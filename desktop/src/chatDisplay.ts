// Chat display is a preference of the viewer, including when it connects to another host.
export type ChatDisplay = {
  completionPosition: "latest" | "beginning";
  /** How a turn's steps show in the chat. Open is the live island (ActivityIsland.tsx); the activity rail always keeps all of them. */
  steps: "folded" | "open" | "failed";
  /** How a turn's reasoning shows in the chat. Open puts its newest lines in the island. Updates are their own switch (`showUpdates`). */
  thinking: "open" | "folded" | "hidden";
  /** Collapse a finished turn to one expandable elapsed-time/count line. */
  foldFinishedSteps: boolean;
  /** What selecting a bot does on this device. Main chat is the default. */
  botTap: "main" | "latest" | "new";
};
type Saved = Omit<Partial<ChatDisplay>, "steps" | "thinking"> & { steps?: unknown; thinking?: unknown; stepsPicked?: boolean; thinkingPicked?: boolean; foldTools?: boolean; showThinking?: boolean };
const key = "botkins.chatDisplay";
/**
 * Open (the live island) is the default for Steps and for Thinking, unless the person chose.
 *
 * - Steps: a value saved with `stepsPicked` is the person's choice. Without it, only a value that
 *   was never a default counts: old Hidden becomes Folded and Failed only stays. Unpicked Every
 *   and Folded were the old defaults and become Open.
 * - Thinking: a value saved with `thinkingPicked` is the person's choice. Without it, the
 *   workspace's `showThinking: false` still means Hidden, a saved Open or Hidden is kept, and
 *   Folded, the old default, becomes Open.
 * - The workspace's older `foldTools` and `foldThinking` are not a choice here: their defaults
 *   (both on) were never picked by anyone.
 */
export function settleChatDisplay(saved: Saved, showThinking = true): ChatDisplay {
  const oldSteps = saved?.steps;
  const oldThinking = saved?.thinking;
  const steps: ChatDisplay["steps"] = saved?.stepsPicked === true
    ? oldSteps === "hidden" ? "folded" : oldSteps === "folded" || oldSteps === "failed" ? oldSteps : "open"
    : oldSteps === "hidden" ? "folded" : oldSteps === "failed" ? "failed" : "open";
  const thinking: ChatDisplay["thinking"] = saved?.thinkingPicked === true
    ? oldThinking === "folded" || oldThinking === "hidden" ? oldThinking : "open"
    : showThinking === false ? "hidden" : oldThinking === "hidden" ? "hidden" : "open";
  const oldOpen = (oldSteps === "every" && saved.stepsPicked === true) || oldSteps === "open";
  return {
    completionPosition: saved?.completionPosition === "beginning" ? "beginning" : "latest",
    steps,
    thinking,
    // An old Every/Open choice was the explicit "keep finished work open" choice. Do not let a
    // missing new toggle turn that choice into a fold; all other old choices keep the new default.
    foldFinishedSteps: typeof saved?.foldFinishedSteps === "boolean" ? saved.foldFinishedSteps : !oldOpen,
    botTap: saved?.botTap === "new" || saved?.botTap === "latest" ? saved.botTap : "main",
  };
}
export function readChatDisplay(): Saved {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; }
}
export function saveChatDisplay(patch: Saved) {
  localStorage.setItem(key, JSON.stringify({ ...readChatDisplay(), ...patch }));
  window.dispatchEvent(new Event(key));
}
export const chatDisplayEvent = key;
