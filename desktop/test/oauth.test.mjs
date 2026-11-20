// Signing in to a remote MCP server with OAuth (desktop/oauth.mjs, desktop/integrations.mjs),
// against the local stand-in server in test/oauth-server.mjs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { challengeParam, REDIRECT_PORT, scheme } from "../desktop/oauth.mjs";
import { serversWithTokens } from "../desktop/providers/sessions.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";

async function setup(t, serverOptions, workspaceOptions = {}) {
  const remote = await oauthMcpServer(serverOptions);
  t.after(() => remote.close());
  const dir = tempDir(t);
  const fake = fakeClient();
  const opened = [];
  const options = { oauthPort: 0, openExternal: async (url) => (opened.push(url), remote.browser(url)), ...workspaceOptions };
  const open = () => new Workspace(dir, fake.client, () => {}, options);
  const ws = open();
  const id = ws.integrations.saveServer({ name: "words", type: "http", url: remote.url });
  const view = (w = ws) => w.snapshot().mcpServers.find((s) => s.id === id);
  const ask = (reason = "initial", w = ws) => w.integrations.mcpAuth({ server: "words", url: remote.url, reason });
  return { remote, dir, ws, id, view, ask, open, opened, fake, files: () => readFileSync(join(dir, "workspace.json"), "utf8") + readFileSync(join(dir, "vault.json"), "utf8") };
}

