// Staying on, so a phone and the routines can count on this computer.
//
// Two choices in Settings › General (settings.background):
//   keepRunning   closing the window leaves Botkins running, with its icon in the menu bar (macOS)
//                 or the taskbar's notification area (Windows, Linux). On unless switched off.
//   runAtStartup  Botkins starts by itself when the person signs in to the computer, quietly: no
//                 window, only the icon. Off unless switched on.
//
// "Run at startup" is asked of the system in the system's own way, and each way starts this app's
// program with --hidden:
//   macOS    a launch agent, ~/Library/LaunchAgents/app.botkins.desktop.startup.plist
//   Windows  the app's entry among the sign-in apps (Electron's login item)
//   Linux    an autostart entry, ~/.config/autostart/botkins.desktop
// The entry names the program by its path, so main.mjs writes it again on every start while the
// setting is on: an app that was moved or updated keeps starting.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** On the command line of a start that should open no window. */
export const HIDDEN_FLAG = "--hidden";
export const startedHidden = (argv = process.argv) => argv.includes(HIDDEN_FLAG);

export const LABEL = "app.botkins.desktop.startup";
const USUAL = { keepRunning: true, runAtStartup: false };

/** The two choices made whole. `value` changes the ones it names; anything but true or false is refused. */
export function backgroundField(value, current = USUAL) {
  const base = { keepRunning: current?.keepRunning !== false, runAtStartup: current?.runAtStartup === true };
  if (value == null) return base;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose on or off");
  for (const key of Object.keys(value)) if (!Object.hasOwn(USUAL, key)) throw new Error("Unknown background setting");
  for (const key of Object.keys(USUAL)) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error("Choose on or off");
  return { keepRunning: value.keepRunning ?? base.keepRunning, runAtStartup: value.runAtStartup ?? base.runAtStartup };
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The macOS launch agent that starts `exe` quietly at sign-in. */
export const launchAgent = (exe) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>" + LABEL + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>" + xml(exe) + "</string>",
    "    <string>" + HIDDEN_FLAG + "</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>LimitLoadToSessionType</key>",
    "  <string>Aqua</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

/** The Linux autostart entry. A path is quoted the way desktop entries want it. */
export const autostartEntry = (exe, name = "Botkins") =>
  ["[Desktop Entry]", "Type=Application", "Name=" + name, 'Exec="' + String(exe).replace(/(["`$\\])/g, "\\$1") + '" ' + HIDDEN_FLAG, "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n");

/**
 * "Run at startup" on this system.
 * @param options.exe       The program to start (the app's own; on Linux an AppImage's own file).
 * @param options.home      The person's home folder. Tests and trial runs pass a folder of their own.
 * @param options.electron  Electron's `app`, for Windows' sign-in apps. Without it (a trial run) the
 *                          choice is only written to a file under `home`, and nothing is registered.
 * @returns { set(on), isOn(), file }: `file` is where the entry is written, if it is a file.
 */
export function loginItem({ platform = process.platform, exe = process.env.APPIMAGE || process.execPath, home = homedir(), env = process.env, electron } = {}) {
  const file =
    platform === "darwin"
      ? join(home, "Library", "LaunchAgents", LABEL + ".plist")
      : platform === "win32"
        ? electron
          ? null
          : join(home, "startup.json")
        : join(env.XDG_CONFIG_HOME && home === homedir() ? env.XDG_CONFIG_HOME : join(home, ".config"), "autostart", "botkins.desktop");
  const body = platform === "darwin" ? launchAgent(exe) : platform === "win32" ? JSON.stringify({ path: exe, args: [HIDDEN_FLAG] }) : autostartEntry(exe);
  const written = () => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  return {
    file,
    /** True when the system has the entry and it starts this very program. */
    isOn() {
      if (!file) return electron.getLoginItemSettings({ path: exe, args: [HIDDEN_FLAG] }).openAtLogin === true;
      return written() === body;
    },
    /** Adds, corrects or removes the entry. Does nothing when it is already as asked. */
    set(on) {
      if (!file) {
        if (this.isOn() !== !!on) electron.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: [HIDDEN_FLAG] });
        return;
      }
      if (!on) {
        if (existsSync(file)) rmSync(file, { force: true });
        return;
      }
      if (written() === body) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body, { mode: 0o644 });
    },
  };
}
