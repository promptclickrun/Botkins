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
    "node.setup": async ([name] = []) => handlers.nodeSetup({ name: text(name, 80, "a name for this node host") }),
    "node.rename": async ([name] = []) => handlers.nodeRename(text(name, 80, "a name for this node host")),
    "node.pause": async ([paused] = []) => handlers.nodePause(paused === true),
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
