// The agent you're with moves; lists hold still (the owner's rule, 2026-11-24, after OpenBot).
// Moving: a bot's own page (this wrapper), and in its chat the header face, the face in the working
// status capsule and the live voice dock (each passes `animated`). Holding still, with the state's
// pose and badge: Home, the Chats list, Work, Spaces, Market, pickers and every message or reply row.
// A moving avatar still holds still under another page, in a tab that isn't selected, while the app
// isn't active, and under Reduce Motion or the phone's own setting (BotAvatar).
import { createContext, type ReactNode, useContext } from "react";

const Motion = createContext(false);

/** Lets the avatars inside move: wrap a whole screen that the rule above allows. */
export function AvatarMotion({ children, on = true }: { children: ReactNode; on?: boolean }) {
  return <Motion.Provider value={on}>{children}</Motion.Provider>;
}

/** Whether an avatar without its own `animated` may move here. */
export const useAvatarMotion = () => useContext(Motion);
