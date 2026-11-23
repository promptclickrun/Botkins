import type { ChatSummary } from "@/link/types";
import { useCan, useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";

export const regenerateTitleAction = { id: "regenerate-title", title: "Regenerate title", image: "arrow.clockwise" };

export function useCanRegenerateTitle(chat: ChatSummary, manages: boolean) {
  const supported = useCapability("chat-title-regeneration-v1");
  const canChat = useCan("agents", "chat");
  return supported && canChat && manages && chat.count > 0 && !chat.panelId && !chat.schedules?.some((entry) => entry.routine);
}

export function regenerateTitle(chatId: string) {
  showToast("Regenerating title…");
  void attempt(api.regenerateChatTitle(chatId), "Title updated");
}
