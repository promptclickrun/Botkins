// Phone access: how Botkins uses the Botkins link (desktop/link, copied from the Botkins repo)
// and the sign-in a phone hands over (desktop/oauth.mjs adopt, desktop/integrations.mjs adoptSignIn).
// No phone is needed: the link is checked from this side only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";
import { pluginHandlers } from "../desktop/plugins.mjs";
import { LinkHost, qrPath, REMOTE_METHODS } from "../desktop/link/index.mjs";

const source = (file) => readFileSync(new URL("../desktop/" + file, import.meta.url), "utf8");
const preload = new Set([...source("preload.cjs").matchAll(/^ {2}"([\w.]+)",$/gm)].map((m) => m[1]));
const handlers = new Set([...source("main.mjs").matchAll(/^ {6}(?:([\w]+)|"([\w.]+)"): /gm)].map((m) => m[1] ?? m[2]));
// The same shared handler factory serves local IPC and the paired-device dispatcher.
if (source("main.mjs").includes("...pluginHandlers(workspace.plugins, savedCredentials)")) {
  for (const name of Object.keys(pluginHandlers({}, {}))) handlers.add(name);
}
// The calls only Settings › Phone makes. A phone must never be able to make them.
const PHONE_PAGE = ["remoteHosts", "pairRemoteHost", "useRemoteHost", "forgetRemoteHost", "renameRemoteHost", "renamePhone", "setPhonePerson", "phoneLink", "setPhoneLink", "startPhonePairing", "cancelPhonePairing", "removePhone", "renamePhoneLinkComputer", "setPhoneScreen", "setPhoneRelay", "resetPhoneRelay", "requestScreenPermission", "allowLocalNetwork", "macToolsStatus", "setMacTool", "grantMacTool", "voiceSettings", "setVoice", "setVoiceKey", "voiceOptions", "transcribe", "speak", "startDictation", "startLiveVoice", "liveVoiceTool", "endLiveVoice", "savedCredentials", "saveSavedCredential", "removeSavedCredential", "checkSavedCredential", "passwordManagers", "unlockPasswordManager", "lockPasswordManager", "passwordManagerVaults", "passwordManagerItems", "passwordManagerItem", "linkPasswordManagerField"];

test("every call a phone may make exists, and the phone page's own calls are not among them", () => {
  for (const name of REMOTE_METHODS) {
    assert.ok(preload.has(name), name + " is in REMOTE_METHODS but not in preload.cjs");
    assert.ok(handlers.has(name), name + " is in REMOTE_METHODS but has no handler in main.mjs");
  }
  for (const name of [...PHONE_PAGE, "pickPluginFolder", "openChatPath", "previewChatPath", "inspectChatPaths"]) {
    assert.ok(preload.has(name), name + " is missing from preload.cjs");
    assert.ok(handlers.has(name), name + " has no handler in main.mjs");
    assert.ok(!REMOTE_METHODS.has(name), name + " must not be callable from a phone");
  }
});

async function setup(t, serverOptions, { oauth = false } = {}) {
  const remote = await oauthMcpServer(serverOptions);
  t.after(() => remote.close());
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { oauthPort: 0, openExternal: async () => {} });
  const id = ws.integrations.saveServer({ name: "words", type: "http", url: remote.url, ...(oauth && { oauth: {} }) });
  const server = () => ws.integrations.server(id);
  const ask = (reason = "initial") => ws.integrations.oauth.token(server(), { reason });
  // What a phone that signed in to the stand-in server holds. The server knows these tokens and this client.
  const grant = {
    clientId: "phone-client",
    accessToken: "phone-access",
    refreshToken: "phone-refresh",
    expiresIn: 3600,
    scope: "tools.read",
    redirectUri: "botkins://oauth/callback",
  };
  remote.state.access.set(grant.accessToken, { scope: "tools.read", client: grant.clientId, expiresAt: Date.now() + 3600_000 });
  remote.state.refresh.set(grant.refreshToken, { scope: "tools.read", client: grant.clientId });
  return { remote, ws, id, server, ask, grant };
}

test("an adopted sign-in gives the phone's token, and renews with the phone's client at the discovered address", async (t) => {
  const { remote, ws, server, ask, grant } = await setup(t);
  assert.equal(await ask(), null);
  // A grant that tries to name an address of its own: it is ignored, discovery decides.
  await ws.integrations.oauth.adopt(server(), { ...grant, tokenEndpoint: "https://evil.example/token", revocationEndpoint: "https://evil.example/revoke" });
  const token = await ask();
  assert.equal(token.accessToken, "phone-access");
  assert.equal(token.tokenType, "Bearer");
  assert.ok(token.expiresIn > 3000);
  const saved = ws.integrations.oauth.read(server());
  assert.equal(saved.tokenEndpoint, remote.origin + "/token");
  assert.equal(saved.revocationEndpoint, remote.origin + "/revoke");
  assert.equal(saved.issuer, remote.origin);
  assert.equal(saved.resource, remote.url);
  assert.equal(saved.clientId, "phone-client");
  assert.equal(saved.redirectUri, grant.redirectUri);
  assert.equal(saved.registered, true);
  assert.equal(saved.scope, "tools.read");
  // The person was never sent to a browser and Botkins registered nothing: the phone's client is used as it is.
  assert.ok(!remote.state.log.some((r) => r.path === "/register" || r.path === "/authorize"));
  assert.equal(ws.integrations.oauth.status(server()).signedIn, true);
  // A renewal goes to the discovered token endpoint as the phone's client, with the phone's refresh token.
  const renewed = await ask("refresh");
  assert.notEqual(renewed.accessToken, "phone-access");
  assert.ok(remote.state.access.has(renewed.accessToken));
  const exchange = new URLSearchParams(remote.state.log.findLast((r) => r.path === "/token").body);
  assert.equal(exchange.get("grant_type"), "refresh_token");
  assert.equal(exchange.get("refresh_token"), "phone-refresh");
  assert.equal(exchange.get("client_id"), "phone-client");
  assert.equal(exchange.get("resource"), remote.url);
});

