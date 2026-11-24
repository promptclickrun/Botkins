// Market's plain logic (src/features/market/catalog.ts): what an app of the direct catalog offers by
// how it signs in, that a program on the computer needs a yes with its exact line, the state line of
// an added app, the landing's search and shelves (starters first, skills with no query), the Bots
// groups, and that Composio is one secondary row on the Apps page, never a gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pairingTitle } from "../src/features/market/agents/logic";
import {
  addOptions,
  appsBlocks,
  builtInSkills,
  entryPlan,
  entryState,
  featuredGroups,
  featuredLine,
  heroTemplate,
  keysFilled,
  landingResults,
  landingShelves,
  needsConfirm,
  offersSkillsSh,
  openableUrl,
  orderTemplates,
  sourceLine,
  templateGroups,
} from "../src/features/market/catalog";
import type { FeaturedSkill, MarketAgent, McpCatalogEntry, SkillInfo } from "../src/link/types";

const entry = (over: Partial<McpCatalogEntry> & { id: string }): McpCatalogEntry => ({
  name: over.id[0].toUpperCase() + over.id.slice(1),
  category: "work",
  categoryName: "Plans and tasks",
  description: "Does a thing.",
  transport: "http",
  auth: "none",
  url: "https://example.com/mcp",
  keys: [],
  docs: "https://example.com/docs",
  icon: { letter: over.id[0].toUpperCase() },
  added: false,
  ...over,
});

const KEY = [{ id: "key", label: "API key" }];
const context7 = entry({ id: "context7", category: "code", categoryName: "Code and deploys" });
const notion = entry({ id: "notion", auth: "oauth", category: "notes", categoryName: "Notes and docs" });
const render = entry({ id: "render", auth: "key", keys: KEY, category: "code", categoryName: "Code and deploys" });
const brave = entry({ id: "brave", transport: "stdio", url: undefined, package: "@brave/brave-search-mcp-server", version: "2.1.4", license: "MIT", command: "npx -y @brave/brave-search-mcp-server@2.1.4", env: ["BRAVE_API_KEY"], auth: "key", keys: KEY, category: "research", categoryName: "Search and research" });
const sqlite = entry({ id: "sqlite", transport: "stdio", url: undefined, package: "mcp-sqlite", version: "1.0.0", license: "MIT", command: "npx -y mcp-sqlite@1.0.0", env: [] });
const figma = entry({ id: "figma", url: "http://127.0.0.1:3845/mcp", local: "Needs Figma's desktop app, with its MCP server turned on.", category: "design", categoryName: "Design and media" });
const ENTRIES = [context7, notion, render, brave, figma];

const agent = (over: Partial<MarketAgent> & { id: string }): MarketAgent => ({ name: over.id, role: "", summary: "", marketplace: "botkins", marketplaceName: "Botkins", builtIn: true, ...over });
const AGENTS = [
  agent({ id: "outside", builtIn: false, marketplace: "acme", marketplaceName: "Acme" }),
  agent({ id: "builder", group: "builder" }),
  agent({ id: "everyday", group: "everyday", deliverable: "A short brief" }),
  agent({ id: "starter-b", starter: true, group: "everyday" }),
  agent({ id: "starter-a", starter: true, group: "builder", name: "Inbox helper", summary: "Sorts your mail" }),
];

const skill = (name: string, group: string): FeaturedSkill => ({ id: "o/r/" + name + "@abcdef1", name, summary: "Helps with " + name, group, author: "Lauren Tan", license: "MIT", repo: "cursor/plugins", commit: "792440e8a560a4a3f63748cdee70491ecd412982", path: "skills/" + name, url: "https://github.com/cursor/plugins/tree/x/skills/" + name });
const SKILLS = [skill("tdd", "Engineering habits"), skill("frontend-design", "Writing and design"), skill("unslop", "Engineering habits")];

test("each kind of entry offers its own action", () => {
  assert.deepEqual(entryPlan(context7), { kind: "add", label: "Add" });
  assert.deepEqual(entryPlan(notion), { kind: "connect", label: "Connect" });
  assert.deepEqual(entryPlan(render), { kind: "key", label: "Save" });
  assert.deepEqual(entryPlan(brave), { kind: "key", label: "Save", confirm: brave.command });
  assert.deepEqual(entryPlan(sqlite), { kind: "add", label: "Add", confirm: sqlite.command });
  assert.deepEqual(entryPlan(figma), { kind: "add", label: "Add", local: figma.local });
});

