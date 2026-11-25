// Script commands (desktop/script-commands.mjs): a slash command that runs a script with no model.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { tempDir, tick } from "./fake-copilot.mjs";
import { authorize } from "../desktop/link/team.mjs";
import { enabledSkills } from "../desktop/providers/skills.mjs";
import { RESERVED_COMMANDS, SCRIPT_FILE, cleanScriptCommand, commandKind, hashScript, matchScriptCommand, scriptCommandTools, scriptRevision, scrubbedEnvironment, shownScript } from "../desktop/script-commands.mjs";
import { askDetail, askOf } from "../desktop/link/cards.mjs";
import { gadgetPart } from "../desktop/link/gadget.mjs";
import { desktopCommands } from "../desktop/providers/copilot/commands.mjs";
import { SCRIPT_LENGTH } from "../desktop/routine-script.mjs";

const unix = process.platform !== "win32";
const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));

/** A workspace whose Copilot client records the sessions it is asked to open, and what each was given. */
function setup(t, { commands = [] } = {}) {
  const dir = tempDir(t, "botkins-script-commands-");
  const seen = { created: [], configs: [], sent: [] };
  const rpc = {
    commands: { list: async () => (commands === "fail" ? Promise.reject(new Error("the provider is down")) : { commands }) },
    skills: { ensureLoaded: async () => {}, list: async () => ({ skills: [] }) },
    plugins: { list: async () => ({ plugins: [] }) },
    mcp: { list: async () => ({ servers: [] }) },
    tools: { initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [] }) },
    model: { switchTo: async () => ({}) },
    permissions: { setMode: async () => ({ success: true }) },
  };
  const client = {
    createSession: async (config) => {
      seen.created.push(config.sessionId);
      seen.configs.push(config);
      const handlers = new Set();
      const emit = (event) => handlers.forEach((handler) => handler(event));
      return {
        sessionId: config.sessionId,
        rpc,
        disconnect: async () => {},
        abort: async () => {},
        on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
        send: async ({ prompt }) => {
          seen.sent.push(prompt);
          const id = config.sessionId + ":message:" + seen.sent.length;
          emit({ type: "user.message", id, data: { messageId: id } });
          emit({ type: "assistant.message", data: { originatingMessageId: id, content: "Model reply." } });
          emit({ type: "session.idle", data: { mode: "interactive" } });
          return id;
        },
      };
    },
    resumeSession: async () => {
      throw new Error("Session not found");
    },
    deleteSession: async () => {},
  };
  const ws = new Workspace(join(dir, "data"), async () => client, () => {}, () => ({ kind: "reject" }));
  ws.integrations.reachable = () => true;
  return { ws, seen, dir };
}
const save = (ws, name = "hello", script = 'echo "hi from $BOTKINS_COMMAND"', description = "Says hi.") => ws.integrations.saveScriptCommand({ name, description, script });
const commandMessages = (ws, chatId) => ws.chat(chatId).messages.filter((m) => m.role === "command");

test("a script command is saved as a skill with its script beside it, and read back whole", (t) => {
  const { ws } = setup(t);
  assert.equal(save(ws, "deploy-preview", "make preview\n", "Deploys a preview."), "deploy-preview");
  const dir = join(ws.integrations.skillsDir, "deploy-preview");
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  assert.equal(commandKind(skill), "script");
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.equal(readFileSync(join(dir, SCRIPT_FILE), "utf8"), "make preview\n");
  assert.deepEqual(ws.integrations.readScriptCommand("deploy-preview"), { name: "deploy-preview", description: "Deploys a preview.", script: "make preview\n" });
  const listed = ws.integrations.skills().find((s) => s.name === "deploy-preview");
  assert.equal(listed.command, "script");
  assert.equal(listed.origin, "botkins");
  assert.equal(listed.unavailable, undefined);
  assert.deepEqual(ws.integrations.scriptCommands().map((c) => [c.name, c.enabled]), [["deploy-preview", true]]);
  // The workspace file keeps the name and the script's SHA-256 (never the script).
  assert.match(ws.state.skills.scripts["deploy-preview"], /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(ws.state), /make preview/);
  // Changing it rewrites both files; renaming moves it.
  ws.integrations.saveScriptCommand({ name: "preview", description: "Deploys.", script: "make preview-2", original: "deploy-preview" });
  assert.deepEqual(ws.integrations.scriptCommands().map((c) => c.name), ["preview"]);
  assert.equal(ws.integrations.readScriptCommand("preview").script, "make preview-2");
  assert.equal(existsSync(dir), false);
  assert.equal(ws.state.skills.scripts["deploy-preview"], undefined);
  // Removing the skill removes the command.
  ws.integrations.removeSkill("preview");
  assert.deepEqual(ws.integrations.scriptCommands(), []);
  assert.equal(ws.state.skills.scripts, undefined);
});

