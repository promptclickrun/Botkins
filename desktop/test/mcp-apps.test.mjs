// MCP Apps in chat (desktop/mcp-apps.mjs) against a real MCP server over stdio
// (test/fixtures/mcp-app-server.mjs), counting the tool calls it really gets.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { proxyName, resultText, serverKey, viewCsp } from "../desktop/mcp-apps.mjs";
import { MCP_URL } from "../desktop/composio.mjs";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-app-server.mjs", import.meta.url));

/** A Copilot client that records each session's options and answers "ok". */
function fakeClient() {
  const configs = [];
  const make = (id, config) => {
    configs.push(config);
    const handlers = new Set();
    const emit = (event) => handlers.forEach((handler) => handler(event));
    return {
      sessionId: id,
      on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
      rpc: {},
      abort: async () => {},
      disconnect: async () => {},
      send: async () => {
        const messageId = id + ":m";
        emit({ type: "user.message", id: messageId, data: { messageId } });
        emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "ok" } });
        emit({ type: "session.idle", data: { mode: "interactive" } });
        return messageId;
      },
    };
  };
  const client = { createSession: async (config) => make(config.sessionId, config), resumeSession: async (id, config) => make(id, config), deleteSession: async () => {} };
  return { configs, client: async () => client };
}

function setup(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-mcp-apps-"));
  const log = join(dir, "calls.log");
  const { configs, client } = fakeClient();
  const ws = new Workspace(dir, client, () => {});
  // The server's environment is kept in the vault as the app keeps it; `open` reads it back for the connection.
  ws.integrations.open = () => ({ BOTKINS_TEST_LOG: log, ...env });
  ws.state.mcpServers.push({ id: "clock-id", name: "clock", type: "stdio", command: process.execPath, args: [SERVER], env: { BOTKINS_TEST_LOG: "ref" }, enabled: true });
  t.after(async () => {
    ws.mcpApps.close();
    ws.connects.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const calls = (tool) => requests().filter((entry) => entry.method === "tools/call" && (!tool || entry.tool === tool)).length;
  const bot = ws.state.bots[0];
  /** A turn under way in a new chat, with the routed servers' tools as the bot gets them. */
  const turn = async () => {
    const chatId = ws.createChat(bot.id);
    const run = { id: "run-" + chatId, chatId, status: "Working" };
    ws.state.runs.unshift(run);
    const task = { stopped: false };
    ws.active.set(chatId, task);
    const routed = await ws.mcpApps.prepare(bot);
    const tools = Object.fromEntries(ws.mcpApps.tools(bot, ws.chat(chatId), run, task, routed).map((tool) => [tool.name, tool]));
    return { chatId, run, task, routed, tools };
  };
  const discovered = async () => {
    await ws.mcpApps.prepare(bot);
    await Promise.all(ws.mcpApps.looking.values());
  };
  return { ws, dir, bot, configs, requests, calls, turn, discovered };
}

test("a server is looked at once, then run by Botkins: the harness doesn't get it, the bot gets its tools for the model", async (t) => {
  const { ws, bot, configs, requests, turn, discovered } = setup(t);
  // The first turn: the server isn't known yet, so it goes to the harness while Botkins looks at it.
  await ws.send(ws.createChat(bot.id), "Hello");
  assert.ok(Object.keys(configs.at(-1).mcp.servers).includes("clock"), "the harness has the server on the first turn");
  assert.ok(!configs.at(-1).tools.definitions.some((tool) => tool.name.startsWith("clock__")));
  await discovered();
  assert.equal(requests()[0].method, "initialize");
  assert.deepEqual(requests()[0].ui, { mimeTypes: ["text/html;profile=mcp-app"] }, "Botkins says it shows views");
  assert.equal(requests().filter((entry) => entry.method === "tools/list").length, 2, "every page of tools is read");
  assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "mcp-apps.json"), "utf8"))["clock-id"].views, true);

  const { tools } = await turn();
  assert.deepEqual(Object.keys(tools).sort(), ["clock__echo", "clock__get_time", "clock__set_alarm"], "a tool for the view only is not the model's");
  assert.equal(tools.clock__get_time.skipPermission, true, "a tool that only reads doesn't ask");
  assert.equal(tools.clock__set_alarm.skipPermission, false, "a tool that may change something asks as before");

  // A whole turn: the harness gets no "clock" server, and the bot gets its tools with Botkins' own.
  const chatId = ws.createChat(bot.id);
  await ws.send(chatId, "What time is it?");
  const config = configs.at(-1);
  assert.ok(!Object.keys(config.mcp.servers).includes("clock"));
  assert.ok(config.tools.definitions.some((tool) => tool.name === "clock__get_time"));
});

