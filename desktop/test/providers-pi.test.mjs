// Pi as the harness (desktop/providers/pi): the adapter against a stand-in `pi`
// (test/fixtures/fake-pi.mjs) that speaks Pi's RPC protocol. Nothing here starts the real Pi or
// reaches a model.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRA_USAGE, PiProvider, PiRpc, bundledPi, errorText, launcher, parseOmpMcpOutput, parsePiMcpNotify } from "../desktop/providers/pi/index.mjs";
import { INVENTORY } from "../desktop/providers/pi/extension-shared.mjs";
import { execFileSync } from "node:child_process";
import { Providers } from "../desktop/providers/index.mjs";
import { ModelProvider } from "../desktop/providers/provider.mjs";
import { recordActivity } from "../desktop/activity.mjs";
import { pass, until, watching } from "./quiet-turns.mjs";

const skip = process.platform === "win32" && "The stand-in is a shell script.";
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "botkins-pi-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const binary = join(root, "pi");
writeFileSync(binary, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(FIXTURE) + ' "$@"\n');
chmodSync(binary, 0o755);

let n = 0;
/** A Pi provider on the stand-in, with a log of what the stand-in saw. */
function setup() {
  const dir = join(root, "case-" + ++n);
  const logFile = join(dir, "log.jsonl");
  const provider = new PiProvider({ dataDir: dir, binary, env: { ...process.env, FAKE_PI_LOG: logFile } });
  const seen = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { provider, dir, seen };
}
const CONNECTION = { name: "botkins-claude", config: { name: "Claude", baseUrl: "http://127.0.0.1:1/claude", api: "anthropic-messages", apiKey: "s", models: [{ id: "opus", name: "Opus", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };
const spec = (more = {}) => ({
  sessionId: "chat-1",
  established: false,
  hasReplies: false,
  folder: root,
  model: { model: "opus", source: "botkins-claude", reasoningEffort: "high" },
  inference: { providers: [CONNECTION] },
  instructions: "You are Testy.",
  context: "",
  tools: [],
  skills: { directories: [], disabled: [] },
  mcpServers: { files: { type: "http", url: "https://mcp.example/x", headers: { A: "b" } }, old: { type: "sse", url: "https://sse.example" } },
  history: () => [],
  handlers: { permission: async () => ({ allow: true }) },
  ...more,
});

test("status: installed with its version, or not installed with Pi's install command", { skip }, async () => {
  const { provider } = setup();
  assert.deepEqual(await provider.status(), { installed: true, version: "1.6.0", connected: true, signIn: null, signOut: false });
  const missing = new PiProvider({ dataDir: join(root, "missing"), binary: join(root, "nope") });
  const status = await missing.status();
  assert.equal(status.installed, false);
  assert.deepEqual(status.install, { url: "https://pi.dev", command: "curl -fsSL https://pi.dev/install.sh | sh" });
});

test("a turn starts Pi in RPC mode on Botkins' own folder, streams the reply, and reports usage", { skip }, async () => {
  const { provider, dir, seen } = setup();
  const session = await provider.openSession(spec());
  const events = [];
  session.on((event) => events.push(event));
  const { text } = await session.send({ prompt: "hello" });
  assert.equal(text, "echo: hello");
  assert.deepEqual(
    events.filter((e) => e.type === "assistant.message_delta").map((e) => e.data.deltaContent),
    ["echo", ": hello"],
  );
  // pi-ai's input is the uncached input; its cache write reaches the run (it was dropped before).
  assert.deepEqual(events.find((e) => e.type === "assistant.usage").data, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 3, model: "opus" });
  assert.deepEqual(events.find((e) => e.type === "session.usage_info").data, { currentTokens: 130, tokenLimit: 1000 });
  const { started } = seen().find((entry) => entry.started);
  assert.equal(started.agentDir, join(dir, "agent"), "the person's own ~/.pi is left alone");
  for (const flag of ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-approve", "builtin:mcp"]) assert.ok(started.args.includes(flag), flag);
  assert.deepEqual(started.args.slice(started.args.indexOf("--model"), started.args.indexOf("--model") + 2), ["--model", "botkins-claude/opus"]);
  assert.deepEqual(started.args.slice(started.args.indexOf("--thinking"), started.args.indexOf("--thinking") + 2), ["--thinking", "high"]);
  assert.equal(started.args[started.args.indexOf("--session-id") + 1], "chat-1");
  // The extension is given the connection, the servers Pi can reach, and the bot's instructions.
  assert.deepEqual(started.described.providers, [CONNECTION]);
  assert.deepEqual(started.described.servers.files, { url: "https://mcp.example/x", headers: { A: "b" }, exposure: "direct" });
  assert.match(started.described.servers.old.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  assert.match(started.described.servers.old.headers.Authorization, /^Bearer /);
  assert.equal(started.described.prompt, "You are Testy.");
  await session.close();
  await provider.stop();
});

test("the file the extension reads is the user's own, and goes when Pi stops", { skip }, async () => {
  const { provider, dir } = setup();
  const session = await provider.openSession(spec());
  await session.send({ prompt: "hi" });
  const live = provider.live.get("chat-1");
  assert.ok(live.file.startsWith(join(dir, "run")));
  assert.equal(statSync(live.file).mode & 0o777, 0o600);
  await provider.stop();
  await live.rpc.exited;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(live.file), false);
});

test("a process let go just before the next turn starts another doesn't take that one's file away", { skip }, async () => {
  // The file has the session's own name: the old process's exit must not remove it from under
  // the new one, which would then start with no connections ("Model … not found").
  const { provider } = setup();
  const first = await provider.openSession(spec());
  await first.send({ prompt: "hi" });
  await first.close();
  const old = provider.live.get("chat-1");
  provider.release("chat-1");
  const next = await provider.openSession(spec());
  await next.send({ prompt: "again" });
  await old.rpc.exited;
  await new Promise((resolve) => setImmediate(resolve));
  const live = provider.live.get("chat-1");
  assert.notEqual(live, old);
  assert.notEqual(live.file, old.file, "each process has a file of its own");
  assert.equal(existsSync(old.file), false, "the old one took its own away");
  assert.ok(existsSync(live.file), "the new process keeps its file");
  const { text } = await next.send({ prompt: "and again" });
  assert.equal(text, "echo: and again");
  await next.close();
  await provider.stop();
  await live.rpc.exited;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(live.file), false, "and it goes when that one stops");
});

test("a tool Pi wants to run asks Botkins' approval rules, and a refusal blocks it", { skip }, async () => {
  for (const allow of [true, false]) {
    const { provider, seen } = setup();
    const asked = [];
    const session = await provider.openSession(spec({ handlers: { permission: async (request) => (asked.push(request), { allow }) } }));
    const events = [];
    session.on((event) => events.push(event));
    await session.send({ prompt: "run bash:ls" });
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0].kind, asked[0].toolName, asked[0].preview, asked[0].remember], ["shell", "bash", "ls", ["this exact command", "ls"]]);
    assert.deepEqual(seen().find((entry) => entry.answer).answer.value, allow ? "allow" : "deny");
    const start = events.find((e) => e.type === "tool.execution_start").data;
    assert.deepEqual([start.toolCallId, start.toolName, start.arguments], ["call-1", "bash", { command: "ls" }]);
    const done = events.find((e) => e.type === "tool.execution_complete").data;
    assert.equal(done.success, allow);
    await provider.stop();
  }
});

