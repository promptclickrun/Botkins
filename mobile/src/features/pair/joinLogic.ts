import type { JoinAttempt, JoinResult } from "@/link/client";
import { LinkError } from "@/link/client";
import { normalizeCode, parseJoinUrl, parsePairingUrl } from "@/link/pairing";

export const JOIN_ATTEMPT_KEY = "botkins.join.v1";
/**
 * How long a join request saved on this phone is picked up again when the app starts. An older one
 * is dropped: the owner never answered, and the person starts afresh from Welcome.
 */
export const JOIN_RESUME_MS = 7 * 24 * 60 * 60_000;
/** A computer's pairing code (link-host/crypto.mjs `newCode`); a team invite has ten characters. */
const PAIRING_CODE_LENGTH = 12;

/**
 * What was typed in "Invite code". A computer's pairing code (twelve characters) or pairing link
 * typed here by mistake is `pairing`: the screen sends the person to pairing instead.
 */
export type InviteInput = { code: string; serverKey?: string; pairing?: { kind: "code"; code: string } | { kind: "link"; url: string } };
export type JoinViewState =
  | { phase: "pending"; requestId: string; team: { name: string } }
  | { phase: "approved"; pairing: Extract<JoinResult, { status: "approved" }>["pairing"]; teamName?: string }
  | { phase: "denied" }
  | { phase: "closed" }
  | { phase: "wait" }
  | { phase: "offline" }
  | { phase: "error"; message: string };

function displayCode(value: string) {
  const clean = normalizeCode(value).replace(/[^0-9A-Z]/g, "").slice(0, 10);
  return clean.length > 5 ? clean.slice(0, 5) + "-" + clean.slice(5) : clean;
}

export function parseInviteInput(value: string): InviteInput {
  const link = parseJoinUrl(value);
  if (link) return { code: displayCode(link.code), serverKey: link.serverKey };
  if (parsePairingUrl(value)) return { code: "", serverKey: undefined, pairing: { kind: "link", url: value.trim() } };
  // A pairing code keeps its own letters (its alphabet has L, which an invite reads as 1) and its groups of four.
  const raw = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (raw.length > 10) {
    const code = raw.slice(0, PAIRING_CODE_LENGTH);
    return { code: code.replace(/(.{4})(?=.)/g, "$1-"), serverKey: undefined, ...(code.length === PAIRING_CODE_LENGTH && { pairing: { kind: "code" as const, code } }) };
  }
  return { code: displayCode(value), serverKey: undefined };
}

function one(value: string | string[] | undefined) {
  return typeof value === "string" ? value : value?.[0];
}

export function joinRouteParams(params: Record<string, string | string[] | undefined>): InviteInput | null {
  const code = one(params.c);
  const serverKey = one(params.k);
  if (!code || !serverKey) return null;
  const link = parseJoinUrl("botkins://join?c=" + encodeURIComponent(code) + "&k=" + encodeURIComponent(serverKey));
  return link ? { code: displayCode(link.code), serverKey: link.serverKey } : null;
}

export function joinState(result: JoinResult): JoinViewState {
  if (result.status === "pending") return { phase: "pending", requestId: result.requestId, team: result.team };
  if (result.status === "approved") return { phase: "approved", pairing: result.pairing };
  return { phase: "denied" };
}

export function joinErrorState(error: unknown): JoinViewState {
  if (!(error instanceof LinkError)) return { phase: "error", message: error instanceof Error ? error.message : "Joining didn't work. Try again." };
  if (error.code === "join_closed") return { phase: "closed" };
  if (error.code === "join_wait") return { phase: "wait" };
  if (error.code === "offline" || error.code === "not-found") return { phase: "offline" };
  return { phase: "error", message: error.message };
}

export async function pollJoinState(attempt: JoinAttempt, check: (attempt: JoinAttempt) => Promise<JoinResult>): Promise<JoinViewState> {
  try {
    return joinState(await check(attempt));
  } catch (error) {
    return joinErrorState(error);
  }
}

/** A pairing link's values, as the pairing sheet (/pair) takes them in its route. */
export function pairingParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const at = url.indexOf("?");
  for (const part of (at < 0 ? "" : url.slice(at + 1).replace(/#.*$/, "")).split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      // A badly escaped part is skipped.
    }
  }
  return out;
}

/** What is kept for a join request that waits for the owner: the attempt and when it was saved. */
export const savedJoin = (attempt: JoinAttempt, now: number) => JSON.stringify({ ...attempt, savedAt: now });

export type ResumeDecision = { kind: "none" } | { kind: "drop" } | { kind: "resume"; attempt: JoinAttempt };

/**
 * What to do at launch with a saved join request: nothing saved, drop it (unreadable, saved by an
 * earlier version without a time, or older than JOIN_RESUME_MS), or pick it up again. A picked-up
 * request opens on top of Welcome or Home, never in place of it, so the person can always close it.
 */
export function resumeDecision(saved: string | null | undefined, now: number): ResumeDecision {
  if (!saved) return { kind: "none" };
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    return { kind: "drop" };
  }
  if (!isAttempt(value)) return { kind: "drop" };
  const savedAt = (value as { savedAt?: unknown }).savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt > now + 60_000 || now - savedAt > JOIN_RESUME_MS) return { kind: "drop" };
  const { savedAt: _savedAt, ...attempt } = value as JoinAttempt & { savedAt: number };
  return { kind: "resume", attempt };
}

function isAttempt(value: unknown): value is JoinAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as JoinAttempt;
  return (
    !!attempt.target &&
    typeof attempt.target.code === "string" &&
    typeof attempt.target.serverKey === "string" &&
    Array.isArray(attempt.target.hosts) &&
    !!attempt.device &&
    typeof attempt.device.name === "string" &&
    typeof attempt.device.platform === "string" &&
    !!attempt.keys &&
    typeof attempt.keys.publicKey === "string" &&
    typeof attempt.keys.secretKey === "string"
  );
}

/** Reads a saved join request and asks the computer where it stands. Null when there is none to pick up (resumeDecision). */
export async function readJoinResume(
  read: () => Promise<string | null>,
  check: (attempt: JoinAttempt) => Promise<JoinResult>,
  now = Date.now(),
): Promise<{ attempt: JoinAttempt; state: JoinViewState } | null> {
  let saved: string | null;
  try {
    saved = await read();
  } catch {
    return null;
  }
  const decision = resumeDecision(saved, now);
  if (decision.kind !== "resume") return null;
  return { attempt: decision.attempt, state: await pollJoinState(decision.attempt, check) };
}
