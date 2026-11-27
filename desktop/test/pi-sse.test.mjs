import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { bundledPi, PiProvider } from "../desktop/providers/pi/index.mjs";
import { modelReply } from "./fixtures/pi-model-response.mjs";

test("bundled Pi discovers, approves, denies and disconnects a legacy SSE server", { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bk-pi-sse-"));
  const binary = bundledPi();
  assert.ok(binary, "the Pi bundled with Botkins is required");
  const provider = new PiProvider({ dataDir: root, binary, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root } });
  const requests = [], calls = [], headers = [], approvals = [];
  const hanging = Promise.withResolvers(), cancelled = Promise.withResolvers();
  let hangingId;
  let stream, connected = 0, closed = 0, modelStep = 0;
  const tool = { name: "echo", description: "Echo fixture input", inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } };
  const server = createServer(async (req, res) => {
    if (req.url === "/events" && req.method === "GET") {
      headers.push(req.headers.authorization);
      connected++;
      stream = res;
      res.on("close", () => closed++);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (req.method !== "POST" || !["/messages", "/model/responses"].includes(req.url)) {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (req.url === "/model/responses") {
      requests.push(message);
      const response = ++modelStep % 2 === 1
        ? modelReply("call" + modelStep, "mcp__legacy__echo", { word: "word" + modelStep })
        : modelReply("done" + modelStep);
      res.writeHead(200, Object.fromEntries(response.headers)).end(await response.text());
      return;
    }
    headers.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer fixture-only") return res.writeHead(401).end();
    if (message.method === "notifications/cancelled" && message.params.requestId === hangingId) cancelled.resolve();
    if (message.method === "tools/call") {
      calls.push(message.params);
      if (message.params.arguments.word === "word9") {
        hangingId = message.id;
        res.writeHead(202).end();
        hanging.resolve();
        return;
      }
      if (message.params.arguments.word === "word5") {
        res.writeHead(202).end();
        stream.destroy();
        return;
      }
    }
    res.writeHead(202).end();
    if (message.id === undefined) return;
    const result = message.method === "initialize"
      ? { protocolVersion: "2024-11-05", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
      : message.method === "tools/list" ? { tools: [tool] }
      : message.method === "tools/call" ? { content: [{ type: "text", text: "upstream:" + message.params.arguments.word }] }
      : {};
    stream.write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n\n");
  });
  t.after(async () => {
    await provider.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port;
  const spec = {
    sessionId: "fixture", folder: root, model: { source: "fixture", model: "fixture" },
    inference: { providers: [{ name: "fixture", config: {
      baseUrl: url + "/model", api: "openai-responses", apiKey: "model-fixture",
      models: [{ id: "fixture", name: "Fixture", input: ["text"], contextWindow: 16000, maxTokens: 1000, cost: {} }],
    } }] },
    mcpServers: { legacy: { type: "sse", url: url + "/events", headers: { Authorization: "Bearer fixture-only" } } },
    instructions: "You are a fixture.", tools: [], history: () => [],
    handlers: { permission: async (request) => {
      approvals.push(request);
      return { allow: approvals.length !== 2 };
    } },
  };
  const session = await provider.openSession(spec);
  await session.send({ prompt: "Call once." });
  assert.ok(requests[0]?.tools?.some(({ name }) => name === "mcp__legacy__echo"), "the model sees the SSE tool with its configured server identity");
  assert.equal(approvals[0]?.label, "legacy / echo");
  assert.match(JSON.stringify(requests[1].input), /upstream:word1/);
  await session.send({ prompt: "Try again." });
  assert.equal(approvals[1]?.label, "legacy / echo");
  assert.deepEqual(calls.map(x => x.arguments.word), ["word1"], "denial never reached the upstream server");
  assert.ok(headers.length >= 4 && headers.every(value => value === "Bearer fixture-only"));
  assert.doesNotMatch(JSON.stringify(requests), /fixture-only/);
  await session.send({ prompt: "The stream drops during this call." });
  assert.match(JSON.stringify(requests[5].input), /legacy.*SSE.*failed/i);
  assert.deepEqual(calls.map(x => x.arguments.word), ["word1", "word5"], "a lost response must not replay the call");
  await session.send({ prompt: "Make a fresh request." });
  assert.match(JSON.stringify(requests[7].input), /upstream:word7/);
  assert.equal(connected, 2);
  assert.equal(closed, 1);
  const stopping = session.send({ prompt: "Wait on a call until stopped." });
  await hanging.promise;
  await session.abort();
  await Promise.all([stopping, cancelled.promise]);
  assert.deepEqual(calls.map(x => x.arguments.word), ["word1", "word5", "word7", "word9"]);
  await session.close();
  await provider.stop();
  for (let i = 0; closed < connected && i < 50; i++) await delay(20);
  assert.equal(closed, connected, "stopping Pi closes the live SSE connection");
});
