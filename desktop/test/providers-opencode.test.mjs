// The OpenCode provider (desktop/providers/opencode) against a stand-in for `opencode serve`:
// the model list, the model services and connecting them, a turn's requests and events,
// approvals, the per-session tool bridge and its rules, forking, and a chat through the workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Providers, defineTool } from "../desktop/providers/index.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { BRIDGE_PREFIX, OpenCodeProvider, sessionRules } from "../desktop/providers/opencode/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";

const PASSWORD = "test-password";

/**
 * A stand-in for the OpenCode server. `play(turn)` scripts one prompt: `turn.emit(type, data)`
 * sends an event for the session, `turn.say(text)` streams a reply, and the turn ends with
 * session.execution.succeeded unless `play` returns another event type.
 */
async function fakeOpenCode(t, play = async (turn) => turn.say("ok")) {
  const log = { requests: [], sessions: new Map(), mcp: new Map(), instructions: new Map(), replies: [], removed: [], keys: [], credentialsRemoved: [] };
  const state = {
    busyStarts: 0,
    models: [
      { id: "big-pickle", providerID: "opencode", name: "Big Pickle", variants: [], status: "active", enabled: true, capabilities: { tools: true, input: ["text"], output: ["text"] } },
      { id: "gemini-pro", providerID: "google", name: "Gemini Pro", variants: [{ id: "default" }, { id: "low" }, { id: "high" }], status: "active", enabled: true, capabilities: { tools: true, input: ["text"], output: ["text"] } },
      { id: "embed-1", providerID: "google", name: "Embedding", variants: [], status: "active", enabled: true, capabilities: { tools: false, input: ["text"], output: ["embedding"] } },
      { id: "painter", providerID: "google", name: "Painter", variants: [], status: "active", enabled: true, capabilities: { tools: true, input: ["text"], output: ["image"] } },
      { id: "old", providerID: "google", name: "Old", variants: [], status: "deprecated", enabled: true, capabilities: { tools: true, input: ["text"], output: ["text"] } },
      { id: "off", providerID: "google", name: "Off", variants: [], status: "active", enabled: false, capabilities: { tools: true, input: ["text"], output: ["text"] } },
    ],
    integrations: [
      { id: "zed", name: "Zed Models", methods: [{ type: "key" }], connections: [] },
      { id: "google", name: "Google", methods: [{ type: "key" }, { type: "env", names: ["GEMINI_API_KEY"] }], connections: [{ type: "env", name: "GEMINI_API_KEY" }] },
      { id: "openai", name: "OpenAI", methods: [{ type: "key" }, { type: "oauth", id: "chatgpt", label: "Sign in with ChatGPT" }, { type: "oauth", id: "device", label: "Device code" }], connections: [] },
      { id: "github-copilot", name: "GitHub Copilot", methods: [{ type: "oauth", id: "device", label: "Login with GitHub Copilot", form: [{ key: "deploymentType", required: true, type: "string", options: [{ value: "github.com", label: "GitHub.com" }, { value: "enterprise", label: "Enterprise" }] }, { key: "enterpriseUrl", when: [{ key: "deploymentType", op: "eq", value: "enterprise" }], type: "string" }] }], connections: [] },
      { id: "envonly", name: "Env Only", methods: [{ type: "env", names: ["X"] }], connections: [] },
    ],
    credentials: [],
    attempts: new Map(),
  };
  const streams = new Set();
  const emit = (type, data) => {
    for (const response of streams) response.write("data: " + JSON.stringify({ id: "evt", type, data }) + "\n\n");
  };
  let seq = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (request.headers.authorization !== "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")) return send(401, { _tag: "UnauthorizedError", message: "Authentication required" });
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = url.pathname;
    const location = url.searchParams.get("location[directory]");
    log.requests.push([request.method, path, body, location]);
    const match = (pattern) => new RegExp("^" + pattern + "$").exec(path);
    let m;
    if (path === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: " + JSON.stringify({ id: "evt", type: "server.connected", data: {} }) + "\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (path === "/api/info") return send(200, { version: "9.9.9" });
    if (path === "/api/model" && request.method === "GET") {
      // A server that has just started says "not ready" for a moment.
      if (state.busyStarts-- > 0) return send(503, { _tag: "ServiceUnavailableError", message: "Location plugins did not finish activating" });
      return send(200, { data: state.models });
    }
    if (path === "/api/model/default") return send(200, { data: state.models[0] });
    if (path === "/api/provider") return send(200, { data: [{ id: "opencode", name: "OpenCode" }, { id: "google", name: "Google" }] });
    if (path === "/api/agent") return send(200, { data: [{ id: "squad" }, { id: "build" }, { id: "plan" }] });
    if (path === "/api/integration") return send(200, { data: state.integrations });
    if ((m = match("/api/integration/([^/]+)")) && request.method === "GET") return send(200, { data: state.integrations.find((i) => i.id === m[1]) });
    if ((m = match("/api/integration/([^/]+)/connect/key"))) {
      log.keys.push([m[1], body.key]);
      state.integrations.find((i) => i.id === m[1]).connections.push({ type: "credential" });
      state.credentials.push({ id: "cred-" + m[1], integrationID: m[1] });
      return send(204);
    }
    if ((m = match("/api/integration/([^/]+)/connect/oauth")) && request.method === "POST") {
      const attemptID = "attempt-" + ++seq;
      const mode = body.methodID === "device" && m[1] === "openai" ? "code" : "auto";
      state.attempts.set(attemptID, { status: "pending", polls: 0, service: m[1], body });
      return send(200, { data: { attemptID, url: state.signInUrl ?? "https://auth.example/" + m[1], instructions: mode === "code" ? "Paste the code." : "", mode } });
    }
    if ((m = match("/api/integration/([^/]+)/connect/oauth/([^/]+)")) && request.method === "GET") {
      const attempt = state.attempts.get(m[2]);
      if (++attempt.polls >= 2 && attempt.status === "pending") attempt.status = state.oauthOutcome ?? "complete";
      return send(200, { data: { status: attempt.status, ...(attempt.status === "failed" && { message: "Access denied" }) } });
    }
    if ((m = match("/api/integration/([^/]+)/connect/oauth/([^/]+)")) && request.method === "DELETE") return (state.attempts.get(m[2]).status = "cancelled"), send(204);
    if ((m = match("/api/integration/([^/]+)/connect/oauth/([^/]+)/complete"))) return (state.attempts.get(m[2]).code = body.code), send(204);
    if (path === "/api/credential" && request.method === "GET") return send(200, { data: state.credentials });
    if ((m = match("/api/credential/([^/]+)")) && request.method === "DELETE") return log.credentialsRemoved.push(m[1]), (state.credentials = state.credentials.filter((c) => c.id !== m[1])), send(204);
    if ((m = match("/api/experimental/mcp/([^/]+)"))) {
      if (request.method === "PUT") log.mcp.set(decodeURIComponent(m[1]), { ...body.config, location });
      else log.removed.push(decodeURIComponent(m[1])), log.mcp.delete(decodeURIComponent(m[1]));
      return send(204);
    }
    if (path === "/api/mcp") return send(200, { data: [...log.mcp.keys()].map((name) => ({ name, status: { status: name === "mail" ? "needs_auth" : name === "down" ? "failed" : "connected" } })) });
    if (path === "/api/session" && request.method === "POST") {
      const info = { id: "ses_" + ++seq, ...body };
      log.sessions.set(info.id, info);
      return send(200, { data: info });
    }
    if ((m = match("/api/session/([^/]+)/message"))) return send(200, { data: (log.sessions.get(m[1])?.messages ?? []).toReversed() });
    if ((m = match("/api/session/([^/]+)"))) {
      const info = log.sessions.get(m[1]);
      if (request.method === "GET" && state.lookupFails) return send(500, { _tag: "UnknownError", message: "The database is locked" });
      if (request.method === "GET") return info ? send(200, { data: info }) : send(404, { _tag: "SessionNotFoundError", message: "Session not found" });
      if (request.method === "PATCH") return Object.assign(info, body), send(204);
      if (request.method === "DELETE") return log.sessions.delete(m[1]), send(204);
    }
    if ((m = match("/api/session/([^/]+)/model"))) return (log.sessions.get(m[1]).model = body.model), send(204);
    if ((m = match("/api/experimental/session/([^/]+)/instructions/entries/([^/]+)"))) return log.instructions.set(m[1], body.value), send(204);
    if ((m = match("/api/session/([^/]+)/fork"))) {
      const info = { id: "ses_" + ++seq, forkedFrom: m[1], before: body.before };
      log.sessions.set(info.id, info);
      return send(200, { data: info });
    }
    if ((m = match("/api/session/([^/]+)/generate"))) return send(200, { data: { text: "Side answer to " + body.prompt } });
    if ((m = match("/api/session/([^/]+)/compact")) || (m = match("/api/experimental/session/([^/]+)/wait"))) return send(200, { data: {} });
    if ((m = match("/api/session/([^/]+)/interrupt"))) return state.interrupt?.(), send(200, { interrupted: true });
    if ((m = match("/api/session/([^/]+)/permission/([^/]+)/reply"))) return log.replies.push([m[2], body.decision]), state.replied?.(body.decision), send(204);
    if ((m = match("/api/session/([^/]+)/form/([^/]+)/reply"))) return log.replies.push([m[2], body.answer]), state.replied?.(body.answer), send(204);
    if ((m = match("/api/session/([^/]+)/form/([^/]+)")) && request.method === "DELETE") return log.replies.push([m[2], "cancelled"]), state.replied?.("cancelled"), send(204);
    if ((m = match("/api/session/([^/]+)/prompt"))) {
      const sessionID = m[1];
      const id = "msg_" + ++seq;
      send(200, { data: { id, sessionID } });
      const turn = {
        sessionID,
        body,
        session: log.sessions.get(sessionID),
        emit: (type, data) => emit(type, { sessionID, ...data }),
        say(text, ordinal = 0) {
          const assistantMessageID = "msg_a" + seq;
          emit("session.text.started", { sessionID, assistantMessageID, ordinal });
          for (const part of text.match(/.{1,5}/gs) ?? []) emit("session.text.delta", { sessionID, assistantMessageID, ordinal, delta: part });
          emit("session.text.ended", { sessionID, assistantMessageID, ordinal, text });
        },
        /** Sends a request to the person and resolves with the reply the provider posts back. */
        ask: (type, data) => new Promise((resolve) => ((state.replied = resolve), emit(type, { sessionID, ...data }))),
      };
      setImmediate(async () => {
        emit("session.execution.started", { sessionID });
        const end = (await play(turn)) ?? "session.execution.succeeded";
        // What OpenCode has stored once the turn is over, for a client that missed the events.
        const info = log.sessions.get(sessionID);
        if (info) Object.assign(info, { time: { idle: Date.now() + 5 }, outcome: end.split(".").pop(), messages: [...(info.messages ?? []), { type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: turn.stored ?? "" }] }] });
        emit(end, { sessionID, ...(end === "session.execution.failed" && { error: { message: "The model is overloaded." } }) });
      });
      return;
    }
    send(404, { _tag: "NotFound", message: "No route " + path });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const response of streams) response.destroy();
    server.closeAllConnections();
    server.close();
  });
  /** Cuts every open event stream, as a dropped connection does. */
  const drop = () => {
    for (const response of streams) response.destroy();
    streams.clear();
  };
  return { url: "http://127.0.0.1:" + server.address().port, log, state, emit, drop, sent: (method, pattern) => log.requests.filter(([m, p]) => m === method && pattern.test(p)) };
}

