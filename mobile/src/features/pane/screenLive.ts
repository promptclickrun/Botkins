// The computer's screen, live, in a chat (ScreenCard) and in the side pane's screen tab: which gate
// applies, how large and how often pictures are asked for, which card is live, the words, and when the
// computer is told that nothing shows the screen any more. No React Native imports, so
// tests/screen-card.test.ts runs it. The picture loop itself is src/features/remote/useFeed.ts.
import type { ChatPane, HostPart, PanePanel } from "@/link/types";

export const SCREEN_CAPABILITY = "screen-v1";

/** Where the picture is shown: a card in the chat's list, or the side pane's screen tab. */
export type Place = "card" | "pane";
export type Route = "direct" | "relay" | null;
/** A picture at most `maxWidth` pixels wide, at JPEG `quality`, and the next ask no sooner than `gapMs` after the last one began. */
export type FeedPlan = { maxWidth: number; quality: number; gapMs: number };

/**
 * How large and how often, by place and route. The computer takes widths from 480 to 1920 and
 * qualities from 30 to 85, and sends a picture only when the screen changed, so a still screen costs
 * one short answer per ask. It counts a phone as watching for 5 seconds after its last ask, so every
 * gap stays well under that.
 * - The card is a glance at the chat's width: 640 pixels at a modest quality, at most one picture
 *   every 2 seconds. Through the relay, 480 pixels every 3.5 seconds.
 * - The pane's tab fills the sheet: Settings › Screen's own "Balanced" (1280 at 60), at most two
 *   pictures a second. Through the relay, its "Data saver" size, every 1.5 seconds.
 */
export const PLANS: Record<Place, { direct: FeedPlan; relay: FeedPlan }> = {
  card: { direct: { maxWidth: 640, quality: 45, gapMs: 2000 }, relay: { maxWidth: 480, quality: 40, gapMs: 3500 } },
  pane: { direct: { maxWidth: 1280, quality: 60, gapMs: 500 }, relay: { maxWidth: 800, quality: 45, gapMs: 1500 } },
};
export const feedPlan = (place: Place, route: Route): FeedPlan => PLANS[place][route === "relay" ? "relay" : "direct"];

/** How the owner check stands for the screen: no tap has started it yet, it is running, it passed, or it failed. */
export type Owner = "unasked" | "checking" | "open" | "locked";
export type Gate =
  /** The computer hasn't said what it can do yet. */
  | { kind: "waiting" }
  /** The app on the computer has no screen. */
  | { kind: "update" }
  /** Phones may not see the screen. `headless`: the level is set from a phone, on the computer's page. */
  | { kind: "off"; headless: boolean }
  /** The owner check hasn't passed: covered, with "Show screen". */
  | { kind: "covered"; checking: boolean }
  | { kind: "open" };

/** Which gate applies, in order: the app on the computer, the screen's level, then the owner check. */
export function screenGate({ capabilities, host, owner }: { capabilities: readonly string[] | undefined; host: HostPart | undefined; owner: Owner }): Gate {
  if (!capabilities) return { kind: "waiting" };
  if (!capabilities.includes(SCREEN_CAPABILITY)) return { kind: "update" };
  // No host part reads as off, as Settings › Screen reads it.
  if (!host || host.screen === "off") return { kind: "off", headless: host?.headless === true };
  if (owner !== "open") return { kind: "covered", checking: owner === "checking" };
  return { kind: "open" };
}

/** The pane's newest screen tab (the tabs are oldest first). */
export function newestScreen(pane: ChatPane | undefined): PanePanel | undefined {
  const panels = pane?.panels ?? [];
  for (let index = panels.length - 1; index >= 0; index--) if (panels[index]!.kind === "screen") return panels[index];
  return undefined;
}

/**
 * What a card is: the live one (it stands for the pane's newest screen tab), an older one (a newer
 * screen tab is there), one whose screen is no longer shown (the pane has no screen tab), or not
 * known yet (the chat isn't loaded).
 */
export type Role = "waiting" | "live" | "older" | "gone";
export function cardRole(loaded: boolean, pane: ChatPane | undefined, panelId: string): Role {
  if (!loaded) return "waiting";
  const newest = newestScreen(pane);
  if (!newest) return "gone";
  return newest.id === panelId ? "live" : "older";
}

export const WORDS = {
  title: "Your computer's screen",
  covered: "Your computer's screen",
  show: "Show screen",
  update: "Update the app on your computer",
  off: (headless: boolean) => (headless ? "Screen is off. Turn it on in Settings, on this computer's page, under Screen." : "Screen is off. Turn it on in the app on your computer, under Phone."),
  away: "Can't reach your computer",
  retrying: "Reconnecting…",
  lost: "Lost the picture. Trying again…",
  cantSee: "Can't see the screen",
  older: "Shown again below",
  gone: "The screen is no longer shown",
  live: "Live",
  /** The pane's button to Settings › Screen, when the computer lets phones use its pointer and keyboard, and when it doesn't. */
  control: "Use pointer and keyboard",
  watch: "Open full screen",
} as const;

