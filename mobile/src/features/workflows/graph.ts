// Plain graph edits for the phone's workflow designer: no React, so tests can drive them.
// The host (desktop/desktop/workflows.mjs) checks and normalizes what is saved; these keep a draft valid as it is edited.
import type { WorkflowEdge, WorkflowNode, WorkflowTriggerKind } from "@/link/types";

export type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
export type StepKind = Exclude<WorkflowNode["kind"], "trigger">;
export type Branch = "default" | "yes" | "no" | "approved" | "rejected";

export const TRIGGER_KINDS: WorkflowTriggerKind[] = ["manual", "schedule", "task", "chat", "routine", "webhook", "github"];
export const STEP_KINDS: StepKind[] = ["agent", "model", "condition", "approval", "output"];

export const KIND_LABEL: Record<WorkflowNode["kind"], string> = {
  trigger: "Trigger",
  agent: "Ask a bot",
  model: "Ask a model",
  condition: "Check a condition",
  approval: "Wait for approval",
  output: "Send a result",
};
export const KIND_HINT: Record<StepKind, string> = {
  agent: "A teammate does the work with its tools and replies.",
  model: "One quick model call, no tools: sort, summarize, extract.",
  condition: "Go one way or the other on a field's value.",
  approval: "Stop until a person approves or rejects.",
  output: "Post to a chat, Feed, Ideas, Goals or a notification.",
};
export const TRIGGER_LABEL: Record<WorkflowTriggerKind, string> = {
  manual: "Run by hand",
  schedule: "On a schedule",
  task: "A task changes",
  chat: "A chat message",
  routine: "A routine finishes",
  webhook: "A webhook call",
  github: "GitHub activity",
};

/** The two ways out of a step that branches, in the order they are drawn. */
export function branchesOf(kind: WorkflowNode["kind"]): [Branch, Branch] | null {
  if (kind === "condition") return ["yes", "no"];
  if (kind === "approval") return ["approved", "rejected"];
  return null;
}
export const BRANCH_LABEL: Record<Branch, string> = { default: "Next", yes: "Yes", no: "No", approved: "Approved", rejected: "Rejected" };

/** The host counts "default" out of a condition as yes, and out of an approval as approved. */
export function branchOf(edge: WorkflowEdge, from: WorkflowNode | undefined): Branch {
  const raw = (edge.branch || "default") as Branch;
  const pair = from && branchesOf(from.kind);
  if (pair && raw === "default") return pair[0];
  return raw;
}

let counter = 0;
export function newId(prefix: string, taken: Iterable<string>) {
  const used = new Set(taken);
  for (;;) {
    const id = `${prefix}_${Date.now().toString(36).slice(-4)}${(counter++).toString(36)}`;
    if (!used.has(id)) return id;
  }
}

export function newTrigger(triggerKind: WorkflowTriggerKind, id: string): WorkflowNode {
  const config: Record<string, unknown> =
    triggerKind === "schedule" ? { cadence: "daily", time: "09:00" }
    : triggerKind === "task" ? { event: "status_changed", toStatus: "done" }
    : triggerKind === "chat" ? { mentionOnly: false }
    : triggerKind === "routine" ? { onlyOnStatus: "any" }
    : triggerKind === "github" ? { events: ["pr_opened"], pollMinutes: 5 }
    : triggerKind === "webhook" ? { fields: [] }
    : { inputs: [] };
  return { id, kind: "trigger", triggerKind, label: TRIGGER_LABEL[triggerKind], position: { x: 0, y: 0 }, config };
}

export function newStep(kind: StepKind, id: string): WorkflowNode {
  const config: Record<string, unknown> =
    kind === "agent" ? { prompt: "", outputFields: [] }
    : kind === "model" ? { prompt: "", outputFields: [] }
    : kind === "condition" ? { match: "all", rules: [{ field: "", op: "equals", value: "" }] }
    : kind === "approval" ? { message: "Okay to continue?", noteField: "approval_note" }
    : { destination: "chat", template: "" };
  return { id, kind, label: KIND_LABEL[kind], position: { x: 0, y: 0 }, config };
}

