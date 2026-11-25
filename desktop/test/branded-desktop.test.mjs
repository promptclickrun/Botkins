// The Botkins desktop (docker/desktop): the background, Openbox theme and menu of a display that
// Botkins starts itself. A managed display gets the brand; a display a person owns is never changed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const repo = join(desktopDir, "..");
const kit = join(desktopDir, "docker", "desktop");
const read = (path) => readFileSync(path, "utf8");

const FILES = [
  "botkins-desktop",
  "botkins-desktop-open",
  "botkins-desktop-session",
  "install-tools",
  "botkins-mark.png",
  "wallpaper.html",
  "config/openbox/botkins-rc.xml",
  "config/openbox/botkins-menu.xml",
  "share/themes/Botkins/openbox-3/themerc",
];

/** Throws unless `text` is well-formed XML: one root, every tag closed in order, no `--` in a comment. */
function checkXml(text, name) {
  let rest = text.replace(/^﻿/, "").replace(/<\?xml[^?]*\?>/, "");
  for (const comment of rest.match(/<!--[\s\S]*?-->/g) ?? []) assert.ok(!comment.slice(4, -3).includes("--"), name + ": a comment holds --");
  rest = rest.replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  let roots = 0;
  for (const [, close, tag, , selfClose] of rest.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g)) {
    if (close) assert.equal(stack.pop(), tag, name + ": </" + tag + "> closes the wrong element");
    else if (!selfClose) { if (!stack.length) roots++; stack.push(tag); }
    else if (!stack.length) roots++;
  }
  assert.deepEqual(stack, [], name + ": unclosed elements");
  assert.equal(roots, 1, name + ": one root element");
  assert.ok(!/<(?![/!?A-Za-z_])/.test(rest), name + ": a stray <");
}

