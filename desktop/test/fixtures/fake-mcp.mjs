// A one-tool MCP stdio server for the real-OMP live check.
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
    const request = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (!request.id) continue;
    switch (request.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "botkins-fixture", version: "1.0.0" },
          },
        });
        break;
      case "tools/list":
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: [{
              name: "echo",
              description: "Echo one local value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            }],
          },
        });
        break;
      case "tools/call":
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: "echo:" + String(request.params?.arguments?.value ?? "") }],
          },
        });
        break;
      default:
        send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  }
});