test("Botkins' own tools never ask, and MCP tools ask as MCP tools", { skip }, async () => {
  const { provider } = setup();
  const asked = [];
  const session = await provider.openSession(spec({ handlers: { permission: async (request) => (asked.push(request), { allow: true }) } }));
  session.turn = {};
  assert.equal(await session.permission({ toolName: "mcp__botkins__wiki_read", input: {} }), true);
  assert.equal(asked.length, 0);
  assert.equal(await session.permission({ toolName: "mcp__files__get", input: { id: 1 } }), true);
  assert.deepEqual([asked[0].kind, asked[0].label, asked[0].remember], ["mcp", "files / get", ["MCP tool files/get", "files", "get"]]);
  assert.equal(await session.permission({ toolName: "read", input: { path: "/x" } }), true);
  assert.deepEqual([asked[1].kind, asked[1].readOnly], ["read", true]);
  // With no turn, or no one to ask, nothing runs.
  session.turn = null;
  assert.equal(await session.permission({ toolName: "bash", input: { command: "ls" } }), false);
});

test("Pi keeps the Botkins tool call open for the full secure prompt", async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  session.bridge = { url: "http://127.0.0.1:1/mcp/fixture", headers: {} };
  const { servers } = await session.describe();
  assert.ok(servers.botkins.timeout > 5 * 60, "Pi's timeout in seconds must outlast the secure prompt");
  assert.equal(servers.files.timeout, undefined);
});

