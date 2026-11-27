// Every provider on every harness (desktop/harness): which program runs a turn, what Pi, OMP and
// the Copilot runtime are told, and the gateway's routes for GitHub Copilot (/copilot, signed by
// headers a Copilot runtime lends: providers/copilot/relay.mjs) and OpenCode (/opencode, one step
// of an OpenCode session: harness/opencode.mjs). GitHub, OpenCode and the model services are
// stood in for here: nothing reaches the network, the keychain, or a real OpenCode or Copilot.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../desktop/harness/gateway.mjs";
import { COPILOT_CONNECTIONS, HARNESSES, Harness, PI_PLANS, PLANS, piModel } from "../desktop/harness/index.mjs";
import { COPILOT_ENDPOINTS, copilotHeaders, initiator } from "../desktop/harness/copilot.mjs";
import { CONTINUE, OpenCodeRelay, RELAY_AGENT, completion, relayNames, transcript, usageOf } from "../desktop/harness/opencode.mjs";
import { CopilotRelay, LENT_FOR_MS, LENT_HEADERS, copilotApi } from "../desktop/providers/copilot/relay.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { KEYED_IDS } from "../desktop/providers/keyed/config.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-harness-providers-"));
after(() => rmSync(root, { recursive: true, force: true }));
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Which program runs a turn: every harness × every provider ----

/** A stand-in Copilot relay: the API each model speaks, and the headers it lends. */
function fakeRelay({ apis = new Map(), lent = { url: "http://127.0.0.1:9/responses", headers: { authorization: "Bearer gho_secret" }, at: Date.now() } } = {}) {
  const relay = { asked: [], endpointList: null, forgot: 0, lent };
  relay.endpoints = async (model) => (relay.asked.push(model), (relay.endpointList = { map: apis, at: Date.now() }), apis);
  relay.credentials = async (_model, { fresh } = {}) => (fresh ? (relay.lent = { ...relay.lent, at: Date.now(), fresh: true }) : relay.lent);
  relay.forget = () => void relay.forgot++;
  return relay;
}
const IDS = ["copilot", "codex", "claude", "opencode", ...KEYED_IDS, "pi", "omp", "grok"];
function registry({ ids = IDS, relay = fakeRelay(), models = async () => [] } = {}) {
  const byId = new Map(ids.map((id) => [id, id === "copilot" && relay ? { id, relay: () => relay } : { id }]));
  return { byId, for: (selection) => byId.get(selection.provider), models };
}
const standIn = () => ({ secret: "s", started: 0, start: async function () { this.started++; return "http://127.0.0.1:1"; }, stop: () => {} });
const harness = (providers, choice, gateway = standIn()) => new Harness({ providers, choice: () => choice, dir: root, bridge: null, gateway });

// What runs each selection, by harness: the via() route (null: the model's own provider runs it).
const MATRIX = {
  pi: { codex: "pi", claude: "pi", copilot: "pi", "copilot:auto": null, opencode: "pi", openrouter: "pi", foundry: "pi", "openai-api": "pi", grok: null },
  omp: { codex: "omp", claude: "omp", copilot: "omp", "copilot:auto": null, opencode: "omp", openrouter: "omp", foundry: "omp", "openai-api": "omp", grok: null },
  copilot: { codex: "copilot", claude: "copilot", copilot: null, "copilot:auto": null, opencode: "copilot", openrouter: "copilot", foundry: "copilot", "openai-api": "copilot", grok: null },
  // Each provider's own program; the key providers have none, so Pi runs theirs.
  provider: { codex: null, claude: null, copilot: null, "copilot:auto": null, opencode: null, openrouter: "pi", foundry: "pi", "openai-api": "pi", grok: null },
};
const selectionOf = (key) => {
  const [provider, model = "m"] = key.split(":");
  return { provider, model };
};

test("every harness and every provider: the route of a turn and the program that runs it", () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...HARNESSES].sort());
  const providers = registry();
  for (const [choice, row] of Object.entries(MATRIX)) {
    const one = harness(providers, choice);
    for (const [key, route] of Object.entries(row)) {
      const selection = selectionOf(key);
      assert.equal(one.via(selection), route, choice + " × " + key);
      const runner = route === "copilot" ? "copilot" : route ?? selection.provider;
      assert.equal(one.runner(selection), providers.byId.get(runner), choice + " × " + key + " runs on " + runner);
      assert.equal(one.hosts(selection), route === "copilot", choice + " × " + key + " hosted");
    }
  }
});

test("Copilot's models stay on its runtime under Pi when that runtime can't lend its sign-in, and when Pi isn't here", () => {
  const silent = registry({ relay: null });
  assert.equal(harness(silent, "pi").via({ provider: "copilot", model: "gpt-5" }), null);
  assert.equal(harness(silent, "omp").runner({ provider: "copilot", model: "gpt-5" }), silent.byId.get("copilot"));
  const noPi = registry({ ids: ["copilot", "opencode", "codex"] });
  for (const provider of ["copilot", "opencode", "codex"]) assert.equal(harness(noPi, "pi").via({ provider, model: "m" }), null, provider);
});

// ---- What each harness is told ----

const CATALOG = [
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "codex", efforts: ["low", "high"] },
  { id: "opus", name: "Claude Opus 5.5", provider: "claude" },
  { id: "auto", name: "Auto", provider: "copilot" },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "copilot", efforts: ["low", "medium", "high"], contextWindow: 200000, maxOutput: 32000, vision: true },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "copilot", efforts: ["low", "high"] },
  { id: "gemini-4-neon", name: "Gemini 4 Neon", provider: "copilot", vision: true },
  { id: "grok-4.7", name: "Grok 4.7", provider: "copilot" },
  { id: "gpt-5-off", name: "Off", provider: "copilot", available: false },
  { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", provider: "opencode", efforts: ["low", "high"], contextWindow: 1000000, maxOutput: 64000, vision: true },
  { id: "opencode/big-pickle", name: "Big Pickle", provider: "opencode", vision: false },
];

