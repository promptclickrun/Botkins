// Marketplace › Bots and Apps, the plain logic (src/marketLogic.ts): the search, the chips and the
// sections, kept the same as the phone's (mobile/src/features/market/catalog.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { appBadge, appChips, appsBlocks, asksFirst, botChips, botSections, connectsLines, filterBots, jobLine, matches, tooLong } from "../src/marketLogic.ts";

const agent = (over) => ({ name: over.id, role: "", summary: "", marketplace: "botkins", marketplaceName: "Botkins", builtIn: true, ...over });
const entry = (over) => ({ name: over.id, category: "work", categoryName: "Plans and tasks", description: "", transport: "http", auth: "none", keys: [], docs: "", added: false, ...over });

const bots = [
  agent({ id: "inbox", name: "Inbox Triage", role: "Inbox", summary: "Sorts your mail.", group: "everyday", category: "productivity", categoryName: "Productivity" }),
  agent({ id: "chief", name: "Chief of Staff", role: "Chief of Staff", summary: "Plans the day.", starter: true, category: "productivity", categoryName: "Productivity", approval: "Asks before it sends." }),
  agent({ id: "review", name: "Code Reviewer", role: "Reviews diffs", summary: "Reads a change.", group: "builder", category: "engineering", categoryName: "Engineering" }),
  agent({ id: "quill", name: "Quill", role: "Writer", summary: "Drafts posts.", builtIn: false, marketplace: "local", marketplaceName: "Local market", category: "writing", categoryName: "Writing" }),
];

test("the Bots chips: All, Starters, Everyday, For builders, then the categories", () => {
  assert.deepEqual(botChips(bots).map((chip) => chip.label), ["All", "Starters", "Everyday", "For builders", "Productivity", "Engineering", "Writing"]);
  assert.deepEqual(botChips([bots[0]]).map((chip) => chip.label), ["All", "Everyday", "Productivity"]);
});

test("Bots search matches name, role, summary and category; a chip narrows; a blank query keeps all", () => {
  const ids = (list) => list.map((item) => item.id);
  assert.deepEqual(ids(filterBots(bots, { query: "mail" })), ["inbox"]);
  assert.deepEqual(ids(filterBots(bots, { query: "REVIEWS" })), ["review"]);
  assert.deepEqual(ids(filterBots(bots, { query: "engineering" })), ["review"]);
  assert.deepEqual(ids(filterBots(bots, { query: "plans staff" })), ["chief"]);
  assert.deepEqual(ids(filterBots(bots, { query: "zzz" })), []);
  assert.deepEqual(ids(filterBots(bots, { query: "  " })), ["chief", "inbox", "review", "quill"]);
  assert.deepEqual(ids(filterBots(bots, { chip: "starters" })), ["chief"]);
  assert.deepEqual(ids(filterBots(bots, { chip: "cat:productivity" })), ["chief", "inbox"]);
  assert.deepEqual(ids(filterBots(bots, { chip: "cat:productivity", query: "mail" })), ["inbox"]);
});

test("the Bots sections: Starters first, then Everyday, For builders, each other marketplace", () => {
  assert.deepEqual(botSections(bots, {}).map((section) => section.title), ["Starters", "Everyday", "For builders", "Local market"]);
  assert.deepEqual(botSections(bots, { query: "zzz" }), []);
});

test("a template's one-line job, whether it asks first, and when instructions fold", () => {
  assert.equal(jobLine(bots[1]), "Plans the day.");
  assert.equal(jobLine(bots[0]), "Inbox");
  assert.equal(asksFirst(bots[1]), true);
  assert.equal(asksFirst(bots[0]), false);
  assert.equal(tooLong("short", 4), false);
  assert.equal(tooLong("a\nb\nc\nd\ne", 4), true);
  assert.equal(tooLong("x".repeat(400), 4), true);
});

const apps = [
  entry({ id: "notion", name: "Notion", description: "Pages and notes" }),
  entry({ id: "linear", name: "Linear", description: "Issues", category: "dev", categoryName: "Developer tools", added: true, auth: "oauth", signedIn: true }),
  entry({ id: "stripe", name: "Stripe", description: "Payments", category: "money", categoryName: "Money", added: true, keys: [{ id: "K", label: "Key" }], keysSet: false }),
  entry({ id: "sentry", name: "Sentry", description: "Errors", category: "dev", categoryName: "Developer tools", added: true, enabled: false }),
];

test("the Apps chips are All and each category in the computer's order", () => {
  assert.deepEqual(appChips(apps).map((chip) => chip.label), ["All", "Plans and tasks", "Developer tools", "Money"]);
});

test("the Apps page: featured first, then categories; a category or a query narrows", () => {
  const all = appsBlocks(apps, {});
  assert.equal(all[0].kind, "featured");
  assert.deepEqual(all[0].entries.map((item) => item.id), ["notion", "linear", "stripe", "sentry"]);
  assert.deepEqual(all.slice(1).map((block) => block.name), ["Plans and tasks", "Developer tools", "Money"]);
  const dev = appsBlocks(apps, { category: "dev" });
  assert.deepEqual(dev.map((block) => block.kind), ["category"]);
  assert.deepEqual(dev[0].entries.map((item) => item.id), ["linear", "sentry"]);
  const found = appsBlocks(apps, { query: "payments" });
  assert.deepEqual(found.map((block) => block.kind), ["category"]);
  assert.deepEqual(found[0].entries.map((item) => item.id), ["stripe"]);
  assert.deepEqual(appsBlocks(apps, { query: "zzz" }), []);
  assert.equal(matches("", ["anything"]), false);
});

test("an app's chip: nothing before it is added, then Added, Sign in, Needs a key, Off", () => {
  const [notion, linear, stripe, sentry] = apps;
  assert.equal(appBadge(notion), undefined);
  assert.equal(appBadge(linear).label, "Added");
  assert.equal(appBadge({ ...linear, signedIn: false }).label, "Sign in");
  assert.equal(appBadge(stripe).label, "Needs a key");
  assert.equal(appBadge(sentry).label, "Off");
});

test("how an app connects is two short lines", () => {
  assert.deepEqual(connectsLines(entry({ id: "a", transport: "stdio", auth: "key" })), { how: "A program on your computer", auth: "Needs an API key" });
  assert.deepEqual(connectsLines(entry({ id: "b", auth: "oauth" })), { how: "Over the internet", auth: "Signs in in your browser" });
});
