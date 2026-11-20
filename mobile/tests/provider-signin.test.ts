// Signing a model provider in, and installing one, from the phone ("provider-signin-v1"). The
// computer runs the provider's own sign-in or install with no browser of its own; the phone shows
// its page and code, answers its question, or sends a pasted token. Here: the phone's plain logic,
// the link's checks and owner-only rule, and the demo computer end to end over a real link.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { remoteArgs, REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { DEMO_BAD_CODE, DEMO_BAD_TOKEN } from "../link-host/mock-signin.mjs";
import { TEAM_METHODS } from "../link-host/team.mjs";
import { applyView, codeInLines, finishedLine, providerAction, safePage, startState } from "../src/features/models/signin";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { ProviderSignInView, ProviderStatus } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const CALLS = ["providerSignInStart", "providerSignInRead", "providerSignInInput", "providerSignInCancel", "providerUseToken", "installProvider"];

const provider = (more: Partial<ProviderStatus>): ProviderStatus => ({ id: "claude", name: "Claude", description: "", enabled: true, default: false, installed: true, connected: false, signIn: "browser", signOut: true, ...more });

test("the provider's page offers what the computer can do from here", () => {
  // Not installed: the computer can install it when it names a command, else only a guide.
  assert.deepEqual(providerAction(provider({ installed: false, install: { url: "https://x", command: "curl … | bash" } }), true), { kind: "install" });
  assert.deepEqual(providerAction(provider({ installed: false, install: { url: "https://x" } }), true), { kind: "install-guide" });
  assert.deepEqual(providerAction(provider({ installed: false, install: { url: "https://x", command: "npm i -g x" } }), false), { kind: "install-guide" });
  // Signed out: its own sign-in, finished here, with a token as the other way in.
  assert.deepEqual(providerAction(provider({ signInWays: { guided: true, token: true } }), true), { kind: "signin", token: true });
  assert.deepEqual(providerAction(provider({ signInWays: { guided: false, token: true } }), true), { kind: "token" });
  // A computer without the capability: finish on the computer, as before.
  assert.deepEqual(providerAction(provider({ signInWays: { guided: true, token: true } }), false), { kind: "computer" });
  assert.deepEqual(providerAction(provider({ signIn: null }), true), { kind: "none" });
  assert.deepEqual(providerAction(provider({ connected: true, signInWays: { guided: true, token: true } }), true), { kind: "none" });
  assert.deepEqual(providerAction(provider({ signIn: "services" }), true), { kind: "services" });
});

test("only an https page is opened", () => {
  assert.equal(safePage("https://github.com/login/device"), "https://github.com/login/device");
  for (const bad of ["http://github.com/login/device", "javascript:alert(1)", "file:///etc/passwd", "botkins://pair?c=1", "not a page", undefined]) assert.equal(safePage(bad), null, String(bad));
});

test("a run's events add up to what the sheet shows", () => {
  const view = (events: ProviderSignInView["events"], more: Partial<ProviderSignInView> = {}): ProviderSignInView => ({ events, next: events.at(-1)?.n ?? 0, done: false, wantsInput: false, ...more });
  let state = applyView(startState(), view([{ n: 1, type: "code", url: "https://github.com/login/device", code: "WDJB-MJHT" }]));
  assert.deepEqual(state.code, { url: "https://github.com/login/device", code: "WDJB-MJHT" });
  // An event already read is not added twice, and a page that isn't https is ignored.
  state = applyView(state, view([{ n: 1, type: "output", text: "again" }, { n: 2, type: "output", text: "Open this page:" }, { n: 3, type: "open", url: "http://evil.example" }]));
  assert.deepEqual(state.lines, ["Open this page:"]);
  assert.equal(state.page, undefined);
  state = applyView(state, view([{ n: 4, type: "open", url: "https://claude.ai/oauth/authorize?x=1" }, { n: 5, type: "prompt", text: "" }], { wantsInput: true }));
  assert.equal(state.page, "https://claude.ai/oauth/authorize?x=1");
  assert.equal(state.prompt, "", "the tool waits, asking in its own lines");
  // The question goes once the tool moves on, and the end says how it went.
  state = applyView(state, { events: [], next: 5, done: true, wantsInput: false, result: { connected: true, account: "you@example.com" } });
  assert.equal(state.prompt, undefined);
  assert.equal(state.done, true);
  assert.equal(finishedLine(state.result, "Claude"), "Signed in as you@example.com.");
  assert.equal(finishedLine({ installed: true, version: "1.4.0" }, "Grok"), "Grok is installed (1.4.0).");
  // The tool's lines keep only the newest.
  let many = startState();
  for (let n = 1; n <= 60; n++) many = applyView(many, view([{ n, type: "output", text: "line " + n }]));
  assert.equal(many.lines.length, 40);
  assert.equal(many.lines.at(-1), "line 60");
});

