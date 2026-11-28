// Pure presentation helpers for bot-to-bot rail cards (T3 Code-style vertical accent rail).
// No React or DOM imports so desktop, mobile, and Node tests share the exact same rules.
import type { Bot, BotTask, Message, MessageFrom, TaskHandoff, TaskStatus, TeamAsk } from "./types";

export const BODY_PREVIEW_LINES = 2;
export const BODY_COLLAPSE_CHARS = 160;
export const BODY_COLLAPSE_LINES = 3;

export type AgentRailStatus =
  | "asked"
  | "working"
  | "answered"
  | "failed"
  | "stopped"
  | "later"
  | "ready"
  | "review"
  | "blocked"
  | "done";

export type AgentRailTone = "neutral" | "accent" | "success" | "warning" | "danger";

export type IncomingAgentRailModel = {
  kind: "incoming";
  from: MessageFrom;
  senderName: string;
  senderBotId: string;
  via: MessageFrom["via"];
  viaLabel: string;
  hostLabel?: string;
  sourceChatId?: string;
  taskTitle?: string;
  body: string;
  preview: string;
  collapsible: boolean;
  ariaLabel: string;
  time?: number;
};

export type OutgoingAgentRailModel = {
  kind: "outgoing";
  id: string;
  targetName: string;
  targetBotId: string;
  hostLabel?: string;
  via: "teamwork" | "remote";
  viaLabel: string;
  status: AgentRailStatus;
  statusLabel: string;
  statusTone: AgentRailTone;
  live: boolean;
  message: string;
  expecting?: string;
  reply?: string;
  error?: string;
  intent?: string;
  stepCount: number;
  durationMs?: number;
  ariaLabel: string;
};

export type TaskHandoffRailModel = {
  kind: "task-handoff";
  id: string;
  taskId: string;
  targetName: string;
  targetBotId: string;
  title: string;
  details?: string;
  status: AgentRailStatus;
  statusLabel: string;
  statusTone: AgentRailTone;
  live: boolean;
  taskChatId?: string;
  result?: string;
  problem?: string;
  ariaLabel: string;
};

/** True when a chat message was sent by another bot (not by a person). */
export function isAgentMessage(message: Pick<Message, "role" | "from"> | null | undefined): message is Pick<Message, "role" | "from"> & { from: MessageFrom } {
  return !!message && message.role === "user" && message.from?.kind === "bot";
}

/** Human-readable channel label for a bot-to-bot message. */
export function viaLabel(via: MessageFrom["via"], hostLabel?: string): string {
  if (via === "task") return "Task Board";
  if (via === "remote") return hostLabel ? "Remote · " + hostLabel : "Remote";
  return "Teamwork";
}

/** Extracts the readable body of a task prompt (strips boilerplate wrapper if present, preserves text otherwise). */
export function readableAgentBody(text: string, via: MessageFrom["via"]): { title?: string; body: string } {
  const raw = String(text ?? "").trim();
  if (!raw) return { body: "" };
  if (via === "task") {
    const taskMatch = raw.match(/\n\nTask:\s*([^\n]+)(?:\n\nDetails:\n([\s\S]*?))?(?:\n\nDo the work with your tools\.[\s\S]*)?$/);
    if (taskMatch) {
      const title = taskMatch[1].trim();
      const details = (taskMatch[2] ?? "").trim();
      return { title, body: details || title };
    }
  }
  return { body: raw };
}

/** First N lines or chars for the collapsed preview, plus whether collapsing is worthwhile. */
export function foldPreview(text: string): { preview: string; collapsible: boolean } {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return { preview: "", collapsible: false };
  const lines = cleaned.split(/\r?\n/);
  const tooLong = cleaned.length > BODY_COLLAPSE_CHARS || lines.length >= BODY_COLLAPSE_LINES;
  if (!tooLong) return { preview: cleaned, collapsible: false };
  const clippedLines = lines.slice(0, BODY_PREVIEW_LINES).join("\n");
  const preview = clippedLines.length > BODY_COLLAPSE_CHARS
    ? clippedLines.slice(0, BODY_COLLAPSE_CHARS - 1).trimEnd() + "…"
    : clippedLines + (lines.length > BODY_PREVIEW_LINES ? "…" : "");
  return { preview, collapsible: true };
}