test("a name, a description and a script are checked, and a taken or reserved name is refused", (t) => {
  const { ws } = setup(t);
  const bad = (fields, pattern) => assert.throws(() => cleanScriptCommand({ name: "ok", description: "Does it.", script: "true", ...fields }), pattern);
  bad({ name: "Bad Name" }, /lowercase letters/);
  bad({ name: "-x" }, /lowercase letters/);
  bad({ description: " " }, /description/);
  bad({ script: "  " }, /Enter the script/);
  bad({ script: "x".repeat(SCRIPT_LENGTH + 1) }, /up to 20,000/);
  bad({ script: "a\0b" }, /null/);
  assert.equal(cleanScriptCommand({ name: "/Deploy", description: "d", script: "true" }).name, "deploy");
  for (const name of ["help", "model", "compact", "init"]) bad({ name }, /already has/);
  // Every command that Botkins and Copilot's desktop surface have is reserved (providers/commands.mjs, providers/copilot/commands.mjs).
  const own = [...desktopCommands.flatMap(([name, aliases]) => [name, ...aliases]), "model", "permissions", "allow-all", "reset-allowed-tools", "compact"];
  assert.deepEqual(own.filter((name) => !RESERVED_COMMANDS.has(name)), []);
  // A skill that has the name is not taken over.
  mkdirSync(join(ws.integrations.skillsDir, "taken"), { recursive: true });
  writeFileSync(join(ws.integrations.skillsDir, "taken", "SKILL.md"), "---\nname: taken\ndescription: x\n---\nSteps.");
  assert.throws(() => save(ws, "taken"), /already exists/);
  // And a plain skill can't be rewritten as a script command, nor a script command as a plain skill.
  assert.throws(() => ws.integrations.saveScriptCommand({ name: "taken", description: "x", script: "true", original: "taken" }), /isn't a script command/);
  save(ws, "mine");
  assert.throws(() => ws.integrations.saveSkill({ name: "mine", description: "x", instructions: "Do.", original: "mine" }), /script command/);
  assert.throws(() => save(ws, "mine", "true", "other"), /already exists/, "a new one with the name of an existing one is not a change");
});

test("only a command that Botkins saved in its own folder is one: a linked folder, an import and a changed script are not", (t) => {
  const { ws, dir } = setup(t);
  // A linked folder whose skill says it is a script command, with a script beside it.
  const linked = join(dir, "linked");
  mkdirSync(join(linked, "planted"), { recursive: true });
  writeFileSync(join(linked, "planted", "SKILL.md"), "---\nname: planted\ndescription: Planted.\ncommand: script\ndisable-model-invocation: true\n---\nx");
  writeFileSync(join(linked, "planted", SCRIPT_FILE), "touch planted-ran");
  ws.integrations.addFolder(ws.integrations.skillState.folders, linked);
  assert.equal(ws.integrations.skills().find((s) => s.name === "planted").command, undefined);
  assert.deepEqual(ws.integrations.scriptCommands(), []);
  assert.equal(ws.integrations.runnableScript("planted"), null);
  // The same skill, imported into Botkins' folder (from a folder that is not linked), is a skill and nothing more.
  const incoming = join(dir, "incoming");
  mkdirSync(join(incoming, "other"), { recursive: true });
  writeFileSync(join(incoming, "other", "SKILL.md"), "---\nname: other\ndescription: Other.\ncommand: script\ndisable-model-invocation: true\n---\nx");
  writeFileSync(join(incoming, "other", SCRIPT_FILE), "touch other-ran");
  const imported = ws.integrations.importSkillFolders([join(incoming, "other")], [], true);
  assert.deepEqual(imported.added, ["other"]);
  assert.equal(existsSync(join(ws.integrations.skillsDir, "other", SCRIPT_FILE)), true);
  assert.deepEqual(ws.integrations.scriptCommands(), []);
  assert.equal(ws.integrations.runnableScript("other"), null);
  // An import over a script command takes the name away from the command, even with the same script file.
  save(ws, "real", "echo ok");
  mkdirSync(join(incoming, "real"), { recursive: true });
  writeFileSync(join(incoming, "real", "SKILL.md"), "---\nname: real\ndescription: Replaced.\ncommand: script\n---\nx");
  writeFileSync(join(incoming, "real", SCRIPT_FILE), "echo ok");
  ws.integrations.importSkillFolders([join(incoming, "real")], ["real"], true);
  assert.equal(ws.integrations.runnableScript("real"), null);
  assert.equal(ws.state.skills.scripts, undefined);
  assert.equal(ws.integrations.skills().find((s) => s.name === "real").command, undefined);
  // A script that something else changed on disk is not run, and says why.
  save(ws, "edited", "echo fine");
  assert.equal(ws.integrations.runnableScript("edited").script, "echo fine");
  writeFileSync(join(ws.integrations.skillsDir, "edited", SCRIPT_FILE), "echo changed");
  assert.equal(ws.integrations.runnableScript("edited"), null);
  assert.match(ws.integrations.skills().find((s) => s.name === "edited").unavailable, /changed outside Botkins/);
  assert.deepEqual(ws.integrations.scriptCommands().map((c) => [c.name, !!c.unavailable]), [["edited", true]]);
  // Saving it again from Botkins makes it whole again.
  ws.integrations.saveScriptCommand({ name: "edited", description: "x", script: "echo changed", original: "edited" });
  assert.equal(ws.integrations.runnableScript("edited").script, "echo changed");
  // A state file cannot name a command that has no matching script: a wrong hash is a changed script.
  ws.state.skills.scripts.edited = "0".repeat(64);
  assert.equal(ws.integrations.runnableScript("edited"), null);
});

test("no model is offered a script command as a skill", async (t) => {
  const { ws, seen } = setup(t);
  save(ws, "hello");
  ws.integrations.setSkillEnabled("hello", true);
  // The skills a session is given leave it out, by name, for every bot.
  assert.ok(ws.integrations.skillsFor(ws.bot("pip")).disabled.includes("hello"));
  // And a backend that lists skills itself skips a skill that says it is one, whether or not it is switched off.
  const skills = ws.integrations.skillsFor(ws.bot("pip"));
  assert.deepEqual(enabledSkills({ skills: { directories: skills.directories, disabled: [] } }).filter((s) => s.name === "hello"), []);
  // The Copilot runtime is told to leave it out in a real turn.
  const chat = ws.createChat("pip");
  await ws.send(chat, "Hi there");
  assert.ok(seen.configs.at(-1).skills.disabledSkills.includes("hello"));
  assert.equal(seen.sent.length, 1);
});

test("the / menu lists script commands that are on, and leaves out one that a command already has", async (t) => {
  const { ws } = setup(t, { commands: [{ name: "clash", description: "A provider's own.", kind: "builtin" }] });
  save(ws, "hello", "echo hi", "Says hi.");
  save(ws, "clash", "echo no", "Loses to the provider's command.");
  save(ws, "quiet", "echo no", "Switched off.");
  ws.integrations.setSkillEnabled("quiet", false);
  const menu = await ws.catalog("pip");
  const named = (name) => menu.choices.filter((c) => c.name === name);
  assert.deepEqual(named("hello").map((c) => [c.kind, c.source, c.description, c.command]), [["Command", "Script", "Says hi.", "hello"]]);
  assert.deepEqual(named("clash").map((c) => c.source), ["Copilot"], "the provider's command wins");
  assert.deepEqual(named("quiet"), []);
  // The saved menu is not changed: the next one is built from it again.
  assert.deepEqual((await ws.catalog("pip")).choices.filter((c) => c.source === "Script").map((c) => c.name), ["hello"]);
  // A chat that a team member started has none: they are the owner's.
  const mine = ws.createChat("pip", "Mine", undefined, "m_avery");
  assert.deepEqual((await ws.catalog("pip", mine)).choices.filter((c) => c.source === "Script"), []);
  // One whose script changed outside Botkins is not offered.
  writeFileSync(join(ws.integrations.skillsDir, "hello", SCRIPT_FILE), "echo changed");
  assert.deepEqual((await ws.catalog("pip")).choices.filter((c) => c.source === "Script"), []);
});

test("typing a script command runs its script with no model and no session, and the output is the reply", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  save(ws, "hello", 'exec 2>&1; echo "hi from $BOTKINS_COMMAND"; echo "warn" >&2; echo "chat=$BOTKINS_CHAT_ID"; pwd; test -z "$BOTKINS_ROUTINE" && echo not-a-routine');
  const chat = ws.createChat("pip");
  await ws.send(chat, "/hello");
  // The menu is read to be sure that the chat's provider has no command of that name (a menu session, not the chat's, and no model).
  assert.deepEqual(seen.created.filter((id) => !id.startsWith("menu-")), [], "the chat's own session was not opened");
  assert.deepEqual(seen.sent, [], "no model turn");
  const [reply] = commandMessages(ws, chat);
  assert.equal(reply.plain, true);
  assert.equal(reply.runId, ws.state.runs[0].id);
  assert.match(reply.text, /^hi from hello\nwarn\nchat=/);
  assert.ok(reply.text.includes("chat=" + chat));
  assert.ok(reply.text.includes(join(ws.dir, "files", "pip")), "it runs in the bot's own folder");
  assert.match(reply.text, /not-a-routine/);
  assert.doesNotMatch(reply.text, /Exit code/);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Completed");
  assert.equal(run.command, "hello");
  assert.deepEqual(run.script, { exitCode: 0 });
  assert.equal(ws.active.has(chat), false);
  // The command is in the chat's history as the person typed it.
  assert.equal(ws.chat(chat).messages[0].text, "/hello");
});

