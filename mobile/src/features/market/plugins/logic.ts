// The plain logic of the Plugins pages (docs/plugins.md): hook events in words, everything a tool
// and a hook start as lines to show, where a setting's value goes, what the alert before an install
// says, the chips, the status line and the settings form. Text a plugin wrote is shown for a
// decision, so it goes through `shownText` here. No React Native imports, so tests/plugins.test.ts
// runs it.
import type { InstalledPlugin, PluginContents, PluginField, PluginHook, PluginHookEvent, PluginListing, PluginMarketplace, PluginTool } from "@/link/types";
import { sizeWords } from "@/features/artifacts/logic";
import { shownText } from "@/ui/shownText";

/** Hook events in the order a turn meets them, in the words the desktop app uses too. */
export const HOOK_WORDS: Record<PluginHookEvent, string> = {
  sessionStart: "When a chat starts",
  userPromptSubmitted: "Each message you send",
  preToolUse: "Before a tool runs",
  postToolUse: "After a tool runs",
  postToolUseFailure: "After a tool fails",
  permissionRequest: "When a bot asks for permission",
  subagentStart: "When a helper starts",
  subagentStop: "When a helper ends",
  agentStop: "When a reply ends",
  preCompact: "Before a chat is compacted",
  notification: "When a bot sends a notification",
  errorOccurred: "When something goes wrong",
  sessionEnd: "When a chat ends",
};
const ORDER = Object.keys(HOOK_WORDS);

/** An event in words. One this app doesn't know yet is made readable: "fileChanged" is "File changed". */
export function hookWords(event: string): string {
  if (event in HOOK_WORDS) return HOOK_WORDS[event as PluginHookEvent];
  const words = event.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Another time";
}

/** Hooks grouped by event, in the order a turn meets them; unknown events last. */
export function groupHooks(hooks: PluginContents["hooks"]): { event: string; label: string; hooks: PluginHook[] }[] {
  const groups = new Map<string, PluginHook[]>();
  for (const hook of hooks) groups.set(hook.event, [...(groups.get(hook.event) ?? []), hook]);
  const rank = (event: string) => (ORDER.includes(event) ? ORDER.indexOf(event) : ORDER.length);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([event, list]) => ({ event, label: hookWords(event), hooks: list }));
}

// ── What a plugin starts, as lines to show ───────────────────────────────────

/** Whether a description shows everything the plugin starts: the computer's mark, on this one description. Without it, ask first. */
export const showsAll = (about: { starts?: unknown } | undefined) => about?.starts === 1;

/**
 * One word of a command line as it is shown. A word with a space, a quote or a backslash, and an
 * empty one, is put in quotes, so two words never read as one and one never reads as two.
 */
export function shownWord(word: unknown): string {
  const text = String(word ?? "");
  const quoted = text === "" || /[\s"'\\]/.test(text) ? '"' + text.replace(/(["\\])/g, "\\$1") + '"' : text;
  return shownText(quoted);
}

/** A local tool's whole line: its command and each word of its arguments. A computer from before the arguments sends the command alone, as written. */
export function runLine(server: Pick<PluginTool, "command" | "args">): string {
  if (!Array.isArray(server.args)) return shownText(server.command ?? "");
  return [server.command ?? "", ...server.args].map(shownWord).join(" ");
}

/** One thing to show about a tool or a hook: a label, and text, lines or names with the computer's reason. */
export type Fact = { label: string; text?: string; lines?: string[]; notes?: { name: string; why: string }[] };

const pairs = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    if (typeof item === "string") return [shownText(item)];
    const pair = item as { name?: unknown; value?: unknown } | null;
    if (!pair || typeof pair.name !== "string") return [];
    return [shownText(pair.name) + " = " + (pair.value === "" || pair.value == null ? '""' : shownText(pair.value, { lines: true }))];
  });
const notSet = (list: unknown): { name: string; why: string }[] =>
  (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    if (typeof item === "string") return [{ name: shownText(item), why: "" }];
    const entry = item as { name?: unknown; why?: unknown } | null;
    return entry && typeof entry.name === "string" ? [{ name: shownText(entry.name), why: typeof entry.why === "string" ? entry.why : "" }] : [];
  });
const environment = (about: { env?: unknown; envNotSet?: unknown }): Fact[] => {
  const facts: Fact[] = [];
  const env = pairs(about.env);
  if (env.length) facts.push({ label: "Environment", lines: env });
  const left = notSet(about.envNotSet);
  if (left.length) facts.push({ label: "Not set by Botkins", notes: left });
  return facts;
};

