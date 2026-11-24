// A call from a paired device, on its way to the app's handlers: the link backend's `call`.
// LinkHost passes only names in REMOTE_METHODS, and has already checked what the caller may do.
import { deviceArgs } from "./folders.mjs";

/**
 * Makes the link backend's `call(name, args, context)`.
 *
 * A project's folder sent by a paired device must be one the folder browser could have shown, as
 * for the calls that pick a folder. What a team member does is marked as theirs: a chat they
 * start, a message they send, a routine they make or copy, and their answer to a bot's request.
 * Nobody else's message is. A member is offered only what is theirs to mention, and a live voice
 * they start is told nothing from the owner's notes.
 */
/**
 * The calls that are about a space, a panel or a card, with how many arguments each takes. The
 * person who called ("owner" or a member's id) goes in after those, in the same place whatever
 * the device left out; a handler never reads the person from what the device sent.
 */
const FOR_A_PERSON = {
  "spaces.read": 1, "spaces.create": 1, "spaces.rename": 2, "spaces.remove": 1, "spaces.setProject": 2, "spaces.setPanelProject": 2,
  "spaces.newPanel": 1, "spaces.ask": 1, "spaces.movePanel": 2, "spaces.patchState": 3, "spaces.note": 2, "spaces.removeNote": 2,
  changePanel: 2, routine: 2, refreshPanel: 1, boardAct: 3,
  // A bot's Proactive agent works for the person who sets it up.
  setBotProactive: 2, reactToMessage: 4,
};

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
    if (name === "recordVoiceLine") return handlers[name](checked[0], checked[1], checked[2], checked[3], member, checked[4]);
    if (member) {
      // These four take the member's id beside what the device sent; a handler never reads it from the device.
      if (name === "mentionables") return workspace.mentions.candidates(checked[0], checked[1], member.memberId);
      if (name === "createRoutine") return workspace.panels.routines.createWithModel(checked[0] ?? {}, undefined, member.memberId);
      if (name === "updateRoutine") return workspace.panels.routines.updateWithModel(checked[0], checked[1] ?? {}, undefined, member.memberId);
      if (name === "duplicateRoutine") return workspace.panels.routines.duplicate(checked[0], checked[1], undefined, member.memberId);
    }
    if (Object.hasOwn(FOR_A_PERSON, name)) return handlers[name](...Array.from({ length: FOR_A_PERSON[name] }, (_, at) => checked[at]), member ? member.memberId : "owner");
    const result = await handlers[name](...callArgs);
    if (member) {
      // A bot a member makes or copies is marked as theirs. One without the mark is the owner's.
      if (["addBot", "duplicateBot"].includes(name) && typeof result === "string") {
        const bot = workspace.state.bots.find((item) => item.id === result);
        if (bot) bot.createdBy = member.memberId;
      }
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