test("a Pi turn that is quiet for hours is not given up on, and a caller's own limit still applies", { skip }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider } = setup();
  // Pi waits for the person's answer: the turn is quiet, and Pi is alive.
  let answer;
  const session = await provider.openSession(spec({ handlers: { permission: () => new Promise((resolve) => (answer = resolve)) } }));
  const sending = watching(session.send({ prompt: "run bash:ls" }));
  await until(() => answer, "Pi is waiting for the person");
  await pass(t, 3 * 60 * 60 * 1000);
  assert.equal(sending.seen.state, "pending", "three hours of silence did not end the turn");
  answer({ allow: true });
  await sending.done;
  assert.equal(sending.seen.state, "done");
  // A caller with nobody to stop it (a background summary) can still name a limit.
  answer = undefined;
  const limited = watching(session.send({ prompt: "run bash:ls again" }, 60000));
  await until(() => answer, "Pi is waiting again");
  await pass(t, 60000);
  await limited.done;
  assert.match(limited.seen.value.message, /Pi took too long to answer/);
  await provider.stop();
});

test("a model error with no reply fails the turn with the plan's words", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  await assert.rejects(session.send({ prompt: "fail please" }), /The plan said no\./);
  await provider.stop();
});

test("a refused request fails the turn with the provider's own message, and Claude's extra usage says where the plan answers", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  const failed = await session.send({ prompt: "extra please" }).catch((error) => error);
  assert.match(failed.message, /^API Error: 400 You're out of extra usage\. /, "the JSON around it is gone");
  assert.ok(failed.message.endsWith(EXTRA_USAGE));
  await provider.stop();
});

test("errorText reads the provider's message out of Pi's error and keeps any other text", () => {
  assert.equal(errorText('botkins-chatgpt API error (400): {"error":{"message":"Bad schema.","type":"invalid_request_error"}}'), "Bad schema.");
  assert.equal(errorText('500 {"type":"error","error":{"type":"api_error","message":"Down."}}'), "Down.");
  assert.equal(errorText("The plan said no."), "The plan said no.");
  assert.equal(errorText("Odd {not json"), "Odd {not json");
  assert.equal(errorText(undefined), "");
});

test("the next turn reuses the running Pi, and a new model goes to it with set_model", { skip }, async () => {
  const { provider, seen } = setup();
  const first = await provider.openSession(spec());
  await first.send({ prompt: "one" });
  const pid = provider.live.get("chat-1").rpc.child.pid;
  await first.close();
  const second = await provider.openSession(spec({ established: true, hasReplies: true, model: { model: "opus", source: "botkins-claude", reasoningEffort: "low" } }));
  await second.send({ prompt: "two" });
  assert.equal(provider.live.get("chat-1").rpc.child.pid, pid, "the same process");
  assert.equal(seen().filter((entry) => entry.started).length, 1);
  assert.ok(seen().some((entry) => entry.command?.type === "set_thinking_level" && entry.command.level === "low"));
  await second.switchModel({ model: "opus", source: "botkins-claude", reasoningEffort: "max" });
  assert.ok(seen().some((entry) => entry.command?.type === "set_model" && entry.command.provider === "botkins-claude" && entry.command.modelId === "opus"));
  await provider.stop();
});

test("warming a chat starts its Pi ahead of the message, and the message uses that process", { skip }, async () => {
  const { provider, seen } = setup();
  // What Workspace.prewarm does when a chat opens: a session with no turn, warmed, then closed.
  const ahead = await provider.openSession(spec({ established: true, hasReplies: true, handlers: null }));
  await ahead.warm();
  await ahead.close();
  const pid = provider.live.get("chat-1").rpc.child.pid;
  assert.equal(seen().filter((entry) => entry.started).length, 1, "Pi started when the chat opened");
  const turn = await provider.openSession(spec({ established: true, hasReplies: true }));
  await turn.send({ prompt: "hi" });
  assert.equal(provider.live.get("chat-1").rpc.child.pid, pid, "the same process");
  assert.equal(seen().filter((entry) => entry.started).length, 1, "nothing started again for the message");
  await provider.stop();
});

