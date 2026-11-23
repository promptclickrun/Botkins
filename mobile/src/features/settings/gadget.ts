// A gadget's own page (Settings › Devices › a gadget, "gadget-settings-v1"): the plain logic behind
// it. The timer choices and their words, the value a setting shows, what each Wi-Fi row says, and
// the checks a new network gets before it is sent. The desktop app's page has the same choices and
// words (desktop/src/gadgetSettings.ts; its test compares the two). No React Native imports:
// tests/gadget-settings.test.ts runs it. The values and their rules are gadget/docs/contract.md,
// "Settings".
import type { GadgetInfo, GadgetSettings, PairedDevice } from "@/link/types";

/** The capability the page needs. Without it a gadget's row keeps its old menu. */
export const GADGET_SETTINGS = "gadget-settings-v1";

/** What a gadget starts with, as the computer has it (GADGET_DEFAULTS in link-host/gadget.mjs). */
export const GADGET_DEFAULTS: GadgetSettings = { volume: 60, mic: "normal", mute: false, brightness: 80, dimAfter: 30, offAfter: 300 };

export const VOLUME = { min: 0, max: 100 } as const;
export const BRIGHTNESS = { min: 5, max: 100 } as const;

export const MIC_CHOICES: { value: GadgetSettings["mic"]; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

/** Seconds idle before the screen dims, and before it goes dark. 0 is never. */
export const DIM_CHOICES = [0, 15, 30, 60, 120, 300];
export const OFF_CHOICES = [0, 60, 300, 900, 1800];

const count = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");

/** A timer in words: "Never", "15 seconds", "1 minute", "2 hours". */
export function timerLabel(seconds: number): string {
  if (seconds <= 0) return "Never";
  if (seconds % 3600 === 0) return count(seconds / 3600, "hour");
  if (seconds % 60 === 0) return count(seconds / 60, "minute");
  return count(seconds, "second");
}

/**
 * A picker's choices. A value set elsewhere (the gadget, `botkins gadgets set`) that isn't one of
 * them is shown in its place among them, so the picker always names what is set.
 */
export function timerOptions(choices: number[], current: number): { value: string; label: string }[] {
  const all = choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
  return all.map((seconds) => ({ value: String(seconds), label: timerLabel(seconds) }));
}

/**
 * The settings a page shows: the computer's, over the defaults (an older list may lack some), with
 * what the person is changing right now on top (a slider being moved, a call under way).
 */
export function shownSettings(gadget: GadgetInfo | undefined, held: Partial<GadgetSettings> = {}): GadgetSettings {
  return { ...GADGET_DEFAULTS, ...gadget?.settings, ...held };
}

/** "Online", "Last seen 5m ago", "Not seen yet". `seen` is how long ago, in a list's words ("5m ago", "yesterday"). */
export function presence(device: Pick<PairedDevice, "connected" | "lastSeenAt">, seen: string): string {
  if (device.connected) return "Online";
  if (!device.lastSeenAt || !seen) return "Not seen yet";
  return "Last seen " + seen;
}

/** The line under the gadget's name: whether it is online, then its board. */
export function headerLine(device: Pick<PairedDevice, "connected" | "lastSeenAt" | "gadget">, seen: string): string {
  return [presence(device, seen), device.gadget?.board].filter(Boolean).join(" · ");
}

/** The firmware as the gadget said it. There are no updates yet, so nothing is said about being up to date. */
export const firmwareLabel = (gadget: GadgetInfo | undefined) => gadget?.firmware || "Not reported";

/** The bot a gadget talks with: the one it names, else the first bot shown, as the computer picks (`botOf`). */
export function talksWith<B extends { id: string; hidden?: boolean }>(bots: B[], botId: string | undefined): B | undefined {
  return bots.find((bot) => bot.id === botId) ?? bots.find((bot) => !bot.hidden) ?? bots[0];
}

/** A signal in dBm, in a word. */
export function signalLabel(dbm: number | undefined): string | undefined {
  if (dbm === undefined) return undefined;
  if (dbm >= -55) return "Strong signal";
  if (dbm >= -67) return "Good signal";
  if (dbm >= -75) return "Fair signal";
  return "Weak signal";
}

export const WAITING = "Waiting for the gadget";

export type WifiRow = {
  ssid: string;
  /** What the row says under or beside the name. */
  status: string;
  /** The network the gadget is on now. */
  inUse: boolean;
  /** A change the gadget hasn't taken yet. */
  waiting: boolean;
  /** It can be forgotten from here: saved, and not already waiting to be forgotten. */
  canForget: boolean;
};

/**
 * The Wi-Fi group's rows: the network in use first, then the other saved ones in the gadget's
 * order, then networks added here that the gadget hasn't taken yet. A change still waiting says so.
 */
export function wifiRows(gadget: GadgetInfo | undefined): WifiRow[] {
  const network = gadget?.wifi?.network;
  const saved = gadget?.wifi?.saved ?? [];
  const adding = new Set<string>();
  const forgetting = new Set<string>();
  for (const change of gadget?.wifiWaiting ?? []) {
    if ("add" in change) adding.add(change.add);
    else forgetting.add(change.forget);
  }
  const names = [...(network ? [network] : []), ...saved.filter((name) => name !== network), ...[...adding].filter((name) => name !== network && !saved.includes(name))];
  return names.map((ssid) => {
    const inUse = ssid === network;
    const known = inUse || saved.includes(ssid);
    const waiting = adding.has(ssid) || forgetting.has(ssid);
    const base = inUse ? ["Connected", signalLabel(gadget?.wifi?.signal)].filter(Boolean).join(" · ") : known ? "Saved" : "";
    const status = forgetting.has(ssid) ? "Forgetting · " + WAITING : waiting ? [base, WAITING].filter(Boolean).join(" · ") : base;
    return { ssid, status, inUse, waiting, canForget: known && !forgetting.has(ssid) };
  });
}

/** A network's name as the computer takes it: 1 to 32 bytes, no control characters. */
export function networkProblem(ssid: string): string | null {
  const control = [...ssid].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (!ssid || control || new TextEncoder().encode(ssid).length > 32) return "Give the Wi-Fi network's name (up to 32 letters).";
  return null;
}

/** A password has 8 to 63 characters, or none for an open network. Says nothing of the password itself. */
export function passwordProblem(password: string): string | null {
  if (password.length > 0 && (password.length < 8 || password.length > 63)) return "A Wi-Fi password has 8 to 63 characters, or none for an open network.";
  return null;
}

/** How often the page reads the list again while it is open: soon while the gadget has something to take. */
export function lookAgainMs(gadget: GadgetInfo | undefined): number {
  return gadget?.wifiWaiting?.length || gadget?.restarting ? 3000 : 15000;
}
