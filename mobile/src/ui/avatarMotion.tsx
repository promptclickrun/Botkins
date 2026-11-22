// On Home the primary bot may move, as may the bots on the Chats list, in a live voice call and on
// a bot's own page (the owner's rule, 2026-11-21, for battery). In a chat the faces hold their poses
// (2026-11-22). Everywhere else an avatar holds its state's pose, with its badge.
import { createContext, type ReactNode, useContext } from "react";

const Motion = createContext(false);

/** Lets the avatars inside move: wrap a whole screen that the rule above allows. */
export function AvatarMotion({ children, on = true }: { children: ReactNode; on?: boolean }) {
  return <Motion.Provider value={on}>{children}</Motion.Provider>;
}

/** Whether an avatar without its own `animated` may move here. */
export const useAvatarMotion = () => useContext(Motion);
