// What the phone knows about the computer right now. The link fills it (src/state/link.ts) and
// screens read it through the hooks in src/state/hooks.ts.
import { PendingSends } from "../../link-host/pending-sends";
import { create } from "zustand";
import type { LinkRoute, LinkState, Pairing } from "@/link/client";
import type { ChatDetail, Live, Message, ModelInfo, Parts, ProviderStatus, ReasoningView, Run, SkillInfo } from "@/link/types";
import type { UnifiedHostStatus } from "./unified";

/** A chat's messages as loaded so far: a run of them ending at the newest. */
export type ChatView = {
  activeFork?: string;
  /** The index, in the whole chat, of the first message held. */
  from: number;
  total: number;
  messages: Message[];
  runs: Record<string, Run>;
  todos?: ChatDetail["todos"];
  /** The side pane a bot opened beside this chat ("side-pane-v1"). */
  pane?: ChatDetail["pane"];
  loadingEarlier?: boolean;
};

export type Toast = { id: number; text: string; tone: "info" | "success" | "error" };

export type QuietLive = Omit<Live, "streams" | "thinking"> & { streams: Record<string, boolean>; thinking: Record<string, boolean> };
export type PhoneParts = Omit<Parts, "live"> & { live: QuietLive };
type ChatText = { stream: string; thinking: string };

export type AppState = {
  /** Saved choices and the pairing were read from the phone's storage. */
  booted: boolean;
  /** The computer in use. The phone follows one computer at a time. */
  pairing: Pairing | null;
  /** Every computer this phone is paired with, in the order they were paired. */
  pairings: Pairing[];
  /** True when unified mode is on and at least two paired computers are included. */
  unified: boolean;
  /** Per-computer status while unified mode is enabled. */
  unifiedHosts: UnifiedHostStatus[];
  link: LinkState;
  /** How the phone reaches the computer right now: null while there is no session. */
  route: LinkRoute | null;
  /** The first state arrived from the computer since the app started. */
  synced: boolean;
  parts: Partial<PhoneParts>;
  texts: Record<string, ChatText | undefined>;
  chats: Record<string, ChatView | undefined>;
  /** The turn a chat is working on right now. */
  running: Record<string, Run | null | undefined>;
  /** Lists the computer is asked for (they aren't part of the synced state). */
  models?: ModelInfo[];
  providers?: ProviderStatus[];
  skills?: SkillInfo[];
  toast: Toast | null;
};

export const useApp = create<AppState>(() => ({
  booted: false,
  pairing: null,
  pairings: [],
  unified: false,
  unifiedHosts: [],
  link: "connecting",
  route: null,
  synced: false,
  parts: {},
  texts: {},
  chats: {},
  running: {},
  toast: null,
}));

// What is kept about one computer outside this store (its wiki pages, its plans and limits). Each is
// emptied when the phone starts using another computer, so nothing of the last one is shown.
const resets = new Set<() => void>();
/** Registers a cache to empty when the computer in use changes. */
export const onComputerChange = (reset: () => void) => void resets.add(reset);
export function forgetComputer() {
  for (const reset of resets) reset();
}

export const pendingSends = new PendingSends<Message & { clientMessageId: string }>();
onComputerChange(() => pendingSends.clear());
useApp.subscribe((state, prev) => {
  if (state.chats === prev.chats && state.parts.live === prev.parts.live) return;
  for (const id of pendingSends.chatIds()) {
    const chat = state.chats[id];
    pendingSends.observe(id, chat?.from ?? 0, chat?.messages ?? [], state.parts.live?.queued[id] ?? []);
  }
});

/**
 * Joins a fresh page of a chat onto what is already loaded, keeping earlier pages.
 *
 * The computer sends a chat's page whole whenever anything in it changes: a reply lands, and all 60
 * messages and their runs come again as new objects. Each message and run that is the same as the
 * one held stays that object, so only the rows that changed are drawn again (66 of 90 rows were,
 * for one new reply); and the same page again is the chat as it is held, so nothing is.
 */
export function mergeChat(held: ChatView | undefined, next: ChatDetail): ChatView {
  const runs: Record<string, Run> = {};
  for (const run of next.runs) runs[run.id] = kept(held?.runs[run.id], run);
  const pane = kept(held?.pane, next.pane);
  const fresh: ChatView = { ...(next.activeFork && { activeFork: next.activeFork }), from: next.from, total: next.total, messages: next.messages, runs, todos: kept(held?.todos, next.todos), ...(pane && { pane }) };
  // Earlier messages stay when the new page continues the same chat without a gap.
  if (!held || next.activeFork !== held.activeFork || next.from < held.from || next.from > held.from + held.messages.length || next.total < held.total) return fresh;
  const before = next.from - held.from;
  const merged: ChatView = {
    ...fresh,
    from: held.from,
    messages: [...held.messages.slice(0, before), ...next.messages.map((message, index) => kept(held.messages[before + index], message))],
    runs: { ...held.runs, ...runs },
  };
  const same =
    merged.total === held.total && merged.todos === held.todos && merged.pane === held.pane &&
    merged.messages.length === held.messages.length && merged.messages.every((message, index) => message === held.messages[index]) &&
    Object.keys(merged.runs).length === Object.keys(held.runs).length && next.runs.every((run) => merged.runs[run.id] === held.runs[run.id]);
  return same ? held : merged;
}