test("Pi is given a gateway connection for Copilot's models by the API each speaks, and one for OpenCode's", async () => {
  // GitHub lists grok on Chat Completions here, against what its name would say.
  const relay = fakeRelay({ apis: new Map([["grok-4.7", "completions"]]) });
  const providers = registry({ relay, models: async () => CATALOG });
  const out = await harness(providers, "pi").session({ provider: "copilot", model: "claude-sonnet-5.5", reasoningEffort: "high" }, "pi");
  assert.deepEqual(out.model, { model: "claude-sonnet-5.5", source: COPILOT_CONNECTIONS.messages.name, reasoningEffort: "high" });
  assert.deepEqual(relay.asked, ["claude-sonnet-5.5"], "GitHub's list is read for a Copilot model's chat");
  const byName = new Map(out.inference.providers.map((provider) => [provider.name, provider.config]));
  assert.deepEqual([...byName.keys()], ["botkins-chatgpt", "botkins-claude", "botkins-opencode", "botkins-copilot-claude", "botkins-copilot", "botkins-copilot-chat"]);
  const ids = (name) => byName.get(name).models.map((model) => model.id);
  assert.deepEqual(ids("botkins-copilot-claude"), ["claude-sonnet-5.5"]);
  assert.deepEqual(ids("botkins-copilot"), ["gpt-6-sol"]);
  assert.deepEqual(ids("botkins-copilot-chat"), ["gemini-4-neon", "grok-4.7"], "Auto and an unavailable model aren't offered");
  for (const [name, api, authHeader] of [["botkins-copilot-claude", "anthropic-messages", undefined], ["botkins-copilot", "openai-responses", true], ["botkins-copilot-chat", "openai-completions", true]])
    assert.deepEqual({ ...byName.get(name), models: undefined, name: undefined }, { baseUrl: "http://127.0.0.1:1/copilot", api, apiKey: "s", ...(authHeader && { authHeader }), models: undefined, name: undefined }, name);
  // Only the gateway's secret: no sign-in of Copilot's reaches Pi.
  assert.doesNotMatch(JSON.stringify(out), /gho_secret/);
  assert.deepEqual(byName.get("botkins-copilot-claude").models[0], piModel(CATALOG[3]));
  assert.deepEqual({ ...byName.get("botkins-opencode"), models: undefined }, { name: "OpenCode", baseUrl: "http://127.0.0.1:1/opencode", api: "openai-completions", apiKey: "s", authHeader: true, models: undefined });
  const [flash, pickle] = byName.get("botkins-opencode").models;
  assert.deepEqual([flash.id, flash.reasoning, flash.input, flash.contextWindow, flash.maxTokens, flash.compat], ["google/gemini-3.5-flash-lite", true, ["text", "image"], 1000000, 64000, PI_PLANS.opencode.compat]);
  assert.deepEqual([pickle.reasoning, pickle.input], [false, ["text"]]);
});

test("a chat on another provider's model under Pi reads no Copilot list, and its models go by their names", async () => {
  const relay = fakeRelay();
  const out = await harness(registry({ relay, models: async () => CATALOG }), "omp").session({ provider: "opencode", model: "google/gemini-3.5-flash-lite", reasoningEffort: "low" }, "omp");
  assert.deepEqual(out.model, { model: "google/gemini-3.5-flash-lite", source: "botkins-opencode", reasoningEffort: "low" });
  assert.deepEqual(relay.asked, [], "no Copilot runtime is started for an OpenCode chat");
  const byName = new Map(out.inference.providers.map((provider) => [provider.name, provider.config.models.map((model) => model.id)]));
  assert.deepEqual(byName.get("botkins-copilot-claude"), ["claude-sonnet-5.5"]);
  assert.deepEqual(byName.get("botkins-copilot"), ["gpt-6-sol", "grok-4.7"]);
  assert.deepEqual(byName.get("botkins-copilot-chat"), ["gemini-4-neon"]);
});

test("switching models in one Pi chat: every provider's model is named on a connection Pi was given", async () => {
  const one = harness(registry({ models: async () => CATALOG }), "pi");
  const opened = await one.session({ provider: "codex", model: "gpt-6-astra" }, "pi");
  const names = new Set(opened.inference.providers.map((provider) => provider.name));
  for (const selection of [
    { provider: "copilot", model: "claude-sonnet-5.5" },
    { provider: "copilot", model: "gpt-6-sol" },
    { provider: "copilot", model: "gemini-4-neon" },
    { provider: "opencode", model: "opencode/big-pickle" },
    { provider: "claude", model: "opus" },
  ]) {
    const { model } = await one.session(selection, "pi");
    assert.ok(names.has(model.source), selection.model + " is on " + model.source);
    const connection = opened.inference.providers.find((provider) => provider.name === model.source);
    assert.ok(connection.config.models.some((entry) => entry.id === selection.model), selection.model + " is listed on its connection");
  }
});

test("the Copilot runtime is given OpenCode as an OpenAI connection, and no speed on it", async () => {
  const one = harness(registry({ models: async () => CATALOG }), "copilot");
  const out = await one.session({ provider: "opencode", model: "google/gemini-3.5-flash-lite", fastMode: "fast" });
  assert.deepEqual(out.model, { model: "google/gemini-3.5-flash-lite", source: "opencode" });
  const connections = new Map(out.inference.providers.map((provider) => [provider.name, provider]));
  assert.deepEqual(connections.get("opencode"), { name: "opencode", type: "openai", wireApi: "completions", baseUrl: "http://127.0.0.1:1/opencode", bearerToken: "s" });
  assert.equal(connections.get("chatgpt").baseUrl, "http://127.0.0.1:1/chatgpt/fast", "a plan with speeds keeps its speed");
  const flash = out.inference.models.find((model) => model.id === "google/gemini-3.5-flash-lite");
  assert.deepEqual(flash, { id: "google/gemini-3.5-flash-lite", provider: "opencode", name: "Gemini 3.5 Flash Lite", maxPromptTokens: 936000, maxContextWindowTokens: 1000000, maxOutputTokens: 64000, capabilities: { supports: { vision: true, reasoningEffort: true } } });
  assert.ok(!out.inference.models.some((model) => model.provider === "copilot"), "Copilot's own models are the runtime's own");
  assert.deepEqual(PLANS.opencode, { name: "opencode", type: "openai", wireApi: "completions", path: "/opencode" });
});

