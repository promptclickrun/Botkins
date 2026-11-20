// The host interface (desktop/host): what a host must have, what the headless one refuses and how
// it says so, and that the workspace's calls reach a window, a dialog or the clipboard only
// through the host they were given.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { checkHost, HOST_MEMBERS, HostUnavailable, missingMembers, unavailable } from "../desktop/host/index.mjs";
import { DESKTOP_ONLY, headlessHost } from "../desktop/host/headless.mjs";
import { Failure } from "../desktop/link/tools.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { LinkClient, pair } from "../desktop/remote/link-client.mjs";
import { fakeHost } from "./fake-host.mjs";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A runtime on `host` in a folder of its own, with no provider this computer happens to have. */
async function runtimeOn(t, host, options = {}) {
  const before = process.env.BOTKINS_PROVIDERS;
  process.env.BOTKINS_PROVIDERS = "grok";
  const runtime = await createRuntime({ host, dataDir: join(tempDir(t), "data"), trial: true, link: { port: 0 }, ...options });
  if (before === undefined) delete process.env.BOTKINS_PROVIDERS;
  else process.env.BOTKINS_PROVIDERS = before;
  t.after(() => runtime.stop());
  return runtime;
}

test("a host that leaves a member out is named for it", () => {
  const whole = headlessHost({ version: "1.2.3" });
  assert.deepEqual(missingMembers(whole), []);
  assert.equal(checkHost(whole), whole);
  const { pdf: _pdf, ...rest } = whole;
  const broken = { ...rest, dialogs: { ...whole.dialogs, save: undefined }, version: 5 };
  assert.deepEqual(missingMembers(broken).sort(), ["dialogs.save", "pdf", "version"]);
  assert.throws(() => checkHost(broken), /This host is missing: .*dialogs\.save/);
  assert.deepEqual(missingMembers({}), Object.keys(HOST_MEMBERS));
});

test("what a host can't do is one sentence, and one of the link's own failures", () => {
  const error = unavailable("Choosing a file");
  assert.ok(error instanceof HostUnavailable);
  // A Failure reaches a phone with its own words (desktop/link/server.mjs, plain()).
  assert.ok(error instanceof Failure);
  assert.equal(error.message, "Choosing a file is not available on this host.");
  assert.equal(error.code, "HOST_UNAVAILABLE");
});