/** How long a hook may run: "10 seconds". */
export function timeLimit(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const shown = Number.isInteger(seconds) ? String(seconds) : String(Math.round(seconds * 100) / 100);
  return shown + (seconds === 1 ? " second" : " seconds");
}

/**
 * Everything a tool starts or reaches, in order. A local one: the whole line, its folder, its
 * environment (each name with its value) and the names the computer does not set. A remote one:
 * the address (and that it is a stream), each header with its value, and that it signs in.
 */
export function toolFacts(server: PluginTool): Fact[] {
  if (server.kind === "local") {
    const facts: Fact[] = [{ label: "Runs", text: runLine(server) }];
    if (server.cwd) facts.push({ label: "In folder", text: shownText(server.cwd) });
    return [...facts, ...environment(server)];
  }
  const facts: Fact[] = [{ label: "Connects to", text: shownText(server.url ?? "") + (server.type === "sse" ? " (stream)" : "") }];
  const headers = pairs(server.headers);
  if (headers.length) facts.push({ label: "Sends headers", lines: headers });
  if (server.oauth) facts.push({ label: "Signs in on your computer" });
  if (server.oauthClientId) facts.push({ label: "Client id", text: shownText(server.oauthClientId) });
  return facts;
}

/** Everything a hook runs: the whole command (its lines kept), its time limit, its environment and the names not set. */
export function hookFacts(hook: PluginHook): Fact[] {
  const facts: Fact[] = [{ label: "Runs", text: shownText(hook.command, { lines: true }) }];
  const limit = timeLimit(hook.timeoutSec);
  if (limit) facts.push({ label: "Time limit", text: limit });
  return [...facts, ...environment(hook)];
}

/** Where a setting's value goes, one line for each place. */
export function sentToLines(field: Pick<PluginField, "sentTo">): string[] {
  return (Array.isArray(field.sentTo) ? field.sentTo : []).flatMap((to) => {
    if (!to || typeof to !== "object") return [];
    if ("header" in to) return ["Sent to the tool " + shownText(to.tool) + " at " + shownText(to.url) + " in the header " + shownText(to.header)];
    if ("tool" in to) return ["Sent to the tool " + shownText(to.tool) + " as " + shownText(to.env)];
    if ("hook" in to) return ["Sent to the hook (" + hookWords(String(to.hook)).toLowerCase() + ") as " + shownText(to.env)];
    return [];
  });
}

/** What the computer does not run, with its reasons, and how many more it did not list. */
export function notRunRows(contents: Pick<PluginContents, "notRun">): { rows: { name: string; why: string }[]; more: number } {
  const items = Array.isArray(contents.notRun?.items) ? contents.notRun.items : [];
  const rows = items.flatMap((item) => (item && typeof item.name === "string" ? [{ name: shownText(item.name), why: typeof item.why === "string" ? item.why : "" }] : []));
  const count = typeof contents.notRun?.count === "number" ? contents.notRun.count : rows.length;
  return { rows, more: Math.max(0, count - rows.length) };
}

/** The plugin's other files: "214 files · 3.2 MB", and the ones that tools read by themselves ("package.json · 2 KB", "node_modules/ · 180 files"). */
export function otherFilesRows(contents: Pick<PluginContents, "otherFiles">): { line: string; config: string[] } | undefined {
  const other = contents.otherFiles;
  if (!other || typeof other.count !== "number" || other.count <= 0) return undefined;
  const size = sizeWords(other.bytes);
  const row = (file: { path: string; bytes: number; files?: number }) => shownText(file.path) + " · " + (typeof file.files === "number" ? count(file.files, "file", "files") : sizeWords(file.bytes));
  return {
    line: count(other.count, "file", "files") + (size ? " · " + size : ""),
    config: (Array.isArray(other.files) ? other.files : []).filter((file) => file && file.config === true && typeof file.path === "string").map(row),
  };
}

