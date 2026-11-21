// What a plugin starts, as the window shows it for a decision ("plugins-v1" with the mark
// `starts: 1`; desktop/docs/PLUGINS.md, "What a plugin starts, and what you are shown").
//
// The rule is the computer's: what is shown is what starts, and all of it. The window's part is to
// show every field of the description, whole and as text, and to ask first when a description has
// no mark. The words here are the phone's where the two apps say the same thing, with "this
// computer" (or the name of the computer in use) where the phone says "your computer".
import { shownText } from "../desktop/shown-text.mjs";
import type { InstalledPlugin, PluginContents, PluginField, PluginHook, PluginNamed, PluginPreview, PluginSentTo, PluginTool } from "./types";

/** The capability of a computer whose descriptions show every command it starts. */
export const PLUGIN_STARTS = "plugin-starts-v1";

/**
 * Text from a plugin as it is shown for a decision: each character that changes what a person
 * sees is written as its number. A new line and a tab stay what they are, so a command of several
 * lines keeps its lines; everything else in a line goes through the computer's one rule.
 * Not for a chat's or a bot's name: there a joiner is correct writing.
 */
export const decisionText = (text: unknown): string =>
  String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.split("\t").map((part) => shownText(part)).join("\t"))
    .join("\n");

/** A local tool's whole line as its words: the command, then each argument. Each is one word, also when it has spaces in it. */
export const toolWords = (tool: Extract<PluginTool, { kind: "local" }>): string[] => [tool.command ?? "", ...(tool.args ?? [])].map(decisionText);

/** "NAME = value", for an environment name or a header. */
export const namedLine = (one: PluginNamed) => decisionText(one.name) + " = " + decisionText(one.value);

/** "10 seconds", for a hook's time limit. */
export const timeLimit = (seconds: number) => (seconds === 1 ? "1 second" : seconds + " seconds");

export const HOOK_WORDS: Record<string, string> = {
  sessionStart: "When a chat starts",
  userPromptSubmitted: "Each message you send",
  preToolUse: "Before a tool runs",
  postToolUse: "After a tool runs",
  postToolUseFailure: "After a tool fails",
  agentStop: "When a reply ends",
  subagentStart: "When a helper starts",
  subagentStop: "When a helper ends",
  sessionEnd: "When a chat ends",
  errorOccurred: "When an error occurs",
};
/** A hook's event in words. An event the window has no words for is shown by its own name. */
export const hookWords = (event: string) => HOOK_WORDS[event] ?? decisionText(event);

/** Where a setting's value goes, one line for each place. */
export function sentToLines(field: Pick<PluginField, "sentTo">): string[] {
  return (field.sentTo ?? []).map((place: PluginSentTo) =>
    "hook" in place
      ? "Sent to the hook “" + hookWords(place.hook) + "” as " + decisionText(place.env)
      : "header" in place
        ? "Sent to the tool " + decisionText(place.tool) + " at " + decisionText(place.url) + " in the header " + decisionText(place.header)
        : "Sent to the tool " + decisionText(place.tool) + " as " + decisionText(place.env),
  );
}

/** "3.2 MB", "214 KB", "80 B". */
export const sizeWords = (bytes: number) =>
  bytes < 1024 ? bytes + " B" : bytes < 1024 * 1024 ? Math.round(bytes / 102.4) / 10 + " KB" : Math.round(bytes / 104857.6) / 10 + " MB";
const count = (n: number, one: string, many: string) => (n === 1 ? "1 " + one : n.toLocaleString("en-US") + " " + many);

/**
 * The plugin's other files: "214 files · 3.2 MB", and the rows a person should see, which are the
 * files that tools read by themselves ("node_modules/ · 180 files" for a folder of dependencies).
 * Nothing when the description has no such part (an older computer).
 */
export function otherFilesView(contents: Pick<PluginContents, "otherFiles">): { line: string; read: string[] } | undefined {
  const other = contents.otherFiles;
  if (!other || !(other.count > 0)) return undefined;
  return {
    line: count(other.count, "file", "files") + " · " + sizeWords(other.bytes),
    read: other.files.filter((file) => file.config).map((file) => decisionText(file.path) + " · " + (file.files != null ? count(file.files, "file", "files") : sizeWords(file.bytes))),
  };
}

/** What is not run: each row with its reason as it comes, and "and 12 more" when there are more than the rows. */
export function notRunView(contents: Pick<PluginContents, "notRun">): { rows: { name: string; why: string }[]; more: string } | undefined {
  const not = contents.notRun;
  if (!not || !(not.count > 0)) return undefined;
  const rest = not.count - not.items.length;
  return {
    rows: not.items.map((item) => ({ name: (item.what === "hook" ? "Hook · " : "Tool · ") + decisionText(item.name), why: item.why })),
    more: rest > 0 ? "and " + rest.toLocaleString("en-US") + " more" : "",
  };
}

/** Whether the description shows anything that runs on the computer: a hook, or a tool that is a program. */
export const runsCommands = (contents: Pick<PluginContents, "hooks" | "mcpServers">) => contents.hooks.length > 0 || contents.mcpServers.some((tool) => tool.kind === "local");

/** The computer in use, for the words of a question: "this computer", or another computer by its name. */
export type Where = { name?: string; starts: boolean };
const on = (where: Where) => (where.name ? decisionText(where.name) : "this computer");
/** The same at the start of a sentence. */
const On = (where: Where) => (where.name ? decisionText(where.name) : "This computer");
/** A description without the mark, on a computer that has the rule: that computer could not read the plugin's copy just now. */
const notWhole = (where: Where) => On(where) + " could not show everything this plugin runs.";

