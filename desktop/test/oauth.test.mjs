// Signing in to a remote MCP server with OAuth (desktop/oauth.mjs, desktop/integrations.mjs),
// against the local stand-in server in test/oauth-server.mjs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as listening } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { accountOf, challengeParam, REDIRECT_PORT, scheme } from "../desktop/oauth.mjs";
import { serversWithTokens } from "../desktop/providers/sessions.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";
import { PHONE_REDIRECT, phoneSignIns } from "../desktop/phone-signin.mjs";

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
  // Something else holds the port Botkins answers a sign-in on. A port this test asked the system
  // for stands in for the app's usual one: no test listens on REDIRECT_PORT itself, because the
  // installed app on the same computer answers its own sign-ins there.
  const blocker = createServer(() => {});
  await new Promise((resolve, reject) => blocker.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const usual = blocker.address().port;
  assert.notEqual(usual, REDIRECT_PORT);
  const { remote, ws, id } = await setup(t, {}, { oauthPort: usual });
  assert.equal(ws.integrations.oauth.port, usual);
  // Without a port of its own, the app uses its usual one. Nothing is opened to find that out.
  assert.equal(new Workspace(tempDir(t), fakeClient().client, () => {}).integrations.oauth.port, REDIRECT_PORT);
  // A plain http address that isn't this computer never gets a sign-in.
  const lan = ws.integrations.saveServer({ name: "lan", type: "http", url: "http://192.168.1.20:8080/mcp" });
  await assert.rejects(ws.integrations.signIn(lan), /needs a secure \(https\) server address/);
  const local = ws.integrations.saveServer({ name: "local", command: "npx" });
  await assert.rejects(ws.integrations.signIn(local), /signs in with its environment values/);
  // With the usual port held, a self-registered sign-in uses another one.
  ws.openExternal = remote.browser;
  await ws.integrations.signIn(id);
  const redirect = JSON.parse(remote.state.log.find((r) => r.path === "/register").body).redirect_uris[0];
  assert.notEqual(new URL(redirect).port, String(usual));
  assert.notEqual(new URL(redirect).port, String(REDIRECT_PORT));
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

// ---- A sign-in whose browser is on another device (a terminal host): the person copies the address
// the browser was sent back to and gives it to `answer()`. It is judged as the browser's own answer is.

/**
 * Starts a sign-in with an `open` of its own that visits nothing, and plays the person's browser on
 * another device: it fetches the sign-in page itself and keeps the address the browser would be sent
 * back to. `done` is the sign-in; `back` is that address.
 */
async function otherDevice(t, serverOptions, signInOptions = {}) {
  const env = await setup(t, serverOptions);
  let shown;
  const page = new Promise((resolve) => (shown = resolve));
  const done = env.ws.integrations.signIn(env.id, { open: async (address, { redirect }) => shown({ address, redirect }), ...signInOptions });
  done.catch(() => {});
  const { address, redirect } = await page;
  const first = await fetch(address, { redirect: "manual" });
  const back = first.headers.get("location");
  assert.ok(back, "the sign-in server sent the browser back");
  const params = new URL(back).searchParams;
  return { ...env, done, address, redirect, back, code: params.get("code"), state: params.get("state"), answer: (text) => env.ws.integrations.answerSignIn(env.id, text), open: () => env.ws.integrations.oauth.flows.has(env.id) };
}
/** The pasted address with one change. */
const changed = (back, change) => {
  const url = new URL(back);
  change(url);
  return url.href;
};

test("a pasted address is taken only when it is the address this sign-in named, and every other one leaves the sign-in open", async (t) => {
  const { remote, ws, id, view, done, back, redirect, code, state, answer, open, opened, files } = await otherDevice(t);
  assert.equal(opened.length, 0, "no browser was opened on this computer");
  assert.equal(redirect, new URL(back).origin + new URL(back).pathname, "the address that the browser was sent to is the one the sign-in named");
  const refusals = [];
  const refused = (text, said) => {
    // An address that is turned away has no code of its own: the sign-in is open still, and the caller says so.
    assert.throws(() => answer(text), (error) => (refusals.push(error.message), said.test(error.message) && error.code === undefined), String(text).slice(0, 60));
    assert.equal(open(), true, "the sign-in is open still");
  };
  // Another place: another port or host, another path, another scheme.
  refused(changed(back, (url) => (url.port = String(Number(url.port) + 1))), /not the address this sign-in sends the browser back to/);
  refused(changed(back, (url) => (url.hostname = "localhost")), /not the address this sign-in sends the browser back to/);
  refused(changed(back, (url) => (url.pathname = "/elsewhere")), /not the address this sign-in sends the browser back to/);
  refused(changed(back, (url) => (url.protocol = "https:")), /not the address this sign-in sends the browser back to/);
  // The mark is compared as a whole: one of the same length that differs, and one that is the start of the right one.
  refused(changed(back, (url) => url.searchParams.set("state", "x".repeat(state.length))), /not the answer to this sign-in/);
  refused(changed(back, (url) => url.searchParams.set("state", state.slice(0, -1))), /not the answer to this sign-in/);
  refused(changed(back, (url) => url.searchParams.set("state", state + "x")), /not the answer to this sign-in/);
  // The right place with the mark of another sign-in, with none, and with no code.
  refused(changed(back, (url) => url.searchParams.set("state", "from-another-sign-in")), /not the answer to this sign-in/);
  refused(changed(back, (url) => url.searchParams.delete("state")), /not the answer to this sign-in/);
  refused(changed(back, (url) => url.searchParams.delete("code")), /no code in it/);
  // Not an address at all, nothing, and far too much.
  refused("this is not an address", /not a web address/);
  refused("", /not a web address/);
  refused("http://127.0.0.1:1/callback?" + "x".repeat(9000), /not a web address/);
  // What was said about each refusal never has the code or the mark of this sign-in.
  for (const said of refusals) for (const secret of [code, state]) assert.equal(said.includes(secret), false, said);
  assert.equal(remote.state.log.some((r) => r.path === "/token"), false, "nothing went to the token address for an address that was turned away");
  // With spaces around it, as a copy from a terminal has it, the right one finishes the sign-in.
  answer("  " + back + "\n");
  // The first answer ends the sign-in: another one now is not taken, and says so (its own code, not "turned away").
  assert.throws(() => answer(back), (error) => error.code === "ANSWERED" && /has its answer already/.test(error.message));
  const auth = await done;
  assert.equal(auth.signedIn, true);
  assert.equal(view().auth.signedIn, true);
  assert.deepEqual(ws.vault.list().map((entry) => [entry.label, entry.kind]), [["words sign-in", "oauth"]]);
  assert.equal(open(), false, "the sign-in is over");
  // The code was used with the secret this computer made for this sign-in, once.
  const exchange = new URLSearchParams(remote.state.log.find((r) => r.path === "/token").body);
  assert.equal(exchange.get("code"), code);
  assert.ok(exchange.get("code_verifier").length >= 43);
  assert.equal(remote.state.log.filter((r) => r.path === "/token").length, 1);
  assert.equal(files().includes(code) || files().includes(state), false, "neither the code nor the mark is kept");
  // Nothing is waiting any more.
  assert.throws(() => answer(back), (error) => error.code === "NO_SIGN_IN" && /No sign-in is waiting/.test(error.message));
});

test("an address that says access was denied ends the sign-in as cancelled, and one with nothing open is turned away", async (t) => {
  const { ws, id, view, done, back, answer, open } = await otherDevice(t);
  answer(changed(back, (url) => (url.searchParams.delete("code"), url.searchParams.set("error", "access_denied"))));
  await assert.rejects(done, /Sign-in was cancelled\./);
  assert.ok(!view().auth.signedIn);
  assert.equal(open(), false);
  assert.throws(() => answer(back), /No sign-in is waiting for that address/);
  // The same for a sign-in that was never started, and for a server that is not there.
  assert.throws(() => ws.integrations.answerSignIn(id, back), (error) => error.code === "NO_SIGN_IN");
  assert.throws(() => ws.integrations.answerSignIn("nobody", back));
  // Another kind of error says what the server said, in a few words.
  const second = await otherDevice(t);
  second.answer(changed(second.back, (url) => (url.searchParams.delete("code"), url.searchParams.set("error", "server_error"), url.searchParams.set("error_description", "The server broke"))));
  await assert.rejects(second.done, /Sign-in failed: The server broke/);
  // An error with another sign-in's mark is not an answer to this one: it ends nothing.
  const third = await otherDevice(t);
  assert.throws(() => third.answer(changed(third.back, (url) => (url.searchParams.delete("code"), url.searchParams.set("error", "access_denied"), url.searchParams.set("state", "other")))), /not the answer to this sign-in/);
  assert.equal(third.open(), true);
  third.ws.integrations.cancelSignIn(third.id);
  await assert.rejects(third.done, /Sign-in was cancelled/);
});

test("a phone's browser can do a tool's sign-in for a computer with none: it comes back to the app's address, and the computer trades it", async (t) => {
  const { remote, ws, id, view, opened } = await setup(t);
  const phone = phoneSignIns(() => ws.integrations);
  const { url, redirect } = await phone.start(id);
  assert.equal(redirect, PHONE_REDIRECT);
  assert.equal(opened.length, 0, "nothing opens on the computer");
  assert.equal(new URL(url).searchParams.get("redirect_uri"), PHONE_REDIRECT, "the sign-in server sends the browser back to the phone app");
  const registered = remote.state.log.find((r) => r.path === "/register");
  assert.deepEqual(JSON.parse(registered.body).redirect_uris, [PHONE_REDIRECT]);
  const back = (await fetch(url, { redirect: "manual" })).headers.get("location");
  assert.ok(back.startsWith(PHONE_REDIRECT + "?"));
  // Another app's address, or the computer's own, is not this sign-in's answer.
  await assert.rejects(phone.finish(id, back.replace("botkins://", "evil://")), /not the address this sign-in sends the browser back to/);
  await assert.rejects(phone.finish(id, back.replace(PHONE_REDIRECT, "http://127.0.0.1:47823/callback")), /not the address this sign-in sends the browser back to/);
  const auth = await phone.finish(id, back);
  assert.equal(auth.signedIn, true);
  assert.equal(view().auth.signedIn, true);
  const exchange = new URLSearchParams(remote.state.log.find((r) => r.path === "/token").body);
  assert.equal(exchange.get("redirect_uri"), PHONE_REDIRECT);
  await assert.rejects(phone.finish(id, back), /No sign-in is waiting/);
  // A sign-in the phone closed is cancelled on the computer.
  await phone.start(id);
  phone.cancel(id);
  await tick();
  assert.equal(ws.integrations.oauth.flows.has(id), false);
});

test("the sign-in server's name in a pasted address is checked as in the browser's own answer", async (t) => {
  const supported = { tweak: { server: (doc) => ({ ...doc, authorization_response_iss_parameter_supported: true }) } };
  // A server that says it names itself, and an address with no name.
  const none = await otherDevice(t, supported);
  none.answer(none.back);
  await assert.rejects(none.done, /came from a different server than the one asked/);
  assert.ok(!none.view().auth.signedIn);
  // An address with another server's name.
  const other = await otherDevice(t, supported);
  other.answer(changed(other.back, (url) => url.searchParams.set("iss", "https://someone-else.example")));
  await assert.rejects(other.done, /came from a different server than the one asked/);
  assert.equal(other.remote.state.log.some((r) => r.path === "/token"), false, "a code from another server is not sent anywhere");
  // With the right name it finishes.
  const right = await otherDevice(t, supported);
  right.answer(changed(right.back, (url) => url.searchParams.set("iss", right.remote.origin)));
  assert.equal((await right.done).signedIn, true);
});

test("a sign-in in a terminal host waits as long as it was given, and no longer", async (t) => {
  const { ws, id, view } = await setup(t);
  const started = Date.now();
  // Nobody answers: the wait is the one given (50 ms), not the five minutes of the window's own sign-in.
  await assert.rejects(ws.integrations.signIn(id, { open: async () => {}, patience: 50 }), /Sign-in timed out\. Try again\./);
  assert.ok(Date.now() - started < 5000);
  assert.equal(ws.integrations.oauth.flows.has(id), false, "the sign-in is over and its port is free");
  assert.ok(!view().auth.signedIn);
  // Without a patience the window's own wait stays (no browser opens here: it is answered through the stand-in).
  assert.equal((await ws.integrations.signIn(id)).signedIn, true);
});

// ---- Which account, a sign-in that replaces one, a cancel at any time, the one port, and a kept registration.

/** A port the system gives (never a fixed number): it is free when this returns. */
const freePort = () =>
  new Promise((resolve) => {
    const server = listening();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const until = async (check, what) => {
  for (let waited = 0; waited < 5000; waited += 10) {
    if (check()) return;
    await tick(10);
  }
  throw new Error("never saw: " + what);
};
const jwt = (claims) => "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".c2ln";
/**
 * A sign-in that shows its page and waits, for a test that plays the person. `go()` fetches the page (as a browser on
 * another device) and gives the address the browser is sent back to.
 */
function waits(ws, id, extra = {}) {
  let shown;
  const page = new Promise((resolve) => (shown = resolve));
  const done = ws.integrations.signIn(id, { open: async (address, { redirect }) => shown({ address, redirect }), ...extra });
  done.catch(() => {});
  return { done, page, go: async () => (await fetch((await page).address, { redirect: "manual" })).headers.get("location") };
}

test("the account is the email that the sign-in server says in its id token, and no other word, and the token is not kept", () => {
  assert.equal(accountOf({ id_token: jwt({ email: "sam@example.com", preferred_username: "sam", name: "Sam" }) }), "sam@example.com");
  assert.equal(accountOf({ id_token: jwt({ email: "  sam@example.com  " }) }), "sam@example.com");
  assert.equal(accountOf({ id_token: jwt({ email: "x".repeat(300) }) }).length, 120);
  // A name and a user name are chosen by whoever owns the account: they can say anything, even the name of somebody else. They are no account.
  assert.equal(accountOf({ id_token: jwt({ preferred_username: "sam", name: "Sam" }) }), null);
  assert.equal(accountOf({ id_token: jwt({ name: "Sam Example" }) }), null);
  // The server's own word is taken as text only: a number, a list and an empty word are no account.
  assert.equal(accountOf({ id_token: jwt({ email: 5, name: ["x"], preferred_username: "  " }) }), null);
  assert.equal(accountOf({ id_token: jwt({ email: "   " }) }), null);
  for (const bad of [undefined, {}, { id_token: 5 }, { id_token: "not.a.jwt" }, { id_token: "a.b" }, { id_token: "e30.!!!.c2ln" }, { id_token: jwt(null) }, { id_token: jwt([1]) }]) assert.equal(accountOf(bad), null);
});

test("a sign-in says the account that the server names, and whether it replaced one, and keeps no id token", async (t) => {
  const claims = { email: "sam@example.com", name: "Sam Example", sub: "subject-1" };
  const { ws, id, files } = await setup(t, { idToken: claims });
  const seen = [];
  await ws.integrations.signIn(id, { finished: (outcome) => seen.push(outcome) });
  await ws.integrations.signIn(id, { finished: (outcome) => seen.push(outcome) });
  assert.deepEqual(seen, [{ account: "sam@example.com", again: false }, { account: "sam@example.com", again: true }]);
  const saved = JSON.stringify(ws.integrations.oauth.read(ws.integrations.server(id)));
  for (const kept of [saved, files()]) for (const secret of [jwt(claims).split(".")[1], "sam@example.com", "subject-1", "id_token"]) assert.equal(kept.includes(secret), false, "the id token is kept: " + secret);
  // A server that sends none: no account, and the sign-in is as before.
  const none = await setup(t);
  const outcome = [];
  assert.equal((await none.ws.integrations.signIn(none.id, { finished: (value) => outcome.push(value) })).signedIn, true);
  assert.deepEqual(outcome, [{ account: null, again: false }]);
});

test("a sign-in that is cancelled once the address was taken writes nothing and leaves an earlier sign-in as it was", async (t) => {
  const { remote, ws, id } = await setup(t);
  await ws.integrations.signIn(id);
  const server = ws.integrations.server(id);
  const earlier = ws.integrations.oauth.read(server).accessToken;
  const tokenRequests = () => remote.state.log.filter((entry) => entry.path === "/token").length;
  // (1) The cancel comes right after the address was given, before the token request is made: none is made.
  const first = waits(ws, id);
  ws.integrations.answerSignIn(id, await first.go());
  assert.equal(ws.integrations.cancelSignIn(id), true);
  await assert.rejects(first.done, /Sign-in was cancelled\./);
  assert.equal(tokenRequests(), 1, "no token was asked for");
  // (2) The cancel comes while the sign-in server holds its answer: the sign-in ends at once, and the answer, when it comes, is dropped.
  let release;
  remote.state.tokenGate = new Promise((resolve) => (release = resolve));
  const second = waits(ws, id);
  ws.integrations.answerSignIn(id, await second.go());
  await until(() => tokenRequests() === 2, "the token request");
  assert.equal(ws.integrations.cancelSignIn(id), true);
  await assert.rejects(second.done, /Sign-in was cancelled\./);
  release();
  await tick(100);
  assert.equal(ws.integrations.oauth.read(server).accessToken, earlier, "the earlier sign-in is still there");
  assert.equal(ws.integrations.oauth.flows.size, 0);
  assert.equal(ws.integrations.oauth.status(server).signedIn, true);
});

const ENDED = "This sign-in was ended: a sign-in to another tool needed its port. Start it again.";
/** The port of the return address that a registration at the stand-in server named. */
const registeredPort = (remote, n = 0) => Number(new URL(JSON.parse(remote.state.log.filter((entry) => entry.path === "/register")[n].body).redirect_uris[0]).port);

test("a sign-in that is followed holds the port: a tool that cannot use another port is refused with the holder named, and one that can goes on", async (t) => {
  const { ws, id } = await setup(t);
  const own = await oauthMcpServer({ registration: false, staticClient: { id: "mine" } });
  t.after(() => own.close());
  const client = ws.integrations.saveServer({ name: "client", type: "http", url: own.url, oauth: { clientId: "mine" } });
  ws.integrations.oauth.port = await freePort();
  const held = waits(ws, id);
  await held.page;
  t.after(() => ws.integrations.oauth.cancel(id));
  // The window's own sign-in has a person in front of its browser: it is followed, whatever the other asks.
  await assert.rejects(ws.integrations.signIn(client, { open: async () => {} }), { message: "Another sign-in (to words) is open on this computer and holds the port. Finish it or cancel it, then try again." });
  assert.equal(ws.integrations.oauth.flows.size, 1, "the holder was not touched");
  // The first one finishes, and the port is free for the next.
  ws.integrations.answerSignIn(id, await held.go());
  assert.equal((await held.done).signedIn, true);
  const next = waits(ws, client);
  ws.integrations.answerSignIn(client, await next.go());
  assert.equal((await next.done).signedIn, true);
});

test("a held sign-in does not hold back another tool: it goes to a free port, and the held one stays open and can be finished", async (t) => {
  const { remote, ws, id } = await setup(t);
  const second = await oauthMcpServer();
  t.after(() => second.close());
  const other = ws.integrations.saveServer({ name: "other", type: "http", url: second.url });
  const fixed = await freePort();
  ws.integrations.oauth.port = fixed;
  // A sign-in that nobody follows (a `--start`, say) holds the fixed port.
  const held = waits(ws, id, { followed: () => false });
  await held.page;
  t.after(() => ws.integrations.oauth.cancel(id));
  // The window's own sign-in for another tool, through the default `open`, works, on another port.
  assert.equal((await ws.integrations.signIn(other)).signedIn, true);
  assert.notEqual(registeredPort(second), fixed);
  // (The stand-in browser of this test is the first server's: it follows any page to the address it is sent back to.)
  assert.equal(new URL(remote.state.lastCallback).port, String(registeredPort(second)));
  // The held one was not touched: it is open and finishes.
  assert.equal(ws.integrations.oauth.flows.has(id), true);
  assert.equal(ws.integrations.oauth.flows.get(id).port, fixed);
  ws.integrations.answerSignIn(id, await held.go());
  assert.equal((await held.done).signedIn, true);
});

test("the same tool again after a cancel uses the registration that was kept, and its port: no new client is made", async (t) => {
  const { ws, id } = await setup(t);
  const second = await oauthMcpServer();
  t.after(() => second.close());
  const other = ws.integrations.saveServer({ name: "other", type: "http", url: second.url });
  ws.integrations.oauth.port = await freePort();
  const held = waits(ws, id, { followed: () => false });
  await held.page;
  t.after(() => ws.integrations.oauth.cancel(id));
  const registrations = () => second.state.log.filter((entry) => entry.path === "/register").length;
  // The first start registers, and is cancelled.
  const first = waits(ws, other);
  await first.page;
  assert.equal(registrations(), 1);
  const port = registeredPort(second);
  ws.integrations.cancelSignIn(other);
  await assert.rejects(first.done, /Sign-in was cancelled\./);
  // The next one, with the fixed port held again, uses that client and that port.
  const again = waits(ws, other);
  const back = await again.go();
  assert.equal(registrations(), 1, "no new registration was sent");
  assert.equal(new URL(back).port, String(port));
  assert.equal(new URL((await again.page).address).searchParams.get("client_id"), ws.integrations.oauth.read(ws.integrations.server(other)).registration.clientId);
  ws.integrations.cancelSignIn(other);
  await assert.rejects(again.done, /Sign-in was cancelled\./);
  // When the kept port is taken by a program, a port from the system is used, with a new registration.
  const taken = createServer(() => {});
  await new Promise((resolve, reject) => taken.once("error", reject).listen(port, "127.0.0.1", resolve));
  t.after(() => taken.close());
  const moved = waits(ws, other);
  await moved.page;
  assert.equal(registrations(), 2);
  assert.notEqual(registeredPort(second, 1), port);
  ws.integrations.cancelSignIn(other);
  await assert.rejects(moved.done, /Sign-in was cancelled\./);
});

test("a tool that cannot use another port ends a held sign-in that nobody follows, and goes on", async (t) => {
  const { remote, ws, id } = await setup(t);
  const own = await oauthMcpServer({ registration: false, staticClient: { id: "mine" } });
  t.after(() => own.close());
  const client = ws.integrations.saveServer({ name: "client", type: "http", url: own.url, oauth: { clientId: "mine" } });
  const fixed = await freePort();
  ws.integrations.oauth.port = fixed;
  const held = waits(ws, id, { followed: () => false });
  await held.page;
  // The window's sign-in for a tool with a client of its own (the default `open` answers through the stand-in).
  assert.equal((await ws.integrations.signIn(client)).signedIn, true);
  await assert.rejects(held.done, { message: ENDED });
  assert.equal(ws.integrations.oauth.flows.size, 0);
  assert.equal(ws.integrations.oauth.status(ws.integrations.server(id)).signedIn, false);
  assert.equal(new URL(remote.state.lastCallback).port, String(fixed), "it used the port that it needed");
  // A sign-in that is ended in this way says why, and asked about a second time it works again.
  assert.equal((await ws.integrations.signIn(id)).signedIn, true);
});

test("a holder whose answer to \"is it followed\" fails is taken as followed, and is not ended", async (t) => {
  const { ws, id } = await setup(t);
  const own = await oauthMcpServer({ registration: false, staticClient: { id: "mine" } });
  t.after(() => own.close());
  const client = ws.integrations.saveServer({ name: "client", type: "http", url: own.url, oauth: { clientId: "mine" } });
  ws.integrations.oauth.port = await freePort();
  const held = waits(ws, id, {
    followed: () => {
      throw new Error("broken");
    },
  });
  await held.page;
  t.after(() => ws.integrations.oauth.cancel(id));
  await assert.rejects(ws.integrations.signIn(client, { open: async () => {} }), /Another sign-in \(to words\) is open on this computer and holds the port\./);
  assert.equal(ws.integrations.oauth.flows.has(id), true);
});

test("a registration made for a sign-in that was cancelled or timed out is used again, and holds no token", async (t) => {
  const { remote, ws, id } = await setup(t);
  ws.integrations.oauth.port = await freePort();
  const server = ws.integrations.server(id);
  const registrations = () => remote.state.log.filter((entry) => entry.path === "/register").length;
  // A start that is cancelled.
  const first = waits(ws, id);
  await first.page;
  ws.integrations.cancelSignIn(id);
  await assert.rejects(first.done, /Sign-in was cancelled\./);
  assert.equal(registrations(), 1);
  const kept = ws.integrations.oauth.read(server);
  assert.ok(kept.registration.clientId, "the registration is kept with the sign-in's own entry");
  assert.equal(kept.accessToken, undefined);
  assert.equal(kept.refreshToken, undefined);
  assert.equal(ws.integrations.oauth.status(server).signedIn, false);
  // A start that runs out of time uses it again, with the same client.
  await assert.rejects(ws.integrations.signIn(id, { open: async () => {}, patience: 50 }), /Sign-in timed out/);
  assert.equal(registrations(), 1, "the client was used again");
  // So does the sign-in that is done, and it then holds the client as a sign-in does.
  const third = waits(ws, id);
  const back = await third.go();
  assert.equal(new URL((await third.page).address).searchParams.get("client_id"), kept.registration.clientId);
  ws.integrations.answerSignIn(id, back);
  assert.equal((await third.done).signedIn, true);
  assert.equal(registrations(), 1);
  const saved = ws.integrations.oauth.read(server);
  assert.equal(saved.registered, true);
  assert.equal(saved.clientId, kept.registration.clientId);
  assert.equal(saved.registration, undefined);
  // A registration for another return address is not used: the port is another one now.
  await ws.integrations.signOut(id);
  ws.integrations.oauth.port = await freePort();
  const fourth = waits(ws, id);
  await fourth.page;
  ws.integrations.cancelSignIn(id);
  await assert.rejects(fourth.done, /Sign-in was cancelled\./);
  assert.equal(registrations(), 2);
});
