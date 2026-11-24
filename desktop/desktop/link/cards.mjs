// A Live Activity for a Botkin's chats ("activity-bots-v1"), or one for all Botkins' chats
// ("activity-all-v1"; docs/live-cards.md): which chats a card shows, what Apple may see of them,
// and what only the phone may see.
//
// Plain functions with no Node imports. The computer uses them for its pushes (push.mjs), and the
// phone uses the same file for the cards it draws while the app is open (src/state/cards.ts), so the
// two never show different things. Tests: tests/cards.test.ts.

/** A chat stays on its Botkin's card this long after its turn ends. (push.mjs: ACTIVITY_LINGER_MS.) */
export const CARD_LINGER_MS = 30 * 60_000;
/** The most chats one card shows; the rest are counted in `more`. */
export const CARD_CHATS = 3;
/** The sealed part is kept under this many bytes, so a push stays under Apple's 4 KB. */
export const SEALED_MAX = 2400;
/** The same for the card for all Botkins, whose rows also carry each Botkin's look in the clear. */
export const ALL_SEALED_MAX = 2000;
/** The key of the card for all Botkins. A Botkin's card is "bot:" + its id; a chat's card is the chat's id. */
export const ALL_CARD = "all";
/** What the sealed part of a card is authenticated as: never the same as an alert's ("botkins-push-v1"). */
export const CARD_AAD = "botkins-card-v1";

const TEXT = 180;
const secs = (ms) => Math.floor(ms / 1000);
const bytes = (text) => unescape(encodeURIComponent(text)).length;
const clip = (text, max) => {
  const plain = String(text ?? "").trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
};

