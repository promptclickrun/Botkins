// Real OMP, local model endpoint. No provider account or plan is used.
//   OMP_BINARY=/path/to/omp node test/omp-live.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";

const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
const body = (request) =>
  new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(JSON.parse(data)));
  });
const textOutput = (id, text) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const toolOutput = {
  id: "fc_1",
  type: "function_call",
  call_id: "call_1",
  name: "bash",
  status: "completed",
  arguments: JSON.stringify({ command: "printf omp-tool" }),
};
const mcpToolOutput = {
  id: "fc_2",
  type: "function_call",
  call_id: "call_2",
  name: "mcp__fixture_echo",
  status: "completed",
  arguments: JSON.stringify({ value: "omp-mcp" }),
};

const requests = [];
let modelTurns = 0;
const outputs = [
  [textOutput("msg_1", "OMP is ready.")],
  [toolOutput],
  [textOutput("msg_2", "The tool ran.")],
  [mcpToolOutput],
  [textOutput("msg_3", "The MCP tool ran.")],
];
const model = createServer(async (request, response) => {
  const input = await body(request);
  requests.push(input);
  const output = outputs[modelTurns++] ?? [textOutput("msg_final", "Done.")];
  const responseId = "resp_" + modelTurns;
  const item = output[0];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.end(
    sse("response.created", { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } }) +
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: item.type === "message"
          ? { ...item, status: "in_progress", content: [] }
          : { ...item, status: undefined, arguments: "" },
      }) +
      (item.type === "message"
        ? sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text })
        : sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments })) +
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
      sse("response.completed", {
        type: "response.completed",
        response: { id: responseId, status: "completed", output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const root = mkdtempSync(join(tmpdir(), "botkins-omp-live-"));
const provider = new OmpProvider({ dataDir: join(root, "data"), ...(process.env.OMP_BINARY && { binary: process.env.OMP_BINARY }) });
const approvals = [];
try {
  const address = model.address();
  const connection = {
    name: "botkins-test",
    config: {
      name: "Local test",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-responses",
      apiKey: "test",
      authHeader: true,
      models: [{
        id: "test",
        name: "Test",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false },
      }],
    },
  };
  const session = await provider.openSession({
    sessionId: "omp-live",
    established: false,
    hasReplies: false,
    folder: root,
    model: { model: "test", source: "botkins-test" },
    inference: { providers: [connection] },
    instructions: "You are Testy.",
    context: "",
    tools: [],
    skills: { directories: [], disabled: [] },
    mcpServers: {
      fixture: {
        type: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url))],
      },
    },
    history: () => [],
    handlers: { permission: async (request) => (approvals.push(request), { allow: true }) },
  });
  const events = [];
  session.on((event) => events.push(event));
  const first = await session.send({ prompt: "Say OMP is ready." });
  assert.equal(first.text, "OMP is ready.", JSON.stringify(events));
  assert.equal((await session.send({ prompt: "Run the shell tool once, then answer." })).text, "The tool ran.");
  assert.equal((await session.send({ prompt: "Run the fixture echo MCP tool once, then answer." })).text, "The MCP tool ran.");
  assert.equal(approvals.length, 2);
  assert.deepEqual([approvals[0].kind, approvals[0].toolName, approvals[0].preview], ["shell", "bash", "printf omp-tool"]);
  assert.deepEqual([approvals[1].kind, approvals[1].label, approvals[1].toolName], ["mcp", "fixture / echo", "echo"]);
  assert.ok(requests.length >= 5);
  const prompts = requests.map((request) => {
    const at = typeof request.instructions === "string" ? request.instructions.indexOf("omp://: harness docs") : -1;
    return {
      type: typeof request.instructions,
      harnessDocs: at >= 0,
      docsTag: typeof request.instructions === "string" && request.instructions.includes("<docs>"),
      bot: typeof request.instructions === "string" && request.instructions.includes("You are Testy."),
      ...(at >= 0 && { around: request.instructions.slice(Math.max(0, at - 180), at + 180) }),
    };
  });
  assert.ok(prompts.every((prompt) => prompt.type === "string" && !prompt.docsTag && !prompt.harnessDocs), JSON.stringify(prompts));
  assert.ok(prompts.every((prompt) => prompt.bot), JSON.stringify(prompts));
  console.log("OMP live: startup, streamed reply, approvals, shell, MCP and settlement passed.");
} finally {
  await provider.stop();
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
