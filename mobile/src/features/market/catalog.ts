// Market, the plain logic: what an app of the direct catalog offers and how it stands, the search
// on the landing, the order of the shelves (starters first), the Apps page's blocks (Composio is one
// secondary row, never a gate) and the featured skills' groups. No React Native imports.
import type { FeaturedSkill, MarketAgent, McpCatalogEntry, SkillInfo, SkillSource } from "@/link/types";

export const CATALOG_CAPABILITY = "mcp-catalog-v1";
export const FEATURED_CAPABILITY = "skills-featured-v1";

// ---- An app of the direct catalog ----

/**
 * What an app that is not added yet offers. add: one tap. connect: add, then the browser sign-in.
 * key: a masked field per key, sent once. `confirm` is a program's exact line: the person says yes
 * to it before the add, and the add carries it. `local` is the sentence about another app it needs.
 */
export type EntryPlan = { kind: "add" | "connect" | "key"; label: string; confirm?: string; local?: string };

export function entryPlan(entry: McpCatalogEntry): EntryPlan {
  const kind = entry.auth === "oauth" ? "connect" : entry.auth === "key" || entry.keys.length > 0 ? "key" : "add";
  return {
    kind,
    label: kind === "connect" ? "Connect" : kind === "key" ? "Save" : "Add",
    ...(entry.transport === "stdio" && entry.command && { confirm: entry.command }),
    ...(entry.local && { local: entry.local }),
  };
}

/** Whether an add must first be confirmed with the program's line. */
export const needsConfirm = (entry: McpCatalogEntry) => entry.transport === "stdio";

/** The options of an add: the keys typed now, and a program's exact line once the person said yes. */
export function addOptions(entry: McpCatalogEntry, keys?: Record<string, string>, confirmed?: boolean): { keys?: Record<string, string>; confirm?: string } {
  const typed = keys ? Object.fromEntries(Object.entries(keys).filter(([, value]) => value.length > 0)) : {};
  return {
    ...(Object.keys(typed).length > 0 && { keys: typed }),
    ...(needsConfirm(entry) && confirmed && entry.command && { confirm: entry.command }),
  };
}

/** Whether every key field has something in it (a first add needs them all). */
export const keysFilled = (entry: McpCatalogEntry, keys: Record<string, string>) => entry.keys.every((key) => (keys[key.id] ?? "").trim().length > 0);

/** How an added app stands, in one or two words; nothing when it isn't added. */
export function entryState(entry: McpCatalogEntry): { line: string; attention: boolean } | undefined {
  if (!entry.added) return;
  if (entry.enabled === false) return { line: "Off", attention: false };
  if (entry.auth === "oauth") {
    if (entry.signingIn) return { line: "Signing in…", attention: false };
    if (!entry.signedIn) return { line: "Needs sign-in", attention: true };
    return { line: "Signed in", attention: false };
  }
  if (entry.keys.length > 0 && !entry.keysSet) return { line: "Needs a key", attention: true };
  return { line: "Added", attention: false };
}

/** The line under an app in a list: its state when added, then what it does. */
export const entryLine = (entry: McpCatalogEntry) => [entryState(entry)?.line, entry.description].filter(Boolean).join(" · ");

/** How an app connects, in two short lines: where it runs, and how it signs in. */
export function connectsLines(entry: McpCatalogEntry): { how: string; auth: string } {
  return {
    how: entry.transport === "stdio" ? "A program on your computer" : entry.local ? "An app on your computer" : "Over the internet",
    auth: entry.auth === "oauth" ? "In your browser" : entry.auth === "key" ? "Needs an API key" : "No sign-in",
  };
}

/** The chip on an app's card once it is added ("Added", "Sign in", "Needs a key", "Off"); nothing before, when the card offers Add. */
export function appBadge(entry: McpCatalogEntry): { label: string; attention: boolean } | undefined {
  const state = entryState(entry);
  if (!state) return;
  const label = state.line === "Needs sign-in" ? "Sign in" : state.line === "Signed in" ? "Added" : state.line;
  return { label, attention: state.attention };
}

/** Only an address on the web opens from the phone. */
export const openableUrl = (url?: string) => !!url && /^https:\/\//i.test(url);

// ---- Search ----

