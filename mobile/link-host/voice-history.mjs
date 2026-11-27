// A provider's input item, its transcript and its ask_bot call can arrive in any order.
// Keep their identity for the duration of this call. The tool's wording is never a match key.
export class VoiceTurns {
  constructor(sessionId) {
    this.prefix = sessionId + ":";
    this.inputs = new Map();
    this.outputs = new Map();
    this.sequence = 0;
    this.awaitingInput = [];
  }

  input(item) {
    if (this.inputs.has(item)) return this.inputs.get(item);
    const reserved = this.awaitingInput.shift();
    const id = reserved ?? this.prefix + item;
    this.inputs.set(item, id);
    if (!reserved) this.current = id;
    return id;
  }

  start(item) {
    this.started = this.input(item);
  }

  claim() {
    // With an input boundary, a short acknowledgement before the tool still belongs to that input.
    // A provider with only text events can call the tool for the next turn before sending its input.
    const previousAnswer = this.current === this.answered && this.current !== this.started;
    if (!this.current || this.current === this.claimed || previousAnswer) {
      this.current = this.prefix + "request-" + ++this.sequence;
      this.awaitingInput.push(this.current);
    }
    this.claimed = this.current;
    return this.current;
  }

  output(item) {
    // An old output item may finish after the next user has already started speaking.
    if (!this.outputs.has(item)) this.outputs.set(item, this.current);
    const afterVoiceId = this.outputs.get(item);
    return { role: "assistant", afterVoiceId };
  }

  finishOutput(item) {
    if (this.outputs.get(item) === this.current) this.answered = this.current;
  }
}

const validId = id => typeof id === "string" && id.length > 0 && id.length <= 256;
const own = (message, author) => message.author?.memberId === author?.memberId;

// Both the desktop workspace and the demo apply whole transcript snapshots.
export function recordVoiceLine(chat, id, text, final, author, { role = "user", afterVoiceId } = {}) {
  if (!validId(id) || typeof text !== "string" || text.length > 32000 || typeof final !== "boolean" || !["user", "assistant"].includes(role)) {
    throw new Error("Invalid voice transcript.");
  }
  const words = text.trim();
  if (!words) return false;
  let message = chat.messages.findLast(item => item.voiceId === id);
  if (message && message.role !== role) return false;
  const user = role === "assistant" && validId(afterVoiceId) && chat.messages.findLast(item => item.role === "user" && item.voiceId === afterVoiceId && own(item, author));
  const newLine = !message;
  const written = newLine && user?.runId && chat.messages.findLast(item => item.role === "assistant" && !item.interim && item.runId === user.runId);
  if (written && !written.voiceId) {
    // Caption the reading in the written answer's row. Keep its complete text, links and files.
    message = written;
    message.voiceId = id;
  }
  if (message?.runId && role === "assistant" && !message.interim) {
    if (user?.runId !== message.runId || (!newLine && !message.voiceCaption)) return false;
    if (final) delete message.voiceCaption;
    else message.voiceCaption = words;
    return true;
  }
  if (message) {
    if (!own(message, author)) return false;
    if (!message.voicePartial && !(role === "assistant" && final)) return false;
    if (message.text === words && !final) return false;
  } else {
    const time = Date.now();
    message = { role, voiceId: id, time, ...(author && { author }) };
    if (role === "assistant" && validId(afterVoiceId)) message.afterVoiceId = afterVoiceId;
    const before = role === "user" ? chat.messages.findIndex(item => item.afterVoiceId === id && own(item, author)) : -1;
    if (before < 0) chat.messages.push(message);
    else chat.messages.splice(before, 0, message);
    chat.time = time;
  }
  message.text = words;
  if (final) {
    delete message.voicePartial;
    if (role === "user" && message === chat.messages[0] && chat.title === "New chat") chat.title = words.slice(0, 80);
  } else {
    message.voicePartial = true;
  }
  return true;
}

/** Attach the run to its utterance, preserving the transcript and where it first appeared. */
export function addUserMessage(chat, message, voiceId) {
  if (validId(voiceId)) {
    const heard = chat.messages.findLast(item => item.voiceId === voiceId);
    if (!heard || heard.role === "user" && own(heard, message.author) && !heard.runId && !heard.steeredRunId) {
      const before = chat.messages.findIndex(item => item.afterVoiceId === voiceId && own(item, message.author));
      if (heard) {
        const { time, text, ...turn } = message;
        return Object.assign(heard, turn);
      }
      Object.assign(message, { voiceId, voicePartial: true });
      if (before >= 0) {
        chat.messages.splice(before, 0, message);
        return message;
      }
    }
  }
  chat.messages.push(message);
  return message;
}