/** Builds the display model for an incoming bot-to-bot message in the recipient's chat. */
export function buildIncomingRail(
  message: Pick<Message, "role" | "text" | "time" | "from">,
  options: {
    bots?: ReadonlyArray<Pick<Bot, "id" | "name">>;
    accessibleChatIds?: ReadonlySet<string>;
  } = {},
): IncomingAgentRailModel | null {
  if (!isAgentMessage(message)) return null;
  const from = message.from;
  const matchedBot = options.bots?.find((b) => b.id === from.botId);
  const senderName = (from.name || matchedBot?.name || "a bot").trim();
  const hostLabel = from.hostName?.trim() || undefined;
  const sourceChatId =
    from.chatId && (!options.accessibleChatIds || options.accessibleChatIds.has(from.chatId))
      ? from.chatId
      : undefined;
  const { title: taskTitle, body } = readableAgentBody(message.text, from.via);
  const { preview, collapsible } = foldPreview(body);
  const channel = viaLabel(from.via, hostLabel);
  return {
    kind: "incoming",
    from,
    senderName,
    senderBotId: from.botId,
    via: from.via,
    viaLabel: channel,
    hostLabel,
    sourceChatId,
    taskTitle,
    body,
    preview,
    collapsible,
    ariaLabel: "Message from " + senderName + (hostLabel ? " on " + hostLabel : ""),
    time: message.time,
  };
}

/** Status mapping for an outgoing ask (teamwork / remote dispatch). */
export function askStatusInfo(ask: Pick<TeamAsk, "status" | "intent">): {
  status: AgentRailStatus;
  label: string;
  tone: AgentRailTone;
  live: boolean;
} {
  switch (ask.status) {
    case "waiting":
      return { status: "asked", label: "Asked", tone: "neutral", live: true };
    case "working":
      return { status: "working", label: ask.intent ? "Working · " + ask.intent : "Working", tone: "accent", live: true };
    case "answered":
      return { status: "answered", label: "Answered", tone: "success", live: false };
    case "failed":
      return { status: "failed", label: "Failed", tone: "danger", live: false };
    case "stopped":
      return { status: "stopped", label: "Stopped", tone: "neutral", live: false };
  }
}

/** Builds the display model for an outgoing bot-to-bot ask in the sender's chat. */
export function buildOutgoingRail(
  ask: TeamAsk,
  bots: ReadonlyArray<Pick<Bot, "id" | "name">> = [],
): OutgoingAgentRailModel {
  const localBot = ask.remote ? undefined : bots.find((b) => b.id === ask.botId);
  const targetName = ask.remote ? ask.remote.botName : (localBot?.name ?? "a bot");
  const hostLabel = ask.remote?.hostName || undefined;
  const via: "teamwork" | "remote" = ask.remote ? "remote" : "teamwork";
  const info = askStatusInfo(ask);
  const durationMs = ask.finished && ask.started ? Math.max(0, ask.finished - ask.started) : undefined;
  return {
    kind: "outgoing",
    id: ask.id,
    targetName,
    targetBotId: ask.botId,
    hostLabel,
    via,
    viaLabel: viaLabel(via, hostLabel),
    status: info.status,
    statusLabel: info.label,
    statusTone: info.tone,
    live: info.live,
    message: ask.message,
    expecting: ask.expecting,
    reply: ask.reply,
    error: ask.error,
    intent: ask.intent,
    stepCount: ask.steps?.length ?? 0,
    durationMs,
    ariaLabel: "Message to " + targetName + (hostLabel ? " on " + hostLabel : "") + ", " + info.label,
  };
}

