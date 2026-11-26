import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { skillSupport } from "../desktop/providers/skills.mjs";
import { tickChatSchedules } from "../desktop/schedules.mjs";
import { toolsApi } from "../desktop/terminal/control-tools.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";

const skill = { name: "archive-index", description: "Index an archive.", instructions: "List each item with its shelf number." };
const routine = {
  name: "Weekly index",
  instructions: "Summarize this week's archive entries.",
  cadence: { kind: "weekly", time: "09:00", days: [1] },
};
const template = {
  format: "botkins.bot-template", version: 2, name: "Archivist", role: "Archive assistant",
  instructions: "Maintain an archive.", bundle: { skills: [skill], routines: [routine] },
};

function open(dir) {
  return new Workspace(join(dir, "data"), fakeClient().client, () => {});
}

function runtimeSkills(ws, botId) {
  return skillSupport({ skills: ws.integrations.skillsFor(ws.bot(botId)) });
}

function checkInstall(ws, botId) {
  const support = runtimeSkills(ws, botId);
  assert.ok(support.list.some((s) => s.name === skill.name && s.description === skill.description));
  const read = support.tools.find((tool) => tool.name === "skill_read");
  assert.equal(JSON.parse(read.handler({ name: skill.name })).instructions, skill.instructions);

  const routines = ws.panels.routines.list(botId);
  assert.equal(routines.length, 1);
  const { chat, entry } = routines[0];
  assert.equal(chat.botId, botId);
  assert.equal(entry.name, routine.name);
  assert.equal(entry.prompt, routine.instructions);
  assert.deepEqual(entry.cadence, routine.cadence);
  assert.equal(entry.enabled, false);
  return chat.id;
}

test("installing a marketplace bundle twice gives each bot its own skill and paused routine", async (t) => {
  const dir = tempDir(t);
  const market = join(dir, "market");
  const manifestDir = join(market, ".github", "plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "marketplace.json"), JSON.stringify({
    name: "local-archive", plugins: [], agents: [{ name: "archivist", source: "./archivist.json" }],
  }));
  writeFileSync(join(market, "archivist.json"), JSON.stringify(template));

  const ws = open(dir);
  const catalog = ws.plugins.catalog;
  const marketplace = await catalog.addMarketplace(market);
  const { agents } = await catalog.agents({ marketplace: marketplace.id });
  assert.deepEqual(agents.map((agent) => agent.name), ["Archivist"]);
  const detail = await catalog.agentTemplate(agents[0].id);
  assert.deepEqual(detail.bundle, template.bundle);
  const first = await ws.agents.create(detail);
  const second = await ws.agents.create({ ...detail, name: "Second archivist" });
  const later = await ws.agents.create({ name: "Plain", role: "Helper", instructions: "Help." });
  const firstRoutine = checkInstall(ws, first);
  const secondRoutine = checkInstall(ws, second);
  assert.notEqual(firstRoutine, secondRoutine);
  for (const unrelated of ["pip", later]) {
    assert.equal(runtimeSkills(ws, unrelated).list.some((s) => s.name === skill.name), false);
    assert.deepEqual(ws.panels.routines.list(unrelated), []);
  }
  assert.equal(ws.integrations.skills().some((s) => s.name === skill.name), false, "the bundle stays out of workspace skills");
  tickChatSchedules(ws, Date.now() + 8 * 86400000);
  assert.equal(ws.state.runs.length, 0, "no scheduled turn starts before the person enables a routine");

  rmSync(market, { recursive: true });
  const reopened = open(dir);
  assert.equal(checkInstall(reopened, first), firstRoutine);
  assert.equal(checkInstall(reopened, second), secondRoutine);
  await reopened.agents.deleteBot(first);
  assert.equal(checkInstall(reopened, second), secondRoutine);
  assert.equal(reopened.panels.routines.list().length, 1);
  assert.equal(runtimeSkills(reopened, later).list.some((s) => s.name === skill.name), false);
});

test("an invalid bundled routine leaves no bot, chat, routine or workspace skill", async (t) => {
  const dir = tempDir(t);
  const ws = open(dir);
  const before = { bots: ws.state.bots.map((b) => b.id), chats: ws.state.chats.map((c) => c.id) };
  const invalid = { ...routine, name: "Broken", cadence: { kind: "weekly", time: "25:00", days: [1] } };
  await assert.rejects(ws.agents.create({ ...template, bundle: { skills: [skill], routines: [routine, invalid] } }));
  for (const observed of [ws, open(dir)]) {
    assert.deepEqual(observed.state.bots.map((b) => b.id), before.bots);
    assert.deepEqual(observed.state.chats.map((c) => c.id), before.chats);
    assert.deepEqual(observed.panels.routines.list(), []);
    assert.equal(runtimeSkills(observed, "pip").list.some((s) => s.name === skill.name), false);
    assert.equal(observed.integrations.skills().some((s) => s.name === skill.name), false);
  }
});

test("the per-bot skills command toggles a bundled skill independently of a shared skill with the same name", async (t) => {
  const ws = open(tempDir(t));
  const owner = await ws.agents.create(template);
  const calls = toolsApi({
    workspace: ws, bot: (id) => ws.bot(id),
    handlers: { skills: () => ({ skills: ws.integrations.skills() }), setBotIntegrations: (...args) => ws.integrations.setBotIntegrations(...args) },
  });
  const row = (id) => calls["bots.tools"]([id]).skills.find((s) => s.name === skill.name);
  assert.equal(row(owner)?.bundled, true);
  assert.equal(row("pip"), undefined);
  await assert.rejects(calls["bots.tools.set"](["pip", { skillsOn: [skill.name] }]), /no skill/i);
  ws.integrations.saveSkill({ ...skill, instructions: "Workspace instructions." });
  ws.integrations.setSkillEnabled(skill.name, false);
  assert.equal(row("pip").enabled, false);
  assert.equal(row(owner).enabled, true);
  await calls["bots.tools.set"]([owner, { skillsOff: [skill.name] }]);
  assert.equal(row(owner).on, false);
  assert.equal(runtimeSkills(ws, owner).list.some((s) => s.name === skill.name), false);
  await calls["bots.tools.set"]([owner, { skillsOn: [skill.name] }]);
  assert.equal(row(owner).on, true);
  checkInstall(ws, owner);
  assert.equal(runtimeSkills(ws, "pip").list.some((s) => s.name === skill.name), false);
});
