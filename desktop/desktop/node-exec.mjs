// Shell execution (`system.run` and `system.which`) for a Botkins node host.
//
// Security model (modelled on OpenClaw exec approvals):
// - Exec policy is stored and enforced on the node, never on the caller.
//   Modes: `deny` | `allowlist` | `ask` (default) | `full`.
// - Allowlists are stored per node (`botId: "*"`) and/or per source bot (`botId: "<id>"`).
// - Every approval binds the exact request: `argv`, `cwd`, `env`, `resolvedExecutable` (realpath +
//   SHA-256 hash), and any `pinnedScript` (realpath + SHA-256 hash). Before spawning, the binding
//   is re-validated against both the request and disk; any post-approval edit or file drift fails.
// - Interpreter commands (`sh`, `bash`, `node`, `python3`, `ruby`, `perl`, etc.) whose script file
//   cannot be pinned to a single concrete local file are denied unless policy mode is `full`.
// - Dangerous loader/interpreter environment overrides are blocked unless policy mode is `full`.
// - Running child processes are spawned in their own process group so `pause`, cancellation, or
//   timeout immediately kills the whole process tree.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export const EXEC_MODES = ["deny", "allowlist", "ask", "full"];
export const DEFAULT_EXEC_MODE = "ask";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 128 * 1024;
export const MAX_ENV_KEYS = 32;
export const MAX_ARGV_LEN = 128;

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
  "python2",
  "ruby",
  "perl",
  "php",
  "lua",
  "pwsh",
  "powershell",
  "cmd",
  "awk",
  "gawk",
  "nawk",
  "osascript",
  "env",
  "xargs",
  "tclsh",
  "wish",
  "rscript",
]);

// Flags that run inline code or modules instead of a single local script file.
const INLINE_EXEC_FLAGS = new Set([
  "-c",
  "-e",
  "--eval",
  "-p",
  "--print",
  "-m",
  "-r",
  "-command",
  "-encodedcommand",
  "-enc",
  "/c",
  "/k",
  "-s",
  "-",
]);