test("a program on the computer needs a yes, and the add carries its exact line only then", () => {
  assert.equal(needsConfirm(sqlite), true);
  assert.equal(needsConfirm(brave), true);
  assert.equal(needsConfirm(context7), false);
  assert.deepEqual(addOptions(sqlite, undefined, false), {});
  assert.deepEqual(addOptions(sqlite, undefined, true), { confirm: "npx -y mcp-sqlite@1.0.0" });
  assert.deepEqual(addOptions(brave, { key: "secret" }, true), { keys: { key: "secret" }, confirm: brave.command });
  // An http app never sends a confirm, and an empty field is left out (the stored key is kept).
  assert.deepEqual(addOptions(render, { key: "" }, true), {});
  assert.deepEqual(addOptions(render, { key: "k" }), { keys: { key: "k" } });
});

test("a first key needs every field filled", () => {
  assert.equal(keysFilled(render, {}), false);
  assert.equal(keysFilled(render, { key: "  " }), false);
  assert.equal(keysFilled(render, { key: "k" }), true);
  assert.equal(keysFilled(context7, {}), true);
});

test("an added app says how it stands", () => {
  assert.equal(entryState(context7), undefined);
  assert.deepEqual(entryState({ ...context7, added: true, enabled: true }), { line: "Added", attention: false });
  assert.deepEqual(entryState({ ...context7, added: true, enabled: false }), { line: "Off", attention: false });
  assert.deepEqual(entryState({ ...notion, added: true, enabled: true, signedIn: false }), { line: "Needs sign-in", attention: true });
  assert.deepEqual(entryState({ ...notion, added: true, enabled: true, signingIn: true }), { line: "Signing in…", attention: false });
  assert.deepEqual(entryState({ ...notion, added: true, enabled: true, signedIn: true }), { line: "Signed in", attention: false });
  assert.deepEqual(entryState({ ...render, added: true, enabled: true, keysSet: false }), { line: "Needs a key", attention: true });
  assert.deepEqual(entryState({ ...render, added: true, enabled: true, keysSet: true }), { line: "Added", attention: false });
});

test("only a web address opens from the phone", () => {
  assert.equal(openableUrl("https://linear.app/docs/mcp"), true);
  assert.equal(openableUrl("http://127.0.0.1:3845/mcp"), false);
  assert.equal(openableUrl("javascript:alert(1)"), false);
  assert.equal(openableUrl(undefined), false);
});

test("starters come first, then Botkins' everyday and builder, then other marketplaces", () => {
  assert.deepEqual(orderTemplates(AGENTS).map((a) => a.id), ["starter-b", "starter-a", "everyday", "builder", "outside"]);
  assert.equal(heroTemplate(AGENTS)?.id, "starter-b");
  assert.equal(heroTemplate(AGENTS.filter((a) => !a.starter))?.id, "builder");
  assert.equal(heroTemplate([AGENTS[0]]), undefined);
  assert.deepEqual(
    templateGroups(AGENTS).map((g) => [g.title, g.agents.map((a) => a.id)]),
    [["Starters", ["starter-b", "starter-a"]], ["Everyday", ["everyday"]], ["Builder", ["builder"]], ["Acme", ["outside"]]],
  );
  // No starters: no Starters group.
  assert.equal(templateGroups(AGENTS.filter((a) => !a.starter)).some((g) => g.title === "Starters"), false);
});

test("the landing's shelves with no query: the hero, then bots without it, apps and skills", () => {
  const shelves = landingShelves({ agents: AGENTS, entries: ENTRIES, skills: SKILLS });
  assert.equal(shelves.hero?.id, "starter-b");
  assert.deepEqual(shelves.bots.map((a) => a.id), ["starter-a", "everyday", "builder", "outside"]);
  assert.equal(shelves.apps.length, ENTRIES.length);
  assert.ok(shelves.skills.length > 0);
  assert.deepEqual(shelves.skills.map((s) => s.name), ["tdd", "frontend-design", "unslop"]);
});

