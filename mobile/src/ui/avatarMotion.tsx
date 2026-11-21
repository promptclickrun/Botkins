// Which bot avatars may move (the owner's rule, 2026-11-21, for battery): only on Home, in chats
// (the Chats list, a chat, a live voice call) and on a bot's own page. On Home only the primary bot
// moves. Everywhere else an avatar holds its state's pose, with its badge.
import { createContext, type ReactNode, useContext } from "react";

const Motion = createContext(false);

/** Lets the avatars inside move: wrap a whole screen that the rule above allows. */
export function AvatarMotion({ children, on = true }: { children: ReactNode; on?: boolean }) {
  return <Motion.Provider value={on}>{children}</Motion.Provider>;
}

/** Whether an avatar without its own `animated` may move here. */
export const useAvatarMotion = () => useContext(Motion);
