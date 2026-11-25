import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { watchReasoning } from "@/state/link";
import { useAppActive } from "@/state/useAppActive";

/** A sheet can cover a mounted chat. Only the front reader needs its detailed thinking. */
export function useWatchedReasoning(chatId: string, requested: boolean) {
  const focused = useAppActive(useIsFocused());
  useEffect(() => focused && requested ? watchReasoning(chatId) : undefined, [chatId, focused, requested]);
  return focused;
}