test("the parameters of a sign-in challenge are read", () => {
  const header = 'Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp", scope="read write", error=invalid_token';
  assert.equal(challengeParam(header, "resource_metadata"), "https://a.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(challengeParam(header, "scope"), "read write");
  assert.equal(challengeParam(header, "error"), "invalid_token");
  assert.equal(challengeParam(header, "missing"), undefined);
  assert.equal(challengeParam(null, "scope"), undefined);
});

test("signing in registers Botkins, uses PKCE, and keeps the tokens in the vault only", async (t) => {
  const { remote, ws, id, view, ask, opened, files, open } = await setup(t);
  assert.deepEqual(view().auth, { type: "none" });
  assert.equal(await ask(), null, "before sign-in there is no token to give");
  const auth = await ws.integrations.signIn(id);
  assert.equal(auth.type, "oauth");
  assert.equal(auth.signedIn, true);
  assert.equal(auth.scope, "tools.read");
  assert.ok(auth.expiresAt > Date.now() + 3000_000);
  assert.equal(auth.canRenew, true);
  // What went to the server: a registration for this computer only, and a PKCE sign-in for this server.
  const registration = JSON.parse(remote.state.log.find((r) => r.path === "/register").body);
  assert.equal(registration.client_name, "Botkins");
  assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(registration.token_endpoint_auth_method, "none");
  const asked = new URL(opened[0]);
  assert.equal(asked.origin + asked.pathname, remote.origin + "/authorize");
  assert.equal(asked.searchParams.get("code_challenge_method"), "S256");
  assert.equal(asked.searchParams.get("resource"), remote.url);
  assert.equal(asked.searchParams.get("scope"), "tools.read");
  assert.ok(asked.searchParams.get("state").length >= 20 && asked.searchParams.get("code_challenge").length >= 40);
  const exchange = new URLSearchParams(remote.state.log.find((r) => r.path === "/token").body);
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.ok(exchange.get("code_verifier").length >= 43);
  assert.equal(exchange.get("resource"), remote.url);
  // The token is real: the server accepts it.
  const token = await ask();
  assert.equal(token.tokenType, "Bearer");
  assert.ok(remote.state.access.has(token.accessToken));
  assert.ok(token.expiresIn > 3000);
  // No token in the workspace file, in the vault's file as text, or on the page.
  for (const secret of [token.accessToken, ...remote.state.refresh.keys()]) {
    assert.ok(!files().includes(secret), "a token is stored as text");
    assert.ok(!JSON.stringify(ws.snapshot()).includes(secret), "a token reached the page");
  }
  assert.deepEqual(ws.vault.list().map((e) => [e.label, e.kind]), [["words sign-in", "oauth"]]);
  // A restart keeps the sign-in.
  const again = open();
  assert.equal(again.snapshot().mcpServers[0].auth.signedIn, true);
  assert.equal((await again.integrations.mcpAuth({ server: "words", url: remote.url, reason: "initial" })).accessToken, token.accessToken);
  // The token goes only to the address the person signed in to, and only for that server.
  assert.equal(await ws.integrations.mcpAuth({ server: "words", url: "https://evil.example/mcp", reason: "initial" }), null);
  assert.equal(await ws.integrations.mcpAuth({ server: "other", url: remote.url, reason: "initial" }), null);
  ws.integrations.setServerEnabled(id, false);
  assert.equal(await ask(), null, "a server that is switched off gets no token");
});

test("a token is renewed without the person, and a sign-in that has ended asks them back", async (t) => {
  const { remote, ws, id, view, ask } = await setup(t, { expiresIn: 30 });
  await ws.integrations.signIn(id);
  // Thirty seconds is inside the "about to end" window, so the first ask already renews it.
  const first = await ask();
  assert.equal(remote.state.log.filter((r) => r.path === "/token").length, 2);
  assert.ok(remote.state.access.has(first.accessToken));
  // The provider says the token was turned down: renew again. Refresh tokens rotate and the new one is kept.
  remote.state.expiresIn = 3600;
  const second = await ask("reauth");
  assert.notEqual(second.accessToken, first.accessToken);
  const third = await ask("refresh");
  assert.notEqual(third.accessToken, second.accessToken);
  assert.equal((await ask()).accessToken, third.accessToken, "a good token is reused");
  // Two asks at once renew once.
  const before = remote.state.log.filter((r) => r.path === "/token").length;
  const [a, b] = await Promise.all([ask("refresh"), ask("refresh")]);
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(remote.state.log.filter((r) => r.path === "/token").length, before + 1);
  // The sign-in is ended on the server (revoked): no token, and Settings says to sign in again.
  remote.state.refresh.clear();
  assert.equal(await ask("reauth"), null);
  assert.equal(view().auth.signedIn, false);
  assert.equal(view().auth.needsSignIn, true);
  assert.equal(await ask(), null);
  // Signing in again clears that.
  await ws.integrations.signIn(id);
  assert.equal(view().auth.signedIn, true);
  assert.equal(view().auth.needsSignIn, undefined);
  assert.ok((await ask()).accessToken);
  // A server that needs more permission than the sign-in has: the person signs in again.
  assert.equal(await ask("upscope"), null);
  assert.equal(view().auth.needsSignIn, true);
});

test("one Sign in uses the approved public client, exact callback and scopes without registration", async (t) => {
  const { remote, dir, ws, id, ask, opened, open } = await setup(t, {
    registration: false, staticClient: { id: "approved" }, scope: "all.tools",
  });
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const redirectUri = "http://127.0.0.1:" + probe.address().port + "/botkins/return";
  await new Promise((resolve) => probe.close(resolve));
  const file = join(dir, "approved.json");
  const previous = process.env.BOTKINS_MCP_OAUTH_CLIENTS_FILE;
  process.env.BOTKINS_MCP_OAUTH_CLIENTS_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.BOTKINS_MCP_OAUTH_CLIENTS_FILE;
    else process.env.BOTKINS_MCP_OAUTH_CLIENTS_FILE = previous;
  });
  const profile = { serverUrl: remote.url, issuer: remote.origin, clientId: "approved", redirectUri, scopes: ["tools.read", "user.read"] };
  const provision = (changes) => writeFileSync(file, JSON.stringify({ clients: [{ ...profile, ...changes }] }));
  provision({});
  assert.equal((await ws.integrations.signIn(id)).signedIn, true);
  assert.equal(opened.length, 1);
  const params = new URL(opened[0]).searchParams;
  assert.equal(params.get("client_id"), profile.clientId);
  assert.equal(params.get("redirect_uri"), redirectUri);
  assert.equal(params.get("scope"), "tools.read user.read");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.ok(params.get("state"));
  const exchange = new URLSearchParams(remote.state.log.find((r) => r.path === "/token").body);
  assert.equal(exchange.get("redirect_uri"), redirectUri);
  assert.ok(exchange.get("code_verifier"));
  assert.equal(exchange.has("client_secret"), false);
  assert.ok((await ask("refresh", open())).accessToken);
  assert.equal(remote.state.log.some((r) => r.path === "/register"), false);

  for (const changes of [
    { serverUrl: remote.url + "/other" }, { issuer: remote.origin + "/another-issuer" },
    { redirectUri: "https://outside.example/callback" }, { scopes: ["read write"] },
  ]) {
    provision(changes);
    await assert.rejects(ws.integrations.signIn(id), /administrator|server operator/i);
    assert.equal(opened.length, 1);
  }
  // A fixed registered callback cannot quietly move to a different port.
  provision({});
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(Number(new URL(redirectUri).port), "127.0.0.1", resolve));
  try {
    await assert.rejects(ws.integrations.signIn(id), /port/);
    assert.equal(opened.length, 1);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("a server that doesn't register apps takes a client ID entered by hand, with its secret in the vault", async (t) => {
  const { remote, ws, id, view, ask, files } = await setup(t, { registration: false, staticClient: { id: "botkins-desktop", secret: "client-s3cret" } }, { oauthPort: 0 });
  await assert.rejects(ws.integrations.signIn(id), /administrator or the server operator to configure an approved OAuth client/);
  assert.deepEqual(view().auth, { type: "none" }, "a failed sign-in changes nothing");
  assert.throws(() => ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientSecret: "x" } }), /A client secret needs its client ID/);
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "botkins-desktop", clientSecret: "client-s3cret", scope: "tools.read" } });
  assert.deepEqual(view().auth, { type: "oauth", signedIn: false, canRenew: false, signingIn: false, clientId: "botkins-desktop", scope: "tools.read", clientSecret: true });
  assert.ok(!files().includes("client-s3cret"));
  assert.ok(!JSON.stringify(ws.snapshot()).includes("client-s3cret"));
  await ws.integrations.signIn(id);
  assert.equal(view().auth.signedIn, true);
  assert.equal(remote.state.log.filter((r) => r.path === "/register").length, 0);
  // The secret went to the token endpoint in the Authorization header, not in the address.
  const exchange = remote.state.log.find((r) => r.path === "/token");
  assert.equal(Buffer.from(exchange.authorization.slice(6), "base64").toString(), "botkins-desktop:client-s3cret");
  // Renewal uses the same client.
  assert.ok((await ask("refresh")).accessToken);
  // Keeping the secret on an edit works; it never follows the server to another address or client.
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "botkins-desktop", clientSecret: null } });
  assert.equal(view().auth.clientSecret, true);
  assert.equal(view().auth.signedIn, true, "an edit that keeps the address keeps the sign-in");
  assert.throws(() => ws.integrations.saveServer({ id, name: "words", type: "http", url: "https://other.example/mcp", oauth: { clientId: "botkins-desktop", clientSecret: null } }), /Enter the client secret again/);
  assert.throws(() => ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "someone-else", clientSecret: null } }), /Enter the client secret again/);
  assert.throws(() => ws.integrations.saveServer({ id, name: "words", type: "http", url: "https://other.example/mcp" }), /Enter the client secret again/);
  // Turning sign-in off removes the tokens and the secret.
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: null });
  assert.deepEqual(view().auth, { type: "none" });
  assert.deepEqual(ws.vault.list(), []);
});