test("a tool with a view: the model reads text only, the card keeps the actual result, and showing it never runs the tool again", async (t) => {
  const { ws, calls, requests, turn, discovered } = setup(t);
  await discovered();
  const { chatId, run, tools } = await turn();
  const text = await tools.clock__get_time.handler({ zone: "UTC" });
  assert.equal(text, "It is 12:01.");
  assert.equal(calls("get_time"), 1);
  assert.equal(requests().filter((entry) => entry.method === "resources/read").length, 1, "the view is read through the same connection");
  assert.equal(run.mcpApps.length, 1);
  const [card] = run.mcpApps;
  assert.deepEqual({ server: card.server, tool: card.tool, summary: card.summary }, { server: "clock", tool: "get_time", summary: "It is 12:01." });

  // What the chat keeps and a phone syncs has nothing of the view's own data.
  assert.ok(!JSON.stringify(ws.state).includes("view-only"), "_meta stays out of the workspace");
  const view = ws.mcpApps.view(chatId, card.id, { html: true });
  assert.deepEqual(view.input, { zone: "UTC" });
  assert.deepEqual(view.result.structuredContent, { time: "12:01", zone: "UTC" });
  assert.equal(view.result._meta.secret, "view-only-1");
  assert.match(view.html, /<title>Clock<\/title>/);
  assert.deepEqual(view.csp, { resourceDomains: ["https://cdn.clock.example"], connectDomains: ["https://api.clock.example"] });
  assert.equal(view.prefersBorder, true);
  ws.mcpApps.view(chatId, card.id);
  ws.mcpApps.page(card.id);
  assert.equal(calls("get_time"), 1, "showing the card again reads what was kept");

  // A plain tool keeps its text result and makes no card.
  assert.equal(await tools.clock__echo.handler({ text: "hi" }), "hi");
  assert.equal(run.mcpApps.length, 1);
});

test("parallel calls of the same tool each get their own card with their own result", async (t) => {
  const { calls, turn, discovered } = setup(t);
  await discovered();
  const { run, tools } = await turn();
  const answers = await Promise.all([tools.clock__get_time.handler({ zone: "A" }), tools.clock__get_time.handler({ zone: "B" })]);
  assert.equal(calls("get_time"), 2);
  assert.equal(new Set(answers).size, 2);
  assert.equal(run.mcpApps.length, 2);
  assert.notEqual(run.mcpApps[0].id, run.mcpApps[1].id);
  assert.deepEqual(run.mcpApps.map((card) => card.summary).sort(), [...answers].sort());
});

