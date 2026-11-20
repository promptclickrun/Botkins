// Turns the desktop's whole workspace into the named parts a phone keeps in step with.
// A phone asks for the parts whose version it doesn't have, so a streaming reply resends only
// "live", and a long chat's history travels once.

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
    host: { screen: link.screen ?? "off", relay: link.relay === true, ...(link.headless && { headless: true, display: link.display ?? { available: false } }), ...(link.screenSetBy && { screenSetBy: link.screenSetBy }) },
  };
}

/** Runs by chat id, newest first, for the chats asked for. */
export function runsByChat(state, chatIds) {
  const wanted = new Map(chatIds.map((id) => [id, []]));
  if (wanted.size) for (const run of state.runs ?? []) wanted.get(run.chatId)?.push(run);
  return wanted;
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
  const answered = new Set((chat.messages ?? []).filter((m) => m.role !== "user").map((m) => m.runId).filter(Boolean));
  const run = runs.find((r) => r.status === "Working") ?? (runs[0] && !answered.has(runs[0].id) ? runs[0] : null);
  return run ? runDetail(run) : null;
}
