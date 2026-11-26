import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { skillSupport } from "../desktop/providers/skills.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";

const skill = { name: "field-review", description: "Inspect field notes.", instructions: "Check the survey date." };
const routine = { name: "Notes review", instructions: "Read today's notes.", cadence: { kind: "daily", time: "09:00" } };
const profile = { name: "Reviewer", role: "Editor", instructions: "Review notes.", bundle: { skills: [skill], routines: [routine] } };
function setup(t) {
  const dir = tempDir(t);
  const fake = fakeClient();
  return { ws: new Workspace(dir, fake.client, () => {}), ...fake };
}

test("Copilot and the skill reader receive the bot's own copy when a shared name collides", async (t) => {
  const { ws, log } = setup(t);
  ws.integrations.saveSkill({ ...skill, instructions: "Shared instructions." });
  ws.integrations.setSkillEnabled(skill.name, false);
  const id = ws.addBot(profile);
  const chat = ws.mainChat(id);
  await ws.send(chat, "Hello");
  const config = log.configs.get(chat).skills;
  const privateDir = ws.integrations.botSkillDirectory(ws.bot(id));
  assert.equal(config.directories[0], privateDir);
  assert.ok(!config.disabledSkills.includes(skill.name));
  assert.ok(readFileSync(join(privateDir, skill.name, "SKILL.md"), "utf8").includes(skill.instructions));
  const support = skillSupport({ skills: ws.integrations.skillsFor(ws.bot(id)) });
  assert.equal(JSON.parse(support.tools[0].handler({ name: skill.name })).instructions, skill.instructions);
  ws.integrations.setBotIntegrations(id, { skillsOff: [skill.name] });
  ws.integrations.removeSkill(skill.name);
  assert.ok(ws.integrations.skillsFor(ws.bot(id)).disabled.includes(skill.name));
  assert.throws(() => ws.integrations.saveScriptCommand({ name: skill.name, description: "Echo.", script: "echo ok" }), /skill of a bot/);
  await ws.agents.deleteBot(id);
  assert.equal(existsSync(privateDir), false);
});

test("a failed workspace write rolls back the bot, its chats and its skill files", (t) => {
  const { ws } = setup(t);
  const bots = ws.state.bots.slice();
  const chats = ws.state.chats.slice();
  const file = readFileSync(ws.file);
  ws.writer.save = () => { throw new Error("Write failed"); };
  assert.throws(() => ws.addBot(profile), /Write failed/);
  assert.deepEqual(ws.state.bots, bots);
  assert.deepEqual(ws.state.chats, chats);
  assert.deepEqual(readFileSync(ws.file), file);
  assert.deepEqual(readdirSync(join(ws.dir, ".agent-skills")), []);
});

test("copies reflect changes to portable routines and only copy the caller's routines", async (t) => {
  const { ws } = setup(t);
  const id = ws.addBot(profile, "m_ada");
  const r = ws.panels.routines;
  const [{ chat, entry }] = r.list(id);
  assert.equal(chat.createdBy, "m_ada");
  assert.equal(entry.createdBy, "m_ada");
  assert.equal(entry.notify, false);
  assert.equal(entry.deliver, undefined);
  r.update(chat.id, { name: "Recent notes", prompt: "Summarize my notes.", deliver: { to: "feed" }, notify: true });
  r.setEnabled(chat.id, null, true);
  r.create({ botId: id, name: "Another routine", prompt: "Help.", cadence: routine.cadence });
  const copy = ws.agents.duplicateBot(id, "m_ada");
  const [copied] = r.list(copy);
  assert.equal(r.list(copy).length, 1);
  assert.equal(copied.entry.name, "Recent notes");
  assert.equal(copied.entry.prompt, "Summarize my notes.");
  assert.equal(copied.entry.enabled, false);
  assert.equal(copied.entry.notify, false);
  assert.equal(copied.entry.deliver, undefined);
  assert.equal(r.list(ws.agents.duplicateBot(id, "m_other")).length, 0);
  r.update(chat.id, { script: "echo private" });
  assert.equal(ws.bundleForBot(ws.bot(id)).routines, undefined);
  await r.remove(chat.id);
  assert.equal(r.list(ws.agents.duplicateBot(id)).length, 0);
});
