// Live typing indicators for shared chats ("chat-typing-v1").
//
// Kept strictly in memory: a dropped connection or quiet device clears on its own after `ttlMs`,
// and nothing about draft text or keystrokes ever crosses the wire — only `{ chatId, active }`.
// Tracked per `(chatId, sourceId)` (a device id, or "host" for the local desktop window) and
// aggregated per chat deduped by person id so two devices for the same person appear once.
import { OWNER } from "./team.mjs";

/** How long a typing heartbeat stays live without a refresh. */
export const TYPING_TTL_MS = 5_000;
/** How often expired entries are swept so dropped clients disappear promptly. */
export const TYPING_SWEEP_MS = 1_000;

const keyOf = (chatId, sourceId) => `${chatId}\0${sourceId}`;

function sameSnapshot(a, b) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const chatId of keysA) {
    const listA = a[chatId];
    const listB = b[chatId];
    if (!Array.isArray(listB) || listA.length !== listB.length) return false;
    for (let i = 0; i < listA.length; i++) {
      if (listA[i].id !== listB[i].id || listA[i].name !== listB[i].name) return false;
    }
  }
  return true;
}

export class ChatTyping {
  /**
   * @param options.changed called whenever the visible typing map changes
   * @param options.now clock function, overridable for tests
   * @param options.ttlMs heartbeat expiry in ms
   * @param options.sweepMs expiry check interval in ms
   */
  constructor({ changed = () => {}, now = () => Date.now(), ttlMs = TYPING_TTL_MS, sweepMs = TYPING_SWEEP_MS } = {}) {
    this.changed = changed;
    this.now = now;
    this.ttlMs = ttlMs;
    this.sweepMs = sweepMs;
    /** Map<`${chatId}\0${sourceId}`, { chatId: string, personId: string, sourceId: string, until: number, order: number }> */
    this.entries = new Map();
    this.seq = 0;
    this.timer = null;
    this.lastIds = {};
  }

  /** Set or clear typing for one device/window in one chat. */
  set({ chatId, personId, sourceId, typing }) {
    if (typeof chatId !== "string" || !chatId || chatId.length > 200) return false;
    if (typeof personId !== "string" || !personId) return false;
    if (typeof sourceId !== "string" || !sourceId) return false;
    const key = keyOf(chatId, sourceId);
    if (typing === true) {
      const existing = this.entries.get(key);
      this.entries.set(key, {
        chatId,
        personId,
        sourceId,
        until: this.now() + this.ttlMs,
        order: existing ? existing.order : ++this.seq,
      });
      this.ensureTimer();
    } else {
      this.entries.delete(key);
      this.maybeStopTimer();
    }
    return this.notifyIfChanged();
  }

  /** Clear all typing entries for a specific person in one chat (e.g. on send or removal). */
  clearPerson(chatId, personId) {
    if (!chatId || !personId) return false;
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (entry.chatId === chatId && entry.personId === personId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (!removed) return false;
    this.maybeStopTimer();
    return this.notifyIfChanged();
  }

  /** Clear all typing entries for a deleted chat. */
  clearChat(chatId) {
    if (!chatId) return false;
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (entry.chatId === chatId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (!removed) return false;
    this.maybeStopTimer();
    return this.notifyIfChanged();
  }

  /** Clear all typing entries from a disconnected or unpaired device. */
  forgetSource(sourceId) {
    if (!sourceId) return false;
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (entry.sourceId === sourceId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (!removed) return false;
    this.maybeStopTimer();
    return this.notifyIfChanged();
  }

  /** Clear all typing entries for a member removed from the team. */
  forgetPerson(personId) {
    if (!personId) return false;
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (entry.personId === personId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (!removed) return false;
    this.maybeStopTimer();
    return this.notifyIfChanged();
  }

  /** Remove expired entries and notify if the visible map changed. */
  sweep() {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.until <= t) this.entries.delete(key);
    }
    this.maybeStopTimer();
    return this.notifyIfChanged();
  }

  /** Current unexpired typing map keyed by chatId, deduped by personId. */
  snapshot(names = new Map()) {
    const t = this.now();
    const byChat = new Map();
    for (const [key, entry] of this.entries) {
      if (entry.until <= t) {
        this.entries.delete(key);
        continue;
      }
      let list = byChat.get(entry.chatId);
      if (!list) byChat.set(entry.chatId, (list = new Map()));
      const prev = list.get(entry.personId);
      if (prev === undefined || entry.order < prev) list.set(entry.personId, entry.order);
    }
    this.maybeStopTimer();
    const out = {};
    for (const [chatId, people] of byChat) {
      const sorted = [...people.entries()].sort((a, b) => a[1] - b[1]);
      out[chatId] = sorted.map(([id]) => ({
        id,
        name: names.get(id) || (id === OWNER ? "Owner" : "Member"),
      }));
    }
    return out;
  }

  rawIds() {
    const t = this.now();
    const byChat = new Map();
    for (const entry of this.entries.values()) {
      if (entry.until <= t) continue;
      let list = byChat.get(entry.chatId);
      if (!list) byChat.set(entry.chatId, (list = new Map()));
      const prev = list.get(entry.personId);
      if (prev === undefined || entry.order < prev) list.set(entry.personId, entry.order);
    }
    const out = {};
    for (const [chatId, people] of byChat) {
      out[chatId] = [...people.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => ({ id, name: id }));
    }
    return out;
  }

  notifyIfChanged() {
    const after = this.rawIds();
    if (sameSnapshot(this.lastIds, after)) return false;
    this.lastIds = after;
    this.changed();
    return true;
  }

  ensureTimer() {
    if (this.timer || this.sweepMs <= 0) return;
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  maybeStopTimer() {
    if (!this.entries.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.entries.clear();
  }
}
