// Setting what phones may do with a headless computer's screen ("screen-grant-v1"). These are the
// only calls of their kind in the app, and only ScreenAccess.tsx makes them, from a tap by the
// person: no chat, custom view, notification, deep link or phone tool can (tests/screen-grant.test.ts
// holds that). The computer refuses them unless a person confirmed on this phone: `confirm` carries
// a signature that the phone's presence key gives only after Face ID, Touch ID or the passcode.
import { grantMessage, type Pairing } from "@/link/client";
import type { ScreenMode } from "@/link/types";
import { api } from "@/state/link";
import { signPresence } from "@/state/presence";
import { levelOf } from "./grantWords";

/**
 * Turns the screen on at `level`. The computer gives a ticket, iOS asks the person for Face ID,
 * Touch ID or the passcode, and the signed ticket goes back. Resolves with the level now in force.
 * Rejects with `PresenceCancelled` when the person does not confirm.
 */
export async function grantScreen(level: "view" | "control", pairing: Pairing): Promise<ScreenMode> {
  const { ticket } = await api["link.screen.grant.begin"](level);
  const signature = await signPresence(pairing.presenceTag, grantMessage(pairing.serverId, pairing.deviceId, level, ticket), "Let phones use " + (pairing.name || "this computer") + "'s screen: " + levelOf(level).label.toLowerCase());
  return (await api["link.screen.grant.confirm"](ticket, signature)).screen;
}

/** Turns the screen off for every phone. One step, no question. */
export async function revokeScreen(): Promise<ScreenMode> {
  return (await api["link.screen.revoke"]()).screen;
}