test("the kit's files are all there, and its scripts can run", () => {
  for (const file of FILES) assert.ok(existsSync(join(kit, file)), file);
  for (const script of ["botkins-desktop", "botkins-desktop-open", "botkins-desktop-session"]) {
    assert.ok(statSync(join(kit, script)).mode & 0o111, script + " is executable");
    assert.equal(spawnSync("sh", ["-n", join(kit, script)]).status, 0, script + " parses");
  }
  const png = readFileSync(join(kit, "botkins-mark.png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  // Small enough to sit centered on the smallest display without being cut.
  assert.ok(width <= 480 && height <= 200, "the mark is " + width + "x" + height);
  assert.equal(png[25], 6, "the mark has a transparent background (RGBA)");
});

test("the Openbox files are well-formed and set one desktop, the Botkins theme and its menu", () => {
  const rc = read(join(kit, "config/openbox/botkins-rc.xml"));
  const menu = read(join(kit, "config/openbox/botkins-menu.xml"));
  checkXml(rc, "botkins-rc.xml");
  checkXml(menu, "botkins-menu.xml");
  const xmllint = spawnSync("xmllint", ["--noout", join(kit, "config/openbox/botkins-rc.xml"), join(kit, "config/openbox/botkins-menu.xml")], { encoding: "utf8" });
  if (!xmllint.error) assert.equal(xmllint.status, 0, xmllint.stderr);

  assert.match(rc, /<theme>\s*<name>Botkins<\/name>/);
  assert.match(rc, /<titleLayout>NLIMC<\/titleLayout>/);
  assert.match(rc, /<desktops>\s*<number>1<\/number>/);
  assert.match(rc, /<file>botkins-menu\.xml<\/file>/);
  // No surprises: nothing in the settings or the menu quits, restarts or reconfigures Openbox.
  for (const text of [rc, menu]) assert.doesNotMatch(text, /name="(Exit|Restart|Reconfigure|SessionLogout)"/);

  const theme = read(join(kit, "share/themes/Botkins/openbox-3/themerc"));
  const tokens = JSON.parse(read(join(repo, "mobile/design/botkins-kit/theme/tokens.json")));
  for (const color of [tokens.dark.canvas, tokens.dark.surface, tokens.dark.ink, tokens.dark.action, tokens.dark.border]) assert.ok(theme.includes(color), "the theme uses " + color);
  assert.match(theme, /^border\.width: 1$/m);
  const background = /hsetroot -solid '(#[0-9A-Fa-f]{6})'/.exec(read(join(kit, "botkins-desktop")));
  assert.equal(background?.[1], tokens.dark.canvas, "the background is the kit's dark canvas");
});

test("a tap opens the application menu, including a browser and minimized windows", () => {
  const menu = read(join(kit, "config/openbox/botkins-menu.xml"));
  const items = [...menu.matchAll(/<item label="([^"]+)">\s*<action name="Execute">\s*<command>([^<]+)<\/command>/g)].map(([, label, command]) => [label, command]);
  assert.deepEqual(items, [["Open Botkins", "botkins-desktop-open botkins"], ["Terminal", "botkins-desktop-open terminal"], ["Files", "botkins-desktop-open files"], ["Browser", "botkins-desktop-open browser"]]);
  assert.match(menu, /<menu id="client-list-combined-menu"/);
  const rc = read(join(kit, "config/openbox/botkins-rc.xml"));
  assert.match(rc.split('<context name="Root">')[1].split('</context>')[0], /button="Left"[^>]*>\s*<action name="ShowMenu">\s*<menu>root-menu/);
  assert.match(rc, /key="W-d">\s*<action name="ToggleShowDesktop"/);
  assert.match(rc, /key="W-space">\s*<action name="ShowMenu"><menu>root-menu/);
  assert.match(rc, /key="C-Escape">\s*<action name="ShowMenu"><menu>root-menu/);
  assert.match(rc, /key="C-A-d">\s*<action name="ToggleShowDesktop"/);
  const open = read(join(kit, "botkins-desktop-open"));
  for (const what of ["botkins", "terminal", "files", "browser"]) assert.match(open, new RegExp("^  " + what + "\\)", "m"));

  const programs = ["xterm", "mc", "xdotool"];
  const dockerApt = /apt-get install[^&]*/.exec(read(join(desktopDir, "Dockerfile")))[0].split(/\s+/);
  const azureApt = /apt install xvfb[^\n]*/.exec(read(join(repo, "deploy/azure/install.sh")))[0].split(/\s+/);
  for (const program of programs) {
    assert.match(open, new RegExp("\\b" + program + "\\b"), program);
    assert.ok(dockerApt.includes(program), "the Docker workspace installs " + program);
    assert.ok(azureApt.includes(program), "the Azure display installs " + program);
  }
  for (const tool of ["openbox", "hsetroot", "x11-utils"]) {
    assert.ok(dockerApt.includes(tool), "the Docker workspace installs " + tool);
    assert.ok(azureApt.includes(tool), "the Azure display installs " + tool);
  }
});

test("Linux terminal releases and the default Compose workspace ship the private desktop", () => {
  const pack = read(join(desktopDir, "scripts/package-terminal.mjs"));
  assert.match(pack, /"docker", "desktop"/);
  const image = read(join(desktopDir, "Dockerfile")).split(" AS terminal\n").at(-1);
  assert.match(image, /^COPY docker\/desktop .\/docker\/desktop$/m);
  for (const tool of ["xvfb", "xdotool", "ffmpeg", "openbox", "hsetroot", "xterm", "pcmanfm", "chromium"]) assert.ok(image.includes(tool), tool);
  assert.match(read(join(desktopDir, "install/install.sh")), /--screen\)/);
  assert.match(read(join(desktopDir, "install/install.sh")), /--no-screen\)/);
});

