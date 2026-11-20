import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { type AvatarState, botkinSvg, botkinUrl, clipDuration, lookKey, lookOf, playsOnce } from "./botkins";
import type { BotLook } from "./types";
import "./agents.css";

export { activityLabel, botActivity, chatActivity, type AvatarState } from "./botkins";

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const watchMotion = (changed: () => void) => {
  reduce.addEventListener("change", changed);
  return () => reduce.removeEventListener("change", changed);
};

export type BotAvatarProps = {
  /** A bot (its saved look, or its default character), or a look by itself. */
  bot?: { id?: string; look?: BotLook };
  look?: BotLook;
  /** What the bot is doing; the Botkin acts it out. */
  state?: AvatarState;
  /** Width and height in CSS pixels. */
  size?: number;
  /** Moving or still. By default an avatar moves when it is large, or when its bot is doing something. */
  animated?: boolean;
  /** The state's badge at the corner. On by default from 40 pixels up. */
  badge?: boolean;
  /** Set to expose the avatar to assistive tech; otherwise it is decorative. */
  label?: string;
};

/**
 * A bot, drawn as its Botkin and acting out a state. Every bot avatar in the app goes through
 * this component. The picture is the design kit's own animated SVG, shown bare: nothing behind it.
 */
export const BotAvatar = memo(function BotAvatar({ bot, look: given, state = "idle", size = 52, animated, badge, label }: BotAvatarProps) {
  const look = given ?? lookOf(bot ?? {});
  const still = useSyncExternalStore(watchMotion, () => reduce.matches) || !(animated ?? (state !== "idle" || size >= 48));
  const showBadge = badge ?? size >= 40;
  // An outcome or a reaction plays once and holds, so each showing needs a picture of its own:
  // a picture that is already loaded has already played.
  const once = !still && playsOnce(state);
  const [played, setPlayed] = useState<string>();
  // Eyes and custom colors are part of the look too, so a change to either plays it again.
  const drawing = lookKey(look);
  useEffect(() => {
    if (!once) return;
    const url = URL.createObjectURL(new Blob([botkinSvg(look, state, { badge: showBadge })], { type: "image/svg+xml" }));
    setPlayed(url);
    return () => {
      setPlayed(undefined);
      URL.revokeObjectURL(url);
    };
  }, [once, drawing, state, showBadge]);
  const src = once ? (played ?? botkinUrl(look, state, { still: true, badge: showBadge })) : botkinUrl(look, state, { still, badge: showBadge });
  return (
    <img
      className="bot-avatar"
      data-state={state}
      src={src}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : "true"}
      draggable={false}
    />
  );
});

/**
 * Shows an outcome for a moment after work ends: the Botkin's Completed (or Error) clip, then idle.
 * `activity` is what the bot is doing now; `failed` says how the work that just ended went.
 */
export function useOutcome(activity: AvatarState, failed = false): AvatarState {
  const [shown, setShown] = useState<{ after: AvatarState; outcome: AvatarState | null }>({ after: activity, outcome: null });
  if (shown.after !== activity) {
    const worked = shown.after !== "idle" && shown.after !== "waiting";
    setShown({ after: activity, outcome: activity === "idle" && worked ? (failed ? "error" : "completed") : null });
  }
  const outcome = shown.outcome;
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setShown((s) => ({ ...s, outcome: null })), clipDuration(outcome) + 1800);
    return () => clearTimeout(timer);
  }, [outcome, shown.after]);
  return activity === "idle" && outcome ? outcome : activity;
}