test("an explicit steer interrupts Pi and sends just the replacement and its files on the same conversation", { skip }, async (t) => {
  const { provider, seen } = setup();
  t.after(() => provider.stop());
  const session = await provider.openSession(spec());
  let deliver;
  const reply = session.send({ prompt: "slow work" }, undefined, steer => { deliver = steer; });
  await until(() => deliver);
  assert.equal(await deliver({ prompt: "use tabs", attachments: [{ path: "/tmp/a.txt" }] }), true);
  assert.equal((await reply).text, "echo: use tabs\n\nAttached:\n- /tmp/a.txt");
  assert.deepEqual(seen().map(e => e.command).filter(c => ["abort","prompt","steer"].includes(c?.type)).map(c => [c.type, c.message]), [
    ["prompt", "slow work"], ["abort", undefined], ["prompt", "use tabs\n\nAttached:\n- /tmp/a.txt"],
  ]);
  assert.equal(await deliver({ prompt: "too late" }), false);
});

test("a late abort acknowledgement and early replacement settle retain each accepted steer exactly once", { skip }, async (t) => {
  const { provider, seen } = setup();
  t.after(() => provider.stop());
  const session = await provider.openSession(spec());
  await session.warm();
  const { rpc } = session.live;
  const request = rpc.request.bind(rpc);
  const idle = Promise.withResolvers(), release = Promise.withResolvers();
  let gated = false;
  t.mock.method(rpc, "request", async (command, deadline) => {
    const reply = await request(command, deadline);
    if (command.type === "abort" && !gated) {
      gated = true;
      await idle.promise;
      await release.promise;
    }
    return reply;
  });
  rpc.on(event => { if (event.type === "agent_settled") idle.resolve(); });
  let deliver;
  const reply = session.send({ prompt: "slow late" }, undefined, steer => { deliver = steer; });
  await until(() => deliver);
  const first = watching(deliver({ prompt: "first correction" }));
  const second = watching(deliver({ prompt: "second correction" }));
  await idle.promise;
  assert.equal(first.seen.state, "pending", "the original settle is not an admission");
  assert.equal(second.seen.state, "pending");
  assert.equal(seen().filter(e => e.command?.type === "prompt").length, 1);
  release.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(first.seen.value, true);
  assert.equal(second.seen.value, true);
  assert.equal((await reply).text, "echo: second correction");
  assert.deepEqual(seen().filter(e => e.command?.type === "prompt").map(e => e.command.message), ["slow late", "first correction", "second correction"]);
});

