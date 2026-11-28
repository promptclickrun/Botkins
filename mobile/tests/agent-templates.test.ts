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
import { authorize, filterParts } from "../link-host/team.mjs";
import { agentChips, fromLine, listLine, pageLine, templateAvailability } from "../src/features/market/agents/logic";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { MarketAgent, MarketAgentCategory, MarketAgentTemplate } from "../src/link/types";

const fetcher = fetch as unknown as FetchLike;
type Browse = { agents: MarketAgent[]; categories: MarketAgentCategory[] };

test("agent templates on the demo computer, over a paired link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-agents-"));
  const backend = new MockBackend({ speed: 0.05 });
  assert.ok(backend.capabilities.includes("agent-templates-v1"));
  assert.ok(backend.capabilities.includes("agent-template-bundles-v1"));
  const link = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const pairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const client = new LinkClient(pairing, { fetch: fetcher, onParts: () => {}, onState: () => {} });
  const refusal = (work: Promise<unknown>) => work.then(() => null, (error: Error) => error.message);
  try {
    const all = await client.call<Browse>("agents.browse", {});
    assert.ok(all.agents.length >= 5);
    assert.ok(all.agents.every((agent) => agent.id && agent.name && agent.summary && agent.marketplaceName && !("bundle" in agent) && !("instructions" in agent)));
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
    await assert.rejects(client.call("agents.template", mail.agents[0].id), /Update Botkins/);
    assert.equal((await client.call<MarketAgentTemplate>("agents.template", all.agents.find(agent => !agent.builtIn)!.id)).bundle, undefined);
    const template = await client.call<MarketAgentTemplate>("agents.template", mail.agents[0].id, 2);
    assert.equal(template.name, "Inbox Triage");
    assert.match(template.instructions, /inbox/);
    assert.equal(await refusal(client.call("agents.template", "no-such@botkins")), "That template isn't in its marketplace any more.");

    const bundle = template.bundle!;
    assert.equal(bundle.skills?.length, 1);
    assert.equal(bundle.routines?.length, 1);
    const fields = { name: "Sorter", role: template.role, instructions: template.instructions, bundle };
    const botsBefore = backend.state.bots.length;
    await assert.rejects(client.call("addBot", { ...fields, bundle: { routines: [{ ...bundle.routines![0], script: "unsupported" }] } }), /unknown field/);
    assert.equal(backend.state.bots.length, botsBefore);
    const made = await client.call<string>("addBot", fields);
    const scheduleChat = backend.state.chats.find((chat: any) => chat.botId === made && chat.schedules?.some((entry: any) => entry.fromTemplate))!;
    const [routine] = scheduleChat.schedules;
    assert.deepEqual([routine.enabled, routine.notify, routine.cadence, routine.deliver], [false, false, bundle.routines![0].cadence, undefined]);
    const privateName = bundle.skills![0].name;
    const catalog = (id: string) => client.call<{choices: {name: string}[]}>("catalog", id);
    assert.ok((await catalog(made)).choices.some(item => item.name === privateName));
    assert.ok(!(await catalog(backend.state.bots[0].id)).choices.some(item => item.name === privateName));

    await client.call("updateRoutine", scheduleChat.id, { prompt: "Prepare the revised inbox report." });
    const saved = await client.call<string>("saveTemplate", made);
    type Sync = { parts: { templates?: { id: string; bundle?: typeof bundle }[] }; v: Record<string, number> };
    const old = await client.call<Sync>("link.sync", { epoch: link.epoch, have: {}, wait: 0 });
    assert.ok(old.parts.templates!.every(item => !item.bundle && item.id !== saved));
    const current = await client.call<Sync>("link.sync", { epoch: link.epoch, have: old.v, wait: 0, templateVersion: 2 });
    assert.equal(current.parts.templates!.find(item => item.id === saved)?.bundle?.routines?.[0].instructions, "Prepare the revised inbox report.");
    const file = await client.call<{text: string}>("exportTemplateText", { templateId: saved });
    assert.equal(JSON.parse(file.text).version, 2);
    const imported = await client.call<string>("importTemplateText", file);
    const again = await client.call<{text: string}>("exportTemplateText", { templateId: imported });
    assert.equal(again.text, file.text);

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

    // The same wire calls under a member role, including copying the owner's bot.
    const perms = { agents: ["view", "create"], skills: ["create"], today: [] as string[] };
    const membership = link.store.data.team;
    membership.roles.push({ id: "bundle-role", name: "Bundle role", perms, bots: "all" });
    membership.groups.push({ id: "bundle-group", name: "Bundle group", roleId: "bundle-role" });
    membership.members.push({ id: "m-reader", name: "Reader", groupId: "bundle-group" });
    link.store.device(pairing.deviceId).memberId = "m-reader";
    await assert.rejects(client.call("addBot", fields), /create bundled routines/);
    const copy = await client.call<string>("duplicateBot", made);
    assert.deepEqual(backend.bot(copy).bundle, { skills: bundle.skills });
    assert.ok(!backend.state.chats.some((chat: any) => chat.botId === copy && chat.schedules?.length));
    await assert.rejects(client.call("runRoutine", scheduleChat.id), /role|another member/);
    perms.today.push("create");
    const mine = await client.call<string>("addBot", fields);
    const myRoutine = backend.state.chats.find((chat: any) => chat.botId === mine && chat.schedules?.length)!;
    assert.equal(myRoutine.createdBy, "m-reader");
    assert.equal(myRoutine.schedules[0].createdBy, "m-reader");
    perms.today.length = 0;
    await assert.rejects(client.call("duplicateBot", mine), /create bundled routines/);
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


test("a member creating or duplicating a bundle needs the permissions for its contents", () => {
  const perms = { agents: ["view", "create"], skills: [] as string[], today: [] as string[] };
  const team = { roles: [{ id: "r", perms, bots: "all" }], groups: [{ id: "g", roleId: "r" }], members: [{ id: "m", groupId: "g" }] };
  const member = { kind: "member", memberId: "m" };
  const bundle = { skills: [{ name: "private-skill" }], routines: [{ name: "Private routine" }] };
  const bot = { id: "bot", bundle, skillsOff: ["private-skill", "global-skill"] };
  const decision = (method: string) => authorize(member, team, method, method === "addBot" ? [{ bundle }] : [bot.id], { bot: () => bot, botBundle: () => bundle });
  for (const method of ["addBot", "duplicateBot"]) assert.match(decision(method), /create bundled skills/);
  perms.skills.push("create");
  for (const method of ["addBot", "duplicateBot"]) assert.match(decision(method), /create bundled routines/);
  perms.today.push("create");
  for (const method of ["addBot", "duplicateBot"]) assert.equal(decision(method), "");
  assert.equal(authorize(member, team, "addBot", [{ name: "Plain" }]), "");
  const view = filterParts({ bots: [bot] }, member, team);
  assert.equal(view.bots[0].bundle, undefined);
  assert.deepEqual(view.bots[0].skillsOff, ["global-skill"]);
});
