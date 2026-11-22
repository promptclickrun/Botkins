import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync,mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { PLUGIN_STARTS } from "../desktop/plugins.mjs";
import { botSteps, ownNote } from "../desktop/workspace.mjs";
import { CAPABILITIES } from "../desktop/runtime.mjs";

/** A switch-on as a client makes it after a look: it names the revision of the installed copy. A plugin that runs commands is not switched on without it. */
const switchOn = (plugins, id) => plugins.setEnabled(id, true, { revision: plugins.list().find((p) => p.id === id).revision });

test("a copied folder arrives switched on, and its settings survive restart behind the vault", async (t) => {
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
  // On at once, as an installed plugin is: the window and the phone warn before a folder is added.
  assert.equal(added.enabled, true);
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
  // (Added switched off, so that the bot's proposal to switch it on is what the test looks at.)
  const plugin = await ws.plugins.addFolder(source, { enabled: false });
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
  await switchOn(ws.plugins, added.id);
  const bot = ws.bot("pip");
  const session = () => ws.plugins.session(bot, { id: "chat-1" });
  assert.equal(typeof (await session()).hooks.handlers.onSessionStart, "function");
  // Something on this computer writes into the copy: a second hooks file, which a look by the list of names would find.
  const copy = ws.plugins.records[0].folder;
  mkdirSync(join(copy, "hooks"));
  writeFileSync(join(copy, "hooks", "hooks.json"), JSON.stringify({ hooks: { sessionEnd: [{ command: "touch /tmp/planted" }] } }));
  assert.deepEqual(await session(), { directories: [], mcpServers: {}, hooks: undefined });
  const [listed] = ws.plugins.list();
  assert.deepEqual([listed.status, listed.detail], ["error", "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings."]);
  assert.equal(listed.repair, "update");
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
  await switchOn(again.plugins, back.id);
  assert.equal(again.plugins.list()[0].status, "ready");
  assert.deepEqual(Object.keys((await again.plugins.session(again.bot("pip"), { id: "chat-1" })).hooks.handlers), ["onSessionStart"]);
});