test("a conversation Pi never held goes on from Botkins' transcript", { skip }, async () => {
  const { provider, seen } = setup();
  const history = [{ role: "user", text: "what is 2+2" }, { role: "assistant", text: "4" }, { role: "user", text: "and again?" }];
  const session = await provider.openSession(spec({ established: true, hasReplies: true, history: () => history }));
  await session.send({ prompt: "and again?" });
  const { prompt } = seen().find((entry) => entry.started).started.described;
  assert.match(prompt, /^You are Testy\./);
  // The transcript comes once, before the message, and never in the system prompt Pi is given each run.
  assert.doesNotMatch(prompt, /what is 2\+2/);
  const sent = seen().filter((entry) => entry.command?.type === "prompt").map((entry) => entry.command.message);
  assert.match(sent[0], /^\[Botkins: this conversation continues from earlier\.[\s\S]*User: what is 2\+2\n\nAssistant: 4\n<\/earlier-conversation>\n\nand again\?$/);
  await provider.stop();
});

test("Pi's ids: a Botkins session id Pi can't take is made into one it can", { skip }, async () => {
  const { provider, seen } = setup();
  const session = await provider.openSession(spec({ sessionId: "chat:with/odd chars" }));
  await session.send({ prompt: "x" });
  const { args } = seen().find((entry) => entry.started).started;
  assert.match(args[args.indexOf("--session-id") + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  await provider.stop();
});

test("the registry keeps a harness out of the model providers but finds it by id", { skip }, async () => {
  class Fake extends ModelProvider {
    id = "copilot";
    name = "Copilot";
  }
  const { provider } = setup();
  const providers = new Providers([new Fake(), provider]);
  assert.deepEqual(providers.list.map((p) => p.id), ["copilot"]);
  assert.equal(providers.get("pi"), provider);
  assert.deepEqual((await providers.statuses()).map((s) => s.id), ["copilot"]);
  const [pi] = await providers.harnessStatuses();
  assert.deepEqual([pi.id, pi.harness, pi.installed, pi.version], ["pi", true, true, "1.6.0"]);
  assert.equal((await providers.status("pi")).id, "pi", "the install flow finds it");
});

test("a package change refreshes the next Pi turn and its slash commands", { skip }, async (t) => {
  const { provider, seen } = setup();
  t.after(() => provider.stop());
  let enabled = false;
  t.mock.method(provider.packages, "activePaths", () => enabled ? ["/fixture/pi-package"] : []);
  const session = await provider.openSession(spec());
  await session.send({ prompt: "before" });
  const before = session.live;
  enabled = true;
  const { choices } = await session.inventory();
  assert.ok(choices.some((c) => c.command === "skill:garden" && c.kind === "Skill"));
  assert.ok(before.rpc.closed);
  assert.equal(session.live.ref, before.ref);
  const [first, restarted] = seen().filter((entry) => entry.started).map((entry) => entry.started.args);
  assert.ok(!first.includes("/fixture/pi-package"));
  assert.equal(restarted[restarted.indexOf("/fixture/pi-package") - 1], "-e", "an active package is an extension path to Pi");
  const resolved = await session.resolvePrompt("/show-garden", {}, {}, {});
  assert.equal(resolved.kind, "agent-prompt");
  // A handled extension command has no model turn and no agent_settled event.
  assert.deepEqual(await session.send({ prompt: resolved.prompt }, 100), { text: "" });
  const withPackage = session.live;
  enabled = false;
  assert.ok(!(await session.inventory()).choices.some((c) => c.command === "show-garden"));
  assert.ok(withPackage.rpc.closed);
  assert.equal(session.live.ref, before.ref);
  await session.send({ prompt: "after" });
  assert.equal(session.live.ref, before.ref);
});

test("a character split across two reads of Pi's output comes back whole, on stdout and stderr", { skip }, async () => {
  const text = "emoji \u{1F600} and CJK \u6F22\u5B57";
  const bytes = Buffer.from(JSON.stringify({ type: "note", text }) + "\n");
  // Cut inside the emoji and inside the first CJK character.
  const cuts = [bytes.indexOf(0xf0) + 2, bytes.indexOf(0xe6) + 1];
  const script = `
    const bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");
    const cuts = ${JSON.stringify(cuts)};
    const parts = [bytes.subarray(0, cuts[0]), bytes.subarray(cuts[0], cuts[1]), bytes.subarray(cuts[1])];
    (async () => {
      for (const part of parts) {
        process.stdout.write(part);
        process.stderr.write(part);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      process.exit(0);
    })();`;
  const rpc = new PiRpc(process.execPath, ["-e", script]);
  const heard = [];
  rpc.on((message) => heard.push(message));
  const reason = await rpc.exited;
  assert.deepEqual(heard.find((m) => m.type === "note"), { type: "note", text });
  assert.equal(heard.length, 2, "the exit notice is the only other event");
  assert.ok(rpc.stderr.includes(text), rpc.stderr);
  assert.ok(!reason.message.includes("\uFFFD") && !rpc.stderr.includes("\uFFFD"));
});

test("a tool call shows as a running step from toolcall_start and stays one step through execution", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  const events = [];
  session.on((event) => events.push(event));
  const run = {};
  const notified = [];
  session.on((event) => recordActivity(run, event, () => notified.push(run.steps.map((s) => s.status + ":" + s.label))));
  await session.send({ prompt: "early bash:ls" });
  const tools = events.filter((e) => e.type.startsWith("tool."));
  assert.deepEqual(
    tools.map((e) => [e.type, e.data.toolCallId, e.data.toolName, e.data.arguments]),
    [
      ["tool.execution_start", "call-1", "bash", {}],
      ["tool.execution_start", "call-1", "bash", { command: "ls" }],
      ["tool.execution_complete", "call-1", undefined, undefined],
    ],
    "the execution's own start repeats nothing: its arguments are the ones already sent",
  );
  assert.equal(run.steps.length, 1);
  assert.deepEqual([run.steps[0].status, run.steps[0].label, run.steps[0].name], ["Done", "ls", "bash"]);
  assert.deepEqual(notified[0], ["Running:bash"]);
  assert.ok(notified.some((n) => n[0] === "Running:ls"));
  await provider.stop();
});

test("a call that is written but never executed ends as Stopped, not Running", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  const events = [];
  session.on((event) => events.push(event));
  const run = {};
  session.on((event) => recordActivity(run, event, () => {}));
  await session.send({ prompt: "dangle" });
  const tools = events.filter((e) => e.type.startsWith("tool."));
  assert.deepEqual(tools.map((e) => [e.type, e.data.toolCallId, e.data.success, e.data.error?.message]), [
    ["tool.execution_start", "call-9", undefined, undefined],
    ["tool.execution_complete", "call-9", false, "Stopped"],
  ]);
  assert.deepEqual([run.steps.length, run.steps[0].status, run.steps[0].output], [1, "Stopped", "Stopped"], "stopped, not counted as a failure");
  await provider.stop();
});

test("the Pi that ships with Botkins is found first, and is the version the adapter is built for", async () => {
  const cli = bundledPi();
  assert.ok(cli && existsSync(cli), "the dependency's command line script");
  const provider = new PiProvider({ dataDir: join(root, "bundled") });
  assert.equal(await provider.locate(), cli);
  const { version } = JSON.parse(readFileSync(join(cli, "..", "..", "..", "package.json"), "utf8"));
  const status = await provider.status();
  assert.deepEqual([status.installed, status.version], [true, version]);
});

test("a bundled script runs on this program's Node, without ELECTRON_RUN_AS_NODE reaching what it starts", () => {
  const script = join(root, "show.mjs");
  writeFileSync(script, "console.log(JSON.stringify({ flag: process.env.ELECTRON_RUN_AS_NODE ?? null, argv: process.argv.slice(1) }))");
  const start = launcher(script, ["--mode", "rpc"]);
  assert.equal(start.file, process.execPath);
  const out = JSON.parse(execFileSync(start.file, start.args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }));
  assert.equal(out.flag, null, "a bot's shell commands don't inherit it");
  assert.deepEqual(out.argv, [script, "--mode", "rpc"], "Pi sees its own command line");
  assert.deepEqual(launcher("/usr/local/bin/pi", ["x"]), { file: "/usr/local/bin/pi", args: ["x"], env: {} }, "an installed program runs as it is");
});

