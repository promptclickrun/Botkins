// Display state for the compact server connection indicator next to Home's computer rail.
// No React Native imports here, so the tests can load this file.
import type { LinkState } from "@/link/client";

export type ServerLinkPhase = "hidden" | "connecting" | "connected" | "failed";

/** How long the green checkbox stays visible after connecting before fading away. */
export const CONNECTED_HOLD_MS = 1100;
/** Minimum time the spinner stays visible after a manual retry if the attempt fails immediately. */
export const MIN_RETRY_SPIN_MS = 400;

export function initialServerLinkPhase(link: LinkState): ServerLinkPhase {
  if (link === "connecting") return "connecting";
  if (link === "offline") return "failed";
  return "hidden";
}

export function nextServerLinkPhase(current: ServerLinkPhase, link: LinkState, minSpinActive = false): ServerLinkPhase {
  if (link === "connecting") return "connecting";
  if (link === "revoked") return "hidden";
  if (link === "online") return current === "hidden" ? "hidden" : "connected";
  return minSpinActive ? "connecting" : "failed";
}
