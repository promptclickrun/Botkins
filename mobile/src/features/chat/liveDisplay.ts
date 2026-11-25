/**
 * Resolves what a live turn displays on mobile.
 * Chain of thought (`thinkingMode`) and interim messages / status updates (`showUpdates`) are controlled independently.
 */
export function liveTurnDisplay({
  stream,
  thinking,
  intent,
  thinkingMode,
  showUpdates,
}: {
  stream: string;
  thinking?: string;
  intent?: string;
  thinkingMode: "show" | "folded" | "hide";
  showUpdates: boolean;
}) {
  return {
    thinking: thinkingMode !== "hide" && thinking ? thinking : undefined,
    stream: showUpdates ? stream : "",
    intent: showUpdates ? intent : undefined,
  };
}
