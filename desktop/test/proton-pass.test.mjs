import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { Credentials } from "../desktop/link/credentials.mjs";
import { protonPage } from "../desktop/link/proton-setup.mjs";

const TOKEN = "pst_test2Y3z::testSecretSentinel";
const PASSWORD = "secret-fixture-password";
const URL = "https://account.proton.me/pass/cli?challenge=example";

// Shapes are based on the public CLI docs, not a recording from a signed-in account.
async function fixture(t, mode = "", options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "botkins-proton-test-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const calls = join(dir, "calls");
  const tool = join(dir, "pass-cli");
  await writeFile(tool, `#!${process.execPath}
const fs = require("node:fs");
const [command, sub] = process.argv.slice(2);
const env = process.env;
const session = env.PROTON_PASS_SESSION_DIR?.startsWith(${JSON.stringify(dir)}) ? env.PROTON_PASS_SESSION_DIR : undefined;
const mode = ${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({argv: process.argv.slice(2),
  kind: env.PROTON_PASS_PERSONAL_ACCESS_TOKEN ? "agent" : session ? "private" : "legacy",
  reason: env.PROTON_PASS_AGENT_REASON, dir: session}) + "\\n");
const print = (value) => console.log(JSON.stringify(value));
const fail = (message) => { console.error(message); process.exit(1); };
if (command === "login" && env.PROTON_PASS_PERSONAL_ACCESS_TOKEN) {
  if (env.PROTON_PASS_PERSONAL_ACCESS_TOKEN !== ${JSON.stringify(TOKEN)}) fail("invalid token");
  fs.writeFileSync(session + "/authed", "yes");
} else if (command === "login") {
  console.log(${JSON.stringify(URL)});
  if (mode === "offline") fail("Network is unreachable");
  if (mode === "plan") fail("This account requires a paid plan");
  if (mode === "hang") setInterval(() => {}, 1000);
  if (mode === "password") {
    for (let i = 0; i < 3; i++) {
      const supplied = fs.readFileSync(env.PROTON_PASS_EXTRA_PASSWORD_FILE, "utf8");
      if (supplied === ${JSON.stringify(PASSWORD)}) process.exit(0);
      console.error("incorrect extra password " + supplied);
    }
    fail("Wrong extra password");
  }
} else if (command === "--version") console.log("pass-cli 2.7.1");
else if (command === "info") console.log("- Email: example@proton.me");
else if (command === "vault" && sub === "list") {
  print([{share_id: "shared", name: "Shared"}, ...(!session || !fs.existsSync(session + "/authed") ?
    [{share_id: "private", name: "Private"}] : [])]);
} else if (command === "agent" && sub === "create") {
  print({token: "PROTON_PASS_PERSONAL_ACCESS_TOKEN=" + ${JSON.stringify(TOKEN)}, instruction: "Not for display"});
} else if (command === "item" && sub === "view") {
  if (session && !fs.existsSync(session + "/authed")) fail("requires an authenticated client");
  if (session && mode === "retry" && !fs.existsSync(${JSON.stringify(join(dir, "retry"))})) {
    fs.writeFileSync(${JSON.stringify(join(dir, "retry"))}, "");
    fail("requires an authenticated client");
  }
  if (process.argv.some(arg => arg.startsWith("--field="))) {
    console.log("linked-value");
  } else if (process.argv[4]?.startsWith("pass://")) print("linked-value");
  else print({title:"Example", login:{password:"linked-value"}});
} else if (command === "logout" && !process.argv.includes("--force")) fail("try --force");
`, { mode: 0o700 });
  const credentials = new Credentials({ dir, searchPath: [dir], ...options });
  return {
    dir, credentials, setup: credentials.proton,
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
  };
}

async function until(setup, session, predicate) {
  for (let i = 0; i < 500; i++) {
    const view = setup.read({ session });
    if (predicate(view)) return view;
    if (view.done) assert.fail(view.error ?? "Setup finished before the expected event");
    await pause(10);
  }
  assert.fail("Proton setup did not reach the expected state");
}

async function connect(setup) {
  const { session } = setup.start({});
  const view = await until(setup, session, (next) => next.events.some((e) => e.type === "choose-vaults"));
  setup.input({ session, vaultIds: ["shared"] });
  const done = await until(setup, session, (next) => next.done);
  assert.equal(done.error, undefined);
  assert.equal(done.result.state, "ready");
  return { view, done };
}

test("only HTTPS Proton account URLs are accepted, with no credentials or explicit ports", () => {
  assert.equal(protonPage("open " + URL + "\n"), URL);
  for (const url of [
    "http://account.proton.me", "https://account.proton.me.evil.test", "https://notaccount.proton.me",
    "https://evil.test/?site=https://account.proton.me", "https://account.proton.me:443",
    "https://account.proton.me:5454", "https://evil@account.proton.me", "https://evil.test\\@account.proton.me",
  ]) assert.equal(protonPage("open " + url), undefined, url);
});

