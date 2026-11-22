// The phone's host for an MCP App's view (src/features/chat/mcpApp.ts): the MCP Apps handshake, the
// tool's input and result once, the view's calls, and the page with its policy first.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAppView } from "../src/link/types";
import { createMcpHost, deliver, MCP_APPS_PROTOCOL, mcpAppCsp, mcpAppPage, VIEW_MAX } from "../src/features/chat/mcpApp";

const VIEW: McpAppView = {
  id: "card",
  server: "clock",
  tool: { name: "get_time", inputSchema: { properties: {} } },
  input: { zone: "UTC" },
  result: { content: [{ type: "text", text: "It is 12:00." }], structuredContent: { time: "12:00" }, _meta: { secret: "for the view" } },
  csp: { resourceDomains: ["https://cdn.clock.example", "http://plain.example"], connectDomains: ["wss://live.clock.example"] },
  html: "<!doctype html><html><head><script>/* view */</script></head><body><p>Clock</p></body></html>",
};
const CONTEXT = { theme: "light", platform: "mobile", displayMode: "inline", availableDisplayModes: ["inline"], deviceCapabilities: { touch: true, hover: false } } as const;

function setup() {
  const sent: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const state = { height: 0, ready: 0, openLink: true };
  const host = createMcpHost(
    VIEW,
    { ...CONTEXT },
    {
      callTool: async (name, args) => {
        asked.push("tool " + name + " " + JSON.stringify(args));
        if (name === "boom") throw new Error("The server is gone.");
        return { content: [{ type: "text", text: "12:01" }] };
      },
      readResource: async (uri) => (asked.push("read " + uri), { contents: [] }),
      openLink: async (url) => (asked.push("open " + url), state.openLink),
      size: (height) => (state.height = height),
      ready: () => state.ready++,
    },
    (message) => sent.push(message as Record<string, unknown>),
  );
  const send = (message: object) => host.receive(JSON.stringify({ jsonrpc: "2.0", ...message }));
  return { host, sent, asked, state, send };
}

test("the handshake answers as a host, then sends the tool's input and its result once", async () => {
  const { host, sent, state, send } = setup();
  await send({ id: 1, method: "ui/initialize", params: { protocolVersion: MCP_APPS_PROTOCOL, appInfo: { name: "clock", version: "1" }, appCapabilities: {} } });
  const init = sent[0] as { id: number; result: { protocolVersion: string; hostCapabilities: Record<string, unknown>; hostContext: { theme: string; toolInfo: { tool: { name: string; inputSchema: { type: string } } } } } };
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, MCP_APPS_PROTOCOL);
  assert.deepEqual(Object.keys(init.result.hostCapabilities).sort(), ["openLinks", "serverResources", "serverTools"], "only what the phone does is offered");
  assert.equal(init.result.hostContext.toolInfo.tool.name, "get_time");
  assert.equal(init.result.hostContext.toolInfo.tool.inputSchema.type, "object");

  // Nothing about the tool goes before the view says it is initialized.
  assert.equal(sent.length, 1);
  host.theme("dark");
  assert.equal(sent.length, 1, "a theme before the start is in the next context, not a notification");
  await send({ method: "ui/notifications/initialized", params: {} });
  await send({ method: "ui/notifications/initialized", params: {} });
  assert.deepEqual(sent.slice(1).map((message) => message.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.deepEqual((sent[1] as { params: unknown }).params, { arguments: { zone: "UTC" } });
  assert.deepEqual((sent[2] as { params: unknown }).params, VIEW.result);
  assert.equal(state.ready, 1);

  host.theme("light");
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  host.teardown();
  assert.equal(sent.at(-1)?.method, "ui/resource-teardown");
});

test("the view's calls go through the screen's calls, and a failure is an error answer", async () => {
  const { sent, asked, state, send } = setup();
  await send({ id: 2, method: "tools/call", params: { name: "refresh_time", arguments: { a: 1 } } });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "12:01" }] } });
  await send({ id: 3, method: "tools/call", params: { name: "boom" } });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "The server is gone." } });
  await send({ id: 4, method: "resources/read", params: { uri: "ui://clock/more" } });
  await send({ id: 5, method: "ui/open-link", params: { url: "https://clock.example" } });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 5, result: {} });
  state.openLink = false;
  await send({ id: 6, method: "ui/open-link", params: { url: "https://clock.example" } });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 6, result: { isError: true } });
  await send({ id: 7, method: "ui/message", params: {} });
  assert.deepEqual((sent.at(-1) as { error: { code: number } }).error.code, -32601, "what the phone doesn't offer is refused");
  assert.deepEqual(asked, ['tool refresh_time {"a":1}', "tool boom {}", "read ui://clock/more", "open https://clock.example", "open https://clock.example"]);

  await send({ method: "ui/notifications/size-changed", params: { height: 99999 } });
  assert.equal(state.height, VIEW_MAX);
  // Not JSON-RPC, or not JSON: nothing happens.
  const before = sent.length;
  await setup().host.receive("not json");
  await send({ jsonrpc: "1.0", id: 8, method: "tools/call" } as object);
  assert.equal(sent.length, before + 0);
});

test("the page has the app's policy first, with only the https and wss origins the server declared", () => {
  const csp = mcpAppCsp(VIEW.csp);
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdn\.clock\.example;/);
  assert.ok(!csp.includes("plain.example"));
  assert.match(csp, /connect-src wss:\/\/live\.clock\.example;/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(mcpAppCsp({ resourceDomains: [], connectDomains: [] }), /connect-src 'none'/);
  const page = mcpAppPage(VIEW, "/* guard */");
  assert.ok(page.indexOf("Content-Security-Policy") < page.indexOf("/* view */"), "the policy comes before anything of the view's");
  assert.ok(page.startsWith("<!doctype html><html><head><meta charset=\"utf-8\">"));
  assert.ok(page.includes("<body><!doctype html><html><head><script>/* view */"));
  assert.equal(deliver({ a: "</script>" }), 'window.__botkinsMcp("{\\"a\\":\\"</script>\\"}");true;');
});