test("a server Botkins gave Pi earlier but this turn hasn't does nothing; a Pi package's own server still asks", { skip }, async () => {
  // Pi keeps every server it was given registered, so its tool list stays the same from turn to
  // turn (extension-shared.mjs). One the turn's person may not use is turned down here.
  const { provider } = setup();
  const asked = [];
  const session = await provider.openSession(spec({ mcpServers: {}, handlers: { permission: async (request) => (asked.push(request.label), { allow: true }) } }));
  session.turn = { calls: new Map() };
  session.live = { given: new Set(["crm", "botkins"]) };
  assert.equal(await session.permission({ toolCallId: "1", toolName: "mcp__crm__find", mcpServerName: "crm", mcpToolName: "find", input: {} }), false);
  assert.equal(await session.permission({ toolCallId: "2", toolName: "mcp__notes__read", mcpServerName: "notes", mcpToolName: "read", input: {} }), true);
  assert.deepEqual(asked, ["notes / read"]);
  session.turn = null;
  await provider.stop();
});

test("a chat warmed before its first message still gives Pi every Botkins tool", { skip }, async (t) => {
  // Pi lists the bridge's tools once, when it connects. A process warmed with no turn (and so no
  // handlers) must already see them, or the conversation goes without them until Pi restarts.
  const { ToolBridge } = await import("../desktop/providers/toolbridge.mjs");
  const bridge = new ToolBridge();
  const dir = join(root, "case-bridge");
  const provider = new PiProvider({ dataDir: dir, binary, bridge, env: { ...process.env, FAKE_PI_LOG: join(dir, "log.jsonl") } });
  t.after(() => Promise.all([provider.stop(), bridge.stop()]));
  let ran = 0;
  const side = { name: "side_pane_show", description: "Show a panel.", parameters: { type: "object", properties: {} }, skipPermission: true, defer: "never", handler: async () => (ran++, "shown") };
  const list = async (server) => {
    const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    return (await response.json()).result.tools.map((tool) => tool.name);
  };
  const call = async (server) => {
    const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "side_pane_show", arguments: {} } }) });
    return (await response.json()).result;
  };
  // What Workspace.prewarm does: no turn, no handlers.
  const ahead = await provider.openSession(spec({ established: true, hasReplies: true, handlers: null, tools: [side], mcpServers: {} }));
  await ahead.warm();
  const { servers } = await ahead.describe();
  assert.ok(servers.botkins, "the bridge is one of Pi's servers");
  assert.deepEqual((await list(servers.botkins)).sort(), ["side_pane_show", "update_plan"]);
  await ahead.close();
  // Between turns nothing runs: a call says so.
  const idle = await call(servers.botkins);
  assert.equal(idle.isError, true);
  assert.equal(ran, 0);
  // The turn's own tools run.
  const turn = await provider.openSession(spec({ established: true, hasReplies: true, tools: [side], mcpServers: {} }));
  await turn.warm();
  assert.equal((await call(servers.botkins)).isError, undefined);
  assert.equal(ran, 1);
  await turn.close();
});

