// Moving the pointer, clicking and typing on this computer, for a phone that is allowed to control
// the screen. Two parts:
//   cleanEvents()   checks and tidies what a phone sent. Nothing else in this file sees raw input.
//   injectors       post the tidied events: macOS (osascript), Windows (PowerShell), Linux (xdotool).
// Each injector runs a FIXED script. The events travel to it as data (one JSON argument), and no
// phone text is ever put into a script or a command line that a shell reads.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failure, findTool, runTool, toolEnv } from "./tools.mjs";

export const MAX_EVENTS = 64;
/** What 64 actions may grow to once text is split at new lines and tabs. */
export const MAX_EXPANDED = 256;
export const MAX_TEXT = 2000;
export const KEYS = ["enter", "tab", "escape", "backspace", "delete", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"];
export const MODIFIERS = ["cmd", "ctrl", "alt", "shift"];
const POINTER = ["move", "down", "up", "click", "doubleClick", "rightClick"];
const SCROLL_MAX = 1000;
export const NEED_ACCESSIBILITY = "Allow accessibility for this app in System Settings › Privacy & Security.";

const bad = () => new Failure("That screen action isn't valid.");
const fraction = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
  return Math.min(1, Math.max(0, value));
};
const distance = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
  return Math.round(Math.min(SCROLL_MAX, Math.max(-SCROLL_MAX, value)));
};
/** A key as the injectors take it: a name from KEYS, or one printable character. */
function cleanKey(key) {
  if (typeof key !== "string") throw bad();
  if (KEYS.includes(key.toLowerCase())) return key.toLowerCase();
  const chars = Array.from(key);
  const code = chars.length === 1 ? chars[0].codePointAt(0) : 0;
  if (code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f) || !code) throw bad();
  return key;
}

/**
 * Checks what a phone sent and returns the events to post. Numbers are held to their range, a key
 * must be from the list, and anything else is refused whole, so a call either runs fully or not at
 * all. Text with a new line becomes text, Enter, text. `pressed` says whether a button is held from
 * an earlier call, so a move while it is down is a drag.
 */
export function cleanEvents(events, pressed = false) {
  if (!Array.isArray(events)) throw bad();
  if (events.length > MAX_EVENTS) throw new Failure("Send up to " + MAX_EVENTS + " screen actions at a time.");
  const out = [];
  for (const event of events) {
    if (!event || typeof event !== "object") throw bad();
    const { type } = event;
    if (POINTER.includes(type)) {
      const at = { x: fraction(event.x), y: fraction(event.y) };
      if (type === "move") out.push({ type, ...at, ...(pressed && { drag: true }) });
      else out.push({ type, ...at });
      if (type === "down") pressed = true;
      else if (type !== "move") pressed = false;
    } else if (type === "scroll") {
      out.push({ type, x: fraction(event.x), y: fraction(event.y), dx: distance(event.dx), dy: distance(event.dy) });
    } else if (type === "text") {
      if (typeof event.text !== "string" || event.text.length > MAX_TEXT) throw new Failure("Type up to " + MAX_TEXT.toLocaleString("en-US") + " characters at a time.");
      const lines = event.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").split("\n");
      lines.forEach((line, index) => {
        if (index) out.push({ type: "key", key: "enter" });
        // A tab inside a line is its own key too.
        line.split("\t").forEach((piece, at) => {
          if (at) out.push({ type: "key", key: "tab" });
          if (piece) out.push({ type: "text", text: piece });
        });
      });
    } else if (type === "key") {
      const modifiers = event.modifiers === undefined ? [] : event.modifiers;
      if (!Array.isArray(modifiers) || modifiers.length > MODIFIERS.length || modifiers.some((m) => !MODIFIERS.includes(m))) throw bad();
      out.push({ type, key: cleanKey(event.key), ...(modifiers.length && { modifiers: [...new Set(modifiers)] }) });
    } else throw bad();
  }
  return { events: out, pressed };
}

// ── macOS ─────────────────────────────────────────────────────────────────────────────────────
// A JavaScript for Automation script that posts CGEvents through the Objective-C bridge. It reads
// one JSON argument: { action: "info" } or { action: "input", display, events }. Positions are
// fractions of the display, turned into the display's own global points here. Text goes in chunks
// of 20 or fewer UTF-16 characters, with the string handed over as UTF-16 bytes (the plain bridge
// drops it). Scrolling uses the fixed-argument CGEventCreateScrollWheelEvent2.

export const MAC_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);

var FLAG = { cmd: 0x100000, ctrl: 0x40000, alt: 0x80000, shift: 0x20000 };
var NAMED = { enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, "delete": 117, home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126 };
var CODE = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30,
  o: 31, u: 32, "[": 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, ",": 43, "/": 44, n: 45, m: 46, ".": 47, "\`": 50 };
