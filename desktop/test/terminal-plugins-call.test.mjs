// The plugin rules hold on the control socket by whatever way a call arrives: by its own name or
// through `call`. A real service, a folder plugin with a hook. The revision that was looked at is
// needed to switch on a plugin that runs commands and to give it to more bots, a saved credential
// is not taken by reference from the socket, and what the service says of a plugin is what the
// copy is now, with the names of its bots.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_REFERENCES_ON_THE_SOCKET } from "../desktop/terminal/control.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const NO_REFERENCES = "A saved credential is chosen in the app's window or on a paired phone. From the command line, give the value itself (`--settings`, `--secrets` or the hidden question).";
const STALE = "0".repeat(64);

/** A real service, and a plugin folder with a hook that is added through `call plugins.addFolder`. */
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-call-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const write = (path, value) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const mine = join(dir, "mine");
  write(join(mine, "plugin.json"), { name: "mine", version: "1.0.0", userConfig: { KEY: { title: "A key" } } });
  write(join(mine, "hooks", "hooks.json"), { hooks: { sessionStart: [{ type: "command", bash: "sh ./start.sh" }] } });
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const logged = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => /(Changed|Tried) from the command line/.test(text)).map((text) => text.slice(text.search(/(Changed|Tried) from/)));
  const added = await client.call("call", "plugins.addFolder", [mine]);
  return { client, logged, running, id: added.id, revision: added.revision, write, dir };
}

test("through call, a switch-on of a plugin that runs commands needs the revision that was looked at", { skip }, async (t) => {
  const { client, logged, id, revision } = await setup(t);
  assert.equal((await client.call("plugins.get", id)).enabled, false);
  await assert.rejects(client.call("call", "plugins.setEnabled", [id, true]), /Give the revision that was looked at/);
  assert.equal((await client.call("plugins.get", id)).enabled, false);
  await assert.rejects(client.call("call", "plugins.setEnabled", [id, true, STALE]), /is not the one that was looked at/);
  await assert.rejects(client.call("call", "plugins.setEnabled", [id, true, { revision: STALE }]), /is not the one that was looked at/);
  assert.equal((await client.call("plugins.get", id)).enabled, false);
  assert.deepEqual((await logged()).slice(-3), Array(3).fill("Tried from the command line: call plugins.setEnabled (it failed)"));
  // The revision, as a word and as the app's own { revision }: it is on. Off needs none.
  assert.equal((await client.call("call", "plugins.setEnabled", [id, true, revision])).enabled, true);
  assert.equal((await client.call("call", "plugins.setEnabled", [id, false])).enabled, false);
  assert.equal((await client.call("call", "plugins.setEnabled", [id, true, { revision }])).enabled, true);
  assert.equal((await logged()).at(-1), "Changed from the command line: call plugins.setEnabled");
});

test("through call, more bots for a plugin that is on and runs commands need the revision, and fewer need none", { skip }, async (t) => {
  const { client, logged, id, revision } = await setup(t);
  const nova = (await client.call("bots.add", { name: "Nova" })).id;
  await client.call("bots.add", { name: "Orbit" });
  // Off: any choice needs none, since nothing runs.
  await client.call("call", "plugins.setBots", [id, ["Nova"]]);
  assert.deepEqual((await client.call("plugins.get", id)).bots, [nova]);
  await client.call("call", "plugins.setEnabled", [id, true, revision]);
  // On and one bot: all bots, and a list with another bot, are wider.
  await assert.rejects(client.call("call", "plugins.setBots", [id, "all"]), /Look at it first .* give the revision that was looked at/);
  await assert.rejects(client.call("call", "plugins.setBots", [id, ["Nova", "Orbit"]]), /Look at it first/);
  await assert.rejects(client.call("plugins.setBots", id, "all"), /Look at it first/);
  await assert.rejects(client.call("call", "plugins.setBots", [id, "all", STALE]), /is not the one that was looked at/);
  assert.deepEqual((await client.call("plugins.get", id)).bots, [nova]);
  assert.deepEqual((await logged()).slice(-4), Array(4).fill("Tried from the command line: call plugins.setBots (it failed)").with(2, "Tried from the command line: plugins.setBots " + id + " (it failed)"));
  // With the revision it goes through. A choice that is no wider needs none.
  assert.equal((await client.call("call", "plugins.setBots", [id, "all", revision])).bots, "all");
  assert.deepEqual((await client.call("call", "plugins.setBots", [id, ["Nova"]])).bots, [nova]);
  assert.deepEqual((await client.call("call", "plugins.setBots", [id, ["Nova"]])).bots, [nova]);
});

