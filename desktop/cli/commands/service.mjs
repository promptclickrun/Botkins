// The service itself: run it, ask how it is, read its log, check its health.
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../desktop/terminal/config.mjs";
import { serviceManager } from "../../desktop/terminal/manager.mjs";
import { launchedByApp } from "../../desktop/terminal/reach.mjs";
import { installLayout, notRootOwned, notRootOwnedWords } from "../../desktop/terminal/update-install.mjs";
import { CliError, duration, EXIT, table } from "../output.mjs";

const MIN_NODE = [22, 12];
const WANTED_NODE = 24;
/** What a command says when the app's own launcher ran it and the app is not running: the app is not a service to start. */
const OPEN_THE_APP = "The Botkins app is not running. Open it.";

/** The last lines of the log file, for a service that isn't running. */
function tailFile(file, count) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-count);
  return lines.map((line, index) => {
    const [, time, level, text] = /^(\S+) (\w+)\s+(.*)$/.exec(line) ?? [null, "", "info", line];
    return { n: index + 1, time, level, text };
  });
}

/** True when nothing listens on the port. It finds out by listening there for a moment itself. */
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
  });

/** One check's answer: ok true (fine), false (a problem to fix) or null (worth knowing). */
const check = (name, ok, detail, fix) => ({ name, ok, detail, ...(fix && { fix }) });
const mode = (path) => statSync(path).mode & 0o777;

/**
 * Everything `botkins doctor` looks at. Works with the service stopped; says more when it runs.
 * @param options.freePort  (port) → true when nothing listens there. The real look listens on the
 *   port for a moment, so a test hands in its own answer: two tests that looked at the same real
 *   port at the same moment would each find it taken by the other.
 */
