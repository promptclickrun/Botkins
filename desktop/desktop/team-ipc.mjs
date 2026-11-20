/** Owner-only IPC calls shared by the Electron window and tests. */
export function teamHandlers(link) {
  const call = (method, ...args) => {
    const host = link();
    if (!host) throw new Error("Phone access is still opening. Try again.");
    return host[method](...args);
  };
  return {
    team: () => call("team"),
    saveTeamRole: (role) => call("saveRole", role),
    deleteTeamRole: (id) => call("deleteRole", id),
    saveTeamGroup: (group) => call("saveGroup", group),
    deleteTeamGroup: (id, moveTo) => call("deleteGroup", id, moveTo),
    createTeamInvite: (options) => call("createInvite", options),
    revokeTeamInvite: (id) => call("revokeInvite", id),
    approveTeamRequest: (id, groupId) => call("approve", id, groupId),
    denyTeamRequest: (id) => call("deny", id),
    moveTeamMember: (id, groupId) => call("moveMember", id, groupId),
    removeTeamMember: (id) => call("removeMember", id),
    renameTeam: (name) => call("renameTeam", name),
  };
}
