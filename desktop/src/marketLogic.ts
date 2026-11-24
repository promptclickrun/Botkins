// Marketplace › Bots and Apps, the plain logic: the search, the chips and the sections, the same words
// and the same order as the phone's (mobile/src/features/market/catalog.ts). No React.
import type { MarketAgent, McpCatalogEntry } from "./types";

/** Every word of the query is in one of the fields, any case. An empty query matches nothing. */
export function matches(query: string, fields: (string | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const text = fields.filter(Boolean).join(" \n ").toLowerCase();
  return words.every((word) => text.includes(word));
}

// ---- Bots ----

const rank = (agent: MarketAgent) => (agent.starter ? 0 : agent.builtIn ? (agent.group === "builder" ? 2 : 1) : 3);

/** Starters first, then Botkins' own (everyday before builder), then other marketplaces; otherwise as listed. */
export function orderTemplates(agents: MarketAgent[]) {
  return agents.map((agent, index) => ({ agent, index })).sort((a, b) => rank(a.agent) - rank(b.agent) || a.index - b.index).map((item) => item.agent);
}

/** A chip on the Bots page: "all", "starters", "everyday", "builder", or "cat:<category id>". */
export type BotChip = { key: string; label: string };

const isEveryday = (agent: MarketAgent) => !agent.starter && agent.builtIn && agent.group === "everyday";
const isBuilder = (agent: MarketAgent) => !agent.starter && agent.builtIn && agent.group === "builder";

/** All, Starters, Everyday and For builders (each only when it holds a bot), then each category by how many it holds. */
export function botChips(agents: MarketAgent[]): BotChip[] {
  const chips: BotChip[] = [{ key: "all", label: "All" }];
  if (agents.some((agent) => agent.starter)) chips.push({ key: "starters", label: "Starters" });
  if (agents.some(isEveryday)) chips.push({ key: "everyday", label: "Everyday" });
  if (agents.some(isBuilder)) chips.push({ key: "builder", label: "For builders" });
  const categories = new Map<string, { name: string; count: number; first: number }>();
  agents.forEach((agent, index) => {
    if (!agent.category) return;
    const seen = categories.get(agent.category) ?? { name: agent.categoryName || agent.category, count: 0, first: index };
    seen.count += 1;
    categories.set(agent.category, seen);
  });
  const sorted = [...categories].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first);
  return [...chips, ...sorted.map(([id, item]) => ({ key: "cat:" + id, label: item.name }))];
}

/** The bots a chip keeps. */
export function chipAgents(agents: MarketAgent[], chip: string) {
  if (chip === "starters") return agents.filter((agent) => agent.starter);
  if (chip === "everyday") return agents.filter(isEveryday);
  if (chip === "builder") return agents.filter(isBuilder);
  return chip.startsWith("cat:") ? agents.filter((agent) => agent.category === chip.slice(4)) : agents;
}

/** The Bots page's list: the chip's bots, narrowed by what was typed (name, role, summary, category). An empty query keeps all. */
export function filterBots(agents: MarketAgent[], { query = "", chip = "all" }: { query?: string; chip?: string }) {
  const kept = chipAgents(agents, chip);
  if (!query.trim()) return orderTemplates(kept);
  return orderTemplates(kept).filter((agent) => matches(query, [agent.name, agent.role, agent.summary, agent.categoryName, agent.deliverable, ...(agent.keywords ?? [])]));
}

