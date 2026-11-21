// Turns the desktop's whole workspace into the named parts a phone keeps in step with.
// The server versions these snapshots. An opted-in phone gets boolean stream indicators in live
// and only the missing reply and thinking text for its watched chats.

const PREVIEW = 160;
const STEP_TEXT = 4000;
export const CHAT_PAGE = 60;
const RUN_LIST = 80;

const clip = (text, limit) => (typeof text === "string" && text.length > limit ? text.slice(0, limit) + "…" : text);

/** A chat without its messages: what lists and headers need. */
function chatSummary(chat) {
  const messages = chat.messages ?? [];
  const last = messages[messages.length - 1];
  return {
    id: chat.id,
    botId: chat.botId,
    ...(chat.botIds && { botIds: chat.botIds }),
    ...(chat.createdBy && { createdBy: chat.createdBy }),
    title: chat.title,
    time: chat.time,
    ...(chat.pinned && { pinned: true }),
    ...(chat.archived && { archived: true }),
    ...(chat.unread && { unread: true }),
    ...(chat.projectId && { projectId: chat.projectId }),
    ...(chat.mode && { mode: chat.mode }),
    ...(chat.panelId && { panelId: chat.panelId }),
    // How many tabs the chat's side pane has; the tabs themselves come with the chat's detail.
    ...(Array.isArray(chat.pane?.panels) && chat.pane.panels.length > 0 && { panes: chat.pane.panels.length }),
    ...(chat.model && { model: chat.model }),
    ...(chat.forkedFrom && { forkedFrom: chat.forkedFrom }),
    ...(chat.context && { context: chat.context }),
    ...(chat.schedules?.length && { schedules: chat.schedules }),
    count: messages.length,
    ...(last && { last: { role: last.role, text: clip(String(last.text ?? "").trim(), PREVIEW), ...(last.time && { time: last.time }), ...(last.botId && { botId: last.botId }) } }),
  };
}

function runSummary(run) {
  return {
    id: run.id,
    chatId: run.chatId,
    title: run.title,
    time: run.time,
    status: run.status,
    ...(run.detail && { detail: clip(run.detail, 400) }),
    ...(run.trigger && { trigger: run.trigger }),
    ...(run.finished && { finished: run.finished }),
    ...(run.summary && { summary: run.summary }),
    ...(run.panelId && { panelId: run.panelId }),
    ...(run.scheduleId != null && { scheduleId: run.scheduleId }),
    ...(run.usage && { usage: run.usage }),
  };
}

/** A run as a chat shows it. Long tool text is cut: a phone shows the start of it. */
function runDetail(run) {
  const step = (s) => ({ ...s, ...(s.input && { input: clip(s.input, STEP_TEXT) }), ...(s.output && { output: clip(s.output, STEP_TEXT) }) });
  return {
    ...run,
    ...(run.steps && { steps: run.steps.map(step) }),
    ...(run.teamwork && { teamwork: run.teamwork.map((ask) => ({ ...ask, ...(ask.steps && { steps: ask.steps.map(step) }) })) }),
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
    },
    runs: (state.runs ?? []).slice(0, RUN_LIST).map(runSummary),
    panels: state.panels ?? [],
    board: state.board ?? [],
    tasks: state.tasks ?? [],
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
    return { ...rest, ...(!long(input) && input !== undefined && { input }), ...(!long(output) && output !== undefined && { output }), more: true };
  };
  return {
    ...run,
    steps: run.steps.map(light),
    ...(run.teamwork && { teamwork: run.teamwork.map((ask) => ({ ...ask, ...(ask.steps && { steps: ask.steps.map(light) }) })) }),
  };
}
/** A chat's page, or a chat's run part, with light steps. */
export const lightPart = (part) => (!part ? part : Array.isArray(part.runs) ? { ...part, runs: part.runs.map(lightRun) } : lightRun(part));

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
  const messages = all.slice(from, end).map(({ context: _context, ...message }) => message);
  const ids = new Set(messages.map((m) => m.runId).filter(Boolean));
  return {
    id: chatId,
    from,
    total: all.length,
    messages,
    runs: runs.filter((run) => ids.has(run.id) && run.status !== "Working").map(runDetail),
    ...(chat.todos && { todos: chat.todos }),
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
  const run = runs.find((r) => r.status === "Working") ?? (runs[0] && !answered.has(runs[0].id) ? runs[0] : null);
  return run ? runDetail(run) : null;
}