test("signing out forgets the tokens and tells the server; a new address needs a new sign-in", async (t) => {
  const { remote, ws, id, view, ask } = await setup(t);
  await ws.integrations.signIn(id);
  const token = await ask();
  await ws.integrations.signOut(id);
  assert.equal(view().auth.signedIn, false);
  assert.equal(await ask(), null);
  assert.ok(remote.state.log.some((r) => r.path === "/revoke"), "the server was told");
  assert.equal(remote.state.refresh.size, 0);
  assert.deepEqual(ws.vault.list(), []);
  assert.equal(view().auth.type, "oauth", "the server still signs in with OAuth");
  // Signed in again, then moved to another address: the sign-in doesn't follow.
  await ws.integrations.signIn(id);
  assert.ok((await ask()).accessToken !== token.accessToken);
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.origin + "/other" });
  assert.equal(view().auth.signedIn, false);
  assert.equal(await ws.integrations.mcpAuth({ server: "words", url: remote.origin + "/other", reason: "initial" }), null);
  // Removing a server removes everything it kept.
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url });
  await ws.integrations.signIn(id);
  assert.equal(ws.vault.list().length, 1);
  ws.integrations.removeServer(id);
  assert.deepEqual(ws.vault.list(), []);
});

test("a sign-in can be cancelled, refused by the person, or answered wrongly", async (t) => {
  // The browser never comes back: Cancel ends the wait.
  let release;
  const { remote, ws, id, view } = await setup(t, {}, { oauthPort: 0, openExternal: () => new Promise((resolve) => (release = resolve)) });
  // The outcome is watched from the start, so the cancel below never rejects a promise nobody holds.
  const cancelled = assert.rejects(ws.integrations.signIn(id), /Sign-in was cancelled/);
  // Wait for the browser to be asked, however long the steps before it take on this machine. A fixed
  // pause was too short on a slow one: the cancel then came before there was anything to release.
  for (let waited = 0; !release && waited < 10000; waited += 10) await tick(10);
  assert.equal(typeof release, "function", "the browser was asked to open the sign-in page");
  assert.equal(view().auth?.signingIn ?? ws.integrations.oauth.flows.has(id), true);
  await assert.rejects(ws.integrations.signIn(id), /already open in your browser/);
  assert.equal(ws.integrations.cancelSignIn(id), true);
  release();
  await cancelled;
  assert.deepEqual(view().auth, { type: "none" });
  // The person chooses Deny on the server's page.
  remote.state.authorize = "deny";
  ws.openExternal = remote.browser;
  await assert.rejects(ws.integrations.signIn(id), /Sign-in was cancelled/);
  remote.state.authorize = "allow";
  // An answer with the wrong state is turned away, and the real one still completes the sign-in.
  ws.openExternal = async (url) => {
    const first = await fetch(url, { redirect: "manual" });
    const back = new URL(first.headers.get("location"));
    const forged = new URL(back);
    forged.searchParams.set("state", "forged");
    forged.searchParams.set("code", "stolen");
    assert.equal((await fetch(forged)).status, 400);
    assert.equal((await fetch(back.origin + "/other")).status, 404);
    await fetch(back);
  };
  await ws.integrations.signIn(id);
  assert.equal(view().auth.signedIn, true);
});

