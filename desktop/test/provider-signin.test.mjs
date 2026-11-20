// Signing a model provider in, and installing its tool, from a phone ("provider-signin-v1"). The
// computer runs the provider's own sign-in or install with no browser of its own, through the
// same sessions as the terminal host's `botkins providers login` (desktop/terminal/signin.mjs);
// the phone reads them through the link (desktop/runtime.mjs). Here: a phone paired with a running
// terminal host signs a stand-in agent in, and the install and token rules on their own.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTE_METHODS } from "../desktop/link/methods.mjs";
import { TEAM_METHODS } from "../desktop/link/team.mjs";
import { LinkClient, pair, parsePairingUrl } from "../desktop/remote/link-client.mjs";
import { CAPABILITIES, PROVIDER_SIGNIN } from "../desktop/runtime.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { SignIns } from "../desktop/terminal/signin.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The terminal host and the install run in a POSIX shell.";
const agent = fileURLToPath(new URL("./fixtures/standin-agent.mjs", import.meta.url));
const CALLS = ["providerSignInStart", "providerSignInRead", "providerSignInInput", "providerSignInCancel", "providerUseToken", "installProvider"];
const tempDir = (t) => {
  const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** A terminal host whose one provider, "grok", is the stand-in agent, signed out; and a phone paired with it. */
async function hostAndPhone(t) {
  const dir = tempDir(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "grok"), "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(agent) + ' "$@"\n');
  chmodSync(join(bin, "grok"), 0o755);
  const before = { PATH: process.env.PATH, STANDIN_AGENT_HOME: process.env.STANDIN_AGENT_HOME, STANDIN_AGENT_PIECE_MS: process.env.STANDIN_AGENT_PIECE_MS };
  Object.assign(process.env, { PATH: bin + delimiter + process.env.PATH, STANDIN_AGENT_HOME: join(dir, "agent"), STANDIN_AGENT_PIECE_MS: "25" });
  t.after(() => {
    for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ providers: { only: ["grok"] }, link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(() => running.stop("the test ended"));
  const control = controlClient(paths.socket, { timeout: 40_000 });
  await control.call("providers.enable", "grok", true);
  const code = await control.call("pair.start");
  const target = parsePairingUrl(code.url);
  const port = (await control.call("status")).link.port;
  const pairing = await pair(fetch, { ...target, hosts: ["127.0.0.1:" + port] }, { name: "Test phone", platform: "ios" });
  const phone = new LinkClient(pairing, { fetch, onParts() {}, onState() {} });
  t.after(() => phone.stop());
  return { phone, control, paths };
}

test("the link offers the calls to the owner only, and the app names the capability", () => {
  assert.ok(CAPABILITIES.includes(PROVIDER_SIGNIN));
  assert.equal(PROVIDER_SIGNIN, "provider-signin-v1");
  for (const method of CALLS) {
    assert.ok(REMOTE_METHODS.has(method), method + " is a phone's call");
    assert.equal(TEAM_METHODS[method], "owner", method + " is the owner's alone");
  }
});

test("a phone signs a provider in with the tool's own sign-in: the page and code come to the phone, and its answer goes back", { skip }, async (t) => {
  const { phone } = await hostAndPhone(t);
  const before = (await phone.call("providers", true)).find((entry) => entry.id === "grok");
  assert.equal(before.connected, false);
  // The stand-in's sign-in command ("grok login") makes it a guided sign-in; it takes no token.
  assert.deepEqual(before.signInWays, { guided: true, token: false });
  const { session } = await phone.call("providerSignInStart", "grok");
  const events = [];
  let view;
  let typed = false;
  for (let after = 0; ; ) {
    view = await phone.call("providerSignInRead", session, after);
    after = view.next;
    events.push(...view.events);
    if (!typed && view.wantsInput) {
      typed = true;
      await phone.call("providerSignInInput", session, "confirm-123");
    }
    if (view.done) break;
  }
  assert.deepEqual(events.filter((event) => event.type === "open").map((event) => event.url), ["https://example.com/device"]);
  assert.ok(events.some((event) => event.type === "output" && /STAND-1234/.test(event.text)));
  assert.equal(view.error, undefined);
  assert.deepEqual(view.result, { connected: true, account: null, plan: null });
  assert.equal((await phone.call("providers", true)).find((entry) => entry.id === "grok").connected, true);
  await assert.rejects(phone.call("providerUseToken", "grok", "a-token"), /doesn't take a pasted token/);
  await assert.rejects(phone.call("providerSignInRead", "no-such-session", 0), /That sign-in is over/);
});

test("a sign-in from a phone can be cancelled from the phone, and says so", { skip }, async (t) => {
  const { phone } = await hostAndPhone(t);
  const { session } = await phone.call("providerSignInStart", "grok");
  // A second start while the phone follows the first is turned down.
  await phone.call("providerSignInRead", session, 0);
  await assert.rejects(phone.call("providerSignInStart", "grok"), /already in progress/);
  assert.equal(await phone.call("providerSignInCancel", session), true);
  let view;
  do view = await phone.call("providerSignInRead", session, 0);
  while (!view.done);
  assert.match(view.error, /cancelled/i);
});

/** A registry with one provider whose tool is "installed" once a marker file exists. */
function fakeProviders(dir, { command, url = "https://example.com/guide", id = "fake" } = {}) {
  const marker = join(dir, "installed");
  const provider = { id, name: "Fake CLI", signOut: async () => {}, releaseSessions: async () => {} };
  return {
    marker,
    providers: () => ({
      require: (wanted) => {
        if (wanted !== id) throw new Error("Unknown model provider");
        return provider;
      },
      status: async () => (existsSync(marker) ? { id, installed: true, version: "2.0.0", connected: false } : { id, installed: false, connected: false, install: { url, ...(command && { command }) } }),
    }),
  };
}
const until = async (signIns, session) => {
  const events = [];
  for (let after = 0; ; ) {
    const view = await signIns.read(session, { after, ms: 2000 });
    after = view.next;
    events.push(...view.events);
    if (view.done) return { ...view, events };
  }
};

test("a provider's tool is installed with the command it names, and what it prints is followed", { skip }, async (t) => {
  const dir = tempDir(t);
  const { providers, marker } = fakeProviders(dir, { command: "printf 'Downloading Fake CLI\\n'; touch " + JSON.stringify(join(dir, "installed")) + "; printf 'Installed\\n'" });
  const changed = [];
  const signIns = new SignIns({ providers, vault: () => null, changed: async (id) => changed.push(id), env: { ...process.env } });
  const { session } = await signIns.install("fake");
  const ended = await until(signIns, session);
  assert.equal(ended.error, undefined);
  assert.deepEqual(ended.result, { installed: true, version: "2.0.0" });
  assert.deepEqual(ended.events.filter((event) => event.type === "output").map((event) => event.text), ["$ " + "printf 'Downloading Fake CLI\\n'; touch " + JSON.stringify(join(dir, "installed")) + "; printf 'Installed\\n'", "Downloading Fake CLI", "Installed"]);
  assert.ok(existsSync(marker));
  assert.deepEqual(changed, ["fake"], "the provider is looked at again");
  await assert.rejects(signIns.install("fake"), /already installed/);
});

test("an install that fails, or finishes without the tool, says why", { skip }, async (t) => {
  const dir = tempDir(t);
  const failing = new SignIns({ ...fakeProviders(dir, { command: "printf 'npm ERR! network\\n'; exit 7" }), vault: () => null, env: { ...process.env } });
  const failed = await until(failing, (await failing.install("fake")).session);
  assert.match(failed.error, /^The install didn't finish\. npm ERR! network/);
  const silent = new SignIns({ ...fakeProviders(dir, { command: "true" }), vault: () => null, env: { ...process.env } });
  const missing = await until(silent, (await silent.install("fake")).session);
  assert.match(missing.error, /still isn't found/);
  // No command: only the guide. Windows: not from a phone.
  const guideOnly = new SignIns({ ...fakeProviders(dir, {}), vault: () => null });
  await assert.rejects(guideOnly.install("fake"), /can't be installed from Botkins\. Its guide: https:\/\/example\.com\/guide/);
  const windows = new SignIns({ ...fakeProviders(dir, { command: "npm install -g fake" }), vault: () => null, platform: "win32" });
  await assert.rejects(windows.install("fake"), /macOS and Linux/);
});

test("an npm global install goes to ~/.npm-global, so it needs no administrator", async (t) => {
  const dir = tempDir(t);
  let started;
  const launch = (file, args, options) => {
    started = { file, args, env: options.env };
    const listeners = {};
    const stream = () => ({ on: () => {} });
    const child = { stdin: { on: () => {}, write: () => {} }, stdout: stream(), stderr: stream(), kill: () => {}, on: (name, fn) => ((listeners[name] = fn), child) };
    setTimeout(() => listeners.close?.(1), 10);
    return child;
  };
  const signIns = new SignIns({ ...fakeProviders(dir, { command: "npm install -g @openai/codex" }), vault: () => null, launch, home: "/home/someone", platform: "linux" });
  const ended = await until(signIns, (await signIns.install("fake")).session);
  assert.equal(started.file, "/bin/sh");
  assert.deepEqual(started.args, ["-c", "npm install -g @openai/codex"]);
  assert.equal(started.env.NPM_CONFIG_PREFIX, "/home/someone/.npm-global");
  assert.ok(started.env.PATH.split(delimiter).includes(dirname(process.execPath)), "the npm beside this Node is found");
  assert.match(ended.error, /install didn't finish/);
});

test("each provider's ways in from a phone", () => {
  const signIns = new SignIns({ providers: () => null, vault: () => null });
  assert.deepEqual(signIns.ways({ id: "copilot" }), { guided: true, token: true });
  assert.deepEqual(signIns.ways({ id: "codex" }), { guided: true, token: true });
  assert.deepEqual(signIns.ways({ id: "claude" }), { guided: true, token: true });
  // OpenCode signs in one model service at a time; an ACP agent with a login command of its own is guided.
  assert.deepEqual(signIns.ways({ id: "opencode" }), { guided: false, token: false });
  assert.deepEqual(signIns.ways({ id: "kiro", signInCommand: "kiro-cli login" }), { guided: true, token: false });
  assert.deepEqual(signIns.ways({ id: "antigravity" }), { guided: false, token: false });
});
