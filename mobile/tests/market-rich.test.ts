// The rich Market: the Bots and Apps pages' search and filter logic, the brand icon data and the color
// math behind the marks and the washes, and the demo computer's templates (starters first, only the
// ten newer characters).
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_ICONS, APP_ICONS_SOURCE } from "../src/data/appIcons.generated";
import { brandOf, contrast, letterStyle, luminance, markStyle, MARK_CONTRAST, mix, parseHex, wash } from "../src/data/marketColors";
import { appBadge, appChips, appsBlocks, asksFirst, botChips, botSections, chipCategory, connectsLines, featuredApps, filterBots, jobLine } from "../src/features/market/catalog";
import { tooLong } from "../src/features/market/agents/logic";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { DEMO_CATALOG } from "../link-host/mock-catalog.mjs";
import type { MarketAgent, McpCatalogEntry } from "../src/link/types";

const agent = (over: Partial<MarketAgent> & { id: string }): MarketAgent => ({ name: over.id, role: "", summary: "", marketplace: "botkins", marketplaceName: "Botkins", builtIn: true, ...over });
const entry = (over: Partial<McpCatalogEntry> & { id: string }): McpCatalogEntry => ({
  name: over.id,
  category: "work",
  categoryName: "Plans and tasks",
  description: "",
  transport: "http",
  auth: "none",
  keys: [],
  docs: "",
  added: false,
  ...over,
} as McpCatalogEntry);

const bots = [
  agent({ id: "chief", name: "Chief of Staff", role: "Chief of Staff", summary: "Plans the day.", starter: true, category: "productivity", categoryName: "Productivity", approval: "Asks before it sends." }),
  agent({ id: "money", name: "Money manager", role: "Money manager", summary: "Tracks bills.", starter: true, category: "finance", categoryName: "Finance" }),
  agent({ id: "inbox", name: "Inbox Triage", role: "Email sorter", summary: "Sorts your mail.", group: "everyday", category: "productivity", categoryName: "Productivity" }),
  agent({ id: "reviewer", name: "Code Reviewer", role: "Reviewer", summary: "Reads a pull request.", group: "builder", category: "dev", categoryName: "Development" }),
  agent({ id: "notes", name: "Release Notes", role: "Changelog writer", summary: "Writes release notes.", builtIn: false, marketplace: "team", marketplaceName: "Team picks", category: "dev", categoryName: "Development" }),
];

test("the Bots chips: All, Starters, Everyday, For builders, then the categories by count", () => {
  assert.deepEqual(
    botChips(bots).map((chip) => chip.label),
    ["All", "Starters", "Everyday", "For builders", "Productivity", "Development", "Finance"],
  );
  assert.deepEqual(botChips([bots[2]]).map((chip) => chip.key), ["all", "everyday", "cat:productivity"], "a group with nothing in it has no chip");
  assert.equal(chipCategory("cat:dev"), "dev");
  assert.equal(chipCategory("starters"), undefined);
});

test("Bots search matches name, role, summary and category; a chip narrows; a blank query keeps all", () => {
  const ids = (query: string, chip = "all") => filterBots(bots, { query, chip }).map((item) => item.id);
  assert.deepEqual(ids(""), ["chief", "money", "inbox", "reviewer", "notes"], "starters first, then Botkins' own, then the team's");
  assert.deepEqual(ids("   "), ids(""));
  assert.deepEqual(ids("chief"), ["chief"], "by name");
  assert.deepEqual(ids("email"), ["inbox"], "by role");
  assert.deepEqual(ids("pull request"), ["reviewer"], "by summary");
  assert.deepEqual(ids("finance"), ["money"], "by category");
  assert.deepEqual(ids("nothing like this"), []);
  assert.deepEqual(ids("", "starters"), ["chief", "money"]);
  assert.deepEqual(ids("", "everyday"), ["inbox"]);
  assert.deepEqual(ids("", "builder"), ["reviewer"]);
  assert.deepEqual(ids("", "cat:dev"), ["reviewer", "notes"]);
  assert.deepEqual(ids("notes", "cat:dev"), ["notes"], "a query inside a chip");
  assert.deepEqual(ids("notes", "starters"), []);
});