test("sign-in is only for secure addresses, and a busy port is worked around", async (t) => {
  const { remote, ws, id } = await setup(t, {}, { oauthPort: undefined });
  // A plain http address that isn't this computer never gets a sign-in.
  const lan = ws.integrations.saveServer({ name: "lan", type: "http", url: "http://192.168.1.20:8080/mcp" });
  await assert.rejects(ws.integrations.signIn(lan), /needs a secure \(https\) server address/);
  const local = ws.integrations.saveServer({ name: "local", command: "npx" });
  await assert.rejects(ws.integrations.signIn(local), /signs in with its environment values/);
  // Something else holds Botkins' usual port: a self-registered sign-in uses another one.
  const blocker = createServer(() => {});
  const taken = await new Promise((resolve) => blocker.listen(REDIRECT_PORT, "127.0.0.1", () => resolve(true)).once("error", () => resolve(false)));
  t.after(() => blocker.close());
  ws.openExternal = remote.browser;
  await ws.integrations.signIn(id);
  const redirect = JSON.parse(remote.state.log.find((r) => r.path === "/register").body).redirect_uris[0];
  if (taken) assert.notEqual(new URL(redirect).port, String(REDIRECT_PORT));
  assert.equal(ws.snapshot().mcpServers.find((s) => s.id === id).auth.signedIn, true);
});

test("a session passes the provider's sign-in question to the vault", async (t) => {
  const { remote, ws, id, fake } = await setup(t);
  await ws.integrations.signIn(id);
  const chat = ws.createChat("pip");
  await ws.send(chat, "Hi");
  const config = fake.log.configs.get(chat);
  assert.deepEqual(config.mcp.servers.words, { type: "http", url: remote.url, headers: {}, tools: ["*"] }, "no token is written into the server's settings");
  // The runtime asks in its own words; the adapter answers in the runtime's shape.
  const answer = await config.mcp.onAuthRequest({ requestId: "r1", serverName: "words", serverUrl: remote.url, reason: "initial", wwwAuthenticateParams: { scope: "tools.read" } }, { sessionId: chat });
  assert.equal(answer.kind, "token");
  assert.ok(remote.state.access.has(answer.accessToken));
  assert.equal(answer.tokenType, "Bearer");
  assert.deepEqual(await config.mcp.onAuthRequest({ requestId: "r2", serverName: "unknown", serverUrl: remote.url, reason: "initial" }, { sessionId: chat }), { kind: "cancelled" });
  await ws.integrations.signOut(id);
  assert.deepEqual(await config.mcp.onAuthRequest({ requestId: "r3", serverName: "words", serverUrl: remote.url, reason: "refresh" }, { sessionId: chat }), { kind: "cancelled" });
});

