// The plain logic of setting what phones may do with a computer's screen, from the phone
// ("screen-grant-v1"): the levels and what each grants, in words, and whether this phone may change
// it now. No React Native imports, so the tests run it. grant.ts makes the calls; ScreenAccess.tsx
// is the settings section.
import type { HostDisplay, HostPart, ScreenMode } from "@/link/types";

export const GRANT_CAPABILITY = "screen-grant-v1";

/** The three levels, in order, with what each lets phones do. The statement is shown before a level is turned on. */
export const LEVELS: { value: ScreenMode; label: string; grants: string }[] = [
  { value: "off", label: "Off", grants: "No phone can see this computer's screen." },
  { value: "view", label: "View only", grants: "Every phone paired with this computer can watch its screen." },
  { value: "control", label: "View and control", grants: "Every phone paired with this computer can watch its screen and use its pointer and keyboard." },
];
export const levelOf = (mode: ScreenMode | undefined) => LEVELS.find((level) => level.value === mode) ?? LEVELS[0]!;

/** Why this phone can't change the level right now. */
export type Blocked = "offline" | "relay" | "pair-again" | "passcode";
export const BLOCKED: Record<Blocked, string> = {
  offline: "Your computer can't be reached right now.",
  relay: "Connect to the computer's own network to change this. It can't be changed through the relay.",
  "pair-again": "Pair this phone with the computer again to change this from here.",
  passcode: "Set a passcode on this phone to change this from here.",
};

export type ScreenAccess =
  /** Nothing to show yet. */
  | { kind: "none" }
  /** A computer with its own settings: the level is shown, and changed there. */
  | { kind: "computer"; level: ScreenMode }
  /** A headless host. `turnOn` is why a level can't be turned on from here (null: it can); `turnOff` the same for turning it off. */
  | { kind: "phone"; level: ScreenMode; display: HostDisplay; setBy?: HostPart["screenSetBy"]; turnOn: Blocked | null; turnOff: Blocked | null };

/**
 * What the Screen section shows, from what the computer says and what this phone has.
 * - `capable`: the computer names "screen-grant-v1" (only a headless host does).
 * - `route`: how the phone reaches it now. The computer takes these calls only directly.
 * - `pinned`: the computer keeps this phone's presence key; `hasKey`: the phone still has its half;
 *   `canProve`: the phone can ask for Face ID or a passcode at all.
 */
export function screenAccess(input: { host?: HostPart; capable: boolean; online: boolean; route: "direct" | "relay" | null; pinned: boolean; hasKey: boolean; canProve: boolean }): ScreenAccess {
  const { host } = input;
  if (!host) return { kind: "none" };
  if (!host.headless || !input.capable) return { kind: "computer", level: host.screen };
  const reach: Blocked | null = !input.online ? "offline" : input.route === "relay" ? "relay" : null;
  // Turning it off needs no proof: only that the computer hears it directly.
  const turnOn: Blocked | null = reach ?? (!input.canProve ? "passcode" : !input.pinned || !input.hasKey ? "pair-again" : null);
  return { kind: "phone", level: host.screen, display: host.display ?? { available: false }, ...(host.screenSetBy && { setBy: host.screenSetBy }), turnOn, turnOff: reach };
}

/** Whether the computer has a display to show now, as one line. */
export function displayLine(display: HostDisplay): string {
  if (display.available) return display.kind ? "Running (" + display.kind + ")" : "Running";
  return "Not running";
}
/** What to say under it when there is no display. */
export const displayNote = (display: HostDisplay) => (display.available ? undefined : display.note || "There is no display to show until one is started on the computer.");

/** Who set the level and when: "Set by this phone", "Set by Colt's phone". */
export function setByLine(setBy: HostPart["screenSetBy"], thisDevice: string | undefined, level: ScreenMode): string | undefined {
  if (!setBy) return undefined;
  return (level === "off" ? "Turned off by " : "Set by ") + (setBy.deviceId === thisDevice ? "this phone" : setBy.name || "a phone");
}

/** The question asked before a level is turned on: what it grants, in full. */
export function confirmWords(level: "view" | "control", computer: string): { title: string; message: string; action: string } {
  return {
    title: level === "control" ? "Let phones view and control " + computer + "?" : "Let phones view " + computer + "'s screen?",
    message: levelOf(level).grants + " You confirm with Face ID, Touch ID or your passcode. You can turn it off here at any time.",
    action: "Turn on",
  };
}
