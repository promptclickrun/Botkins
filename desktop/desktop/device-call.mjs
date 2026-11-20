// A call from a paired device, on its way to the app's handlers: the link backend's `call`.
// LinkHost passes only names in REMOTE_METHODS, and has already checked what the caller may do.
import { deviceArgs } from "./folders.mjs";

/**
 * Makes the link backend's `call(name, args, context)`.
 *
 * A project's folder sent by a paired device must be one the folder browser could have shown, as
 * for the calls that pick a folder. What a team member does is marked as theirs: a chat they
 * start, a message they send, and their answer to a bot's request. Nobody else's message is.
 */
export function deviceCall({ workspace, handlers, folders }) {
  return async (name, args, context = {}) => {
    const checked = await deviceArgs(folders, name, args);
    const principal = context.principal;
    const member = principal?.kind === "member" ? { memberId: principal.memberId, name: principal.name } : null;
    // A request is gone once it is answered, so its chat is read before the answer goes in.
    // Requests wait in `workspace.interactions`; `workspace.state` has no list of them.
    const answeredIn = member && name === "respond" ? workspace.interactions.snapshot().find((item) => item.id === args[0])?.chatId : null;
    // A member's message carries their name with it, wherever `send` puts it: in the chat now, in
    // the queue, or into the turn under way.
    const callArgs = member && name === "send" ? [checked[0], checked[1], { ...(checked[2] ?? {}), author: member }] : checked;
    const result = await handlers[name](...callArgs);
    if (member) {
      if (["createChat", "createGroupChat", "forkChat"].includes(name) && typeof result === "string") {
        const chat = workspace.state.chats.find((item) => item.id === result);
        if (chat) chat.createdBy = member.memberId;
      }
      // Their answer's line in the chat is found by its request. An answer that left no line
      // (an approval outside a run, a routine with no output) marks nothing.
      if (name === "respond") {
        const chat = workspace.state.chats.find((item) => item.id === answeredIn);
        const receipt = chat?.messages.find((item) => item.answer?.requestId === args[0]);
        if (receipt) receipt.author = member;
      }
      workspace.save();
    }
    return result;
  };
}