// ---- What a server says about its own sign-in is checked before it is believed (code review).
import { McpOAuth, zone } from "../desktop/oauth.mjs";
import { Vault } from "../desktop/vault.mjs";

/** A sign-in client whose network is a table of answers: { "GET https://…": body | { status, headers, body } }. */
function offline(t, table) {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const key = (init.method ?? "GET") + " " + url;
    asked.push(key);
    const hit = table[key] ?? table[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit instanceof Error) throw hit;
    const { status = 200, headers = {}, body = hit } = hit.status || hit.headers ? hit : {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  const oauth = new McpOAuth({ vault: new Vault(tempDir(t)), open: async () => {}, fetch: fetcher, port: 0 });
  return { oauth, asked };
}
const asMeta = (issuer, extra = {}) => ({
  issuer,
  authorization_endpoint: issuer + "/authorize",
  token_endpoint: issuer + "/token",
  registration_endpoint: issuer + "/register",
  code_challenge_methods_supported: ["S256"],
  ...extra,
});

test("hosts are placed by how far inside the network they are", () => {
  for (const host of ["localhost", "127.0.0.1", "127.5.5.5", "[::1]", "app.localhost"]) assert.equal(zone(host), 2, host);
  for (const host of ["10.0.0.5", "192.168.1.20", "172.16.0.1", "172.31.255.1", "169.254.1.1", "intranet", "printer.local", "db.internal", "[fd00::1]", "[fe80::1]"]) assert.equal(zone(host), 1, host);
  for (const host of ["example.com", "172.32.0.1", "8.8.8.8", "mcp.linear.app", "[2001:db8::1]"]) assert.equal(zone(host), 0, host);
});

test("a server can't pass off another service's sign-in as its own", async (t) => {
  const evil = { id: "e", name: "evil", url: "https://evil.example/mcp" };
  // Its challenge points at another service's description: that description is about the other service, so it is ignored.
  const borrowed = offline(t, {
    "POST https://evil.example/mcp": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://victim.example/.well-known/oauth-protected-resource"' }, body: "" },
    "https://victim.example/.well-known/oauth-protected-resource": { resource: "https://victim.example/mcp", authorization_servers: ["https://auth.victim.example"] },
    "https://auth.victim.example/.well-known/oauth-authorization-server": asMeta("https://auth.victim.example"),
  });
  const found = await borrowed.oauth.discover(evil);
  assert.equal(found.issuer, "https://evil.example", "with no description of its own, only its own host can be its sign-in server");
  assert.equal(found.resource, "https://evil.example/mcp");
  assert.ok(!borrowed.asked.some((a) => a.includes("auth.victim.example")), "the other service's sign-in server is never contacted");
  // A sign-in server's description must name the address it was fetched from.
  const lying = offline(t, {
    "https://evil.example/.well-known/oauth-protected-resource/mcp": { resource: "https://evil.example/mcp", authorization_servers: ["https://auth.evil.example"] },
    "https://auth.evil.example/.well-known/oauth-authorization-server": asMeta("https://login.honest.example"),
  });
  await assert.rejects(lying.oauth.discover(evil), /sign-in information is missing or doesn't match its address/);
  // The page the person signs in on must be on the sign-in server: it can't be borrowed from an honest one.
  const mixed = offline(t, {
    "https://evil.example/.well-known/oauth-protected-resource/mcp": { resource: "https://evil.example/mcp", authorization_servers: ["https://auth.evil.example"] },
    "https://auth.evil.example/.well-known/oauth-authorization-server": asMeta("https://auth.evil.example", { authorization_endpoint: "https://login.honest.example/authorize" }),
  });
  await assert.rejects(mixed.oauth.discover(evil), /sign-in page is on a different site than its sign-in server/);
  // An honest setup with the token address on another host (as some large providers have) is fine.
  const split = offline(t, {
    "https://mcp.good.example/.well-known/oauth-protected-resource/v1": { resource: "https://mcp.good.example/v1", authorization_servers: ["https://accounts.good.example/"], scopes_supported: ["a", "b"] },
    "https://accounts.good.example/.well-known/oauth-authorization-server": asMeta("https://accounts.good.example", { token_endpoint: "https://tokens.good-apis.example/token" }),
  });
  const good = await split.oauth.discover({ id: "g", name: "good", url: "https://mcp.good.example/v1?key=abc" });
  assert.deepEqual([good.issuer, good.meta.token_endpoint, good.scope, good.resource], ["https://accounts.good.example", "https://tokens.good-apis.example/token", "a b", "https://mcp.good.example/v1"]);
  assert.ok(!good.resource.includes("key=abc"), "nothing after ? goes into what the token is asked for");
});

test("a server on the internet can't send Botkins into the local network or this computer", async (t) => {
  const remote = { id: "r", name: "remote", url: "https://remote.example/mcp" };
  for (const inside of ["http://127.0.0.1:8123/token", "https://10.0.0.5/token", "https://intranet/token", "https://user:pw@remote.example/token"]) {
    const { oauth } = offline(t, {
      "https://remote.example/.well-known/oauth-protected-resource/mcp": { resource: "https://remote.example/mcp", authorization_servers: ["https://remote.example"] },
      "https://remote.example/.well-known/oauth-authorization-server": asMeta("https://remote.example", { token_endpoint: inside }),
    });
    await assert.rejects(oauth.discover(remote), /isn't a secure \(https\) address|points inside your own network|invalid token address/, inside);
  }
  // Nor through a redirect, and a sign-in server named inside the network is not even asked.
  const hop = offline(t, {
    "https://remote.example/.well-known/oauth-protected-resource/mcp": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, body: "" },
    "https://remote.example/.well-known/oauth-protected-resource": { resource: "https://remote.example/mcp", authorization_servers: ["https://192.168.1.1"] },
  });
  await assert.rejects(hop.oauth.discover(remote), /points inside your own network/);
  assert.ok(!hop.asked.some((a) => /169\.254|192\.168/.test(a)), "no request left for an inside address: " + hop.asked.join(", "));
  // A server inside the network may use a sign-in server there, but still not this computer.
  const lan = { id: "l", name: "lan", url: "https://tools.internal/mcp" };
  const inside = offline(t, {
    "https://tools.internal/.well-known/oauth-protected-resource/mcp": { resource: "https://tools.internal/mcp", authorization_servers: ["https://login.internal"] },
    "https://login.internal/.well-known/oauth-authorization-server": asMeta("https://login.internal"),
  });
  assert.equal((await inside.oauth.discover(lan)).issuer, "https://login.internal");
  const toSelf = offline(t, {
    "https://tools.internal/.well-known/oauth-protected-resource/mcp": { resource: "https://tools.internal/mcp", authorization_servers: ["https://login.internal"] },
    "https://login.internal/.well-known/oauth-authorization-server": asMeta("https://login.internal", { registration_endpoint: "http://localhost:2375/containers/create" }),
  });
  await assert.rejects(toSelf.oauth.discover(lan), /isn't a secure \(https\) address/);
  // An answer far larger than a sign-in needs is refused rather than read into memory.
  const huge = offline(t, { "https://remote.example/.well-known/oauth-protected-resource/mcp": "x".repeat(1_200_000) });
  await assert.rejects(huge.oauth.json("https://remote.example/.well-known/oauth-protected-resource/mcp", undefined, { limit: 0 }), /too large/);
});

test("the address that receives the browser's answer can't be crashed or fooled by another page", async (t) => {
  const { remote, ws, id, view } = await setup(t);
  let port;
  ws.openExternal = async (url) => {
    const first = await fetch(url, { redirect: "manual" });
    const back = new URL(first.headers.get("location"));
    port = back.port;
    const { connect } = await import("node:net");
    const raw = (text) =>
      new Promise((resolve) => {
        const socket = connect(Number(port), "127.0.0.1", () => socket.write(text));
        let answer = "";
        socket.on("data", (chunk) => (answer += chunk));
        socket.on("close", () => resolve(answer));
        socket.on("error", () => resolve(answer));
        setTimeout(() => socket.destroy(), 500);
      });
    // A request line no URL can be made of, a wrong Host (a page that reached this port under another name), and garbage.
    assert.match(await raw("GET // HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 4\d\d/);
    assert.match(await raw("GET /callback?code=x&state=y HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 400/);
    await raw("\x00\x01 not http at all\r\n\r\n");
    assert.equal((await fetch(back.origin + "/callback?state=wrong&code=1")).status, 400);
    // After all that, the real answer still finishes the sign-in.
    await fetch(back);
  };
  await ws.integrations.signIn(id);
  assert.equal(view().auth.signedIn, true);
  assert.ok(remote.state.access.size > 0);
});

test("a client secret goes only to the sign-in server it was first used with", async (t) => {
  const { remote, ws, id, view } = await setup(t, { registration: false, staticClient: { id: "desk", secret: "client-s3cret" } });
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "desk", clientSecret: "client-s3cret" } });
  await ws.integrations.signIn(id);
  assert.equal(ws.integrations.server(id).oauth.boundTo, remote.origin);
  // The server now names another token address (it was taken over, or just changed): the secret doesn't follow.
  const other = await oauthMcpServer({ registration: false, staticClient: { id: "desk", secret: "anything" } });
  t.after(() => other.close());
  remote.state.tweak.server = (doc) => ({ ...doc, token_endpoint: other.origin + "/token" });
  await assert.rejects(ws.integrations.signIn(id), /now signs in at 127\.0\.0\.1:\d+, not where its client secret was first used/);
  assert.ok(!other.state.log.some((r) => r.path === "/token"), "nothing was sent to the new address");
  assert.equal(view().auth.signedIn, true, "the earlier sign-in is untouched");
  // Entering the secret again accepts the new sign-in server: the sign-in now goes there. (This
  // stand-in pair shares no codes, so the exchange itself fails, which leaves the secret unbound.)
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "desk", clientSecret: "anything" } });
  assert.equal(ws.integrations.server(id).oauth.boundTo, undefined);
  await assert.rejects(ws.integrations.signIn(id), /The code or its verifier is wrong/);
  assert.ok(other.state.log.some((r) => r.path === "/token"), "the newly entered secret was allowed to go to the new address");
  assert.equal(ws.integrations.server(id).oauth.boundTo, undefined, "a sign-in that failed binds nothing");
  // Back at its own sign-in server, a new secret binds there, and keeping it on a later edit keeps the binding.
  remote.state.tweak.server = undefined;
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "desk", clientSecret: "client-s3cret" } });
  await ws.integrations.signIn(id);
  assert.equal(ws.integrations.server(id).oauth.boundTo, remote.origin);
  ws.integrations.saveServer({ id, name: "words", type: "http", url: remote.url, oauth: { clientId: "desk", clientSecret: null } });
  assert.equal(ws.integrations.server(id).oauth.boundTo, remote.origin);
});