test("only the desktop app's own files load Electron, and its host is checked whole when it is built", () => {
  // The Electron host can only be built inside Electron, which the smokes do: `checkHost` then
  // refuses a host with a member missing, so the app would not start. Here its source is read
  // for each group of the interface, and every other file is read for Electron.
  const source = readFileSync(new URL("../desktop/host/electron.mjs", import.meta.url), "utf8");
  assert.match(source, /return checkHost\(\{/);
  for (const group of new Set(Object.keys(HOST_MEMBERS).map((path) => path.split(".")[0])))
    assert.ok(new RegExp("^    (async )?" + group + "[:(]", "m").test(source), group + " is missing from the Electron host");
  const root = new URL("../desktop/", import.meta.url);
  const loaders = readdirSync(root, { recursive: true })
    .filter((file) => /\.(mjs|cjs)$/.test(file) && !file.split(sep).includes("node_modules") && !file.split(sep).includes("generated"))
    .filter((file) => /from "electron"|require\("electron"\)|import\("electron"\)/.test(readFileSync(new URL(file.split(sep).join("/"), root), "utf8")))
    .map((file) => file.split(sep).join("/"))
    .sort();
  assert.deepEqual(loaders, ["app-preload.cjs", "app-window.mjs", "host/electron.mjs", "main.mjs", "preload.cjs", "start.mjs"]);
});

test("the headless host refuses what needs a desktop, and does the rest", async () => {
  const host = headlessHost({ version: "1.2.3", packaged: true });
  assert.equal(host.kind, "terminal");
  assert.equal(host.headless, true);
  assert.deepEqual(host.displayStatus(), { available: false, note: "This host has no display." });
  assert.deepEqual(host.info(), { version: "1.2.3", electron: "", chrome: "", node: process.versions.node, platform: process.platform, host: "terminal" });
  assert.equal(await host.keys({ dataDir: "/nowhere", trial: false }), null);
  assert.equal(host.updates(), undefined);
  assert.equal(host.notifications, null);
  assert.equal(host.images, null);
  assert.equal(host.window.focused(), false);
  assert.equal(host.window.viewing(), null);
  assert.equal(host.window.send("changed", {}), false);
  assert.equal(await host.cache.size(), 0);
  for (const [what, ask] of [
    ["Choosing a file or folder", () => host.dialogs.open({})],
    ["Choosing where to save a file", () => host.dialogs.save({})],
    ["Asking a question on the computer's screen", () => host.dialogs.ask({})],
    ["Opening a web page in a browser", () => host.shell.openExternal("https://example.com")],
    ["Opening a file or folder", () => host.shell.openPath("/tmp")],
    ["Viewing the screen", () => host.screen.capture({})],
    ["Viewing the screen", () => host.screen.displays()],
    ["Exporting a PDF", () => host.pdf("<p>x</p>")],
    ["Typing a saved credential into a page", () => host.window.fillSecurePage({}, {}, null)],
  ])
    await assert.rejects(ask(), { name: "HostUnavailable", message: what + " is not available on this host." });
  assert.throws(() => host.clipboard.writeText("x"), /The clipboard is not available on this host\./);
  assert.throws(() => host.shell.showItemInFolder("/tmp"), /not available on this host\./);
  // An error box becomes a line in the service's log.
  const lines = [];
  headlessHost({ log: (line) => lines.push(line) }).dialogs.error("Panel refresh", "It failed.");
  assert.deepEqual(lines, ["Panel refresh: It failed."]);
  // A program that knows the computer woke says so, and what waited for that runs.
  let woke = 0;
  host.power.onResume(() => woke++);
  host.resumed();
  assert.equal(woke, 1);
  assert.ok(DESKTOP_ONLY.length >= 5);
});

test("the workspace's calls reach a dialog, the clipboard and the window only through their host", async (t) => {
  const dir = tempDir(t);
  const saved = join(dir, "usage.csv");
  const host = fakeHost({ save: saved, open: null, viewing: null });
  const runtime = await runtimeOn(t, host);
  const { handlers } = runtime;
  assert.deepEqual(host.asked.find(([name]) => name === "theme.set"), ["theme.set", "system"]);

  assert.equal(await handlers.exportUsage(7), true);
  assert.match(readFileSync(saved, "utf8"), /date|day/i);
  const asked = host.asked.find(([name]) => name === "dialogs.save");
  assert.equal(asked[1].defaultPath, "botkins-usage-7d.csv");

  assert.deepEqual(await handlers.chooseFiles(), []);
  assert.equal(await handlers.addProject(), null);
  handlers.copyText("copied text");
  assert.deepEqual(host.asked.findLast(([name]) => name === "clipboard.writeText"), ["clipboard.writeText", "copied text"]);
  await handlers.openLink("https://example.com/a?b=1");
  assert.deepEqual(host.asked.findLast(([name]) => name === "shell.openExternal"), ["shell.openExternal", "https://example.com/a?b=1"]);
  assert.throws(() => handlers.openLink("file:///etc/passwd"), /Unsupported link/);

  // Settings are saved, and the host is told what to make of them.
  handlers.setPreferences({ appearance: { theme: "dark" } });
  assert.deepEqual(host.asked.findLast(([name]) => name === "theme.set"), ["theme.set", "dark"]);
  assert.equal(host.asked.findLast(([name]) => name === "background.apply")[1].keepRunning, true);

  handlers.testNotification();
  assert.equal(host.Notification.shown.at(-1).options.title, "Botkins");
  assert.deepEqual(handlers.appInfo(), host.info());
  assert.equal(handlers.snapshot().phones.revision, runtime.phoneRevision());
});

test("a computer that looks for updates says so to its phones, tells them of a new one once, and answers their calls", async (t) => {
  let found = "9.9.9";
  const { AppUpdates } = await import("../desktop/updates.mjs");
  let restarted = 0;
  const updates = new AppUpdates({ current: "9.9.9", mac: true, arch: "arm64", latest: async () => ({ version: found, assets: ["Botkins-" + found + "-arm64-mac.zip", "latest-mac.yml"] }), stage: async () => {}, restart: () => void restarted++ });
  const host = { ...fakeHost(), updates: () => updates };
  const runtime = await runtimeOn(t, host);
  const { handlers, link, linkBackend } = runtime;
  assert.ok(linkBackend.capabilities.includes("app-update-v1"));
  // The link's own way of telling the owner's phones (desktop/link/push.mjs), stood in for here.
  const told = [];
  link.push.updateAvailable = (version) => told.push(version);
  assert.deepEqual(await handlers.checkAppUpdate(), { status: "current", current: "9.9.9", latest: "9.9.9", canInstall: false });
  assert.deepEqual(told, []);
  found = "9.10.0";
  assert.deepEqual(await handlers.checkAppUpdate(), { status: "available", current: "9.9.9", latest: "9.10.0", canInstall: true });
  await handlers.checkAppUpdate();
  assert.deepEqual(told, ["9.10.0"], "once for each version");
  assert.deepEqual(handlers.appUpdateStatus(), { status: "available", current: "9.9.9", latest: "9.10.0", canInstall: true });
  assert.equal((await handlers.installAppUpdate()).status, "restarting");
  // The answer is out before the app goes down: the restart waits a moment after the call returns.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(restarted, 0, "not yet: the phone that asked is still being answered");
  for (let tries = 0; tries < 40 && !restarted; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(restarted, 1);
  // The desktop app has no choice to install by itself: the status has no `auto`, and the call is refused.
  assert.throws(() => handlers.setAppUpdateAuto(true), /doesn't install updates by itself/);
  // A copy with no update service names no such capability, and its calls say so.
  const plain = await runtimeOn(t, headlessHost({ version: "1.2.3" }));
  assert.equal(plain.linkBackend.capabilities.includes("app-update-v1"), false);
  assert.throws(() => plain.handlers.appUpdateStatus(), /doesn't look for updates/);
  await assert.rejects(plain.handlers.checkAppUpdate(), /doesn't look for updates/);
});

test("a setting the host refuses goes back to what it was", async (t) => {
  const host = fakeHost({
    background: (background) => {
      if (background?.runAtStartup) throw new Error("No.");
    },
  });
  const { handlers, workspace } = await runtimeOn(t, host);
  assert.throws(() => handlers.setPreferences({ background: { runAtStartup: true } }), /This computer wouldn't change what starts with it\. No\./);
  assert.equal(workspace.state.settings.background.runAtStartup, false);
  assert.equal(host.asked.at(-1)[0], "background.refresh");
});

test("on the headless host a phone pairs and works, and is told plainly what the host can't do", async (t) => {
  const lines = [];
  const runtime = await runtimeOn(t, headlessHost({ version: "1.2.3", log: (line) => lines.push(line) }));
  const { handlers, link, phone: page } = runtime;
  runtime.begin();
  // The calls of the app's own window work without one, or refuse in one sentence.
  for (const [name, args, what] of [
    ["chooseFiles", [], "Choosing a file or folder"],
    ["exportUsage", [7], "Choosing where to save a file"],
    ["importTemplate", [], "Choosing a file or folder"],
    ["openAppRelease", [], "Opening a web page in a browser"],
  ])
    await assert.rejects(async () => handlers[name](...args), { message: what + " is not available on this host." }, name);
  assert.throws(() => handlers.copyText("x"), /The clipboard is not available on this host\./);
  assert.throws(() => handlers.testNotification(), /Notifications aren't supported on this computer\./);
  assert.equal(await handlers["artifacts.thumbnail"]("nothing", { size: 64 }), null);
  // iMessage and Mail tools are the desktop app's, on a Mac: here they are not there, whatever this computer is.
  assert.equal((await handlers.macToolsStatus()).available, false);
  await assert.rejects(handlers.setMacTool("mail", "read"), /work only in Botkins on a Mac/);
  assert.equal(runtime.workspace.snapshot().macTools.available, false);
  assert.deepEqual(await handlers.cacheInfo(), { bytes: 0, catalogs: 0 });

  await page.setPhoneLink(true);
  const status = page.startPhonePairing();
  assert.match(status.pairing.url, /^botkins:\/\/pair\?/);
  assert.deepEqual(status.screen.permissions, { system: false, screenRecording: false, accessibility: false });
  const pairing = await pair(fetch, { hosts: ["127.0.0.1:" + link.port], code: status.pairing.code }, { name: "Fixture phone", platform: "ios" });
  const phone = new LinkClient(pairing, { fetch, onState() {}, onParts() {} });
  t.after(() => phone.stop());
  assert.equal(link.headless(), true);
  // What a phone does all day: the app's own calls.
  const botId = await phone.call("addBot", { name: "Nova", role: "Editor", instructions: "Be brief." });
  assert.equal(runtime.workspace.bot(botId).name, "Nova");
  assert.equal((await phone.call("appInfo")).host, "terminal");
  assert.equal(typeof (await phone.call("exportUsageText", 7)).name, "string");
  assert.deepEqual(await phone.call("cacheInfo"), { bytes: 0, catalogs: 0 });
  // The screen: off, and when asked for, not there to show.
  assert.equal((await phone.call("link.screen.info")).canView, false);
  link.setScreenMode("view");
  const screen = await phone.call("link.screen.info");
  assert.deepEqual([screen.canView, screen.problem], [false, "Viewing the screen is not available on this host."]);
  await assert.rejects(phone.call("link.screen.frame", { display: "1" }), /Viewing the screen is not available on this host\./);
  // A notification the computer would show has nowhere to go.
  await assert.rejects(phone.call("testNotification"), /Notifications aren't supported on this computer\./);
  assert.equal(page.phoneLink().devices.length, 1);
  assert.equal(existsSync(join(runtime.workspace.dir, "vault.key")), true, "a trial run keeps its vault key in a file");
});
