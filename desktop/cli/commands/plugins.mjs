// Plugins from the command line, to the rule the window and the phone keep ("reviewed bytes",
// mobile/AGENTS.md): install and update send the `revision` of the preview that the person saw,
// and a plugin that runs commands on this computer (a hook, or a tool that is a local program) is
// shown first and needs a yes before it is installed, updated or turned on.
//
// The yes is one of two things, on every path:
//  - a person's answer to the question, at a terminal, after the plugin was shown;
//  - `--yes` WITH `--revision`: the word of a caller that says it looked, which must name what it
//    looked at. `--yes` alone is refused, also at a terminal: an agent's harness often gives a
//    terminal, so a terminal does not mean a person.
// What a plugin runs comes from its description (`runs`, desktop/terminal/control-plugins.mjs),
// and the description is what the app starts (desktop/plugin-reading.mjs). Every word of a
// plugin's own text goes through `safe` before it is printed.
import { readFileSync } from "node:fs";
import { CliError, EXIT, usage } from "../output.mjs";
import { ask, confirm, readAll } from "./input.mjs";
import { safe, shown } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first. For a plugin that runs commands on this computer it needs --revision too" } };
const REVISION = { revision: { type: "string", value: "revision", about: "The revision that you looked at (`botkins plugins show` prints it). The plugin is refused when it is another one now" } };
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const count = (list, word) => (list?.length ? list.length + " " + word + (list.length === 1 ? "" : "s") : null);
const called = (plugin) => safe(plugin.name ?? plugin.id);
/** One thing that a plugin runs here, whole: a hook's command, or a tool's line with every word, then its folder and the names of its environment values. */
const runLines = (run) => [
  "  " + (run.what === "hook" ? "at " + safe(run.when) + ": " + safe(run.command) : "the tool " + safe(run.name) + ": " + shown([run.command, ...(run.args ?? [])])),
  ...(run.cwd ? ["      in the folder " + JSON.stringify(safe(run.cwd))] : []),
  ...(run.env?.length ? ["      with the environment values " + run.env.map(safe).join(", ")] : []),
];
const reachLine = (reach) => "  the tool " + safe(reach.name) + ": " + safe(reach.url) + (reach.headers?.length ? ", with the headers " + reach.headers.map(safe).join(", ") : "") + (reach.signsIn ? " (signs in)" : "");
/** Where a setting's value goes: the environment names and the headers that get it. */
const goesTo = (field) =>
  field.sentTo?.length
    ? field.sentTo.map((place) => (place.header ? "the header " + safe(place.header) + " of the tool " + safe(place.tool) + " at " + safe(place.url) : "the environment value " + safe(place.env) + (place.hook ? " of the hook at " + safe(place.hook) : " of the tool " + safe(place.tool)))).join("; ")
    : "no tool and no hook of the plugin";
