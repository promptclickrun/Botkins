// The terminal host: Botkins as a service with no window and no display, under plain Node.
// `botkins serve` runs this in the foreground, and it is what the systemd unit or the launchd
// job starts.
//
// It builds the same workspace the desktop app runs (desktop/runtime.mjs) on the headless host
// (desktop/host/headless.mjs), so a paired phone finds everything it finds on a computer with the
// desktop app, except what needs a screen. Around it:
//
//   config   <root>/config.json, checked whole before anything starts (config.mjs)
//   log      the last lines in memory, a file, and standard output (logs.mjs)
//   keys     the host key store that wraps secrets at rest (desktop/host/keystore.mjs)
//   socket   the owner-only control socket the `botkins` command line talks to (socket.mjs)
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { openKeyStore } from "../host/keystore.mjs";
import { headlessHost } from "../host/headless.mjs";
import { createRuntime } from "../runtime.mjs";
import { loadConfig, saveConfig } from "./config.mjs";
import { controlApi, dispatcher } from "./control.mjs";
import { createLog } from "./logs.mjs";
import { SignIns } from "./signin.mjs";
import { listenControl } from "./socket.mjs";

/** Makes a folder the service's own: there, and closed to everyone else. */
function ownFolder(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // Somebody else's folder (a mount): its permissions are theirs to set, and `botkins doctor` says so.
  }
}

/**
 * Starts the service.
 * @param options.paths    From desktop/terminal/paths.mjs.
 * @param options.version  The app's version.
 * @param options.trial    A run on a folder of its own (the tests): no key store, nothing announced
 *   on the network, no notifications through the relay.
 * @param options.out      (text) → standard output for log lines, or nothing to stay quiet.
 * @param options.console  True to send what the workspace's modules print through the log (the real service does).
 * @param options.updates  (service) → the update service for this copy, or undefined.
 * @param options.keySource  For tests: replaces openKeyStore.
 * @returns { runtime, api, log, config(), paths, stop(reason), stopped }
 */
export async function startService({ paths, version, trial = false, out, console: captureConsole = false, updates, keySource = openKeyStore, env = process.env }) {
  ownFolder(paths.root);
  ownFolder(paths.runDir);
  // A config file written by hand is made the service's own to read, like everything else here.
  try {
    if ((statSync(paths.config).mode & 0o077) !== 0) chmodSync(paths.config, 0o600);
  } catch {
    // No config file: every setting is at its default.
  }
  let config = loadConfig(paths.config);
  const log = createLog({ file: paths.logFile, lines: config.logs.lines, level: config.logs.level, out });
  const restoreConsole = captureConsole ? log.capture() : () => {};
  log.info("Botkins " + version + " terminal host starting. Data folder: " + paths.root);
  // What changed, counted, so a command line that waits (a chat's reply, the dashboard) hears of it.
  let revision = 0;
  const waiting = new Set();
  const bump = () => {
    revision++;
    for (const wake of [...waiting]) wake();
  };
  let keys = null;
  let signIns = null;
  let runtime;
  let closeSocket = async () => {};
  let stopping;
  const service = {
    paths,
    version,
    started: Date.now(),
    log,
    config: () => config,
    keys: () => keys && { source: keys.source, where: keys.where },
    revision: () => revision,
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
  try {
    if (config.providers.only.length) env.BOTKINS_PROVIDERS = config.providers.only.join(",");
    const host = headlessHost({
      version,
      packaged: !trial,
      // A trial run keeps its keys in files in its own folder, as the desktop app's does.
      keys: async ({ dataDir }) => {
        if (trial) return null;
        keys = await keySource({ dataDir, source: config.secrets.source, keyFile: config.secrets.keyFile ?? undefined, env });
        return keys;
      },
      updates: () => updates?.(service),
      log: (line) => log.info(line),
    });
    runtime = await createRuntime({
      host,
      dataDir: paths.dataDir,
      trial,
      pushed: bump,
      link: { port: config.link.port, extraHosts: config.link.addresses, announce: trial ? false : config.link.announce },
      copilot: { github: () => signIns?.copilotGitHub() },
    });
    service.runtime = runtime;
    runtime.subscribe(bump);
    signIns = new SignIns({ providers: () => runtime.providers, vault: () => runtime.workspace.vault, changed: (id) => runtime.workspace.providerChanged(id), env });
    signIns.restore();
    service.signIns = signIns;
    /** Makes the running link agree with the settings. What only a start picks up is left for the next one. */
    const apply = async (next) => {
      const { link } = runtime;
      log.setLevel(next.logs.level);
      if (link.store.data.locked) return void log.error("The phone link's key can't be opened with this host key, so phone access stays off. Run `botkins doctor`.");
      if (next.name && link.store.data.name !== next.name) link.setName(next.name);
      const status = link.status();
      if (status.relay.url !== next.relay.url || link.store.data.relay.enabled !== next.relay.enabled) link.setRelay({ enabled: next.relay.enabled, url: next.relay.url });
      if (status.enabled !== next.link.enabled || (next.link.enabled && !status.listening)) {
        try {
          await link.setEnabled(next.link.enabled);
          runtime.announce();
        } catch (error) {
          log.error("Phone link: " + error.message + (error.code === "EADDRINUSE" ? " Something else is using port " + next.link.port + ". Choose another with `botkins config set link.port`." : ""));
        }
      }
    };
    service.setConfig = async (next) => {
      config = saveConfig(paths.config, next);
      await apply(config);
      bump();
    };
    // The link's own start comes first: two starts at once would both try to take the port.
    await runtime.listening;
    await apply(config);
    service.stop = stop;
    const api = controlApi(service);
    closeSocket = await listenControl(paths.socket, dispatcher(api), () => ({ version, pid: process.pid }));
    runtime.begin();
    const status = runtime.link.status();
    log.info("Ready. Control socket: " + paths.socket + (status.listening ? ". Phone link on port " + status.port + (status.relay.enabled ? ", relay on" : "") + "." : ". Phone access is off."));
    if (!status.devices.length && status.listening) log.info("No phone is paired yet. Run `botkins pair` to show a pairing code.");
    return { runtime, api, log, config: () => config, paths, service, stop, stopped: () => stopping };
  } catch (error) {
    log.error("Botkins could not start: " + (error?.message ?? error));
    await closeSocket().catch(() => {});
    await runtime?.stop().catch(() => {});
    restoreConsole();
    throw error;
  }
  /** Stops for good: the socket first, so nothing new comes in, then the workspace. */
  function stop(reason = "stopping") {
    stopping ??= (async () => {
      log.info("Botkins is stopping (" + reason + ").");
      await closeSocket().catch(() => {});
      await signIns?.close().catch(() => {});
      // A provider that doesn't answer must not hold the service past its service manager's patience.
      await Promise.race([runtime.stop(), new Promise((resolve) => setTimeout(resolve, 8000).unref())]);
      log.info("Stopped.");
      restoreConsole();
    })();
    return stopping;
  }
}