/** Every word of the query is in one of the fields, any case. An empty query matches nothing. */
export function matches(query: string, fields: (string | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const text = fields.filter(Boolean).join(" \n ").toLowerCase();
  return words.every((word) => text.includes(word));
}

export const searchTemplates = (agents: MarketAgent[], query: string) => orderTemplates(agents).filter((agent) => matches(query, [agent.name, agent.role, agent.summary, agent.categoryName, agent.deliverable, ...(agent.keywords ?? [])]));
export const searchEntries = (entries: McpCatalogEntry[], query: string) => entries.filter((entry) => matches(query, [entry.name, entry.description, entry.categoryName]));
export const searchFeatured = (skills: FeaturedSkill[], query: string) => skills.filter((skill) => matches(query, [skill.name, skill.summary, skill.group, skill.author]));

/** skills.sh is searched from two characters. */
export const SKILLS_SH_MIN = 2;
export const offersSkillsSh = (query: string) => query.trim().length >= SKILLS_SH_MIN;

/** The landing's results for a query. */
export function landingResults(query: string, { agents, entries, skills }: { agents: MarketAgent[]; entries: McpCatalogEntry[]; skills: FeaturedSkill[] }) {
  return { bots: searchTemplates(agents, query), apps: searchEntries(entries, query), skills: searchFeatured(skills, query), skillsSh: offersSkillsSh(query) };
}

// ---- The shelves ----

const rank = (agent: MarketAgent) => (agent.starter ? 0 : agent.builtIn ? (agent.group === "builder" ? 2 : 1) : 3);

/** Starters first, then Botkins' own (everyday before builder), then other marketplaces; otherwise as listed. */
export function orderTemplates(agents: MarketAgent[]) {
  return agents.map((agent, index) => ({ agent, index })).sort((a, b) => rank(a.agent) - rank(b.agent) || a.index - b.index).map((item) => item.agent);
}

/** The landing's featured bot: the first starter, else the first of Botkins' own. */
export const heroTemplate = (agents: MarketAgent[]) => agents.find((agent) => agent.starter) ?? agents.find((agent) => agent.builtIn);

/** The line on a template's card: what it delivers, else its category. Never a made-up count. */
export const cardLine = (agent: MarketAgent) => agent.deliverable || agent.categoryName || agent.marketplaceName;

export const SHELF = { bots: 10, apps: 8, skills: 10 } as const;

/** What the landing shows with no query. */
export function landingShelves({ agents, entries, skills }: { agents: MarketAgent[]; entries: McpCatalogEntry[]; skills: FeaturedSkill[] }) {
  const hero = heroTemplate(agents);
  return {
    hero,
    bots: orderTemplates(agents).filter((agent) => agent.id !== hero?.id).slice(0, SHELF.bots),
    apps: entries.slice(0, SHELF.apps),
    skills: skills.slice(0, SHELF.skills),
  };
}

/** Market › Bots: Starters (when any), Botkins' Everyday and For builders, then each other marketplace. */
export function templateGroups(agents: MarketAgent[]): { key: string; title: string; agents: MarketAgent[] }[] {
  const groups = new Map<string, { key: string; title: string; agents: MarketAgent[] }>();
  const put = (key: string, title: string, agent: MarketAgent) => {
    const group = groups.get(key) ?? { key, title, agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  };
  for (const agent of orderTemplates(agents)) {
    if (agent.starter) put("starters", "Starters", agent);
    else if (agent.builtIn && agent.group === "everyday") put("everyday", "Everyday", agent);
    else if (agent.builtIn && agent.group === "builder") put("builder", "For builders", agent);
    else if (agent.builtIn) put("botkins", agent.marketplaceName || "Botkins", agent);
    else put("market:" + agent.marketplace, agent.marketplaceName || "Other", agent);
  }
  return [...groups.values()];
}

// ---- Bots page: search, chips, sections ----

/** A chip on the Bots page: "all", "starters", "everyday", "builder", or "cat:<category id>". */
export type BotChip = { key: string; label: string };

/** The category's id in a chip's key, if it is one. */
export const chipCategory = (key: string) => (key.startsWith("cat:") ? key.slice(4) : undefined);

/** All, Starters, Everyday and For builders (each only when it holds a bot), then each category by how many it holds. */
export function botChips(agents: MarketAgent[]): BotChip[] {
  const chips: BotChip[] = [{ key: "all", label: "All" }];
  if (agents.some((agent) => agent.starter)) chips.push({ key: "starters", label: "Starters" });
  if (agents.some((agent) => !agent.starter && agent.builtIn && agent.group === "everyday")) chips.push({ key: "everyday", label: "Everyday" });
  if (agents.some((agent) => !agent.starter && agent.builtIn && agent.group === "builder")) chips.push({ key: "builder", label: "For builders" });
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
  if (chip === "everyday") return agents.filter((agent) => !agent.starter && agent.builtIn && agent.group === "everyday");
  if (chip === "builder") return agents.filter((agent) => !agent.starter && agent.builtIn && agent.group === "builder");
  const category = chipCategory(chip);
  return category ? agents.filter((agent) => agent.category === category) : agents;
}

/** The Bots page's list: the chip's bots, narrowed by what was typed (name, role, summary, category). An empty query keeps all. */
export function filterBots(agents: MarketAgent[], { query = "", chip = "all" }: { query?: string; chip?: string }) {
  const kept = chipAgents(agents, chip);
  return query.trim() ? searchTemplates(kept, query) : orderTemplates(kept);
}

/** The Bots page, top to bottom: the groups of the bots that pass the chip and the query. Starters is a carousel; the rest are grids. */
export const botSections = (agents: MarketAgent[], options: { query?: string; chip?: string }) => templateGroups(filterBots(agents, options));

/** A template's one-line job: its role, unless that only repeats the name; then its summary. */
export const jobLine = (agent: MarketAgent) => (agent.role && agent.role.trim().toLowerCase() !== agent.name.trim().toLowerCase() ? agent.role : agent.summary);

/** Under a starter's job: what it hands back, else its category. */
/** A line that may start lowercase in the data ("a short plan…"), shown as a sentence. */
export const sentence = (text: string | undefined) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");

export const deliverableLine = (agent: MarketAgent) => sentence(agent.deliverable) || agent.categoryName || "";

/** A bot that stops to ask before it acts has an approval step. */
export const asksFirst = (agent: MarketAgent) => !!agent.approval?.trim();

// ---- Apps page ----

export type AppsBlock = { kind: "mac" } | { kind: "featured"; entries: McpCatalogEntry[] } | { kind: "category"; id: string; name: string; entries: McpCatalogEntry[] } | { kind: "composio" };

/** The apps the Featured carousel leads with, in this order, when the computer's catalog has them. */
export const FEATURED_APP_IDS = ["notion", "linear", "stripe", "figma", "sentry", "vercel", "supabase", "atlassian", "hubspot", "posthog"] as const;
export const FEATURED_APPS = 6;

/** The featured apps: the picks above that the catalog has, in that order. */
export const featuredApps = (entries: McpCatalogEntry[], limit = FEATURED_APPS) =>
  FEATURED_APP_IDS.flatMap((id) => entries.filter((entry) => entry.id === id)).slice(0, limit);

/** The chips of the Apps page: All, then each category the catalog has, in the computer's order. */
export function appChips(entries: McpCatalogEntry[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const entry of entries) if (!seen.has(entry.category)) seen.set(entry.category, entry.categoryName || "Other");
  return [{ key: "all", label: "All" }, ...[...seen].map(([key, label]) => ({ key, label }))];
}

/**
 * The Apps page, top to bottom: the Mac's own tools first on a Mac, the featured apps, the direct
 * catalog by category (narrowed by a query or one category), and Composio last, as one secondary
 * row. Composio is never in front of the catalog, signed in or not. A query or a chosen category
 * leaves out the Mac's tools and the featured apps, and a chosen category leaves out Composio too.
 */
export function appsBlocks(entries: McpCatalogEntry[], { mac, query = "", category, featured = false }: { mac: boolean; query?: string; category?: string; featured?: boolean }): AppsBlock[] {
  const searching = !!query.trim();
  const chosen = !!category && category !== "all";
  const narrowed = searching || chosen;
  const found = searching ? searchEntries(entries, query) : entries;
  const shown = chosen ? found.filter((entry) => entry.category === category) : found;
  const categories = new Map<string, { kind: "category"; id: string; name: string; entries: McpCatalogEntry[] }>();
  for (const entry of shown) {
    const block = categories.get(entry.category) ?? { kind: "category" as const, id: entry.category, name: entry.categoryName || "Other", entries: [] };
    block.entries.push(entry);
    categories.set(entry.category, block);
  }
  const lead = featuredApps(entries);
  return [
    ...(mac && !narrowed ? [{ kind: "mac" as const }] : []),
    ...(featured && !narrowed && lead.length ? [{ kind: "featured" as const, entries: lead }] : []),
    ...categories.values(),
    ...(chosen ? [] : [{ kind: "composio" as const }]),
  ];
}

// ---- Skills ----

/** The featured shelf by group, in the order the computer lists them. */
export function featuredGroups(skills: FeaturedSkill[]): { group: string; skills: FeaturedSkill[] }[] {
  const groups = new Map<string, FeaturedSkill[]>();
  for (const skill of skills) groups.set(skill.group || "Featured", [...(groups.get(skill.group || "Featured") ?? []), skill]);
  return [...groups].map(([group, list]) => ({ group, skills: list }));
}

/** Under a featured skill: "MIT · Lauren Tan". */
export const featuredLine = (skill: Pick<SkillSource, "license" | "author">) => [skill.license, skill.author].filter(Boolean).join(" · ");

/** Where a featured skill's files are from: "openai/skills@49f948f". */
export const sourceLine = (source: Pick<SkillSource, "repo" | "commit">) => source.repo + "@" + source.commit.slice(0, 7);

/** The skills that ship with Botkins, by name. */
export const builtInSkills = (skills: SkillInfo[] | undefined) => (skills ?? []).filter((skill) => skill.origin === "built-in").sort((a, b) => a.name.localeCompare(b.name));
