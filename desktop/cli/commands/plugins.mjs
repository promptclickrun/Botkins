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
import { hasUnshown } from "../../desktop/shown-text.mjs";
import { safe, shellWord, shown, SIGN_IN_DETAILS, SIGN_IN_OPTIONS, signInCommand } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first. For a plugin that runs commands on this computer it needs --revision too" } };
const REVISION = { revision: { type: "string", value: "revision", about: "The revision that you looked at (`botkins plugins show` prints it). The plugin is refused when it is another one now" } };
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const count = (list, word) => (list?.length ? list.length + " " + word + (list.length === 1 ? "" : "s") : null);
const called = (plugin) => safe(plugin.name ?? plugin.id);
// Each word of a command that is printed for someone to run goes through `shellWord` (cli/commands/tools.mjs):
// the id is `name@marketplace` and the name is the plugin's own text, so it can hold `;`, `$(` or a backtick.
// A word that cannot be written safely is a placeholder, and the sentence says where to take it from.
const idWord = (id) => shellWord(id, "<its id>");
const idNote = (id) => (hasUnshown(id) ? " Take the id from `botkins plugins list --json`: it has a character that cannot be written in a command." : "");
const lookAgain = (id) => "Look at it again: `botkins plugins show -- " + idWord(id) + "`." + idNote(id);
const changedSince = (id) => "This plugin is not the one that you looked at: its revision is another one now. " + lookAgain(id);
/**
 * The rest of the command line that was given (--all, --bot, --settings, --unset), each word written
 * for a shell, and a sentence for each word that has no runnable form. Without it the printed
 * command would do another thing.
 */
const restOf = ({ all = false, bots = [], settings, unset = [] } = {}) => {
  const words = [];
  const notes = new Set();
  if (all) words.push("--all");
  for (const bot of bots) {
    words.push(shellWord("--bot=" + bot, "--bot=<the bot>"));
    if (hasUnshown(bot)) notes.add("Write the bot's id for --bot= (`botkins bots list --json` has it): its name has a character that cannot be written in a command.");
  }
  if (settings !== undefined) {
    words.push("--settings " + shellWord(settings, "<the path>"));
    if (hasUnshown(settings)) notes.add("Write the path of the settings file yourself: it has a character that cannot be written in a command.");
  }
  for (const key of unset) {
    words.push(shellWord("--unset=" + key, "--unset=<the key>"));
    if (hasUnshown(key)) notes.add("Write the setting's name for --unset= yourself: it has a character that cannot be written in a command.");
  }
  return { text: words.join(" "), notes: [...notes] };
};
/**
 * One thing that a plugin runs here, whole: a hook's command, or a tool's line with every word,
 * then its folder, each environment value as the plugin wrote it (a value can be a command), and
 * the names that the plugin asked for and Botkins does not set.
 */
const runLines = (run) => [
  "  " + (run.what === "hook" ? "at " + safe(run.when) + ": " + safe(run.command) : "the tool " + safe(run.name) + ": " + shown([run.command, ...(run.args ?? [])])),
  ...(run.what === "hook" && run.timeoutSec != null ? ["      for at most " + safe(run.timeoutSec) + " second" + (Number(run.timeoutSec) === 1 ? "" : "s")] : []),
  ...(run.cwd ? ["      in the folder " + JSON.stringify(safe(run.cwd)) + (/^(?:[/]|[A-Za-z]:)/.test(run.cwd) ? "" : " of the plugin's own copy")] : []),
  ...(run.env ?? []).map((entry) => "      with " + safe(entry.name) + "=" + JSON.stringify(safe(entry.value))),
  // Each name has the service's own sentence for why Botkins does not set it (an older answer has the name alone).
  ...(run.envNotSet?.length ? ["      not set by Botkins, though the plugin asks for them:", ...run.envNotSet.map((entry) => "        " + (typeof entry === "string" ? safe(entry) : safe(entry.name) + (entry.why ? ": " + safe(entry.why) : "")))] : []),
];
/** A tool on the web, whole: its address and kind, each header as the plugin wrote it (a name alone when the description gives no value), and its sign-in. */
const reachLines = (reach) => [
  "  the tool " + safe(reach.name) + ": " + safe(reach.url) + (reach.type === "sse" ? ", as a stream (sse)" : ""),
  ...(reach.headers ?? []).map((entry) => {
    const header = typeof entry === "string" ? { name: entry } : entry ?? {};
    return "      with the header " + safe(header.name) + (header.value == null ? "" : "=" + JSON.stringify(safe(header.value)));
  }),
  ...(reach.signsIn || reach.oauthClientId ? ["      signs in" + (reach.oauthClientId ? ", with the client id " + JSON.stringify(safe(reach.oauthClientId)) : "")] : []),
];
/** The same, made from one tool of a description (what the control wrapper makes of a remote tool). */
const reachOf = (server) => ({ name: server.name, url: server.url, type: server.type, headers: server.headers, ...(server.oauth && { signsIn: true }), oauthClientId: server.oauthClientId });
/** Where a setting's value goes: the environment names and the headers that get it. */
const goesTo = (field) =>
  field.sentTo?.length
    ? field.sentTo.map((place) => (place.header ? "the header " + safe(place.header) + " of the tool " + safe(place.tool) + " at " + safe(place.url) : "the environment value " + safe(place.env) + (place.hook ? " of the hook at " + safe(place.hook) : " of the tool " + safe(place.tool)))).join("; ")
    : "no tool and no hook of the plugin";
