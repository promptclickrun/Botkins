// Script commands (desktop/script-commands.mjs): a slash command that runs a script with no model.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { tempDir, tick } from "./fake-copilot.mjs";
import { authorize } from "../desktop/link/team.mjs";
import { enabledSkills } from "../desktop/providers/skills.mjs";
import { RESERVED_COMMANDS, SCRIPT_FILE, cleanScriptCommand, commandKind, matchScriptCommand, scriptCommandTools, shownScript } from "../desktop/script-commands.mjs";
import { desktopCommands } from "../desktop/providers/copilot/commands.mjs";
import { SCRIPT_LENGTH } from "../desktop/routine-script.mjs";

const unix = process.platform !== "win32";
const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));

/** A workspace whose Copilot client records the sessions it is asked to open, and what each was given. */
function setup(t, { commands = [] } = {}) {
  const dir = tempDir(t, "botkins-script-commands-");
  const seen = { created: [], configs: [], sent: [] };
  const rpc = {
    commands: { list: async () => ({ commands }) },
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
  assert.deepEqual(seen.created, [], "no session was opened");
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

test("a team member's message does not run a script command", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  save(ws, "touchy", "touch ran");
  const chat = ws.createChat("pip");
  await ws.send(chat, "/touchy", { author: { memberId: "m_avery", name: "Avery" } });
  assert.deepEqual(commandMessages(ws, chat).map((m) => m.text), ["Only the computer's owner can run a script command."]);
  assert.equal(existsSync(join(ws.dir, "files", "pip", "ran")), false);
  assert.deepEqual(seen.created, []);
  // And a member's chat does not either, even when the owner types in it.
  const theirs = ws.createChat("pip", "Theirs", undefined, "m_avery");
  await ws.send(theirs, "/touchy");
  assert.match(commandMessages(ws, theirs)[0].text, /Only the computer's owner/);
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
