// OMP as a harness (desktop/providers/omp): the adapter against a stand-in `omp` that speaks
// OMP's RPC-UI protocol. Nothing here starts the real OMP or reaches a model.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { PiPackages } from "../desktop/providers/pi/packages.mjs";
import { Providers } from "../desktop/providers/index.mjs";
import { ModelProvider } from "../desktop/providers/provider.mjs";

const skip = process.platform === "win32" && "The stand-in is a shell script.";
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "botkins-omp-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const binary = join(root, "omp");
writeFileSync(binary, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(FIXTURE) + ' "$@"\n');
chmodSync(binary, 0o755);

let n = 0;
function setup() {
  const dir = join(root, "case-" + ++n);
  const logFile = join(dir, "log.jsonl");
  const provider = new OmpProvider({ dataDir: dir, binary, env: { ...process.env, OMP_PROFILE: "personal", PI_CONFIG_FILES: "/personal.yml", FAKE_OMP_LOG: logFile } });
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
  mcpServers: {
    files: { type: "http", url: "https://mcp.example/x", headers: { A: "b" } },
    old: { type: "sse", url: "https://sse.example" },
    local: { type: "stdio", command: "node", args: ["server.mjs"], env: { A: "b" }, cwd: "/work" },
  },
  history: () => [],
  handlers: { permission: async () => ({ allow: true }) },
  ...more,
});

test("status finds OMP and offers its own installer when absent", { skip }, async () => {
  const { provider } = setup();
  assert.deepEqual(await provider.status(), { installed: true, version: "19.1.0", connected: true, signIn: null, signOut: false });
  const missing = new OmpProvider({ dataDir: join(root, "missing"), binary: join(root, "nope") });
  const status = await missing.status();
  assert.equal(status.installed, false);
  assert.deepEqual(status.install, { url: "https://omp.sh", command: "curl -fsSL https://omp.sh/install | sh" });
});

test("a turn runs OMP in RPC-UI with isolated config and OMP's session directory", { skip }, async () => {
  const { provider, dir, seen } = setup();
  const session = await provider.openSession(spec());
  const events = [];
  session.on((event) => events.push(event));
  const { text } = await session.send({ prompt: "hello" });
  assert.equal(text, "echo: hello");
  assert.deepEqual(events.filter((e) => e.type === "assistant.message_delta").map((e) => e.data.deltaContent), ["echo", ": hello"]);
  assert.deepEqual(events.find((e) => e.type === "assistant.usage").data, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 0, model: "opus" });
  assert.deepEqual(events.find((e) => e.type === "session.usage_info").data, { currentTokens: 126, tokenLimit: 1000 });

  const { started } = seen().find((entry) => entry.started);
  assert.equal(started.args[started.args.indexOf("--mode") + 1], "rpc-ui");
  for (const flag of ["--mode", "--auto-approve", "--offline", "--no-extensions", "--no-skills", "--no-rules", "--config", "--cwd"]) assert.ok(started.args.includes(flag), flag);
  for (const flag of ["--session-id", "--no-approve", "--no-prompt-templates", "--no-themes", "builtin:mcp"]) assert.ok(!started.args.includes(flag), flag);
  assert.deepEqual(started.args.slice(started.args.indexOf("--model"), started.args.indexOf("--model") + 2), ["--model", "botkins-claude/opus"]);
  assert.deepEqual(started.args.slice(started.args.indexOf("--thinking"), started.args.indexOf("--thinking") + 2), ["--thinking", "high"]);
  assert.equal(started.args[started.args.indexOf("--cwd") + 1], root);
  assert.notEqual(started.cwd, root, "OMP itself starts outside the project so the project's dotenv cannot pre-load");
  assert.ok(started.agentDir.startsWith(join(dir, "agents")));
  assert.notEqual(started.agentDir, join(dir, "agent"), "each conversation owns its OMP config and MCP credentials");
  assert.equal(started.profile, undefined);
  assert.equal(started.configFiles, undefined);
  assert.ok(!started.configDir.startsWith(".omp"), started.configDir);
  assert.deepEqual(started.described.providers, [CONNECTION]);
  assert.equal(started.described.prompt, "You are Testy.");
  assert.deepEqual(started.config, {
    mcpServers: {
      files: { type: "http", url: "https://mcp.example/x", headers: { A: "b" } },
      old: { type: "sse", url: "https://sse.example" },
      local: { type: "stdio", command: "node", args: ["server.mjs"], env: { A: "b" }, cwd: "/work" },
    },
  });
  assert.match(started.overlay, /enableProjectConfig:\s*false/);
  assert.match(started.overlay, /shared:\s*false/);
  assert.match(started.overlay, /startupTimeoutMs:\s*\d+/);
  assert.match(started.overlay, /tools:\n\s+commands:\s*false/);

  const live = provider.live.get("chat-1");
  assert.equal(statSync(live.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(started.agentDir, "mcp.json")).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
  assert.equal(stored["chat-1"].ref, "omp-session-1");
  await session.close();
  await provider.stop();
  assert.ok(seen().some((entry) => entry.command?.type === "negotiate_protocol" && entry.command.protocolVersion === 2));
});