// A default is put into environment values and headers: what the block shows as ${API_URL} becomes this. A secret's default is not shown.
const settingLine = (field) =>
  "  " + safe(field.key) + [field.required && "needed", field.secret && "secret", field.set === true && "has a value", !field.secret && field.default != null && "default " + JSON.stringify(safe(field.default))].filter(Boolean).map((word) => " (" + word + ")").join("") + ": goes to " + goesTo(field);
/** Who has an installed plugin, as a person reads it: by name, and only the count when the service gave no names. */
const botsText = (plugin) => (plugin.bots === "all" || plugin.botNames === "all" ? "every bot" : Array.isArray(plugin.botNames) ? (plugin.botNames.length ? plugin.botNames.map(safe).join(", ") : "no bot") : (count(plugin.bots, "bot") ?? "no bot"));
/** What the plugin has and Botkins does not run: the first rows and how many there are (an older answer is the plain list). */
const notRunOf = (contents) => {
  const rows = Array.isArray(contents?.notRun) ? contents.notRun : Array.isArray(contents?.notRun?.items) ? contents.notRun.items : [];
  return { rows, count: Math.max(rows.length, Number(contents?.notRun?.count) || 0) };
};
const notRunLine = (item) => "  the " + safe(item.what) + " " + safe(item.name) + ": " + safe(item.why);
/** A row of the other files: a whole folder is one row, with how many files it holds. */
const fileName = (file) => safe(file.path) + (typeof file.files === "number" ? " (" + some(file.files, "file") + ")" : "");
const LIMIT = "A command runs with these files, and Botkins cannot show all that they make it do.";
const some = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const filesText = (files) => some(files?.count ?? 0, "file") + ", " + some(files?.bytes ?? 0, "byte");
/** The files of a plugin that are not skills, tools or hooks, and the limit of this look: a command runs with them. */
const otherFilesLines = (plugin) => {
  const files = plugin.contents?.otherFiles;
  const named = listOf(files?.files).filter((file) => file.config).map(fileName);
  return [
    ...(files?.count > 0 ? ["Other files of the plugin: " + filesText(files)] : []),
    ...(named.length ? ["  configuration files: " + named.slice(0, 12).join(", ") + (named.length > 12 ? " and " + (named.length - 12) + " more" : "")] : []),
    ...(plugin.runs?.length ? [LIMIT] : []),
  ];
};

