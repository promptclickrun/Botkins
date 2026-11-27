// A marketplace plugin's hooks and MCP servers on Pi and OMP (#309, #310): a fixture plugin read by
// Botkins' own pluginSession(), run against the stand-in OMP (test/fixtures/fake-omp.mjs), which
// speaks the extension's approval exchange. Nothing here starts the real OMP or reaches a model.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { pluginAlias } from "../desktop/providers/pi/index.mjs";
import { pluginServerName, pluginSession } from "../desktop/plugin-runtime.mjs";

const skip = process.platform === "win32" && "The stand-in is a shell script.";
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "botkins-plugin-parity-"));
after(() => rmSync(root, { recursive: true, force: true }));
const binary = join(root, "omp");
writeFileSync(binary, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(FIXTURE) + ' "$@"\n');
chmodSync(binary, 0o755);

// The plugin: one preToolUse hook whose answer depends on the command, one local MCP tool, one prompt hook.
const plugin = join(root, "guard-plugin");
mkdirSync(plugin, { recursive: true });
writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "guard", hooks: "hooks.json", mcpServers: ".mcp.json" }));
writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { tools: { type: "local", command: "node", args: ["server.mjs"], env: { TOKEN: "${TOKEN}" } } } }));
writeFileSync(
  join(plugin, "hook.mjs"),
  [
    'import { appendFileSync } from "node:fs";',
    'let d = ""; process.stdin.on("data", (b) => (d += b)).on("end", () => {',
    "  const x = JSON.parse(d);",
    '  appendFileSync(process.env.PLUGIN_DATA + "/calls.log", (x.toolName ?? "prompt") + "\\n");',
    "  const cmd = x.toolArgs?.command ?? \"\";",
    '  if (x.prompt !== undefined) return console.log(JSON.stringify(x.prompt.includes("blockme") ? { decision: "block", reason: "no" } : { modifiedPrompt: x.prompt + " (checked)" }));',
    '  if (cmd === "rm") return console.log(JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: "Not rm." }));',
    '  if (cmd === "ask") return console.log(JSON.stringify({ permissionDecision: "ask", permissionDecisionReason: "Sure?" }));',
    '  if (cmd === "grant") return console.log(JSON.stringify({ permissionDecision: "allow" }));',
    '  if (cmd === "ls") return console.log(JSON.stringify({ modifiedArgs: { command: "ls -la" } }));',
    '  console.log("{}");',
    "});",
  ].join("\n"),
);
writeFileSync(
  join(plugin, "hooks.json"),
  JSON.stringify({ hooks: { preToolUse: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hook.mjs"' }], userPromptSubmitted: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hook.mjs"' }] } }),
);
const record = (more = {}) => ({ id: "guard", folder: plugin, values: { TOKEN: "synthetic-token-value" }, config: [{ key: "TOKEN", secret: true, set: true }], status: "ready", enabled: true, bots: "all", ...more });
const SERVER = pluginServerName("guard", "tools");
const CONNECTION = { name: "botkins-claude", config: { name: "Claude", baseUrl: "http://127.0.0.1:1/claude", api: "anthropic-messages", apiKey: "s", models: [{ id: "opus", name: "Opus", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };

let n = 0;
function setup() {
  const dir = join(root, "case-" + ++n);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "log.jsonl");
  const provider = new OmpProvider({ dataDir: dir, binary, env: { ...process.env, FAKE_OMP_LOG: logFile } });
  const seen = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { provider, dir, seen };
}
// What the workspace hands a full-plugin harness (Workspace.openSession).
function spec(dir, plugins, asked, more = {}) {
  const session = pluginSession(plugins, { dir, chatId: "chat-1", botId: "bot-1" });
  return {
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
    mcpServers: session.mcpServers,
    plugins: session.directories,
    pluginHooks: session.hooks,
    history: () => [],
    handlers: { permission: async (request) => (asked.push(request), { allow: true }) },
    ...more,
  };
}
// What the hook wrote in its own data folder (plugin-runtime.mjs: <dir>/.botkins-plugin-data/<plugin>-<digest>).
const hookCalls = (dir) => {
  const data = join(dir, ".botkins-plugin-data");
  return readdirSync(data).flatMap((folder) => {
    const file = join(data, folder, "calls.log");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
  });
};

test("a plugin's preToolUse hook changes, asks or denies once on OMP, with the outcome the person sees on Copilot", { skip }, async () => {
  const { provider, dir, seen } = setup();
  const asked = [];
  const session = await provider.openSession(spec(dir, [record()], asked));
  const ran = () => seen().filter((entry) => Object.hasOwn(entry, "ran")).map((entry) => entry.ran);

  // Changed arguments: the person is asked about the command that runs, and that command runs.
  await session.send({ prompt: "run bash:ls" });
  assert.deepEqual([asked[0].kind, asked[0].preview], ["shell", "ls -la"]);
  assert.deepEqual(ran().at(-1), { toolName: "bash", input: { command: "ls -la" } });

  // Deny: nothing runs and nobody is asked; the reason is the tool's result.
  await session.send({ prompt: "run bash:rm" });
  assert.equal(asked.length, 1);
  assert.equal(ran().at(-1), null);
  assert.equal(seen().filter((entry) => entry.detail).at(-1).detail.value, JSON.stringify({ deny: true, reason: "Not rm." }));

  // Ask: the card says a plugin asks, with the hook's words and the command.
  await session.send({ prompt: "run bash:ask" });
  assert.equal(asked[1].kind, "hook");
  assert.equal(asked[1].title, "A plugin asks before bash runs");
  assert.equal(asked[1].label, "The plugin's hook says: Sure?");
  assert.equal(asked[1].preview, "ask");

  // A hook can't grant: "allow" still goes to Botkins' approval.
  await session.send({ prompt: "run bash:grant" });
  assert.equal(asked[2].kind, "shell");

  // Each call ran the hook once (and each prompt ran the prompt hook once).
  const calls = hookCalls(dir);
  assert.equal(calls.filter((line) => line === "bash").length, 4, calls.join(","));
  assert.equal(calls.filter((line) => line === "prompt").length, 4, calls.join(","));
  await session.close();
  await provider.stop();
});

test("a plugin's prompt hook changes the message or blocks it before OMP sees it", { skip }, async () => {
  const { provider, dir, seen } = setup();
  const session = await provider.openSession(spec(dir, [record()], []));
  const { text } = await session.send({ prompt: "hello" });
  assert.equal(text, "echo: hello (checked)");
  const blocked = await session.send({ prompt: "blockme" });
  assert.equal(blocked.text, "");
  assert.ok(!seen().some((entry) => entry.command?.type === "prompt" && entry.command.message.includes("blockme")), "a blocked prompt is never sent");
  await session.close();
  await provider.stop();
});

test("a plugin's MCP tool is configured, scoped and named as the plugin's, and goes away with the plugin", { skip }, async () => {
  const { provider, dir, seen } = setup();
  const asked = [];
  const alias = pluginAlias(SERVER);
  const session = await provider.openSession(spec(dir, [record()], asked));
  await session.send({ prompt: "run mcp:" + alias + ":echo" });
  const { started } = seen().find((entry) => entry.started);
  const config = started.config.mcpServers[alias];
  assert.ok(config, "OMP gets the plugin's server under a name it keeps whole");
  assert.equal(config.type, "stdio");
  assert.equal(config.env.TOKEN, "synthetic-token-value", "the approved setting goes to its own server only");
  assert.ok(config.cwd, "the server starts in the plugin's folder");
  assert.equal(Object.keys(started.config.mcpServers).filter((name) => name !== alias).length, 0);
  assert.ok(!started.described.prompt.includes("synthetic-token-value"), "the setting never reaches the model's prompt");
  // Approval, "Always allow" and the activity name the plugin's server, not the harness's alias.
  assert.deepEqual([asked[0].kind, asked[0].label, asked[0].remember], ["mcp", SERVER + " / echo", ["MCP tool " + SERVER + "/echo", SERVER, "echo"]]);
  await session.close();

  // Switched off: the next turn has no server, and a call to it (from a warm process) does nothing.
  const off = await provider.openSession(spec(dir, [record({ enabled: false })], asked));
  await off.send({ prompt: "run mcp:" + alias + ":echo" });
  assert.equal(asked.length, 1, "nobody is asked about a revoked tool");
  assert.equal(seen().filter((entry) => Object.hasOwn(entry, "ran")).at(-1).ran, null);
  const restarted = seen().filter((entry) => entry.started).at(-1).started;
  assert.equal(restarted.config.mcpServers[alias], undefined, "OMP starts again without it");
  await off.close();
  await provider.stop();
});
