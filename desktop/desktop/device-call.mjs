// A call from a paired device, on its way to the app's handlers: the link backend's `call`.
// LinkHost passes only names in REMOTE_METHODS, and has already checked what the caller may do.
import { deviceArgs } from "./folders.mjs";

/**
 * Makes the link backend's `call(name, args, context)`.
 *
 * A project's folder sent by a paired device must be one the folder browser could have shown, as
 * for the calls that pick a folder. What a team member does is marked as theirs: a chat they
 * start, a message they send, and their answer to a bot's request.
 */
export function deviceCall({ workspace, handlers, folders }) {
  return async (name, args, context = {}) => {
    const checked = await deviceArgs(folders, name, args);
    // A request is gone once it is answered, so its chat is read before the answer goes in.
    // Requests wait in `workspace.interactions`; `workspace.state` has no list of them.
    const responseChatId = name === "respond" ? workspace.interactions.snapshot().find((item) => item.id === args[0])?.chatId : null;
    const principal = context.principal;
    const callArgs =
      principal?.kind === "member" && name === "send"
        ? [checked[0], checked[1], { ...(checked[2] ?? {}), author: { memberId: principal.memberId, name: principal.name } }]
        : checked;
    const result = await handlers[name](...callArgs);
    if (principal?.kind === "member") {
      if (["createChat", "createGroupChat", "forkChat"].includes(name) && typeof result === "string") {
        const chat = workspace.state.chats.find((item) => item.id === result);
        if (chat) chat.createdBy = principal.memberId;
      }
      if (name === "send" || name === "respond") {
        const chatId = name === "send" ? args[0] : responseChatId;
        const chat = workspace.state.chats.find((item) => item.id === chatId);
        const message = [...(chat?.messages ?? [])].reverse().find((item) => item.role === "user" && !item.author);
        if (message) message.author = { memberId: principal.memberId, name: principal.name };
      }
      workspace.save();
    }
    return result;
  };
}