CODE[String.fromCharCode(92)] = 42;

function frameOf(index) {
  var screens = $.NSScreen.screens;
  var count = Number(screens.count);
  var n = Math.min(Math.max(Math.floor(Number(index)) || 1, 1), count) - 1;
  // Cocoa measures up from the bottom of the main display; events are placed down from its top.
  var top = screens.objectAtIndex(0).frame.size.height;
  var f = screens.objectAtIndex(n).frame;
  return { x: f.origin.x, y: top - f.origin.y - f.size.height, w: f.size.width, h: f.size.height };
}
function at(f, e) {
  return { x: f.x + Math.min(e.x * f.w, f.w - 1), y: f.y + Math.min(e.y * f.h, f.h - 1) };
}
function post(ev) { $.CGEventPost($.kCGHIDEventTap, ev); }
function pause(seconds) { $.NSThread.sleepForTimeInterval(seconds); }
function mouse(type, p, button, clicks) {
  var ev = $.CGEventCreateMouseEvent(null, type, p, button);
  if (clicks) $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clicks);
  post(ev);
}
function keyEvent(code, flags, down) {
  var ev = $.CGEventCreateKeyboardEvent(null, code, down);
  if (flags) $.CGEventSetFlags(ev, flags);
  post(ev);
}
function tap(code, flags) { keyEvent(code, flags, true); pause(0.004); keyEvent(code, flags, false); pause(0.004); }
function sendChunk(chunk) {
  var data = $.NSString.stringWithString(chunk).dataUsingEncoding(0x94000100);
  [true, false].forEach(function (down) {
    var ev = $.CGEventCreateKeyboardEvent(null, 0, down);
    $.CGEventKeyboardSetUnicodeString(ev, chunk.length, data.bytes);
    post(ev);
  });
  pause(0.004);
}
function typeText(text) {
  var chunk = "";
  Array.from(text).forEach(function (ch) {
    if (chunk.length + ch.length > 20) { sendChunk(chunk); chunk = ""; }
    chunk += ch;
  });
  if (chunk) sendChunk(chunk);
}
function click(f, e, down, up, button, count) {
  var p = at(f, e);
  mouse($.kCGEventMouseMoved, p, button);
  for (var i = 1; i <= count; i++) { mouse(down, p, button, i); pause(0.01); mouse(up, p, button, i); pause(0.01); }
}
function act(e, f) {
  var L = $.kCGMouseButtonLeft;
  if (e.type === "move") mouse(e.drag ? $.kCGEventLeftMouseDragged : $.kCGEventMouseMoved, at(f, e), L);
  else if (e.type === "down") { var d = at(f, e); mouse($.kCGEventMouseMoved, d, L); mouse($.kCGEventLeftMouseDown, d, L, 1); }
  else if (e.type === "up") mouse($.kCGEventLeftMouseUp, at(f, e), L, 1);
  else if (e.type === "click") click(f, e, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, L, 1);
  else if (e.type === "doubleClick") click(f, e, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, L, 2);
  else if (e.type === "rightClick") click(f, e, $.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight, 1);
  else if (e.type === "scroll") {
    mouse($.kCGEventMouseMoved, at(f, e), L);
    // Positive means right and down, like the web's wheel; the system counts the other way.
    post($.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitPixel, 2, -e.dy, -e.dx, 0));
  } else if (e.type === "text") typeText(e.text);
  else if (e.type === "key") {
    var flags = 0;
    (e.modifiers || []).forEach(function (m) { flags |= FLAG[m]; });
    var code = NAMED[e.key];
    if (code === undefined) {
      var lower = e.key.toLowerCase();
      code = CODE[lower];
      if (code !== undefined && lower !== e.key) flags |= FLAG.shift;
    }
    if (code === undefined) typeText(e.key); else tap(code, flags);
  }
}
function run(argv) {
  var job = JSON.parse(argv[0]);
  var trusted = $.AXIsProcessTrusted();
  if (job.action === "info") {
    var main = frameOf(1);
    return JSON.stringify({ accessibility: !!trusted, width: main.w, height: main.h });
  }
  if (!trusted) return JSON.stringify({ error: "accessibility" });
  var f = frameOf(job.display);
  for (var i = 0; i < job.events.length; i++) act(job.events[i], f);
  return JSON.stringify({ ok: true });
}
`;

/** Runs the macOS script. `job` is { action: "info" } or { action: "input", display, events }. */
export async function macScript(job, dirs) {
  const out = await runTool("Mouse and keyboard control", "/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT, JSON.stringify(job)], { env: toolEnv(dirs), timeout: 20_000 });
  try {
    return JSON.parse(out.trim());
  } catch {
    throw new Failure("Mouse and keyboard control sent back something unexpected.");
  }
}

function macInjector(dirs) {
  return async ({ display, events }) => {
    const answer = await macScript({ action: "input", display: /^\d{1,2}$/.test(display.id) ? Number(display.id) : 1, events }, dirs);
    if (answer.error === "accessibility") throw new Failure(NEED_ACCESSIBILITY);
    if (!answer.ok) throw new Failure("Mouse and keyboard control didn't work.");
  };
}

// ── Windows ───────────────────────────────────────────────────────────────────────────────────
// A PowerShell script with user32 (SetCursorPos, mouse_event, keybd_event, SendInput). It is saved
// to a private temporary folder and started with -File, and the events are its one argument, as
// base64 of JSON, so nothing of them is read as code. "cmd" counts as Ctrl here.

export const WIN_TYPES = `
using System;
using System.Runtime.InteropServices;
public static class BotkinsInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Unicode(char ch) {
    INPUT[] inputs = new INPUT[2];
    for (int i = 0; i < 2; i++) {
      inputs[i].type = 1;
      inputs[i].u.ki.wScan = ch;
      inputs[i].u.ki.dwFlags = (uint)(0x0004 | (i == 1 ? 0x0002 : 0));
    }
    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
`;

export const WIN_SCRIPT = `param([string]$Job)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${WIN_TYPES}
'@
[void][BotkinsInput]::SetProcessDPIAware()
$job = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Job)) | ConvertFrom-Json
$screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object @{ Expression = { -not $_.Primary } }, @{ Expression = { $_.Bounds.X } })
$index = [Math]::Min([Math]::Max([int]$job.display, 1), $screens.Count) - 1
$b = $screens[$index].Bounds
$named = @{ enter = 0x0D; tab = 0x09; escape = 0x1B; backspace = 0x08; delete = 0x2E; space = 0x20; left = 0x25; up = 0x26; right = 0x27; down = 0x28; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22 }
$mods = @{ cmd = 0x11; ctrl = 0x11; alt = 0x12; shift = 0x10 }
function MoveTo($e) {
  [void][BotkinsInput]::SetCursorPos([int]($b.X + [Math]::Min($e.x * $b.Width, $b.Width - 1)), [int]($b.Y + [Math]::Min($e.y * $b.Height, $b.Height - 1)))
}
function Button($down, $up, $count) {
  for ($i = 0; $i -lt $count; $i++) { [BotkinsInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [BotkinsInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 20 }
}
function Tap($vk, $held) {
  foreach ($m in $held) { [BotkinsInput]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero) }
  [BotkinsInput]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  [BotkinsInput]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  foreach ($m in $held) { [BotkinsInput]::keybd_event([byte]$m, 0, 2, [UIntPtr]::Zero) }
}
foreach ($e in $job.events) {
  switch ($e.type) {
    "move" { MoveTo $e }
    "down" { MoveTo $e; [BotkinsInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
    "up" { MoveTo $e; [BotkinsInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
    "click" { MoveTo $e; Button 0x0002 0x0004 1 }
    # The phone sends a click first, so one more press here makes the pair Windows reads as a double click.
    "doubleClick" { MoveTo $e; Button 0x0002 0x0004 1 }
    "rightClick" { MoveTo $e; Button 0x0008 0x0010 1 }
    "scroll" {
      MoveTo $e
      if ($e.dy -ne 0) { [BotkinsInput]::mouse_event(0x0800, 0, 0, [int](-2 * $e.dy), [UIntPtr]::Zero) }
      if ($e.dx -ne 0) { [BotkinsInput]::mouse_event(0x1000, 0, 0, [int](2 * $e.dx), [UIntPtr]::Zero) }
    }
    "text" { foreach ($ch in $e.text.ToCharArray()) { [BotkinsInput]::Unicode($ch); Start-Sleep -Milliseconds 2 } }
    "key" {
      $held = @()
      foreach ($m in @($e.modifiers)) { if ($m) { $held += $mods[[string]$m] } }
      $held = @($held | Select-Object -Unique)
      if ($named.ContainsKey([string]$e.key)) { Tap $named[[string]$e.key] $held }
      else {
        $first = ([string]$e.key)[0]
        $scan = [BotkinsInput]::VkKeyScan($first)
        if ($scan -eq -1) { foreach ($ch in ([string]$e.key).ToCharArray()) { [BotkinsInput]::Unicode($ch) } }
        else {
          if (($scan -band 0x100) -ne 0 -and $held -notcontains 0x10) { $held += 0x10 }
          Tap ($scan -band 0xFF) $held
        }
      }
    }
  }
}
Write-Output "ok"
`;

function windowsInjector(dirs) {
  return async ({ display, events }) => {
    const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const folder = mkdtempSync(join(tmpdir(), "botkins-input-"));
    try {
      const file = join(folder, "input.ps1");
      writeFileSync(file, WIN_SCRIPT, { mode: 0o600 });
      const job = Buffer.from(JSON.stringify({ display: /^\d{1,2}$/.test(display.id) ? Number(display.id) : 1, events }), "utf8").toString("base64");
      const out = await runTool("Mouse and keyboard control", shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, job], { env: toolEnv(dirs), timeout: 20_000 });
      if (!/ok/.test(out)) throw new Failure("Mouse and keyboard control didn't work.");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
}

// ── Linux ─────────────────────────────────────────────────────────────────────────────────────

const XKEYS = { enter: "Return", tab: "Tab", escape: "Escape", backspace: "BackSpace", delete: "Delete", space: "space", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "Prior", pagedown: "Next" };
const XPUNCT = { ".": "period", ",": "comma", "-": "minus", "=": "equal", "/": "slash", ";": "semicolon", "'": "apostrophe", "`": "grave", "[": "bracketleft", "]": "bracketright", "\\": "backslash" };
const XMODS = { cmd: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift" };

/** The xdotool commands (argument lists) for tidied events on a screen of `width` by `height` pixels. */
export function xdotoolCommands(events, { width, height }) {
  const px = (e) => [String(Math.round(e.x * (width - 1))), String(Math.round(e.y * (height - 1)))];
  const commands = [];
  for (const e of events) {
    if (e.type === "move") commands.push(["mousemove", ...px(e)]);
    else if (e.type === "down") commands.push(["mousemove", ...px(e), "mousedown", "1"]);
    else if (e.type === "up") commands.push(["mousemove", ...px(e), "mouseup", "1"]);
    else if (e.type === "click") commands.push(["mousemove", ...px(e), "click", "1"]);
    // The phone sends a click first, so one more press here makes the pair the desktop reads as a double click.
    else if (e.type === "doubleClick") commands.push(["mousemove", ...px(e), "click", "1"]);
    else if (e.type === "rightClick") commands.push(["mousemove", ...px(e), "click", "3"]);
    else if (e.type === "scroll") {
      commands.push(["mousemove", ...px(e)]);
      // One wheel click is about 40 pixels. Buttons 4 to 7 are up, down, left and right.
      for (const [amount, back, forward] of [[e.dy, "4", "5"], [e.dx, "6", "7"]]) if (amount) commands.push(["click", "--repeat", String(Math.min(20, Math.ceil(Math.abs(amount) / 40))), amount < 0 ? back : forward]);
    } else if (e.type === "text") commands.push(["type", "--delay", "0", "--clearmodifiers", "--", e.text]);
    else if (e.type === "key") {
      const name = XKEYS[e.key] ?? (/^[a-z0-9]$/i.test(e.key) ? e.key : XPUNCT[e.key]);
      if (!name) commands.push(["type", "--delay", "0", "--clearmodifiers", "--", e.key]);
      else commands.push(["key", "--clearmodifiers", [...new Set((e.modifiers ?? []).map((m) => XMODS[m])), name].join("+")]);
    }
  }
  return commands;
}

function linuxInjector(dirs) {
  return async ({ events }) => {
    const xdotool = findTool("xdotool", dirs);
    const env = toolEnv(dirs, Object.fromEntries(["DISPLAY", "XAUTHORITY"].filter((name) => process.env[name]).map((name) => [name, process.env[name]])));
    const [width, height] = String(await runTool("xdotool", xdotool, ["getdisplaygeometry"], { env, timeout: 5000 })).trim().split(/\s+/).map(Number);
    if (!(width > 0 && height > 0)) throw new Failure("xdotool didn't give the screen's size.");
    for (const args of xdotoolCommands(events, { width, height })) await runTool("xdotool", xdotool, args, { env, timeout: 10_000 });
  };
}

/**
 * What can post input here: { inject, problem }. `problem` is one line for a person when nothing can
 * (an adapter or a test may still bring its own injector).
 */
export function injectorFor(platform, dirs) {
  if (platform === "darwin") return { inject: macInjector(dirs) };
  if (platform === "win32") return { inject: windowsInjector(dirs) };
  if (platform === "linux") {
    if (process.env.XDG_SESSION_TYPE === "wayland") return { problem: "Controlling the screen needs an X11 session. It doesn't work on Wayland yet." };
    if (!findTool("xdotool", dirs)) return { problem: "Install xdotool on your computer to control its screen." };
    return { inject: linuxInjector(dirs) };
  }
  return { problem: "Controlling the screen isn't available on this system yet." };
}