test("a script command runs in the chat's project folder when it has one", { skip: !unix }, async (t) => {
  const { ws, dir } = setup(t);
  const folder = join(dir, "repo");
  mkdirSync(folder);
  save(ws, "where", "pwd");
  const chat = ws.createChat("pip");
  ws.projects.folderFor = () => folder;
  await ws.send(chat, "/where");
  assert.equal(commandMessages(ws, chat)[0].text, realpathSync(folder));
});

test("a failing script says its exit code, and one with no output says so", { skip: !unix }, async (t) => {
  const { ws } = setup(t);
  save(ws, "bad", "echo partial; exit 3");
  save(ws, "silent", "true");
  const chat = ws.createChat("pip");
  await ws.send(chat, "/bad");
  await ws.send(chat, "/silent");
  assert.deepEqual(commandMessages(ws, chat).map((m) => m.text), ["partial\n\nExit code 3.", "(no output)"]);
  assert.equal(ws.state.runs.find((r) => r.command === "bad").script.exitCode, 3);
});

test("the words after the command reach the script as data and are never part of its command", { skip: !unix }, async (t) => {
  const { ws } = setup(t);
  save(ws, "echoer", 'echo "env=[$BOTKINS_ARGS]"; printf "stdin=["; cat; echo "]"');
  const chat = ws.createChat("pip");
  const folder = join(ws.dir, "files", "pip");
  const hostile = "a; touch pwned && $(touch pwned2) `touch pwned3` 'q' \"d\"";
  await ws.send(chat, "/echoer " + hostile);
  const [reply] = commandMessages(ws, chat);
  assert.equal(reply.text, "env=[" + hostile + "]\nstdin=[" + hostile + "]");
  for (const file of ["pwned", "pwned2", "pwned3"]) assert.equal(existsSync(join(folder, file)), false, file + " was not created");
  // No words is an empty value, and the script still gets an end of input.
  await ws.send(chat, "/echoer");
  assert.equal(commandMessages(ws, chat)[1].text, "env=[]\nstdin=[]");
});

test("Stop ends a running script and everything it started, and it has no time limit of its own", { skip: !unix }, async (t) => {
  const { ws, dir } = setup(t);
  const pids = join(dir, "pids");
  save(ws, "slow", `sh -c 'echo $$ >> "${pids}"; sleep 60' & echo $! >> "${pids}"; echo started; sleep 60`);
  const chat = ws.createChat("pip");
  const turn = ws.send(chat, "/slow");
  while (!existsSync(pids) || readFileSync(pids, "utf8").trim().split("\n").length < 2) await tick(20);
  assert.ok(ws.active.has(chat), "the chat is busy while it runs");
  assert.equal(ws.active.get(chat).intent, "Running /slow");
  const started = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  await ws.stop(chat);
  await turn;
  assert.equal(ws.state.runs[0].status, "Stopped");
  assert.equal(ws.active.has(chat), false);
  assert.match(commandMessages(ws, chat)[0].text, /Stopped\.$/);
  await tick(50);
  for (const pid of started) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "process " + pid + " is gone");
  // The menu stays answerable while a script runs (it is asked of the bot's menu session, not of the busy chat).
  const again = ws.send(chat, "/slow");
  while (!ws.active.has(chat)) await tick(5);
  assert.ok((await ws.catalog("pip", chat)).choices.some((c) => c.name === "slow"));
  await ws.stop(chat);
  await again;
});

/** A team with a member whose role may use skills, and one whose role may only read them. */
const TEAM = {
  members: [{ id: "m_use", groupId: "g1", name: "Uma" }, { id: "m_read", groupId: "g2", name: "Rey" }],
  groups: [{ id: "g1", roleId: "r1" }, { id: "g2", roleId: "r2" }],
  roles: [{ id: "r1", bots: "all", perms: { agents: ["view", "chat"], skills: ["read", "use"] } }, { id: "r2", bots: "all", perms: { agents: ["view", "chat"], skills: ["read"] } }],
};