test("the landing's search finds bots, apps and skills, and offers skills.sh from two characters", () => {
  const found = landingResults("inbox", { agents: AGENTS, entries: ENTRIES, skills: SKILLS });
  assert.deepEqual(found.bots.map((a) => a.id), ["starter-a"]);
  assert.equal(landingResults("mail", { agents: AGENTS, entries: ENTRIES, skills: SKILLS }).bots[0]?.id, "starter-a");
  assert.deepEqual(landingResults("NOTION", { agents: AGENTS, entries: ENTRIES, skills: SKILLS }).apps.map((e) => e.id), ["notion"]);
  assert.deepEqual(landingResults("unslop", { agents: AGENTS, entries: ENTRIES, skills: SKILLS }).skills.map((s) => s.name), ["unslop"]);
  assert.deepEqual(landingResults("search research", { agents: AGENTS, entries: ENTRIES, skills: SKILLS }).apps.map((e) => e.id), ["brave"]);
  assert.equal(offersSkillsSh("a"), false);
  assert.equal(offersSkillsSh(" ab "), true);
  assert.equal(landingResults("zz", { agents: [], entries: [], skills: [] }).skillsSh, true);
});

test("Composio is one secondary row at the end of Apps, not a gate", () => {
  const blocks = appsBlocks(ENTRIES, { mac: false });
  assert.equal(blocks.at(-1)?.kind, "composio");
  assert.equal(blocks.filter((b) => b.kind === "composio").length, 1);
  // The direct catalog is there in full, before Composio, with no sign-in of any kind.
  const shown = blocks.flatMap((b) => (b.kind === "category" ? b.entries.map((e) => e.id) : []));
  assert.deepEqual(new Set(shown), new Set(ENTRIES.map((e) => e.id)));
  assert.equal(blocks[0].kind, "category");
  // With nothing in the catalog (an older computer) Composio is still offered.
  assert.deepEqual(appsBlocks([], { mac: false }).map((b) => b.kind), ["composio"]);
});

test("on a Mac its own tools come first; a search narrows the catalog", () => {
  assert.equal(appsBlocks(ENTRIES, { mac: true })[0].kind, "mac");
  assert.equal(appsBlocks(ENTRIES, { mac: false }).some((b) => b.kind === "mac"), false);
  const narrowed = appsBlocks(ENTRIES, { mac: true, query: "linear notion" });
  assert.deepEqual(narrowed.map((b) => b.kind), ["composio"]);
  const notes = appsBlocks(ENTRIES, { mac: true, query: "notion" });
  assert.deepEqual(notes.map((b) => (b.kind === "category" ? b.name : b.kind)), ["Notes and docs", "composio"]);
});

test("featured skills by group, with license, author and a pinned source", () => {
  assert.deepEqual(featuredGroups(SKILLS).map((g) => [g.group, g.skills.map((s) => s.name)]), [["Engineering habits", ["tdd", "unslop"]], ["Writing and design", ["frontend-design"]]]);
  assert.equal(featuredLine(SKILLS[0]), "MIT · Lauren Tan");
  assert.equal(sourceLine(SKILLS[0]), "cursor/plugins@792440e");
});

test("Built into Botkins lists only the skills that ship with it", () => {
  const list: SkillInfo[] = [
    { name: "my-skill", description: "", path: "", origin: "botkins", enabled: true },
    { name: "meeting-actions", description: "", path: "", origin: "built-in", enabled: true },
    { name: "daily-brief", description: "", path: "", origin: "built-in", enabled: true },
  ];
  assert.deepEqual(builtInSkills(list).map((s) => s.name), ["daily-brief", "meeting-actions"]);
  assert.deepEqual(builtInSkills(undefined), []);
});

test("a template's pairing reads as a routine with its cadence, or proactive", () => {
  assert.equal(pairingTitle({ kind: "routine", cadence: "Weekdays at 8:00", note: "" }), "Routine · Weekdays at 8:00");
  assert.equal(pairingTitle({ kind: "routine", note: "" }), "Routine");
  assert.equal(pairingTitle({ kind: "proactive", note: "Checks in" }), "Proactive");
});
