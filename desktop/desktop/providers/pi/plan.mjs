// In-chat plan support for Pi and OMP: the `update_plan` tool (with optional explicit
// dependencies) plus conversion/reconciliation with OMP's native `todoPhases` state. The plan is
// kept in Botkins' `{ rows, dependencies }` format so `todos()`, the chat's task list (`mapTodos`)
// and Botkins' "keep the work moving" rules (desktop/keep-moving.mjs) behave identically across
// Copilot, Pi and OMP.
import { defineTool } from "../provider.mjs";

/** Steps in one plan. */
export const PLAN_LIMIT = 100;
const TEXT_LIMIT = 300;
export const PLAN_STATUSES = ["pending", "in_progress", "completed"];

/** What the model is told about the tool, after the harness's own instructions. */
export const PLAN_INSTRUCTIONS =
  "For work that takes several steps, keep an in-chat progress checklist with update_plan (this tracks progress in the current chat only and does not create or start Task Board jobs; use task_create for board tasks): list the steps, mark the one you are working on in_progress, and mark each completed as soon as it is done. When a step genuinely depends on earlier steps, list their ids in dependsOn; omit dependsOn when there is no dependency and never invent dependencies. Send the whole list every time. Skip the plan for a simple question or a one-step task. Don't end your turn while steps are open unless you need the person's input or approval; then say so.";

/** The checked steps of a plan, as normalized rows (with optional `dependsOn`), or an Error that says what to fix. */
export function checkedPlan(input) {
  const steps = input?.steps;
  if (!Array.isArray(steps)) throw new Error("steps must be a list of { id, text, status }.");
  if (steps.length > PLAN_LIMIT) throw new Error("A plan holds up to " + PLAN_LIMIT + " steps.");
  const seen = new Set();
  const rows = steps.map((step, i) => {
    const id = typeof step?.id === "number" ? String(step.id) : typeof step?.id === "string" ? step.id.trim() : "";
    const text = typeof step?.text === "string" ? step.text.replace(/\s+/g, " ").trim() : "";
    if (!id) throw new Error("Step " + (i + 1) + " needs an id.");
    if (seen.has(id)) throw new Error("Step ids must be different: " + id + " is used twice.");
    seen.add(id);
    if (!text) throw new Error("Step " + id + " needs text.");
    if (!PLAN_STATUSES.includes(step.status)) throw new Error("Step " + id + " has status " + JSON.stringify(step.status) + "; use pending, in_progress or completed.");
    let dependsOn;
    if (step.dependsOn !== undefined) {
      if (!Array.isArray(step.dependsOn)) throw new Error("Step " + id + " dependsOn must be a list of step ids.");
      const deps = [];
      const seenDeps = new Set();
      for (const raw of step.dependsOn) {
        const dep = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
        if (!dep) throw new Error("Step " + id + " has an empty dependency id.");
        if (dep === id) throw new Error("Step " + id + " cannot depend on itself.");
        if (!seenDeps.has(dep)) {
          seenDeps.add(dep);
          deps.push(dep);
        }
      }
      if (deps.length) dependsOn = deps;
    }
    return { id, title: text.slice(0, TEXT_LIMIT), status: step.status, ...(dependsOn && { dependsOn }) };
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    for (const dep of row.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error("Step " + row.id + " depends on unknown step " + dep + ".");
    }
  }
  // Reject cycles in explicit dependencies.
  const state = new Map(); // 0/undefined = unvisited, 1 = visiting, 2 = done
  const visit = (id) => {
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const s = state.get(dep);
      if (s === 1) throw new Error("Plan dependencies cannot form a cycle (" + id + " -> " + dep + ").");
      if (!s) visit(dep);
    }
    state.set(id, 2);
  };
  for (const row of rows) if (!state.get(row.id)) visit(row.id);
  return rows;
}

/** Converts a checked plan (or stored `{ rows, dependencies }`) into Botkins' `session.todos()` shape. */
export function toTodoResult(plan) {
  if (!plan) return null;
  const sourceRows = Array.isArray(plan) ? plan : Array.isArray(plan.rows) ? plan.rows : null;
  if (!sourceRows) return null;
  const rows = [];
  const dependencies = [];
  const seenDep = new Set();
  const rowIds = new Set();
  for (const step of sourceRows) {
    if (!step?.id) continue;
    const id = String(step.id);
    rowIds.add(id);
    rows.push({ id, title: String(step.title ?? ""), status: String(step.status ?? "pending") });
    for (const dep of step.dependsOn ?? []) {
      const target = String(dep);
      const key = id + "\0" + target;
      if (target && target !== id && !seenDep.has(key)) {
        seenDep.add(key);
        dependencies.push({ todoId: id, dependsOn: target });
      }
    }
  }
  for (const dep of Array.isArray(plan.dependencies) ? plan.dependencies : []) {
    const todoId = dep?.todoId ? String(dep.todoId) : "";
    const dependsOn = dep?.dependsOn ? String(dep.dependsOn) : "";
    const key = todoId + "\0" + dependsOn;
    if (todoId && dependsOn && todoId !== dependsOn && rowIds.has(todoId) && rowIds.has(dependsOn) && !seenDep.has(key)) {
      seenDep.add(key);
      dependencies.push({ todoId, dependsOn });
    }
  }
  return { rows, dependencies };
}