/** The first line of some Markdown, as plain words: a banner and a card read it without marks. */
export function firstLine(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const plain = (line ?? "").replace(/^#{1,6}\s+/, "").replace(/[*_`~]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return plain.length > TEXT ? plain.slice(0, TEXT - 1) + "…" : plain;
}

/**
 * The latest sentence of a bot's thinking, at most `max` characters. A sentence still being written
 * gives way to the one before it while it is short, so the line doesn't flicker word by word.
 */
export function latestThought(text, max = 140) {
  const plain = String(text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[*_`~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const parts = (plain.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [plain]).map((part) => part.trim()).filter(Boolean);
  let last = parts[parts.length - 1] ?? plain;
  if (!/[.!?]["')\]]*$/.test(last) && parts.length > 1 && last.length < 40) last = parts[parts.length - 2];
  return last.length > max ? "…" + last.slice(-(max - 1)).trimStart() : last;
}

// The desktop app's kinds of work (desktop/canvas.mjs, workSummary; the phone's turn.ts), folded to
// the few a card has a symbol for.
const KINDS = [
  [/^(bash|powershell|shell|terminal|run_command|exec|write_bash|write_powershell|read_bash|read_powershell)$/, "run"],
  [/^(view|read|read_file|cat|open_file)$/, "read"],
  [/^(create|write|write_file|create_file|edit|str_replace|str_replace_editor|apply_patch|patch|multi_edit|insert)$/, "edit"],
  [/^(grep|glob|search|search_files|find|rg|ls|list_dir|list_directory)$/, "search"],
  [/^(web_search|search_web|bing_search|google_search|web_fetch|fetch|fetch_url|browse|browser_navigate)$/, "web"],
  [/^(task|subagent|run_subagent|delegate)$/, "helper"],
];
/** What kind of work a step is, from its tool's name: run, read, edit, search, web, helper or tool. */
export function stepKind(name) {
  const tool = String(name ?? "")
    .toLowerCase()
    .replace(/^.*[./]/, "");
  for (const [pattern, kind] of KINDS) if (pattern.test(tool)) return kind;
  return "tool";
}

// The same rule as the phone's request panel (src/features/chat/request/logic.ts, looksDangerous).
// tests/cards.test.ts keeps the two the same.
export const DANGER =
  /\brm\s+(-\w*r\w*f|-\w*f\w*r|--recursive\s+--force|--force\s+--recursive)\b|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bpush\b[^\n]*(\s-f\b|--force)|\bforce[- ]push|\bdelete\b|\bformat\b|\bmkfs\b|\bdd\s+if=|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-\w*f/i;
/** Whether a request's command or words look destructive. */
export const looksDangerous = (request) => DANGER.test([request?.preview, request?.label, request?.title].filter(Boolean).join("\n"));

/** The longest choice that is a button on a card or a notification. Longer ones are read in the app. */
export const CHOICE_MAX = 40;
/**
 * What a request's buttons are away from the app: "approve" (Deny, Allow once and, when it can be
 * remembered, Allow for this chat), "risky" (Deny, and Allow once in the app after Face ID),
 * "question" (one to three short choices, or a free answer, and Reply…), or "open" (open the app).
 */
export function askOf(request) {
  if (!request) return undefined;
  if (request.dispatch) return "open";
  if (request.kind === "permission") return looksDangerous(request) ? "risky" : "approve";
  if (request.kind === "question") {
    const choices = Array.isArray(request.choices) ? request.choices : [];
    if (!choices.length) return "question";
    if (choices.length <= 3 && choices.every((choice) => typeof choice === "string" && choice.trim() && choice.trim().length <= CHOICE_MAX && !choice.includes("\n"))) return "question";
  }
  return "open";
}

/** A request as a card and a notification carry it (sealed): its words, its command, its choices. */
export function askDetail(request) {
  const ask = askOf(request);
  const free = request.kind === "question" && (!!request.freeform || !request.choices?.length);
  return {
    id: request.id,
    k: request.dispatch ? "open" : request.kind,
    t: clip(firstLine(request.title) || (request.kind === "permission" ? "Approve" : "Question"), 120),
    ...(request.preview && { p: clip(firstLine(request.preview), 120) }),
    ...(ask === "question" && request.choices?.length && { ch: request.choices.map((choice) => choice.trim()) }),
    ...(request.kind === "permission" && request.remember && ask === "approve" && { rm: true }),
    ...(ask === "risky" && { x: true }),
    ...(ask === "question" && free && { free: true }),
  };
}

/** A run a person started: a routine's, a panel's or a scheduled one never gets a card. */
const ownRun = (run) => run.scheduleId == null && run.trigger !== "scheduled" && !run.panelId;
const TIMED_OUT = /stall|timed? ?out|didn't finish in time|did not finish in time|took too long|no (event|answer|response) for/i;
/** How a turn ended, in the app's words (src/features/chat/turn.ts, endingOf), or "Done". */
export function endedWord(run) {
  if (run.status === "Completed") return "Done";
  const kind = run.ending ?? (run.status === "Stopped" ? "stopped" : run.status === "Interrupted" ? "interrupted" : TIMED_OUT.test(run.detail ?? "") ? "timed-out" : "failed");
  return kind === "timed-out" ? "Timed out" : kind === "stopped" ? "Stopped" : kind === "interrupted" ? "Interrupted" : "Failed";
}

/**
 * A Botkin's chats as its card shows them (every Botkin's when `botId` is null), in order: one with
 * an open request first, then working ones (the newest start first), then ended ones (the newest end
 * first). A chat counts while its turn works and for `linger` after it ends. `visible(chat)` leaves
 * out chats a device may not see.
 */
export function cardRows(state, botId, { now = Date.now(), linger = CARD_LINGER_MS, visible = () => true } = {}) {
  const latest = new Map();
  for (const run of state.runs ?? []) {
    if (!run || !ownRun(run)) continue;
    const before = latest.get(run.chatId);
    if (!before || run.time > before.time) latest.set(run.chatId, run);
  }
  const requests = state.requests ?? [];
  const rows = [];
  for (const chat of state.chats ?? []) {
    if (!chat || (botId != null && chat.botId !== botId) || chat.botIds?.length || chat.temporary || chat.panelId || !visible(chat)) continue;
    const run = latest.get(chat.id);
    const asked = requests.findIndex((request) => request.chatId === chat.id);
    const request = asked >= 0 ? requests[asked] : undefined;
    if (!run && !request) continue;
    const working = run?.status === "Working";
    const ended = run && !working ? (run.finished ?? run.time) : undefined;
    if (!request && !working && !(ended !== undefined && now - ended < linger)) continue;
    rows.push({ chat, run, request, asked, working, ended });
  }
  const rank = (row) => (row.request ? 0 : row.working ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (a.request && b.request ? a.asked - b.asked : a.working ? (b.run?.time ?? 0) - (a.run?.time ?? 0) : (b.ended ?? 0) - (a.ended ?? 0)));
  return rows;
}

/** When the next ended chat drops off a card, or null when none will. For a timer that looks again then. */
export function nextExpiry(rows, linger = CARD_LINGER_MS) {
  const ends = rows.filter((row) => row.ended !== undefined && !row.request).map((row) => row.ended + linger);
  return ends.length ? Math.min(...ends) : null;
}

const running = (run) => [...(run?.steps ?? [])].reverse().find((step) => step.status === "Running");
function rowPhase(row, state) {
  if (row.request) return "needs-you";
  if (!row.working) return row.run.status === "Completed" ? "done" : "failed";
  if (state.streams?.[row.chat.id] || (row.run.steps?.length ?? 0) > 0 || state.intents?.[row.chat.id]) return "working";
  return "thinking";
}
const PLAIN = { "needs-you": "Needs you", thinking: "Thinking", working: "Working", done: "Done", failed: "Stopped" };

/**
 * What a chat is doing now, in a few words (sealed: a step's name is the bot's content): the step
 * that runs, else what the bot says it is doing, else the step it did last. A step takes moments
 * and the thinking between two takes most of a turn, so without that last one a row would say
 * "Working…" nearly all the time.
 */
function rowLabel(row, state) {
  if (row.request) return clip(firstLine(row.request.title), 60) || "Needs you";
  if (!row.working) return endedWord(row.run);
  if (state.streams?.[row.chat.id]) return "Replying…";
  const step = running(row.run);
  if (step) return clip(firstLine(step.label || step.name), 60) || "Working…";
  const intent = firstLine(state.intents?.[row.chat.id]);
  if (intent) return clip(intent, 60);
  const last = row.run.steps?.[row.run.steps.length - 1];
  if (last) return clip(firstLine(last.label || last.name), 60) || "Working…";
  return "Thinking…";
}

/** The newest message of the turn that is the reply (not text written on the way). */
function defaultReply(chat, run) {
  const reply = [...(chat.messages ?? [])].reverse().find((message) => message.runId === run.id && message.role !== "user" && !message.interim);
  return reply?.text;
}

/** The sealed part, trimmed to fit: thinking goes first, then steps, then the reply, then long words. */
function fit(detail, max) {
  if (bytes(JSON.stringify(detail)) <= max) return detail;
  const next = { c: detail.c.map((row) => ({ ...row })) };
  for (const field of ["th", "s", "r"]) {
    for (const row of next.c) delete row[field];
    if (bytes(JSON.stringify(next)) <= max) return next;
  }
  for (const row of next.c) {
    row.t = clip(row.t, 30);
    row.l = clip(row.l, 30);
    if (row.q) row.q = { ...row.q, t: clip(row.q.t, 60), ...(row.q.p && { p: clip(row.q.p, 60) }) };
  }
  return next;
}

/**
 * A Botkin's card now (the card for all Botkins when `botId` is null), or null when it has no chat
 * to show (then it ends).
 *
 *   state    what the card shows, as Apple may see it: phases, counts, times and the provider
 *   detail   what only the phone may see, sealed before it is sent (null with previews off)
 *   relevance  100 when a chat needs the person, 50 while one works, 10 when all ended
 *   expires  when the next ended chat drops off, or null
 *
 * The model is the chat's, else the Botkin's, else the computer's default (`state.settings.model`).
 * `reply(chat, run)` finds a turn's reply. The computer has the chat's messages; the phone passes
 * its own way. On the card for all Botkins each row names its Botkin (`bot`) and carries its look
 * from `look(botId)` when there is one; the Botkin's name is sealed (`b`).
 */
export function botCard(state, botId, { previews = true, now = Date.now(), linger = CARD_LINGER_MS, visible, reply = defaultReply, look = () => undefined } = {}) {
  const rows = cardRows(state, botId, { now, linger, visible });
  if (!rows.length) return null;
  const all = botId == null;
  const botOf = (row) => (state.bots ?? []).find((item) => item.id === (all ? row.chat.botId : botId));
  const shown = rows.slice(0, CARD_CHATS);
  const single = shown.length === 1;
  const chats = shown.map((row) => {
    const phase = rowPhase(row, state);
    const model = row.chat.model ?? botOf(row)?.model ?? state.settings?.model;
    const ask = askOf(row.request);
    const face = all ? look(row.chat.botId) : undefined;
    return {
      id: row.chat.id,
      phase,
      steps: row.run?.steps?.length ?? 0,
      startedAt: secs(row.run?.time ?? now),
      ...(row.ended !== undefined && { finishedAt: Math.max(secs(row.run.time), secs(row.ended)) }),
      ...(typeof model?.provider === "string" && model.provider && { provider: model.provider }),
      ...(ask && { ask }),
      ...(all && { bot: row.chat.botId }),
      ...(face?.head && { head: face.head, palette: face.palette ?? "original", eyes: face.eyes ?? "oval", ...(face.colors?.length === 4 && { colors: face.colors }) }),
    };
  });
  const first = chats[0];
  const writing = first.phase === "working" && !!state.streams?.[first.id];
  const plain = {
    v: 1,
    phase: first.phase,
    label: writing ? "Writing" : PLAIN[first.phase],
    steps: first.steps,
    startedAt: first.startedAt,
    ...(first.finishedAt !== undefined && { finishedAt: first.finishedAt }),
    chats,
    more: rows.length - shown.length,
  };
  let detail = null;
  if (previews) {
    detail = fit({
      c: shown.map((row) => {
        const model = row.chat.model ?? botOf(row)?.model ?? state.settings?.model;
        const out = { id: row.chat.id, t: clip(firstLine(row.chat.title) || "New chat", 60), l: rowLabel(row, state) };
        if (all && botOf(row)?.name) out.b = clip(botOf(row).name, 40);
        if (typeof model?.model === "string" && model.model) out.m = clip(model.model, 60);
        if (single && row.run) {
          const steps = (row.run.steps ?? []).slice(-3).map((step) => ({ k: stepKind(step.name), l: clip(firstLine(step.label || step.name), 60) || "Step", d: step.status === "Running" ? 0 : /fail|error/i.test(step.status) ? 2 : 1, ...(step.started && { at: secs(step.started) }) }));
          if (steps.length) out.s = steps;
          if (row.working && !row.request) {
            const thought = latestThought(state.thinking?.[row.chat.id]);
            if (thought) out.th = thought;
          }
          if (!row.working) {
            const said = firstLine(reply(row.chat, row.run));
            if (said) out.r = clip(said, 140);
          }
        }
        // The card for all Botkins says how each ended chat ended, in the reply's first line.
        if (all && !single && row.run && !row.working) {
          const said = firstLine(reply(row.chat, row.run));
          if (said) out.r = clip(said, 100);
        }
        if (row.request) out.q = askDetail(row.request);
        return out;
      }),
    }, all ? ALL_SEALED_MAX : SEALED_MAX);
  }
  const relevance = chats.some((chat) => chat.phase === "needs-you") ? 100 : chats.some((chat) => chat.phase === "working" || chat.phase === "thinking") ? 50 : 10;
  return { state: plain, detail, relevance, expires: nextExpiry(rows, linger) };
}

/** Whether every chat on a card has ended (the card says done, and stays a while). */
export const cardOver = (state) => !!state && state.chats.every((chat) => chat.phase === "done" || chat.phase === "failed");