const clone = (g: Graph): Graph => ({ nodes: g.nodes.map((n) => ({ ...n, config: { ...n.config } })), edges: g.edges.map((e) => ({ ...e })) });

function wouldCycle(edges: WorkflowEdge[], from: string, to: string) {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === from) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...(out.get(at) ?? []));
  }
  return false;
}

/**
 * Put a new step on the way out of `fromId` (by `branch`). What that way led to before now follows the new step,
 * on its first way out when it branches. Answers the new graph and the step's id.
 */
export function insertStep(graph: Graph, fromId: string, branch: Branch, step: WorkflowNode): Graph {
  const g = clone(graph);
  const from = g.nodes.find((n) => n.id === fromId);
  if (!from) return g;
  const moved = g.edges.filter((e) => e.from === fromId && branchOf(e, from) === branch);
  const out = branchesOf(step.kind)?.[0] ?? "default";
  // Triggers that start the same steps share one start: a step put after one goes after all of them.
  const targets = (id: string) => g.edges.filter((e) => e.from === id).map((e) => e.to).sort().join(",");
  const starts = from.kind === "trigger" ? g.nodes.filter((n) => n.kind === "trigger" && targets(n.id) === targets(fromId)).map((n) => n.id) : [fromId];
  const dropped = from.kind === "trigger" ? g.edges.filter((e) => starts.includes(e.from)) : moved;
  g.edges = g.edges.filter((e) => !dropped.includes(e));
  g.nodes.push(step);
  for (const start of starts) g.edges.push({ id: newId("e", g.edges.map((e) => e.id)), from: start, to: step.id, branch: from.kind === "trigger" ? "default" : branch });
  for (const old of moved) g.edges.push({ id: old.id, from: step.id, to: old.to, branch: out });
  return place(g, step.id, fromId);
}

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < NODE_W + 24 && Math.abs(a.y - b.y) < NODE_H + 24;

/**
 * Give a new step a spot near the one it follows where nothing else is, so the canvas keeps the person's layout.
 * The spot is after `nearId` in the direction most of the graph already runs; then down (or across) until it's free.
 */
export function place(graph: Graph, id: string, nearId: string): Graph {
  const near = graph.nodes.find((n) => n.id === nearId)?.position ?? { x: 40, y: 40 };
  const others = graph.nodes.filter((n) => n.id !== id).map((n) => n.position ?? { x: 0, y: 0 });
  const across = graph.edges.reduce((sum, e) => {
    const a = graph.nodes.find((n) => n.id === e.from)?.position;
    const b = graph.nodes.find((n) => n.id === e.to)?.position;
    return a && b && e.to !== id && e.from !== id ? sum + Math.sign(Math.abs(b.x - a.x) - Math.abs(b.y - a.y)) : sum;
  }, 0) >= 0;
  const at = across ? { x: near.x + GAP_DEPTH.across, y: near.y } : { x: near.x, y: near.y + GAP_DEPTH.down };
  for (let i = 0; i < 50 && others.some((o) => overlaps(o, at)); i++) {
    if (across) at.y += NODE_H + GAP_LANE.across;
    else at.x += GAP_LANE.down;
  }
  return { nodes: graph.nodes.map((n) => (n.id === id ? { ...n, position: at } : n)), edges: graph.edges };
}

/** A trigger of its own kind that starts the same first steps as the workflow's first trigger. */
export function addTrigger(graph: Graph, trigger: WorkflowNode): Graph {
  const g = clone(graph);
  const first = g.nodes.find((n) => n.kind === "trigger");
  g.nodes.unshift(trigger);
  if (first) for (const e of graph.edges.filter((e) => e.from === first.id)) g.edges.push({ id: newId("e", g.edges.map((x) => x.id)), from: trigger.id, to: e.to, branch: "default" });
  if (!first) return g;
  const p = first.position ?? { x: 40, y: 40 };
  const others = g.nodes.filter((n) => n.id !== trigger.id).map((n) => n.position ?? { x: 0, y: 0 });
  const at = { x: p.x, y: p.y + NODE_H + GAP_LANE.across };
  for (let i = 0; i < 50 && others.some((o) => overlaps(o, at)); i++) at.y += NODE_H + GAP_LANE.across;
  g.nodes[0] = { ...trigger, position: at };
  return g;
}

