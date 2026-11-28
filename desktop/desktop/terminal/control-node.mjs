// Node host calls over the control socket (desktop/terminal/control.mjs).
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  }
  return value.trim();
};

export function nodeApi({ workspace, handlers }) {
  const resolveProject = (ref, allowMissing = false) => {
    const wanted = text(ref, 200, "a project name or id");
    const projects = workspace.state.projects;
    const found =
      projects.find((entry) => entry.id === wanted) ??
      (() => {
        const named = projects.filter((entry) => String(entry.name ?? "").toLowerCase() === wanted.toLowerCase());
        if (named.length > 1) {
          throw new ControlError("More than one project is called " + wanted + ". Use its id (see `botkins projects list`).", "AMBIGUOUS");
        }
        return named[0];
      })();
    if (found) return found;
    if (allowMissing && workspace.nodeHost.sharedProjects.includes(wanted)) return { id: wanted, name: wanted };
    throw new ControlError("There is no project called " + wanted + ". See `botkins projects list`.", "NOT_FOUND");
  };

  return {
    "node.status": () => handlers.nodeStatus(),
    "node.approvals": () =>
      workspace.interactions
        .snapshot()
        // A node's own approvals, and the ones nodes handed back to this computer's chats (nodeAsk).
        .filter((entry) => entry.nodeJob === true || typeof entry.nodeAsk === "string")
        .map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          ...(entry.label && { label: entry.label }),
          ...(entry.preview && { preview: entry.preview }),
          ...(entry.detail && { detail: entry.detail }),
          chatId: entry.chatId,
          botId: entry.botId,
          nodeJob: true,
          ...(entry.dispatch && { dispatch: true }),
          ...(entry.review && { review: true }),
          ...(entry.operation && { operation: entry.operation }),
          ...(entry.resourceId && { resourceId: entry.resourceId }),
          ...(entry.resourceName && { resourceName: entry.resourceName }),
          ...(entry.sourceBotName && { sourceBotName: entry.sourceBotName }),
          ...(entry.sourceHostName && { sourceHostName: entry.sourceHostName }),
          ...(entry.targetHostName && { targetHostName: entry.targetHostName }),
          ...(entry.time !== undefined && { time: entry.time }),
        })),
    "node.audit": ([limit] = []) => handlers.nodeAuditLog(limit),
    "node.setup": async ([name] = []) => handlers.nodeSetup({ name: text(name, 80, "a name for this node host") }),
    "node.rename": async ([name] = []) => handlers.nodeRename(text(name, 80, "a name for this node host")),
    "node.pause": async ([paused] = []) => handlers.nodePause(paused === true),
    "node.wholeComputer": async ([enabled] = []) => handlers.nodeSetWholeComputer(enabled === true),
    "node.execMode": async ([mode] = []) => handlers.nodeSetExecMode(text(mode, 32, "an exec policy mode (deny, allowlist, ask or full)")),
    "node.allowlist.add": async ([pattern, botId] = []) =>
      handlers.nodeAddAllowlistRule({
        pattern: text(pattern, 240, "a command or executable path pattern"),
        botId: botId === undefined || botId === null || botId === "" ? "*" : text(botId, 160, "a source bot id or *"),
      }),
    "node.allowlist.remove": async ([ruleId] = []) => {
      const id = ruleId === undefined || ruleId === null || ruleId === "" ? undefined : text(ruleId, 120, "an allowlist rule id");
      const status = await handlers.nodeRemoveAllowlistRule(id);
      return { ...status, removed: id ?? "all" };
    },
    "node.share": async ([ref, shared] = []) => {
      const share = shared !== false;
      const project = resolveProject(ref, !share);
      const status = await handlers.nodeShareProject(project.id, share);
      return { ...status, project: { id: project.id, name: project.name, shared: share } };
    },
    "node.revoke": async ([grantId] = []) => {
      const id = grantId === undefined || grantId === null || grantId === "" ? undefined : text(grantId, 120, "a grant id");
      const status = await handlers.nodeRevokeGrant(id);
      return { ...status, revoked: id ?? "all" };
    },
    "node.disconnect": async () => handlers.nodeDisconnect(),
    "node.convert.inspect": async () => handlers.nodeConvertInspect(),
    "node.convert.plan": async ([input] = []) => handlers.nodeConvertPlan(input && typeof input === "object" ? input : {}),
    "node.convert.run": async ([input] = []) => handlers.nodeConvertRun(input && typeof input === "object" ? input : {}),
    "node.convert.status": () => handlers.nodeConvertStatus(),
    "node.convert.undo": async ([snapshotId] = []) =>
      handlers.nodeConvertUndo(snapshotId ? { snapshotId: text(snapshotId, 160, "a snapshot id") } : {}),
    "node.remote.status": async ([hostId] = []) => handlers.nodeRemoteStatus(text(hostId, 160, "a remote host id")),
    "node.remote.control": async ([hostId, action, params] = []) =>
      handlers.nodeRemoteControl(
        text(hostId, 160, "a remote host id"),
        text(action, 32, "a remote control action"),
        params && typeof params === "object" ? params : {},
      ),
  };
}
