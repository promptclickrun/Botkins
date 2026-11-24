// Only an entire assistant reply can request silence. Quotes and explanations remain ordinary text.
export const SILENT = "[SILENT]";
export const isSilent = text => typeof text === "string" && text.trim() === SILENT;
export const isSilentMessage = message => message.role === "assistant" && isSilent(message.text);

export function mayBeSilent(text) {
  const start = (text ?? "").trimStart();
  return SILENT.startsWith(start) || (start.startsWith(SILENT) && start.trimEnd() === SILENT);
}

export const visibleStream = text => mayBeSilent(text) ? "" : text;
