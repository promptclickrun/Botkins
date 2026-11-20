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

export function recordActivity(run, { type, data }, notify) {
  const id = data?.toolCallId;
  if (!id || !type.startsWith("tool.")) return;
  run.steps ??= [];
  let step = run.steps.find((s) => s.id === id);
  if (type === "tool.execution_start") {
    if (step) return;
    const name = data.mcpToolName || data.toolName || "Tool";
    step = {
      id,
      name,
      source: data.mcpServerName,
      label: toolLabel(name, data.arguments),
      input: displayValue(data.arguments, 12000),
      status: "Running",
      started: Date.now(),
    };
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
