// The computer-side features of the link: credentials, the screen, pull requests and uploads.
// The phone's client talks to a real LinkHost over loopback, as in link.test.ts. Password managers,
// gh and the screen are stood in for by tiny fake programs and a fake screen adapter, and the
// input injector is replaced, so nothing real is read, clicked or typed. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, test } from "node:test";
import { Credentials, scrub } from "../link-host/credentials.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { cleanEvents, xdotoolCommands } from "../link-host/input.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { Screen } from "../link-host/screen.mjs";
import { LinkStore, newId } from "../link-host/store.mjs";
import { Gate, runTool, toolGate } from "../link-host/tools.mjs";
import { safeName, Uploads } from "../link-host/uploads.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";

const fetcher = fetch as unknown as FetchLike;
const phone = { name: "Test phone", platform: "ios" };
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const folders: string[] = [];
const scratch = (what: string) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "botkins-" + what + "-")));
  folders.push(folder);
  return folder;
};
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const RECORDED = ["respond", "updateBot", "saveMcpServer", "connectProviderService", "send", "addBot"];

/**
 * A desktop that records the calls that matter instead of running them. `mode` "echo" answers with
 * what it was given, "fail" throws with it in the message, and `real` names calls that also run.
 */
class Recording extends MockBackend {
  calls: [string, any[]][] = [];
  screen: any;
  mode = "record";
  real = new Set<string>();
  async call(method: string, args: any[]) {
    if (RECORDED.includes(method)) {
      this.calls.push([method, structuredClone(args)]);
      if (this.real.has(method)) return super.call(method, args);
      if (this.mode === "echo") return method === "connectProviderService" ? { instructions: "echo " + JSON.stringify(args), list: [JSON.stringify(args)] } : "echo " + JSON.stringify(args);
      if (this.mode === "fail") throw new Error("could not use " + JSON.stringify(args));
      return null;
    }
    return super.call(method, args);
  }
}

/** A host with one paired phone that follows its parts. */
async function setup(options: Record<string, unknown> = {}, follow = true) {
  const dir = scratch("host");
  const backend = new Recording({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"], searchPath: [], ...options });
  await link.setEnabled(true);
  const paired = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, phone);
  const parts: Record<string, any> = {};
  let waiters: (() => void)[] = [];
  const client = new LinkClient(paired, {
    fetch: fetcher,
    onParts(next) {
      Object.assign(parts, next);
      for (const wake of waiters) wake();
      waiters = [];
    },
    onState() {},
  });
  // A phone's own follow loop holds one wait open; a test of the waiters leaves it off.
  if (follow) client.start();
  const until = async (check: () => boolean, what: string, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), delay(50)]);
    }
  };
  if (follow) await until(() => !!parts.bots, "the first state");
  const call = (method: string, ...args: unknown[]): Promise<any> => (client as any).call(method, ...args);
  const done = async () => {
    client.stop();
    await link.stop();
  };
  return { dir, link, backend, client, parts, until, call, done, deviceId: paired.deviceId };
}

/** Every file under a folder, read as text. */
function everything(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    text += name.isDirectory() ? everything(path) : readFileSync(path, "latin1");
  }
  return text;
}

/** Fake command-line programs in a folder of their own. `STATE` in a script is a folder it keeps notes in. */
function fakeTools(scripts: Record<string, string>) {
  const dir = scratch("tools");
  const state = scratch("state");
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), '#!/bin/sh\nSTATE="' + state + '"\n' + body, { mode: 0o755 });
  const note = (file: string) => (existsSync(join(state, file)) ? readFileSync(join(state, file), "utf8") : "");
  const mark = (file: string) => writeFileSync(join(state, file), "");
  const unmark = (file: string) => rmSync(join(state, file), { force: true });
  return { dir, state, note, mark, unmark };
}

const OP = `
echo "$*" >> "$STATE/op.log"
env | cut -d= -f1 | sort | tr '\\n' ' ' >> "$STATE/op.env"; echo >> "$STATE/op.env"
case "$*" in
  "--version") echo 2.30.0 ;;
  "whoami --format json") [ -f "$STATE/signedin" ] || exit 1; echo '{"url":"my.1password.com","email":"me@example.com"}' ;;
  "vault list --format json") echo '[{"id":"vault-uuid-1","name":"Work"},{"id":"vault-uuid-2","name":"Home"}]' ;;
  "item list --vault vault-uuid-1 --format json") echo '[{"id":"item-uuid-1","title":"GitHub","additional_information":"octocat"},{"id":"item-uuid-2","title":"AWS","additional_information":"root"}]' ;;
  "item get item-uuid-1 --vault vault-uuid-1 --format json") echo '{"id":"item-uuid-1","title":"GitHub","fields":[{"id":"username","label":"username","type":"STRING","value":"octocat"},{"id":"tokfield1","label":"token","type":"CONCEALED","value":"ghp_FAKE_VALUE"},{"id":"empty1","label":"empty","type":"STRING"}]}' ;;
  "read --no-newline op://vault-uuid-1/item-uuid-1/tokfield1") [ -f "$STATE/broken" ] && exit 1; printf %s ghp_FAKE_VALUE ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;

const LONG_NAME = "n".repeat(110);
const BW = `
echo "$*" >> "$STATE/bw.log"
env | grep -c '^BW_PASSWORD=' >> "$STATE/bw.password"
echo "\${BW_SESSION:-none}" >> "$STATE/bw.session"
case "$1" in
  --version) echo 2025.1.0 ;;
  status)
    [ "$BW_SESSION" = "TOKEN-123" ] && [ -f "$STATE/unlocked" ] && { echo '{"status":"unlocked","userEmail":"me@example.com"}'; exit 0; }
    echo '{"status":"locked","userEmail":"me@example.com"}' ;;
  unlock) [ "$BW_PASSWORD" = "correct horse" ] || exit 1; touch "$STATE/unlocked"; printf TOKEN-123 ;;
  lock) rm -f "$STATE/unlocked" ;;
  list)
    [ "$BW_SESSION" = "TOKEN-123" ] || exit 1
    case "$2" in
      folders) echo '[{"id":null,"name":"No Folder"},{"id":"folder-uuid-1","name":"Dev"}]' ;;
      items) echo '[{"id":"bw-item-1","name":"GitHub","login":{"username":"octocat","password":"bw-secret-VALUE"}}]' ;;
    esac ;;
  get)
    [ "$BW_SESSION" = "TOKEN-123" ] || exit 1
    case "$2" in
      item) echo '{"id":"bw-item-1","name":"GitHub","login":{"username":"octocat","password":"bw-secret-VALUE","totp":"JBSWY3DP"},"fields":[{"name":"api token","value":"bw-custom-VALUE","type":1},{"name":"${LONG_NAME}","value":"long-VALUE","type":1}]}' ;;
      totp) echo 123456 ;;
    esac ;;
  *) exit 2 ;;
esac
`;

const PASS = `
echo "$*" >> "$STATE/pass.log"
case "$*" in
  "--version") echo "Proton Pass CLI 2.2.5 (abc123)" ;;
  "agent --help") echo "Manage agent tokens" ;;
  "info --output json") [ -f "$STATE/signedin" ] || exit 1; echo '{"user":{"email":"me@proton.test"}}' ;;
  "vault list --output json") echo '{"vaults":[{"share_id":"share-1","name":"Personal"}]}' ;;
  "item list --share-id=share-1 --output json") echo '{"items":[{"id":"p-item-1","content":{"title":"Mail","content":{"Login":{"username":"me","password":"p-VALUE"}}}}]}' ;;
  "item view --share-id=share-1 --item-id=p-item-1 --output json") echo '{"item":{"content":{"title":"Mail","content":{"Login":{"username":"me","password":"p-VALUE"}},"extra_fields":[{"name":"recovery","type":"hidden"}]}}}' ;;
  "item view --share-id=share-1 --item-id=p-item-1 --field=password") echo p-VALUE ;;
  *) exit 2 ;;
