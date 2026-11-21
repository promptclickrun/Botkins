// Spaces and panels: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<word>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// A space is a page of panels and cards, and a panel is something a bot publishes and refreshes
// (docs/spaces.md, `spaces-v1`). Whoever reaches the socket is the owner, so every call here is made as
// the owner's own window makes it: the app's calls get no person (`spaces.*`) or "owner" (`changePanel`,
// `routine`, `refreshPanel`, `boardAct`). The owner can open and change every space on the computer, also
// the spaces that a team member made.
//
// The names are `space.*`, `panel.*` and `card.*`, not the app's `spaces.*`: these calls find things by
// name, and so a call here must never be taken for the app's call of the same name.
//
// Each call is thin: it finds a space, a panel, a card, a bot or a project by the name a person typed and
// hands the work to the app's own call, which checks what it is given. Some rules are here:
//  - `space.remove` and `panel.remove` take away panels, their routines and their views, and a routine's
//    prompt, so they need the mark `{ agreed: true }` as the last argument: the caller showed what goes and
//    got a yes. So does `panel.routine.remove`, `panel.noteRemove`, and `card.act` with the action delete.
//  - A panel's routine runs a bot on a schedule with nobody watching. A schedule that runs more often than
//    the app's own limit for a bot's routine (`slowEnough`: 15 minutes) needs the mark `{ fastSchedule: true }`,
//    as `routines.add` does. `panel.routine.review` says what a routine will be before it is saved.
//  - `panel.new`, `space.ask`, `panel.ask` and `panel.refresh` start a turn of a bot's model.
import { nextTime } from "../panels.mjs";
import { compileCadence, slowEnough } from "../routines.mjs";
import { STARTS } from "../spaces.mjs";
import { DOWN_REASONS, GOAL_CATEGORIES, BOARD_KINDS } from "../board.mjs";
import { meaning } from "./control-routines.mjs";
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const iso = (time) => (time ? new Date(time).toISOString() : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const shortList = (entries, label) => entries.slice(0, 5).map((entry) => label(entry) + " (" + entry.id + ")").join(", ") + (entries.length > 5 ? " and " + (entries.length - 5) + " more" : "");
/**
 * One of a list by its id, or by its label: the exact label first, then the start of a label, then the start of an id (6
 * characters at least). When more than one matches, the answer says which ones.
 */
function pick(list, ref, what, see, label = (entry) => entry.name) {
  const wanted = text(ref, 200, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  for (const match of [(entry) => String(label(entry) ?? "").toLowerCase() === lower, (entry) => String(label(entry) ?? "").toLowerCase().startsWith(lower), (entry) => wanted.length >= 6 && entry.id.startsWith(wanted)]) {
    const found = list.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new ControlError("More than one " + what + " matches " + wanted + ": " + shortList(found, label) + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  }
  throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
}
const oneOf = (list, value, what) => {
  if (!list.includes(value)) throw new ControlError(what + " is one of " + list.join(", ") + ".", "BAD_ARGUMENT");
  return value;
};

// ── A panel's routine ──
// (Copied from control-routines.mjs, which keeps these to itself: how often a schedule runs at its fastest.)
const series = (cron, zone, first, count) => {
  const out = [first];
  while (out.length < count) out.push(nextTime(cron, zone, out.at(-1)));
  return out;
};
/** How often a repeating schedule runs at its fastest, in whole minutes, when it runs more often than a bot's own routine tool allows (the app's `slowEnough`); else null. */
const fastEvery = (cron, zone, now) => {
  if (!cron || slowEnough(cron)) return null;
  const times = series(cron, zone, nextTime(cron, zone, now), 21);
  return Math.max(1, Math.round(Math.min(...times.slice(1).map((time, index) => time - times[index])) / 60_000));
};
const FAST_SENTENCE = (minutes) => "This schedule runs as often as every " + (minutes === 1 ? "minute" : minutes + " minutes") + ". Each run uses one model turn, and a model turn can cost money.";
const needsFastAgreement = (minutes) =>
  new ControlError(FAST_SENTENCE(minutes) + " Show it to the person and ask first. `botkins panels` does that and needs --yes. A call to the socket carries { fastSchedule: true } as its last argument once the person agreed.", "NEEDS_AGREEMENT");
const needsAgreement = (what) => new ControlError(what + " Show that to the person and ask first. `botkins` does that and needs --yes. A call to the socket carries { agreed: true } as its last argument once the person agreed.", "NEEDS_AGREEMENT");
/** The mark the caller puts last: `{ agreed?, fastSchedule? }`, or nothing. */
const markOf = (value) => (isObject(value) ? value : {});

/**
 * The schedule that a caller names, as { cron, timezone, cadence }: a cron line (`cron`), or a kind (`cadence`:
 * daily, weekdays or weekly) with `at` and, for weekly, `days`. The app's own `compileCadence` checks it. A panel's
 * routine repeats, so a one-time schedule is refused.
 */
function schedule(spec) {
  if (!isObject(spec)) throw new ControlError("Say when it refreshes.", "BAD_ARGUMENT");
  const kind = spec.cadence ?? (spec.cron !== undefined ? "custom" : undefined);
  if (spec.cron !== undefined && spec.cadence !== undefined && spec.cadence !== "custom") throw new ControlError("A cron line is for the cadence custom.", "BAD_ARGUMENT");
  if (!kind) throw new ControlError("Say when it refreshes: a cadence (daily, weekdays or weekly) with a time, or a cron line.", "BAD_ARGUMENT");
  if (kind === "once") throw new ControlError("A panel's routine repeats. Choose daily, weekdays, weekly or a cron line.", "BAD_ARGUMENT");
  try {
    const compiled = compileCadence({ kind, ...(spec.at !== undefined && { time: spec.at }), ...(spec.days !== undefined && { days: spec.days }), ...(spec.cron !== undefined && { cron: spec.cron }) }, spec.timezone);
    return { cron: compiled.cron, timezone: compiled.timezone, cadence: compiled.cadence };
  } catch (error) {
    throw new ControlError(String(error?.message ?? error), "BAD_ARGUMENT");
  }
}

const PANEL_CHANGES = ["hide", "show", "small", "wide", "tall", "earlier", "later"];
const CARD_ACTIONS = ["read", "unread", "clear", "done", "reopen", "yes", "goal", "notToday", "up", "down", "delete"];
const CARD_STATUSES = ["open", "done", "cleared"];

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function spacesApi({ workspace, handlers, bot }) {
  const state = () => workspace.state;
  const spaces = () => state().spaces ?? [];
  const panels = () => state().panels ?? [];
  const cards = () => state().board ?? [];
  const botName = (id) => state().bots.find((entry) => entry.id === id)?.name ?? null;
  const projectOf = (id) => {
    const found = id && (state().projects ?? []).find((entry) => entry.id === id);
    return found ? { id: found.id, name: found.name } : null;
  };
  const project = (ref) => pick(state().projects ?? [], ref, "project", "botkins projects list");
  const personName = (id) => workspace.spaces.named(id).name;

  /** A space by its id or name. A name is looked for among the owner's own spaces first (every person has a Today, a Feed, Ideas and Goals); another person's space is found by its id. */
  const space = (ref) => {
    try {
      return pick(spaces().filter((entry) => !entry.createdBy), ref, "space", "botkins spaces list");
    } catch (error) {
      if (error.code !== "NOT_FOUND") throw error;
      return pick(spaces(), ref, "space", "botkins spaces list");
    }
  };
  /** A panel by its id or title, in one space when `inSpace` is given. */
  const panel = (ref, inSpace) => pick(inSpace ? panels().filter((entry) => entry.spaceId === inSpace.id) : panels(), ref, "panel", "botkins panels list", (entry) => entry.title);
  const card = (ref) => pick(cards(), ref, "card", "botkins cards list", (entry) => entry.title);
  const spaceNamed = (entry) => ({ id: entry.id, name: entry.name });
  const panelNamed = (entry) => ({ id: entry.id, title: entry.title });
  const panelsOf = (entry) => workspace.spaces.panels(entry.id);
  const viewsOf = (list) => list.reduce((sum, item) => sum + (item.blocks ?? []).filter((block) => block.type === "html").length, 0);

  const spaceView = (entry) => {
    const inside = panelsOf(entry);
    const there = workspace.spaces.cards(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      ...(entry.builtin && { builtin: entry.builtin }),
      maker: entry.createdBy ? personName(entry.createdBy) : "owner",
      mine: !entry.createdBy,
      project: projectOf(entry.projectId),
      panels: inside.length,
      routines: inside.filter((item) => item.routine).length,
      views: viewsOf(inside),
      cards: { open: there.filter((item) => item.status === "open").length, total: there.length },
      rev: entry.rev ?? 0,
      createdAt: iso(entry.createdAt),
      updatedAt: iso(entry.updatedAt),
    };
  };
  const routineView = (routine, withPrompt) => {
    if (!routine) return null;
    const fastMinutes = fastEvery(routine.cron, routine.timezone, Date.now());
    return {
      cron: routine.cron,
      timezone: routine.timezone,
      meaning: meaning({ kind: "custom", cron: routine.cron }),
      enabled: routine.enabled !== false,
      nextAt: routine.enabled !== false ? iso(routine.nextAt) : null,
      ...(routine.setBy && { setBy: personName(routine.setBy) }),
      ...(fastMinutes && { fastMinutes }),
      ...(withPrompt && { prompt: routine.prompt }),
    };
  };
  const panelSummary = (p) => ({
    id: p.id,
    key: p.key,
    title: p.title,
    bot: botName(p.botId),
    botId: p.botId,
    space: spaceNamed(workspace.spaces.of(p)),
    size: p.size ?? "wide",
    hidden: !!p.hidden,
    project: projectOf(p.projectId),
    revision: p.revision ?? 0,
    updatedAt: iso(p.updatedAt),
    refreshing: !!(p.refreshChatId && workspace.active.has(p.refreshChatId)),
    routine: routineView(p.routine, false),
    blocks: (p.blocks ?? []).length,
    views: viewsOf([p]),
    notes: (p.notes ?? []).length,
    hasState: p.state !== undefined,
    ...(p.createdBy && { createdBy: personName(p.createdBy) }),
  });
  /** A panel whole: what it shows (its blocks as the bot published them), the saved state of an app panel, and its notes. */
  const panelView = (p) => ({
    ...panelSummary(p),
    routine: routineView(p.routine, true),
    blocks: p.blocks ?? [],
    state: p.state ?? null,
    stateRev: p.stateRev ?? 0,
    notes: (p.notes ?? []).map((note, index) => ({ id: note.id, position: index + 1, by: note.name, text: note.text, at: iso(note.at) })),
    last: p.last ? { by: p.last.name, ...(p.last.label && { label: p.last.label }), at: iso(p.last.at) } : null,
    asks: p.asks ?? [],
    ...(p.chatId && { chatId: p.chatId }),
    ...(p.refreshChatId && { refreshChatId: p.refreshChatId }),
  });
  const cardView = (c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    body: c.body ?? "",
    links: c.links ?? [],
    ...(c.category && { category: c.category }),
    status: c.status,
    read: !!c.read,
    ...(c.answer && { answer: c.answer }),
    ...(c.rating && { rating: c.rating }),
    ...(c.reason && { reason: c.reason }),
    ...(c.snoozedUntil > Date.now() && { notToday: true }),
    bot: botName(c.botId),
    botId: c.botId,
    ...(c.source && { source: c.source }),
    space: spaceNamed(workspace.spaces.of(c)),
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  });

  /** What a routine will be, before it is saved: the bot, the schedule in words, the next two times and the prompt. `p` is the panel that gets it, or null for a panel that is not made yet (then `spec.bot` is its bot). */
  const reviewOf = (p, spec) => {
    const when = schedule(spec);
    const prompt = text(spec.prompt, 4000, "the refresh instructions (what the bot does at each refresh, up to 4,000 characters)");
    const now = Date.now();
    const owner = p ? { id: p.botId, name: botName(p.botId) } : (({ id, name }) => ({ id, name }))(bot(spec.bot));
    const fastMinutes = fastEvery(when.cron, when.timezone, now);
    return {
      ...(p && { panel: panelNamed(p), replaces: routineView(p.routine, false) }),
      bot: owner.name,
      botId: owner.id,
      cron: when.cron,
      timezone: when.timezone,
      meaning: meaning(when.cadence),
      next: series(when.cron, when.timezone, nextTime(when.cron, when.timezone, now), 2).map(iso),
      prompt,
      ...(fastMinutes && { fastMinutes }),
    };
  };
  /** The panel's routine, or a refusal when it has none. */
  const routineOf = (p) => {
    if (!p.routine) throw new ControlError("The panel " + p.title + " has no routine. Give it one with `botkins panels routine set`.", "NO_ROUTINE");
    return p.routine;
  };

  /** A note of a panel by its id, its place in the list (1 is the first), or the start of its id. */
  const note = (p, ref) => {
    const notes = p.notes ?? [];
    const number = typeof ref === "number" ? String(ref) : typeof ref === "string" && /^[1-9][0-9]{0,2}$/.test(ref.trim()) ? ref.trim() : null;
    if (number && notes[Number(number) - 1] && !notes.some((item) => item.id === number)) return notes[Number(number) - 1];
    return pick(notes, ref, "note", "botkins panels show", (item) => item.id);
  };
  /** A refresh that is running is not started twice. */
  const idle = (p) => {
    if (p.refreshChatId && workspace.active.has(p.refreshChatId)) throw new ControlError("The panel " + p.title + " is refreshing already.", "BUSY");
  };

  return {
    // ── Spaces ──
    /** Every space on this computer: the owner's four and the others, with what each holds. */
    "space.list": () => spaces().map(spaceView).sort((a, b) => Number(b.mine) - Number(a.mine)),
    /** One space with its panels (a summary of each) and its cards. */
    "space.get"([ref]) {
      const found = space(ref);
      // The app's own read, as the owner's window makes it.
      const answer = handlers["spaces.read"](found.id);
      return { ...spaceView(found), panelList: answer.panels.map(panelSummary), cardList: answer.cards.map(cardView) };
    },
    async "space.add"([name]) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 40) throw new ControlError("Give the space a name (40 characters at most).", "BAD_ARGUMENT");
      const id = await handlers["spaces.create"]({ name });
      return spaceView(space(id));
    },
    async "space.rename"([ref, name]) {
      const found = space(ref);
      if (typeof name !== "string" || !name.trim() || name.trim().length > 40) throw new ControlError("Give the space a name (40 characters at most).", "BAD_ARGUMENT");
      await handlers["spaces.rename"](found.id, name);
      return spaceView(space(found.id));
    },
    /** Deletes the space with its panels, their routines, their refresh chats and their views, and its cards. The caller has to say it showed that: `{ agreed: true }`. */
    async "space.remove"([ref, mark]) {
      const found = space(ref);
      const view = spaceView(found);
      if (!markOf(mark).agreed) throw needsAgreement("This removes the space " + found.name + " with its " + view.panels + " panels, their " + view.routines + " routines, their " + view.views + " views and its " + view.cards.total + " cards.");
      await handlers["spaces.remove"](found.id);
      return { removed: found.id, name: found.name, panels: view.panels, routines: view.routines, views: view.views, cards: view.cards.total };
    },
    /** Attaches the space to a project, or (a null project) takes it off. Only the owner's own spaces go with a project (the app's rule). */
    async "space.project"([ref, projectRef]) {
      const found = space(ref);
      await handlers["spaces.setProject"](found.id, projectRef === null || projectRef === undefined ? null : project(projectRef).id);
      return spaceView(space(found.id));
    },
    /**
     * Starts a chat with a bot about the space: a turn of the bot's model. `options`: { bot, text, panel? } (a panel of the
     * space makes the chat about that panel). Answers { chatId }; the bot's answer goes on in that chat.
     */
    async "space.ask"([ref, options = {}]) {
      const found = space(ref);
      if (!isObject(options)) throw new ControlError("Give the bot and the message.", "BAD_ARGUMENT");
      const owner = bot(options.bot);
      const about = options.panel === undefined ? null : panel(options.panel, found);
      const asked = await handlers["spaces.ask"]({ spaceId: found.id, botId: owner.id, text: text(options.text, 32000, "the message (up to 32,000 characters)"), ...(about && { panelId: about.id }) });
      return { chatId: asked.chatId, space: spaceNamed(found), bot: { id: owner.id, name: owner.name }, ...(about && { panel: panelNamed(about) }) };
    },

    // ── Panels ──
    /** The panels, in the order they are kept. `options`: { space?, bot? }. */
    "panel.list"([options = {}]) {
      if (!isObject(options)) throw new ControlError("Give the options as an object.", "BAD_ARGUMENT");
      const inSpace = options.space === undefined ? null : space(options.space);
      const only = options.bot === undefined ? null : bot(options.bot).id;
      return panels()
        .filter((p) => (!inSpace || p.spaceId === inSpace.id) && (!only || p.botId === only))
        .map(panelSummary);
    },
    /** One panel whole. `ref` is its id or title; `options.space` narrows a title. */
    "panel.get"([ref, options = {}]) {
      return panelView(panel(ref, options?.space === undefined ? null : space(options.space)));
    },
    /** Hide, show, size or order: `action` is one of hide, show, small, wide, tall, earlier, later. A panel's removal is `panel.remove`. */
    async "panel.change"([ref, action]) {
      const found = panel(ref);
      oneOf(PANEL_CHANGES, action, "A change");
      await handlers.changePanel(found.id, action);
      return { ...panelSummary(panel(found.id)), action };
    },
    /** Takes the panel away with its routine, its views and its saved state. The caller has to say it showed that: `{ agreed: true }`. */
    async "panel.remove"([ref, mark]) {
      const found = panel(ref);
      const view = panelSummary(found);
      if (!markOf(mark).agreed) throw needsAgreement("This removes the panel " + found.title + (view.routine ? ", its routine" : "") + (view.views ? ", its " + view.views + " views" : "") + (view.notes ? " and its " + view.notes + " notes" : "") + ".");
      await handlers.changePanel(found.id, "delete");
      return { removed: found.id, title: found.title, space: view.space, routine: !!view.routine, views: view.views, notes: view.notes };
    },
    /** Puts the panel in a space, at its end or (`options.before`, a panel of that space) before one of its panels. */
    async "panel.move"([ref, spaceRef, options = {}]) {
      const found = panel(ref);
      const to = space(spaceRef);
      const before = options?.before === undefined ? null : panel(options.before, to);
      await handlers["spaces.movePanel"](found.id, { spaceId: to.id, before: before?.id ?? null });
      return panelSummary(panel(found.id));
    },
    /** Attaches the panel to a project, or (a null project) takes it off. */
    async "panel.project"([ref, projectRef]) {
      const found = panel(ref);
      await handlers["spaces.setPanelProject"](found.id, projectRef === null || projectRef === undefined ? null : project(projectRef).id);
      return panelSummary(panel(found.id));
    },
    /** Has the panel's bot refresh it now: a turn of the bot's model, in the panel's own chat. It does not wait for the turn. */
    async "panel.refresh"([ref]) {
      const found = panel(ref);
      idle(found);
      await handlers.refreshPanel(found.id);
      return { ...panelSummary(panel(found.id)), started: true, chatId: panel(found.id).refreshChatId ?? null };
    },
    /**
     * Starts a chat with a bot that makes a new panel in a space from the person's sentence: a turn of the bot's model.
     * `data`: { space, bot, text, start?, refresh?, project? }. `refresh` is a schedule, `{ cron }` or `{ cadence, at, days? }`
     * with `timezone?`, and the panel then has a routine that runs the sentence. A schedule that is fast needs `{ fastSchedule: true }`.
     */
    async "panel.new"([data, mark]) {
      if (!isObject(data)) throw new ControlError("Give the space, the bot and a sentence.", "BAD_ARGUMENT");
      const into = space(data.space);
      const owner = bot(data.bot);
      const sentence = text(data.text, 4000, "a sentence that says what the panel is for (up to 4,000 characters)");
      const start = data.start === undefined ? undefined : oneOf(Object.keys(STARTS), data.start, "A start");
      const chosen = data.project === undefined ? null : project(data.project);
      let refresh;
      let review = null;
      if (data.refresh !== undefined) {
        review = reviewOf(null, { ...data.refresh, bot: owner.id, prompt: sentence });
        if (review.fastMinutes && !markOf(mark).fastSchedule) throw needsFastAgreement(review.fastMinutes);
        refresh = { cron: review.cron, timezone: review.timezone };
      }
      const made = await handlers["spaces.newPanel"]({ spaceId: into.id, botId: owner.id, prompt: sentence, ...(start && { start }), ...(refresh && { refresh }), ...(chosen && { projectId: chosen.id }) });
      return { chatId: made.chatId, space: spaceNamed(into), bot: { id: owner.id, name: owner.name }, ...(start && { start }), ...(chosen && { project: { id: chosen.id, name: chosen.name } }), ...(review && { routine: review }) };
    },
    /** Starts a chat with a bot about one panel: a turn of the bot's model. `options`: { bot, text }. */
    async "panel.ask"([ref, options = {}]) {
      const found = panel(ref);
      if (!isObject(options)) throw new ControlError("Give the bot and the message.", "BAD_ARGUMENT");
      const owner = bot(options.bot);
      const asked = await handlers["spaces.ask"]({ spaceId: found.spaceId, botId: owner.id, text: text(options.text, 32000, "the message (up to 32,000 characters)"), panelId: found.id });
      return { chatId: asked.chatId, panel: panelNamed(found), space: spaceNamed(workspace.spaces.of(found)), bot: { id: owner.id, name: owner.name } };
    },

    // ── A panel's routine: a bot refreshes the panel on a schedule, with nobody watching ──
    /** What a routine will be, before it is saved. `ref` is the panel, or null for a panel that is not made yet. `spec`: { cron | cadence + at + days?, timezone?, prompt, bot? }. Nothing is changed. */
    "panel.routine.review"([ref, spec]) {
      return reviewOf(ref === null || ref === undefined ? null : panel(ref), spec);
    },
    /** Sets the panel's routine (a new one, or in place of the old one). A schedule that is fast needs `{ fastSchedule: true }` as the last argument. */
    async "panel.routine.set"([ref, spec, mark]) {
      const found = panel(ref);
      const review = reviewOf(found, spec);
      if (review.fastMinutes && !markOf(mark).fastSchedule) throw needsFastAgreement(review.fastMinutes);
      await handlers.routine(found.id, { action: "set", cron: review.cron, timezone: review.timezone, prompt: review.prompt });
      return panelView(panel(found.id));
    },
    async "panel.routine.pause"([ref]) {
      const found = panel(ref);
      routineOf(found);
      await handlers.routine(found.id, { action: "pause" });
      return panelView(panel(found.id));
    },
    /** Turns the routine on again. A schedule that is fast needs `{ fastSchedule: true }`. */
    async "panel.routine.resume"([ref, mark]) {
      const found = panel(ref);
      const routine = routineOf(found);
      const fast = fastEvery(routine.cron, routine.timezone, Date.now());
      if (fast && !markOf(mark).fastSchedule) throw needsFastAgreement(fast);
      await handlers.routine(found.id, { action: "resume" });
      return panelView(panel(found.id));
    },
    /** Takes the routine away, with its prompt. The caller has to say it showed that: `{ agreed: true }`. */
    async "panel.routine.remove"([ref, mark]) {
      const found = panel(ref);
      routineOf(found);
      if (!markOf(mark).agreed) throw needsAgreement("This removes the routine of the panel " + found.title + ", with its prompt.");
      await handlers.routine(found.id, { action: "remove" });
      return panelView(panel(found.id));
    },

    // ── What people do in a panel: a value of an app panel's saved state, and notes ──
    /** Merges keys into an app panel's saved state, as the owner's change (a null value takes a key away). `label` is a few words for the panel's last line. Answers the new revision and the keys. */
    async "panel.state"([ref, patch, label]) {
      const found = panel(ref);
      if (!isObject(patch)) throw new ControlError("Give the keys to set as an object (a null value takes a key away).", "BAD_ARGUMENT");
      const done = await handlers["spaces.patchState"](found.id, patch, label);
      return { panel: panelNamed(found), rev: done.rev, keys: Object.keys(panel(found.id).state ?? {}) };
    },
    async "panel.note"([ref, words]) {
      const found = panel(ref);
      const id = await handlers["spaces.note"](found.id, text(words, 2000, "the note (up to 2,000 characters)"));
      const written = (panel(found.id).notes ?? []).find((item) => item.id === id);
      return { panel: panelNamed(found), note: { id, by: written?.name, text: written?.text, at: iso(written?.at) } };
    },
    /** Takes a note away, which cannot be got back. The caller has to say it showed that: `{ agreed: true }`. */
    async "panel.noteRemove"([ref, which, mark]) {
      const found = panel(ref);
      const target = note(found, which);
      if (!markOf(mark).agreed) throw needsAgreement("This removes a note from the panel " + found.title + ", and it cannot be got back.");
      await handlers["spaces.removeNote"](found.id, target.id);
      return { panel: panelNamed(found), removed: target.id };
    },

    // ── The cards of Feed, Ideas and Goals ──
    /** The cards, newest first. `options`: { space?, kind?, status?, bot? }. */
    "card.list"([options = {}]) {
      if (!isObject(options)) throw new ControlError("Give the options as an object.", "BAD_ARGUMENT");
      const inSpace = options.space === undefined ? null : space(options.space);
      const only = options.bot === undefined ? null : bot(options.bot).id;
      const kind = options.kind === undefined ? null : oneOf(BOARD_KINDS, options.kind, "A kind");
      const status = options.status === undefined ? null : oneOf(CARD_STATUSES, options.status, "A status");
      return cards()
        .filter((c) => (!inSpace || c.spaceId === inSpace.id) && (!only || c.botId === only) && (!kind || c.kind === kind) && (!status || c.status === status))
        .map(cardView);
    },
    "card.get": ([ref]) => cardView(card(ref)),
    /**
     * What a person does with a card, as the owner (the app's `boardAct`): read, unread, clear, done, reopen; yes (an idea: Let's do it);
     * goal (an idea becomes a goal, with a category in `value`); notToday (a goal); up, down (`value` is a reason of a thumbs down); delete.
     * A delete needs `{ agreed: true }` as the last argument.
     */
    async "card.act"([ref, action, value, mark]) {
      const found = card(ref);
      oneOf(CARD_ACTIONS, action, "An action");
      if (action === "goal" && value != null) oneOf(GOAL_CATEGORIES, value, "A goal's category");
      if (action === "down" && value != null) oneOf(DOWN_REASONS, value, "A reason");
      if (action === "delete" && !markOf(mark).agreed) throw needsAgreement("This deletes the card " + found.title + ".");
      const before = cardView(found);
      const created = await handlers.boardAct(found.id, action, value ?? undefined);
      const after = cards().find((c) => c.id === found.id);
      const goal = created && cards().find((c) => c.id === created);
      return { card: after ? cardView(after) : before, action, ...(action === "delete" && { deleted: true }), ...(goal && { created: cardView(goal) }) };
    },
  };
}
