// Chat display is a preference of the viewer, including when it connects to another host.
export type ChatDisplay = {
  steps: "folded" | "every" | "failed" | "hidden";
  thinking: "open" | "folded" | "hidden";
};
type Saved = Partial<ChatDisplay> & { stepsPicked?: boolean };
const key = "botkins.chatDisplay";
export function settleChatDisplay(saved: Saved, showThinking = true): ChatDisplay {
  return {
    steps: saved?.stepsPicked && ["folded","every","failed","hidden"].includes(saved.steps ?? "") ? saved.steps! : "folded",
    thinking: ["open","folded","hidden"].includes(saved?.thinking ?? "") ? saved.thinking! : showThinking ? "folded" : "hidden",
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