/** The last trigger can't go: the host refuses a workflow with none. */
export function canRemove(graph: Graph, id: string) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return false;
  return node.kind !== "trigger" || graph.nodes.filter((n) => n.kind === "trigger").length > 1;
}

/** Take a step out and join what came before it to what came after it on its main way out (Next, Yes or Approved). */
export function removeStep(graph: Graph, id: string): Graph {
  if (!canRemove(graph, id)) return clone(graph);
  const g = clone(graph);
  const node = g.nodes.find((n) => n.id === id)!;
  const main = branchesOf(node.kind)?.[0] ?? "default";
  const after = g.edges.filter((e) => e.from === id && branchOf(e, node) === main).map((e) => e.to);
  const before = g.edges.filter((e) => e.to === id);
  g.nodes = g.nodes.filter((n) => n.id !== id);
  g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
  if (node.kind !== "trigger")
    for (const inbound of before)
      for (const to of after)
        if (!g.edges.some((e) => e.from === inbound.from && e.to === to && e.branch === inbound.branch) && !wouldCycle(g.edges, inbound.from, to))
          g.edges.push({ id: newId("e", g.edges.map((e) => e.id)), from: inbound.from, to, branch: inbound.branch });
  return g;
}

export function updateNode(graph: Graph, id: string, patch: Partial<WorkflowNode>): Graph {
  return { nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch, config: patch.config ?? n.config } : n)), edges: graph.edges };
}

export function moveNode(graph: Graph, id: string, position: { x: number; y: number }): Graph {
  return updateNode(graph, id, { position: { x: Math.round(position.x), y: Math.round(position.y) } });
}

/** Steps nothing leads to, apart from triggers. The flow shows them at the end so they can be wired up or removed. */
export function orphans(graph: Graph) {
  const reached = new Set(graph.edges.map((e) => e.to));
  return graph.nodes.filter((n) => n.kind !== "trigger" && !reached.has(n.id));
}

// ---------------------------------------------------------------------------------------------------------------
// The one-column flow: the trigger(s), then each step under the one before it, with a lane for each way a step branches.

export type FlowItem =
  | { type: "step"; node: WorkflowNode; from: string; branch: Branch }
  | { type: "lanes"; node: WorkflowNode; lanes: { branch: Branch; items: FlowItem[] }[] }
  | { type: "jump"; to: WorkflowNode; from: string; branch: Branch }
  | { type: "add"; from: string; branch: Branch };

/**
 * The steps from `fromId` in reading order. A step already drawn (two ways meet) shows as a jump to it.
 * Each run of steps ends in an add spot, so a new step can go at the end of any lane.
 */
