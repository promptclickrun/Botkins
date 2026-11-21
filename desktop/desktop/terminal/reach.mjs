// How a bot's shell finds the `botkins` command and the control socket.
//
// A bot's shell is a child of this process (or runs in it), so it gets this process's environment
// and nothing else. A service started by systemd or launchd, or the desktop app started from the
// Dock, has no PATH that holds `botkins`. So the host makes its own launcher, and puts it where
// every shell it starts looks first:
//
//   <root>/run/bin/botkins   a small script that runs this installation's command line with this
//                            installation's own Node (in the desktop app: the app's program, as Node)
//   PATH                     that folder, at the front
//   BOTKINS_SOCKET           the socket of this host, so the command talks to this host and no other
//
// `prepareReach` is called once, after the control socket listens: by `botkins serve`, and by the
// desktop app when it has started its own socket (desktop/terminal/control-start.mjs).
import { execFile } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = "botkins";
/** The command line's own file. In a packaged app it is the same place: next to `desktop/` (package.json "build.files"). */
const CLI = fileURLToPath(new URL("../../cli/botkins.mjs", import.meta.url));
// For a PATH that has none (a launchd job with no environment). The shell's own default is much the same.
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** The launcher of the desktop app sets this to "app" for its one command, so the command knows that there is no service to start. */
export const LAUNCHED_BY = "BOTKINS_LAUNCHED_BY";
/** True when `env` comes from the desktop app's own launcher (desktop/terminal/control-start.mjs). */
export const launchedByApp = (env = process.env) => env?.[LAUNCHED_BY] === "app";

/** A word as a shell reads it with no change: in single quotes, so a space or a quote in a path is safe. */
const quoted = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'";

/**
 * The text of the launcher.
 * @param options.node      The program that runs the command line (process.execPath).
 * @param options.cli       The command line's file.
 * @param options.electron  True when `node` is the desktop app's program: it runs as Node for this one command.
 * @param options.app       True for the desktop app's launcher: it sets BOTKINS_LAUNCHED_BY=app for this one command.
 */
export function launcherText({ node = process.execPath, cli = CLI, electron = !!process.versions.electron, app = false } = {}) {
  return "#!/bin/sh\n# Made by Botkins each time it starts. It runs this installation's own command line.\n" + (app ? LAUNCHED_BY + "=app " : "") + (electron ? "ELECTRON_RUN_AS_NODE=1 " : "") + "exec " + quoted(node) + " " + quoted(cli) + ' "$@"\n';
}

/**
 * Makes the launcher and tells `env` where it is.
 * @param options.dataDir  The folder that holds `run/` (the host's root: `<root>/run/bin/botkins`), not its `data/` folder.
 * @param options.socket   The control socket, as the command line should find it.
 * @param options.env      What a bot's shell inherits. Changed in place.
 * @param options.app      True when the desktop app calls it: the launcher then tells the command that it is the app's.
 * @returns { bin, command, socket }: the folder, the launcher's file, and the socket.
 */
export function prepareReach({ dataDir, socket, env = process.env, node, cli, electron, app = false } = {}) {
  if (!dataDir || !socket) throw new Error("prepareReach needs a data folder and a socket.");
  const bin = join(dataDir, "run", "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(bin).mode & 0o077) !== 0) chmodSync(bin, 0o700);
  } catch {
    // Somebody else's folder: its permissions are theirs to set.
  }
  const command = join(bin, LAUNCHER);
  const text = launcherText({ node, cli, electron, app });
  // Written whole and moved into place, so a shell that runs it right now never reads half of it.
  let current = null;
  try {
    current = readFileSync(command, "utf8");
  } catch {
    // Not there yet.
  }
  if (current !== text || (statSync(command).mode & 0o777) !== 0o755) {
    const staged = command + "." + process.pid + ".tmp";
    writeFileSync(staged, text, { mode: 0o755 });
    chmodSync(staged, 0o755);
    renameSync(staged, command);
  }
  env.BOTKINS_SOCKET = socket;
  // At the front, once: a second call does not add it again.
  const rest = (env.PATH || DEFAULT_PATH).split(delimiter).filter((entry) => entry && entry !== bin);
  env.PATH = [bin, ...rest].join(delimiter);
  return { bin, command, socket };
}

/** The launcher of a host, as the PATH in `env` finds it: a folder `.../run/bin` with an executable `botkins` in it. Or null. */
export function launcherOn(env = process.env) {
  for (const entry of String(env.PATH ?? "").split(delimiter)) {
    if (!entry || basename(entry) !== "bin" || basename(dirname(entry)) !== "run") continue;
    const file = join(entry, LAUNCHER);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** True when a bot's shell of a process with this environment can use `botkins`: it knows the socket, and finds the launcher. */
export function reachable(env = process.env) {
  return !!env.BOTKINS_SOCKET && launcherOn(env) !== null;
}

/**
 * What `botkins doctor` says about a bot's shell, found out the way a bot's shell does it: a shell
 * that is a child of this process, with this process's environment, asks for the command and runs
 * `botkins status --json`. The answer names this process when the command reached this service.
 * It waits for the child without blocking, so the service can answer the child's call.
 * @returns { ok, launcher?, pid?, problem? }
 */
export function checkReach({ env = process.env, pid = process.pid, timeout = 20_000 } = {}) {
  const lacks = (problem) => ({ ok: false, problem });
  if (!env.BOTKINS_SOCKET) return Promise.resolve(lacks("BOTKINS_SOCKET is not set in this service's environment, so the `botkins` command in a bot's shell does not know where this service is."));
  if (process.platform === "win32") return Promise.resolve(lacks("A bot's shell on Windows has no `botkins` command from this host."));
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "command -v botkins && botkins status --json"], { env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const [launcher, ...rest] = String(stdout).split("\n");
      if (!launcher) return resolve(lacks("A bot's shell finds no `botkins` command on its PATH."));
      if (error) return resolve({ ...lacks("A bot's shell finds `" + launcher + "`, but `botkins status` fails there: " + (String(stderr).trim().split("\n").pop() || error.message) + "."), launcher });
      let seen;
      try {
        seen = JSON.parse(rest.join("\n"));
      } catch {
        return resolve({ ...lacks("A bot's shell finds `" + launcher + "`, but `botkins status --json` does not answer with JSON."), launcher });
      }
      if (seen?.pid !== pid) return resolve({ ...lacks("A bot's shell finds `" + launcher + "`, but it reaches another Botkins (process " + seen?.pid + ", socket " + env.BOTKINS_SOCKET + "), not this one (process " + pid + ")."), launcher });
      resolve({ ok: true, launcher, pid });
    });
  });
}
