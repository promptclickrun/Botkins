// Pi as the harness (desktop/providers/pi): the adapter against a stand-in `pi`
// (test/fixtures/fake-pi.mjs) that speaks Pi's RPC protocol. Nothing here starts the real Pi or
// reaches a model.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRA_USAGE, PiProvider, PiRpc, bundledPi, errorText, launcher } from "../desktop/providers/pi/index.mjs";
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
  assert.deepEqual(started.described.servers, { files: { url: "https://mcp.example/x", headers: { A: "b" }, exposure: "direct" } }, "an SSE server is left out");
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

test("a message written during a turn steers it: Pi takes it before its next step", { skip }, async () => {
  const { provider, seen } = setup();
  const session = await provider.openSession(spec());
  let deliver;
  const reply = session.send({ prompt: "slow work" }, undefined, (steer) => (deliver = steer));
  while (!deliver) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await deliver({ prompt: "use tabs", attachments: [{ path: "/tmp/a.txt" }] }), true, "the harness took it");
  const { text } = await reply;
  assert.match(text, /\| steer: use tabs\n\nAttached:\n- \/tmp\/a\.txt/, "delivered inside the same turn");
  assert.ok(seen().some((entry) => entry.command?.type === "steer"));
  assert.equal(seen().filter((entry) => entry.command?.type === "prompt").length, 1, "no second prompt");
  assert.equal(await deliver({ prompt: "too late" }), false, "a finished turn takes no steer");
  await provider.stop();
});

test("a steer Pi took but never delivered before the run ended goes as one more prompt in the turn", { skip }, async () => {
  const { provider, seen } = setup();
  const session = await provider.openSession(spec());
  let deliver;
  const reply = session.send({ prompt: "slow late" }, undefined, (steer) => (deliver = steer));
  while (!deliver) await new Promise((resolve) => setTimeout(resolve, 5));
  await deliver({ prompt: "use tabs" });
  const { text } = await reply;
  assert.match(text, /echo: use tabs/, "nothing the person wrote is dropped");
  assert.ok(seen().some((entry) => entry.command?.type === "clear_queue"));
  await provider.stop();
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
  enabled = false;
  assert.ok(!(await session.inventory()).choices.some((c) => c.command === "show-garden"));
  const withPackage = session.live;
  await session.send({ prompt: "after" });
  assert.ok(withPackage.rpc.closed);
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