test("copilotApi prefers Messages, then Responses, then Chat Completions, and else goes by the name", () => {
  assert.equal(copilotApi("x", ["/chat/completions", "/v1/messages"]), "messages");
  assert.equal(copilotApi("x", ["/chat/completions", "/responses"]), "responses");
  assert.equal(copilotApi("x", ["/responses", "ws:/responses"]), "responses");
  assert.equal(copilotApi("x", ["/chat/completions"]), "completions");
  assert.equal(copilotApi("claude-haiku-5.5"), "messages");
  assert.equal(copilotApi("gemini-4-neon", []), "completions");
  assert.equal(copilotApi("gpt-6-sol", ["/v1/images/generations"]), "responses");
  assert.equal(copilotApi("grok-4.7"), "responses");
});

// ---- The Copilot relay: a runtime lends a request's headers and never sends it ----

/** A stand-in SDK: a client whose sessions make one model request through the request handler per send. */
function fakeSdk({ url = "https://api.example.githubcopilot.com/responses", transport = "http", failWith, headers = {} } = {}) {
  const record = { started: 0, sessions: 0, sent: 0, answers: [], stopped: 0, disconnected: 0 };
  class Handler {
    async sendRequest() {
      record.passed = (record.passed ?? 0) + 1;
      return new Response("passed");
    }
    async openWebSocket() {
      return null;
    }
  }
  class WebSocketHandler {
    constructor(context) {
      this.context = context;
    }
    async close(status) {
      this.closedWith = status;
      record.wsClosed = status;
    }
  }
  class CloseStatus {
    constructor(description, errorCode, error) {
      Object.assign(this, { description, errorCode, error });
    }
  }
  const start = async (handler) => {
    record.started++;
    return {
      stop: async () => void record.stopped++,
      deleteSession: async () => {},
      createSession: async (options) => {
        record.sessions++;
        record.options = options;
        const sessionId = "relay-" + record.sessions;
        const listeners = new Set();
        return {
          sessionId,
          on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
          disconnect: async () => void record.disconnected++,
          send: async () => {
            record.sent++;
            setImmediate(async () => {
              if (failWith) return listeners.forEach((fn) => fn({ type: "session.error", data: { message: failWith, statusCode: 401 } }));
              const ctx = { sessionId, url, transport, headers: { authorization: ["Bearer gho_" + record.sent], "copilot-integration-id": ["copilot-sdk"], "editor-version": ["copilot/1"], "x-initiator": ["user"], "x-agent-task-id": ["task"], "anthropic-beta": ["b"], ...headers } };
              if (transport === "websocket") return record.answers.push(await handler.openWebSocket(ctx));
              const answer = await handler.sendRequest(new Request(url, { method: "POST", body: "{}" }), ctx);
              record.answers.push({ status: answer.status, body: await answer.text() });
            });
            return "message-" + record.sent;
          },
        };
      },
    };
  };
  return { record, Handler, WebSocketHandler, CloseStatus, start };
}

test("the relay borrows a request's sign-in headers, answers the runtime itself, and sends nothing on", async () => {
  const sdk = fakeSdk();
  let now = 1_000_000;
  const relay = new CopilotRelay({ ...sdk, now: () => now });
  const lent = await relay.credentials("gpt-6-sol");
  await tick(5);
  assert.equal(lent.url, "https://api.example.githubcopilot.com/responses");
  assert.deepEqual(lent.headers, { authorization: "Bearer gho_1", "copilot-integration-id": "copilot-sdk", "editor-version": "copilot/1" }, "only the headers that say who asks");
  assert.ok(Object.keys(lent.headers).every((name) => LENT_HEADERS.includes(name)));
  assert.equal(sdk.record.answers[0].status, 400, "the runtime's request was answered here");
  assert.match(sdk.record.answers[0].body, /not sent/);
  assert.equal(sdk.record.passed, undefined, "nothing went on to GitHub");
  assert.deepEqual(sdk.record.options.tools, { availableTools: [] }, "the lending session has no tools");
  assert.equal(sdk.record.options.model, "gpt-6-sol");
  // Kept for a while, then borrowed again on the same session; `fresh` borrows at once.
  assert.equal(await relay.credentials("gpt-6-sol"), lent);
  now += LENT_FOR_MS + 1;
  assert.equal((await relay.credentials("claude")).headers.authorization, "Bearer gho_2");
  assert.equal((await relay.credentials("claude", { fresh: true })).headers.authorization, "Bearer gho_3");
  assert.deepEqual([sdk.record.started, sdk.record.sessions], [1, 1], "one runtime, one session lends them all");
  // Two at once share one borrow.
  now += LENT_FOR_MS + 1;
  const [a, b] = await Promise.all([relay.credentials("m"), relay.credentials("m")]);
  assert.equal(a, b);
  await relay.stop();
  assert.equal(sdk.record.stopped, 1);
});

test("a runtime that can't sign the request says why, and its session is not used again", async () => {
  const sdk = fakeSdk({ failWith: "Not signed in to GitHub Copilot." });
  const relay = new CopilotRelay(sdk);
  await assert.rejects(relay.credentials("gpt-6-sol"), (error) => error.message === "Not signed in to GitHub Copilot." && error.status === 401);
  await assert.rejects(relay.credentials("gpt-6-sol"));
  assert.equal(sdk.record.sessions, 2, "a failed session is replaced");
});

test("a request the runtime would send over a WebSocket lends its headers too, and the socket is closed unopened", async () => {
  const sdk = fakeSdk({ url: "wss://api.example.githubcopilot.com/responses", transport: "websocket" });
  const lent = await new CopilotRelay(sdk).credentials("gpt-6-sol");
  assert.equal(lent.url, "https://api.example.githubcopilot.com/responses");
  await tick(5);
  assert.equal(sdk.record.wsClosed.errorCode, "botkins_relay");
});