test("an answer from the wrong sign-in server is refused, and a registration is reused only where it was made", async (t) => {
  const { remote, ws, id, view } = await setup(t);
  // The answer names another server than the one asked (RFC 9207).
  remote.state.tweak.callback = (url) => (url.searchParams.set("iss", "https://someone-else.example"), url);
  await assert.rejects(ws.integrations.signIn(id), /came from a different server than the one asked/);
  assert.deepEqual(view().auth, { type: "none" });
  // A server that says it names itself must do so.
  remote.state.tweak.callback = undefined;
  remote.state.tweak.server = (doc) => ({ ...doc, authorization_response_iss_parameter_supported: true });
  await assert.rejects(ws.integrations.signIn(id), /came from a different server/);
  remote.state.tweak.callback = (url) => (url.searchParams.set("iss", remote.origin), url);
  await ws.integrations.signIn(id);
  assert.equal(view().auth.signedIn, true);
  // Signing in again where the registration was made reuses it; with another token address it registers anew.
  const registrations = () => remote.state.log.filter((r) => r.path === "/register").length;
  const before = registrations();
  ws.oauthPortFixed = true;
  await ws.integrations.signIn(id);
  remote.state.tweak.server = (doc) => ({ ...doc, authorization_response_iss_parameter_supported: true, token_endpoint: remote.origin + "/token?v=2" });
  await ws.integrations.signIn(id).catch(() => {});
  assert.ok(registrations() > before, "a registration isn't carried to a different token address");
});

