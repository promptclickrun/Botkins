import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { PLUGIN_STARTS } from "../desktop/plugins.mjs";
import { CAPABILITIES } from "../desktop/runtime.mjs";

test("a copied folder needs activation and its settings survive restart behind the vault", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugin-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "mine");
  mkdirSync(source);
  writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "memory-fixture", version: "1.0.0", mcpServers: ".mcp.json" }));
  writeFileSync(
    join(source, ".mcp.json"),
    JSON.stringify({
      mcpServers: { memory: { type: "http", url: "http://127.0.0.1:12345/mcp", headers: { Authorization: "Bearer ${MEMORY_API_KEY}" } } },
    }),
  );
  const open = () => new Workspace(join(dir, "data"), fakeClient().client, () => {});
  const ws = open();
  const added = await ws.plugins.addFolder(source);
  assert.equal(added.enabled, false);
  assert.equal(added.status, "needs-config");
  await ws.plugins.configure(added.id, { MEMORY_API_KEY: "synthetic-marker-907" });
  await ws.plugins.setBots(added.id, ["pip"]);
  await ws.plugins.setEnabled(added.id, true);
  const snapshot = ws.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-marker-907"));
  assert.ok(!readFileSync(join(dir, "data", "plugins.json"), "utf8").includes("synthetic-marker-907"));
  const restored = open().plugins.list()[0];
  assert.equal(restored.config.find((f) => f.key === "MEMORY_API_KEY").set, true);
  assert.equal(restored.status, "ready");
  assert.deepEqual(restored.bots, ["pip"]);
  await ws.plugins.uninstall(added.id);
  assert.deepEqual(ws.plugins.list(), []);
  assert.deepEqual((await ws.plugins.browse({ marketplace: "folder" })).plugins, []);
  assert.ok(readFileSync(join(source, "plugin.json"), "utf8").includes("memory-fixture"));
});

test("a bot in an approve-all chat still needs the person's approval and secure input", async (t) => {
  const { pluginTools } = await import("../desktop/plugin-tools.mjs");
  const dir = mkdtempSync(join(tmpdir(), "botkins-propose-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "plugin");
  mkdirSync(source);
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "calendar",
      userConfig: {
        CALENDAR_KEY: { title: "Calendar key", sensitive: true, required: true },
      },
    }),
  );
  const ws = new Workspace(join(dir, "data"), fakeClient().client, () => {});
  const plugin = await ws.plugins.addFolder(source);
  const bot = ws.bot("pip"),
    chat = ws.chat(ws.createChat(bot.id)),
    task = {},
    run = { id: "fixture" };
  chat.approval = "all";
  ws.active.set(chat.id, task);
  const tools = pluginTools(ws, bot, chat, run, task);
  const propose = (action) => tools.find((tool) => tool.name === "propose_plugin").handler({ id: plugin.id, action });
  const current = (kind) => {
    const req = ws.interactions.snapshot()[0];
    assert.equal(req.kind, kind);
    return req;
  };
  const pending = propose("enable");
  ws.interactions.respond(current("permission").id, { action: "deny" });
  assert.match(await pending, /declined/);
  assert.equal(ws.plugins.list()[0].enabled, false);
  const marker = "synthetic-tool-only-credential-3141";
  const configure = propose("configure");
  ws.interactions.respond(current("permission").id, { action: "approve" });
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = current("secure");
  assert.equal(prompt.fields[0].key, "CALENDAR_KEY");
  ws.interactions.respond(prompt.id, { action: "accept", content: { CALENDAR_KEY: marker } });
  const reply = await configure;
  assert.ok(!JSON.stringify([reply, ws.snapshot()]).includes(marker));
  assert.equal(ws.plugins.values(ws.plugins.get(plugin.id)).CALENDAR_KEY, marker);
  assert.equal(ws.plugins.list()[0].enabled, false);
  for (const unattended of [{ scheduleId: "routine" }, { taskId: "task" }, { panelId: "panel" }])
    assert.deepEqual(pluginTools(ws, bot, chat, unattended, task), []);
});

