/** Shell providers can explicitly launch a command in the background. */
const shellTool = /^(bash|powershell|shell|terminal|run_command)$/i;

export function backgroundShell(name, source, args) {
  return !source && shellTool.test(name) &&
    (args?.run_in_background === true || args?.mode === "async" || args?.detach === true);
}

export function isBackgroundStep(step) {
  if (step.background) return true;
  // Saved runs predate the flag. Read the arguments when the preview is available.
  if (!step.input || step.source || !shellTool.test(step.name)) return false;
  try {
    return backgroundShell(step.name, step.source, JSON.parse(step.input));
  } catch {
    return false;
  }
}

export function activitySteps(steps = [], agents = []) {
  const byAgent = new Map(agents.map((agent) => [agent.id, []]));
  const tools = [];
  const background = [];
  // A later arrival wins a timestamp tie. Sort a copy so the chat keeps its timeline.
  for (const step of [...steps].reverse().sort((a, b) => b.started - a.started)) {
    const owned = byAgent.get(step.agentId ?? step.id);
    if (owned) owned.push(step);
    else if (step.agentId || isBackgroundStep(step)) background.push(step);
    else tools.push(step);
  }
  return { tools, background, byAgent };
}
