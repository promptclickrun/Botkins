// Turning on what phones may do with this computer's screen, from a phone ("screen-grant-v1").
//
// A computer with a window sets this in its own Settings › Phone. A headless host has no window, so
// nobody could ever turn the screen on there. On such a host, and only there, a paired phone may set
// the level itself. It is the one thing a phone can do that widens what phones may do, so it asks
// for more than a paired session:
//
//   - the host is headless (the app says so: `backend.headless === true`);
//   - the call arrived straight over HTTP, never through the relay, also in a session that was
//     opened directly. One host is different: a server that runs its own relay, where phones have
//     no other way in. Its app says so (`relay.own`), the host then names "screen-grant-relay-v1",
//     and these calls and a phone's presence key are taken through that relay too. The relay still
//     can't make a grant: it carries sealed messages, and a grant needs the phone's signature;
//   - the device is a phone;
//   - the phone proves a person is holding it. When it paired (directly, with the code the owner
//     was shown) it gave a second public key, P-256, whose private half the phone keeps where it
//     can be used only after Face ID, Touch ID or the passcode. To turn the screen on, the phone
//     asks for a ticket (`begin`), signs it with that key, and sends the signature (`confirm`).
//     A program that has only the pairing's ordinary keys can't make that signature.
//
// A ticket is random, lasts 60 seconds, works once, and belongs to one session, one device, this
// host and one level. Any change of the level, and the session ending, ends it. Turning the screen
// off (`revoke`) needs no ticket and no signature: taking access away is one tap.
//
// Nothing here is reachable by a bot: these are the link's own calls, answered only inside a paired
// device's sealed session. They are not among the app's calls a phone may make (methods.mjs), no
// tool a bot has is given this object, and the app registers no other way in.
import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { Failure } from "./tools.mjs";

export const GRANT_CAPABILITY = "screen-grant-v1";
/** A headless host that takes the grant calls through its own relay as well ("relay.own"). */
export const GRANT_RELAY_CAPABILITY = "screen-grant-relay-v1";
export const GRANT_LEVELS = ["view", "control"];
export const TICKET_MS = 60_000;
const TICKET_BYTES = 32;
const SIGNED_AS = "botkins-screen-grant-v1";

export const NOT_HEADLESS = "Change this on the computer itself.";
export const NOT_DIRECT = "This can't be changed through the relay. Connect to the computer's own network and try again.";
export const NOT_A_PHONE = "Only a paired phone can change this.";
export const NO_PRESENCE_KEY = "Pair this phone with the computer again to change this from the phone.";
export const TICKET_GONE = "That confirmation ran out. Try again.";
export const NOT_CONFIRMED = "This phone couldn't confirm it was you. Try again.";

/** A P-256 public key as a phone sends it when it pairs (SPKI, base64url), or null when it is anything else. */
export function cleanPresenceKey(value) {
  if (typeof value !== "string" || value.length < 100 || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? value : null;
  } catch {
    return null;
  }
}

/** What the phone signs, as text. Both ends build exactly this. */
export const grantMessage = (serverId, deviceId, level, ticket) => JSON.stringify([SIGNED_AS, serverId, deviceId, level, ticket]);

/** Whether `signature` (DER, base64url) is the phone's over the ticket: P-256 with SHA-256. */
export function signedByPhone(presenceKey, message, signature) {
  if (typeof signature !== "string" || !signature || signature.length > 200 || !/^[A-Za-z0-9_-]+$/.test(signature)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(presenceKey, "base64url"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export class ScreenGrants {
  /**
   * @param options.serverId  This host's id: part of what a phone signs.
   * @param options.device    (deviceId) => the paired device's record, or undefined.
   * @param options.headless  () => whether the app says this host has no window of its own.
   * @param options.apply     (level, by) sets the level and who set it, and tells every phone.
   * @param options.overRelay () => whether a call through the relay is taken too: only where the
   *                          relay is the host's own. Without it, never.
   * @param options.now       The clock (tests).
   */
  constructor({ serverId, device, headless, apply, overRelay = () => false, now = Date.now }) {
    Object.assign(this, { serverId, device, headless, apply, overRelay, now });
    /** The one open ticket of each device: deviceId → { ticket, sessionId, level, expiresAt }. */
    this.tickets = new Map();
  }

  /** The device behind a call that may change the level, or a sentence that says why it may not. */
  allowed(session, via) {
    if (!this.headless()) throw new Failure(NOT_HEADLESS);
    if (via !== "http" && !(via === "relay" && this.overRelay() === true)) throw new Failure(NOT_DIRECT);
    const device = this.device(session.deviceId);
    if (!device || device.kind !== "phone") throw new Failure(NOT_A_PHONE);
    return device;
  }

  begin(session, via, level) {
    const device = this.allowed(session, via);
    if (!GRANT_LEVELS.includes(level)) throw new Failure("The screen can be set to view or control.");
    if (!cleanPresenceKey(device.presenceKey)) throw new Failure(NO_PRESENCE_KEY);
    const expiresAt = this.now() + TICKET_MS;
    const ticket = randomBytes(TICKET_BYTES).toString("base64url");
    // One open ticket for a device: asking again ends the one before.
    this.tickets.set(device.id, { ticket, sessionId: session.id, level, expiresAt });
    return { ticket, expiresAt };
  }

  confirm(session, via, ticket, signature) {
    const device = this.allowed(session, via);
    const open = this.tickets.get(device.id);
    // One use: whatever this try comes to, the ticket is gone.
    this.tickets.delete(device.id);
    const same = typeof ticket === "string" && !!open && ticket.length === open.ticket.length && timingSafeEqual(Buffer.from(ticket), Buffer.from(open.ticket));
    if (!open || !same || open.sessionId !== session.id || this.now() > open.expiresAt) throw new Failure(TICKET_GONE);
    if (!cleanPresenceKey(device.presenceKey)) throw new Failure(NO_PRESENCE_KEY);
    if (!signedByPhone(device.presenceKey, grantMessage(this.serverId, device.id, open.level, open.ticket), signature)) throw new Failure(NOT_CONFIRMED);
    this.apply(open.level, { deviceId: device.id, name: device.name, at: this.now() });
    return { screen: open.level };
  }

  /** Turns the screen off for every phone. No ticket: taking access away is always one step. */
  revoke(session, via) {
    const device = this.allowed(session, via);
    this.apply("off", { deviceId: device.id, name: device.name, at: this.now() });
    return { screen: "off" };
  }

  /** The level changed, by anyone: every open ticket ends. */
  clear() {
    this.tickets.clear();
  }
  /** A session ended: its ticket ends with it. */
  dropSession(sessionId) {
    for (const [deviceId, open] of this.tickets) if (open.sessionId === sessionId) this.tickets.delete(deviceId);
  }
  /** A device was removed. */
  forget(deviceId) {
    this.tickets.delete(deviceId);
  }
}