export type Step = "install" | "update" | "on";
const VERB: Record<Step, string> = { install: "Install", update: "Update", on: "Turn on" };

/**
 * The question before an install, an update or a switch-on, or nothing when none is needed.
 * - A description with the mark: asked from what it shows. A plugin that runs nothing is not asked about.
 * - A description without the mark is never trusted: asked always, also when it shows nothing that runs.
 *   On a computer from before "plugin-starts-v1" the words say to update the app there.
 */
export function startQuestion(plugin: Pick<PluginPreview | InstalledPlugin, "contents" | "starts" | "warnings">, step: Step, where: Where): { title: string; body: string; confirm: string } | undefined {
  if (plugin.starts === 1) {
    if (!runsCommands(plugin.contents) && !plugin.warnings?.length) return undefined;
    const said = (plugin.warnings ?? []).join("\n");
    return { title: "This plugin runs commands on " + on(where), body: (said ? said + "\n\n" : "") + "Only go on if you trust this plugin.", confirm: VERB[step] };
  }
  return {
    title: "This plugin may run commands on " + on(where),
    body: where.starts
      ? notWhole(where) + " Go on only if you trust where the plugin comes from."
      : "Botkins on " + on(where) + " is older and may not show everything a plugin runs. Update it first, or go on only if you trust where the plugin comes from.",
    confirm: VERB[step] + " anyway",
  };
}

/**
 * The line on the page of a plugin whose description has no mark: on a computer from before the
 * rule, to update Botkins there; on one that has the rule, that it could not show everything.
 */
export const unmarkedLine = (where: Where) => (where.starts ? notWhole(where) : "Update Botkins on " + on(where) + " to see everything a plugin runs.");

/** A plugin that Botkins switched off: it is off and the computer says why. One that a person switched off has no such sentence. */
export const heldBack = (plugin: Pick<InstalledPlugin, "enabled" | "detail">) => !plugin.enabled && !!plugin.detail;
/** An entry for a folder that was linked and could not be copied: it can only be removed. */
export const linkedError = (plugin: Pick<InstalledPlugin, "id">) => plugin.id.startsWith("linked-");

/** "On", "Off", or "Off · Needs review" for a plugin that Botkins switched off. A linked folder that could not be copied has nothing to review: "Not used". */
export const onOffLabel = (plugin: Pick<InstalledPlugin, "id" | "enabled" | "detail">) => (plugin.enabled ? "On" : linkedError(plugin) ? "Not used" : heldBack(plugin) ? "Off · Needs review" : "Off");

/**
 * What "told one time" is kept by: the plugin and the computer's reason. A plugin that is switched
 * off again later, for another reason, is told again.
 */
export const toldKey = (plugin: Pick<InstalledPlugin, "id" | "detail">, host = "") => host + "\n" + plugin.id + "\n" + (plugin.detail ?? "");

/** The notice for plugins that Botkins switched off, shown one time: nothing when every such plugin was told already. */
export function switchedOffNotice(
  plugins: readonly Pick<InstalledPlugin, "id" | "enabled" | "detail">[],
  told: readonly string[],
  where: Where,
  host = "",
): { keys: string[]; title: string; text: string } | undefined {
  const keys = plugins.filter((plugin) => heldBack(plugin) && !linkedError(plugin)).map((plugin) => toldKey(plugin, host)).filter((key) => !told.includes(key));
  if (!keys.length) return undefined;
  return {
    keys,
    title: "Botkins switched off " + count(keys.length, "plugin", "plugins"),
    text: "Botkins now shows everything a plugin runs on " + on(where) + ". Review each one, then turn it on.",
  };
}

/** The plugins whose skills are off because Botkins switched the plugin off: one notice each, in Settings › Skills, one time. */
export const skillsOff = <P extends Pick<InstalledPlugin, "id" | "name" | "enabled" | "detail" | "contents">>(plugins: readonly P[], told: readonly string[], host = ""): P[] =>
  plugins.filter((plugin) => heldBack(plugin) && !linkedError(plugin) && plugin.contents.skills.length > 0 && !told.includes(toldKey(plugin, host)));

/** A tool's folder as it is shown: a path that is not a full path is a folder in the plugin's own copy. */
export function folderLine(cwd: string) {
  const full = cwd.startsWith("/") || cwd.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(cwd);
  return decisionText(cwd) + (full ? "" : " (in the plugin’s own folder)");
}

/** What the person was told one time, kept in this window's own storage under `name`. Storage that cannot be read tells again. */
export function readTold(name: string): string[] {
  try {
    const kept = JSON.parse(localStorage.getItem(name) ?? "[]");
    return Array.isArray(kept) ? kept.filter((one) => typeof one === "string") : [];
  } catch {
    return [];
  }
}
export function writeTold(name: string, told: readonly string[]) {
  try {
    // The newest 200 are enough: an entry is a plugin and a sentence.
    localStorage.setItem(name, JSON.stringify(told.slice(-200)));
  } catch {
    // A per-window convenience only.
  }
}

/** Whether a hook has anything beside its command to show. */
export const hookHasMore = (hook: PluginHook) => !!(hook.env?.length || hook.envNotSet?.length || hook.timeoutSec != null);