async function setup(t, play, { dir = tempDir(t) } = {}) {
  const fake = await fakeOpenCode(t, play);
  const bridge = new ToolBridge();
  const provider = new OpenCodeProvider({ dataDir: join(dir, "opencode"), bridge, connect: async () => ({ url: fake.url, password: PASSWORD }), pollMs: 10 });
  t.after(() => Promise.all([provider.stop(), bridge.stop()]));
  return { dir, provider, bridge, ...fake };
}

const spec = (over = {}) => ({
  sessionId: "chat-1",
  established: false,
  hasReplies: false,
  temporary: false,
  folder: "/work",
  coding: false,
  model: { model: "google/gemini-pro", provider: "opencode", reasoningEffort: "high" },
  approval: "ask",
  instructions: "You are Pip.",
  context: "\nMemory: likes teal.",
  tools: [],
  mcpServers: {},
  history: () => [],
  handlers: null,
  ...over,
});

test("OpenCode lists the chat models of every connected service, and says what is connected", async (t) => {
  const { provider, state } = await setup(t);
  state.busyStarts = 2;
  assert.deepEqual(await provider.models(), [
    { id: "google/gemini-pro", name: "Gemini Pro", provider: "opencode", group: "Google", efforts: ["low", "high"], tools: true, vision: false, available: true },
    { id: "opencode/big-pickle", name: "Big Pickle", provider: "opencode", group: "OpenCode", efforts: [], tools: true, vision: false, recommended: true, available: true },
  ], "models that can't chat (no tools, not text), old ones and switched-off ones are left out; a starting server is waited for");
  assert.deepEqual(await provider.status(), { installed: true, version: "9.9.9", connected: true, signIn: "services", signOut: false, plan: "Google" });
  state.integrations.find((i) => i.id === "google").connections = [];
  assert.equal((await provider.status()).plan, "Free models", "OpenCode's own free models need no sign-in");
  state.models = [];
  const empty = await provider.status();
  assert.deepEqual([empty.connected, empty.message], [false, "Connect a model service to use OpenCode."]);
  assert.equal(await provider.version(), "OpenCode 9.9.9");
});

