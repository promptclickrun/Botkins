// Resolve and verify an executable's canonical, trusted identity for `env_exec`.
//
// Never trusts ambient PATH lookup, relative paths, symlinks escaping trusted roots,
// world/group-writable binaries, or blocked shells/interpreters/utilities.
// Returns `{ requested, resolvedPath, exeSha256 }` computed from an `O_NOFOLLOW` descriptor.
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

// Shells, script interpreters, network exfiltration utilities, and env-dump binaries are blocked
// from env_exec (checked against BOTH requested name and resolved canonical target basename).
export const BLOCKED_SHELLS = new Set([
  "sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish", "rc", "nu", "nushell",
  "cmd", "command", "powershell", "pwsh", "osascript", "wscript", "cscript",
  "env", "printenv", "set", "export",
  "node", "nodejs", "python", "python2", "python3", "perl", "ruby", "php",
  "awk", "gawk", "mawk", "nawk", "lua", "luajit", "deno", "bun", "tclsh", "wish",
  "rscript", "julia", "expect",
  "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "rsync",
  "xargs", "find", "exec", "eval", "sudo", "su", "doas", "nohup", "screen", "tmux",
  "dd", "base64", "xxd", "od", "hexdump", "strings", "cat", "echo", "printf",
]);

const DEFAULT_POSIX_SEARCH_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/local/bin",
  "/snap/bin",
];

const DEFAULT_POSIX_TRUSTED_ROOTS = [
  ...DEFAULT_POSIX_SEARCH_DIRS,
  "/usr/local/sbin",
  "/usr/local/Cellar",
  "/usr/local/opt",
  "/usr/local/lib",
  "/usr/lib",
  "/usr/libexec",
  "/opt/homebrew/sbin",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/local/libexec",
  "/snap",
  "/nix/store",
];

function defaultWindowsDirs(env = process.env) {
  const sysRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    join(sysRoot, "System32"),
    join(sysRoot, "SysWOW64"),
    programFiles,
    programFilesX86,
  ];
}

function normalizeBaseName(filePath) {
  return basename(filePath).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}

function isInsideRoot(targetPath, rootPath, platform) {
  const t = platform === "win32" ? normalize(targetPath).toLowerCase() : normalize(targetPath);
  const r = platform === "win32" ? normalize(rootPath).toLowerCase() : normalize(rootPath);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function canonicalRoots(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const abs = resolve(dir.trim());
    for (const candidate of [abs, (() => { try { return realpathSync(abs); } catch { return null; } })()]) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
  }
  return out;
}

function assertDirChainTrusted(fileDir, stopAtRoot, { platform, uid, checkAboveRoot }) {
  if (platform === "win32") return;
  let cur = normalize(fileDir);
  const rootLimit = stopAtRoot ? normalize(stopAtRoot) : null;
  while (true) {
    let st;
    try {
      st = statSync(cur);
    } catch {
      throw new Error(`Trusted executable directory is inaccessible: ${cur}`);
    }
    if (!st.isDirectory()) throw new Error(`Invalid executable directory: ${cur}`);
    if ((st.mode & 0o002) !== 0) {
      throw new Error(`Refused executable in world-writable directory "${cur}".`);
    }
    if (typeof uid === "number" && st.uid !== 0 && st.uid !== uid) {
      throw new Error(`Refused executable under directory "${cur}" owned by another user.`);
    }
    if (!checkAboveRoot && rootLimit && cur === rootLimit) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

function hashFileDescriptor(fd) {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (true) {
    const bytesRead = readSync(fd, buf, 0, buf.length, offset);
    if (bytesRead <= 0) break;
    hash.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * Resolve a command to a canonical, verified, trusted executable path and its SHA-256 content hash.
 *
 * - Relative paths (`./foo`, `../bar`, `dir/bin`) are always refused.
 * - Bare names (`gh`) are looked up ONLY inside fixed trusted directories, never `process.env.PATH`.
 * - Symlinks are resolved via `realpathSync`; the real target must reside inside a trusted root and
 *   must not resolve to a blocked shell/interpreter/utility.
 * - On POSIX, the file is opened with `O_NOFOLLOW`, verified as a non-world/group-writable, non-setuid
 *   regular executable owned by root or the current user, and hashed from that open descriptor.
 */
export function resolveTrustedExecutable(
  command,
  {
    trustedDirs = null,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : null,
    env = process.env,
  } = {},
) {
  const cmd = typeof command === "string" ? command.trim() : "";
  if (!cmd || cmd.length > 512 || /[\s\0\p{Cc}]/u.test(cmd)) {
    throw new Error("Provide a single executable name or path without spaces or shell operators.");
  }

  const requestedBase = normalizeBaseName(cmd);
  if (!requestedBase || BLOCKED_SHELLS.has(requestedBase)) {
    throw new Error(`Refused to run shell, interpreter, or utility "${requestedBase || cmd}" with a secret.`);
  }

  const customTrusted = Array.isArray(trustedDirs) && trustedDirs.length > 0;
  const trustedRoots = customTrusted
    ? canonicalRoots(trustedDirs)
    : canonicalRoots(platform === "win32" ? defaultWindowsDirs(env) : DEFAULT_POSIX_TRUSTED_ROOTS);

  if (!isAbsolute(cmd)) {
    throw new Error("env_exec requires an absolute path to a trusted executable (bare names and PATH lookup are not allowed).");
  }
  const candidatePath = cmd;

  let resolvedPath;
  try {
    resolvedPath = realpathSync(candidatePath);
  } catch {
    throw new Error(`Executable "${cmd}" does not exist or cannot be resolved.`);
  }

  const resolvedBase = normalizeBaseName(resolvedPath);
  if (!resolvedBase || BLOCKED_SHELLS.has(resolvedBase)) {
    throw new Error(`Refused to run shell, interpreter, or utility "${resolvedBase || resolvedPath}" with a secret.`);
  }

  const matchedRoot = trustedRoots.find((root) => isInsideRoot(resolvedPath, root, platform));
  if (!matchedRoot) {
    throw new Error(`Refused untrusted executable "${resolvedPath}": outside trusted executable directories.`);
  }

  assertDirChainTrusted(dirname(resolvedPath), matchedRoot, {
    platform,
    uid,
    checkAboveRoot: !customTrusted,
  });

  const openFlags = fsConstants.O_RDONLY | (platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  let fd;
  try {
    fd = openSync(resolvedPath, openFlags);
  } catch {
    throw new Error(`Executable "${resolvedPath}" could not be opened safely for verification.`);
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Refused non-regular executable "${resolvedPath}".`);
    }
    if (platform !== "win32") {
      if ((st.mode & 0o111) === 0) {
        throw new Error(`File "${resolvedPath}" is not executable.`);
      }
      if ((st.mode & 0o022) !== 0) {
        throw new Error(`Refused writable executable "${resolvedPath}": must not be group- or world-writable.`);
      }
      if ((st.mode & 0o6000) !== 0) {
        throw new Error(`Refused setuid/setgid executable "${resolvedPath}".`);
      }
      if (typeof uid === "number" && st.uid !== 0 && st.uid !== uid) {
        throw new Error(`Refused executable "${resolvedPath}" owned by another user.`);
      }
      try {
        accessSync(resolvedPath, fsConstants.X_OK);
      } catch {
        throw new Error(`Executable "${resolvedPath}" is not executable by the current user.`);
      }
    }
    const exeSha256 = hashFileDescriptor(fd);
    return {
      requested: cmd,
      resolvedPath,
      exeSha256,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}
