// The thinking slider as numbers: where each level's stop is on the track, which stop a touch
// means, how far along a level is, and the thought bubbles that fill the track behind the knob.
// No React Native imports, so tests/thinking-slider.test.ts runs it. ThinkingSlider.tsx draws it.
import type { FastMode } from "@/link/types";
import { effortLabel } from "@/state/models";
import type { AvatarState } from "@/state/sessionActivity";

export const SLIDER = {
  /** The track, a pill. */
  height: 56,
  /** The knob: the bot's face, on a round ground. */
  knob: 46,
  face: 38,
  /** The room between the track's edge and the knob at either end. */
  pad: 5,
  /** How many bubbles the track can hold. */
  bubbles: 30,
} as const;

/** A level's name under the track: short, so eight of them fit side by side. */
const SHORT: Record<string, string> = { none: "Off", off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "High", xhigh: "X-High", max: "Max", ultra: "Ultra" };
export function shortEffort(level: string): string {
  const known = SHORT[level];
  if (known) return known;
  const name = effortLabel(level);
  return name.length > 6 ? name.slice(0, 5) : name;
}

/** A level that means no thinking at all. */
export const isOff = (level: string | undefined) => level === "none" || level === "off";

/** How far the knob's middle travels from the first stop to the last. */
const travel = (width: number) => Math.max(0, width - 2 * SLIDER.pad - SLIDER.knob);

/** Where a stop's middle is on a track this wide. One stop alone is in the middle. */
export function stopX(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2;
  return SLIDER.pad + SLIDER.knob / 2 + (Math.max(0, Math.min(count - 1, index)) * travel(width)) / (count - 1);
}

/** The stop a touch at `x` means: the nearest one. */
export function stopAt(x: number, count: number, width: number): number {
  if (count <= 1 || travel(width) <= 0) return 0;
  const at = ((x - SLIDER.pad - SLIDER.knob / 2) / travel(width)) * (count - 1);
  return Math.max(0, Math.min(count - 1, Math.round(at)));
}

/** How far along a level is, 0 for the first and 1 for the last. One level alone is 0. */
export const heatOf = (index: number, count: number) => (count <= 1 ? 0 : Math.max(0, Math.min(count - 1, index)) / (count - 1));

/** The bot's look on the knob: asleep with thinking off, at rest at the low levels, thinking, then hard at work at the top ones. */
export function moodAt(heat: number, off: boolean): AvatarState {
  if (off) return "sleeping";
  if (heat < 0.3) return "idle";
  return heat < 0.75 ? "thinking" : "working";
}

export type Bubble = {
  /** Where it is along the track and across it, 0 to 1. */
  u: number;
  v: number;
  size: number;
  /** A ring, or a small filled dot. */
  ring: boolean;
  /** It shows from this heat up, so the track fills as the level rises. */
  from: number;
  /** Where it is in the slow drift all bubbles share, 0 to 1. */
  phase: number;
};

/** The track's bubbles: the same ones every time (no random), spread along the track and across it. */
export function bubbles(count: number = SLIDER.bubbles): Bubble[] {
  let seed = 20261128;
  const next = () => {
    // A small fixed generator: the picture is the same on every phone and in every test.
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => ({
    // Evenly along the track with a little wander, so no stretch of it is bare or crowded.
    u: (index + 0.15 + next() * 0.7) / count,
    v: 0.14 + next() * 0.72,
    size: 5 + Math.round(next() * 8),
    ring: next() > 0.28,
    from: next() * 0.7,
    phase: next(),
  }));
}

/** Whether a bubble shows: only behind the knob, and only once the level is high enough for it. */
export function bubbleShows(bubble: Bubble, heat: number, knobX: number, width: number): boolean {
  if (heat <= 0 || bubble.from > heat) return false;
  const x = SLIDER.pad + bubble.u * (width - 2 * SLIDER.pad);
  return x + bubble.size / 2 < knobX - SLIDER.knob / 2 - 3;
}

/** The fast modes a model has, as the computer lists them. */
type Speeds = Partial<Record<"fast" | "ultrafast", string>> | undefined;

/** Whether the Fast switch can be changed: a model with a fast mode, or fast mode on (it can always be turned off). */
export const fastCanChange = (speeds: Speeds, effective: FastMode) => effective !== "off" || !!speeds?.fast || !!speeds?.ultrafast;

/**
 * What flipping the Fast switch saves. On is the model's fast mode (its ultrafast one when that is
 * all it has), off is off. Flipping back to how it was saved is no change at all (undefined), so a
 * chat that follows its bot, or a bot that follows the global setting, goes on following it.
 */
export function fastFlip(on: boolean, speeds: Speeds, savedEffective: FastMode): FastMode | undefined {
  if ((savedEffective !== "off") === on) return undefined;
  if (!on) return "off";
  return speeds?.fast || !speeds?.ultrafast ? "fast" : "ultrafast";
}
