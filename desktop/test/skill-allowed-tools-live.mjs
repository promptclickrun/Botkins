// Opt-in real SDK probe: does `allowed-tools` in a skill's SKILL.md header take the permission
// question away from Botkins?
//
// Run with:
//   node test/skill-allowed-tools-live.mjs
//
// The outer process creates a clean HOME/COPILOT_HOME; the isolated child starts the REAL Copilot
// runtime against a local OpenAI-compatible endpoint that this script serves. The "model" is a
// script: it loads the `probe` skill (if the runtime offers a skill tool), then calls the shell
// tool with `touch <marker>`, then answers DONE. No GitHub credential is needed or read.
//
// For every skill header form it runs the session twice, once with the permission handler
// answering "approve" and once "reject", and records every permission request the runtime makes.
// The session options come from Botkins' own sessionOptions() (manual approval, as for a person
// who has not turned on "allow everything"), so the handler is the one the provider installs,
// except that it records first and then answers through Botkins' own decide().
//
// Timeouts: BOTKINS_PROBE_LIMIT_MS (whole run, default 600000) and BOTKINS_PROBE_CASE_MS (one
// session, default 60000).
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const LIMIT_MS = Number(process.env.BOTKINS_PROBE_LIMIT_MS) || 600_000;
const CASE_MS = Number(process.env.BOTKINS_PROBE_CASE_MS) || 60_000;

