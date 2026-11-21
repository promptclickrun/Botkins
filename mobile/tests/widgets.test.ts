// What the widgets show (src/state/widgetData.ts): each Botkin's state in the app's words, its
// newest chats, plans and limits, and one part for each paired computer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerPart, sameSnapshot, withComputer } from "../src/state/widgetData";

const NOW = 1_795_200_000_000;
const look = () => ({ head: "tinker", palette: "original", eyes: "oval" });
const live = (over: Record<string, unknown> = {}) => ({ streams: {}, thinking: {}, intents: {}, speakers: {}, queued: {}, requests: [], active: [], ...over }) as any;

function input(over: Record<string, unknown> = {}) {
  return {
    name: "Demo Mac",
    bots: [
      { id: "patch", name: "Patch", role: "Coding partner", model: { provider: "claude", model: "claude-fable-5-2" } },
      { id: "mira", name: "Mira", role: "Chief of staff", pinned: true },
      { id: "echo", name: "Echo", role: "Meeting notes", hidden: true },
    ],
    chats: [
      { id: "login", botId: "patch", title: "Fix login refresh", time: NOW - 1000, count: 4 },
      { id: "log", botId: "patch", title: "Update changelog", time: NOW - 9000, count: 2, model: { provider: "copilot", model: "gpt-5.5" } },
      { id: "week", botId: "mira", title: "Plan next week", time: NOW - 5000, count: 1 },
      { id: "routine", botId: "mira", title: "Morning brief", time: NOW, count: 1, schedules: [{ id: 1, routine: true }] },
    ],
    runs: [
      { id: "r1", chatId: "login", title: "", status: "Working", time: NOW - 134_000 },
      { id: "r2", chatId: "log", title: "", status: "Completed", time: NOW - 600_000, finished: NOW - 540_000 },
      { id: "r3", chatId: "week", title: "", status: "Working", time: NOW - 60_000 },
    ],
    live: live({ streams: { login: false, week: false }, intents: { login: "Running the tests" }, active: ["login", "week"], requests: [{ id: "q", chatId: "week", botId: "mira", kind: "question", title: "Which day works for the team review?" }] }),
    models: [{ id: "claude-fable-5-2", name: "Fable 5.2", provider: "claude" }],
    look,
    now: NOW,
    ...over,
  } as any;
}

test("each Botkin as a widget draws it: pinned first, hidden left out, its state in the app's words", () => {
  const part = computerPart(input());
  assert.deepEqual(part.bots.map((bot) => bot.id), ["mira", "patch"]);
  const [mira, patch] = part.bots;
  assert.equal(mira.state, "waiting");
  assert.equal(mira.label, "Needs you");
  assert.equal(mira.ask, "Which day works for the team review?");
  assert.deepEqual(mira.chat, { id: "week", title: "Plan next week", startedAt: (NOW - 60_000) / 1000 });
  assert.equal(patch.state, "coding");
  assert.equal(patch.label, "Coding…");
  assert.equal(patch.provider, "claude");
  assert.deepEqual(patch.chat, { id: "login", title: "Fix login refresh", startedAt: (NOW - 134_000) / 1000 });
  assert.equal(part.models["claude-fable-5-2"], "Fable 5.2");
  // An idle Botkin shows its role.
  const quiet = computerPart(input({ live: live() }));
  assert.equal(quiet.bots[1].label, "Coding partner");
  assert.equal(quiet.bots[1].chat, undefined);
});

test("a Botkin's newest chats, without routines, each with its own model and state", () => {
  const part = computerPart(input());
  assert.deepEqual(part.chats.patch, [
    { id: "login", title: "Fix login refresh", provider: "claude", state: "working", label: "Coding…", startedAt: (NOW - 134_000) / 1000 },
    { id: "log", title: "Update changelog", provider: "copilot", state: "done", label: "Done", startedAt: (NOW - 600_000) / 1000, finishedAt: (NOW - 540_000) / 1000 },
  ]);
  assert.deepEqual(part.chats.mira.map((chat) => [chat.id, chat.state, chat.label]), [["week", "needs-you", "Needs you"]]);
});

test("one part for each paired computer; usage and model names stay when a look has none", () => {
  const usage = { items: [{ provider: "claude", limits: [{ id: "weekly", label: "Weekly", percentRemaining: 7 }] }], fetchedAt: NOW - 60_000 };
  const first = withComputer(undefined, "mac", computerPart(input({ usage })), ["mac", "box"], NOW);
  assert.equal(first.inUse, "mac");
  assert.equal(first.computers.mac.usage![0].provider, "claude");
  assert.equal(first.computers.mac.usageAt, (NOW - 60_000) / 1000);
  const box = withComputer(first, "box", computerPart(input({ name: "Box", models: undefined })), ["mac", "box"], NOW + 1000);
  assert.deepEqual(Object.keys(box.computers).sort(), ["box", "mac"]);
  assert.equal(box.inUse, "box");
  const again = withComputer(box, "mac", computerPart(input({ models: [] })), ["mac"], NOW + 2000);
  assert.deepEqual(Object.keys(again.computers), ["mac"], "an unpaired computer's part is dropped");
  assert.equal(again.computers.mac.usage![0].provider, "claude", "the last usage is kept");
  assert.equal(again.computers.mac.models["claude-fable-5-2"], "Fable 5.2", "and the model names");
  assert.ok(sameSnapshot(again, { ...again, at: again.at + 50 }));
  assert.ok(!sameSnapshot(first, again));
});
