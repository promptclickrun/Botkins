/**
 * Tells the link a chat is gone, so it forgets who was invited into it. A chat deleted through the
 * link is forgotten there; this is for one deleted in the window. A link without chat people, or
 * one that is still opening, has nothing to forget.
 */
export function forgetChatPeople(link, chatId) {
  try {
    link()?.removeChatPeople?.(String(chatId));
  } catch (error) {
    console.error("Chat people:", error.message);
  }
}

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
    // The people in a chat (the link's "team-people-v1"): who started it and who was invited.
    chatPeople: (chatId) => call("chatPeople", String(chatId)),
    inviteToChat: (chatId, personId) => call("inviteToChat", String(chatId), String(personId)),
    removeFromChat: (chatId, personId) => call("removeFromChat", String(chatId), String(personId)),
  };
}