test("the app compares the revision itself: a raw call of the app's own call with another revision is refused too", { skip }, async (t) => {
  const { running, id, revision } = await setup(t);
  const { handlers } = running.runtime;
  await assert.rejects(handlers["plugins.setEnabled"](id, true, { revision: STALE }), /is not the one that was looked at/);
  await assert.rejects(handlers["plugins.setBots"](id, "all", { revision: STALE }), /is not the one that was looked at/);
  await handlers["plugins.setEnabled"](id, true, { revision });
  assert.equal(running.runtime.workspace.plugins.list()[0].enabled, true);
});

test("no reference to a saved credential is taken from the socket, by the named call or through call", { skip }, async (t) => {
  assert.equal(CREDENTIAL_REFERENCES_ON_THE_SOCKET, false, "these tests are for the side where references are not taken");
  const { client, logged, running, id, revision } = await setup(t);
  const reference = { $credential: "a-credential" };
  const plugins = running.runtime.workspace.plugins;
  const keySet = () => plugins.list()[0].config.find((field) => field.key === "KEY").set;
  const refused = (promise) => assert.rejects(promise, (error) => error.message === NO_REFERENCES);
  // Install: in its settings, and in a place where it is no setting either (deeper).
  await refused(client.call("plugins.install", "memory@test-market", { revision, config: { KEY: reference } }));
  await refused(client.call("call", "plugins.install", ["memory@test-market", { revision, config: { KEY: reference } }]));
  await refused(client.call("call", "plugins.install", ["memory@test-market", { revision, config: { KEY: [{ deeper: reference }] } }]));
  assert.equal(plugins.list().length, 1, "nothing was installed");
  // Configure.
  await refused(client.call("plugins.configure", id, { KEY: reference }));
  await refused(client.call("call", "plugins.configure", [id, { KEY: reference }]));
  assert.equal(keySet(), false, "nothing was saved");
  // Answering a bot's request: the check comes before the app looks for the request.
  await refused(client.call("chat.respond", "no-such-request", { action: "accept", content: { KEY: reference } }));
  await refused(client.call("call", "respond", ["no-such-request", { action: "accept", content: { KEY: reference } }]));
  const lines = await logged();
  assert.ok(lines.includes("Tried from the command line: plugins.configure " + id + " (it failed)"));
  assert.ok(lines.includes("Tried from the command line: call plugins.configure (it failed)"));
  assert.ok(lines.includes("Tried from the command line: call respond (it failed)"));
  // A value that the caller has is still taken, by both ways.
  await client.call("plugins.configure", id, { KEY: "a value" });
  assert.equal(keySet(), true);
  await client.call("plugins.configure", id, { KEY: null });
  assert.equal(keySet(), false);
  await client.call("call", "plugins.configure", [id, { KEY: "another value" }]);
  assert.equal(keySet(), true);
  // The app's own path, as the window takes it, still resolves a reference: this one fails because there is no such credential, not by the socket's rule.
  await assert.rejects(running.runtime.handlers["plugins.configure"](id, { KEY: { $credential: "a-credential-that-does-not-exist" } }), (error) => error.message !== NO_REFERENCES && !/saved credential is chosen in the app's window/.test(error.message));
});

test("what the socket says of a plugin is the copy as it is now, and names its bots", { skip }, async (t) => {
  const { client, running, id, revision } = await setup(t);
  // Who gets it, by name: "all", then the names in the order of its own list.
  assert.equal((await client.call("plugins.get", id)).botNames, "all");
  const nova = (await client.call("bots.add", { name: "Nova" })).id;
  const orbit = (await client.call("bots.add", { name: "Orbit" })).id;
  const chosen = await client.call("plugins.setBots", id, ["Orbit", "Nova"]);
  assert.deepEqual([chosen.bots, chosen.botNames], [[orbit, nova], ["Orbit", "Nova"]]);
  assert.deepEqual((await client.call("plugins.list"))[0].botNames, ["Orbit", "Nova"]);
  // A bot that is gone is left out.
  await client.call("bots.remove", "Nova");
  assert.deepEqual((await client.call("plugins.get", id)).botNames, ["Orbit"]);
  // A preview has no bots, and says nothing of them.
  assert.equal(Object.hasOwn(await client.call("plugins.preview", id), "botNames"), false);
  // A file is written into the installed copy. The next look says so, with no session opened in between.
  await client.call("plugins.setEnabled", id, true, revision);
  assert.equal((await client.call("plugins.get", id)).status, "ready");
  const [row] = running.runtime.workspace.plugins.records;
  writeFileSync(join(row.folder, "planted.txt"), "not reviewed");
  const got = await client.call("plugins.get", id);
  assert.deepEqual([got.status, got.repair], ["error", "update"]);
  assert.deepEqual((await client.call("plugins.list")).map((entry) => [entry.status, entry.repair]), [["error", "update"]]);
});
