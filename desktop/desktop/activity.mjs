import { backgroundShell } from "./link/activity-steps.mjs";
import { displayValue } from "./display.mjs";

function toolLabel(name, args) {
  if (!args || typeof args !== "object") return name;
  const detail =
    args.description ||
    args.intention ||
    args.command ||
    args.query ||
    args.url ||
    args.path ||
    args.file_path ||
    args.filename;
  return typeof detail === "string"
    ? detail.split("\n")[0].slice(0, 180)
    : name;
}

// Provider instance IDs and tool-call IDs can differ. Keep the association private to the run.
const owners = new WeakMap();
const pendingOwners = new WeakMap();
export function associateHelper(run, instance, toolCallId) {
  if (!instance || !toolCallId) return;
  if (!owners.has(run)) owners.set(run, new Map());
  owners.get(run).set(instance, toolCallId);
  for (const step of run.steps ?? []) if (pendingOwners.get(step) === instance) {
    step.agentId = toolCallId;
    pendingOwners.delete(step);
  }
}
export function helperId(run, instance) {
  return owners.get(run)?.get(instance) ?? run.agents?.find(a => a.id === instance)?.id;
}
export function recordActivity(run, { type, data, agentId }, notify) {
  const id = data?.toolCallId;
  if (!id || !type.startsWith("tool.")) return;
  run.steps ??= [];
  let step = run.steps.find((s) => s.id === id);
  if (type === "tool.execution_start") {
    if (step) return;
    const name = data.mcpToolName || data.toolName || "Tool";
    const owner = data.parentToolCallId ?? (agentId && helperId(run, agentId));
    step = {
      id,
      ...(owner && {agentId:owner}),
      name,
      source: data.mcpServerName,
      ...(backgroundShell(name, data.mcpServerName, data.arguments) && { background: true }),
      label: toolLabel(name, data.arguments),
      input: displayValue(data.arguments, 12000),
      status: "Running",
      started: Date.now(),
    };
    if (!owner && agentId) pendingOwners.set(step, agentId);
    run.steps.push(step);
  } else if (!step) return;
  else if (type === "tool.execution_progress")
    step.progress = displayValue(data.progressMessage, 1200);
  else if (type === "tool.shell_output")
    step.output = ((step.output || "") + data.text).slice(-12000);
  else if (type === "tool.execution_partial_result")
    step.output = displayValue(data.partialOutput, 12000);
  else if (type === "tool.execution_complete") {
    step.status = data.success ? "Done" : "Failed";
    step.finished = Date.now();
    const output =
      data.error?.message ??
      data.result?.content ??
      data.result?.detailedContent;
    if (output && !step.output) step.output = displayValue(output, 12000);
    if (data.success) {
      run.usedTools ??= [];
      if (!run.usedTools.includes(step.name)) run.usedTools.push(step.name);
    }
  } else return;
  notify();
}