test("the relay reads which API each model speaks from GitHub's own list, with the lent headers", async () => {
  const sdk = fakeSdk();
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([String(url), init.headers.authorization]);
    return Response.json({ data: [{ id: "claude-x", supported_endpoints: ["/chat/completions", "/v1/messages"] }, { id: "gem", supported_endpoints: ["/chat/completions"] }, { id: "gpt", supported_endpoints: ["/responses", "ws:/responses"] }] });
  };
  const relay = new CopilotRelay({ ...sdk, fetch });
  const map = await relay.endpoints("gpt");
  assert.deepEqual([...map], [["claude-x", "messages"], ["gem", "completions"], ["gpt", "responses"]]);
  assert.deepEqual(asked, [["https://api.example.githubcopilot.com/models", "Bearer gho_1"]]);
  assert.equal(await relay.endpoints("gpt"), map, "kept a while");
  const broken = new CopilotRelay({ ...fakeSdk(), fetch: async () => new Response("no", { status: 500 }) });
  assert.deepEqual([...(await broken.endpoints("gpt"))], [], "an unreadable list is an empty one");
});

// ---- The gateway's /copilot route ----

const post = (base, path, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + headers.secret, ...headers.extra } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });

test("who started a request: the person's turn, or the agent going on from a tool's result", () => {
  assert.equal(initiator("completions", { messages: [{ role: "user", content: "hi" }] }), "user");
  assert.equal(initiator("completions", { messages: [{ role: "user", content: "hi" }, { role: "assistant", tool_calls: [] }, { role: "tool", content: "x" }] }), "agent");
  assert.equal(initiator("responses", { input: [{ role: "user", content: "hi" }] }), "user");
  assert.equal(initiator("responses", { input: [{ type: "function_call", call_id: "c" }, { type: "function_call_output", call_id: "c", output: "x" }] }), "agent");
  assert.equal(initiator("messages", { messages: [{ role: "user", content: "hi" }] }), "user");
  assert.equal(initiator("messages", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }] }), "agent");
  assert.deepEqual(Object.keys(COPILOT_ENDPOINTS), ["chat/completions", "responses", "v1/messages"]);
});

test("a Copilot request carries the lent headers, its API's own, who started it, and never the harness's secret", () => {
  const lent = { headers: { authorization: "Bearer gho_x", "editor-version": "copilot/1" } };
  const headers = copilotHeaders(lent, "messages", { messages: [{ role: "user", content: "hi" }] }, { accept: "text/event-stream", "anthropic-beta": "fine-grained", "x-api-key": "secret", authorization: "Bearer secret" });
  assert.equal(headers.authorization, "Bearer gho_x");
  assert.equal(headers["anthropic-beta"], "fine-grained");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-initiator"], "user");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["x-api-key"], undefined);
  const chat = copilotHeaders(lent, "completions", { messages: [{ role: "tool", content: "x" }] });
  assert.deepEqual([chat["x-initiator"], chat["x-interaction-type"], chat["anthropic-version"]], ["agent", "conversation-agent", undefined]);
});

/** A gateway with a stand-in Copilot relay, and an upstream that records each request. */
async function copilotGateway(t, { answer, relay = fakeRelay({ lent: { url: "https://api.example.githubcopilot.com/responses", headers: { authorization: "Bearer gho_secret", "editor-version": "copilot/1" }, at: Date.now() - 5000 } }) } = {}) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: init.body, signal: init.signal });
    return answer(seen.length, init);
  };
  const gateway = new Gateway({ copilot: () => relay, fetch, waiting: 0 });
  t.after(() => gateway.stop());
  const base = await gateway.start();
  return { base, gateway, seen, relay, ask: (path, body, extra) => post(base, path, body, { secret: gateway.secret, extra }) };
}
const sse = (events) => new Response(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

test("the gateway streams Copilot's answer as it is, from the endpoint the harness asked for", async (t) => {
  const { ask, seen } = await copilotGateway(t, { answer: () => sse([{ choices: [{ delta: { content: "pong" } }] }]) });
  const body = { model: "gemini-4-neon", stream: true, messages: [{ role: "user", content: "ping" }] };
  const out = await ask("/copilot/chat/completions", body);
  assert.equal(out.status, 200);
  assert.match(out.headers["content-type"], /event-stream/);
  assert.match(out.text, /"pong"[\s\S]*\[DONE\]/);
  assert.equal(seen[0].url, "https://api.example.githubcopilot.com/chat/completions");
  assert.equal(seen[0].body, JSON.stringify(body), "the request goes on as it was written");
  assert.equal(seen[0].headers.authorization, "Bearer gho_secret");
  assert.equal(seen[0].headers["x-initiator"], "user");
  for (const [path, upstream] of [["/copilot/responses", "/responses"], ["/copilot/v1/messages", "/v1/messages"]]) {
    await ask(path, { model: "m", messages: [{ role: "user", content: "x" }] });
    assert.equal(seen.at(-1).url, "https://api.example.githubcopilot.com" + upstream);
  }
});

test("the gateway drops tool-schema formats Copilot refuses, such as Home Assistant's lower and strip", async (t) => {
  const { ask, seen } = await copilotGateway(t, { answer: () => sse([]) });
  const level = { type: "string", enum: ["debug", "info"], format: "lower", description: "Minimum log level." };
  const tool = (parameters) => ({ type: "function", name: "mcp__Home_Assistant__hassio__get_logs", strict: false, parameters });
  const body = {
    model: "gpt-6.2-sol",
    input: [],
    tools: [
      tool({ type: "object", properties: { level, domain: { anyOf: [{ type: "string", format: "strip" }, { type: "array", items: { type: "string", format: "strip" } }] }, since: { type: "string", format: "date-time" }, format: { type: "string", enum: ["format"] } } }),
      { type: "function", name: "plain", parameters: { type: "object", properties: {} } },
    ],
  };
  await ask("/copilot/responses", body);
  const sent = JSON.parse(seen[0].body);
  const props = sent.tools[0].parameters.properties;
  assert.deepEqual(props.level, { type: "string", enum: ["debug", "info"], description: "Minimum log level." }, "the enum still checks the value");
  assert.deepEqual(props.domain.anyOf, [{ type: "string" }, { type: "array", items: { type: "string" } }]);
  assert.equal(props.since.format, "date-time", "a format Copilot knows stays");
  assert.deepEqual(props.format, { type: "string", enum: ["format"] }, "a property named format is a schema, not the keyword");
  assert.deepEqual(sent.tools[1], body.tools[1]);
  const chat = { model: "m", messages: [], tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: { level } } } }] };
  await ask("/copilot/chat/completions", chat);
  assert.equal(JSON.parse(seen[1].body).tools[0].function.parameters.properties.level.format, undefined);
  const messages = { model: "m", messages: [], tools: [{ name: "f", input_schema: { type: "object", properties: { level } } }] };
  await ask("/copilot/v1/messages", messages);
  assert.equal(JSON.parse(seen[2].body).tools[0].input_schema.properties.level.format, undefined);
  const clean = { model: "m", input: [], tools: [body.tools[1]] };
  await ask("/copilot/responses", clean);
  assert.equal(seen[3].body, JSON.stringify(clean), "a request with nothing to drop goes on as it was written");
});

