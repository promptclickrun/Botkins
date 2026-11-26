// Per-room, disposable replay state shared by the Worker and Node relay.
import { hex } from "./pure.ts";
import { MAX_PENDING_BYTES, MAX_PENDING_REQUESTS, PENDING_LIFE, REQUEST, readU32 } from "./shared.ts";

type Entry = { ids: string; requestId: number; at: number };
type PendingRequest = Entry & { body: Uint8Array; sent: boolean };

export class PendingRequests {
  private items: PendingRequest[] = [];
  private done: Entry[] = [];

  get length(): number {
    return this.items.length;
  }

  nextExpiry(): number {
    return this.items.length ? this.items[0]!.at + PENDING_LIFE : Infinity;
  }

  add(ids: Uint8Array, body: Uint8Array): PendingRequest | null {
    if (body.length < 5 || body[0] !== REQUEST || this.length >= MAX_PENDING_REQUESTS) return null;
    const total = this.items.reduce((size, item) => size + item.body.length, body.length);
    if (total > MAX_PENDING_BYTES) return null;
    const key = hex(ids);
    const requestId = readU32(body, 1);
    const matches = (item: Entry) => item.ids === key && item.requestId === requestId;
    if (this.items.some(matches) || this.done.some(matches)) return null;
    const item = { ids: key, requestId, body, sent: false, at: Date.now() };
    this.items.push(item);
    return item;
  }

  drain(send: (item: PendingRequest) => boolean, replay: boolean): void {
    for (const item of this.items) {
      if (item.sent && !replay) continue;
      if (!send(item)) break;
      item.sent = true;
    }
  }

  // A live phone supplies the full prefix even if hibernation discarded both lists.
  accept(conn: string, requestId: number, phoneIds?: Uint8Array) {
    const matches = (item: Entry) => item.requestId === requestId && item.ids.startsWith(conn);
    const done = this.done.find(matches);
    if (done) return { ids: done.ids, duplicate: true };
    const item = this.items.find(matches);
    const ids = item?.ids ?? (phoneIds && hex(phoneIds));
    // The host releases its cache by conn and request ID. After phone departure the from
    // field is unavailable, so leave its eight bytes zero in this host-only acknowledgement.
    if (!ids) return { ids: conn.padEnd(32, "0"), duplicate: false };
    if (item) this.items.splice(this.items.indexOf(item), 1);
    this.remember(ids, requestId);
    return { ids, duplicate: false };
  }

  private remember(ids: string, requestId: number): void {
    this.done.push({ ids, requestId, at: Date.now() });
    if (this.done.length > 128) this.done.shift();
  }

  expire(now: number, offline: (item: Entry) => void): void {
    while (this.done.length && this.done[0]!.at + PENDING_LIFE <= now) this.done.shift();
    while (this.items.length && this.items[0]!.at + PENDING_LIFE <= now) {
      const item = this.items.shift()!;
      offline(item);
      this.remember(item.ids, item.requestId);
    }
  }

  drop(ids: Uint8Array): void {
    const key = hex(ids);
    this.items = this.items.filter(item => item.ids !== key);
    this.done = this.done.filter(item => item.ids !== key);
  }

  clear(keepDone = false): void {
    this.items = [];
    if (!keepDone) this.done = [];
  }
}
