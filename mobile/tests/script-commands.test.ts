// Script commands on the phone ("script-commands-v1"): the editor's plain logic, the demo computer's calls and menu,
// and that the owner alone reads or saves one. (desktop/test/script-commands.test.mjs holds the computer's side.)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { authorize } from "../link-host/team.mjs";
import { pair, LinkClient, type FetchLike } from "../src/link/client";
import type { ScriptCommand, SkillInfo } from "../src/link/types";
import { botSkills, isScript, scriptName, scriptProblems, skillOrigin, SCRIPT_LIMIT } from "../src/features/skills/shared";

const skill = (patch: Partial<SkillInfo>): SkillInfo => ({ name: "x", description: "", path: "/skills/x", origin: "botkins", enabled: true, editable: true, ...patch });

test("the editor names a command as it is typed and says what is missing", () => {
  assert.equal(scriptName("/Deploy Preview!"), "deploy-preview-");
  assert.deepEqual(scriptProblems({ name: "", description: "", script: "" }), { name: "Give the command a name.", description: "Say what it does.", script: "Write the script." });
  assert.deepEqual(scriptProblems({ name: "-bad", description: "ok", script: "echo" }), { name: "Use lowercase letters, numbers and dashes." });
  assert.deepEqual(scriptProblems({ name: "ok", description: "ok", script: "x".repeat(SCRIPT_LIMIT + 1) }), { script: "A script can have up to 20,000 characters." });
  assert.deepEqual(scriptProblems({ name: "ok", description: "ok", script: "echo hi" }), {});
});

test("a script command is listed as one, and no bot is offered it as a skill", () => {
  const script = skill({ name: "deploy", command: "script" });
  const plain = skill({ name: "notes" });
  assert.equal(isScript(script), true);
  assert.equal(isScript(plain), false);
  assert.equal(skillOrigin(script), "Script command");
  assert.deepEqual(botSkills([script, plain]).map((s) => s.name), ["notes"]);
});

test("the demo computer saves, reads, lists and removes a script command, and puts it in the / menu", async (t) => {
  const backend = new MockBackend();
  const dir = mkdtempSync(join(tmpdir(), "botkins-script-link-"));
  const host = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.setEnabled(true);
  const localFetch = fetch as unknown as FetchLike;
  const pairing = await pair(localFetch, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, { name: "Phone", platform: "ios" });
  const client = new LinkClient(pairing, { fetch: localFetch, onParts() {}, onState() {} });
  t.after(() => client.stop());
  assert.ok(backend.capabilities.includes("script-commands-v1"));

  const made = await client.call<string>("skills.saveScript", { name: "Deploy-Preview", description: "Builds a preview.", script: "echo \"$BOTKINS_ARGS\"" });
  assert.equal(made, "deploy-preview");
  const read = await client.call<ScriptCommand>("skills.readScript", "deploy-preview");
  assert.deepEqual(read, { name: "deploy-preview", description: "Builds a preview.", script: "echo \"$BOTKINS_ARGS\"" });
  // The list says what it is and never carries the script.
  const { skills } = await client.call<{ skills: SkillInfo[] }>("skills");
  const listed = skills.find((s) => s.name === "deploy-preview");
  assert.equal(listed?.command, "script");
  assert.doesNotMatch(JSON.stringify(skills), /BOTKINS_ARGS/);
  // The menu lists it as a command from "Script".
  const menu = await client.call<{ choices: { name: string; kind: string; source: string; description: string }[] }>("catalog", "pip");
  assert.deepEqual(menu.choices.filter((c) => c.source === "Script").map((c) => [c.name, c.kind, c.description]), [["deploy-preview", "Command", "Builds a preview."]]);
  // A change keeps one command; a name that is reserved, a skill's name and a plain skill's call are refused.
  await client.call("skills.saveScript", { name: "deploy-preview", description: "Builds.", script: "make", original: "deploy-preview" });
  assert.equal((await client.call<ScriptCommand>("skills.readScript", "deploy-preview")).script, "make");
  await assert.rejects(client.call("skills.saveScript", { name: "help", description: "x", script: "true" }), /already has/);
  await assert.rejects(client.call("skills.saveScript", { name: "x", description: "x", script: "" }), /Enter the script/);
  await assert.rejects(client.call("saveSkill", { name: "y", description: "x", instructions: "x", original: "deploy-preview" }), /script command/);
  // A switched-off command leaves the menu; removing it removes it.
  await client.call("setSkillEnabled", "deploy-preview", false);
  assert.deepEqual((await client.call<{ choices: { source: string }[] }>("catalog", "pip")).choices.filter((c) => c.source === "Script"), []);
  await client.call("removeSkill", "deploy-preview");
  await assert.rejects(client.call("skills.readScript", "deploy-preview"), /isn't a script command/);
});

test("only the owner reads or saves a script command, and the link files are the computer's own", () => {
  const team = { roles: [{ id: "r", perms: { skills: ["read", "use", "create", "manage", "delete"] }, bots: "all" }], groups: [{ id: "g", roleId: "r" }], members: [{ id: "m", groupId: "g" }] };
  const member = { kind: "member", memberId: "m" };
  for (const method of ["skills.saveScript", "skills.readScript"]) {
    assert.match(authorize(member, team, method, [{}]), /Only the owner/);
    assert.equal(authorize({ kind: "owner" }, team, method, [{}]), "");
  }
  // The computer's copies of these files are the same bytes (desktop/desktop/link/).
  for (const file of ["team.mjs", "methods.mjs"]) {
    assert.equal(readFileSync(new URL("../link-host/" + file, import.meta.url), "utf8"), readFileSync(new URL("../../desktop/desktop/link/" + file, import.meta.url), "utf8"), file);
  }
});
