// Opt-in real SDK probe: when a `preToolUse` hook changes the arguments of a shell command that
// needs a yes, which command does the permission request carry (what the person is shown), and
// which command runs? And what does an `agentStop` hook that answers `block` do?
//
// Run with:
//   node test/hook-changed-args-live.mjs
//
// The outer process creates a clean HOME/COPILOT_HOME; the isolated child starts the REAL Copilot
// runtime against a local OpenAI-compatible endpoint that this script serves. The "model" is a
// script: it calls the shell tool (`bash`) once with `touch <dir>/original`, then answers DONE.
// No GitHub credential is needed or read. The session options come from Botkins' own
// sessionOptions() (manual approval, hooks given as `pluginHooks`, as the app does), and the
// permission handler is Botkins' own decide(), except that it records the request first.
//
// Cases (each is a separate real session):
//   A  no hook (baseline)
//   B  preToolUse returns modifiedArgs { ...args, command: "touch <dir>/changed" }, approve
//   C  as B, the permission handler rejects
//   D  preToolUse returns permissionDecision "deny"; "ask"; "ask" with modifiedArgs; "allow" with modifiedArgs
//   E  agentStop returns { decision: "block", reason } twice, then nothing; and on every call (capped at 6)
//
// Environment: BOTKINS_PROBE_LIMIT_MS (whole run, default 900000), BOTKINS_PROBE_CASE_MS (one
// session, default 90000), QUICK=1 (a short run: A, B, D deny, E twice), BOTKINS_PROBE_DEBUG=1
// (print the raw permission requests and hook inputs).
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const QUICK = !!(process.env.QUICK || process.env.BOTKINS_PROBE_QUICK);
const LIMIT_MS = Number(process.env.BOTKINS_PROBE_LIMIT_MS) || (QUICK ? 360_000 : 900_000);
const CASE_MS = Number(process.env.BOTKINS_PROBE_CASE_MS) || (QUICK ? 45_000 : 90_000);