test("a team member whose role may use skills runs a script command, and one whose role may not is told so", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  ws.teamOf = () => TEAM;
  save(ws, "touchy", "echo ran-for-$BOTKINS_ARGS > ran.txt; echo done");
  const chat = ws.createChat("pip");
  const ran = join(ws.dir, "files", "pip", "ran.txt");
  // A role that has skills "use" (the default Guest role has it): it runs, as the computer's user.
  await ws.send(chat, "/touchy first", { author: { memberId: "m_use", name: "Uma" } });
  assert.deepEqual(commandMessages(ws, chat).map((m) => m.text), ["done"]);
  assert.equal(readFileSync(ran, "utf8"), "ran-for-first\n");
  assert.deepEqual(seen.sent, [], "no model");
  // A role that has only skills "read" does not.
  rmSync(ran);
  await ws.send(chat, "/touchy second", { author: { memberId: "m_read", name: "Rey" } });
  assert.equal(commandMessages(ws, chat)[1].text, "Your team role can't use skills, so it can't run a script command.");
  assert.equal(existsSync(ran), false);
  // The member whose chat it is counts too: the owner typing in a chat of a member who can't use skills runs nothing, and in one of a member who can, runs it.
  const theirs = ws.createChat("pip", "Theirs", undefined, "m_read");
  await ws.send(theirs, "/touchy third");
  assert.match(commandMessages(ws, theirs)[0].text, /Your team role can't use skills/);
  const usable = ws.createChat("pip", "Usable", undefined, "m_use");
  await ws.send(usable, "/touchy fourth");
  assert.deepEqual(commandMessages(ws, usable).map((m) => m.text), ["done"]);
  // A member who is not on the team at all has no right to.
  await ws.send(chat, "/touchy fifth", { author: { memberId: "m_gone", name: "Gone" } });
  assert.match(commandMessages(ws, chat)[2].text, /Your team role can't use skills/);
});

test("a member's menu lists script commands when their role may use skills", async (t) => {
  const { ws } = setup(t);
  ws.teamOf = () => TEAM;
  save(ws, "hello", "echo hi", "Says hi.");
  const names = async (...args) => (await ws.catalog(...args)).choices.filter((c) => c.source === "Script").map((c) => c.name);
  assert.deepEqual(await names("pip"), ["hello"], "the owner's");
  assert.deepEqual(await names("pip", undefined, false, "m_use"), ["hello"]);
  assert.deepEqual(await names("pip", undefined, false, "m_read"), []);
  // The chat's own member counts too.
  const theirs = ws.createChat("pip", "Theirs", undefined, "m_read");
  assert.deepEqual(await names("pip", theirs, false, "owner"), []);
  const usable = ws.createChat("pip", "Usable", undefined, "m_use");
  assert.deepEqual(await names("pip", usable, false, "m_use"), ["hello"]);
  // The link says who asks: a member's call to `catalog` carries their id.
  const { deviceCall } = await import("../desktop/device-call.mjs");
  const asked = [];
  const call = deviceCall({ workspace: ws, handlers: { catalog: (...args) => (asked.push(args), []) }, folders: {} });
  await call("catalog", ["pip", undefined, false], { principal: { kind: "member", memberId: "m_use", name: "Uma" } });
  assert.deepEqual(asked[0], ["pip", undefined, false, "m_use"]);
});

test("a command that is off, changed or reserved is not run as one, and a turn nobody watches does not run one", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  save(ws, "off", "touch ran-off");
  ws.integrations.setSkillEnabled("off", false);
  const chat = ws.createChat("pip");
  // A command that is switched off is not run: the person gets the provider's answer for an unknown command.
  await ws.send(chat, "/off now");
  assert.equal(commandMessages(ws, chat).length, 0);
  assert.equal(existsSync(join(ws.dir, "files", "pip", "ran-off")), false);
  assert.equal(ws.state.runs[0].script, undefined);
  assert.deepEqual(seen.created.length > 0, true, "the turn went the way every other message goes");
  // A changed script says why it can't run, and runs nothing.
  save(ws, "changed", "echo ran");
  writeFileSync(join(ws.integrations.skillsDir, "changed", SCRIPT_FILE), "echo other");
  await ws.send(chat, "/changed");
  assert.match(commandMessages(ws, chat)[0].text, /^\/changed can't run\. The script was changed outside Botkins/);
  // A routine's prompt, a reaction and the like are not a person typing.
  save(ws, "plain", "echo ran");
  const routine = ws.panels.routines.create({ botId: "pip", name: "Slashy", prompt: "/plain", cadence: { kind: "daily", time: "09:00" } }, Date.UTC(2026, 10, 17, 12));
  await ws.panels.routines.run(routine);
  assert.equal(commandMessages(ws, routine).length, 0, "a routine does not run a script command");
});

test("a bot proposes a script command with a card that shows the whole script, and nothing is saved until a yes", async (t) => {
  const { ws } = setup(t);
  const views = [];
  let answer = { action: "deny" };
  ws.interactions.request = async (_chat, _task, view) => (views.push(view), answer);
  const chat = ws.createChat("pip");
  const task = {};
  ws.active.set(chat, task);
  const tools = ws.sessionTools(ws.bot("pip"), ws.chat(chat), { id: "run1" }, task);
  const create = tools.find((tool) => tool.name === "script_command_create");
  const list = tools.find((tool) => tool.name === "script_command_list");
  assert.ok(create && list, "a bot has both tools in a turn that the owner is there for");
  const script = "echo one\n\techo two # \u202etxet\nrm -rf build";
  // Declined: the answer says so, and nothing is written.
  assert.equal(await create.handler({ name: "build", description: "Cleans and builds.", script }), "The person declined.");
  assert.equal(views.length, 1);
  assert.equal(views[0].kind, "permission");
  assert.match(views[0].title, /^Add the script command \/build\?$/);
  assert.ok(views[0].detail.includes("echo one\n    echo two # \\u{202e}txet\nrm -rf build"), "the whole script is in the card, made safe to read");
  assert.equal(views[0].remember, undefined, "it can't be remembered");
  assert.equal(views[0].preview, undefined);
  assert.deepEqual(ws.integrations.scriptCommands(), []);
  assert.equal(existsSync(join(ws.integrations.skillsDir, "build")), false);
  assert.deepEqual(ws.state.skills.scripts ?? {}, {});
  // A dismissed card is not a yes either.
  answer = { action: "cancel" };
  assert.equal(await create.handler({ name: "build", description: "Cleans.", script }), "The person declined.");
  assert.deepEqual(ws.integrations.scriptCommands(), []);
  // Approved: it is written, as the script that was shown.
  answer = { action: "approve" };
  assert.match(await create.handler({ name: "build", description: "Cleans and builds.", script }), /^Saved\. /);
  assert.equal(ws.integrations.readScriptCommand("build").script, script);
  assert.deepEqual(JSON.parse(await list.handler({})).map((c) => [c.name, c.description, c.enabled, c.script]), [["build", "Cleans and builds.", true, script]]);
  // The same name again is a change, and the card says so.
  assert.match(await create.handler({ name: "build", description: "Changed.", script: "echo two" }), /^Saved\./);
  assert.match(views.at(-1).title, /^Change the script command \/build\?$/);
  assert.equal(ws.integrations.readScriptCommand("build").description, "Changed.");
  // A name that a command or a skill has is refused before any card.
  const before = views.length;
  await assert.rejects(() => create.handler({ name: "help", description: "x", script: "true" }), /already has/);
  await assert.rejects(() => create.handler({ name: "x", description: "x", script: "" }), /Enter the script/);
  assert.equal(views.length, before);
  // A turn that has ended writes nothing, even when the card was answered yes.
  task.stopped = true;
  await assert.rejects(() => create.handler({ name: "late", description: "x", script: "true" }), /This turn has ended/);
  assert.equal(ws.integrations.scriptCommands().some((c) => c.name === "late"), false);
});

test("a bot gets no script command tools when nobody is there, or when a team member is", (t) => {
  const { ws } = setup(t);
  const chat = ws.createChat("pip");
  const task = {};
  ws.active.set(chat, task);
  const names = (run, task2 = task, chat2 = chat) => ws.sessionTools(ws.bot("pip"), ws.chat(chat2), run, task2).filter((tool) => tool.name.startsWith("script_command")).map((tool) => tool.name);
  assert.deepEqual(names({ id: "r" }), ["script_command_list", "script_command_create"]);
  // A routine, a panel refresh, a task, a reaction and a background check run for nobody.
  for (const run of [{ id: "r", scheduleId: 1 }, { id: "r", panelId: "p" }, { id: "r", taskId: "t" }, { id: "r", reaction: true }, { id: "r", recovery: { proactiveCheck: {} } }])
    assert.deepEqual(names(run), [], JSON.stringify(run));
  assert.deepEqual(scriptCommandTools(ws, ws.bot("pip"), ws.chat(chat), { id: "r", scheduleId: 1 }, task), []);
  // A team member's turn.
  const member = { author: { memberId: "m_avery", name: "Avery" } };
  assert.deepEqual(names({ id: "r" }, member), []);
});

test("saving and reading a script command is the owner's alone, on the link and in the mirrored files", () => {
  const team = { members: [{ id: "m_a", groupId: "g" }], groups: [{ id: "g", roleId: "r" }], roles: [{ id: "r", bots: "all", perms: { skills: ["read", "use", "create", "manage", "delete"] } }] };
  const member = { kind: "member", memberId: "m_a" };
  const owner = { kind: "owner" };
  for (const method of ["skills.saveScript", "skills.readScript"]) {
    assert.match(authorize(member, team, method, [{ name: "x" }]), /Only the owner/);
    assert.equal(authorize(owner, team, method, [{ name: "x" }]), "");
  }
  // A member who may create skills still can't make a skill that is a script command by the plain call.
  assert.equal(authorize(member, team, "saveSkill", [{ name: "x" }]), "");
  // The phone's copies of the link's files are the same bytes.
  assert.deepEqual(read("../desktop/link/team.mjs"), read("../../mobile/link-host/team.mjs"));
  assert.deepEqual(read("../desktop/link/methods.mjs"), read("../../mobile/link-host/methods.mjs"));
});

test("a typed command is read as a name and its words", () => {
  assert.deepEqual(matchScriptCommand("/deploy-preview  now please "), { name: "deploy-preview", args: "now please" });
  assert.deepEqual(matchScriptCommand("/Deploy"), { name: "deploy", args: "" });
  assert.deepEqual(matchScriptCommand("/a\nsecond line\nthird"), { name: "a", args: "second line\nthird" });
  assert.equal(matchScriptCommand("/tool:today_list"), null);
  assert.equal(matchScriptCommand("hello /deploy"), null);
  assert.equal(matchScriptCommand("/usr/bin"), null);
  assert.equal(shownScript("a\tb\r\nc\u202e"), "a    b\nc\\u{202e}");
});

test("a script with no time limit runs to its end, gets its input and is not marked as a routine's", { skip: !unix }, async () => {
  const { runScript } = await import("../desktop/routine-script.mjs");
  const run = runScript('read line; echo "got:$line"; echo "routine=[$BOTKINS_ROUTINE]"; sleep 0.3; echo done', { timeoutMs: null, routine: false, input: "from stdin\n", env: { ...process.env, BOTKINS_ROUTINE: "" } });
  const result = await run.done;
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "got:from stdin\nroutine=[]\ndone\n");
  // A routine's script keeps its limit and its mark.
  const routine = runScript('echo "routine=[$BOTKINS_ROUTINE]"');
  assert.equal((await routine.done).output, "routine=[1]\n");
});

