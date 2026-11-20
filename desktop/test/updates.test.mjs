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
  // The last install is shown only while it says something about the copy that runs: it brought
  // this version, or it failed and left this version. Old news is not shown.
  const shown = (record) => new AppUpdates({ ...base, last: () => record }).status().last;
  assert.deepEqual(shown({ ...last, from: "0.9.0", to: "1.0.0", ok: true }), { ...last, from: "0.9.0", to: "1.0.0", ok: true });
  assert.deepEqual(shown({ ...last, from: "1.0.0", to: "1.1.0", ok: false, message: "It was put back." }).ok, false);
  assert.equal(shown({ ...last, from: "0.8.0", to: "0.9.0", ok: true }), undefined, "an install from before a later upgrade");
  assert.equal(shown({ ...last, from: "0.9.0", to: "1.0.0", ok: false }), undefined, "a failure the person has since got past by hand");
  // A release that failed here is not tried again by itself; the one after it is.
  let tried = "1.1.0";
  const stuck = [];
  const wary = new AppUpdates({ ...base, latest: async () => ({ version: tried, assets: ["botkins-desktop-" + tried + ".tar.gz"] }), stage: async version => stuck.push(version), auto: { get: () => true, set() {} }, idle: () => true, last: () => ({ ...last, from: "1.0.0", to: "1.1.0", ok: false }), autoPollMs: 5 });
  await wary.check();
  await wary.check();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(stuck, []);
  assert.equal((await wary.install()).status, "restarting", "on purpose, it is installed");
  assert.deepEqual(stuck, ["1.1.0"]);
  const next = new AppUpdates({ ...base, latest: async () => ({ version: "1.2.0", assets: ["botkins-desktop-1.2.0.tar.gz"] }), stage: async version => stuck.push(version), auto: { get: () => true, set() {} }, idle: () => true, last: () => ({ ...last, from: "1.0.0", to: "1.1.0", ok: false }), autoPollMs: 5 });
  await next.check();
  for (let tries = 0; tries < 100 && stuck.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(stuck, ["1.1.0", "1.2.0"]);
  next.stopAuto();
  wary.stopAuto();
});

