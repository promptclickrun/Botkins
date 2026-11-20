// A local stdio MCP server used by the SDK smoke test. Returns a value known only to the fixture.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const [dataFile, receiptFile] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  let result;
  switch (msg.method) {
    case "initialize":
      result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "botkins-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "review_note",
            description:
              "Review a synthetic note and return the locally stored sample identifier.",
            inputSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["note"],
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
          {
            name: "read_sample",
            description: "Read the current synthetic sample identifier.",
            inputSchema: { type: "object", properties: {} },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
        ],
      };
      break;
    case "tools/call":
      if (["read_sample", "review_note"].includes(msg.params.name)) {
        if (msg.params.name === "review_note")
          await new Promise((resolve) => setTimeout(resolve, 1200));
        const value = readFileSync(dataFile, "utf8");
        appendFileSync(receiptFile, value + "\n");
        result = { content: [{ type: "text", text: value }] };
      }
      break;
    case "ping":
      result = {};
      break;
  }
  console.log(
    JSON.stringify(
      result === undefined
        ? {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Unknown method" },
          }
        : { jsonrpc: "2.0", id: msg.id, result },
    ),
  );
}
