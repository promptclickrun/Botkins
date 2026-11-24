import { isSilent } from "./link/silent-reply.mjs";

// Each boundary consumes the live tail exactly once. Keep source message IDs separate
// from chat indexes: a steer or an answer can split one provider message into two.
export function commitInterim(chat, run, task) {
  const text = task.stream?.trim();
  if (!run || run.noOutput || !text) return;
  if (!isSilent(text)) chat.messages.push({ role: "assistant", text, interim: true, runId: run.id,
    time: task.streamTime ?? Date.now(), ...(task.speaker && { botId: task.speaker }) });
  task.stream = "";
  delete task.streamTime;
  if (run.recovery) delete run.recovery.draft;
}

export function finishReply(chat, run, task, final) {
  if (run.noOutput) return;
  // A continuation of the turn (desktop/keep-moving.mjs) is its own reply: it is not made of the text before it.
  const from = task.replyFrom ?? 0;
  const segments = chat.messages.filter((m, i) => i >= from && !m.voiceId && m.interim && m.runId === run.id && m.botId === task.speaker);
  const last = segments.at(-1);
  let text = final?.trim() || "";
  if (last) {
    const prefix = segments.map(m => m.text).join("\n\n");
    if (task.stream?.trim()) text = task.stream.trim();
    else if (text.startsWith(prefix) && text.length > prefix.length) text = text.slice(prefix.length).trim();
    else if (!text || text === last.text || text === prefix) {
      delete last.interim;
      return;
    }
  }
  if (text && !isSilent(text)) chat.messages.push({ role:"assistant", text, runId:run.id, time:task.streamTime ?? Date.now(),
    ...(task.speaker && {botId:task.speaker}) });
  task.stream = "";
}

// Some providers emit only a completed message (and some emit it after every delta).
export function wholeMessage(task, data) {
  if (!data?.content || data.messageId == null) return;
  if (task.sourceMessageId === data.messageId) {
    const previous = task.sourceText ?? "";
    if (data.content.startsWith(previous)) {
      const missing = data.content.slice(previous.length);
      if (missing.trim()) task.streamTime ??= Date.now();
      task.stream += missing;
    }
    task.sourceText = data.content;
    return;
  }
  task.sourceMessageId = data.messageId;
  task.sourceText = data.content;
  task.streamMessage = data.messageId;
  task.streamTime ??= Date.now();
  task.stream = task.stream ? task.stream + "\n\n" + data.content : data.content;
}

export function answerReceipt(view, answer) {
  if (answer.action === "cancel") return "Dismissed";
  if (view.kind === "secure") {
    const labels = view.fields.filter(f => Object.hasOwn(answer.content, f.key)).map(f => f.label);
    return view.title + " · " + (labels.length ? "Provided " + labels.join(", ") : "No fields supplied");
  }
  if (view.dispatch) return ({ approve: "Allow this time", today: "Allow for today", remember: "Always allow", deny: "Deny" })[answer.action];
  if (view.kind === "permission") return ({ approve:"Allow once", remember:"Allow for this chat", deny:"Deny" })[answer.action];
  if (view.kind === "question" && view.freeform === false && view.choices?.includes(answer.value)) return answer.value;
  return "Answered";
}
