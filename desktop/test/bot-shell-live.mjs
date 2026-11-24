// A check with the real SDK runtime: what does a bot's shell find? Can it use the `botkins` command,
// does the command reach this service, and do the rules of the command line hold when a bot is the caller?
//
// Run with:
//   node test/bot-shell-live.mjs
//
// It ends with 0 only when every condition holds, and its last line is `PASSED` or `FAILED: <cases>`.
// It is part of `npm run test:runtime`, not of `npm test`: it starts the real runtime. It needs no
// account, no token and no network (the model is this script, on 127.0.0.1; the service listens on a
// socket in a temporary folder and on one local port that it takes itself), and it writes only below the
// system's temporary folder, which it removes at the end.
//
// The outer process creates a clean HOME/COPILOT_HOME and a short PATH. The isolated child plays the
// service: it starts a real service on a socket (as `botkins serve --trial` does), makes the command
// reachable (`prepareReach` from desktop/terminal/reach.mjs: a launcher in `<root>/run/bin`, that folder at
// the front of PATH, and BOTKINS_SOCKET, both set in THIS process's own environment), and only then starts the
// REAL Copilot runtime. The runtime is a child process that inherits this environment (the app and the service
// give it none of their own: desktop/providers/copilot/index.mjs makes `RuntimeConnection.forSpawnedStdio`
// with no `env`), so what its shell finds is what the service's own process has.
//
// The model is a script: it calls the shell tool (`bash`) with one command line at a time and then answers
// DONE. The permission handler is Botkins' own decide(), except that it records the request first. Each
// command line writes its output, its error and its exit code to files in the case's folder, and the script
// reads them there. The session options come from Botkins' own sessionOptions() (manual approval).
//
// Cases (each is a separate real session):
//   A  the person says yes to every command: the commands of conditions 1 to 6 run, one at a time
//   B  the person says no: a `botkins` command that changes something does not run
//
// What must hold (each is a line of the last part of the output, and a case of the last line):
//   1  `command -v botkins` gives the launcher's path
//   2  `botkins status --json` reaches THIS service (its pid)
//   3  `botkins help --json` lists the areas of the command line
//   4  a read works: `botkins bots list --json`
//   5  a change that asks does not happen with no --yes: exit code 2, the refusal names the flag, nothing changed
//   6  what is refused for every caller is refused from a bot's shell: (i) there is no command that unlocks a password
//      manager and no `call` method on the socket (the exit code and the sentence of an unknown command, and the
//      service's answer that it has no call named `call`); (ii) a saved credential by reference is refused by the
//      socket's own call (`chat.respond`)
//   7  the person is asked about every command before it runs, and with a no the command does not run
//
// The temporary folders are made in the system's own temporary folder (TMPDIR, else os.tmpdir()).
//
// Environment: BOTKINS_PROBE_LIMIT_MS (whole run, default 300000), BOTKINS_PROBE_CASE_MS (one session,
// default 90000), BOTKINS_PROBE_DEBUG=1 (print each command's output).
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const LIMIT_MS = Number(process.env.BOTKINS_PROBE_LIMIT_MS) || 300_000;
const CASE_MS = Number(process.env.BOTKINS_PROBE_CASE_MS) || 90_000;