esac
`;

// ── Capabilities and parts ────────────────────────────────────────────────────────────────────

test("the host says what it can do, and its parts hold no credentials or screen yet", async () => {
  const { parts, link, done } = await setup();
  for (const name of ["credentials-v1", "screen-v1", "prs-v1", "uploads-v1", "relay-v1"]) assert.ok(parts.meta.capabilities.includes(name), name);
  assert.deepEqual(parts.credentials, []);
  assert.deepEqual(parts.host, { screen: "off", relay: false });
  assert.deepEqual(link.status().screen, { mode: "off", viewers: [] });
  await done();
});

// ── Credentials ───────────────────────────────────────────────────────────────────────────────

test("a credential is saved encrypted, listed without its value, kept on null and removed", async () => {
  const { dir, link, parts, until, call, done } = await setup();
  const secret = "sk-test-0123456789-VALUE";
  const answers: unknown[] = [];
  await assert.rejects(call("link.credentials.save", { name: "No value" }), /value/);
  await assert.rejects(call("link.credentials.save", { name: "", value: "x" }), /name/);
  await assert.rejects(call("link.credentials.save", { name: "Big", value: "x".repeat(16_001) }), /16,000/);
  const id = await call("link.credentials.save", { name: "OpenAI", kind: "api-key", website: "https://example.com", notes: "for tests", value: secret });
  answers.push(id);
  await until(() => parts.credentials.length === 1, "the credential in the list");
  const [entry] = parts.credentials;
  assert.equal(entry.id, id);
  assert.equal(entry.source, "vault");
  assert.equal(entry.kind, "api-key");
  assert.equal(entry.name, "OpenAI");
  assert.equal(entry.value, undefined);
  assert.equal(entry.secret, undefined);

  answers.push(await call("link.credentials.check", id));
  assert.deepEqual(answers[1], { ok: true });
  assert.equal(await link.credentials.read(id), secret, "the computer can read it");

  // The file holds it encrypted, readable only by the person.
  const file = join(dir, "credentials.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes(secret) && !saved.includes(b64(secret)), "the value isn't in the file");
  assert.ok(!existsSync(file + ".tmp"), "the write was atomic");

  // value: null (or none) keeps the saved value while the rest changes.
  await call("link.credentials.save", { id, name: "OpenAI (work)", value: null, username: "me" });
  await call("link.credentials.save", { id, name: "OpenAI (work)", notes: "" });
  await until(() => parts.credentials[0].name === "OpenAI (work)" && parts.credentials[0].notes === undefined, "the change");
  assert.equal(parts.credentials[0].username, "me");
  assert.equal(await link.credentials.read(id), secret, "the value was kept");
  await call("link.credentials.save", { id, name: "OpenAI (work)", value: "second-VALUE" });
  assert.equal(await link.credentials.read(id), "second-VALUE");

  // No part and no answer ever holds a value.
  const everyone = JSON.stringify([parts, answers, await call("link.credentials.managers")]);
  assert.ok(!everyone.includes(secret) && !everyone.includes("second-VALUE"));

  await assert.rejects(call("link.credentials.save", { id: "cred-nope", name: "X", value: "y" }), /no longer exists/);
  await call("link.credentials.remove", id);
  await until(() => parts.credentials.length === 0, "the list to empty");
  assert.deepEqual(await call("link.credentials.check", id), { ok: false, message: "That credential no longer exists." });
  await done();
});

test("the vault's key goes through the keychain hooks, and a vault that can't be opened is only listed", async () => {
  const wraps: string[] = [];
  const hooks = {
    protect: (text: string) => {
      wraps.push("protect");
      return "wrapped:" + [...text].reverse().join("");
    },
    reveal: (text: string) => {
      wraps.push("reveal");
      return [...text.slice(8)].reverse().join("");
    },
  };
  const { dir, link, call, done } = await setup(hooks);
  const id = await call("link.credentials.save", { name: "Wrapped", value: "wrapped-VALUE" });
  assert.ok(wraps.includes("protect"));
  const file = join(dir, "credentials.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.wrapped, true);
  assert.match(saved.key, /^wrapped:/);
  assert.ok(!everything(dir).includes("wrapped-VALUE"));
  assert.equal(await link.credentials.read(id), "wrapped-VALUE");
  await done();

  // The same folder opened with the hooks reads it back.
  const again = new Credentials({ dir, ...hooks, searchPath: [] });
  assert.equal(again.locked, false);
  assert.equal(await again.read(id), "wrapped-VALUE");

  // Without the way to unwrap the key, it is listed but not read, changed or overwritten.
  const before = readFileSync(file);
  for (const locked of [new Credentials({ dir, protect: hooks.protect, searchPath: [] }), new Credentials({ dir, ...hooks, reveal: () => { throw new Error("no keychain"); }, searchPath: [] })]) {
    assert.equal(locked.locked, true);
    assert.equal(locked.list().length, 1);
    assert.equal(locked.list()[0].name, "Wrapped");
    await assert.rejects(locked.read(id), /locked/);
    assert.deepEqual(await locked.check(id), { ok: false, message: "The saved credentials are locked on this computer." });
    await assert.rejects(locked.save({ name: "New", value: "v" }), /locked/);
    await assert.rejects(locked.save({ id, name: "Renamed" }), /locked/);
    assert.throws(() => locked.remove(id), /locked/);
  }
  assert.deepEqual(readFileSync(file), before, "the file wasn't touched");
});

// ── Using a credential without it reaching the phone ──────────────────────────────────────────

test("a credential reference is filled in at fixed places of three calls, and refused everywhere else", async () => {
  const { backend, call, done, parts, until } = await setup();
  const secret = "ref-secret-VALUE-42";
  const id = await call("link.credentials.save", { name: "Token", value: secret });
  const bearer = await call("link.credentials.save", { name: "Has scheme", value: "Bearer abc123" });
  const ref = { $credential: id };
  const withPrefix = { $credential: id, prefix: "Bearer " };

  // The places: an answer's value and its content, a server's env, headers and client secret, a service's key.
  await call("respond", "req-1", { action: "accept", value: ref, content: { token: ref, plain: "x" } });
  await call("saveMcpServer", { name: "files", type: "http", url: "https://example.com", env: { TOKEN: ref, KEEP: { $credential: id, prefix: "Bearer " } }, headers: { Authorization: withPrefix, "X-Key": ref, Done: { $credential: bearer, prefix: "Bearer " } }, oauth: { clientSecret: ref } });
  await call("connectProviderService", "opencode", "google", { key: withPrefix });
  const [[, respond], [, mcp], [, provider]] = backend.calls;
  assert.equal(respond[1].value, secret);
  assert.deepEqual(respond[1].content, { token: secret, plain: "x" });
  assert.equal(mcp[0].env.TOKEN, secret);
  assert.equal(mcp[0].env.KEEP, secret, "a prefix is honored for headers and keys only");
  assert.equal(mcp[0].headers.Authorization, "Bearer " + secret);
  assert.equal(mcp[0].headers["X-Key"], secret);
  assert.equal(mcp[0].headers.Done, "Bearer abc123", "a prefix isn't doubled");
  assert.equal(mcp[0].oauth.clientSecret, secret);
  assert.equal(provider[2].key, "Bearer " + secret);

  // Anywhere else, in these calls or any other, the call is refused and never made.
  const there = /A credential can't be used there/;
  const refused: [string, unknown[]][] = [
    ["saveMcpServer", [{ name: ref, type: "http", url: "https://example.com" }]],
    ["saveMcpServer", [{ name: "x", type: "http", url: ref }]],
    ["saveMcpServer", [{ name: "x", type: "stdio", command: ref }]],
    ["saveMcpServer", [{ name: "x", type: "stdio", command: "node", args: [ref] }]],
    ["saveMcpServer", [{ name: "x", type: "stdio", command: "node", cwd: ref }]],
    ["saveMcpServer", [{ name: "x", type: "http", url: "https://example.com", env: { A: { nested: ref } } }]],
    ["saveMcpServer", [{ name: "x", type: "http", url: "https://example.com", headers: ref }]],
    ["saveMcpServer", [{ name: "x", type: "http", url: "https://example.com", oauth: { clientId: ref } }]],
    ["saveMcpServer", [{ name: "x", type: "http", url: "https://example.com", oauth: { clientSecret: { $credential: id, extra: 1 } } }]],
    ["saveMcpServer", [{ name: "x", type: "http", url: "https://example.com", env: { A: [ref] } }]],
    ["saveMcpServer", [ref]],
    ["respond", ["req-2", { action: "accept", content: { deep: { x: ref } } }]],
    ["respond", ["req-2", { action: "accept", content: { list: [ref] } }]],
    ["respond", ["req-2", { action: ref }]],
    ["respond", [ref, { action: "accept" }]],
    ["respond", ["req-2", { action: "accept", value: { $credential: id, extra: 1 } }]],
    ["connectProviderService", [ref, "google", { key: "k" }]],
    ["connectProviderService", ["opencode", ref, { key: "k" }]],
    ["connectProviderService", ["opencode", "google", { method: ref }]],
    ["connectProviderService", ["opencode", "google", { key: "k", also: ref }]],
    ["updateBot", ["bot-mira", { summary: ref }]],
    ["addBot", [{ name: ref, role: "", instructions: "", face: "idle" }]],
    ["send", ["chat-launch", ref]],
    ["send", ["chat-launch", "hi", { quote: ref }]],
    ["renameChat", ["chat-launch", ref]],
  ];
  const before = backend.calls.length;
  for (const [method, args] of refused) await assert.rejects(call(method, ...args), there, method + " " + JSON.stringify(args));
  assert.equal(backend.calls.length, before, "none of them reached the desktop");
  await assert.rejects(call("link.adoptMcpSignIn", "mcp-linear", { clientId: ref }), there);
  await assert.rejects(call("link.credentials.save", { name: "x", value: ref }), /can't be saved/);

  // A credential that can't be read stops the call, and the message holds no value.
  await assert.rejects(call("respond", "req-3", { action: "accept", value: { $credential: "cred-unknown" } }), (error: Error) => /can't be read right now: That credential no longer exists/.test(error.message));
  assert.equal(backend.calls.length, before);

  // Nothing a phone can read brings the value back: the tool list, the answers, any part.
  backend.real.add("saveMcpServer");
  const server = await call("saveMcpServer", { name: "kept", type: "http", url: "https://example.com", env: { TOKEN: ref }, headers: { Authorization: withPrefix } });
  await until(() => parts.mcp.some((m: any) => m.id === server), "the server in the list");
  await assert.rejects(call("saveMcpServer", { name: ref, type: "http", url: "https://example.com" }), there);
  assert.deepEqual(parts.mcp.find((m: any) => m.id === server).env, ["TOKEN"], "names only");
  assert.ok(!JSON.stringify([parts, server]).includes(secret));
  await done();
});

test("a value the desktop echoes back or puts in an error is hidden before it reaches a phone", async () => {
  const { backend, call, done } = await setup();
  const secret = "echo-secret-VALUE";
  const id = await call("link.credentials.save", { name: "Token", value: secret });
  const ref = { $credential: id };
  const withPrefix = { $credential: id, prefix: "Bearer " };

  backend.mode = "echo";
  const said = await call("respond", "req-1", { action: "accept", value: ref });
  assert.equal(typeof said, "string");
  assert.ok(said.includes("•••") && !said.includes(secret), said);
  const object = await call("connectProviderService", "opencode", "google", { key: withPrefix });
  assert.ok(!JSON.stringify(object).includes(secret) && JSON.stringify(object).includes("•••"), JSON.stringify(object));

  backend.mode = "fail";
  for (const [method, args] of [["respond", ["req-1", { action: "accept", value: ref }]], ["saveMcpServer", [{ name: "x", type: "http", url: "https://example.com", headers: { Authorization: withPrefix } }]]] as [string, unknown[]][]) {
    await assert.rejects(call(method, ...args), (error: Error) => error.message.startsWith("could not use ") && error.message.includes("•••") && !error.message.includes(secret));
  }
  // Without a reference the desktop's own message is left as it is.
  await assert.rejects(call("respond", "req-1", { action: "accept", value: "plain" }), /could not use .*plain/);
  assert.equal(scrub({ a: ["x token-1 y", 1, null], b: { c: "token-1" } }, ["token-1", ""]).a[0], "x ••• y");
  await done();
});

test("an error that isn't a plain sentence of the link's or the desktop's own doesn't tell a phone about the computer", async () => {
  const logs: string[] = [];
  const { backend, link, call, done } = await setup({ log: (line: string) => logs.push(line) });
  const system = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/.secret/file'"), { code: "ENOENT", errno: -2, syscall: "open", path: "/Users/someone/.secret/file" });
  backend.extras = { ...backend.extras, boom: () => { throw system; }, nice: () => { throw new Error("Pick a smaller number."); } };
  await assert.rejects(call("link.boom"), (error: Error) => error.message === "That didn't work on your computer.");
  await assert.rejects(call("link.nice"), /Pick a smaller number\./);
  await assert.rejects(call("renameChat", "chat-launch", ""), /Enter a title/);

  // The link's own calls give a sentence of their own or the plain one, never an internal.
  const save = link.credentials.save;
  link.credentials.save = () => { throw new TypeError("Cannot read properties of undefined (reading '/Users/someone/x')"); };
  await assert.rejects(call("link.credentials.save", { name: "x", value: "y" }), (error: Error) => error.message === "That didn't work on your computer.");
  link.credentials.save = save;
  await assert.rejects(call("link.credentials.save", { name: "" }), /name/);
  assert.ok(logs.some((line) => line.includes("Cannot read properties")), "the detail is logged on the computer");
  await done();
});

test("only a host's own names are reachable as extras", async () => {
  const { backend, call, done } = await setup();
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "credentials.constructor", "screen.__proto__"]) {
    await assert.rejects(call("link." + name), /doesn't support that yet/, name);
  }
  assert.ok(await call("link.adoptMcpSignIn", "mcp-linear", {}), "a real extra still works");
  assert.ok(backend.extras.adoptMcpSignIn);
  await done();
});

// ── Password managers, with fake command-line tools ────────────────────────────────────────────

test("1Password is read through op: status, vaults, items, fields, link, check and use", async () => {
  const tools = fakeTools({ op: OP });
  process.env.BOTKINS_TEST_SECRET = "must-not-leak";
  process.env.OP_SESSION_demo = "session-passes-through";
  const { dir, link, parts, until, call, backend, done } = await setup({ searchPath: [tools.dir] });
  try {
    const status = async () => (await call("link.credentials.managers", true)).find((m: any) => m.id === "onepassword");
    assert.equal((await call("link.credentials.managers", true)).length, 3);
    assert.equal((await status()).state, "signed-out");
    assert.match((await status()).message, /CLI integration/);
    tools.mark("signedin");
    assert.deepEqual(await status(), { id: "onepassword", name: "1Password", state: "ready", version: "2.30.0", account: "me@example.com" });
    assert.equal((await call("link.credentials.managers", true)).find((m: any) => m.id === "bitwarden").state, "missing");

    assert.deepEqual(await call("link.credentials.vaults", "onepassword"), [{ id: "vault-uuid-1", name: "Work" }, { id: "vault-uuid-2", name: "Home" }]);
    assert.equal((await call("link.credentials.items", "onepassword", "vault-uuid-1")).length, 2);
    assert.deepEqual(await call("link.credentials.items", "onepassword", "vault-uuid-1", "git"), [{ id: "item-uuid-1", title: "GitHub", subtitle: "octocat" }]);
    const item = await call("link.credentials.item", "onepassword", "vault-uuid-1", "item-uuid-1");
    assert.deepEqual(item.fields, [{ id: "username", label: "username", secret: false }, { id: "tokfield1", label: "token", secret: true }]);
    assert.ok(!JSON.stringify(item).includes("ghp_FAKE_VALUE"), "no value comes back with the labels");
    await assert.rejects(call("link.credentials.items", "onepassword", "--vault"), /isn't valid/);
    await assert.rejects(call("link.credentials.vaults", "nothing"), /isn't supported/);

    // Linking keeps only the place, and shows it as text.
    await assert.rejects(call("link.credentials.link", { manager: "onepassword", vaultId: "vault-uuid-1", itemId: "item-uuid-1", fieldId: "nope", name: "X" }), /isn't on the item/);
    const id = await call("link.credentials.link", { manager: "onepassword", vaultId: "vault-uuid-1", itemId: "item-uuid-1", fieldId: "tokfield1", name: "GitHub token" });
    await until(() => parts.credentials.length === 1, "the linked credential");
    assert.equal(parts.credentials[0].source, "onepassword");
    assert.equal(parts.credentials[0].reference, "Work / GitHub / token");
    const shown = JSON.stringify(parts);
    for (const hidden of ["vault-uuid-1", "item-uuid-1", "tokfield1", "ghp_FAKE_VALUE"]) assert.ok(!shown.includes(hidden), hidden + " stays on the computer");
    await assert.rejects(call("link.credentials.save", { id, name: "x", value: "new" }), /read from its password manager/);

    // It is read from the manager at the moment of use.
    assert.deepEqual(await call("link.credentials.check", id), { ok: true });
    await call("respond", "req-1", { action: "accept", value: { $credential: id } });
    assert.equal(backend.calls.at(-1)![1][1].value, "ghp_FAKE_VALUE");
    tools.mark("broken");
    const broken = await call("link.credentials.check", id);
    assert.equal(broken.ok, false);
    assert.equal(broken.message, "1Password reported an error.");
    await assert.rejects(call("respond", "req-2", { action: "accept", value: { $credential: id } }), /can't be read right now: 1Password reported an error/);

    // The tool got a small environment: nothing of this app's, the manager's own variables kept.
    const names = tools.note("op.env").trim().split("\n")[0].split(" ");
    assert.ok(names.includes("PATH") && names.includes("HOME") && names.includes("OP_SESSION_demo"));
    assert.ok(!names.includes("BOTKINS_TEST_SECRET"));
    assert.ok(!everything(dir).includes("ghp_FAKE_VALUE"));
    assert.equal(await link.credentials.read(id).catch(() => "broken"), "broken");
  } finally {
    delete process.env.BOTKINS_TEST_SECRET;
    delete process.env.OP_SESSION_demo;
    await done();
  }
});

test("Bitwarden unlocks with the password in the tool's environment, and keeps the session in memory only", async () => {
  const tools = fakeTools({ bw: BW });
  let clock = Date.now();
  const dir = scratch("host");
  const credentials = new Credentials({ dir, searchPath: [tools.dir], now: () => clock });
  const status = async () => (await credentials.managers(true)).find((m: any) => m.id === "bitwarden");

  assert.deepEqual(await status(), { id: "bitwarden", name: "Bitwarden", state: "locked", canUnlock: true, version: "2025.1.0", account: "me@example.com", message: "Enter your master password to unlock Bitwarden." });
  await assert.rejects(credentials.vaults("bitwarden"), /locked/);
  await assert.rejects(credentials.unlock("bitwarden", { password: "wrong" }), /Check the master password/);
  await assert.rejects(credentials.unlock("bitwarden", { password: "" }), /Enter the master password/);
  await assert.rejects(credentials.unlock("onepassword", { password: "x" }), /on your computer/);

  const ready = await credentials.unlock("bitwarden", { password: "correct horse" });
  assert.equal(ready.state, "ready");
  assert.ok(!JSON.stringify(ready).includes("TOKEN-123"), "the session isn't in the answer");
  assert.ok(!everything(dir).includes("TOKEN-123") && !everything(dir).includes("correct horse"), "nothing on disk holds the session or the password");

  assert.deepEqual(await credentials.vaults("bitwarden"), [{ id: "folder-uuid-1", name: "Dev" }, { id: "none", name: "No folder" }]);
  assert.deepEqual(await credentials.items("bitwarden", "none", "git"), [{ id: "bw-item-1", title: "GitHub", subtitle: "octocat" }]);
  const item = await credentials.item("bitwarden", "none", "bw-item-1");
  assert.deepEqual(item.fields, [
    { id: "username", label: "Username", secret: false },
    { id: "password", label: "Password", secret: true },
    { id: "totp", label: "One-time password", secret: true },
    { id: "field:api token", label: "api token", secret: true },
    { id: "field:" + LONG_NAME.slice(0, 100), label: LONG_NAME.slice(0, 100), secret: true },
  ]);
  const id = await credentials.link({ manager: "bitwarden", vaultId: "none", itemId: "bw-item-1", fieldId: "field:api token", name: "Custom" });
  const totp = await credentials.link({ manager: "bitwarden", vaultId: "none", itemId: "bw-item-1", fieldId: "totp", name: "Code" });
  assert.equal(credentials.list()[0].reference, "No folder / GitHub / api token");
  assert.equal(await credentials.read(id), "bw-custom-VALUE");
  assert.equal(await credentials.read(totp), "123456");
  // A field name that was cut short when listed is found again by the same cut.
  const long = await credentials.link({ manager: "bitwarden", vaultId: "none", itemId: "bw-item-1", fieldId: "field:" + LONG_NAME.slice(0, 100), name: "Long" });
  assert.equal(await credentials.read(long), "long-VALUE");

  // The password was in the environment of the unlock call only. The session is in the environment
  // of every later call and never on a command line, and no call can stop to ask a question.
  const log = tools.note("bw.log").trim().split("\n");
  assert.ok(log.includes("unlock --passwordenv BW_PASSWORD --raw --nointeraction"));
  for (const line of log) assert.match(line, / --nointeraction$/);
  assert.ok(!tools.note("bw.log").includes("TOKEN-123") && !tools.note("bw.log").includes("--session"), "the session was never in the arguments");
  const withPassword = tools.note("bw.password").trim().split("\n").flatMap((count, index) => (count === "1" ? [log[index].split(" ")[0]] : []));
  assert.ok(withPassword.length > 0 && withPassword.every((command) => command === "unlock"), "BW_PASSWORD reached only unlock: " + withPassword);
  const later = log.filter((line) => /^(list|get)/.test(line));
  assert.ok(later.length > 0);
  const sessions = tools.note("bw.session").trim().split("\n");
  for (const line of later) assert.equal(sessions[log.indexOf(line)], "TOKEN-123", "the session came in the environment for: " + line);

  // Locking forgets it, and so do eight idle hours.
  assert.equal((await credentials.lock("bitwarden")).state, "locked");
  assert.match(tools.note("bw.log"), /^lock --nointeraction$/m);
  await assert.rejects(credentials.vaults("bitwarden"), /locked/);
  await credentials.unlock("bitwarden", { password: "correct horse" });
  assert.equal((await status()).state, "ready");
  clock += 8 * 60 * 60_000 + 1000;
  assert.equal((await status()).state, "locked");
  await assert.rejects(credentials.vaults("bitwarden"), /locked/);
});

test("Proton Pass is read through pass-cli with the syntax its help shows", async () => {
  const tools = fakeTools({ "pass-cli": PASS });
  const credentials = new Credentials({ dir: scratch("host"), searchPath: [tools.dir] });
  const status = async () => (await credentials.managers(true)).find((m: any) => m.id === "protonpass");
  assert.equal((await status()).state, "signed-out");
  tools.mark("signedin");
  assert.equal((await status()).state, "signed-out", "the user's legacy session is not a Botkins connection");
  assert.equal((await status()).source, "path");
  assert.deepEqual(await credentials.vaults("protonpass"), [{ id: "share-1", name: "Personal" }]);
  assert.deepEqual(await credentials.items("protonpass", "share-1", "mail"), [{ id: "p-item-1", title: "Mail", subtitle: "me" }]);
  const item = await credentials.item("protonpass", "share-1", "p-item-1");
  assert.deepEqual(item.fields.map((f: any) => f.id), ["username", "password", "extra:recovery"]);
  const id = await credentials.link({ manager: "protonpass", vaultId: "share-1", itemId: "p-item-1", fieldId: "password", name: "Mail password" });
  assert.equal(await credentials.read(id), "p-VALUE");
  assert.ok(!tools.note("pass.log").includes("--show-secrets"));
});

// ── Pull requests, with a fake gh ─────────────────────────────────────────────────────────────

test("pull requests come from gh in the project's folder, and failures say why", async () => {
  const tools = fakeTools({
    gh: `
