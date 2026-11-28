// A call from a paired device, on its way to the app's handlers: the link backend's `call`.
// LinkHost passes only names in REMOTE_METHODS, and has already checked what the caller may do.
import { deviceArgs } from "./folders.mjs";
import { bundleCreateRefusal, roleOfMember } from "./link/team.mjs";

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
  // A bot's Proactive agent is changed, and its alerts are acted on, as the person who calls.
  mainChat: 1, changeMainFork: 4, addBot: 1, duplicateBot: 1, importAgents: 1, setProactiveChatMode: 1,
  setBotProactive: 2, proactiveAct: 3, reactToMessage: 4, "chat.a2uiAction": 2, "chat.a2uiFunction": 2,
};

/**
 * The arguments of a call as a person's: a message the person sends, or a turn they send again, may be a script command
 * (desktop/script-commands.mjs). A call that comes from the window (main.mjs) or from a paired device (below) is a person's;
 * a call from the control socket is not, unless the person agreed (desktop/terminal/control.mjs). `send` takes it as an option
 * in its third argument, `retry` in its second.
 */
export function asPerson(name, args) {
  if (name === "send") return [args[0], args[1], { ...(args[2] && typeof args[2] === "object" ? args[2] : {}), allowScript: true }, ...args.slice(3)];
  if (name === "retry") return [args[0], { allowScript: true }];
  return args;
}

export function deviceCall({ workspace, handlers, folders }) {
  return async (name, args, context = {}) => {
    // A paired device is a person (the owner, or a member whose role the computer checked before this call).
    // A gadget's send is a person's words too, but spoken and transcribed: it never runs a script command.
    const checked = context.gadget ? await deviceArgs(folders, name, args) : asPerson(name, await deviceArgs(folders, name, args));
    const principal = context.principal;
    const member = principal?.kind === "member" ? { memberId: principal.memberId, name: principal.name } : null;
    // A request is gone once it is answered, so its chat is read before the answer goes in.
    // Requests wait in `workspace.interactions`; `workspace.state` has no list of them.
    const answeredIn = member && name === "respond" ? workspace.interactions.snapshot().find((item) => item.id === args[0])?.chatId : null;
    // A member's message carries their name with it, wherever `send` puts it: in the chat now, in
    // the queue, or into the turn under way.
    // An answer to a question that outlived its turn becomes the answerer's next message, so it says who they are.
    const callArgs = member && name === "send" ? [checked[0], checked[1], { ...(checked[2] ?? {}), author: member }] : name === "respond" ? [checked[0], checked[1], member?.memberId ?? "owner"] : checked;
    if (name === "recordVoiceLine") return handlers[name](checked[0], checked[1], checked[2], checked[3], member, checked[4]);
    // A script command is the owner's to remove, turn off or replace, whatever a member's role lets them do to a skill (desktop/script-commands.mjs).
    if (member) {
      if (name === "workflowRetryRun" && checked[2]?.allowUncertainRetry === true) {
        throw new Error("Only the owner can retry an uncertain GitHub action.");
      }
      const names = name === "removeSkill" || name === "setSkillEnabled" ? [checked[0]] : name === "skills.upload" ? checked[0]?.replace : name === "skillsCatalog.install" ? checked[1] : [];
      const scripts = workspace.state.skills?.scripts ?? {};
      if (Array.isArray(names) && names.some((skill) => typeof skill === "string" && Object.hasOwn(scripts, skill))) throw new Error("Only the owner can remove, turn off or replace a script command.");
    }
    // A separate link container can have an older version or an earlier snapshot of these routines.
    if (member && (name === "addBot" || name === "duplicateBot")) {
      const bundle = name === "addBot" ? checked[0]?.bundle : workspace.bundleForBot(workspace.bot(checked[0]), member.memberId);
      if (bundle) {
        const refusal = bundleCreateRefusal(roleOfMember(workspace.teamOf(), member.memberId)?.perms, bundle);
        if (refusal) throw new Error(refusal);
      }
    }
    // A member's menu lists the script commands only when their role may use skills ("script-commands-v1").
    if (member && name === "catalog") return handlers.catalog(checked[0], checked[1], checked[2], member.memberId);
    if (member) {
      // The fork can contain private history. Stamp its creator before the first save or snapshot.
      if (name === "forkChat") return workspace.forkChat(checked[0], checked[1], member.memberId);
      if (name === "createChat") return workspace.createChat(checked[0], undefined, undefined, member.memberId);
      if (name === "mentionables") return workspace.mentions.candidates(checked[0], checked[1], member.memberId);
      if (name === "createRoutine") return workspace.panels.routines.createWithModel(checked[0] ?? {}, undefined, member.memberId);
      if (name === "updateRoutine") return workspace.panels.routines.updateWithModel(checked[0], checked[1] ?? {}, undefined, member.memberId);
      if (name === "duplicateRoutine") return workspace.panels.routines.duplicate(checked[0], checked[1], undefined, member.memberId);
    }
    if (Object.hasOwn(FOR_A_PERSON, name)) return handlers[name](...Array.from({ length: FOR_A_PERSON[name] }, (_, at) => checked[at]), member ? member.memberId : "owner");
    const result = await handlers[name](...callArgs);
    if (member) {
      if (name === "createGroupChat" && typeof result === "string") {
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
