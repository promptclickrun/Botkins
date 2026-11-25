// Chats: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// What the Chats page of the window does to a chat, and the sections of that page. A chat is named by
// its id, or by its title: exactly, or by the start of it when only one chat starts so. Talking in a
// chat is `chat.*` (desktop/terminal/control.mjs); the calls here keep the chat, they do not talk.
//
// The sections are a person's own way to group chats. The phone link keeps them (desktop/link/chat-sections.mjs),
// and the app's calls for them are `link.chats.*` (desktop/chat-sections-ipc.mjs). They are read from the
// window's snapshot, which holds the list and the section of each chat.
import { ControlError } from "./socket.mjs";

const MODES = ["default", "plan", "yolo"];
const FLAGS = ["pinned", "archived", "unread"];
const SECTIONS = "link.chats.";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
/** A short form of a title for a sentence that says which chats match. */
const brief = (value) => JSON.stringify(String(value ?? "").slice(0, 50));
/** One of a list by its id, or by its name exactly, or by the start of its name when only one has it. */
function pick(list, ref, { what, see, name = (entry) => entry.name }) {
  const wanted = text(ref, 300, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const named = (entry) => String(name(entry) ?? "").toLowerCase();
  const exact = list.filter((entry) => named(entry) === lower);
  const found = exact.length ? exact : list.filter((entry) => named(entry).startsWith(lower));
  if (found.length > 1) throw new ControlError("More than one " + what + " matches " + brief(wanted) + ": " + found.slice(0, 5).map((entry) => brief(name(entry)) + " (" + entry.id + ")").join(", ") + (found.length > 5 ? " and " + (found.length - 5) + " more" : "") + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  if (!found.length) throw new ControlError("There is no " + what + " called " + brief(wanted) + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
  return found[0];
}

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function chatsApi({ workspace, handlers, bot }) {
  const state = () => workspace.state;
  const chat = (ref) => {
    const wanted = typeof ref === "string" ? ref.trim() : "";
    // A chat that is only a scratch space (a temporary chat) is found by its id and not by its title.
    const byId = state().chats.find((entry) => entry.id === wanted);
    return byId ?? pick(state().chats.filter((entry) => !entry.temporary), ref, { what: "chat", see: "botkins chats list", name: (entry) => entry.title });
  };
  const lookup = (ref) => pick(state().projects ?? [], ref, { what: "project" });
  /** The project and the mode that a `chats.project` call asks for, checked: `{ project, mode }`. */
  const aimOf = (found, options) => {
    const { project: to, none, mode } = options && typeof options === "object" && !Array.isArray(options) ? options : {};
    if (to === undefined && none !== true && mode === undefined && options?.folder === undefined) throw new ControlError("Give a project, none, or a mode.", "BAD_ARGUMENT");
    if (to !== undefined && none === true) throw new ControlError("Give a project, or none, not both.", "BAD_ARGUMENT");
    if (mode !== undefined && !MODES.includes(mode)) throw new ControlError("A mode is one of " + MODES.join(", ") + ".", "BAD_ARGUMENT");
    const project = none === true ? null : to === undefined ? (state().projects ?? []).find((entry) => entry.id === found.projectId) ?? null : lookup(to);
    return { project, mode: mode ?? (project && project.id !== found.projectId ? project.mode : found.mode) ?? "default" };
  };
  /** The owner's sections, `{ list: [{ id, name }], of: { chatId: sectionId } }`, or null when the phone link keeps none (it is still opening, or too old). */
  const held = () => {
    let snapshot;
    try {
      snapshot = handlers.snapshot();
    } catch {
      return null;
    }
    if (!Array.isArray(snapshot?.chatSections)) return null;
    return { list: snapshot.chatSections, of: Object.fromEntries((snapshot.chats ?? []).filter((entry) => entry.sectionId).map((entry) => [entry.id, entry.sectionId])) };
  };
  const sections = () => {
    const found = held();
    if (!found) throw new ControlError("The sections are kept by the phone link, and it is not ready on this computer yet (it is still opening, or it is too old). Try again in a moment.", "UNSUPPORTED");
    return found;
  };
  const section = (ref) => pick(sections().list, ref, { what: "section", see: "botkins chats sections" });
  /** The newest turn of a chat whose message the chat still holds (runs are kept newest first). */
  const latestTurn = (found) => state().runs.find((entry) => entry.chatId === found.id && found.messages.some((message) => message.role === "user" && message.runId === entry.id));
  const queued = (id) => workspace.snapshot().queued?.[id] ?? [];
  /** A chat as the command line shows it. `of` is the owner's sections, when the call has them. */
  const view = (entry, of) => {
    const members = Array.isArray(entry.botIds) && entry.botIds.length >= 2 ? entry.botIds : null;
    const botOf = (id) => state().bots.find((candidate) => candidate.id === id)?.name ?? null;
    const sectionId = of?.of?.[entry.id] ?? null;
    return {
      id: entry.id,
      title: entry.title,
      ...(entry.main && { main: true, activeFork: entry.activeFork, forks: entry.forks }),
      botId: entry.botId,
      bot: botOf(entry.botId),
      ...(members && { group: true, bots: members.map(botOf) }),
      messages: entry.messages.length,
      working: workspace.active.has(entry.id),
      pinned: entry.pinned === true,
      archived: entry.archived === true,
      unread: entry.unread === true,
      projectId: entry.projectId ?? null,
      ...(entry.projectId && { folder: workspace.projects.folderFor(entry) }),
      project: (state().projects ?? []).find((candidate) => candidate.id === entry.projectId)?.name ?? null,
      mode: entry.mode ?? "default",
      ...(of && { sectionId, section: of.list.find((candidate) => candidate.id === sectionId)?.name ?? null }),
      time: entry.time ? new Date(entry.time).toISOString() : null,
    };
  };
  /** A waiting message of a chat, by its id or by its place in the line (1 is the first). */
  const waiting = (found, ref) => {
    const list = queued(found.id);
    const wanted = String(ref ?? "").trim();
    const item = list.find((entry) => entry.id === wanted) ?? (/^[1-9]\d{0,2}$/.test(wanted) ? list[Number(wanted) - 1] : undefined);
    if (!item) throw new ControlError("This chat has no waiting message " + brief(wanted) + ". See `botkins chats queue " + found.id + "`.", "NOT_FOUND");
    return item;
  };

  return {
    // ── The chats ──
    /** Every chat that is not a scratch space, newest first, with its sections. `{ bot }` keeps one bot's chats. */
    "chats.list": ([options = {}] = []) => {
      const only = options?.bot ? bot(options.bot).id : null;
      const of = held();
      return state().chats.filter((entry) => !entry.temporary && (!only || entry.botId === only || entry.botIds?.includes(only))).map((entry) => view(entry, of));
    },
    /** One chat, with the turn that `chats.retry` would send again. */
    "chats.get": ([ref]) => {
      const found = chat(ref);
      const latest = latestTurn(found);
      return { ...view(found, held()), ...(latest && { latestTurn: { id: latest.id, status: latest.status ?? null, ...(latest.time && { time: new Date(latest.time).toISOString() }) } }) };
    },
    async "chats.rename"([ref, title]) {
      const found = chat(ref);
      await handlers.renameChat(found.id, text(title, 120, "the chat a title (up to 120 characters)"));
      return view(chat(found.id));
    },
    async "chats.regenerateTitle"([ref]) {
      const found = chat(ref);
      await handlers.regenerateChatTitle(found.id);
      return view(chat(found.id));
    },
    /** Removes the chat with its messages and its runs. It cannot be undone, and a chat that works is refused. */
    async "chats.delete"([ref]) {
      const found = chat(ref);
      await handlers.deleteChat(found.id);
      return { removed: found.id, id: found.id, title: found.title };
    },
    async "chats.react"([ref, index, emoji]) {
      const found = chat(ref);
      await handlers.reactToMessage(found.id, index, found.messages[index]?.time ?? null, emoji);
      return { id: found.id, index, emoji };
    },
    /** A new chat of the same bot with the conversation up to a message (`at`: its place in the chat, 0 is the first; the last without it). */
    async "chats.fork"([ref, at, inMain]) {
      const found = chat(ref);
      if (!found.messages.length) throw new ControlError("This chat has no message to fork from.", "BAD_ARGUMENT");
      const index = at === undefined || at === null ? found.messages.length - 1 : at;
      if (!Number.isInteger(index) || index < 0 || index >= found.messages.length) throw new ControlError("Choose a message from 0 to " + (found.messages.length - 1) + ".", "BAD_ARGUMENT");
      const id = inMain === true ? await handlers.changeMainFork(found.id, "fork", index) : await handlers.forkChat(found.id, index);
      return { ...view(chat(id)), from: found.id, at: index };
    },
    /** Starts a turn of the chat's model that summarizes the conversation (the runtime's own /compact). It answers when the turn has started. */
    async "chats.reset"([ref]) {
      const found = chat(ref);
      await handlers.changeMainFork(found.id, "reset");
      return view(found);
    },
    async "chats.switchFork"([ref, fork]) {
      const found = chat(ref);
      await handlers.changeMainFork(found.id, "switch", fork);
      return view(found);
    },
    "chats.compact"([ref]) {
      const found = chat(ref);
      handlers.compact(found.id);
      return { ...view(found), started: true };
    },
    /** `patch` holds the flags to set: pinned, archived, unread, each true or false. */
    async "chats.flags"([ref, patch]) {
      const found = chat(ref);
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw new ControlError("Give a flag to set: " + FLAGS.join(", ") + ".", "BAD_ARGUMENT");
      for (const [key, value] of Object.entries(patch)) if (!FLAGS.includes(key) || typeof value !== "boolean") throw new ControlError("A chat's flags are " + FLAGS.join(", ") + ", each true or false.", "BAD_ARGUMENT");
      await handlers.setChatFlags(found.id, patch);
      return view(chat(found.id));
    },
    /**
     * What `chats.project` would do, and nothing of it done: the chat, the project it would be in (with its folder) and the mode
     * that is asked for. The command shows this before it asks for the yes that yolo needs.
     */
    "chats.projectLook"([ref, options]) {
      const found = chat(ref);
      const aim = aimOf(found, options);
      const project = aim.project;
      return { id: found.id, title: found.title, projectId: project?.id ?? null, project: project?.name ?? null, folder: options.folder ?? (found.projectId === project?.id && found.folder || project?.folder) ?? null, mode: aim.mode };
    },
    /**
     * The project of a chat and the way it works there. `options` holds `project` (a project's name or id) or
     * `none: true`, and `mode` (default, plan or yolo). What it leaves out stays as it is.
     * Yolo gives each request of the bot in the chat a yes with no question (but for one that leaves the sandbox), so it
     * needs `agreed: true`: the mark of a caller that showed this to the person, or that is the person (`--yes` of the command).
     */
    async "chats.project"([ref, options]) {
      const found = chat(ref);
      const aim = aimOf(found, options);
      if (aim.mode === "yolo" && options.agreed !== true) throw new ControlError("Yolo mode gives each request of the bot in this chat a yes with no question, but for one that leaves the sandbox. Give agreed: true. `botkins chats project <chat> --mode yolo --yes` does so after it shows what the mode gives.", "BAD_ARGUMENT");
      await handlers.setChatProject(found.id, aim.project?.id ?? null, aim.mode, options.folder);
      return view(chat(found.id));
    },
    /** A group chat of 2 to 6 bots, each named once. */
    async "chats.group"([bots, title]) {
      if (!Array.isArray(bots) || !bots.length) throw new ControlError("Give the bots of the group chat.", "BAD_ARGUMENT");
      const id = await handlers.createGroupChat(bots.map((ref) => bot(ref).id), title === undefined || title === null ? undefined : text(title, 120, "the chat a title (up to 120 characters)"));
      return view(chat(id));
    },
    /** Sends the message of a stopped or failed turn again, which starts a turn of the model. `ref` is the turn's id (`runs.list`), or a chat, for its latest turn. */
    "chats.retry"([ref]) {
      const wanted = typeof ref === "string" ? ref.trim() : "";
      const run = state().runs.find((entry) => entry.id === wanted) ?? (() => {
        const own = latestTurn(chat(ref));
        if (!own) throw new ControlError("This chat has no turn to send again.", "NOT_FOUND");
        return own;
      })();
      const found = chat(run.chatId);
      if (workspace.active.has(found.id)) throw new ControlError("This chat is working. Wait for it to finish, or stop it, before you send a turn again.", "BAD_ARGUMENT");
      handlers.retry(run.id);
      return { ...view(found), runId: run.id, started: true };
    },
    /** The messages that wait for the chat to be free, in order: { position, id, text }. */
    "chats.queue": ([ref]) => queued(chat(ref).id).map((entry, index) => ({ position: index + 1, id: entry.id, text: String(entry.text ?? "").slice(0, 500), attachments: entry.attachments?.length ?? 0 })),
    /** Takes a waiting message out of the line. `item` is its id or its position. */
    async "chats.unqueue"([ref, item]) {
      const found = chat(ref);
      const message = waiting(found, item);
      await handlers.unqueue(found.id, message.id);
      return { id: found.id, title: found.title, item: message.id, removed: true };
    },
    /** Moves a waiting message to the front and sends it now: into the turn that works, when the model takes it, or as the next turn. */
    async "chats.sendNow"([ref, item]) {
      const found = chat(ref);
      const message = waiting(found, item);
      await handlers.sendNow(found.id, message.id);
      return { id: found.id, title: found.title, item: message.id, sent: true };
    },
    /** What "@" and "#" offer in a chat's message box: its projects, wiki pages, files and bots. For a chat not yet made, give a bot instead. */
    "chats.mentions"([ref, botRef]) {
      if ((ref === undefined || ref === null) === (botRef === undefined || botRef === null)) throw new ControlError("Give a chat, or a bot, not both.", "BAD_ARGUMENT");
      return ref === undefined || ref === null ? handlers.mentionables(null, bot(botRef).id) : handlers.mentionables(chat(ref).id, undefined);
    },
    /** A side question: the chat's model answers it from the conversation, and the answer is not added to the chat. It starts a turn of the model. */
    async "chats.aside"([ref, question]) {
      const found = chat(ref);
      const answer = await handlers.sideQuestion(found.id, text(question, 32000, "a question"));
      return { id: found.id, title: found.title, answer };
    },

    // ── The sections of the Chats page ──
    /** The owner's sections in their order, each with how many chats are in it. */
    "chats.sections": () => {
      const { list, of } = sections();
      const inside = new Set(state().chats.filter((entry) => !entry.temporary).map((entry) => entry.id));
      const chats = Object.entries(of).filter(([id]) => inside.has(id));
      return { sections: list.map((entry) => ({ id: entry.id, name: entry.name, chats: chats.filter(([, sectionId]) => sectionId === entry.id).length })), without: inside.size - chats.length };
    },
    async "chats.sections.add"([name]) {
      const given = text(name, 200, "the section a name");
      const id = await handlers[SECTIONS + "addSection"](given);
      return { id, name: sections().list.find((entry) => entry.id === id)?.name ?? given };
    },
    async "chats.sections.rename"([ref, name]) {
      const found = section(ref);
      await handlers[SECTIONS + "renameSection"](found.id, text(name, 200, "the section a name"));
      return { id: found.id, name: sections().list.find((entry) => entry.id === found.id)?.name };
    },
    /** The section goes. Its chats stay, in no section. */
    async "chats.sections.delete"([ref]) {
      const found = section(ref);
      await handlers[SECTIONS + "deleteSection"](found.id);
      return { removed: found.id, id: found.id, name: found.name };
    },
    /** The order of the sections, by name or id. Sections not named keep their place after the named ones. */
    async "chats.sections.order"([refs]) {
      if (!Array.isArray(refs) || !refs.length) throw new ControlError("Give the sections in the order you want.", "BAD_ARGUMENT");
      const ids = refs.map((ref) => section(ref).id);
      await handlers[SECTIONS + "orderSections"](ids);
      return sections().list.map((entry) => ({ id: entry.id, name: entry.name }));
    },
    /** Puts a chat in a section, or in none (`null`). */
    async "chats.sections.set"([ref, to]) {
      const found = chat(ref);
      const target = to === undefined || to === null ? null : section(to);
      await handlers[SECTIONS + "setSection"](found.id, target?.id ?? null);
      return { id: found.id, title: found.title, sectionId: target?.id ?? null, section: target?.name ?? null };
    },
  };
}
