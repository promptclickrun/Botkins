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
import { chmodSync, statSync } from "node:fs";
import { openKeyStore } from "../host/keystore.mjs";
import { headlessHost } from "../host/headless.mjs";
import { createRuntime } from "../runtime.mjs";
import { loadConfig, saveConfig } from "./config.mjs";
import { changeCounter, ownFolder, startControl } from "./control-start.mjs";
import { createLog } from "./logs.mjs";
import { prepareReach } from "./reach.mjs";
import { installTeamworkPeers } from "../teamwork-peers.mjs";
import { ProfileManager } from "../profile.mjs";
import { RemoteHosts } from "../remotehosts.mjs";
import * as profileLib from "../remote/link-client.mjs";

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
 * @param options.reach  Whether a bot's shell gets the `botkins` command and BOTKINS_SOCKET (desktop/terminal/reach.mjs).
 *   It changes `env`, so a trial run (the tests, which share one process) leaves it off unless it asks.
 * @returns { runtime, api, log, config(), paths, stop(reason), stopped }
 */
export async function startService({ paths, version, trial = false, reach = !trial, out, console: captureConsole = false, updates, keySource = openKeyStore, env = process.env }) {
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
  const { bump, revision, waitForChange } = changeCounter();
  let keys = null;
  let signIns = null;
  let runtime;
  let remote;
  let profile;
  let closeSocket = async () => {};
  let stopping;
  const service = {
    paths,
    version,
    started: Date.now(),
    log,
    config: () => config,
    keys: () => keys && { source: keys.source, where: keys.where },
    revision,
    /** Something the command line or a dashboard shows changed outside the workspace (an update's state). */
    changed: () => bump(),
    waitForChange,
  };
  try {
    if (config.providers.only.length) env.BOTKINS_PROVIDERS = config.providers.only.join(",");
    const host = headlessHost({
      version,
      // "Packaged" is what makes the workspace look for a new release by itself now and then.
      packaged: !trial && config.updates.check,
      // A trial run keeps its keys in files in its own folder, as the desktop app's does.
      keys: async ({ dataDir }) => {
        if (trial) return null;
        // The service file may say where the key comes from (BOTKINS_KEY_SOURCE): that wins over the setting.
        keys = await keySource({ dataDir, source: env.BOTKINS_KEY_SOURCE || config.secrets.source, keyFile: config.secrets.keyFile ?? undefined, env });
        return keys;
      },
      updates: () => updates?.(service),
      log: (line) => log.info(line),
      env,
    });
    runtime = await createRuntime({
      host,
      dataDir: paths.dataDir,
      trial,
      pushed: bump,
      // For a container, whose own address no phone can reach: BOTKINS_PAIR_ADDRESS adds the
      // server's address for this start, and BOTKINS_LINK_PORT sets the port, which has to be the
      // one the container publishes (a phone uses the link's own port at every address).
      link: { port: /^\d{1,5}$/.test(env.BOTKINS_LINK_PORT ?? "") ? Number(env.BOTKINS_LINK_PORT) : config.link.port, extraHosts: [...config.link.addresses, ...(env.BOTKINS_PAIR_ADDRESS ? [env.BOTKINS_PAIR_ADDRESS.replace(/:\d+$/, "")] : [])], announce: trial ? false : config.link.announce, relayOwn: config.relay.own },
    });
    remote = new RemoteHosts({
      file: `${paths.dataDir}/remote-hosts.json`,
      protect: runtime.secretStore,
      lib: profileLib,
      fetch: host.fetch,
      device: { name: config.name || "Terminal host", platform: process.platform, kind: "terminal" },
      changed: bump,
      log: (line) => log.info(line),
    });
    profile = new ProfileManager({
      file: paths.profile ?? `${paths.dataDir}/profile.json`,
      protect: runtime.secretStore,
      lib: profileLib,
      local: () => runtime.link,
      remote: () => remote,
      workspace: () => !!runtime.workspace.state.bots.length || !!runtime.workspace.state.chats.length || !!runtime.workspace.nodeHost?.enabled,
      fetch: host.fetch,
      device: { name: config.name || "Terminal host", platform: process.platform, kind: "terminal" },
      changed: bump,
      log: (line) => log.info(line),
    });
    installTeamworkPeers(runtime, profile, remote.transport());
    const originalAddBot = runtime.handlers.addBot;
    runtime.handlers.addBot = (data, person) => {
      const result = originalAddBot(data, person);
      if (profile.token()) void profile.ensureLocalHost({ existing: true }).catch((error) => log.error("Profile local host: " + error.message));
      return result;
    };
    const originalNodeSetup = runtime.handlers.nodeSetup;
    runtime.handlers.nodeSetup = async (input) => {
      const result = await originalNodeSetup(input);
      if (profile.token()) void profile.ensureLocalHost({ existing: true }).catch((error) => log.error("Profile local host: " + error.message));
      return result;
    };
    const originalNodeDisconnect = runtime.handlers.nodeDisconnect;
    runtime.handlers.nodeDisconnect = async () => {
      if (profile.token()) await profile.disconnectLocal().catch((error) => log.error("Profile disconnect: " + error.message));
      return originalNodeDisconnect();
    };
    void profile.bindAll().catch((error) => log.error("Profile bind: " + error.message));
    service.profile = profile;
    service.runtime = runtime;
    runtime.subscribe(bump);
    // The runtime's own: a phone signs providers in and installs them through the same sessions (desktop/runtime.mjs).
    signIns = runtime.signIns;
    service.signIns = signIns;
    /** Makes the running link agree with the settings. What only a start picks up is left for the next one. */
    const apply = async (next) => {
      const { link } = runtime;
      log.setLevel(next.logs.level);
      // Switched on while a newer release is already known: it is installed now, not at the next look.
      if (next.updates.auto) runtime.updates?.autoInstall?.();
      else runtime.updates?.stopAuto?.();
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
      const prior = config;
      config = saveConfig(paths.config, next);
      await apply(config);
      if (prior.link.enabled !== config.link.enabled) profile.noteLocalLinkSetting(config.link.enabled === true);
      if (config.link.enabled === true && profile.token()) void profile.ensureLocalHost({ existing: !!runtime.workspace.state.bots.length || !!runtime.workspace.state.chats.length || !!runtime.workspace.nodeHost?.enabled }).catch((error) => log.error("Profile local host: " + error.message));
      if (profile.token()) void profile.bindAll().catch((error) => log.error("Profile bind: " + error.message));
      bump();
    };
    // The link's own start comes first: two starts at once would both try to take the port.
    await runtime.listening;
    await apply(config);
    if (profile.token()) void profile.ensureLocalHost({ existing: !!runtime.workspace.state.bots.length || !!runtime.workspace.state.chats.length || !!runtime.workspace.nodeHost?.enabled }).catch((error) => log.error("Profile local host: " + error.message));
    if (profile.token()) void profile.bindAll().catch((error) => log.error("Profile bind: " + error.message));
    service.stop = stop;
    const control = await startControl({ service, socket: paths.socket, log });
    const { api } = control;
    closeSocket = control.close;
    // A bot's shell finds the command and this socket whatever PATH the service's unit or job gave it.
    if (reach && process.platform !== "win32") prepareReach({ dataDir: paths.root, socket: paths.socket, env });
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