test("a renewal that fails for now doesn't end the sign-in", async (t) => {
  const { remote, ws, id, view, ask } = await setup(t, { expiresIn: 45 });
  await ws.integrations.signIn(id);
  // The sign-in server is down. The token still has 45 seconds: it is handed out, and nothing is marked as ended.
  remote.state.tokenStatus = 503;
  const token = await ask();
  assert.ok(remote.state.access.has(token.accessToken));
  assert.equal(view().auth.signedIn, true);
  assert.equal(view().auth.needsSignIn, undefined);
  // The server turned the token down and it can't be renewed right now: no token this time, but still no sign-in asked for.
  assert.equal(await ask("reauth"), null);
  assert.equal(view().auth.needsSignIn, undefined);
  // When the sign-in server is back, the renewal goes through.
  remote.state.tokenStatus = null;
  assert.notEqual((await ask("refresh")).accessToken, token.accessToken);
});

// ---- The spelling of a bearer token. Composio refuses "Authorization: bearer <token>" (401, "no
// Authorization: Bearer header"), so a bearer token is always handed out as "Bearer".

test("a bearer token is always spelled Bearer, and another kind of token is left alone", () => {
  for (const type of ["bearer", "BEARER", " Bearer ", "Bearer", undefined, null, "", "  ", 7, {}]) assert.equal(scheme(type), "Bearer", JSON.stringify(type));
  assert.equal(scheme("DPoP"), "DPoP");
  assert.equal(scheme(" DPoP "), "DPoP");
});

