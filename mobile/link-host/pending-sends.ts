/** Local composer rows stay visible until the host publishes the message or its queue entry. */
type Echo = { text: string; clientMessageId?: string };
type Queued = Echo & { id: string };
type Legacy = { from: number; queued: Set<string> };
type Entry<M> = { message: M; legacy?: Legacy; echoed: boolean };

const EMPTY: never[] = [];

export class PendingSends<M extends Echo & { clientMessageId: string }> {
  private chats = new Map<string, Entry<M>[]>();
  private visible = new Map<string, M[]>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  rows(chatId: string) { return this.visible.get(chatId) ?? EMPTY; }
  chatIds() { return this.chats.keys(); }

  private publish(chatId: string, entries: Entry<M>[]) {
    if (entries.length) {
      this.chats.set(chatId, entries);
      this.visible.set(chatId, entries.map(entry => entry.message));
    } else {
      this.chats.delete(chatId);
      this.visible.delete(chatId);
    }
    for (const listener of this.listeners) listener();
  }

  async send(chatId: string, message: M, dispatch: () => Promise<void>, legacy?: Legacy) {
    const entry = { message, legacy, echoed: false };
    this.publish(chatId, [...(this.chats.get(chatId) ?? []), entry]);
    try {
      await dispatch();
    } catch (error) {
      // An echo can arrive before the RPC fails. In that case the host already accepted it.
      if (entry.echoed) return;
      this.publish(chatId, (this.chats.get(chatId) ?? []).filter(item => item !== entry));
      throw error;
    }
  }

  observe(chatId: string, from: number, messages: (Echo & { role: string })[], queued: Queued[]) {
    const entries = this.chats.get(chatId);
    if (!entries) return;
    const used = new Set<number | string>();
    const remaining = entries.filter(entry => {
      const { message, legacy } = entry;
      if (!legacy) {
        entry.echoed = queued.some(q => q.clientMessageId === message.clientMessageId)
          || messages.some(m => m.role === "user" && m.clientMessageId === message.clientMessageId);
      } else {
        // Older hosts have no client IDs. Consume each new matching row only once.
        let key: number | string | undefined;
        for (let i = Math.max(0, legacy.from - from); i < messages.length; i++) {
          if (messages[i].role === "user" && messages[i].text === message.text && !used.has(from + i)) {
            key = from + i;
            break;
          }
        }
        key ??= queued.find(q => !legacy.queued.has(q.id) && !used.has(q.id) && q.text === message.text)?.id;
        if (key !== undefined) {
          used.add(key);
          entry.echoed = true;
        }
        legacy.from = Math.max(legacy.from, from + messages.length);
        for (const q of queued) legacy.queued.add(q.id);
      }
      return !entry.echoed;
    });
    if (remaining.length !== entries.length) this.publish(chatId, remaining);
  }

  clear() {
    for (const id of this.chatIds()) this.publish(id, []);
  }
}