/** Stable serialization for detecting whether a plan actually changed. */
export function planSignature(plan) {
  const normalized = toTodoResult(plan);
  return normalized ? JSON.stringify(normalized) : "";
}

const ompStatus = (status) => {
  const s = String(status || "").toLowerCase();
  if (s === "completed" || s === "done" || s === "complete" || s === "finished") return "completed";
  if (s === "in_progress" || s === "in-progress" || s === "inprogress" || s === "active" || s === "running") return "in_progress";
  if (s === "abandoned" || s === "cancelled" || s === "canceled" || s === "skipped") return "abandoned";
  return "pending";
};

/** Converts Botkins' `{ rows, dependencies }` into OMP's `set_todos` phases payload. */
export function planToOmpPhases(plan) {
  const normalized = toTodoResult(plan);
  if (!normalized?.rows?.length) return [];
  return [{ name: "Plan", tasks: normalized.rows.map((row) => ({ content: row.title, status: ompStatus(row.status) })) }];
}

/**
 * Converts OMP's native `todoPhases` (`[{ name, tasks: [{ content, status }] }]`) into Botkins'
 * `{ rows, dependencies }`. Reuses IDs and existing explicit dependencies for matching task titles
 * from `existingPlan`, and never invents dependencies from phase or task order.
 */
export function planFromOmpPhases(phases, existingPlan = null, { allowEmpty = false } = {}) {
  if (!Array.isArray(phases)) return null;
  const flat = [];
  for (const phase of phases) {
    for (const task of Array.isArray(phase?.tasks) ? phase.tasks : []) {
      const title = typeof task?.content === "string" ? task.content.replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT) : "";
      if (!title) continue;
      flat.push({ title, status: ompStatus(task?.status) });
      if (flat.length >= PLAN_LIMIT) break;
    }
    if (flat.length >= PLAN_LIMIT) break;
  }
  const existing = toTodoResult(existingPlan);
  if (!flat.length) return allowEmpty || existing ? { rows: [], dependencies: [] } : null;
  // Reconcile IDs by exact title (preserving order for duplicates) so native OMP updates keep
  // stable step IDs and retain any explicit dependencies already recorded via update_plan.
  const unusedByTitle = new Map();
  const usedIds = new Set();
  for (const row of existing?.rows ?? []) {
    const list = unusedByTitle.get(row.title) ?? [];
    list.push(row.id);
    unusedByTitle.set(row.title, list);
  }
  let nextNum = 1;
  const allocId = () => {
    while (usedIds.has("omp-" + nextNum)) nextNum++;
    const id = "omp-" + nextNum++;
    usedIds.add(id);
    return id;
  };
  const rows = flat.map((item) => {
    const matches = unusedByTitle.get(item.title);
    const id = matches?.length ? matches.shift() : allocId();
    usedIds.add(id);
    return { id, title: item.title, status: item.status };
  });
  const rowIds = new Set(rows.map((row) => row.id));
  // Keep only previously recorded explicit dependencies whose steps are still present; never invent new ones.
  const dependencies = (existing?.dependencies ?? []).filter((dep) => rowIds.has(dep.todoId) && rowIds.has(dep.dependsOn));
  return { rows, dependencies };
}

/** The `update_plan` tool for Pi and OMP sessions: saves rows + explicit dependencies and notifies Botkins. */
export function updatePlanTool(session) {
  return defineTool("update_plan", {
    description:
      "Update this chat's in-turn progress checklist only; does not create, queue, or start Task Board jobs (use task_create for board tasks). Send the whole list of steps each time (up to " + PLAN_LIMIT + "), with each step's status: pending, in_progress or completed, and optional dependsOn step ids for real prerequisites (never invent dependencies). Update it as you finish steps. An empty list clears the plan.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          maxItems: PLAN_LIMIT,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "A short id that stays the same as the plan changes." },
              text: { type: "string", description: "What the step does." },
              status: { type: "string", enum: PLAN_STATUSES },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "Optional ids of earlier steps that must finish before this step. Omit if none; never invent dependencies.",
              },
            },
            required: ["id", "text", "status"],
            additionalProperties: false,
          },
        },
        explanation: { type: "string", description: "Optional: why the plan changed." },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: "never",
    handler: async (input) => {
      const rows = checkedPlan(input);
      const plan = toTodoResult(rows);
      if (typeof session.setPlan === "function") await session.setPlan(plan, { syncNative: true });
      else {
        session.plan = plan;
        session.emit("session.todos_changed", {});
      }
      const open = plan.rows.filter((row) => row.status !== "completed").length;
      return plan.rows.length ? "Plan saved: " + plan.rows.length + (plan.rows.length === 1 ? " step, " : " steps, ") + open + " open." : "Plan cleared.";
    },
  });
}