test("MCP status parsers distinguish connected, pending, failed, needs-auth, disconnected and disabled", () => {
  const attention = parsePiMcpNotify("MCP servers need attention:\n  down: failed: HTTP 500\n  mail: needs sign-in\nRun /mcp to fix.");
  assert.equal(attention.settled, true);
  assert.deepEqual(Object.fromEntries(attention.states), { down: "failed", mail: "needs-auth" });

  const status = parsePiMcpNotify(
    "ok: connected, 2 tools (direct)\nempty: connected, 0 tools (direct)\npend: connecting (direct)\ndisc: disconnected, reconnects on next call (direct)\ndis: disabled (direct)\nauth: needs sign-in, run /mcp login auth (direct)\nbad: failed (direct)",
  );
  assert.deepEqual(Object.fromEntries(status.states), {
    ok: "connected",
    empty: "connected",
    pend: "pending",
    disc: "disconnected",
    dis: "disabled",
    auth: "needs-auth",
    bad: "failed",
  });

  assert.deepEqual(parseOmpMcpOutput('Server "empty" connected (0 tools).'), { name: "empty", status: "connected" });
  assert.deepEqual(parseOmpMcpOutput('Connection to "auth" failed: HTTP 401: unauthorized [WWW-Authenticate: Bearer]'), { name: "auth", status: "needs-auth" });
  assert.deepEqual(parseOmpMcpOutput('Connection to "down" failed: HTTP 500: boom'), { name: "down", status: "failed" });
  assert.deepEqual(parseOmpMcpOutput('Server "gone" not found.'), { name: "gone", status: "unavailable" });
});

test("Pi inventory reflects runtime connection states, direct vs indirect exposure, changed access and active turns", { skip }, async (t) => {
  const { provider } = setup();
  t.after(() => provider.stop());
  const session = await provider.openSession(spec({
    mcpServers: {
      direct_srv: { type: "http", url: "http://127.0.0.1:9/direct" },
      indirect_srv: { type: "http", url: "http://127.0.0.1:9/indirect" },
      pend_srv: { type: "http", url: "http://127.0.0.1:9/pend" },
      fail_srv: { type: "http", url: "http://127.0.0.1:9/fail" },
      auth_srv: { type: "http", url: "http://127.0.0.1:9/auth" },
      sse_srv: { type: "sse", url: "http://127.0.0.1:9/sse" },
    },
  }));
  const live = await session.start();
  // Simulate live telemetry emitted by extension-shared.mjs and builtin:mcp.
  provider.observeRuntime(live, {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: INVENTORY,
    statusText: JSON.stringify({
      tools: [
        { name: "mcp__direct_srv__search", description: "Search directly", active: true, exposure: "direct" },
        { name: "mcp__indirect_srv__query", description: "Query via codemode", active: true, exposure: "codemode" },
        { name: "mcp__indirect_srv__secret", description: "Hidden tool", active: true, exposure: "hidden" },
        { name: "mcp__stale_srv__old", description: "Removed server tool", active: true, exposure: "direct" },
      ],
      servers: [
        { name: "direct_srv", enabled: true, exposure: "direct" },
        { name: "indirect_srv", enabled: true, exposure: "codemode" },
        { name: "pend_srv", enabled: true, exposure: "direct" },
        { name: "fail_srv", enabled: true, exposure: "direct" },
        { name: "auth_srv", enabled: true, exposure: "direct" },
        { name: "stale_srv", enabled: true, exposure: "direct" },
      ],
    }),
  });
  provider.observeRuntime(live, {
    type: "extension_ui_request",
    method: "notify",
    message: "direct_srv: connected, 1 tools (direct)\nindirect_srv: connected, 1 tools (codemode)\npend_srv: connecting (direct)\nfail_srv: failed (direct)\nauth_srv: needs sign-in, run /mcp login auth_srv (direct)",
  });

  const inv = await session.inventory();
  assert.deepEqual(inv.servers, [
    { name: "direct_srv", status: "connected" },
    { name: "indirect_srv", status: "connected" },
    { name: "pend_srv", status: "pending" },
    { name: "fail_srv", status: "failed" },
    { name: "auth_srv", status: "needs-auth" },
    { name: "sse_srv", status: "configured" },
  ]);
  const direct = inv.choices.find((c) => c.kind === "Tool" && c.name === "search" && c.source === "direct_srv");
  const indirect = inv.choices.find((c) => c.kind === "Tool" && c.name === "query" && c.source === "indirect_srv");
  assert.equal(direct?.exposure, "direct");
  assert.equal(indirect?.exposure, "indirect");
  assert.ok(!inv.choices.some((c) => c.name === "secret"), "hidden tools are not presented as callable");
  assert.ok(!inv.choices.some((c) => c.name === "old" || c.source === "stale_srv"), "removed servers never leak stale tools");

  // Pending server transitioning to connected exposes its tools immediately.
  provider.observeRuntime(live, {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: INVENTORY,
    statusText: JSON.stringify({
      tools: [
        { name: "mcp__direct_srv__search", description: "Search directly", active: true, exposure: "direct" },
        { name: "mcp__pend_srv__ready", description: "Now ready", active: true, exposure: "direct" },
      ],
      servers: live.runtime.servers,
    }),
  });
  const afterReady = await session.inventory();
  assert.equal(afterReady.servers.find((s) => s.name === "pend_srv")?.status, "connected");
  assert.ok(afterReady.choices.some((c) => c.source === "pend_srv" && c.name === "ready"));

  // Changed access during an active turn filters stale tools and never restarts the process.
  session.turn = { calls: new Map(), rows: new Map() };
  session.spec = spec({
    mcpServers: {
      newly_added: { type: "http", url: "http://127.0.0.1:9/new" },
    },
  });
  const activeInv = await session.inventory();
  assert.equal(session.live, live, "active turn does not restart Pi");
  assert.ok(!live.rpc.closed);
  assert.deepEqual(activeInv.servers, [{ name: "newly_added", status: "configured" }]);
  assert.ok(!activeInv.choices.some((c) => c.source === "direct_srv" || c.source === "pend_srv"), "removed tools disappear immediately");
  session.turn = null;
  await session.close();
});