const DANGEROUS_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "BASH_ENV",
  "ENV",
  "IFS",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "PROMPT_COMMAND",
  "ZDOTDIR",
  "SHELLOPTS",
  "PS4",
  "CDPATH",
  "GCONV_PATH",
  "LOCPATH",
  "HOSTALIASES",
  "PATH",
]);

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function executableBase(resolvedPath) {
  return basename(resolvedPath).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

function defaultShellArgv(command) {
  if (process.platform === "win32") {
    return [process.env.COMSPEC || "cmd.exe", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}

/**
 * Parses a command string into argv without invoking a shell when possible.
 * If shell metacharacters are present, wraps into `/bin/sh -c` (which is treated as an unpinned
 * interpreter and denied unless policy mode is `full`).
 */
export function parseShellCommand(command) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("Command cannot be empty.");
  }
  if (command.includes("\0")) throw new Error("Command contains a null byte.");
  // Detect unquoted or command-substitution metacharacters.
  if (/[|;&`><\n\r()]|\$\(/.test(command)) {
    return { argv: defaultShellArgv(command), shellWrapped: true };
  }
  const argv = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote || escaped) {
    return { argv: defaultShellArgv(command), shellWrapped: true };
  }
  if (hasToken) argv.push(current);
  if (argv.length === 0) throw new Error("Command cannot be empty.");
  return { argv, shellWrapped: false };
}

function isExecutableFile(candidate) {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Resolves an executable name or path on this node's PATH to its canonical realpath. */
export function resolveExecutablePath(name, cwd = process.cwd(), pathEnv = process.env.PATH || "") {
  if (typeof name !== "string" || !name.trim() || name.includes("\0")) {
    return null;
  }
  const raw = name.trim();
  const hasSep = raw.includes("/") || (process.platform === "win32" && raw.includes("\\"));
  if (hasSep) {
    const candidate = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (isExecutableFile(candidate)) return realpathSync(candidate);
    return null;
  }
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, raw + ext);
      if (isExecutableFile(candidate)) return realpathSync(candidate);
    }
  }
  return null;
}

/** `system.which`: resolves a list of command names on this node. */
export function nodeWhich(names) {
  if (!Array.isArray(names) || names.length === 0 || names.length > 50) {
    throw new Error("Provide between 1 and 50 executable names.");
  }
  const found = {};
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    found[name] = resolveExecutablePath(name);
  }
  return { found };
}

function cleanEnvOverrides(env) {
  if (env === undefined || env === null) return { entries: [], dangerous: [] };
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new Error("Environment overrides must be an object of string key/value pairs.");
  }
  const keys = Object.keys(env).sort();
  if (keys.length > MAX_ENV_KEYS) {
    throw new Error(`Too many environment overrides (max ${MAX_ENV_KEYS}).`);
  }
  const entries = [];
  const dangerous = [];
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    const value = env[key];
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`Invalid value for environment variable ${key}.`);
    }
    if (DANGEROUS_ENV_KEYS.has(key.toUpperCase())) {
      dangerous.push(key);
    }
    entries.push([key, value]);
  }
  return { entries, dangerous };
}

function analyzeInterpreter(resolvedExecutable, argv, cwd) {
  const base = executableBase(resolvedExecutable);
  if (!INTERPRETERS.has(base)) {
    return { isInterpreter: false, pinnedScript: null, unpinnedReason: null };
  }
  // `env` and `xargs` launch arbitrary subcommands and cannot be safely pinned as a single script.
  if (base === "env" || base === "xargs") {
    return {
      isInterpreter: true,
      pinnedScript: null,
      unpinnedReason: `Indirect launcher "${base}" cannot be pinned to a script file (only allowed in full mode).`,
    };
  }
  const args = argv.slice(1);
  // Look for inline-execution flags before the script argument.
  let scriptArg = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const lower = token.toLowerCase();
    if (INLINE_EXEC_FLAGS.has(lower) || lower.startsWith("--eval=") || lower.startsWith("--print=")) {
      return {
        isInterpreter: true,
        pinnedScript: null,
        unpinnedReason: `Interpreter "${base}" inline code flag "${token}" cannot be pinned to a script file (only allowed in full mode).`,
      };
    }
    if (token === "--") {
      scriptArg = args[i + 1] ?? null;
      break;
    }
    if (token.startsWith("-")) {
      // Single-char combined flags like `-ce` or `-ec` containing `c` or `e`.
      if (/^-[a-zA-Z]+$/.test(token) && /[cepm]/.test(token)) {
        return {
          isInterpreter: true,
          pinnedScript: null,
          unpinnedReason: `Interpreter "${base}" flag "${token}" cannot be pinned to a script file (only allowed in full mode).`,
        };
      }
      continue;
    }
    scriptArg = token;
    break;
  }

  if (!scriptArg) {
    return {
      isInterpreter: true,
      pinnedScript: null,
      unpinnedReason: `Interpreter "${base}" has no local script file to pin (only allowed in full mode).`,
    };
  }

  const candidate = isAbsolute(scriptArg) ? scriptArg : resolve(cwd, scriptArg);
  if (!existsSync(candidate)) {
    return {
      isInterpreter: true,
      pinnedScript: null,
      unpinnedReason: `Interpreter "${base}" script "${scriptArg}" does not exist on disk and cannot be pinned.`,
    };
  }
  let realScript;
  try {
    realScript = realpathSync(candidate);
    const st = statSync(realScript);
    if (!st.isFile()) {
      return {
        isInterpreter: true,
        pinnedScript: null,
        unpinnedReason: `Interpreter "${base}" script "${scriptArg}" is not a regular file and cannot be pinned.`,
      };
    }
  } catch {
    return {
      isInterpreter: true,
      pinnedScript: null,
      unpinnedReason: `Interpreter "${base}" script "${scriptArg}" could not be resolved on disk.`,
    };
  }
  return {
    isInterpreter: true,
    pinnedScript: {
      path: realScript,
      hash: sha256File(realScript),
    },
    unpinnedReason: null,
  };
}

function globMatch(pattern, value) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

/** Checks if a prepared request matches the node's allowlist for `sourceBotId`. */
export function matchesAllowlist(allowlist = [], sourceBotId, binding) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const resolved = binding.resolvedExecutable;
  const base = basename(resolved);
  const rawCmd = binding.argv[0] || "";
  for (const rule of allowlist) {
    if (!rule || typeof rule.pattern !== "string" || !rule.pattern.trim()) continue;
    const ruleBot = rule.botId || "*";
    if (ruleBot !== "*" && ruleBot !== sourceBotId) continue;
    const pattern = rule.pattern.trim();
    if (pattern.includes("/") || pattern.includes("\\")) {
      if (globMatch(pattern, resolved)) return true;
    } else if (globMatch(pattern, base) || globMatch(pattern, rawCmd)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes, resolves, and binds a `system.run` request without executing it.
 * The returned `binding` cryptographically pins argv, cwd, env, resolved executable, and any
 * pinned script file.
 */
export function prepareExecRequest(payload = {}, { resolveCwd } = {}) {
  let argv;
  let shellWrapped = false;
  if (Array.isArray(payload.argv) && payload.argv.length > 0) {
    if (payload.argv.length > MAX_ARGV_LEN) {
      throw new Error(`Command has too many arguments (max ${MAX_ARGV_LEN}).`);
    }
    argv = payload.argv.map((item) => {
      if (typeof item !== "string" || item.includes("\0")) {
        throw new Error("Every argv element must be a valid string.");
      }
      return item;
    });
    if (!argv[0].trim()) throw new Error("Executable name cannot be empty.");
  } else if (typeof payload.command === "string" && payload.command.trim()) {
    ({ argv, shellWrapped } = parseShellCommand(payload.command));
  } else {
    throw new Error("Provide either `argv` (array of strings) or `command` (string).");
  }

  let cwd;
  if (typeof resolveCwd === "function") {
    cwd = resolveCwd(payload);
  } else {
    const rawCwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : homedir();
    const expanded = rawCwd === "~" ? homedir() : rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(2)) : rawCwd;
    if (!existsSync(expanded)) throw new Error("Working directory does not exist on this node.");
    cwd = realpathSync(expanded);
  }
  const cwdStat = statSync(cwd);
  if (!cwdStat.isDirectory()) throw new Error("Working directory is not a directory.");

  const { entries: envEntries, dangerous: dangerousEnv } = cleanEnvOverrides(payload.env);
  const resolvedExecutable = resolveExecutablePath(argv[0], cwd);
  if (!resolvedExecutable) {
    throw new Error(`Executable not found on this node: ${argv[0]}`);
  }
  const execHash = sha256File(resolvedExecutable);
  const interpreter = analyzeInterpreter(resolvedExecutable, argv, cwd);

  const timeoutMs =
    typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
      ? Math.min(Math.max(Math.round(payload.timeoutMs), 500), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const canonical = {
    argv,
    cwd,
    env: envEntries,
    resolvedExecutable,
    execHash,
    pinnedScript: interpreter.pinnedScript,
  };
  const binding = {
    ...canonical,
    bindingHash: sha256Json(canonical),
  };

  return {
    binding,
    shellWrapped,
    dangerousEnv,
    isInterpreter: interpreter.isInterpreter,
    unpinnedReason: interpreter.unpinnedReason,
    timeoutMs,
    displayCommand: argv.join(" "),
  };
}

/**
 * Evaluates a prepared exec request against the node's exec policy (`deny` | `allowlist` | `ask` | `full`).
 */
export function evaluateExecPolicy(prepared, { mode = DEFAULT_EXEC_MODE, allowlist = [], sourceBotId = "" } = {}) {
  const activeMode = EXEC_MODES.includes(mode) ? mode : DEFAULT_EXEC_MODE;
  if (activeMode === "deny") {
    return { decision: "deny", reason: "Shell execution is disabled on this node (exec policy: deny)." };
  }
  if (activeMode === "full") {
    return { decision: "allow", reason: "policy:full" };
  }
  if (prepared.dangerousEnv.length > 0) {
    return {
      decision: "deny",
      reason: `Blocked environment override(s): ${prepared.dangerousEnv.join(", ")} (only allowed in full mode).`,
    };
  }
  if (prepared.unpinnedReason) {
    return { decision: "deny", reason: prepared.unpinnedReason };
  }
  if (activeMode === "allowlist") {
    if (matchesAllowlist(allowlist, sourceBotId, prepared.binding)) {
      return { decision: "allow", reason: "allowlist" };
    }
    return {
      decision: "deny",
      reason: `Command "${prepared.binding.resolvedExecutable}" is not in this node's allowlist.`,
    };
  }
  return { decision: "ask", reason: "policy:ask" };
}

/**
 * Re-validates an approved binding right before execution:
 * 1. If `payload` is provided, re-prepares it and confirms the exact request matches the approved binding.
 * 2. Re-hashes the executable and any pinned script on disk to detect tampering after approval.
 */
export function verifyExecBinding(approvedBinding, payload = null, { resolveCwd } = {}) {
  if (!approvedBinding || typeof approvedBinding.bindingHash !== "string") {
    throw new Error("Missing approval binding for shell command.");
  }
  if (payload) {
    const fresh = prepareExecRequest(payload, { resolveCwd });
    if (fresh.binding.bindingHash !== approvedBinding.bindingHash) {
      throw new Error("Shell request changed after approval (binding mismatch); refusing to run.");
    }
  }
  if (!existsSync(approvedBinding.cwd) || realpathSync(approvedBinding.cwd) !== approvedBinding.cwd) {
    throw new Error("Working directory changed after approval; refusing to run.");
  }
  if (!existsSync(approvedBinding.resolvedExecutable) || realpathSync(approvedBinding.resolvedExecutable) !== approvedBinding.resolvedExecutable) {
    throw new Error("Resolved executable changed after approval; refusing to run.");
  }
  const currentExecHash = sha256File(approvedBinding.resolvedExecutable);
  if (currentExecHash !== approvedBinding.execHash) {
    throw new Error("Executable binary changed on disk after approval; refusing to run.");
  }
  if (approvedBinding.pinnedScript) {
    const { path: scriptPath, hash: scriptHash } = approvedBinding.pinnedScript;
    if (!existsSync(scriptPath) || realpathSync(scriptPath) !== scriptPath) {
      throw new Error("Pinned script path changed after approval; refusing to run.");
    }
    if (sha256File(scriptPath) !== scriptHash) {
      throw new Error("Pinned script contents changed after approval; refusing to run.");
    }
  }
  return true;
}

function appendBounded(current, chunk, maxBytes) {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  const remaining = maxBytes - current.bytes;
  if (remaining <= 0) {
    current.truncated = true;
    return;
  }
  if (incoming.length <= remaining) {
    current.chunks.push(incoming);
    current.bytes += incoming.length;
  } else {
    current.chunks.push(incoming.subarray(0, remaining));
    current.bytes += remaining;
    current.truncated = true;
  }
}

/**
 * Executes a verified, bound command directly (no shell) in its own process group.
 * Returns `{ promise, kill }` where `kill(reason)` immediately terminates the entire process tree.
 */
export function runBoundExec(approvedBinding, { timeoutMs = DEFAULT_TIMEOUT_MS, onOutput, payload = null, resolveCwd } = {}) {
  verifyExecBinding(approvedBinding, payload, { resolveCwd });

  const env = { ...process.env };
  for (const [key, value] of approvedBinding.env) {
    env[key] = value;
  }

  const startedAt = Date.now();
  const child = spawn(approvedBinding.resolvedExecutable, approvedBinding.argv.slice(1), {
    cwd: approvedBinding.cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutBuf = { chunks: [], bytes: 0, truncated: false };
  const stderrBuf = { chunks: [], bytes: 0, truncated: false };
  let finished = false;
  let timedOut = false;
  let killedReason = null;
  let forceTimer = null;

  const emitOutput = () => {
    if (typeof onOutput !== "function") return;
    onOutput({
      stdout: Buffer.concat(stdoutBuf.chunks).toString("utf8"),
      stderr: Buffer.concat(stderrBuf.chunks).toString("utf8"),
      stdoutTruncated: stdoutBuf.truncated,
      stderrTruncated: stderrBuf.truncated,
    });
  };

  const terminateTree = (signal = "SIGTERM") => {
    if (finished || !child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    }
  };

  const kill = (reason = "killed") => {
    if (finished) return;
    if (!killedReason) killedReason = reason;
    terminateTree("SIGTERM");
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        terminateTree("SIGKILL");
      }, 400);
      forceTimer.unref?.();
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill("timeout");
  }, timeoutMs);
  timer.unref?.();

  child.stdout?.on("data", (chunk) => {
    appendBounded(stdoutBuf, chunk, MAX_OUTPUT_BYTES);
    emitOutput();
  });
  child.stderr?.on("data", (chunk) => {
    appendBounded(stderrBuf, chunk, MAX_OUTPUT_BYTES);
    emitOutput();
  });

  const promise = new Promise((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      finished = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      finished = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise({
        argv: approvedBinding.argv,
        resolvedExecutable: approvedBinding.resolvedExecutable,
        cwd: approvedBinding.cwd,
        exitCode: typeof code === "number" ? code : null,
        signal: signal || null,
        timedOut,
        killed: Boolean(killedReason),
        killedReason,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdoutBuf.chunks).toString("utf8"),
        stderr: Buffer.concat(stderrBuf.chunks).toString("utf8"),
        stdoutTruncated: stdoutBuf.truncated,
        stderrTruncated: stderrBuf.truncated,
      });
    });
  });

  return { promise, kill, pid: child.pid };
}
