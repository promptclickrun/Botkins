/** The desktop's live thinking preview is the last 4,000 characters for the current speaker. */
export function reasoningPreview(items, botId) {
  const tail = [];
  let remaining = 4000;
  for (let index = items.length - 1; index >= 0 && remaining; index--) {
    const item = items[index];
    if (!item.text || (botId && item.botId !== botId)) continue;
    if (tail.length) {
      const separator = "\n\n".slice(-remaining);
      tail.push(separator);
      remaining -= separator.length;
      if (!remaining) break;
    }
    const suffix = item.text.slice(-remaining);
    tail.push(suffix);
    remaining -= suffix.length;
  }
  return tail.reverse().join("");
}