/** The Bots page, top to bottom: Starters (a carousel), then Everyday, For builders and each other marketplace (grids). */
export function botSections(agents: MarketAgent[], options: { query?: string; chip?: string }) {
  const groups = new Map<string, { key: string; title: string; agents: MarketAgent[] }>();
  const put = (key: string, title: string, agent: MarketAgent) => {
    const group = groups.get(key) ?? { key, title, agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  };
  for (const agent of filterBots(agents, options)) {
    if (agent.starter) put("starters", "Starters", agent);
    else if (isEveryday(agent)) put("everyday", "Everyday", agent);
    else if (isBuilder(agent)) put("builder", "For builders", agent);
    else if (agent.builtIn) put("botkins", agent.marketplaceName || "Botkins", agent);
    else put("market:" + agent.marketplace, agent.marketplaceName || "Other", agent);
  }
  return [...groups.values()];
}

/** A template's one-line job: its role, unless that only repeats the name; then its summary. */
export const jobLine = (agent: MarketAgent) => (agent.role && agent.role.trim().toLowerCase() !== agent.name.trim().toLowerCase() ? agent.role : agent.summary);

/** Under a starter's job: what it hands back, else its category. */
export const deliverableLine = (agent: MarketAgent) => agent.deliverable || agent.categoryName || "";

/** A bot that stops to ask before it acts has an approval step. */
export const asksFirst = (agent: MarketAgent) => !!agent.approval?.trim();

/** Whether a text runs past `lines` lines: about `perLine` letters a line, and each line break counts. */
export const tooLong = (text: string, lines: number, perLine = 90) => text.split("\n").reduce((sum, row) => sum + Math.max(1, Math.ceil(row.length / perLine)), 0) > lines;

// ---- Apps ----

/** The apps the Featured carousel leads with, in this order, when the computer's catalog has them. */
export const FEATURED_APP_IDS = ["notion", "linear", "stripe", "figma", "sentry", "vercel", "supabase", "atlassian", "hubspot", "posthog"] as const;
export const FEATURED_APPS = 6;

export const featuredApps = (entries: McpCatalogEntry[], limit = FEATURED_APPS) => FEATURED_APP_IDS.flatMap((id) => entries.filter((entry) => entry.id === id)).slice(0, limit);

/** All, then each category the catalog has, in the computer's order. */
export function appChips(entries: McpCatalogEntry[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const entry of entries) if (!seen.has(entry.category)) seen.set(entry.category, entry.categoryName || "Other");
  return [{ key: "all", label: "All" }, ...[...seen].map(([key, label]) => ({ key, label }))];
}

export type AppsBlock = { kind: "featured"; entries: McpCatalogEntry[] } | { kind: "category"; id: string; name: string; entries: McpCatalogEntry[] };

/** The Apps page's blocks: the featured apps, then each category narrowed by a query or one chosen category. A query or a category leaves the featured apps out. */
export function appsBlocks(entries: McpCatalogEntry[], { query = "", category = "all" }: { query?: string; category?: string }): AppsBlock[] {
  const searching = !!query.trim();
  const chosen = category !== "all";
  const found = searching ? entries.filter((entry) => matches(query, [entry.name, entry.description, entry.categoryName])) : entries;
  const shown = chosen ? found.filter((entry) => entry.category === category) : found;
  const categories = new Map<string, { kind: "category"; id: string; name: string; entries: McpCatalogEntry[] }>();
  for (const entry of shown) {
    const block = categories.get(entry.category) ?? { kind: "category" as const, id: entry.category, name: entry.categoryName || "Other", entries: [] };
    block.entries.push(entry);
    categories.set(entry.category, block);
  }
  const lead = featuredApps(entries);
  return [...(!searching && !chosen && lead.length ? [{ kind: "featured" as const, entries: lead }] : []), ...categories.values()];
}

/** The chip on an app's card once it is added ("Added", "Sign in", "Needs a key", "Off"); nothing before, when the card offers Add. */
export function appBadge(entry: McpCatalogEntry): { label: string; tone: "ok" | "warn" | "" } | undefined {
  if (!entry.added) return undefined;
  if (entry.auth === "oauth" && entry.signingIn) return { label: "Signing in…", tone: "" };
  if (entry.auth === "oauth" && !entry.signedIn) return { label: "Sign in", tone: "warn" };
  if (entry.keys.length > 0 && entry.keysSet === false) return { label: "Needs a key", tone: "warn" };
  if (entry.enabled === false) return { label: "Off", tone: "" };
  return { label: "Added", tone: "ok" };
}

/** How an app connects, in two short lines: where it runs, and how it signs in. */
export function connectsLines(entry: McpCatalogEntry): { how: string; auth: string } {
  return {
    how: entry.transport === "stdio" ? "A program on your computer" : entry.local ? "An app on your computer" : "Over the internet",
    auth: entry.auth === "oauth" ? "In your browser" : entry.auth === "key" ? "Needs an API key" : "No sign-in",
  };
}
