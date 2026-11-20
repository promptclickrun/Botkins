// Tools a bot runs on a paired phone (desktop/phonetools.mjs), and a Today item carried by a
// message (desktop/mentions.mjs). The phone link is a stand-in: nothing here pairs a phone, opens
// a socket or reads anyone's calendar.
import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { PhoneTools, listedPhoneTools } from "../desktop/phonetools.mjs";
import { BOARD_MENTIONS } from "../desktop/mentions.mjs";

const object = (properties = {}) => ({ type: "object", properties, additionalProperties: false });
const LIST = [
  { name: "phone_calendar_events", description: "Reads events.", parameters: object({ from: { type: "string" } }), readOnly: true, source: "calendar" },
  { name: "phone_calendar_create", description: "Adds an event.", parameters: object({ title: { type: "string" } }), readOnly: false, source: "calendar" },
];

/** A workspace with a stand-in phone link that records what it was asked. */
function rig(t, { list = LIST, answer = async () => ({ ok: true }) } = {}) {
  const calls = [];
  const link = { tools: () => list, call: (name, args, options) => (calls.push({ name, args, options }), answer(name, args, options)) };
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { phoneTools: () => link });
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stopped: false };
  ws.active.set(chat.id, task);
  const tools = (view = chat, run = { id: "r" }) => Object.fromEntries(ws.phone.tools(ws.bot("pip"), view, run, task).map((tool) => [tool.name, tool]));
  return { ws, chat, task, tools, calls };
}

test("only well-formed phone tools are taken from the link's list, each once", () => {
  const good = LIST[0];
  const kept = listedPhoneTools([
    good,
    { ...good },
    { ...good, name: "calendar_events" },
    { ...good, name: "phone_Calendar" },
    { ...good, name: "phone_" + "a".repeat(45) },
    { ...good, name: "phone_x", description: " " },
    { ...good, name: "phone_y", parameters: "object" },
    { ...good, name: "phone_z", parameters: { type: "string" } },
    null,
    "phone_events",
  ]);
  assert.deepEqual(kept, [good]);
  assert.deepEqual(listedPhoneTools(undefined), []);
  assert.deepEqual(listedPhoneTools({}), []);
});

test("a tool that only looks runs without asking, and one that changes something asks first", (t) => {
  const { tools } = rig(t);
  const all = tools();
  assert.deepEqual(Object.keys(all), ["phone_calendar_events", "phone_calendar_create"]);
  assert.equal(all.phone_calendar_events.skipPermission, true, "switching the source to Read on the phone was the consent");
  assert.equal(all.phone_calendar_create.skipPermission, false, "adding or changing goes through the chat's approval");
  assert.equal(all.phone_calendar_events.description, "Reads events.");
  assert.deepEqual(all.phone_calendar_events.parameters, LIST[0].parameters);
});

test("a tool is only skipped past approval when the link itself says it only looks", (t) => {
  const { tools } = rig(t, { list: [{ ...LIST[0], readOnly: "yes" }, { ...LIST[1], name: "phone_calendar_update", readOnly: undefined }] });
  for (const tool of Object.values(tools())) assert.equal(tool.skipPermission, false, tool.name);
});

test("a turn nobody is watching gets only the tools that look", (t) => {
  const { tools, chat } = rig(t);
  for (const run of [{ id: "r", scheduleId: "s" }, { id: "r", panelId: "p" }, { id: "r", taskId: "k" }]) assert.deepEqual(Object.keys(tools(chat, run)), ["phone_calendar_events"], JSON.stringify(run));
  assert.deepEqual(Object.keys(tools({ ...chat, helper: true })), ["phone_calendar_events"], "a teammate's help");
});