if (process.argv[2] !== "--isolated") {
  const home = mkdtempSync(join(process.env.TMPDIR || "/private/tmp", "botkins-skill-tools-live-"));
  try {
    const env = {
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: join(home, "copilot"),
      BOTKINS_DATA_DIR: join(home, "botkins"),
      BOTKINS_PROBE_CASE_MS: String(CASE_MS),
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    };
    for (const key of ["BOTKINS_PROBE_DEBUG", "BOTKINS_PROBE_QUICK"]) if (process.env[key]) env[key] = process.env[key];
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [script, "--isolated"], { env, stdio: "inherit", timeout: LIMIT_MS, cwd: dirname(dirname(script)) });
    if (result.error) {
      console.log("VERDICT: could not determine: the run did not finish (" + result.error.message + ")");
      process.exitCode = 1;
    } else process.exitCode = result.status ?? 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  const root = mkdtempSync(join(process.env.TMPDIR || "/private/tmp", "botkins-skill-tools-live-inner-"));
  const isShellTool = (name) => /^(bash|shell|powershell)$/i.test(name);
  const isSkillTool = (name) => /^skill$/i.test(name);

  // Each form is a literal header line (or lines) put into the YAML header.
  const FORMS = [
    { label: "none", header: null },
    { label: "shell", header: "allowed-tools: shell" },
    { label: "bash", header: "allowed-tools: bash" },
    { label: "Bash", header: "allowed-tools: Bash" },
    { label: "shell(touch:*)", header: "allowed-tools: shell(touch:*)" },
    { label: "list [shell]", header: "allowed-tools:\n  - shell" },
    { label: "list [bash]", header: "allowed-tools:\n  - bash" },
  ];

  // Per-case state the model endpoint reads. Only one case runs at a time.
  let current = null;
  const offered = new Set();
  const models = [];

  const argsFor = (tool, command) => {
    const schema = tool.function?.parameters ?? {};
    const out = {};
    for (const key of schema.required ?? []) {
      const spec = schema.properties?.[key] ?? {};
      if (/command|cmd/i.test(key)) out[key] = command;
      else if (Array.isArray(spec.enum)) out[key] = spec.enum[0];
      else if (spec.default !== undefined) out[key] = spec.default;
      else if (spec.type === "boolean") out[key] = false;
      else if (spec.type === "number" || spec.type === "integer") out[key] = spec.minimum ?? 30;
      else out[key] = "touch marker";
    }
    if (!("command" in out)) out.command = command;
    return out;
  };

  const sse = (response, events) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
    response.end("data: [DONE]\n\n");
  };
  const chunk = (delta, finish, usage) => ({
    id: "probe-chat", object: "chat.completion.chunk", model: "local",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage && { usage }),
  });
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const say = (response, text) => sse(response, [chunk({ role: "assistant", content: text }, null), chunk({}, "stop", usage)]);
  const call = (response, id, name, args) =>
    sse(response, [
      chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null),
      chunk({}, "tool_calls", usage),
    ]);

  const model = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    let parsed;
    try { parsed = JSON.parse(body); } catch { response.writeHead(400); response.end(); return; }
    const tools = parsed.tools ?? [];
    for (const tool of tools) offered.add(tool.function?.name ?? tool.name);
    if (parsed.model && !models.includes(parsed.model)) models.push(parsed.model);
    const messages = parsed.messages ?? [];
    const userText = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((p) => p.text ?? "").join("");
    const wantsProbe = messages.some((m) => m.role === "user" && /PROBE/.test(userText(m)));
    if (current) {
      const system = messages.filter((m) => m.role === "system" || m.role === "developer").map(userText).join("\n");
      current.skillListed ||= /<name>probe<\/name>|\bprobe\b[^\n]*runs one shell command/i.test(system);
    }
    const shellTool = tools.find((t) => isShellTool(t.function?.name));
    const skillTool = tools.find((t) => isSkillTool(t.function?.name));
    const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    const done = (pick) => calls.some((c) => pick(c.function?.name) && answered.has(c.id));
    const asked = (pick) => calls.some((c) => pick(c.function?.name));
    if (!wantsProbe || !current) return say(response, "No probe asked.");
    if (current) {
      const skillCall = calls.find((c) => isSkillTool(c.function?.name));
      const result = skillCall && messages.find((m) => m.role === "tool" && m.tool_call_id === skillCall.id);
      // The skill counts as loaded only when its result carries the skill's own instructions.
      if (result) current.skillResultText = userText(result).slice(0, 120);
      const carriesSkill = messages.some((m) => m.role !== "system" && m.role !== "developer" && /touch /.test(userText(m)) && /skill-context|Base directory|probe/.test(userText(m)) && !(m.role === "user" && userText(m).trim() === "PROBE"));
      if (result && carriesSkill) current.skillResult = true;
      if (process.env.BOTKINS_PROBE_DEBUG && result) console.log("skill tool result:", JSON.stringify(messages.slice(-3).map((m) => [m.role, userText(m).slice(0, 300)])));
    }
    if (skillTool && !asked(isSkillTool)) {
      current.skillCalled = true;
      return call(response, "call_skill_1", skillTool.function.name, { skill: "probe" });
    }
    if (shellTool && !asked(isShellTool)) {
      current.shellCalled = true;
      return call(response, "call_shell_1", shellTool.function.name, argsFor(shellTool, `touch ${JSON.stringify(current.marker)}`));
    }
    return say(response, "DONE");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

  const verdicts = [];
  let client;
  try {
    const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
    const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
    const { decide } = await import("../desktop/providers/copilot/permissions.mjs");
    const { planModel } = await import("../desktop/harness/index.mjs");

    const workingDirectory = join(root, "work");
    mkdirSync(workingDirectory, { recursive: true });
    const inference = {
      providers: [{ name: "fixture", type: "openai", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, bearerToken: "synthetic-model-token" }],
      models: [planModel("fixture", { id: "local", name: "Local fixture", tools: true, contextWindow: 64_000, maxOutput: 4_096 })],
    };
    client = new CopilotClient({
      mode: "coding-agent",
      github: { useLoggedInUser: false },
      runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: join(root, "copilot"), workingDirectory }),
    });
    await client.start();

    let counter = 0;
    const runCase = async (form, answer, approval) => {
      const id = ++counter;
      const dir = join(root, "case-" + id);
      const skills = join(dir, "skills");
      mkdirSync(join(skills, "probe"), { recursive: true });
      const marker = join(dir, "marker.txt");
      const header = ["---", "name: probe", "description: Use this skill whenever the user says PROBE. It runs one shell command.", ...(form.header ? [form.header] : []), "---"].join("\n");
      writeFileSync(join(skills, "probe", "SKILL.md"), header + `\nWhen asked to PROBE, run the shell command \`touch ${marker}\` and then answer DONE.\n`);
      const state = { marker, requests: [], skillCalled: false, skillResult: false, skillListed: false, shellCalled: false };
      current = state;
      const options = sessionOptions({
        sessionId: "probe-" + id,
        folder: workingDirectory,
        model: { model: "local", source: "fixture" },
        inference,
        approval,
        instructions: "Follow the user's request exactly.",
        tools: [],
        skills: { directories: [skills], disabled: [] },
      }, { handlers: {} });
      options.permissions = {
        ...options.permissions,
        onRequest: (request, invocation) => {
          state.requests.push({ kind: request.kind, command: request.fullCommandText ?? request.path ?? request.toolName ?? "" });
          return decide(() => ({ allow: answer === "approve" }), request, invocation);
        },
      };
      let session;
      let outcome = "ok";
      try {
        session = await client.createSession({ ...options, github: { capi: { enabled: false } } });
        await session.sendAndWait({ prompt: "PROBE" }, CASE_MS);
      } catch (error) {
        outcome = "error: " + String(error?.message ?? error).slice(0, 160);
      } finally {
        await session?.disconnect?.().catch(() => {});
        current = null;
      }
      const shellRequests = state.requests.filter((r) => r.kind === "shell");
      return {
        form: form.label,
        answer,
        approval,
        outcome,
        skillOffered: state.skillCalled,
        skillLoaded: state.skillResult,
        skillListed: state.skillListed,
        shellToolCalled: state.shellCalled,
        permissionCalls: state.requests.length,
        shellPermissionCalls: shellRequests.length,
        requestKinds: state.requests.map((r) => r.kind + (r.command ? "(" + String(r.command).slice(0, 60) + ")" : "")),
        markerCreated: existsSync(marker),
      };
    };

    const rows = [];
    // "manual" is Botkins' default level for a person who asked to be asked; "assisted" is the middle one.
    const quick = !!process.env.BOTKINS_PROBE_QUICK;
    for (const approval of quick ? ["read"] : ["read", "assisted"]) {
      for (const form of quick ? FORMS.slice(0, 2) : FORMS) {
        for (const answer of quick ? ["approve"] : ["approve", "reject"]) {
          let row = await runCase(form, answer, approval);
          if (/timed out|timeout/i.test(row.outcome)) row = { ...(await runCase(form, answer, approval)), retried: true };
          rows.push(row);
          console.log(
            `${form.label === "none" ? "A" : answer === "approve" ? "B" : "C"} level=${approval === "read" ? "manual" : approval} header=${form.label} handler=${answer}: ` +
              `shell permission asked=${row.shellPermissionCalls > 0 ? "YES(" + row.shellPermissionCalls + ")" : "NO"} ` +
              `skill listed=${row.skillListed} skill loaded=${row.skillLoaded} shell tool called=${row.shellToolCalled} ` +
              `marker=${row.markerCreated} all requests=[${row.requestKinds.join(", ")}] session=${row.outcome}${row.retried ? " (retried)" : ""}`,
          );
        }
      }
    }
    verdicts.push(...rows);
    console.log("tools offered by the runtime: " + [...offered].sort().join(", "));
    console.log("model ids seen: " + models.join(", "));

    const base = rows.find((r) => r.form === "none" && r.answer === "approve" && r.approval === "read");
    const valid = (r) => r.shellToolCalled && r.outcome === "ok";
    const withHeader = rows.filter((r) => r.form !== "none");
    let verdict;
    if (!base || !valid(base) || base.shellPermissionCalls === 0) {
      verdict = "VERDICT: could not determine: the harness baseline (case A) did not show a shell permission request" +
        (base ? ` (shell tool called=${base.shellToolCalled}, outcome=${base.outcome}, requests=${base.permissionCalls})` : "");
    } else {
      const usable = withHeader.filter((r) => r.answer === "approve" && valid(r) && r.skillLoaded);
      // A header only counts as silent where the same level, with no header, asked.
      const levelAsked = (level) => rows.some((r) => r.form === "none" && r.answer === "approve" && r.approval === level && r.shellPermissionCalls > 0);
      const silent = usable.filter((r) => levelAsked(r.approval) && r.shellPermissionCalls === 0);
      const rejectedStillRan = withHeader.filter((r) => r.answer === "reject" && r.markerCreated && r.shellPermissionCalls > 0);
      if (usable.length === 0) verdict = "VERDICT: could not determine: with a header the skill never became active and the shell tool ran in no case";
      else if (silent.length || rejectedStillRan.length)
        verdict = "VERDICT: allowed-tools takes the permission question away";
      else verdict = "VERDICT: the permission question still comes with allowed-tools";
      if (usable.length < withHeader.filter((r) => r.answer === "approve").length)
        console.log("note: some header forms did not reach a loaded skill plus a shell call: " +
          withHeader.filter((r) => r.answer === "approve" && !(valid(r) && r.skillLoaded)).map((r) => r.form).join(", "));
    }
    console.log(verdict);
  } catch (error) {
    console.log("VERDICT: could not determine: " + String(error?.stack ?? error).slice(0, 400));
    process.exitCode = 1;
  } finally {
    await client?.stop?.().catch(() => {});
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
