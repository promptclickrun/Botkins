// Plugins from the command line, to the rule the window and the phone keep ("reviewed bytes",
// mobile/AGENTS.md): install and update send the `revision` of the preview that the person saw,
// and a plugin that runs commands on this computer (a hook, or a tool that is a local program) is
// shown first and needs a yes before it is installed, updated or turned on.
//
// With no terminal there is nobody to show it to. So such a plugin is looked at first
// (`botkins plugins show <id>` prints what it runs and its revision), and the command that
// installs or updates it names that revision: `--yes --revision <revision>`. The computer then
// refuses a source that changed since.
import { readFileSync } from "node:fs";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { ask, confirm, readAll } from "./input.mjs";
import { safe } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first" } };
const REVISION = { revision: { type: "string", value: "revision", about: "The revision that you looked at (`botkins plugins show <id>`). The plugin is refused when its source changed since" } };
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const count = (list, word) => (list?.length ? list.length + " " + word + (list.length === 1 ? "" : "s") : null);
/** A plugin as a person reads it before a decision: what it holds, what it runs here, what it needs, and its revision. */
function described(plugin) {
  const holds = [count(plugin.contents?.skills, "skill"), count(plugin.contents?.agents, "agent"), count(plugin.contents?.commands, "command"), count(plugin.contents?.mcpServers, "tool"), count(plugin.contents?.hooks, "hook")].filter(Boolean);
  return [
    (plugin.name ?? plugin.id) + (plugin.version ? " " + plugin.version : "") + "   " + plugin.id + (plugin.installed ? "   (installed" + (plugin.enabled === false ? ", off" : "") + ")" : ""),
    plugin.description ?? null,
    "Holds: " + (holds.length ? holds.join(", ") : "nothing that Botkins uses") + ".",
    ...(plugin.runs.length
      ? ["Runs on this computer, as the user that runs Botkins:", ...plugin.runs.map((run) => "  " + (run.what === "hook" ? "at " + run.when + ": " : "the tool " + run.name + ": ") + run.command)]
      : ["Runs nothing on this computer."]),
    ...(plugin.contents?.mcpServers ?? []).filter((server) => server.kind === "remote").map((server) => "Reaches: " + server.url + (server.oauth ? " (signs in)" : "")),
    ...(plugin.config?.length ? ["Settings: " + plugin.config.map((field) => field.key + (field.required ? " (needed)" : "") + (field.secret ? " (secret)" : "") + (field.set === true ? " ✓" : "")).join(", ")] : []),
    ...(plugin.status && plugin.status !== "ready" ? ["State: " + plugin.status + (plugin.detail ? " (" + plugin.detail + ")" : "")] : []),
    ...(plugin.warnings ?? []).map((warning) => "Note: " + warning),
    plugin.revision ? "Revision: " + plugin.revision : null,
  ]
    .filter(Boolean)
    // (A plugin's own words are shown as they can be: a character that would hide or move text is written as its number.)
    .map(safe)
    .join("\n");
}
/** What must be seen is written to standard error whatever --json is, as for a tool that is a program. */
const show = (context, text) => void context.stderr.write(text + "\n");
/**
 * The yes for a plugin that runs commands here. At a terminal: the plugin is shown and the
 * person is asked (or said --yes). With no terminal: --yes with the revision that was looked at.
 * A plugin that runs nothing needs no yes.
 */