test("GitHub release discovery follows API redirects", async () => {
  let options;
  const result = await latestRelease({ fetcher: async (_url, next) => { options = next; return Response.json({ tag_name: "v0.15.7", draft: false, prerelease: false, assets: [] }); } });
  assert.equal(result.version, "0.15.7");
  assert.equal(options.redirect, "follow");
});
test("the latest release is found from the release page, which GitHub does not limit, and from the API only as a second try", async () => {
  const sums = ["a".repeat(64) + "  botkins-terminal-0.17.0-linux-x64.tar.gz", "b".repeat(64) + "  botkins-desktop-0.17.0.tar.gz", "not a line of the list", ""].join("\n");
  const there = ["SHA256SUMS.asc", "latest-mac.yml", "Botkins-0.17.0-arm64-mac.zip"];
  // GitHub as it answers: the page sends its reader on to the release, and a file that is there sends on to where it is kept.
  // `files` says how one file answers instead: a status, or "down" for no answer at all.
  const github = ({ api = 403, page = "v0.17.0", files = {}, leads = "https://github.com/promptclickrun/Botkins/releases/tag/" } = {}) => {
    const asked = [];
    const fetcher = async (url, options = {}) => {
      asked.push((options.method ?? "GET") + " " + url.replace("https://github.com/promptclickrun/Botkins/", "").replace("https://api.github.com/repos/promptclickrun/Botkins/", "api:") + (options.headers?.Authorization ? " (signed in)" : ""));
      if (url.startsWith("https://api.github.com/")) return typeof api === "number" ? new Response(null, { status: api }) : Response.json(api);
      if (url.endsWith("/releases/latest")) return page ? new Response(null, { status: 302, headers: { location: leads + page } }) : new Response("<html>", { status: 200 });
      const name = url.split("/").at(-1);
      if (files[name] === "down") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
      if (files[name]) return new Response(null, { status: files[name] });
      if (name === "SHA256SUMS") return new Response(sums);
      return new Response(null, { status: there.includes(name) ? 302 : 404 });
    };
    return { asked, fetcher };
  };
  const listed = ["botkins-terminal-0.17.0-linux-x64.tar.gz", "botkins-desktop-0.17.0.tar.gz", "SHA256SUMS", "SHA256SUMS.asc"];
  const fromApi = { tag_name: "v0.17.0", draft: false, prerelease: false, assets: [{ name: "from-the-api" }] };
  // No sign-in (a server, the terminal host): the page says which release, its own list says what it holds, and the API is never asked.
  const plain = github();
  assert.deepEqual(await latestRelease({ fetcher: plain.fetcher, token: "" }), { version: "0.17.0", assets: listed });
  assert.deepEqual(plain.asked, ["GET releases/latest", "GET releases/download/v0.17.0/SHA256SUMS", "HEAD releases/download/v0.17.0/SHA256SUMS.asc"], "three small questions, none of them to the API, and none about files only a Mac takes");
  // The Mac app says it is one, and the files its own updater takes are asked for by name, and not downloaded.
  const mac = github();
  assert.deepEqual(await latestRelease({ fetcher: mac.fetcher, token: "", mac: true }), { version: "0.17.0", assets: [...listed, "latest-mac.yml", "Botkins-0.17.0-arm64-mac.zip"] });
  assert.deepEqual(mac.asked.slice(2).sort(), ["SHA256SUMS.asc", "latest-mac.yml", "Botkins-0.17.0-arm64-mac.zip", "Botkins-0.17.0-x64-mac.zip", "Botkins-0.17.0-universal-mac.zip"].map((name) => "HEAD releases/download/v0.17.0/" + name).sort());
  // The page not leading anywhere (GitHub changed, or is half down): the API is the second try.
  const second = github({ page: null, api: { tag_name: "v0.17.1", draft: false, prerelease: false, assets: [{ name: "latest-mac.yml" }] } });
  assert.deepEqual(await latestRelease({ fetcher: second.fetcher, token: "" }), { version: "0.17.1", assets: ["latest-mac.yml"] });
  assert.deepEqual(second.asked, ["GET releases/latest", "GET api:releases/latest"]);
  // With a sign-in (the desktop app, where GitHub CLI is signed in) the API is asked first, and the page when it fails.
  const signed = github({ api: fromApi });
  assert.deepEqual(await latestRelease({ fetcher: signed.fetcher, token: "t" }), { version: "0.17.0", assets: ["from-the-api"] });
  assert.deepEqual(signed.asked, ["GET api:releases/latest (signed in)"]);
  const expired = github({ api: 401 });
  assert.equal((await latestRelease({ fetcher: expired.fetcher, token: "old" })).version, "0.17.0");
  assert.equal(expired.asked[1], "GET releases/latest");

  // A failure that passes is never an answer. The list of the release's files not coming (GitHub
  // busy, a timeout) is not an empty list: the page way gives up, and the API has its turn.
  for (const failure of [429, 500, 503, "down"]) {
    const busy = github({ api: fromApi, files: { SHA256SUMS: failure } });
    assert.deepEqual(await latestRelease({ fetcher: busy.fetcher, token: "" }), { version: "0.17.0", assets: ["from-the-api"] }, "the list answered " + failure);
    assert.equal(busy.asked.at(-1), "GET api:releases/latest");
  }
  // The same for a file asked for by name: only GitHub saying 404 means it isn't there.
  for (const failure of [429, 500, 502, "down"]) {
    const busy = github({ api: fromApi, files: { "latest-mac.yml": failure } });
    assert.deepEqual(await latestRelease({ fetcher: busy.fetcher, token: "", mac: true }), { version: "0.17.0", assets: ["from-the-api"] }, "latest-mac.yml answered " + failure);
    const signature = github({ api: fromApi, files: { "SHA256SUMS.asc": failure } });
    assert.deepEqual(await latestRelease({ fetcher: signature.fetcher, token: "" }), { version: "0.17.0", assets: ["from-the-api"] }, "SHA256SUMS.asc answered " + failure);
  }
  // And when the API can't answer either, nothing is made up: the lookup fails, and says both reasons.
  await assert.rejects(latestRelease({ fetcher: github({ api: 403, files: { SHA256SUMS: 503 } }).fetcher, token: "" }), (error) => error.message === "GitHub did not say which release is the latest: the list of what Botkins 0.17.0 holds did not come (HTTP 503); its API is not answering this address for now (it limits how often one address may ask). Try again later.");
  await assert.rejects(latestRelease({ fetcher: github({ api: 403, files: { "latest-mac.yml": 500 } }).fetcher, token: "", mac: true }), /it did not say whether Botkins 0\.17\.0 has latest-mac\.yml \(HTTP 500\); its API is not answering/);
  // 404 is GitHub saying "not there", and is an answer: a release with no list of its own, a file it doesn't have.
  const bare = github({ files: { SHA256SUMS: 404 } });
  assert.deepEqual(await latestRelease({ fetcher: bare.fetcher, token: "", mac: true }), { version: "0.17.0", assets: ["SHA256SUMS.asc", "latest-mac.yml", "Botkins-0.17.0-arm64-mac.zip"] });
  assert.ok(bare.asked.every((line) => !line.includes("api:")));

  // A page that leads to something that is no stable release of this project is not followed: a
  // pre-release, a tag that is no version, and the same path at another address (a network's own sign-in page, say).
  for (const page of ["v0.18.0-beta.1", "nightly", "0.17.0", "v0.17", "v0.17.0/../../x"]) await assert.rejects(latestRelease({ fetcher: github({ page, api: 404 }).fetcher, token: "" }), /its release page did not lead to a stable release of Botkins \(HTTP 302\); its API names no published release of Botkins/);
  for (const leads of ["https://example.com/promptclickrun/Botkins/releases/tag/", "https://github.com/someone-else/Botkins/releases/tag/", "/releases/tag/"]) {
    const elsewhere = github({ leads, api: 404 });
    await assert.rejects(latestRelease({ fetcher: elsewhere.fetcher, token: "" }), /its release page did not lead to a stable release/);
    assert.ok(elsewhere.asked.every((line) => !line.includes("download")), "nothing is asked of a release found that way");
  }
  // Both ways refused or unreachable: what is said is true, names each cause once, and names nothing to sign in to.
  await assert.rejects(latestRelease({ fetcher: github({ page: null, api: 403 }).fetcher, token: "" }), (error) => error.message === "GitHub did not say which release is the latest: its release page did not lead to a stable release of Botkins (HTTP 200); its API is not answering this address for now (it limits how often one address may ask). Try again later.");
  await assert.rejects(latestRelease({ fetcher: github({ page: null, api: 429 }).fetcher, token: "" }), /limits how often one address may ask/);
  await assert.rejects(latestRelease({ fetcher: github({ page: null, api: 503 }).fetcher, token: "" }), /its API answered HTTP 503\. Try again later\./);
  await assert.rejects(latestRelease({ fetcher: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, token: "" }), (error) => error.message === "GitHub did not say which release is the latest: it could not be reached (ENOTFOUND). Try again later.");
  // A sign-in that GitHub no longer accepts is said as that, beside what the page did, and not hidden by it.
  await assert.rejects(latestRelease({ fetcher: github({ page: null, api: 401 }).fetcher, token: "old" }), (error) => error.message === "GitHub did not say which release is the latest: its API did not accept the sign-in from GitHub CLI; its release page did not lead to a stable release of Botkins (HTTP 200). Try again later.");
  for (const status of [403, 404, 429, 503]) await latestRelease({ fetcher: github({ page: null, api: status }).fetcher, token: "" }).catch((error) => assert.doesNotMatch(error.message, /GitHub CLI|[Ss]ign in/));
  for (const status of [401, 403, 404, 429, 503]) await latestRelease({ fetcher: github({ page: null, api: status }).fetcher, token: "" }).catch((error) => assert.ok(error.message.length < 300, "it fits where a phone shows it"));
});

test("untrusted tags, missing assets, and unavailable private releases never install", async () => {
  await assert.rejects(latestRelease({ token: "", fetcher: async () => new Response(null, { status: 404 }) }), /its API names no published release of Botkins\. Try again later\./);
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