test("auto migrates the old Botkins virtual display and honors a personal display and Azure screen-off", async () => {
  const { wantsManagedDesktop } = await import("../desktop/terminal/desktop-policy.mjs");
  const files = new Map([["/tmp/.X20-lock", "  1459\n"], ["/proc/1459/comm", "Xvnc\n"], ["/proc/1459/cgroup", "0::/user.slice/user-1000.slice/user@1000.service/app.slice/bot-display.service\n"]]);
  const read = path => files.get(path) || "";
  const env = { DISPLAY: ":20", XAUTHORITY: "/home/sam/bot-desktop/Xauthority" };
  assert.equal(wantsManagedDesktop(env, false, read), true);
  assert.equal(wantsManagedDesktop({ ...env, BOTKINS_DESKTOP: "off" }, false, read), false);
  files.set("/proc/1459/cgroup", "0::/user.slice/user-1000.slice/session-1.scope\n");
  assert.equal(wantsManagedDesktop(env, false, read), false);
  assert.equal(wantsManagedDesktop({ WAYLAND_DISPLAY: "wayland-0" }, false, read), false);
  files.set("/etc/botkins-server/server.env", "MODE=terminal\n");
  assert.equal(wantsManagedDesktop({}, false, read), false);
  files.set("/etc/botkins-server/server.env", "MODE=screen\n");
  assert.equal(wantsManagedDesktop({ DISPLAY: ":20", XAUTHORITY: "/var/lib/botkins/display/Xauthority" }, false, read), true);
  assert.equal(wantsManagedDesktop(env, false, read), false);
});

test("auto leaves a supplied display alone and a missing private desktop never shares that display", { skip: process.platform !== "linux" }, async () => {
  const { startManagedDesktop } = await import("../desktop/terminal/managed-desktop.mjs");
  const env = { DISPLAY: ":65533", XAUTHORITY: "/home/sam/.Xauthority" };
  const options = { env, dirs: [], paths: {}, note: assert.fail };
  assert.equal(await startManagedDesktop(options), null);
  assert.deepEqual(env, { DISPLAY: ":65533", XAUTHORITY: "/home/sam/.Xauthority" });
  env.BOTKINS_DESKTOP = "managed";
  const notes = [];
  assert.equal(await startManagedDesktop({ ...options, note: text => notes.push(text) }), null);
  assert.match(notes.join(" "), /Xvfb/);
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.XAUTHORITY, undefined);
});