async function allowed(context, plugin, verb) {
  if (!plugin.runs.length) return true;
  show(context, described(plugin));
  const terminal = context.stdin.isTTY && !context.json;
  if (!terminal && !(context.options.yes && context.options.revision))
    throw usage("This plugin runs commands on this computer. Look at it with `botkins plugins show " + plugin.id + "`, then run this again with --yes --revision <its revision>.");
  return confirm(context, verb + " it and let it run these on this computer?");
}
/** A plugin's settings from --settings (a JSON file of { KEY: value }, or "-" for standard input). A value is never a word on the command line. */
async function settingsFile(context) {
  const path = context.options.settings;
  if (path === undefined) return undefined;
  let text;
  try {
    text = path === "-" ? await readAll(context.stdin) : readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The settings file " + path + " can't be read: " + error.message);
  }
  let values;
  try {
    values = JSON.parse(text);
  } catch {
    values = null;
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new CliError("The settings are not JSON. Give { \"KEY\": \"value\" }.");
  return values;
}
const SETTINGS = { settings: { type: "string", value: "path", about: "A JSON file with the plugin's settings: { \"KEY\": \"value\" }. \"-\" reads standard input. A value is never a word on the command line" } };
const needs = (plugin) => (plugin.config ?? []).filter((field) => field.required && field.set !== true).map((field) => field.key);

/** These replace `install`, `update` and `enable` of the plugin commands and add the rest (cli/commands/workspace.mjs has list, browse and the marketplaces). */
export const pluginCommands = {
  show: {
    summary: "Show a plugin: what it holds, what it runs on this computer, and its revision",
    usage: "botkins plugins show <id>",
    details: "For a plugin that is not installed, give its id from `botkins plugins browse` (name@marketplace). What is shown is its source as it is now; an install with `--revision` is refused when the source changed since.",
    async run(context) {
      const id = one(context, "Name the plugin by its id (see `botkins plugins browse` and `botkins plugins list`).");
      // The source as it is now, with the installed plugin's own state beside it when there is one.
      const installed = await context.client.call("plugins.get", id).catch(() => null);
      const preview = await context.client.call("plugins.preview", installed?.id ?? id).catch((error) => {
        if (installed) return null;
        throw error;
      });
      const plugin = installed ? { ...installed, ...(preview && { source: { revision: preview.revision, runs: preview.runs, changed: preview.revision !== installed.revision } }) } : preview;
      context.print(plugin, (shown) => described(shown) + (shown.source?.changed ? "\nIts source changed since it was installed. `botkins plugins update " + shown.id + "` shows what is new." : ""));
    },
  },
  install: {
    summary: "Install a plugin, for every bot or for the bots you name",
    usage: "botkins plugins install <id> [--bot <bot>]… [--settings <path>] [--revision <revision>] [--yes]",
    options: { bot: { type: "string", multiple: true, value: "bot", about: "A bot that gets the plugin, by name or id. Give it again for each one (every bot without it)" }, ...SETTINGS, ...REVISION, ...YES },
    details: "A plugin that runs commands on this computer is shown first and needs your yes. With no terminal, look at it with `botkins plugins show <id>` and give `--yes --revision <its revision>`.",
    async run(context) {
      const id = one(context, "Name the plugin by its id (see `botkins plugins browse`).");
      const o = context.options;
      const preview = await context.client.call("plugins.preview", id);
      if (o.revision !== undefined && o.revision !== preview.revision) throw new CliError("This plugin changed after the revision that you looked at. Look at it again: `botkins plugins show " + id + "`.");
      if (!(await allowed(context, preview, "Install"))) return EXIT.failed;
      const config = await settingsFile(context);
      const plugin = await context.client.call("plugins.install", id, { revision: preview.revision, ...(o.bot?.length && { bots: o.bot }), ...(config && { config }) });
      context.print(plugin, (now) => "Installed " + (now.name ?? now.id) + "." + (needs(now).length ? " It needs settings before it works: " + needs(now).join(", ") + ". Give them with `botkins plugins configure " + now.id + "`." : ""));
    },
  },
  update: {
    summary: "Update an installed plugin to its source as it is now",
    usage: "botkins plugins update <id> [--revision <revision>] [--yes]",
    options: { ...REVISION, ...YES },
    details: "The new source is shown first when it runs commands on this computer, as for an install.",
    async run(context) {
      const before = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name, see `botkins plugins list`)."));
      const preview = await context.client.call("plugins.preview", before.id);
      const o = context.options;
      if (o.revision !== undefined && o.revision !== preview.revision) throw new CliError("This plugin changed after the revision that you looked at. Look at it again: `botkins plugins show " + before.id + "`.");
      if (preview.revision === before.revision) return void context.print(before, () => (before.name ?? before.id) + " is up to date.");
      if (!(await allowed(context, preview, "Update"))) return EXIT.failed;
      context.print(await context.client.call("plugins.update", before.id, { revision: preview.revision }), (now) => "Updated " + (now.name ?? now.id) + "." + (needs(now).length ? " It needs settings: " + needs(now).join(", ") + "." : ""));
    },
  },
  enable: {
    summary: "Switch an installed plugin on",
    usage: "botkins plugins enable <id> [--yes]",
    options: YES,
    details: "A plugin that runs commands on this computer is shown before it is switched on, and needs your yes.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      if (plugin.enabled === false && plugin.runs.length) {
        show(context, described(plugin));
        if (!(await confirm(context, "Switch it on and let it run these on this computer?"))) return EXIT.failed;
      }
      await context.client.call("plugins.setEnabled", plugin.id, true);
      context.print(await context.client.call("plugins.get", plugin.id), (now) => (now.name ?? now.id) + " is on.");
    },
  },
  configure: {
    summary: "Give a plugin its settings",
    usage: "botkins plugins configure <id> [--settings <path>] [--unset <KEY>]…",
    options: { ...SETTINGS, unset: { type: "string", multiple: true, value: "KEY", about: "Take a setting's value away" } },
    details: "At a terminal, with no option, each setting is asked for; a secret one is not shown as you type, and an empty answer keeps what is stored. No command prints a setting's value: `botkins plugins show` says which ones have one.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      const o = context.options;
      let values = (await settingsFile(context)) ?? {};
      if (o.settings === undefined && !o.unset?.length) {
        if (!plugin.config?.length) return void context.print(plugin, () => (plugin.name ?? plugin.id) + " has no settings.");
        if (!context.stdin.isTTY || context.json) throw usage("Give the settings in a JSON file with --settings <path>, or --settings - to read it from standard input. It can set: " + plugin.config.map((field) => field.key).join(", ") + ".");
        values = {};
        for (const field of plugin.config) {
          const typed = await ask(context, field.label + (field.secret ? " (not shown)" : "") + (field.set ? " [Enter keeps it]" : field.required ? " (needed)" : "") + ": ", { hidden: field.secret });
          if (typed) values[field.key] = typed;
        }
      }
      for (const key of o.unset ?? []) values[key] = null;
      if (!Object.keys(values).length) return void context.note("Nothing changed.");
      await context.client.call("plugins.configure", plugin.id, values);
      context.print(await context.client.call("plugins.get", plugin.id), (now) => "Saved." + (needs(now).length ? " Still needed: " + needs(now).join(", ") + "." : ""));
    },
  },
  bots: {
    summary: "Say which bots have a plugin",
    usage: "botkins plugins bots <id> (--all | --bot <bot>…)",
    options: { all: { type: "boolean", about: "Every bot, and each new one" }, bot: { type: "string", multiple: true, value: "bot", about: "A bot that has it, by name or id. Give it again for each one; these replace the list" } },
    arguments: [{ name: "id", required: true }],
    async run(context) {
      const id = one(context, "Name the plugin (its id or name).");
      const o = context.options;
      if ((o.all === true) === (o.bot?.length > 0)) throw usage("Give --all, or --bot for each bot that has the plugin.");
      context.print(await context.client.call("plugins.setBots", id, o.all ? "all" : o.bot), (now) => (now.name ?? now.id) + " is for " + (now.bots === "all" ? "every bot" : now.bots.length + " bot" + (now.bots.length === 1 ? "" : "s")) + ".");
    },
  },
  "add-folder": {
    summary: "Add a plugin from a folder on this computer, switched off",
    usage: "botkins plugins add-folder <path>",
    details: "Give the folder's full path. The plugin is added switched off, so nothing of it runs. What it would run is shown; `botkins plugins enable <id>` switches it on after your yes.",
    async run(context) {
      const added = await context.client.call("plugins.addFolder", one(context, "Give the folder's full path."));
      const plugin = await context.client.call("plugins.get", added.id);
      context.print(plugin, (now) => described(now) + "\nAdded, and switched off. Switch it on with `botkins plugins enable " + now.id + "`.");
    },
  },
  "sign-out": {
    summary: "Forget the sign-ins of a plugin's tools",
    usage: "botkins plugins sign-out <id>",
    details: "A tool on the web signs in through a browser, which this command line does not have. Sign it in from a paired phone or from the app's window.",
    async run(context) {
      context.print(await context.client.call("plugins.signOut", one(context, "Name the plugin (its id or name).")), (done) => (done.signedOut ? (done.name ?? done.id) + " is signed out." : (done.name ?? done.id) + " has no tool that signs in."));
    },
  },
};