test("a link in a command's folder is never written through, and the registry holds the hash of the approved script", { skip: !unix }, (t) => {
  const { ws, dir } = setup(t);
  save(ws, "linky", "echo one");
  const folder = join(ws.integrations.skillsDir, "linky");
  const victim = join(dir, "zshrc");
  writeFileSync(victim, "precious");
  const change = (script = "echo two") => ws.integrations.saveScriptCommand({ name: "linky", description: "d", script, original: "linky" });
  // `run` made a link to a file of the person's: a save does not write to it, and says so.
  rmSync(join(folder, SCRIPT_FILE));
  symlinkSync(victim, join(folder, SCRIPT_FILE));
  assert.throws(() => change(), /run is a link/);
  assert.equal(readFileSync(victim, "utf8"), "precious");
  assert.equal(ws.integrations.runnableScript("linky"), null, "a command whose script is a link is not run");
  // The same for SKILL.md, and for a link to nowhere (a read of it gave nothing, and its hash was the hash of "null").
  rmSync(join(folder, SCRIPT_FILE));
  writeFileSync(join(folder, SCRIPT_FILE), "echo one");
  rmSync(join(folder, "SKILL.md"));
  symlinkSync(victim, join(folder, "SKILL.md"));
  assert.throws(() => change(), /SKILL\.md is a link/);
  rmSync(join(folder, SCRIPT_FILE));
  symlinkSync(join(dir, "nowhere"), join(folder, SCRIPT_FILE));
  rmSync(join(folder, "SKILL.md"));
  writeFileSync(join(folder, "SKILL.md"), "x");
  assert.throws(() => change(), /run is a link/);
  assert.equal(existsSync(join(dir, "nowhere")), false, "a link to nowhere is not made into a file");
  assert.equal(readFileSync(victim, "utf8"), "precious");
  // The folder itself a link.
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(ws.integrations.skillsDir, "dirlink"));
  assert.throws(() => save(ws, "dirlink"), /folder is a link/);
  assert.deepEqual(readFileSync(join(dir, "zshrc"), "utf8"), "precious");
  assert.equal(existsSync(join(elsewhere, SCRIPT_FILE)), false);
  // With the links taken away it saves, as plain files, and the registry has the hash of the script that was given.
  rmSync(join(folder, SCRIPT_FILE));
  change("echo three");
  assert.equal(ws.state.skills.scripts.linky, hashScript("echo three"));
  assert.equal(readFileSync(join(folder, SCRIPT_FILE), "utf8"), "echo three");
  assert.equal(ws.integrations.runnableScript("linky").script, "echo three");
  // A script that is not well formed text is refused: what is written would not be what was approved.
  assert.throws(() => change("echo \ud800"), /broken character/);
});

