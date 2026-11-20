// Opt-in real SDK proof for plugin runtime traffic.
//
// Run with:
//   node test/plugin-memory-live.mjs
//
// The outer process creates a clean HOME/COPILOT_HOME and the isolated child uses only a local
// fake MCP and a local OpenAI-compatible model endpoint. It never reads ~/.copilot/config.json or
// needs a GitHub credential.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);

if (process.argv[2] !== "--isolated") {
  const home = mkdtempSync(join(process.env.TMPDIR || "/private/tmp", "botkins-plugin-memory-live-"));
  try {
    const env = {
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: join(home, "copilot"),
      BOTKINS_DATA_DIR: join(home, "botkins"),
      PLUGIN_HOST_SECRET: "host-only-secret-must-not-reach-plugin-mcp",
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [script, "--isolated"], { env, stdio: "inherit", timeout: 120_000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  const root = mkdtempSync(join(process.env.TMPDIR || "/private/tmp", "botkins-plugin-memory-live-inner-"));
  const MCP_KEY = "synthetic-plugin-mcp-key-9d7e";
  const HOOK_CONTEXT = "fresh-plugin-context-once-4f2a";
  const MODEL_REPLY = "MODEL_REPLY_ONCE-31c8";
  const requests = [];
  const mcp = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ kind: "mcp", path: request.url, method: request.method, authorization: request.headers.authorization, body });
    if (request.headers.authorization !== "Bearer " + MCP_KEY) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let message;
    try { message = JSON.parse(body); } catch { message = null; }
    if (message?.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = message?.method === "initialize"
      ? { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "local-hindsight-fixture", version: "1" } }
      : message?.method === "tools/list"
        ? { tools: [] }
        : message?.method === "ping"
          ? {}
          : null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, result: result ?? {}, ...(result === null && { error: { code: -32601, message: "Not found" } }) }));
  });
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ kind: "model", path: request.url, method: request.method, authorization: request.headers.authorization, body });
    assert.equal(request.headers.authorization, "Bearer synthetic-model-token");
    const parsed = JSON.parse(body);
    assert.equal(parsed.stream, true, "production sessionOptions uses streaming model requests");
    const events = [
      { id: "fixture-chat-1", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: { role: "assistant", content: MODEL_REPLY }, finish_reason: null }] },
      { id: "fixture-chat-1", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listen(mcp);
  await listen(model);
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, ".plugin"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  const stdioEnvReport = join(root, "stdio-env.json");
  const stdioFixture = join(plugin, "stdio-env.cjs");
  writeFileSync(stdioFixture, [
    "const fs = require('node:fs');",
    "const crypto = require('node:crypto');",
    "const setting = process.env.LOCAL_PLUGIN_SETTING || '';",
    "fs.writeFileSync(process.argv[2], JSON.stringify({ hostPresent: Boolean(process.env.PLUGIN_HOST_SECRET), settingHash: crypto.createHash('sha256').update(setting).digest('hex') }));",
    "const readline = require('node:readline');",
    "readline.createInterface({ input: process.stdin }).on('line', line => { let msg; try { msg = JSON.parse(line); } catch { return; } if (msg.id === undefined) return; const result = msg.method === 'initialize' ? { protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stdio-env-fixture', version: '1' } } : msg.method === 'tools/list' ? { tools: [] } : {}; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n'); });",
  ].join("\n"));
  writeFileSync(join(plugin, ".plugin", "plugin.json"), JSON.stringify({ name: "memory-fixture", version: "1.0.0", hooks: "hooks/hooks.json", mcpServers: ".mcp.json" }));
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({
    mcpServers: {
      memory: {
        type: "http",
        url: `http://127.0.0.1:${mcp.address().port}/mcp/default/`,
        headers: { Authorization: "Bearer ${MEMORY_API_KEY}" },
      },
      localEnv: {
        type: "local",
        command: process.execPath,
        args: [stdioFixture, stdioEnvReport],
        env: { LOCAL_PLUGIN_SETTING: "${MEMORY_API_KEY}" },
      },
    },
  }));
  writeFileSync(join(plugin, "hook.cjs"), [
    "let body='';",
    "process.stdin.on('data', chunk => body += chunk);",
    "process.stdin.on('end', () => {",
    "  const fs = require('node:fs');",
    "  fs.appendFileSync(process.env.PLUGIN_DATA + '/prompt-hook.log', 'once\\n');",
    `  process.stdout.write(JSON.stringify({ additionalContext: ${JSON.stringify(HOOK_CONTEXT)} }));`,
    "});",
  ].join("\n"));
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: {
    userPromptSubmitted: [{ type: "command", bash: `${process.execPath} ${JSON.stringify(join(plugin, "hook.cjs"))}`, timeoutSec: 5 }],
  } }));

  let client;
  let session;
  try {
    const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
    const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
    const { pluginSession } = await import("../desktop/plugin-runtime.mjs");
    const { planModel } = await import("../desktop/harness/index.mjs");
    const pluginSpec = pluginSession([{
      id: "memory-fixture",
      folder: plugin,
      values: { MEMORY_API_KEY: MCP_KEY },
      config: [{ key: "MEMORY_API_KEY", secret: true, set: true }],
      status: "ready",
      enabled: true,
      bots: "all",
    }], { dir: root, chatId: "chat-live", botId: "bot-live" });
    const workingDirectory = join(root, "work");
    mkdirSync(workingDirectory, { recursive: true });
    const inference = {
      providers: [{ name: "fixture", type: "openai", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, bearerToken: "synthetic-model-token" }],
      models: [planModel("fixture", { id: "local", name: "Local fixture", tools: true, contextWindow: 64_000, maxOutput: 4_096 })],
    };
    const options = sessionOptions({
      sessionId: "chat-live",
      folder: workingDirectory,
      model: { model: "local", source: "fixture" },
      inference,
      approval: "read",
      instructions: "Answer with the local fixture response.",
      tools: [],
      skills: { directories: [], disabled: [] },
      plugins: pluginSpec.directories,
      mcpServers: pluginSpec.mcpServers,
      pluginHooks: pluginSpec.hooks,
      pluginRevision: 1,
    }, { handlers: {} });
    client = new CopilotClient({
      mode: "coding-agent",
      github: { useLoggedInUser: false },
      // Deliberately inherit the isolated host environment: plugin-mcp-launcher is the boundary
      // under test, rather than an app-wide Copilot runtime env override.
      runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: join(root, "copilot"), workingDirectory }),
    });
    await client.start();
    session = await client.createSession({ ...options, github: { capi: { enabled: false } } });
    const reply = await session.sendAndWait({ prompt: "Use memory context, then answer." }, 30_000);
    const replyText = typeof reply === "string" ? reply : reply?.data?.content ?? reply?.text ?? "";
    assert.match(replyText, new RegExp(MODEL_REPLY));

    const mcpRequests = requests.filter((entry) => entry.kind === "mcp");
    const initializes = mcpRequests.filter((entry) => JSON.parse(entry.body || "{}").method === "initialize");
    assert.equal(initializes.length, 1, "the real SDK initialized the credentialed MCP once");
    assert.equal(initializes[0].authorization, "Bearer " + MCP_KEY);
    const modelRequests = requests.filter((entry) => entry.kind === "model");
    const modelBodies = modelRequests.map((entry) => entry.body).join("\n");
    assert.equal(modelBodies.split(HOOK_CONTEXT).length - 1, 1, "fresh hook context reaches model traffic once");
    assert.doesNotMatch(modelBodies, new RegExp(MCP_KEY));
    assert.doesNotMatch(replyText, new RegExp(MCP_KEY));
    assert.equal(modelRequests.length >= 1, true);
    const stdioEnv = JSON.parse(readFileSync(stdioEnvReport, "utf8"));
    assert.equal(stdioEnv.settingHash, createHash("sha256").update(MCP_KEY).digest("hex"), "the local MCP receives its approved setting");
    assert.equal(stdioEnv.hostPresent, false, "the local MCP does not inherit the host credential");

    const dataFiles = [];
    const walk = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) walk(path);
        else dataFiles.push(path);
      }
    };
    walk(join(root, ".botkins-plugin-data"));
    const allFiles = [];
    const walkAll = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) walkAll(path);
        else allFiles.push(path);
      }
    };
    walkAll(root);
    const leakedPaths = allFiles.filter((path) => readFileSync(path).includes(MCP_KEY));
    assert.deepEqual(leakedPaths, [], "the plugin key stays out of local persistence and logs: " + leakedPaths.join(", "));
    const hookLog = dataFiles.find((path) => path.endsWith("prompt-hook.log"));
    assert.ok(hookLog);
    assert.equal(readFileSync(hookLog, "utf8"), "once\n");
    console.log(JSON.stringify({ modelRequests: modelRequests.length, mcpRequests: mcpRequests.map((entry) => JSON.parse(entry.body || "{}").method), hookContextOccurrences: modelBodies.split(HOOK_CONTEXT).length - 1, persistedFiles: allFiles.length }));
  } finally {
    await session?.disconnect?.().catch(() => {});
    await client?.stop?.().catch(() => {});
    mcp.closeAllConnections();
    model.closeAllConnections();
    await new Promise((resolve) => mcp.close(resolve));
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
