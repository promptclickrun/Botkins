// The phone's end of the Botkins link (the desktop's end is link-host/server.mjs).
// It pairs with a computer, opens encrypted sessions, makes calls, and follows the computer's
// state by asking for the parts that changed. Nothing here depends on React Native, so the same
// code runs in the tests.
import { agree, b64u, box, cleanCode, concat, fromUtf8, hkdf, INFO, newKeyPair, open, randomBytes, seal, seqBytes, seqNonce, unb64u, unbox, utf8 } from "./crypto";
import type { PairTarget } from "./pairing";
import { isRelayHost } from "./relay";

const PREFIX = "/botkins/v1/";
export const PROTOCOL = 1;

/** What the phone keeps (in its keychain) about the computer it is paired with. */
/** What a phone signs to turn the screen on, as text: the computer builds exactly the same (link-host/grant.mjs). */
export const grantMessage = (serverId: string, deviceId: string, level: "view" | "control", ticket: string) => JSON.stringify(["botkins-screen-grant-v1", serverId, deviceId, level, ticket]);

export type Pairing = {
  serverId: string;
  /** The computer's public key. */
  serverKey: string;
  deviceId: string;
  /** This phone's secret key. */
  secretKey: string;
  /** Addresses to find the computer at, best first. */
  hosts: string[];
  name: string;
  /** The name this phone keeps its presence key under, when it made one for this pairing. Never sent anywhere. */
  presenceTag?: string;
};

/** How the phone reaches the computer: on its own network, or through the relay. */
export type LinkRoute = "direct" | "relay";

/** online: in step with the computer. offline: it can't be reached. revoked: the computer no longer knows this phone. */
export type LinkState = "connecting" | "online" | "offline" | "revoked";

export type LinkErrorCode = "offline" | "revoked" | "remote" | "protocol" | "code" | "closed" | "not-found";
export class LinkError extends Error {
  code: LinkErrorCode;
  constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> };
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<FetchResponse>;

/** What a computer says about itself. Over the relay it says only the first four (no name, app or version). */
/** `pairing` says whether a code is open. Through the relay the computer leaves it out, so a stranger can't watch for one. */
type Hello = { botkins: number; serverId: string; publicKey: string; pairing?: boolean; name?: string; app?: string; version?: string };

/**
 * Runs a request with a deadline. It gives up by itself at the deadline, or when `outer` aborts: it
 * never waits on the transport to say so. A request that iOS dropped while the app was suspended may
 * never settle, and that must not hold the link.
 */
async function timed<T>(ms: number, outer: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    stop = () => {
      controller.abort();
      const error = new Error("The request was cancelled");
      error.name = "AbortError";
      reject(error);
    };
    timer = setTimeout(stop, ms);
    outer?.addEventListener("abort", stop);
    if (outer?.aborted) stop();
  });
  try {
    return await Promise.race([run(controller.signal), gaveUp]);
  } finally {
    clearTimeout(timer);
    if (stop) outer?.removeEventListener("abort", stop);
  }
}

async function hello(fetcher: FetchLike, host: string, timeout: number): Promise<Hello> {
  return timed(timeout, undefined, async (signal) => {
    const response = await fetcher("http://" + host + PREFIX + "hello", { signal });
    const body = (await response.json()) as Hello;
    if (!response.ok || typeof body?.serverId !== "string" || typeof body.publicKey !== "string") throw new Error("Not a Botkins computer");
    return body;
  });
}

/**
 * Finds the computer: asks the direct addresses at once and takes the first that answers as the
 * computer we expect. A relay entry is tried only when none of them did (they get `timeout`, 1.5 s
 * when there is a relay entry to fall back on and 4 s when there is not; the relay gets `relayTimeout`).
 * An answer from the wrong computer does not stop the relay from being tried.
 */
