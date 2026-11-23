// Agent templates (docs/agent-templates.md): the demo computer over a paired link. Browse lists the
// templates with category counts, a category and a search narrow it, a template comes with its
// instructions, a gone one is refused with a sentence, and the link refuses a search that is too long.
// Also the lines the phone draws from a template, and the capability the demo names.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { agentChips, fromLine, listLine, pageLine, templateAvailability } from "../src/features/market/agents/logic";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { MarketAgent, MarketAgentCategory, MarketAgentTemplate } from "../src/link/types";

const fetcher = fetch as unknown as FetchLike;
type Browse = { agents: MarketAgent[]; categories: MarketAgentCategory[] };

test("agent templates on the demo computer, over a paired link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-agents-"));
  const backend = new MockBackend({ speed: 0.05 });
  assert.ok(backend.capabilities.includes("agent-templates-v1"));
  const link = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const pairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const client = new LinkClient(pairing, { fetch: fetcher, onParts: () => {}, onState: () => {} });
  const refusal = (work: Promise<unknown>) => work.then(() => null, (error: Error) => error.message);
  try {
    const all = await client.call<Browse>("agents.browse", {});
    assert.ok(all.agents.length >= 5);
    assert.ok(all.agents.every((agent) => agent.id && agent.name && agent.summary && agent.marketplaceName && !("instructions" in agent)));
    assert.equal(all.agents[0].marketplaceName, "Botkins", "the built-in marketplace comes first");
    assert.ok(all.agents.some((agent) => !agent.builtIn && agent.marketplaceName === "Team picks"));
    assert.equal(new Set(all.agents.map((agent) => agent.look?.head)).size, all.agents.length, "each has its own Botkin");
    assert.ok(all.categories.length >= 3);
    assert.equal(all.categories.reduce((sum, item) => sum + item.count, 0), all.agents.filter((agent) => agent.category).length);

    // A category narrows the list; the counts still count the other categories.
    const writing = await client.call<Browse>("agents.browse", { category: "writing" });
    assert.ok(writing.agents.length > 0 && writing.agents.length < all.agents.length);
    assert.ok(writing.agents.every((agent) => agent.category === "writing"));
    assert.deepEqual(writing.categories, all.categories);

    // A search matches keywords too, and the counts follow it.
    const mail = await client.call<Browse>("agents.browse", { query: "  email " });
    assert.deepEqual(mail.agents.map((agent) => agent.name), ["Inbox Triage"]);
    assert.deepEqual(mail.categories, [{ id: "productivity", name: "Productivity", count: 1 }]);
    assert.deepEqual((await client.call<Browse>("agents.browse", { marketplace: "team-picks" })).agents.map((agent) => agent.builtIn), [false]);

    // A template comes with its instructions; a gone one is refused with a sentence.
    const template = await client.call<MarketAgentTemplate>("agents.template", mail.agents[0].id);
    assert.equal(template.name, "Inbox Triage");
    assert.match(template.instructions, /inbox/);
    assert.equal(await refusal(client.call("agents.template", "no-such@botkins")), "That template isn't in its marketplace any more.");

    // The link refuses a search over 200 characters before the computer sees it.
    assert.equal(await refusal(client.call("agents.browse", { query: "a".repeat(201) })), "That search is too long.");
    assert.equal((await client.call<Browse>("agents.browse", { query: "a".repeat(200) })).agents.length, 0);

    // What the phone draws from them.
    const team = all.agents.find((agent) => !agent.builtIn)!;
    assert.equal(listLine(team), "Development · Team picks");
    assert.equal(pageLine(team), "Development · Team picks · v2.0.0 · Acme platform team");
    assert.equal(fromLine(team), "From Team picks. Someone else wrote these instructions: read them first.");
    assert.equal(fromLine(template), undefined);
    assert.deepEqual(agentChips(mail.categories, { id: "writing", name: "Writing" }).map((chip) => chip.label), ["All", "Productivity 1", "Writing 0"]);
  } finally {
    client.stop();
    await link.stop();
  }
});

test("the demo leaves agent-templates-v1 out with BOTKINS_DEV_AGENTS=off", () => {
  process.env.BOTKINS_DEV_AGENTS = "off";
  try {
    assert.ok(!new MockBackend({ speed: 0.05 }).capabilities.includes("agent-templates-v1"));
  } finally {
    delete process.env.BOTKINS_DEV_AGENTS;
  }
});

test("New bot explains an older computer or a disconnected link before browsing templates", () => {
  assert.equal(templateAvailability(false, true), "Update the app on your computer");
  assert.equal(templateAvailability(true, false), "Connect to your computer");
  assert.equal(templateAvailability(true, true), undefined);
});
