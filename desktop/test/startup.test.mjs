// Staying on: the two background choices and "Run at startup".
// Every test that writes passes its own temporary `home` folder, removed afterwards. Windows gets
// a stand-in for Electron's `app`, so nothing here can change what really starts with this computer.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HIDDEN_FLAG, LABEL, autostartEntry, backgroundField, launchAgent, loginItem, startedHidden } from "../desktop/startup.mjs";

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const EXE = "/Applications/Botkins.app/Contents/MacOS/Botkins";

// ---- startedHidden -------------------------------------------------------------------------

test("a start is hidden when --hidden is on the command line", () => {
  assert.equal(HIDDEN_FLAG, "--hidden");
  assert.equal(startedHidden(["/path/to/botkins", "--hidden"]), true);
  assert.equal(startedHidden(["/path/to/botkins"]), false);
  assert.equal(startedHidden([]), false);
});

// ---- backgroundField -----------------------------------------------------------------------

test("with nothing chosen the usual values are used: keep running on, run at startup off", () => {
  assert.deepEqual(backgroundField(undefined), { keepRunning: true, runAtStartup: false });
  assert.deepEqual(backgroundField(null), { keepRunning: true, runAtStartup: false });
  assert.deepEqual(backgroundField(undefined, undefined), { keepRunning: true, runAtStartup: false });
});

test("with nothing chosen the saved values stay as they are", () => {
  assert.deepEqual(backgroundField(undefined, { keepRunning: false, runAtStartup: true }), { keepRunning: false, runAtStartup: true });
});

test("changing one choice keeps the other", () => {
  const saved = { keepRunning: false, runAtStartup: true };
  assert.deepEqual(backgroundField({ keepRunning: true }, saved), { keepRunning: true, runAtStartup: true });
  assert.deepEqual(backgroundField({ runAtStartup: false }, saved), { keepRunning: false, runAtStartup: false });
  assert.deepEqual(backgroundField({ runAtStartup: true }), { keepRunning: true, runAtStartup: true });
});

test("both choices can be changed at once", () => {
  assert.deepEqual(backgroundField({ keepRunning: false, runAtStartup: true }), { keepRunning: false, runAtStartup: true });
});

test("an empty change leaves the saved values alone", () => {
  assert.deepEqual(backgroundField({}, { keepRunning: false, runAtStartup: true }), { keepRunning: false, runAtStartup: true });
});

test("anything but true or false is refused", () => {
  for (const bad of ["yes", 1, 0, [], true, false, [true], { keepRunning: "no" }, { keepRunning: 1 }, { runAtStartup: "true" }, { runAtStartup: null }, { keepRunning: {} }]) {
    assert.throws(() => backgroundField(bad), /Choose on or off/, JSON.stringify(bad));
  }
});

test("an unknown key is refused", () => {
  assert.throws(() => backgroundField({ nope: true }), /Unknown background setting/);
  assert.throws(() => backgroundField({ keepRunning: true, extra: false }), /Unknown background setting/);
});

test("a damaged saved value is made whole", () => {
  // Only a clear false switches keep-running off, and only a clear true switches run-at-startup on.
  assert.deepEqual(backgroundField(undefined, { keepRunning: "yes", runAtStartup: "yes" }), { keepRunning: true, runAtStartup: false });
  assert.deepEqual(backgroundField(undefined, { keepRunning: 0, runAtStartup: 1 }), { keepRunning: true, runAtStartup: false });
  assert.deepEqual(backgroundField(undefined, {}), { keepRunning: true, runAtStartup: false });
  assert.deepEqual(backgroundField(undefined, null), { keepRunning: true, runAtStartup: false });
  assert.deepEqual(backgroundField(undefined, "garbage"), { keepRunning: true, runAtStartup: false });
  // A change on top of a damaged value still lands.
  assert.deepEqual(backgroundField({ runAtStartup: true }, { keepRunning: "x" }), { keepRunning: true, runAtStartup: true });
});

// ---- launchAgent ---------------------------------------------------------------------------

