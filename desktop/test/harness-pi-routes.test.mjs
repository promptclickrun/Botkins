// The Pi that ships with Botkins, running real turns on GitHub Copilot's and OpenCode's models
// through the gateway (desktop/harness): Pi → /copilot → a stand-in for GitHub's model API, and
// Pi → /opencode → the OpenCode relay → a scripted OpenCode. Each turn calls one of Botkins' own
// tools over the tool bridge and then answers with what it returned. Nothing reaches the network.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../desktop/harness/index.mjs";
import { bundledPi, PiProvider } from "../desktop/providers/pi/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";

const skip = !bundledPi() && "The bundled Pi isn't installed (npm ci).";
const root = mkdtempSync(join(tmpdir(), "botkins-pi-routes-"));
const bridge = new ToolBridge();
after(async () => {
  await bridge.stop();
  rmSync(root, { recursive: true, force: true });
});
const WORD = "marmalade-5386";
const secretTool = (calls) => ({ name: "secret_word", description: "Returns today's secret word.", parameters: { type: "object", properties: {} }, handler: async () => (calls.push(1), JSON.stringify({ word: WORD })) });
const spec = (hosted, tools) => ({
  sessionId: "chat-" + Math.random().toString(36).slice(2),
  established: false,
  hasReplies: false,
  folder: root,
  model: hosted.model,
  inference: hosted.inference,
  instructions: "You are Testy.",
  context: "",
  tools,
  skills: { directories: [], disabled: [] },
  mcpServers: {},
  history: () => [],
  handlers: { permission: async () => ({ allow: true }), question: async () => ({ answer: "" }) },
});
/** Chat Completions chunks as an event stream. */
const stream = (response, chunks) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write("data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", ...chunk }) + "\n\n");
  response.end("data: [DONE]\n\n");
};
const readBody = async (request) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
};
/** The tool the request offers whose name ends with `name` (Pi names an MCP server's tools its own way). */
const offered = (body, name) => (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name).find((each) => each?.endsWith(name));

