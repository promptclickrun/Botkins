// The built-in skill that teaches a bot the `botkins` command (desktop/desktop/skills/use-botkins).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { skillSupport } from "../desktop/providers/skills.mjs";
import { find } from "../cli/commands/index.mjs";

const skillFile = fileURLToPath(new URL("../desktop/skills/use-botkins/SKILL.md", import.meta.url));
const secureInput = fileURLToPath(new URL("../desktop/secure-input.mjs", import.meta.url));

test("a bot is offered the skill only where its shell can run `botkins`", async (t) => {
  const dir = tempDir(t);
  const fake = fakeClient();
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  const bots = () => [ws.bot("pip"), ws.bot("scout")];
  const names = (bot) => skillSupport({ skills: ws.integrations.skillsFor(bot) }).list.map((s) => s.name);
  // The stand-in is the option the code offers; the real environment of this process is not touched.
  ws.integrations.reachable = () => true;
  for (const bot of bots()) {
    assert.ok(ws.integrations.skillsFor(bot).directories.some((d) => /desktop[\\/]skills[\\/]?$/.test(d)), "the folder of the built-in skills is given");
    assert.ok(!ws.integrations.skillsFor(bot).disabled.includes("use-botkins"));
    assert.ok(names(bot).includes("use-botkins"), "a provider's session has the skill");
  }
  assert.equal(ws.integrations.skills().find((s) => s.name === "use-botkins").unavailable, undefined);
  const on = ws.createChat("pip");
  await ws.send(on, "Hi");
  assert.ok(!fake.log.configs.get(on).skills.disabledSkills.includes("use-botkins"));

  ws.integrations.reachable = () => false;
  for (const bot of bots()) {
    assert.ok(ws.integrations.skillsFor(bot).disabled.includes("use-botkins"), "off for every bot");
    assert.ok(!names(bot).includes("use-botkins"), "a provider's session does not have it");
  }
  const listed = ws.integrations.skills().find((s) => s.name === "use-botkins");
  assert.match(listed.unavailable, /Needs the botkins command line on this host/);
  assert.equal(listed.enabled, true, "the switch stays the person's own");
  assert.deepEqual(ws.state.skills.disabled, [], "nothing is saved as a choice of the person");
  const off = ws.createChat("scout");
  await ws.send(off, "Hi");
  assert.ok(fake.log.configs.get(off).skills.disabledSkills.includes("use-botkins"));
});

test("the skill is not offered in a team member's turn, even where the owner's bots have it", async (t) => {
  const dir = tempDir(t);
  const fake = fakeClient();
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  ws.integrations.reachable = () => true;
  const bot = ws.bot("pip");
  assert.ok(!ws.integrations.skillsFor(bot).disabled.includes("use-botkins"));
  assert.ok(!ws.integrations.skillsFor(bot, { member: false }).disabled.includes("use-botkins"));
  assert.ok(ws.integrations.skillsFor(bot, { member: true }).disabled.includes("use-botkins"), "off for a member");
  // The turn passes it on: the owner's chat has the skill, a chat that a member made does not.
  const owners = ws.createChat("pip");
  await ws.send(owners, "Hi");
  assert.ok(!fake.log.configs.get(owners).skills.disabledSkills.includes("use-botkins"));
  // A member whose role may use skills still does not get this one.
  ws.teamOf = () => ({ roles: [{ id: "r_maker", perms: { skills: ["use"], mcp: ["use"] }, bots: "all" }], groups: [{ id: "g_makers", roleId: "r_maker" }], members: [{ id: "m_avery", groupId: "g_makers" }] });
  const members = ws.createChat("pip");
  ws.chat(members).createdBy = "m_avery";
  await ws.send(members, "Hi");
  const given = fake.log.configs.get(members).skills;
  assert.ok(given.directories.length > 0, "the member has skills");
  assert.ok(given.disabledSkills.includes("use-botkins"));
});

test("the skill teaches the rule for a yes and the rule for secrets, and only commands that exist", () => {
  const text = readFileSync(skillFile, "utf8");
  assert.match(text, /^---\nname: use-botkins\ndescription: .+\n---\n/);
  assert.ok(text.split("\n").length < 120, "short");
  // The rule for a yes: look first with no --yes, show the block, give --yes (and the revision) only after they agree.
  assert.match(text, /Run the command with no `--yes`/);
  assert.match(text, /Show your person that block as it is/);
  assert.match(text, /Only after they agree/);
  assert.match(text, /--revision=<revision>/);
  assert.match(text, /Never give `--yes` on your own/);
  // Nobody but the person answers a request that waits in a chat, and the skill does not say that an approval card shows the command.
  assert.match(text, /Never answer a request that waits in a chat: an approval, a question or a secure input\. Your own above all\. The person answers it/);
  assert.doesNotMatch(text, /approval card before it runs/);
  assert.match(text, /you show it yourself, in the chat, and you wait there for their yes/i);
  // The rule for secrets, and the places where a person does what the command refuses.
  assert.match(text, /Never put a secret on the command line/);
  assert.match(text, /hidden question or from standard input/);
  assert.match(text, /password manager[\s\S]*window or on a paired phone/);
  assert.match(text, /No command does them[\s\S]*Do not look for a way round/);
  assert.doesNotMatch(text, /botkins call/, "there is no `call` any more");
  assert.ok(readFileSync(secureInput, "utf8").includes('defineTool("request_secure_input"'), "the tool that the skill names is the one the code has");

  // Every `botkins …` command in it is in the command tree.
  const seen = [];
  for (const [, rest] of text.matchAll(/\bbotkins ([^`\n]*)/g)) {
    const words = [];
    for (const word of rest.split(/\s+/)) {
      if (!/^[a-z][a-z-]*$/.test(word)) break;
      words.push(word);
    }
    if (!words.length) continue;
    const [first, ...tail] = words[0] === "help" ? words : [null, ...words];
    const path = words[0] === "help" ? tail : words;
    if (first === "help") {
      if (path.length) assert.ok(find(path), "`botkins help " + path.join(" ") + "` names a command");
      seen.push("help");
      continue;
    }
    const found = find(path);
    assert.ok(found && !found.command.commands, "`botkins " + words.join(" ") + "` is a command (" + (found ? found.path.join(" ") : "none") + ")");
    seen.push(found.path.join(" "));
  }
  for (const needed of ["status", "logs", "bots list", "bots tools", "routines add", "plugins install", "plugins show", "credentials save", "sharing link", "team invite"])
    assert.ok(seen.includes(needed), "the skill names `botkins " + needed + "`");
});