/** A web address's host, or "" when it isn't one. */
export function hostOf(url: string | undefined): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*@)?([^/?#:\s]+)/i.exec(url ?? "");
  return match ? match[2].toLowerCase() : "";
}

/** A tool (MCP server) in a few words, for its row's line: where it runs. What it starts is shown whole under it (`toolFacts`). */
export function toolLine(server: PluginTool): string {
  if (server.kind === "local") return "Runs on your computer";
  const host = hostOf(server.url);
  return host ? "Remote · " + shownText(host) : "Remote";
}

/** Whether a plugin runs anything on the computer: a hook, or a tool started there. */
export const runsOnComputer = (contents: PluginContents) => contents.hooks.length > 0 || contents.mcpServers.some((server) => server.kind === "local");

const count = (n: number, one: string, many: string) => n + " " + (n === 1 ? one : many);
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : items.slice(0, -1).join(", ") + " and " + items.at(-1));

/**
 * What the alert before an install, an update or turning a plugin on says, or null when nothing
 * needs asking. A description with the computer's mark (`starts: 1`) asks when it runs something on
 * the computer. One without the mark asks always: it may not show everything the plugin runs.
 * `older`: the computer does not name "plugin-starts-v1", so the reason is its older app.
 */
export function consent(about: { contents: PluginContents; starts?: unknown }, verb: "install" | "update" | "turn on" = "install", older = false): { title: string; message: string; action: string } | null {
  const contents = about.contents;
  const action = verb === "install" ? "Install" : verb === "update" ? "Update" : "Turn on";
  if (!showsAll(about))
    return {
      title: "This plugin may run commands on your computer",
      message: older
        ? "The app on your computer is older and may not show everything a plugin runs. Update it first, or go on only if you trust where the plugin comes from."
        : "Your computer could not show everything this plugin runs. Go on only if you trust where the plugin comes from.",
      action: action + " anyway",
    };
  if (!runsOnComputer(contents)) return null;
  const parts: string[] = [];
  const events = new Set(contents.hooks.map((hook) => hook.event));
  if (events.size) parts.push(count(contents.hooks.length, "command", "commands") + " (" + list([...events].map((event) => hookWords(event).toLowerCase())) + ")");
  const local = contents.mcpServers.filter((server) => server.kind === "local").map((server) => shownText(server.name));
  if (local.length) parts.push(count(local.length, "tool", "tools") + " (" + list(local) + ")");
  return {
    title: "This plugin runs commands on your computer",
    message: "It runs " + list(parts) + ", with your access. " + (verb === "turn on" ? "Turn it on" : action + " it") + " only if you trust where it comes from.",
    action,
  };
}

/** A chip over the list: everything, one marketplace, or what is installed. */
export type PluginChip = { key: string; label: string; marketplace?: string };
export function pluginChips(marketplaces: PluginMarketplace[] | undefined): PluginChip[] {
  return [{ key: "all", label: "All" }, ...(marketplaces ?? []).map((market) => ({ key: "m:" + market.id, label: market.name, marketplace: market.id })), { key: "installed", label: "Installed" }];
}

/** The quiet line under a plugin's name in a list: its author, else where it comes from. */
export function byLine(listing: PluginListing, marketplaces: PluginMarketplace[] | undefined): string {
  if (listing.author) return listing.author;
  if (listing.marketplace === "folder") return "Folder on your computer";
  return marketplaces?.find((market) => market.id === listing.marketplace)?.name ?? "";
}

/**
 * Whether the computer switched a plugin off and says why: the person looks at it, then turns it
 * on (or updates it first, with `repair`). An entry in error that no update repairs (a linked
 * folder that could not be copied) has nothing to review: it can only be removed.
 */
export const needsReview = (plugin: Pick<InstalledPlugin, "enabled" | "detail" | "status" | "repair">) => !plugin.enabled && !!plugin.detail && (plugin.status !== "error" || plugin.repair === "update");

/**
 * An installed plugin's status as one line. A plugin the computer switched off reads
 * "Off · Needs review"; one a person switched off stays "Off". `page`: on the plugin's own page the
 * computer's sentence is shown whole under the name, so the line stays short.
 */
export function statusLine(plugin: Pick<InstalledPlugin, "status" | "detail" | "enabled" | "repair">, { page = false }: { page?: boolean } = {}): string {
  if (plugin.status !== "error" && needsReview(plugin)) return "Off · Needs review";
  if (plugin.status === "error" && page) return "Something is wrong with this plugin.";
  switch (plugin.status) {
    case "ready":
      return plugin.enabled ? "Ready" : "Off";
    case "needs-config":
      return "Needs settings";
    case "needs-sign-in":
      return "Sign in on your computer";
    default:
      return plugin.detail || "Something is wrong with this plugin.";
  }
}