test("OMP's generated session id is resumed by the next process", { skip }, async () => {
  const { provider, seen } = setup();
  const first = await provider.openSession(spec());
  await first.send({ prompt: "one" });
  await first.close();
  await provider.stop();

  const second = await provider.openSession(spec({ established: true, hasReplies: true }));
  await second.send({ prompt: "two" });
  const starts = seen().filter((entry) => entry.started).map((entry) => entry.started);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].args.includes("--resume"), false);
  assert.deepEqual(starts[1].args.slice(starts[1].args.indexOf("--resume"), starts[1].args.indexOf("--resume") + 2), ["--resume", "omp-session-1"]);
  await second.close();
  await provider.stop();
});

test("Botkins approvals keep OMP's own tools, MCP metadata and shell names", { skip }, async () => {
  const { provider, seen } = setup();
  const asked = [];
  const session = await provider.openSession(spec({ handlers: { permission: async (request) => (asked.push(request), { allow: true }) } }));
  const events = [];
  session.on((event) => events.push(event));
  await session.send({ prompt: "run mcp:files:get" });
  assert.deepEqual([asked[0].kind, asked[0].label, asked[0].toolName, asked[0].remember], ["mcp", "files / get", "get", ["MCP tool files/get", "files", "get"]]);
  const start = events.find((event) => event.type === "tool.execution_start").data;
  assert.deepEqual([start.toolName, start.mcpServerName, start.mcpToolName], ["get", "files", "get"]);

  await session.send({ prompt: "run own:wiki_read" });
  assert.equal(asked.length, 1, "Botkins' bridge asks no approval");
  const own = events.findLast((event) => event.type === "tool.execution_start").data;
  assert.equal(own.toolName, "wiki_read");
  assert.equal(own.mcpServerName, undefined);
  assert.equal(seen().filter((entry) => entry.answer).at(-1).answer.value, "allow");

  await session.send({ prompt: "run bash:ls" });
  assert.deepEqual([asked[1].kind, asked[1].toolName, asked[1].preview], ["shell", "bash", "ls"]);
  await session.close();
  await provider.stop();
});

test("OMP settlement and errors finish a turn through the same provider interface", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  await assert.rejects(session.send({ prompt: "fail" }), /The plan said no\./);
  const failed = await session.send({ prompt: "extra" }).catch((error) => error);
  assert.match(failed.message, /^API Error: 400 You're out of extra usage\. /);
  await session.close();
  await provider.stop();
});

test("a buffered OMP assistant message still supplies the final reply without text deltas", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  const events = [];
  session.on((event) => events.push(event));
  const original = session.event.bind(session);
  session.event = (event) => original(event.type === "message_update" ? { ...event, assistantMessageEvent: {} } : event);
  assert.equal((await session.send({ prompt: "hello" })).text, "echo: hello");
  assert.deepEqual(events.filter((event) => event.type === "assistant.message_delta").map((event) => event.data.deltaContent), ["echo: hello"]);
  await session.close();
  await provider.stop();
});

test("OMP protocol-v2 chunks reassemble into one streaming event", { skip }, async () => {
  const { provider } = setup();
  const session = await provider.openSession(spec());
  const events = [];
  session.on((event) => events.push(event));
  assert.equal((await session.send({ prompt: "chunked" })).text, "echo: chunked");
  assert.deepEqual(events.filter((event) => event.type === "assistant.message_delta").map((event) => event.data.deltaContent), ["echo: chunked"]);
  await session.close();
  await provider.stop();
});