test("the card of a bot's script command is read in the app: never answered from a notification, a card or a gadget", async (t) => {
  const { ws } = setup(t);
  const views = [];
  ws.interactions.request = async (_chat, _task, view) => (views.push(view), { action: "deny" });
  const chat = ws.createChat("pip");
  const task = {};
  ws.active.set(chat, task);
  const create = ws.sessionTools(ws.bot("pip"), ws.chat(chat), { id: "r" }, task).find((tool) => tool.name === "script_command_create");
  await create.handler({ name: "tidy", description: "Tidies.", script: "echo tidy" });
  const request = { ...views[0], id: "q1", chatId: chat };
  assert.equal(request.review, true);
  assert.equal(askOf(request), "open", "no Allow once away from the app");
  assert.equal(askDetail(request).k, "open");
  assert.equal(askDetail(request).rm, undefined);
  // An ordinary approval still has its buttons.
  assert.equal(askOf({ id: "q2", kind: "permission", title: "Run ls?", preview: "ls" }), "approve");
  // A gadget does not show it as a request that it could answer.
  const device = { name: "Desk", gadget: {} };
  const live = (extra) => ({ requests: [{ id: "q1", chatId: "c1", kind: "permission", title: "Add the script command /tidy?", ...extra }] });
  assert.equal(gadgetPart({ device, chat: { id: "c1", title: "t", messages: [] }, live: live({}) }).phase, "request");
  const part = gadgetPart({ device, chat: { id: "c1", title: "t", messages: [] }, live: live({ review: true }) });
  assert.notEqual(part.phase, "request");
  assert.equal(part.request, undefined);
  // The phone's copies are the same files.
  for (const file of ["cards.mjs", "push.mjs", "gadget.mjs"]) assert.deepEqual(read("../desktop/link/" + file), read("../../mobile/link-host/" + file), file);
});