/** Status mapping for a Task Board handoff. */
export function taskHandoffStatusInfo(status: TaskStatus | "archived"): {
  status: AgentRailStatus;
  label: string;
  tone: AgentRailTone;
  live: boolean;
} {
  switch (status) {
    case "later":
      return { status: "later", label: "Queued", tone: "neutral", live: false };
    case "ready":
      return { status: "ready", label: "Ready", tone: "neutral", live: false };
    case "working":
      return { status: "working", label: "Working", tone: "accent", live: true };
    case "review":
      return { status: "review", label: "Ready for review", tone: "success", live: false };
    case "blocked":
      return { status: "blocked", label: "Blocked", tone: "warning", live: false };
    case "done":
      return { status: "done", label: "Done", tone: "success", live: false };
    case "archived":
      return { status: "done", label: "Archived", tone: "neutral", live: false };
  }
}

/** Builds the display model for a Task Board handoff in the creating bot's chat, synced with live task state. */
export function buildTaskHandoffRail(
  handoff: TaskHandoff,
  options: {
    bots?: ReadonlyArray<Pick<Bot, "id" | "name">>;
    tasks?: ReadonlyArray<Pick<BotTask, "id" | "status" | "chatId" | "result" | "problem" | "title" | "botId">>;
  } = {},
): TaskHandoffRailModel {
  const liveTask = options.tasks?.find((t) => t.id === handoff.taskId);
  const targetBotId = liveTask?.botId ?? handoff.botId;
  const targetName = options.bots?.find((b) => b.id === targetBotId)?.name ?? "a bot";
  const status = liveTask?.status ?? handoff.status;
  const info = taskHandoffStatusInfo(status);
  const title = liveTask?.title ?? handoff.title;
  return {
    kind: "task-handoff",
    id: handoff.id,
    taskId: handoff.taskId,
    targetName,
    targetBotId,
    title,
    details: handoff.details,
    status: info.status,
    statusLabel: info.label,
    statusTone: info.tone,
    live: info.live,
    taskChatId: liveTask?.chatId ?? handoff.chatId,
    result: liveTask?.result,
    problem: liveTask?.problem,
    ariaLabel: "Task handed to " + targetName + ": " + title + ", " + info.label,
  };
}

/** True for a rail entry made by a node_* tool (list_node_files, node_exec, ...), not a teammate ask. */
export function isNodeAsk(ask: Pick<TeamAsk, "botId">): boolean {
  return typeof ask.botId === "string" && ask.botId.startsWith("node:");
}

export type NodeCallGroupModel = {
  kind: "node-group";
  id: string;
  asks: TeamAsk[];
  hostLabel: string;
  count: number;
  running: number;
  failed: number;
  live: boolean;
  title: string;
  summary: string;
  statusTone: AgentRailTone;
  ariaLabel: string;
};

export type RailAskItem = { kind: "ask"; ask: TeamAsk } | NodeCallGroupModel;

/** Summary for a run of node calls folded into one card. */
export function nodeCallGroup(asks: TeamAsk[]): NodeCallGroupModel {
  const hosts = [...new Set(asks.map((a) => a.remote?.hostName).filter((h): h is string => !!h))];
  const hostLabel = hosts.length === 1 ? hosts[0] : hosts.length ? hosts.length + " hosts" : "a node";
  const running = asks.filter((a) => a.status === "waiting" || a.status === "working").length;
  const failed = asks.filter((a) => a.status === "failed").length;
  const stopped = asks.filter((a) => a.status === "stopped").length;
  const count = asks.length;
  const title = count + " node " + (count === 1 ? "call" : "calls") + " on " + hostLabel;
  const parts: string[] = [];
  if (running) parts.push(running + " running");
  if (failed) parts.push(failed + " failed");
  if (stopped) parts.push(stopped + " stopped");
  const current = [...asks].reverse().find((a) => a.status === "working" || a.status === "waiting");
  const summary = current ? current.message : parts.length ? parts.join(" · ") : "All done";
  const statusTone: AgentRailTone = failed ? "danger" : running ? "accent" : stopped ? "neutral" : "success";
  return {
    kind: "node-group",
    id: "nodes-" + asks[0].id,
    asks,
    hostLabel,
    count,
    running,
    failed,
    live: running > 0,
    title,
    summary,
    statusTone,
    ariaLabel: title + (parts.length ? ", " + parts.join(", ") : ", all done"),
  };
}