test("Copilot's refusal goes back with its status, and with the sign-in hidden should it appear", async (t) => {
  const { ask } = await copilotGateway(t, { answer: () => new Response(JSON.stringify({ error: { message: "quota: Bearer gho_secret has none left", code: "quota_exceeded" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } }) });
  const out = await ask("/copilot/chat/completions", { model: "m", messages: [] });
  assert.equal(out.status, 429);
  assert.equal(out.headers["retry-after"], "30");
  assert.doesNotMatch(out.text, /gho_secret/);
  assert.match(out.text, /\[key\]/);
});

test("headers GitHub turns down are borrowed again once, and the request sent again", async (t) => {
  const { ask, seen, relay } = await copilotGateway(t, { answer: (n) => (n === 1 ? new Response("expired", { status: 401 }) : sse([{ choices: [{ delta: { content: "ok" } }] }])) });
  const out = await ask("/copilot/chat/completions", { model: "m", messages: [{ role: "user", content: "x" }] });
  assert.equal(out.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(relay.forgot, 1);
  const again = await copilotGateway(t, { answer: () => new Response("no", { status: 401 }) });
  assert.equal((await again.ask("/copilot/chat/completions", { model: "m", messages: [] })).status, 401);
  assert.equal(again.seen.length, 2, "once, not again and again");
});

test("the /copilot route turns away a request without the secret, with an origin, to an unknown path, or with no Copilot", async (t) => {
  const { base, gateway, seen, ask } = await copilotGateway(t, { answer: () => sse([]) });
  assert.equal((await post(base, "/copilot/chat/completions", {}, { secret: "wrong" })).status, 401);
  assert.equal((await post(base, "/copilot/chat/completions", {}, { secret: gateway.secret, extra: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await ask("/copilot/v1/embeddings", {})).status, 404);
  const anthropic = JSON.parse((await post(base, "/copilot/v1/messages", {}, { secret: "wrong" })).text);
  assert.equal(anthropic.type, "error", "the Messages route answers as Anthropic's would");
  assert.equal(seen.length, 0, "nothing reached GitHub");
  const none = new Gateway({ waiting: 0 });
  t.after(() => none.stop());
  const out = await post(await none.start(), "/copilot/responses", { model: "m" }, { secret: none.secret });
  assert.equal(out.status, 503);
  assert.match(out.text, /GitHub Copilot isn't set up/);
});

test("a relay that can't sign says why as an authentication error", async (t) => {
  const relay = { credentials: async () => Promise.reject(Object.assign(new Error("Not signed in."), { status: 401 })), forget() {} };
  const { ask, seen } = await copilotGateway(t, { relay, answer: () => sse([]) });
  const out = await ask("/copilot/chat/completions", { model: "m", messages: [] });
  assert.equal(out.status, 401);
  assert.match(out.text, /couldn't sign the request: Not signed in/);
  assert.equal(seen.length, 0);
});

test("the harness hanging up stops the request to Copilot", async (t) => {
  let aborted = null;
  const { base, gateway } = await copilotGateway(t, {
    answer: (_n, init) =>
      new Promise((resolve) => {
        init.signal.addEventListener("abort", () => (aborted = true));
        const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("data: {}\n\n")) });
        resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      }),
  });
  await new Promise((resolve) => {
    const req = request(base + "/copilot/chat/completions", { method: "POST", headers: { authorization: "Bearer " + gateway.secret } }, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve();
      });
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ model: "m", messages: [] }));
  });
  for (let i = 0; i < 50 && !aborted; i++) await tick(10);
  assert.equal(aborted, true);
});

// ---- OpenCode: a Chat Completions request as one step of an OpenCode session ----

const PNG = "iVBORw0KGgo=";
const CONVERSATION = {
  model: "google/gemini-3.5-flash-lite",
  messages: [
    { role: "system", content: "You are Pi." },
    { role: "user", content: [{ type: "text", text: "Look at this and add 2 and 3." }, { type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }] },
    { role: "assistant", content: "Adding.", tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }, { id: "call_2", type: "function", function: { name: "read", arguments: "{bad" } }] },
    { role: "tool", tool_call_id: "call_1", content: "5" },
    { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "a picture:" }, { type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }] },
    { role: "developer", content: [{ type: "text", text: "Be brief." }] },
  ],
};