test("a name that a provider's command has is refused when saving, and a cold or changed menu is read before a typed command runs", { skip: !unix }, async (t) => {
  const commands = [{ name: "clash", description: "A provider's own.", kind: "builtin" }];
  const { ws } = setup(t, { commands });
  // Saving: the window's and the phone's call, and a bot's tool (before any card).
  await assert.rejects(() => ws.assertScriptName("clash"), /command of Pip's model provider/);
  await assert.rejects(() => ws.assertScriptName("/Clash"), /command of Pip's/);
  await ws.assertScriptName("fresh-name");
  await ws.assertScriptName("clash", "clash"); // a command that is being changed keeps its name
  const views = [];
  ws.interactions.request = async (_chat, _task, view) => (views.push(view), { action: "approve" });
  const chat = ws.createChat("pip");
  const task = {};
  ws.active.set(chat, task);
  const create = ws.sessionTools(ws.bot("pip"), ws.chat(chat), { id: "r" }, task).find((tool) => tool.name === "script_command_create");
  await assert.rejects(() => create.handler({ name: "clash", description: "x", script: "true" }), /command of Pip's model provider/);
  assert.equal(views.length, 0);
  ws.active.delete(chat);
  // Typing, with the menu not read yet: a command saved some other way (here, before the provider had it) loses.
  save(ws, "clash", "touch ran-clash");
  ws.clearCatalogs();
  assert.equal(ws.catalogs.size, 0, "a cold menu");
  const typed = ws.createChat("pip");
  await ws.send(typed, "/clash now");
  assert.equal(existsSync(join(ws.dir, "files", "pip", "ran-clash")), false, "the provider's command won");
  assert.equal(ws.state.runs[0].script, undefined);
  assert.deepEqual(commandMessages(ws, typed).filter((m) => /ran|can't run/.test(m.text)), []);
  // A menu that was read before the provider got a command, and has expired, is read again.
  save(ws, "late", "touch ran-late");
  await ws.catalog("pip");
  commands.push({ name: "late", description: "Added by an update.", kind: "builtin" });
  for (const entry of ws.catalogs.values()) entry.expires = 0;
  await ws.send(typed, "/late");
  assert.equal(existsSync(join(ws.dir, "files", "pip", "ran-late")), false);
  // A menu that can't be read decides nothing: the script is not run, and the message says why.
  const failing = setup(t, { commands: "fail" });
  save(failing.ws, "calm", "touch ran-calm");
  const there = failing.ws.createChat("pip");
  await failing.ws.send(there, "/calm");
  assert.equal(existsSync(join(failing.ws.dir, "files", "pip", "ran-calm")), false);
  assert.match(commandMessages(failing.ws, there)[0].text, /^\/calm did not run: Botkins could not read this chat's commands to be sure.*the provider is down.*Try again\.$/);
  // With the menu readable, and no command of that name, it runs.
  const clear = setup(t, { commands: [] });
  save(clear.ws, "calm", "touch ran-calm");
  const here = clear.ws.createChat("pip");
  await clear.ws.send(here, "/calm");
  assert.equal(existsSync(join(clear.ws.dir, "files", "pip", "ran-calm")), true);
});

test("a script does not get Botkins' own secrets or the usual credential variables", { skip: !unix }, async (t) => {
  const kept = scrubbedEnvironment({ PATH: "/bin", HOME: "/h", SHELL: "/bin/sh", LANG: "C", USER: "u", LC_ALL: "C", SSH_AUTH_SOCK: "/agent", GIT_AUTHOR_NAME: "n", BOTKINS_SOCKET: "/s", BOTKINS_DATA_DIR: "/d" });
  assert.deepEqual(Object.keys(kept), ["PATH", "HOME", "SHELL", "LANG", "USER", "LC_ALL", "SSH_AUTH_SOCK", "GIT_AUTHOR_NAME", "BOTKINS_SOCKET", "BOTKINS_DATA_DIR"]);
  const dropped = ["GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "DB_PASSWORD", "CLIENT_SECRET", "BOTKINS_KEY_FILE", "BOTKINS_LINK_CIPHER", "BOTKINS_GIT_BEARER", "BOTKINS_PI_SESSION", "AUTHORIZATION", "STRIPE_KEY"];
  assert.deepEqual(Object.keys(scrubbedEnvironment(Object.fromEntries(dropped.map((name) => [name, "x"])))), []);
  // And in a real run: what the script prints of its environment.
  const { ws } = setup(t);
  const before = { ...process.env };
  Object.assign(process.env, { GITHUB_TOKEN: "ghp_secret", BOTKINS_KEY_FILE: "/keys", MY_DB_PASSWORD: "hunter2" });
  t.after(() => {
    for (const name of ["GITHUB_TOKEN", "BOTKINS_KEY_FILE", "MY_DB_PASSWORD"]) delete process.env[name];
    Object.assign(process.env, before);
  });
  save(ws, "envy", "env");
  const chat = ws.createChat("pip");
  await ws.send(chat, "/envy some words");
  const text = commandMessages(ws, chat)[0].text;
  assert.doesNotMatch(text, /ghp_secret|\/keys|hunter2|GITHUB_TOKEN|BOTKINS_KEY_FILE|MY_DB_PASSWORD/);
  assert.match(text, /^PATH=/m);
  assert.match(text, /^HOME=/m);
  assert.match(text, /^BOTKINS_ARGS=some words$/m);
  assert.match(text, /^BOTKINS_COMMAND=envy$/m);
  assert.ok(text.includes("BOTKINS_CHAT_ID=" + chat));
  assert.equal(scriptRevision({ name: "a", description: "d", script: "x" }), scriptRevision({ name: "A", description: " d ", script: "x" }), "the revision is of the cleaned fields");
  assert.notEqual(scriptRevision({ name: "a", description: "d", script: "x" }), scriptRevision({ name: "a", description: "d", script: "y" }));
});

const T0 = Date.UTC(2026, 10, 17, 12);
const DAILY = { kind: "daily", time: "09:00" };

test("a routine whose prompt is a script command runs it with no model, and its output is delivered as a routine's result is", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  save(ws, "nightly", 'echo "args=[$BOTKINS_ARGS]"; echo "[SILENT]"; echo "{\\"wakeAgent\\": false}"');
  const id = ws.panels.routines.create({ botId: "pip", name: "Nightly", prompt: "/nightly --full run", cadence: DAILY, deliver: { to: "feed" } }, T0);
  await ws.panels.routines.run(id);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Completed");
  assert.equal(run.command, "nightly");
  assert.deepEqual(run.script, { exitCode: 0 });
  assert.deepEqual(seen.sent, [], "no model turn");
  assert.deepEqual(seen.created.filter((name) => !name.startsWith("menu-")), [], "no session of the routine's chat");
  // The output is the run's reply, [SILENT] and wakeAgent have no meaning in it, and it went where the routine's results go.
  const reply = ws.chat(id).messages.findLast((message) => message.role === "assistant" && message.runId === run.id);
  assert.equal(reply.text, 'args=[--full run]\n[SILENT]\n{"wakeAgent": false}');
  assert.equal(run.silent, undefined);
  assert.equal(run.noOutput, undefined);
  assert.equal(ws.board.items[0].source, "Nightly");
  assert.match(ws.board.items[0].title + (ws.board.items[0].body ?? ""), /args=\[--full run\]/);
  // A script that fails ends the run as failed and delivers nothing.
  save(ws, "broken", "echo partial; exit 4");
  const bad = ws.panels.routines.create({ botId: "pip", name: "Broken", prompt: "/broken", cadence: DAILY, deliver: { to: "feed" } }, T0);
  const before = ws.board.items.length;
  await ws.panels.routines.run(bad);
  assert.equal(ws.state.runs[0].status, "Needs you");
  assert.equal(ws.state.runs[0].detail, "/broken failed (exit code 4).");
  assert.match(ws.chat(bad).messages.findLast((message) => message.role === "assistant").text, /^partial\n\nExit code 4\.$/);
  assert.equal(ws.board.items.length, before);
  // A routine that delivers nowhere runs it and keeps no reply.
  const quiet = ws.panels.routines.create({ botId: "pip", name: "Quiet", prompt: "/nightly", cadence: DAILY, deliver: { to: "none" } }, T0);
  await ws.panels.routines.run(quiet);
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.equal(ws.chat(quiet).messages.some((message) => message.role === "assistant"), false);
  // The checks hold: a script that was changed on disk is not run, and says so as the run's result.
  writeFileSync(join(ws.integrations.skillsDir, "nightly", SCRIPT_FILE), "echo changed");
  await ws.panels.routines.run(id);
  assert.equal(ws.state.runs[0].status, "Needs you");
  assert.match(ws.chat(id).messages.findLast((message) => message.role === "assistant").text, /^\/nightly can't run\. The script was changed outside Botkins/);
  // A routine made by a member whose role may not use skills does not run it.
  ws.teamOf = () => TEAM;
  const theirs = ws.panels.routines.create({ botId: "pip", name: "Theirs", prompt: "/broken", cadence: DAILY }, T0, "m_read");
  await ws.panels.routines.run(theirs);
  assert.match(ws.chat(theirs).messages.findLast((message) => message.role === "assistant").text, /Your team role can't use skills/);
});

test("a task whose details are a script command runs it with no model, and its output is the task's result", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  save(ws, "deploy", 'echo "deploying $BOTKINS_ARGS"');
  const id = ws.tasks.save({ title: "Deploy it", body: "/deploy to staging", botId: "pip", status: "later" });
  ws.tasks.start(id);
  const task = ws.tasks.get(id);
  assert.equal(task.status, "working");
  await ws.active.get(task.chatId).done;
  assert.equal(ws.tasks.get(id).status, "review");
  assert.equal(ws.tasks.get(id).result, "deploying to staging");
  assert.deepEqual(seen.sent, [], "no model turn");
  assert.equal(ws.state.runs[0].taskId, id);
  // The title alone, when there are no details.
  const titled = ws.tasks.save({ title: "/deploy now", botId: "pip", status: "later" });
  ws.tasks.start(titled);
  await ws.active.get(ws.tasks.get(titled).chatId).done;
  assert.equal(ws.tasks.get(titled).result, "deploying now");
  // A script that fails blocks the task with the reason.
  save(ws, "broken", "echo no; exit 2");
  const bad = ws.tasks.save({ title: "Broken", body: "/broken", botId: "pip", status: "later" });
  ws.tasks.start(bad);
  await ws.active.get(ws.tasks.get(bad).chatId).done;
  assert.equal(ws.tasks.get(bad).status, "blocked");
  assert.equal(ws.tasks.get(bad).problem, "/broken failed (exit code 2).");
  // A task that is not a script command is a model's turn, as it was.
  const plain = ws.tasks.save({ title: "Write", body: "Write the notes.", botId: "pip", status: "later" });
  ws.tasks.start(plain);
  await ws.active.get(ws.tasks.get(plain).chatId)?.done;
  assert.equal(seen.sent.length, 1);
  assert.match(seen.sent[0], /Work on this task/);
});

/** The tools of a bot's turn, with the card answered as `answer` says. */
function botTools(ws, { run = { id: "run" }, answer = { action: "approve" } } = {}) {
  const views = [];
  ws.interactions.request = async (_chat, _task, view) => (views.push(view), answer);
  const chat = ws.createChat("pip");
  const task = {};
  ws.active.set(chat, task);
  const tools = new Map(ws.sessionTools(ws.bot("pip"), ws.chat(chat), run, task).map((tool) => [tool.name, tool]));
  return { tools, views, chat, task };
}

test("a bot that makes or changes a routine that runs a script command asks the person first, in a card that is read in the app", async (t) => {
  const { ws } = setup(t);
  save(ws, "deploy", "echo deploying", "Deploys.");
  const declined = botTools(ws, { answer: { action: "deny" } });
  const made = { name: "Deploys", instructions: "/deploy --prod", cadence: "daily", time: "09:00" };
  assert.equal(await declined.tools.get("routine_create").handler(made), "The person declined.");
  assert.equal(ws.panels.routines.list("pip").length, 0, "nothing was saved");
  const [card] = declined.views;
  assert.equal(card.review, true, "only opens the app");
  assert.equal(askOf({ ...card, id: "q" }), "open");
  assert.equal(card.title, "Let a routine run the script command /deploy?");
  for (const text of ["Routine: Deploys", "When: daily 09:00", "/deploy on this computer", '"--prod"', "echo deploying"]) assert.ok(card.detail.includes(text), text);
  // A yes saves it.
  const yes = botTools(ws);
  const created = JSON.parse(await yes.tools.get("routine_create").handler(made));
  assert.equal(ws.panels.routines.list("pip").length, 1);
  assert.equal(yes.views.length, 1);
  // A routine that is not a script command has no card.
  const plain = botTools(ws);
  await plain.tools.get("routine_create").handler({ name: "Plain", instructions: "Remind me to stretch.", cadence: "daily", time: "10:00" });
  assert.equal(plain.views.length, 0);
  // A change to the routine's prompt (to or from a script command) asks; a change that leaves a prompt that is no script command does not.
  const change = botTools(ws, { answer: { action: "deny" } });
  assert.equal(await change.tools.get("routine_update").handler({ id: created.id, instructions: "/deploy --other" }), "The person declined.");
  assert.equal(ws.panels.routines.find(created.id).entry.prompt, "/deploy --prod");
  assert.equal(change.views.length, 1);
  assert.match(change.views[0].detail, /"--other"/);
  const quiet = botTools(ws);
  await quiet.tools.get("routine_update").handler({ id: ws.panels.routines.list("pip").find(({ entry }) => entry.name === "Plain").chat.id, instructions: "Remind me to walk." });
  assert.equal(quiet.views.length, 0);
  // An existing routine that invokes it is asked about when its schedule is changed too.
  const when = botTools(ws, { answer: { action: "deny" } });
  assert.equal(await when.tools.get("routine_update").handler({ id: created.id, cadence: "weekdays", time: "07:00" }), "The person declined.");
  assert.match(when.views[0].detail, /When: weekdays 07:00/);
  // The turn ends before the answer: nothing is saved.
  // Work that nobody watches cannot make or change one: there is nobody to ask.
  const unattended = botTools(ws, { run: { id: "r3", scheduleId: 1 } });
  await assert.rejects(() => unattended.tools.get("routine_update").handler({ id: created.id, instructions: "/deploy sneaky" }), /only be made or changed with the person there/);
  assert.equal(ws.panels.routines.find(created.id).entry.prompt, "/deploy --prod");
  const gone = botTools(ws);
  ws.interactions.request = async () => (gone.task.stopped = true, { action: "approve" });
  await assert.rejects(() => gone.tools.get("routine_create").handler({ ...made, name: "Late" }), /This turn has ended/);
  assert.equal(ws.panels.routines.list("pip").some(({ entry }) => entry.name === "Late"), false);
});

test("a bot that makes or changes a task that runs a script command asks the person first", async (t) => {
  const { ws } = setup(t);
  save(ws, "deploy", "echo deploying");
  const declined = botTools(ws, { answer: { action: "deny" } });
  assert.equal(await declined.tools.get("task_create").handler({ title: "Deploy", details: "/deploy now", bot: "Pip", status: "ready" }), "The person declined.");
  assert.equal(ws.tasks.all.length, 0);
  const [card] = declined.views;
  assert.equal(card.review, true);
  assert.equal(card.title, "Let a task run the script command /deploy?");
  for (const text of ["Task: Deploy", "Status: ready, for Pip", "It starts by itself when Pip is free.", '"now"', "echo deploying"]) assert.ok(card.detail.includes(text), text);
  const yes = botTools(ws);
  const made = JSON.parse(await yes.tools.get("task_create").handler({ title: "Deploy", details: "/deploy now", bot: "Pip", status: "later" }));
  assert.equal(ws.tasks.get(made.id).body, "/deploy now");
  // A task that is not a script command has no card, and the title counts when there are no details.
  const plain = botTools(ws);
  await plain.tools.get("task_create").handler({ title: "Write the notes" });
  assert.equal(plain.views.length, 0);
  const titled = botTools(ws, { answer: { action: "deny" } });
  assert.equal(await titled.tools.get("task_create").handler({ title: "/deploy soon" }), "The person declined.");
  // Changing it, or making it ready, asks.
  const change = botTools(ws, { answer: { action: "deny" } });
  assert.equal(await change.tools.get("task_update").handler({ id: made.id, details: "/deploy elsewhere" }), "The person declined.");
  assert.equal(ws.tasks.get(made.id).body, "/deploy now");
  assert.equal(await change.tools.get("task_update").handler({ id: made.id, status: "ready" }), "The person declined.");
  assert.equal(ws.tasks.get(made.id).status, "later");
  assert.equal(change.views.length, 2);
  const approve = botTools(ws);
  await approve.tools.get("task_update").handler({ id: made.id, status: "ready" });
  assert.equal(ws.tasks.get(made.id).status, "ready");
  // Work that nobody watches can only leave one in Later (no card), and cannot change one.
  const unattended = botTools(ws, { run: { id: "r2", scheduleId: 1 } });
  const later = JSON.parse(await unattended.tools.get("task_create").handler({ title: "Deploy", details: "/deploy at night", bot: "Pip", status: "ready" }));
  assert.equal(later.status, "later");
  assert.equal(unattended.views.length, 0);
  await assert.rejects(() => unattended.tools.get("task_update").handler({ id: made.id, details: "/deploy sneaky" }), /only be changed with the person there/);
  assert.equal(ws.tasks.get(made.id).body, "/deploy now");
});
