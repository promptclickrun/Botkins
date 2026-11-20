import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Apps } from "../desktop/apps.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-apps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  return { ws, apps: new Apps(ws), bot: ws.state.bots[0].id, other: ws.state.bots[1].id };
}
const page = "<!doctype html><h1>Hi</h1>";

test("apps store their page and data and validate input", (t) => {
  const { ws, apps, bot } = setup(t);
  const app = apps.create(bot, "c1", "r1", { title: "Tip calculator", description: "Splits a bill", html: page, data: { total: 42 } });
  assert.equal(apps.page(app.id), page);
  assert.deepEqual(apps.data(app.id), { total: 42 });
  assert.equal(apps.create(bot, "c1", "r1", { title: "No data", description: "d", html: page }).sendsAnswers, false);
  assert.equal(apps.data(ws.state.apps[1].id), null);
  assert.throws(() => apps.create(bot, "c1", "r1", { title: "x", description: "d", html: " " }), /Provide the app's HTML/);
  assert.throws(() => apps.create(bot, "c1", "r1", { title: "x", description: "d", html: "x".repeat(600_001) }), /600,000/);
  assert.throws(() => apps.create(bot, "c1", "r1", { title: "", description: "d", html: page }), /Invalid app title/);
  assert.throws(() => apps.page("../../etc"), /no longer exists/);
  assert.throws(() => apps.folder("../x"), /Invalid app/);
});

test("only the owning bot updates an app, and open windows hear about it", (t) => {
  const { apps, bot, other } = setup(t);
  const app = apps.create(bot, "c1", "r1", { title: "Chart", description: "Live chart", html: page });
  const heard = [];
  apps.onChange = (a, changed) => heard.push([a.id, changed]);
  apps.update(bot, app.id, { data: [1, 2, 3] });
  assert.deepEqual(apps.data(app.id), [1, 2, 3]);
  assert.deepEqual(heard, [[app.id, { html: false, data: true }]]);
  assert.throws(() => apps.update(other, app.id, { data: [] }), /your own apps/);
  apps.update(bot, app.id, { html: "<p>v2</p>", title: "Chart v2" });
  assert.equal(apps.page(app.id), "<p>v2</p>");
  assert.equal(app.title, "Chart v2");
});

test("show_app adds a card to the turn and caps apps per reply; chat cleanup removes files", async (t) => {
  const { ws, apps, bot } = setup(t);
  const chatId = ws.createChat(bot);
  const task = { stopped: false };
  ws.active.set(chatId, task);
  const run = { id: "r" };
  const tools = Object.fromEntries(apps.tools(ws.bot(bot), ws.chat(chatId), run, task).map((x) => [x.name, x]));
  for (let i = 0; i < 4; i++) await tools.show_app.handler({ title: "App " + i, description: "d", html: page, sends_answers: true });
  assert.equal(run.apps.length, 4);
  await assert.rejects(async () => tools.show_app.handler({ title: "Fifth", description: "d", html: page }), /at most four/);
  assert.equal(run.apps[0].title, "App 0");
  const folder = apps.folder(run.apps[0].id);
  assert.ok(existsSync(folder));
  apps.removeChats([chatId]);
  assert.equal(ws.state.apps.length, 0);
  assert.ok(!existsSync(folder));
});
