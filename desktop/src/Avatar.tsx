import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { type AvatarState, botkinArt, botkinFace, clipDuration, lookKey, lookOf, motionOf } from "./botkins";
import { observeVisibleAnimation } from "./visibleAnimation";
import type { BotLook } from "./types";
import "./agents.css";

export { activityLabel, botActivity, chatActivity, type AvatarState } from "./botkins";

const AvatarAnimationSetting = createContext(true);
const blink = [[0, 1], [0.92, 1], [0.94, 0.09], [0.946, 0.09], [0.97, 1], [1, 1]].map(([offset, scale]) => ({
  offset, transform: `scaleY(${scale})`, easing: "ease-in-out",
}));

/** One desktop-wide setting for every Botkin drawn in the window. */
export function AvatarAnimations({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <AvatarAnimationSetting.Provider value={enabled}>{children}</AvatarAnimationSetting.Provider>;
}

export type BotAvatarProps = {
  /** A bot (its saved look, or its default character), or a look by itself. */
  bot?: { id?: string; look?: BotLook };
  look?: BotLook;
  /** What the bot is doing; the Botkin acts it out. */
  state?: AvatarState;
  /** Width and height in CSS pixels. */
  size?: number;
  /**
   * Moving or still; still unless asked. The agent you're with moves; lists hold still (the owner's
   * rule, 2026-11-24, the phone's too): only its profile, its chat's header, its chat's details
   * panel, the live line while a turn runs and live voice pass it. Everything else (Home, the side
   * bar, Chats, routines, tasks, pickers, message rows) holds its state's pose, with its badge.
   */
  animated?: boolean;
  /** The state's badge at the corner. On by default from 40 pixels up. */
  badge?: boolean;
  /** Set to expose the avatar to assistive tech; otherwise it is decorative. */
  label?: string;
};

/** The kit's still shell and expression move together around its pivot. The badge stays put. */
export const BotAvatar = memo(function BotAvatar({ bot, look: given, state = "idle", size = 52, animated, badge, label }: BotAvatarProps) {
  const look = given ?? lookOf(bot ?? {});
  const moving = useContext(AvatarAnimationSetting) && animated === true;
  const showBadge = badge ?? size >= 40;
  const drawing = lookKey(look);
  const art = useMemo(() => botkinArt(look), [drawing]);
  const face = useMemo(() => botkinFace(look, state), [drawing, state]);
  const clip = motionOf(state);
  const head = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const body = head.current;
    if (!moving || !body) return;
    let tracks: Animation[] = [];
    const cancel = () => {
      for (const track of tracks) track.cancel();
      tracks = [];
    };
    const unobserve = observeVisibleAnimation(body.parentElement, (playback) => {
      if (playback === "reduced") {
        cancel();
      } else if (playback === "paused") {
        for (const track of tracks) if (track.playState === "running") track.pause();
      } else if (!tracks.length) {
        // The browser runs these transforms. A hidden avatar has no frame callback, and one
        // that has never been on screen has no animation objects either.
        tracks.push(body.animate(clip.frames, clip.timing));
        for (const eye of body.querySelectorAll("ellipse")) {
          tracks.push(eye.animate(blink, { duration: face.blinkDuration, delay: face.blinkDelay, iterations: Infinity }));
        }
      } else {
        // Finished outcomes hold their last pose across a hide/show. A new showing starts fresh.
        for (const track of tracks) if (track.playState === "paused") track.play();
      }
    });
    return () => {
      unobserve?.();
      cancel();
    };
  }, [moving, state, clip, face, showBadge]);
  return (
    <span
      className="bot-avatar"
      data-state={state}
      style={{ "--avatar-size": `${size}px` } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      <span className="botkin-head" ref={head} style={{ transform: clip.frames[0].transform }}>
        <img className="botkin-art" ref={art} alt="" draggable={false} />
        <svg className="botkin-face" viewBox="0 0 256 256" aria-hidden="true" dangerouslySetInnerHTML={{ __html: face.expression }} />
      </span>
      {showBadge && face.badge && <svg className="botkin-badge" viewBox="0 0 256 256" aria-hidden="true" dangerouslySetInnerHTML={{ __html: face.badge }} />}
    </span>
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
