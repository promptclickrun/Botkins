// The Botkins desktop (docker/desktop): the background, Openbox theme and menu of a display that
// Botkins starts itself. A managed display gets the brand; a display a person owns is never changed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const repo = join(desktopDir, "..");
const kit = join(desktopDir, "docker", "desktop");
const read = (path) => readFileSync(path, "utf8");

const FILES = [
  "botkins-desktop",
  "botkins-desktop-open",
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
  for (const script of ["botkins-desktop", "botkins-desktop-open"]) {
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

test("the menu lists Open Botkins, Terminal and Files, and only installed programs", () => {
  const menu = read(join(kit, "config/openbox/botkins-menu.xml"));
  const items = [...menu.matchAll(/<item label="([^"]+)">\s*<action name="Execute">\s*<command>([^<]+)<\/command>/g)].map(([, label, command]) => [label, command]);
  assert.deepEqual(items, [["Open Botkins", "botkins-desktop-open botkins"], ["Terminal", "botkins-desktop-open terminal"], ["Files", "botkins-desktop-open files"]]);
  const open = read(join(kit, "botkins-desktop-open"));
  for (const what of ["botkins", "terminal", "files"]) assert.match(open, new RegExp("^  " + what + "\\)", "m"));

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

test("the Docker workspace and the Azure display, which Botkins starts, run the kit", () => {
  const dockerfile = read(join(desktopDir, "Dockerfile"));
  assert.match(dockerfile, /^COPY docker\/desktop \/usr\/local\/share\/botkins-desktop$/m);

  const entrypoint = read(join(desktopDir, "docker/workspace-entrypoint.sh"));
  const xvfb = entrypoint.indexOf("Xvfb \"$DISPLAY\"");
  const desktop = entrypoint.indexOf("BOTKINS_DESKTOP_MANAGED=1 /usr/local/share/botkins-desktop/botkins-desktop");
  assert.ok(xvfb > 0 && desktop > xvfb, "the workspace starts its own Xvfb, then the Botkins desktop on it");
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
  assert.match(unit, /^ExecStart=\/usr\/local\/share\/botkins-desktop\/botkins-desktop$/m);

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
    files = execFileSync("git", ["ls-files", "desktop", "deploy", "docs"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
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
  return files.filter((file) => /(\.(sh|mjs|cjs|js|ts|service|conf|md|bicep)|Dockerfile|botkins-server|botkins-desktop(-open)?)$/.test(file) && existsSync(join(repo, file)));
}

test("nothing else sets a background or starts a window manager, and only displays Botkins started run the kit", () => {
  const self = "desktop/test/branded-desktop.test.mjs";
  const setsDesktop = /^[^#\n]*\b((hsetroot|xsetroot)\s+-|feh\s+--bg|nitrogen\s|gsettings\s+set\s+org\.gnome\.desktop\.background|openbox(\s+--\S+)*\s*(&|>|$))/m;
  const runsKit = /^[^#\n]*(BOTKINS_DESKTOP_MANAGED=1|ExecStart=\/usr\/local\/share\/botkins-desktop\/botkins-desktop)/m;
  const changers = [];
  const runners = [];
  for (const file of sources()) {
    if (file === self || file.endsWith(".md") || file.endsWith("azuredeploy.json")) continue;
    const text = read(join(repo, file));
    if (setsDesktop.test(text)) changers.push(file);
    if (runsKit.test(text)) runners.push(file);
  }
  assert.deepEqual(changers.sort(), ["desktop/docker/desktop/botkins-desktop"]);
  assert.deepEqual(runners.sort(), ["deploy/azure/systemd/botkins-desktop.service", "desktop/docker/workspace-entrypoint.sh"]);
  // The guide's display for a server without Docker (xvfb-run around `botkins serve`) is the
  // person's own setup: it does not run the kit.
  assert.doesNotMatch(read(join(desktopDir, "docs/terminal.md")), /botkins-desktop\b/);
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
