// Where the terminal host keeps things, and where its command line finds the running service.
//
//   <root>/config.json        what `botkins config` edits (desktop/terminal/config.mjs)
//   <root>/data/              the workspace: the same folder layout as the desktop app's "data"
//   <root>/logs/botkins.log   the service's log (desktop/terminal/logs.mjs)
//   <root>/run/botkins.sock   the control socket the command line talks to
//
// The root is the folder BOTKINS_DATA_DIR names, else the system's folder when this runs as the
// system service (or as root), else the person's own:
//
//   Linux   /var/lib/botkins               ~/.local/share/botkins (or $XDG_DATA_HOME/botkins)
//   macOS   /Library/Application Support/Botkins Terminal
//                                          ~/Library/Application Support/Botkins Terminal
//
// It is never the desktop app's own folder ("Botkins"), so the two can be installed on one Mac.
// The root and everything in it belong to the user the service runs as, and nobody else can read
// them (0700): that, and the socket's own mode (0600), is what "owner-only" means here.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SERVICE_USER = "botkins";
export const SOCKET_NAME = "botkins.sock";
// A Unix socket's path has to fit in the kernel's address (104 bytes on macOS, 108 on Linux).
export const MAX_SOCKET_PATH = 100;

/** The system service's folder on this platform. */
export const systemRoot = (platform = process.platform) => (platform === "darwin" ? "/Library/Application Support/Botkins Terminal" : "/var/lib/botkins");

/** A person's own folder on this platform. */
export function userRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Botkins Terminal");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "botkins");
}

/**
 * @param options.root    A folder named on the command line (--data-dir).
 * @param options.socket  A socket named on the command line (--socket).
 * @returns { root, dataDir, config, logs, logFile, runDir, socket, scope }: `scope` is "custom",
 *   "system" or "user", by where the root came from.
 */
export function terminalPaths({ root, socket, env = process.env, platform = process.platform, home = homedir(), uid = process.getuid?.(), owns = ownedBy } = {}) {
  let scope = "custom";
  let dir = root || env.BOTKINS_DATA_DIR;
  if (!dir) {
    const system = systemRoot(platform);
    // The system's folder is used by root and by the user it belongs to (the service's own).
    scope = uid === 0 || owns(system, uid) ? "system" : "user";
    dir = scope === "system" ? system : userRoot({ platform, env, home });
  }
  dir = resolve(dir);
  const runDir = join(dir, "run");
  return {
    root: dir,
    dataDir: join(dir, "data"),
    config: join(dir, "config.json"),
    logs: join(dir, "logs"),
    logFile: join(dir, "logs", "botkins.log"),
    runDir,
    socket: resolve(socket || env.BOTKINS_SOCKET || join(runDir, SOCKET_NAME)),
    scope,
  };
}

function ownedBy(path, uid) {
  try {
    return existsSync(path) && statSync(path).uid === uid;
  } catch {
    return false;
  }
}
