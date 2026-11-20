import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AppUpdates, latestRelease, updateTools } from "../desktop/updates.mjs";

test("check compares stable GitHub tags, notifies once, and installs only on request", async t => {
  let tag = "v0.15.4";
  const server = createServer((_req, res) => res.end(JSON.stringify({ tag_name: tag, draft: false, prerelease: false,
    assets: [{ name: "Botkins-" + tag.slice(1) + "-arm64-mac.zip" }, { name: "latest-mac.yml" }] })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const notices = [], installs = [];
  const restarted = Promise.withResolvers();
  const updates = new AppUpdates({ current: "0.15.4", mac: true, arch: "arm64",
    latest: () => latestRelease({ fetcher: () => fetch("http://127.0.0.1:" + server.address().port), token: "" }),
    notify: version => notices.push(version), stage: async version => installs.push(version), restart: () => { installs.push("restart"); restarted.resolve(); } });
  assert.equal((await updates.check()).status, "current");
  tag = "v0.15.3";
  assert.equal((await updates.check()).status, "current");
  tag = "v0.15.10";
  await Promise.all([updates.check(), updates.check()]);
  await updates.check();
  assert.deepEqual(notices, ["0.15.10"]);
  assert.deepEqual(installs, []);
  const end = Promise.withResolvers();
  await Promise.all([updates.install(end.promise), updates.install(end.promise)]);
  assert.deepEqual(installs, ["0.15.10"]);
  end.resolve();
  await restarted.promise;
  assert.deepEqual(installs, ["0.15.10", "restart"]);
});
test("untrusted tags, missing assets, and unavailable private releases never install", async () => {
  await assert.rejects(latestRelease({ token: "", fetcher: async () => new Response(null, { status: 404 }) }), /GitHub CLI/);
  for (const data of [{ tag_name: "whatever" }, { tag_name: "v1.0.0", prerelease: true }, { tag_name: "v1.0.0", draft: true }])
    await assert.rejects(latestRelease({ token: "", fetcher: async () => Response.json(data) }));
  const u = new AppUpdates({ current: "1.0.0", mac: true, arch: "arm64", latest: async () => ({ version: "1.1.0", assets: [] }), stage: assert.fail });
  assert.equal((await u.check()).canInstall, false);
  await assert.rejects(u.install(), /compatible/);
  assert.deepEqual(updateTools(u, { helper: true }, {}, {}), []);
});

test("agent update tools use the active person's turn and wait for its reply", async () => {
  const calls = [];
  const updates = { check: async () => ({ latest: "2.0.0" }), install: async done => { calls.push(done); return { status: "restarting" }; } };
  const task = { done: Promise.resolve(), stopped: false };
  const tools = updateTools(updates, { id: "chat" }, { id: "run" }, task, () => task);
  const [check, install] = tools;
  assert.deepEqual(tools.map(t => t.name), ["check_app_update", "install_app_update"]);
  assert.equal(JSON.parse(await check.handler({})).latest, "2.0.0");
  assert.equal(install.skipPermission, false);
  assert.equal(JSON.parse(await install.handler({})).status, "restarting");
  assert.deepEqual(calls, [task.done]);
  task.stopped = true;
  await assert.rejects(install.handler({}), /turn has ended/);
  assert.deepEqual(updateTools(updates, {}, { scheduleId: 0 }, task), []);
});