const settingLine = (field) => "  " + safe(field.key) + [field.required && "needed", field.secret && "secret", field.set === true && "has a value"].filter(Boolean).map((word) => " (" + word + ")").join("") + ": goes to " + goesTo(field);
/** A plugin as a person reads it before a decision: what it holds, what it runs here, where it reaches, what it needs, and its revision. */
function described(plugin) {
  const holds = [count(plugin.contents?.skills, "skill"), count(plugin.contents?.agents, "agent"), count(plugin.contents?.commands, "command"), count(plugin.contents?.mcpServers, "tool"), count(plugin.contents?.hooks, "hook")].filter(Boolean);
  const source = plugin.source;
  return [
    called(plugin) + (plugin.version ? " " + safe(plugin.version) : "") + "   " + safe(plugin.id) + (plugin.installed ? "   (installed" + (plugin.enabled === false ? ", off" : "") + ")" : ""),
    plugin.description ? safe(plugin.description) : null,
    "Holds: " + (holds.length ? holds.join(", ") : "nothing that Botkins uses") + ".",
    ...(plugin.runs?.length ? ["Runs on this computer, as the user that runs Botkins:", ...plugin.runs.flatMap(runLines)] : ["Runs nothing on this computer."]),
    ...(plugin.reaches?.length ? ["Reaches on the web:", ...plugin.reaches.map(reachLine)] : []),
    ...(plugin.config?.length ? ["Settings:", ...plugin.config.map(settingLine)] : []),
    ...(plugin.status && plugin.status !== "ready" ? ["State: " + safe(plugin.status)] : []),
    ...(plugin.detail ? ["Note: " + safe(plugin.detail)] : []),
    ...(plugin.warnings ?? []).map((warning) => "Note: " + safe(warning)),
    // An installed plugin has two revisions: the one of its installed copy, and the one of its source as it is now. An update takes the second.
    ...(plugin.installed
      ? ["Installed revision: " + safe(plugin.revision), source?.error ? "Its source cannot be read now: " + safe(source.error) : source ? (source.changed ? "Revision of its source now: " + safe(source.revision) + "   (an update takes this one)" : "Its source is the same as the installed copy.") : null]
      : [plugin.revision ? "Revision: " + safe(plugin.revision) : null]),
  ]
    .filter(Boolean)
    .join("\n");
}
/** What must be seen is written to standard error whatever --json is, as for a tool that is a program. */
const show = (context, text) => void context.stderr.write(text + "\n");
/** The sentence for a caller that cannot be asked, in the form that works for every id (an id can start with a dash). */
const look = (plugin, command) => "This plugin runs commands on this computer or reaches a new place. Look at it first: `botkins plugins show -- " + safe(plugin.id) + "`. Then give the revision that you looked at: `botkins plugins " + command + " --yes --revision=<revision> -- " + safe(plugin.id) + "`.";
/**
 * The yes for a plugin that runs commands here (or, for an update, reaches a new place).
 * `text` is what the person is shown. `revision` is the one that the yes is for.
 * A person with no --yes is asked. --yes needs --revision, and it must be that revision.
 */
