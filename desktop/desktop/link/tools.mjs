// Running the computer's own command-line tools (password managers, the GitHub CLI, screen
// capture) safely: never through a shell, with a time limit, an output cap and a small
// environment. A tool's output is data. When it fails, only a short reason leaves this file.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const WINDOWS = process.platform === "win32";
export const TOOL_TIMEOUT = 30_000;
export const TOOL_OUTPUT = 4 * 1024 * 1024;

/** A failure with a message that is safe to show: it never holds anything the tool printed. */
export class Failure extends Error {}
export class ToolError extends Failure {
  /** `kind`: missing, timeout, output, exit or busy (too many tools already running). `detail` is the tool's own error text, kept only when asked for, for sorting failures. */
  constructor(label, kind, detail = "") {
    const text = { missing: " isn't installed.", timeout: " took too long to answer.", output: " sent back too much.", exit: " reported an error." };
    super(kind === "busy" ? "Your computer is busy. Try again." : label + text[kind]);
    this.kind = kind;
    this.detail = detail;
  }
}

/** Folders a command-line tool may live in, in the order they are tried. A test passes its own list. */
export function searchDirs(override) {
  if (Array.isArray(override)) return override;
  const home = homedir();
  const env = process.env;
  const known = WINDOWS
    ? [
        join(env.ProgramFiles ?? "C:\\Program Files", "1Password CLI"),
        join(env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI"),
        join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Microsoft", "WinGet", "Links"),
        join(env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin"),
        join(home, "scoop", "shims"),
        join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
      ]
    : ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), "/usr/bin", "/bin"];
  return [...new Set([...String(env.PATH ?? "").split(delimiter).filter(Boolean), ...known])];
}

/** The full path of a command-line tool, or null. On Windows only real programs (.exe, .com) count. */
export function findTool(name, dirs, platform = process.platform) {
  const names = platform === "win32" ? [name + ".exe", name + ".com"] : [name];
  for (const dir of dirs) {
    for (const file of names) {
      const path = join(dir, file);
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  return null;
}

/**
 * A Windows script shim (.cmd or .bat) for a tool, or null. It is only used to say so: running one
 * needs cmd.exe, and quoting arguments for cmd.exe can't be made safe, so such a tool isn't run.
 */
export function findShim(name, dirs, platform = process.platform) {
  if (platform !== "win32") return null;
  for (const dir of dirs) for (const ext of [".cmd", ".bat"]) if (existsSync(join(dir, name + ext))) return join(dir, name + ext);
  return null;
}

/**
 * What a tool is started with: PATH, HOME, and only the variables its caller names. Nothing else
 * from this app's environment (which may hold tokens) is passed on.
 */
export function toolEnv(dirs, extra = {}) {
  const system = WINDOWS ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  const env = { PATH: [...new Set([...dirs, ...system])].join(delimiter), HOME: process.env.HOME ?? homedir() };
  if (WINDOWS) for (const name of ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ...extra };
}

/** Variables of this app's environment that start with one of the prefixes: a tool's own settings and session. */
export function inherit(prefixes) {
  const found = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && prefixes.some((prefix) => name.startsWith(prefix))) found[name] = value;
  return found;
}

/** Lets a few things run at once and a few more wait; anything beyond that is turned away. */
export class Gate {
  constructor(running = 4, queued = 32) {
    Object.assign(this, { limit: running, room: queued, active: 0, waiting: [] });
  }
  async run(label, task) {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.room) throw new ToolError(label, "busy");
      // The slot is handed over directly, so a waiting task keeps its place.
      await new Promise((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
/** Every command-line tool this code starts goes through this: 4 at a time, 32 waiting, then "busy". */
export const toolGate = new Gate(4, 32);

/**
 * Runs a tool and resolves with what it printed. `label` names it in an error ("1Password took too
 * long to answer."). Rejects with a ToolError.
 */
export function runTool(label, file, args, options = {}) {
  if (!file) return Promise.reject(new ToolError(label, "missing"));
  return toolGate.run(label, () => start(label, file, args, options));
}

function start(label, file, args, { env, cwd, timeout = TOOL_TIMEOUT, cap = TOOL_OUTPUT, keepError = false }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(file, args, { env, cwd, timeout, killSignal: "SIGKILL", maxBuffer: cap, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const kind = error.code === "ENOENT" ? "missing" : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output" : error.killed ? "timeout" : "exit";
        reject(new ToolError(label, kind, keepError ? String(stderr ?? "").slice(0, 2000) : ""));
      });
    } catch {
      return reject(new ToolError(label, "missing"));
    }
    // A tool that waits for typed input gets none.
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
}

/** JSON from a tool, or a Failure that says so. */
export function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure(label + " sent back something unexpected.");
  }
}
