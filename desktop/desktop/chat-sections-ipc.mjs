// Sections on the Chats page ("chat-sections-v1"): a person's own way to group their chats. The
// link keeps them, not the workspace. The window's calls have the link's own names, so the same
// names reach another computer's link when one is in use (remotehosts.mjs passes "link." on as it
// is). On this computer the window is the owner.

const OPENING = "Phone access is still opening. Try again.";
const OLDER = "Sections need a newer phone link than this copy of Botkins has.";

/** The window's calls for chat sections, each made on the link as the owner. */
export function chatSectionHandlers(link) {
  const call = (method, ...args) => {
    const host = link();
    if (!host) throw new Error(OPENING);
    if (typeof host[method] !== "function") throw new Error(OLDER);
    return host[method]("owner", ...args);
  };
  return {
    "link.chats.addSection": (name) => call("addChatSection", name),
    "link.chats.renameSection": (id, name) => call("renameChatSection", id, name),
    "link.chats.deleteSection": (id) => call("deleteChatSection", id),
    "link.chats.orderSections": (ids) => call("orderChatSections", ids),
    "link.chats.setSection": (chatId, sectionId) => call("setChatSection", chatId, sectionId ?? null),
  };
}

/**
 * The window's snapshot with the owner's chat sections: the list in their order, and each chat
 * with the section it is in (left out for a chat in none). A link without sections adds nothing,
 * which is how the window knows this computer has none.
 */
export function withOwnerChatSections(state, host) {
  if (typeof host?.chatSectionsFor !== "function") return state;
  let held;
  try {
    held = host.chatSectionsFor("owner");
  } catch (error) {
    console.error("Chat sections:", error.message);
    return state;
  }
  const list = Array.isArray(held?.list) ? held.list.map((section) => ({ id: section.id, name: section.name })) : [];
  const of = held?.of && typeof held.of === "object" ? held.of : {};
  const chats = (state.chats ?? []).map((chat) => {
    // A chat in no section goes on as it is, the same object: nothing about it is changed here.
    if (!Object.hasOwn(chat, "sectionId") && !Object.hasOwn(of, chat.id)) return chat;
    const { sectionId: _old, ...rest } = chat;
    return Object.hasOwn(of, chat.id) ? { ...rest, sectionId: of[chat.id] } : rest;
  });
  return { ...state, chatSections: list, chats };
}
