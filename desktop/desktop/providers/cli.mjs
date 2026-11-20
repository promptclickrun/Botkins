// Finding and running the command-line tools some model providers are built on (Codex, Claude
// Code, OpenCode and the ACP agents), and talking to one over its standard input and output.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const windows = process.platform === "win32";

/** Where command-line tools are usually installed, for an app that was not started from a shell. */
function usualFolders(home = homedir()) {
  const folders = windows
    ? [
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
        join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs"),
        join(home, ".local", "bin"),
        join(home, ".bun", "bin"),
        join(home, ".opencode", "bin"),
      ]
    : [
        join(home, ".local", "bin"),
        join(home, "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        join(home, ".npm-global", "bin"),
        join(home, ".bun", "bin"),
        join(home, ".cargo", "bin"),
        join(home, ".volta", "bin"),
        join(home, ".opencode", "bin"),
        join(home, ".claude", "local"),
        join(home, "Library", "pnpm"),
        join(home, ".local", "share", "pnpm"),
      ];
  return folders;
}

let shellPath;
/**
 * The PATH of the person's login shell. An app opened from the Dock or Finder starts with a
 * short system PATH, so tools installed with a version manager are only found this way.
 */
function loginShellPath() {
  shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL;
    if (windows || !shell || !isAbsolute(shell)) return resolve("");
    const mark = "__BOTKINS_PATH__";
    execFile(
      shell,
      ["-ilc", 'printf "%s%s%s" "' + mark + '" "$PATH" "' + mark + '"'],
      { timeout: 4000, encoding: "utf8", env: { ...process.env, TERM: "dumb" } },
      (_error, stdout) => resolve(String(stdout ?? "").split(mark)[1] ?? ""),
    );
  });
  return shellPath;
}

/** The folders to look in for a tool: the app's own PATH, the login shell's, then the usual places. */
export async function searchPath(env = process.env) {
  const parts = [env.PATH ?? env.Path ?? "", await loginShellPath(), ...usualFolders()];
  return [...new Set(parts.flatMap((p) => p.split(delimiter)).filter(Boolean))].join(delimiter);
}

function runnable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    if (!windows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full path of a command-line tool, or null when it isn't installed. `override` is a path
 * the person set; it wins when it points at a file that can run.
 */
export async function findBinary(name, { override, env } = {}) {
  if (override) return runnable(override) ? override : null;
  const names = windows ? [name + ".exe", name + ".cmd", name + ".bat", name] : [name];
  for (const folder of (await searchPath(env)).split(delimiter))
    for (const n of names) {
      const file = join(folder, n);
      if (runnable(file)) return file;
    }
  return null;
}

/** The environment a tool runs in: the app's own, with the full search path, minus what would confuse a child. */
export async function cliEnv(extra = {}, base = process.env) {
  const env = { ...base, PATH: await searchPath(base), ...extra };
  // An Electron app started by the child would otherwise run as plain Node and exit.
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

/** Runs a tool to the end. Resolves { code, stdout, stderr }; rejects when it can't start or runs too long. */
export function run(file, args = [], { timeoutMs = 20000, env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: windows && /\.(cmd|bat)$/i.test(file) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(file + " took too long to answer."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-2_000_000)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-200_000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** "1.2.3" out of a version line such as "codex-cli 1.2.3" or "2.1.325 (Claude Code)". */
export function versionOf(text) {
  return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(String(text ?? ""))?.[0] ?? "";
}

/**
 * A JSON-RPC peer on a child process's standard input and output, one message per line. Both
 * sides send requests: `request` asks the child, `onRequest` answers what the child asks.
 */
export class StdioRpc {
  /**
   * @param options.jsonrpc  Add `"jsonrpc": "2.0"` to each message (ACP wants it; Codex's app-server leaves it out).
   * @param options.onStderr Called with each chunk the child writes to its error output.
   */
  constructor(file, args, { env, cwd, jsonrpc = false, onStderr } = {}) {
    this.jsonrpc = jsonrpc;
    this.next = 1;
    this.pending = new Map();
    this.notifications = new Set();
    this.requests = null;
    this.stderr = "";
    this.child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: windows && /\.(cmd|bat)$/i.test(file) });
    this.exited = new Promise((resolve) => {
      const done = (error) => {
        if (this.closed) return;
        this.closed = true;
        const reason = error ?? new Error(this.stderr.trim().split("\n").slice(-3).join("\n") || "The model provider's process stopped.");
        if (!error) reason.code = "BOTKINS_PROVIDER_EXIT";
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(reason);
        }
        this.pending.clear();
        resolve(reason);
      };
      this.child.on("error", done);
      this.child.on("close", () => done());
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
      onStderr?.(String(chunk));
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
  }
  write(message) {
    if (this.closed) throw new Error("The model provider's process has stopped.");
    this.child.stdin.write(JSON.stringify(this.jsonrpc ? { jsonrpc: "2.0", ...message } : message) + "\n");
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // A tool may print a plain line before it starts talking.
    }
    if (!message || typeof message !== "object") return;
    if (message.method && message.id != null) return void this.answer(message);
    if (message.method) {
      for (const handler of this.notifications) {
        try {
          handler(message.method, message.params ?? {});
        } catch (error) {
          console.error("Provider notification:", error.message);
        }
      }
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(Object.assign(new Error(message.error.message || "The model provider refused the request."), { code: message.error.code, data: message.error.data }));
    else waiting.resolve(message.result);
  }
  async answer({ id, method, params }) {
    try {
      if (!this.requests) throw Object.assign(new Error("Unsupported request: " + method), { code: -32601 });
      const result = await this.requests(method, params ?? {});
      if (!this.closed) this.write({ id, result: result ?? {} });
    } catch (error) {
      if (!this.closed) this.write({ id, error: { code: error.code ?? -32000, message: error.message } });
    }
  }
  /** Asks the child and resolves with its result. */
  request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = timeoutMs > 0 ? setTimeout(() => this.pending.delete(id) && reject(Object.assign(new Error("The model provider didn't answer in time (" + method + ")."), {code:"ETIMEDOUT"})), timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params !== undefined && { params }) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  notify(method, params) {
    this.write({ method, ...(params !== undefined && { params }) });
  }
  /** Subscribes to the child's notifications. Returns an unsubscribe function. */
  onNotification(handler) {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }
  /** Sets the one function that answers the child's own requests: async (method, params) => result. */
  onRequest(handler) {
    this.requests = handler;
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500);
    await this.exited;
    clearTimeout(timer);
  }
}