test("relayNames name a tool as OpenCode lists a tool server's, shorten a long one, and find each again", () => {
  const long = "x".repeat(80);
  const names = relayNames("babc123", ["read", long]);
  assert.equal(names.native("read"), "babc123_read");
  assert.equal(names.original("babc123_read"), "read");
  assert.equal(names.original("read"), "read", "a model that drops the server's name is taken at its word");
  assert.ok(names.native(long).length <= 64);
  assert.equal(names.original(names.native(long)), long);
  const pair = relayNames("b", ["a".repeat(70) + "1", "a".repeat(70) + "2"]);
  assert.notEqual(pair.native("a".repeat(70) + "1"), pair.native("a".repeat(70) + "2"), "two long names with one start stay apart");
});

test("transcript turns the conversation into OpenCode's import: system, pictures, tool calls and their results", () => {
  const names = relayNames("babc123", ["add", "read"]);
  const natives = new Map([["call_1", { thoughtSignature: "sig" }]]);
  const { system, messages, prompt } = transcript(CONVERSATION, names, { model: { providerID: "google", id: "gemini-3.5-flash-lite" }, now: 10_000, natives });
  assert.equal(system, "You are Pi.\n\nBe brief.");
  assert.deepEqual(prompt, { text: CONTINUE }, "a conversation that goes on from tool results asks to go on");
  assert.deepEqual(messages.map((m) => m.type), ["user", "assistant"]);
  const [user, assistant] = messages;
  assert.match(user.id, /^msg_/);
  assert.equal(user.text, "Look at this and add 2 and 3.");
  assert.deepEqual(user.files, [{ mime: "image/png", data: PNG, source: { type: "inline" } }]);
  assert.equal(assistant.agent, RELAY_AGENT);
  assert.equal(assistant.finish, "tool-calls");
  assert.ok(assistant.time.created > user.time.created, "turns keep their order");
  const [text, add, read] = assistant.content;
  assert.deepEqual(text, { type: "text", text: "Adding." });
  assert.deepEqual([add.name, add.executed, add.native, add.state], ["babc123_add", false, { thoughtSignature: "sig" }, { status: "completed", input: { a: 2, b: 3 }, content: [{ type: "text", text: "5" }] }]);
  assert.deepEqual(read.state.input, { arguments: "{bad" }, "badly written arguments are kept as they were said");
  assert.deepEqual(read.state.content, [{ type: "text", text: "a picture:" }, { type: "file", uri: "data:image/png;base64," + PNG, mime: "image/png" }]);
});

test("the person's last turn is the prompt, a call with no result is an error, and no turn at all is refused", () => {
  const names = relayNames("b1", ["add"]);
  const out = transcript({ messages: [{ role: "user", content: "add" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "add", arguments: "{}" } }] }, { role: "user", content: [{ type: "text", text: "never mind" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + PNG } }] }] }, names);
  assert.deepEqual(out.prompt, { text: "never mind", files: [{ uri: "data:image/jpeg;base64," + PNG, name: "picture-1" }] });
  assert.equal(out.messages[1].content[0].state.status, "error");
  assert.throws(() => transcript({ messages: [{ role: "system", content: "x" }] }, names), /at least one turn/);
});

