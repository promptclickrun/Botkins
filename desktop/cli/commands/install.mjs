// `botkins service …`: the service as the computer's own (systemd on Linux, launchd on macOS).
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceManager } from "../../desktop/terminal/manager.mjs";
import { CliError, EXIT, table } from "../output.mjs";
import { confirm } from "./input.mjs";

/**
 * How this copy of `botkins` is started, for a service file. A copy installed from a release sits
 * in <install folder>/<version>/ with <install folder>/current pointing at it: the service is
 * started through `current`, so an update needs no new service file. A checkout is started with
 * Node and this file.
 */
export function ownCommand({ entry = fileURLToPath(new URL("../botkins.mjs", import.meta.url)), node = process.execPath } = {}) {
  const real = realpathSync(entry);
  const version = dirname(dirname(real));
  const current = join(dirname(version), "current");
  try {
    if (lstatSync(current).isSymbolicLink() && realpathSync(current) === version && existsSync(join(version, "bin", "botkins"))) return [join(current, "bin", "botkins")];
  } catch {
    // Not a release install.
  }
  return [node, real];
}

const manager = (context) => serviceManager({ command: ownCommand(), env: context.env, say: (line) => context.note(line) });
const fail = (error) => {
  throw new CliError(error.message, error.code === "NEEDS_ROOT" ? EXIT.denied : EXIT.failed, error.code);
};
const act = (verb, done) => ({
  summary: done.summary,
  usage: "botkins service " + verb,
  async run(context) {
    await manager(context)[verb]().catch(fail);
    context.print({ ok: true }, done.said);
  },
});

export const install = {
  service: {
    summary: "Install Botkins as a service that starts with the computer, and start or stop it",
    details: "On Linux this is a systemd unit; on macOS a launchd job. As root the service is the whole computer's and runs as its own user; otherwise it is yours alone.",
    commands: {
      install: {
        summary: "Install the service and start it",
        usage: "botkins service install [--system | --user] [--run-as <user>] [--allow-path <dir>]… [--encrypted-key] [--no-start]",
        options: {
          system: { type: "boolean", about: "For the whole computer (needs root). The default as root" },
          user: { type: "boolean", about: "For you alone, kept running while you are signed out. The default otherwise" },
          "run-as": { type: "string", value: "user", about: "The user the whole computer's service runs as (Linux: botkins, made when missing)" },
          "allow-path": { type: "string", multiple: true, value: "dir", about: "Linux, whole computer: one more folder bots may write to, such as a project folder" },
          "encrypted-key": { type: "boolean", about: "Linux, whole computer: encrypt the host key to this machine with systemd-creds (its TPM when it has one)" },
          "no-start": { type: "boolean", about: "Write the service's files without starting it" },
        },
        details: "Installing again is safe: the service's files are written anew, and the data folder, the paired phones and the host key are left as they are.",
        async run(context) {
          const { options } = context;
          if (options.system && options.user) throw new CliError("Choose --system or --user.", EXIT.usage);
          const result = await manager(context)
            // A data folder named on purpose (--data-dir, or BOTKINS_DATA_DIR) is the one the service is installed on.
            .install({ ...(options.system && { scope: "system" }), ...(options.user && { scope: "user" }), ...(context.paths.scope === "custom" && { dataDir: context.paths.root }), runAs: options["run-as"], allowPaths: options["allow-path"] ?? [], encryptedKey: options["encrypted-key"] === true, start: options["no-start"] !== true })
            .catch(fail);
          context.print(result, () =>
            [
              "Botkins is installed as a service" + (result.scope === "system" ? " for the whole computer" : " for " + result.user) + (options["no-start"] ? "." : " and started."),
              "",
              table(["", ""], [["Service file", result.file], ["Runs as", result.user], ["Data folder", result.dataDir], ["Host key", result.key]]).split("\n").slice(1).join("\n"),
              ...(result.note ? ["", result.note] : []),
              // The installer says what comes next in its own words.
              ...(context.env.BOTKINS_INSTALLER === "1" ? [] : ["", "Next: `botkins status`, then `botkins providers login <provider>` and `botkins pair`."]),
            ].join("\n"),
          );
        },
      },
      uninstall: {
        summary: "Stop the service and remove its files (the data stays)",
        usage: "botkins service uninstall [--yes]",
        options: { yes: { type: "boolean", short: "y", about: "Don't ask first" } },
        async run(context) {
          if (!(await confirm(context, "Stop Botkins and remove it from this computer's services? Its data folder stays."))) return EXIT.failed;
          const removed = await manager(context).uninstall().catch(fail);
          context.print(removed, "The service is removed. The data folder (" + context.paths.root + ") and the host key are still there.");
        },
      },
      start: act("start", { summary: "Start the service", said: "Botkins is starting. `botkins status` shows it." }),
      stop: act("stop", { summary: "Stop the service", said: "Botkins is stopped." }),
      restart: act("restart", { summary: "Restart the service", said: "Botkins is restarting. `botkins status` shows it." }),
      status: {
        summary: "Show what the computer's service manager says about the service",
        usage: "botkins service status",
        async run(context) {
          const status = await manager(context).status();
          context.print(status, !status.installed ? "Botkins isn't installed as a service here. Install it with `botkins service install`." : "Installed (" + status.kind + ", " + (status.scope === "system" ? "the whole computer" : "this user") + "): " + status.file + "\n" + (status.active ? "Running" + (status.pid ? " (pid " + status.pid + ")" : "") : "Not running") + " — " + status.state + (status.enabled ? ", starts with the computer" : ", doesn't start by itself") + (status.restarts ? ", restarted " + status.restarts + " times" : "") + ".");
          return status.installed && status.active ? EXIT.ok : EXIT.notRunning;
        },
      },
    },
  },
};
