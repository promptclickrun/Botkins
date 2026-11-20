// The plain logic behind Today's panel routines, Work's chat schedules, a project's to-dos and
// access, and the wiki's folders. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot, ProjectTodo, WikiTree } from "../src/link/types";
import { cadenceFromCron, cronFromCadence, cronLabel, everyLabel, scheduleLabel } from "../src/features/work/cron";
import { ACCESS_REASON, accessVia, moveSteps, orderedTodos } from "../src/features/projects/logic";
import { canNotify, deliveryToSave, firstPlace, notifyLine, placeOf, placesFor } from "../src/features/work/delivery";
import { pagesIn, renamedFolder, suggestedLine } from "../src/features/wiki/model";

test("cron reads back into the simple cadences, and anything else stays custom", () => {
  assert.deepEqual(cadenceFromCron("0 9 * * 1-5"), { kind: "weekdays", time: "09:00" });
  assert.deepEqual(cadenceFromCron("30 8 * * *"), { kind: "daily", time: "08:30" });
  assert.deepEqual(cadenceFromCron("5 17 * * 5,1,1"), { kind: "weekly", time: "17:05", days: [1, 5] });
  assert.deepEqual(cadenceFromCron("0 */2 * * *"), { kind: "custom", cron: "0 */2 * * *" });
  assert.deepEqual(cadenceFromCron("61 9 * * *"), { kind: "custom", cron: "61 9 * * *" });
});

test("a cadence compiles to the computer's cron, and a panel routine can't run once", () => {
  assert.equal(cronFromCadence({ kind: "weekdays", time: "09:00" }), "0 9 * * 1-5");
  assert.equal(cronFromCadence({ kind: "daily", time: "07:45" }), "45 7 * * *");
  assert.equal(cronFromCadence({ kind: "weekly", time: "16:00", days: [5, 1] }), "0 16 * * 1,5");
  assert.equal(cronFromCadence({ kind: "custom", cron: "  0  */2 * * * " }), "0 */2 * * *");
  assert.throws(() => cronFromCadence({ kind: "once", date: "2026-11-20", time: "09:00" }), /repeat/);
  for (const cron of ["0 9 * * 1-5", "45 7 * * *", "0 16 * * 1,5"]) assert.equal(cronFromCadence(cadenceFromCron(cron)), cron);
});

test("schedules read as words", () => {
  assert.equal(cronLabel("0 */2 * * *"), "Custom · 0 */2 * * *");
  assert.match(cronLabel("0 9 * * 1-5"), /^Weekdays at 9:00/);
  assert.equal(everyLabel(2 * 3_600_000), "Every 2 hours");
  assert.equal(everyLabel(60_000), "Every minute");
  assert.equal(everyLabel(90_000), "Every 90 seconds");
  assert.equal(scheduleLabel({ recurring: true, intervalMs: 86_400_000 }), "Every day");
  assert.equal(scheduleLabel({ recurring: true, cron: "*/5 * * * *" }), "Cron · */5 * * * *");
  assert.match(scheduleLabel({ recurring: true, cron: "0 8 * * *" }), /^Daily at 8:00/);
  assert.equal(scheduleLabel({ recurring: false }), "Once");
});

const todo = (id: string, done = false): ProjectTodo => ({ id, text: id, done, createdAt: 0, ...(done && { doneAt: 1 }) });

test("a to-do moves past the next open one, skipping done ones", () => {
  const todos = [todo("a"), todo("x", true), todo("b"), todo("c")];
  assert.equal(moveSteps(todos, "a", -1), 0);
  assert.equal(moveSteps(todos, "a", 1), 2);
  assert.equal(moveSteps(todos, "b", -1), 2);
  assert.equal(moveSteps(todos, "b", 1), 1);
  assert.equal(moveSteps(todos, "c", 1), 0);
  assert.equal(moveSteps([todo("a"), todo("x", true)], "a", 1), 0);
  assert.equal(moveSteps(todos, "gone", 1), 0);
  assert.deepEqual(orderedTodos(todos).open.map((item) => item.id), ["a", "b", "c"]);
});

