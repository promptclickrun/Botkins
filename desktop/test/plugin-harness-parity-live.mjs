// A check with the real Pi (the bundled one, or PI_BINARY) and the real OMP (OMP_BINARY or `omp`
// on PATH): one fixture plugin, read by Botkins' own pluginSession(), gives each harness a local
// MCP tool and a preToolUse hook that changes a shell command (#309, #310).
//
// Run with:
//   node test/plugin-harness-parity-live.mjs
//
// The model is this script, on 127.0.0.1 (no account, no token, no network). For each harness it
// asks for `bash` with `printf original`, which the hook changes to `printf hooked`, then the
// plugin's `echo` MCP tool, then answers. What must hold, on each harness:
//   - the person is asked about the changed command, and the changed command is what ran;
//   - the hook ran once for each tool call;
//   - the plugin's tool is asked about under the plugin's own server name, and its result comes back;
//   - the plugin's approved setting reaches its server's environment and nothing else.
// It ends with 0 when every case holds; it is not a part of `npm test`.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { bundledPi, PiProvider, pluginAlias } from "../desktop/providers/pi/index.mjs";
import { pluginServerName, pluginSession } from "../desktop/plugin-runtime.mjs";
import { findBinary } from "../desktop/providers/cli.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-plugin-parity-live-"));
const plugin = join(root, "guard-plugin");
mkdirSync(plugin, { recursive: true });
copyFileSync(fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url)), join(plugin, "server.mjs"));
// The server says which setting it was started with, so the check sees the scoped value arrive.
writeFileSync(join(plugin, "server.mjs"), readFileSync(join(plugin, "server.mjs"), "utf8").replace('"echo:" + String(', '"echo:" + (process.env.TOKEN === "synthetic-token-value" ? "scoped:" : "unscoped:") + String('));
writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "guard", hooks: "hooks.json", mcpServers: ".mcp.json" }));
writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { tools: { type: "local", command: "node", args: ["server.mjs"], env: { TOKEN: "${TOKEN}" } } } }));
writeFileSync(
  join(plugin, "hook.mjs"),
  'import { appendFileSync } from "node:fs";\nlet d = ""; process.stdin.on("data", (b) => (d += b)).on("end", () => { const x = JSON.parse(d); appendFileSync(process.env.PLUGIN_DATA + "/calls.log", x.toolName + "\\n"); console.log(JSON.stringify(x.toolArgs?.command === "printf original" ? { modifiedArgs: { command: "printf hooked" } } : {})); });\n',
);
writeFileSync(join(plugin, "hooks.json"), JSON.stringify({ hooks: { preToolUse: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hook.mjs"' }] } }));
const SERVER = pluginServerName("guard", "tools");
const ALIAS = pluginAlias(SERVER);

const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
const body = (request) => new Promise((resolve) => { let data = ""; request.on("data", (c) => (data += c)); request.on("end", () => resolve(JSON.parse(data))); });
const call = (id, name, args) => ({ id: "fc_" + id, type: "function_call", call_id: "call_" + id, name, status: "completed", arguments: JSON.stringify(args) });
const say = (id, text) => ({ id: "msg_" + id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

async function check(label, provider, mcpToolName) {
  const requests = [];
  const outputs = [[call(1, "bash", { command: "printf original" })], [call(2, mcpToolName, { value: "plugin" })], [say(3, "Done.")]];
  let turns = 0;
  const model = createServer(async (request, response) => {
    requests.push(await body(request));
    const output = outputs[turns++] ?? [say(9, "Done.")];
    const item = output[0];
    const id = "resp_" + turns;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(
      sse("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }) +
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, status: undefined, arguments: "" } }) +
        (item.type === "message"
          ? sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text })
          : sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments })) +
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
        sse("response.completed", { type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }),
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const session = pluginSession([{ id: "guard", folder: plugin, values: { TOKEN: "synthetic-token-value" }, config: [{ key: "TOKEN", secret: true, set: true }], status: "ready", enabled: true, bots: "all" }], { dir, chatId: "chat", botId: "bot" });
  const approvals = [];
  try {
    const connection = { name: "botkins-test", config: { name: "Local test", baseUrl: "http://127.0.0.1:" + model.address().port + "/v1", api: "openai-responses", apiKey: "test", authHeader: true, models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] } };
    const live = await provider.openSession({
      sessionId: label + "-live", established: false, hasReplies: false, folder: dir,
      model: { model: "test", source: "botkins-test" }, inference: { providers: [connection] },
      instructions: "You are Testy.", context: "", tools: [], skills: { directories: [], disabled: [] },
      mcpServers: session.mcpServers, plugins: session.directories, pluginHooks: session.hooks,
      history: () => [], handlers: { permission: async (request) => (approvals.push(request), { allow: true }) },
    });
    const reply = await live.send({ prompt: "Run the tools." });
    await live.close();
    const sent = JSON.stringify(requests);
    assert.equal(reply.text, "Done.", label + ": " + sent.slice(-600));
    assert.deepEqual([approvals[0]?.kind, approvals[0]?.preview], ["shell", "printf hooked"], label + ": the person is asked about the changed command");
    assert.ok(sent.includes("hooked") && !/"output":"original/.test(sent), label + ": the changed command ran");
    assert.deepEqual([approvals[1]?.kind, approvals[1]?.label], ["mcp", SERVER + " / echo"], label + ": the plugin's tool under its own name");
    assert.ok(sent.includes("echo:scoped:plugin"), label + ": the plugin's tool ran with its own setting: " + sent.slice(-400));
    assert.ok(!sent.includes("synthetic-token-value"), label + ": the setting never reached the model");
    const data = join(dir, ".botkins-plugin-data");
    const calls = readdirSync(data).flatMap((f) => (existsSync(join(data, f, "calls.log")) ? readFileSync(join(data, f, "calls.log"), "utf8").trim().split("\n") : []));
    assert.deepEqual(calls, ["bash", SERVER + "/echo"], label + ": the hook ran once for each call");
    console.log(label + ": hook changed args, single run, plugin MCP tool, scoped setting: passed.");
  } finally {
    await provider.stop();
    await new Promise((resolve) => model.close(resolve));
  }
}

let failed = false;
try {
  const pi = process.env.PI_BINARY ?? bundledPi();
  await check("pi", new PiProvider({ dataDir: join(root, "pi-data"), ...(pi && { binary: pi }) }), "mcp__" + ALIAS + "__echo");
  const omp = process.env.OMP_BINARY ?? (await findBinary("omp"));
  if (omp) await check("omp", new OmpProvider({ dataDir: join(root, "omp-data"), binary: omp }), "mcp__" + ALIAS + "_echo");
  else console.log("omp: not installed, skipped.");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);