test("a managed session authenticates a new X display, renders the mark and switches real windows", { timeout: 20000 }, async (t) => {
  const programs = ["xvfb-run", "xauth", "openbox", "hsetroot", "xdotool", "xdpyinfo", "dbus-run-session", "import"];
  if (process.platform !== "linux" || programs.some(program => spawnSync("sh", ["-c", 'command -v "$1"', "sh", program]).status !== 0)) return t.skip("Requires the Linux X11 desktop tools");
  if (!["xterm", "lxterminal", "xfce4-terminal"].some(program => spawnSync("sh", ["-c", 'command -v "$1"', "sh", program]).status === 0)) return t.skip("Requires a terminal emulator");
  const { startManagedDesktop } = await import("../desktop/terminal/managed-desktop.mjs");
  const root = mkdtempSync(join(tmpdir(), "bk-x11-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, DISPLAY: ":65534", BOTKINS_DESKTOP: "managed" };
  const session = await startManagedDesktop({ env, paths: { root, socket: join(root, "botkins.sock") }, note: t.diagnostic.bind(t) });
  assert.ok(session, "a private display started");
  t.after(() => session.stop());
  assert.notEqual(env.DISPLAY, ":65534");
  assert.equal(statSync(env.XAUTHORITY).mode & 0o077, 0);
  const x = (command, args = []) => spawnSync(command, args, { env, encoding: "utf8", timeout: 1500 });
  assert.equal(x("xdpyinfo").status, 0);
  assert.notEqual(spawnSync("xdpyinfo", [], { env: { ...env, XAUTHORITY: join(root, "wrong-cookie") } }).status, 0, "a client without the cookie cannot connect");
  const [w, h] = x("xdotool", ["getdisplaygeometry"]).stdout.trim().split(/\s+/).map(Number);
  const frame = execFileSync("import", ["-silent", "-window", "root", "-depth", "8", "rgb:-"], { env, maxBuffer: w*h*3+200 });
  assert.equal(frame.subarray(0, 3).toString("hex"), "251e1a");
  const middle = frame.subarray((Math.floor(h/2)*w+Math.floor(w/2)-210)*3, (Math.floor(h/2)*w+Math.floor(w/2)+210)*3);
  assert.ok(new Set(middle).size > 10, "the centered mark is visible on the root window");
  const key = (...args) => assert.equal(x("xdotool", args).status, 0);
  key("mousemove", "15", "15", "click", "1", "key", "Home", "Down", "Return");
  const until = async (what, check) => {
    for (let i=0; i<60; i++) { const answer=check(); if (answer) return answer; await delay(80); }
    assert.fail(what);
  };
  const win = await until("tap → Terminal opened a real window", () => x("xdotool", ["search", "--onlyvisible", "--class", "(Botkins-Terminal|[Ll][Xx][Tt]erminal|[Xx]fce4-terminal)"]).stdout?.trim().split("\n")[0]);
  key("windowminimize", win);
  await until("the terminal was minimized", () => /Iconic/.test(x("xprop", ["-id", win, "WM_STATE"]).stdout));
  key("key", "alt+Tab");
  await until("the minimized terminal was restored", () => /Normal/.test(x("xprop", ["-id", win, "WM_STATE"]).stdout));
  key("key", "super+d");
  await until("returned to the desktop", () => /= 1/.test(x("xprop", ["-root", "_NET_SHOWING_DESKTOP"]).stdout));
  await session.stop();
  assert.notEqual(x("xdpyinfo").status, 0, "stopping the service closes its display");
});

test("the split workspace starts at its desktop, its Open Botkins menu restores the app, and an ordinary launch shows its window", async t => {
  const tools = ["Xvfb", "openbox", "xdotool", "xprop", "hsetroot"];
  if (process.platform !== "linux" || tools.some(name => spawnSync("sh", ["-c", 'command -v "$1"', "sh", name]).status !== 0)) return t.skip("Requires the X11 desktop tools");
  async function until(check, message) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (check()) return;
      await delay(50);
    }
    assert.fail(message);
  }
  const dir = mkdtempSync(join(tmpdir(), "bk-split-window-"));
  let app, wm;
  const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1024x768x24", "-noreset", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(server, "exit");
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const ended = once(child, "exit");
    process.kill(-child.pid, "SIGTERM");
    await ended;
  };
  t.after(async () => {
    await stop(app); await stop(wm);
    server.kill(); await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const [number] = await once(server.stdout, "data", { signal: AbortSignal.timeout(10_000) });
  const env = { ...process.env, HOME: dir, DISPLAY: ":" + String(number).trim(), XDG_SESSION_TYPE: "x11", XDG_RUNTIME_DIR: dir,
    XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), BOTKINS_DATA_DIR: join(dir, "managed"),
    BOTKINS_WORKSPACE_SOCKET: join(dir, "backend.sock"), BOTKINS_WORKSPACE_APP_DIR: desktopDir, ELECTRON_DISABLE_SANDBOX: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.XAUTHORITY;
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.WAYLAND_DISPLAY;
  const x = (file, args) => spawnSync(file, args, { env, timeout: 2000, encoding: "utf8" });
  const openWindows = () => (x("xprop", ["-root", "_NET_CLIENT_LIST"]).stdout?.match(/0x[0-9a-f]+/gi) ?? [])
    .filter(id => /Botkins/i.test(x("xprop", ["-id", id, "_NET_WM_NAME"]).stdout));
  const launch = (args, environment) => spawn(process.execPath, ["scripts/start.cjs", ...args], { env: environment, cwd: desktopDir, detached: true, stdio: "ignore" });
  wm = spawn(join(kit, "botkins-desktop"), [], { env: { ...env, BOTKINS_DESKTOP_MANAGED: "1" }, detached: true, stdio: "ignore" });
  await until(() => /0x[1-9a-f]/i.test(x("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"]).stdout), "Openbox did not start");

  app = launch(["--hidden"], env);
  await until(() => existsSync(join(env.BOTKINS_DATA_DIR, "run", "botkins.sock")), "the split Electron workspace did not finish starting");
  assert.deepEqual(openWindows(), [], "Botkins covered its idle desktop");
  x("xdotool", ["key", "super+space"]);
  await delay(150);
  x("xdotool", ["key", "Home", "Return"]);
  await until(() => openWindows().length === 1, "Open Botkins did not show the workspace window");
  const [first] = openWindows();
  x("xdotool", ["windowminimize", first]);
  await until(() => /Iconic/.test(x("xprop", ["-id", first, "WM_STATE"]).stdout), "could not minimize the workspace");
  x("xdotool", ["key", "super+space"]);
  await delay(150);
  x("xdotool", ["key", "Home", "Return"]);
  await until(() => /Normal/.test(x("xprop", ["-id", first, "WM_STATE"]).stdout), "Open Botkins did not restore the same window");

  await stop(app);
  await until(() => openWindows().length === 0, "the split workspace did not exit");
  const ordinary = { ...env, BOTKINS_DATA_DIR: join(dir, "ordinary") };
  delete ordinary.BOTKINS_WORKSPACE_SOCKET;
  delete ordinary.BOTKINS_WORKSPACE_APP_DIR;
  app = launch([], ordinary);
  await until(() => openWindows().length === 1, "an ordinary start did not show Botkins");
});

