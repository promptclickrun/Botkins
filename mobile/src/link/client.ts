// The phone's end of the Botkins link (the desktop's end is link-host/server.mjs).
// It pairs with a computer, opens encrypted sessions, makes calls, and follows the computer's
// state by polling or receiving sealed relay updates. Nothing here depends on React Native, so the same
// code runs in the tests.
import { type ResourceHandle, trackResource } from "../state/ledger";
import { agree, b64u, box, cleanCode, concat, fromUtf8, hkdf, INFO, newKeyPair, open, randomBytes, seal, pushNonce, seqBytes, seqNonce, unb64u, unbox, utf8 } from "./crypto";
import type { PairTarget } from "./pairing";
import type { ProfileHost } from "./profile";
import { normalizeCode } from "./pairing";
import { isRelayHost } from "./relay";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ReasoningDelta, ReasoningView, Run, RunSummary, Step } from "./types";

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
  /** This device joined through an invite rather than pairing with full owner trust. */
  member?: true;
  /** The name this phone keeps its presence key under, when it made one for this pairing. Never sent anywhere. */
  presenceTag?: string;
};

/** How the phone reaches the computer: on its own network, or through the relay. */
export type LinkRoute = "direct" | "relay";

/** online: in step with the computer. offline: it can't be reached. revoked: the computer no longer knows this phone. */
export type LinkState = "connecting" | "online" | "offline" | "revoked";

export type LinkErrorCode = "offline" | "revoked" | "remote" | "protocol" | "code" | "closed" | "not-found" | "join_closed" | "join_wait" | "join_owner";
export class LinkError extends Error {
  code: LinkErrorCode;
  constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> };
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal; onPart?(part: Uint8Array): void }) => Promise<FetchResponse>;

/** What a computer says about itself. Over the relay it says only the first four (no name, app or version). */
/** `pairing` says whether a code is open. Through the relay the computer leaves it out, so a stranger can't watch for one. */
type Hello = { botkins: number; serverId: string; publicKey: string; pairing?: boolean; join?: boolean; name?: string; app?: string; version?: string };

/**
 * Runs a request with a deadline. It gives up by itself at the deadline, or when `outer` aborts: it
 * never waits on the transport to say so. A request that iOS dropped while the app was suspended may
 * never settle, and that must not hold the link.
 */
