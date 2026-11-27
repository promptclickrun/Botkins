// The phone's workflow designer edits graphs the computer must accept, and draws them one column or on a canvas.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateWorkflow } from "../../desktop/desktop/workflow-fields.mjs";
import { analyzeWorkflowFields } from "../src/features/workflows/fields";
import {
  addTrigger,
  bounds,
  canRemove,
  flowFrom,
  type FlowItem,
  type Graph,
  insertStep,
  needsTidy,
  newStep,
  newTrigger,
  NODE_H,
  NODE_W,
  removeStep,
  starter,
  summary,
  tidy,
} from "../src/features/workflows/graph";

const valid = (g: Graph) => {
  const check = validateWorkflow({ name: "t", ...g });
  assert.deepEqual(check.errors, []);
};
const outOf = (g: Graph, id: string) => g.edges.filter((e) => e.from === id).map((e) => `${e.branch}->${e.to}`).sort();
const steps = (items: FlowItem[]) => items.map((i) => (i.type === "step" ? i.node.id : i.type === "lanes" ? `[${i.lanes.map((l) => l.branch + ":" + steps(l.items).join(",")).join(" | ")}]` : i.type === "jump" ? "→" + i.to.id : "+"));

test("the starter workflow is one the computer accepts and lays out", () => {
  const g = starter();
  valid(g);
  assert.equal(needsTidy(g), false);
  assert.deepEqual(steps(flowFrom(g, "trigger_1", "default")), ["output_1", "+"]);
});

test("a step put between two others takes over the old way out", () => {
  let g = starter();
  g = insertStep(g, "trigger_1", "default", newStep("agent", "a"));
  valid(g);
  assert.deepEqual(outOf(g, "trigger_1"), ["default->a"]);
  assert.deepEqual(outOf(g, "a"), ["default->output_1"]);
});

test("a condition put in the middle sends what followed down its Yes lane", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("condition", "c"));
  valid(g);
  assert.deepEqual(outOf(g, "c"), ["yes->output_1"]);
  g = insertStep(g, "c", "no", newStep("output", "o2"));
  valid(g);
  assert.deepEqual(steps(flowFrom(g, "trigger_1", "default")), ["c", "[yes:output_1,+ | no:o2,+]"]);
});

test("an approval branches approved and rejected", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("approval", "ap"));
  g = insertStep(g, "ap", "rejected", newStep("output", "r"));
  valid(g);
  assert.deepEqual(outOf(g, "ap"), ["approved->output_1", "rejected->r"]);
});

test("taking a step out joins what was before it to what was after", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("agent", "a"));
  g = insertStep(g, "a", "default", newStep("model", "m"));
  g = removeStep(g, "a");
  valid(g);
  assert.deepEqual(outOf(g, "trigger_1"), ["default->m"]);
  assert.deepEqual(outOf(g, "m"), ["default->output_1"]);
});

test("taking a condition out keeps its Yes lane and drops the No lane's link", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("condition", "c"));
  g = insertStep(g, "c", "no", newStep("output", "o2"));
  g = removeStep(g, "c");
  valid(g);
  assert.deepEqual(outOf(g, "trigger_1"), ["default->output_1"]);
  assert.ok(g.nodes.some((n) => n.id === "o2"), "the No step stays, unlinked, for the person to wire or remove");
});

test("the last trigger can't be removed, a second one can", () => {
  let g = starter();
  assert.equal(canRemove(g, "trigger_1"), false);
  assert.equal(removeStep(g, "trigger_1").nodes.length, 2);
  g = addTrigger(g, newTrigger("schedule", "t2"));
  valid(g);
  assert.deepEqual(outOf(g, "t2"), ["default->output_1"]);
  assert.equal(canRemove(g, "trigger_1"), true);
  g = removeStep(g, "trigger_1");
  valid(g);
});

test("a step put after the start goes after every trigger that shares it", () => {
  let g = addTrigger(starter(), newTrigger("schedule", "t2"));
  g = insertStep(g, "trigger_1", "default", newStep("agent", "a"));
  valid(g);
  assert.deepEqual(outOf(g, "trigger_1"), ["default->a"]);
  assert.deepEqual(outOf(g, "t2"), ["default->a"]);
  assert.deepEqual(outOf(g, "a"), ["default->output_1"]);
});

test("new steps and triggers land where nothing else is", () => {
  let g = addTrigger(starter(), newTrigger("schedule", "t2"));
  for (let i = 0; i < 4; i++) g = insertStep(g, "trigger_1", "default", newStep("model", "m" + i));
  for (const a of g.nodes)
    for (const b of g.nodes)
      if (a !== b) assert.ok(Math.abs(a.position.x - b.position.x) >= NODE_W || Math.abs(a.position.y - b.position.y) >= NODE_H, `${a.id} overlaps ${b.id}`);
});