test("the Bots sections are the groups of what passes, and Starters come first", () => {
  assert.deepEqual(
    botSections(bots, {}).map((group) => [group.title, group.agents.map((item) => item.id)]),
    [["Starters", ["chief", "money"]], ["Everyday", ["inbox"]], ["For builders", ["reviewer"]], ["Team picks", ["notes"]]],
  );
  assert.deepEqual(botSections(bots, { query: "zzz" }), []);
});

test("a template's one-line job, and whether it asks first", () => {
  assert.equal(jobLine(bots[0]), "Plans the day.", "a role that only repeats the name gives way to the summary");
  assert.equal(jobLine(bots[2]), "Email sorter");
  assert.equal(asksFirst(bots[0]), true);
  assert.equal(asksFirst(bots[1]), false);
});

const apps = ["notion", "linear", "stripe", "figma", "sentry", "vercel", "calendly", "granola"].map((id, index) =>
  entry({ id, name: id[0].toUpperCase() + id.slice(1), category: index < 2 ? "notes" : index < 4 ? "work" : "code", categoryName: index < 2 ? "Notes and docs" : index < 4 ? "Plans and tasks" : "Code and deploys", description: id + " things" }),
);

test("the Apps chips are All and each category in the computer's order", () => {
  assert.deepEqual(appChips(apps).map((chip) => chip.label), ["All", "Notes and docs", "Plans and tasks", "Code and deploys"]);
});

test("the Apps page: featured, then the categories, then Composio; a category or a query narrows", () => {
  const kinds = (blocks: ReturnType<typeof appsBlocks>) => blocks.map((block) => (block.kind === "category" ? "category:" + block.id : block.kind));
  assert.deepEqual(kinds(appsBlocks(apps, { mac: true, featured: true })), ["mac", "featured", "category:notes", "category:work", "category:code", "composio"]);
  assert.deepEqual(kinds(appsBlocks(apps, { mac: false })), ["category:notes", "category:work", "category:code", "composio"], "no featured unless asked");
  assert.deepEqual(kinds(appsBlocks(apps, { mac: true, featured: true, category: "work" })), ["category:work"], "a category is all of it, alone");
  assert.deepEqual(kinds(appsBlocks(apps, { mac: true, featured: true, category: "all" })), kinds(appsBlocks(apps, { mac: true, featured: true })));
  const found = appsBlocks(apps, { mac: true, featured: true, query: "stripe" });
  assert.deepEqual(kinds(found), ["category:work", "composio"]);
  assert.deepEqual(kinds(appsBlocks(apps, { mac: true, featured: true, query: "zzz" })), ["composio"]);
  assert.deepEqual(featuredApps(apps).map((item) => item.id), ["notion", "linear", "stripe", "figma", "sentry", "vercel"], "the picks the catalog has, in the picks' order");
  assert.deepEqual(featuredApps([apps[7]]), [], "never an app that isn't a pick");
});

test("an app's chip: nothing before it is added, then Added, Sign in, Needs a key, Off", () => {
  assert.equal(appBadge(entry({ id: "a" })), undefined);
  assert.deepEqual(appBadge(entry({ id: "a", added: true })), { label: "Added", attention: false });
  assert.deepEqual(appBadge(entry({ id: "a", added: true, auth: "oauth", signedIn: true })), { label: "Added", attention: false });
  assert.deepEqual(appBadge(entry({ id: "a", added: true, auth: "oauth", signedIn: false })), { label: "Sign in", attention: true });
  assert.deepEqual(appBadge(entry({ id: "a", added: true, auth: "key", keys: [{ id: "key", label: "Key" }], keysSet: false })), { label: "Needs a key", attention: true });
  assert.deepEqual(appBadge(entry({ id: "a", added: true, enabled: false })), { label: "Off", attention: false });
});

test("how an app connects is two short lines, so neither is cut off", () => {
  assert.deepEqual(connectsLines(entry({ id: "a", transport: "stdio", auth: "key" })), { how: "A program on your computer", auth: "Needs an API key" });
  assert.deepEqual(connectsLines(entry({ id: "a", auth: "oauth" })), { how: "Over the internet", auth: "In your browser" });
  assert.deepEqual(connectsLines(entry({ id: "a", local: "Needs Figma's desktop app" })), { how: "An app on your computer", auth: "No sign-in" });
});

