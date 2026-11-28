import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./starter.mjs";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";
import { nextTime } from "../desktop/panels.mjs";

function setup(
  t,
  client = async () => {
    throw new Error("Offline");
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-panels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () =>
    new Workspace(
      dir,
      client,
      () => {},
      () => ({ kind: "reject" }),
    );
  return { dir, open, ws: open() };
}
const content = {
  key: "signals",
  title: "Signals",
  blocks: [{ type: "metric", label: "Open", value: "3" }],
};
test("panel identity belongs to its bot and stale writes and late refreshes cannot replace it", (t) => {
  const { ws } = setup(t);
  const chat = ws.createChat("pip");
  ws.panels.write("pip", chat, content, { id: "first" });
  const p = ws.panels.all[0];
  ws.panels.write("scout", ws.createChat("scout"), content, { id: "second" });
  assert.equal(ws.panels.all.length, 2);
  assert.throws(() => ws.panels.write("pip", chat, content, {}), /revision/);
  const update = { ...content, revision: p.revision, title: "New signals" };
  ws.panels.write("pip", chat, update, { panelId: p.id, id: "third" });
  assert.equal(p.title, "New signals");
  assert.throws(() => ws.panels.write("pip", chat, update, {}), /revision/);
  assert.throws(
    () =>
      ws.panels.write(
        "pip",
        chat,
        { ...content, key: "different" },
        { panelId: p.id },
      ),
    /assigned/,
  );
  ws.panels.change(p.id, "delete");
  assert.throws(
    () => ws.panels.write("pip", chat, content, { panelId: p.id }),
    /assigned/,
  );
  assert.equal(ws.panels.all[0].botId, "scout");
});
test("a missed cron occurrence is coalesced once, including after a restart; paused routines never tick", async (t) => {
  const { ws, open } = setup(t);
  ws.panels.write("pip", ws.createChat("pip"), content, {});
  const p = ws.panels.all[0],
    opts = {
      action: "set",
      cron: "0 9 * * 1-5",
      timezone: "America/Chicago",
      prompt: "Refresh the count.",
    };
  ws.panels.routine(p.id, opts);
  const before = Date.parse("2026-03-06T15:00:00Z");
  assert.equal(
    nextTime(opts.cron, opts.timezone, before),
    Date.parse("2026-03-09T14:00:00Z"),
  );
  assert.throws(() => ws.panels.routine(p.id, { ...opts, cron: "bad" }));
  assert.equal(p.routine.cron, opts.cron);
  p.routine.nextAt = before;
  ws.save();
  const w = open(),
    now = Date.parse("2026-03-11T18:00:00Z");
  await Promise.all([w.panels.tick(now), w.panels.tick(now)]);
  await w.panels.tick(now);
  assert.equal(w.state.runs.length, 1);
  assert.equal(w.state.runs[0].status, "Needs you");
  assert.equal(w.panels.get(p.id).lastCheck.status, "Needs you");
  assert.equal(
    w.panels.get(p.id).routine.nextAt,
    Date.parse("2026-03-12T14:00:00Z"),
  );
  w.panels.routine(p.id, { action: "pause" });
  const reopened = open();
  await reopened.panels.tick(Date.now() + 365 * 86400000);
  assert.equal(reopened.state.runs.length, 1);
  w.panels.change(p.id, "hide");
  assert.equal(w.panels.get(p.id).hidden, true);
  w.panels.routine(p.id, { action: "resume" });
  assert.ok(w.panels.get(p.id).routine.nextAt > Date.now());
});
test("Botkins 0.1 data is retained on migration and cache clearing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-panels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () =>
    new RealWorkspace(
      dir,
      async () => {
        throw new Error("Offline");
      },
      () => {},
    );
  const old = {
    bots: [
      {
        id: "test",
        name: "Saved bot",
        role: "Editor",
        instructions: "Edit",
        face: "idle",
      },
    ],
    chats: [
      {
        id: "saved",
        botId: "test",
        title: "Earlier chat",
        time: 1,
        messages: [{ role: "user", text: "Original text" }],
        established: true,
      },
    ],
    runs: [],
  };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(old));
  const ws = open();
  assert.equal(ws.bot("test").name, "Saved bot");
  assert.equal(ws.bot("test").sources, undefined, "bots no longer carry their own sources");
  assert.deepEqual(ws.state.mcpServers, []);
  assert.deepEqual(ws.state.skills, { folders: [], plugins: [], disabled: [] });
  assert.deepEqual(ws.state.panels, []);
  ws.clearCatalogs();
  const saved = open().state.chats.filter(c => !c.main);
  assert.equal(saved.length, 1);
  const { sessions, ...rest } = saved[0];
  assert.deepEqual(rest, old.chats[0]);
  assert.deepEqual(sessions, { copilot: { through: 1 } });
});