if (process.argv[2] !== "--isolated") {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "botkins-bot-shell-live-"));
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
} else if (process.platform === "win32") {
  // The terminal host runs on Linux and macOS (desktop/terminal/paths.mjs), and its launcher is a shell script.
  console.log("PASSED (nothing to check: the terminal host does not run on Windows)");
} else {
  // An error that nothing caught (the runtime died, a write to it failed) ends the run with the same last line as a
  // case that did not hold. Without this, Node would print its own trace and the last line would not say FAILED.
  for (const event of ["uncaughtException", "unhandledRejection"])
    process.on(event, (error) => {
      console.log("FAILED: the script itself stopped: " + String(error?.stack ?? error).slice(0, 400).replace(/\s*\n\s*/g, " | "));
      process.exit(1);
    });
  // A short folder name: a Unix socket's path has to fit in about 100 characters (desktop/terminal/paths.mjs).
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "bk-shell-"));
  const DEBUG = !!process.env.BOTKINS_PROBE_DEBUG;
  const isShellTool = (name) => /^(bash|shell|powershell)$/i.test(name ?? "");
  const sq = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'";
  const freePort = () =>
    new Promise((resolve) => {
      const server = netServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });

  // Per-case state the model endpoint and the handlers read. Only one case runs at a time.
  let current = null;
  const offered = new Set();

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
      else out[key] = "run the command";
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

  // The scripted model: the next command line of the case, one at a time, then DONE.
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
    current.toolResults = messages.filter((m) => m.role === "tool").length;
    const asked = messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).filter((c) => isShellTool(c.function?.name));
    const shellTool = tools.find((t) => isShellTool(t.function?.name));
    const next = current.steps[asked.length];
    if (shellTool && next) {
      current.issued.push(next.name);
      return call(response, "call_shell_" + (asked.length + 1), shellTool.function.name, argsFor(shellTool, next.line));
    }
    return say(response, "DONE");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

  let client;
  let running;
  try {
    const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
    const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
    const { decide, describeRequest } = await import("../desktop/providers/copilot/permissions.mjs");
    const { planModel } = await import("../desktop/harness/index.mjs");
    const { terminalPaths } = await import("../desktop/terminal/paths.mjs");
    const { startService } = await import("../desktop/terminal/serve.mjs");
    const { controlClient } = await import("../desktop/terminal/socket.mjs");

    // ---- The service: real, on a socket in a folder of its own (as desktop/test/terminal-tools.test.mjs starts one).
    const paths = terminalPaths({ root: join(root, "s"), env: {} });
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
    running = await startService({ paths, version: "9.9.9", trial: true });
    const control = controlClient(paths.socket, { timeout: 40_000 });

    // ---- The command, reachable for a bot's shell. This process plays the service, and its own environment is
    // what the runtime (a child process) inherits. The real module of part (g) when it is there; until then a
    // launcher of this script's own, made the way the contract says.
    let reach;
    let reachBy = "prepareReach (desktop/terminal/reach.mjs)";
    try {
      const { prepareReach } = await import("../desktop/terminal/reach.mjs");
      reach = await prepareReach({ dataDir: paths.root, socket: paths.socket, env: process.env });
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" && !/not made reachable yet/.test(error?.message ?? "")) throw error;
      const bin = join(paths.runDir, "bin");
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      const command = join(bin, "botkins");
      writeFileSync(command, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(join(dirname(dirname(script)), "cli", "botkins.mjs"))} "$@"\n`);
      chmodSync(command, 0o755);
      process.env.BOTKINS_SOCKET = paths.socket;
      process.env.PATH = bin + delimiter + process.env.PATH;
      reach = { bin, command, socket: paths.socket };
      reachBy = "the launcher of this script (desktop/terminal/reach.mjs is still the stand-in)";
    }
    // [reach done]
    console.log(`reach: ${reachBy}; launcher=${reach.command}; PATH starts with ${process.env.PATH.split(delimiter)[0]}; BOTKINS_SOCKET=${process.env.BOTKINS_SOCKET === paths.socket ? "the service's socket" : "NOT the service's socket"}`);

    const workingDirectory = join(root, "work");
    mkdirSync(workingDirectory, { recursive: true });
    const inference = {
      providers: [{ name: "fixture", type: "openai", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, bearerToken: "synthetic-model-token" }],
      models: [planModel("fixture", { id: "local", name: "Local fixture", tools: true, contextWindow: 64_000, maxOutput: 4_096 })],
    };
    // No `env`: the runtime inherits this process's environment, as it does in the app and in the service.
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
     * @param {(dir: string) => {name: string, line: string}[]} spec.steps the commands, in order; each is given the folder for its files
     */
    const runCase = async (spec) => {
      const id = ++counter;
      const dir = join(root, "c" + id);
      mkdirSync(dir, { recursive: true });
      // A command line writes its output, its error and its exit code to files, which this script reads.
      const steps = spec.steps(dir).map((step) => {
        const file = (ext) => join(dir, step.name + "." + ext);
        return { ...step, file, line: `${step.line} > ${sq(file("out"))} 2> ${sq(file("err"))}; echo $? > ${sq(file("exit"))}` };
      });
      const state = { dir, steps, issued: [], permissions: [], modelRequests: 0, toolResults: 0 };
      current = state;
      const options = sessionOptions({
        sessionId: "probe-" + id,
        folder: workingDirectory,
        model: { model: "local", source: "fixture" },
        inference,
        approval: "read",
        instructions: "Follow the user's request exactly.",
        tools: [],
        skills: { directories: [], disabled: [] },
      }, { handlers: {} });
      options.permissions = {
        ...options.permissions,
        onRequest: (request, invocation) => {
          const command = request.fullCommandText ?? request.path ?? request.toolName ?? "";
          state.permissions.push({ kind: request.kind, command: String(command), shown: String(describeRequest(request, invocation).preview ?? ""), toolCallId: request.toolCallId });
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
        // A moment for a late write from a command that was still running.
        await new Promise((resolve) => setTimeout(resolve, 300));
        current = null;
      }
      const read = (step, ext) => (existsSync(step.file(ext)) ? readFileSync(step.file(ext), "utf8") : null);
      const results = Object.fromEntries(
        steps.map((step) => {
          const exit = read(step, "exit");
          return [step.name, { out: read(step, "out"), err: read(step, "err"), exit: exit === null ? null : Number(exit.trim()) }];
        }),
      );
      if (DEBUG) for (const [name, r] of Object.entries(results)) console.log(`  [debug] ${spec.label} ${name}: exit=${r.exit} out=${JSON.stringify(r.out)?.slice(0, 300)} err=${JSON.stringify(r.err)?.slice(0, 300)}`);
      return { label: spec.label, outcome, state, results, shell: state.permissions.filter((p) => p.kind === "shell") };
    };
    const runWithRetry = async (spec) => {
      // A retry would run a change twice, so only a case that did not start at all is run again.
      let row = await runCase(spec);
      if (/timed out|timeout/i.test(row.outcome) && !row.state.issued.length) row = { ...(await runCase(spec)), retried: true };
      return row;
    };
    const tail = (row) => `session=${row.outcome}${row.retried ? " (retried)" : ""}`;

    // A request to the socket's own calls, from the shell, with the same one-liner: the call that carries the rule about
    // a saved credential by reference, and the old method `call`, which the service no longer has. The answer is the error that the service sent.
    const socketRequest = (...request) => `import { controlClient } from ${JSON.stringify(pathToFileURL(join(dirname(dirname(script)), "desktop", "terminal", "socket.mjs")).href)}; ` +
      `try { await controlClient(process.env.BOTKINS_SOCKET).call(...${JSON.stringify(request)}); console.log("NOT REFUSED"); } ` +
      'catch (error) { console.log(error.code + ": " + error.message); process.exitCode = 3; }';
    const socketCall = socketRequest("chat.respond", "x", { $credential: "x" });
    const socketOldCall = socketRequest("call", "unlockPasswordManager", []);

    // ---- A: yes to every command
    const A = await runWithRetry({
      label: "A",
      answer: "approve",
      steps: () => [
        { name: "path", line: "command -v botkins" },
        { name: "status", line: "botkins status --json" },
        { name: "help", line: "botkins help --json" },
        { name: "add", line: "botkins bots add Tester --json" },
        { name: "list", line: "botkins bots list --json" },
        { name: "remove", line: "botkins bots remove Tester" },
        { name: "after", line: "botkins bots list --json" },
        { name: "unlock", line: "botkins password-managers unlock x" },
        { name: "old", line: `${sq(process.execPath)} --input-type=module -e ${sq(socketOldCall)}` },
        { name: "socket", line: `${sq(process.execPath)} --input-type=module -e ${sq(socketCall)}` },
      ],
    });
    // ---- B: no to a command that changes something
    const B = await runWithRetry({ label: "B", answer: "reject", steps: () => [{ name: "add", line: "botkins bots add Nope --json" }] });
    const botsNow = (await control.call("bots.list").catch(() => [])).map((bot) => bot.name);

    const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
    const r = A.results;
    const listed = json(r.list?.out);
    const after = json(r.after?.out);
    const helped = json(r.help?.out);
    const status = json(r.status?.out);
    const short = (text) => JSON.stringify(String(text ?? "").trim().slice(0, 160));
    console.log(`1 path: command -v botkins -> ${short(r.path.out)} (exit ${r.path.exit}); the launcher is ${reach.command}`);
    console.log(`2 status: exit ${r.status.exit}, pid ${status?.pid} (this service is ${process.pid}), socket ${short(status?.socket)}`);
    console.log(`3 help: exit ${r.help.exit}, areas=${Array.isArray(helped?.areas) ? helped.areas.length : "none"}${Array.isArray(helped?.areas) ? " (" + helped.areas.slice(0, 5).map((a) => a.name).join(", ") + ", ...)" : ""}`);
    console.log(`4 read: bots list exit ${r.list.exit}, ${Array.isArray(listed) ? listed.length + " bot(s): " + listed.map((b) => b.name).join(", ") : "not a list"}; bots add exit ${r.add.exit}`);
    console.log(`5 asks: bots remove with no --yes exit ${r.remove.exit}, error ${short(r.remove.err)}; bots after: ${Array.isArray(after) ? after.map((b) => b.name).join(", ") || "none" : "not a list"}`);
    console.log(`6 refused: unlock exit ${r.unlock.exit} error ${short(r.unlock.err)}`);
    console.log(`6 refused: socket method call exit ${r.old.exit} answer ${short(r.old.out)}`);
    console.log(`6 refused: socket call chat.respond with a reference exit ${r.socket.exit} answer ${short(r.socket.out)}`);
    console.log(`7 asked: yes-case ${new Set(A.shell.map((p) => p.toolCallId)).size} commands asked about in ${A.shell.length} shell requests, for ${A.state.issued.length} commands (${A.state.toolResults} results came back to the model); no-case requests=${B.shell.length}, its command ran=${B.results.add.exit !== null || B.results.add.out !== null}, bots in the service=${botsNow.join(", ") || "none"}`);
    console.log("tools offered by the runtime: " + [...offered].sort().join(", "));

    // ---- What must hold. Each failed condition is one entry of the last line.
    const failed = [];
    const hold = (name, ok, got) => { if (!ok) failed.push(name + (got ? " [" + got + "]" : "")); };
    const ran = (row) => row.outcome === "ok";
    const sentenceOf = (step) => `exit=${step.exit}, error=${short(step.err)}, out=${short(step.out)}`;
    hold("0: the session ran every command once", ran(A) && A.state.issued.length === A.state.steps.length && Object.values(r).every((step) => step.exit !== null), `${tail(A)}, issued=${A.state.issued.length}/${A.state.steps.length}, finished=${Object.values(r).filter((s) => s.exit !== null).length}`);
    hold("1: `command -v botkins` gives the launcher's path", r.path.exit === 0 && r.path.out.trim() === reach.command, sentenceOf(r.path));
    hold("2: `botkins status --json` reaches this service", r.status.exit === 0 && status?.running === true && status.pid === process.pid && status.socket === paths.socket, sentenceOf(r.status));
    hold("3: `botkins help --json` lists areas", r.help.exit === 0 && Array.isArray(helped?.areas) && helped.areas.length > 0 && helped.areas.every((a) => typeof a.name === "string" && Array.isArray(a.commands)), `exit=${r.help.exit}, ${short(r.help.err)}`);
    hold("4: a read works (`botkins bots list --json`)", r.list.exit === 0 && Array.isArray(listed) && listed.some((b) => b.name === "Tester"), sentenceOf(r.list));
    hold("5: a change that asks does not happen with no --yes", r.remove.exit === 2 && /--yes/.test(r.remove.err ?? "") && Array.isArray(after) && after.some((b) => b.name === "Tester") && botsNow.includes("Tester"), `${sentenceOf(r.remove)}, bots after=${Array.isArray(after) ? after.map((b) => b.name).join(",") : "?"}, in the service=${botsNow.join(",")}`);
    hold("6: there is no command to unlock a password manager (an unknown command: exit 2 and its sentence)", r.unlock.exit === 2 && /^botkins: `botkins password-managers` has no command `unlock`\. It has: [^.\n]*\./.test(r.unlock.err ?? "") && !/\bunlock\b/.test((r.unlock.err ?? "").split("It has:")[1] ?? ""), sentenceOf(r.unlock));
    hold("6: a request to the socket with the method `call` is refused: the service has no such call", r.old.exit === 3 && /^UNKNOWN_METHOD: The service has no call named call\./.test(r.old.out ?? ""), sentenceOf(r.old));
    hold("6: a saved credential by reference is refused by the socket's own call", r.socket.exit === 3 && /^BAD_ARGUMENT: A saved credential is chosen in the app's window or on a paired phone\. From the command line, give the value itself\./.test(r.socket.out ?? ""), sentenceOf(r.socket));
    // The runtime may ask twice about one command (it did for the `node -e` line, with the same toolCallId and text), so
    // what counts is that each command, by its call id, was asked about at least once, and nothing else was asked.
    const askedAbout = (row) => new Map(row.shell.map((p) => [p.toolCallId, p.command]));
    const asks = askedAbout(A);
    hold("7: the person is asked before each command", ran(A) && A.state.issued.length > 0 && asks.size === A.state.issued.length && A.state.steps.every((step, i) => asks.get("call_shell_" + (i + 1))?.startsWith(step.line.split(" > ")[0])) && A.shell.length === A.state.permissions.length, `commands=${A.state.issued.length}, asked about=${asks.size} (${A.shell.length} requests), all kinds=${A.state.permissions.map((p) => p.kind).join(",")}`);
    hold("7: with a no the command does not run", ran(B) && B.shell.length === 1 && B.state.issued.length === 1 && B.results.add.exit === null && B.results.add.out === null && !botsNow.includes("Nope"), `requests=${B.shell.length}, ${sentenceOf(B.results.add)}, ${tail(B)}, bots=${botsNow.join(",")}`);
    console.log(failed.length ? "FAILED: " + failed.join("; ") : "PASSED");
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.log("FAILED: the script itself stopped: " + String(error?.stack ?? error).slice(0, 400).replace(/\s*\n\s*/g, " | "));
    process.exitCode = 1;
  } finally {
    await client?.stop?.().catch(() => {});
    await running?.stop("the check ended").catch(() => {});
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
