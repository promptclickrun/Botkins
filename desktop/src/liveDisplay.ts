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
