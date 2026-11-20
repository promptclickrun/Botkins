import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";

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