test("a code a tool printed in its lines is found", () => {
  assert.equal(codeInLines(["1. Open this link", "2. Enter this one-time code: 4F7K-LQ2P"]), "4F7K-LQ2P");
  assert.equal(codeInLines(["Code: GRK-7731"]), "GRK-7731");
  assert.equal(codeInLines(["Paste code here if prompted >"]), null);
  assert.equal(codeInLines(["Your code: hello"]), null, "a word is not a code");
});

test("the link lets an owner make these calls, checks their shape, and lets no member make them", () => {
  for (const method of CALLS) {
    assert.ok(REMOTE_METHODS.has(method), method + " is a phone's call");
    assert.equal(TEAM_METHODS[method], "owner", method + " is the owner's alone");
  }
  assert.deepEqual(remoteArgs("providerSignInStart", ["opencode", { service: "google", method: "oauth", extra: 1 }]), ["opencode", { service: "google", method: "oauth" }]);
  assert.deepEqual(remoteArgs("providerSignInStart", [{ evil: 1 }]), ["", {}]);
  assert.deepEqual(remoteArgs("providerSignInRead", ["s1", -4]), ["s1", 0]);
  assert.deepEqual(remoteArgs("providerSignInRead", ["s1", 12]), ["s1", 12]);
  assert.throws(() => remoteArgs("providerSignInInput", ["s1", "x".repeat(5000)]), /too long/);
  assert.throws(() => remoteArgs("providerUseToken", ["claude", "  "]), /Paste the token/);
  assert.throws(() => remoteArgs("providerUseToken", ["claude", { key: "x" }]), /Paste the token/);
  assert.deepEqual(remoteArgs("providerUseToken", ["claude", { $credential: "c1", other: 1 }]), ["claude", { $credential: "c1" }, {}]);
  assert.deepEqual(remoteArgs("installProvider", ["grok", "--force"]), ["grok"]);
});

async function demo() {
  const backend = new MockBackend({ speed: 0.01 });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-signin-")));
  folders.push(dir);
  const link = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const pairing = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const client = new LinkClient(pairing, { fetch: real, onParts() {}, onState() {} });
  const call = <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args);
  /** Reads a run until `until` holds or it ends. */
  const follow = async (session: string, until: (state: ReturnType<typeof startState>) => boolean = () => false) => {
    let state = startState();
    for (let i = 0; i < 200 && !state.done && !until(state); i++) state = applyView(state, await call<ProviderSignInView>("providerSignInRead", session, state.next));
    return state;
  };
  const status = async (id: string) => (await call<ProviderStatus[]>("providers")).find((entry) => entry.id === id)!;
  return { link, client, call, follow, status, stop: async () => (client.stop(), await link.stop()) };
}

