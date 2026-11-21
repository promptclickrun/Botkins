// Agent access: resolution rules and backend enforcement, with fake Copilot sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { accessField, canUseProject } from "../desktop/access.mjs";

/** A fake client that records each session's config and answers "ok". */
function fakeClient() {
  const log = { configs: new Map() };
  const make = (id, config) => {
    log.configs.set(id, config);
    const handlers = new Set();
    const emit = (event) => handlers.forEach((handler) => handler(event));
    return {
      sessionId: id,
      on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
      emit,
      rpc: {},
      abort: async () => {},
      disconnect: async () => {},
      send: async () => {
        const messageId = id + ":message";
        emit({ type: "user.message", id: messageId, data: { messageId } });
        emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "ok" } });
        emit({ type: "session.idle", data: { mode: "interactive" } });
        return messageId;
      },
    };
  };
  const client = {
    createSession: async (config) => make(config.sessionId, config),
    resumeSession: async (id, config) => make(id, config),
    deleteSession: async () => {},
  };
  return { log, client: async () => client };
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-access-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { log, client } = fakeClient();
  const ws = new Workspace(dir, client, () => {});
  const migration = ws.projects.create({ name: "Migration", description: "Move mail to the cloud" });
  const rollout = ws.projects.create({ name: "Rollout" });
  const personal = ws.projects.create({ name: "Personal" });
  return { dir, ws, log, migration, rollout, personal };
}

test("access resolves globally, by all and per project", (t) => {
  const { ws, migration, rollout, personal } = setup(t);
  const bot = ws.bot("pip");
  const s = ws.state;
  assert.equal(s.settings.access.allBots, true, "global access is on by default");
  assert.deepEqual(bot.access, { all: false, projects: [] }, "bots get an empty grant");
  assert.ok(canUseProject(s, bot, migration), "global lets every bot in");
  ws.setPreferences({ access: { allBots: false } });
  assert.ok(!canUseProject(s, bot, migration) && !canUseProject(s, bot, personal));
  ws.access.setBotAccess("pip", { all: false, projects: [personal] });
  assert.ok(canUseProject(s, bot, personal) && !canUseProject(s, bot, migration) && !canUseProject(s, bot, rollout));
  ws.access.setBotAccess("pip", { all: true });
  assert.ok(canUseProject(s, bot, rollout));
  assert.ok(!canUseProject(s, ws.bot("scout"), rollout), "other bots keep their own grants");
  assert.throws(() => accessField(s, { projects: ["nope"] }), /Unknown project/);
  assert.deepEqual(accessField(s, { all: false, unknown: ["old"], projects: [] }), { all: false, projects: [] }, "the grant accepts only current fields");
  assert.throws(() => ws.setPreferences({ access: { allBots: "no" } }), /all bots/);
  // Deleting a project removes it from grants.
  ws.access.setBotAccess("scout", { projects: [personal] });
  ws.projects.remove(personal);
  assert.deepEqual(ws.bot("scout").access.projects, []);
});

