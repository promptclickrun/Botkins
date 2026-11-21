// A space shared by link ("spaces-v1"; docs/spaces.md, "Share by link"): this module puts a sealed
// copy of the space on the relay, keeps it fresh, and takes it back.
//
// The relay cannot read a copy: it is sealed with the key in the link's fragment, which only people
// with the link have. Nobody without a pairing reaches the host through a link; a link opens a copy
// the host chose to put out.
//
// Everything here is worked out again from what is saved (`team.spaces`, `team.spaceCopies`), so
// `sync()` is safe to call whenever anything may have changed, and after a restart:
//   - a space shared by link is put out when it never was, 20 seconds at the earliest after its last
//     copy when it changed, and once a day, each time to end 7 days later;
//   - a copy that should no longer be out (the space is no longer shared by link, has a new link,
//     was deleted, the relay was switched off) is in `team.spaceCopies` until the relay says it is
//     gone: tried at once, then at growing gaps, and at every start.
import { createCipheriv, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { b64u, random, unb64u } from "./crypto.mjs";
import { roomOf, signWithRelayKey, validRelayKey } from "./relay.mjs";

export const SPACE_COPY = {
  /** A copy ends by itself this long after it was last put, so a host that is gone leaves nothing behind. */
  life: 7 * 24 * 60 * 60 * 1000,
  /** A copy is put again this long after the last time, changed or not. */
  again: 24 * 60 * 60 * 1000,
  /** A changed space is put again this long after its last copy at the earliest. */
  gap: 20_000,
  /** The largest sealed copy the relay takes. */
  max: 4 * 1024 * 1024,
  /** A request to the relay is given up after this long. */
  timeout: 30_000,
  /** How long to wait before the next try of something the relay did not take. The last gap repeats. */
  retry: [5_000, 15_000, 60_000, 5 * 60_000, 30 * 60_000],
};
/** The nonce and the tag a seal adds: the gzip of a copy may be this much smaller than `max`. */
export const SEAL_BYTES = 12 + 16;

/** A space's copy as the relay keeps it: `nonce(12) || ciphertext || tag(16)`, AES-256-GCM over the gzip of the JSON. */
export function sealSpaceCopy(snapshot, share) {
  const nonce = random(12);
  const cipher = createCipheriv("aes-256-gcm", unb64u(share.key), nonce);
  cipher.setAAD(Buffer.from("botkins-space-v1:" + share.id, "utf8"));
  return Buffer.concat([nonce, cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"))), cipher.final(), cipher.getAuthTag()]);
}

/** What is kept of a copy until the relay says it is gone. `space` is the space it was of, while that still exists. */
export const retiredCopy = (spaceId, share, base) => ({
  id: share.id,
  salt: share.salt,
  relay: share.relay ?? base,
  space: spaceId,
  ...(share.putAt && { after: share.putAt }),
  ...(share.until && { until: share.until }),
});

const origin = (base) => String(base).replace(/^ws/, "http").replace(/\/+$/, "");
const seconds = (ms) => Math.floor(ms / 1000);

export class SpaceLinks {
  /**
   * @param team     () => the team as stored
   * @param setTeam  (team) => saves it and tells every device
   * @param records  () => the app's spaces, or null when it has none (yet)
   * @param relay    () => { on, base, key }: whether the relay applies now, its address, and the host's relay key (null when it has none)
   * @param snapshot (id) => the space's copy (`SpaceSnapshot`), from the app
   * @param newShare () => a fresh link (id, salt, key) under the relay key in use
   * @param fetch    the fetch to use
   * @param timing   overrides for SPACE_COPY (tests)
   */
  constructor({ team, setTeam, records, relay, snapshot, newShare, fetch, log = () => {}, now = Date.now, timing = {} }) {
    Object.assign(this, { team, setTeam, records, relay, snapshot, newShare, fetch, log, now });
    this.timing = { ...SPACE_COPY, ...timing };
    /** share id → the last time (seconds) signed for it, so every request for one id is later than the one before. */
    this.signed = new Map();
    /** share id → a PUT that is on its way. Its DELETE waits for it. */
    this.inflight = new Map();
    /** "put:<space id>" or "del:<share id>" → { n, at }: tries that failed, and when the last one was. */
    this.failed = new Map();
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  /** The spaces a copy is still being taken back for: their sheet says "Taking the link back…". */
  leaving() {
    return new Set((this.team().spaceCopies ?? []).map((copy) => copy.space).filter(Boolean));
  }

  /** Looks at what is saved and does what is due. Safe to call at any time. */
  sync() {
    if (this.stopped) return;
    this.settle();
    this.arm();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The host's relay key was replaced: every link is a new one, since a link's id belongs to the
   * key. The copies under the old key are taken back with that key, which is kept beside each until
   * the relay says it is gone or the copy has ended by itself.
   */
  rekey(oldKey) {
    const team = this.team();
    const { base } = this.relay();
    let copies = (team.spaceCopies ?? []).map((copy) => (copy.key ? copy : { ...copy, key: oldKey }));
    const spaces = {};
    for (const [id, entry] of Object.entries(team.spaces ?? {})) {
      if (!entry?.share) {
        spaces[id] = entry;
        continue;
      }
      if (entry.share.putAt) copies = [...copies, { ...retiredCopy(id, entry.share, base), key: oldKey }];
      spaces[id] = { ...entry, share: this.newShare() };
    }
    this.setTeam({ ...team, spaces, spaceCopies: copies.slice(-500) });
    this.sync();
  }

  /** A copy that is out where it no longer should be joins the ones to take back; one that is wanted again leaves them. */
  settle() {
    const team = this.team();
    const relay = this.relay();
    let copies = team.spaceCopies ?? [];
    let spaces = team.spaces ?? {};
    let changed = false;
    const wanted = new Set();
    for (const [id, entry] of Object.entries(spaces)) {
      const share = entry?.share;
      if (!share) continue;
      const stays = relay.on && entry.access === "link" && (!share.relay || share.relay === relay.base);
      if (stays) wanted.add(share.id);
      else if (share.putAt) {
        copies = [...copies, retiredCopy(id, share, relay.base)];
        const { putAt: _putAt, rev: _rev, until: _until, relay: _relay, ...kept } = share;
        spaces = { ...spaces, [id]: { ...entry, share: kept } };
        changed = true;
      }
    }
    // The same link is out again (the relay came back on): an old take-back must not remove the new copy.
    if (copies.some((copy) => wanted.has(copy.id))) {
      copies = copies.filter((copy) => !wanted.has(copy.id));
      changed = true;
    }
    if (changed) this.setTeam({ ...team, spaces, spaceCopies: copies.slice(-500) });
  }

  /** When a failed try may be made again. */
  retryAt(key) {
    const failed = this.failed.get(key);
    if (!failed) return 0;
    const gaps = this.timing.retry;
    return failed.at + gaps[Math.min(failed.n, gaps.length) - 1];
  }
  fail(key) {
    this.failed.set(key, { n: (this.failed.get(key)?.n ?? 0) + 1, at: this.now() });
  }

  /** Everything there is to do, each with when it is due. */
  due() {
    const team = this.team();
    const relay = this.relay();
    const now = this.now();
    const list = [];
    const records = this.records();
    if (relay.on && validRelayKey(relay.key) && Array.isArray(records)) {
      const revs = new Map(records.map((space) => [space?.id, Number(space?.rev) || 0]));
      for (const [id, entry] of Object.entries(team.spaces ?? {})) {
        const share = entry?.access === "link" ? entry.share : null;
        if (!share || !revs.has(id)) continue;
        const at = !share.putAt ? now : share.rev !== revs.get(id) ? share.putAt + this.timing.gap : share.putAt + this.timing.again;
        list.push({ kind: "put", id, at: Math.max(at, this.retryAt("put:" + id)) });
      }
    }
    for (const copy of team.spaceCopies ?? []) list.push({ kind: "del", copy, at: this.retryAt("del:" + copy.id) });
    return list;
  }

  arm() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || this.running) return;
    const list = this.due();
    if (!list.length) return;
    const wait = Math.max(0, Math.min(...list.map((item) => item.at)) - this.now());
    this.timer = setTimeout(() => void this.run(), Math.min(wait, 2_147_000_000));
    this.timer.unref?.();
  }

  async run() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const now = this.now();
      for (const item of this.due().filter((one) => one.at <= now)) {
        if (this.stopped) return;
        if (item.kind === "put") await this.put(item.id);
        else await this.take(item.copy);
      }
    } catch (error) {
      this.log("space links: " + (error?.message ?? "failed"));
    } finally {
      this.running = false;
    }
    this.settle();
    this.arm();
  }

  /** The next time to sign for a share id: now, and later than anything signed for it before. */
  nextTime(shareId, afterMs = 0) {
    const time = Math.max(seconds(this.now()), (this.signed.get(shareId) ?? seconds(afterMs)) + 1);
    this.signed.set(shareId, time);
    return time;
  }

  /** Puts one space's copy out. */
  async put(id) {
    const relay = this.relay();
    const entry = this.team().spaces?.[id];
    const share = entry?.access === "link" ? entry.share : null;
    if (!share || !relay.on || !validRelayKey(relay.key)) return;
    const rev = Number((this.records() ?? []).find((space) => space?.id === id)?.rev) || 0;
    const work = (async () => {
      let body;
      try {
        const snapshot = await this.snapshot(id);
        if (!snapshot || typeof snapshot !== "object") return false;
        body = sealSpaceCopy(snapshot, share);
      } catch {
        return false;
      }
      if (body.length > this.timing.max) {
        this.log("space links: a copy is over the relay's size");
        return false;
      }
      const time = this.nextTime(share.id, share.putAt);
      const expiresAt = this.now() + this.timing.life;
      const hash = createHash("sha256").update(body).digest("base64url");
      const signature = signWithRelayKey(relay.key, `botkins-relay-space-v1:${roomOf(relay.key.publicKey)}:${share.id}:${expiresAt}:${hash}:${time}`);
      try {
        const response = await this.fetch(origin(relay.base) + "/v1/spaces/" + share.id, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "x-botkins-key": relay.key.publicKey, "x-botkins-time": String(time), "x-botkins-sig": signature, "x-botkins-salt": share.salt, "x-botkins-expires": String(expiresAt) },
          body,
          signal: AbortSignal.timeout(this.timing.timeout),
        });
        // When it was put: now, or the signed time when that is ahead (two copies within one second).
        return response?.status === 204 ? { at: Math.max(this.now(), time * 1000), expiresAt } : false;
      } catch {
        return false;
      }
    })();
    this.inflight.set(share.id, work);
    const done = await work;
    if (this.inflight.get(share.id) === work) this.inflight.delete(share.id);
    if (!done) return this.fail("put:" + id);
    this.failed.delete("put:" + id);
    // The link may have been taken back or replaced while the copy was on its way: then nothing is noted,
    // and its take-back, which waited for this, is signed later than it.
    const team = this.team();
    const current = team.spaces?.[id];
    if (current?.access !== "link" || current.share?.id !== share.id) return;
    this.setTeam({ ...team, spaces: { ...team.spaces, [id]: { ...current, share: { ...current.share, putAt: done.at, rev, until: done.expiresAt, relay: relay.base } } } });
  }

  /** Takes one copy back. It stays in the list until the relay says it is gone. */
  async take(copy) {
    // A copy that was on its way lands first, so this is signed after it.
    await this.inflight.get(copy.id);
    const gone = () => {
      this.failed.delete("del:" + copy.id);
      const team = this.team();
      this.setTeam({ ...team, spaceCopies: (team.spaceCopies ?? []).filter((one) => one.id !== copy.id) });
    };
    const key = copy.key ?? this.relay().key;
    // Without the key it was put with, nothing can take it back; it ends by itself.
    if (!validRelayKey(key)) return gone();
    if (copy.until && copy.until <= this.now() && !this.signed.has(copy.id)) return gone();
    const time = this.nextTime(copy.id, copy.after);
    const signature = signWithRelayKey(key, `botkins-relay-space-del-v1:${roomOf(key.publicKey)}:${copy.id}:${time}`);
    let status = 0;
    try {
      const response = await this.fetch(origin(copy.relay) + "/v1/spaces/" + copy.id, {
        method: "DELETE",
        headers: { "x-botkins-key": key.publicKey, "x-botkins-time": String(time), "x-botkins-sig": signature, "x-botkins-salt": copy.salt },
        signal: AbortSignal.timeout(this.timing.timeout),
      });
      status = response?.status ?? 0;
    } catch {
      status = 0;
    }
    // Gone (204), never there (404), or not ours to take back with this key (403): nothing is left to do.
    if (status === 204 || status === 404 || status === 403) return gone();
    this.fail("del:" + copy.id);
  }
}