test("the demo computer signs a provider in by its page and code, and by a code typed back", async () => {
  const { call, follow, status, stop } = await demo();
  try {
    // GitHub's device sign-in: the page and the code come first, then GitHub says yes.
    await call("signOut", "copilot");
    assert.equal((await status("copilot")).connected, false);
    assert.deepEqual((await status("copilot")).signInWays, { guided: true, token: true });
    const copilot = await call<{ session: string }>("providerSignInStart", "copilot");
    const shown = await follow(copilot.session, (state) => !!state.code);
    assert.deepEqual(shown.code, { url: "https://github.com/login/device", code: "WDJB-MJHT" });
    const ended = await follow(copilot.session);
    assert.equal(ended.done, true);
    assert.equal(ended.error, undefined);
    assert.equal((await status("copilot")).connected, true);

    // Claude Code: a page, then the code it shows typed back. A wrong code ends it with the tool's words.
    await call("signOut", "claude");
    const first = await call<{ session: string }>("providerSignInStart", "claude");
    const asked = await follow(first.session, (state) => state.prompt !== undefined);
    assert.equal(asked.page, "https://claude.ai/oauth/authorize?code=true&client_id=demo");
    await call("providerSignInInput", first.session, DEMO_BAD_CODE);
    assert.match((await follow(first.session)).error ?? "", /didn't finish/);
    assert.equal((await status("claude")).connected, false);
    const second = await call<{ session: string }>("providerSignInStart", "claude");
    await follow(second.session, (state) => state.prompt !== undefined);
    await call("providerSignInInput", second.session, "abc123");
    const done = await follow(second.session);
    assert.deepEqual(done.result, { connected: true, account: "you@example.com", plan: "Max" });
    assert.equal((await status("claude")).connected, true);
    // Typing into a sign-in that is over is refused.
    await assert.rejects(call("providerSignInInput", second.session, "late"), /over/);
  } finally {
    await stop();
  }
});

test("a sign-in can be cancelled, and starting another ends the one before", async () => {
  const { call, follow, stop } = await demo();
  try {
    const one = await call<{ session: string }>("providerSignInStart", "codex");
    assert.equal(await call("providerSignInCancel", one.session), true);
    assert.match((await follow(one.session)).error ?? "", /cancelled/);
    assert.equal(await call("providerSignInCancel", one.session), false);
    const two = await call<{ session: string }>("providerSignInStart", "codex");
    const three = await call<{ session: string }>("providerSignInStart", "codex");
    assert.match((await follow(two.session)).error ?? "", /cancelled/);
    const shown = await follow(three.session, (state) => !!state.page);
    assert.equal(shown.page, "https://auth.openai.com/codex/device");
    assert.equal(codeInLines(shown.lines) ?? codeInLines((await follow(three.session, (state) => state.lines.length > 4)).lines), "4F7K-LQ2P");
    await call("providerSignInCancel", three.session);
  } finally {
    await stop();
  }
});

test("a pasted token or a saved credential signs a provider in, and a bad one is turned down", async () => {
  const { call, status, link, stop } = await demo();
  try {
    await call("signOut", "claude");
    await assert.rejects(call("providerUseToken", "claude", DEMO_BAD_TOKEN), /didn't accept/);
    assert.equal((await status("claude")).connected, false);
    assert.equal((await call<{ connected: boolean }>("providerUseToken", "claude", "sk-ant-oat-good")).connected, true);
    // A saved credential: the link fills in its value, and the phone never had it.
    await call("signOut", "codex");
    const id = await link.credentials.save({ name: "OpenAI key", kind: "api-key", value: "sk-demo-not-real" });
    assert.equal((await call<{ connected: boolean }>("providerUseToken", "codex", { $credential: id })).connected, true);
    assert.equal((await status("codex")).connected, true);
    // A provider that has no token way says so.
    await assert.rejects(call("providerUseToken", "grok", "x"), /doesn't take a pasted token/);
  } finally {
    await stop();
  }
});

test("a model service is signed in to through the same run, its code typed back", async () => {
  const { call, follow, stop } = await demo();
  try {
    const run = await call<{ session: string }>("providerSignInStart", "opencode", { service: "google", method: "oauth" });
    const asked = await follow(run.session, (state) => state.prompt !== undefined);
    assert.match(asked.page ?? "", /^https:\/\/accounts\.google\.com\//);
    assert.match(asked.prompt ?? "", /code/);
    await call("providerSignInInput", run.session, "g-code");
    assert.equal((await follow(run.session)).error, undefined);
    const services = await call<{ id: string; connected: boolean }[]>("providerServices", "opencode");
    assert.equal(services.find((service) => service.id === "google")?.connected, true);
  } finally {
    await stop();
  }
});

test("a provider's tool is installed from the phone, and then signed in to", async () => {
  const { call, follow, status, stop } = await demo();
  try {
    const before = await status("grok");
    assert.equal(before.installed, false);
    assert.ok(before.install?.command, "the computer names the command");
    await assert.rejects(call("providerSignInStart", "grok"), /isn't installed/);
    const run = await call<{ session: string }>("installProvider", "grok");
    const ended = await follow(run.session);
    assert.equal(ended.error, undefined);
    assert.deepEqual(ended.result, { installed: true, version: "1.4.0" });
    assert.ok(ended.lines.some((line) => /Installed to/.test(line)));
    const now = await status("grok");
    assert.equal(now.installed, true);
    assert.deepEqual(now.signInWays, { guided: true, token: false });
    await assert.rejects(call("installProvider", "grok"), /already installed/);
    const signin = await call<{ session: string }>("providerSignInStart", "grok");
    assert.equal((await follow(signin.session)).result?.connected, true);
  } finally {
    await stop();
  }
});

test("the demo names the capability, and leaves it out when asked to", async () => {
  const on = new MockBackend({ speed: 0.01 });
  assert.ok(on.capabilities.includes("provider-signin-v1"));
  assert.ok((await on.call("providers", [])).every((entry: ProviderStatus) => !entry.installed || entry.signInWays));
  const saved = process.env.BOTKINS_DEV_SIGNIN;
  process.env.BOTKINS_DEV_SIGNIN = "off";
  try {
    const off = new MockBackend({ speed: 0.01 });
    assert.ok(!off.capabilities.includes("provider-signin-v1"));
    assert.ok((await off.call("providers", [])).every((entry: ProviderStatus) => !entry.signInWays));
  } finally {
    if (saved === undefined) delete process.env.BOTKINS_DEV_SIGNIN;
    else process.env.BOTKINS_DEV_SIGNIN = saved;
  }
});
