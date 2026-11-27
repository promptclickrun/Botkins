// Turns the desktop's whole workspace into the named parts a phone keeps in step with.
// The server versions these snapshots. An opted-in phone gets boolean stream indicators in live
// and only the missing reply and thinking text for its watched chats.

import { interned } from "./json-cache.mjs";
import { isBackgroundStep } from "./activity-steps.mjs";
import { formatFeedWork } from "./activityModel.mjs";
import { isRoutineChat } from "./routine-chat.mjs";

const PREVIEW = 160;
const STEP_TEXT = 4000;
export const CHAT_PAGE = 60;
const RUN_LIST = 80;

const clip = (text, limit) => (typeof text === "string" && text.length > limit ? text.slice(0, limit) + "…" : text);

/** A job's facts for a phone (desktop/jobs.mjs): never a path on the computer. */
function jobSummary(job) {
  return {
    where: job.where,
    state: job.state,
    ...(job.branch && { branch: job.branch }),
    ...(job.base && { base: job.base }),
    ...(job.baseSha && { baseSha: job.baseSha.slice(0, 7) }),
    ...(job.setup && { setup: job.setup }),
    ...(job.setupError && { setupError: clip(job.setupError, 600) }),
    ...(job.mergedSha && { mergedSha: job.mergedSha }),
    ...(job.carryFailed && { carryFailed: true }),
    createdAt: job.createdAt,
  };
}

/** A chat without its messages: what lists and headers need. */
function chatSummary(chat) {
  const messages = chat.messages ?? [];
  const last = messages[messages.length - 1];
  return {
    id: chat.id,
    botId: chat.botId,
    ...(chat.botIds && { botIds: chat.botIds }),
    ...(chat.hostDispatch && { hostDispatch: true }),
    ...(chat.createdBy && { createdBy: chat.createdBy }),
    title: chat.title,
    time: chat.time,
    ...(chat.pinned && { pinned: true }),
    ...(chat.archived && { archived: true }),
    ...(chat.unread && !isRoutineChat(chat) && { unread: true }),
    ...(chat.projectId && { projectId: chat.projectId }),
    ...(chat.folder && { folder: chat.folder }),
    ...(chat.mode && { mode: chat.mode }),
    ...(chat.job && { job: jobSummary(chat.job) }),
    ...(chat.panelId && { panelId: chat.panelId }),
    // How many tabs the chat's side pane has; the tabs themselves come with the chat's detail.
    ...(Array.isArray(chat.pane?.panels) && chat.pane.panels.length > 0 && { panes: chat.pane.panels.length }),
    ...(chat.fastMode && { fastMode: chat.fastMode }),
    ...(chat.model && { model: chat.model }),
    ...(chat.main && { main: true, activeFork: chat.activeFork, forks: chat.forks }),
    ...(chat.forkedFrom && { forkedFrom: chat.forkedFrom }),
    ...(chat.context && { context: chat.context }),
    ...(chat.schedules?.length && { schedules: chat.schedules }),
    count: messages.length,
    ...(last && { last: { role: last.role, text: clip(String(last.text ?? "").trim(), PREVIEW), ...(last.time && { time: last.time }), ...(last.botId && { botId: last.botId }) } }),
  };
}

function runSummary(run) {
  const work = formatFeedWork(run);
  return {
    id: run.id,
    chatId: run.chatId,
    ...(run.forkId && { forkId: run.forkId }),
    title: run.title,
    time: run.time,
    status: run.status,
    ...(run.detail && { detail: clip(run.detail, 400) }),
    ...(run.trigger && { trigger: run.trigger }),
    ...(run.finished && { finished: run.finished }),
    ...(work.summary && { summary: work.summary }),
    ...(work.kinds.length > 0 && { stepKinds: work.kinds }),
    ...(work.stepCount > 0 && { stepCount: work.stepCount }),
    ...(work.failedCount > 0 && { failedCount: work.failedCount }),
    ...(run.panelId && { panelId: run.panelId }),
    ...(run.scheduleId != null && { scheduleId: run.scheduleId }),
    ...(run.notifyTargets && { notifyTargets: run.notifyTargets }),
    ...(run.usage && { usage: run.usage }),
  };
}