test("a server that says token_type bearer in lower case still gets a Bearer header, also after a renewal", async (t) => {
  const { remote, ws, id, ask } = await setup(t, { tokenType: "bearer" });
  await ws.integrations.signIn(id);
  const first = await ask();
  assert.equal(first.tokenType, "Bearer");
  // The stand-in's /mcp wants "Bearer " exactly: a request made the way a session makes it is let in.
  const call = (token) => fetch(remote.url, { method: "POST", headers: { "content-type": "application/json", authorization: token.tokenType + " " + token.accessToken }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await call(first)).status, 200);
  // A renewed token is spelled the same way.
  const renewed = await ask("refresh");
  assert.notEqual(renewed.accessToken, first.accessToken);
  assert.equal(renewed.tokenType, "Bearer");
  assert.equal((await call(renewed)).status, 200);
});

test("a sign-in saved earlier with the type bearer is handed out as Bearer", async (t) => {
  const { remote, ws, id, ask } = await setup(t);
  await ws.integrations.signIn(id);
  const server = ws.integrations.server(id);
  const saved = ws.integrations.oauth.read(server);
  ws.integrations.oauth.write(server, { ...saved, tokenType: "bearer" });
  assert.equal(ws.integrations.oauth.read(server).tokenType, "bearer", "the old spelling is what is on disk");
  const token = await ask();
  assert.equal(token.tokenType, "Bearer");
  assert.equal(token.accessToken, saved.accessToken);
  assert.ok(remote.state.access.has(token.accessToken));
});

test("a session puts the sign-in token on an http server, and on no other", async () => {
  const mcpAuth = async () => ({ accessToken: "tok", tokenType: "Bearer" });
  const servers = {
    web: { type: "http", url: "https://a.example/mcp", headers: { "X-Team": "x" } },
    bare: { type: "http", url: "https://b.example/mcp" },
    local: { type: "stdio", command: "node", args: ["x.js"] },
    own: { type: "http", url: "https://c.example/mcp", headers: { authorization: "Bearer mine" } },
    shouted: { type: "http", url: "https://d.example/mcp", headers: { AUTHORIZATION: "Basic abc" } },
  };
  const out = await serversWithTokens({ mcpServers: servers, mcpAuth });
  assert.deepEqual(out.web.headers, { "X-Team": "x", Authorization: "Bearer tok" });
  assert.deepEqual(out.bare.headers, { Authorization: "Bearer tok" });
  // A local server and a server that already has an Authorization header (in any letter case) are not touched.
  for (const name of ["local", "own", "shouted"]) assert.equal(out[name], servers[name], name);
  // With no sign-in to give, nothing changes.
  const none = await serversWithTokens({ mcpServers: servers, mcpAuth: async () => null });
  for (const name of Object.keys(servers)) assert.equal(none[name], servers[name], name);
});