test("a grant that is incomplete or oversized is refused and saves nothing", async (t) => {
  const { ws, server, ask, grant } = await setup(t);
  const { accessToken: _gone, ...noAccess } = grant;
  const bad = [
    noAccess,
    { ...grant, accessToken: "" },
    { ...grant, accessToken: "x".repeat(4097) },
    { ...grant, clientId: undefined },
    { ...grant, refreshToken: 5 },
    { ...grant, expiresIn: -1 },
    { ...grant, expiresIn: "soon" },
    { ...grant, scope: "s".repeat(513) },
    { ...grant, redirectUri: "r".repeat(513) },
    { ...grant, redirectUri: undefined },
    null,
    "a string",
  ];
  for (const one of bad) await assert.rejects(ws.integrations.oauth.adopt(server(), one), /incomplete/, JSON.stringify(one)?.slice(0, 60));
  assert.equal(await ask(), null);
  assert.deepEqual(ws.vault.list(), []);
  // The optional parts may be left out.
  await ws.integrations.oauth.adopt(server(), { clientId: "phone-client", accessToken: "phone-access", redirectUri: "" });
  assert.equal((await ask()).accessToken, "phone-access");
  assert.equal(ws.integrations.oauth.read(server()).refreshToken, undefined);
});

test("adopting a sign-in is for a remote server that signs in with OAuth, and then checks the server", async (t) => {
  const { remote, ws, id, ask, grant } = await setup(t, {}, { oauth: true });
  // The check connects to the server like Test does; here it is a stand-in that reports what the server would.
  const checked = [];
  ws.probe = async (overrides) => {
    checked.push(Object.keys(overrides.mcpServers));
    return {
      servers: [{ name: "words", status: (await ask())?.accessToken === "phone-access" ? "connected" : "needs-auth" }],
      choices: [{ kind: "Tool", source: "words", name: "words-secret_word" }],
    };
  };
  assert.deepEqual(await ws.integrations.adoptSignIn(id, grant), { status: "connected", tools: ["secret_word"] });
  assert.deepEqual(checked, [["words"]]);
  assert.equal(ws.snapshot().mcpServers[0].auth.signedIn, true);
  assert.equal(remote.state.log.some((r) => r.path === "/register"), false);
  // A bad grant stops before anything is checked.
  await assert.rejects(ws.integrations.adoptSignIn(id, { ...grant, accessToken: undefined }), /incomplete/);
  assert.equal(checked.length, 1);
  await assert.rejects(ws.integrations.adoptSignIn("nope", grant), /no longer exists/);
  const local = ws.integrations.saveServer({ name: "local", type: "stdio", command: "node" });
  await assert.rejects(ws.integrations.adoptSignIn(local, grant), /local server/);
  const open = ws.integrations.saveServer({ name: "open", type: "http", url: remote.url.replace("127.0.0.1", "localhost") });
  await assert.rejects(ws.integrations.adoptSignIn(open, grant), /isn't set to sign in/);
});

test("a link host opens a pairing without a phone, and calls outside the list stay out of reach", async (t) => {
  const calls = [];
  const adopted = [];
  const backend = {
    info: () => ({ app: "commander", version: "0.0.0", platform: process.platform }),
    snapshot: () => ({ bots: [], chats: [], runs: [] }),
    call: (name, args) => calls.push([name, args]),
    subscribe: () => () => {},
    extras: { adoptMcpSignIn: (...args) => adopted.push(args) },
  };
  const link = new LinkHost({ dir: join(tempDir(t), "link"), backend, port: 0 });
  t.after(() => link.stop());
  const changes = [];
  link.on("status", () => changes.push(link.status().pairing?.code ?? null));
  assert.equal(link.status().enabled, false, "phone access is off until the person turns it on");
  assert.equal(link.status().listening, false);
  assert.throws(() => link.startPairing(), /Turn on phone access/);
  await link.start();
  assert.equal(link.status().listening, false, "start() listens only when it was turned on");
  await link.setEnabled(true);
  const status = link.status();
  assert.equal(status.enabled && status.listening, true);
  assert.ok(status.port > 0);
  const { code, url } = link.startPairing();
  assert.match(code, /^[2-9A-HJ-NP-Z]{12}$/);
  assert.match(url, /^botkins:\/\/pair\?/);
  assert.equal(new URL(url).searchParams.get("c"), code);
  const qr = qrPath(link.status().pairing.url);
  assert.ok(qr.d.length > 100 && qr.size > 20 && /^M\d+ \d+h\d+v1h-\d+z/.test(qr.d));
  assert.deepEqual(changes.at(-1), code);
  link.cancelPairing();
  assert.equal(link.status().pairing, null);
  // Only names in REMOTE_METHODS reach the app's calls; the phone page's own calls never do.
  for (const name of PHONE_PAGE) await assert.rejects(link.dispatch({}, { m: name, a: [] }), /can't be done from a phone/);
  assert.deepEqual(calls, []);
  await link.dispatch({}, { m: "stop", a: ["chat-1"] });
  assert.deepEqual(calls, [["stop", ["chat-1"]]]);
  // Sign-in hand-over is reached as "link.adoptMcpSignIn".
  await link.dispatch({}, { m: "link.adoptMcpSignIn", a: ["server-1", { clientId: "c" }] });
  assert.deepEqual(adopted, [["server-1", { clientId: "c" }]]);
  await link.setEnabled(false);
  assert.equal(link.status().listening, false);
});