/**
 * A step as a chat shows it, long tool text cut. A step that did not change since the last page is
 * the same object again (`interned`), which is what lets the link keep its JSON instead of writing
 * every step of a long turn again each time the reply grows.
 */
const clippedStep = (s) => interned(s, (s) => ({ ...s, ...(s.input?.length > STEP_TEXT && isBackgroundStep(s) && { background: true }), ...(s.input && { input: clip(s.input, STEP_TEXT) }), ...(s.output && { output: clip(s.output, STEP_TEXT) }) }));

/** A run as a chat shows it. Long tool text is cut: a phone shows the start of it. */
function runDetail(run) {
  return {
    ...run,
    ...(run.steps && { steps: run.steps.map(clippedStep) }),
    ...(run.teamwork && { teamwork: run.teamwork.map((ask) => ({ ...ask, ...(ask.steps && { steps: ask.steps.map(clippedStep) }) })) }),
  };
}

/**
 * The installed plugins ("plugins-v1", docs/plugins.md), as phones are sent them. The app already
 * sends no secret's value; a secret field's `value` is dropped here as well, whatever the app sent.
 */
function pluginsPart(plugins) {
  return plugins.map((plugin) => (Array.isArray(plugin?.config) ? { ...plugin, config: plugin.config.map((field) => (field?.secret ? (({ value: _value, ...rest }) => rest)(field) : field)) } : plugin));
}

/**
 * The parts every paired phone follows. `looks` is the Botkin saved for each bot, by bot id.
 * `link` holds what the link itself keeps: the public list of credentials and the screen mode.
 */
export function baseParts(state, info, looks = {}, link = {}) {
  const active = Object.keys(state.streams ?? {});
  return {
    meta: info,
    settings: state.settings ?? {},
    // The Proactive agent: the computer's switch, and each proactive bot's settings and log (desktop/link/team.mjs cuts it for a member).
    proactive: state.proactive ?? { enabled: false, bots: {} },
    bots: (state.bots ?? []).map((bot) => (looks[bot.id] ? { ...bot, look: looks[bot.id] } : bot)),
    sections: state.sections ?? [],
    chats: (state.chats ?? []).map(chatSummary),
    live: {
      streams: state.streams ?? {},
      intents: state.intents ?? {},
      thinking: state.thinking ?? {},
      speakers: state.speakers ?? {},
      queued: state.queued ?? {},
      requests: state.requests ?? [],
      active,
      // Whether a message sent now steers the turn under way (the desktop app's "Steer now") or waits ("Send next").
      ...(state.steerable && typeof state.steerable === "object" && { steerable: state.steerable }),
      // People currently typing in each shared chat ("chat-typing-v1"): only ids and display names, never draft text.
      ...(link.typing && typeof link.typing === "object" && Object.keys(link.typing).length > 0 && { typing: link.typing }),
    },
    runs: (state.runs ?? []).slice(0, RUN_LIST).map(runSummary),
    panels: state.panels ?? [],
    board: state.board ?? [],
    tasks: state.tasks ?? [],
    workflows: state.workflows ?? [],
    workflowRuns: (state.workflowRuns ?? []).slice(0, RUN_LIST),
    channels: state.channels ?? [],
    projects: state.projects ?? [],
    mcp: state.mcpServers ?? [],
    skills: state.skills ?? { folders: [], plugins: [], disabled: [] },
    templates: state.templates ?? [],
    // `artifacts` goes up when the index of what bots made changes, so an open list can ask again. An app without that index says nothing.
    revs: { wiki: state.wiki?.revision ?? 0, providers: state.providers?.revision ?? 0, ...(Number.isFinite(state.artifacts?.revision) && { artifacts: state.artifacts.revision }) },
    credentials: link.credentials ?? [],
    // A host with no window of its own says so, with whether it has a display now; and a level that was
    // set from a phone says which phone and when (grant.mjs). A computer with its own settings page says neither.
    // An app without plugins sends no such part.
    ...(Array.isArray(state.plugins) && { plugins: pluginsPart(state.plugins) }),
    host: { screen: link.screen ?? "off", relay: link.relay === true, ...(link.headless && { headless: true, display: link.display ?? { available: false } }), ...(link.screenSetBy && { screenSetBy: link.screenSetBy }) },
  };
}

