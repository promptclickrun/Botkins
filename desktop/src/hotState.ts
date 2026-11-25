// The window's state is kept up to date from two kinds of message (desktop/window-push.mjs): the whole
// state when something that does not change every few milliseconds changed, and, while a bot streams, a
// small "hot" message with only what moves: the live text, thinking, requests and the running turns'
// steps. This puts a hot message onto the state the window has, keeping every object that did not change.
import type { Run, State, Step } from "./types";

const plain = (value: object) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * `next`, with every part of it that equals the same part of `prev` replaced by that very object.
 * Data that crossed from the main process is all new objects; this gives back the old ones for what
 * did not change, so `===` says what changed and React renders only that. Lists of things with an
 * `id` are matched by it (a chat added at the top moves the rest); other lists by place.
 */
export function share<T>(prev: unknown, next: T): T {
  if (prev === next || typeof next !== "object" || next === null || typeof prev !== "object" || prev === null) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    const keyed = typeof (next[0] as { id?: unknown } | undefined)?.id === "string" && typeof (prev[0] as { id?: unknown } | undefined)?.id === "string";
    const before = keyed ? new Map<string | undefined, unknown>(prev.map((item: { id?: string }) => [item?.id, item])) : null;
    const out = next.map((item, index) => share(before ? before.get((item as { id: string })?.id) : prev[index], item));
    return (out.length === prev.length && out.every((item, index) => item === prev[index]) ? prev : out) as T;
  }
  if (Array.isArray(prev) || !plain(next) || !plain(prev)) return next;
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = share(before[key], after[key]);
    out[key] = value;
    if (value !== before[key] || !Object.hasOwn(before, key)) same = false;
  }
  return (same ? prev : out) as T;
}

/** What changed of one running turn: its fields but the steps, the order of its steps, and the steps that changed. */
export type HotRun = { id: string; rest?: Record<string, unknown>; order?: string[] | null; steps?: Step[] };
/**
 * A hot message. It applies to the whole state numbered `base` (every whole state carries its `seq`,
 * and a hot message does not change it), and to nothing else. `fields` holds the top-level fields that changed: null removes one.
 */
export type HotMessage = {
  base: number;
  seq: number;
  fields?: Record<string, unknown>;
  appends?: { name: "streams" | "thinking"; chat: string; from: number; add: string }[];
  runs?: HotRun[];
};

function mergeRun(prev: Run, patch: HotRun): Run | null {
  const { steps: prevSteps, ...prevRest } = prev;
  const rest = patch.rest ? share(prevRest, patch.rest as typeof prevRest) : prevRest;
  let steps = prevSteps;
  if (patch.order !== undefined || patch.steps?.length) {
    if (patch.order === null) steps = undefined;
    else {
      const old = new Map((prevSteps ?? []).map((step) => [step.id, step]));
      const changed = new Map((patch.steps ?? []).map((step) => [step.id, step]));
      const list: Step[] = [];
      for (const id of patch.order ?? (prevSteps ?? []).map((step) => step.id)) {
        const step = changed.has(id) ? share(old.get(id), changed.get(id)!) : old.get(id);
        // A step the window never had: it missed a message, and asks for the whole state.
        if (!step) return null;
        list.push(step);
      }
      steps = prevSteps && list.length === prevSteps.length && list.every((step, index) => step === prevSteps[index]) ? prevSteps : list;
    }
  }
  if (rest === prevRest && steps === prevSteps) return prev;
  return steps === undefined ? (rest as Run) : { ...(rest as Run), steps };
}

/**
 * The state with a hot message applied; the same object when nothing changed. Null when the message
 * does not fit the state (a turn it names is not there): the caller asks for the whole state.
 */
export function applyHot(state: State, hot: HotMessage): State | null {
  const next: Record<string, unknown> = { ...state };
  let changed = false;
  for (const [name, value] of Object.entries(hot.fields ?? {})) {
    if (value === null) {
      if (name in next) {
        delete next[name];
        changed = true;
      }
      continue;
    }
    const shared = share(next[name], value);
    if (shared !== next[name]) {
      next[name] = shared;
      changed = true;
    }
  }
  for (const { name, chat, from, add } of hot.appends ?? []) {
    let map = next[name] as Record<string, string>;
    if (!map || !Object.hasOwn(map, chat)) return null;
    const previous = map[chat];
    if (from !== 0 && previous.length !== from) return null;
    if (map === state[name]) map = { ...map };
    map[chat] = from === 0 ? add : previous + add;
    next[name] = map;
    changed = true;
  }
  if (hot.runs?.length) {
    let runs = state.runs;
    for (const patch of hot.runs) {
      const at = runs.findIndex((run) => run.id === patch.id);
      if (at < 0) return null;
      const merged = mergeRun(runs[at], patch);
      if (!merged) return null;
      if (merged !== runs[at]) {
        if (runs === state.runs) runs = [...runs];
        runs[at] = merged;
      }
    }
    if (runs !== state.runs) {
      next.runs = runs;
      changed = true;
    }
  }
  return changed ? (next as State) : state;
}

const hostOf = (state?: State) => state?.remote?.using?.id ?? "local";
type Listener = () => void;

/** One IPC sequence for the window. The workspace reads activity (absent, empty, or writing);
 * only the live reply row reads the body. Both snapshots advance before either is published. */
export class WindowState {
  private current?: State;
  private lastWorkspace?: State;
  private seq = 0;
  private listeners = new Set<Listener>();
  private rows = new Map<string, Set<Listener>>();

  workspace = () => this.lastWorkspace;
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  text(host: string, chat: string) {
    return host === hostOf(this.current) ? this.current?.streams[chat] ?? "" : "";
  }
  subscribeText(chat: string, fn: Listener) {
    const listeners = this.rows.get(chat) ?? new Set<Listener>();
    this.rows.set(chat, listeners);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
      if (!listeners.size) this.rows.delete(chat);
    };
  }

  whole(received: State, observe?: (next: State) => void) {
    if (received.seq !== undefined && received.seq < this.seq) return;
    const next = share(this.current, received);
    this.seq = received.seq ?? this.seq;
    this.publish(next, true, observe);
  }

  /** False when a delta was missed or does not fit: fetch a numbered full snapshot. */
  hot(hot: HotMessage, observeQueue?: (next: State) => void): boolean {
    if (hot.seq <= this.seq) return true;
    const prev = this.current;
    if (!prev || prev.seq !== hot.base || hot.seq !== this.seq + 1) return false;
    const next = applyHot(prev, hot);
    if (!next) return false;
    this.seq = hot.seq;
    if (next === prev) return true;
    const before = prev.streams, after = next.streams;
    const textOnly = before !== after && prev.thinking === next.thinking && prev.runs === next.runs && Object.keys(hot.fields ?? {}).every(key => key === "streams")
      && Object.keys(before).length === Object.keys(after).length
      && Object.keys(before).every(id => Object.hasOwn(after, id) && !!before[id] === !!after[id]);
    this.publish(next, !textOnly, next.queued !== prev.queued ? observeQueue : undefined);
    return true;
  }

  private publish(next: State, workspaceChanged: boolean, observe?: (next: State) => void) {
    const prev = this.current;
    this.current = next;
    if (workspaceChanged) this.lastWorkspace = next;
    observe?.(next);
    if (workspaceChanged) for (const fn of this.listeners) fn();
    const switched = hostOf(prev) !== hostOf(next);
    if (!switched && prev?.streams === next.streams) return;
    for (const [id, listeners] of this.rows) {
      if (switched || prev?.streams[id] !== next.streams[id]) for (const fn of listeners) fn();
    }
  }
}