echo "$*" >> "$STATE/gh.log"; pwd -P >> "$STATE/gh.cwd"
[ -f "$STATE/noauth" ] && { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }
[ -f "$STATE/norepo" ] && { echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 1; }
case "$1 $2" in
  "pr list") echo '[{"number":12,"title":"Add the screen viewer","url":"https://github.com/acme/botkins/pull/12","state":"OPEN","isDraft":true,"author":{"login":"octocat"},"headRefName":"screen","baseRefName":"main","updatedAt":"2026-11-01T10:00:00Z"},{"number":9,"title":"Fix pairing","url":"https://github.com/acme/botkins/pull/9","state":"MERGED","isDraft":false,"author":{"login":"hubot"},"headRefName":"fix","baseRefName":"main","updatedAt":"2026-10-20T10:00:00Z"}]' ;;
  "pr view") [ "$3" = "7" ] && echo '{"number":7,"title":"Old idea","url":"https://github.com/acme/botkins/pull/7","state":"CLOSED","isDraft":false,"author":{"login":"octocat"},"headRefName":"idea","baseRefName":"main","updatedAt":"2026-01-01T10:00:00Z"}' || { echo "no pull requests found" >&2; exit 1; } ;;
esac
`,
  });
  const folder = scratch("repo");
  const { backend, call, done } = await setup({ searchPath: [tools.dir] });
  const project = backend.state.projects[0];
  project.folder = folder;
  try {
    // A chat with a project: gh runs in the project's folder.
    const found = await call("link.pullRequests", { chatId: "chat-auth" });
    assert.equal(found.available, true);
    assert.deepEqual(found.items[0], { number: 12, title: "Add the screen viewer", url: "https://github.com/acme/botkins/pull/12", state: "open", draft: true, author: "octocat", head: "screen", base: "main", updatedAt: "2026-11-01T10:00:00Z", repository: "acme/botkins" });
    assert.equal(found.items[1].state, "merged");
    assert.equal(tools.note("gh.cwd").trim(), folder);
    assert.match(tools.note("gh.log"), /^pr list --state all --limit 30 --json number,title,url,state,isDraft,author,headRefName,baseRefName,updatedAt$/m);

    // The same question within 30 seconds isn't asked again; another one is.
    const lines = () => tools.note("gh.log").trim().split("\n").length;
    const count = lines();
    await call("link.pullRequests", { chatId: "chat-auth" });
    assert.equal(lines(), count);
    await call("link.pullRequests", { projectId: project.id }, "screen -label:wip");
    assert.equal(lines(), count + 1);
    assert.match(tools.note("gh.log"), /--search=screen -label:wip$/m);

    // A search that starts with "-" stays one argument and doesn't become an option.
    await call("link.pullRequests", { projectId: project.id }, "-label:wip");
    assert.match(tools.note("gh.log"), /^pr list .* --search=-label:wip$/m);
    // Qualifiers that reach other repositories are taken out; with nothing left there is no search.
    await call("link.pullRequests", { projectId: project.id }, 'repo:other/secret bug OWNER:me -repo:x org:y user:z "fix it" repo:"a b"');
    assert.match(tools.note("gh.log"), /--search=bug "fix it"$/m);
    // With nothing left of the search, it is the plain list (the one asked for first, still kept).
    assert.equal((await call("link.pullRequests", { projectId: project.id }, "repo:other/secret org:acme")).items.length, 2);
    assert.ok(!tools.note("gh.log").includes("secret") && !tools.note("gh.log").includes("org:"));
    // A qualifier inside brackets is one too.
    await call("link.pullRequests", { projectId: project.id }, "(repo:a/hidden OR repo:c/d) crash");
    assert.match(tools.note("gh.log"), /--search=\( OR \) crash$/m);
    assert.ok(!tools.note("gh.log").includes("hidden"));

    // A number is looked up directly first; one that doesn't exist falls back to the list.
    const seven = await call("link.pullRequests", { projectId: project.id }, "7");
    assert.deepEqual(seven.items.map((pr: any) => [pr.number, pr.state]), [[7, "closed"], [12, "open"], [9, "merged"]]);
    assert.match(tools.note("gh.log"), /^pr view 7 --json /m);
    assert.deepEqual((await call("link.pullRequests", { projectId: project.id }, "#8")).items.map((pr: any) => pr.number), [12, 9]);

    // Reasons a person can act on.
    assert.deepEqual(await call("link.pullRequests", { chatId: "chat-launch" }), { available: false, reason: "This chat isn't in a project folder.", items: [] });
    assert.equal((await call("link.pullRequests", { chatId: "no-chat" })).reason, "This chat isn't in a project folder.");
    tools.mark("noauth");
    assert.match((await call("link.pullRequests", { projectId: project.id }, "fresh query")).reason, /Sign in to the GitHub CLI/);
    tools.mark("norepo");
    tools.unmark("noauth");
    assert.equal((await call("link.pullRequests", { projectId: project.id }, "another query")).reason, "This project isn't a GitHub repository.");
    // A failed lookup is kept for 30 seconds too, so asking again doesn't start gh again.
    tools.unmark("norepo");
    const asked = tools.note("gh.log").trim().split("\n").length;
    assert.equal((await call("link.pullRequests", { projectId: project.id }, "another query")).reason, "This project isn't a GitHub repository.");
    assert.equal(tools.note("gh.log").trim().split("\n").length, asked);
  } finally {
    await done();
  }

  const none = await setup({ searchPath: [scratch("empty")] });
  none.backend.state.projects[0].folder = folder;
  assert.deepEqual(await none.call("link.pullRequests", { chatId: "chat-auth" }), { available: false, reason: "Install the GitHub CLI (gh) on your computer and sign in.", items: [] });
  await none.done();
});

// ── Uploads ───────────────────────────────────────────────────────────────────────────────────

test("an upload gets a safe name, comes in parts, and stays inside its phone's folder", async () => {
  const { dir, call, deviceId, done, link } = await setup();
  const mine = join(dir, "uploads", deviceId) + sep;

  const one = await call("link.upload", { name: "../../etc/pa ss\\wd\u0007.txt", data: b64("hello, computer") });
  assert.equal(one.name, "wd.txt");
  assert.ok(one.path.startsWith(mine) && one.path.endsWith(one.id + "-wd.txt"), one.path);
  assert.equal(one.size, 15);
  assert.equal(readFileSync(one.path, "utf8"), "hello, computer");
  assert.equal(statSync(one.path).mode & 0o777, 0o600);

  // A file in parts: no id starts it, the same id appends, last finishes it.
  const first = await call("link.upload", { name: "big.bin", data: b64("AAA"), last: false });
  await call("link.upload", { id: first.id, name: "ignored", data: b64("BBB") });
  const last = await call("link.upload", { id: first.id, name: "big.bin", data: b64("CCC"), last: true });
  assert.equal(last.id, first.id);
  assert.equal(last.path, first.path);
  assert.equal(last.size, 9);
  assert.equal(readFileSync(last.path, "utf8"), "AAABBBCCC");
  await assert.rejects(call("link.upload", { id: first.id, name: "big.bin", data: b64("D") }), /isn't open any more/);
  await assert.rejects(call("link.upload", { id: "unknown-id", name: "x", data: b64("D") }), /isn't open any more/);
  await assert.rejects(call("link.upload", { name: "x", data: "not base64 !!" }), /4 MB/);
  await assert.rejects(call("link.upload", { name: "x" }), /can't be sent/);

  // A part of the most that one call may hold (4 MB) makes it through the link.
  const part = await call("link.upload", { name: "four.bin", data: Buffer.alloc(4 * 1024 * 1024, 1).toString("base64"), last: false });
  assert.equal(part.size, 4 * 1024 * 1024);
  await call("link.upload", { id: part.id, data: "", last: true });

  // More than 4 MB in one call is refused, and nothing is written for it.
  const before = readdirSync(mine).length;
  await assert.rejects(link.uploads.put(deviceId, { name: "huge", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }), /4 MB/);
  assert.equal(readdirSync(mine).length, before);
  await done();
});

test("names are made safe", () => {
  assert.equal(safeName("a/b/c.txt"), "c.txt");
  assert.equal(safeName("..\\..\\boot.ini"), "boot.ini");
  assert.equal(safeName("../.."), "file");
  assert.equal(safeName(".."), "file");
  assert.equal(safeName(" .hidden "), "hidden");
  assert.equal(safeName("CON.txt"), "_CON.txt");
  assert.equal(safeName("a:b|c?.txt"), "a_b_c_.txt");
  assert.equal(safeName("tab\tname\u0000.md"), "tabname.md");
  assert.equal(safeName(undefined), "file");
  const long = safeName("x".repeat(300) + ".png");
  assert.ok(long.length <= 120 && long.endsWith(".png"));
});

test("upload limits hold: a file, a phone's folder, and old files", async () => {
  const dir = scratch("uploads");
  const uploads = new Uploads({ dir, limits: { file: 10, device: 25 } });
  const put = (input: Record<string, unknown>) => uploads.put("phone1", { name: "f.txt", ...input } as any);
  const data = (bytes: number) => b64("x".repeat(bytes));

  // A file past its limit is stopped and removed.
  const big = await put({ data: data(6), last: false });
  await assert.rejects(put({ id: big.id, data: data(6), last: true }), /can be sent/);
  assert.ok(!existsSync(big.path));

  // The oldest finished files go first to make room.
  const a = await put({ data: data(10) });
  const b = await put({ data: data(10) });
  const old = new Date(Date.now() - 60_000);
  utimesSync(a.path, old, old);
  const c = await put({ data: data(10) });
  assert.ok(!existsSync(a.path) && existsSync(b.path) && existsSync(c.path), "the oldest was removed");

  // A file still being sent is never the one removed.
  const open = await put({ data: data(10), last: false });
  const d = await put({ data: data(5) });
  assert.ok(existsSync(open.path) && existsSync(d.path));
  assert.ok(!existsSync(b.path) || !existsSync(c.path), "a finished file made room");
  await put({ data: data(10), last: false });
  await assert.rejects(put({ data: data(10), last: false }), /Too many files/);

  // Another phone has its own room.
  await uploads.put("phone2", { name: "f.txt", data: data(10) });
  assert.equal(readdirSync(join(dir, "uploads", "phone2")).length, 1);
  await assert.rejects(uploads.put("../phone3", { name: "f.txt", data: data(1) }), /isn't paired/);

  // Files older than a week are removed when the host starts.
  const kept = await uploads.put("phone2", { name: "kept.txt", data: data(2) });
  const stale = await uploads.put("phone2", { name: "stale.txt", data: data(2) });
  const week = new Date(Date.now() - 8 * 24 * 60 * 60_000);
  utimesSync(stale.path, week, week);
  new Uploads({ dir });
  assert.ok(existsSync(kept.path) && !existsSync(stale.path));
});

test("a message from a phone attaches only files from that phone's own folder", async () => {
  const { dir, link, backend, call, deviceId, done } = await setup();
  const own = await call("link.upload", { name: "notes.txt", data: b64("mine") });
  const other = await link.uploads.put("other-phone", { name: "theirs.txt", data: b64("theirs") });
  const outside = join(scratch("outside"), "secret.txt");
  writeFileSync(outside, "secret");
  const folder = join(dir, "uploads", deviceId);
  symlinkSync(outside, join(folder, "link-out.txt"));
  mkdirSync(join(folder, "sub"));

  await call("send", "chat-launch", "see attached", {
    quote: "q",
    attachments: [
      { name: "notes.txt", path: own.path },
      { name: "again", path: own.path },
      { name: "passwd", path: "/etc/passwd" },
      { name: "theirs", path: other.path },
      { name: "link", path: join(folder, "link-out.txt") },
      { name: "up", path: join(folder, "..", "..", "link.json") },
      { name: "dir", path: join(folder, "sub") },
      { name: "relative", path: "uploads/" + deviceId + "/x" },
      { name: "no path" },
      "nonsense",
    ],
  });
  const [, args] = backend.calls.find(([method]) => method === "send")!;
  assert.equal(args[2].quote, "q", "the other options stay");
  assert.deepEqual(args[2].attachments, [{ name: "notes.txt", path: realpathSync(own.path), kind: "file" }]);

  await call("send", "chat-launch", "nothing attached", { attachments: [{ name: "passwd", path: "/etc/passwd" }] });
  const [, plain] = backend.calls.filter(([method]) => method === "send").at(-1)!;
  assert.equal("attachments" in plain[2], false, "nothing is left to attach");
  await done();
});

// ── The screen ────────────────────────────────────────────────────────────────────────────────

/** A picture as the adapter hands it over: a JPEG (it starts FF D8) followed by whatever `picture` says. */
const jpegOf = (picture: string) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(picture)]);
const seen = (frame: { jpeg: string }) => Buffer.from(frame.jpeg, "base64").subarray(2).toString();

/** A fake screen: the picture is whatever `shown.picture` says, and each capture and lookup is recorded. */
function fakeScreen() {
  const shown = { picture: "picture-A", lag: 20, accessibility: true, raw: null as Buffer | null, during: null as null | (() => void) };
  const captured: { display: string; maxWidth: number; quality: number }[] = [];
  const looked = { displays: 0, permissions: 0 };
  const adapter = {
    displays: async () => {
      looked.displays++;
      return [{ id: "1", label: "Main display", width: 1440, height: 900, primary: true }, { id: "2", label: "Side display", width: 800, height: 600, primary: false }];
    },
    async capture(options: { display: string; maxWidth: number; quality: number }) {
      captured.push(options);
      await delay(shown.lag);
      shown.during?.();
      return { jpeg: shown.raw ?? jpegOf(shown.picture), width: 1000, height: 600 };
    },
    permissions: async () => {
      looked.permissions++;
      return { screenRecording: true, accessibility: shown.accessibility };
    },
  };
  return { shown, captured, looked, adapter };
}

test("the screen is off until the person turns it on; frames have numbers and say when nothing changed", async () => {
  const screen = fakeScreen();
  const { dir, link, backend, parts, until, call, deviceId, done } = await setup({ screenInput: async () => {} });
  backend.screen = screen.adapter;
  const events: { device: string; started: boolean }[] = [];
  link.on("screen", (event: { device: string; started: boolean }) => events.push(event));
  const frame = (options: Record<string, unknown> = {}) => call("link.screen.frame", options);

  // Off: nothing is shown or done.
  const off = await call("link.screen.info");
  assert.equal(off.mode, "off");
  assert.equal(off.canView, false);
  assert.equal(off.canControl, false);
  assert.ok(off.problem);
  await assert.rejects(frame(), /off/);
  await assert.rejects(call("link.screen.input", "1", [{ type: "move", x: 0, y: 0 }]), /off/);
  assert.equal(screen.captured.length, 0);

  // The person turns on viewing; the phone's parts follow, and it survives a restart.
  link.setScreenMode("view");
  await until(() => parts.host.screen === "view", "the host part");
  assert.equal(JSON.parse(readFileSync(join(dir, "link.json"), "utf8")).screen, "view");
  assert.throws(() => link.setScreenMode("everything"), /off, view or control/);
  const info = await call("link.screen.info");
  assert.equal(info.canView, true);
  assert.equal(info.canControl, false);
  assert.deepEqual(info.displays.map((d: any) => d.id), ["1", "2"]);

  // Frames: defaults, clamps, and a number that goes up only when the picture changes.
  const first = await frame();
  assert.equal(seen(first), "picture-A");
  assert.deepEqual([first.display, first.width, first.height], ["1", 1000, 600]);
  assert.deepEqual(screen.captured[0], { display: "1", maxWidth: 1280, quality: 60 });
  await frame({ maxWidth: 99999, quality: 5 });
  assert.deepEqual(screen.captured.at(-1), { display: "1", maxWidth: 1920, quality: 30 });
  await frame({ maxWidth: 10, quality: 100, display: "2" });
  assert.deepEqual(screen.captured.at(-1), { display: "2", maxWidth: 480, quality: 85 });
  await assert.rejects(frame({ display: "9" }), /display/);
  const again = await frame();
  assert.equal(again.seq, first.seq, "same picture, same number");
  screen.shown.picture = "picture-B";
  const second = await frame();
  assert.ok(second.seq > first.seq, "a new picture has a higher number");

  // Callers share one capture per display.
  const count = screen.captured.length;
  screen.shown.lag = 200;
  await Promise.all([frame(), frame()]);
  assert.equal(screen.captured.length, count + 1);
  screen.shown.lag = 20;

  // A paced preview already schedules its next check. One request samples the screen once.
  const beforePreview = screen.captured.length;
  const still = await frame({ after: second.seq, wait: false });
  assert.equal(still.seq, second.seq);
  assert.equal(still.jpeg, undefined);
  assert.equal(screen.captured.length - beforePreview, 1);

  // Waiting for a change: nothing new answers without a picture after about 1.5 seconds.
  const started = Date.now();
  const quiet = await frame({ after: second.seq });
  assert.equal(quiet.jpeg, undefined);
  assert.equal(quiet.seq, second.seq);
  assert.ok(Date.now() - started >= 1300 && Date.now() - started < 3500, "waited " + (Date.now() - started) + " ms");
  // A change while waiting ends the wait with the new picture.
  setTimeout(() => (screen.shown.picture = "picture-C"), 400);
  const waited = Date.now();
  const changed = await frame({ after: second.seq });
  assert.equal(seen(changed), "picture-C");
  assert.ok(changed.seq > second.seq && Date.now() - waited < 1400);
  // An older number gets the picture at once.
  assert.ok((await frame({ after: first.seq })).jpeg);

  // Who is watching.
  assert.deepEqual(events, [{ device: deviceId, started: true }]);
  assert.equal(link.status().screen.viewers[0].deviceId, deviceId);
  assert.equal(link.status().screen.viewers[0].name, "Test phone");
  await call("link.screen.stop");
  assert.deepEqual(events.at(-1), { device: deviceId, started: false });
  assert.deepEqual(link.status().screen.viewers, []);
  await frame();
  assert.equal(events.at(-1)!.started, true);
  link.setScreenMode("off");
  assert.deepEqual(events.at(-1), { device: deviceId, started: false }, "turning it off stops the viewers");
  await assert.rejects(frame(), /off/);
  await until(() => parts.host.screen === "off", "the host part");
  link.setScreenMode("view");
  await frame();
  link.removeDevice(deviceId);
  assert.deepEqual(events.at(-1), { device: deviceId, started: false }, "removing the phone stops it");
  await done();
});

test("a device that stops asking for frames stops viewing after a few seconds", async () => {
  const screen = fakeScreen();
  const events: [string, boolean][] = [];
  const watcher = new Screen({ adapter: () => screen.adapter, mode: () => "view", emit: (device: string, started: boolean) => events.push([device, started]), dirs: [], idleMs: 80 });
  await watcher.frame("phone-1", {});
  await watcher.frame("phone-1", {});
  assert.deepEqual(events, [["phone-1", true]]);
  await delay(250);
  assert.deepEqual(events, [["phone-1", true], ["phone-1", false]]);
  watcher.dispose();
});

test("clicks and typing need control mode, and bad actions are refused whole or clamped", async () => {
  const screen = fakeScreen();
  const posted: { display: { id: string }; events: any[] }[] = [];
  const { link, backend, call, done } = await setup({ screenInput: async (job: { display: { id: string }; events: any[] }) => void posted.push(job) });
  backend.screen = screen.adapter;
  const input = (events: unknown, display = "1") => call("link.screen.input", display, events);

  link.setScreenMode("view");
  await assert.rejects(input([{ type: "click", x: 0.5, y: 0.5 }]), /Controlling the screen is off/);
  assert.equal(posted.length, 0);

  link.setScreenMode("control");
  assert.equal((await call("link.screen.info")).canControl, true);
  await input([{ type: "click", x: 5, y: -3 }, { type: "text", text: "hi\nthere\tnow\u0007" }, { type: "key", key: "C", modifiers: ["cmd", "cmd"] }, { type: "scroll", x: 0.5, y: 0.5, dx: -99999, dy: 42.6 }, { type: "key", key: "pagedown" }]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].display.id, "1");
  assert.deepEqual(posted[0].events, [
    { type: "click", x: 1, y: 0 },
    { type: "text", text: "hi" },
    { type: "key", key: "enter" },
    { type: "text", text: "there" },
    { type: "key", key: "tab" },
    { type: "text", text: "now" },
    { type: "key", key: "C", modifiers: ["cmd"] },
    { type: "scroll", x: 0.5, y: 0.5, dx: -1000, dy: 43 },
    { type: "key", key: "pagedown" },
  ]);

  // Anything wrong refuses the whole call: nothing is posted.
  const refused: [unknown, RegExp][] = [
    [[{ type: "launch", app: "calculator" }], /isn't valid/],
    [[{ type: "click", x: 0.5 }], /isn't valid/],
    [[{ type: "click", x: "0.5", y: 0.5 }], /isn't valid/],
    [[{ type: "click", x: Number.NaN, y: 0.5 }], /isn't valid/],
    [[{ type: "key", key: "F13" }], /isn't valid/],
    [[{ type: "key", key: "ab" }], /isn't valid/],
    [[{ type: "key", key: "\u0007" }], /isn't valid/],
    [[{ type: "key", key: "a", modifiers: ["super"] }], /isn't valid/],
    [[{ type: "key", key: "a", modifiers: "cmd" }], /isn't valid/],
    [[{ type: "text", text: "x".repeat(2001) }], /2,000/],
    [[{ type: "text", text: 5 }], /2,000/],
    [Array.from({ length: 65 }, () => ({ type: "move", x: 0, y: 0 })), /up to 64/],
    [{ type: "move", x: 0, y: 0 }, /isn't valid/],
    [[null], /isn't valid/],
  ];
  for (const [events, message] of refused) await assert.rejects(input(events), message);
  await assert.rejects(input([{ type: "move", x: 0, y: 0 }], "9"), /display/);
  assert.equal(posted.length, 1, "none of them was posted");
  await input(Array.from({ length: 64 }, () => ({ type: "move", x: 0, y: 0 })));
  assert.equal(posted.at(-1)!.events.length, 64);

  // A move while the button is held is a drag, across calls.
  await input([{ type: "down", x: 0.1, y: 0.1 }]);
  await input([{ type: "move", x: 0.2, y: 0.2 }]);
  await input([{ type: "up", x: 0.2, y: 0.2 }]);
  await input([{ type: "move", x: 0.3, y: 0.3 }]);
  assert.deepEqual(posted.slice(-4).map((job) => job.events[0].drag === true), [false, true, false, false]);

  // Without the right to post input, the person is told how to allow it.
  screen.shown.accessibility = false;
  // What info() learned is kept for 5 seconds; a change of mode starts it afresh.
  link.setScreenMode("view");
  link.setScreenMode("control");
  const blocked = await call("link.screen.info");
  assert.equal(blocked.canControl, false);
  assert.match(blocked.problem, /accessibility/);
  const count = posted.length;
  await assert.rejects(input([{ type: "move", x: 0, y: 0 }]), /accessibility/);
  assert.equal(posted.length, count);
  await done();
});

test("what a phone sends is tidied the same way for every system", () => {
  assert.deepEqual(cleanEvents([{ type: "move", x: 0.5, y: 2 }], true).events, [{ type: "move", x: 0.5, y: 1, drag: true }]);
  assert.equal(cleanEvents([{ type: "down", x: 0, y: 0 }]).pressed, true);
  assert.equal(cleanEvents([{ type: "click", x: 0, y: 0 }], true).pressed, false);
  assert.deepEqual(cleanEvents([{ type: "key", key: "Enter" }]).events, [{ type: "key", key: "enter" }]);
  assert.deepEqual(cleanEvents([{ type: "text", text: "a\r\nb" }]).events.map((e: any) => e.text ?? e.key), ["a", "enter", "b"]);

  // Linux: the commands xdotool would be given, as argument lists.
  const commands = xdotoolCommands(
    cleanEvents([{ type: "click", x: 0.5, y: 0.5 }, { type: "doubleClick", x: 0, y: 1 }, { type: "rightClick", x: 1, y: 0 }, { type: "scroll", x: 0, y: 0, dx: 0, dy: -100 }, { type: "text", text: "-rm -rf" }, { type: "key", key: "c", modifiers: ["cmd", "shift"] }, { type: "key", key: "." }, { type: "key", key: "é" }]).events,
    { width: 1001, height: 501 },
  );
  assert.deepEqual(commands, [
    ["mousemove", "500", "250", "click", "1"],
    // One press: the phone sent a click just before, and the two make the double click.
    ["mousemove", "0", "500", "click", "1"],
    ["mousemove", "1000", "0", "click", "3"],
    ["mousemove", "0", "0"],
    ["click", "--repeat", "3", "4"],
    ["type", "--delay", "0", "--clearmodifiers", "--", "-rm -rf"],
    ["key", "--clearmodifiers", "ctrl+shift+c"],
    ["key", "--clearmodifiers", "period"],
    ["type", "--delay", "0", "--clearmodifiers", "--", "é"],
  ]);
});

// ── Limits, robustness and the rest of the review's list ──────────────────────────────────────

test("a message's mentions are cut down to the shapes the composer sends", async () => {
  const { backend, call, done } = await setup();
  const nul = "bad\u0000path";
  await call("send", "chat-launch", "hi", {
    mentions: [
      { kind: "project", id: "p1" },
      { kind: "file", path: "/work/notes.txt" },
      { kind: "wiki", path: "projects/website.md" },
      { kind: "project", id: "p1", label: "extra key" },
      { kind: "file", path: "x", label: "extra key" },
      { kind: "unknown", id: "c1" },
      { kind: "file", id: "x" },
      { kind: "project", path: "x" },
      { kind: "file", path: 5 },
      { kind: "file", path: "" },
      { kind: "file", path: nul },
      { kind: "file", path: "x".repeat(1025) },
      "nonsense",
      null,
      ["file", "x"],
    ],
  });
  assert.deepEqual(backend.calls.at(-1)![1][2].mentions, [{ kind: "project", id: "p1" }, { kind: "file", path: "/work/notes.txt" }, { kind: "wiki", path: "projects/website.md" }]);
  await call("send", "chat-launch", "hi", { mentions: Array.from({ length: 20 }, (_, i) => ({ kind: "wiki", path: "page-" + i + ".md" })) });
  assert.equal(backend.calls.at(-1)![1][2].mentions.length, 12);
  await call("send", "chat-launch", "hi", { mentions: "everything" });
  assert.equal("mentions" in backend.calls.at(-1)![1][2], false);
  await call("send", "chat-launch", "hi", { mentions: [{ kind: "file", path: "x".repeat(1024) }] });
  assert.equal(backend.calls.at(-1)![1][2].mentions.length, 1);
  await done();
});

test("a Today card discussed in a chat goes as a board mention, in its one shape", async () => {
  const { backend, call, done } = await setup();
  await call("send", "chat-launch", "hi", {
    mentions: [
      { kind: "board", id: "b1" },
      { kind: "board", id: "b2", label: "extra key" },
      { kind: "board", path: "b3" },
      { kind: "board", id: "" },
      { kind: "board", id: 7 },
      { kind: "board", id: "bad\u0000id" },
      { kind: "project", id: "p1" },
    ],
  });
  assert.deepEqual(backend.calls.at(-1)![1][2].mentions, [{ kind: "board", id: "b1" }, { kind: "project", id: "p1" }]);
  await done();
});

test("a call is checked before its body is read, and the host takes only so many connections", async () => {
  const { link, call, done } = await setup();
  await call("models");
  const session = [...link.sessions.keys()][0];
  assert.equal(link.server.maxConnections, 256);
  // Each request declares a body it never sends. A host that read it first would wait for it.
  const answer = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: link.port, method: "POST", path: "/botkins/v1/" + path, headers }, (res) => {
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", reject);
      req.flushHeaders();
      setTimeout(() => reject(new Error("no answer before the body")), 2000).unref();
    });
  assert.equal(await answer("rpc", { "content-length": String(50 * 1024 * 1024) }), 401, "no session: refused before the body");
  assert.equal(await answer("rpc", { "content-length": String(50 * 1024 * 1024), "x-botkins-session": "unknown" }), 401);
  assert.equal(await answer("rpc", { "content-length": String(7 * 1024 * 1024), "x-botkins-session": session }), 413, "a real session but too much");
  assert.equal(await answer("pair", { "content-length": String(1024 * 1024) }), 413);
  assert.equal(await answer("nothing", { "content-length": "10" }), 404);
  await done();
});

test("a phone has two waits open at most, and a newer one ends the oldest", async () => {
  const { link, client, call, until, done } = await setup({}, false);
  // What this phone holds: the versions of its own view, as one sync gave them.
  const { v: have } = await (client as any).call("link.sync", { epoch: link.epoch, have: {} });
  const wait = () => (client as any).call("link.sync", { epoch: link.epoch, have, wait: 20_000 });
  const first = wait().then((news: any) => ({ first: true, news }));
  await until(() => link.waiters.size === 1, "the first wait");
  const second = wait();
  await until(() => link.waiters.size === 2, "both waits");
  assert.equal(link.waiters.size, 2);
  const third = wait();
  assert.deepEqual(await Promise.race([first, delay(1500).then(() => "still waiting")]).then((r: any) => r.news?.parts), {}, "the oldest ended quietly");
  assert.equal(link.waiters.size, 2);
  // The other two are still waiting, and a change wakes them.
  link.backend.state.settings.foldTools = !link.backend.state.settings.foldTools;
  link.changed();
  assert.ok((await second).parts.settings);
  assert.ok((await third).parts.settings);
  assert.ok(await call("models"));
  await done();
});

test("a timer that fails is logged and goes on", async () => {
  const logs: string[] = [];
  const { link, call, done, parts, until } = await setup({ log: (line: string) => logs.push(line) });
  // The pump that wakes waiting phones (it only runs while one is waiting).
  await until(() => link.waiters.size > 0, "the phone to wait");
  const refresh = link.refresh;
  link.refresh = () => {
    throw new Error("pump broke");
  };
  link.changed();
  await until(() => logs.some((line) => line.includes("pump broke")), "the pump's failure in the log");
  link.refresh = refresh;
  link.backend.state.settings.foldTools = !link.backend.state.settings.foldTools;
  link.changed();
  await until(() => parts.settings.foldTools === link.backend.state.settings.foldTools, "the host to go on");
  // The "forget this phone" that follows link.unpair.
  const remove = link.removeDevice.bind(link);
  link.removeDevice = () => {
    throw new Error("unpair broke");
  };
  assert.equal(await call("link.unpair"), true);
  await until(() => logs.some((line) => line.includes("unpair broke")), "the unpair failure in the log");
  link.removeDevice = remove;
  await done();
});

test("a phone's settings file that can't be read is left alone, and only a missing one is a new identity", async () => {
  // A path that is a folder can't be read as a file.
  const odd = scratch("store");
  mkdirSync(join(odd, "link.json"));
  const store = new LinkStore(odd);
  assert.ok(store.data.locked);
  store.set({ name: "x" });
  store.touch("nobody");
  assert.ok(statSync(join(odd, "link.json")).isDirectory(), "nothing was written over it");
  const host = new LinkHost({ relay: false, dir: odd, backend: new MockBackend(), port: 0 });
  assert.equal(host.status().locked, true);
  await assert.rejects(host.setEnabled(true), /can't be opened here/);
  await host.stop();

  // A file that is there but is no JSON is kept as it is.
  const broken = scratch("store");
  writeFileSync(join(broken, "link.json"), "{ not json");
  assert.ok(new LinkStore(broken).data.locked);
  new LinkStore(broken).set({ name: "x" });
  assert.equal(readFileSync(join(broken, "link.json"), "utf8"), "{ not json");

  // No file at all is a new identity, saved when something changes.
  const fresh = scratch("store");
  const created = new LinkStore(fresh);
  assert.equal(created.data.locked, undefined);
  created.set({ name: "mine" });
  assert.equal(new LinkStore(fresh).data.serverId, created.data.serverId);
});

test("a new device or server id never starts with a dash, which a command line would read as an option", () => {
  // 0xfb… is "-" first in base64url: such a draw is thrown away and the next one is used.
  const draws = [Buffer.alloc(9, 0xfb), Buffer.alloc(9, 0xf8), Buffer.alloc(9, 1)];
  const id = newId(9, () => draws.shift()!);
  assert.equal(Buffer.alloc(9, 0xfb).toString("base64url")[0], "-");
  assert.equal(id, Buffer.alloc(9, 1).toString("base64url"));
  assert.equal(draws.length, 0);
  // The same sizes as before: 9 bytes for a device, 12 for a server.
  assert.equal(newId(9).length, 12);
  assert.equal(newId(12).length, 16);
  for (let i = 0; i < 2000; i++) assert.notEqual(newId(9)[0], "-");
  const store = new LinkStore(scratch("ids"));
  assert.notEqual(store.data.serverId[0], "-");
});

test("Bitwarden unlock tries are limited, and a .cmd shim is said to be unsupported", async () => {
  const tools = fakeTools({ bw: BW });
  let clock = Date.now();
  const credentials = new Credentials({ dir: scratch("host"), searchPath: [tools.dir], now: () => clock });
  for (let i = 0; i < 5; i++) await assert.rejects(credentials.unlock("bitwarden", { password: "wrong" }), /Check the master password/);
  await assert.rejects(credentials.unlock("bitwarden", { password: "correct horse" }), /Too many tries\. Wait a minute\./);
  assert.equal(tools.note("bw.log").split("\n").filter((line) => line.startsWith("unlock")).length, 5, "the sixth try never ran bw");
  clock += 61_000;
  assert.equal((await credentials.unlock("bitwarden", { password: "correct horse" })).state, "ready");

  // On Windows a .cmd or .bat shim would need cmd.exe, and arguments for cmd.exe can't be quoted safely.
  const shims = scratch("tools");
  writeFileSync(join(shims, "bw.cmd"), "@echo off\r\n");
  writeFileSync(join(shims, "op.bat"), "@echo off\r\n");
  const windows = new Credentials({ dir: scratch("host"), searchPath: [shims], platform: "win32" });
  const states = await windows.managers(true);
  for (const id of ["bitwarden", "onepassword"]) {
    const found = states.find((m: any) => m.id === id);
    assert.equal(found.state, "missing");
    assert.match(found.message, /\.cmd script, which can't be run safely/);
  }
  // Proton Pass is installed by Botkins itself (a pinned pass-cli), so a missing one may have no message at all; it never blames a shim.
  assert.doesNotMatch(String(states.find((m: any) => m.id === "protonpass")?.message ?? ""), /\.cmd/);
});

test("command-line tools run a few at a time, and too many waiting are turned away", async () => {
  const gate = new Gate(2, 3);
  const open: (() => void)[] = [];
  const task = () => new Promise<string>((resolve) => open.push(() => resolve("done")));
  const runs = Array.from({ length: 5 }, () => gate.run("Tool", task));
  await delay(20);
  assert.equal(open.length, 2, "two run at once");
  assert.equal(gate.waiting.length, 3);
  await assert.rejects(gate.run("Tool", task), (error: Error) => error.message === "Your computer is busy. Try again.");
  while (open.length) open.shift()!();
  await delay(20);
  while (open.length) open.shift()!();
  await delay(20);
  while (open.length) open.shift()!();
  assert.deepEqual(await Promise.all(runs), Array(5).fill("done"));
  assert.equal(gate.active, 0);

  // Every real run goes through the shared gate.
  const tools = fakeTools({ slow: "sleep 0.3" });
  const running = runTool("Slow", join(tools.dir, "slow"), []);
  await delay(100);
  assert.equal(toolGate.active, 1);
  await running;
  assert.equal(toolGate.active, 0);
});

test("an upload left alone is dropped, an empty one isn't started, and a phone keeps few files", async () => {
  const dir = scratch("uploads");
  let clock = 1_000_000;
  const uploads = new Uploads({ dir, now: () => clock, limits: { files: 3 } });
  const put = (input: Record<string, unknown>) => uploads.put("phone1", { name: "f.txt", ...input } as any);
  const data = (text: string) => b64(text);

  // Ten minutes without a part ends it: the file and its entry, by the sweep or by the next part.
  const started = await put({ data: data("one"), last: false });
  clock += 9 * 60_000;
  const more = await put({ id: started.id, data: data("two"), last: false });
  assert.equal(more.size, 6, "a part keeps it alive");
  clock += 11 * 60_000;
  uploads.sweep();
  assert.ok(!existsSync(started.path), "the file was removed");
  assert.equal(uploads.open.size, 0);
  await assert.rejects(put({ id: started.id, data: data("three"), last: true }), /isn't open any more/);
  const lazy = await put({ data: data("x"), last: false });
  clock += 11 * 60_000;
  await assert.rejects(put({ id: lazy.id, data: data("y"), last: true }), /isn't open any more/);
  assert.ok(!existsSync(lazy.path));

  // Nothing starts with empty data, though an empty last part may end a file.
  await assert.rejects(put({ data: "" }), /empty/);
  const part = await put({ data: data("a"), last: false });
  assert.equal((await put({ id: part.id, data: "", last: true })).size, 1);

  // At most 3 finished files stay; the oldest go first.
  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    const file = await put({ name: "keep" + i + ".txt", data: data("x" + i) });
    const old = new Date(Date.now() - (10 - i) * 60_000);
    utimesSync(file.path, old, old);
    names.push(file.path);
  }
  const left = readdirSync(join(dir, "uploads", "phone1"));
  assert.equal(left.length, 3);
  assert.ok(!existsSync(names[0]) && existsSync(names[3]));

  // A write that fails leaves no half file and no entry.
  const broken = await put({ name: "broken.txt", data: data("a"), last: false });
  rmSync(broken.path);
  mkdirSync(broken.path);
  await assert.rejects(put({ id: broken.id, data: data("b"), last: true }), /couldn't be saved/);
  assert.equal(uploads.open.has("phone1/" + broken.id), false);
  writeFileSync(join(dir, "uploads", "phone2"), "a file where a folder should be");
  await assert.rejects(uploads.put("phone2", { name: "x", data: data("x") }), /couldn't be saved/);
  assert.equal(uploads.open.size, 0);

  // A phone that is forgotten takes its files with it.
  uploads.forget("phone1");
  assert.ok(!existsSync(join(dir, "uploads", "phone1")));
  uploads.dispose();
});

test("removing a phone deletes its uploads, and lets go of the mouse button it held", async () => {
  const posted: { events: any[] }[] = [];
  const screen = fakeScreen();
  const { dir, link, backend, call, deviceId, done } = await setup({ screenInput: async (job: { events: any[] }) => void posted.push(job) });
  backend.screen = screen.adapter;
  const file = await call("link.upload", { name: "mine.txt", data: b64("mine") });
  assert.ok(existsSync(file.path));
  link.setScreenMode("control");
  await call("link.screen.input", "1", [{ type: "down", x: 0.25, y: 0.5 }, { type: "move", x: 0.75, y: 0.5 }]);
  assert.equal(posted.length, 1);
  link.removeDevice(deviceId);
  assert.ok(!existsSync(join(dir, "uploads", deviceId)), "its uploads are gone");
  await delay(80);
  assert.equal(posted.length, 2, "the button was let go");
  assert.deepEqual(posted[1].events, [{ type: "up", x: 0.75, y: 0.5 }]);
  await done();
});

test("a frame taken while the screen was turned off isn't sent, and only real, small JPEGs are", async () => {
  const screen = fakeScreen();
  const { link, backend, call, done } = await setup({ screenInput: async () => {} });
  backend.screen = screen.adapter;
  link.setScreenMode("view");
  assert.ok((await call("link.screen.frame", {})).jpeg);

  screen.shown.during = () => link.setScreenMode("off");
  await assert.rejects(call("link.screen.frame", {}), /off/);
  screen.shown.during = null;
  link.setScreenMode("view");

  // Not a JPEG, and a JPEG over 3 MB, are refused.
  screen.shown.raw = Buffer.from("this is not a picture");
  await assert.rejects(call("link.screen.frame", {}), /picture couldn't be used/);
  screen.shown.raw = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3 * 1024 * 1024 - 1)]);
  await assert.rejects(call("link.screen.frame", {}), /picture couldn't be used/);
  screen.shown.raw = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1024)]);
  assert.ok((await call("link.screen.frame", {})).jpeg);
  await done();
});

test("what info() learns about the screen is kept for a few seconds", async () => {
  const screen = fakeScreen();
  const { link, backend, call, done } = await setup({ screenInput: async () => {} });
  backend.screen = screen.adapter;
  link.setScreenMode("control");
  for (let i = 0; i < 4; i++) assert.equal((await call("link.screen.info")).canControl, true);
  assert.deepEqual(screen.looked, { displays: 1, permissions: 1 });
  link.setScreenMode("view");
  await call("link.screen.info");
  assert.deepEqual(screen.looked, { displays: 2, permissions: 2 }, "a change of mode looks again");
  await done();
});

test("a call that would type too much, or wait behind too many, or whose phone left, isn't posted", async () => {
  const screen = fakeScreen();
  const posted: { events: any[] }[] = [];
  const { link, backend, call, done } = await setup({ screenInput: async (job: { events: any[] }) => void posted.push(job) });
  backend.screen = screen.adapter;
  link.setScreenMode("control");
  const input = (events: unknown) => call("link.screen.input", "1", events);

  // 64 actions that become more than 256 once split are refused whole; 256 are not.
  await assert.rejects(input([{ type: "text", text: "\n".repeat(300) }]), /Too much to type at once\./);
  await assert.rejects(input(Array.from({ length: 64 }, () => ({ type: "text", text: "a\nb\nc\nd\ne" }))), /Too much to type at once\./);
  assert.equal(posted.length, 0);
  await input([{ type: "text", text: "\n".repeat(256) }]);
  assert.equal(posted[0].events.length, 256);
  await done();

  // Waiting calls: 8 at most, and one is skipped when its phone is gone or control was turned off.
  const modes = { mode: "control" };
  const paired = new Set(["a", "b", "c"]);
  const sent: any[] = [];
  let release = () => {};
  const block = new Promise<void>((resolve) => (release = resolve));
  const watcher = new Screen({
    adapter: () => screen.adapter,
    mode: () => modes.mode,
    paired: (id: string) => paired.has(id),
    inject: async (job: any) => {
      await block;
      sent.push(job.events);
    },
    dirs: [],
  });
  const move = (x: number) => [{ type: "move", x, y: 0 }];
  const calls = [watcher.input("a", "1", move(0)), watcher.input("a", "1", move(0.1)), watcher.input("b", "1", move(0.2)), ...[3, 4, 5, 6].map((n) => watcher.input("c", "1", move(n / 10)))];
  const eighth = watcher.input("c", "1", move(0.7));
  await assert.rejects(watcher.input("c", "1", move(0.8)), /Too many actions are waiting/);
  paired.delete("b");
  release();
  assert.equal((await Promise.allSettled(calls)).filter((r) => r.status === "rejected").length, 1, "only the call of the removed phone");
  await eighth;
  assert.equal(sent.length, 7);
  modes.mode = "view";
  await assert.rejects(watcher.input("c", "1", move(0.9)), /Controlling the screen is off/);
  watcher.dispose();
});

test("a held mouse button is let go when the mode changes or the holder stops", async () => {
  const screen = fakeScreen();
  const sent: any[] = [];
  const modes = { mode: "control" };
  const watcher = new Screen({ adapter: () => screen.adapter, mode: () => modes.mode, inject: async (job: any) => void sent.push(job.events), dirs: [] });
  await watcher.input("a", "1", [{ type: "down", x: 0.2, y: 0.4 }]);
  await watcher.input("a", "1", [{ type: "move", x: 0.6, y: 0.8 }]);
  assert.equal(sent[1][0].drag, true);
  modes.mode = "view";
  watcher.modeChanged();
  await delay(30);
  assert.deepEqual(sent.at(-1), [{ type: "up", x: 0.6, y: 0.8 }]);

  modes.mode = "control";
  await watcher.input("a", "1", [{ type: "down", x: 0.1, y: 0.1 }]);
  watcher.stop("b");
  await delay(30);
  assert.equal(sent.at(-1)[0].type, "down", "another device stopping changes nothing");
  watcher.stop("a");
  await delay(30);
  assert.deepEqual(sent.at(-1), [{ type: "up", x: 0.1, y: 0.1 }]);
  await watcher.input("a", "1", [{ type: "move", x: 0.3, y: 0.3 }]);
  assert.equal(sent.at(-1)[0].drag, undefined, "nothing is held any more");
  watcher.dispose();
});

test("a viewer's idle timer that hits a failing listener logs it and goes on", async () => {
  const screen = fakeScreen();
  const logs: string[] = [];
  const watcher = new Screen({ adapter: () => screen.adapter, mode: () => "view", emit: (_device: string, started: boolean) => { if (!started) throw new Error("listener broke"); }, log: (line: string) => logs.push(line), dirs: [], idleMs: 30 });
  await watcher.frame("phone-1", {});
  await delay(150);
  assert.ok(logs.some((line) => line.includes("listener broke")));
  watcher.dispose();
});

// ── After the second review ───────────────────────────────────────────────────────────────────

test("a mention never climbs out: a wiki page is named from the wiki's top, a file has no ..", async () => {
  const { backend, call, done } = await setup();
  await call("send", "chat-launch", "hi", {
    mentions: [
      { kind: "wiki", path: "goals/launch.md" },
      { kind: "wiki", path: "../../etc/passwd" },
      { kind: "wiki", path: "/etc/passwd" },
      { kind: "wiki", path: "C:\\Windows\\win.ini" },
      { kind: "wiki", path: "goals\\..\\..\\secret.md" },
      { kind: "file", path: "/work/notes.txt" },
      { kind: "file", path: "/work/../../home/me/.ssh/id_rsa" },
    ],
  });
  assert.deepEqual(backend.calls.at(-1)![1][2].mentions, [{ kind: "wiki", path: "goals/launch.md" }, { kind: "file", path: "/work/notes.txt" }]);
  await done();
});

test("a hidden value is found in its escaped forms, and a very short one is left alone", () => {
  const secret = 'pa"ss word/1';
  assert.equal(scrub("got " + secret, [secret]), "got •••");
  assert.equal(scrub("json " + JSON.stringify(secret), [secret]), 'json "•••"');
  assert.equal(scrub("url ?k=" + encodeURIComponent(secret), [secret]), "url ?k=•••");
  assert.equal(scrub("mcp-3f2a9", ["3f"]), "mcp-3f2a9", "two characters would blank out ids");
});

test("one phone keeps a few sessions and can't push another phone's out", async () => {
  const link = new LinkHost({ relay: false, dir: scratch("host"), backend: new Recording({ speed: 0.05 }), port: 0, extraHosts: ["127.0.0.1"], searchPath: [] });
  await link.setEnabled(true);
  const hosts = ["127.0.0.1:" + link.port];
  const quiet = { fetch: fetcher, onParts() {}, onState() {} };
  const first = await pair(fetcher, { hosts, code: link.startPairing().code }, phone);
  const second = await pair(fetcher, { hosts, code: link.startPairing().code }, { name: "Second phone", platform: "ios" });
  const other = new LinkClient(second, quiet);
  await other.call("models");
  for (let i = 0; i < 10; i++) await new LinkClient(first, quiet).call("models");
  const of = (id: string) => [...link.sessions.values()].filter((session: any) => session.deviceId === id).length;
  assert.equal(of(first.deviceId), 6);
  assert.equal(of(second.deviceId), 1, "the other phone's session is still there");
  assert.ok(Array.isArray(await other.call("models")));
  await link.stop();
});

test("a phone has only a few unfinished uploads at once, and none after it is removed", async () => {
  const dir = scratch("uploads");
  const uploads = new Uploads({ dir, limits: { open: 3 } });
  const start = (device = "phone1") => uploads.put(device, { name: "f.txt", data: b64("x"), last: false } as any);
  const opened = [await start(), await start(), await start()];
  await assert.rejects(start(), /Too many files are being sent at once/);
  // A whole small file still goes through, another phone is counted by itself, and finishing one makes room.
  await uploads.put("phone1", { name: "whole.txt", data: b64("y") } as any);
  await start("phone2");
  await uploads.put("phone1", { id: opened[0].id, data: b64("z"), last: true } as any);
  await start();

  // A part that is still being written when the phone is removed leaves nothing behind.
  const late = uploads.put("phone3", { name: "late.txt", data: b64("x".repeat(1000)) } as any);
  uploads.forget("phone3");
  await assert.rejects(late, /isn't paired/);
  assert.ok(!existsSync(join(dir, "uploads", "phone3")));
  uploads.dispose();
});

test("one address can hold only so many connections, and failed pairing tries are counted per address", async () => {
  const { link, done } = await setup({}, false);
  const { connect } = await import("node:net");
  const sockets = await Promise.all(
    Array.from({ length: 30 }, () =>
      new Promise<import("node:net").Socket>((resolve, reject) => {
        const socket = connect(link.port, "127.0.0.1", () => resolve(socket));
        socket.on("error", reject);
      }),
    ),
  );
  await delay(100);
  // The ones over the limit were closed by the host; the rest are open and silent.
  const open = sockets.filter((socket) => !socket.destroyed && socket.readyState === "open").length;
  assert.ok(open <= 24, open + " stayed open");
  for (const socket of sockets) socket.destroy();
  await delay(50);
  assert.equal((await fetch("http://127.0.0.1:" + link.port + "/botkins/v1/hello")).status, 200, "room again once they are gone");

  // A flood of failed pairing tries from one address is refused for that address only. (Each way in has its
  // own counts, and only failures count; see "attempts are counted..." in tests/relay-host.test.ts.)
  const attempt = async (from: string) => (await link.serve({ route: "pair", body: Buffer.from("{}"), from })).status;
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) statuses.push(await attempt("10.0.0.9"));
  assert.equal(statuses.filter((status) => status === 429).length, 5);
  assert.notEqual(await attempt("10.0.0.10"), 429);
  await done();
});

// ---------------------------------------------------------------------------------------------
// Looks with eyes and their own colors, and where a routine's result lands.

test("a look may carry eyes and its own four colors, and nothing else", async () => {
  const { cleanLook } = await import("../link-host/store.mjs");
  assert.deepEqual(cleanLook({ head: "sprig", palette: "honey" }), { head: "sprig", palette: "honey" });
  assert.deepEqual(cleanLook({ head: "sprig", palette: "honey", eyes: "oval" }), { head: "sprig", palette: "honey" }, "the default eyes are not saved");
  assert.deepEqual(cleanLook({ head: "sprig", palette: "honey", eyes: "wink", extra: 1 }), { head: "sprig", palette: "honey", eyes: "wink" });
  assert.deepEqual(cleanLook({ head: "sprig", palette: "custom", colors: ["#AA0011", "#00bb22", "#ffffff", "#000000"] }), { head: "sprig", palette: "custom", colors: ["#aa0011", "#00bb22", "#ffffff", "#000000"] });
  // Colors belong to "custom" only, and "custom" must have all four.
  assert.deepEqual(cleanLook({ head: "sprig", palette: "fern", colors: ["#aa0011", "#00bb22", "#ffffff", "#000000"] }), { head: "sprig", palette: "fern" });
  for (const bad of [
    { head: "sprig", palette: "custom" },
    { head: "sprig", palette: "custom", colors: ["#aa0011", "#00bb22", "#ffffff"] },
    { head: "sprig", palette: "custom", colors: ["red", "#00bb22", "#ffffff", "#000000"] },
    { head: "sprig", palette: "custom", colors: ["#aa0011", "#00bb22", "#ffffff", "url(x)"] },
    { head: "sprig", palette: "honey", eyes: "laser" },
    { head: "../x", palette: "honey" },
  ])
    assert.throws(() => cleanLook(bad), /can't be saved/, JSON.stringify(bad));
});

test("the computer names what its app supports, and a routine's result lands where it is sent", async () => {
  const { backend, call, done, parts, until } = await setup();
  try {
    await until(() => !!parts.meta);
    assert.ok(parts.meta.capabilities.includes("routine-delivery-v1"), "the app's own capability is announced");
    assert.ok(parts.meta.capabilities.includes("looks-v2"), "the link keeps looks itself here, so it takes the richer ones");
    assert.ok(parts.meta.capabilities.includes("botkin-heads-v2"));
    assert.ok(parts.meta.capabilities.includes("botkin-heads-v3"), "the link can save all ten additional characters");

    const id = await call("createRoutine", { botId: "bot-mira", name: "Stand up", prompt: "Remind me to stand up.", cadence: { kind: "daily", time: "10:00" }, deliver: { to: "feed" } });
    await until(() => parts.chats.some((chat: any) => chat.id === id));
    assert.deepEqual(parts.chats.find((chat: any) => chat.id === id).schedules[0].deliver, { to: "feed" });
    const before = backend.state.board.length;
    await call("runRoutine", id);
    await until(() => backend.state.board.length === before + 1);
    assert.equal(backend.state.board[0].kind, "feed");
    assert.equal(backend.state.board[0].title, "Stand up");

    // To the person's chat with the bot: a message there, unread.
    await call("updateRoutine", id, { deliver: { to: "chat" } });
    const chat = backend.state.chats.find((c: any) => c.botId === "bot-mira" && !c.schedules?.length && !c.botIds);
    const count = chat.messages.length;
    await call("runRoutine", id);
    await until(() => chat.messages.length === count + 1);
    assert.match(chat.messages.at(-1).text, /Stand up/);
    assert.equal(chat.unread, true);

    await assert.rejects(call("updateRoutine", id, { deliver: { to: "everyone" } }), /destination/);
  } finally {
    await done();
  }
});

test("a chat's side pane travels with the chat: the tabs in its detail, their number in the list", async () => {
  const { chatPart, baseParts } = await import("../link-host/parts.mjs");
  const { REMOTE_METHODS } = await import("../link-host/methods.mjs");
  const pane = { panels: [{ id: "p1", kind: "table", title: "Prices", botId: "bot-mira", createdAt: 1, updatedAt: 2, columns: ["Plan", "Price"], rows: [["Team", "$18"]] }], active: "p1", ask: { seq: 3, panelId: "p1", runId: "r1", botId: "bot-mira", at: 5 } };
  const state = { chats: [{ id: "c1", botId: "bot-mira", title: "Chat", time: 1, messages: [], pane }, { id: "c2", botId: "bot-mira", title: "Other", time: 1, messages: [] }], runs: [] };
  assert.deepEqual(chatPart(state, "c1").pane, pane);
  assert.equal("pane" in chatPart(state, "c2"), false);
  const list = baseParts(state).chats;
  assert.equal(list.find((chat: { id: string }) => chat.id === "c1").panes, 1);
  assert.equal("panes" in list.find((chat: { id: string }) => chat.id === "c2"), false);
  assert.ok(REMOTE_METHODS.has("sidePane"));
});

test("a paired phone can save speed independently and return a chat to its bot default", async (t) => {
  const { parts, call, until, done } = await setup();
  t.after(done);
  assert.ok(parts.meta.capabilities.includes("fast-mode-v1"));
  const chat = parts.chats[0];
  const bot = parts.bots.find((item: { id: string }) => item.id === chat.botId);
  await call("setModel", "global", null, parts.settings.model, "fast");
  await call("setModel", "bot", bot.id, bot.model ?? null, "off");
  await call("setModel", "chat", chat.id, null, "ultrafast");
  const latest = () => parts.chats.find((item: { id: string }) => item.id === chat.id);
  await until(() => latest()?.fastMode === "ultrafast", "the chat speed");
  assert.equal(latest().model, undefined);
  assert.equal(parts.settings.fastMode, "fast");
  assert.equal(parts.bots.find((item: { id: string }) => item.id === bot.id).fastMode, "off");
  await call("setModel", "chat", chat.id, null, null);
  await until(() => latest()?.fastMode === undefined, "inheritance");
});