/** The same activity as full live, with just presence and first text for each body. */
export function quietLive(live) {
  const flags = (map) => Object.fromEntries(Object.entries(map).map(([id, text]) => [id, !!text]));
  return { ...live, streams: flags(live.streams), thinking: flags(live.thinking) };
}

/**
 * A phone that asked for text in chunks ("text-chunks-v1") gets thinking, and any text that waits for a
 * sentence's end, at most this often. Each answer through the relay is two billed relay messages
 * (the phone's request and the computer's answer, 20 to 1; relay/README.md, "Pricing notes").
 */
export const CHUNK_MS = 2000;
/**
 * The reply's own text goes this often, cut after a whole word, and the first words of a reply go at
 * once. At 650 ms a phone that follows a reply costs the relay about 9 requests a minute (0.15 a
 * second), against 3 a minute at 2 s. The Free plan's 100,000 a day is then about 10,000 minutes
 * of following a reply, for every phone and computer on the relay together. A phone draws each chunk
 * whole, with no animation between two.
 */
export const CHUNK_LIVE_MS = 650;
/** Text held for want of a complete sentence goes anyway after this long, or once it is this long. */
export const CHUNK_HOLD_MAX_MS = 6000;
export const CHUNK_HOLD_MAX_CHARS = 1200;

const SENTENCE_ENDS = ".!?…";
const CLOSERS = "\"')]”’*_";
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "dr", "st"]);
const isSpace = (char) => /\s/.test(char);
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;

/** Whether the period at `at` ends a list marker ("12."), an abbreviation ("e.g.") or an initial ("J."). */
function notSentenceEnd(text, at) {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  if (/^\s*\d+$/.test(text.slice(lineStart, at))) return true;
  let start = at;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) start--;
  const word = text.slice(start, at);
  return (word.length === 1 && /[A-Z]/.test(word)) || ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Where to cut `text` between `from` and `to` so what is sent ends complete: after the last line end,
 * or after the whitespace that follows a sentence's end. Inside a ``` code block only a line end counts.
 * `from` when there is none.
 */
export function completeUpTo(text, from, to) {
  const fences = [];
  for (let at = text.indexOf("```"); at >= 0 && at < to; at = text.indexOf("```", at + 3)) fences.push(at);
  const inCode = (at) => fences.filter((fence) => fence < at).length % 2 === 1;
  for (let i = to - 1; i >= from; i--) {
    if (text[i] === "\n") return i + 1;
    if (!isSpace(text[i])) continue;
    let end = i - 1;
    while (end >= 0 && CLOSERS.includes(text[end])) end--;
    if (end < 0 || !SENTENCE_ENDS.includes(text[end]) || inCode(end)) continue;
    if (text[end] === "." && notSentenceEnd(text, end)) continue;
    return i + 1;
  }
  return from;
}

/** Text with no spaces between words (Han and kana, and the full-width marks) may be cut after any one of its characters. */
const spaceless = (code) => (code >= 0x3000 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);

/**
 * Where to cut `text` between `from` and `to` after a whole word: after the last whitespace, or after
 * a character of a script written without spaces. Not after a word that may not be finished (the one
 * at the end, which only a space after it completes). `from` when there is none.
 */
export function wordUpTo(text, from, to) {
  for (let i = to - 1; i >= from; i--) if (isSpace(text[i]) || spaceless(text.charCodeAt(i))) return i + 1;
  return from;
}

