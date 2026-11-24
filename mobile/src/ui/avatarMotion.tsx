// One focal avatar per screen keeps full motion (Home primary bot, bot page, live voice).
// List avatars (Chats list rows) hold their state pose: no idle/rest beat passes and no blinks;
// a row may loop only while actively working, capped at MAX_LIST_AVATAR_LOOPS visible rows at once
// (owner's 2026-11-24 battery rule, overriding part of 2026-11-21). In a chat the faces hold
// their poses (2026-11-22). Everywhere else an avatar holds its state's pose, with its badge.
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type AvatarLoopBudget, type AvatarMotionMode, createAvatarLoopBudget, MAX_LIST_AVATAR_LOOPS } from "./avatarRest";

type MotionContext = {
  mode: AvatarMotionMode;
  budget: AvatarLoopBudget | null;
};

const Motion = createContext<MotionContext>({ mode: "off", budget: null });

/** Lets the avatars inside move: wrap a whole screen that the rule above allows. */
export function AvatarMotion({ children, on = true, mode }: { children: ReactNode; on?: boolean; mode?: AvatarMotionMode }) {
  const resolved: AvatarMotionMode = mode ?? (on ? "focal" : "off");
  const budget = useMemo(() => (resolved === "list" ? createAvatarLoopBudget(MAX_LIST_AVATAR_LOOPS) : null), [resolved]);
  const value = useMemo(() => ({ mode: resolved, budget }), [resolved, budget]);
  return <Motion.Provider value={value}>{children}</Motion.Provider>;
}

/** Whether an avatar without its own `animated` may move here. */
export const useAvatarMotion = () => useContext(Motion).mode !== "off";

/** Motion mode (`off` | `focal` | `list`) and optional list loop budget for the current screen. */
export const useAvatarMotionContext = () => useContext(Motion);
