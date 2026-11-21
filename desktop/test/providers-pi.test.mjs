// Pi as the harness (desktop/providers/pi): the adapter against a stand-in `pi`
// (test/fixtures/fake-pi.mjs) that speaks Pi's RPC protocol. Nothing here starts the real Pi or
// reaches a model.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiProvider } from "../desktop/providers/pi/index.mjs";
import { Providers } from "../desktop/providers/index.mjs";
import { ModelProvider } from "../desktop/providers/provider.mjs";

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
  assert.deepEqual(events.find((e) => e.type === "assistant.usage").data, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 0, model: "opus" });
  assert.deepEqual(events.find((e) => e.type === "session.usage_info").data, { currentTokens: 127, tokenLimit: 1000 });
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

test("a model error with no reply fails the turn with the plan's words", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  await assert.rejects(session.send({ prompt: "fail please" }), /The plan said no\./);
  await provider.stop();
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

test("a conversation Pi never held goes on from Botkins' transcript", { skip }, async () => {
  const { provider, seen } = setup();
  const history = [{ role: "user", text: "what is 2+2" }, { role: "assistant", text: "4" }, { role: "user", text: "and again?" }];
  const session = await provider.openSession(spec({ established: true, hasReplies: true, history: () => history }));
  await session.send({ prompt: "and again?" });
  const { prompt } = seen().find((entry) => entry.started).started.described;
  assert.match(prompt, /^You are Testy\./);
  assert.match(prompt, /what is 2\+2/);
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
