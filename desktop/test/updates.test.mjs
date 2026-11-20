import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppUpdates, latestRelease, updateTools } from "../desktop/updates.mjs";
import { installLinuxTarball, isLinuxTarballExecutable, linuxUnitAvailable } from "../desktop/linux-update.mjs";
import { performUpdate } from "../desktop/linux-service/botkins-update-helper.mjs";

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

test("the status carries the choice to install by itself and how the last install ended, only where there is one", async () => {
  let on = false;
  let idle = false;
  const installs = [];
  const base = { current: "1.0.0", linux: true, mac: false, arch: "x64", latest: async () => ({ version: "1.1.0", assets: ["botkins-desktop-1.1.0.tar.gz"] }), stage: async version => installs.push(version), restart: () => {} };
  const plain = new AppUpdates(base);
  assert.deepEqual(plain.status(), { status: "idle", current: "1.0.0", canInstall: false });
  assert.throws(() => plain.setAuto(true), /doesn't install updates by itself/);
  const heard = [];
  const stop = plain.onAvailable(version => heard.push(version));
  plain.onAvailable(() => { throw new Error("a listener that fails"); });
  await plain.check();
  await plain.check();
  assert.deepEqual(heard, ["1.1.0"]);
  stop();
  const last = { at: "2026-01-02T03:04:05.000Z", from: "0.9.0", to: "1.0.0", ok: true };
  const auto = new AppUpdates({ ...base, auto: { get: () => on, set: value => { on = value; } }, idle: () => idle, last: () => last, autoPollMs: 5 });
  assert.deepEqual(auto.status(), { status: "idle", current: "1.0.0", canInstall: false, auto: false, last });
  await auto.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(installs, [], "off: a new release waits to be asked for");
  assert.equal(auto.setAuto(true).auto, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(installs, [], "on, and a turn is under way: it waits");
  idle = true;
  for (let tries = 0; tries < 100 && !installs.length; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(installs, ["1.1.0"]);
  assert.throws(() => auto.setAuto(1), /Say on or off/);
  auto.stopAuto();
});

test("GitHub release discovery follows API redirects", async () => {
  let options;
  const result = await latestRelease({ fetcher: async (_url, next) => { options = next; return Response.json({ tag_name: "v0.15.7", draft: false, prerelease: false, assets: [] }); } });
  assert.equal(result.version, "0.15.7");
  assert.equal(options.redirect, "follow");
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

test("Linux tarball installs advertise the matching architecture", async () => {
  const u = new AppUpdates({ current: "0.15.6", linux: true, mac: false, arch: "arm64", latest: async () => ({ version: "0.15.7", assets: ["botkins-desktop-0.15.7-arm64.tar.gz"] }) });
  assert.equal((await u.check()).canInstall, true);
  assert.equal((await u.check()).installer, "linux-tarball");
  const calls = [];
  await installLinuxTarball(async (...args) => calls.push(args));
  assert.deepEqual(calls[0].slice(0, 2), ["systemctl", ["--no-ask-password", "start", "botkins-update.service"]]);
});

test("Linux updater refuses AppImage and unsupported executable layouts and probes its systemd unit", async () => {
  assert.equal(isLinuxTarballExecutable("/opt/botkins/current/botkins-desktop", () => ({ isSymbolicLink: () => true })), true);
  assert.equal(isLinuxTarballExecutable("/opt/botkins/current/Botkins", () => ({ isSymbolicLink: () => true })), false);
  assert.equal(isLinuxTarballExecutable("/opt/botkins/Botkins.AppImage", () => ({ isSymbolicLink: () => false })), false);
  const calls = [];
  assert.equal(await linuxUnitAvailable(async (...args) => { calls.push(args); return { stdout: "loaded\n" }; }), true);
  assert.deepEqual(calls[0].slice(0, 2), ["systemctl", ["show", "botkins-update.service", "--property=LoadState", "--value"]]);
});

test("Linux install waits for the person's turn before starting the updater unit", async () => {
  const calls = [];
  const turn = Promise.withResolvers();
  const fired = Promise.withResolvers();
  const updates = new AppUpdates({ current:"0.15.6", linux:true, arch:"arm64",
    latest: async () => ({version:"0.15.7", assets:["botkins-desktop-0.15.7-arm64.tar.gz"]}),
    stage: async () => {}, restart: () => {calls.push("restart"); fired.resolve();} });
  // The tool has to return BEFORE the turn can finish.
  assert.equal((await updates.install(turn.promise)).status, "restarting");
  assert.equal(calls.length, 0);
  turn.resolve();
  await fired.promise;
  assert.equal(calls.length, 1);
});

test("Linux upgrade preserves existing directories and restores the running version on failed health checks", t => {
  const root = mkdtempSync(join(tmpdir(), "botkins-update-"));
  t.after(() => rmSync(root, { force:true, recursive:true }));
  const current = join(root, "current");
  const versionDir = version => "botkins-desktop-" + version + "-arm64";
  const previous = join(root, versionDir("0.15.6"));
  mkdirSync(previous);
  symlinkSync(previous, current);
  const stage = join(root, "source");
  mkdirSync(stage);
  function fixture(version) {
    const top = versionDir(version);
    mkdirSync(join(stage, top));
    writeFileSync(join(stage, top, "botkins-desktop"), version);
    writeFileSync(join(stage, top, "chrome-sandbox"), "sandbox");
    const archive = join(root, top + ".tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", stage, top]);
    return {version, archive, installRoot:root, currentLink:current, service:"botkins.service",
      arch:"arm64", verifyOwnership:false, healthWindowMs:0};
  }
  const good = fixture("0.15.7");
  const invoke = (file, args, options) => file === "systemctl" ? "healthy" : execFileSync(file, args, options);
  performUpdate({...good, execFile:invoke});
  const activeVersion = () => readFileSync(join(current,"botkins-desktop"),"utf8");
  assert.equal(activeVersion(),"0.15.7");
  assert.throws(() => performUpdate({...good,execFile:invoke}), /newer/);
  assert.equal(activeVersion(),"0.15.7");
  const next = fixture("0.15.8");
  const target = join(root, versionDir("0.15.8"));
  mkdirSync(target);
  assert.throws(() => performUpdate({...next,execFile:invoke}), /already exists/);
  assert.ok(lstatSync(target).isDirectory());
  rmSync(target,{recursive:true});
  let restarts = 0;
  const unhealthy = (file,args,options) => {
    if (file === "systemctl" && args[0] === "restart") restarts++;
    if (file === "systemctl" && args[0] === "is-active") throw new Error("unit failed");
    return invoke(file,args,options);
  };
  assert.throws(() => performUpdate({...next,execFile:unhealthy}), /unit failed/);
  assert.equal(activeVersion(),"0.15.7");
  assert.equal(restarts,2);
  assert.equal(existsSync(target),false);
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
