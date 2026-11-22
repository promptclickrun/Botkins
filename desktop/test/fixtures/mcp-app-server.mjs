// A small MCP server with an MCP App, over stdio, for test/mcp-apps.test.mjs. It speaks
// newline-delimited JSON-RPC, as the stdio transport does, and writes one line to BOTKINS_TEST_LOG
// for every request, so a test can count the real tool calls.
//
//   get_time      a tool with a view (ui://clock/view.html); its result has structuredContent and _meta
//   refresh_time  callable by the view only (visibility ["app"])
//   echo          a plain tool with no view
//   set_alarm     a tool that changes something (no readOnlyHint)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.BOTKINS_TEST_LOG;
const VIEW = process.env.BOTKINS_TEST_VIEW_MISSING ? null : "<!doctype html><title>Clock</title><p id=t>…</p><script>/* the view */</script>";
const log = (entry) => LOG && appendFileSync(LOG, JSON.stringify(entry) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let calls = 0;

const tools = [
  { name: "get_time", title: "Get the time", description: "The time now.", inputSchema: { type: "object", properties: { zone: { type: "string" } } }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://clock/view.html" } } },
  { name: "refresh_time", description: "Fresh time for the view.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://clock/view.html", visibility: ["app"] } } },
  { name: "echo", description: "Says it back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "set_alarm", description: "Sets an alarm.", inputSchema: { type: "object", properties: { at: { type: "string" } } } },
];

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return;
  log({ method, ...(method === "tools/call" && { tool: params?.name, args: params?.arguments }), ...(method === "initialize" && { ui: params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"] ?? null }) });
  switch (method) {
    case "initialize":
      return result(id, { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "clock", version: "1.0.0" } });
    case "ping":
      return result(id, {});
    case "tools/list":
      // Two pages, so the host must follow the cursor.
      return params?.cursor === "2" ? result(id, { tools: tools.slice(2) }) : result(id, { tools: tools.slice(0, 2), nextCursor: "2" });
    case "resources/list":
      // A server may leave its views out of the list; the host reads them by the tool's URI.
      return result(id, { resources: [] });
    case "resources/read":
      if (params?.uri !== "ui://clock/view.html" || !VIEW) return send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Resource not found" } });
      return result(id, { contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: VIEW, _meta: { ui: { csp: { connectDomains: ["https://api.clock.example", "http://insecure.example", "*"], resourceDomains: ["https://cdn.clock.example"] }, prefersBorder: true } } }] });
    case "tools/call": {
      calls++;
      const name = params?.name;
      if (name === "get_time" || name === "refresh_time")
        return result(id, { content: [{ type: "text", text: "It is 12:0" + calls + "." }], structuredContent: { time: "12:0" + calls, zone: params?.arguments?.zone ?? "UTC" }, _meta: { secret: "view-only-" + calls } });
      if (name === "echo") return result(id, { content: [{ type: "text", text: String(params?.arguments?.text ?? "") }] });
      if (name === "set_alarm") return result(id, { content: [{ type: "text", text: "Alarm set." }] });
      return result(id, { content: [{ type: "text", text: "Unknown tool" }], isError: true });
    }
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
