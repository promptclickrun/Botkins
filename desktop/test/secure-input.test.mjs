import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { baseParts } from "../desktop/link/parts.mjs";
import { performSecureUse } from "../desktop/secure-input.mjs";

const form = { title: "Sign in", operation: "https_form", url: "https://example.org/sign-in",
  fields: [{ key: "username", label: "Username", kind: "text" }, { key: "password", label: "Password", kind: "password" },
    { key: "code", label: "One-time code", kind: "code", optional: true }] };

test("a secure answer reaches only its approved operation and leaves a label-only receipt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-secure-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const content = { username: "example-canary-user", password: "example-canary-password" };
  let response, used, checked = false;
  const { client } = fakeClient(async (_id, _options, session) => {
    response = JSON.parse(await session.tool("request_secure_input", form));
    assert.deepEqual(Object.keys(response.handles), ["username", "password"]);
    await assert.rejects(async () => session.tool("use_secure_input", { handles: Object.values(response.handles).slice(0, 1) }));
    const { username, password } = response.handles;
    for (const handles of [{ username }, { username: password, password: username }, [username, username]])
      await assert.rejects(async () => session.tool("use_secure_input", { handles }));
    used = await session.tool("use_secure_input", response);
    await assert.rejects(async () => session.tool("use_secure_input", { handles: [username, password] }));
    checked = true;
    return { data: { content: "Signed in." } };
  });
  const ws = new Workspace(dir, client, () => {}, { secureUse: async (op, values) => {
    assert.equal(op.url, form.url);
    assert.deepEqual({ ...values }, content);
  } });
  const chat = ws.createChat("pip");
  ws.events.once("request", (request) => {
    assert.equal(request.kind, "secure");
    assert.match(request.detail, /https:\/\/example.org\/sign-in/);
    assert.throws(() => ws.interactions.respond(request.id, { action: "accept", content: { username: "only" } }));
    ws.interactions.respond(request.id, { action: "accept", content });
  });
  await ws.send(chat, "Sign in securely");
  assert.equal(checked, true, ws.state.runs[0].detail);
  const state = ws.snapshot();
  for (const surface of [JSON.stringify(state), JSON.stringify(baseParts(state, {})), JSON.stringify(response), used, readFileSync(join(dir, "workspace.json"), "utf8")])
    for (const value of Object.values(content)) assert.ok(!surface.includes(value));
  assert.match(ws.chat(chat).messages.map(m => m.text).join(" "), /Username, Password/);
});

test("the approved HTTPS operation sends a bearer token once, refuses redirects and discards response text", async () => {
  let sent;
  const result = await performSecureUse({ operation: "bearer_get", url: form.url }, { token: "fake-token" }, {
    fetch: async (url, init) => { sent = { url, init }; return new Response("echo fake-token"); },
  });
  assert.equal(sent.url, form.url);
  assert.equal(sent.init.headers.Authorization, "Bearer fake-token");
  assert.equal(sent.init.redirect, "error");
  assert.equal(result, undefined);
});

test("cancel, expiry, turn identity, restart and a failed use cannot release secret values", async (t) => {
  const { SecureInputs } = await import("../desktop/secure-input.mjs");
  const { Interactions } = await import("../desktop/interactions.mjs");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const ws = { active: new Map(), notify() {}, save() {}, closing: false };
  ws.interactions = new Interactions(ws);
  const secret = "secure-test-error-canary";
  let attempts = 0;
  const use = async () => { attempts++; throw new Error(secret); };
  ws.secureInputs = new SecureInputs(ws, use);
  const chat = { id: "chat", botId: "pip", messages: [] }, task = {};
  ws.active.set(chat.id, task);
  const tools = (bot = "pip", manager = ws.secureInputs) => manager.tools({ id: bot }, chat, { id: "r" }, task);
  const [ask, apply] = tools();
  const input = { ...form, operation: "bearer_get", fields: [{ key: "token", label: "Token", kind: "secret" }] };
  async function approved() {
    const pending = ask.handler(input);
    const req = ws.interactions.snapshot()[0];
    ws.interactions.respond(req.id, { action: "accept", content: { token: secret } });
    const { handles } = JSON.parse(await pending);
    return { handles: Object.values(handles) };
  }
  for (const url of ["http://example.org", "https://user:pw@example.org", "file:///secret"]) {
    await assert.rejects(ask.handler({ ...input, url }));
    assert.equal(ws.interactions.snapshot().length, 0);
  }
  let pending = ask.handler(input);
  ws.interactions.cancel(chat.id);
  assert.equal(JSON.parse(await pending).cancelled, true);
  assert.equal(chat.messages.length, 0);
  pending = ask.handler(input);
  t.mock.timers.tick(300001);
  assert.equal(JSON.parse(await pending).cancelled, true);
  const optional = ask.handler({ ...input, fields: [{ ...input.fields[0], optional: true }] });
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "accept", content: {} });
  assert.deepEqual(JSON.parse(await optional), { handles: {} });
  let args = await approved();
  await assert.rejects(tools("other")[1].handler(args), /unavailable/);
  await assert.rejects(tools("pip", new SecureInputs(ws, use))[1].handler(args), /unavailable/);
  t.mock.timers.tick(300001);
  await assert.rejects(apply.handler(args), /unavailable/);
  args = await approved();
  ws.interactions.cancel(chat.id);
  await assert.rejects(apply.handler(args), /unavailable/);
  args = await approved();
  const operations = await Promise.allSettled([apply.handler(args), apply.handler(args)]);
  assert.equal(attempts, 1);
  for (const result of operations) {
    assert.equal(result.status, "rejected");
    assert.ok(!result.reason.message.includes(secret));
  }
  ws.active.delete(chat.id);
  await assert.rejects(ask.handler(input), /ended/);
  assert.deepEqual(ws.secureInputs.tools({ id: "pip" }, chat, { scheduleId: "r" }, task), []);
});

