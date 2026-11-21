// A check with the real SDK runtime: does `allowed-tools` in a skill's SKILL.md header take the
// permission question away from Botkins?
//
// Run with:
//   node test/skill-allowed-tools-live.mjs
//
// It ends with 0 only when every case holds, and its last line is `PASSED` or `FAILED: <cases>`.
// It is not a part of `npm test`: it starts the real runtime for each case. It needs no account, no
// token and no network (the model is this script, on 127.0.0.1), and it writes only below the
// system's temporary folder, which it removes at the end.
//
// Botkins gives a skill's folder to the runtime as it is, with its header. So this check is what
// holds the rule "a skill cannot use the shell with no question": a new version of the SDK that
// obeys `allowed-tools` makes it fail.
//
// The outer process creates a clean HOME/COPILOT_HOME; the isolated child starts the REAL Copilot
// runtime against a local OpenAI-compatible endpoint that this script serves. The "model" is a
// script: it loads the `probe` skill (if the runtime offers a skill tool), then calls the shell
// tool with `touch <marker>`, then answers DONE. No GitHub credential is needed or read.
//
// For every skill header form, at the two levels at which Botkins asks, it runs the session twice,
// once with the permission handler answering "approve" and once "reject", and records every
// permission request the runtime makes. What must hold in each of these sessions: the skill is
// loaded and the model calls the shell tool (or the case shows nothing); the permission handler
// is asked about the shell command; the command runs with a yes and does not run with a no; and
// nothing that the header names is started (the forms with `hooks` and `mcp-servers`).
// The session options come from Botkins' own sessionOptions() (manual approval, as for a person
// who has not turned on "allow everything"), so the handler is the one the provider installs,
// except that it records first and then answers through Botkins' own decide().
//
// Timeouts: BOTKINS_PROBE_LIMIT_MS (whole run, default 600000) and BOTKINS_PROBE_CASE_MS (one
// session, default 60000).
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const LIMIT_MS = Number(process.env.BOTKINS_PROBE_LIMIT_MS) || 600_000;
const CASE_MS = Number(process.env.BOTKINS_PROBE_CASE_MS) || 60_000;