/** What an installed plugin's setting shows: a secret only whether it is set, anything else its value. */
export function fieldState(field: InstalledPlugin["config"][number]): string {
  if (field.secret) return field.set ? "Set" : "Not set";
  return field.set && field.value ? field.value : "Not set";
}

/** A setting as typed in the install sheet: text, or a saved credential (for a secret). */
export type FieldDraft = { text: string; credential?: { id: string; name: string } };
export const filled = (draft: FieldDraft | undefined) => !!draft && (!!draft.credential || draft.text.trim().length > 0);

/** The labels of the required settings that are still empty. A non-secret field's default counts. */
export function missingFields(fields: PluginField[], drafts: Record<string, FieldDraft>): string[] {
  return fields.filter((field) => field.required && !filled(drafts[field.key]) && !(!field.secret && field.default)).map((field) => field.label);
}

/** The settings to send: only what was filled; a picked credential as its reference. */
export function configValues(fields: PluginField[], drafts: Record<string, FieldDraft>): Record<string, string | { $credential: string }> {
  const out: Record<string, string | { $credential: string }> = {};
  for (const field of fields) {
    const draft = drafts[field.key];
    if (!filled(draft)) continue;
    if (draft.credential && field.secret) out[field.key] = { $credential: draft.credential.id };
    else if (draft.text.trim()) out[field.key] = field.secret ? draft.text : draft.text.trim();
  }
  return out;
}

/** Which bots use a plugin, in a few words. */
export function botsLine(bots: "all" | string[], names: Record<string, string>): string {
  if (bots === "all") return "All bots";
  if (bots.length === 1) return names[bots[0]] ?? "1 bot";
  return bots.length + " bots";
}

/** A marketplace source a person typed: owner/repo (with #ref), an https address, or a folder. */
export function isMarketplaceSource(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 300) return false;
  return /^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(value) || /^https:\/\/[^\s/]+(\/\S*)?$/i.test(value) || /^\/\S/.test(value);
}

/** A link from a manifest, only when it is https. */
export const safeLink = (url: string | undefined) => (url && /^https:\/\/[^\s]+$/i.test(url) ? url : undefined);

/** Installed plugins that match a search, by name. */
export function matchInstalled(plugins: InstalledPlugin[], query: string): InstalledPlugin[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return plugins
    .filter((plugin) => words.every((word) => [plugin.name, plugin.description ?? "", ...(plugin.keywords ?? [])].some((part) => part.toLowerCase().includes(word))))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── The two notices, each shown one time ─────────────────────────────────────

/** What the phone remembers it told: one key for each computer, plugin and place. */
export const noticeKey = (computer: string, pluginId: string, where: "plugins" | "skills") => where + ":" + computer + ":" + pluginId;

/** The notice over the plugins: "Botkins switched off 3 plugins", for those not told about yet. Undefined when there is nothing new to say. */
export function reviewNotice(plugins: InstalledPlugin[] | undefined, computer: string, told: readonly string[]): { title: string; text: string; keys: string[] } | undefined {
  const fresh = (plugins ?? []).filter((plugin) => needsReview(plugin) && !told.includes(noticeKey(computer, plugin.id, "plugins")));
  if (!fresh.length) return undefined;
  return {
    title: "Botkins switched off " + count(fresh.length, "plugin", "plugins"),
    text: "Botkins now shows everything a plugin runs on your computer. Review each one, then turn it on.",
    keys: fresh.map((plugin) => noticeKey(computer, plugin.id, "plugins")),
  };
}

/** The notices in Skills: one for each installed plugin that has skills and is switched off with a reason, not told about yet. */
export function skillsNotices(plugins: InstalledPlugin[] | undefined, computer: string, told: readonly string[]): { id: string; key: string; title: string; text: string }[] {
  return (plugins ?? [])
    .filter((plugin) => needsReview(plugin) && plugin.contents.skills.length > 0 && !told.includes(noticeKey(computer, plugin.id, "skills")))
    .map((plugin) => ({ id: plugin.id, key: noticeKey(computer, plugin.id, "skills"), title: "Skills from " + shownText(plugin.name) + " are off", text: "They are part of a plugin that is switched off. Review it, then turn it on." }));
}

/** Whether a plugin adds nothing this app can name. */
export const addsNothing = (contents: PluginContents) => !contents.skills.length && !contents.agents.length && !contents.commands.length && !contents.mcpServers.length && !contents.hooks.length && !contents.lspServers?.length;