async function timed<T>(ms: number, outer: AbortSignal | undefined, run: (signal: AbortSignal, renew: () => void) => Promise<T>): Promise<T> {
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
    const renew = () => {
      clearTimeout(timer);
      if (stop && !controller.signal.aborted) timer = setTimeout(stop, ms);
    };
    return await Promise.race([run(controller.signal, renew), gaveUp]);
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

/**
 * What a device tells the computer it pairs with, sealed with the code's key (the relay never reads
 * it). `name` describes the device ("iPhone 17 Pro"); `person` is who it belongs to ("Jordan"). A
 * computer from before "device-person-v1" ignores `person` and pairs as before.
 */
export type PairDevice = { name: string; platform: string; kind?: "phone" | "desktop"; presenceKey?: string; person?: string };

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
export async function pair(fetcher: FetchLike, target: PairTarget, device: PairDevice): Promise<Pairing> {
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

/**
 * Enrolls a profile device with a host already bound to that profile. The generated X25519 key is
 * deliberately fresh for this enrollment and is kept only in the returned Pairing. The ticket and
 * device details are sealed to the pinned host key before they cross either LAN or relay.
 */
export async function profileConnect(
  fetcher: FetchLike,
  target: ProfileHost,
  device: PairDevice,
  issueTicket: (publicKey: string) => Promise<string>,
): Promise<Pairing> {
  if (!target || typeof target.serverId !== "string" || typeof target.serverKey !== "string" || !Array.isArray(target.hosts) || !target.hosts.length) {
    throw new LinkError("protocol", "That profile computer is incomplete.");
  }
  let { host, hello: found } = await findHost(fetcher, target.hosts, { serverId: target.serverId, serverKey: target.serverKey });
  if (found.botkins !== PROTOCOL) throw new LinkError("protocol", "Update Botkins and your computer's app to the same version.");
  const keys = newKeyPair();
  const publicKey = b64u(keys.publicKey);
  let ticket: string;
  try {
    ticket = await issueTicket(publicKey);
  } catch {
    throw new LinkError("offline", "The profile service couldn't issue a device ticket.");
  }
  if (typeof ticket !== "string" || !ticket || ticket.length > 1024) throw new LinkError("protocol", "The profile service returned an invalid device ticket.");
  const key = hkdf(agree(keys.secretKey, unb64u(target.serverKey)), utf8(target.serverId), "botkins/profile/v1");
  const request = (at: string) => timed(10_000, undefined, (signal) => fetcher("http://" + at + PREFIX + "profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey, box: box(key, { ticket, publicKey, device }, "profile:" + target.serverId) }),
    signal,
  }));
  let response: FetchResponse;
  try {
    response = await request(host);
  } catch {
    const relays = target.hosts.filter(isRelayHost);
    if (isRelayHost(host) || !relays.length) throw new LinkError("offline", "That profile computer can't be reached right now.");
    try {
      ({ host, hello: found } = await findHost(fetcher, relays, { serverId: target.serverId, serverKey: target.serverKey }));
      response = await request(host);
    } catch {
      throw new LinkError("offline", "That profile computer can't be reached right now.");
    }
  }
  const body = (await response.json().catch(() => ({}))) as { box?: string; error?: string };
  if (!response.ok || typeof body.box !== "string") {
    if (body.error === "profile_revoked" || body.error === "profile_denied") throw new LinkError("revoked", "That profile is no longer allowed on this computer.");
    throw new LinkError("protocol", "The profile computer refused this device.");
  }
  let reply: { serverId: string; serverKey: string; device: string; name: string; hosts: string[]; member?: boolean };
  try {
    reply = unbox(key, body.box, "profile-ok:" + target.serverId);
  } catch {
    throw new LinkError("protocol", "The profile computer returned an invalid answer.");
  }
  if (reply.serverId !== target.serverId || reply.serverKey !== target.serverKey || typeof reply.device !== "string" || typeof reply.name !== "string" || !Array.isArray(reply.hosts)) {
    throw new LinkError("protocol", "The profile computer returned an incomplete answer.");
  }
  return {
    serverId: reply.serverId,
    serverKey: target.serverKey,
    deviceId: reply.device,
    secretKey: b64u(keys.secretKey),
    hosts: mergeHosts(host, reply.hosts, target.hosts, Infinity),
    name: reply.name,
    ...(reply.member === true && { member: true }),
  };
}

export type JoinTarget = {
  code: string;
  hosts: string[];
  serverKey: string;
  serverId?: string;
  name?: string;
};
export type JoinDevice = PairDevice;
export type JoinKeyPair = { publicKey: string; secretKey: string };
export type JoinAttempt = { target: JoinTarget; device: JoinDevice; keys: JoinKeyPair; serverId?: string };
export type JoinResult =
  | { status: "pending"; requestId: string; team: { name: string } }
  | { status: "approved"; pairing: Pairing }
  | { status: "denied" };

export type InviteCard = { v: 1; serverId: string; serverKey: string; name: string; room: string; hosts: string[] };
export type InviteTarget = JoinTarget & { relayBase: string; room: string };
export const DEFAULT_RELAY = "https://relay.botkins.app";

function joinFailure(body: { error?: string }, status: number, target: JoinTarget): LinkError {
  if (body.error === "join_closed") return new LinkError("join_closed", "That invite is closed or has expired.");
  if (body.error === "join_wait" || status === 429) return new LinkError("join_wait", "Too many invites were tried. Wait a moment before trying again.");
  if (body.error === "join_owner") return new LinkError("join_owner", "That code belongs to a device that is already paired as the owner.");
  return new LinkError("protocol", "Joining " + (target.name || "that team") + " didn't work. Try again.");
}

async function sendJoin(fetcher: FetchLike, attempt: JoinAttempt): Promise<{ result: JoinResult; attempt: JoinAttempt }> {
  const target = { ...attempt.target, code: normalizeCode(attempt.target.code) };
  let foundHost: Awaited<ReturnType<typeof findHost>>;
  try {
    foundHost = await findHost(fetcher, target.hosts, { serverId: target.serverId, serverKey: target.serverKey });
  } catch (error) {
    if (error instanceof LinkError) throw new LinkError(error.code === "not-found" ? "offline" : error.code, error.message);
    throw new LinkError("offline", "The team's computer can't be reached right now.");
  }
  const { host, hello: found } = foundHost;
  if (found.botkins !== PROTOCOL) throw new LinkError("protocol", "Update Botkins and the team's app to the same version.");
  const keys = { publicKey: unb64u(attempt.keys.publicKey), secretKey: unb64u(attempt.keys.secretKey) };
  const code = normalizeCode(target.code);
  const key = hkdf(agree(keys.secretKey, unb64u(target.serverKey)), utf8(code), "botkins-join-v1");
  let response: FetchResponse;
  try {
    response = await timed(10_000, undefined, (signal) =>
      fetcher("http://" + host + PREFIX + "join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: attempt.keys.publicKey, box: box(key, attempt.device, "join:" + found.serverId) }),
        signal,
      }),
    );
  } catch {
    throw new LinkError("offline", "Can't reach " + (target.name || "that team") + " right now. Try again when the owner's computer is on.");
  }
  const body = (await response.json().catch(() => ({}))) as { box?: string; error?: string };
  if (!response.ok || !body.box) throw joinFailure(body, response.status, target);
  let answer: { status: "pending" | "approved" | "denied"; requestId?: string; team?: { name: string }; device?: string; serverId?: string; name?: string; hosts?: string[] };
  try {
    answer = unbox(key, body.box, "joined:" + found.serverId);
  } catch {
    throw new LinkError("protocol", "That team's answer could not be opened.");
  }
  const next = { ...attempt, target: { ...target, serverId: found.serverId }, serverId: found.serverId };
  if (answer.status === "pending" && answer.requestId && answer.team) return { result: { status: "pending", requestId: answer.requestId, team: answer.team }, attempt: next };
  if (answer.status === "denied") return { result: { status: "denied" }, attempt: next };
  if (answer.status === "approved" && answer.device && answer.serverId && answer.name && Array.isArray(answer.hosts)) {
    const hosts = mergeHosts(host, answer.hosts, target.hosts, Infinity);
    return {
      result: {
        status: "approved",
        pairing: { serverId: answer.serverId, serverKey: target.serverKey, deviceId: answer.device, secretKey: attempt.keys.secretKey, hosts, name: answer.name, member: true },
      },
      attempt: next,
    };
  }
  throw new LinkError("protocol", "That team's answer was incomplete.");
}

/** Starts one join request. Keep `attempt` to check the same request without using a second key. */
export async function startJoin(fetcher: FetchLike, target: JoinTarget, device: JoinDevice): Promise<{ result: JoinResult; attempt: JoinAttempt }> {
  const keys = newKeyPair();
  return sendJoin(fetcher, { target: { ...target, code: normalizeCode(target.code) }, device, keys: { publicKey: b64u(keys.publicKey), secretKey: b64u(keys.secretKey) } });
}
/** Repeats the sealed request with the same key, which checks status on the host. */
export function checkJoin(fetcher: FetchLike, attempt: JoinAttempt): Promise<JoinResult> {
  return sendJoin(fetcher, attempt).then(({ result }) => result);
}
/**
 * A convenience join call with the result's status at the top level. Pass the returned `attempt`
 * on the next call to check status without creating a second request.
 */