test("every new trigger and step kind is one the computer accepts", () => {
  for (const kind of ["manual", "schedule", "task", "chat", "routine", "webhook", "github"] as const) valid({ nodes: [newTrigger(kind, "t")], edges: [] });
  let g = starter();
  for (const kind of ["agent", "model", "condition", "approval", "output"] as const) g = insertStep(g, "trigger_1", "default", newStep(kind, "s_" + kind));
  valid(g);
});

test("a step two ways reach is drawn once, then as a jump", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("condition", "c"));
  g = { ...g, edges: [...g.edges, { id: "x", from: "c", to: "output_1", branch: "no" }] };
  assert.deepEqual(steps(flowFrom(g, "trigger_1", "default")), ["c", "[yes:output_1,+ | no:→output_1]"]);
});

test("tidy lays depth across in landscape and down in portrait, with no overlaps", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("condition", "c"));
  g = insertStep(g, "c", "no", newStep("output", "o2"));
  const across = tidy(g, "across");
  const down = tidy(g, "down");
  const pos = (h: Graph, id: string) => h.nodes.find((n) => n.id === id)!.position;
  assert.ok(pos(across, "c").x > pos(across, "trigger_1").x);
  assert.equal(pos(across, "c").y, pos(across, "trigger_1").y);
  assert.ok(pos(down, "c").y > pos(down, "trigger_1").y);
  assert.ok(pos(across, "o2").y > pos(across, "output_1").y, "the No lane sits under Yes");
  assert.ok(pos(down, "o2").x > pos(down, "output_1").x, "the No lane sits right of Yes");
  for (const h of [across, down]) {
    assert.equal(needsTidy(h), false);
    for (const a of h.nodes)
      for (const b of h.nodes)
        if (a !== b) assert.ok(Math.abs(a.position.x - b.position.x) >= NODE_W || Math.abs(a.position.y - b.position.y) >= NODE_H, `${a.id} overlaps ${b.id}`);
  }
  const box = bounds(across);
  assert.ok(box.w >= NODE_W * 3 && box.h >= NODE_H * 2);
});

test("summaries say what a step does", () => {
  const g = starter();
  assert.match(summary(g.nodes[1]), /^Chat · Workflow ran at/);
  assert.equal(summary({ ...newStep("condition", "c"), config: { match: "any", rules: [{ field: "a", op: "exists" }, { field: "b", op: "equals", value: "x" }] } }), "a is set or b is x");
  assert.equal(summary({ ...newStep("agent", "a"), config: { botId: "b1", prompt: "Do\nit" } }, () => "Glory"), "Glory · Do it");
});

test("field analysis flags a field no earlier step gives", () => {
  let g = insertStep(starter(), "trigger_1", "default", newStep("agent", "a"));
  g.nodes.find((n) => n.id === "output_1")!.config.template = "{{agent_reply}} {{nope}}";
  const fields = analyzeWorkflowFields({ id: "w", name: "t", enabled: true, createdAt: 0, updatedAt: 0, ...g });
  assert.deepEqual(fields.output_1.problems.map((p) => p.field), ["nope"]);
});

test("the phone's field analysis is the computer's, apart from its import", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^import |^\/\/ The same file as/.test(l)).join("\n");
  const phone = readFileSync(new URL("../src/features/workflows/fields.ts", import.meta.url), "utf8");
  const computer = readFileSync(new URL("../../desktop/src/workflowAnalysis.ts", import.meta.url), "utf8");
  assert.equal(strip(phone), strip(computer));
});

test("GitHub trigger exposes mention/issue fields and formats event summaries", () => {
  const gh = {
    ...newTrigger("github", "t_gh"),
    config: { repo: "promptclickrun/Botkins", events: ["issue_opened", "bot_mentioned"], mentionHandle: "@botkins-bot", pollMinutes: 5 },
  };
  const out = {
    ...newStep("output", "o_gh"),
    config: { destination: "feed", title: "{{event}} {{mention}}", template: "{{item_type}} #{{number}}: {{body}} ({{labels}})" },
  };
  const g: Graph = { nodes: [gh, out], edges: [{ id: "e1", from: "t_gh", to: "o_gh", branch: "default" }] };
  valid(g);
  const fields = analyzeWorkflowFields({ id: "w", name: "gh", enabled: true, createdAt: 0, updatedAt: 0, ...g });
  assert.deepEqual(fields.o_gh.problems, []);
  assert.equal(summary(gh), "promptclickrun/Botkins · Issue opened, Bot mentioned");
});