test("a view calls only its own server's tools that it may use, with approvals, and not once access is gone", async (t) => {
  const { ws, bot, calls, turn, discovered } = setup(t);
  await discovered();
  const { chatId, run, tools } = await turn();
  await tools.clock__get_time.handler({});
  const card = run.mcpApps[0].id;

  // A button in the view asks the same server for fresh data (a tool for the view only).
  const fresh = await ws.mcpApps.callTool(chatId, card, "refresh_time", {});
  assert.match(fresh.result.content[0].text, /12:02/);
  assert.equal(calls("refresh_time"), 1);
  await assert.rejects(ws.mcpApps.callTool(chatId, card, "no_such_tool", {}), /can't use that tool/);

  // A tool that may change something asks the person first, unless the chat allows everything.
  const asked = await ws.mcpApps.callTool(chatId, card, "set_alarm", { at: "7:00" });
  assert.deepEqual(asked, { needsApproval: { tool: "set_alarm", title: "set_alarm", server: "clock" } });
  assert.equal(calls("set_alarm"), 0);
  assert.equal((await ws.mcpApps.callTool(chatId, card, "set_alarm", { at: "7:00" }, { approved: true })).result.content[0].text, "Alarm set.");
  ws.chat(chatId).approval = "all";
  assert.equal((await ws.mcpApps.callTool(chatId, card, "set_alarm", {})).result.content[0].text, "Alarm set.");
  assert.equal(calls("set_alarm"), 2);

  // Access taken away while the card shows: nothing reaches the server.
  bot.mcpOff = ["clock-id"];
  const before = calls();
  await assert.rejects(ws.mcpApps.callTool(chatId, card, "refresh_time", {}), /can't use clock any more/);
  await assert.rejects(ws.mcpApps.readResource(chatId, card, "ui://clock/view.html"), /can't use clock any more/);
  assert.equal(calls(), before);
  await assert.rejects(ws.mcpApps.callTool("nope", card, "refresh_time", {}), /can't be found/);

  // The chat is deleted: its views go with it.
  bot.mcpOff = [];
  ws.active.delete(chatId);
  await ws.agents.deleteChat(chatId);
  assert.throws(() => ws.mcpApps.page(card), /no longer kept/);
});

test("a view that can't be read leaves the text result and no card", async (t) => {
  const { turn, discovered } = setup(t, { BOTKINS_TEST_VIEW_MISSING: "1" });
  await discovered();
  const { run, tools } = await turn();
  assert.equal(await tools.clock__get_time.handler({}), "It is 12:01.");
  assert.equal(run.mcpApps, undefined);
});

test("a view's policy keeps only the https origins it declared, and the model's text never has _meta", () => {
  const csp = viewCsp({ connectDomains: ["https://api.example.com", "wss://live.example.com", "http://plain.example.com", "*", "https://a.example.com/path"], resourceDomains: ["https://*.cdn.example.com", "javascript:alert(1)"] });
  assert.deepEqual(csp.connectDomains, ["https://api.example.com", "wss://live.example.com"]);
  assert.deepEqual(csp.resourceDomains, ["https://*.cdn.example.com"]);
  assert.match(csp.header, /connect-src https:\/\/api\.example\.com wss:\/\/live\.example\.com;/);
  assert.match(csp.header, /script-src 'unsafe-inline' https:\/\/\*\.cdn\.example\.com;/);
  assert.match(csp.header, /frame-src 'none'/);
  assert.match(viewCsp(undefined).header, /connect-src 'none'/);
  assert.equal(resultText({ content: [], structuredContent: { a: 1 }, _meta: { secret: 1 } }), '{"a":1}');
  assert.equal(proxyName("my server", "x".repeat(80)).length, 64);
  assert.equal(proxyName("my server", "x".repeat(80)), proxyName("my server", "x".repeat(80)));
});

test("Composio's own connection tool, run by Botkins, shows a Connect card and keeps the sign-in page from the model", async (t) => {
  const { ws, bot, turn } = setup(t);
  ws.state.mcpServers.splice(0, 1, { id: "composio", name: "composio", type: "http", url: MCP_URL, enabled: true, oauth: {} });
  const page = "https://connect.composio.dev/link/ln_private";
  const reply = { successful: true, data: { results: { github: { toolkit: "github", status: "initiated", redirect_url: page }, gmail: { toolkit: "gmail", status: "active" } } } };
  const asked = [];
  // A stand-in for the connection to Composio, and for the computer's Composio client the card uses.
  ws.mcpApps.connect = (server) => ({
    key: serverKey(server),
    tools: async () => [{ name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: { type: "object" } }],
    call: async (name, args) => (asked.push([name, args]), { content: [{ type: "text", text: JSON.stringify(reply) }] }),
    read: async () => ({ contents: [] }),
    close: async () => {},
  });
  ws.composio = {
    catalog: async () => ({ toolkits: [{ slug: "github", name: "GitHub", logo: null, noAuth: false }] }),
    connection: async () => ({ status: null, accounts: [] }),
  };
  const { run, tools } = await turn();
  const told = await tools.composio__COMPOSIO_MANAGE_CONNECTIONS.handler({ toolkits: [{ name: "github", action: "add" }] });
  assert.deepEqual(asked.map(([name]) => name), ["COMPOSIO_MANAGE_CONNECTIONS"], "Composio is asked once");
  assert.ok(!told.includes("ln_private"), "the model never reads the page");
  const parsed = JSON.parse(told);
  assert.equal(parsed.results.github.status, "needed");
  assert.equal(parsed.results.gmail.status, "active");
  assert.equal(run.connects.length, 1);
  assert.equal(run.connects[0].toolkit, "github");
  assert.ok(!JSON.stringify(ws.state).includes("ln_private"));
  assert.ok(bot);
});