test("HTTPS form submits only the approved fields and omits cookies and redirects", async () => {
  const values = { username: "test+user", password: "test space & punctuation" };
  await performSecureUse({ operation: "https_form", url: form.url }, values, { fetch: async (url, init) => {
    assert.equal(url, form.url);
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.deepEqual(Object.fromEntries(init.body), values);
    return new Response(null, { status: 204 });
  } });
});

test("a paired client can answer a single-field request with a vault reference", { timeout: 12000 }, async (t) => {
  const { LinkHost } = await import("../desktop/link/index.mjs");
  const { LinkClient, pair } = await import("../desktop/remote/link-client.mjs");
  const dir = mkdtempSync(join(tmpdir(), "botkins-secure-wire-"));
  const canary = "wire-only-credential-canary";
  const logs = [], updates = [];
  let received = false, host, phone;
  const ws = new Workspace(dir, fakeClient().client, () => host?.changed(), {
    secureUse: async (_plan, values) => { received = values.token === canary; },
  });
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stream: "" }, run = { id: "wire" };
  ws.active.set(chat.id, task);
  host = new LinkHost({ dir: join(dir, "pairing"), port: 0, relay: false, log: line => logs.push(line), backend: {
    info: () => ({ app: "botkins" }), capabilities: ["secure-input-v1"], snapshot: () => ws.snapshot(), subscribe: () => () => {},
    call: (method, args) => { assert.equal(method, "respond"); return ws.interactions.respond(...args); },
  } });
  t.after(async () => { phone?.stop(); await host.stop(); rmSync(dir, { recursive: true, force: true }); });
  const saved = await host.credentials.save({ name: "Test credential", value: canary });
  await host.setEnabled(true);
  const device = await pair(fetch, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, { name: "Test phone", platform: "ios" });
  const [ask, use] = ws.secureInputs.tools(ws.bot("pip"), chat, run, task);
  const answer = ask.handler({ title: "Account check", operation: "bearer_get", url: form.url, fields: [{ key: "token", kind: "secret", label: "Access token" }] });
  const request = new Promise(resolve => {
    phone = new LinkClient(device, { fetch, onState() {}, onParts(parts) {
      updates.push(parts);
      if (parts.live?.requests?.length) resolve(parts.live.requests[0]);
    } });
    phone.start();
  });
  const view = await request;
  assert.equal(view.kind, "secure");
  assert.equal(view.fields.length, 1);
  assert.ok(updates.some(p => p.meta?.capabilities.includes("secure-input-v1")));
  await phone.call("respond", view.id, { action: "accept", content: { token: { $credential: saved } } });
  const result = JSON.parse(await answer);
  await use.handler({ handles: Object.values(result.handles) });
  assert.equal(received, true);
  for (const output of [result, updates, logs, ws.snapshot()]) assert.ok(!JSON.stringify(output).includes(canary));
});

test("a private interactive chat discovers site-matched vault labels and screen forms through the harness tool bridge", async t => {
  const { ToolBridge } = await import("../desktop/providers/toolbridge.mjs");
  const bridge = new ToolBridge();
  t.after(() => bridge.stop());
  const dir = mkdtempSync(join(tmpdir(), "botkins-vault-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, fakeClient().client, () => {}, {
    savedLogins: (chatId, origin) => {
      assert.equal(chatId, chat.id);
      assert.equal(origin, "https://example.org");
      return [{ name: "Example login", kind: "login" }];
    },
    formBrowser: { inspect: async () => ({ url: form.url, fields: [] }) },
  });
  const chat = ws.chat(ws.createChat("pip")), task = {}, run = { id: "r" };
  ws.active.set(chat.id, task);
  const tools = () => ws.sessionTools(ws.bot("pip"), chat, run, task);
  const endpoint = await bridge.open(tools());
  const rpc = async (method, params) => (await (await fetch(endpoint.url, {
    method: "POST", headers: { ...endpoint.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })).json()).result;
  const names = (await rpc("tools/list")).tools.map(tool => tool.name);
  for (const name of ["browser_form", "find_saved_credentials", "request_secure_input", "use_secure_input"]) assert.ok(names.includes(name), name);
  const call = async (name, args) => JSON.parse((await rpc("tools/call", { name, arguments: args })).content[0].text);
  assert.deepEqual(await call("find_saved_credentials", { url: form.url }), [{ name: "Example login", kind: "login" }]);
  assert.deepEqual(await call("browser_form", { action: "inspect" }), { url: form.url, fields: [] });
  ws.peopleOf = () => ({ invited: ["member"] });
  assert.ok(!tools().some(tool => tool.name === "find_saved_credentials"));
  assert.equal((await rpc("tools/call", { name: "find_saved_credentials", arguments: { url: form.url } })).isError, true);
  ws.peopleOf = () => undefined; // The split workspace has lost contact with the host that knows the invites.
  assert.ok(!tools().some(tool => tool.name === "browser_form"));
});