if (process.argv[2] !== "--isolated") {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "botkins-skill-tools-live-"));
  try {
    const env = {
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: join(home, "copilot"),
      BOTKINS_DATA_DIR: join(home, "botkins"),
      BOTKINS_PROBE_CASE_MS: String(CASE_MS),
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    };
    if (process.env.BOTKINS_PROBE_DEBUG) env.BOTKINS_PROBE_DEBUG = process.env.BOTKINS_PROBE_DEBUG;
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [script, "--isolated"], { env, stdio: "inherit", timeout: LIMIT_MS, cwd: dirname(dirname(script)) });
    if (result.error) {
      console.log("FAILED: the run did not finish (" + result.error.message + ")");
      process.exitCode = 1;
    } else {
      // (A child that a signal ended has no status, and it did not print its last line.)
      if (result.status === null) console.log("FAILED: the run was ended by " + (result.signal ?? "a signal"));
      process.exitCode = result.status ?? 1;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  // An error that nothing caught (the runtime died, a write to it failed) ends the run with the same last line as a
  // case that did not hold. Without this, Node would print its own trace and the last line would not say FAILED.
  for (const event of ["uncaughtException", "unhandledRejection"])
    process.on(event, (error) => {
      console.log("FAILED: the script itself stopped: " + String(error?.stack ?? error).slice(0, 400).replace(/\s*\n\s*/g, " | "));
      process.exit(1);
    });
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "botkins-skill-tools-live-inner-"));
  const isShellTool = (name) => /^(bash|shell|powershell)$/i.test(name);
  const isSkillTool = (name) => /^skill$/i.test(name);

  // Each form is a literal header line (or lines) put into the YAML header. The last three are keys that start
  // something in other places (a plugin's agent file, another tool's skills): here they must start nothing. Each
  // would make the file `started` of its case, which must not be there at the end.
  const FORMS = [
    { label: "none", header: () => null },
    { label: "shell", header: () => "allowed-tools: shell" },
    { label: "bash", header: () => "allowed-tools: bash" },
    { label: "Bash", header: () => "allowed-tools: Bash" },
    { label: "shell(touch:*)", header: () => "allowed-tools: shell(touch:*)" },
    { label: "list [shell]", header: () => "allowed-tools:\n  - shell" },
    { label: "list [bash]", header: () => "allowed-tools:\n  - bash" },
    {
      label: "hooks (Claude's form)",
      header: (started) => ["hooks:", ...["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].flatMap((event) => [`  ${event}:`, "    - hooks:", "        - type: command", `          command: ${JSON.stringify("touch " + started)}`])].join("\n"),
    },
    {
      label: "hooks (the runtime's form)",
      header: (started) => ["hooks:", ...["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "agentStop"].flatMap((event) => [`  ${event}:`, "    - type: command", `      bash: ${JSON.stringify("touch " + started)}`])].join("\n"),
    },
    {
      label: "mcp-servers",
      header: (started) => ["mcp-servers:", "  probe:", "    type: local", "    command: touch", `    args: [${JSON.stringify(started)}]`, '    tools: ["*"]'].join("\n"),
    },
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
      const started = join(dir, "started.txt");
      const extra = form.header(started);
      const header = ["---", "name: probe", "description: Use this skill whenever the user says PROBE. It runs one shell command.", ...(extra ? [extra] : []), "---"].join("\n");
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
        // A moment for a late start of something the header named.
        await new Promise((resolve) => setTimeout(resolve, 300));
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
        headerStarted: existsSync(started),
      };
    };

    const rows = [];
    // "manual" is Botkins' default level for a person who asked to be asked; "assisted" is the middle one.
    for (const approval of ["read", "assisted"]) {
      for (const form of FORMS) {
        for (const answer of ["approve", "reject"]) {
          let row = await runCase(form, answer, approval);
          if (/timed out|timeout/i.test(row.outcome)) row = { ...(await runCase(form, answer, approval)), retried: true };
          rows.push(row);
          console.log(
            `${form.label === "none" ? "A" : answer === "approve" ? "B" : "C"} level=${approval === "read" ? "manual" : approval} header=${form.label} handler=${answer}: ` +
              `shell permission asked=${row.shellPermissionCalls > 0 ? "YES(" + row.shellPermissionCalls + ")" : "NO"} ` +
              `skill listed=${row.skillListed} skill loaded=${row.skillLoaded} shell tool called=${row.shellToolCalled} ` +
              `marker=${row.markerCreated} header started something=${row.headerStarted} all requests=[${row.requestKinds.join(", ")}] session=${row.outcome}${row.retried ? " (retried)" : ""}`,
          );
        }
      }
    }
    console.log("tools offered by the runtime: " + [...offered].sort().join(", "));
    console.log("model ids seen: " + models.join(", "));

    // ---- What must hold. Each session that fails is one entry of the last line.
    const failed = [];
    for (const row of rows) {
      const name = `level=${row.approval === "read" ? "manual" : row.approval} header=${row.form} handler=${row.answer}`;
      const why = [];
      if (row.outcome !== "ok") why.push("the session did not end well (" + row.outcome + ")");
      if (!row.skillLoaded) why.push("the skill was not loaded, so the case shows nothing");
      if (!row.shellToolCalled) why.push("the model did not call the shell tool, so the case shows nothing");
      if (row.shellToolCalled && row.shellPermissionCalls === 0) why.push("THE QUESTION DID NOT COME for the shell command");
      if (row.answer === "approve" && !row.markerCreated) why.push("the command did not run after a yes");
      if (row.answer === "reject" && row.markerCreated) why.push("THE COMMAND RAN AFTER A NO");
      if (row.headerStarted) why.push("THE HEADER STARTED A COMMAND");
      if (why.length) failed.push(name + ": " + why.join(", "));
    }
    const expected = 2 * FORMS.length * 2;
    if (rows.length !== expected) failed.push(`${rows.length} sessions ran, not ${expected}`);
    console.log(failed.some((line) => /DID NOT COME|RAN AFTER A NO|STARTED A COMMAND/.test(line))
      ? "VERDICT: a skill's header takes the permission question away or starts a command"
      : failed.length ? "VERDICT: could not determine" : "VERDICT: the permission question still comes with allowed-tools, and a skill's header starts nothing");
    console.log(failed.length ? "FAILED: " + failed.join("; ") : "PASSED");
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.log("FAILED: the script itself stopped: " + String(error?.stack ?? error).slice(0, 400).replace(/\s*\n\s*/g, " | "));
    process.exitCode = 1;
  } finally {
    await client?.stop?.().catch(() => {});
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