export async function findHost(
  fetcher: FetchLike,
  hosts: string[],
  expect?: { serverId?: string; serverKey?: string },
  timeout?: number,
  relayTimeout = 8000,
): Promise<{ host: string; hello: Hello }> {
  if (!hosts.length) throw new LinkError("not-found", "No address for this computer.");
  const direct = hosts.filter((host) => !isRelayHost(host));
  const relays = hosts.filter(isRelayHost);
  let wrong = false;
  const race = (list: string[], ms: number) =>
    Promise.any(
      list.map(async (host) => {
        const found = await hello(fetcher, host, ms);
        if ((expect?.serverKey && found.publicKey !== expect.serverKey) || (expect?.serverId && found.serverId !== expect.serverId)) {
          wrong = true;
          throw new Error("A different computer answered");
        }
        return { host, hello: found };
      }),
    );
  try {
    if (direct.length) {
      try {
        return await race(direct, timeout ?? (relays.length ? 1500 : 4000));
      } catch (error) {
        if (!relays.length) throw error;
      }
    }
    return await race(relays, relayTimeout);
  } catch {
    throw new LinkError("not-found", wrong ? "A different computer answered at that address." : "Your computer didn't answer. Check that it is on and on the same network.");
  }
}

/**
 * The saved addresses after an answer: the one that just worked first, then the computer's own, then
 * what was saved. The computer's current relay entry replaces older ones, and the list keeps a relay
 * entry when it has to be cut short.
 */
function mergeHosts(worked: string, fresh: string[], saved: string[], limit: number): string[] {
  const valid = (host: string) => !host.startsWith("relay!") || isRelayHost(host);
  const current = fresh.filter(valid);
  const currentRelays = current.filter(isRelayHost);
  const kept = currentRelays.length ? saved.filter((host) => !isRelayHost(host) || host === worked || currentRelays.includes(host)) : saved.filter(valid);
  const all = [worked, ...current, ...kept].filter((entry, index, list) => list.indexOf(entry) === index);
  if (all.length <= limit) return all;
  const cut = all.slice(0, limit);
  const relay = all.find(isRelayHost);
  if (relay && !cut.some(isRelayHost)) cut[limit - 1] = relay;
  return cut;
}

/** Pairs this phone with a computer that is showing a pairing code. */
/**
 * Pairs this device with a computer. `kind` says what this device is: a phone (the default), or
 * "desktop" for another computer's Botkins app that uses this one (docs/link-contract.md).
 */
/**
 * `device.presenceKey` is a phone's second public key (P-256, SPKI as base64url) whose private half
 * can be used only after Face ID, Touch ID or the passcode. A computer keeps it only from a pairing
 * that reached it directly, and asks for a signature made with it before a phone may turn the screen
 * on ("screen-grant-v1"). `grantMessage` is what gets signed.
 */
export async function pair(fetcher: FetchLike, target: PairTarget, device: { name: string; platform: string; kind?: "phone" | "desktop"; presenceKey?: string }): Promise<Pairing> {
  const { host, hello: found } = await findHost(fetcher, target.hosts, { serverKey: target.serverKey, serverId: target.serverId });
  if (found.botkins !== PROTOCOL) throw new LinkError("protocol", "Update Botkins and your computer's app to the same version.");
  if (found.pairing === false) throw new LinkError("closed", "That code has expired. Show a new one on your computer.");
  // A scanned code carries the computer's key. A typed one takes the key the computer sends.
  const serverKey = target.serverKey ?? found.publicKey;
  const keys = newKeyPair();
  const key = hkdf(agree(keys.secretKey, unb64u(serverKey)), utf8(cleanCode(target.code)), INFO.pair);
  const response = await timed(10_000, undefined, (signal) =>
    fetcher("http://" + host + PREFIX + "pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: b64u(keys.publicKey), box: box(key, device, "pair:" + found.serverId) }),
      signal,
    }),
  );
  const body = (await response.json()) as { box?: string; error?: string };
  if (!response.ok || !body.box) {
    if (body.error === "pair_closed") throw new LinkError("closed", "That code has expired. Show a new one on your computer.");
    if (body.error === "pair_failed") throw new LinkError("code", "That code isn't right. Check it and try again.");
    // Too many wrong tries from this network (someone else's count too, on a shared one).
    if (body.error === "pair_wait" || response.status === 429) throw new LinkError("closed", "Too many tries. Show a new code on your computer and try again.");
    throw new LinkError("protocol", "Pairing didn't work. Try again.");
  }
  let reply: { device: string; serverId: string; name: string; hosts: string[] };
  try {
    reply = unbox(key, body.box, "paired:" + found.serverId);
  } catch {
    throw new LinkError("code", "That code isn't right. Check it and try again.");
  }
  const hosts = mergeHosts(host, reply.hosts, target.hosts, Infinity);
  return { serverId: reply.serverId, serverKey, deviceId: reply.device, secretKey: b64u(keys.secretKey), hosts, name: reply.name };
}

