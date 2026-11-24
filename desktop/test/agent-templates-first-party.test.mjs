// Botkins' own agent templates (desktop/agent-templates-first-party.mjs): the single-job contract,
// the looks they may wear, and where they show in agents.browse.
import test from "node:test";
import assert from "node:assert/strict";
import { bundledTemplates, contractOf, FIRST_PARTY_TEMPLATES, HOME_STARTERS, NEWER_HEADS, STARTER_HEADS } from "../desktop/agent-templates-first-party.mjs";
import { templateFields } from "../desktop/templates.mjs";
import { AGENT_CATEGORIES } from "../desktop/plugin-catalog.mjs";
import { PALETTES } from "../desktop/looks.mjs";
import { CATALOG } from "../desktop/mcp-catalog.mjs";

const NAMES = {
  everyday: ["Copy Editor", "Research Desk", "Home Care Log", "Subscription & Bill Watch", "Morning Brief"],
  builder: ["Change Reviewer", "Bug Fixer", "PR Shepherd", "Scope Writer", "Launch Coordinator", "Design Critic", "Spend Auditor"],
};

test("the set is the agreed twelve, in two groups, and none is a Home starter", () => {
  for (const group of ["everyday", "builder"])
    assert.deepEqual(FIRST_PARTY_TEMPLATES.filter((t) => t.group === group).map((t) => t.template.name), NAMES[group]);
  const names = FIRST_PARTY_TEMPLATES.map((t) => t.template.name.toLowerCase());
  for (const starter of ["chief of staff", "coding partner", "money manager"]) assert.equal(names.includes(starter), false, starter + " belongs to the Home starters");
  assert.equal(new Set(FIRST_PARTY_TEMPLATES.map((t) => t.name)).size, FIRST_PARTY_TEMPLATES.length);
  assert.deepEqual(HOME_STARTERS, [], "the starters are connected at merge");
});

test("each template keeps the single-job contract", () => {
  for (const t of FIRST_PARTY_TEMPLATES) {
    const where = t.name;
    // 1. One job and a named deliverable, said in the summary.
    assert.ok(t.deliverable && t.template.summary.toLowerCase().includes(t.deliverable.toLowerCase()), where + ": the summary names the deliverable");
    assert.match(t.instructions, /^Your one job: /, where);
    assert.ok(t.instructions.includes("What you hand back: "), where);
    // 2. Useful on day one: from text, files or screenshots, or with connected apps.
    assert.ok(t.dayOne, where);
    assert.match(t.instructions, /pasted text, files or screenshots/, where);
    // 3. An approval step before any external write or send.
    assert.ok(t.approval, where);
    assert.match(t.instructions, /Ask first: before you send, post, file, buy, delete or change anything outside this chat, show me exactly what you will do and wait for my yes\./, where);
    // 4. A pairing, when there is one, is a Routine or Proactive, and every watching run stays quiet.
    if (t.pairing) {
      assert.ok(["routine", "proactive"].includes(t.pairing.kind), where);
      assert.ok(t.pairing.note, where);
      if (t.pairing.kind === "routine") assert.ok(t.pairing.cadence, where + ": a routine says when");
    }
    assert.match(t.instructions, /finds nothing new, say nothing/, where);
    // The template is one the app can import, in a category it knows.
    assert.doesNotThrow(() => templateFields({ ...t.template, instructions: t.instructions }), where);
    assert.ok(Object.hasOwn(AGENT_CATEGORIES, t.category), where);
    for (const app of t.apps ?? []) assert.ok(CATALOG.some((e) => e.id === app), where + ": " + app + " is in the apps catalog");
    const listing = contractOf(t);
    assert.deepEqual(Object.keys(listing).filter((k) => !["deliverable", "dayOne", "approval", "group", "pairing", "apps"].includes(k)), []);
  }
  assert.ok(FIRST_PARTY_TEMPLATES.filter((t) => t.pairing).length >= 4);
});

test("looks use only the ten newer Botkins, never the three the starters wear", () => {
  for (const t of FIRST_PARTY_TEMPLATES) {
    assert.ok(NEWER_HEADS.includes(t.template.look.head), t.name);
    assert.equal(STARTER_HEADS.includes(t.template.look.head), false, t.name);
    assert.ok(PALETTES.includes(t.template.look.palette), t.name);
  }
});

test("starters are listed before every other template", () => {
  const starter = { name: "chief-of-staff", category: "productivity", group: "everyday", template: { name: "Chief of Staff", role: "r", summary: "s", look: { head: "drip", palette: "original" } }, instructions: "i" };
  const list = bundledTemplates([starter]);
  assert.equal(list[0].starter, true);
  assert.equal(list[0].name, "chief-of-staff");
  assert.equal(list.slice(1).some((t) => t.starter), false);
});

test("agents.browse lists Botkins' own first, with the contract fields, and agents.template answers one", async (t) => {
  const { PluginCatalog } = await import("../desktop/plugin-catalog.mjs");
  const { tempDir } = await import("./fake-copilot.mjs");
  // No marketplace can be read here (the network is refused): only the bundled templates are listed.
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  t.after(() => (globalThis.fetch = real));
  const catalog = new PluginCatalog(tempDir(t));
  const { agents, categories } = await catalog.agents({});
  const own = agents.filter((a) => a.marketplace === "botkins-app");
  assert.deepEqual(own.map((a) => a.name), [...NAMES.everyday, ...NAMES.builder]);
  assert.equal(agents.indexOf(own[0]), 0, "first");
  const bill = own.find((a) => a.name === "Subscription & Bill Watch");
  assert.deepEqual([bill.builtIn, bill.author, bill.deliverable, bill.pairing.kind], [true, "Botkins", "a list of recurring charges with renewal dates and price changes", "proactive"]);
  assert.ok(categories.some((c) => c.id === "dev"));
  const found = await catalog.agentTemplate(own[0].id);
  assert.match(found.instructions, /^Your one job: /);
  assert.equal((await catalog.agents({ query: "pull request" })).agents.some((a) => a.name === "PR Shepherd"), true);
  await assert.rejects(catalog.agentTemplate("gone@botkins-app"), /no longer in Botkins/);
});