/**
 * What a picture's place knows, past the gate:
 * - `wants`: it can be seen (its screen is on show, the app is in front, a card is in the chat's
 *   view and the pane doesn't show the screen over it) and it is the live card or the pane's tab.
 * - `problem`: the computer said it can't show the screen, and why (undefined: it can, or it hasn't said).
 * - `feed` and `hasPicture`: the picture loop's state, and whether there is a picture to show.
 */
export type Seen = {
  gate: Gate;
  role: Role;
  wants: boolean;
  online: boolean;
  problem: string | undefined;
  feed: "starting" | "live" | "retrying" | "failed";
  hasPicture: boolean;
};
/** `live`: the picture follows the screen now. `dim`: the last picture stays, dimmed, under `line`. `busy`: a spinner until the first picture. */
export type Look = { live: boolean; dim: boolean; busy: boolean; line: string | null };

export function screenLook(seen: Seen): Look {
  const quiet: Look = { live: false, dim: false, busy: false, line: null };
  const stale = (line: string): Look => ({ live: false, dim: seen.hasPicture, busy: false, line });
  if (seen.gate.kind !== "open" || seen.role === "waiting") return quiet;
  if (seen.role === "older") return stale(WORDS.older);
  if (seen.role === "gone") return stale(WORDS.gone);
  // Nobody can see it: the picture holds still, with nothing to say.
  if (!seen.wants) return quiet;
  if (!seen.online) return stale(WORDS.away);
  if (seen.problem !== undefined) return stale(seen.problem || WORDS.cantSee);
  if (seen.feed === "failed") return stale(WORDS.lost);
  if (seen.feed === "retrying") return stale(WORDS.retrying);
  if (!seen.hasPicture) return { ...quiet, busy: true };
  return { ...quiet, live: true };
}

/** What VoiceOver reads for the picture. On a live card it says that a tap opens it. */
export function screenLabel(place: Place, look: Look): string {
  if (look.live) return place === "card" ? WORDS.title + ", live. Tap to open it in the side pane." : WORDS.title + ", live";
  return WORDS.title + (look.line ? ". " + look.line : "");
}

/** The screen's proportions before the first picture says otherwise. */
export const DEFAULT_RATIO = 16 / 10;

/** The card's size: the width it is given at the screen's own proportions, narrowed when it would be taller than `maxHeight`. */
export function cardSize(available: number, ratio: number, maxHeight: number): { width: number; height: number } {
  if (!(available > 0)) return { width: 0, height: 0 };
  const shape = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_RATIO;
  const height = available / shape;
  if (maxHeight > 0 && height > maxHeight) return { width: maxHeight * shape, height: maxHeight };
  return { width: available, height };
}

/** The grace before the computer is told nothing shows the screen: long enough for a card to hand over to the pane, or the pane back to the card. */
export const STOP_AFTER_MS = 2000;

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (id: unknown) => void };
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * Who shows the screen on this phone. Each card or tab that asks for pictures holds it, and the
 * release says it stopped (`now`: at once, because the app is going to the background). When the
 * last one lets go, `stop` runs once after `delayMs`, unless another takes hold first.
 * Settings › Screen holds it with `own`: it tells the computer itself when it closes, so while it
 * holds nothing else is said, and once it lets go the cards' stop is owed only for what they ask
 * for after that.
 */
export function screenWatchers(stop: () => void, delayMs: number, timers: Timers = realTimers) {
  let held = 0;
  /** A card or tab asked for pictures since the computer was last told. */
  let owed = false;
  let timer: unknown;
  const cancel = () => {
    if (timer === undefined) return;
    timers.clear(timer);
    timer = undefined;
  };
  const tell = () => {
    cancel();
    if (held > 0 || !owed) return;
    owed = false;
    stop();
  };
  return {
    hold({ own = false }: { own?: boolean } = {}) {
      held += 1;
      cancel();
      if (!own) owed = true;
      let done = false;
      return (now = false) => {
        if (done) return;
        done = true;
        held -= 1;
        if (held > 0) return;
        // Settings › Screen told the computer itself, after everything asked before it closed.
        if (own) owed = false;
        if (!owed) return;
        if (now) tell();
        else
          timer = timers.set(() => {
            timer = undefined;
            tell();
          }, delayMs);
      };
    },
  };
}