if (process.argv[2] !== "--isolated") {
  const home = mkdtempSync(join(process.env.TMPDIR || "/private/tmp", "botkins-hook-args-live-"));
  try {
    const env = {
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: join(home, "copilot"),
      BOTKINS_DATA_DIR: join(home, "botkins"),
      BOTKINS_PROBE_CASE_MS: String(CASE_MS),
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    };
    if (QUICK) env.QUICK = "1";
    if (process.env.BOTKINS_PROBE_DEBUG) env.BOTKINS_PROBE_DEBUG = process.env.BOTKINS_PROBE_DEBUG;
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [script, "--isolated"], { env, stdio: "inherit", timeout: LIMIT_MS, cwd: dirname(dirname(script)) });
    if (result.error) {
      console.log("SHOWN vs RUN: could not determine: the run did not finish (" + result.error.message + ")");
      process.exitCode = 1;
    } else process.exitCode = result.status ?? 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  const root = mkdtempSync(join(process.env.TMPDIR || "/private/tmp", "botkins-hook-args-live-inner-"));
  const DEBUG = !!process.env.BOTKINS_PROBE_DEBUG;
  const isShellTool = (name) => /^(bash|shell|powershell)$/i.test(name ?? "");
  const t0 = performance.now();
  const stamp = () => Math.round(performance.now() - t0);

  // Per-case state the model endpoint and the handlers read. Only one case runs at a time.
  let current = null;
  const offered = new Set();
  const note = (what, extra) => current?.events.push({ n: current.events.length + 1, ms: stamp(), what, ...(extra && { extra }) });

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

  const userText = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((p) => p.text ?? "").join("");

  const model = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    let parsed;
    try { parsed = JSON.parse(body); } catch { response.writeHead(400); response.end(); return; }
    const tools = parsed.tools ?? [];
    for (const tool of tools) offered.add(tool.function?.name ?? tool.name);
    const messages = parsed.messages ?? [];
    if (!current) return say(response, "No case running.");
    current.modelRequests += 1;
    note("model request #" + current.modelRequests, "messages=" + messages.length);
    if (current.modelPrompts) current.modelPrompts.push(messages.filter((m) => m.role === "user").map((m) => userText(m).slice(0, 60)).at(-1));
    const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
    const shellTool = tools.find((t) => isShellTool(t.function?.name));
    if (current.callsShell && shellTool && !calls.some((c) => isShellTool(c.function?.name))) {
      current.shellCalled = true;
      return call(response, "call_shell_1", shellTool.function.name, argsFor(shellTool, `touch ${current.dir}/original`));
    }
    return say(response, "DONE");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

  let client;
  const rows = {};
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
    /**
     * @param {object} spec
     * @param {string} spec.label
     * @param {"approve"|"reject"} spec.answer what the permission handler says
     * @param {boolean} [spec.callsShell=true] the scripted model calls bash (false: it only answers)
     * @param {(ctx: object) => object} [spec.hooks] the `hooks.handlers` for the case, given the case context
     */
    const runCase = async (spec) => {
      const id = ++counter;
      const dir = join(root, "case-" + id);
      mkdirSync(dir, { recursive: true });
      const state = {
        dir,
        events: [],
        permissions: [],
        hookInputs: [],
        modelRequests: 0,
        modelPrompts: [],
        shellCalled: false,
        callsShell: spec.callsShell !== false,
        hookCalls: { preToolUse: 0, agentStop: 0 },
        stopInputs: [],
        hookErrors: [],
      };
      current = state;
      const handlers = spec.hooks?.(state) ?? {};
      const options = sessionOptions({
        sessionId: "probe-" + id,
        folder: workingDirectory,
        model: { model: "local", source: "fixture" },
        inference,
        approval: "read",
        instructions: "Follow the user's request exactly.",
        tools: [],
        skills: { directories: [], disabled: [] },
        // As the app does: plugin hooks are given as `pluginHooks`, and sessionOptions() passes them as `hooks`.
        pluginHooks: { handlers },
      }, { handlers: {} });
      options.permissions = {
        ...options.permissions,
        onRequest: (request, invocation) => {
          const command = request.fullCommandText ?? request.path ?? request.toolName ?? "";
          state.permissions.push({ kind: request.kind, command: String(command), toolCallId: request.toolCallId });
          note("permission asked", request.kind + "(" + String(command).slice(0, 80) + ")");
          if (DEBUG) console.log("  [debug] permission request: " + JSON.stringify(request).slice(0, 1500));
          return decide(() => ({ allow: spec.answer === "approve" }), request, invocation);
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
        // A moment for a late touch from a tool that was still running.
        await new Promise((resolve) => setTimeout(resolve, 300));
        current = null;
      }
      const shell = state.permissions.filter((p) => p.kind === "shell");
      return {
        label: spec.label,
        outcome,
        state,
        shellPermissions: shell,
        shownCommand: shell[0]?.command ?? null,
        original: existsSync(join(dir, "original")),
        changed: existsSync(join(dir, "changed")),
      };
    };
    const runWithRetry = async (spec) => {
      let row = await runCase(spec);
      if (/timed out|timeout/i.test(row.outcome)) row = { ...(await runCase(spec)), retried: true };
      return row;
    };

    const shownAs = (command, dir) => command == null ? "NO REQUEST" : command.includes(dir + "/changed") ? "CHANGED" : command.includes(dir + "/original") ? "ORIGINAL" : "OTHER(" + command.slice(0, 80) + ")";
    const marks = (row) => `original=${row.original} changed=${row.changed}`;
    const orderOf = (row) => row.state.events.filter((e) => /^(permission|hook preToolUse)/.test(e.what)).map((e) => e.n + ":" + e.what.replace("hook ", "hook-").replace(" asked", "")).join(" < ");
    const tail = (row) => `session=${row.outcome}${row.retried ? " (retried)" : ""}`;

    // What a preToolUse handler sees, kept for the report. Only the shell tool is touched.
    let argShape = null;
    const changeArgs = (state) => async (input) => {
      state.hookCalls.preToolUse += 1;
      state.hookInputs.push({ toolName: input.toolName, argsType: typeof input.toolArgs, toolArgs: input.toolArgs, toolCallId: input.toolCallId });
      note("hook preToolUse", input.toolName);
      if (DEBUG) console.log("  [debug] preToolUse input: " + JSON.stringify(input).slice(0, 800));
      if (!isShellTool(input.toolName)) return undefined;
      const wasString = typeof input.toolArgs === "string";
      const args = wasString ? JSON.parse(input.toolArgs) : input.toolArgs ?? {};
      argShape ??= (wasString ? "a JSON string" : "an object") + " with keys [" + Object.keys(args).join(", ") + "]";
      const modifiedArgs = { ...args, command: `touch ${state.dir}/changed` };
      return { modifiedArgs: wasString ? JSON.stringify(modifiedArgs) : modifiedArgs };
    };
    const decideOnly = (state, permissionDecision, withArgs) => async (input) => {
      state.hookCalls.preToolUse += 1;
      state.hookInputs.push({ toolName: input.toolName, argsType: typeof input.toolArgs });
      note("hook preToolUse", input.toolName + " -> " + permissionDecision);
      if (!isShellTool(input.toolName)) return undefined;
      const out = { permissionDecision, permissionDecisionReason: "probe says " + permissionDecision };
      if (withArgs) {
        const wasString = typeof input.toolArgs === "string";
        const args = wasString ? JSON.parse(input.toolArgs) : input.toolArgs ?? {};
        const modifiedArgs = { ...args, command: `touch ${state.dir}/changed` };
        out.modifiedArgs = wasString ? JSON.stringify(modifiedArgs) : modifiedArgs;
      }
      return out;
    };

    // ---- A: baseline
    {
      const row = await runWithRetry({ label: "A", answer: "approve" });
      rows.A = row;
      console.log(`A baseline (no hook), approve: shell permission requests=${row.shellPermissions.length} shown=${shownAs(row.shownCommand, row.state.dir)} ${marks(row)} order=[${orderOf(row)}] model requests=${row.state.modelRequests} ${tail(row)}`);
    }
    // ---- B: hook changes the args, approve
    {
      const row = await runWithRetry({ label: "B", answer: "approve", hooks: (s) => ({ onPreToolUse: changeArgs(s) }) });
      rows.B = row;
      console.log(`B hook modifiedArgs, approve: hook calls=${row.state.hookCalls.preToolUse} shell permission requests=${row.shellPermissions.length} shown=${shownAs(row.shownCommand, row.state.dir)} ${marks(row)} order=[${orderOf(row)}] model requests=${row.state.modelRequests} ${tail(row)}`);
      console.log(`  hook input toolArgs: ${row.state.hookInputs.filter((i) => isShellTool(i.toolName)).map((i) => i.argsType + " " + JSON.stringify(i.toolArgs).slice(0, 200)).join(" | ") || "(no shell call seen)"}; tools the hook saw: ${[...new Set(row.state.hookInputs.map((i) => i.toolName))].join(",")}`);
    }
    // ---- C: hook changes the args, reject
    if (!QUICK) {
      const row = await runWithRetry({ label: "C", answer: "reject", hooks: (s) => ({ onPreToolUse: changeArgs(s) }) });
      rows.C = row;
      console.log(`C hook modifiedArgs, REJECT: hook calls=${row.state.hookCalls.preToolUse} shell permission requests=${row.shellPermissions.length} shown=${shownAs(row.shownCommand, row.state.dir)} ${marks(row)} order=[${orderOf(row)}] ${tail(row)}`);
    }
    // ---- D: the hook decides
    const dCases = [
      { key: "D-deny", label: "D deny", hook: (s) => decideOnly(s, "deny", false) },
      ...(QUICK ? [] : [
        { key: "D-ask", label: "D ask", hook: (s) => decideOnly(s, "ask", false) },
        { key: "D-ask+args", label: "D ask+modifiedArgs", hook: (s) => decideOnly(s, "ask", true) },
        { key: "D-allow+args", label: "D allow+modifiedArgs", hook: (s) => decideOnly(s, "allow", true) },
      ]),
    ];
    for (const entry of dCases) {
      const row = await runWithRetry({ label: entry.key, answer: "approve", hooks: (s) => ({ onPreToolUse: entry.hook(s) }) });
      rows[entry.key] = row;
      console.log(`${entry.label} (permission handler would approve): hook calls=${row.state.hookCalls.preToolUse} permission handler asked=${row.state.permissions.length > 0 ? "YES(" + row.state.permissions.length + ": " + row.state.permissions.map((p) => p.kind + " " + p.command.slice(-40)).join("; ") + ")" : "NO"} ${marks(row)} order=[${orderOf(row)}] ${tail(row)}`);
    }
    // ---- E: agentStop
    const stopHandler = (state, blockWhile) => async (input) => {
      state.hookCalls.agentStop += 1;
      const n = state.hookCalls.agentStop;
      state.stopInputs.push({ n, stopReason: input?.stopReason, stopHookActive: input?.stopHookActive });
      const block = n <= blockWhile;
      note("hook agentStop #" + n, block ? "block" : "allow stop");
      return block ? { decision: "block", reason: "go on" } : undefined;
    };
    const eCases = QUICK ? [{ key: "E2", blockWhile: 2 }] : [{ key: "E2", blockWhile: 2 }, { key: "E-always", blockWhile: 6 }];
    for (const entry of eCases) {
      const row = await runWithRetry({ label: entry.key, answer: "approve", callsShell: false, hooks: (s) => ({ onAgentStop: stopHandler(s, entry.blockWhile) }) });
      rows[entry.key] = row;
      const s = row.state;
      console.log(
        `${entry.key} agentStop blocks the first ${entry.blockWhile} calls: handler calls=${s.hookCalls.agentStop} model requests=${s.modelRequests} ` +
          `stop inputs=[${s.stopInputs.map((i) => "#" + i.n + ":" + (i.stopReason ?? "?") + "/active=" + i.stopHookActive).join(", ")}] ${tail(row)}`,
      );
      if (DEBUG) console.log("  [debug] events: " + JSON.stringify(s.events));
    }

    console.log("tools offered by the runtime: " + [...offered].sort().join(", "));
    console.log("shape of a bash call's arguments as the preToolUse hook gets them: " + (argShape ?? "(never seen)"));

    // ---- Verdicts
    const B = rows.B;
    const okB = B && B.state.hookCalls.preToolUse > 0 && B.state.shellCalled && B.shellPermissions.length > 0 && B.outcome === "ok";
    let shownVsRun;
    if (!rows.A || rows.A.shellPermissions.length === 0 || !rows.A.original) {
      shownVsRun = "could not determine: the baseline (case A) did not show a shell permission request followed by the original command running" + (rows.A ? ` (requests=${rows.A.shellPermissions.length}, original=${rows.A.original}, session=${rows.A.outcome})` : "");
    } else if (!okB) {
      shownVsRun = "could not determine: in case B the hook, the shell call or the permission request did not all happen" + (B ? ` (hook calls=${B.state.hookCalls.preToolUse}, shell called=${B.state.shellCalled}, requests=${B.shellPermissions.length}, session=${B.outcome})` : "");
    } else {
      const shown = shownAs(B.shownCommand, B.state.dir);
      if (shown === "CHANGED") shownVsRun = `the person is shown the changed command (permission request text: ${B.shownCommand}; marker files: ${marks(B)})`;
      else if (shown === "ORIGINAL" && B.changed && !B.original) shownVsRun = `the person is shown the ORIGINAL command and the changed one runs (permission request text: ${B.shownCommand}; marker files: ${marks(B)})`;
      else if (shown === "ORIGINAL" && B.original && !B.changed) shownVsRun = `the person is shown the original command and the original one runs: modifiedArgs had no effect on this command (marker files: ${marks(B)})`;
      else shownVsRun = `could not determine: shown=${shown}, ${marks(B)}`;
    }
    let order;
    if (!okB) order = "could not determine: case B did not complete";
    else {
      const hookAt = B.state.events.find((e) => e.what === "hook preToolUse" && isShellTool(e.extra));
      const permAt = B.state.events.find((e) => e.what === "permission asked" && /^shell/.test(e.extra ?? ""));
      if (!hookAt || !permAt) order = "could not determine: one of the two was not logged";
      else order = hookAt.n < permAt.n ? `hook before permission (event ${hookAt.n} at ${hookAt.ms} ms, then event ${permAt.n} at ${permAt.ms} ms)` : `permission before hook (event ${permAt.n} at ${permAt.ms} ms, then event ${hookAt.n} at ${hookAt.ms} ms)`;
    }
    const E2 = rows.E2;
    const Ea = rows["E-always"];
    let agentStop;
    if (!E2 || E2.state.hookCalls.agentStop === 0) agentStop = "could not determine: the agentStop handler was never called" + (E2 ? ` (session=${E2.outcome})` : "");
    else {
      const parts = [`block twice then allow: handler called ${E2.state.hookCalls.agentStop} times, ${E2.state.modelRequests} model requests (a model request per turn; a run with no block is 1)`];
      if (Ea) {
        const calls = Ea.state.hookCalls.agentStop;
        parts.push(`block on every call, my handler capped at 6 blocks: handler called ${calls} times, ${Ea.state.modelRequests} model requests, ` +
          (calls > 6 ? "the runtime did not stop it by itself within 6 blocks (my cap ended it)" : `the runtime stopped by itself after ${calls} handler calls (before my cap of 6 blocks was reached)`));
      }
      agentStop = parts.join("; ");
    }
    const pick = (key) => rows[key];
    const dline = ["D-deny", "D-ask", "D-ask+args", "D-allow+args"].filter(pick).map((k) => `${k}: permission asked=${rows[k].state.permissions.length > 0}${rows[k].state.permissions.length ? "(" + rows[k].state.permissions.map((p) => p.kind).join(",") + ")" : ""}, marks ${marks(rows[k])}`).join("; ");
    if (dline) console.log("DECISIONS: " + dline);
    if (rows.C) console.log(`REJECT: with modifiedArgs and a rejecting permission handler, ${marks(rows.C)}`);
    console.log("SHOWN vs RUN: " + shownVsRun);
    console.log("ORDER: " + order);
    console.log("AGENT STOP: " + agentStop);
  } catch (error) {
    console.log("SHOWN vs RUN: could not determine: " + String(error?.stack ?? error).slice(0, 400));
    process.exitCode = 1;
  } finally {
    await client?.stop?.().catch(() => {});
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