test("a call goes to the phone with the bot and the chat, and its answer comes back as text", async (t) => {
  const { tools, calls, chat } = rig(t, { answer: async (name) => (name === "phone_calendar_events" ? { events: [{ title: "Dentist" }] } : "done") });
  assert.equal(await tools().phone_calendar_events.handler({ from: "2026-01-01" }), JSON.stringify({ events: [{ title: "Dentist" }] }));
  assert.equal(await tools().phone_calendar_create.handler(undefined), "done", "text is passed on as it is");
  assert.deepEqual(calls.map((call) => [call.name, call.args, call.options.botId, call.options.chatId]), [
    ["phone_calendar_events", { from: "2026-01-01" }, "pip", chat.id],
    ["phone_calendar_create", {}, "pip", chat.id],
  ]);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("the phone's own words for a refusal reach the bot", async (t) => {
  const { tools } = rig(t, { answer: async () => Promise.reject(new Error("The phone didn't answer. It may be off.")) });
  await assert.rejects(tools().phone_calendar_events.handler({}), /The phone didn't answer/);
});

test("stopping the turn stops a call that is waiting on the phone", async (t) => {
  let seen;
  const { tools, task } = rig(t, {
    answer: (_name, _args, { signal }) => new Promise((_, reject) => ((seen = signal), signal.addEventListener("abort", () => reject(new Error("Stopped.")), { once: true }))),
  });
  const waiting = tools().phone_calendar_events.handler({});
  task.stopped = true;
  await assert.rejects(waiting, /Stopped/);
  assert.equal(seen.aborted, true);
  await assert.rejects(tools().phone_calendar_events.handler({}), /no longer active/, "and a turn that is over runs nothing");
});

test("no link, a link that is locked and a link without tools all give no tools", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, {});
  const chat = ws.chat(ws.createChat("pip"));
  assert.deepEqual(ws.phone.tools(ws.bot("pip"), chat, { id: "r" }, {}), []);
  const failing = new PhoneTools(ws, () => ({ tools: () => { throw new Error("locked"); } }));
  assert.deepEqual(failing.tools(ws.bot("pip"), chat, { id: "r" }, {}), []);
  assert.deepEqual(failing.summary(), { tools: 0, readOnly: 0 });
  assert.deepEqual(new PhoneTools(ws, () => null).listed(), []);
});

test("the phone's tools are among a turn's tools, and not a helping teammate's that change things", (t) => {
  const { ws, chat, task } = rig(t);
  const names = (view) => ws.sessionTools(ws.bot("pip"), view, { id: "r" }, task).map((tool) => tool.name);
  assert.ok(names(chat).includes("phone_calendar_events") && names(chat).includes("phone_calendar_create"));
  assert.ok(!names({ ...chat, helper: true }).some((name) => name.startsWith("phone_")), "a helper reads records and keeps its memory, nothing else");
});

// ---- A Today item carried by a message ----

test("a message can carry a Today item: the chat keeps a card for it and the bot reads it", (t) => {
  const { ws, chat } = rig(t);
  assert.equal(BOARD_MENTIONS, "board-mentions-v1");
  const { id } = ws.board.post("pip", { kind: "idea", title: "Try a standing desk", body: "Two hours a day to start.\nSee how the back feels.", links: [{ url: "https://example.com/desks", title: "Desks" }] });
  const out = ws.mentions.resolve(chat, [{ kind: "board", id }, { kind: "board", id }]);
  assert.deepEqual(out.list, [{ kind: "board", id, label: "Try a standing desk", board: "idea", body: "Two hours a day to start.\nSee how the back feels.", links: [{ url: "https://example.com/desks", title: "Desks" }] }]);
  assert.match(out.context, /\[Records the person mentioned\]\n#Try a standing desk is an item from the person's Today page \(Ideas\), posted by Pip\./);
  assert.match(out.context, /Two hours a day to start\./);
  assert.match(out.context, /Links: Desks https:\/\/example\.com\/desks/);
  assert.ok(out.context.includes("Its id is " + id), "so the bot can change the item with its board tools");
  assert.deepEqual(out.files, []);
});

test("a goal says its category, a bare item has no body or links, and one that is gone is refused", (t) => {
  const { ws, chat } = rig(t);
  const goal = ws.board.post("pip", { kind: "goal", title: "Run 5 km", category: "health" }).id;
  const out = ws.mentions.resolve(chat, [{ kind: "board", id: goal }]);
  assert.deepEqual(out.list, [{ kind: "board", id: goal, label: "Run 5 km", board: "goal" }]);
  assert.match(out.context, /\(Goals, health\)/);
  assert.ok(!/Links:/.test(out.context));
  assert.throws(() => ws.mentions.resolve(chat, [{ kind: "board", id: "nope" }]), /Today item no longer exists/);
  assert.throws(() => ws.mentions.resolve(chat, [{ kind: "board" }]), /Today item no longer exists/);
});

test("a Today item's card survives the item being cleared, since the message keeps its text", async (t) => {
  const { ws, chat } = rig(t);
  const { id } = ws.board.post("pip", { kind: "feed", title: "Rain at four", body: "Take an umbrella." });
  const kept = ws.mentions.resolve(chat, [{ kind: "board", id }]).list[0];
  ws.board.act(id, "delete");
  assert.deepEqual([kept.label, kept.body, kept.board], ["Rain at four", "Take an umbrella.", "feed"]);
});
