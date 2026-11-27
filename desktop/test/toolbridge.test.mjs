// The tool bridge (desktop/providers/toolbridge.mjs) and /reload-tools: Botkins' tools must stay listed for a
// backend that keeps its MCP connection (Pi, OMP). A chat warmed ahead of its message closed the bridge before Pi
// connected, Pi cached an empty list for the life of its process, and the bot lost every mcp__botkins__ tool.
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";

const tool = (name, description = "A tool.") => ({ name, description, parameters: { type: "object", properties: {} }, handler: async () => name + " ran" });

async function rpc(server, method, params) {
  const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params && { params }) }) });
  return (await response.json()).result;
}
const names = async (server) => (await rpc(server, "tools/list")).tools.map((entry) => entry.name).sort();

test("a kept address keeps listing its tools after close, so a backend that connects late still sees them", async (t) => {
  const bridge = new ToolBridge();
  t.after(() => bridge.stop());
  const warm = await bridge.open([tool("side_pane_show"), tool("claude_artifact")], { key: "pi:chat-1" });
  // What Workspace.prewarm does: the session closes before Pi has connected.
  warm.close();
  assert.deepEqual(await names(warm), ["claude_artifact", "side_pane_show"], "Pi connecting after the warm-up still gets every tool");
  assert.ok((await rpc(warm, "initialize", { protocolVersion: "2025-06-18" })).capabilities.tools.listChanged);
  // Between turns a call says so, and nothing runs.
  const idle = await rpc(warm, "tools/call", { name: "claude_artifact", arguments: {} });
  assert.equal(idle.isError, true);
  assert.match(idle.content[0].text, /No turn is running/);
  // The next turn's tools run again, on the same address.
  const turn = await bridge.open([tool("side_pane_show"), tool("claude_artifact")], { key: "pi:chat-1" });
  assert.equal(turn.url, warm.url);
  assert.equal((await rpc(turn, "tools/call", { name: "claude_artifact", arguments: {} })).content[0].text, "claude_artifact ran");
  // A session without a key goes away when it closes.
  const once = await bridge.open([tool("x")]);
  once.close();
  const gone = await fetch(once.url, { method: "POST", headers: { ...once.headers, "content-type": "application/json" }, body: "{}" });
  assert.equal(gone.status, 401);
});

test("a change to the tools is pushed as notifications/tools/list_changed on the address's event stream", async (t) => {
  const bridge = new ToolBridge();
  t.after(() => bridge.stop());
  const server = await bridge.open([tool("a")], { key: "pi:chat-2" });
  const url = new URL(server.url);
  const events = [];
  const stream = await new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { ...server.headers, accept: "text/event-stream" } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.setEncoding("utf8");
      res.on("data", (chunk) => events.push(chunk));
      resolve(req);
    });
    req.on("error", reject);
    req.end();
  });
  t.after(() => stream.destroy());
  server.set([tool("a")]);
  await new Promise((done) => setTimeout(done, 50));
  assert.ok(!events.join("").includes("list_changed"), "the same list says nothing");
  server.set([tool("a"), tool("claude_artifact")]);
  for (let i = 0; i < 50 && !events.join("").includes("list_changed"); i++) await new Promise((done) => setTimeout(done, 10));
  assert.match(events.join(""), /notifications\/tools\/list_changed/);
  // A browser-style GET with no event-stream accept is still refused.
  const plain = await fetch(server.url, { headers: server.headers });
  assert.equal(plain.status, 405);
});
