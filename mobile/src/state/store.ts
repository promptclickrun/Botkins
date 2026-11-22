// What the phone knows about the computer right now. The link fills it (src/state/link.ts) and
// screens read it through the hooks in src/state/hooks.ts.
import { PendingSends } from "../../link-host/pending-sends";
import { create } from "zustand";
import type { LinkRoute, LinkState, Pairing } from "@/link/client";
import type { ChatDetail, Live, Message, ModelInfo, Parts, ProviderStatus, Run, SkillInfo } from "@/link/types";

/** A chat's messages as loaded so far: a run of them ending at the newest. */
export type ChatView = {
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

/** Joins a fresh page of a chat onto what is already loaded, keeping earlier pages. */
export function mergeChat(held: ChatView | undefined, next: ChatDetail): ChatView {
  const runs: Record<string, Run> = {};
  for (const run of next.runs) runs[run.id] = run;
  const fresh: ChatView = { from: next.from, total: next.total, messages: next.messages, runs, todos: next.todos, ...(next.pane && { pane: next.pane }) };
  // Earlier messages stay when the new page continues the same chat without a gap.
  if (!held || next.from < held.from || next.from > held.from + held.messages.length || next.total < held.total) return fresh;
  return {
    ...fresh,
    from: held.from,
    messages: [...held.messages.slice(0, next.from - held.from), ...next.messages],
    runs: { ...held.runs, ...runs },
  };
}

/** Parsed JSON has no cycles. Compare map keys independently of insertion order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
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
        chats = { ...chats, [id]: value ? mergeChat(chats[id], value as ChatDetail) : undefined };
      } else if (name.startsWith("run:")) {
        running = { ...running, [name.slice(4)]: (value as Run | null) ?? null };
      } else {
        if (parts === state.parts) parts = { ...parts };
        Object.assign(parts, { [name]: value });
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
