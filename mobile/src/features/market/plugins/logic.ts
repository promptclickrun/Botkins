// The plain logic of the Plugins pages (docs/plugins.md): hook events in words, a tool in one line,
// what the alert before an install says, the chips, the status line and the settings form. No React
// Native imports, so tests/plugins.test.ts runs it.
import type { InstalledPlugin, PluginContents, PluginField, PluginHookEvent, PluginListing, PluginMarketplace } from "@/link/types";

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
export function groupHooks(hooks: PluginContents["hooks"]): { event: string; label: string; commands: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const hook of hooks) groups.set(hook.event, [...(groups.get(hook.event) ?? []), hook.command]);
  const rank = (event: string) => (ORDER.includes(event) ? ORDER.indexOf(event) : ORDER.length);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([event, commands]) => ({ event, label: hookWords(event), commands }));
}

/** A web address's host, or "" when it isn't one. */
export function hostOf(url: string | undefined): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*@)?([^/?#:\s]+)/i.exec(url ?? "");
  return match ? match[2].toLowerCase() : "";
}

/** A tool (MCP server) in one line: a local one by its command, a remote one by its host. */
export function toolLine(server: PluginContents["mcpServers"][number]): string {
  if (server.kind === "local") return server.command ? "Runs on your computer: " + server.command : "Runs on your computer";
  const host = hostOf(server.url);
  return host ? "Remote · " + host : "Remote";
}

/** Whether a plugin runs anything on the computer: a hook, or a tool started there. */
export const runsOnComputer = (contents: PluginContents) => contents.hooks.length > 0 || contents.mcpServers.some((server) => server.kind === "local");

const count = (n: number, one: string, many: string) => n + " " + (n === 1 ? one : many);
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : items.slice(0, -1).join(", ") + " and " + items.at(-1));

/**
 * What the alert before an install (or an update, or turning on a folder plugin) says, or null when
 * the plugin runs nothing on the computer.
 */
export function consent(contents: PluginContents, verb: "install" | "update" | "turn on" = "install"): { title: string; message: string; action: string } | null {
  if (!runsOnComputer(contents)) return null;
  const parts: string[] = [];
  const events = new Set(contents.hooks.map((hook) => hook.event));
  if (events.size) parts.push(count(contents.hooks.length, "command", "commands") + " (" + list([...events].map((event) => hookWords(event).toLowerCase())) + ")");
  const local = contents.mcpServers.filter((server) => server.kind === "local").map((server) => server.name);
  if (local.length) parts.push(count(local.length, "tool", "tools") + " (" + list(local) + ")");
  const action = verb === "install" ? "Install" : verb === "update" ? "Update" : "Turn on";
  return {
    title: "This plugin runs commands on your computer",
    message: "It runs " + list(parts) + ", with your access. " + action + " it only if you trust where it comes from.",
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

/** An installed plugin's status as one line. */
export function statusLine(plugin: Pick<InstalledPlugin, "status" | "detail" | "enabled">): string {
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

/** Whether a plugin adds nothing this app can name. */
export const addsNothing = (contents: PluginContents) => !contents.skills.length && !contents.agents.length && !contents.commands.length && !contents.mcpServers.length && !contents.hooks.length && !contents.lspServers?.length;