/** Folds back-to-back node calls into one group so a burst of node_exec doesn't fill the chat. */
export function groupRailAsks(asks: ReadonlyArray<TeamAsk>): RailAskItem[] {
  const items: RailAskItem[] = [];
  let run: TeamAsk[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ kind: "ask", ask: run[0] });
    else if (run.length > 1) items.push(nodeCallGroup(run));
    run = [];
  };
  for (const ask of asks) {
    if (isNodeAsk(ask)) run.push(ask);
    else {
      flush();
      items.push({ kind: "ask", ask });
    }
  }
  flush();
  return items;
}

export type AskGroupModel = {
  kind: "ask-group";
  id: string;
  asks: TeamAsk[];
  count: number;
  answered: number;
  working: number;
  failed: number;
  stopped: number;
  live: boolean;
  names: string[];
  header: string;
  ariaLabel: string;
};

export type GroupedRailItem = AskGroupModel | NodeCallGroupModel;

export type TaskHandoffGroupModel = {
  kind: "task-handoff-group";
  id: string;
  items: TaskHandoffRailModel[];
  count: number;
  working: number;
  done: number;
  blocked: number;
  live: boolean;
  names: string[];
  header: string;
  ariaLabel: string;
};

function joinNames(names: string[]): string {
  if (!names.length) return "teammates";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + " and " + names[1];
  if (names.length === 3) return names[0] + ", " + names[1] + " and " + names[2];
  return names[0] + ", " + names[1] + " and " + (names.length - 2) + " more";
}

function uniqueTargetNames(asks: ReadonlyArray<TeamAsk>, bots: ReadonlyArray<Pick<Bot, "id" | "name">>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const ask of asks) {
    const localBot = ask.remote ? undefined : bots.find((b) => b.id === ask.botId);
    const name = (ask.remote ? ask.remote.botName : (localBot?.name ?? "a bot")).trim() || "a bot";
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Summary for a run of teammate asks rendered together in one quiet card. */
export function buildAskGroup(
  asks: ReadonlyArray<TeamAsk>,
  bots: ReadonlyArray<Pick<Bot, "id" | "name">> = [],
): AskGroupModel {
  const list = [...asks];
  const names = uniqueTargetNames(list, bots);
  const count = list.length;
  const answered = list.filter((a) => a.status === "answered").length;
  const working = list.filter((a) => a.status === "waiting" || a.status === "working").length;
  const failed = list.filter((a) => a.status === "failed").length;
  const stopped = list.filter((a) => a.status === "stopped").length;
  const lead = count + (count === 1 ? " ask to " : " asks to ") + joinNames(names);
  const parts: string[] = [];
  if (count === 1) {
    if (answered) parts.push("answered");
    else if (working) parts.push("working");
    else if (failed) parts.push("failed");
    else if (stopped) parts.push("stopped");
  } else {
    if (answered) parts.push(answered + " answered");
    if (working) parts.push(working + " working");
    if (failed) parts.push(failed + " failed");
    if (stopped) parts.push(stopped + " stopped");
  }
  const header = [lead, ...parts].join(" · ");
  return {
    kind: "ask-group",
    id: "asks-" + (list[0]?.id ?? "empty"),
    asks: list,
    count,
    answered,
    working,
    failed,
    stopped,
    live: working > 0,
    names,
    header,
    ariaLabel: header,
  };
}

/** Groups consecutive teammate asks into one card and consecutive node calls into one node-call card. */
export function groupAsks(
  asks: ReadonlyArray<TeamAsk>,
  bots: ReadonlyArray<Pick<Bot, "id" | "name">> = [],
): GroupedRailItem[] {
  const items: GroupedRailItem[] = [];
  let teamRun: TeamAsk[] = [];
  let nodeRun: TeamAsk[] = [];
  const flushTeam = () => {
    if (!teamRun.length) return;
    items.push(buildAskGroup(teamRun, bots));
    teamRun = [];
  };
  const flushNode = () => {
    if (!nodeRun.length) return;
    items.push(nodeCallGroup(nodeRun));
    nodeRun = [];
  };
  for (const ask of asks) {
    if (isNodeAsk(ask)) {
      flushTeam();
      nodeRun.push(ask);
    } else {
      flushNode();
      teamRun.push(ask);
    }
  }
  flushTeam();
  flushNode();
  return items;
}

/** Groups Task Board handoffs from a turn into one quiet card of expandable rows. */
export function buildTaskHandoffGroup(
  handoffs: ReadonlyArray<TaskHandoff>,
  options: {
    bots?: ReadonlyArray<Pick<Bot, "id" | "name">>;
    tasks?: ReadonlyArray<Pick<BotTask, "id" | "status" | "chatId" | "result" | "problem" | "title" | "botId">>;
  } = {},
): TaskHandoffGroupModel | null {
  if (!handoffs.length) return null;
  const items = handoffs.map((handoff) => buildTaskHandoffRail(handoff, options));
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!seen.has(item.targetName)) {
      seen.add(item.targetName);
      names.push(item.targetName);
    }
  }
  const count = items.length;
  const working = items.filter((i) => i.live).length;
  const done = items.filter((i) => i.status === "done" || i.status === "review").length;
  const blocked = items.filter((i) => i.status === "blocked").length;
  const queued = count - working - done - blocked;
  const lead = count + (count === 1 ? " task to " : " tasks to ") + joinNames(names);
  const parts: string[] = [];
  if (count === 1) {
    parts.push(items[0].statusLabel.toLowerCase());
  } else {
    if (done) parts.push(done + " done");
    if (working) parts.push(working + " working");
    if (blocked) parts.push(blocked + " blocked");
    if (queued > 0) parts.push(queued + " queued");
  }
  const header = [lead, ...parts].join(" · ");
  return {
    kind: "task-handoff-group",
    id: "handoffs-" + items[0].id,
    items,
    count,
    working,
    done,
    blocked,
    live: working > 0,
    names,
    header,
    ariaLabel: header,
  };
}