test("chats can't be created or moved into a project the bot can't use; turning access off refuses turns", async (t) => {
  const { ws, migration } = setup(t);
  ws.setPreferences({ access: { allBots: false } });
  const before = ws.state.chats.length;
  assert.throws(() => ws.projects.startChat(["pip"], migration), /Pip doesn't have access to the project “Migration”/);
  assert.equal(ws.state.chats.length, before, "a refused chat isn't left behind");
  const plain = ws.createChat("pip");
  assert.throws(() => ws.projects.setChatProject(plain, migration), /doesn't have access/);
  assert.equal(ws.chat(plain).projectId, undefined);

  ws.access.setBotAccess("pip", { projects: [migration] });
  const id = ws.projects.startChat(["pip"], migration);
  assert.equal(ws.chat(id).projectId, migration);
  await ws.send(id, "hello");
  assert.equal(ws.chat(id).messages.at(-1).text, "ok");

  // Taking access away keeps the chat, refuses new turns and explains why.
  ws.access.setBotAccess("pip", { projects: [] });
  assert.equal(ws.chat(id).projectId, migration, "nothing is deleted");
  assert.throws(() => ws.send(id, "again"), /doesn't have access to the project “Migration”.*Settings › Access/);
  assert.throws(() => ws.submit(id, "again"), /doesn't have access/);
  ws.setPreferences({ access: { allBots: true } });
  await ws.send(id, "back");
  assert.equal(ws.chat(id).messages.filter((m) => m.role === "assistant").length, 2);
});

test("group chats in a project need access for every member, and can't use a folder", (t) => {
  const { ws, dir, migration, personal } = setup(t);
  ws.setPreferences({ access: { allBots: false } });
  ws.access.setBotAccess("pip", { projects: [migration] });
  assert.throws(() => ws.projects.startChat(["pip", "scout"], migration), /Scout doesn't have access/);
  ws.access.setBotAccess("scout", { all: true });
  const group = ws.projects.startChat(["pip", "scout"], migration);
  assert.deepEqual(ws.chat(group).botIds, ["pip", "scout"]);
  assert.equal(ws.chat(group).projectId, migration);
  assert.throws(() => ws.projects.setChatProject(group, personal), /Pip doesn't have access/);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const coding = ws.projects.add(repo);
  ws.setPreferences({ access: { allBots: true } });
  assert.throws(() => ws.projects.setChatProject(group, coding), /Group chats .* project folder/);
  ws.setPreferences({ access: { allBots: false } });
  ws.access.setBotAccess("pip", { projects: [] });
  assert.throws(() => ws.send(group, "hi"), /Pip doesn't have access/);
});

test("a chat in a project gets the project in its system message and the to-do tools", async (t) => {
  const { ws, log, migration } = setup(t);
  const id = ws.projects.startChat(["pip"], migration);
  await ws.send(id, "hi");
  const config = log.configs.get(id);
  const system = config.systemMessage.content;
  assert.match(system, /This chat belongs to the project “Migration”\.\nProject description: Move mail to the cloud/);
  const names = config.tools.definitions.map((x) => x.name);
  for (const n of ["todo_list", "todo_add", "todo_update", "project_info"]) assert.ok(names.includes(n), n);
  const plain = ws.createChat("pip");
  await ws.send(plain, "hi");
  const other = log.configs.get(plain);
  assert.doesNotMatch(other.systemMessage.content, /belongs to the project/);
  assert.ok(!other.tools.definitions.some((x) => x.name.startsWith("todo_")), "chats outside a project get no to-do tools");
});

test("project tools act on the chat's own project and stop when access is gone", async (t) => {
  const { ws, migration } = setup(t);
  const id = ws.projects.startChat(["pip"], migration);
  const chat = ws.chat(id);
  const task = { stopped: false };
  ws.active.set(id, task);
  const tools = Object.fromEntries(ws.projects.tools(ws.bot("pip"), chat, { id: "r" }, task).map((x) => [x.name, x]));
  const added = JSON.parse(await tools.todo_add.handler({ text: "Draft the plan" }));
  assert.equal(ws.projects.get(migration).todos[0].text, "Draft the plan");
  JSON.parse(await tools.todo_update.handler({ id: added.id, done: true, text: "Draft the cutover plan" }));
  assert.deepEqual(JSON.parse(await tools.todo_list.handler({})), [{ id: added.id, text: "Draft the cutover plan", done: true }]);
  assert.deepEqual(JSON.parse(await tools.todo_list.handler({ open_only: true })), []);
  const info = JSON.parse(await tools.project_info.handler({}));
  assert.deepEqual(info, { id: migration, name: "Migration", description: "Move mail to the cloud", folder: null, todos: { open: 0, done: 1 } });
  ws.setPreferences({ access: { allBots: false } });
  await assert.rejects(async () => tools.todo_list.handler({}), /doesn't have access/);
  ws.access.setBotAccess("pip", { projects: [migration] });
  assert.equal(JSON.parse(await tools.todo_list.handler({})).length, 1);
});

test("panels published from a project chat join the project, and need access", (t) => {
  const { ws, migration } = setup(t);
  const id = ws.projects.startChat(["pip"], migration);
  const blocks = [{ type: "markdown", text: "Status" }];
  ws.panels.write("pip", id, { key: "status", title: "Status", blocks }, { id: "r1" });
  const panel = ws.state.panels.find((p) => p.key === "status");
  assert.equal(panel.projectId, migration);
  const elsewhere = ws.createChat("pip");
  ws.panels.write("pip", elsewhere, { key: "news", title: "News", blocks }, { id: "r2" });
  assert.equal(ws.state.panels.find((p) => p.key === "news").projectId, undefined);
  ws.setPreferences({ access: { allBots: false } });
  assert.throws(() => ws.panels.write("pip", id, { key: "status", revision: 1, title: "Status", blocks }, { id: "r3" }), /doesn't have access/);
  ws.access.setBotAccess("pip", { projects: [migration] });
  ws.panels.write("pip", id, { key: "status", revision: 1, title: "Status 2", blocks }, { id: "r4" });
  // A panel refresh chat works for the panel's project.
  const refresh = ws.createChat("pip", "Updates · Status", panel.id);
  assert.equal(ws.projects.projectOf(ws.chat(refresh)).id, migration);
  ws.projects.remove(migration);
  assert.equal(panel.projectId, undefined, "deleting the project unlinks its panels");
});
