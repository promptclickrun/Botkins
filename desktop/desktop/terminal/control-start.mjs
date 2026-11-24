// Starts the control socket for a host. Two hosts use it, so that both have the same calls and
// the same refusals:
//
//   `botkins serve`      desktop/terminal/serve.mjs, which builds its own `service` and calls `startControl`
//   the desktop app      desktop/main.mjs, through `startAppControl`: the socket is at <the app's data folder>/run/botkins.sock
//
// The app's own socket leaves out what only makes sense for a service (see NOT_IN_THE_APP). A
// socket that fails to start never stops the app: it is one line in the log (the command is then
// not reachable, `reachable()` in reach.mjs says false).
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { controlApi, dispatcher } from "./control.mjs";
import { createLog } from "./logs.mjs";
import { prepareReach } from "./reach.mjs";
import { MAX_SOCKET_PATH, SOCKET_NAME } from "./paths.mjs";
import { ControlError, listenControl } from "./socket.mjs";

/** Makes a folder the host's own: there, and closed to everyone else. */
export function ownFolder(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // Somebody else's folder (a mount): its permissions are theirs to set, and `botkins doctor` says so.
  }
}

/** The number of changes, and a wait for the next one (the dashboard, a chat that is read as it streams). */
export function changeCounter() {
  let revision = 0;
  const waiting = new Set();
  return {
    revision: () => revision,
    bump() {
      revision++;
      for (const wake of [...waiting]) wake();
    },
    waitForChange({ after = 0, ms = 25_000, signal } = {}) {
      if (revision !== after || signal?.aborted) return Promise.resolve({ revision });
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          signal?.removeEventListener("abort", done);
          resolve({ revision });
        };
        const timer = setTimeout(done, ms);
        waiting.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
  };
}

/**
 * Listens on the control socket with the calls of `controlApi`.
 * @param options.service  What controlApi reads (desktop/terminal/control.mjs).
 * @param options.socket   Where to listen.
 * @param options.log      The log (desktop/terminal/logs.mjs): the dispatcher writes what changed to it.
 * @param options.refuse   { call name: the sentence that refuses it }, for calls this host cannot do.
 * @returns { api, close }
 */
export async function startControl({ service, socket, log, refuse = {} }) {
  const api = controlApi(service);
  for (const [name, sentence] of Object.entries(refuse)) {
    api[name] = () => {
      throw new ControlError(sentence, "NOT_IN_THE_APP");
    };
  }
  const close = await listenControl(socket, dispatcher(api, { log: (line) => log.info(line) }), () => ({ version: service.version, pid: process.pid }));
  return { api, close };
}

/** The calls of the terminal host's service that the app's socket refuses, and what each says. */
export const NOT_IN_THE_APP = {
  stop: "`stop` ends the terminal host's service. The desktop app is closed from its own window or its menu.",
  "config.get": "The desktop app has no config file (`botkins config`). Its settings are in the app's window.",
  "config.describe": "The desktop app has no config file (`botkins config`). Its settings are in the app's window.",
  "config.set": "The desktop app has no config file (`botkins config`). Its settings are in the app's window.",
  "config.replace": "The desktop app has no config file (`botkins config`). Its settings are in the app's window.",
  "relay.set": "The relay of the desktop app is switched in the app's window (`botkins relay on` and `off` change the terminal host's config file).",
  "update.install": "The desktop app installs its updates from its own window, because the install restarts it.",
};

/**
 * The desktop app's control socket, and the command a bot's shell runs to reach it.
 * @param options.runtime  From createRuntime (desktop/runtime.mjs).
 * @param options.root     The app's data folder: the socket is `<root>/run/botkins.sock`, the launcher `<root>/run/bin/botkins`.
 * @param options.keys     () → { source, where } for what wraps the app's secrets, or null (a run that keeps keys in files).
 * @param options.env      What a bot's shell inherits (the app's own environment).
 * @param options.say      (line) → where one line for the person who runs the app goes.
 * @returns { socket, close, changed } or null when the socket did not start (one line is said).
 */
export async function startAppControl({ runtime, profile = runtime?.profile, root, version, keys = () => null, env = process.env, platform = process.platform, say = (line) => console.error(line) } = {}) {
  if (platform === "win32") return say("Control socket: not available on Windows, so a bot's shell has no `botkins` command here."), null;
  const socket = join(root, "run", SOCKET_NAME);
  // A path that is too long for the system cannot be a socket. One clear line, and the app goes on with no command in a bot's shell.
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) return say("Control socket: not started. The path " + socket + " is longer than " + MAX_SOCKET_PATH + " bytes, which is too long for this system. A bot's shell has no `botkins` command until the app's data folder has a shorter path."), null;
  const counter = changeCounter();
  // The folder of the socket is the app's own, whether or not it was there before.
  try {
    ownFolder(join(root, "run"));
  } catch (error) {
    return say("Control socket: not started (" + (error?.message ?? error) + "). A bot's shell has no `botkins` command meanwhile."), null;
  }
  // The same file as the terminal host's log (<root>/logs/botkins.log, this user only), so a person sees what a bot changed after the app quits and starts again. `botkins logs` reads it when the app is not running. The lines go on the app's own error output too.
  let log;
  try {
    log = createLog({ file: join(root, "logs", "botkins.log"), lines: 1000, out: (text) => say(text.replace(/\n$/, "")) });
  } catch (error) {
    say("Control socket: the log file is not available (" + (error?.message ?? error) + "). What a bot changes is kept in memory only until the app quits.");
    log = createLog({ lines: 1000, out: (text) => say(text.replace(/\n$/, "")) });
  }
  const service = {
    paths: { root, dataDir: join(root, "data"), runDir: join(root, "run"), socket },
    inApp: true, // the app, not the terminal host: its socket has no `config set` (a message that names one says where the app has it)
    version,
    started: Date.now(),
    log,
    runtime,
    profile,
    signIns: runtime.signIns,
    config: () => {
      throw new ControlError(NOT_IN_THE_APP["config.get"], "NOT_IN_THE_APP");
    },
    setConfig: async () => {
      throw new ControlError(NOT_IN_THE_APP["config.set"], "NOT_IN_THE_APP");
    },
    keys,
    revision: counter.revision,
    changed: counter.bump,
    waitForChange: counter.waitForChange,
    stop: async () => {
      throw new ControlError(NOT_IN_THE_APP.stop, "NOT_IN_THE_APP");
    },
  };
  let control;
  try {
    control = await startControl({ service, socket, log, refuse: NOT_IN_THE_APP });
    // Any change of the workspace wakes a command line that waits.
    const unsubscribe = runtime.subscribe(counter.bump);
    const closed = control.close;
    control.close = async () => {
      unsubscribe?.();
      await closed();
    };
    prepareReach({ dataDir: root, socket, env, app: true });
  } catch (error) {
    await control?.close().catch(() => {});
    say("Control socket: not started (" + (error?.message ?? error) + "). A bot's shell has no `botkins` command meanwhile.");
    return null;
  }
  log.info("Control socket: " + socket);
  return { socket, close: control.close, changed: counter.bump };
}
