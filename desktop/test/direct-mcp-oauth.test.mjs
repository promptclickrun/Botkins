import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PiProvider, pluginAlias } from "../desktop/providers/pi/index.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { headlessHost } from "../desktop/host/headless.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";
import { seedBots, Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { until } from "./quiet-turns.mjs";

async function setup(t, nativeBinary, Provider = PiProvider) {
  const home = mkdtempSync(join(tmpdir(), "botkins-direct-oauth-"));
  t.after(() => rmSync(home, { force: true, recursive: true }));
  const remote = await oauthMcpServer({ recordSecrets: false });
  t.after(() => remote.close());
  const ws = new Workspace(join(home, "workspace"), fakeClient().client, () => {}, { oauthPort: 0, openExternal: remote.browser });
  const id = ws.integrations.saveServer({ name: "words", type: "http", url: remote.url, oauth: {} });
  await ws.integrations.signIn(id);

  const binary = nativeBinary ?? join(home, "harness");
  if (!nativeBinary) {
    const script = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
    writeFileSync(binary, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(script) + ' "$@"\n');
    chmodSync(binary, 0o700);
  }
  const provider = new Provider({ binary, dataDir: join(home, "harness-data"), env: { HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, PATH: "/usr/bin:/bin" } });
  t.after(() => provider.stop());
  const bot = {};
  const makeSession = (extra) => provider.openSession({
    sessionId: "oauth-chat",
    folder: home,
    model: { source: "fixture", model: "fixture" },
    inference: { providers: [{ name: "fixture", config: { baseUrl: remote.origin } }] },
    tools: [],
    mcpServers: ws.integrations.serversFor(bot, { liveOAuth: true }),
    mcpAuth: (request) => ws.integrations.mcpAuth(request),
    ...extra,
  });
  return { remote, provider, makeSession, ws, id };
}

// Opt in with a native Pi binary or CLI script. The model speaks Responses SSE on loopback only.
async function localModel(t, toolName = "mcp__words__secret_word", explicitlyArmed = false, args = "{}") {
  const requests = [];
  const missingTool = [];
  let armed = false;
  const model = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const id = "fixture_" + requests.length;
    const name = input.tools?.find((tool) => tool.name === toolName)?.name;
    // OMP also makes auxiliary model requests on the configured provider. Only the main
    // request gets the external MCP schema and should consume the one armed invocation.
    const useTool = explicitlyArmed ? armed && !!name : requests.length % 2 === 1;
    if (useTool && explicitlyArmed) armed = false;
    if (useTool && !name) missingTool.push(requests.length);
    const call = useTool && name;
    const item = call
      ? { id, type: "function_call", call_id: id, name, arguments: args }
      : { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
    const frame = (type, data) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame("response.created", { response: { id, status: "in_progress", output: [] } }) +
      frame("response.output_item.added", { output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, status: "in_progress", content: [] } }) +
      (call
        ? frame("response.function_call_arguments.delta", { output_index: 0, item_id: id, delta: args })
        : frame("response.output_text.delta", { output_index: 0, item_id: id, content_index: 0, delta: "Done." })) +
      frame("response.output_item.done", { output_index: 0, item }) +
      frame("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (model.closeAllConnections(), model.close(resolve))));
  return { requests, missingTool, arm: () => { armed = true; }, baseUrl: "http://127.0.0.1:" + model.address().port + "/v1" };
}

const binary = process.env.BOTKINS_TEST_PI;
test("native Pi: warm approved calls renew without replay or token leakage", { skip: !binary && "No native Pi specified", timeout: 30000 }, async (t) => {
  const { remote, makeSession } = await setup(t, binary);
  const { baseUrl, requests, missingTool } = await localModel(t);
  const approvals = [];
  let allow = true;
  const session = await makeSession({
    inference: { providers: [{ name: "fixture", config: {
      name: "Local fixture", baseUrl, api: "openai-responses", apiKey: "synthetic-model-key", authHeader: true,
      models: [{ id: "fixture", name: "Local fixture", input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } }] },
    handlers: { permission: async (request) => (approvals.push(request), { allow }) },
  });
  const events = [];
  session.on((event) => events.push(event));
  await session.warm();
  await until(() => remote.state.log.some((entry) => entry.body && JSON.parse(entry.body).method === "tools/list"));
  const live = session.live;
  const turn = async () => assert.equal((await session.send({ prompt: "Use the fixture tool once." })).text, "Done.");
  await turn();
  assert.deepEqual(missingTool, []);
  assert.equal(upstreamCalls(remote).length, 1);
  remote.state.rejectNextCall = true;
  await turn();
  assert.equal(remote.state.rejectedEffects, 1);
  assert.equal(upstreamCalls(remote).length, 2);
  await turn();
  assert.equal(upstreamCalls(remote).length, 3);
  assert.equal(tokenRequests(remote), 2);
  remote.state.interruptNextCall = true;
  await turn();
  assert.equal(remote.state.interruptedEffects, 1);
  assert.equal(upstreamCalls(remote).length, 4);
  allow = false;
  await turn();
  assert.equal(upstreamCalls(remote).length, 4, "denied tool requests must not reach the MCP server");
  assert.equal(session.live === live, true);
  assert.equal(approvals.length, 5);
  assert.ok(approvals.every((approval) => approval.kind === "mcp" && approval.label === "words / secret_word"));
  assert.ok(JSON.stringify(events).includes("not replayed"));
  withoutCredentials(remote, [requests, events, remote.state.log, live.rpc.stderr]);
});

const credentials = (remote) => [...remote.state.access.keys(), ...remote.state.refresh.keys()];
const withoutCredentials = (remote, value) => {
  const text = JSON.stringify(value);
  assert.ok(credentials(remote).every((token) => !text.includes(token)), "OAuth credentials reached native files, logs or messages");
};
const tokenRequests = (remote) => remote.state.log.filter((entry) => entry.path === "/token").length;
const upstreamCalls = (remote) => remote.state.log.filter((entry) => entry.path === "/mcp" && entry.body && JSON.parse(entry.body).method === "tools/call");

const ompBinary = process.env.BOTKINS_TEST_OMP;
for (const [kind, program] of [["pi", binary], ["omp", ompBinary]]) {
  test(`Workspace ${kind}: installed plugin OAuth renews only its scoped credential`, { skip: !program, timeout: 30000 }, async (t) => {
    assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
    const home = mkdtempSync(join(tmpdir(), "botkins-workspace-plugin-oauth-"));
    const remote = await oauthMcpServer({ recordSecrets: false });
    seedBots(home);
    const runtime = await createRuntime({ host: headlessHost({ version: "1" }), dataDir: home, trial: true, link: { port: 0, announce: false } });
    t.after(async () => {
      await runtime.stop();
      await remote.close();
      rmSync(home, { force: true, recursive: true });
    });
    const ws = runtime.workspace;
    const folder = join(home, "plugin-fixture");
    mkdirSync(folder);
    writeFileSync(join(folder, "plugin.json"), JSON.stringify({ name: "words-fixture", version: "1.0.0", mcpServers: ".mcp.json", hooks: "hooks.json" }));
    writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { words: { type: "http", url: remote.url, oauth: {} } } }));
    writeFileSync(join(folder, "hooks.json"), JSON.stringify({ hooks: { preToolUse: [{ type: "command", command: `node "\${PLUGIN_ROOT}/hook.mjs"` }] } }));
    writeFileSync(join(folder, "hook.mjs"), `const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const req = JSON.parse(Buffer.concat(chunks)); console.log(JSON.stringify(req.toolName.endsWith("-secret_word") ? { modifiedArgs: { word: "rewritten" } } : {}));`);
    const plugin = await ws.plugins.addFolder(folder);
    await ws.plugins.setBots(plugin.id, ["pip"]);
    await ws.plugins.setEnabled(plugin.id, true, { revision: plugin.revision });
    const [pluginServer] = ws.plugins.oauthServers(ws.plugins.get(plugin.id));
    await ws.plugins.signIn(pluginServer.id, { open: remote.browser });
    const noPlugin = await ws.plugins.session({ id: "scout" }, { id: "other-chat" }, { liveOAuth: true });
    assert.deepEqual(noPlugin.mcpServers, {});
    const provider = runtime.providers.require(kind);
    provider.binary = program;
    provider.baseEnv = { HOME: home, TMPDIR: home, PATH: process.env.PATH };
    ws.state.settings.harness = kind;
    ws.state.settings.approval = "ask";
    const chat = ws.chat(ws.createChat("pip"));
    chat.model = { provider: "codex", model: "fixture" };
    t.mock.method(runtime.providers, "models", async () => [{ provider: "codex", id: "fixture", tools: true }]);
    const gateway = ws.harness.gateway;
    gateway.chatgpt = { signIn: () => ({ token: "fixture-model-only" }) };
    const tool = "mcp__" + pluginAlias(pluginServer.name) + (kind === "pi" ? "__" : "_") + "secret_word";
    const model = await localModel(t, tool, true, '{"word":"original"}');
    t.mock.method(gateway, "fetch", (_url, init) => fetch(model.baseUrl + "/responses", { ...init, headers: { "content-type": "application/json" } }));
    const asks = [];
    ws.events.on("request", (view) => {
      asks.push(view);
      if (view.kind === "permission") ws.interactions.respond(view.id, { action: "approve" });
    });
    const run = async () => {
      model.arm();
      await ws.submit(chat.id, "Run the fixture tool once.");
      assert.equal(chat.messages.at(-1)?.text, "Done.");
    };
    await run();
    const [live] = provider.live.values();
    assert.ok(live?.oauth, "Workspace must project the installed plugin through the OAuth relay");
    assert.equal(upstreamCalls(remote).length, 1);
    assert.equal(JSON.parse(upstreamCalls(remote)[0].body).params.arguments.word, "rewritten");
    assert.ok(asks.some((view) => view.label === pluginServer.name + " / secret_word" && view.preview.includes("rewritten")));
    remote.state.rejectNextCall = true;
    await run();
    assert.equal(remote.state.rejectedEffects, 1);
    assert.equal(upstreamCalls(remote).length, 2);
    await run();
    assert.equal(tokenRequests(remote), 2);
    assert.equal(upstreamCalls(remote).length, 3);
    assert.ok([...provider.live.values()].includes(live) && !live.rpc.closed);
    assert.equal(await ws.plugins.token("scout", { server: pluginServer.name, serverId: pluginServer.id, url: pluginServer.url }), null);
    assert.equal(await ws.plugins.token("pip", { server: pluginServer.name, serverId: "not-this-plugin", url: pluginServer.url }), null);
    remote.state.scope = "tools.read tools.write";
    remote.state.requiredScope = "tools.write";
    await run();
    assert.equal(ws.plugins.oauth.status(pluginServer).signedIn, false);
    remote.state.authorize = "deny";
    await assert.rejects(ws.plugins.signIn(pluginServer.id, { open: remote.browser }), /cancel|denied/i);
    assert.equal(await ws.plugins.token("pip", { server: pluginServer.name, serverId: pluginServer.id, url: pluginServer.url }), null);
    const scopes = [...remote.state.access.values()].map((grant) => grant.scope);
    assert.ok(scopes.every((scope) => scope === "tools.read"), "cancelled consent did not create a wider token");
    await run();
    assert.equal(upstreamCalls(remote).length, 4);
    withoutCredentials(remote, [model.requests, chat.messages, ...[...provider.live.values()].map((entry) => readFileSync(entry.file, "utf8")), live.rpc.stderr]);
  });
}

test("native OMP: relay grants, warm renewal, no replay, and Stop", { skip: !ompBinary && "No native OMP specified", timeout: 30000 }, async (t) => {
  assert.deepEqual(Object.keys(networkInterfaces()), ["lo"], "Run this test in a loopback-only Linux network namespace");
  const { remote, makeSession } = await setup(t, ompBinary, OmpProvider);
  const { baseUrl, requests, arm } = await localModel(t, "mcp__words_secret_word", true);
  const approvals = [];
  let allow = true;
  const session = await makeSession({
    inference: { providers: [{ name: "fixture", config: {
      name: "Local fixture", baseUrl, api: "openai-responses", apiKey: "synthetic-model-key", authHeader: true,
      models: [{ id: "fixture", name: "Local fixture", input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } }] },
    handlers: { permission: async (request) => (approvals.push(request), { allow }) },
  });
  const events = [];
  session.on((event) => events.push(event));
  const { call, config } = await connect(session);
  const live = session.live;
  const versionConfig = JSON.parse(readFileSync(join(live.agentDir, "mcp.json"), "utf8"));
  assert.notEqual(config.servers.words.url, remote.url, "native OMP must receive the host relay URL, not the upstream OAuth address");
  assert.deepEqual(versionConfig.mcpServers, config.servers);
  const turn = async () => {
    arm();
    assert.equal((await session.send({ prompt: "Use the fixture tool once." }, 5000)).text, "Done.");
  };
  try {
    await until(() => remote.state.log.some((entry) => entry.body && JSON.parse(entry.body).method === "tools/list"), "native OMP MCP discovery");
  } catch (error) {
    const methods = remote.state.log.filter((entry) => entry.path === "/mcp").map((entry) => entry.body ? JSON.parse(entry.body).method : entry.method);
    throw new Error("Native OMP discovery did not list tools; upstream methods: " + methods.join(", "), { cause: error });
  }
  assert.equal(remote.state.log.some((entry) => entry.body && JSON.parse(entry.body).method === "server/discover"), false,
    "the relay must not forward OMP's optional discovery RPC");
  assert.equal((await call(98765)).result?.isError, true);
  assert.equal(upstreamCalls(remote).length, 0);
  await turn();
  assert.ok(requests.some((request) => request.tools?.some((tool) => tool.name === "mcp__words_secret_word")));
  assert.ok(JSON.stringify(events).includes(remote.state.word), "native OMP must receive the real relay result");
  assert.equal(upstreamCalls(remote).length, 1);
  remote.state.rejectNextCall = true;
  await turn();
  assert.equal(remote.state.rejectedEffects, 1);
  assert.equal(upstreamCalls(remote).length, 2);
  await turn();
  assert.equal(upstreamCalls(remote).length, 3);
  assert.equal(tokenRequests(remote), 2);
  remote.state.interruptNextCall = true;
  await turn();
  assert.equal(remote.state.interruptedEffects, 1);
  assert.equal(upstreamCalls(remote).length, 4);
  allow = false;
  await turn();
  assert.equal(upstreamCalls(remote).length, 4);
  allow = true;
  const received = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  remote.state.holdNextCall = { received: received.resolve, disconnected: disconnected.resolve };
  arm();
  const stopping = session.send({ prompt: "Use the fixture tool, then stop." }, 5000);
  await Promise.race([received.promise, stopping.then(() => assert.fail("OMP finished without opening the held request"))]);
  await session.abort();
  await stopping;
  await disconnected.promise;
  assert.equal(upstreamCalls(remote).length, 5);
  assert.equal((await call(98766)).result?.isError, true);
  assert.equal(upstreamCalls(remote).length, 5);
  assert.equal(session.live === live && !live.rpc.closed, true, "OMP process should stay warm even after Stop");
  assert.equal(approvals.length, 6);
  assert.ok(approvals.every((entry) => entry.kind === "mcp" && entry.label === "words / secret_word"));
  assert.ok(JSON.stringify(events).includes("not replayed"));
  withoutCredentials(remote, [versionConfig, requests, events, remote.state.log, live.rpc.stderr]);
});

async function connect(session) {
  await session.warm();
  const config = JSON.parse(readFileSync(session.live.file, "utf8"));
  const server = config.servers.words;
  const request = (rpc) => fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...rpc }),
  });
  const call = async (id, args, name = "secret_word") => {
    const response = await request({ id, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { call, request, config, endpoint: server.url };
}

const skip = process.platform === "win32" && "The harness fixtures use a POSIX launcher";

// Hold a real fake-Pi RPC turn at its shell approval while the test drives the relay.
async function heldTurn(session, onReady) {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  session.spec.handlers = { permission: (req) => {
    if (req.kind !== "shell") return { allow: true };
    entered.resolve();
    return resume.promise;
  } };
  const done = session.send({ prompt: "bash:fixture" }, 10000, onReady);
  done.catch(entered.reject);
  await entered.promise;
  const release = () => resume.resolve({ allow: false });
  return { release, finish: async () => { release(); await done; } };
}

async function approval(session, id, input = {}, server = "words", name = "secret_word") {
  return session.permission({ toolCallId: String(id), toolName: "mcp__" + server + "__" + name, mcpServerName: server, mcpToolName: name, input });
}

async function approvedCall(session, call, id) {
  const turn = await heldTurn(session);
  try {
    assert.equal(await approval(session, id), true);
    return await call(id);
  } finally {
    await turn.finish();
  }
}

test("Pi's relay refuses a fixture tool invocation without a host approval", { skip }, async (t) => {
  const { remote, ws, makeSession } = await setup(t);
  ws.integrations.saveServer({ name: "other_words", type: "http", url: remote.url, oauth: {} });
  const session = await makeSession();
  const { call } = await connect(session);
  const reply = await call(1);
  assert.equal(reply.result?.isError, true);
  assert.equal(upstreamCalls(remote).length, 0);
  const turn = await heldTurn(session);
  try {
    assert.equal((await call(2)).result?.isError, true);
    assert.equal(upstreamCalls(remote).length, 0);
    assert.equal(await approval(session, "other-server", { text: "approved" }, "other_words"), true);
    assert.equal((await call(20, { text: "approved" })).result?.isError, true);
    assert.equal(await approval(session, "first", { text: "approved" }), true);
    assert.equal((await call(3, { text: "different" })).result?.isError, true);
    assert.equal((await call(4, { text: "approved" }, "other_tool")).result?.isError, true);
    assert.equal(upstreamCalls(remote).length, 0);
    assert.equal((await call(5, { text: "approved" })).result?.content[0]?.text, remote.state.word);
    assert.equal(await approval(session, "first", { text: "approved" }), false);
    assert.equal((await call(6, { text: "approved" })).result?.isError, true);
    assert.equal(upstreamCalls(remote).length, 1);
  } finally {
    await turn.finish();
  }
});

test("the relay passes discovery but rejects unsupported messages and HTTP DELETE", { skip }, async (t) => {
  const { remote, makeSession } = await setup(t);
  const { request, endpoint } = await connect(await makeSession());
  const listed = await request({ id: 1, method: "tools/list" });
  assert.equal((await listed.json()).result.tools[0].name, "secret_word");
  assert.equal((await request({ id: 2, method: "prompts/get", params: { name: "fixture" } })).status, 403);
  assert.equal((await request({ method: "notifications/cancelled", params: { requestId: 1 } })).status, 403);
  assert.equal((await request({ id: 3, method: "notifications/initialized" })).status, 403);
  assert.equal((await fetch(endpoint, { method: "DELETE" })).status, 405);
  assert.equal(remote.state.log.filter((entry) => entry.path === "/mcp").length, 2, "only browser discovery and the allowed request reached MCP");
});

test("an interrupted tool response returns an error without replaying even with an identical pending approval", { skip }, async (t) => {
  const { remote, makeSession } = await setup(t);
  const session = await makeSession();
  const { call } = await connect(session);
  const turn = await heldTurn(session);
  try {
    assert.equal(await approval(session, "first"), true);
    assert.equal(await approval(session, "second"), true);
    remote.state.interruptNextCall = true;
    assert.match((await call(1)).result?.content[0]?.text ?? "", /not replayed/i);
    assert.equal((await call(1)).result?.isError, true);
    assert.equal(remote.state.interruptedEffects, 1);
    assert.equal(upstreamCalls(remote).length, 1);
    remote.state.streamNextCall = true;
    assert.equal((await call(2)).result?.content[0]?.text, remote.state.word);
  } finally {
    await turn.finish();
  }
});

for (const end of ["Stop", "steer", "finish"]) {
  test(end + " revokes unused approval and cannot admit a late approval", { skip }, async (t) => {
    const { remote, makeSession } = await setup(t);
    const session = await makeSession();
    const { call } = await connect(session);
    const ready = Promise.withResolvers();
    const turn = await heldTurn(session, ready.resolve);
    const answer = Promise.withResolvers();
    const asked = Promise.withResolvers();
    let steering;
    try {
      assert.equal(await approval(session, "unused"), true);
      session.spec.handlers.permission = () => { asked.resolve(); return answer.promise; };
      const late = approval(session, "late", { late: true });
      await asked.promise;
      if (end === "Stop") await session.abort();
      else if (end === "steer") steering = (await ready.promise)({ prompt: "replacement" });
      else await turn.finish();
      assert.equal((await call(1)).result?.isError, true);
      answer.resolve({ allow: true });
      assert.equal(await late, false);
      assert.equal((await call(2, { late: true })).result?.isError, true);
      assert.equal(upstreamCalls(remote).length, 0);
    } finally {
      answer.resolve({ allow: false });
      turn.release();
      if (steering) await steering;
      await turn.finish();
    }
  });
}

test("Pi renews a rejected vault token for the next call on the same process", { skip }, async (t) => {
  const { remote, makeSession } = await setup(t);
  const session = await makeSession();
  const { config, call } = await connect(session);
  const live = session.live;
  const result = await approvedCall(session, call, 1);
  assert.equal(result.result?.content[0]?.text, remote.state.word);
  withoutCredentials(remote, config);
  remote.state.rejectNextCall = true;
  const refused = await approvedCall(session, call, 2);
  assert.equal(refused.result?.isError, true);
  assert.equal(remote.state.rejectedEffects, 1);
  assert.equal(upstreamCalls(remote).filter((entry) => JSON.parse(entry.body).id === 2).length, 1);
  withoutCredentials(remote, [refused, remote.state.log, live.rpc.stderr]);
  await session.close();
  const next = await makeSession();
  await next.warm();
  assert.equal(next.live === live, true, "OAuth renewal replaced the harness process");
  assert.equal((await approvedCall(next, call, 3)).result?.content[0]?.text, remote.state.word);
  assert.equal(tokenRequests(remote), 2);
});

test("a scope challenge stops warm calls until a person consents, even after cancellation", { skip }, async (t) => {
  const { remote, makeSession, ws, id } = await setup(t);
  const session = await makeSession();
  const { call } = await connect(session);
  const live = session.live;
  remote.state.requiredScope = "tools.write";
  remote.state.scope = "tools.read tools.write";
  const denied = await approvedCall(session, call, 1);
  assert.match(denied.result?.content[0]?.text ?? "", /sign.in/i);
  assert.equal(ws.integrations.publicServers()[0].auth.needsSignIn, true);
  assert.equal((await approvedCall(session, call, 2)).result?.isError, true);
  assert.equal(upstreamCalls(remote).length, 1, "no tool call advances without consent");
  assert.equal(tokenRequests(remote), 1, "no unattended refresh or new grant");
  assert.equal(remote.state.log.filter((r) => r.path === "/authorize").length, 1, "no unattended browser launch");

  const opened = Promise.withResolvers();
  const pending = ws.integrations.signIn(id, { open: (url) => opened.resolve(new URL(url).searchParams.get("scope")) });
  assert.equal(await opened.promise, "tools.read tools.write");
  ws.integrations.cancelSignIn(id);
  await assert.rejects(pending, /cancel/i);
  assert.equal((await approvedCall(session, call, 3)).result?.isError, true);
  assert.equal(session.live === live && !live.rpc.closed, true);
  assert.equal(tokenRequests(remote), 1);
  withoutCredentials(remote, [denied, ws.snapshot()]);

  await ws.integrations.signIn(id);
  assert.equal(ws.integrations.publicServers()[0].auth.scope, "tools.read tools.write");
  assert.equal(tokenRequests(remote), 2);
});

test("the first warm call after vault expiry uses the renewed grant", { skip }, async (t) => {
  const { remote, makeSession, ws, id } = await setup(t);
  const session = await makeSession();
  const { call } = await connect(session);
  await approvedCall(session, call, 1);
  const record = ws.integrations.server(id);
  const oauth = ws.integrations.oauth;
  oauth.write(record, { ...oauth.read(record), expiresAt: Date.now() - 1 });
  remote.state.access.clear();
  assert.equal((await approvedCall(session, call, 2)).result?.content[0]?.text, remote.state.word);
  assert.equal(tokenRequests(remote), 2);
  assert.equal(upstreamCalls(remote).length, 2, "expiry does not send a request with a stale token");
});

test("releasing Pi revokes its OAuth endpoint before the child exits", { skip }, async (t) => {
  const { remote, provider, makeSession } = await setup(t);
  const session = await makeSession();
  const { endpoint } = await connect(session);
  const rpc = session.live.rpc;
  const close = rpc.close.bind(rpc);
  rpc.close = async () => {};
  try {
    provider.release(session.id);
    await assert.rejects(fetch(endpoint), /fetch failed/);
    assert.equal(remote.state.log.filter((entry) => entry.path === "/mcp").length, 1, "only browser discovery reached MCP");
  } finally {
    await close();
  }
});

test("a late renewal cannot overwrite a warm scope refusal", { skip }, async (t) => {
  const { remote, makeSession, ws, id } = await setup(t);
  const session = await makeSession();
  const { call } = await connect(session);
  const sent = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(release.resolve);
  remote.state.tokenGate = { then: (accept) => (sent.resolve(), release.promise.then(accept)) };
  const renewal = ws.integrations.mcpAuth({ server: "words", url: remote.url, reason: "refresh" });
  await sent.promise;
  remote.state.requiredScope = "tools.write";
  await approvedCall(session, call, 1);
  assert.equal(ws.integrations.publicServers()[0].auth.needsSignIn, true);
  release.resolve();
  assert.equal((await renewal) === null, true, "the outstanding renewal cannot erase the consent requirement");
  assert.equal(ws.integrations.oauth.status(ws.integrations.server(id)).needsSignIn, true);
});