export async function join(fetcher: FetchLike, target: JoinTarget, device: JoinDevice, previous?: JoinAttempt): Promise<JoinResult & { attempt: JoinAttempt }> {
  const outcome = previous ? await sendJoin(fetcher, previous) : await startJoin(fetcher, target, device);
  return { ...outcome.result, attempt: outcome.attempt };
}

/** Reads and opens the relay's sealed invite directory entry. */
export async function findInvite(
  fetcher: FetchLike,
  code: string,
  relayBase: string | { relayBase?: string; serverKey?: string } = DEFAULT_RELAY,
  expectedServerKey?: string,
): Promise<InviteTarget> {
  const clean = normalizeCode(code);
  const options = typeof relayBase === "string" ? { relayBase, serverKey: expectedServerKey } : relayBase;
  const base = String(options.relayBase || DEFAULT_RELAY).replace(/\/+$/, "");
  if (clean.length !== 10) throw new LinkError("join_closed", "Enter the ten-character invite code.");
  const lookup = b64u(sha256(utf8("botkins-invite-v1:" + clean)));
  let response: FetchResponse;
  try {
    response = await timed(10_000, undefined, (signal) => fetcher(base + "/v1/invites/" + lookup, { signal }));
  } catch {
    throw new LinkError("offline", "The invite service can't be reached right now.");
  }
  const body = (await response.json().catch(() => ({}))) as { card?: string };
  if (response.status === 404) throw new LinkError("join_closed", "That invite is closed or has expired.");
  if (!response.ok || typeof body.card !== "string") throw new LinkError("offline", "The invite service couldn't find that team.");
  const cardKey = hkdf(utf8(clean), utf8("botkins-invite-card-v1"), lookup);
  let card: InviteCard;
  try {
    const sealed = unb64u(body.card);
    if (sealed.length > 4096 || sealed.length < 28) throw new Error("card");
    card = JSON.parse(fromUtf8(open(cardKey, sealed.subarray(0, 12), sealed.subarray(12), ""))) as InviteCard;
  } catch {
    throw new LinkError("join_closed", "That invite code couldn't be opened.");
  }
  if (card.v !== 1 || !Array.isArray(card.hosts) || typeof card.serverId !== "string" || !card.serverId || !/^[A-Za-z0-9_-]{43}$/.test(card.serverKey) || !/^[A-Za-z0-9_-]{43}$/.test(card.room) || typeof card.name !== "string") {
    throw new LinkError("protocol", "That invite card is not a supported Botkins invite.");
  }
  if (options.serverKey && card.serverKey !== options.serverKey) throw new LinkError("join_closed", "That invite points to a different computer.");
  return { code: clean, serverId: card.serverId, serverKey: card.serverKey, name: card.name.slice(0, 60), hosts: card.hosts.filter((host) => typeof host === "string"), room: card.room, relayBase: base };
}

/** The key this phone and its computer share from pairing. Sessions are built on it. */
const deviceKeyOf = (pairing: Pairing) => hkdf(agree(unb64u(pairing.secretKey), unb64u(pairing.serverKey)), utf8(pairing.deviceId), INFO.device);
/**
 * The key sealed notifications are opened with (link-host/push.mjs seals with the same one). The
 * phone keeps it where its notification extension can read it; it never leaves the phone.
 */
export const pushKeyOf = (pairing: Pairing) => hkdf(deviceKeyOf(pairing), utf8(pairing.deviceId), "botkins/push/v1");

