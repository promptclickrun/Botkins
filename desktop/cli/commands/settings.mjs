// The host's own settings (config.json) and updates.
import { existsSync } from "node:fs";
import { loadConfig, parseValue, read, saveConfig, SETTINGS, validate, withSetting, changed } from "../../desktop/terminal/config.mjs";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { ask, edit } from "./input.mjs";
import { ownCommand } from "./install.mjs";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { latestRelease } from "../../desktop/updates.mjs";
import { serviceManager } from "../../desktop/terminal/manager.mjs";
import { applyUpdate, assetName, installLayout, takeRequest, writeLastUpdate } from "../../desktop/terminal/update-install.mjs";
import { REQUEST } from "../../desktop/terminal/updates.mjs";

/**
 * The config through the running service, or straight from the file when no service holds it.
 * (While the service runs it is the only one that touches the data folder's files.)
 */
async function store(context) {
  if (await context.client.running())
    return {
      live: true,
      get: () => context.client.call("config.get"),
      replace: (next) => context.client.call("config.replace", next),
    };
  return {
    live: false,
    get: async () => loadConfig(context.paths.config),
    replace: async (next) => {
      const before = loadConfig(context.paths.config);
      const saved = saveConfig(context.paths.config, next);
      return { changed: changed(before, saved), restart: [] };
    },
  };
}
const said = (result, live) => (!result.changed.length ? "Nothing changed." : "Saved: " + result.changed.join(", ") + "." + (result.restart.length ? "\n" + result.restart.join(", ") + (result.restart.length === 1 ? " takes" : " take") + " effect when the service restarts (`botkins service restart`)." : live ? "" : "\nThe service is not running: it reads this when it starts."));

export const settings = {
  config: {
    summary: "Read and change this host's settings",
    details: "Settings are in config.json in the data folder, checked whole before they are saved. Bots, chats and routines are not here: see `botkins bots` and `botkins routines`.",
    commands: {
      get: {
        summary: "Show every setting, or one",
        usage: "botkins config get [<setting>]",
        async run(context) {
          const config = await (await store(context)).get();
          const [key] = context.args;
          if (key !== undefined) {
            if (!Object.hasOwn(SETTINGS, key)) throw new CliError(key + " is not a setting. Run `botkins config get` to see them all.", EXIT.failed, "NOT_FOUND");
            const value = read(config, key);
            return void context.print(value, typeof value === "string" ? value : JSON.stringify(value));
          }
          context.print(config, () => table(["SETTING", "VALUE", "WHAT IT IS"], Object.entries(SETTINGS).map(([name, setting]) => [name, JSON.stringify(read(config, name)), setting.about + (setting.restart ? " (restart)" : "")])));
        },
      },
      set: {
        summary: "Change one setting",
        usage: "botkins config set <setting> <value>",
        details: "Examples: `botkins config set name \"Studio server\"`, `botkins config set link.port 47611`, `botkins config set link.addresses server.example.com`.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the setting and its new value.");
          const [key, raw] = context.args;
          const config = await store(context);
          let next;
          try {
            next = withSetting(await config.get(), key, parseValue(key, raw));
          } catch (error) {
            throw new CliError(error.message, EXIT.failed, "INVALID_CONFIG");
          }
          const result = await config.replace(next);
          context.print({ ...result, value: read(next, key) }, said(result, config.live));
        },
      },
      edit: {
        summary: "Open the settings in your editor",
        usage: "botkins config edit",
        details: "Uses $VISUAL, then $EDITOR, then vi. What you save is checked before it is used: a mistake is shown with its line, and nothing changes until the file is right.",
        async run(context) {
          if (!context.stdin.isTTY || context.json) throw usage("`botkins config edit` needs a terminal. Use `botkins config set` in a script.");
          const config = await store(context);
          let text = JSON.stringify(await config.get(), null, 2) + "\n";
          for (;;) {
            text = edit(context, text, "config.json");
            let problems;
            let parsed;
            try {
              parsed = JSON.parse(text);
              ({ problems } = validate(parsed));
            } catch (error) {
              problems = ["The file is not JSON: " + error.message];
            }
            if (!problems.length) {
              const result = await config.replace(parsed);
              return void context.print(result, said(result, config.live));
            }
            context.stderr.write("The settings were not saved:\n  " + problems.join("\n  ") + "\n");
            if (!/^(y(es)?|)$/i.test((await ask(context, "Edit again? [Y/n] ")).trim())) return EXIT.failed;
          }
        },
      },
      path: {
        summary: "Print where the config file is",
        usage: "botkins config path",
        async run(context) {
          context.print({ path: context.paths.config, exists: existsSync(context.paths.config) }, context.paths.config);
        },
      },
    },
  },
  update: {
    summary: "Install the latest signed release",
    usage: "botkins update [--check]",
    options: { check: { type: "boolean", about: "Only say whether there is a newer release" }, apply: { type: "boolean", about: "Install now, in this process (what the service's own update job runs)" } },
    details: "An update is taken only from the project's own releases, and only when its checksums carry the Botkins release key's signature (GnuPG checks it). The new version is unpacked beside the old one and the service restarts on it; if it doesn't stay up, the old one is put back. For the whole computer's service, run it as root (with sudo).",
    async run(context) {
      const entry = fileURLToPath(new URL("../botkins.mjs", import.meta.url));
      const layout = installLayout(entry);
      if (context.options.check) {
        let state;
        try {
          state = await context.client.call("update.check");
        } catch (error) {
          if (error.code !== "NOT_RUNNING" && error.code !== "UNSUPPORTED") throw error;
          // No service to ask: the same question, asked from here.
          const { version, assets } = await latestRelease({ token: "" });
          const newer = semver.gt(version, context.version);
          state = { status: newer ? "available" : "current", current: context.version, latest: version, canInstall: newer && !!layout && assets.includes(assetName(version, process.platform, process.arch)) };
        }
        context.print(state, state.status === "available" ? "Botkins " + state.latest + " is available (this is " + state.current + ")." + (state.canInstall ? " Install it with `botkins update`." : " " + (state.message ?? "It has no terminal host build this copy can install by itself.")) : "Botkins " + state.current + " is the latest release.");
        return;
      }
      const manager = serviceManager({ command: ownCommand(), env: context.env });
      const installed = manager.installed();
      // The service's request is taken up: left there, the watch would start this job again. This
      // is the one thing the root job does in the data folder, and it does it as that folder's owner.
      if (context.options.apply) takeRequest(context.paths.root, REQUEST);
      if (installed?.scope === "system" && process.getuid?.() !== 0) {
        // Not root: the service is asked, and its own root job does the installing.
        const state = await context.client.call("update.install");
        return void context.print(state, state.status === "current" ? "Botkins " + state.current + " is the latest release." : "Botkins " + state.latest + " is being installed by the service's update job. `botkins status` shows the new version once it has restarted.");
      }
      let result;
      try {
        // How it ends is left beside the versions, where the service reads it when it is back, for a phone that asked and for `botkins status`.
        result = await applyUpdate({ entry, manager: installed ? manager : undefined, say: (line) => context.note(line), report: (record) => void (layout && writeLastUpdate(layout.installRoot, record)) });
      } catch (error) {
        throw new CliError(error.message, EXIT.failed, error.code);
      }
      context.print(result, result.status === "current" ? "Botkins " + result.current + " is the latest release." : "Botkins " + result.current + " is installed (it was " + result.previous + ")." + (installed ? " The service is running on it." : " Restart `botkins serve` to use it."));
    },
  },
};