async function agreed(context, plugin, { text, question, command, revision }) {
  show(context, text);
  const o = context.options;
  if (o.yes) {
    if (o.revision === undefined) throw usage("--yes needs --revision for this plugin. " + look(plugin, command));
    if (o.revision !== revision) throw new CliError("This plugin is not the one that you looked at: its revision is another one now. Look at it again: `botkins plugins show -- " + safe(plugin.id) + "`.");
    return true;
  }
  if (!context.stdin.isTTY || context.json) throw usage(look(plugin, command));
  return confirm(context, question);
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

/** What an update changes of what a plugin runs, reaches and is given: the new and changed things, and what is gone. */
function changes(before, next) {
  const same = (list, item) => list.some((other) => JSON.stringify(other) === JSON.stringify(item));
  const fresh = (now = [], then = []) => now.filter((item) => !same(then, item));
  const places = (plugin) => Object.fromEntries((plugin.config ?? []).map((field) => [field.key, JSON.stringify(field.sentTo ?? [])]));
  const [was, is] = [places(before), places(next)];
  return {
    runs: fresh(next.runs, before.runs),
    noLongerRuns: fresh(before.runs, next.runs),
    reaches: fresh(next.reaches, before.reaches),
    noLongerReaches: fresh(before.reaches, next.reaches),
    newSettings: Object.keys(is).filter((key) => !(key in was)),
    goneSettings: Object.keys(was).filter((key) => !(key in is)),
    // A setting that the person gave a value for, and that goes to another place now: the kept value would go there with nothing said.
    movedSettings: Object.keys(is).filter((key) => key in was && was[key] !== is[key]),
  };
}
function changeLines(change, next) {
  const settings = (keys) => (next.config ?? []).filter((field) => keys.includes(field.key)).map(settingLine);
  const lines = [
    ...(change.runs.length ? ["New or changed, runs on this computer:", ...change.runs.flatMap(runLines)] : []),
    ...(change.noLongerRuns.length ? ["No longer runs:", ...change.noLongerRuns.flatMap(runLines)] : []),
    ...(change.reaches.length ? ["New or changed, reaches on the web:", ...change.reaches.map(reachLine)] : []),
    ...(change.noLongerReaches.length ? ["No longer reaches:", ...change.noLongerReaches.map(reachLine)] : []),
    ...(change.movedSettings.length ? ["A setting that you gave, which goes to another place now:", ...settings(change.movedSettings)] : []),
    ...(change.newSettings.length ? ["New settings:", ...settings(change.newSettings)] : []),
    ...(change.goneSettings.length ? ["Settings that are gone: " + change.goneSettings.map(safe).join(", ")] : []),
  ];
  return lines.length ? lines : [next.runs?.length ? "It runs and reaches the same as before. Its files changed, and its commands run those files." : "It runs and reaches the same as before: nothing."];
}

/** These replace `install`, `update` and `enable` of the plugin commands and add the rest (cli/commands/workspace.mjs has list, browse and the marketplaces). */
export const pluginCommands = {
  show: {
    summary: "Show a plugin: what it holds, what it runs on this computer, where its settings go, and its revision",
    usage: "botkins plugins show <id>",
    details: "For a plugin that is not installed, give its id from `botkins plugins browse` (name@marketplace). What is shown is its source as it is now, with its revision. An installed plugin shows two revisions: the one of its installed copy, and the one of its source now. `install --revision` and `update --revision` take the revision of the source, and are refused when the source is another one by then.",
    async run(context) {
      const ref = one(context, "Name the plugin by its id (see `botkins plugins browse` and `botkins plugins list`).");
      const installed = await context.client.call("plugins.get", ref).catch((error) => {
        if (error.code === "NOT_FOUND") return null;
        throw error;
      });
      if (!installed) {
        // Not installed: the word is an id in a marketplace, or it is nothing. The refusal says which.
        const preview = await context.client.call("plugins.preview", ref).catch((error) => {
          throw ref.includes("@") ? error : new CliError("No installed plugin is called " + safe(ref) + ", and it is not the id of a plugin in a marketplace (name@marketplace). See `botkins plugins list` and `botkins plugins browse`.", EXIT.failed, "NOT_FOUND");
        });
        return void context.print(preview, described);
      }
      // The installed copy, and beside it the source as it is now. A source that cannot be read is said, not hidden.
      const source = await context.client.call("plugins.preview", installed.id).then(
        (preview) => ({ revision: preview.revision, changed: preview.revision !== installed.revision, runs: preview.runs, reaches: preview.reaches }),
        (error) => ({ error: error.message }),
      );
      context.print({ ...installed, source }, (plugin) => described(plugin) + (source.changed ? "\n`botkins plugins update -- " + safe(plugin.id) + "` shows what is new." : ""));
    },
  },
  install: {
    summary: "Install a plugin, for every bot or for the bots you name",
    usage: "botkins plugins install <id> [--bot <bot>]… [--settings <path>] [--revision <revision>] [--yes]",
    options: { bot: { type: "string", multiple: true, value: "bot", about: "A bot that gets the plugin, by name or id. Give it again for each one (every bot without it)" }, ...SETTINGS, ...REVISION, ...YES },
    details: "A plugin that runs commands on this computer is shown first and needs your yes. A caller that cannot be asked looks at it with `botkins plugins show -- <id>` and gives `--yes --revision=<its revision> -- <id>`. `--yes` with no `--revision` is refused for such a plugin, also at a terminal.",
    async run(context) {
      const id = one(context, "Name the plugin by its id (see `botkins plugins browse`).");
      const o = context.options;
      // Before anything is asked: a plugin that is installed is not installed again.
      const have = await context.client.call("plugins.get", id).catch(() => null);
      if (have?.id === id) throw new CliError(called(have) + " is installed. `botkins plugins update -- " + safe(id) + "` brings its source as it is now.");
      const preview = await context.client.call("plugins.preview", id);
      if (o.revision !== undefined && o.revision !== preview.revision) throw new CliError("This plugin is not the one that you looked at: its revision is another one now. Look at it again: `botkins plugins show -- " + safe(id) + "`.");
      if (preview.runs.length && !(await agreed(context, preview, { text: described(preview), question: "Install it and let it run these on this computer?", command: "install", revision: preview.revision }))) return EXIT.failed;
      const config = await settingsFile(context);
      const plugin = await context.client.call("plugins.install", id, { revision: preview.revision, ...(o.bot?.length && { bots: o.bot }), ...(config && { config }) });
      context.print(plugin, (now) => "Installed " + called(now) + "." + (needs(now).length ? " It needs settings before it works: " + needs(now).map(safe).join(", ") + ". Give them with `botkins plugins configure -- " + safe(now.id) + "`." : ""));
    },
  },
  update: {
    summary: "Update an installed plugin to its source as it is now",
    usage: "botkins plugins update <id> [--revision <revision>] [--yes]",
    options: { ...REVISION, ...YES },
    details: "What the update changes is shown first: the commands, the places on the web and the settings that are new, changed or gone. It needs your yes when the plugin runs commands on this computer, when it reaches a new place, or when a setting that you gave goes to another place. `--revision` is the revision of the source (`botkins plugins show` prints it), not the installed one.",
    async run(context) {
      const before = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name, see `botkins plugins list`)."));
      const preview = await context.client.call("plugins.preview", before.id);
      const o = context.options;
      if (o.revision !== undefined && o.revision !== preview.revision)
        throw new CliError(o.revision === before.revision ? "That is the revision of the installed copy. An update takes the revision of the source as it is now: `botkins plugins show -- " + safe(before.id) + "` prints both." : "This plugin is not the one that you looked at: its revision is another one now. Look at it again: `botkins plugins show -- " + safe(before.id) + "`.");
      if (preview.revision === before.revision) return void context.print(before, () => called(before) + " is up to date.");
      const change = changes(before, preview);
      const text = [called(before) + ": what this update changes", ...changeLines(change, preview), "", "After the update:", described(preview)].join("\n");
      // Saved settings are carried over. So a new place on the web, or a setting that goes to another place, asks too, also when nothing runs here.
      const asks = preview.runs.length > 0 || change.reaches.length > 0 || change.movedSettings.length > 0;
      if (asks) {
        if (!(await agreed(context, preview, { text, question: "Update it?", command: "update", revision: preview.revision }))) return EXIT.failed;
      } else show(context, text);
      context.print({ ...(await context.client.call("plugins.update", before.id, { revision: preview.revision })), changed: change }, (now) => "Updated " + called(now) + "." + (needs(now).length ? " It needs settings: " + needs(now).map(safe).join(", ") + "." : ""));
    },
  },
  enable: {
    summary: "Switch an installed plugin on",
    usage: "botkins plugins enable <id> [--revision <revision>] [--yes]",
    options: { ...REVISION, ...YES },
    details: "A plugin that runs commands on this computer is shown before it is switched on, and needs your yes. A caller that cannot be asked gives `--yes --revision=<the installed revision> -- <id>`. The service checks the revision: a plugin that was updated after the look is not switched on.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      const asks = plugin.enabled === false && plugin.runs.length > 0;
      if (asks && !(await agreed(context, plugin, { text: described(plugin), question: "Switch it on and let it run these on this computer?", command: "enable", revision: plugin.revision }))) return EXIT.failed;
      context.print(await context.client.call("plugins.setEnabled", plugin.id, true, plugin.revision), (now) => called(now) + " is on.");
    },
  },
  configure: {
    summary: "Give a plugin its settings",
    usage: "botkins plugins configure <id> [--settings <path>] [--unset <KEY>]…",
    options: { ...SETTINGS, unset: { type: "string", multiple: true, value: "KEY", about: "Take a setting's value away" } },
    // With no option it asks for each setting at a terminal. With none there, this flag gives them.
    asks: "--settings",
    details: "At a terminal, with no option, each setting is asked for, with the place its value goes to. A secret one is not shown as you type, and an empty answer keeps what is stored. A value can also be a saved credential, by reference: { \"KEY\": { \"$credential\": \"<its id>\" } }. No command prints a setting's value: `botkins plugins show` says which ones have one, and where each one goes.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      const o = context.options;
      let values = (await settingsFile(context)) ?? {};
      if (o.settings === undefined && !o.unset?.length) {
        if (!plugin.config?.length) return void context.print(plugin, () => called(plugin) + " has no settings.");
        if (!context.stdin.isTTY || context.json) throw usage("Give the settings in a JSON file with --settings <path>, or --settings - to read it from standard input. It can set: " + plugin.config.map((field) => safe(field.key)).join(", ") + ".");
        values = {};
        for (const field of plugin.config) {
          show(context, safe(field.label ?? field.key) + " goes to " + goesTo(field) + ".");
          const typed = await ask(context, safe(field.label ?? field.key) + (field.secret ? " (not shown)" : "") + (field.set ? " [Enter keeps it]" : field.required ? " (needed)" : "") + ": ", { hidden: field.secret });
          if (typed) values[field.key] = typed;
        }
      }
      for (const key of o.unset ?? []) values[key] = null;
      if (!Object.keys(values).length) return void context.print(plugin, () => "Nothing changed.");
      // Where each given value goes is said, so that a caller that reads no question sees it too.
      const given = (plugin.config ?? []).filter((field) => values[field.key] !== undefined && values[field.key] !== null);
      if (given.length) show(context, ["These values go to:", ...given.map(settingLine)].join("\n"));
      await context.client.call("plugins.configure", plugin.id, values);
      context.print(await context.client.call("plugins.get", plugin.id), (now) => "Saved." + (needs(now).length ? " Still needed: " + needs(now).map(safe).join(", ") + "." : ""));
    },
  },
  bots: {
    summary: "Say which bots have a plugin",
    usage: "botkins plugins bots <id> (--all | --bot <bot>…) [--revision <revision>] [--yes]",
    options: { all: { type: "boolean", about: "Every bot, and each new one" }, bot: { type: "string", multiple: true, value: "bot", about: "A bot that has it, by name or id. Give it again for each one; these replace the list" }, ...REVISION, ...YES },
    arguments: [{ name: "id", required: true }],
    details: "A plugin that is on and runs commands on this computer is shown before more bots get it, and needs your yes, as `enable` does. Fewer bots need no yes. This command does not switch a plugin on.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      const o = context.options;
      if ((o.all === true) === (o.bot?.length > 0)) throw usage("Give --all, or --bot for each bot that has the plugin.");
      const bots = o.all ? "all" : await Promise.all(o.bot.map(async (ref) => (await context.client.call("bots.get", ref)).id));
      const wider = plugin.bots !== "all" && (bots === "all" || bots.some((id) => !plugin.bots.includes(id)));
      const asks = wider && plugin.enabled !== false && plugin.runs.length > 0;
      if (asks && !(await agreed(context, plugin, { text: described(plugin), question: "Let it run these for more bots?", command: "bots", revision: plugin.revision }))) return EXIT.failed;
      context.print(await context.client.call("plugins.setBots", plugin.id, bots, asks ? plugin.revision : undefined), (now) => called(now) + " is for " + (now.bots === "all" ? "every bot" : now.bots.length + " bot" + (now.bots.length === 1 ? "" : "s")) + "." + (now.enabled === false ? " It is off." : ""));
    },
  },
  "add-folder": {
    summary: "Add a plugin from a folder on this computer, switched off",
    usage: "botkins plugins add-folder <path>",
    details: "Give the folder's full path. Botkins copies the folder and adds the plugin switched off, so nothing of it runs. What it would run is shown. `botkins plugins enable` switches it on after your yes.",
    async run(context) {
      const added = await context.client.call("plugins.addFolder", one(context, "Give the folder's full path."));
      const plugin = await context.client.call("plugins.get", added.id);
      context.print(plugin, (now) => described(now) + "\nAdded, and switched off. Switch it on with `botkins plugins enable -- " + safe(now.id) + "`.");
    },
  },
  "sign-out": {
    summary: "Forget the sign-ins of a plugin's tools",
    usage: "botkins plugins sign-out <id>",
    details: "A tool on the web signs in through a browser. Sign it in from a paired phone or from the app's window.",
    async run(context) {
      context.print(await context.client.call("plugins.signOut", one(context, "Name the plugin (its id or name).")), (done) =>
        !done.tools ? called(done) + " has no tool that signs in." : done.signedOut ? called(done) + " is signed out (" + done.signedOut + " of its " + done.tools + " tool" + (done.tools === 1 ? "" : "s") + " that sign in " + (done.signedOut === 1 ? "was" : "were") + " signed in)." : called(done) + " was not signed in.",
      );
    },
  },
};
