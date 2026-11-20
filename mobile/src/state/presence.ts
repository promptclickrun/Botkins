// The phone's presence key: what proves to a computer that a person is holding this phone, for the
// one thing a phone can widen ("screen-grant-v1"; see modules/botkins-presence). There is one key
// for each paired computer, made just before pairing so the computer can keep its public half. The
// private half never leaves the phone and signs only after Face ID, Touch ID or the passcode.
import * as Crypto from "expo-crypto";
import { Presence } from "../../modules/botkins-presence";

/** Whether this phone can make and use such a key: the build has the native part and the phone has a passcode. */
export const canProvePresence = () => {
  try {
    return !!Presence?.available();
  } catch {
    return false;
  }
};

/** A new key for a pairing that is about to be made: its name on this phone and its public half. Null when the phone can't keep one. */
export async function newPresenceKey(): Promise<{ tag: string; publicKey: string } | null> {
  if (!canProvePresence() || !Presence) return null;
  const tag = "k-" + Crypto.randomUUID();
  try {
    return { tag, publicKey: await Presence.create(tag) };
  } catch {
    return null;
  }
}

/** Whether the key kept under `tag` is still there (it goes when the phone's passcode is taken off). */
export const hasPresenceKey = (tag: string | undefined) => {
  try {
    return !!tag && !!Presence?.has(tag);
  } catch {
    return false;
  }
};

/** Removes a pairing's key: the pairing is gone, or did not happen. */
export function removePresenceKey(tag: string | undefined) {
  if (tag) void Presence?.remove(tag).catch(() => {});
}

/** The person closed the question (Face ID, Touch ID or the passcode) without answering it. */
export class PresenceCancelled extends Error {}

/**
 * Signs `message` with the key under `tag`. iOS asks for Face ID, Touch ID or the passcode first and
 * shows `reason`. It rejects when there is no key, when the person cancels (`PresenceCancelled`), or
 * when the phone can't check who is holding it: there is no signature without that answer.
 */
export async function signPresence(tag: string | undefined, message: string, reason: string): Promise<string> {
  if (!tag || !Presence) throw new Error("This phone can't confirm it's you for that computer. Pair with it again.");
  try {
    return await Presence.sign(tag, message, reason);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code.includes("CANCELLED")) throw new PresenceCancelled("Not confirmed.");
    if (code.includes("NO_KEY")) throw new Error("This phone can't confirm it's you for that computer. Pair with it again.");
    throw new Error("This phone couldn't confirm it was you. Try again.");
  }
}