test("plugin OAuth is bound to the installed server and removed with the plugin", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugin-oauth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, "calendar");
  mkdirSync(folder);
  writeFileSync(join(folder, "plugin.json"), JSON.stringify({ name: "calendar" }));
  writeFileSync(
    join(folder, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        calendar: { type: "http", url: "https://calendar.example/mcp", oauth: { clientId: "test-client" } },
      },
    }),
  );
  const ws = new Workspace(join(dir, "data"), fakeClient().client, () => {});
  const p = await ws.plugins.addFolder(folder);
  assert.equal(p.status, "needs-sign-in");
  const [server] = ws.plugins.oauthServers(ws.plugins.get(p.id));
  assert.equal(p.contents.mcpServers[0].serverId, server.id);
  await ws.plugins.setBots(p.id, ["pip"]);
  await ws.plugins.setEnabled(p.id, true);
  const marker = "test-only-plugin-access-token";
  ws.plugins.oauth.write(server, { accessToken: marker, tokenType: "Bearer" });
  assert.equal(ws.plugins.list()[0].status, "ready");
  const request = { server: server.name, url: server.url };
  assert.equal(await ws.plugins.token("scout", request), null);
  assert.equal(await ws.plugins.token("pip", { ...request, url: "https://elsewhere.example" }), null);
  assert.ok(JSON.stringify(await ws.plugins.token("pip", request)).includes(marker));
  assert.ok(!JSON.stringify(ws.snapshot()).includes(marker));
  await ws.plugins.uninstall(p.id);
  assert.equal(ws.plugins.oauth.status(server).signedIn, false);
});

test("the server id shown in an installed plugin completes the host OAuth flow", async (t) => {
  const { oauthMcpServer } = await import("./oauth-server.mjs");
  const remote = await oauthMcpServer();
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugin-sign-in-"));
  t.after(async () => {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = join(dir, "plugin");
  mkdirSync(source);
  writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "calendar" }));
  writeFileSync(
    join(source, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        calendar: { type: "http", url: remote.url, oauth: {} },
      },
    }),
  );
  const ws = new Workspace(join(dir, "data"), fakeClient().client, () => {}, {
    oauthPort: 0,
    openExternal: (url) => remote.browser(url),
  });
  const added = await ws.plugins.addFolder(source);
  const serverId = added.contents.mcpServers[0].serverId;
  assert.equal(added.status, "needs-sign-in");
  assert.equal((await ws.plugins.signIn(serverId)).signedIn, true);
  assert.equal(ws.plugins.list()[0].status, "ready");
  await ws.plugins.signOut(serverId);
  assert.equal(ws.plugins.list()[0].status, "needs-sign-in");
});

/** A workspace in a folder of its own, and a way to open it again as after a restart. */
function managed(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugin-copy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => new Workspace(join(dir, "data"), fakeClient().client, () => {});
  const source = (name, files) => {
    const root = join(dir, name);
    for (const [file, value] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
    }
    return root;
  };
  return { dir, open, source, file: join(dir, "data", "plugins.json") };
}

