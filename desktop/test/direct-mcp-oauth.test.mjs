import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PiProvider } from "../desktop/providers/pi/index.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { until } from "./quiet-turns.mjs";

async function setup(t, nativeBinary) {
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
  const provider = new PiProvider({ binary, dataDir: join(home, "harness-data"), env: { HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, PATH: "/usr/bin:/bin" } });
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
async function localModel(t) {
  const requests = [];
  const missingTool = [];
  const model = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const id = "fixture_" + requests.length;
    const useTool = requests.length % 2 === 1;
    const name = input.tools?.find((tool) => tool.name === "mcp__words__secret_word")?.name;
    if (useTool && !name) missingTool.push(requests.length);
    const call = useTool && name;
    const item = call
      ? { id, type: "function_call", call_id: id, name, arguments: "{}" }
      : { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
    const frame = (type, data) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame("response.created", { response: { id, status: "in_progress", output: [] } }) +
      frame("response.output_item.added", { output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, status: "in_progress", content: [] } }) +
      (call
        ? frame("response.function_call_arguments.delta", { output_index: 0, item_id: id, delta: "{}" })
        : frame("response.output_text.delta", { output_index: 0, item_id: id, content_index: 0, delta: "Done." })) +
      frame("response.output_item.done", { output_index: 0, item }) +
      frame("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (model.closeAllConnections(), model.close(resolve))));
  return { requests, missingTool, baseUrl: "http://127.0.0.1:" + model.address().port + "/v1" };
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
  allow = false;
  await turn();
  assert.equal(upstreamCalls(remote).length, 3, "denied tool requests must not reach the MCP server");
  assert.equal(session.live === live, true);
  assert.equal(approvals.length, 4);
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
async function connect(session) {
  await session.warm();
  const config = JSON.parse(readFileSync(session.live.file, "utf8"));
  const server = config.servers.words;
  const call = async (id) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "secret_word" } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { call, config, endpoint: server.url };
}

const skip = process.platform === "win32" && "The harness fixtures use a POSIX launcher";
test("Pi renews a rejected vault token for the next call on the same process", { skip }, async (t) => {
  const { remote, makeSession } = await setup(t);
  const session = await makeSession();
  const { config, call } = await connect(session);
  const live = session.live;
  const result = await call(1);
  assert.equal(result.result?.content[0]?.text, remote.state.word);
  withoutCredentials(remote, config);
  remote.state.rejectNextCall = true;
  const refused = await call(2);
  assert.equal(refused.result?.isError, true);
  assert.equal(remote.state.rejectedEffects, 1);
  assert.equal(upstreamCalls(remote).filter((entry) => JSON.parse(entry.body).id === 2).length, 1);
  withoutCredentials(remote, [refused, remote.state.log, live.rpc.stderr]);
  await session.close();
  const next = await makeSession();
  await next.warm();
  assert.equal(next.live === live, true, "OAuth renewal replaced the harness process");
  assert.equal((await call(3)).result?.content[0]?.text, remote.state.word);
  assert.equal(tokenRequests(remote), 2);
});

test("a scope challenge stops warm calls until a person consents, even after cancellation", { skip }, async (t) => {
  const { remote, makeSession, ws, id } = await setup(t);
  const session = await makeSession();
  const { call } = await connect(session);
  const live = session.live;
  remote.state.requiredScope = "tools.write";
  remote.state.scope = "tools.read tools.write";
  const denied = await call(1);
  assert.match(denied.result?.content[0]?.text ?? "", /sign.in/i);
  assert.equal(ws.integrations.publicServers()[0].auth.needsSignIn, true);
  assert.equal((await call(2)).result?.isError, true);
  assert.equal(upstreamCalls(remote).length, 1, "no tool call advances without consent");
  assert.equal(tokenRequests(remote), 1, "no unattended refresh or new grant");
  assert.equal(remote.state.log.filter((r) => r.path === "/authorize").length, 1, "no unattended browser launch");

  const opened = Promise.withResolvers();
  const pending = ws.integrations.signIn(id, { open: (url) => opened.resolve(new URL(url).searchParams.get("scope")) });
  assert.equal(await opened.promise, "tools.read tools.write");
  ws.integrations.cancelSignIn(id);
  await assert.rejects(pending, /cancel/i);
  assert.equal((await call(3)).result?.isError, true);
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
  await call(1);
  const record = ws.integrations.server(id);
  const oauth = ws.integrations.oauth;
  oauth.write(record, { ...oauth.read(record), expiresAt: Date.now() - 1 });
  remote.state.access.clear();
  assert.equal((await call(2)).result?.content[0]?.text, remote.state.word);
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
  await call(1);
  assert.equal(ws.integrations.publicServers()[0].auth.needsSignIn, true);
  release.resolve();
  assert.equal((await renewal) === null, true, "the outstanding renewal cannot erase the consent requirement");
  assert.equal(ws.integrations.oauth.status(ws.integrations.server(id)).needsSignIn, true);
});
