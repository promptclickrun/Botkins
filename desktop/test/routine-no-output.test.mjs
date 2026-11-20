import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { decide } from "../desktop/notify.mjs";

const T0 = Date.UTC(2026, 10, 17, 12);
const DAILY = { kind: "daily", time: "09:00" };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-routine-no-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = { reply: "This work is complete.", handlers: new Set() };
  const session = {
    on: (handler) => (script.handlers.add(handler), () => script.handlers.delete(handler)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      const id = "message:" + prompt;
      for (const handler of script.handlers) handler({ type: "user.message", id, data: { messageId: id } });
      if (script.reply) for (const handler of script.handlers) handler({ type: "assistant.message", data: { originatingMessageId: id, content: script.reply } });
      for (const handler of script.handlers) handler({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session, deleteSession: async () => {} });
  return { ws: new Workspace(dir, client, () => {}, () => ({ kind: "reject" })), script };
}

test("a no-output routine completes on idle without publishing or notifying its reply", async (t) => {
  const { ws, script } = setup(t);
  const routine = ws.panels.routines.create({
    botId: "pip",
    name: "Background check",
    prompt: "Check the inbox and do the work.",
    cadence: DAILY,
    deliver: { to: "none" },
  }, T0);
  const spare = ws.createChat("pip");

  await ws.panels.routines.run(routine);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Completed");
  assert.equal(run.noOutput, true, "the run history records that no output was published");
  assert.equal(ws.chat(routine).messages.filter((message) => message.role === "assistant").length, 0);
  assert.equal(ws.chat(spare).messages.length, 0);
  assert.equal(ws.board.items.length, 0);
  assert.equal(decide({ type: "turn", bot: ws.bot("pip"), chat: ws.chat(routine), run }, { settings: ws.state.settings, focused: false }), null);

  script.reply = "";
  const idleOnly = ws.panels.routines.create({ botId: "pip", name: "Idle check", prompt: "Do the check.", cadence: DAILY, deliver: { to: "none" } }, T0);
  await ws.panels.routines.run(idleOnly);
  assert.equal(ws.state.runs[0].status, "Completed", "provider idle with no text is still success");
  assert.equal(ws.chat(idleOnly).messages.filter((message) => message.role === "assistant").length, 0);

  const ordinary = ws.createChat("pip");
  await ws.send(ordinary, "Say something.");
  await ws.active.get(ordinary)?.done;
  assert.equal(ws.state.runs[0].status, "Needs you", "empty interactive turns retain reply validation");
});