export async function examine({ paths, client, env, fetcher = fetch, node = process.versions.node, uid = process.getuid?.(), installFolder, units, freePort = portFree }) {
  const checks = [];
  const [major, minor] = node.split(".").map(Number);
  const enough = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push(check("Node.js", !enough ? false : major >= WANTED_NODE ? true : null, "Node.js " + node + (major >= WANTED_NODE ? "" : enough ? " works; " + WANTED_NODE + " is what Botkins is built and tested on." : " is too old."), enough && major >= WANTED_NODE ? undefined : "Install Node.js " + WANTED_NODE + "."));
  // The data folder: there, this user's own, and closed to everyone else.
  let config = null;
  if (!existsSync(paths.root)) checks.push(check("Data folder", null, paths.root + " doesn't exist yet. `botkins serve` makes it."));
  else {
    const stat = statSync(paths.root);
    const own = uid === undefined || stat.uid === uid || uid === 0;
    const closed = (stat.mode & 0o077) === 0;
    let writable = true;
    try {
      accessSync(paths.root, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      writable = false;
    }
    checks.push(check("Data folder", own && closed && writable, paths.root + (!own ? " belongs to another user." : !writable ? " can't be written by this user." : !closed ? " can be read by other users (mode " + (stat.mode & 0o777).toString(8) + ")." : " is this user's own, and closed to everyone else."), !own ? "Run the command as the user the service runs as, for example with `sudo -u botkins`." : !closed ? "chmod 700 '" + paths.root + "'" : undefined));
    const open = [];
    for (const file of ["config.json", "data/vault.json", "data/vault.key", "data/host.key", "data/keystore.json", "data/link/link.json", "data/workspace.json", "logs/botkins.log"]) {
      const path = join(paths.root, file);
      if (existsSync(path) && (mode(path) & 0o077) !== 0) open.push(file + " (" + mode(path).toString(8) + ")");
    }
    checks.push(check("Private files", open.length === 0, open.length ? "Readable by other users: " + open.join(", ") + "." : "Keys, the vault, the link's identity, the workspace and the log are readable by this user only.", open.length ? "chmod -R go-rwx '" + paths.root + "'" : undefined));
  }
  try {
    config = loadConfig(paths.config);
    checks.push(check("Config", true, existsSync(paths.config) ? paths.config + " is valid." : "No config file: every setting is at its default."));
  } catch (error) {
    checks.push(check("Config", false, error.message, "Fix it with `botkins config edit`."));
  }
  // The service, through its socket.
  let seen = null;
  try {
    seen = await client.call("doctor");
  } catch (error) {
    if (error.code === "DENIED") checks.push(check("Service", false, error.message));
    else if (error.code === "NOT_RUNNING") checks.push(check("Service", null, "Not running, so the phone link, the relay and the providers can't be asked. " + (launchedByApp(env) ? OPEN_THE_APP : "Start it with `botkins service start` or `botkins serve`.")));
    else checks.push(check("Service", false, error.message));
  }
  if (seen) {
    checks.push(check("Service", true, "Running, version " + seen.version + ", Node.js " + seen.node + "."));
    const socketMode = existsSync(paths.socket) ? mode(paths.socket) : null;
    checks.push(check("Control socket", socketMode === null || (socketMode & 0o077) === 0, socketMode === null ? paths.socket : paths.socket + " is mode " + socketMode.toString(8) + (socketMode & 0o077 ? ": other users can reach the service." : ", this user only."), socketMode !== null && socketMode & 0o077 ? "chmod 600 '" + paths.socket + "'" : undefined));
    checks.push(check("Secrets at rest", seen.vault.locked ? false : seen.secrets.source === "file" ? null : true, seen.vault.locked ? "The credential vault can't be opened with this host key." : "The vault's key and the phone link's are wrapped by the host key from the " + seen.secrets.where + "." + (seen.secrets.source === "file" ? " A key file protects a copy of the data folder only when it is kept outside it." : ""), seen.vault.locked ? "Put the earlier host key back, or reset the vault from a paired phone (Settings › Credentials)." : undefined));
    // What a bot's shell finds: the service asked it of itself, in the way a bot's shell does (desktop/terminal/reach.mjs).
    if (seen.botShell) checks.push(check("A bot's shell", seen.botShell.ok, seen.botShell.ok ? "Finds `botkins` at " + seen.botShell.launcher + ", and it reaches this service (process " + seen.botShell.pid + ")." : seen.botShell.problem, seen.botShell.ok ? undefined : "Restart Botkins: it makes the command and BOTKINS_SOCKET for its bots when it starts."));
    checks.push(check("Phone link", seen.link.locked ? false : seen.link.enabled ? seen.link.listening : null, seen.link.locked ? "The link's identity can't be opened with this host key, so phone access is off." : !seen.link.enabled ? "Phone access is off." : seen.link.listening ? "Listening on port " + seen.link.port + "." : "Phone access is on, and the link is not listening on port " + (config?.link.port ?? "") + ".", seen.link.enabled && !seen.link.listening ? "Another program may hold the port. See `botkins logs`, or choose another with `botkins config set link.port`." : !seen.link.enabled ? "`botkins config set link.enabled true`" : undefined));
    for (const provider of seen.providers) {
      if (!provider.enabled) continue;
      const ok = provider.error ? false : provider.connected ? true : null;
      checks.push(check("Provider: " + provider.name, ok, provider.error ? provider.error : !provider.installed ? (provider.message ?? "Its command-line tool isn't installed.") : provider.connected ? "Signed in" + (provider.account ? " as " + provider.account : "") + (provider.plan ? " (" + provider.plan + ")" : "") + "." : (provider.message ?? "Signed out."), provider.connected || provider.error ? undefined : provider.installed ? "`botkins providers login " + provider.id + "`" : undefined));
    }
    if (!seen.providers.some((provider) => provider.enabled && provider.connected)) checks.push(check("Model providers", false, "No provider is signed in, so no bot can answer.", "Sign one in with `botkins providers login <provider>`."));
  } else if (config) {
    const free = await freePort(config.link.port);
    checks.push(check("Phone link port", free ? true : null, "Port " + config.link.port + (free ? " is free." : " is in use by another program.") , free ? undefined : "Choose another with `botkins config set link.port`."));
  }
  // The install folder of the whole computer's service: root's own, all the way up, or no update is installed into it.
  const folder = installFolder?.();
  if (folder) {
    const words = folder.problem && notRootOwnedWords(folder.problem, folder.root);
    checks.push(check("Install folder", !folder.problem, folder.problem ? words.replace(/ On the computer: .*$/, "") + " No update is installed until it is put right." : folder.root + " and every folder above it are root's own, so updates can be installed.", folder.problem ? /On the computer: `(.*)`\.$/.exec(words)?.[1] : undefined));
  }
  // The installed service's files: the ones this version writes, or older ones. An update brings
  // them up to date; one done by a version from before that, or one that couldn't, leaves them.
  if (units) {
    try {
      const state = await units();
      const kept = state.kept ?? [];
      if (state.changed.length || !kept.length) checks.push(check("Service files", state.changed.length === 0, state.changed.length ? "Not the ones this version of Botkins writes: " + state.changed.join(", ") + ". The service runs under what an earlier version wrote." : state.file + " is as this version of Botkins writes it.", state.changed.length ? "`" + (state.scope === "system" ? "sudo " : "") + "botkins service refresh` writes them and keeps what was chosen at install." : undefined));
      // A file with a setting of the person's own is theirs to keep: no update replaces it, so it may be an earlier version's.
      for (const entry of kept) checks.push(check("Service file " + entry.file, null, "It holds settings that Botkins did not write (" + entry.lines.slice(0, 3).join("; ") + (entry.lines.length > 3 ? "; and " + (entry.lines.length - 3) + " more" : "") + "), so no update replaces it, and it may be as an earlier version wrote it.", state.kind === "systemd" ? "Environment variables and folders for bots are kept by an update. Put anything else in `systemctl " + (state.scope === "user" ? "--user " : "") + "edit botkins.service`, which every update keeps, take it out of the file, and run `" + (state.scope === "system" ? "sudo " : "") + "botkins service refresh`." : "Environment variables are kept by an update. For anything else: `botkins service install` writes the file anew."));
    } catch (error) {
      if (error.code !== "NOT_INSTALLED") checks.push(check("Service files", null, error.message, "`botkins service install`, with the options it was first installed with, writes it anew."));
    }
  }
  // The relay: whether this computer can reach it at all. Nothing of the workspace is sent.
  if (config) {
    const url = (seen?.relay.url ?? config.relay.url).replace(/\/+$/, "");
    const wanted = seen ? seen.relay.enabled : config.relay.enabled;
    try {
      const response = await fetcher(url + "/", { signal: AbortSignal.timeout(6000), redirect: "manual" });
      const connected = seen?.relay.connected === true;
      checks.push(check("Relay", !wanted ? null : seen ? connected : true, new URL(url).host + " answers (HTTP " + response.status + "). " + (!wanted ? "The relay is off: phones reach this host on its own network only." : seen ? (connected ? "This host is connected to it." : "This host is not connected to it yet.") : "It is switched on."), wanted ? undefined : "`botkins relay on` lets a phone reach this host from another network."));
    } catch (error) {
      checks.push(check("Relay", wanted ? false : null, new URL(url).host + " can't be reached from this computer (" + (error.cause?.code ?? error.name) + ").", wanted ? "Check this computer's outgoing HTTPS access." : undefined));
    }
  }
  return { ok: checks.every((entry) => entry.ok !== false), user: userInfo().username, dataDir: paths.root, checks, ...(seen && { desktopOnly: seen.desktopOnly }) };
}

export const service = {
  serve: {
    summary: "Run the Botkins service in the foreground (what the service unit runs)",
    usage: "botkins serve [--trial]",
    options: { trial: { type: "boolean", about: "A run on a folder of its own: no key store, nothing announced, nothing sent through the relay" } },
    details: "Stops on Ctrl-C or SIGTERM. To keep it running across restarts, install it as a service: `botkins service install`.",
    async run(context) {
      const { startService } = await import("../../desktop/terminal/serve.mjs");
      // Everything the service writes is its user's own.
      process.umask(0o077);
      const trial = context.options.trial === true || context.env.BOTKINS_TRIAL === "1";
      const { terminalUpdates } = await import("../../desktop/terminal/updates.mjs").catch(() => ({}));
      const running = await startService({ paths: context.paths, version: context.version, trial, reach: true, out: context.env.BOTKINS_QUIET === "1" ? undefined : (line) => context.stdout.write(line), console: true, updates: terminalUpdates, env: context.env });
      return new Promise((resolve) => {
        let asked = false;
        // The service has saved its work and closed what it had open. The process ends now, even
        // if something a provider's library started is still there: a service manager that asked
        // for a stop gets one, with a clean exit, and never has to kill it.
        const leave = (code) => {
          resolve(code);
          setTimeout(() => process.exit(code), 100).unref();
        };
        const stop = (signal) => {
          // A second Ctrl-C doesn't wait.
          if (asked) process.exit(130);
          asked = true;
          running.stop(signal).then(() => leave(EXIT.ok));
        };
        process.on("SIGINT", () => stop("SIGINT"));
        process.on("SIGTERM", () => stop("SIGTERM"));
        process.on("uncaughtException", (error) => {
          running.log.error("Unexpected error: " + (error?.stack ?? error));
          running.stop("an unexpected error").then(() => leave(EXIT.failed));
        });
        process.on("unhandledRejection", (error) => running.log.error("Unhandled: " + (error?.stack ?? error)));
        // `botkins stop` and the control call end the service from inside.
        const watch = setInterval(() => {
          const stopped = running.stopped();
          if (!stopped) return;
          clearInterval(watch);
          stopped.then(() => leave(EXIT.ok));
        }, 200);
        watch.unref();
      });
    },
  },
  status: {
    summary: "Show whether the service runs, and what it is doing",
    usage: "botkins status",
    async run(context) {
      let status;
      try {
        status = await context.client.call("status");
      } catch (error) {
        if (error.code !== "NOT_RUNNING") throw error;
        context.print({ running: false, dataDir: context.paths.root, socket: context.paths.socket }, "Botkins is not running (data folder " + context.paths.root + ").\n" + (launchedByApp(context.env) ? OPEN_THE_APP : "Start it with `botkins service start`, or `botkins serve` in another terminal."));
        return EXIT.notRunning;
      }
      context.print(status, () => {
        const { color } = context;
        const relay = !status.relay.enabled ? "off" : status.relay.connected ? "connected" : "on, not connected" + (status.relay.problem ? " (" + status.relay.problem + ")" : "");
        return [
          color.bold("Botkins " + status.version) + "  " + color.green("running") + " for " + duration(status.uptimeSeconds) + "  (pid " + status.pid + ", Node.js " + status.node + ", " + status.platform + ")",
          "",
          table(["", ""], [
            ["Phone link", !status.link.enabled ? "off" : status.link.listening ? "“" + status.link.name + "” on port " + status.link.port + (status.link.addresses.length ? "  (" + status.link.addresses.join(", ") + ")" : "") : "on, not listening (see `botkins logs`)"],
            ["Relay", relay],
            ["Devices", status.link.devices + " paired, " + status.link.connected + " connected" + (status.link.pairing ? "  (a pairing code is open)" : "")],
            ...(status.nodeHost?.enabled
              ? [
                  ["Node host", "“" + status.nodeHost.name + "” · " + (status.nodeHost.paused ? "Paused" : "Online")],
                  ["Shared folders", status.nodeHost.sharedProjects?.length ? status.nodeHost.sharedProjects.map((project) => project.name).join(", ") : "none"],
                  ...(status.nodeHost.lastCompleted
                    ? [["Last node job", status.nodeHost.lastCompleted.sourceBotName + " on " + status.nodeHost.lastCompleted.sourceHostName + " · " + status.nodeHost.lastCompleted.operation + " (" + status.nodeHost.lastCompleted.resourceName + ")"]]
                    : []),
                ]
              : []),
            ["Workspace", status.workspace.bots + " bots, " + status.workspace.chats + " chats, " + status.workspace.routines + " routines" + (status.workspace.working ? ", " + status.workspace.working + " working" : "") + (status.workspace.waiting ? ", " + status.workspace.waiting + " waiting for an answer" : "")],
            ["Secrets", status.vault.locked ? color.red("vault locked") : "wrapped by the " + status.secrets.where],
            ["Memory", status.memory.rssMb + " MB"],
            // How the install that left this version ended, with what it had to say.
            ...(status.update?.last ? [["Last update", status.update.last.ok ? "from " + status.update.last.from + " to " + status.update.last.to + (status.update.last.message ? ". " + status.update.last.message : "") : (status.update.last.message ?? "The update to " + status.update.last.to + " didn't finish, so " + status.update.last.from + " is back.")]] : []),
            ["Data folder", status.dataDir],
          ]).split("\n").slice(1).join("\n"),
        ].join("\n");
      });
    },
  },
  logs: {
    summary: "Show the service's log",
    usage: "botkins logs [-f] [-n <lines>]",
    options: { follow: { type: "boolean", short: "f", about: "Keep showing new lines as they come" }, lines: { type: "string", short: "n", value: "count", about: "How many of the last lines to show (50)" } },
    async run(context) {
      const count = Number(context.options.lines ?? 50);
      if (!Number.isInteger(count) || count < 0 || count > 100000) throw new CliError("--lines takes a number from 0 to 100000.", EXIT.usage);
      const show = (entry) => context.line(entry, entry.time + " " + (entry.level === "error" ? context.color.red(entry.level.padEnd(5)) : entry.level.padEnd(5)) + " " + entry.text);
      let read;
      try {
        read = await context.client.call("logs.read", { tail: count });
      } catch (error) {
        if (error.code !== "NOT_RUNNING") throw error;
        // The service is stopped, so its log file is nobody's to hold: the last lines come from it.
        const entries = tailFile(context.paths.logFile, count);
        if (context.options.follow) throw new CliError("Botkins is not running, so there is nothing to follow. Its last lines are in " + context.paths.logFile + ".", EXIT.notRunning, "NOT_RUNNING");
        if (context.json) return void context.print(entries);
        if (!entries.length) return void context.note("Botkins is not running, and has no log yet (" + context.paths.logFile + ").");
        return void entries.forEach(show);
      }
      if (context.json && !context.options.follow) return void context.print(read.entries);
      read.entries.forEach(show);
      if (!context.options.follow) return;
      for (let after = read.next; ; ) {
        let more;
        try {
          more = await context.client.call("logs.read", { after, wait: true });
        } catch (error) {
          if (error.code === "NOT_RUNNING") return void context.note("The service stopped.");
          throw error;
        }
        more.entries.forEach(show);
        after = more.next;
      }
    },
  },
  doctor: {
    summary: "Check this computer and the service, and say what to fix",
    usage: "botkins doctor",
    details: "Checks Node.js, the data folder's permissions, the config, the control socket, the phone link's port, the install folder of the whole computer's service, the installed service's files, whether the relay can be reached and each provider's sign-in. Exits 1 when something needs fixing.",
    async run(context) {
      // Only the whole computer's service is updated by root, so only its install folder has to be root's own.
      const installFolder = () => {
        const layout = installLayout(fileURLToPath(new URL("../botkins.mjs", import.meta.url)));
        return layout && serviceManager({ command: [], env: context.env }).installed()?.scope === "system" ? { root: layout.installRoot, problem: notRootOwned(layout.installRoot) } : null;
      };
      const report = await examine({ paths: context.paths, client: context.client, env: context.env, installFolder, units: () => serviceManager({ command: [], env: context.env }).refresh({ write: false }) });
      context.print(report, () => {
        const { color } = context;
        const lines = report.checks.map((entry) => {
          const mark = entry.ok === true ? color.green("ok  ") : entry.ok === false ? color.red("FAIL") : color.yellow("note");
          return mark + "  " + color.bold(entry.name) + ": " + entry.detail + (entry.fix ? "\n      " + color.dim("→ " + entry.fix) : "");
        });
        const failed = report.checks.filter((entry) => entry.ok === false).length;
        lines.push("", failed ? color.red(failed + (failed === 1 ? " thing needs" : " things need") + " fixing.") : color.green("Nothing needs fixing."));
        if (report.desktopOnly) lines.push("", "Not available on a terminal host (use the desktop app for these):", ...report.desktopOnly.map((item) => "  - " + item));
        return lines.join("\n");
      });
      return report.ok ? EXIT.ok : EXIT.failed;
    },
  },
  stop: {
    summary: "Stop a service started by hand with `botkins serve`",
    usage: "botkins stop",
    details: "A service installed with `botkins service install` is stopped with `botkins service stop`, so its service manager doesn't start it again.",
    async run(context) {
      context.print(await context.client.call("stop"), "Botkins is stopping.");
    },
  },
};
