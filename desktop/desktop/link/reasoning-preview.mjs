/** The desktop's live thinking preview is the last 4,000 characters for the current speaker. */
export function reasoningPreview(items, botId) {
  return items.filter((item) => item.text && (!botId || item.botId === botId)).map((item) => item.text).join("\n\n").slice(-4000);
}
