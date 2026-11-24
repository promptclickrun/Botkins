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

/** How an app connects, in words. */
export function connectsLine(entry: McpCatalogEntry) {
  const how = entry.transport === "stdio" ? "A program on your computer" : entry.local ? "An app on your computer" : "Over the internet";
  const auth = entry.auth === "oauth" ? "signs in in your browser" : entry.auth === "key" ? "needs an API key" : "no sign-in";
  return how + " · " + auth;
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

/** Market › Bots: Starters (when any), Botkins' Everyday and Builder, then each other marketplace. */
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
    else if (agent.builtIn && agent.group === "builder") put("builder", "Builder", agent);
    else if (agent.builtIn) put("botkins", agent.marketplaceName || "Botkins", agent);
    else put("market:" + agent.marketplace, agent.marketplaceName || "Other", agent);
  }
  return [...groups.values()];
}

// ---- Apps page ----

export type AppsBlock = { kind: "mac" } | { kind: "category"; id: string; name: string; entries: McpCatalogEntry[] } | { kind: "composio" };

/**
 * The Apps page, top to bottom: the Mac's own tools first on a Mac, the direct catalog by category
 * (narrowed by a query), and Composio last, as one secondary row. Composio is never in front of the
 * catalog, signed in or not.
 */
export function appsBlocks(entries: McpCatalogEntry[], { mac, query = "" }: { mac: boolean; query?: string }): AppsBlock[] {
  const shown = query.trim() ? searchEntries(entries, query) : entries;
  const categories = new Map<string, { kind: "category"; id: string; name: string; entries: McpCatalogEntry[] }>();
  for (const entry of shown) {
    const block = categories.get(entry.category) ?? { kind: "category" as const, id: entry.category, name: entry.categoryName || "Other", entries: [] };
    block.entries.push(entry);
    categories.set(entry.category, block);
  }
  return [...(mac && !query.trim() ? [{ kind: "mac" as const }] : []), ...categories.values(), { kind: "composio" }];
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
