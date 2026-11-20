import type { JoinAttempt, JoinResult } from "@/link/client";
import { LinkError } from "@/link/client";
import { normalizeCode, parseJoinUrl } from "@/link/pairing";

export const JOIN_ATTEMPT_KEY = "botkins.join.v1";

export type InviteInput = { code: string; serverKey?: string };
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

export async function readJoinResume(
  read: () => Promise<string | null>,
  check: (attempt: JoinAttempt) => Promise<JoinResult>,
): Promise<{ attempt: JoinAttempt; state: JoinViewState } | null> {
  let saved: string | null;
  try {
    saved = await read();
  } catch {
    return null;
  }
  if (!saved) return null;
  try {
    const attempt: unknown = JSON.parse(saved);
    if (!isAttempt(attempt)) return null;
    return { attempt, state: await pollJoinState(attempt, check) };
  } catch {
    return null;
  }
}