/** Single-line plain summary for a collapsed ask row: reply once answered, error when failed, request otherwise. */
export function askRowSummary(model: Pick<OutgoingAgentRailModel, "status" | "reply" | "error" | "message">): string {
  const raw =
    model.status === "answered" && model.reply?.trim()
      ? model.reply
      : model.status === "failed" && model.error?.trim()
        ? model.error
        : model.message;
  const firstLine =
    String(raw ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compact elapsed time for an ask row ("12s", "6m", "1h 4m"). */
export function formatCompactElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return Math.max(1, seconds) + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? hours + "h " + rem + "m" : hours + "h";
}

const KNOWN_RECEIPT_TEXTS = new Set([
  "Answered",
  "Allow once",
  "Allow for this chat",
  "Always allow",
  "Deny",
  "Allow this time",
  "Allow for today",
  "Dismissed",
]);

/**
 * True when a user-role message is a system receipt for an answered request/permission,
 * not a message the person typed. Renders as a quiet system line without changing the model transcript.
 */
export function isAnswerReceipt(
  message: Pick<Message, "role" | "text" | "from" | "receipt" | "answer"> | null | undefined,
  previous?: (Pick<Message, "role"> & { request?: unknown }) | null,
): boolean {
  if (!message || message.role !== "user" || message.from?.kind === "bot") return false;
  if (message.receipt === true || !!message.answer) return true;
  return !!previous?.request && KNOWN_RECEIPT_TEXTS.has(message.text);
}

/** Quiet system-line wording for an answer receipt ("You answered · Allow once"). */
export function answerReceiptLabel(message: Pick<Message, "text">): string {
  const text = String(message.text ?? "").trim();
  if (!text || text === "Answered") return "You answered";
  return "You answered · " + text;
}