/** The cut when nothing complete came for too long: after the last whitespace, or all of it. Never inside a surrogate pair. */
export function looseUpTo(text, from, to) {
  let cut = to;
  for (let i = to - 1; i >= from; i--) {
    if (isSpace(text[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut > from && isHigh(text.charCodeAt(cut - 1))) cut--;
  return cut;
}

/**
 * A `textDelta` cut to complete sentences and lines, for a phone that asked for chunks. `loose` (held
 * too long) cuts at a word instead when nothing is complete. `live` cuts the reply's own text
 * (`stream`) after any whole word instead, so it can go every `CHUNK_LIVE_MS`; thinking keeps to
 * sentences and lines. `held` says text is left for later; `delta` is undefined when nothing is worth
 * sending yet.
 */
export function chunkDelta(text, delta, cursor, loose, live = false) {
  if (!delta) return { delta, held: false };
  let held = false;
  let any = false;
  const cut = (field) => {
    const { from, add } = delta[field];
    const body = text[field];
    const to = from + add.length;
    let at = live && field === "stream" ? wordUpTo(body, from, to) : completeUpTo(body, from, to);
    if (at === from && add && (loose || add.length > CHUNK_HOLD_MAX_CHARS)) at = looseUpTo(body, from, to);
    if (at < to) held = true;
    if (at > from) any = true;
    return { from, add: body.slice(from, at) };
  };
  const next = { id: delta.id, stream: cut("stream"), thinking: cut("thinking") };
  // Nothing new to show: a phone on this text already, or holding none, waits for more.
  const caughtUp = cursor?.id === delta.id && cursor.stream === delta.stream.from && cursor.thinking === delta.thinking.from;
  if (!any && (!cursor || caughtUp)) return { delta: undefined, held };
  return { delta: next, held };
}

/** Missing UTF-16 suffixes for one watcher. Null clears a held body and undefined means caught up. */
export function textDelta(text, cursor) {
  if (!text) return cursor ? null : undefined;
  const matches = cursor?.id === text.id && cursor.stream <= text.stream.length && cursor.thinking <= text.thinking.length;
  if (matches && cursor.stream === text.stream.length && cursor.thinking === text.thinking.length) return undefined;
  const suffix = (field) => {
    const from = matches ? cursor[field] : 0;
    return { from, add: text[field].slice(from) };
  };
  return { id: text.id, stream: suffix("stream"), thinking: suffix("thinking") };
}

/** Missing suffixes for each reasoning item. `previous` is the last snapshot the host actually sent. */
export function reasoningDelta(current, previous) {
  if (!current) return previous ? null : undefined;
  const reset = previous?.run !== current.run;
  const previousItems = reset ? [] : previous.items;
  const old = new Map(previousItems.map((item) => [item.id, item]));
  const order = current.items.map((item) => item.id);
  const currentIds = new Set(order);
  const remove = previousItems.filter((item) => !currentIds.has(item.id)).map((item) => item.id);
  const reordered = reset || order.length !== previousItems.length || order.some((id, i) => id !== previousItems[i].id);
  const items = [];
  for (const { text, ...meta } of current.items) {
    const prior = old.get(meta.id);
    if (prior && prior.text === text && prior.started === meta.started && prior.finished === meta.finished && prior.botId === meta.botId) continue;
    const from = prior && text.startsWith(prior.text) ? prior.text.length : 0;
    items.push({ ...meta, from, add: text.slice(from) });
  }
  if (!reordered && !remove.length && !items.length) return undefined;
  return { run: current.run, ...(reset && { reset: true }), ...(remove.length && { remove }), ...(reordered && { order }), items };
}

/** Runs by chat id, newest first, for the chats asked for. */
export function runsByChat(state, chatIds) {
  const wanted = new Map(chatIds.map((id) => [id, []]));
  if (wanted.size) for (const run of state.runs ?? []) wanted.get(run.chatId)?.push(run);
  return wanted;
}

/** The longest input or output a light step keeps. Longer ones are fetched when the step is opened. */
export const LIGHT_STEP_TEXT = 400;
/** Steps that a chat draws from their input or output, so they keep both: a question the bot asked. */
const KEEPS_TEXT = /^(ask_user|ask)$/i;

/**
 * A run for a client that asked for light steps ("step-details-v1"): a step's input and output stay
 * only when they are short, when the chat itself reads them (a question), or when the step started
 * a helper. Any other step says `more: true` instead, and the client asks for it with `link.step`.
 * Most of a long turn's bytes are these two fields, and a chat only shows them when a step is opened.
 */
export function lightRun(run) {
  if (!run || !Array.isArray(run.steps)) return run;
  const helpers = new Set((run.agents ?? []).map((agent) => agent.id));
  const light = (step) => {
    const long = (text) => typeof text === "string" && text.length > LIGHT_STEP_TEXT;
    if ((!long(step.input) && !long(step.output)) || KEEPS_TEXT.test(step.name ?? "") || helpers.has(step.id)) return step;
    const { input, output, ...rest } = step;
    return { ...rest, ...(long(input) && isBackgroundStep(step) && { background: true }), ...(!long(input) && input !== undefined && { input }), ...(!long(output) && output !== undefined && { output }), more: true };
  };
  return {
    ...run,
    steps: run.steps.map(light),
    ...(run.teamwork && { teamwork: run.teamwork.map((ask) => ({ ...ask, ...(ask.steps && { steps: ask.steps.map(light) }) })) }),
  };
}
/** A chat's page, or a chat's run part, with light steps. */
export const lightPart = (part) => (!part ? part : Array.isArray(part.runs) ? { ...part, runs: part.runs.map(lightRun) } : lightRun(part));

/** While a negotiated append client follows a run, body-sized fields are fetched at completion. */
export function compactWorkingRun(run, light = true) {
  if (!run || run.status !== "Working") return run;
  const { reasoning: _reasoning, ...rest } = light ? lightRun(run) : run;
  return _reasoning?.length ? { ...rest, hasReasoning: true } : rest;
}

/** One step's input and output, as a client that holds light steps asks for them. Null when the step is gone. */
export function stepDetail(state, chatId, runId, stepId) {
  const run = (state.runs ?? []).find((r) => r.id === runId && r.chatId === chatId);
  if (!run) return null;
  const all = [...(run.steps ?? []), ...(run.teamwork ?? []).flatMap((ask) => ask.steps ?? [])];
  const step = all.find((s) => s.id === stepId);
  if (!step) return null;
  return { ...(step.input && { input: clip(step.input, STEP_TEXT) }), ...(step.output && { output: clip(step.output, STEP_TEXT) }) };
}

/**
 * One chat's page of messages, with the finished runs they point to. `before` is the index of the
 * first message already held; the page ends just before it.
 */
export function chatPart(state, chatId, runs = runsByChat(state, [chatId]).get(chatId) ?? [], { before, limit = CHAT_PAGE } = {}) {
  const chat = (state.chats ?? []).find((c) => c.id === chatId);
  if (!chat) return null;
  const all = chat.messages ?? [];
  const end = Number.isInteger(before) ? Math.max(0, Math.min(before, all.length)) : all.length;
  const from = Math.max(0, end - limit);
  const messages = all.slice(from, end).map((message) => interned(message, ({ context: _context, ...rest }) => rest));
  const ids = new Set(messages.map((m) => m.runId).filter(Boolean));
  // Older group chats kept the task list on the run alone.
  const todos = chat.todos ?? (chat.botIds?.length > 1 ? runs.find((run) => run.todos)?.todos : undefined);
  return {
    id: chatId,
    ...(chat.main && { activeFork: chat.activeFork }),
    from,
    total: all.length,
    messages,
    runs: runs.filter((run) => ids.has(run.id) && run.status !== "Working").map(runDetail),
    ...(todos && { todos }),
    // The side pane a bot opened beside this chat: its tabs, the one in front, and the latest ask.
    ...(chat.pane && typeof chat.pane === "object" && { pane: chat.pane }),
  };
}

/** The run a chat is working on right now, or its latest one that has no reply yet (a failure). */
export function runPart(state, chatId, runs = runsByChat(state, [chatId]).get(chatId) ?? []) {
  const chat = (state.chats ?? []).find((c) => c.id === chatId);
  if (!chat) return null;
  // Text a bot wrote on the way ("turn-timeline-v1": `interim`) is not a reply.
  const answered = new Set((chat.messages ?? []).filter((m) => m.role !== "user" && !m.interim).map((m) => m.runId).filter(Boolean));
  if (chat.main) runs = runs.filter(r => r.forkId === chat.activeFork);
  const run = runs.find((r) => r.status === "Working") ?? (runs[0] && !answered.has(runs[0].id) ? runs[0] : null);
  return run ? runDetail(run) : null;
}
