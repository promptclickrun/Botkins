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
// Pending rail entries whose tool handler ran over MCP without a toolCallId (matched on next start/complete).
const pendingRailEntries = new WeakMap();
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
/**
 * Link a rail card entry (run.teamwork or run.taskHandoffs) to the exact tool step that created it.
 * Copilot supplies `toolCallId` directly; MCP bridge providers don't pass it in tools/call, so we
 * bind to the uniquely matching in-flight step on `run.steps` (or queue until that step arrives).
 */
export function bindRailStep(run, entry, { toolName, toolCallId, args } = {}) {
  if (!run || !entry) return;
  if (typeof toolCallId === "string" && toolCallId) {
    entry.toolCallId = toolCallId;
    return;
  }
  const match = findMatchingRunningStep(run, toolName, args);
  if (match) {
    entry.toolCallId = match.id;
    return;
  }
  if (!pendingRailEntries.has(run)) pendingRailEntries.set(run, []);
  pendingRailEntries.get(run).push({ entry, toolName, input: args ? displayValue(args, 12000) : "" });
}
function usedRailStepIds(run) {
  const used = new Set();
  for (const item of run.teamwork ?? []) if (item?.toolCallId) used.add(item.toolCallId);
  for (const item of run.taskHandoffs ?? []) if (item?.toolCallId) used.add(item.toolCallId);
  return used;
}
function findMatchingRunningStep(run, toolName, args) {
  const name = String(toolName || "").toLowerCase();
  if (!name) return null;
  const used = usedRailStepIds(run);
  const candidates = (run.steps ?? []).filter(
    (s) => !s.source && s.status === "Running" && !used.has(s.id) && String(s.name || "").toLowerCase() === name,
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && args) {
    const serialized = displayValue(args, 12000);
    const exact = candidates.filter((s) => s.input === serialized);
    if (exact.length === 1) return exact[0];
  }
  return null;
}
function resolvePendingRailEntries(run, step) {
  const queue = pendingRailEntries.get(run);
  if (!queue?.length || step.source) return;
  const stepName = String(step.name || "").toLowerCase();
  const used = usedRailStepIds(run);
  if (used.has(step.id)) return;
  const exactIdx = queue.findIndex(
    (p) => !p.entry.toolCallId && String(p.toolName || "").toLowerCase() === stepName && p.input && p.input === step.input,
  );
  const idx = exactIdx >= 0
    ? exactIdx
    : queue.filter((p) => !p.entry.toolCallId && String(p.toolName || "").toLowerCase() === stepName).length === 1
      ? queue.findIndex((p) => !p.entry.toolCallId && String(p.toolName || "").toLowerCase() === stepName)
      : -1;
  if (idx >= 0) {
    queue[idx].entry.toolCallId = step.id;
    queue.splice(idx, 1);
  }
}
export function recordActivity(run, { type, data, agentId }, notify) {
  const id = data?.toolCallId;
  if (!id || !type.startsWith("tool.")) return;
  run.steps ??= [];
  let step = run.steps.find((s) => s.id === id);
  if (type === "tool.execution_start") {
    if (step) {
      // A start that came before the arguments were written (Pi's toolcall_start) says more later:
      // the arguments, and which MCP server's tool it is once the harness has asked about it.
      if (step.status !== "Running") return;
      const name = data.mcpToolName || data.toolName || step.name;
      const args = data.arguments && typeof data.arguments === "object" && Object.keys(data.arguments).length ? data.arguments : null;
      const input = args ? displayValue(args, 12000) : step.input;
      const source = data.mcpServerName ?? step.source;
      if (name === step.name && source === step.source && input === step.input) return;
      Object.assign(step, { name, source, input, label: args ? toolLabel(name, args) : step.label });
      resolvePendingRailEntries(run, step);
      notify();
      return;
    }
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
    resolvePendingRailEntries(run, step);
  } else if (!step) return;
  else if (type === "tool.backgrounded") {
    // A command that was moved to the background while it ran.
    if (step.background) return;
    step.background = true;
  } else if (type === "tool.execution_progress")
    step.progress = displayValue(data.progressMessage, 1200);
  else if (type === "tool.shell_output")
    step.output = ((step.output || "") + data.text).slice(-12000);
  else if (type === "tool.execution_partial_result")
    step.output = displayValue(data.partialOutput, 12000);
  else if (type === "tool.execution_complete") {
    // The person stopped it (Workspace.stopHelper): the harness's report of that is not another ending.
    if (step.status === "Stopped") return;
    // `stopped`: the call was written but never ran (a harness ended its message first), so it
    // neither did anything nor failed.
    step.status = data.success ? "Done" : data.stopped ? "Stopped" : "Failed";
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