test("the registry keeps OMP beside Pi and outside the model-provider list", { skip }, async () => {
  class Fake extends ModelProvider {
    id = "copilot";
    name = "Copilot";
  }
  class Pi extends ModelProvider {
    id = "pi";
    name = "Pi";
    harness = true;
    status = async () => ({ installed: false, connected: false });
  }
  const { provider } = setup();
  const providers = new Providers([new Fake(), new Pi(), provider]);
  assert.deepEqual(providers.list.map((p) => p.id), ["copilot"]);
  assert.equal(providers.get("omp"), provider);
  const statuses = await providers.harnessStatuses();
  assert.deepEqual(statuses.map((item) => item.id), ["pi", "omp"]);
  assert.equal(statuses[1].version, "19.1.0");
});

test("OMP loads the Marketplace Pi packages that are on, and stops when one is turned off", { skip }, async (t) => {
  const name = "@garden/pi-rose";
  const market = new PiPackages({
    dataDir: join(root, "pi-market"),
    fetch: async () => new Response("<dt>Package</dt><dd><code>" + name + "</code></dd><dt>Version</dt><dd><code>1.2.3</code></dd>"),
    install: async (source, agentDir) => {
      const pkg = join(agentDir, "npm", "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
    },
  });
  await market.install(name, "1.2.3");
  const { dir, seen } = setup();
  const provider = new OmpProvider({ dataDir: dir, binary, packages: market, env: { ...process.env, FAKE_OMP_LOG: join(dir, "log.jsonl") } });
  t.after(() => provider.stop());
  const loaded = (args) => args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));
  const session = await provider.openSession(spec());
  await session.send({ prompt: "one" });
  const [path] = market.activePaths();
  assert.deepEqual(loaded(seen().find((entry) => entry.started).started.args), [provider.program.extension, path]);

  market.setEnabled(name, "1.2.3", false);
  await session.send({ prompt: "two" });
  const starts = seen().filter((entry) => entry.started).map((entry) => entry.started);
  assert.equal(starts.length, 2, "a changed package restarts OMP on the next turn");
  assert.deepEqual(loaded(starts[1].args), [provider.program.extension]);
  await session.close();
  await provider.stop();
});

test("OMP stays warm when Botkins bridge schemas match and restarts when they change", { skip }, async (t) => {
  const { provider, seen } = setup();
  t.after(() => provider.stop());
  const tool = (name, description = "Test tool") => ({
    name,
    description,
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    handler: async () => "ok",
  });

  const first = await provider.openSession(spec({ tools: [tool("wiki_search")] }));
  await first.send({ prompt: "one" });
  await first.close();

  const warm = await provider.openSession(spec({ established: true, hasReplies: true, tools: [tool("wiki_search")] }));
  await warm.send({ prompt: "two" });
  await warm.close();
  assert.equal(seen().filter((entry) => entry.started).length, 1, "identical bridge schemas keep the warm OMP process");

  const changed = await provider.openSession(spec({ established: true, hasReplies: true, tools: [tool("wiki_search"), tool("ask_teammate")] }));
  await changed.send({ prompt: "three" });
  await changed.close();
  assert.equal(seen().filter((entry) => entry.started).length, 2, "new bridge schemas restart OMP so it discovers them");
});

test("OMP inventory distinguishes direct, indirect, unavailable, unobservable and preserves package commands", { skip }, async (t) => {
  const { provider } = setup();
  t.after(() => provider.stop());
  t.mock.method(provider.packages, "activePaths", () => ["/fixture/pkg"]);
  const session = await provider.openSession(spec({
    mcpServers: {
      ok_srv: { type: "http", url: "http://127.0.0.1:9/ok" },
      cmd_srv: { type: "http", url: "http://127.0.0.1:9/cmd" },
      silent_srv: { type: "http", url: "http://127.0.0.1:9/silent" },
      bad_cfg: { type: "http" },
    },
  }));
  const live = await session.start();
  // Simulate direct tool in dumpTools, indirect tool via toolCommands notice (with underscore server name), and package commands.
  const origRequest = live.rpc.request.bind(live.rpc);
  live.rpc.request = async (cmd, timeout) => {
    if (cmd.type === "get_state") {
      return {
        sessionId: "omp-session-1",
        isSettled: true,
        dumpTools: [{ name: "mcp__ok_srv_ping", description: "Direct ping" }],
      };
    }
    if (cmd.type === "get_available_commands") {
      return {
        commands: [
          { name: "model", description: "OMP builtin", source: "builtin" },
          { name: "autoresearch", description: "OMP builtin ext", source: "extension" },
          { name: "pkg-cmd", description: "Package command", source: "extension" },
        ],
      };
    }
    return origRequest(cmd, timeout);
  };
  provider.observeRuntime(live, {
    type: "notice",
    source: "toolCommands",
    message: "Tool commands: added mcp__cmd_srv_lookup",
  });

  // During an active turn, unprobed 0-tool silent_srv is unobservable (distinct from unavailable bad_cfg), and live is not restarted.
  session.turn = { calls: new Map(), rows: new Map() };
  const inv = await session.inventory();
  assert.equal(session.live, live);
  assert.deepEqual(inv.servers, [
    { name: "ok_srv", status: "connected" },
    { name: "cmd_srv", status: "connected" },
    { name: "silent_srv", status: "unobservable" },
    { name: "bad_cfg", status: "unavailable" },
  ]);
  const direct = inv.choices.find((c) => c.kind === "Tool" && c.source === "ok_srv" && c.name === "ping");
  const indirect = inv.choices.find((c) => c.kind === "Tool" && c.source === "cmd_srv" && c.name === "lookup");
  assert.equal(direct?.exposure, "direct");
  assert.equal(indirect?.exposure, "indirect");
  assert.ok(inv.choices.some((c) => c.command === "pkg-cmd" && c.native === true), "package command preserved on OMP");
  assert.ok(!inv.choices.some((c) => c.command === "autoresearch"), "OMP internal autoresearch stays native-only");
  assert.ok(inv.choices.some((c) => c.command === "help" && c.source === "Botkins"), "Botkins slash commands preserved");
  session.turn = null;
  await session.close();
});