test("model services are looked up, connected with a key or a sign-in, and removed", async (t) => {
  const { provider, state, log } = await setup(t);
  const services = await provider.services();
  assert.deepEqual(services.map((s) => s.id), ["google", "openai", "github-copilot", "zed"], "connected first, then well-known ones; a service with nothing to connect is left out");
  assert.deepEqual(services[0], { id: "google", name: "Google", connected: true, via: "environment", methods: [{ type: "key", label: "API key" }] });
  assert.deepEqual(services[1].methods, [{ type: "key", label: "API key" }, { type: "oauth", id: "chatgpt", label: "Sign in with ChatGPT" }, { type: "oauth", id: "device", label: "Device code" }]);
  assert.deepEqual((await provider.services("zed")).map((s) => s.id), ["zed"]);
  assert.deepEqual(await provider.services("nothing-like-this"), []);

  // An API key goes to OpenCode and is kept there.
  assert.deepEqual(await provider.connectService("zed", { key: "  sk-123  " }), { done: true });
  assert.deepEqual(log.keys, [["zed", "sk-123"]]);
  await assert.rejects(provider.connectService("zed", { key: "   " }), /Enter the API key/);
  assert.deepEqual((await provider.services()).find((s) => s.id === "zed").via, "opencode");

  // A sign-in opens its page and waits for OpenCode to say it finished.
  const opened = [];
  const open = async (url) => void opened.push(url);
  assert.deepEqual(await provider.connectService("openai", { method: "chatgpt", open }), { done: true });
  assert.deepEqual(opened, ["https://auth.example/openai"]);
  // One that asks a question first gets its usual answer; a question that depends on another is left out.
  await provider.connectService("github-copilot", { method: "device", open });
  assert.deepEqual([...state.attempts.values()].at(-1).body, { methodID: "device", answer: { deploymentType: "github.com" } });
  // One whose page shows a code hands back the step to finish.
  const step = await provider.connectService("openai", { method: "device", open });
  assert.deepEqual(step, { code: { attempt: step.code.attempt, instructions: "Paste the code." } });
  assert.deepEqual(await provider.finishService("openai", step.code.attempt, " 1234 "), { done: true });
  assert.equal(state.attempts.get(step.code.attempt).code, "1234");
  await assert.rejects(provider.finishService("openai", step.code.attempt, ""), /Paste the code/);
  // Failures, an unknown method, and a page that isn't https.
  state.oauthOutcome = "failed";
  await assert.rejects(provider.connectService("openai", { method: "chatgpt", open }), /Access denied/);
  state.oauthOutcome = "expired";
  await assert.rejects(provider.connectService("openai", { method: "chatgpt", open }), /expired/);
  await assert.rejects(provider.connectService("openai", { method: "nope", open }), /no longer offered/);
  state.signInUrl = "http://evil.example/login";
  await assert.rejects(provider.connectService("openai", { method: "chatgpt", open: async () => assert.fail("not opened") }), /isn't secure/);
  // Cancelling stops the wait.
  state.signInUrl = undefined;
  state.oauthOutcome = "pending";
  const existingAttempts = new Set(state.attempts.keys());
  const waiting = provider.connectService("openai", { method: "chatgpt", open });
  await t.waitFor(() => {
    assert.ok([...state.attempts].some(([id, attempt]) => !existingAttempts.has(id) && attempt.polls > 0));
  }, { timeout: 10_000 });
  await provider.cancelService("openai");
  await assert.rejects(waiting, /cancelled/);

  await provider.disconnectService("zed");
  assert.deepEqual(log.credentialsRemoved, ["cred-zed"]);
  await assert.rejects(provider.disconnectService("google"), /connected outside OpenCode/);
});

test("approval levels and the bridge become an OpenCode session's rules", () => {
  const rule = (action, effect) => ({ action, resource: "*", effect });
  assert.deepEqual(sessionRules("ask", { bridge: "commander-abc", servers: ["crm"] }), [
    rule("shell", "ask"),
    rule("edit", "ask"),
    rule("external_directory", "ask"),
    rule("crm_*", "ask"),
    rule(BRIDGE_PREFIX + "*", "deny"),
    rule("commander-abc_*", "allow"),
  ]);
  assert.deepEqual(sessionRules("all", { bridge: "commander-abc" }), [rule("*", "allow"), rule(BRIDGE_PREFIX + "*", "deny"), rule("commander-abc_*", "allow")], "even a chat that allows everything can't reach another chat's tools");
  assert.deepEqual(sessionRules("read", { plan: true }).filter((r) => r.action === "edit"), [rule("edit", "ask"), rule("edit", "deny")], "plan mode: the later rule wins, nothing is changed");
});

test("a turn creates a session in the bot's folder, streams the reply and its work, and reports what it used", async (t) => {
  const { provider, log, sent } = await setup(t, async (turn) => {
    const bridge = [...log.mcp.keys()].find((name) => name.startsWith(BRIDGE_PREFIX));
    turn.emit("session.reasoning.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Looking" });
    turn.emit("session.reasoning.ended", { assistantMessageID: "m1", ordinal: 0, text: "Looking it up" });
    turn.say("Let me look.");
    turn.emit("session.tool.input.started", { id: "t1", name: bridge + "_wiki_search" });
    turn.emit("session.tool.called", { id: "t1", input: { query: "teal" } });
    turn.emit("session.tool.success", { id: "t1", content: [{ type: "text", text: "2 pages" }] });
    turn.emit("session.tool.input.started", { id: "t2", name: "crm_find" });
    turn.emit("session.tool.called", { id: "t2", input: { name: "Acme" } });
    turn.emit("session.tool.failed", { id: "t2", error: { message: "No such account" } });
    turn.emit("session.tool.input.started", { id: "t3", name: "todowrite" });
    turn.emit("session.tool.called", { id: "t3", input: {} });
    turn.emit("session.tool.success", { id: "t3", content: [], metadata: { todos: [{ content: "Look", status: "completed" }, { content: "Answer", status: "in_progress" }] } });
    turn.emit("session.step.ended", { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300 } }, cost: 0.01 });
    turn.emit("session.step.ended", { tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 100 } }, cost: 0 });
    turn.say("It is in a.txt.", 1);
    // Another session's events are not this one's.
    turn.emit("session.text.delta", { sessionID: "ses_someone_else", delta: "IGNORED" });
  });
  const session = await provider.openSession(
    spec({
      handlers: {},
      tools: [defineTool("wiki_search", { description: "Search", parameters: { type: "object", properties: {} }, handler: () => "ok" })],
      mcpServers: { crm: { type: "http", url: "https://crm.example/mcp", headers: { "X-Key": "k" } }, files: { type: "stdio", command: "npx", args: ["files"], env: { A: "1" }, workingDirectory: "/srv" } },
    }),
  );
  assert.equal(log.sessions.size, 0, "opening a session creates nothing");
  const events = [];
  session.on((e) => events.push(e));
  const { text } = await session.send({ prompt: "Where is it?", attachments: [{ name: "notes.md", path: "/tmp/notes.md", kind: "file" }, { name: "docs", path: "/tmp/docs", kind: "directory" }] });
  assert.equal(text, "Let me look.\n\nIt is in a.txt.");

  const [created] = [...log.sessions.values()];
  assert.deepEqual([created.location, created.model, created.agent], [{ directory: "/work" }, { providerID: "google", id: "gemini-pro", variant: "high" }, "build"], "the bot brings its own role; the person's default agent is not used");
  const bridgeName = [...log.mcp.keys()].find((name) => name.startsWith(BRIDGE_PREFIX));
  assert.match(bridgeName, /^botkins-[0-9a-f]{16}$/);
  assert.deepEqual(created.permissions.slice(-2), [{ action: BRIDGE_PREFIX + "*", resource: "*", effect: "deny" }, { action: bridgeName + "_*", resource: "*", effect: "allow" }]);
  assert.ok(created.permissions.some((r) => r.action === "crm_*" && r.effect === "ask"));
  const bridge = log.mcp.get(bridgeName);
  assert.deepEqual([bridge.type, bridge.oauth, bridge.codemode, bridge.location], ["remote", false, false, "/work"], "tools are called by name, not through OpenCode's code wrapper");
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  assert.deepEqual(log.mcp.get("crm"), { type: "remote", url: "https://crm.example/mcp", headers: { "X-Key": "k" }, oauth: false, codemode: false, location: "/work" });
  assert.deepEqual(log.mcp.get("files"), { type: "local", command: ["npx", "files"], environment: { A: "1" }, cwd: "/srv", codemode: false, location: "/work" });
  assert.equal(log.instructions.get(created.id), "You are Pip.\nMemory: likes teal.");
  const [, , prompt] = sent("POST", /\/prompt$/)[0];
  assert.deepEqual(prompt, { text: "Where is it?", files: [{ uri: "file:///tmp/notes.md", name: "notes.md" }] });

  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  assert.equal(of("assistant.message_delta").map((d) => d.deltaContent).join(""), "Let me look.\n\nIt is in a.txt.");
  assert.deepEqual(of("assistant.reasoning_delta"), [{ reasoningId: "m1:0", deltaContent: "Looking" }]);
  assert.deepEqual(of("assistant.reasoning"), [{ reasoningId: "m1:0", content: "Looking it up" }]);
  assert.deepEqual(of("tool.execution_start"), [
    { toolCallId: "t1", toolName: "wiki_search", arguments: { query: "teal" } },
    { toolCallId: "t2", toolName: "find", arguments: { name: "Acme" }, mcpServerName: "crm", mcpToolName: "find" },
    { toolCallId: "t3", toolName: "todowrite", arguments: {} },
  ]);
  assert.deepEqual(of("tool.execution_complete"), [
    { toolCallId: "t1", success: true, result: { content: "2 pages" } },
    { toolCallId: "t2", success: false, error: { message: "No such account" } },
    { toolCallId: "t3", success: true },
  ]);
  assert.deepEqual(await session.todos(), { rows: [{ id: "1", title: "Look", status: "completed" }, { id: "2", title: "Answer", status: "in_progress" }], dependencies: [] });
  assert.deepEqual(of("assistant.usage"), [{ inputTokens: 150, outputTokens: 35, cacheReadTokens: 400, cost: 0.01, model: "google/gemini-pro" }]);
  assert.match(events.find((e) => e.type === "user.message").id, /^msg_/, "the message's id is the fork boundary");
  assert.deepEqual(provider.sessions.get("chat-1"), { ref: created.id });
  // When the session closes, its bridge leaves the folder.
  await session.close();
  assert.deepEqual(log.removed, [bridgeName]);
});

