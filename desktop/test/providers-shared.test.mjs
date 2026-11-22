// What the command-line model providers share: the tool bridge, the JSON-RPC channel to a child
// process, the session records, the "/" menu, and the registry that merges every provider's
// status and models.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Providers, ModelProvider, defineTool } from "../desktop/providers/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { StdioRpc, findBinary, versionOf } from "../desktop/providers/cli.mjs";
import { SessionStore, missingConversation, serversWithTokens, transcriptContext, uuidFor } from "../desktop/providers/sessions.mjs";
import { buildInventory, resolvePrompt } from "../desktop/providers/commands.mjs";
import { enabledSkills, skillChoices, skillSupport } from "../desktop/providers/skills.mjs";
import { tempDir, tick } from "./fake-copilot.mjs";
import { watchQuiet } from "../desktop/providers/liveness.mjs";
import { pass, settle } from "./quiet-turns.mjs";

const rpc = (url, headers, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the tool bridge serves a session's tools as an MCP server, to that session's secret only", async (t) => {
  const bridge = new ToolBridge({ version: "9" });
  t.after(() => bridge.stop());
  const calls = [];
  const tools = [
    defineTool("greet", {
      description: "Says hello.\nSecond line.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: ({ name }) => (calls.push(name), JSON.stringify({ greeting: "Hello " + name })),
    }),
    defineTool("broken", { description: "Fails", parameters: { type: "object", properties: {} }, handler: () => { throw new Error("This turn is no longer active"); } }),
  ];
  const endpoint = await bridge.open(tools);
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{24}$/);
  assert.match(endpoint.headers.Authorization, /^Bearer .{20,}$/);

  // The handshake an MCP client makes.
  const hello = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
  assert.equal(hello.result.protocolVersion, "2025-03-26", "the client's protocol version is kept when the bridge knows it");
  assert.deepEqual(hello.result.serverInfo, { name: "botkins", version: "9" });
  assert.deepEqual(hello.result.capabilities, { tools: { listChanged: false } });
  const unknown = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
  const noted = await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(noted.status, 202, "a notification gets no reply");
  assert.equal(await noted.text(), "");

  const listed = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
  assert.deepEqual(listed.result.tools.map((x) => x.name), ["greet", "broken"]);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["name"]);

  const called = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "greet", arguments: { name: "Ada" } } })).json();
  assert.deepEqual(called.result, { content: [{ type: "text", text: '{"greeting":"Hello Ada"}' }] });
  assert.deepEqual(calls, ["Ada"]);
  // A handler that throws is a tool error the model can read, not a broken connection.
  const failed = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "broken", arguments: {} } })).json();
  assert.deepEqual(failed.result, { content: [{ type: "text", text: "This turn is no longer active" }], isError: true });
  const missing = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).json();
  assert.equal(missing.result.isError, true);
  const odd = await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 7, method: "sampling/createMessage" })).json();
  assert.equal(odd.error.code, -32601);
  // A batch is answered as a batch; a ping keeps a connection alive.
  const batch = await (await rpc(endpoint.url, endpoint.headers, [{ jsonrpc: "2.0", id: 8, method: "ping" }, { jsonrpc: "2.0", method: "notifications/cancelled" }, { jsonrpc: "2.0", id: 9, method: "prompts/list" }])).json();
  assert.deepEqual(batch.map((m) => m.id), [8, 9]);

  // Who may call: the session's own secret, never a browser page, never another session's address.
  assert.equal((await rpc(endpoint.url, {}, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc(endpoint.url, { Authorization: "Bearer wrong" }, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc(endpoint.url, { ...endpoint.headers, Origin: "https://evil.example" }, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 403);
  const other = await bridge.open([]);
  assert.equal((await rpc(other.url, endpoint.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401, "one session's secret doesn't open another's address");
  assert.equal((await fetch(endpoint.url, { headers: endpoint.headers })).status, 405, "there is no event stream to open");
  const garbled = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json", ...endpoint.headers }, body: "not json {" });
  assert.equal(garbled.status, 400);
  assert.equal((await garbled.json()).error.code, -32700);

  // Between turns a kept session has no tools; the next turn's are swapped in.
  endpoint.set([]);
  assert.deepEqual((await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools, []);
  endpoint.set([tools[0]]);
  assert.deepEqual((await (await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools.map((x) => x.name), ["greet"]);
  endpoint.close();
  assert.equal((await rpc(endpoint.url, endpoint.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401, "a closed address answers nobody");

  // An address kept for a conversation is the same each time it is opened, for a backend that
  // goes on using the one it was first given. Closing it only takes the tools away.
  const kept = await bridge.open([tools[0]], { key: "codex:chat-1" });
  kept.close();
  assert.deepEqual((await (await rpc(kept.url, kept.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools, []);
  const again = await bridge.open([tools[0]], { key: "codex:chat-1" });
  assert.deepEqual([again.url, again.authorization], [kept.url, kept.authorization]);
  assert.deepEqual((await (await rpc(kept.url, kept.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools.map((x) => x.name), ["greet"]);
  assert.notEqual((await bridge.open([], { key: "codex:chat-2" })).url, kept.url);
  bridge.forget("codex:chat-1");
  bridge.forget("never-opened");
  assert.equal((await rpc(kept.url, kept.headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
});

test("the channel to a command-line backend carries requests both ways and survives the child stopping", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/echo-rpc.mjs", import.meta.url));
  const plain = new StdioRpc(process.execPath, [fixture]);
  assert.deepEqual(await plain.request("echo", { a: 1 }), { echoed: { a: 1 }, jsonrpc: null }, "Codex's app-server leaves the version field out");
  await assert.rejects(plain.request("fail"), /No, thank you\./);
  const seen = [];
  const off = plain.onNotification((method, params) => seen.push([method, params]));
  await plain.request("notify");
  assert.deepEqual(seen, [["hello", { from: "child" }]]);
  off();
  // The child asks; the client answers; the child reports what it heard.
  plain.onRequest(async (method, params) => ({ heard: method + ":" + params.text }));
  assert.deepEqual(await plain.request("ask", { text: "ready?" }), { answered: { heard: "question:ready?" }, refused: null });
  plain.onRequest(async () => {
    throw new Error("Not now");
  });
  assert.deepEqual(await plain.request("ask", { text: "again?" }), { answered: null, refused: "Not now" });
  await assert.rejects(plain.request("never-answered", {}, 50), /didn't answer in time/);
  // 0 is no deadline at all: a turn is one such request, and the person is the one who ends it.
  const unlimited = plain.request("never-answered", {}, 0);
  let answered = false;
  unlimited.then(() => (answered = true), () => (answered = true));
  await tick(120);
  assert.equal(answered, false);
  // A request in flight fails when the child stops, and later ones fail at once.
  const inFlight = plain.request("never-answered", {}, 5000);
  plain.notify("quit");
  await assert.rejects(inFlight, /stopped/);
  await plain.exited;
  await assert.rejects(plain.request("echo"), /has stopped/);

  const strict = new StdioRpc(process.execPath, [fixture], { jsonrpc: true });
  assert.equal((await strict.request("echo", {})).jsonrpc, "2.0", "ACP agents get the version field");
  await strict.close();
  assert.equal(strict.closed, true);

  assert.equal(await findBinary("botkins-no-such-tool-" + Date.now()), null);
  assert.equal(await findBinary("x", { override: process.execPath }), process.execPath, "a path the person set is used as it is");
  assert.equal(await findBinary("x", { override: "/nowhere/at/all" }), null);
  assert.equal(versionOf("codex-cli 0.169.0"), "0.169.0");
  assert.equal(versionOf("2.1.325 (Claude Code)"), "2.1.325");
  assert.equal(versionOf("nothing"), "");
});

test("a quiet turn's harness is asked after each quiet spell: alive or unsure goes on waiting, gone ends the turn once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gone = [];
  let asked = 0;
  let answer = () => undefined;
  const watch = watchQuiet({ every: 60000, probeMs: 10000, probe: async () => (asked++, answer()), onDead: (error) => gone.push(error.message) });
  await pass(t, 10 * 60000);
  assert.equal(asked, 10, "asked once per quiet spell, with no limit");
  // A sign of life starts the quiet spell again.
  t.mock.timers.tick(50000);
  watch.touch();
  await pass(t, 50000);
  assert.equal(asked, 10);
  await pass(t, 10000);
  assert.equal(asked, 11);
  // No answer in time is no news; so is an answer that is late.
  answer = () => new Promise(() => {});
  const before = asked;
  await pass(t, 5 * 60000);
  assert.deepEqual(gone, []);
  assert.ok(asked >= before + 3, "an unanswered check does not stop the next one");
  // Gone: the turn ends once, and nothing is asked again.
  answer = () => Promise.reject(new Error("Connection is closed."));
  await pass(t, 2 * 60000);
  const total = asked;
  await pass(t, 10 * 60000);
  assert.deepEqual(gone, ["Connection is closed."]);
  assert.equal(asked, total);
  watch.stop();
});

test("a quiet turn's check that finds the harness gone is not believed when the harness spoke meanwhile, and stop() ends the watching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gone = [];
  let release;
  const watch = watchQuiet({ every: 60000, probe: () => new Promise((_, reject) => (release = () => reject(new Error("closed")))), onDead: (error) => gone.push(error.message) });
  await pass(t, 60000);
  watch.touch();
  release();
  await settle();
  assert.deepEqual(gone, [], "it spoke while the question was out");
  watch.stop();
  await pass(t, 10 * 60000);
  assert.deepEqual(gone, []);
});

test("session records remember which backend conversation belongs to a Botkins session", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "codex", "sessions.json");
  const store = new SessionStore(file);
  assert.equal(store.get("chat-1"), undefined);
  store.set("chat-1", { ref: "thread-a", turns: [] });
  store.update("chat-1", (record) => record.turns.push("t1"));
  store.update("missing", () => assert.fail("a missing record is not changed"));
  assert.deepEqual(new SessionStore(file).get("chat-1"), { ref: "thread-a", turns: ["t1"] }, "records are read back from disk");
  assert.equal(readFileSync(file, "utf8").includes("thread-a"), true);
  store.delete("chat-1");
  assert.equal(new SessionStore(file).get("chat-1"), undefined);
  assert.ok(!existsSync(file + ".tmp"), "no half-written file is left behind");
  const memory = new SessionStore();
  memory.set("a", { ref: "b" });
  assert.deepEqual(memory.get("a"), { ref: "b" }, "without a file the records live in memory");

  // Claude Code only takes UUIDs: the same session always gets the same one.
  const id = uuidFor("chat-1-team-pip");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(uuidFor("chat-1-team-pip"), id);
  assert.notEqual(uuidFor("chat-1-team-scout"), id);

  assert.equal(missingConversation(new Error("No conversation found with session ID 123")), true);
  assert.equal(missingConversation(new Error("no rollout found for thread id abc")), true);
  assert.equal(missingConversation(new Error("rate limit exceeded")), false);

  // A lost conversation continues from Botkins' transcript, without the message being answered now.
  const context = transcriptContext({ history: () => [{ role: "user", text: "Plan the week" }, { role: "assistant", text: "Monday first." }, { role: "user", text: "And Tuesday?" }] }, "Pip");
  assert.match(context, /User: Plan the week/);
  assert.match(context, /Pip: Monday first\./);
  assert.doesNotMatch(context, /Tuesday/);
  assert.equal(transcriptContext({ history: () => [] }), "");

  // A remote MCP server that signs in with OAuth gets its current token as a header.
  const asked = [];
  const servers = await serversWithTokens({
    mcpServers: {
      files: { type: "stdio", command: "npx", args: [] },
      crm: { type: "http", url: "https://crm.example/mcp", headers: {} },
      keyed: { type: "http", url: "https://keyed.example/mcp", headers: { authorization: "Bearer own" } },
      open: { type: "http", url: "https://open.example/mcp" },
    },
    mcpAuth: async (request) => (asked.push(request.server), request.server === "crm" ? { accessToken: "tok", tokenType: "Bearer" } : null),
  });
  assert.deepEqual(asked, ["crm", "open"], "a local server and one with its own header are not asked about");
  assert.equal(servers.crm.headers.Authorization, "Bearer tok");
  assert.deepEqual(servers.keyed.headers, { authorization: "Bearer own" });
  assert.equal(servers.open.headers, undefined);
});

test("the shared slash menu lists Botkins' commands and tools and carries out the ones it owns", async () => {
  const tools = [defineTool("today_publish", { description: "Publishes a panel.\nMore.", parameters: { type: "object", properties: {} }, handler: () => "ok" })];
  const inventory = buildInventory({
    name: "ChatGPT",
    tools,
    servers: [{ name: "crm", status: "connected", tools: [{ name: "find_account", description: "Looks an account up" }] }],
    native: [{ name: "review", description: "Reviews the changes", hint: "[path]" }, { name: "pdf", description: "Reads PDFs", kind: "Skill" }],
    compact: true,
  });
  assert.equal(inventory.choices[0].name, "today_publish", "Today's tools come first");
  assert.deepEqual(inventory.servers, [{ name: "crm", status: "connected" }]);
  const commands = inventory.choices.filter((c) => c.kind === "Command").map((c) => c.command);
  for (const name of ["model", "permissions", "compact", "new", "btw", "review"]) assert.ok(commands.includes(name), name + " is listed");
  assert.deepEqual(inventory.choices.find((c) => c.command === "review").source, "ChatGPT");
  assert.equal(inventory.choices.find((c) => c.command === "pdf").kind, "Skill");
  assert.deepEqual(inventory.choices.find((c) => c.command === "tool:find_account").source, "crm");
  assert.ok(!buildInventory({ name: "X" }).choices.some((c) => c.command === "compact"), "compact is only offered where the backend can do it");

  const applied = [];
  const host = {
    state: { settings: { approval: "ask" } },
    models: async () => [
      { id: "gpt-6", name: "GPT-6", provider: "codex", efforts: ["low", "high"], available: true },
      { id: "sonnet", name: "Claude Sonnet", provider: "claude", efforts: ["low"], available: true },
    ],
    applyModelCommand: async (_session, chat, selection) => (applied.push(selection), (chat.model = selection)),
    clearCatalogs: () => applied.push("cleared"),
    clearApprovals: (id) => applied.push("approvals:" + id),
  };
  let compacted = 0;
  const session = { provider: { id: "codex", version: async () => "Codex CLI 1.2.3" }, inventory: async () => inventory, compact: async () => void compacted++ };
  const chat = { id: "c1", messages: [{ role: "user", text: "Find the teal invoice" }, { role: "assistant", text: "Here it is." }, { role: "user", text: "/search teal" }] };
  const run = {};
  const resolve = (prompt) => resolvePrompt(session, prompt, run, chat, host);

  assert.deepEqual(await resolve("Just a message"), { kind: "agent-prompt", prompt: "Just a message" });
  assert.deepEqual(await resolve("/usr/bin is a path, not a command"), { kind: "agent-prompt", prompt: "/usr/bin is a path, not a command" });
  assert.match((await resolve("/tool:find_account Acme")).prompt, /chose the tool `find_account`[\s\S]*Acme$/);
  await assert.rejects(resolve("/tool:gone"), /unavailable/);
  await assert.rejects(resolve("/nonsense"), /Unknown command \/nonsense/);
  // The backend's own commands go to it as typed.
  assert.deepEqual(await resolve("/review src"), { kind: "agent-prompt", prompt: "/review src" });
  assert.equal(run.command, "review");
  await resolve("/pdf report.pdf");
  assert.equal(run.skill, "pdf");

  assert.deepEqual(await resolve("/model"), { kind: "show-dialog", dialog: { kind: "model-picker" } });
  assert.equal((await resolve("/model gpt-6 high")).text, "Chat model set to GPT-6 · high.");
  assert.deepEqual(applied.at(-1), { model: "gpt-6", provider: "codex", reasoningEffort: "high" });
  assert.equal((await resolve("/model claude-sonnet")).text, "Chat model set to Claude Sonnet.", "a model's name works as well as its id");
  await assert.rejects(resolve("/model nope"), /Unknown model/);
  await assert.rejects(resolve("/model a b c"), /Use \/model/);
  assert.match((await resolve("/model default")).text, /follows its bot/);
  assert.equal(chat.model, undefined);

  assert.equal((await resolve("/permissions")).kind, "select-subcommand");
  await resolve("/permissions read");
  assert.equal(chat.approval, "read");
  await resolve("/allow-all");
  assert.equal(chat.approval, "all");
  await resolve("/permissions default");
  assert.equal(chat.approval, undefined);
  await assert.rejects(resolve("/permissions sometimes"), /Use \/permissions/);
  await resolve("/reset-allowed-tools");
  assert.ok(applied.includes("approvals:c1"));
  assert.equal(chat.approval, "ask");

  await resolve("/compact");
  assert.equal(compacted, 1);
  assert.equal((await resolve("/version")).text, "Codex CLI 1.2.3");
  assert.match((await resolve("/search teal")).text, /user · Find the teal invoice/);
  assert.match((await resolve("/help")).text, /\/model — Choose the model/);
  // An alias reaches the same command.
  assert.match((await resolve("/settings")).text, /handled by Botkins' window/);
});

test("a bot's skills reach every command-line provider through its instructions and one tool", async (t) => {
  const dir = tempDir(t);
  const skill = (folder, name, description, body, extra = {}) => {
    mkdirSync(join(dir, folder, name), { recursive: true });
    writeFileSync(join(dir, folder, name, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n\n" + body + "\n");
    for (const [file, text] of Object.entries(extra)) {
      mkdirSync(join(dir, folder, name, file, ".."), { recursive: true });
      writeFileSync(join(dir, folder, name, file), text);
    }
  };
  skill("own", "weekly-report", "Write the weekly report.", "1. Gather the numbers.\n2. Write it up.", { "scripts/collect.sh": "echo hi", "template.md": "# Week" });
  skill("own", "invoice", "Prepare an invoice.", "Use the invoice template.");
  skill("linked", "weekly-report", "A second skill of the same name.", "This one is not used.");
  skill("linked", "retro", "Run a retrospective.", "Ask what went well.");
  const spec = { skills: { directories: [join(dir, "own"), join(dir, "linked"), join(dir, "missing")], disabled: ["invoice"] } };
  assert.deepEqual(enabledSkills(spec).map((s) => [s.name, s.description]), [["retro", "Run a retrospective."], ["weekly-report", "Write the weekly report."]], "switched-off skills are left out, and the first folder wins a name");

  const support = skillSupport(spec);
  assert.match(support.instructions, /call the skill_read tool/);
  assert.match(support.instructions, /- retro: Run a retrospective\.\n- weekly-report: Write the weekly report\./);
  assert.doesNotMatch(support.instructions, /invoice/);
  assert.deepEqual(support.tools.map((x) => [x.name, x.skipPermission]), [["skill_read", true]]);
  const read = JSON.parse(support.tools[0].handler({ name: "/Weekly-Report" }));
  assert.deepEqual([read.name, read.instructions, read.folder], ["weekly-report", "1. Gather the numbers.\n2. Write it up.", join(dir, "own", "weekly-report")]);
  assert.deepEqual(read.files.sort(), [join("scripts", "collect.sh"), "template.md"], "the files that come with the skill are named; its SKILL.md is not repeated");
  assert.throws(() => support.tools[0].handler({ name: "invoice" }), /no skill named "invoice"\. Your skills: retro, weekly-report\./, "a switched-off skill can't be read by name");
  assert.deepEqual(skillChoices(support.list), [
    { name: "retro", description: "Run a retrospective.", kind: "Skill", source: "Botkins" },
    { name: "weekly-report", description: "Write the weekly report.", kind: "Skill", source: "Botkins" },
  ]);
  // A bot with no skills gets no extra instructions and no tool.
  assert.deepEqual(skillSupport({ skills: { directories: [join(dir, "missing")], disabled: [] } }), { list: [], instructions: "", tools: [] });
  assert.deepEqual(skillSupport({}), { list: [], instructions: "", tools: [] });
});

class Fixed extends ModelProvider {
  constructor(id, { models = [], status = {}, fails, defaultEnabled = true, delay = 0 } = {}) {
    super();
    Object.assign(this, { id, name: id.toUpperCase(), description: "The " + id + " one.", list: models, state: status, fails, defaultEnabled, delay, asked: { status: 0, models: 0 } });
  }
  async status() {
    this.asked.status++;
    if (this.delay) await tick(this.delay);
    if (this.fails === "status") throw new Error(this.id + " is down");
    return { installed: true, connected: true, signIn: "browser", signOut: true, ...this.state };
  }
  async models() {
    this.asked.models++;
    if (this.delay) await tick(this.delay);
    if (this.fails === "models") throw new Error(this.id + " has no list");
    return this.list;
  }
}
const quiet = async (t) => {
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => (console.error = original));
  return errors;
};

test("the registry reports every provider and merges the models of the connected ones", async (t) => {
  const errors = await quiet(t);
  const a = new Fixed("a", { models: [{ id: "m1", name: "M1", efforts: [], available: true }], status: { account: "ada@example.com", plan: "Plus" } });
  const b = new Fixed("b", { models: [{ id: "m2", name: "M2", efforts: ["low"], available: true }], status: { connected: false, message: "Sign in." } });
  const c = new Fixed("c", { models: [{ id: "m3", name: "M3", efforts: [], available: true }], defaultEnabled: false });
  const d = new Fixed("d", { fails: "status" });
  const providers = new Providers([a, b, c, d]);
  assert.equal(providers.default, a);
  assert.equal(providers.for({ model: "x", provider: "b" }), b);
  assert.equal(providers.for({ model: "x" }), a, "a selection without a provider uses the default");
  assert.equal(providers.for({ model: "x", provider: "gone" }), a, "an unknown provider falls back to the default");
  assert.equal(providers.require("b"), b);
  assert.throws(() => providers.require("gone"), /Unknown model provider/);
  assert.throws(() => new Providers([]), /at least one/);
  assert.throws(() => new Providers([{ id: "x" }]), /Invalid model provider/);

  const statuses = await providers.statuses();
  assert.deepEqual(statuses.map((s) => [s.id, s.enabled, s.connected]), [["a", true, true], ["b", true, false], ["c", false, false], ["d", true, false]]);
  assert.deepEqual([statuses[0].name, statuses[0].description, statuses[0].default, statuses[0].account, statuses[0].plan], ["A", "The a one.", true, "ada@example.com", "Plus"]);
  assert.equal(statuses[1].message, "Sign in.");
  assert.equal(statuses[3].error, "d is down", "a provider that fails is reported, not thrown");
  assert.equal(c.asked.status, 0, "a provider that is switched off is asked nothing");

  // Only connected providers contribute models; each model names its provider.
  const catalog = await providers.models();
  assert.deepEqual(catalog.map((m) => [m.id, m.provider, m.providerName]), [["m1", "a", "A"]]);
  assert.equal(b.asked.models, 0, "a provider that isn't signed in is not asked for models");

  // Answers are remembered for a while: the pickers ask often.
  await providers.models();
  await providers.statuses();
  assert.deepEqual([a.asked.status, a.asked.models], [1, 1]);
  // After a sign-in the provider is asked again.
  b.state = { connected: true };
  providers.invalidate("b");
  assert.deepEqual((await providers.models()).map((m) => m.id), ["m1", "m2"]);
  assert.equal(a.asked.models, 1, "only the provider that changed is asked again");
  await providers.statuses({ refresh: true });
  assert.equal(a.asked.status, 2);

  // The person switches a provider on or off.
  const on = new Set(["a", "c"]);
  providers.configure({ enabled: (provider) => on.has(provider.id) });
  providers.invalidate();
  assert.deepEqual((await providers.models()).map((m) => m.id), ["m1", "m3"]);
  assert.deepEqual(providers.enabled().map((p) => p.id), ["a", "c"]);
  assert.equal(errors.length, 0);
});

test("one provider failing or being slow doesn't take the others' models away", async (t) => {
  const errors = await quiet(t);
  const good = new Fixed("good", { models: [{ id: "m1", name: "M1", efforts: [], available: true }] });
  const bad = new Fixed("bad", { fails: "models" });
  assert.deepEqual((await new Providers([bad, good]).models()).map((m) => m.id), ["m1"], "the default provider failing no longer hides the rest");
  assert.equal(errors.length, 1);
  await assert.rejects(new Providers([bad]).models(), /bad has no list/, "with nothing to show, the reason is given");
  const unsure = new Fixed("unsure", { fails: "status", models: [{ id: "m9", name: "M9", efforts: [], available: true }] });
  assert.deepEqual((await new Providers([unsure]).models()).map((m) => m.id), ["m9"], "a status that can't be read doesn't hide models that can");
  assert.deepEqual(await new Providers([new Fixed("out", { status: { connected: false } })]).models(), [], "nobody signed in is an empty catalog, not an error");

  // A slow provider: reported as starting, left out of the catalog, and announced when it answers.
  const slow = new Fixed("slow", { models: [{ id: "late", name: "Late", efforts: [], available: true }], delay: 60 });
  const providers = new Providers([good, slow], { statusWait: 15, modelsWait: 15 });
  let announced = 0;
  providers.configure({ changed: () => announced++ });
  const first = await providers.statuses();
  assert.deepEqual(first.map((s) => [s.id, !!s.starting]), [["good", false], ["slow", true]]);
  assert.deepEqual((await providers.models()).map((m) => m.id), ["m1"]);
  await tick(150);
  assert.ok(announced >= 1, "the app is told to look again");
  assert.deepEqual((await providers.statuses()).map((s) => [s.id, !!s.starting, s.connected]), [["good", false, true], ["slow", false, true]]);
  await providers.models();
  await tick(150);
  assert.deepEqual((await providers.models()).map((m) => m.id), ["m1", "late"]);
});