test("how a bot came to use a project", () => {
  const bot = (access?: Bot["access"]): Bot => ({ id: "b", name: "B", role: "", instructions: "", face: "idle", ...(access && { access }) });
  const project = { id: "p1" };
  assert.equal(accessVia(undefined, bot(), project), "everyone");
  assert.equal(accessVia({ access: { allBots: true } }, bot(), project), "everyone");
  const off = { access: { allBots: false } };
  assert.equal(accessVia(off, bot({ all: true, projects: [] }), project), "all");
  assert.equal(accessVia(off, bot({ all: false, projects: ["p1"] }), project), "project");
  assert.equal(accessVia(off, bot(), project), "");
  assert.equal(ACCESS_REASON[""], "No access");
});

test("a wiki folder renames beside itself, and the suggested projects read as one line", () => {
  assert.equal(renamedFolder("projects", "Client work"), "client-work");
  assert.equal(renamedFolder("projects/archive", "Old stuff"), "projects/old-stuff");
  assert.equal(renamedFolder("projects", "!!"), "");
  const page = (path: string, template?: boolean) => ({ path, title: path, summary: "", updatedAt: 0, links: [], backlinks: [], missing: [], ...(template && { template }) });
  const tree: WikiTree = {
    folders: ["projects"],
    pages: [page("WIKI.md"), page("projects/_template.md", true), page("projects/a.md"), page("projects/archive/b.md"), page("people/c.md")],
    guide: "WIKI.md",
    revision: 1,
    suggested: { projects: ["One", "Two", "Three", "Four", "Five"].map((name) => ({ id: name, name })) },
  };
  assert.deepEqual(pagesIn(tree, "projects").map((item) => item.path), ["projects/a.md", "projects/archive/b.md"]);
  assert.equal(suggestedLine(tree), "One, Two, Three and 2 more");
  assert.equal(suggestedLine({ ...tree, suggested: { projects: [{ id: "a", name: "Website" }] } }), "Website");
  assert.equal(suggestedLine({ ...tree, suggested: undefined as unknown as WikiTree["suggested"] }), "");
});

// ---- where a routine's result goes (src/features/work/delivery.ts)

test("a routine's destination: No output only where the computer takes it, and never lost by editing", () => {
  const old = ["routine-delivery-v1"];
  const now = ["routine-delivery-v1", "routine-no-output-v1"];
  // The choices, in the computer's order.
  assert.deepEqual(placesFor(now).map((place) => place.value), ["none", "routine", "chat", "feed", "idea", "goal"]);
  assert.deepEqual(placesFor(old).map((place) => place.value), ["routine", "chat", "feed", "idea", "goal"]);
  assert.deepEqual(placesFor(undefined).map((place) => place.value), ["routine", "chat", "feed", "idea", "goal"]);
  // A routine that already has it keeps it in the list, whatever the computer says now.
  assert.equal(placesFor(old, "none")[0]!.value, "none");
  assert.equal(placeOf("none").label, "No output");

  // A new routine starts on No output where it can, as on the computer; an existing one keeps what it has.
  assert.equal(firstPlace(undefined, true, now), "none");
  assert.equal(firstPlace(undefined, true, old), "routine");
  assert.equal(firstPlace(undefined, false, now), "routine", "nothing said on an existing routine means its own chat");
  assert.equal(firstPlace({ to: "none" }, false, now), "none");
  assert.equal(firstPlace({ to: "none" }, false, old), "none");
  assert.equal(firstPlace({ to: "feed" }, false, now), "feed");
  assert.equal(firstPlace({ to: "somewhere" as never }, false, now), "routine");

  // What is saved: the value as it is, and a chat picked on the computer stays with "chat" only.
  assert.deepEqual(deliveryToSave("none", { to: "none" }), { to: "none" });
  assert.deepEqual(deliveryToSave("none", { to: "chat", chatId: "c1" }), { to: "none" });
  assert.deepEqual(deliveryToSave("chat", { to: "chat", chatId: "c1" }), { to: "chat", chatId: "c1" });
  assert.deepEqual(deliveryToSave("chat", { to: "feed" }), { to: "chat" });

  // No output never notifies.
  assert.equal(canNotify("none"), false);
  assert.equal(canNotify("routine"), true);
  assert.equal(notifyLine("none", true), "No-output routines never publish or notify");
  assert.equal(notifyLine("chat", true), "When a run finishes");
  assert.equal(notifyLine("chat", false), "This routine is quiet");
});
