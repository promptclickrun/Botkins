// A check with the real Pi (the bundled one, or PI_BINARY) and the real OMP (OMP_BINARY or `omp`
// on PATH): one fixture plugin, read by Botkins' own pluginSession(), gives each harness a local
// MCP tool and a preToolUse hook that changes a shell command (#309, #310).
//
// Run with:
//   node test/plugin-harness-parity-live.mjs
//
// The model is this script, on 127.0.0.1 (no account, no token, no network). For each harness it
// asks for `bash` with `touch original.txt && echo original`, which the hook changes to the same
// with `hooked` (a write, so every harness asks: Copilot passes read-only commands by itself), then the
// plugin's `echo` MCP tool, then answers. What must hold, on each harness:
//   - the person is asked about the changed command, and the changed command is what ran;
//   - the hook ran once for each tool call;
//   - the plugin's tool is asked about under the plugin's own server name, and its result comes back;
//   - the plugin's approved setting reaches its server's environment and nothing else.
// Copilot runs the real SDK runtime with Botkins' own sessionOptions(); Pi and OMP run Botkins' own providers.
// It ends with 0 when every harness that ran passed; with --gate (or BOTKINS_RELEASE_GATE=1) all
// three must run and pass, and a missing one is named and fails. HARNESSES=pi,omp limits a local run.
// It is not a part of `npm test`.
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
  'import { appendFileSync } from "node:fs";\nlet d = ""; process.stdin.on("data", (b) => (d += b)).on("end", () => { const x = JSON.parse(d); appendFileSync(process.env.PLUGIN_DATA + "/calls.log", x.toolName + "\\n"); console.log(JSON.stringify(x.toolArgs?.command === "touch original.txt && echo original" ? { modifiedArgs: { ...x.toolArgs, command: "touch hooked.txt && echo hooked" } } : {})); });\n',
);
writeFileSync(join(plugin, "hooks.json"), JSON.stringify({ hooks: { preToolUse: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hook.mjs"' }] } }));
const SERVER = pluginServerName("guard", "tools");
const ALIAS = pluginAlias(SERVER);

const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
const body = (request) => new Promise((resolve) => { let data = ""; request.on("data", (c) => (data += c)); request.on("end", () => resolve(JSON.parse(data))); });
const call = (id, name, args) => ({ id: "fc_" + id, type: "function_call", call_id: "call_" + id, name, status: "completed", arguments: JSON.stringify(args) });
const say = (id, text) => ({ id: "msg_" + id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

const isShell = (name) => /^(bash|shell|powershell)$/i.test(name ?? "");
// Chat Completions (the Copilot runtime): the tool names come from the request's own tool list.
function chatReply(response, parsed, turn) {
  const tools = (parsed.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
  const chunk = (delta, finish) => ({ id: "chat", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const name = turn === 0 ? tools.find(isShell) : turn === 1 ? tools.find((tool) => /echo/.test(tool) && !isShell(tool)) : null;
  const args = turn === 0 ? { command: "touch original.txt && echo original", description: "probe" } : { value: "plugin" };
  const events = name
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + (turn + 1), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: "Done." }, null), chunk({}, "stop")];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
  response.end("data: [DONE]\n\n");
}
/** What the model was sent back for one tool call, in either protocol: the proof that this call ran, and with what. */
function resultOf(requests, callId) {
  for (const request of [...requests].reverse()) {
    for (const item of request.input ?? []) if (item?.type === "function_call_output" && item.call_id === callId) return String(typeof item.output === "string" ? item.output : JSON.stringify(item.output));
    for (const message of request.messages ?? []) if (message?.role === "tool" && message.tool_call_id === callId) return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  }
  return null;
}

async function check(label, open, mcpToolName) {
  const requests = [];
  const outputs = [[call(1, "bash", { command: "touch original.txt && echo original" })], [call(2, mcpToolName, { value: "plugin" })], [say(3, "Done.")]];
  let turns = 0;
  const model = createServer(async (request, response) => {
    const parsed = await body(request);
    requests.push(parsed);
    if (process.env.BOTKINS_PROBE_DEBUG) console.log("  [debug] " + label + " " + request.url + " tools=" + (parsed.tools ?? []).map((t) => t.function?.name ?? t.name).join(",") + " messages=" + (parsed.messages ?? parsed.input ?? []).length);
    if (request.url.includes("chat/completions")) return chatReply(response, parsed, turns++);
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
  const permission = async (request) => (approvals.push(request), { allow: true });
  const port = model.address().port;
  let close = async () => {};
  try {
    const run = await open({ dir, session, permission, port });
    close = run.close;
    const reply = await run.send("Run the tools.");
    const sent = JSON.stringify(requests);
    if (process.env.BOTKINS_PROBE_DEBUG) console.log("  [debug] " + label + " approvals=" + JSON.stringify(approvals.map((a) => [a.kind, a.preview])) + " shell=" + JSON.stringify(resultOf(requests, "call_1")));
    assert.equal(reply, "Done.", label + ": " + sent.slice(-600));
    assert.deepEqual([approvals[0]?.kind, approvals[0]?.preview], ["shell", "touch hooked.txt && echo hooked"], label + ": the person is asked about the changed command");
    // The shell call's own result, and the file it wrote, prove which command ran (not text anywhere in the transcript).
    const shellResult = resultOf(requests, "call_1");
    assert.ok(shellResult !== null && /hooked/.test(shellResult) && !/original/.test(shellResult), label + ": the changed command ran: " + shellResult);
    assert.ok(existsSync(join(dir, "hooked.txt")) && !existsSync(join(dir, "original.txt")), label + ": only the changed command touched the folder");
    // Under the plugin's own server name. (Copilot's runtime names the tool "<server>-echo" in its request; #316 normalizes labels.)
    assert.equal(approvals[1]?.kind, "mcp", label + ": the plugin's tool is an MCP approval");
    assert.ok(approvals[1]?.label?.startsWith(SERVER + " / ") && approvals[1].label.endsWith("echo"), label + ": the plugin's tool under its own name: " + approvals[1]?.label);
    const mcpResult = resultOf(requests, "call_2");
    assert.ok(mcpResult !== null && mcpResult.includes("echo:scoped:plugin"), label + ": the plugin's tool ran with its own setting: " + mcpResult);
    assert.ok(!sent.includes("synthetic-token-value"), label + ": the setting never reached the model");
    const data = join(dir, ".botkins-plugin-data");
    const calls = readdirSync(data).flatMap((f) => (existsSync(join(data, f, "calls.log")) ? readFileSync(join(data, f, "calls.log"), "utf8").trim().split("\n") : []));
    // One hook run for each call, and the hook is told the same names on every harness.
    assert.equal(calls.length, 2, label + ": the hook ran once for each call: " + calls.join(", "));
    assert.ok(isShell(calls[0]), label + ": the hook saw the shell call first: " + calls[0]);
    assert.equal(calls[1], SERVER + "-echo", label + ": the hook saw the plugin's tool by the plugin's name");
    console.log(label + ": PASSED (hook changed args, single run, plugin MCP tool, scoped setting; hook saw the MCP tool as " + JSON.stringify(calls[1]) + ")");
  } finally {
    await close().catch(() => {});
    await new Promise((resolve) => model.close(resolve));
  }
}

// Pi and OMP: Botkins' own providers, as the workspace opens them.
const piLike = (provider) => async ({ dir, session, permission, port }) => {
  const connection = { name: "botkins-test", config: { name: "Local test", baseUrl: "http://127.0.0.1:" + port + "/v1", api: "openai-responses", apiKey: "test", authHeader: true, models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] } };
  const live = await provider.openSession({
    sessionId: "parity-live", established: false, hasReplies: false, folder: dir,
    model: { model: "test", source: "botkins-test" }, inference: { providers: [connection] },
    instructions: "You are Testy.", context: "", tools: [], skills: { directories: [], disabled: [] },
    mcpServers: session.mcpServers, plugins: session.directories, pluginHooks: session.hooks,
    history: () => [], handlers: { permission },
  });
  return { send: async (prompt) => (await live.send({ prompt })).text, close: async () => (await live.close(), await provider.stop()) };
};
// Copilot: the real SDK runtime with Botkins' own sessionOptions() and decide(), as in hook-changed-args-live.mjs.
const copilot = async ({ dir, session, permission, port }) => {
  const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
  const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
  const { planModel } = await import("../desktop/harness/index.mjs");
  const inference = {
    providers: [{ name: "fixture", type: "openai", baseUrl: "http://127.0.0.1:" + port + "/v1", bearerToken: "synthetic-model-token" }],
    models: [planModel("fixture", { id: "local", name: "Local fixture", tools: true, contextWindow: 64_000, maxOutput: 4_096 })],
  };
  const client = new CopilotClient({ mode: "coding-agent", github: { useLoggedInUser: false }, runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: join(dir, "copilot"), workingDirectory: dir }) });
  await client.start();
  const spec = {
    sessionId: "parity-live", folder: dir, model: { model: "local", source: "fixture" }, inference, approval: "read",
    instructions: "You are Testy.", tools: [], skills: { directories: [], disabled: [] },
    mcpServers: session.mcpServers, plugins: session.directories, pluginHooks: session.hooks,
  };
  const sdkSession = await client.createSession({ ...sessionOptions(spec, { handlers: { permission } }), github: { capi: { enabled: false } } });
  return {
    send: async (prompt) => (await sdkSession.sendAndWait({ prompt }, 120_000))?.data?.content?.trim() ?? "",
    close: async () => (await sdkSession.disconnect?.().catch(() => {}), await client.stop?.().catch(() => {})),
  };
};

// Release-gate mode (--gate or BOTKINS_RELEASE_GATE=1): all three harnesses must run and pass.
const gate = process.argv.includes("--gate") || process.env.BOTKINS_RELEASE_GATE === "1";
const results = {};
// The Copilot runtime keeps its state below COPILOT_HOME; this run's is its own, and is removed.
process.env.COPILOT_HOME = join(root, "copilot-home");
const legs = [
  ["pi", async () => { const pi = process.env.PI_BINARY ?? bundledPi(); return pi ? piLike(new PiProvider({ dataDir: join(root, "pi-data"), binary: pi })) : null; }, "mcp__" + ALIAS + "__echo"],
  ["omp", async () => { const omp = process.env.OMP_BINARY ?? (await findBinary("omp")); return omp ? piLike(new OmpProvider({ dataDir: join(root, "omp-data"), binary: omp })) : null; }, "mcp__" + ALIAS + "_echo"],
  ["copilot", async () => copilot, null],
];
// HARNESSES=pi,omp,copilot runs only those (not with --gate, which needs all three).
const only = !gate && process.env.HARNESSES ? new Set(process.env.HARNESSES.split(",").map((name) => name.trim())) : null;
try {
  for (const [label, make, toolName] of legs.filter(([label]) => !only || only.has(label))) {
    let open = null;
    try {
      open = await make();
    } catch (error) {
      results[label] = "missing: " + String(error?.message ?? error).slice(0, 200);
    }
    if (!open) {
      results[label] ??= "missing: not installed";
      console.log(label + ": " + results[label]);
      continue;
    }
    try {
      await check(label, open, toolName);
      results[label] = "passed";
    } catch (error) {
      results[label] = "failed";
      console.log(label + ": FAILED " + String(error?.message ?? error).slice(0, 1200));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
const values = Object.values(results);
const failed = values.includes("failed") || (gate && values.some((value) => value !== "passed"));
console.log((failed ? "FAILED" : "PASSED") + " " + JSON.stringify(results));
process.exit(failed ? 1 : 0);