test("existing references migrate by share ID; unshared IDs and flags never reach the agent", async (t) => {
  const { credentials, setup, calls, dir } = await fixture(t, "retry");
  const link = (vaultId, name) => credentials.link({ manager: "protonpass", vaultId, itemId: "item", fieldId: "password", name });
  const shared = await link("shared", "Shared");
  const other = await link("private", "Private");
  assert.equal(await credentials.read(other), "linked-value");
  const { view, done } = await connect(setup);
  assert.deepEqual(view.events.find((e) => e.type === "choose-vaults").vaults.map((v) => v.suggested), [true, true]);
  assert.deepEqual(done.result.sharedVaults, ["Shared"]);
  assert.equal(await credentials.read(shared), "linked-value");
  assert.match((await credentials.check(other)).message, /not shared with Botkins/i);
  await assert.rejects(credentials.items("protonpass", "-flag"), /isn't valid/);
  const log = await calls();
  const grant = log.find((call) => call.argv[1] === "access");
  assert.deepEqual(grant.argv.slice(4), ["--share-id", "shared", "--role", "viewer"]);
  assert.equal(log.filter((c) => c.argv[0] === "login" && c.kind === "agent").length, 2);
  assert.ok(log.filter((c) => c.argv[0] === "item" && c.kind !== "legacy").every((c) => c.reason));
  assert.ok(log.some((c) => c.argv.includes("--force")));
  assert.doesNotMatch(JSON.stringify({ log, view, done }), new RegExp(TOKEN));
  assert.doesNotMatch(await readFile(join(dir, "credentials.json"), "utf8"), new RegExp(TOKEN));
  const reopened = new Credentials({ dir, searchPath: [dir] });
  assert.equal(await reopened.read(shared), "linked-value");
});

test("an agent session is refreshed after two hours and expiry never falls back to the owner's session", async (t) => {
  let now = Date.UTC(2026, 10, 24);
  const { setup, calls } = await fixture(t, "", { now: () => now });
  assert.equal((await setup.status()).state, "signed-out");
  await connect(setup);
  now += 2 * 3600_000;
  await setup.run(["item", "view", "pass://shared/item/password"], "shared");
  assert.equal((await calls()).filter((c) => c.argv[0] === "login" && c.kind === "agent").length, 2);
  now += 351 * 86400_000;
  assert.equal((await setup.status()).state, "expiring");
  now += 16 * 86400_000;
  assert.equal((await setup.status()).state, "expired");
  await assert.rejects(setup.run(["item", "view", "pass://shared/item/password"], "shared"), /expired/i);
});

test("an extra password only goes through the FIFO; three wrong answers are rejected", { skip: process.platform === "win32" }, async (t) => {
  const { setup, calls } = await fixture(t, "password");
  const { session } = setup.start({});
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(setup, session, (view) => view.events.filter((e) => e.type === "extra-password").length === attempt);
    setup.input({ session, extraPassword: PASSWORD + "-wrong" });
  }
  const done = await until(setup, session, (view) => view.done);
  assert.match(done.error, /extra password/i);
  assert.doesNotMatch(JSON.stringify({ done, calls: await calls() }), /secret-fixture-password/);
  const right = setup.start({}).session;
  await until(setup, right, (view) => view.events.some((e) => e.type === "extra-password"));
  setup.input({ session: right, extraPassword: PASSWORD });
  await until(setup, right, (view) => view.events.some((e) => e.type === "choose-vaults"));
  await setup.cancel({ session: right });
});

test("cancel kills login, removes its directory, and attempts both forms of logout", async (t) => {
  const { setup, calls, dir } = await fixture(t, "hang");
  const { session } = setup.start({});
  await until(setup, session, (view) => view.events.some((e) => e.type === "open"));
  await setup.cancel({ session });
  assert.equal(setup.read({ session }).done, true);
  assert.ok((await calls()).some((c) => c.argv[0] === "logout" && c.argv.includes("--force")));
  assert.ok(!(await readdir(join(dir, "proton-pass"))).some((name) => name.startsWith(".login-")));
});

test("login deadline is eleven minutes and uses the same cleanup as cancel", async (t) => {
  let deadline;
  const { setup, calls } = await fixture(t, "hang", { protonOptions: { timer: (callback, ms) => {
    deadline = { callback, ms };
    return () => {};
  } } });
  const { session } = setup.start({});
  await until(setup, session, (view) => view.events.some((e) => e.type === "open"));
  assert.equal(deadline.ms, 11 * 60_000);
  deadline.callback();
  const done = await until(setup, session, (view) => view.done);
  assert.match(done.error, /timed out/i);
  assert.ok((await calls()).some((c) => c.argv.includes("--force")));
});

for (const mode of ["plan", "offline"]) {
  test(`CLI ${mode} errors are classified without exposing output`, async (t) => {
    const { setup } = await fixture(t, mode);
    const { session } = setup.start({});
    const done = await until(setup, session, (view) => view.done);
    assert.equal(done.code, mode);
    assert.equal((await setup.status()).code, mode);
  });
}

test("disconnect waits for a new Proton login, deletes the agent, and never restores full-account access", async (t) => {
  const { setup, calls } = await fixture(t);
  await connect(setup);
  const { state, session } = await setup.disconnect();
  assert.equal(state, "signing-in");
  const done = await until(setup, session, (view) => view.done);
  assert.equal(done.result.state, "signed-out");
  assert.ok((await calls()).some((c) => c.argv[0] === "agent" && c.argv[1] === "delete"));
  await assert.rejects(setup.run(["vault", "list"]), /sign in/i);
});