test("instructions fold after four lines", () => {
  assert.equal(tooLong("One short line.", 4), false);
  assert.equal(tooLong("a\nb\nc\nd\ne", 4), true, "line breaks count");
  assert.equal(tooLong("x".repeat(42 * 4), 4), false);
  assert.equal(tooLong("x".repeat(42 * 4 + 1), 4), true);
});

test("brand icon data: one monochrome path, a six-digit color and a title, keyed by a catalog id", () => {
  assert.equal(APP_ICONS_SOURCE.name, "Simple Icons");
  assert.match(APP_ICONS_SOURCE.version, /^\d+\.\d+\.\d+$/);
  assert.equal(APP_ICONS_SOURCE.license, "CC0-1.0");
  const ids = Object.keys(APP_ICONS);
  assert.ok(ids.length >= 30);
  for (const id of ids) {
    const icon = APP_ICONS[id];
    assert.match(icon.path, /^[Mm][\d\s.,a-zA-Z-]+$/, id + " path");
    assert.match(icon.hex, /^[0-9A-Fa-f]{6}$/, id + " hex");
    assert.ok(icon.title, id + " title");
  }
  const demo = new Map(DEMO_CATALOG.map((item: { id: string }) => [item.id, item]));
  for (const id of ["notion", "linear", "stripe", "figma", "sentry", "vercel"]) assert.ok(APP_ICONS[id] && demo.has(id), id + " has a mark and is in the demo");
});

test("every brand mark reads on its tile, in either theme", () => {
  for (const [id, icon] of Object.entries(APP_ICONS)) {
    const mark = markStyle(icon.hex);
    assert.ok(contrast(mark.glyph, mark.tile) >= MARK_CONTRAST, id + " " + icon.hex + " on " + mark.tile + " is " + contrast(mark.glyph, mark.tile).toFixed(2));
  }
  assert.ok(luminance(markStyle("000000").tile) > 0.5, "a dark brand sits on a light tile");
  assert.ok(luminance(markStyle("FFE01B").tile) < 0.1, "a pale yellow sits on a dark one");
});

test("the color math", () => {
  assert.deepEqual(parseHex("#ff8000"), [255, 128, 0]);
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(brandOf("Notion", "000000"), "#000000");
  assert.equal(brandOf("Granola"), brandOf("Granola"), "the same name gives the same hue");
  assert.notEqual(brandOf("Granola"), brandOf("Fastmail"));
  const light = letterStyle("Granola", false);
  const dark = letterStyle("Granola", true);
  assert.equal(light.hue, dark.hue);
  assert.notEqual(light.from, dark.from);
  const [a, b] = wash(["#ff0000", "#0000ff"], "#ffffff", false);
  assert.ok(a !== b && /^#[0-9a-f]{6}$/.test(a) && /^#[0-9a-f]{6}$/.test(b));
  assert.ok(contrast("#111111", wash(["#ffff00"], "#ffffff", false)[0]) > 7, "dark text reads on a wash in light");
  assert.ok(contrast("#f4f4f4", wash(["#ffff00"], "#1a1a1a", true)[0]) > 4.5, "light text reads on a wash in dark");
});

test("the demo computer lists the three Home starters first, then only the ten newer characters", () => {
  const backend = new MockBackend({ speed: 0.05 }) as unknown as { handlers: Record<string, (this: unknown, ...args: unknown[]) => { agents: MarketAgent[] }> };
  const { agents } = backend.handlers["agents.browse"].call(backend, {});
  assert.deepEqual(agents.slice(0, 3).map((item) => item.name), ["Chief of Staff", "Coding partner", "Money manager"]);
  assert.deepEqual(agents.slice(0, 3).map((item) => item.look?.head), ["drip", "mallow", "pebble"]);
  assert.ok(agents.slice(0, 3).every((item) => item.starter && item.builtIn && item.deliverable && item.dayOne));
  assert.ok(agents.slice(3).every((item) => !item.starter));
  assert.equal(botSections(agents, {})[0].title, "Starters");
  const newer = new Set(["brim", "clover", "dune", "gloop", "mallow", "ripple", "wisp", "drip", "pebble", "orbit"]);
  for (const item of agents) assert.ok(item.look && newer.has(item.look.head), item.name + " uses " + item.look?.head);
  assert.equal(new Set(agents.map((item) => item.look?.head)).size, agents.length, "each has its own Botkin");
  assert.ok(agents.some((item) => asksFirst(item)), "some ask first");
});