test("the Docker workspace and the Azure display, which Botkins starts, run the kit", () => {
  const dockerfile = read(join(desktopDir, "Dockerfile"));
  assert.match(dockerfile, /^COPY docker\/desktop \/usr\/local\/share\/botkins-desktop$/m);

  const entrypoint = read(join(desktopDir, "docker/workspace-entrypoint.sh"));
  const xvfb = entrypoint.indexOf("Xvfb \"$DISPLAY\"");
  const desktop = entrypoint.indexOf("BOTKINS_DESKTOP_MANAGED=1 /usr/local/share/botkins-desktop/botkins-desktop");
  assert.ok(xvfb > 0 && desktop > xvfb, "the workspace starts its own Xvfb, then the Botkins desktop on it");
  assert.match(entrypoint.slice(xvfb, desktop), /export BOTKINS_WORKSPACE_APP_DIR=/, "the workspace gives its menu the app to reopen");
  assert.match(entrypoint, /^node scripts\/start\.cjs --hidden\s/m, "the split workspace starts quietly behind its desktop");
  // It refuses a display that already answers, and brands only while its own Xvfb is alive.
  const taken = entrypoint.indexOf("if xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1; then");
  assert.ok(taken > 0 && taken < xvfb, "a display that already answers is refused before Xvfb starts");
  assert.match(entrypoint.slice(xvfb, desktop), /kill -0 "\$xvfb_pid"[\s\S]*xdpyinfo[\s\S]*kill -0 "\$xvfb_pid"/, "readiness and branding both need this Xvfb alive");
  assert.doesNotMatch(entrypoint, /^\s*openbox\b/m, "Openbox starts only through the kit");

  const display = read(join(repo, "deploy/azure/systemd/botkins-display.service"));
  const unit = read(join(repo, "deploy/azure/systemd/botkins-desktop.service"));
  const displayName = /ExecStart=\/usr\/bin\/Xvfb (:\d+)/.exec(display)[1];
  assert.match(unit, new RegExp("^Environment=DISPLAY=" + displayName + "$", "m"), "the desktop is on the display botkins-display starts");
  assert.match(unit, /^BindsTo=botkins-display\.service$/m);
  assert.match(unit, /^Environment=BOTKINS_DESKTOP_MANAGED=1$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/dbus-run-session -- \/usr\/local\/share\/botkins-desktop\/botkins-desktop$/m);

  const install = read(join(repo, "deploy/azure/install.sh"));
  assert.match(install, /cp -R "\$SRC\/desktop\/docker\/desktop" \/usr\/local\/share\/botkins-desktop/);
  assert.match(install, /install -m 0644 "\$SRC\/deploy\/azure\/systemd\/botkins-desktop\.service" \/etc\/systemd\/system\//);
  assert.match(install, /systemctl enable botkins-display\.service botkins-desktop\.service/);
  assert.match(install, /systemctl disable --now botkins-desktop\.service/);
  // The template carries install.sh. It is built again whenever install.sh changes.
  assert.ok(read(join(repo, "deploy/azure/azuredeploy.json")).includes("botkins-desktop.service"), "azuredeploy.json was rebuilt");
});

/** The text files of the desktop app and the deployments, without dependencies or build output. */
function sources() {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "desktop", "deploy", "docs"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
        if (["node_modules", "dist", "release", ".git"].includes(entry.name)) continue;
        const path = dir + "/" + entry.name;
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    for (const dir of ["desktop", "deploy", "docs"]) if (existsSync(join(repo, dir))) walk(dir);
  }
  return files.filter((file) => /(\.(sh|mjs|cjs|js|ts|service|conf|md|bicep)|Dockerfile|botkins-server|botkins-desktop(-open|-session)?)$/.test(file) && existsSync(join(repo, file)));
}

