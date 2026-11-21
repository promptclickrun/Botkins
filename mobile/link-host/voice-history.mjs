// Both the desktop workspace and the demo apply whole transcript snapshots. A line is a chat
// message, but recording it never submits a request to the bot.
export function recordVoiceLine(chat, id, text, final, author) {
  if (typeof id !== "string" || !id.length || id.length > 256 || typeof text !== "string" || text.length > 32000 || typeof final !== "boolean") {
    throw new Error("Invalid voice transcript.");
  }
  const words = text.trim();
  if (!words) return false;
  let message = chat.messages.findLast(item => item.voiceId === id);
  if (message) {
    if (message.author?.memberId !== author?.memberId || !message.voicePartial || (!final && message.text === words)) return false;
  } else {
    const time = Date.now();
    message = { role: "user", voiceId: id, time, ...(author && { author }) };
    chat.messages.push(message);
    chat.time = time;
  }
  message.text = words;
  if (final) {
    delete message.voicePartial;
    if (message === chat.messages[0] && chat.title === "New chat") chat.title = words.slice(0, 80);
  } else {
    message.voicePartial = true;
  }
  return true;
}

/** A matching ask_bot request starts a normal run on the spoken row, even if the final is in flight. */
export function addUserMessage(chat, message, voiceId) {
  if (typeof voiceId === "string" && voiceId.length && voiceId.length <= 256) {
    const heard = chat.messages.findLast(item => item.voiceId === voiceId);
    if (!heard) Object.assign(message, { voiceId, voicePartial: true });
    else if (heard.author?.memberId === message.author?.memberId && !heard.runId && !heard.steeredRunId && (heard.voicePartial || heard.text === message.text)) {
      const { time, ...turn } = message;
      Object.assign(heard, turn);
      return heard;
    }
  }
  chat.messages.push(message);
  return message;
}