test("Pi inventory resolves aliased plugin MCP servers back to Botkins server names", { skip }, async (t) => {
  const { provider } = setup();
  t.after(() => provider.stop());
  const pluginOk = "plugin_alpha__server_a1b2c3d4";
  const pluginFail = "plugin_beta__server_e5f6a7b8";
  const aliasOk = "bkp_aaaaaaaaaaaa";
  const aliasFail = "bkp_bbbbbbbbbbbb";
  const session = await provider.openSession(spec({
    mcpServers: {
      [pluginOk]: { type: "http", url: "http://127.0.0.1:9/alpha" },
      [pluginFail]: { type: "http", url: "http://127.0.0.1:9/beta" },
    },
  }));
  const live = await session.start();
  // Match PR #321's PiSession.aliases contract (harness alias -> Botkins server name).
  session.aliases = new Map([
    [aliasOk, pluginOk],
    [aliasFail, pluginFail],
  ]);
  live.registeredConfigs = new Map([
    [aliasOk, JSON.stringify(provider.serverRecord(session.spec.mcpServers[pluginOk]))],
    [aliasFail, JSON.stringify(provider.serverRecord(session.spec.mcpServers[pluginFail]))],
  ]);
  provider.observeRuntime(live, {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: INVENTORY,
    statusText: JSON.stringify({
      tools: [
        { name: `mcp__${aliasOk}__search`, description: "Plugin search", active: true, exposure: "direct" },
        { name: "mcp__bkp_zzzzzzzzzzzz__stale", description: "Revoked plugin tool", active: true, exposure: "direct" },
      ],
      servers: [
        { name: aliasOk, enabled: true, exposure: "direct" },
        { name: aliasFail, enabled: true, exposure: "direct" },
      ],
    }),
  });
  provider.observeRuntime(live, {
    type: "extension_ui_request",
    method: "notify",
    message: `${aliasOk}: connected, 1 tools (direct)\n${aliasFail}: failed (direct)`,
  });

  const inv = await session.inventory();
  assert.deepEqual(inv.servers, [
    { name: pluginOk, status: "connected" },
    { name: pluginFail, status: "failed" },
  ]);
  const tool = inv.choices.find((c) => c.kind === "Tool" && c.source === pluginOk && c.name === "search");
  assert.equal(tool?.exposure, "direct");
  assert.ok(!inv.choices.some((c) => c.source?.startsWith("bkp_") || c.name === "stale"), "internal aliases and revoked plugin tools stay hidden");
  await session.close();
});

