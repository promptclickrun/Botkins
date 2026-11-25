import type { Preferences } from "./types";

/**
 * Resolves what a live turn displays on desktop.
 * Chain of thought (`showThinking`) and interim messages / status updates (`showUpdates`) are controlled independently.
 */
export function liveTurnDisplay({
  settings,
  stream,
  thinking,
  intent,
}: {
  settings: Pick<Preferences, "showThinking" | "showUpdates">;
  stream?: string;
  thinking?: string;
  intent?: string;
}) {
  const showThinking = settings.showThinking !== false;
  const showUpdates = settings.showUpdates !== false;
  return {
    showThinking,
    showUpdates,
    liveThinking: showThinking ? thinking : undefined,
    liveStream: showUpdates ? (stream ?? "") : "",
    liveIntent: showUpdates ? (intent ?? "") : "",
  };
}

/**
 * Whether the bot's interim updates show in the chat itself. While the turn runs they do. Once it
 * ended they go with its thinking: in the chat only where the thinking is open in it, else folded
 * with the thinking (the fold, or the island's receipt).
 */
export function updateInChat({
  live,
  showUpdates,
  showThinking,
  thinkingMode,
  islandMode,
}: {
  live: boolean;
  showUpdates: boolean;
  showThinking: boolean;
  thinkingMode: string;
  islandMode: boolean;
}) {
  return showUpdates && (live || (showThinking && thinkingMode === "open" && !islandMode));
}