/** Parsed JSON has no cycles. Compare map keys independently of insertion order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** What was held, when what came says the same: whatever is drawn from it is then not drawn again. */
function kept<T>(held: T | undefined, next: T): T {
  return held !== undefined && sameValue(held, next) ? held : next;
}

/**
 * A list from the computer again. It comes whole whenever one row changes (the list of chats with
 * every model call of any bot, since a chat's summary holds its context), and every row was a new
 * object: every chat's row on Home and Chats, and the open chat's screen, were drawn again. A row
 * that didn't change stays the same object, and so does the list when none did. Rows are matched by
 * their `id`; a list of anything else is taken as it comes.
 */
function keptRows(held: unknown, next: unknown): unknown {
  if (!Array.isArray(held) || !Array.isArray(next) || !held.length || !next.length) return next;
  const idOf = (row: unknown) => (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : undefined);
  const byId = new Map<string, unknown>();
  for (const row of held) {
    const id = idOf(row);
    if (id !== undefined) byId.set(id, row);
  }
  if (!byId.size) return next;
  let same = held.length === next.length;
  const rows = next.map((row, index) => {
    const id = idOf(row);
    const now = id === undefined ? row : kept(byId.get(id), row);
    if (now !== held[index]) same = false;
    return now;
  });
  return same ? held : rows;
}

function normalizeLive(live: Live | QuietLive, previous?: QuietLive): QuietLive {
  const flags = (map: Record<string, string | boolean>) => Object.fromEntries(Object.entries(map).map(([id, text]) => [id, !!text]));
  const next = { ...live, streams: flags(live.streams), thinking: flags(live.thinking) };
  if (!previous) return next;
  const keys = Object.keys(next) as (keyof QuietLive)[];
  let changed = keys.length !== Object.keys(previous).length;
  for (const key of keys) {
    if (sameValue(next[key], previous[key])) Object.assign(next, { [key]: previous[key] });
    else changed = true;
  }
  return changed ? next : previous;
}

/** Takes in the parts the computer sent. */
export function applyParts(incoming: Record<string, unknown>) {
  useApp.setState((state) => {
    let parts = state.parts;
    let texts = state.texts;
    const putText = (id: string, next: ChatText | null) => {
      const held = texts[id];
      if (held?.stream === next?.stream && held?.thinking === next?.thinking) return;
      if (texts === state.texts) texts = Object.assign(Object.create(null), texts);
      if (next) texts[id] = next;
      else delete texts[id];
    };
    let chats = state.chats;
    let running = state.running;
    for (const [name, value] of Object.entries(incoming)) {
      if (name === "live") {
        const live = value as Live | QuietLive;
        const normalized = normalizeLive(live, parts.live);
        if (normalized !== parts.live) parts = { ...parts, live: normalized };
        for (const id of new Set([...Object.keys(texts), ...Object.keys(live.streams), ...Object.keys(live.thinking)])) {
          const stream = live.streams[id];
          const thinking = live.thinking[id];
          if (typeof stream === "string" || typeof thinking === "string") {
            putText(id, { stream: typeof stream === "string" ? stream : "", thinking: typeof thinking === "string" ? thinking : "" });
          } else if (!(id in live.streams) && !(id in live.thinking)) putText(id, null);
        }
      } else if (name.startsWith("text:")) {
        putText(name.slice(5), value as ChatText | null);
      } else if (name.startsWith("chat:")) {
        const id = name.slice(5);
        const merged = value ? mergeChat(chats[id], value as ChatDetail) : undefined;
        if (merged !== chats[id] || !(id in chats)) chats = { ...chats, [id]: merged };
      } else if (name.startsWith("run:")) {
        const id = name.slice(4);
        const nextRun = (value as Run | null) ?? null;
        if (!sameValue(running[id], nextRun)) running = { ...running, [id]: nextRun };
      } else if (name.startsWith("reasoning:")) {
        const id = name.slice(10);
        const held = running[id];
        const view = value as ReasoningView | null;
        if (held && (!view || held.id === view.run)) {
          if (view) running = { ...running, [id]: { ...held, reasoning: view.items } };
          else if (held.status === "Working") running = { ...running, [id]: { ...held, reasoning: undefined } };
        }
      } else {
        const held = (parts as Record<string, unknown>)[name];
        const rows = keptRows(held, value);
        if (rows === held && held !== undefined) continue;
        if (parts === state.parts) parts = { ...parts };
        Object.assign(parts, { [name]: rows });
      }
    }
    if (state.synced && parts === state.parts && texts === state.texts && chats === state.chats && running === state.running) return state;
    return { parts, texts, chats, running, synced: true };
  });
}

let toastId = 0;
export function showToast(text: string, tone: Toast["tone"] = "info") {
  const id = ++toastId;
  useApp.setState({ toast: { id, text, tone } });
  setTimeout(() => useApp.getState().toast?.id === id && useApp.setState({ toast: null }), tone === "error" ? 4200 : 2400);
}
