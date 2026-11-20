// What the phone knows about the computer right now. The link fills it (src/state/link.ts) and
// screens read it through the hooks in src/state/hooks.ts.
import { create } from "zustand";
import type { LinkRoute, LinkState, Pairing } from "@/link/client";
import type { ChatDetail, Message, ModelInfo, Parts, ProviderStatus, Run, SkillInfo } from "@/link/types";

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
  parts: Partial<Parts>;
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

/** Takes in the parts the computer sent. */
export function applyParts(incoming: Record<string, unknown>) {
  useApp.setState((state) => {
    const parts = { ...state.parts } as Record<string, unknown>;
    let chats = state.chats;
    let running = state.running;
    for (const [name, value] of Object.entries(incoming)) {
      if (name.startsWith("chat:")) {
        const id = name.slice(5);
        chats = { ...chats, [id]: value ? mergeChat(chats[id], value as ChatDetail) : undefined };
      } else if (name.startsWith("run:")) {
        running = { ...running, [name.slice(4)]: (value as Run | null) ?? null };
      } else parts[name] = value;
    }
    return { parts: parts as Partial<Parts>, chats, running, synced: true };
  });
}

let toastId = 0;
export function showToast(text: string, tone: Toast["tone"] = "info") {
  const id = ++toastId;
  useApp.setState({ toast: { id, text, tone } });
  setTimeout(() => useApp.getState().toast?.id === id && useApp.setState({ toast: null }), tone === "error" ? 4200 : 2400);
}