test("OMP inventory maps aliased plugin servers across tools and /mcp test probes", { skip }, async (t) => {
  const { provider } = setup();
  t.after(() => provider.stop());
  const pluginOk = "plugin_alpha__server_a1b2c3d4";
  const pluginCmd = "plugin_gamma__server_11223344";
  const pluginFail = "plugin_beta__server_e5f6a7b8";
  const aliasOk = "bkp_aaaaaaaaaaaa";
  const aliasCmd = "bkp_cccccccccccc";
  const aliasFail = "bkp_bbbbbbbbbbbb";
  const session = await provider.openSession(spec({
    mcpServers: {
      [pluginOk]: { type: "http", url: "http://127.0.0.1:9/alpha" },
      [pluginCmd]: { type: "http", url: "http://127.0.0.1:9/gamma" },
      [pluginFail]: { type: "http", url: "http://127.0.0.1:9/beta" },
    },
  }));
  const live = await session.start();
  session.aliases = new Map([
    [aliasOk, pluginOk],
    [aliasCmd, pluginCmd],
    [aliasFail, pluginFail],
  ]);
  const probed = [];
  const origRequest = live.rpc.request.bind(live.rpc);
  live.rpc.request = async (cmd, timeout) => {
    if (cmd.type === "get_state") {
      return {
        sessionId: "omp-session-alias",
        isSettled: true,
        dumpTools: [
          { name: `mcp__${aliasOk}_ping`, description: "Aliased direct ping" },
          { name: "mcp__bkp_zzzzzzzzzzzz_revoked", description: "Revoked plugin tool" },
        ],
      };
    }
    if (cmd.type === "get_available_commands") {
      return { commands: [{ name: "mcp", description: "Manage MCP", source: "builtin" }] };
    }
    if (cmd.type === "prompt" && cmd.message?.startsWith("/mcp test ")) {
      probed.push(cmd.message);
      provider.observeRuntime(live, {
        type: "command_output",
        text: `Connection to "${aliasFail}" failed: connection refused`,
      });
      return { ok: true };
    }
    return origRequest(cmd, timeout);
  };
  provider.observeRuntime(live, {
    type: "notice",
    source: "toolCommands",
    message: `Tool commands: added mcp__${aliasCmd}_lookup`,
  });

  const inv = await session.inventory();
  assert.deepEqual(probed, [`/mcp test ${aliasFail}`], "OMP probes unresolved aliased server by its harness alias");
  assert.deepEqual(inv.servers, [
    { name: pluginOk, status: "connected" },
    { name: pluginCmd, status: "connected" },
    { name: pluginFail, status: "failed" },
  ]);
  assert.equal(inv.choices.find((c) => c.source === pluginOk && c.name === "ping")?.exposure, "direct");
  assert.equal(inv.choices.find((c) => c.source === pluginCmd && c.name === "lookup")?.exposure, "indirect");
  assert.ok(!inv.choices.some((c) => c.source?.startsWith("bkp_") || c.name === "revoked"), "internal aliases and revoked tools stay hidden");
  await session.close();
});

