// Pi's plan: the update_plan tool Botkins gives Pi (desktop/providers/pi/plan.mjs). Pi has no plan of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_ID, PiProvider } from "../desktop/providers/pi/index.mjs";
import { PLAN_INSTRUCTIONS, PLAN_LIMIT, checkedPlan } from "../desktop/providers/pi/plan.mjs";
import { mapTodos } from "../desktop/canvas.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-pi-plan-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const spec = (more = {}) => ({
  sessionId: "chat-1", established: false, hasReplies: false, folder: dir,
  model: { model: "opus", source: "botkins-claude" }, inference: { providers: [] },
  instructions: "You are Testy.", context: "", tools: [], skills: { directories: [], disabled: [] }, mcpServers: {},
  history: () => [], handlers: { permission: async () => ({ allow: true }) }, ...more,
});
const piSession = async (more, options = {}) => new PiProvider({ dataDir: join(dir, "pi"), binary: join(dir, "none"), ...options }).openSession(spec(more));
const tool = (session) => session.planTools().find((each) => each.name === "update_plan");

test("update_plan keeps the plan on the session, tells the apps the task list changed, and todos() reads it", async () => {
  const session = await piSession();
  const events = [];
  session.on((event) => events.push(event.type));
  assert.equal(await session.todos(), null, "no plan until the model makes one");
  const update = tool(session);
  assert.equal(update.skipPermission, true, "Botkins' own tool never asks");
  const said = await update.handler({
    explanation: "Starting",
    steps: [{ id: "a", text: "Read the code", status: "completed" }, { id: "b", text: "Write the fix", status: "in_progress" }, { id: "c", text: "Run the tests", status: "pending" }],
  });
  assert.equal(said, "Plan saved: 3 steps, 2 open.");
  assert.deepEqual(events, ["session.todos_changed"]);
  // The workspace turns it into the chat's task list the way it does for every harness.
  assert.deepEqual(mapTodos(await session.todos()), [
    { id: "a", title: "Read the code", status: "done" },
    { id: "b", title: "Write the fix", status: "in_progress" },
    { id: "c", title: "Run the tests", status: "pending" },
  ]);
  // The whole list is sent each time: the new one replaces the old.
  await update.handler({ steps: [{ id: "a", text: "Read the code", status: "completed" }] });
  assert.equal(mapTodos(await session.todos()).length, 1);
  assert.equal(await update.handler({ steps: [] }), "Plan cleared.");
  assert.deepEqual(mapTodos(await session.todos()), []);
});

test("a plan is checked: up to 100 steps, each with a distinct id, text and a known status", async () => {
  const step = (more = {}) => ({ id: "a", text: "Do it", status: "pending", ...more });
  assert.throws(() => checkedPlan({}), /list of/);
  assert.throws(() => checkedPlan({ steps: [step({ id: "" })] }), /needs an id/);
  assert.throws(() => checkedPlan({ steps: [step(), step()] }), /used twice/);
  assert.throws(() => checkedPlan({ steps: [step({ text: "  " })] }), /needs text/);
  assert.throws(() => checkedPlan({ steps: [step({ status: "done" })] }), /pending, in_progress or completed/);
  const many = Array.from({ length: PLAN_LIMIT }, (_, i) => step({ id: "s" + i }));
  assert.equal(checkedPlan({ steps: many }).length, PLAN_LIMIT);
  assert.throws(() => checkedPlan({ steps: [...many, step({ id: "extra" })] }), /up to 100/);
  assert.equal(checkedPlan({ steps: [step({ id: 7, text: "a\n  b" })] })[0].title, "a b");
  assert.equal(checkedPlan({ steps: [step({ text: "x".repeat(900) })] })[0].title.length, 300);
  // The tool refuses a bad plan with the same words, and keeps the plan it had.
  const session = await piSession();
  await assert.rejects(() => tool(session).handler({ steps: [step({ status: "weird" })] }), /Step a has status/);
  assert.equal(await session.todos(), null);
});

test("only Pi gets the tool, not OMP (which has its own), a throwaway session or a sources-only one", async () => {
  assert.equal((await piSession()).planTools().length, 1);
  assert.equal((await piSession({}, { runtime: OMP_ID })).planTools().length, 0);
  assert.equal((await piSession({ temporary: true })).planTools().length, 0);
  assert.equal((await piSession({ sourcesOnly: true })).planTools().length, 0);
  assert.equal((await piSession({ handlers: null })).planTools().length, 0);
});

test("Pi is told to keep a plan for multi-step work, once the tool can be reached", async () => {
  const session = await piSession();
  assert.equal((await session.describe()).prompt, "You are Testy.", "no bridge, no tool, no instruction");
  session.bridge = { url: "http://127.0.0.1:1/mcp/x", headers: {} };
  const { prompt } = await session.describe();
  assert.ok(prompt.startsWith("You are Testy.\n\n" + PLAN_INSTRUCTIONS));
  assert.match(PLAN_INSTRUCTIONS, /update_plan/);
  const omp = await piSession({}, { runtime: OMP_ID });
  omp.bridge = session.bridge;
  assert.equal((await omp.describe()).prompt, "You are Testy.");
});