test("the launch agent is a plist that starts the program with --hidden at sign-in", () => {
  const plist = launchAgent(EXE);
  assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'));
  assert.ok(plist.includes("<plist version=\"1.0\">"));
  assert.ok(plist.endsWith("</plist>\n"));
  assert.ok(plist.includes("<key>Label</key>\n  <string>" + LABEL + "</string>"));
  assert.equal(LABEL, "app.botkins.desktop.startup");
  // The program comes first in ProgramArguments and --hidden second.
  const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  assert.deepEqual([...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]), [EXE, "--hidden"]);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test("&, < and > in the program's path are escaped in the launch agent", () => {
  const plist = launchAgent("/Apps/A&B <beta>/Botkins");
  assert.ok(plist.includes("<string>/Apps/A&amp;B &lt;beta&gt;/Botkins</string>"));
  // Once only: the & of an escape is not escaped again.
  assert.ok(!plist.includes("&amp;amp;"));
  assert.ok(!plist.includes("&amp;lt;"));
  // The only angle brackets left are the plist's own tags.
  const inside = plist.match(/<string>\/Apps[^<]*<\/string>/)[0];
  assert.equal(inside, "<string>/Apps/A&amp;B &lt;beta&gt;/Botkins</string>");
});

// ---- autostartEntry ------------------------------------------------------------------------

test("the autostart entry is a desktop entry that starts the program with --hidden", () => {
  const entry = autostartEntry("/opt/Botkins/botkins");
  assert.deepEqual(entry.split("\n"), ["[Desktop Entry]", "Type=Application", "Name=Botkins", 'Exec="/opt/Botkins/botkins" --hidden', "Terminal=false", "X-GNOME-Autostart-enabled=true", ""]);
  assert.ok(autostartEntry("/x", "Other").includes("Name=Other"));
});

test("the Exec line quotes the path and escapes \", `, $ and backslash", () => {
  const exe = 'a"b`c$d\\e f';
  const line = autostartEntry(exe)
    .split("\n")
    .find((l) => l.startsWith("Exec="));
  assert.equal(line, 'Exec="a\\"b\\`c\\$d\\\\e f" --hidden');
});

// ---- loginItem: macOS ----------------------------------------------------------------------

test("on macOS the launch agent is written under the given home", (t) => {
  const dir = home(t);
  const item = loginItem({ platform: "darwin", exe: EXE, home: dir, env: {} });
  const expected = join(dir, "Library", "LaunchAgents", "app.botkins.desktop.startup.plist");
  assert.equal(item.file, expected);
  assert.equal(item.isOn(), false);
  item.set(true);
  assert.equal(readFileSync(expected, "utf8"), launchAgent(EXE));
  assert.equal(item.isOn(), true);
});

test("on macOS it reads as off when the file starts a different program, and set(true) corrects it", (t) => {
  const dir = home(t);
  const other = "/Volumes/Old/Botkins.app/Contents/MacOS/Botkins";
  loginItem({ platform: "darwin", exe: other, home: dir, env: {} }).set(true);
  const item = loginItem({ platform: "darwin", exe: EXE, home: dir, env: {} });
  assert.equal(item.isOn(), false);
  item.set(true);
  assert.equal(item.isOn(), true);
  assert.equal(readFileSync(item.file, "utf8"), launchAgent(EXE));
  assert.equal(loginItem({ platform: "darwin", exe: other, home: dir, env: {} }).isOn(), false);
});

test("on macOS set(false) removes the file", (t) => {
  const dir = home(t);
  const item = loginItem({ platform: "darwin", exe: EXE, home: dir, env: {} });
  item.set(true);
  assert.ok(existsSync(item.file));
  item.set(false);
  assert.equal(existsSync(item.file), false);
  assert.equal(item.isOn(), false);
});

test("on macOS set(false) with nothing there changes nothing", (t) => {
  const dir = home(t);
  loginItem({ platform: "darwin", exe: EXE, home: dir, env: {} }).set(false);
  assert.deepEqual(readdirSync(dir), []);
});

test("on macOS setting the same state twice writes nothing new", (t) => {
  const dir = home(t);
  const item = loginItem({ platform: "darwin", exe: EXE, home: dir, env: {} });
  item.set(true);
  // Make the file look old: a second write would bring the time back to now.
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(item.file, old, old);
  item.set(true);
  assert.equal(statSync(item.file).mtimeMs, old.getTime());
  item.set(false);
  item.set(false);
  assert.equal(existsSync(item.file), false);
});

// ---- loginItem: Linux ----------------------------------------------------------------------

test("on Linux the autostart entry is written under .config/autostart in the given home", (t) => {
  const dir = home(t);
  const item = loginItem({ platform: "linux", exe: "/opt/Botkins/botkins", home: dir, env: {} });
  assert.equal(item.file, join(dir, ".config", "autostart", "botkins.desktop"));
  assert.equal(item.isOn(), false);
  item.set(true);
  assert.equal(readFileSync(item.file, "utf8"), autostartEntry("/opt/Botkins/botkins"));
  assert.equal(item.isOn(), true);
  item.set(false);
  assert.equal(existsSync(item.file), false);
  assert.equal(item.isOn(), false);
});

test("on Linux a different program reads as off, and an XDG folder is not used with a home of our own", (t) => {
  const dir = home(t);
  // The environment names a config folder elsewhere; with a home that is not the real one it is ignored.
  const env = { XDG_CONFIG_HOME: join(dir, "elsewhere") };
  loginItem({ platform: "linux", exe: "/old/botkins", home: dir, env }).set(true);
  const item = loginItem({ platform: "linux", exe: "/new/botkins", home: dir, env });
  assert.equal(item.file, join(dir, ".config", "autostart", "botkins.desktop"));
  assert.equal(existsSync(join(dir, "elsewhere")), false);
  assert.equal(item.isOn(), false);
  item.set(true);
  assert.equal(item.isOn(), true);
});

// ---- loginItem: Windows --------------------------------------------------------------------

/** A stand-in for Electron's `app`: it remembers what it was last told and records every call. */
function electronApp(initial = null) {
  let registered = initial;
  const calls = [];
  return {
    calls,
    getLoginItemSettings(options) {
      calls.push(["get", options]);
      return { openAtLogin: registered !== null && registered === options.path };
    },
    setLoginItemSettings(options) {
      calls.push(["set", options]);
      registered = options.openAtLogin ? options.path : null;
    },
  };
}
const WIN_EXE = "C:\\Program Files\\Botkins\\Botkins.exe";

test("on Windows with Electron the login item is asked for with the path and --hidden", (t) => {
  const dir = home(t);
  const electron = electronApp();
  const item = loginItem({ platform: "win32", exe: WIN_EXE, home: dir, env: {}, electron });
  assert.equal(item.file, null);
  assert.equal(item.isOn(), false);
  assert.deepEqual(electron.calls, [["get", { path: WIN_EXE, args: ["--hidden"] }]]);
  electron.calls.length = 0;
  item.set(true);
  assert.deepEqual(electron.calls.at(-1), ["set", { openAtLogin: true, path: WIN_EXE, args: ["--hidden"] }]);
  assert.equal(item.isOn(), true);
  // Nothing was written to the home folder.
  assert.deepEqual(readdirSync(dir), []);
});

test("on Windows with Electron it only changes the login item when the state differs", (t) => {
  const dir = home(t);
  const electron = electronApp();
  const item = loginItem({ platform: "win32", exe: WIN_EXE, home: dir, env: {}, electron });
  const sets = () => electron.calls.filter(([what]) => what === "set");
  item.set(false);
  assert.equal(sets().length, 0, "already off");
  item.set(true);
  assert.equal(sets().length, 1);
  item.set(true);
  assert.equal(sets().length, 1, "already on");
  item.set(false);
  assert.equal(sets().length, 2);
  assert.deepEqual(sets()[1][1], { openAtLogin: false, path: WIN_EXE, args: ["--hidden"] });
  item.set(false);
  assert.equal(sets().length, 2, "already off again");
});

test("on Windows with Electron a login item for a different program reads as off and is corrected", (t) => {
  const dir = home(t);
  const electron = electronApp("C:\\Old\\Botkins.exe");
  const item = loginItem({ platform: "win32", exe: WIN_EXE, home: dir, env: {}, electron });
  assert.equal(item.isOn(), false);
  item.set(true);
  assert.equal(electron.calls.filter(([what]) => what === "set").length, 1);
  assert.equal(item.isOn(), true);
});

test("on Windows without Electron the choice is only written to startup.json under the home", (t) => {
  const dir = home(t);
  const item = loginItem({ platform: "win32", exe: WIN_EXE, home: dir, env: {} });
  assert.equal(item.file, join(dir, "startup.json"));
  assert.equal(item.isOn(), false);
  item.set(true);
  assert.deepEqual(JSON.parse(readFileSync(item.file, "utf8")), { path: WIN_EXE, args: ["--hidden"] });
  assert.deepEqual(readdirSync(dir), ["startup.json"]);
  assert.equal(item.isOn(), true);
  // A different program reads as off.
  assert.equal(loginItem({ platform: "win32", exe: "C:\\Other.exe", home: dir, env: {} }).isOn(), false);
  item.set(false);
  assert.equal(existsSync(item.file), false);
  assert.equal(item.isOn(), false);
});

test("setting the same state twice leaves the file as it was on every platform", (t) => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const dir = home(t);
    const item = loginItem({ platform, exe: EXE, home: dir, env: {} });
    item.set(true);
    const before = readFileSync(item.file, "utf8");
    // Put the folder's other contents beside it to be sure nothing else is touched.
    const marker = join(dirname(item.file), "marker.txt");
    mkdirSync(dirname(item.file), { recursive: true });
    writeFileSync(marker, "keep");
    item.set(true);
    assert.equal(readFileSync(item.file, "utf8"), before, platform);
    assert.equal(readFileSync(marker, "utf8"), "keep", platform);
  }
});