test("nothing else sets a background or starts a window manager, and only displays Botkins started run the kit", () => {
  const self = "desktop/test/branded-desktop.test.mjs";
  const setsDesktop = /^[^#\n]*\b((hsetroot|xsetroot)\s+-|feh\s+--bg|nitrogen\s|gsettings\s+set\s+org\.gnome\.desktop\.background|openbox(\s+--\S+)*\s*(&|>|$))/m;
  const runsKit = /^[^#\n]*(BOTKINS_DESKTOP_MANAGED=1|BOTKINS_DESKTOP_MANAGED: "1"|ExecStart=\/usr\/local\/share\/botkins-desktop\/botkins-desktop)/m;
  const changers = [];
  const runners = [];
  for (const file of sources()) {
    if (file === self || file.endsWith(".md") || file.endsWith("azuredeploy.json")) continue;
    const text = read(join(repo, file));
    if (setsDesktop.test(text)) changers.push(file);
    if (runsKit.test(text)) runners.push(file);
  }
  assert.deepEqual(changers.sort(), ["desktop/docker/desktop/botkins-desktop"]);
  assert.deepEqual(runners.sort(), ["deploy/azure/systemd/botkins-desktop.service", "desktop/desktop/terminal/managed-desktop.mjs", "desktop/docker/workspace-entrypoint.sh"]);
});

/** Runs botkins-desktop with stand-ins for the X tools, and returns what they were asked to do. */
function runDesktop({ managed, wmRunning = false }) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-desktop-test-"));
  try {
    const log = join(dir, "calls.log");
    const stub = (name, body) => {
      writeFileSync(join(dir, name), "#!/bin/sh\necho \"" + name + " $*\" >> '" + log + "'\n" + body + "\n");
      chmodSync(join(dir, name), 0o755);
    };
    stub("xdpyinfo", "exit 0");
    stub("xprop", wmRunning ? "case \"$1\" in -root) echo '_NET_SUPPORTING_WM_CHECK: window id # 0x400001' ;; esac; exit 0" : "exit 0");
    stub("hsetroot", "exit 0");
    stub("openbox", "exit 0");
    const env = { PATH: dir + ":/usr/bin:/bin", DISPLAY: ":42", HOME: dir };
    if (managed) env.BOTKINS_DESKTOP_MANAGED = "1";
    const run = spawnSync("sh", [join(kit, "botkins-desktop")], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    const calls = existsSync(log) ? read(log).trim().split("\n") : [];
    return { calls: calls.filter((line) => /^(hsetroot|openbox) /.test(line)), stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("botkins-desktop changes nothing on a display that is not Botkins' own", { skip: process.platform === "win32" }, () => {
  const unmanaged = runDesktop({ managed: false });
  assert.deepEqual(unmanaged.calls, []);
  assert.match(unmanaged.stderr, /not started by Botkins/);

  const taken = runDesktop({ managed: true, wmRunning: true });
  assert.deepEqual(taken.calls, [], "a running window manager keeps its display as it is");
  assert.match(taken.stderr, /already runs/);

  const own = runDesktop({ managed: true });
  assert.equal(own.calls.length, 2, own.stderr);
  assert.equal(own.calls[0], "hsetroot -solid #251E1A -center " + join(kit, "botkins-mark.png"));
  assert.equal(own.calls[1], "openbox --sm-disable --config-file " + join(kit, "config/openbox/botkins-rc.xml"));
});