test("Pi runs a GitHub Copilot model's turn through /copilot: a tool call, then the answer, signed by the lent headers", { skip, timeout: 120_000 }, async () => {
  const seen = [];
  const upstream = createServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({ path: request.url, headers: request.headers, body });
    const toolName = offered(body, "secret_word");
    if (!body.messages.some((message) => message.role === "tool"))
      return stream(response, [{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolName, arguments: "{}" } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
    const result = body.messages.findLast((message) => message.role === "tool").content;
    const word = /marmalade-\d+/.exec(typeof result === "string" ? result : JSON.stringify(result))?.[0];
    stream(response, [{ choices: [{ index: 0, delta: { role: "assistant", content: "The word is " + word } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }]);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  after(() => (upstream.closeAllConnections(), upstream.close()));
  const origin = "http://127.0.0.1:" + upstream.address().port;
  const relay = { credentials: async () => ({ url: origin + "/chat/completions", headers: { authorization: "Bearer gho_lent", "editor-version": "copilot/1" }, at: Date.now() }), endpoints: async () => new Map([["gemini-x", "completions"]]), forget() {} };
  const pi = new PiProvider({ dataDir: join(root, "pi-copilot"), bridge });
  after(() => pi.stop());
  const copilot = { id: "copilot", relay: () => relay };
  const byId = new Map([["copilot", copilot], ["pi", pi]]);
  const providers = { byId, for: (selection) => byId.get(selection.provider), models: async () => [{ id: "gemini-x", name: "Gemini X", provider: "copilot", vision: false }] };
  const harness = new Harness({ providers, choice: () => "pi", dir: root, bridge });
  after(() => harness.stop());
  const selection = { provider: "copilot", model: "gemini-x" };
  const via = harness.via(selection);
  assert.equal(via, "pi");
  assert.equal(harness.runner(selection, via), pi);
  const hosted = await harness.session(selection, via);
  const calls = [];
  const session = await pi.openSession(spec(hosted, [secretTool(calls)]));
  after(() => session.close());
  const events = [];
  session.on((event) => events.push(event));
  const result = await session.send({ prompt: "Call the secret_word tool, then say the word." });
  assert.match(result.text, new RegExp("The word is " + WORD));
  assert.equal(calls.length, 1, "Botkins' tool ran once, through the bridge");
  assert.ok(events.some((event) => event.type === "tool.execution_start"), "the step is shown");
  assert.deepEqual(seen.map((each) => [each.path, each.headers.authorization, each.headers["x-initiator"]]), [
    ["/chat/completions", "Bearer gho_lent", "user"],
    ["/chat/completions", "Bearer gho_lent", "agent"],
  ]);
  assert.ok(seen.every((each) => !JSON.stringify(each.headers).includes(harness.gateway.secret)), "the gateway's secret stays between Pi and the gateway");
  assert.equal(seen[0].body.model, "gemini-x");
});

test("Pi runs an OpenCode model's turn through /opencode: one OpenCode step per request, its tool run by Pi", { skip, timeout: 120_000 }, async () => {
  const imports = [];
  const open = new Map();
  let calls = 0;
  const emit = (sessionID, type, data = {}) => open.get(sessionID)?.received({ type, data: { sessionID, assistantMessageID: "m-" + sessionID, ...data } });
  let server;
  const api = {
    get: async () => ({ data: [] }),
    patch: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
    put: async (path) => {
      if (path.startsWith("/api/experimental/mcp/")) server = path.split("/").pop();
      return { data: {} };
    },
    post: async (path, body) => {
      if (path === "/api/session") return { data: { id: "ses_probe", projectID: "p" } };
      if (path === "/api/experimental/session/import") return (imports.push(body), { data: body.info });
      const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
      if (prompt) {
        const id = prompt[1];
        const imported = imports.find((each) => each.info.id === id);
        const done = imported.messages.find((message) => message.type === "assistant")?.content.find((part) => part.type === "tool")?.state;
        setImmediate(() => {
          emit(id, "session.step.started");
          if (!done) {
            calls++;
            emit(id, "session.tool.input.started", { id: "call_oc", name: server + "_" + imported.toolName });
            emit(id, "session.tool.called", { id: "call_oc", input: {} });
            emit(id, "session.step.streamed");
            return;
          }
          const word = /marmalade-\d+/.exec(JSON.stringify(done.content))?.[0];
          emit(id, "session.text.delta", { delta: "OpenCode says " + word });
          emit(id, "session.step.ended", { tokens: { input: 5, output: 3 } });
        });
        return { data: {} };
      }
      const interrupt = /^\/api\/session\/([^/]+)\/interrupt$/.exec(path);
      if (interrupt) setImmediate(() => emit(interrupt[1], "session.step.failed", { error: { type: "aborted" }, tokens: { input: 4, output: 2 } }));
      return { data: {} };
    },
  };
  const opencode = { id: "opencode", server: async () => api, serverIfRunning: async () => api, listen: async () => {}, attach: (w) => open.set(w.sessionId, w), detach: (w) => open.delete(w.sessionId), models: async () => [] };
  const pi = new PiProvider({ dataDir: join(root, "pi-opencode"), bridge });
  after(() => pi.stop());
  const byId = new Map([["opencode", opencode], ["pi", pi]]);
  const providers = { byId, for: (selection) => byId.get(selection.provider), models: async () => [{ id: "google/gemini-x", name: "Gemini X", provider: "opencode", vision: false }] };
  const harness = new Harness({ providers, choice: () => "pi", dir: root, bridge });
  after(() => harness.stop());
  // The tool OpenCode's model asks for is the one Pi offered as Botkins' secret_word.
  const relay = harness.opencodeRelay();
  const turn = relay.turn.bind(relay);
  relay.turn = (body, options) => {
    const name = (body.tools ?? []).map((tool) => tool.function.name).find((each) => each.endsWith("secret_word"));
    const realImport = api.post;
    api.post = async (path, payload) => {
      if (path === "/api/experimental/session/import") payload.toolName = name;
      return realImport(path, payload);
    };
    return turn(body, options).finally(() => (api.post = realImport));
  };
  const selection = { provider: "opencode", model: "google/gemini-x" };
  assert.equal(harness.via(selection), "pi");
  const hosted = await harness.session(selection, "pi");
  assert.equal(hosted.model.source, "botkins-opencode");
  const ran = [];
  const session = await pi.openSession(spec(hosted, [secretTool(ran)]));
  after(() => session.close());
  const result = await session.send({ prompt: "Call the secret_word tool, then say the word." });
  assert.match(result.text, new RegExp("OpenCode says " + WORD));
  assert.equal(ran.length, 1, "Pi ran Botkins' tool, not OpenCode");
  assert.equal(calls, 1);
  assert.equal(imports.length, 2, "one OpenCode session per model request");
  assert.equal(imports[1].messages.at(-1).content.find((part) => part.type === "tool").state.status, "completed", "the second request carries the tool's result");
});