test("a plugin installed by an earlier version that starts anything its description did not show stays on, with a note that is shown as a warning", async (t) => {
  const { open, source, file } = managed(t);
  const long = "echo " + "a".repeat(400);
  const plugin = (name, files) => source(name, { "plugin.json": { name: name + "-fixture", version: "1.0.0" }, ...files });
  const folders = [
    // Only a remote tool and a skill: everything it starts was shown.
    plugin("remote", { ".mcp.json": { mcpServers: { api: { url: "https://example.com/mcp" } } }, "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nA." }),
    // The old description had this tool's name and command, and nothing of its arguments.
    plugin("args", { ".mcp.json": { mcpServers: { files: { command: "sh", args: ["-c", "touch /tmp/unseen"] } } } }),
    // The old description had the first 300 characters of this command.
    plugin("long", { "hooks.json": { hooks: { sessionStart: [{ command: long }] } } }),
    // The old description had this command whole, and the hook has no settings of its own.
    plugin("short", { "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }),
    // A short hook is not enough: this plugin also has a tool with arguments.
    plugin("mixed", { "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } }, ".mcp.json": { mcpServers: { files: { command: "npx", args: ["-y", "pkg"] } } } }),
    // The copy of this one is gone, so nothing of it can be shown.
    plugin("gone", { "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }),
  ];
  const ws = open();
  for (const folder of folders) await switchOn(ws.plugins, (await ws.plugins.addFolder(folder)).id);
  const goneCopy = ws.plugins.records.find((row) => row.preview.name === "gone-fixture").folder;
  rmSync(goneCopy, { recursive: true, force: true });
  // The file as the earlier version kept it: no mark of the reading, and the description that version made.
  const rows = JSON.parse(readFileSync(file, "utf8")).map(({ reading: _mark, ...row }) => ({
    ...row,
    preview: {
      ...row.preview,
      contents: {
        ...row.preview.contents,
        hooks: row.preview.contents.hooks.map(({ event, command }) => ({ event, command: command.slice(0, 300) })),
        mcpServers: row.preview.contents.mcpServers.map(({ name, kind, command, url }) => (kind === "local" ? { name, kind, command } : { name, kind, url })),
      },
    },
  }));
  writeFileSync(file, JSON.stringify(rows));
  const after = open();
  const byName = (name) => after.plugins.list().find((row) => row.name === name + "-fixture");
  const noted = (name) => (byName(name).warnings ?? []).some((line) => UNSEEN.test(line));
  const state = (name) => [byName(name).enabled, byName(name).detail === undefined, noted(name)];
  assert.deepEqual(state("remote"), [true, true, false]);
  assert.deepEqual(state("short"), [true, true, false]);
  // Botkins switches nothing off: what nobody was shown is the first warning, and the plugin stays on.
  for (const name of ["args", "long", "mixed"]) {
    assert.deepEqual(state(name), [true, true, true], name);
    assert.match(byName(name).warnings[0], UNSEEN);
  }
  // What it starts is now shown whole.
  assert.deepEqual(byName("args").contents.mcpServers.map((tool) => tool.args), [["-c", "touch /tmp/unseen"]]);
  assert.equal(byName("long").contents.hooks[0].command, long);
  // A copy that cannot be read stays on as the person had it, with its own reason, and is not marked as read. (A session takes only a copy that is intact and ready, so it starts nothing.)
  assert.equal(byName("gone").enabled, true);
  assert.equal(byName("gone").status, "error");
  assert.match(byName("gone").detail, /^The installed files of this plugin could not be read, so Botkins cannot show what it starts\. Update the plugin to write its files again\.$/);
  assert.equal(byName("gone").repair, "update");
  const stored = () => JSON.parse(readFileSync(file, "utf8"));
  const marked = (name) => stored().find((row) => row.preview.name === name + "-fixture").reading;
  assert.deepEqual(["remote", "args", "long", "short", "mixed"].map(marked), [3, 3, 3, 3, 3]);
  assert.equal(marked("gone"), undefined);
  assert.deepEqual([stored().find((row) => row.preview.name === "gone-fixture").note, stored().find((row) => row.preview.name === "gone-fixture").heldBack], ["unread", undefined]);
  // A switch-on cannot describe it while it cannot be read.
  await assert.rejects(after.plugins.setEnabled(byName("gone").id, true), /could not be read/);
  // The reviewing is done once for what was read. The second open changes nothing more, and the one that was not read is tried again.
  await switchOn(after.plugins, byName("args").id);
  const before = JSON.stringify(stored());
  const third = open();
  assert.equal(JSON.stringify(stored()), before);
  const named = (name) => third.plugins.list().find((row) => row.name === name + "-fixture");
  assert.deepEqual(["remote", "args", "long", "short", "mixed", "gone"].map((name) => named(name).enabled), [true, true, true, true, true, true]);
  // The person's own switch is done with the note. The others keep it.
  assert.equal((named("args").warnings ?? []).some((line) => UNSEEN.test(line)), false);
  assert.match(named("long").warnings[0], UNSEEN);
  assert.equal(marked("gone"), undefined);
  // An update writes its files again. The copy can then be read: the reason and the way back are done with, and it is on as it was.
  await third.plugins.update(named("gone").id, { revision: stored().find((row) => row.preview.name === "gone-fixture").revision });
  assert.deepEqual([named("gone").enabled, named("gone").repair, named("gone").detail, marked("gone"), stored().find((row) => row.preview.name === "gone-fixture").note], [true, undefined, undefined, 3, undefined]);
});

test("a changed copy is put right by an update, which writes the reviewed files again and keeps the settings", async (t) => {
  const { open, source } = managed(t);
  const folder = source("mine", {
    "plugin.json": { name: "repair-fixture", version: "1.0.0" },
    "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } },
    ".mcp.json": { mcpServers: { files: { command: "node", args: ["x.js"], env: { TOKEN: "${user_config.token}" } } } },
  });
  writeFileSync(join(folder, "plugin.json"), JSON.stringify({ name: "repair-fixture", version: "1.0.0", userConfig: { token: { title: "Token", description: "A token", type: "string", sensitive: true } } }));
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  await ws.plugins.configure(added.id, { token: "secret-value" });
  await switchOn(ws.plugins, added.id);
  const isSet = () => ws.plugins.list()[0].config.find((field) => field.key === "token").set;
  assert.equal(isSet(), true);
  const [row] = ws.plugins.records;
  const planted = join(row.folder, "hooks", "hooks.json");
  mkdirSync(join(row.folder, "hooks"));
  writeFileSync(planted, JSON.stringify({ hooks: { sessionEnd: [{ command: "touch /tmp/planted" }] } }));
  await ws.plugins.session(ws.bot("pip"), { id: "chat-1" });
  const [broken] = ws.plugins.list();
  assert.deepEqual([broken.status, broken.detail], ["error", "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings."]);
  assert.equal(broken.repair, "update", "the mark that an update is the way back, for a client that does not read the sentence");
  // The runtime asks before each hook starts.
  assert.equal(ws.plugins.runtimeRecord(row).intact(), false);
  const fixed = await ws.plugins.update(added.id, { revision: row.revision });
  assert.deepEqual([fixed.status, fixed.repair], ["ready", undefined]);
  assert.equal(existsSync(planted), false);
  assert.equal(isSet(), true);
  assert.equal(ws.plugins.runtimeRecord(ws.plugins.records[0]).intact(), true);
  assert.equal(ws.plugins.list()[0].status, "ready");
});

test("every installed copy is checked at the start, not only up to the first bad one", async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  for (const name of ["one", "two", "three"]) await ws.plugins.addFolder(source(name, { "plugin.json": { name: name + "-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }));
  for (const row of ws.plugins.records.slice(0, 3)) {
    mkdirSync(join(row.folder, "hooks"));
    writeFileSync(join(row.folder, "hooks", "hooks.json"), "{}");
  }
  const again = open();
  await again.plugins.queue;
  assert.deepEqual(again.plugins.list().map((row) => row.status), ["error", "error", "error"]);
});

test("a plugin folder that was linked live becomes an installed plugin, on as it was with a note, and no session gets the folder itself", async (t) => {
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
  assert.deepEqual([row.name, row.enabled, row.folder, row.detail], ["linked-fixture", true, folder, undefined]);
  assert.match(row.warnings[0], /^This plugin folder was linked for its skills\. Botkins now keeps a copy of it and shows what it starts on this computer\.$/);
  assert.deepEqual(row.contents.hooks.map((hook) => hook.command), ["touch /tmp/linked"]);
  // The one that could be copied is no longer linked. The one that could not stays in the list, and is not used.
  assert.deepEqual(after.integrations.skillState.plugins.map((link) => link.path), [gone]);
  // A session gets what Botkins wrote from the copy, never the linked folder itself.
  const session = await after.plugins.session(after.bot("pip"), { id: "chat-1" });
  assert.ok(session.directories.every((dir) => dir !== folder && !dir.startsWith(folder + "/")), JSON.stringify(session.directories));
  // A new link cannot be made: the folder goes the plugins' way.
  assert.throws(() => after.integrations.addFromFolder(folder), (error) => error.code === "PLUGIN_FOLDER" && error.folder === folder);
});

test("an install and an update need the revision that was looked at, whoever asks", async (t) => {
  const { open, source, file } = managed(t);
  const folder = source("mine", { "plugin.json": { name: "revision-fixture", version: "1.0.0" } });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  const sentence = /Look at the plugin first\. An install or an update names the revision that was looked at\./;
  const before = readFileSync(file, "utf8");
  await assert.rejects(ws.plugins.install("someone@folder-1"), sentence);
  await assert.rejects(ws.plugins.install("someone@folder-1", {}), sentence);
  await assert.rejects(ws.plugins.update(added.id), sentence);
  await assert.rejects(ws.plugins.update(added.id, {}), sentence);
  await assert.rejects(ws.plugins.update(added.id, { revision: "abc" }), sentence);
  await assert.rejects(ws.plugins.update(added.id, { revision: 7 }), sentence);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(ws.plugins.list().length, 1);
  // With a revision that is not the source's now, the catalog's own refusal comes, not this sentence.
  await assert.rejects(ws.plugins.update(added.id, { revision: "0".repeat(64) }), (error) => !sentence.test(error.message));
  assert.equal(readFileSync(file, "utf8"), before);
  // With the revision of the look, the update goes through.
  const { revision } = await ws.plugins.preview(added.id);
  assert.equal((await ws.plugins.update(added.id, { revision })).revision, revision);
});

test("a copy that is not the reviewed files is checked before an old description of it is made, and the planted command is shown nowhere", async (t) => {
  const { open, source, file } = managed(t);
  const folder = source("mine", { "plugin.json": { name: "old-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  await switchOn(ws.plugins, added.id);
  // The file as an earlier version kept it, and a hook planted into the copy before the app is opened again.
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map(({ reading: _mark, ...row }) => row)));
  const copy = ws.plugins.records[0].folder;
  mkdirSync(join(copy, "hooks"));
  writeFileSync(join(copy, "hooks", "hooks.json"), JSON.stringify({ hooks: { sessionEnd: [{ command: "touch planted-marker-5521" }] } }));
  const again = open();
  const [listed] = again.plugins.list();
  assert.ok(!JSON.stringify(again.plugins.list()).includes("planted-marker-5521"));
  assert.deepEqual([listed.status, listed.repair, listed.enabled, listed.starts], ["error", "update", true, undefined]);
  assert.deepEqual(listed.contents.hooks.map((hook) => hook.command), ["true"]);
  // Not described, not marked, not switched off.
  const [stored] = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([stored.reading, stored.enabled, stored.heldBack], [undefined, true, undefined]);
  assert.ok(!readFileSync(file, "utf8").includes("planted-marker-5521"));
  await again.plugins.queue;
  assert.ok(!JSON.stringify(again.plugins.list()).includes("planted-marker-5521"));
  assert.deepEqual(await again.plugins.session(again.bot("pip"), { id: "chat-1" }), { directories: [], mcpServers: {}, hooks: undefined });
  // An update writes the reviewed files again, and the row is the one reading.
  const fixed = await again.plugins.update(added.id, { revision: stored.revision });
  assert.deepEqual([fixed.status, fixed.repair, fixed.starts], ["ready", undefined, 1]);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].reading, 3);
});

test("a check of the copy that could not be done is not kept, is not called a change, and is tried again at the next look", async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "unsure-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }));
  await switchOn(ws.plugins, added.id);
  const [row] = ws.plugins.records;
  // The check cannot read a file of the copy (no right to read it): that says nothing about the copy.
  const { chmodSync } = await import("node:fs");
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("file rights are not enforced here");
  const warn = t.mock.method(console, "warn", () => {});
  const hooks = join(row.folder, "hooks.json");
  chmodSync(hooks, 0o000);
  t.after(() => {
    try {
      chmodSync(hooks, 0o644);
    } catch {}
  });
  assert.equal(ws.plugins.intact(row), false);
  assert.equal(ws.plugins.checked.has(row.folder), false);
  assert.match(warn.mock.calls.at(-1).arguments[0], /could not check the installed files .* tries again/);
  assert.ok(!/not the files that were reviewed/.test(warn.mock.calls.at(-1).arguments[0]));
  // It is not used now, and the app does not say that the files changed.
  assert.deepEqual(await ws.plugins.session(ws.bot("pip"), { id: "chat-1" }), { directories: [], mcpServers: {}, hooks: undefined });
  // A copy that cannot be read is not "ready": it is an error with its own sentence, the way back is an update, and nothing of it is marked as checked.
  const sentence = "Botkins could not read the installed files of this plugin to check them. Try again. If it stays so, update the plugin: Botkins writes its files again and keeps your settings.";
  const unread = (error) => error.message === sentence;
  const [listed] = ws.plugins.list();
  assert.deepEqual([listed.status, listed.repair, "starts" in listed], ["error", "update", false]);
  assert.equal(listed.detail, sentence);
  // Switching on and updating say the same, not "changed".
  await assert.rejects(ws.plugins.setEnabled(row.preview.id, true), unread);
  // (An update that writes the files again would put it right. This one is a catalog that gives back the same unreadable copy.)
  const real = ws.plugins.catalog.materialize.bind(ws.plugins.catalog);
  ws.plugins.catalog.materialize = async () => ({ folder: row.folder, preview: row.preview, revision: row.revision });
  await assert.rejects(ws.plugins.update(row.preview.id, { revision: row.revision }), unread);
  ws.plugins.catalog.materialize = real;
  // How often in a row it could not be done is kept.
  assert.ok(ws.plugins.unreadable.get(row.folder).times >= 3);
  // Once the files can be read, the next look gives a real answer, and the state is gone.
  chmodSync(hooks, 0o644);
  assert.equal(ws.plugins.intact(row), true);
  assert.equal(ws.plugins.checked.get(row.folder).ok, true);
  assert.equal(ws.plugins.unreadable.has(row.folder), false);
  assert.deepEqual([ws.plugins.list()[0].status, ws.plugins.list()[0].detail, ws.plugins.list()[0].repair, ws.plugins.list()[0].starts], ["ready", undefined, undefined, 1]);
});

test("an installed plugin is marked starts: 1 only when its description is the one reading of an intact copy", async (t) => {
  const { open, source, file } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "mark-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }));
  assert.equal(added.starts, 1);
  assert.equal(ws.plugins.list()[0].starts, 1);
  // A mark that sits in the kept description is not the copy's.
  ws.plugins.records[0].preview.starts = 99;
  assert.equal(ws.plugins.list()[0].starts, 1);
  // Nothing is read from a copy that is changed: the kept description is shown, with no mark.
  writeFileSync(join(ws.plugins.records[0].folder, "extra.txt"), "x");
  assert.equal(ws.plugins.intact(ws.plugins.records[0]), false);
  assert.deepEqual([ws.plugins.list()[0].status, "starts" in ws.plugins.list()[0]], ["error", false]);
  // So is a copy that is not there.
  const gone = open().plugins;
  await gone.queue;
  rmSync(gone.records[0].folder, { recursive: true, force: true });
  assert.equal(gone.intact(gone.records[0]), false);
  assert.equal("starts" in gone.list()[0], false);
  assert.ok(file);
});

test("what the reading did not run reaches the client from the fresh description only", async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "norun-fixture", version: "1.0.0" } }));
  const [row] = ws.plugins.records;
  const real = ws.plugins.described(row);
  const notRun = [{ kind: "hook", event: "preToolUse", reason: "Botkins does not run this event." }];
  ws.plugins.descriptions.set(row.folder, { ...real, notRun });
  assert.deepEqual(ws.plugins.list()[0].contents.notRun, notRun);
  ws.plugins.descriptions.set(row.folder, { ...real, notRun: [] });
  assert.equal("notRun" in ws.plugins.list()[0].contents, false);
  // One that sits in the kept description is not shown for a fresh one.
  row.preview.contents.notRun = notRun;
  assert.equal("notRun" in ws.plugins.list()[0].contents, false);
  assert.ok(added);
});

test("switching on a row the one reading has not read stores what the copy starts", async (t) => {
  const { open, source, file } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "store-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "echo stored-command-77" }] } } }));
  // As if an earlier version had kept it: no mark, and a description with no hooks.
  const [row] = ws.plugins.records;
  row.reading = undefined;
  row.preview = { ...row.preview, contents: { ...row.preview.contents, hooks: [] }, warnings: [] };
  await switchOn(ws.plugins, added.id);
  const [stored] = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.reading, 3);
  assert.deepEqual(stored.preview.contents.hooks.map((hook) => hook.command), ["echo stored-command-77"]);
  assert.ok(stored.preview.warnings.some((line) => /Runs a command/.test(line)));
});

test("an update that cannot work for a plugin that needs one says what to do next", async (t) => {
  const { open, source } = managed(t);
  const folder = source("mine", { "plugin.json": { name: "lost-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  const [row] = ws.plugins.records;
  const { revision } = row;
  // Not a repair: the update's own words, nothing more.
  rmSync(folder, { recursive: true, force: true });
  await assert.rejects(ws.plugins.update(added.id, { revision }), (error) => !/remove it/.test(error.message));
  // A copy that was changed is a repair, and the source is gone too.
  writeFileSync(join(row.folder, "extra.txt"), "x");
  assert.equal(ws.plugins.intact(row), false);
  assert.equal(ws.plugins.list()[0].repair, "update");
  await assert.rejects(ws.plugins.update(added.id, { revision }), / If the plugin cannot be updated, remove it\.$/);
  assert.equal(ws.plugins.list()[0].repair, "update");
});

test("a hook of an open session does not run once the copy was changed, with no stand-in for the hook", { skip: process.platform === "win32" }, async (t) => {
  const { dir, open, source } = managed(t);
  const marker = join(dir, "hook-ran");
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "touch-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "touch " + JSON.stringify(marker) }] } } }));
  await switchOn(ws.plugins, added.id);
  const session = await ws.plugins.session(ws.bot("pip"), { id: "chat-1" });
  await session.hooks.handlers.onSessionStart({});
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  writeFileSync(join(ws.plugins.records[0].folder, "extra.txt"), "changed");
  await session.hooks.handlers.onSessionStart({});
  assert.equal(existsSync(marker), false);
  assert.equal(ws.plugins.list()[0].status, "error");
});

test("a linked plugin folder that could not be copied is listed as a plugin in error, and can be removed", async (t) => {
  const { open, source } = managed(t);
  const good = realpathSync(source("linked", { "plugin.json": { name: "linked-fixture", version: "1.0.0" } }));
  const gone = join(good, "..", "gone");
  const ws = open();
  await ws.plugins.queue;
  ws.integrations.addFolder(ws.integrations.skillState.plugins, good);
  ws.integrations.addFolder(ws.integrations.skillState.plugins, gone);
  ws.save();
  const after = open();
  await after.plugins.queue;
  const listed = after.plugins.list();
  assert.deepEqual(listed.map((row) => row.name), ["linked-fixture", "gone"]);
  const entry = listed[1];
  assert.match(entry.id, /^linked-[a-f0-9]{12}$/);
  assert.deepEqual([entry.marketplace, entry.installed, entry.enabled, entry.bots, entry.status, entry.folder, entry.limits], ["folder", true, false, "all", "error", gone, ""]);
  assert.match(entry.detail, /^This plugin folder was linked for its skills\. Botkins could not copy it, so it is not used: .+\. Put the folder right and start Botkins again, or remove it\.$/);
  assert.ok(entry.detail.length < 500 && !/\n|\bat .*:\d+/.test(entry.detail));
  assert.deepEqual(entry.contents, { skills: [], agents: [], commands: [], mcpServers: [], hooks: [] });
  // Other calls do not know it as an installed plugin.
  assert.throws(() => after.plugins.get(entry.id), /This plugin is no longer installed\./);
  await assert.rejects(after.plugins.setEnabled(entry.id, true), /This plugin is no longer installed\./);
  // Removing it removes the link and the entry.
  await after.plugins.uninstall(entry.id);
  assert.deepEqual(after.integrations.skillState.plugins, []);
  assert.deepEqual(after.plugins.list().map((row) => row.name), ["linked-fixture"]);
  assert.equal(after.plugins.unadopted.size, 0);
});

test("the app names the capability that says its description of a plugin is what the plugin starts", () => {
  // A client tells an app with the one reading from an older one by this name, and asks first for every plugin without it.
  assert.equal(PLUGIN_STARTS, "plugin-starts-v1");
  assert.ok(CAPABILITIES.includes(PLUGIN_STARTS));
});

const UNSEEN = /^An earlier version of Botkins did not show everything that this plugin starts on this computer\. Look at what it starts\.$/;
const NEWHOOK = /^A hook of this plugin did not run before this version of Botkins and runs now\. Look at what it starts\.$/;
const ANOTHER = /This plugin is not the one that was looked at: its revision is another one now\. Look at it again\./;

test("a plugin that a version up to 0.17.2 switched off by itself is on again, with the reason as a warning; one the person switched off stays off", async (t) => {
  const { open, source, file } = managed(t);
  const plugin = (name) => source(name, { "plugin.json": { name: name + "-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const ws = open();
  for (const name of ["unseen", "newhook", "linked", "mine"]) await ws.plugins.addFolder(plugin(name));
  // The file as 0.17.2 kept it: three switched off by Botkins (`heldBack`), and one that the person switched off (no reason).
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map((row) => {
    const name = row.preview.name.replace("-fixture", "");
    return { ...row, enabled: false, ...(name !== "mine" && { heldBack: name }) };
  })));
  const after = open();
  const byName = (name) => after.plugins.list().find((row) => row.name === name + "-fixture");
  const stored = () => JSON.parse(readFileSync(file, "utf8"));
  assert.match(byName("unseen").warnings[0], UNSEEN);
  assert.match(byName("newhook").warnings[0], NEWHOOK);
  assert.match(byName("linked").warnings[0], /^This plugin folder was linked for its skills\./);
  for (const name of ["unseen", "newhook", "linked"]) {
    assert.deepEqual([byName(name).enabled, byName(name).detail], [true, undefined], name);
    const row = stored().find((entry) => entry.preview.name === name + "-fixture");
    assert.deepEqual([row.enabled, row.note, row.heldBack], [true, name, undefined], name);
  }
  assert.equal(byName("mine").enabled, false, "the person's own choice of off stays");
});

test("a switch-on and a choice of bots can name the revision that was looked at, and the app compares it", async (t) => {
  const { open, source, file } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "look-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }), { enabled: false });
  const { revision } = ws.plugins.records[0];
  const before = readFileSync(file, "utf8");
  // Another revision: refused, and nothing is kept.
  await assert.rejects(ws.plugins.setEnabled(added.id, true, { revision: "0".repeat(64) }), ANOTHER);
  await assert.rejects(ws.plugins.setBots(added.id, ["pip"], { revision: "0".repeat(64) }), ANOTHER);
  assert.equal(readFileSync(file, "utf8"), before);
  // A request that is not nothing or { revision: a hash }.
  for (const bad of ["abc", 7, [], { revision: "abc" }, { revision: 7 }, { revision: null }]) {
    await assert.rejects(ws.plugins.setEnabled(added.id, true, bad), /Check the plugin request\./, JSON.stringify(bad));
    await assert.rejects(ws.plugins.setBots(added.id, ["pip"], bad), /Check the plugin request\./, JSON.stringify(bad));
  }
  assert.equal(readFileSync(file, "utf8"), before);
  // The revision that is installed: it works.
  await ws.plugins.setBots(added.id, ["pip"], { revision });
  await ws.plugins.setEnabled(added.id, true, { revision });
  assert.deepEqual([ws.plugins.list()[0].enabled, ws.plugins.list()[0].bots], [true, ["pip"]]);
  // None: a switch-off needs none, and for the bots too. A switch-on of this plugin, which has a hook, works with none too:
  // nothing, null and an object with no revision. Only a revision that is given is compared.
  for (const none of [undefined, null, {}]) {
    await ws.plugins.setEnabled(added.id, false);
    await ws.plugins.setEnabled(added.id, true, none);
    assert.equal(ws.plugins.list()[0].enabled, true, JSON.stringify(none));
  }
  await ws.plugins.setBots(added.id, "all", {});
  await ws.plugins.setBots(added.id, ["pip"]);
  assert.deepEqual([ws.plugins.list()[0].enabled, ws.plugins.list()[0].bots], [true, ["pip"]]);
});

test("the app switches on a plugin that runs commands with no revision, and compares a revision that is given", async (t) => {
  const { open, source, file } = managed(t);
  const ws = open();
  const off = { enabled: false };
  const hook = await ws.plugins.addFolder(source("hook", { "plugin.json": { name: "hook-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }), off);
  const tool = await ws.plugins.addFolder(source("tool", { "plugin.json": { name: "tool-fixture", version: "1.0.0" }, ".mcp.json": { mcpServers: { files: { command: "node", args: ["x.js"] } } } }), off);
  const skills = await ws.plugins.addFolder(source("skills", { "plugin.json": { name: "skills-fixture", version: "1.0.0" }, "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nA." }), off);
  const revisionOf = (id) => ws.plugins.list().find((row) => row.id === id).revision;
  const enabled = (id) => ws.plugins.list().find((row) => row.id === id).enabled;
  const stored = () => readFileSync(file, "utf8");
  // (a) No revision: it is switched on, for a hook and for a tool that is a program. The warnings come before it, where a person is
  // (the window, the phone, the command line). It is kept.
  for (const id of [hook.id, tool.id]) {
    await ws.plugins.setEnabled(id, true);
    assert.equal(enabled(id), true);
    assert.equal(JSON.parse(stored()).find((row) => row.preview.id === id).enabled, true);
    await ws.plugins.setEnabled(id, false);
  }
  const before = stored();
  // (c) Another revision: the refusal for a plugin that is not the one that was looked at.
  await assert.rejects(ws.plugins.setEnabled(hook.id, true, { revision: "0".repeat(64) }), ANOTHER);
  assert.equal(enabled(hook.id), false);
  assert.equal(stored(), before);
  // (b) The right revision: it works.
  for (const id of [hook.id, tool.id]) {
    await ws.plugins.setEnabled(id, true, { revision: revisionOf(id) });
    assert.equal(enabled(id), true);
  }
  // A plugin that is on already and is switched on again: nothing changes, so nothing is refused.
  await ws.plugins.setEnabled(hook.id, true);
  assert.equal(enabled(hook.id), true);
  // (e) A switch-off needs none.
  await ws.plugins.setEnabled(hook.id, false);
  assert.equal(enabled(hook.id), false);
  // (d) A plugin that runs nothing needs none.
  await ws.plugins.setEnabled(skills.id, true);
  assert.equal(enabled(skills.id), true);
});

test("a switch-on of a copy that was changed is refused, with a revision and with none", async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "order-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }));
  const copy = ws.plugins.records[0].folder;
  mkdirSync(join(copy, "hooks"));
  writeFileSync(join(copy, "hooks", "hooks.json"), JSON.stringify({ hooks: { sessionEnd: [{ command: "touch /tmp/planted" }] } }));
  await assert.rejects(ws.plugins.setEnabled(added.id, true), /are not the files that were reviewed/);
  await assert.rejects(ws.plugins.setEnabled(added.id, true, { revision: ws.plugins.list()[0].revision }), /are not the files that were reviewed/);
});

test("the bot's tool names the revision of its card for a switch-on, and the app refuses a card that is not the installed plugin", async (t) => {
  const { pluginTools } = await import("../desktop/plugin-tools.mjs");
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "card-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }));
  const bot = ws.bot("pip");
  const chat = ws.chat(ws.createChat(bot.id));
  const task = {};
  ws.active.set(chat.id, task);
  const propose = (action) => pluginTools(ws, bot, chat, { id: "fixture" }, task).find((tool) => tool.name === "propose_plugin").handler({ id: added.id, action });
  const yes = async (action) => {
    const pending = propose(action);
    const [request] = ws.interactions.snapshot();
    ws.interactions.respond(request.id, { action: "approve" });
    return pending;
  };
  const enabled = () => ws.plugins.list()[0].enabled;
  // The card shows the revision of the installed copy, and the yes switches on that one.
  assert.equal(await yes("enable"), "Plugin change saved.");
  assert.equal(enabled(), true);
  assert.equal(await yes("disable"), "Plugin change saved.");
  assert.equal(enabled(), false);
  // A card that shows another revision than the installed one (the list is as it was before the plugin changed): refused, and the plugin stays off.
  const list = ws.plugins.list.bind(ws.plugins);
  ws.plugins.list = () => list().map((row) => ({ ...row, revision: "0".repeat(64) }));
  await assert.rejects(yes("enable"), ANOTHER);
  assert.equal(enabled(), false);
});

test("an update that is under way finishes before a yes is compared, so an old yes does not switch on the new version", async (t) => {
  const { open, source, file } = managed(t);
  const ws = open();
  const folder = source("mine", { "plugin.json": { name: "race-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const added = await ws.plugins.addFolder(folder, { enabled: false });
  const old = ws.plugins.records[0].revision;
  writeFileSync(join(folder, "hooks.json"), JSON.stringify({ hooks: { sessionStart: [{ command: "echo something else" }] } }));
  const { revision: newer } = await ws.plugins.preview(added.id);
  assert.notEqual(newer, old);
  // Not awaited: the yes joins the queue behind the update.
  const updating = ws.plugins.update(added.id, { revision: newer });
  const yes = ws.plugins.setEnabled(added.id, true, { revision: old });
  await assert.rejects(yes, ANOTHER);
  assert.equal((await updating).revision, newer);
  assert.equal(ws.plugins.records[0].revision, newer);
  assert.deepEqual([ws.plugins.list()[0].enabled, JSON.parse(readFileSync(file, "utf8"))[0].enabled], [false, false]);
  // The same for more bots.
  await ws.plugins.setEnabled(added.id, true, { revision: newer });
  await assert.rejects(ws.plugins.setBots(added.id, ["pip"], { revision: old }), ANOTHER);
  assert.equal(ws.plugins.list()[0].bots, "all");
  await ws.plugins.setBots(added.id, ["pip"], { revision: newer });
  assert.deepEqual(ws.plugins.list()[0].bots, ["pip"]);
});

test("a hook that earlier versions never ran and runs now leaves the plugin on, with a note that is shown as a warning until the person switches it", async (t) => {
  const { open, source, file } = managed(t);
  // The old description had the hook by its command, and the hook has no settings of its own: nothing else is unseen.
  const alias = source("alias", { "plugin.json": { name: "alias-fixture", version: "1.0.0" }, "hooks.json": { hooks: { UserPromptSubmit: [{ command: "echo hi" }] } } });
  const same = source("same", { "plugin.json": { name: "same-fixture", version: "1.0.0" }, "hooks.json": { hooks: { userPromptSubmitted: [{ command: "echo hi" }] } } });
  const ws = open();
  for (const folder of [alias, same]) await switchOn(ws.plugins, (await ws.plugins.addFolder(folder)).id);
  // The file as an earlier version kept it: no mark of the reading, a hook by its event and command.
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map(({ reading: _mark, ...row }) => ({ ...row, preview: { ...row.preview, contents: { ...row.preview.contents, hooks: row.preview.contents.hooks.map(({ event, command }) => ({ event, command })) } } }))));
  const stored = () => JSON.parse(readFileSync(file, "utf8"));
  const after = open();
  const byName = (workspace, name) => workspace.plugins.list().find((row) => row.name === name + "-fixture");
  const noted = (workspace, name) => (byName(workspace, name).warnings ?? []).some((line) => NEWHOOK.test(line));
  assert.deepEqual([byName(after, "alias").enabled, byName(after, "alias").detail, noted(after, "alias")], [true, undefined, true]);
  assert.match(byName(after, "alias").warnings[0], NEWHOOK);
  assert.deepEqual([byName(after, "same").enabled, byName(after, "same").detail, noted(after, "same")], [true, undefined, false]);
  assert.equal(stored().find((row) => row.preview.name === "alias-fixture").note, "newhook");
  // The person switches it (here: on again, after a look): the note is done with, also at the next open.
  await switchOn(after.plugins, byName(after, "alias").id);
  assert.equal(stored().find((row) => row.preview.name === "alias-fixture").note, undefined);
  const third = open();
  assert.deepEqual([byName(third, "alias").enabled, noted(third, "alias"), byName(third, "same").enabled], [true, false, true]);
});

/** A marketplace of one plugin, for an install by name. */
function marketplace(t, name, files) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugin-market-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const market = join(dir, "market");
  const plugin = join(market, "plugins", name);
  mkdirSync(join(market, ".github", "plugin"), { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(market, ".github", "plugin", "marketplace.json"), JSON.stringify({ name: "test-market", plugins: [{ name, source: "plugins/" + name }] }));
  for (const [file, value] of Object.entries(files)) writeFileSync(join(plugin, file), JSON.stringify(value));
  return { dir, market, plugin };
}

test("the mark starts is never written to plugins.json, and an older file that has it loses it at the first open", async (t) => {
  const { open, source, file } = managed(t);
  const made = marketplace(t, "garden", { "plugin.json": { name: "garden", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const ws = open();
  await ws.plugins.catalog.addMarketplace(made.market);
  const card = await ws.plugins.preview("garden@test-market");
  assert.equal(card.starts, 1, "the catalog's description carries the mark");
  const installed = await ws.plugins.install("garden@test-market", { revision: card.revision });
  assert.equal(installed.starts, 1);
  const stored = () => readFileSync(file, "utf8");
  assert.ok(!stored().includes('"starts"'), "install");
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "mine-fixture", version: "1.0.0" } }));
  assert.equal(added.starts, 1);
  assert.ok(!stored().includes('"starts"'), "addFolder");
  assert.ok(ws.plugins.records.every((row) => !("starts" in row.preview) && !("starts" in row.preview.contents)), "the rows in memory have no mark either");
  const updated = await ws.plugins.update("garden@test-market", { revision: card.revision });
  assert.equal(updated.starts, 1);
  assert.ok(!stored().includes('"starts"'), "update");
  // Switching on stores a fresh description: no mark in it either.
  await switchOn(ws.plugins, added.id);
  assert.ok(!stored().includes('"starts"'), "setEnabled");
  // A file as an earlier build of this change wrote it: the mark in the description, and in its contents.
  writeFileSync(file, JSON.stringify(JSON.parse(stored()).map((row) => ({ ...row, preview: { ...row.preview, starts: 1, contents: { ...row.preview.contents, starts: 1 } } }))));
  assert.ok(stored().includes('"starts"'));
  const again = open();
  assert.ok(!stored().includes('"starts"'), "the file is written again at the first open");
  assert.ok(again.plugins.records.every((row) => !("starts" in row.preview)));
  // The answer still carries the mark for an intact copy.
  assert.deepEqual(again.plugins.list().map((row) => row.starts), [1, 1]);
});

test("a row marked 2 is looked at once for a hook that runs now, and not for what its complete description already showed", async (t) => {
  const { open, source, file } = managed(t);
  const plugin = (name, files) => source(name, { "plugin.json": { name: name + "-fixture", version: "1.0.0" }, ...files });
  const ws = open();
  const folders = [
    plugin("prompt", { "hooks.json": { hooks: { UserPromptSubmit: [{ command: "echo hi" }] } } }),
    plugin("every", { "hooks.json": { hooks: { preToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo all" }] }] } } }),
    plugin("plain", { "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }),
    // A tool with arguments: the old rule would switch a row with no mark off, a row marked 2 was shown them.
    plugin("tool", { ".mcp.json": { mcpServers: { files: { command: "sh", args: ["-c", "true"] } } } }),
  ];
  for (const folder of folders) await switchOn(ws.plugins, (await ws.plugins.addFolder(folder)).id);
  const stored = () => JSON.parse(readFileSync(file, "utf8"));
  const rowOf = (name) => stored().find((row) => row.preview.name === name + "-fixture");
  // The file as the earlier build of this change kept it: marked 2, on.
  writeFileSync(file, JSON.stringify(stored().map((row) => ({ ...row, reading: 2 }))));
  const after = open();
  const byName = (workspace, name) => workspace.plugins.list().find((row) => row.name === name + "-fixture");
  const noted = (workspace, name) => (byName(workspace, name).warnings ?? []).some((line) => NEWHOOK.test(line) || UNSEEN.test(line));
  for (const name of ["prompt", "every"]) {
    assert.deepEqual([byName(after, name).enabled, byName(after, name).detail], [true, undefined], name);
    assert.match(byName(after, name).warnings[0], NEWHOOK);
    assert.equal(rowOf(name).note, "newhook");
  }
  for (const name of ["plain", "tool"]) assert.deepEqual([byName(after, name).enabled, byName(after, name).detail, noted(after, name)], [true, undefined, false], name);
  assert.deepEqual(["prompt", "every", "plain", "tool"].map((name) => rowOf(name).reading), [3, 3, 3, 3]);
  // The person switches it after a look: the note is done with at the second open. The other one keeps its note, and stays on.
  await switchOn(after.plugins, byName(after, "prompt").id);
  const second = open();
  assert.deepEqual([byName(second, "prompt").enabled, noted(second, "prompt")], [true, false]);
  assert.deepEqual([byName(second, "every").enabled, noted(second, "every")], [true, true], "what the person has not switched keeps its note");
  assert.deepEqual(["prompt", "every", "plain", "tool"].map((name) => rowOf(name).reading), [3, 3, 3, 3]);
  assert.equal(byName(open(), "prompt").enabled, true);
});

test("the sentence about removing a plugin is only for an update that cannot work, not for a revision to look at again", async (t) => {
  const { open, source } = managed(t);
  const folder = source("mine", { "plugin.json": { name: "again-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  const [row] = ws.plugins.records;
  writeFileSync(join(row.folder, "extra.txt"), "x");
  assert.equal(ws.plugins.intact(row), false);
  assert.equal(ws.plugins.list()[0].repair, "update");
  const remove = / If the plugin cannot be updated, remove it\./;
  // The catalog says the source is another revision now: the step is to look again.
  await assert.rejects(ws.plugins.update(added.id, { revision: "0".repeat(64) }), (error) => /was reviewed; preview it again/.test(error.message) && !remove.test(error.message));
  // No revision at all: this app's own refusal, with nothing added.
  await assert.rejects(ws.plugins.update(added.id, {}), (error) => /Look at the plugin first/.test(error.message) && !remove.test(error.message));
  // The source is gone: the update cannot work, and the person is told what is left.
  rmSync(folder, { recursive: true, force: true });
  await assert.rejects(ws.plugins.update(added.id, { revision: row.revision }), remove);
});

test("a tool whose line holds the value of a secret setting is said as not run, and the vault is not opened for each answer", async (t) => {
  const { open, source } = managed(t);
  const folder = source("mine", {
    "plugin.json": { name: "secret-fixture", version: "1.0.0", userConfig: { KEY: { title: "Key", sensitive: true }, SHORT: { title: "Short", sensitive: true } } },
    ".mcp.json": { mcpServers: { holds: { command: "node", args: ["--key", "s3cret-value"] }, clean: { command: "node", args: ["server.js"] } } },
  });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  const items = (listed) => {
    const notRun = listed.contents.notRun;
    return notRun === undefined ? [] : Array.isArray(notRun) ? notRun : notRun.items;
  };
  // No value set yet: both tools are said to start.
  assert.deepEqual(items(ws.plugins.list()[0]), []);
  await ws.plugins.configure(added.id, { KEY: "s3cret-value", SHORT: "ab" });
  const [listed] = ws.plugins.list();
  assert.deepEqual(items(listed), [{ what: "tool", name: "holds", why: "A word of this tool's command holds the value of a secret setting, so Botkins does not start it." }]);
  // The list stays what the files say.
  assert.deepEqual(listed.contents.mcpServers.map((tool) => tool.name), ["holds", "clean"]);
  const notRun = listed.contents.notRun;
  if (!Array.isArray(notRun)) assert.equal(notRun.count, 1);
  // The vault is asked once for the same copy and settings, not for each answer.
  const get = t.mock.method(ws.plugins.vault, "get");
  ws.plugins.list();
  ws.plugins.list();
  assert.equal(get.mock.callCount(), 0);
  // A new value is a new key: the answer follows it.
  await ws.plugins.configure(added.id, { KEY: "another-value" });
  assert.deepEqual(items(ws.plugins.list()[0]), []);
});

test("a row that is already at the current reading is not hashed in the constructor, and one from before is", async (t) => {
  const { open, source, file } = managed(t);
  const ws = open();
  const current = await ws.plugins.addFolder(source("now", { "plugin.json": { name: "now-fixture", version: "1.0.0" } }));
  const old = await ws.plugins.addFolder(source("old", { "plugin.json": { name: "old-fixture", version: "1.0.0" } }));
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map(({ reading, ...row }) => (row.preview.id === old.id ? row : { ...row, reading }))));
  const again = open();
  // (The queue checks the rest later, so right after the start only the old row has been checked.)
  const checked = again.plugins.records.filter((row) => again.plugins.checked.has(row.folder)).map((row) => row.preview.id);
  assert.deepEqual(checked, [old.id]);
  assert.ok(current);
  await again.plugins.queue;
  assert.equal(again.plugins.checked.size, 2);
});

test("when Botkins stops a plugin's hook from keeping a turn going, the turn that runs in that chat gets one line", { skip: process.platform === "win32" }, async (t) => {
  const { open, source } = managed(t);
  const folder = source("loops", { "plugin.json": { name: "loop-fixture", version: "1.0.0" }, "hooks.json": { hooks: { agentStop: [{ command: "echo '{\"decision\":\"block\",\"reason\":\"go on\"}'" }] } } });
  const ws = open();
  const added = await ws.plugins.addFolder(folder);
  await switchOn(ws.plugins, added.id);
  const session = await ws.plugins.session(ws.bot("pip"), { id: "chat-1" });
  // A turn runs in the chat: its steps are the turn's activity.
  const run = { id: "run-1", steps: [] };
  ws.active.set("chat-1", { run });
  const stop = session.hooks.handlers.onAgentStop;
  const decisions = [(await stop({ stopHookActive: false }))?.decision];
  for (let turn = 0; turn < 4; turn++) decisions.push((await stop({ stopHookActive: true }))?.decision);
  ws.active.delete("chat-1");
  assert.deepEqual(decisions, ["block", "block", "block", undefined, undefined]);
  assert.deepEqual(run.steps.map((step) => [step.name, step.label, step.status]), [["Botkins", "The plugin " + added.id + " kept this turn going 3 times. Botkins did not let it do that again.", "Done"]]);
  // An installed plugin's answer names the revision that a switch-on is compared with: the row's own.
  assert.equal(ws.plugins.list()[0].revision, ws.plugins.records[0].revision);
});

const BLOCKING = { "plugin.json": { name: "loop-fixture", version: "1.0.0" }, "hooks.json": { hooks: { agentStop: [{ command: "echo '{\"decision\":\"block\",\"reason\":\"go on\"}'" }] } } };

test("a session opened again in the middle of a turn goes on with the count, and the next turn starts it again, also when the runtime says nothing", { skip: process.platform === "win32" }, async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("loops", BLOCKING));
  await switchOn(ws.plugins, added.id);
  const notes = [];
  ws.pluginNote = (chatId, line) => notes.push([chatId, line]);
  const chat = { id: "chat-1" };
  const first = (await ws.plugins.session(ws.bot("pip"), chat)).hooks.handlers.onAgentStop;
  const blocks = async (stop, input) => (await stop(input))?.decision === "block";
  assert.equal(await blocks(first, { stopHookActive: false }), true);
  assert.equal(await blocks(first, { stopHookActive: true }), true);
  // The session is opened again (a retry after a stall, a change of model). The count is not started again.
  const again = (await ws.plugins.session(ws.bot("pip"), chat)).hooks.handlers.onAgentStop;
  assert.equal(await blocks(again, { stopHookActive: true }), true);
  assert.equal(await blocks(again, { stopHookActive: true }), false);
  assert.equal(notes.length, 1);
  // Another chat has a count of its own.
  const other = (await ws.plugins.session(ws.bot("pip"), { id: "chat-2" })).hooks.handlers.onAgentStop;
  assert.equal(await blocks(other, { stopHookActive: true }), true);
  // A runtime that says nothing: the limit holds for the turn, and the app's start of the next turn gives three more.
  const quiet = (await ws.plugins.session(ws.bot("pip"), { id: "chat-3" })).hooks.handlers.onAgentStop;
  const run = [];
  for (let turn = 0; turn < 4; turn++) run.push(await blocks(quiet, {}));
  assert.deepEqual(run, [true, true, true, false]);
  ws.plugins.turnStarted("chat-3");
  const next = [];
  for (let turn = 0; turn < 4; turn++) next.push(await blocks(quiet, {}));
  assert.deepEqual(next, [true, true, true, false]);
  assert.equal(notes.filter(([chatId]) => chatId === "chat-3").length, 2);
  // A chat that never had a session is no error. Chat-1's count is not touched by another chat's new turn.
  ws.plugins.turnStarted("no-such-chat");
  assert.equal(await blocks(again, { stopHookActive: true }), false);
  ws.plugins.turnStarted("chat-1");
  assert.equal(await blocks(again, { stopHookActive: true }), true);
});

test("the counts of blocks are kept for at most 500 chats", async (t) => {
  const { open } = managed(t);
  const ws = open();
  const first = ws.plugins.stopsFor("chat-0");
  for (let index = 1; index <= 500; index++) ws.plugins.stopsFor("chat-" + index);
  assert.equal(ws.plugins.stops.size, 500);
  assert.equal(ws.plugins.stops.has("chat-0"), false);
  assert.notEqual(ws.plugins.stopsFor("chat-0"), first);
  // A chat in use stays: asking for it again makes it the newest.
  ws.plugins.stopsFor("chat-2");
  ws.plugins.stopsFor("chat-new");
  assert.equal(ws.plugins.stops.has("chat-2"), true);
  assert.equal(ws.plugins.stops.has("chat-3"), false);
});

test("a new turn of a person starts the count, a recovery or a retry of the same turn does not", async (t) => {
  const { open } = managed(t);
  const ws = open();
  const started = [];
  ws.plugins.turnStarted = (chatId) => started.push(chatId);
  const id = ws.createChat("pip");
  await ws.send(id, "Hello");
  assert.deepEqual(started, [id]);
  // (The same turn's recovery goes through startTurn with recovering: true.)
  const chat = ws.chat(id);
  const run = ws.state.runs[0];
  ws.startTurn(chat, ws.bot("pip"), chat.messages.at(-1), run, true);
  await ws.active.get(id)?.done;
  assert.deepEqual(started, [id]);
});

test("a setting named like a password, with no secret mark, is a secret for the manager as for the runtime", async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", {
    "plugin.json": { name: "passwd-fixture", version: "1.0.0", userConfig: { DB_PASSWD: { title: "Password" } } },
    ".mcp.json": { mcpServers: { holds: { command: "node", args: ["--pass", "s3cret-value"] }, clean: { command: "node", args: ["server.js"] } } },
  }));
  await ws.plugins.configure(added.id, { DB_PASSWD: "s3cret-value" });
  const row = ws.plugins.records[0];
  assert.ok(!row.preview.config.find((field) => field.key === "DB_PASSWD").secret, "the catalog set no secret mark");
  const { notRun } = ws.plugins.list()[0].contents;
  assert.deepEqual((Array.isArray(notRun) ? notRun : notRun.items).map((item) => item.name), ["holds"]);
});

test("a read of the vault that threw is not kept: it is tried again after 30 seconds, and not before", async (t) => {
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", {
    "plugin.json": { name: "vault-fixture", version: "1.0.0", userConfig: { KEY: { title: "Key", sensitive: true } } },
    ".mcp.json": { mcpServers: { holds: { command: "node", args: ["--key", "s3cret-value"] } } },
  }));
  await ws.plugins.configure(added.id, { KEY: "s3cret-value" });
  let clock = 1_000_000;
  ws.plugins.now = () => clock;
  ws.plugins.stopped.clear();
  let broken = true;
  const real = ws.plugins.vault.get.bind(ws.plugins.vault);
  const get = t.mock.method(ws.plugins.vault, "get", (ref) => {
    if (broken) throw new Error("the vault could not be read");
    return real(ref);
  });
  const held = () => {
    const { notRun } = ws.plugins.list()[0].contents;
    return notRun === undefined ? [] : (Array.isArray(notRun) ? notRun : notRun.items).map((item) => item.name);
  };
  // The read throws: nothing is said as stopped meanwhile, and the vault is asked once.
  assert.deepEqual(held(), []);
  assert.deepEqual(held(), []);
  assert.equal(get.mock.callCount(), 1);
  clock += 29_000;
  assert.deepEqual(held(), []);
  assert.equal(get.mock.callCount(), 1);
  // After 30 seconds it asks again. Still broken: once more, and the wait starts again.
  clock += 1_000;
  assert.deepEqual(held(), []);
  assert.equal(get.mock.callCount(), 2);
  assert.deepEqual(held(), []);
  assert.equal(get.mock.callCount(), 2);
  // Mended: the next try, after the wait, gives the answer, and it is kept.
  broken = false;
  clock += 30_000;
  assert.deepEqual(held(), ["holds"]);
  const calls = get.mock.callCount();
  assert.deepEqual(held(), ["holds"]);
  assert.equal(get.mock.callCount(), calls);
});

test("a copy whose check could not be done is checked again when the list is asked for, at most every 30 seconds, and the error goes when the check works", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("file rights are not enforced here");
  const { chmodSync } = await import("node:fs");
  const { open, source } = managed(t);
  const ws = open();
  const added = await ws.plugins.addFolder(source("mine", { "plugin.json": { name: "recheck-fixture", version: "1.0.0" }, "hooks.json": { hooks: { sessionStart: [{ command: "true" }] } } }), { enabled: false });
  const [row] = ws.plugins.records;
  assert.equal(row.enabled, false, "the plugin is off");
  t.mock.method(console, "warn", () => {});
  let clock = 5_000_000;
  ws.plugins.now = () => clock;
  const hooks = join(row.folder, "hooks.json");
  chmodSync(hooks, 0o000);
  t.after(() => {
    try {
      chmodSync(hooks, 0o644);
    } catch {}
  });
  assert.equal(ws.plugins.intact(row), false);
  assert.equal(ws.plugins.list()[0].status, "error");
  const times = () => ws.plugins.unreadable.get(row.folder)?.times;
  assert.equal(times(), 1);
  // The files can be read again, but a list in a loop does not hash in a loop: within 30 seconds nothing is checked.
  chmodSync(hooks, 0o644);
  for (let index = 0; index < 5; index++) assert.equal(ws.plugins.list()[0].status, "error");
  clock += 29_000;
  assert.equal(ws.plugins.list()[0].status, "error");
  assert.equal(times(), 1);
  // After 30 seconds the list checks again, and the state clears when the check works.
  clock += 1_000;
  const [listed] = ws.plugins.list();
  assert.deepEqual([listed.id, listed.status, listed.detail, listed.repair], [added.id, "ready", undefined, undefined]);
  assert.equal(ws.plugins.unreadable.has(row.folder), false);
  assert.equal(ws.plugins.checked.get(row.folder).ok, true);
  // A check that still cannot be done waits another 30 seconds.
  chmodSync(hooks, 0o000);
  ws.plugins.checked.delete(row.folder);
  assert.equal(ws.plugins.intact(row), false);
  clock += 10_000;
  ws.plugins.list();
  assert.equal(times(), 1);
  clock += 20_000;
  ws.plugins.list();
  assert.equal(times(), 2);
});

test("a write of the plugins file that fails in the one-time look is said in one line, with the file's name only", async (t) => {
  const { open, source, dir, file } = managed(t);
  const ws = open();
  const old = await ws.plugins.addFolder(source("old", { "plugin.json": { name: "old-fixture", version: "1.0.0" } }));
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map(({ reading, ...row }) => row)));
  // The temporary file's name is a folder: the write fails.
  mkdirSync(file + ".tmp");
  const warn = t.mock.method(console, "warn", () => {});
  const again = open();
  assert.ok(old);
  const lines = warn.mock.calls.map((call) => call.arguments.join(" ")).filter((line) => /plugins file/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not write the plugins file plugins\.json, so it looks at the older plugins again at the next start/);
  assert.ok(!lines[0].includes(dir));
  // The rows are as the look made them for this run, and the file is as it was: the next start looks again.
  assert.equal(again.plugins.records[0].reading, 3);
  assert.equal("reading" in JSON.parse(readFileSync(file, "utf8"))[0], false);
});

test("a note that Botkins wrote in a turn's activity is not the bot's work", async (t) => {
  const { open } = managed(t);
  const ws = open();
  const run = { id: "run-1", steps: [] };
  ws.active.set("chat-1", { run });
  ws.pluginNote("chat-1", "The plugin x kept this turn going 3 times. Botkins did not let it do that again.");
  ws.active.delete("chat-1");
  assert.equal(run.steps.length, 1);
  assert.equal(ownNote(run.steps[0]), true);
  // So a turn with only that note is still "finished without a reply" (both places ask botSteps), and a recovery does not show it to the model.
  assert.deepEqual(botSteps(run.steps), []);
  const work = { id: "call-1", label: "Run tests", status: "Done" };
  assert.deepEqual(botSteps([...run.steps, work]), [work]);
  assert.deepEqual(botSteps(undefined), []);
  assert.equal(ownNote({ id: "toolu_1" }), false);
  assert.equal(ownNote({}), false);
});