export function flowFrom(graph: Graph, fromId: string, branch: Branch, seen = new Set<string>()): FlowItem[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const items: FlowItem[] = [];
  let at = fromId;
  let way: Branch = branch;
  for (;;) {
    const fromNode = byId.get(at);
    const next = graph.edges.filter((e) => e.from === at && branchOf(e, fromNode) === way).map((e) => byId.get(e.to)).filter((n): n is WorkflowNode => !!n);
    if (!next.length) {
      items.push({ type: "add", from: at, branch: way });
      return items;
    }
    // Two steps on one way out run side by side; the flow follows the first and shows jumps to the rest.
    const [node, ...rest] = next;
    if (seen.has(node.id)) {
      items.push({ type: "jump", to: node, from: at, branch: way });
      for (const other of rest) items.push({ type: "jump", to: other, from: at, branch: way });
      return items;
    }
    seen.add(node.id);
    items.push({ type: "step", node, from: at, branch: way });
    for (const other of rest) {
      if (seen.has(other.id)) items.push({ type: "jump", to: other, from: at, branch: way });
      else {
        seen.add(other.id);
        items.push({ type: "step", node: other, from: at, branch: way });
      }
    }
    const pair = branchesOf(node.kind);
    if (pair) {
      items.push({ type: "lanes", node, lanes: pair.map((b) => ({ branch: b, items: flowFrom(graph, node.id, b, seen) })) });
      return items;
    }
    at = node.id;
    way = "default";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Canvas layout: depth runs across in landscape (as on the computer) and down in portrait.

export const NODE_W = 220;
export const NODE_H = 76;
const GAP_DEPTH = { across: 300, down: 140 };
const GAP_LANE = { across: 120, down: 260 };

export function tidy(graph: Graph, direction: "across" | "down"): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const triggers = graph.nodes.filter((n) => n.kind === "trigger");
  const queue = triggers.map((t) => t.id);
  for (const id of queue) depth.set(id, 0);
  // Longest path from a trigger, so a step sits after everything that leads to it. The host forbids cycles.
  for (let guard = 0; guard < graph.nodes.length * graph.nodes.length + 1; guard++) {
    let changed = false;
    for (const e of graph.edges) {
      const d = depth.get(e.from);
      if (d === undefined) continue;
      if ((depth.get(e.to) ?? -1) < d + 1) {
        depth.set(e.to, d + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  let loose = Math.max(0, ...depth.values()) + 1;
  for (const n of graph.nodes) if (!depth.has(n.id)) depth.set(n.id, loose++);
  // Within a depth, keep a branch's second way below (or right of) its first.
  const laneKey = (n: WorkflowNode) => {
    const inbound = graph.edges.find((e) => e.to === n.id);
    if (!inbound) return 0;
    const from = byId.get(inbound.from);
    const pair = from && branchesOf(from.kind);
    return pair ? pair.indexOf(branchOf(inbound, from)) : 0;
  };
  const rows = new Map<number, WorkflowNode[]>();
  for (const n of graph.nodes) rows.set(depth.get(n.id)!, [...(rows.get(depth.get(n.id)!) ?? []), n]);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, list] of rows) {
    list.sort((a, b) => laneKey(a) - laneKey(b));
    list.forEach((n, i) => {
      const lane = i * (direction === "across" ? NODE_H + GAP_LANE.across : GAP_LANE.down);
      positions.set(n.id, direction === "across" ? { x: 40 + d * GAP_DEPTH.across, y: 40 + lane } : { x: 40 + lane, y: 40 + d * GAP_DEPTH.down });
    });
  }
  return { nodes: graph.nodes.map((n) => ({ ...n, position: positions.get(n.id)! })), edges: graph.edges };
}

/** Saved positions overlap when the host laid out a new workflow, or every node sits at 0,0 on a fresh draft. */
export function needsTidy(graph: Graph) {
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    const key = `${Math.round((n.position?.x ?? 0) / 40)}:${Math.round((n.position?.y ?? 0) / 40)}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function bounds(graph: Graph) {
  if (!graph.nodes.length) return { x: 0, y: 0, w: NODE_W, h: NODE_H };
  const xs = graph.nodes.map((n) => n.position?.x ?? 0);
  const ys = graph.nodes.map((n) => n.position?.y ?? 0);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) + NODE_W - x, h: Math.max(...ys) + NODE_H - y };
}

/** A starter graph for a new workflow: run by hand, then post the result to a chat. */
export function starter(): Graph {
  const trigger = newTrigger("manual", "trigger_1");
  const output = { ...newStep("output", "output_1"), config: { destination: "chat", template: "Workflow ran at {{run_time}}, started by {{triggered_by}}." } };
  return tidy({ nodes: [trigger, output], edges: [{ id: "e_1", from: trigger.id, to: output.id, branch: "default" }] }, "across");
}

/** One line under a step's title, said plainly. */
export function summary(node: WorkflowNode, botName?: (id?: string, name?: string) => string | undefined): string {
  const c = node.config ?? {};
  switch (node.kind) {
    case "trigger":
      switch (node.triggerKind) {
        case "schedule":
          return c.when || (c.cadence === "custom" ? `Cron ${c.cron || "not set"}` : `${c.cadence || "daily"} at ${c.time || "09:00"}`);
        case "task":
          return c.event === "created" ? "When a task is created" : `When a task moves${c.toStatus ? " to " + c.toStatus : ""}`;
        case "chat":
          return c.textContains ? `Message contains “${c.textContains}”` : c.mentionOnly ? "When a bot is mentioned" : "Any new message";
        case "routine":
          return c.routineName ? `After ${c.routineName}` : "After any routine";
        case "webhook":
          return c.routeId ? "Webhook URL ready" : "URL made when saved";
        case "github": {
          const evs = Array.isArray(c.events) ? c.events.map((e: string) => GITHUB_EVENT_LABEL[e as (typeof GITHUB_EVENTS)[number]] ?? e) : [];
          return c.repo ? `${c.repo} · ${evs.join(", ") || "no events"}` : "Choose a repository";
        }
        default:
          return "Run now, from here or the computer";
      }
    case "agent":
      return [botName?.(c.botId, c.botName) || "Choose a bot", c.prompt ? String(c.prompt).replace(/\s+/g, " ") : "No prompt yet"].join(" · ");
    case "model":
      return [c.model || "Default model", c.prompt ? String(c.prompt).replace(/\s+/g, " ") : "No prompt yet"].join(" · ");
    case "condition": {
      const rules: any[] = Array.isArray(c.rules) ? c.rules : [];
      if (!rules.length) return c.expression || "No rules: always No";
      const text = rules.map((r) => `${r.field || "?"} ${OP_LABEL[r.op as string] ?? r.op}${OPS_WITHOUT_VALUE.includes(r.op) ? "" : " " + (r.value ?? "")}`);
      return text.join(c.match === "any" ? " or " : " and ");
    }
    case "approval":
      return c.message || "Approve or reject";
    case "output": {
      const where = c.destination === "chat" ? "Chat" : c.destination === "feed" ? "Feed" : c.destination === "idea" ? "Ideas" : c.destination === "goal" ? "Goals" : "Notification";
      return [where, c.template ? String(c.template).replace(/\s+/g, " ") : "No message yet"].join(" · ");
    }
  }
}

export const CONDITION_OPS = ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "matches", "in", "gt", "gte", "lt", "lte", "exists", "empty"] as const;
export const OPS_WITHOUT_VALUE: string[] = ["exists", "empty"];
export const OP_LABEL: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  ends_with: "ends with",
  matches: "matches",
  in: "is one of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  exists: "is set",
  empty: "is empty",
};
export const DESTINATIONS = ["chat", "feed", "idea", "goal", "notification"] as const;
export const GOAL_CATEGORIES = ["health", "relationships", "finance", "career", "interests", "productivity", "other"] as const;
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const GITHUB_EVENTS = [
  "pr_opened",
  "pr_updated",
  "pr_review",
  "ci_status",
  "issue_opened",
  "issue_updated",
  "issue_comment",
  "user_mentioned",
  "bot_mentioned",
] as const;

export const GITHUB_EVENT_LABEL: Record<(typeof GITHUB_EVENTS)[number], string> = {
  pr_opened: "PR opened",
  pr_updated: "PR updated",
  pr_review: "PR review",
  ci_status: "CI status",
  issue_opened: "Issue opened",
  issue_updated: "Issue updated",
  issue_comment: "Comment added",
  user_mentioned: "Mentioned me",
  bot_mentioned: "Bot mentioned",
};
export const TASK_STATUSES = ["later", "ready", "working", "review", "done", "blocked"] as const;
