// Pi has no plan of its own, so Botkins gives it one: the `update_plan` tool. The plan lives on the
// session, `todos()` reads it (the way every other harness's task list is read), and the chat's
// task list and Botkins' "keep the work moving" rules (desktop/keep-moving.mjs) work from that.
import { defineTool } from "../provider.mjs";

/** Steps in one plan. */
export const PLAN_LIMIT = 100;
const TEXT_LIMIT = 300;
export const PLAN_STATUSES = ["pending", "in_progress", "completed"];

/** What the model is told about the tool, after Pi's own instructions. */
export const PLAN_INSTRUCTIONS =
  "For work that takes several steps, keep a plan with the update_plan tool: list the steps, mark the one you are working on in_progress, and mark each completed as soon as it is done. Send the whole list every time. Skip the plan for a simple question or a one-step task. Don't end your turn while steps are open unless you need the person's input or approval; then say so.";

/** The checked steps of a plan, as the rows the workspace reads (`mapTodos`), or an Error that says what to fix. */
export function checkedPlan(input) {
  const steps = input?.steps;
  if (!Array.isArray(steps)) throw new Error("steps must be a list of { id, text, status }.");
  if (steps.length > PLAN_LIMIT) throw new Error("A plan holds up to " + PLAN_LIMIT + " steps.");
  const seen = new Set();
  return steps.map((step, i) => {
    const id = typeof step?.id === "number" ? String(step.id) : typeof step?.id === "string" ? step.id.trim() : "";
    const text = typeof step?.text === "string" ? step.text.replace(/\s+/g, " ").trim() : "";
    if (!id) throw new Error("Step " + (i + 1) + " needs an id.");
    if (seen.has(id)) throw new Error("Step ids must be different: " + id + " is used twice.");
    seen.add(id);
    if (!text) throw new Error("Step " + id + " needs text.");
    if (!PLAN_STATUSES.includes(step.status)) throw new Error("Step " + id + " has status " + JSON.stringify(step.status) + "; use pending, in_progress or completed.");
    return { id, title: text.slice(0, TEXT_LIMIT), status: step.status };
  });
}

/** The `update_plan` tool for a Pi session: `session.plan` holds the rows, and a change is announced as the task list changing. */
export function updatePlanTool(session) {
  return defineTool("update_plan", {
    description:
      "Keeps your plan for multi-step work. Send the whole list of steps each time (up to " + PLAN_LIMIT + "), with each step's status: pending, in_progress or completed. Update it as you finish steps. An empty list clears the plan.",
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
      session.plan = rows;
      session.emit("session.todos_changed", {});
      const open = rows.filter((row) => row.status !== "completed").length;
      return rows.length ? "Plan saved: " + rows.length + (rows.length === 1 ? " step, " : " steps, ") + open + " open." : "Plan cleared.";
    },
  });
}