/** The key this phone and its computer share from pairing. Sessions are built on it. */
const deviceKeyOf = (pairing: Pairing) => hkdf(agree(unb64u(pairing.secretKey), unb64u(pairing.serverKey)), utf8(pairing.deviceId), INFO.device);
/**
 * The key sealed notifications are opened with (link-host/push.mjs seals with the same one). The
 * phone keeps it where its notification extension can read it; it never leaves the phone.
 */
export const pushKeyOf = (pairing: Pairing) => hkdf(deviceKeyOf(pairing), utf8(pairing.deviceId), "botkins/push/v1");

type Session = { id: string; toHost: Uint8Array; toPhone: Uint8Array; seq: number; base: string };
const routeOf = (session: Session | null): LinkRoute | null => (session ? (isRelayHost(session.base.replace(/^http:\/\//, "")) ? "relay" : "direct") : null);
type SyncNews = { epoch: string; v: Record<string, number> | null; parts: Record<string, unknown> };
class Retry extends Error {}

export type LinkOptions = {
  fetch: FetchLike;
  /** Parts that changed on the computer, by name. A chat's detail is "chat:<id>", its running turn "run:<id>". */
  onParts(parts: Record<string, unknown>): void;
  onState(state: LinkState): void;
  /** Each failed attempt while offline, even when the state stayed the same. */
  onUnreachable?(): void;
  /** The computer reported the addresses it can be reached on now. */
  onHosts?(hosts: string[]): void;
  /** How the phone is connected changed: null while there is no session. */
  onRoute?(route: LinkRoute | null): void;
  /** While connected through the relay, the first wait before looking for a direct address (default 60 s). */
  probeMs?: number;
  /** The longest wait between direct probes (default 5 minutes). */
  probeMaxMs?: number;
  /** Called when the link wakes: the transport proves its open connections are alive (the relay's sockets). */
  check?(): void;
  /** After a wake, how long the first answer may take before the path is given up (default 4 s). */
  wakeMs?: number;
};

const WAITS = [400, 1000, 2000, 4000, 8000, 15000];
/** How long a direct address that answered and then failed is left out, when there is a relay to use. */
const DISTRUST_MS = 10 * 60_000;

export class LinkClient {
  state: LinkState = "connecting";
  private session: Session | null = null;
  private opening: Promise<Session> | null = null;
  private epoch = "";
  private have: Record<string, number> = {};
  private watching: string[] = [];
  private running = false;
  // A late answer belongs to the lifetime that asked, even after a stop and restart.
  private lifetime: object | null = {};
  private poll: AbortController | null = null;
  private wakeUp: (() => void) | null = null;
  private deviceKey: Uint8Array;
  /** How the current session reaches the computer. */
  route: LinkRoute | null = null;
  private probing: Session | null = null;
  /** Direct addresses that answered the hello and then failed to open a session, and until when to leave them be. */
  private distrusted = new Map<string, number>();
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private probeDelay: number;
  private readonly probeMs: number;
  private readonly probeMaxMs: number;
  /** Set by a wake: the path in use may have died while the phone was away, so the next sync proves it quickly. */
  private suspect = false;

  constructor(
    private pairing: Pairing,
    private options: LinkOptions,
  ) {
    this.deviceKey = deviceKeyOf(pairing);
    this.probeMs = options.probeMs ?? 60_000;
    this.probeMaxMs = Math.max(this.probeMs, options.probeMaxMs ?? 300_000);
    this.probeDelay = this.probeMs;
  }

  /** Starts following the computer. Keeps trying while it can't be reached. */
  start() {
    if (this.running) return;
    this.running = true;
    this.lifetime ??= {};
    this.scheduleProbe();
    void this.follow(this.lifetime);
  }
  stop() {
    this.running = false;
    this.lifetime = null;
    this.opening = null;
    this.probing = null;
    clearTimeout(this.probeTimer);
    this.probeDelay = this.probeMs;
    this.poll?.abort();
    this.wakeUp?.();
    this.session = null;
    this.setRoute(null);
  }
  /**
   * Try again now: the app came to the front, or the network changed. The path in use is not
   * trusted after that. The next sync asks for an answer at once and gives it a few seconds; when
   * none comes the session is dropped and the computer is looked for afresh, on every address. So a
   * phone that was away comes back in seconds, not when a 40-second wait runs out.
   */
  wake(reason?: "network") {
    if (!this.lifetime) return;
    this.probeDelay = this.probeMs;
    // On another network, an address that failed on the last one gets a fresh try.
    if (reason === "network") this.distrusted.clear();
    this.suspect = true;
    // A socket can look open long after the system closed it under a suspended app.
    this.options.check?.();
    this.wakeUp?.();
    // The waiting sync may be on a path that just died (the phone left the network).
    this.poll?.abort();
    if (this.route === "relay") void this.probeDirect(false);
  }
  /**
   * An address for this computer that was found another way (it announced itself on the network).
   * It is tried first from now on, saved, and the link looks again at once. The computer still
   * has to prove who it is at that address, as at any other.
   */
  learn(host: string) {
    if (!this.lifetime || isRelayHost(host)) return;
    if (this.pairing.hosts[0] === host) {
      if (this.state !== "online") this.wake();
      else {
        this.probeDelay = this.probeMs;
        this.scheduleProbe();
      }
      return;
    }
    const hosts = mergeHosts(host, [], this.pairing.hosts, 8);
    this.pairing = { ...this.pairing, hosts };
    this.distrusted.delete(host);
    this.options.onHosts?.(hosts);
    this.wake();
  }
  /** The chats whose messages and running turn should be kept in step (the open ones). */
  watch(chatIds: string[]) {
    const next = [...new Set(chatIds)].sort();
    if (next.join("\n") === this.watching.join("\n")) return;
    this.watching = next;
    // The waiting request is for the old set: ask again.
    this.poll?.abort();
  }

  /** Sets the session and reports how it connects. */
  private useSession(session: Session | null) {
    this.session = session;
    this.setRoute(routeOf(session));
  }

  private setRoute(route: LinkRoute | null) {
    if (this.route === route) return;
    this.route = route;
    if (route === "direct") this.probeDelay = this.probeMs;
    this.scheduleProbe();
    this.options.onRoute?.(route);
  }

  private scheduleProbe() {
    clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    if (this.running && this.route === "relay" && this.probing !== this.session) {
      this.probeTimer = setTimeout(() => void this.probeDirect(), this.probeDelay);
    }
  }

  /**
   * While connected through the relay: asks the direct addresses (1.5 s) and, when one answers as the
   * right computer, drops the session so the next request opens a direct one. A call in flight keeps
   * the session it started with; only the waiting sync request is cut short. True when it switched.
   */
  async probeDirect(backOff = true): Promise<boolean> {
    const seen = this.session;
    if (!this.running || !seen || this.probing === seen || routeOf(seen) !== "relay") return false;
    this.probing = seen;
    clearTimeout(this.probeTimer);
    // Keep this wait if a direct hello answers but the next session still needs the relay.
    if (backOff) this.probeDelay = Math.min(this.probeDelay * 2, this.probeMaxMs);
    try {
      const direct = this.trusted(this.pairing.hosts.filter((host) => !isRelayHost(host)));
      if (!direct.length) return false;
      await findHost(this.options.fetch, direct, { serverId: this.pairing.serverId, serverKey: this.pairing.serverKey }, 1500);
      if (this.session !== seen || this.opening) return false;
      this.useSession(null);
      this.poll?.abort();
      this.wakeUp?.();
      return true;
    } catch {
      return false;
    } finally {
      if (this.probing === seen) {
        this.probing = null;
        if (this.session === seen) this.scheduleProbe();
      }
    }
  }

  private setState(state: LinkState) {
    if (this.state === state) return;
    this.state = state;
    this.options.onState(state);
  }

  private async openSession(): Promise<Session> {
    const lifetime = this.lifetime;
    // A stopped client opens nothing more: the phone has moved on to another computer, or to none.
    if (!lifetime) throw new LinkError("offline", "Your computer can't be reached right now.");
    if (this.session) return this.session;
    this.opening ??= (async () => {
      const { pairing } = this;
      const expect = { serverId: pairing.serverId, serverKey: pairing.serverKey };
      const relays = pairing.hosts.filter(isRelayHost);
      // With a relay to fall back on, an address that let the phone down a moment ago is left out.
      const hosts = relays.length ? [...this.trusted(pairing.hosts.filter((entry) => !isRelayHost(entry))), ...relays] : pairing.hosts;
      const { host } = await findHost(this.options.fetch, hosts, expect);
      try {
        // A direct address gets little time when the relay is there to take over.
        return await this.openAt(lifetime, host, relays.length && !isRelayHost(host) ? 4000 : 10_000);
      } catch (error) {
        // A direct address answered the hello and then failed. The hello is public, so anything on
        // the network can play it back: that must not keep the phone off the relay, now or at the
        // next look for a direct path.
        if (isRelayHost(host) || !relays.length || (error instanceof LinkError && error.code === "revoked")) throw error;
        if (this.lifetime === lifetime) this.distrusted.set(host, Date.now() + DISTRUST_MS);
        const found = await findHost(this.options.fetch, relays, expect);
        return await this.openAt(lifetime, found.host);
      }
    })().finally(() => {
      if (this.lifetime === lifetime) this.opening = null;
    });
    return this.opening;
  }

  /** The direct addresses that have not just failed to open a session. */
  private trusted(direct: string[]): string[] {
    const now = Date.now();
    for (const [host, until] of this.distrusted) if (until <= now) this.distrusted.delete(host);
    return direct.filter((host) => !this.distrusted.has(host));
  }

  /** Opens a session at one address that answered as this phone's computer. */
  private async openAt(lifetime: object, host: string, timeout = 10_000): Promise<Session> {
    {
      const { pairing } = this;
      const base = "http://" + host;
      const eph = newKeyPair();
      const nonce = randomBytes(16);
      const response = await timed(timeout, undefined, (signal) =>
        this.options.fetch(base + PREFIX + "session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            device: pairing.deviceId,
            eph: b64u(eph.publicKey),
            box: box(this.deviceKey, { eph: b64u(eph.publicKey), nonce: b64u(nonce) }, "session:" + pairing.serverId),
          }),
          signal,
        }),
      );
      const body = (await response.json()) as { box?: string; error?: string };
      if (response.status === 403 && body.error === "unknown_device") throw new LinkError("revoked", "This phone was removed from " + pairing.name + ".");
      if (!response.ok || !body.box) throw new LinkError("protocol", "Your computer refused the connection.");
      const reply = unbox<{ session: string; eph: string; nonce: string; epoch: string; hosts?: string[] }>(this.deviceKey, body.box, "session-ok:" + pairing.serverId);
      if (this.lifetime === lifetime && Array.isArray(reply.hosts) && reply.hosts.length) {
        // The address that just worked stays first; the computer's current ones follow.
        const hosts = mergeHosts(host, reply.hosts, pairing.hosts, 8);
        if (hosts.join() !== pairing.hosts.join()) {
          this.pairing = { ...pairing, hosts };
          this.options.onHosts?.(hosts);
        }
      }
      const salt = concat(nonce, unb64u(reply.nonce));
      const master = hkdf(concat(agree(eph.secretKey, unb64u(reply.eph)), this.deviceKey), salt, INFO.session);
      if (this.lifetime === lifetime && reply.epoch !== this.epoch) {
        // The computer's app restarted: nothing we hold is known to be current.
        this.epoch = reply.epoch;
        this.have = {};
      }
      const session = { id: reply.session, toHost: hkdf(master, salt, INFO.toHost), toPhone: hkdf(master, salt, INFO.toPhone), seq: 0, base };
      if (this.lifetime === lifetime) this.useSession(session);
      return session;
    }
  }

  private async request<T>(method: string, args: unknown[], timeout: number, signal?: AbortSignal): Promise<T> {
    const session = await this.openSession();
    if (signal?.aborted) throw new Error("The request was cancelled");
    const seq = ++session.seq;
    const sealed = seal(session.toHost, seqNonce(seq), utf8(JSON.stringify({ m: method, a: args })), "rpc:" + session.id);
    const response = await timed(timeout, signal, (inner) =>
      this.options.fetch(session.base + PREFIX + "rpc", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-botkins-session": session.id },
        body: concat(seqBytes(seq), sealed),
        signal: inner,
      }),
    );
    if (response.status === 401) {
      // The computer forgot the session (its app restarted, or the phone was away for long).
      if (this.session === session) this.useSession(null);
      throw new Retry();
    }
    if (!response.ok) throw new LinkError("protocol", "Your computer couldn't read that (" + response.status + ").");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const answer = JSON.parse(fromUtf8(open(session.toPhone, seqNonce(seq), bytes, "ok:" + session.id))) as { r?: T; e?: { message: string } };
    if (answer.e) throw new LinkError("remote", answer.e.message);
    return answer.r as T;
  }

  /** One of the computer's calls. Rejects with a LinkError: "remote" carries the computer's own message. */
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const lifetime = this.lifetime;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<T>(method, args, 60_000);
      } catch (error) {
        if (this.lifetime === lifetime && error instanceof Retry && attempt < 2) continue;
        if (error instanceof LinkError) throw error;
        throw new LinkError("offline", "Your computer can't be reached right now.");
      }
    }
  }

  private pause(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }

  private async follow(lifetime: object) {
    let failures = 0;
    while (this.lifetime === lifetime) {
      const poll = new AbortController();
      this.poll = poll;
      try {
        // After a wake the path has to prove itself: no waiting on the computer's side, and a short deadline.
        const quick = this.suspect;
        this.suspect = false;
        const news = await this.request<SyncNews>("link.sync", [{ epoch: this.epoch, have: this.have, watch: this.watching, wait: quick ? 0 : 25_000 }], quick ? (this.options.wakeMs ?? 4000) : 40_000, poll.signal);
        if (this.lifetime !== lifetime) break;
        failures = 0;
        this.setState("online");
        if (this.lifetime !== lifetime) break;
        if (news.epoch !== this.epoch) {
          this.epoch = news.epoch;
          this.have = {};
        }
        if (news.v) {
          this.have = news.v;
          this.options.onParts(news.parts);
        }
      } catch (error) {
        if (this.lifetime !== lifetime) break;
        // Cut short on purpose (the watched chats changed), or a session to renew: go again.
        if (poll.signal.aborted || error instanceof Retry) continue;
        this.useSession(null);
        if (this.lifetime !== lifetime) break;
        const revoked = error instanceof LinkError && error.code === "revoked";
        // One missed answer after being in step is a blip; a second one means the computer is away.
        const blip = this.state === "online" && failures === 0;
        this.setState(revoked ? "revoked" : blip ? "connecting" : "offline");
        if (this.lifetime !== lifetime) break;
        if (!revoked && !blip) this.options.onUnreachable?.();
        if (this.lifetime !== lifetime) break;
        failures++;
        // After a blip the computer is looked for again at once: the old path died, another may be up.
        if (blip) continue;
        const wait = revoked ? 30_000 : WAITS[Math.min(failures - 1, WAITS.length - 1)];
        await this.pause(wait * (0.75 + Math.random() * 0.5));
      }
    }
  }
}