test("completion puts a stream's chunks together, and usageOf reads OpenCode's tokens", () => {
  const whole = completion();
  whole.take({ id: "c1", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] });
  whole.take({ id: "c1", choices: [{ index: 0, delta: { content: "lo", reasoning_content: "hmm" } }] });
  whole.take({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t", type: "function", function: { name: "add", arguments: '{"a"' } }] } }] });
  whole.take({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] });
  whole.take({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  whole.take({ id: "c1", choices: [], usage: { prompt_tokens: 3 } });
  assert.deepEqual(whole.message(), { id: "c1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Hello", reasoning_content: "hmm", tool_calls: [{ id: "t", type: "function", function: { name: "add", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3 } });
  assert.deepEqual(usageOf({ input: 10, output: 5, reasoning: 2, cache: { read: 4, write: 1 } }), { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } });
});

/**
 * A stand-in OpenCode provider: its server's API as the relay calls it, and its event stream.
 * `script(ctx)` answers each prompt with [type, data] events; `ctx.emit` sends one later.
 */
function fakeOpenCode(script, { efforts = { "google/gemini-3.5-flash-lite": ["low", "high"] } } = {}) {
  const log = { calls: [], imports: [], prompts: [], interrupts: [], deleted: [], mcp: [], instructions: [] };
  const open = new Map();
  const emit = (sessionID, type, data = {}) => open.get(sessionID)?.received({ type, data: { sessionID, ...data } });
  const api = {
    get: async (path) => (log.calls.push(["GET", path]), { data: [] }),
    put: async (path, body, location) => {
      log.calls.push(["PUT", path]);
      if (path.startsWith("/api/experimental/mcp/")) log.mcp.push({ name: path.split("/").pop(), body, location });
      if (path.includes("/instructions/entries/")) log.instructions.push(body.value);
      return { data: {} };
    },
    patch: async () => ({ data: {} }),
    delete: async (path) => (log.calls.push(["DELETE", path]), log.deleted.push(path), { data: {} }),
    post: async (path, body) => {
      log.calls.push(["POST", path]);
      if (path === "/api/session") return { data: { id: "ses_probe", projectID: "proj_1" } };
      if (path === "/api/experimental/session/import") return (log.imports.push(body), { data: body.info });
      const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
      if (prompt) {
        const sessionID = prompt[1];
        log.prompts.push(body);
        const imported = log.imports.findLast((each) => each.info.id === sessionID);
        setImmediate(async () => {
          for (const event of script({ sessionID, prompt: body, imported, server: log.mcp.at(-1)?.name, emit: (type, data) => emit(sessionID, type, data) }) ?? []) {
            await tick(1);
            emit(sessionID, ...event);
          }
        });
        return { data: { id: "msg_prompt" } };
      }
      const interrupt = /^\/api\/session\/([^/]+)\/interrupt$/.exec(path);
      if (interrupt) {
        log.interrupts.push(interrupt[1]);
        setImmediate(() => log.onInterrupt?.(interrupt[1], (type, data) => emit(interrupt[1], type, data)));
      }
      return { data: {} };
    },
  };
  return {
    log,
    server: async () => api,
    serverIfRunning: async () => api,
    listen: async () => {},
    attach: (watcher) => open.set(watcher.sessionId, watcher),
    detach: (watcher) => open.delete(watcher.sessionId),
    models: async () => Object.entries(efforts).map(([id, list]) => ({ id, efforts: list })),
    open,
  };
}
const relayOf = (provider, name = "relay-" + Math.random().toString(36).slice(2)) => {
  const bridge = new ToolBridge();
  after(() => bridge.stop());
  return new OpenCodeRelay({ provider, bridge, dir: join(root, name) });
};
const TOOLS = [{ type: "function", function: { name: "add", description: "Adds", parameters: { type: "object", properties: { a: { type: "number" } } } } }];
const step = (extra = {}) => ({ assistantMessageID: "m1", ...extra });

test("an OpenCode text reply streams back as Chat Completions chunks, with its usage", async () => {
  const provider = fakeOpenCode(() => [
    ["session.step.started", step()],
    ["session.reasoning.delta", step({ delta: "thinking", ordinal: 0 })],
    ["session.text.started", step()],
    ["session.text.delta", step({ delta: "Hel" })],
    ["session.text.delta", step({ delta: "lo" })],
    ["session.text.ended", step({ text: "Hello" })],
    ["session.step.ended", step({ finish: "stop", tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } })],
    ["session.execution.succeeded", {}],
  ]);
  const relay = relayOf(provider);
  const chunks = [];
  await relay.turn({ model: "google/gemini-3.5-flash-lite", reasoning_effort: "medium", messages: [{ role: "system", content: "Be Pi." }, { role: "user", content: "hi" }] }, { emit: (c) => chunks.push(c) });
  const deltas = chunks.flatMap((c) => c.choices.map((choice) => choice.delta));
  assert.deepEqual(deltas, [{ role: "assistant", reasoning_content: "thinking" }, { content: "Hel" }, { content: "lo" }, {}]);
  assert.equal(chunks.at(-2).choices[0].finish_reason, "stop");
  assert.deepEqual(chunks.at(-1).usage, usageOf({ input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } }));
  const [imported] = provider.log.imports;
  assert.equal(imported.info.agent, RELAY_AGENT);
  assert.deepEqual(imported.info.model, { providerID: "google", id: "gemini-3.5-flash-lite", variant: "low" }, "the nearest thinking level OpenCode has");
  assert.deepEqual(imported.info.permissions[0], { action: "*", resource: "*", effect: "deny" }, "OpenCode's own tools are closed to it");
  assert.equal(imported.info.projectID, "proj_1");
  assert.deepEqual(imported.messages, [], "the only turn is the prompt");
  assert.deepEqual(provider.log.prompts, [{ text: "hi" }]);
  assert.deepEqual(provider.log.instructions, ["Be Pi."]);
  assert.deepEqual(provider.log.interrupts, [], "a step that ended by itself isn't stopped");
  assert.deepEqual(provider.log.mcp, [], "no tools, no tool server");
  await tick(10);
  assert.ok(provider.log.deleted.includes("/api/session/" + imported.info.id), "the session is removed");
  assert.equal(provider.open.size, 0);
  const config = JSON.parse(readFileSync(join(relay.dir, "opencode.json"), "utf8"));
  assert.equal(config.agent[RELAY_AGENT].mode, "primary");
});

test("an OpenCode tool call comes back whole, OpenCode is stopped before it runs the tool, and the call is let go after", async () => {
  let toolCalled = null;
  const provider = fakeOpenCode(({ server, emit }) => {
    // OpenCode calls the tool server as the model writes the call; that call must wait.
    toolCalled = fetch(provider.relayServerUrl, { method: "POST", headers: provider.relayServerHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { a: 1 } } }) }).then((r) => r.json());
    void emit;
    return [
      ["session.step.started", step()],
      ["session.tool.input.started", step({ id: "call_9", name: server + "_add" })],
      ["session.tool.called", step({ id: "call_9", input: { a: 1 }, native: { thoughtSignature: "s9" } })],
      ["session.step.streamed", step()],
    ];
  });
  provider.log.onInterrupt = (_id, emit) => {
    emit("session.tool.failed", step({ id: "call_9", error: { type: "aborted" } }));
    emit("session.step.failed", step({ error: { type: "aborted", message: "Step interrupted" }, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }));
    emit("session.execution.interrupted", { reason: "user" });
  };
  const relay = relayOf(provider);
  // The tool server's address, once the relay has registered it with OpenCode.
  const realOffer = relay.offer.bind(relay);
  relay.offer = async (...args) => {
    const release = await realOffer(...args);
    const server = relay.servers.get(args[2]);
    provider.relayServerUrl = server.endpoint.url;
    provider.relayServerHeaders = { ...server.endpoint.headers, "content-type": "application/json" };
    return release;
  };
  const chunks = [];
  await relay.turn({ model: "google/gemini-3.5-flash-lite", tools: TOOLS, messages: [{ role: "user", content: "add" }] }, { emit: (c) => chunks.push(c) });
  const calls = chunks.flatMap((c) => c.choices.flatMap((choice) => choice.delta.tool_calls ?? []));
  assert.deepEqual(calls, [{ index: 0, id: "call_9", type: "function", function: { name: "add", arguments: "" } }, { index: 0, function: { arguments: '{"a":1}' } }], "named as the harness knows it");
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
  assert.equal(chunks.at(-1).usage.prompt_tokens, 7, "the stopped step's usage");
  assert.equal(provider.log.interrupts.length, 1, "stopped before the tool ran");
  const [mcp] = provider.log.mcp;
  assert.equal(mcp.body.config.codemode, false);
  assert.equal(mcp.body.config.type, "remote");
  assert.match(provider.log.instructions[0], new RegExp("`" + mcp.name + "_add` for add"));
  assert.deepEqual(provider.log.imports[0].info.permissions[1], { action: mcp.name + "_*", resource: "*", effect: "allow" });
  // The waiting call is let go once the request is over, never run.
  const answer = await toolCalled;
  assert.match(answer.result.content[0].text, /wasn't run here/);
  // The model's signature for its call goes back with it next time, under the same tool server.
  provider.log.onInterrupt = null;
  const next = fakeOpenCode(() => [["session.step.started", step()], ["session.text.delta", step({ delta: "6" })], ["session.step.ended", step({ tokens: { input: 1, output: 1 } })]]);
  relay.provider = next;
  await relay.turn({ model: "google/gemini-3.5-flash-lite", tools: TOOLS, messages: [{ role: "user", content: "add" }, { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "add", arguments: '{"a":1}' } }] }, { role: "tool", tool_call_id: "call_9", content: "1" }] }, { emit: () => {} });
  const part = next.log.imports[0].messages[1].content[0];
  assert.deepEqual([part.name, part.native], [mcp.name + "_add", { thoughtSignature: "s9" }]);
  assert.deepEqual(next.log.prompts, [{ text: CONTINUE }]);
});