/** A plugin as a person reads it before a decision: what it holds, what it runs here, where it reaches, what it needs, and its revision. */
function described(plugin) {
  const holds = [count(plugin.contents?.skills, "skill"), count(plugin.contents?.agents, "agent"), count(plugin.contents?.commands, "command"), count(plugin.contents?.mcpServers, "tool"), count(plugin.contents?.hooks, "hook")].filter(Boolean);
  const source = plugin.source;
  return [
    called(plugin) + (plugin.version ? " " + safe(plugin.version) : "") + "   " + safe(plugin.id) + (plugin.installed ? "   (installed" + (plugin.enabled === false ? ", off" : "") + ")" : ""),
    plugin.description ? safe(plugin.description) : null,
    "Holds: " + (holds.length ? holds.join(", ") : "nothing that Botkins uses") + ".",
    ...(plugin.installed ? ["Bots: " + botsText(plugin)] : []),
    ...(plugin.afterUpdate ? ["Bots: " + botsText(plugin.afterUpdate) + " (as now)" + (plugin.afterUpdate.enabled === false ? ". It stays off." : "")] : []),
    ...(plugin.runs?.length ? ["Runs on this computer, as the user that runs Botkins:", ...plugin.runs.flatMap(runLines)] : ["Runs nothing on this computer."]),
    ...(plugin.reaches?.length ? ["Reaches on the web:", ...plugin.reaches.flatMap(reachLines)] : []),
    ...(plugin.config?.length ? ["Settings:", ...plugin.config.map(settingLine)] : []),
    ...(notRunOf(plugin.contents).count ? ["Not run by Botkins:", ...notRunOf(plugin.contents).rows.map(notRunLine), ...(notRunOf(plugin.contents).count > notRunOf(plugin.contents).rows.length ? ["  and " + (notRunOf(plugin.contents).count - notRunOf(plugin.contents).rows.length) + " more"] : [])] : []),
    ...otherFilesLines(plugin),
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
/** The sentence for a caller that cannot be asked, in the form that works for every id (an id can start with a dash). `rest` is the rest of the command line that was given (--all, --bot): without it the printed command would do another thing. */
const look = (plugin, command, rest = restOf()) =>
  "This plugin runs commands on this computer or reaches a new place. Look at it first: `botkins plugins show -- " + idWord(plugin.id) + "`. Then give the revision that you looked at: `botkins plugins " + command + (rest.text ? " " + rest.text : "") + " --yes --revision=<revision> -- " + idWord(plugin.id) + "`." + idNote(plugin.id) + rest.notes.map((note) => " " + note).join("");
/**
 * The yes for a plugin that runs commands here (or, for an update, reaches a new place).
 * `text` is what the person is shown. `revision` is the one that the yes is for.
 * A person with no --yes is asked. --yes needs --revision, and it must be that revision.
 * `refusal` is the sentence for a caller that cannot be asked, when it is not the one for a plugin that runs commands.
 */
async function agreed(context, plugin, { text, question, command, revision, rest, refusal }) {
  show(context, text);
  const o = context.options;
  const sentence = () => refusal ?? look(plugin, command, rest);
  if (o.yes) {
    if (o.revision === undefined) throw usage("--yes needs --revision for this plugin. " + sentence());
    if (o.revision !== revision) throw new CliError(changedSince(plugin.id));
    return true;
  }
  if (!context.stdin.isTTY || context.json) throw usage(sentence());
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
/** A setting whose value goes into a header to an address on the web, whatever the plugin calls it. */
const toHeader = (field) => field.sentTo?.some((place) => place.header) === true;
/** `--settings -` reads standard input to its end, so it cannot also answer a question: that is said before anything is read. */
const STDIN_ASKS = "--settings - reads standard input, which cannot also answer the question that this plugin needs. Give --yes with --revision after you looked at it, or give --settings a file path instead of -. ";
const needs = (plugin) => (plugin.config ?? []).filter((field) => field.required && field.set !== true).map((field) => field.key);

/** One value as text that does not depend on the order of its keys, so that two descriptions are compared by what they say. */
const whole = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * What an update changes: the two WHOLE descriptions are compared, not chosen fields. The runs and
 * the reaches say it in the words of what happens; the rest (a hook's time limit and order, a
 * tool's type, a header as written, a setting's default, what is not run, the other files) is
 * listed by its kind, so that nothing that differs is left out.
 */
function changes(before, next) {
  const same = (items, item) => listOf(items).some((other) => whole(other) === whole(item));
  const fresh = (now, then) => listOf(now).filter((item) => !same(then, item));
  const runs = fresh(next.runs, before.runs);
  const runsGone = fresh(before.runs, next.runs);
  const reaches = fresh(next.reaches, before.reaches);
  // A hook that is new or changed and that the runs do not say (its time limit, when the runs have none).
  const hooksNow = listOf(next.contents?.hooks);
  const hooksThen = listOf(before.contents?.hooks);
  const said = (hook) => runs.some((run) => run.what === "hook" && run.when === hook.event && run.command === hook.command && whole(run.env ?? []) === whole(hook.env ?? []));
  // A hook is there as many times as it is listed: a hook that is added, taken away, or there more or fewer times is a change, and the order changed only when the same hooks are there in another order.
  const tally = (hooks) => {
    const rows = new Map();
    for (const hook of hooks) {
      const key = whole(hook);
      rows.set(key, { hook, times: (rows.get(key)?.times ?? 0) + 1 });
    }
    return rows;
  };
  const [rowsNow, rowsThen] = [tally(hooksNow), tally(hooksThen)];
  const hooksMore = [...rowsNow].filter(([key, row]) => row.times > (rowsThen.get(key)?.times ?? 0)).map(([key, row]) => ({ ...row.hook, times: row.times, before: rowsThen.get(key)?.times ?? 0 })).filter((hook) => !(hook.before === 0 && said(hook)));
  const sameHook = (hook, other) => hook.event === other.event && hook.command === other.command;
  const hooksFewer = [...rowsThen]
    .filter(([key, row]) => row.times > (rowsNow.get(key)?.times ?? 0))
    .map(([key, row]) => ({ ...row.hook, times: rowsNow.get(key)?.times ?? 0, before: row.times }))
    // A hook that has a changed twin above is said there. One that is gone whole and that "No longer runs" names is said there.
    .filter((hook) => !hooksMore.some((other) => sameHook(hook, other)) && !(hook.times === 0 && runsGone.some((run) => run.what === "hook" && run.when === hook.event && run.command === hook.command)));
  const keysNow = hooksNow.map(whole);
  const keysThen = hooksThen.map(whole);
  const hooksReordered = keysNow.length === keysThen.length && [...rowsNow].every(([key, row]) => rowsThen.get(key)?.times === row.times) && keysNow.some((key, at) => key !== keysThen[at]);
  // A tool that is new or changed, and that neither the runs nor the reaches name.
  const toolsNow = listOf(next.contents?.mcpServers);
  const toolsThen = listOf(before.contents?.mcpServers);
  const named = (tool) => (tool.kind === "remote" ? reaches.some((reach) => reach.name === tool.name) : runs.some((run) => run.what === "tool" && run.name === tool.name));
  // What decides whether a tool on the web is the same: where it is, how it speaks, the headers as written, and how it signs in.
  const web = (tool) => whole([tool.name, tool.type, tool.url, tool.headers, tool.oauth, tool.oauthClientId]);
  const remote = (items) => items.filter((tool) => tool.kind === "remote");
  const field = (plugin) => Object.fromEntries(listOf(plugin.config).map(({ set: _set, ...rest }) => [rest.key, rest]));
  const [was, is] = [field(before), field(next)];
  const both = Object.keys(is).filter((key) => key in was);
  const sentTo = (key, fields) => whole(fields[key].sentTo ?? []);
  const files = [before.contents?.otherFiles, next.contents?.otherFiles];
  const configFiles = (entry) => listOf(entry?.files).filter((file) => file.config).map(fileName);
  const [filesThen, filesNow] = [configFiles(files[0]), configFiles(files[1])];
  // (An installed copy that has no count of its own is not compared: it would differ at each update.)
  const compared = files[0] && files[1];
  const otherFiles = compared && (files[0].count !== files[1].count || files[0].bytes !== files[1].bytes || filesNow.some((path) => !filesThen.includes(path)) || filesThen.some((path) => !filesNow.includes(path))) ? { was: { count: files[0].count, bytes: files[0].bytes }, now: { count: files[1].count, bytes: files[1].bytes }, newConfigFiles: filesNow.filter((path) => !filesThen.includes(path)), goneConfigFiles: filesThen.filter((path) => !filesNow.includes(path)) } : null;
  return {
    runs,
    noLongerRuns: runsGone,
    reaches,
    noLongerReaches: fresh(before.reaches, next.reaches),
    hooks: hooksMore,
    hooksFewer,
    hooksReordered,
    tools: fresh(toolsNow, toolsThen).filter((tool) => !named(tool)),
    // A tool on the web that is new, or whose type, address, headers or sign-in changed: an update takes it with the saved settings.
    webTools: remote(toolsNow).filter((tool) => !remote(toolsThen).some((other) => web(other) === web(tool))).map((tool) => tool.name),
    notRun: fresh(notRunOf(next.contents).rows, notRunOf(before.contents).rows),
    noLongerNotRun: fresh(notRunOf(before.contents).rows, notRunOf(next.contents).rows),
    // The rows are the first ones only: a change in how many there are is a change too.
    notRunCount: notRunOf(before.contents).count !== notRunOf(next.contents).count ? { was: notRunOf(before.contents).count, now: notRunOf(next.contents).count } : null,
    newSettings: Object.keys(is).filter((key) => !(key in was)),
    goneSettings: Object.keys(was).filter((key) => !(key in is)),
    // A setting that the person gave a value for, and that goes to another place now: the kept value would go there with nothing said.
    movedSettings: both.filter((key) => sentTo(key, was) !== sentTo(key, is)),
    changedSettings: both.filter((key) => sentTo(key, was) === sentTo(key, is) && whole(was[key]) !== whole(is[key])),
    // A default is put into the values that go to a place: a changed one changes what is sent there.
    defaultsChanged: both.filter((key) => is[key].sentTo?.length && whole(was[key].default) !== whole(is[key].default)),
    otherFiles,
    // An installed copy from before the files were counted has nothing to compare with: said, not left out.
    otherFilesUnknown: !files[0],
  };
}
function changeLines(change, next) {
  const settings = (keys) => (next.config ?? []).filter((field) => keys.includes(field.key)).map(settingLine);
  const files = change.otherFiles;
  const times = (hook) => (hook.times > 1 || hook.before > 0 ? ["      " + (hook.times === 1 ? "1 time" : hook.times + " times") + " now, " + (hook.before === 0 ? "none" : hook.before === 1 ? "1 time" : hook.before + " times") + " before"] : []);
  const hookLines = (hook) => ["  at " + safe(hook.event) + ": " + safe(hook.command), ...(hook.timeoutSec != null ? ["      for at most " + safe(hook.timeoutSec) + " second" + (Number(hook.timeoutSec) === 1 ? "" : "s")] : []), ...times(hook)];
  const sections = [
    ...(change.runs.length ? ["New or changed, runs on this computer:", ...change.runs.flatMap(runLines)] : []),
    ...(change.noLongerRuns.length ? ["No longer runs:", ...change.noLongerRuns.flatMap(runLines)] : []),
    ...(change.reaches.length ? ["New or changed, reaches on the web:", ...change.reaches.flatMap(reachLines)] : []),
    ...(change.noLongerReaches.length ? ["No longer reaches:", ...change.noLongerReaches.flatMap(reachLines)] : []),
    ...(change.hooks.length ? ["New or changed hooks:", ...change.hooks.flatMap(hookLines)] : []),
    ...(change.hooksFewer.length ? ["Hooks that are gone or are there fewer times:", ...change.hooksFewer.flatMap(hookLines)] : []),
    ...(change.hooksReordered ? ["The order of the hooks changed."] : []),
    ...(change.tools.length ? ["New or changed tools:", ...change.tools.flatMap((tool) => (tool.kind === "remote" ? reachLines(reachOf(tool)) : ["  the tool " + safe(tool.name)]))] : []),
    ...(change.notRun.length ? ["New or changed, not run by Botkins:", ...change.notRun.map(notRunLine)] : []),
    ...(change.notRunCount ? ["The number of things that Botkins does not run changed: from " + change.notRunCount.was + " to " + change.notRunCount.now + "."] : []),
    ...(change.noLongerNotRun.length ? ["No longer listed as not run by Botkins:", ...change.noLongerNotRun.map((item) => "  the " + safe(item.what) + " " + safe(item.name))] : []),
    ...(change.movedSettings.length ? ["A setting that you gave, which goes to another place now:", ...settings(change.movedSettings)] : []),
    ...(change.changedSettings.length ? ["Settings that changed:", ...settings(change.changedSettings)] : []),
    ...(change.newSettings.length ? ["New settings:", ...settings(change.newSettings)] : []),
    ...(change.goneSettings.length ? ["Settings that are gone: " + change.goneSettings.map(safe).join(", ")] : []),
    ...(files ? ["The other files of the plugin changed: from " + filesText(files.was) + " to " + filesText(files.now) + ".", ...(files.newConfigFiles.length ? ["  new configuration files: " + files.newConfigFiles.map(safe).join(", ")] : []), ...(files.goneConfigFiles.length ? ["  configuration files that are gone: " + files.goneConfigFiles.map(safe).join(", ")] : [])] : []),
  ];
  // What runs and what is reached is the first thing said, also when it did not change.
  const unchanged = !(change.runs.length || change.noLongerRuns.length || change.reaches.length || change.noLongerReaches.length);
  const nothing = !next.runs?.length && !next.reaches?.length;
  const same = nothing ? "It runs and reaches the same as before: nothing." : "It runs the same and reaches the same addresses as before.";
  const unknown = change.otherFilesUnknown ? ["The other files of the installed version are not known, so they are not compared."] : [];
  if (!sections.length) return [same + (next.runs?.length ? " Its files changed, and its commands run those files." : ""), ...unknown];
  return [...(unchanged ? [same] : []), ...sections, ...unknown];
}

/**
 * The plugin as it will be after an update, for the block: the new source's description, with what stays the installed
 * plugin's own (who has it, on or off). A look at the source alone says "installed" with no bots, which reads as false.
 */
const afterUpdate = (before, preview) => ({ ...preview, installed: false, afterUpdate: { bots: before.bots, botNames: before.botNames, enabled: before.enabled } });

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
      context.print({ ...installed, source }, (plugin) => described(plugin) + (source.changed ? "\n`botkins plugins update -- " + idWord(plugin.id) + "` shows what is new." + idNote(plugin.id) : ""));
    },
  },
  install: {
    summary: "Install a plugin, for every bot or for the bots you name",
    usage: "botkins plugins install <id> [--bot <bot>]… [--settings <path>] [--revision <revision>] [--yes]",
    options: { bot: { type: "string", multiple: true, value: "bot", about: "A bot that gets the plugin, by name or id. Give it again for each one (every bot without it)" }, ...SETTINGS, ...REVISION, ...YES },
    // A plugin is given to every bot unless --bot says which. The yes needs the revision too.
    asks: "--yes --revision",
    details: "A plugin that runs commands on this computer is shown first and needs your yes, with the bots that get it. So does a plugin that gets a secret setting from --settings that goes to an address on the web. A caller that cannot be asked looks at it with `botkins plugins show -- <id>` and gives `--yes --revision=<its revision> -- <id>`. `--yes` with no `--revision` is refused for such a plugin, also at a terminal. A saved credential is chosen in the app's window or on a paired phone: from the command line, give the value itself.",
    async run(context) {
      const id = one(context, "Name the plugin by its id (see `botkins plugins browse`).");
      const o = context.options;
      // Before anything is asked: a plugin that is installed is not installed again.
      const have = await context.client.call("plugins.get", id).catch(() => null);
      if (have?.id === id) throw new CliError(called(have) + " is installed. `botkins plugins update -- " + idWord(id) + "` brings its source as it is now." + idNote(id));
      const preview = await context.client.call("plugins.preview", id);
      if (o.revision !== undefined && o.revision !== preview.revision) throw new CliError(changedSince(id));
      const rest = restOf({ bots: o.bot, settings: o.settings });
      // Who gets it is said before the question: with no --bot it is every bot.
      const forLine = "For: " + (o.bot?.length ? o.bot.map(safe).join(", ") : "every bot");
      // Standard input cannot be both the settings and the answer. Whether a value goes to an address is known only after it is read, so a plugin that could ask is refused first.
      const mayAsk = preview.runs.length > 0 || (preview.config ?? []).some(toHeader);
      if (o.settings === "-" && mayAsk && !(o.yes && o.revision !== undefined)) {
        show(context, [described(preview), forLine].join("\n"));
        throw usage(STDIN_ASKS + look(preview, "install", rest));
      }
      const config = await settingsFile(context);
      // A value that goes into a header goes to an address on the web, whatever the plugin calls the setting: a plugin that runs nothing needs the yes for it too.
      const given = (preview.config ?? []).filter((field) => config?.[field.key] !== undefined && config[field.key] !== null);
      const values = given.length ? ["These values go to:", ...given.map(settingLine)] : [];
      const toAddress = given.some(toHeader);
      if (preview.runs.length || toAddress) {
        const text = [described(preview), forLine, ...values].join("\n");
        const question = preview.runs.length ? "Install it and let it run these on this computer" + (toAddress ? " and send the values to the addresses above?" : "?") : "Install it and send these values to the addresses above?";
        if (!(await agreed(context, preview, { text, question, command: "install", revision: preview.revision, rest }))) return EXIT.failed;
      } else if (values.length) show(context, values.join("\n"));
      const plugin = await context.client.call("plugins.install", id, { revision: preview.revision, ...(o.bot?.length && { bots: o.bot }), ...(config && { config }) });
      context.print(plugin, (now) => "Installed " + called(now) + "." + (needs(now).length ? " It needs settings before it works: " + needs(now).map(safe).join(", ") + ". Give them with `botkins plugins configure -- " + idWord(now.id) + "`." + idNote(now.id) : ""));
    },
  },
  update: {
    summary: "Update an installed plugin to its source as it is now",
    usage: "botkins plugins update <id> [--revision <revision>] [--yes]",
    options: { ...REVISION, ...YES },
    asks: "--yes --revision",
    details: "What the update changes is shown first: the commands, the places on the web, the hooks, what is not run and the settings that are new, changed or gone. It needs your yes when the plugin runs commands on this computer, when a tool on the web is new or has another type, header or sign-in, or when a setting that you gave goes to another place or has another default. `--revision` is the revision of the source (`botkins plugins show` prints it), not the installed one.",
    async run(context) {
      const before = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name, see `botkins plugins list`)."));
      const preview = await context.client.call("plugins.preview", before.id);
      const o = context.options;
      if (o.revision !== undefined && o.revision !== preview.revision)
        throw new CliError(o.revision === before.revision ? "That is the revision of the installed copy. An update takes the revision of the source as it is now: `botkins plugins show -- " + idWord(before.id) + "` prints both." + idNote(before.id) : changedSince(before.id));
      // A copy that is not the reviewed files is written again by an update, to the same revision too, and the settings stay.
      const repair = preview.revision === before.revision && before.repair === "update";
      if (preview.revision === before.revision && !repair) return void context.print(before, () => called(before) + " is up to date.");
      if (repair) {
        show(context, called(before) + ": " + safe(before.detail ?? "its installed files are written again."));
        if (before.runs.length && !(await agreed(context, before, { text: described(before), question: "Write its files again?", command: "update", revision: preview.revision }))) return EXIT.failed;
        return void context.print(await context.client.call("plugins.update", before.id, { revision: preview.revision }), (now) => "The files of " + called(now) + " are written again. Your settings stay.");
      }
      const change = changes(before, preview);
      const text = [called(before) + ": what this update changes", ...changeLines(change, preview), "", "After the update:", described(afterUpdate(before, preview))].join("\n");
      // Saved settings are carried over. So a new place on the web, a tool that speaks or signs in another way, or a setting that goes to another place or has another default, asks too, also when nothing runs here.
      const asks = preview.runs.length > 0 || change.reaches.length > 0 || change.webTools.length > 0 || change.movedSettings.length > 0 || change.defaultsChanged.length > 0;
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
    asks: "--yes --revision",
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
    usage: "botkins plugins configure <id> [--settings <path>] [--unset <KEY>]… [--revision <revision>] [--yes]",
    options: { ...SETTINGS, unset: { type: "string", multiple: true, value: "KEY", about: "Take a setting's value away" }, ...REVISION, ...YES },
    // With no option it asks for each setting at a terminal. With none there, --settings gives them, and a value that goes to an address needs the yes with the installed revision.
    asks: "--settings --yes --revision",
    details: "At a terminal, with no option, each setting is asked for, with the place its value goes to. A secret one is not shown as you type, and an empty answer keeps what is stored. From a file (--settings), a value that goes into a header to an address on the web is shown first, with the place, and needs your yes, whatever the plugin calls the setting: a caller that cannot be asked gives `--yes --revision=<the installed revision>` (`botkins plugins show` prints it). A value for an environment value of the plugin's own hook or program, and --unset, need no yes. A saved credential is chosen in the app's window or on a paired phone: from the command line, give the value itself. No command prints a setting's value: `botkins plugins show` says which ones have one, and where each one goes.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      const o = context.options;
      const rest = restOf({ settings: o.settings, unset: o.unset });
      const refusal = "These values go to an address on the web, as shown above. Look at where they go, then give the installed revision of the plugin (`botkins plugins show -- " + idWord(plugin.id) + "` prints it): `botkins plugins configure " + (rest.text ? rest.text + " " : "") + "--yes --revision=<revision> -- " + idWord(plugin.id) + "`." + idNote(plugin.id) + rest.notes.map((note) => " " + note).join("");
      // Standard input cannot be both the settings and the answer: a plugin with a setting that goes to a header could ask, so that is said before anything is read.
      if (o.settings === "-" && (plugin.config ?? []).some(toHeader) && !(o.yes && o.revision !== undefined)) {
        show(context, described(plugin));
        throw usage(STDIN_ASKS + refusal);
      }
      let values = (await settingsFile(context)) ?? {};
      // What is typed at a terminal is the person in the conversation: where each value goes is said before it is asked, and no more yes is needed.
      let typed = false;
      if (o.settings === undefined && !o.unset?.length) {
        if (!plugin.config?.length) return void context.print(plugin, () => called(plugin) + " has no settings.");
        if (!context.stdin.isTTY || context.json) throw usage("Give the settings in a JSON file with --settings <path>, or --settings - to read it from standard input. It can set: " + plugin.config.map((field) => safe(field.key)).join(", ") + ".");
        values = {};
        typed = true;
        for (const field of plugin.config) {
          show(context, safe(field.label ?? field.key) + " goes to " + goesTo(field) + ".");
          const answer = await ask(context, safe(field.label ?? field.key) + (field.secret ? " (not shown)" : "") + (field.set ? " [Enter keeps it]" : field.required ? " (needed)" : "") + ": ", { hidden: field.secret });
          if (answer) values[field.key] = answer;
        }
      }
      for (const key of o.unset ?? []) values[key] = null;
      if (!Object.keys(values).length) return void context.print(plugin, () => "Nothing changed.");
      // Where each given value goes is said, so that a caller that reads no question sees it too.
      const given = (plugin.config ?? []).filter((field) => values[field.key] !== undefined && values[field.key] !== null);
      const block = ["These values go to:", ...given.map(settingLine)].join("\n");
      // A value for a header goes to an address on the web, whatever the plugin calls it, and needs the yes. Taking a value away sends nothing.
      if (!typed && given.some(toHeader)) {
        if (!(await agreed(context, plugin, { text: block, question: "Send these values there?", command: "configure", revision: plugin.revision, refusal }))) return EXIT.failed;
      } else if (given.length) show(context, block);
      await context.client.call("plugins.configure", plugin.id, values);
      context.print(await context.client.call("plugins.get", plugin.id), (now) => "Saved." + (needs(now).length ? " Still needed: " + needs(now).map(safe).join(", ") + "." : ""));
    },
  },
  bots: {
    summary: "Say which bots have a plugin",
    usage: "botkins plugins bots <id> (--all | --bot <bot>…) [--revision <revision>] [--yes]",
    options: { all: { type: "boolean", about: "Every bot, and each new one" }, bot: { type: "string", multiple: true, value: "bot", about: "A bot that has it, by name or id. Give it again for each one; these replace the list" }, ...REVISION, ...YES },
    arguments: [{ name: "id", required: true }],
    asks: "--yes --revision",
    details: "A plugin that is on and runs commands on this computer is shown before more bots get it, and needs your yes, as `enable` does. Fewer bots need no yes. This command does not switch a plugin on.",
    async run(context) {
      const plugin = await context.client.call("plugins.get", one(context, "Name the plugin (its id or name)."));
      const o = context.options;
      if ((o.all === true) === (o.bot?.length > 0)) throw usage("Give --all, or --bot for each bot that has the plugin.");
      const chosen = o.all ? "all" : await Promise.all(o.bot.map((ref) => context.client.call("bots.get", ref)));
      const bots = chosen === "all" ? "all" : chosen.map((bot) => bot.id);
      const wider = plugin.bots !== "all" && (bots === "all" || bots.some((id) => !plugin.bots.includes(id)));
      const asks = wider && plugin.enabled !== false && plugin.runs.length > 0;
      const set = "Now: " + botsText(plugin) + ". After: " + (chosen === "all" ? "every bot" : chosen.map((bot) => safe(bot.name ?? bot.id)).join(", ")) + ".";
      // The sentence for a caller that cannot be asked has the same --all or --bot, or it would be another command.
      const rest = restOf({ all: o.all, bots: o.all ? [] : o.bot });
      if (asks && !(await agreed(context, plugin, { text: described(plugin) + "\n" + set, question: set + " Let it run these for more bots?", command: "bots", revision: plugin.revision, rest }))) return EXIT.failed;
      context.print(await context.client.call("plugins.setBots", plugin.id, bots, asks ? plugin.revision : undefined), (now) => called(now) + " is for " + (now.bots === "all" ? "every bot" : now.bots.length + " bot" + (now.bots.length === 1 ? "" : "s")) + "." + (now.enabled === false ? " It is off." : ""));
    },
  },
  "add-folder": {
    summary: "Add a plugin from a folder on this computer",
    usage: "botkins plugins add-folder <path>",
    details: "Give the folder's full path. Botkins copies the folder and adds the plugin. A plugin that runs nothing on this computer is on at once. A plugin that runs commands here is shown first: at a terminal you are asked if it goes on, and with no terminal it is added switched off, and `botkins plugins enable` switches it on with the revision that is printed.",
    async run(context) {
      const added = await context.client.call("plugins.addFolder", one(context, "Give the folder's full path."));
      const plugin = await context.client.call("plugins.get", added.id);
      const text = described(plugin);
      if (plugin.enabled) return void context.print(plugin, () => text + "\nAdded, and on.");
      const off = (now) => text + "\nAdded, and switched off. Switch it on with `botkins plugins enable -- " + idWord(now.id) + "`." + idNote(now.id);
      // It runs commands here. A person at a terminal is shown what it starts and asked. Nobody to ask: it stays off, and the answer says how it goes on.
      if (!context.stdin.isTTY || context.json) return void context.print(plugin, off);
      show(context, text);
      if (!(await confirm(context, "Switch it on and let it run these on this computer?"))) return void context.print(plugin, () => "Added, and switched off. Switch it on with `botkins plugins enable -- " + idWord(plugin.id) + "`." + idNote(plugin.id));
      context.print(await context.client.call("plugins.setEnabled", plugin.id, true, plugin.revision), (now) => "Added. " + called(now) + " is on.");
    },
  },
  "sign-in": {
    summary: "Sign in a tool of a plugin that signs in, with a browser on any device",
    usage: "botkins plugins sign-in <id> [--tool <name>] [--start | --finish | --cancel] [--no-input]",
    options: { tool: { type: "string", value: "name", about: "Which tool, when the plugin has more than one that signs in (the tool's name in `botkins plugins show`)" }, ...SIGN_IN_OPTIONS },
    arguments: [{ name: "id", required: true }],
    details: "A plugin with one tool that signs in needs no --tool. With several, the command refuses and lists their names.\n\n" + SIGN_IN_DETAILS,
    async run(context) {
      const ref = one(context, "Name the plugin (its id or name).");
      const tool = context.options.tool;
      return signInCommand(context, {
        calls: "plugins.signIn",
        // (The tool is always the second word of the call, so that what follows it is the address and nothing else.)
        target: [ref, tool ?? null],
        // The plugin's id and the tool's name are the plugin's own words: each is written for a shell, or is a placeholder.
        next: (started) => "botkins plugins sign-in --finish " + shellWord("--tool=" + started.tool, "--tool=<the tool>") + " -- " + idWord(started.plugin),
      });
    },
  },
  "sign-out": {
    summary: "Forget the sign-ins of a plugin's tools",
    usage: "botkins plugins sign-out <id> [--yes]",
    options: { yes: { type: "boolean", short: "y", about: "Don't ask first" } },
    details: "A tool on the web signs in through a browser. Forget its sign-in here, and sign it in again with `botkins plugins sign-in`.\n\nA sign-in that is forgotten cannot be got back, so this asks first. With no terminal it needs --yes.",
    async run(context) {
      const ref = one(context, "Name the plugin (its id or name).");
      const plugin = await context.client.call("plugins.get", ref);
      const name = safe(plugin.name ?? plugin.id);
      context.stderr.write("This forgets the sign-ins of the tools of the plugin " + name + ". They cannot be got back: each tool signs in again through a browser.\n");
      if (!(await confirm(context, "Sign out of the plugin " + name + "?"))) {
        context.note("Not signed out.");
        return EXIT.failed;
      }
      context.print(await context.client.call("plugins.signOut", ref, { agreed: true }), (done) =>
        !done.tools ? called(done) + " has no tool that signs in." : done.signedOut ? called(done) + " is signed out (" + done.signedOut + " of its " + done.tools + " tool" + (done.tools === 1 ? "" : "s") + " that sign in " + (done.signedOut === 1 ? "was" : "were") + " signed in)." : called(done) + " was not signed in.",
      );
    },
  },
};