type Session = { id: string; toHost: Uint8Array; toPhone: Uint8Array; seq: number; pushCounter: number; base: string };
const routeOf = (session: Session | null): LinkRoute | null => (session ? (isRelayHost(session.base.replace(/^http:\/\//, "")) ? "relay" : "direct") : null);
type SyncNews = { epoch: string; v: Record<string, number> | null; parts: Record<string, unknown> };
class Retry extends Error {}

// Same preview as the host. The portable client is bundled independently of the host modules.
function reasoningPreview(items: ReasoningView["items"], botId?: string) {
  const tail = [];
  let remaining = 4000;
  for (let index = items.length - 1; index >= 0 && remaining; index--) {
    const item = items[index];
    if (!item.text || (botId && item.botId !== botId)) continue;
    if (tail.length) {
      const separator = "\n\n".slice(-remaining);
      tail.push(separator);
      remaining -= separator.length;
      if (!remaining) break;
    }
    const suffix = item.text.slice(-remaining);
    tail.push(suffix);
    remaining -= suffix.length;
  }
  return tail.reverse().join("");
}

type RowPatch<T> = { base: number; set?: T[]; remove?: string[]; order?: string[] };
type RunStepPatch = RowPatch<Step> & { patch: "steps"; run: string; metadata?: Omit<Run, "steps"> };
type RunSummaryPatch = RowPatch<RunSummary> & { patch: "summaries" };

function patchedRows<T extends { id: string }>(held: T[], patch: RowPatch<T>): T[] | null {
  if (!patch.set?.length && !patch.remove?.length && !patch.order) return held;
  const byId = new Map(held.map(row => [row.id, row]));
  for (const id of patch.remove ?? []) if (!byId.delete(id)) return null;
  for (const row of patch.set ?? []) byId.set(row.id, row);
  if (!patch.order) return [...byId.values()];
  if (patch.order.length !== byId.size || new Set(patch.order).size !== byId.size || patch.order.some(id => !byId.has(id))) return null;
  return patch.order.map(id => byId.get(id)!);
}

/** Reconstruct the phone's existing run shape, retaining references to all untouched steps. */
function patchedRun(held: Run, patch: RunStepPatch): Run | null {
  if (held.id !== patch.run || held.status !== "Working" || !Array.isArray(held.steps)) return null;
  if (patch.metadata && (patch.metadata.id !== held.id || patch.metadata.chatId !== held.chatId || patch.metadata.status !== "Working")) return null;
  const steps = patchedRows(held.steps, patch);
  return steps && { ...(patch.metadata ?? held), steps };
}

type PreviewSource = { run: string; botId?: string };
type HeldText = { id: string; stream: string; thinking: string; preview?: PreviewSource };
type Append = { from: number; add: string };
type TextDelta = { id: string; stream: Append; thinking: Append; preview?: PreviewSource };

export type LinkOptions = {
  /** Opt in to boolean live indicators and expanded text:<chatId> parts for watched chats. */
  streamAppends?: boolean;
  /** Request detailed reasoning only for explicit consumers, independently of reply streaming. */
  separateThinking?: boolean;
  /**
   * Ask for steps without their long input and output ("step-details-v1"): such a step says
   * `more: true`, and `link.step` reads it when it is opened. A computer without it sends them whole.
   */
  lightSteps?: boolean;
  /** Negotiate incremental working-run steps with a compatible host. Requires lightSteps. */
  runStepDeltas?: boolean;
  /** Receive keyed edits to the visible run summary list ("run-summary-deltas-v1"). */
  runSummaryDeltas?: boolean;
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
  /** While connected through the relay, the first wait before looking for a direct address (default 5 s). Each wait after doubles. */
  probeMs?: number;
  /** The longest wait between direct probes (default 60 s). */
  probeMaxMs?: number;
  /** Called when the link wakes: the transport proves its open connections are alive (the relay's sockets). */
  check?(): void;
  /** After a wake, how long the first answer may take before the path is given up (default 4 s). */
  wakeMs?: number;
  /** Each time a sync came back: the phone is in step with the computer now. */
  onSync?(): void;
  /**
   * How a reply's text comes on this route (default "live", as it is written; true is "live" too). "whole" or
   * false sends `text: false` ("text-streaming-off-v1"): the indicators stay and the reply comes whole when it
   * ends. "chunks" sends `text: "chunks"` ("text-chunks-v1"): the reply's text comes after whole words a few
   * times a second, the first words at once (older computers: whole sentences every couple of seconds), or
   * whole from a computer without that. Read on each sync; call `textStreamingChanged`
   * when the answer may have changed.
   */
  textStreaming?(route: LinkRoute): boolean | TextMode;
};

/** How a reply's text is followed: as it is written, in whole words now and then, or whole when it ends. */
export type TextMode = "live" | "chunks" | "whole";

const WAITS = [400, 1000, 2000, 4000, 8000, 15000];
/** How long a direct address that answered and then failed is left out, when there is a relay to use. */
const DISTRUST_MS = 10 * 60_000;
/** How long a direct probe waits for its hello. Longer than the first look's 1.5 s: nobody waits on it. */
const PROBE_HELLO_MS = 3000;

export class LinkClient {
  state: LinkState = "connecting";
  private session: Session | null = null;
  private opening: Promise<Session> | null = null;
  private epoch = "";
  private texts = new Map<string, HeldText>();
  private reasonings = new Map<string, ReasoningView>();
  private supportsAppends: boolean | undefined;
  private supportsReasoning: boolean | undefined;
  private supportsStepDeltas: boolean | undefined;
  private supportsSummaryDeltas: boolean | undefined;
  private summaryBase?: { version: number; rows: RunSummary[] };
  private runBases = new Map<string, { version: number; run: Run }>();
  private receivedFullLive = false;
  /** What the last sync asked for, as the option said it and as it was sent. */
  private sentMode: TextMode = "live";
  private sentText: TextMode = "live";
  private supportsPush = false;
  private pushSession: Session | null = null;
  /** Whether the computer sends text in chunks ("text-chunks-v1"), once it has said. */
  private supportsChunks: boolean | undefined;
  private supportsTextWatch = false;
  private have: Record<string, number> = {};
  private watching: string[] = [];
  private keptPage?: string;
  private replyChats: string[] = [];
  private reasoningWatching: string[] = [];
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
  private probeLedger: ResourceHandle | undefined;
  private probeDelay: number;
  private readonly probeMs: number;
  private readonly probeMaxMs: number;
  /** Set by a wake: the path in use may have died while the phone was away, so the next sync proves it quickly. */
  private wakeCheck: { deadline?: number } | null = null;
  /** Set by `rest`: the app is in the background, so nothing is followed until `wake`. */
  private resting = false;

  constructor(
    private pairing: Pairing,
    private options: LinkOptions,
  ) {
    this.deviceKey = deviceKeyOf(pairing);
    this.probeMs = options.probeMs ?? 5_000;
    this.probeMaxMs = Math.max(this.probeMs, options.probeMaxMs ?? 60_000);
    this.probeDelay = this.probeMs;
  }

  /** Starts following the computer. Keeps trying while it can't be reached. */
  start({ resting = false }: { resting?: boolean } = {}) {
    if (this.running) return;
    this.running = true;
    this.resting = resting;
    this.lifetime ??= {};
    this.scheduleProbe();
    void this.follow(this.lifetime);
  }
  private endPush() {
    const session = this.pushSession;
    if (!session) return;
    this.pushSession = null;
    void this.request("link.unfollow", [], 4000, undefined, session).catch(() => {});
  }

  stop() {
    this.endPush();
    this.running = false;
    this.wakeCheck = null;
    this.lifetime = null;
    this.opening = null;
    this.probing = null;
    clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    this.probeLedger?.release();
    this.probeLedger = undefined;
    this.probeDelay = this.probeMs;
    this.poll?.abort();
    this.wakeUp?.();
    this.session = null;
    this.setRoute(null);
  }
  /**
   * Try again now: the app came to the front, the network changed, or the user tapped refresh. The
   * path in use is not trusted after that. The next sync asks for an answer at once and gives it a
   * few seconds; when none comes the session is dropped and the computer is looked for afresh, on
   * every address. So a phone that was away comes back in seconds, not when a 40-second wait runs
   * out.
   */
  wake(reason?: "network" | "retry") {
    if (!this.lifetime) return;
    this.resting = false;
    this.probeDelay = this.probeMs;
    // On another network, or a manual retry, an address that failed gets a fresh try.
    if (reason === "network" || reason === "retry") this.distrusted.clear();
    // A manual retry while offline shows as connecting again until the next attempt settles.
    if (reason === "retry" && this.state === "offline") this.setState("connecting");
    this.wakeCheck = {};
    // A socket can look open long after the system closed it under a suspended app.
    this.options.check?.();
    this.wakeUp?.();
    // The waiting sync may be on a path that just died (the phone left the network).
    this.poll?.abort();
    if (this.route === "relay") void this.probeDirect(false);
    else this.scheduleProbe();
  }
  /**
   * The app went to the background: stop following (no waiting request, no probe) until `wake`.
   * A phone in the background does no work for the link; calls made meanwhile still go through.
   */
  rest() {
    if (!this.lifetime || this.resting) return;
    this.endPush();
    this.resting = true;
    clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    this.probeLedger?.release();
    this.probeLedger = undefined;
    this.poll?.abort();
    // Clear any pending reconnect backoff timer immediately so the follow loop parks at rest.
    this.wakeUp?.();
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
  watch(chatIds: string[], keptPage?: string, replyChats = chatIds) {
    const next = [...new Set(chatIds)].sort();
    const replies = next.filter((id) => replyChats.includes(id));
    if (next.join("\n") === this.watching.join("\n") && keptPage === this.keptPage && replies.join("\n") === this.replyChats.join("\n")) return;
    this.replyChats = replies;
    this.keptPage = keptPage;
    this.watching = next;
    if (this.options.streamAppends && this.supportsAppends) delete this.have.live;
    // The waiting request is for the old set: ask again.
    this.poll?.abort();
  }
  /** Requests detailed reasoning for these chats even when reply text is whole/off. */
  watchReasoning(chatIds: string[]) {
    const next = [...new Set(chatIds)].filter((id) => id.length > 0 && id.length <= 128).sort().slice(0, 4);
    if (next.join("\n") === this.reasoningWatching.join("\n")) return;
    this.reasoningWatching = next;
    this.poll?.abort();
  }
  /** The choice behind `textStreaming` changed: a waiting sync that asked otherwise asks again. */
  textStreamingChanged() {
    if (this.session && this.textFor(this.session) !== this.sentMode) this.poll?.abort();
  }
  private textFor(session: Session): TextMode {
    const mode = this.options.textStreaming?.(routeOf(session)!) ?? "live";
    return mode === true ? "live" : mode === false ? "whole" : mode;
  }

  /** Sets the session and reports how it connects. */
  private useSession(session: Session | null) {
    if (this.pushSession && this.pushSession !== session) this.endPush();
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
    this.probeLedger?.release();
    this.probeLedger = undefined;
    if (this.running && !this.resting && this.route === "relay" && this.probing !== this.session) {
      this.probeLedger = trackResource("timer", "LinkClient:probe", "relay-to-direct", this.pairing.serverId);
      this.probeTimer = setTimeout(() => {
        this.probeLedger?.bump();
        this.probeLedger?.release();
        this.probeLedger = undefined;
        void this.probeDirect();
      }, this.probeDelay);
    }
  }

  /**
   * While connected through the relay: asks the direct addresses (3 s, in the background: a phone's
   * VPN can be slow to wake) and, when one answers as the
   * right computer, drops the session so the next request opens a direct one. A call in flight keeps
   * the session it started with; only the waiting sync request is cut short. True when it switched.
   */
  async probeDirect(backOff = true): Promise<boolean> {
    const seen = this.session;
    if (!this.running || !seen || this.probing === seen || routeOf(seen) !== "relay") return false;
    this.probing = seen;
    clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    this.probeLedger?.release();
    this.probeLedger = undefined;
    // Keep this wait if a direct hello answers but the next session still needs the relay.
    if (backOff) this.probeDelay = Math.min(this.probeDelay * 2, this.probeMaxMs);
    try {
      const direct = this.trusted(this.pairing.hosts.filter((host) => !isRelayHost(host)));
      if (!direct.length) return false;
      await findHost(this.options.fetch, direct, { serverId: this.pairing.serverId, serverKey: this.pairing.serverKey }, PROBE_HELLO_MS);
      if (this.resting || this.session !== seen || this.opening) return false;
      this.useSession(null);
      this.poll?.abort();
      this.wakeUp?.();
      return true;
    } catch {
      return false;
    } finally {
      if (this.probing === seen) {
        this.probing = null;
        if (this.session === seen && !this.resting) this.scheduleProbe();
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
      if (response.status === 403 && body.error === "profile_revoked") throw new LinkError("revoked", "This profile device is no longer active on " + pairing.name + ".");
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
        this.supportsAppends = undefined;
        this.supportsReasoning = undefined;
        this.supportsStepDeltas = undefined;
        this.supportsSummaryDeltas = undefined;
        this.summaryBase = undefined;
        this.runBases.clear();
        this.supportsPush = false;
        this.supportsChunks = undefined;
        this.have = {};
        this.reasonings.clear();
      }
      const session = { id: reply.session, toHost: hkdf(master, salt, INFO.toHost), toPhone: hkdf(master, salt, INFO.toPhone), seq: 0, pushCounter: 0, base };
      if (this.lifetime === lifetime) this.useSession(session);
      return session;
    }
  }

  private async request<T>(method: string, args: unknown[], timeout: number, signal?: AbortSignal, active?: Session, onNews?: (news: SyncNews) => void): Promise<T> {
    const session = active ?? await this.openSession();
    if (signal?.aborted) throw new Error("The request was cancelled");
    const seq = ++session.seq;
    const sealed = seal(session.toHost, seqNonce(seq), utf8(JSON.stringify({ m: method, a: args })), "rpc:" + session.id);
    let first = true;
    const body = await timed(timeout, signal, async (inner, renew) => {
      const response = await this.options.fetch(session.base + PREFIX + "rpc", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-botkins-session": session.id },
        body: concat(seqBytes(seq), sealed),
        signal: inner,
        ...(onNews && { onPart: (part: Uint8Array) => {
          if (inner.aborted || this.session !== session) return;
          if (part.length < 24) throw new Retry();
          const view = new DataView(part.buffer, part.byteOffset, 8);
          const counter = view.getUint32(0) * 0x100000000 + view.getUint32(4);
          if (!Number.isSafeInteger(counter) || counter <= session.pushCounter || (!first && counter !== session.pushCounter + 1)) throw new Retry();
          const aad = "push:" + session.id + ":" + seq + ":" + (first ? "first" : "more");
          let news: SyncNews;
          try {
            news = JSON.parse(fromUtf8(open(session.toPhone, pushNonce(counter), part.subarray(8), aad)));
          } catch {
            throw new Retry();
          }
          session.pushCounter = counter;
          first = false;
          renew();
          onNews(news);
        } }),
      });
      if (response.status === 401) {
        // The computer forgot the session (its app restarted, or the phone was away for long).
        if (this.session === session) this.useSession(null);
        throw new Retry();
      }
      if (response.status === 403) {
        const denial = await response.json().catch(() => ({})) as { error?: string };
        if (denial.error === "profile_revoked") throw new LinkError("revoked", "This profile device is no longer active.");
      }
      if (!response.ok) throw new LinkError("protocol", "Your computer couldn't read that (" + response.status + ").");
      // fetch can resolve at headers; the viewer still owns the download until the last byte.
      return response.arrayBuffer();
    });
    const bytes = new Uint8Array(body);
    const answer = JSON.parse(fromUtf8(open(session.toPhone, seqNonce(seq), bytes, "ok:" + session.id))) as { r?: T; e?: { message: string } };
    if (answer.e) throw new LinkError("remote", answer.e.message);
    return answer.r as T;
  }

  /** One of the computer's calls. Rejects with a LinkError: "remote" carries the computer's own message. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.callWithSignal<T>(method, undefined, ...args);
  }

  async callWithSignal<T>(method: string, signal: AbortSignal | undefined, ...args: unknown[]): Promise<T> {
    const lifetime = this.lifetime;
    for (let attempt = 0; ; attempt++) {
      try {
        if (signal?.aborted) throw new Error("The request was cancelled");
        // Pi waits for npm to finish installing dependencies on the computer.
        return await this.request<T>(method, args, method === "cloneProjectRepository" ? 300_000 : method === "piPackages.install" ? 150_000 : 60_000, signal);
      } catch (error) {
        if (!signal?.aborted && this.lifetime === lifetime && error instanceof Retry && attempt < 2) continue;
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

  private cursors() {
    return Object.fromEntries(this.watching.slice(0, 4).flatMap((chat) => {
      const held = this.texts.get(chat);
      return held ? [[chat, { id: held.id, stream: held.stream.length, thinking: held.thinking.length }]] : [];
    }));
  }

  private releaseReasoning(keep: string[]) {
    const cleared: Record<string, null> = {};
    for (const chat of this.reasonings.keys()) {
      if (keep.includes(chat)) continue;
      this.reasonings.delete(chat);
      delete this.have["reasoning:" + chat];
      cleared["reasoning:" + chat] = null;
    }
    if (Object.keys(cleared).length) this.options.onParts(cleared);
  }

  private retryRunSync(): never {
    // A part of this poll or pushed frame was lost. Replay everything in this batch from a fresh
    // baseline, including any text cursor or reasoning already expanded before the failure.
    this.have = {};
    this.runBases.clear();
    this.summaryBase = undefined;
    this.texts.clear();
    this.reasonings.clear();
    throw new Retry();
  }

  private expandRunSummaries(parts: Record<string, unknown>, versions: Record<string, number>) {
    if (!Object.hasOwn(parts, "runs")) return;
    const wire = parts.runs as RunSummary[] | RunSummaryPatch;
    let rows: RunSummary[];
    if (Array.isArray(wire)) rows = wire;
    else {
      const base = this.summaryBase;
      if (wire.patch !== "summaries" || !base || base.version !== wire.base || this.have.runs !== wire.base) this.retryRunSync();
      rows = patchedRows(base.rows, wire) ?? this.retryRunSync();
      parts.runs = rows;
    }
    this.summaryBase = { version: versions.runs!, rows };
  }

  private expandRunSteps(parts: Record<string, unknown>, versions: Record<string, number>) {
    for (const [name, value] of Object.entries(parts)) {
      if (!name.startsWith("run:")) continue;
      const chat = name.slice(4);
      const wire = value as RunStepPatch | Run | null;
      let run: Run | null;
      if (wire && "patch" in wire && wire.patch === "steps") {
        const base = this.runBases.get(chat);
        run = base && this.have[name] === wire.base && base.version === wire.base ? patchedRun(base.run, wire) : null;
        if (!run) this.retryRunSync();
        parts[name] = run;
      } else run = wire as Run | null;
      if (run?.status === "Working" && Array.isArray(run.steps)) this.runBases.set(chat, { version: versions[name]!, run });
      else this.runBases.delete(chat);
    }
  }

  private expandReasoning(parts: Record<string, unknown>) {
    const meta = parts.meta as { capabilities?: string[] } | undefined;
    if (meta) this.supportsReasoning = meta.capabilities?.includes("reasoning-appends-v1") === true;
    for (const [name, value] of Object.entries(parts)) {
      if (!name.startsWith("reasoning:")) continue;
      const chat = name.slice(10);
      if (!value) {
        this.reasonings.delete(chat);
        continue;
      }
      const delta = value as ReasoningDelta;
      const previous = this.reasonings.get(chat);
      if (!delta.reset && previous?.run !== delta.run) {
        delete this.have[name];
        throw new Retry();
      }
      const byId = new Map((delta.reset || previous?.run !== delta.run ? [] : previous?.items ?? []).map((item) => [item.id, item]));
      for (const id of delta.remove ?? []) {
        byId.delete(id);
      }
      for (const item of delta.items ?? []) {
        const held = byId.get(item.id);
        if (item.from !== 0 && (!held || held.text.length !== item.from)) {
          this.have = {};
          this.texts.clear();
          this.reasonings.clear();
          throw new Retry();
        }
        const text = item.from === 0 ? item.add : held!.text + item.add;
        byId.set(item.id, { id: item.id, text, started: item.started, ...(item.finished !== undefined && { finished: item.finished }), ...(item.botId && { botId: item.botId }) });
      }
      const items = delta.order ? delta.order.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []) : [...byId.values()];
      const view = { run: delta.run, items };
      this.reasonings.set(chat, view);
      parts[name] = view;
    }
    // A step may replace the compact run without changing its separately versioned reasoning.
    for (const [chat, held] of this.reasonings) {
      const run = parts["run:" + chat] as { id: string; status: string } | null | undefined;
      const key = "reasoning:" + chat;
      if (run?.status === "Working" && run.id === held.run && !(key in parts)) parts[key] = held;
    }
  }

  private expandText(parts: Record<string, unknown>, watching: string[], requested: boolean) {
    const meta = parts.meta as { capabilities?: string[] } | undefined;
    if (meta) this.supportsAppends = meta.capabilities?.includes("stream-appends-v1") === true;
    const live = parts.live as { streams: Record<string, unknown>; thinking: Record<string, unknown> } | undefined;
    if (!requested || this.supportsAppends === false) {
      this.texts.clear();
      if (live) this.receivedFullLive = true;
      return;
    }
    if (live && this.receivedFullLive) {
      // The previous full snapshot could include bodies for chats we have never watched.
      for (const chat of [...Object.keys(live.streams), ...Object.keys(live.thinking)]) {
        if (!("text:" + chat in parts)) parts["text:" + chat] = null;
      }
      this.receivedFullLive = false;
    }
    for (const chat of this.texts.keys()) {
      if (!watching.includes(chat) || (live && !(chat in live.streams) && !(chat in live.thinking))) {
        this.texts.delete(chat);
        parts["text:" + chat] = null;
      }
    }
    for (const [name, value] of Object.entries(parts)) {
      if (!name.startsWith("text:")) continue;
      const chat = name.slice(5);
      if (!value) {
        this.texts.delete(chat);
        continue;
      }
      const delta = value as TextDelta;
      const prev = this.texts.get(chat);
      const expand = (field: "stream" | "thinking") => {
        const { from, add } = delta[field];
        if (from === 0) return add;
        if (prev?.id !== delta.id || prev[field].length !== from) {
          // Replay the entire answer, including other chats already expanded in this batch. The
          // session is fine, so this asks again from zero and is not a lost connection.
          this.have = {};
          this.texts.clear();
          throw new Retry();
        }
        return prev[field] + add;
      };
      const stream = expand("stream");
      const thinking = expand("thinking");
      this.texts.set(chat, { id: delta.id, stream, thinking, preview: delta.preview });
      parts[name] = { stream, thinking };
    }
  }

  private publishThinkingPreviews(parts: Record<string, unknown>, watching: string[]) {
    for (const chat of watching) {
      const key = "text:" + chat;
      if (!(key in parts) && !("reasoning:" + chat in parts)) continue;
      const held = this.texts.get(chat);
      const reasoning = this.reasonings.get(chat);
      if (held?.preview) {
        parts[key] = { stream: held.stream, thinking: reasoning?.run === held.preview.run ? reasoningPreview(reasoning.items, held.preview.botId) : "" };
      }
    }
  }

  private async follow(lifetime: object) {
    let failures = 0;
    while (this.lifetime === lifetime) {
      if (this.resting) {
        // At rest until a wake (or a stop, which wakes this too).
        await new Promise<void>((resolve) => {
          this.wakeUp = () => {
            this.wakeUp = null;
            resolve();
          };
        });
        continue;
      }
      const poll = new AbortController();
      this.poll = poll;
      try {
        // After a wake the path has to prove itself: no waiting on the computer's side, and a short deadline.
        const check = this.wakeCheck;
        const quick = check !== null;
        const session = await this.openSession();
        if (poll.signal.aborted) continue;
        const mode = this.textFor(session);
        const watching = this.watching;
        const restricted = this.replyChats.length < watching.length;
        // Older computers can turn off text for all watches together. Keep a detail-only chat quiet there too.
        const text: TextMode = (restricted && (!this.supportsTextWatch || !this.replyChats.length)) ||
          (mode === "chunks" && this.supportsChunks === false) ? "whole" : mode;
        // Text back on: the computer sends each held body again from its start.
        if (text !== "whole" && this.sentText === "whole") {
          this.texts.clear();
          delete this.have.live;
        }
        this.sentMode = mode;
        this.sentText = text;
        const detailed = this.reasoningWatching;
        const requestText = !!this.options.streamAppends && this.supportsAppends !== false &&
          watching.slice(0, 4).every((id) => id.length > 0 && id.length <= 128);
        const appends = requestText ? { appends: this.cursors() } : {};
        const requestReasoning = requestText && this.supportsReasoning !== false;
        const reasoningWatch = requestReasoning ? [...new Set([...detailed, ...(!this.options.separateThinking && text !== "whole" ? watching.slice(0, 4) : [])])].slice(0, 4) : [];
        this.releaseReasoning(reasoningWatch);
        for (const chat of this.runBases.keys()) if (!watching.includes(chat) && !reasoningWatch.includes(chat)) {
          this.runBases.delete(chat);
          delete this.have["run:" + chat];
        }
        const requestSummaryDeltas = this.options.runSummaryDeltas && this.supportsSummaryDeltas !== false;
        const requestStepDeltas = this.options.runStepDeltas && this.options.lightSteps && this.supportsStepDeltas !== false;
        if (poll.signal.aborted) continue;
        const push = !quick && routeOf(session) === "relay" && this.supportsPush &&
          "supportsPush" in this.options.fetch && this.options.fetch.supportsPush === true;
        const accept = (news: SyncNews) => {
          if (this.lifetime !== lifetime || poll.signal.aborted) return;
          failures = 0;
          this.setState("online");
          if (this.lifetime !== lifetime || poll.signal.aborted) return;
          if (news.epoch !== this.epoch) {
            this.epoch = news.epoch;
            this.runBases.clear();
            this.summaryBase = undefined;
            this.have = {};
          }
          if ((this.options.streamAppends || this.options.runStepDeltas) && (watching !== this.watching || detailed !== this.reasoningWatching)) return;
          if (news.v) {
            const meta = news.parts.meta as { capabilities?: string[] } | undefined;
            if (meta) {
              this.supportsPush = meta.capabilities?.includes("sync-push-v1") === true;
              this.supportsTextWatch = meta.capabilities?.includes("text-watch-v1") === true;
              this.supportsChunks = meta.capabilities?.includes("text-chunks-v1") === true;
              this.supportsStepDeltas = meta.capabilities?.includes("run-step-deltas-v1") === true;
              this.supportsSummaryDeltas = meta.capabilities?.includes("run-summary-deltas-v1") === true;
            }
            if (requestSummaryDeltas && this.supportsSummaryDeltas) this.expandRunSummaries(news.parts, news.v);
            if (requestStepDeltas && this.supportsStepDeltas) this.expandRunSteps(news.parts, news.v);
            if (this.options.streamAppends) this.expandText(news.parts, watching.slice(0, 4), requestText);
            if (this.options.streamAppends) this.expandReasoning(news.parts);
            if (requestReasoning && text !== "whole") this.publishThinkingPreviews(news.parts, watching);
            this.have = news.v;
            this.options.onParts(news.parts);
          }
          this.options.onSync?.();
        };
        const args = { epoch: this.epoch, have: this.have, watch: watching, templateVersion: 2, ...(restricted && text !== "whole" && { textWatch: this.replyChats }), ...(this.keptPage && { keepPage: this.keptPage }), ...appends, ...(requestReasoning && { reasoningWatch, ...(this.options.separateThinking && { separateThinking: true }) }), ...(text !== "live" && { text: text === "chunks" ? "chunks" : false }), ...(this.options.lightSteps && { steps: "light" }), ...(requestStepDeltas && { runSteps: "delta" }), ...(requestSummaryDeltas && { runSummaries: "delta" }), ...(!push && { wait: quick ? 0 : 25_000 }) };
        if (push) this.pushSession = session;
        const pollLedger = trackResource("poll", "LinkClient:sync", push ? "link.follow" : "link.sync", this.pairing.serverId);
        let news: SyncNews;
        try {
          // Watching another chat replaces this poll. Both attempts must fit in the same wake check.
          let timeout = 40_000;
          if (check) {
            check.deadline ??= Date.now() + (this.options.wakeMs ?? 4000);
            timeout = check.deadline - Date.now();
            if (timeout <= 0) throw new Error("The wake check expired");
          }
          news = await this.request<SyncNews>(push ? "link.follow" : "link.sync", [args],
            timeout, poll.signal, session, push ? accept : undefined);
        } finally {
          pollLedger.release();
        }
        if (this.lifetime !== lifetime || poll.signal.aborted) continue;
        this.wakeCheck = null;
        if (push && this.pushSession === session) this.pushSession = null;
        accept(news);
      } catch (error) {
        if (this.lifetime !== lifetime) break;
        // Cut short on purpose (the watched chats changed, or the app went to rest), or a session to renew: go again.
        if (poll.signal.aborted || this.resting) continue;
        this.wakeCheck = null;
        if (error instanceof Retry) continue;
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
