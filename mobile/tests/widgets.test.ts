// What the widgets show (src/state/widgetData.ts): each Botkin's state in the app's words, its
// newest chats, plans and limits, and one part for each paired computer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerPart, PANEL_WIDGET, panelHeadline, panelParts, sameSnapshot, withComputer } from "../src/state/widgetData";

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

test("a panel's widget says the one thing the panel says: its number and a line, never something made up", () => {
  const headline = (blocks: unknown[], last?: unknown) => panelHeadline({ blocks, last } as any);
  // A metric: its value, and its note (else its label).
  assert.deepEqual(headline([{ type: "markdown", text: "## Signups" }, { type: "metric", label: "This week", value: "1,284", note: "+12% on last week" }]), { value: "1,284", note: "+12% on last week" });
  assert.deepEqual(headline([{ type: "metric", label: "This week", value: "1,284" }]), { value: "1,284", note: "This week" });
  // A progress, when there is no metric.
  assert.deepEqual(headline([{ type: "progress", label: "Words", value: 3420, max: 5000 }]), { value: "3,420 of 5,000", note: "Words" });
  // Otherwise what its first block says: the top bar, a line's newest value, a list's first item, a row, badges, a line of text.
  assert.deepEqual(headline([{ type: "bars", label: "Deals by stage", items: [{ label: "Lead", value: 14 }, { label: "Won", value: 3 }] }]), { value: "14", note: "Lead" });
  assert.deepEqual(headline([{ type: "line", label: "Daily", labels: ["Mon", "Tue"], series: [{ name: "Signups", values: [180, 210.456] }] }]), { value: "210.46", note: "Daily" });
  assert.deepEqual(headline([{ type: "list", items: ["- **Press kit** is ready", "Changelog"] }]), { note: "Press kit is ready" });
  assert.deepEqual(headline([{ type: "table", columns: ["Plan", "Price"], rows: [["Team", "$19"], ["Solo", "$9"]] }]), { note: "Team · $19" });
  assert.deepEqual(headline([{ type: "badges", items: [{ label: "2 at risk", tone: "warning" }, { label: "On pace", tone: "positive" }] }]), { note: "2 at risk · On pace" });
  assert.deepEqual(headline([{ type: "markdown", text: "\n# Launch week\nMore." }]), { note: "Launch week" });
  // An app panel says what a person last did in it; one nobody touched says nothing.
  assert.deepEqual(headline([{ type: "html", frame: "f", height: 200 }], { by: "m1", name: "Maya Chen", label: "Ticked Press kit", at: 1 }), { note: "Maya ticked Press kit" });
  assert.deepEqual(headline([{ type: "html", frame: "f", height: 200 }]), {});
  assert.deepEqual(headline([]), {});
  // Long text is cut for a widget.
  assert.equal(headline([{ type: "markdown", text: "x".repeat(300) }]).note!.length, PANEL_WIDGET.note);
});

test("the panels a widget can show: pinned spaces first, a space not read again keeps what it had, a space that is gone takes its panels", () => {
  const space = (id: string, pinned: boolean, more: Record<string, unknown> = {}) => ({ id, name: id, mine: true, by: { id: "owner", name: "Alex" }, pinned, ...more });
  const panel = (id: string, more: Record<string, unknown> = {}) => ({ id, title: "Panel " + id, botId: "mira", updatedAt: NOW - 60_000, hidden: false, blocks: [{ type: "metric", label: "L", value: id.toUpperCase() }], ...more });
  const title = (one: { name: string }) => "Space " + one.name;
  const bots = [{ id: "mira", name: "Mira", role: "Chief of staff" }];
  const spaces = [space("more", false), space("today", true), space("launch", true)];
  const first = panelParts(spaces, { today: [panel("a"), panel("b", { hidden: true })], more: [panel("c", { botId: "gone" })] }, bots, look, title);
  // Pinned first, hidden left out, the bot's Botkin (a made-up one when the bot is not known), times in seconds.
  assert.deepEqual(first.map((one) => [one.id, one.spaceId, one.space, one.title, one.value, one.head]), [["a", "today", "Space today", "Panel a", "A", "tinker"], ["c", "more", "Space more", "Panel c", "C", "beacon"]]);
  assert.equal(first[0].at, Math.floor((NOW - 60_000) / 1000));
  // After a restart the phone has read only Launch: Today and More keep the panels the widgets had.
  const next = panelParts(spaces, { launch: [panel("d")] }, bots, look, title, first);
  assert.deepEqual(next.map((one) => one.id), ["a", "d", "c"]);
  // A space read again shows what it holds now, and a space that is gone takes its panels with it.
  const later = panelParts([space("today", true)], { today: [panel("b")] }, bots, look, title, next);
  assert.deepEqual(later.map((one) => one.id), ["b"]);
  // At most so many panels.
  const many = panelParts([space("today", true)], { today: Array.from({ length: 40 }, (_, i) => panel("p" + i)) }, bots, look, title);
  assert.equal(many.length, PANEL_WIDGET.panels);
  // They are part of a computer's part of the snapshot, and nothing is there for a computer without spaces.
  assert.deepEqual(computerPart({ ...input(), panels: first }).panels, first);
  assert.equal("panels" in computerPart(input()), false);
  assert.equal("panels" in computerPart({ ...input(), panels: [] }), false);
});
