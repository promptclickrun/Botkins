// Chat display is a preference of the viewer, including when it connects to another host.
export type ChatDisplay = {
  completionPosition: "latest" | "beginning";
  /** Which work calls remain in the conversation; the activity rail always keeps all of them. */
  steps: "folded" | "open" | "failed";
  /** Which reasoning and interim updates remain in the conversation. */
  thinking: "open" | "folded" | "hidden";
  /** Collapse a finished turn to one expandable elapsed-time/count line. */
  foldFinishedSteps: boolean;
  /** What selecting a bot does: open its latest chat, or start a new one. */
  botTap: "latest" | "new";
};
type Saved = Omit<Partial<ChatDisplay>, "steps" | "thinking"> & { steps?: unknown; thinking?: unknown; stepsPicked?: boolean; foldTools?: boolean; showThinking?: boolean };
const key = "botkins.chatDisplay";
export function settleChatDisplay(saved: Saved, showThinking = true): ChatDisplay {
  const oldSteps = saved?.steps;
  const oldThinking = saved?.thinking;
  // `every` and `hidden` were the four-choice desktop setting. An old, unpicked Every value was
  // the old default and becomes Folded; an explicitly picked Every becomes the new Open choice.
  // Hidden is Folded because both leave the canvas quiet while the activity rail remains complete.
  const steps = oldSteps === "every" ? (saved.stepsPicked === true ? "open" : "folded") : oldSteps === "hidden" ? "folded" :
    ["folded", "open", "failed"].includes(oldSteps as string) ? oldSteps as ChatDisplay["steps"] : "folded";
  const oldOpen = (oldSteps === "every" && saved.stepsPicked === true) || oldSteps === "open";
  return {
    completionPosition: saved?.completionPosition === "beginning" ? "beginning" : "latest",
    steps,
    thinking: ["open", "folded", "hidden"].includes(oldThinking as string) ? oldThinking as ChatDisplay["thinking"] : showThinking ? "folded" : "hidden",
    // An old Every/Open choice was the explicit "keep finished work open" choice. Do not let a
    // missing new toggle turn that choice into a fold; all other old choices keep the new default.
    foldFinishedSteps: typeof saved?.foldFinishedSteps === "boolean" ? saved.foldFinishedSteps : !oldOpen,
    botTap: saved?.botTap === "new" ? "new" : "latest",
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