test("an OpenCode failure before the reply is an error with OpenCode's own status and words", async () => {
  const provider = fakeOpenCode(() => [["session.step.started", step()], ["session.step.failed", step({ error: { type: "provider.free-limit", message: "Free usage limit reached.", status: 429 } })]]);
  await assert.rejects(relayOf(provider).turn({ model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] }, { emit: () => {} }), (error) => error.status === 429 && error.type === "rate_limit_error" && error.message === "Free usage limit reached.");
  await assert.rejects(relayOf(provider).turn({ model: "no-slash", messages: [{ role: "user", content: "hi" }] }, { emit: () => {} }), /<service>\/<model>/);
});

test("a cancelled OpenCode request stops the session and removes it", async () => {
  const provider = fakeOpenCode(() => [["session.step.started", step()], ["session.text.delta", step({ delta: "long" })]]);
  const controller = new AbortController();
  const chunks = [];
  const turn = relayOf(provider).turn({ model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] }, { emit: (c) => (chunks.push(c), controller.abort()), signal: controller.signal });
  await assert.rejects(turn, (error) => error.status === 499);
  await tick(20);
  assert.equal(provider.log.interrupts.length, 1);
  assert.ok(provider.log.deleted.some((path) => path.startsWith("/api/session/ses_")));
});

test("two requests of one conversation at once never share a tool server", async () => {
  const provider = fakeOpenCode(() => [["session.step.started", step()], ["session.text.delta", step({ delta: "x" })], ["session.step.ended", step()]]);
  const relay = relayOf(provider);
  const body = { model: "opencode/big-pickle", tools: TOOLS, messages: [{ role: "user", content: "same" }] };
  await Promise.all([relay.turn(body, { emit: () => {} }), relay.turn(body, { emit: () => {} })]);
  const names = provider.log.mcp.map((each) => each.name);
  assert.equal(new Set(names).size, 2, names.join(", "));
  // The same conversation later uses its first tool server again, without registering it again.
  await relay.turn(body, { emit: () => {} });
  assert.equal(provider.log.mcp.length, 2);
});

test("the gateway's /opencode route streams chunks and [DONE], answers stream: false with one completion, and reports failures", async (t) => {
  let script = () => [["session.step.started", step()], ["session.text.delta", step({ delta: "pong" })], ["session.step.ended", step({ tokens: { input: 2, output: 1 } })]];
  const provider = fakeOpenCode((ctx) => script(ctx));
  const relay = relayOf(provider);
  const gateway = new Gateway({ opencode: () => relay, waiting: 0 });
  t.after(() => gateway.stop());
  const base = await gateway.start();
  const ask = (body, extra) => post(base, "/opencode/chat/completions", body, { secret: gateway.secret, extra });
  const streamed = await ask({ model: "opencode/big-pickle", messages: [{ role: "user", content: "ping" }] });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers["content-type"], /event-stream/);
  const events = streamed.text.split("\n\n").filter(Boolean).map((block) => block.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  assert.equal(JSON.parse(events[0]).choices[0].delta.content, "pong");
  const whole = JSON.parse((await ask({ model: "opencode/big-pickle", stream: false, messages: [{ role: "user", content: "ping" }] })).text);
  assert.deepEqual([whole.object, whole.choices[0].message.content, whole.choices[0].finish_reason, whole.usage.prompt_tokens], ["chat.completion", "pong", "stop", 2]);
  script = () => [["session.step.started", step()], ["session.execution.failed", { error: { message: "No such model.", status: 404 } }]];
  const failed = await ask({ model: "opencode/none", messages: [{ role: "user", content: "ping" }] });
  assert.equal(failed.status, 404);
  assert.deepEqual(JSON.parse(failed.text).error.message, "No such model.");
  script = () => [["session.step.started", step()], ["session.text.delta", step({ delta: "par" })], ["session.step.failed", step({ error: { message: "Overloaded.", status: 529 } })]];
  const broken = await ask({ model: "opencode/big-pickle", messages: [{ role: "user", content: "ping" }] });
  assert.equal(broken.status, 200);
  assert.match(broken.text, /"par"[\s\S]*"error":\{"message":"Overloaded\."/);
  assert.equal((await post(base, "/opencode/chat/completions", {}, { secret: "nope" })).status, 401);
  const none = new Gateway({ waiting: 0 });
  t.after(() => none.stop());
  assert.equal((await post(await none.start(), "/opencode/chat/completions", { model: "a/b" }, { secret: none.secret })).status, 503);
});

test("a model that thinks only adaptively tells Pi so, and the rest keep their connection's compat", () => {
  assert.deepEqual(piModel({ id: "claude-haiku-5.5", efforts: ["low"], adaptiveThinking: true }).compat, { forceAdaptiveThinking: true });
  assert.deepEqual(piModel({ id: "x", adaptiveThinking: true }, { supportsStore: false }).compat, { supportsStore: false, forceAdaptiveThinking: true });
  assert.equal(piModel({ id: "gemini" }).compat, undefined);
  assert.deepEqual(piModel({ id: "gemini" }, { supportsStore: false }).compat, { supportsStore: false });
});