test("an installed copy that was changed on disk is not used, the app says why, and a new install puts the reviewed files back", async (t) => {
  const { open, source } = managed(t);
  const folder = source("mine", { "plugin.json": { name: "copy-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  await ws.plugins.setEnabled(added.id, true);
  const bot = ws.bot("pip");
  const session = () => ws.plugins.session(bot, { id: "chat-1" });
  assert.equal(typeof (await session()).hooks.handlers.onSessionStart, "function");
  // Something on this computer writes into the copy: a second hooks file, which a look by the list of names would find.
  const copy = ws.plugins.records[0].folder;
  mkdirSync(join(copy, "hooks"));
  writeFileSync(join(copy, "hooks", "hooks.json"), JSON.stringify({ hooks: { sessionEnd: [{ command: "touch /tmp/planted" }] } }));
  assert.deepEqual(await session(), { directories: [], mcpServers: {}, hooks: undefined });
  const [listed] = ws.plugins.list();
  assert.deepEqual([listed.status, listed.detail], ["error", "The installed files of this plugin are not the files that were reviewed. Remove the plugin and install it again."]);
  // Off and on again does not get round it.
  await ws.plugins.setEnabled(added.id, false);
  await assert.rejects(ws.plugins.setEnabled(added.id, true), /are not the files that were reviewed/);
  // After a restart the copy is checked again before anything of it is used.
  const again = open();
  await again.plugins.queue;
  assert.equal(again.plugins.list()[0].status, "error");
  // Remove and add: the reviewed files are written again, and the planted file is gone.
  await again.plugins.uninstall(added.id);
  const back = await again.plugins.addFolder(folder);
  await again.plugins.setEnabled(back.id, true);
  assert.equal(again.plugins.list()[0].status, "ready");
  assert.deepEqual(Object.keys((await again.plugins.session(again.bot("pip"), { id: "chat-1" })).hooks.handlers), ["onSessionStart"]);
});

test("a plugin installed by an earlier version that starts a command its description did not have is switched off until the person has looked", async (t) => {
  const { open, source, file } = managed(t);
  const hidden = source("hidden", { "plugin.json": { name: "hidden-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ type: "x", darwin: "touch /tmp/unseen" }] } } });
  const long = "echo " + "a".repeat(400);
  const honest = source("honest", { "plugin.json": { name: "honest-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: long }] } }, ".mcp.json": { mcpServers: { files: { command: "npx", args: ["-y", "pkg"] } } } });
  const ws = open();
  for (const folder of [hidden, honest]) await ws.plugins.setEnabled((await ws.plugins.addFolder(folder)).id, true);
  // The file as the earlier version kept it: no mark of the reading, and the description that version made
  // (no hook for the first plugin; for the second the command cut at 300 characters and the program's name alone).
  const rows = JSON.parse(readFileSync(file, "utf8")).map(({ reading: _mark, ...row }) => ({
    ...row,
    preview: { ...row.preview, contents: { ...row.preview.contents, hooks: row.preview.name === "hidden-fixture" ? [] : [{ event: "sessionStart", command: long.slice(0, 300) }], mcpServers: row.preview.contents.mcpServers.map(({ name, kind, command }) => ({ name, kind, command })) } },
  }));
  writeFileSync(file, JSON.stringify(rows));
  const after = open();
  const byName = (name) => after.plugins.list().find((row) => row.name === name);
  assert.equal(byName("hidden-fixture").enabled, false);
  assert.match(byName("hidden-fixture").detail, /Botkins switched this plugin off\. An earlier version of Botkins did not show everything that this plugin starts/);
  assert.deepEqual(byName("hidden-fixture").contents.hooks, [{ event: "sessionStart", command: "touch /tmp/unseen", env: [], timeoutSec: 10 }]);
  assert.match(byName("hidden-fixture").warnings.join(" "), /Runs a command on your computer through plugin hooks/);
  // What the old description had, cut or with less said, was shown: that plugin stays on, and now shows the whole.
  assert.equal(byName("honest-fixture").enabled, true);
  assert.equal(byName("honest-fixture").detail, undefined);
  assert.equal(byName("honest-fixture").contents.hooks[0].command, long);
  assert.deepEqual(byName("honest-fixture").contents.mcpServers, [{ name: "files", kind: "local", command: "npx", args: ["-y", "pkg"], env: [] }]);
  // It is done once: the file has the mark, and the person's switch is theirs from then on.
  await after.plugins.setEnabled(byName("hidden-fixture").id, true);
  const third = open();
  assert.deepEqual(third.plugins.list().map((row) => [row.name, row.enabled, row.detail]).sort(), [["hidden-fixture", true, undefined], ["honest-fixture", true, undefined]]);
});

test("a plugin folder that was linked live becomes an installed plugin, switched off, and no session gets the folder itself", async (t) => {
  const { open, source } = managed(t);
  const folder = realpathSync(source("linked", { "plugin.json": { name: "linked-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "touch /tmp/linked" }] } }, "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nA." }));
  const gone = join(folder, "..", "gone");
  const ws = open();
  await ws.plugins.queue;
  // As an earlier version left it: the folder in the list of linked plugin folders.
  ws.integrations.addFolder(ws.integrations.skillState.plugins, folder);
  ws.integrations.addFolder(ws.integrations.skillState.plugins, gone);
  ws.save();
  const after = open();
  await after.plugins.queue;
  const [row] = after.plugins.list();
  assert.deepEqual([row.name, row.enabled, row.folder], ["linked-fixture", false, folder]);
  assert.match(row.detail, /This plugin folder was linked for its skills\. Botkins now keeps a copy of it and shows what it starts/);
  assert.deepEqual(row.contents.hooks.map((hook) => hook.command), ["touch /tmp/linked"]);
  // The one that could be copied is no longer linked. The one that could not stays in the list, and is not used.
  assert.deepEqual(after.integrations.skillState.plugins.map((link) => link.path), [gone]);
  assert.deepEqual(await after.plugins.session(after.bot("pip"), { id: "chat-1" }), { directories: [], mcpServers: {}, hooks: undefined });
  // A new link cannot be made: the folder goes the plugins' way.
  assert.throws(() => after.integrations.addFromFolder(folder), (error) => error.code === "PLUGIN_FOLDER" && error.folder === folder);
});

test("the app names the capability that says its description of a plugin is what the plugin starts", () => {
  // A client tells an app with the one reading from an older one by this name, and asks first for every plugin without it.
  assert.equal(PLUGIN_STARTS, "plugin-starts-v1");
  assert.ok(CAPABILITIES.includes(PLUGIN_STARTS));
});