test("a conversation finds its session again, follows a model change, and one OpenCode has lost continues from the transcript", async (t) => {
  const { provider, log } = await setup(t);
  const first = await provider.openSession(spec());
  await first.send({ prompt: "Hi" });
  await first.close();
  const again = await provider.openSession(spec({ established: true, hasReplies: true, approval: "all", model: { model: "opencode/big-pickle", provider: "opencode" } }));
  await again.send({ prompt: "More" });
  assert.equal(log.sessions.size, 1, "the same session is used");
  const info = [...log.sessions.values()][0];
  assert.deepEqual(info.model, { providerID: "opencode", id: "big-pickle" });
  assert.deepEqual(info.permissions[0], { action: "*", resource: "*", effect: "allow" }, "the approval level in force now is the session's");
  // A model picked while the session is open switches it there.
  await again.switchModel({ model: "google/gemini-pro", provider: "opencode", reasoningEffort: "low" });
  assert.deepEqual(info.model, { providerID: "google", id: "gemini-pro", variant: "low" });
  assert.equal(await again.setMode("plan"), true);
  assert.ok(info.permissions.some((r) => r.action === "edit" && r.effect === "deny"));
  await again.close();

  log.sessions.clear();
  const history = [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello" }, { role: "user", text: "Still there?" }];
  const recovered = await provider.openSession(spec({ established: true, hasReplies: true, history: () => history }));
  await recovered.send({ prompt: "Still there?" });
  const fresh = [...log.sessions.values()][0];
  assert.match(log.instructions.get(fresh.id), /<earlier-conversation>[\s\S]*User: Hi[\s\S]*Assistant: Hello/);
  assert.equal(provider.sessions.get("chat-1").ref, fresh.id);
});

test("what OpenCode asks of the person goes through the turn's handlers, also for a helper session", async (t) => {
  const asked = [];
  let allow = true;
  const got = [];
  const { provider, emit, sent } = await setup(t, async (turn) => {
    got.push(await turn.ask("permission.asked", { id: "per_1", action: "shell", resources: ["rm -rf build"], save: ["rm *"] }));
    got.push(await turn.ask("permission.asked", { id: "per_2", action: "edit", resources: ["/work/a.txt"], metadata: { diff: "-a\n+b" } }));
    got.push(await turn.ask("permission.asked", { id: "per_3", action: "crm_delete_account", resources: ["*"] }));
    got.push(await turn.ask("form.created", { form: { id: "frm_1", sessionID: turn.sessionID, title: "A question", fields: [{ key: "audience", title: "Who is it for?", type: "string", options: [{ value: "team", label: "Team" }, { value: "everyone", label: "Everyone" }] }, { key: "secret", hidden: true, default: "x" }] } }));
    // A helper OpenCode started asks through the session that started it.
    emit("session.created", { sessionID: "ses_child", parentID: turn.sessionID });
    got.push(await turn.ask("permission.asked", { id: "per_4", sessionID: "ses_child", action: "external_directory", resources: ["/etc"] }));
    allow = false;
    got.push(await turn.ask("permission.asked", { id: "per_5", action: "shell", resources: ["curl example.com"] }));
    turn.say("Done");
  });
  const session = await provider.openSession(
    spec({
      mcpServers: { crm: { type: "http", url: "https://crm.example" } },
      handlers: {
        permission: async (request) => (asked.push(request), { allow }),
        question: async (request) => (asked.push(request), { answer: "Everyone" }),
      },
    }),
  );
  await session.send({ prompt: "Go" });
  assert.deepEqual(got, ["once", "once", "once", { audience: "everyone", secret: "x" }, "once", "reject"]);
  assert.deepEqual(sent("POST", /ses_child\/permission\/per_4\/reply$/).length, 1, "the helper's request is answered on the helper's session");
  const [shell, edit, mcp, question, child] = asked;
  assert.deepEqual([shell.kind, shell.label, shell.preview, shell.remember], ["shell", "Shell command", "rm -rf build", ["this exact command", "shell", "rm -rf build"]]);
  assert.deepEqual([edit.kind, edit.label, edit.preview], ["write", "/work/a.txt", "-a\n+b"]);
  assert.deepEqual([mcp.kind, mcp.label, mcp.toolName, mcp.remember], ["mcp", "crm / delete_account", "delete_account", null]);
  assert.deepEqual(question, { question: "A question: Who is it for?", choices: ["Team", "Everyone"], allowFreeform: true });
  assert.deepEqual([child.kind, child.sandboxEscape], ["read", true], "reaching outside the folder asks even where reads are allowed");
});

test("a turn can fail or be stopped; a side question, compact, fork and delete go to OpenCode", async (t) => {
  let mode = "fail";
  const { provider, log, state, sent } = await setup(t, async (turn) => {
    if (mode === "fail") return "session.execution.failed";
    if (mode === "stop") {
      turn.say("Half an ans");
      await new Promise((resolve) => (state.interrupt = resolve));
      return "session.execution.interrupted";
    }
    turn.say("Reply");
  });
  const session = await provider.openSession(spec());
  await assert.rejects(session.send({ prompt: "Go" }), /The model is overloaded\./);
  mode = "stop";
  const stopped = session.send({ prompt: "Go" });
  await tick(40);
  await assert.rejects(session.send({ prompt: "Again" }), /already working/);
  await session.abort();
  assert.deepEqual(await stopped, { text: "Half an ans" });
  mode = "ok";
  const events = [];
  session.on((e) => events.push(e));
  await session.send({ prompt: "Go" });
  assert.equal(await session.sideQuestion("Why?"), "Side answer to Why?");
  await session.compact();
  assert.equal(sent("POST", /\/compact$/).length, 1);
  const boundary = events.find((e) => e.type === "user.message").id;
  const copy = await provider.forkSession("chat-1", { toEventId: boundary });
  const forked = [...log.sessions.values()].at(-1);
  assert.deepEqual([forked.forkedFrom, forked.before], [provider.sessions.get("chat-1").ref, boundary], "OpenCode forks before a message, which is what Botkins asks for");
  assert.deepEqual(provider.sessions.get(copy), { ref: forked.id });
  assert.equal(await provider.forkSession("unknown"), null);
  await session.close();
  const ref = provider.sessions.get("chat-1").ref;
  await provider.deleteSession("chat-1");
  assert.equal(log.sessions.has(ref), false);
  assert.equal(provider.sessions.get("chat-1"), undefined);
});

test("the slash menu lists Botkins' tools; a server test asks OpenCode what connected", async (t) => {
  const { provider, log } = await setup(t);
  const tools = [defineTool("today_publish", { description: "Publish", parameters: { type: "object", properties: {} }, handler: () => "ok" })];
  const servers = { crm: { type: "http", url: "https://crm.example" }, mail: { type: "http", url: "https://mail.example" }, down: { type: "stdio", command: "nope" } };
  const menu = await provider.openSession(spec({ mcpServers: servers, tools }));
  const idle = await menu.inventory();
  assert.deepEqual(idle.servers.map((s) => s.status), ["not started", "not started", "not started"]);
  assert.ok(idle.choices.some((c) => c.command === "tool:today_publish"));
  assert.equal(log.sessions.size, 0, "a menu creates no session");
  const probe = await provider.openSession(spec({ sessionId: "probe", temporary: true, mcpServers: servers, tools }));
  assert.deepEqual((await probe.inventory()).servers, [{ name: "crm", status: "connected" }, { name: "mail", status: "needs-auth" }, { name: "down", status: "failed" }]);
  assert.equal(provider.sessions.get("probe"), undefined);
});

test("a chat on an OpenCode model runs through the workspace with Botkins' tools on the bridge", async (t) => {
  const dir = tempDir(t);
  const copilot = new CopilotProvider({ connect: fakeClient().client });
  t.after(() => copilot.stop());
  let called;
  const { provider, log } = await setup(
    t,
    async (turn) => {
      // OpenCode calls one of Botkins' tools the way it really does: over MCP, at the bridge.
      const [name, config] = [...log.mcp].find(([n]) => n.startsWith(BRIDGE_PREFIX));
      const call = (body) => fetch(config.url, { method: "POST", headers: { "content-type": "application/json", ...config.headers }, body: JSON.stringify(body) }).then((r) => r.json());
      const listed = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      turn.emit("session.tool.input.started", { id: "t1", name: name + "_memory_read" });
      turn.emit("session.tool.called", { id: "t1", input: {} });
      called = { names: listed.result.tools.map((x) => x.name), result: await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_read", arguments: {} } }) };
      turn.emit("session.tool.success", { id: "t1", content: called.result.result.content });
      turn.say("Noted.");
    },
    { dir },
  );
  const ws = new Workspace(join(dir, "data"), new Providers([copilot, provider]), () => {});
  // OpenCode is a provider the person adds: until then it contributes nothing.
  assert.deepEqual((await ws.models()).filter((m) => m.provider === "opencode"), []);
  assert.equal((await ws.providerStatuses()).find((s) => s.id === "opencode").enabled, false);
  await ws.setProviderEnabled("opencode", true);
  assert.deepEqual((await ws.models()).filter((m) => m.provider === "opencode").map((m) => [m.id, m.group, m.providerName]), [["google/gemini-pro", "Google", "OpenCode"], ["opencode/big-pickle", "OpenCode", "OpenCode"]]);
  const id = ws.createChat("pip");
  await ws.setModel("chat", id, { model: "google/gemini-pro", provider: "opencode", reasoningEffort: "low" });
  await ws.send(id, "Remember that I like teal");
  const chat = ws.chat(id);
  assert.deepEqual(chat.messages.map((m) => [m.role, m.text]), [["user", "Remember that I like teal"], ["assistant", "Noted."]]);
  assert.equal(chat.sessionProvider, "opencode");
  const run = ws.state.runs.find((r) => r.chatId === id);
  assert.equal(run.status, "Completed");
  assert.deepEqual(run.steps.map((s) => [s.name, s.source, s.status]), [["memory_read", undefined, "Done"]]);
  assert.ok(called.names.includes("memory_read") && called.names.includes("wiki_search"));
  const session = [...log.sessions.values()][0];
  assert.deepEqual(session.model, { providerID: "google", id: "gemini-pro", variant: "low" });
  assert.match(log.instructions.get(session.id), /Pip/);
  assert.match(session.location.directory, /files[\\/]pip$/, "a chat outside a project works in the bot's own folder");
  // Switching the provider off takes its models away again, and a chat still set to one of them
  // says so instead of using the provider anyway. The last provider can't be switched off.
  await ws.setProviderEnabled("opencode", false);
  assert.deepEqual((await ws.models()).filter((m) => m.provider === "opencode"), []);
  await ws.send(id, "Still there?");
  const refused = ws.state.runs.find((r) => r.chatId === id && r.status === "Needs you");
  assert.match(refused.detail, /OpenCode is switched off\. Choose another model for this chat, or switch OpenCode on in Settings › Model providers\./);
  await ws.setProviderEnabled("copilot", false).then(
    () => assert.fail("the last provider stays on"),
    (error) => assert.match(error.message, /at least one/),
  );
});

test("Stop, a lost event stream and a failed lookup never leave a turn running, hanging or orphaned", async (t) => {
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  let hold;
  let mode = "slow";
  const { provider, log, state, sent, drop } = await setup(t, async (turn) => {
    if (mode === "dropped") {
      // The connection drops mid-turn; the turn ends at OpenCode while nobody is listening.
      turn.say("Before the drop. ");
      drop();
      turn.stored = "The whole reply.";
      return;
    }
    turn.say("Working");
    await new Promise((resolve) => (hold = resolve));
  });
  // A turn that times out on Botkins' side is interrupted at OpenCode.
  const session = await provider.openSession(spec({ handlers: {}, tools: [defineTool("x", { description: "x", parameters: {}, handler: () => "x" })] }));
  await assert.rejects(session.send({ prompt: "Slow" }, 60), /didn't finish in time/);
  assert.equal(sent("POST", /\/interrupt$/).length, 1);
  hold();
  // Closing a session whose turn is still running interrupts it too.
  const running = session.send({ prompt: "Again" });
  const closed = assert.rejects(running, /closed/);
  await tick(40);
  await session.close();
  await closed;
  assert.equal(sent("POST", /\/interrupt$/).length, 2);
  hold();

  // The event stream is lost and found again: the turn is finished from what OpenCode stored.
  mode = "dropped";
  const again = await provider.openSession(spec({ established: true, hasReplies: true }));
  assert.deepEqual(await again.send({ prompt: "Go" }), { text: "The whole reply." });
  await again.close();

  // A lookup that fails is a failure, not "the session is gone": no new session replaces the conversation.
  const before = log.sessions.size;
  state.lookupFails = true;
  await assert.rejects((await provider.openSession(spec({ established: true, hasReplies: true }))).send({ prompt: "Hi" }), /database is locked/);
  assert.equal(log.sessions.size, before);
  state.lookupFails = false;

  // A session made only to look is removed from OpenCode again.
  const probe = await provider.openSession(spec({ sessionId: "probe", temporary: true, mcpServers: { crm: { type: "http", url: "https://crm.example" } } }));
  await probe.inventory();
  assert.equal(log.sessions.size, before + 1);
  await probe.close();
  assert.equal(log.sessions.size, before, "the test session is not left in OpenCode's list");

  // Closing after the server has stopped starts nothing.
  const idle = await provider.openSession(spec({ sessionId: "idle" }));
  await provider.stop();
  let connects = 0;
  const connect = provider.connect;
  provider.connect = async () => (connects++, connect());
  await idle.close();
  await idle.abort();
  assert.equal(connects, 0, "a late close or Stop never starts OpenCode again");
});

test("an OpenCode model carries the limits and abilities its listing states", async (t) => {
  const { provider, state } = await setup(t);
  state.models = [
    { id: "big", providerID: "google", name: "Big", variants: [], status: "active", enabled: true, limit: { context: 1_000_000, output: 64_000, input: 900_000 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } },
    { id: "plain", providerID: "google", name: "Plain", variants: [], status: "active", enabled: true, limit: { context: 32_000 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
  ];
  const [big, plain] = await provider.models();
  assert.deepEqual([big.contextWindow, big.maxPrompt, big.maxOutput, big.vision, big.tools], [1_000_000, 900_000, 64_000, true, true]);
  assert.deepEqual([plain.contextWindow, plain.vision, plain.tools], [32_000, false, true]);
  assert.equal("maxPrompt" in plain || "maxOutput" in plain, false, "a limit the listing does not state is left out");
});

test("an OpenCode model whose listing has no limit has no numbers, and a limit that is not real is dropped", async (t) => {
  const { provider, state } = await setup(t);
  state.models = [
    { id: "bare", providerID: "google", name: "Bare", variants: [], status: "active", enabled: true, capabilities: { tools: true, output: ["text"] } },
    { id: "zero", providerID: "google", name: "Zero", variants: [], status: "active", enabled: true, limit: { context: 0, output: "lots", input: null }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
  ];
  const [bare, zero] = await provider.models();
  for (const model of [bare, zero]) assert.deepEqual(["contextWindow", "maxPrompt", "maxOutput"].filter((k) => k in model), []);
  assert.equal("vision" in bare, false, "no list of what it takes, no claim about pictures");
});
