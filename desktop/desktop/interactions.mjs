import { commitInterim, answerReceipt } from "./transcript.mjs";
// Approvals, questions and forms a turn needs from the person.
// Requests arrive in the provider-neutral shape of desktop/providers/provider.mjs.
import { createHash, randomUUID } from "node:crypto";

import { secureAnswer } from "./secure-input.mjs";

export { displayValue } from "./display.mjs";

/** How long a question waits with its turn before it is detached. That ends the wait, never the turn (desktop/AGENTS.md). */
export const DETACH_AFTER_MS = 10 * 60 * 1000;
/** What a detached question's tool call gets back. */
export const DETACHED_NOTE =
  "No answer yet. The question stays visible in the chat. If the person answers later, the answer will reach you as a new message that quotes the question. Finish this turn now.";

export class Interactions {
  entries = new Map();
  constructor(ws) {
    this.ws = ws;
    this.detachAfter = DETACH_AFTER_MS;
  }
  snapshot() {
    return [...this.entries.values()].map((e) => e.view);
  }
  /** The requests still open that were asked in a turn, a detached question among them. */
  openFor(task) {
    return [...this.entries.values()].filter((entry) => entry.task === task).map((entry) => entry.view);
  }
  request(chat, task, view, timeout, { detachAfter } = {}) {
    if (task.stopped || task.ended || this.ws.closing)
      return Promise.resolve({ action: "cancel" });
    const id = randomUUID();
    const transcript = this.ws.state?.chats.find(c => c.id === chat.id) ?? chat;
    if (task.run) commitInterim(transcript, task.run, task);
    return new Promise((resolve) => {
      this.entries.set(id, {
        chat: transcript, task,
        view: {
          botId: chat.botId,
          ...view,
          // When it was raised: reminders (desktop/reminders.mjs) and the Proactive agent wait this long before they speak of it.
          time: Date.now(),
          ...(task?.author && { askedBy: { memberId: task.author.memberId, name: task.author.name } }),
          id,
          chatId: chat.id,
        },
        timer: timeout && setTimeout(() => this.respond(id, { action: "cancel" }, false), timeout).unref(),
        resolve,
      });
      const entry = this.entries.get(id);
      if (detachAfter) {
        entry.detachTimer = setTimeout(() => this.detach(id), detachAfter);
        entry.detachTimer.unref?.();
      }
      this.ws.notify();
      this.ws.events?.emit("request", entry.view);
    });
  }
  /**
   * A question nobody answered in time lets its turn go on: the tool call gets DETACHED_NOTE, and the
   * question stays open (shown as waiting) for the person's answer, which then starts a new turn.
   */
  detach(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.detached) return;
    entry.detached = true;
    entry.view = { ...entry.view, detached: true };
    clearTimeout(entry.detachTimer);
    entry.resolve({ action: "detached" });
    this.ws.notify();
  }
  /** `person` is who answered ("owner" or a member's id), for an answer that outlived its turn. */
  respond(id, answer, human = true, person = "owner") {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("This request has already closed.");
    const { view } = entry;
    if (
      view.kind === "permission" &&
      !["approve", "deny", "remember", "cancel"].includes(answer.action)
    )
      throw new Error("Unknown approval response");
    if (answer.action === "remember" && !view.remember)
      throw new Error("This approval cannot be remembered.");
    if (
      view.kind === "question" &&
      answer.action !== "cancel" &&
      (answer.action !== "answer" ||
        typeof answer.value !== "string" ||
        !answer.value.trim() ||
        answer.value.length > 32000 ||
        (!view.freeform && !view.choices.includes(answer.value)))
    )
      throw new Error("Choose an answer or enter a response.");
    if (view.kind === "secure") answer = secureAnswer(view, answer);
    if (entry.detached) {
      // Its turn is over: a dismissal just closes the card, and an answer is the person's next message, quoting the question.
      // The answer is delivered before the card goes, so one that can't be sent leaves the question open.
      if (answer.action !== "cancel") this.ws.answerDetached(view, answer.value, person);
      this.entries.delete(id);
      this.ws.notify();
      return;
    }
    if (human && entry.task.run && !entry.task.run.noOutput) {
      commitInterim(entry.chat, entry.task.run, entry.task);
      entry.chat.messages.push({ role: "user", text: answerReceipt(view, answer), time: Date.now(),
        answer: { runId: entry.task.run.id, requestId: id, kind: view.kind, title: view.title } });
      this.ws.save();
    }
    clearTimeout(entry.timer);
    clearTimeout(entry.detachTimer);
    this.entries.delete(id);
    entry.resolve(answer);
    this.ws.notify();
  }
  /**
   * Cancels what a turn was waiting for. A detached question is no turn's: it stays until the person
   * answers or dismisses it, unless `detached` says the whole chat (or program) is going away.
   */
  cancel(chatId, { detached = false } = {}) {
    this.ws.secureInputs?.cancel(chatId);
    for (const [id, entry] of [...this.entries])
      if ((!chatId || entry.view.chatId === chatId) && (detached || !entry.detached)) {
        clearTimeout(entry.detachTimer);
        if (entry.detached) this.entries.delete(id);
        else this.respond(id, { action: "cancel" }, false);
      }
    if (detached) this.ws.notify();
  }
  /**
   * Decides one permission request: Botkins' own rules first, then the person.
   * Returns { allow, interactive? }.
   */
  async permission(chat, task, request) {
    // A turn that has ended approves nothing, even when a teammate it started is still winding down.
    if (task.stopped || task.ended || this.ws.closing) return { allow: false };
    // "Always allow" remembers the kind of request and what identifies its scope.
    const key = request.remember
      ? createHash("sha256")
          .update(JSON.stringify([request.kind, ...request.remember.slice(1)]))
          .digest("hex")
      : null;
    const mode = chat.approval ?? this.ws.state.settings.approval;
    if (
      !request.managed &&
      (mode === "all" ||
        // YOLO is per chat: only a coding chat set to YOLO, whose folder still exists, runs without asking.
        // A request to leave or loosen the sandbox still asks.
        (chat.mode === "yolo" && !!this.ws.projects?.folderFor(chat) && !request.sandboxEscape) ||
        (mode === "read" && request.readOnly && !request.sandboxEscape) ||
        (key && chat.approvals?.includes(key)))
    )
      return { allow: true };
    const { action } = await this.request(chat, task, {
      kind: "permission",
      label: request.label,
      preview: request.preview,
      title: request.title,
      detail: request.detail,
      remember: request.remember ? request.remember[0] : null,
    });
    if (task.stopped || task.ended || !["approve", "remember"].includes(action)) return { allow: false };
    if (action === "remember" && key) {
      chat.approvals = [...new Set([...(chat.approvals || []), key])];
      this.ws.save();
    }
    return { allow: true, interactive: true };
  }
  async question(chat, task, req) {
    const choices = req.choices ?? [];
    const answer = await this.request(chat, task, {
      kind: "question",
      title: req.question,
      choices,
      freeform: req.allowFreeform !== false || !choices.length,
    }, undefined, { detachAfter: this.detachAfter });
    if (answer.action === "detached") return { answer: DETACHED_NOTE, wasFreeform: true };
    if (answer.action === "cancel")
      throw new Error("The user dismissed the question.");
    return {
      answer: answer.value,
      wasFreeform: !choices.includes(answer.value),
    };
  }
  async elicit(chat, task, req) {
    const reply = await this.request(chat, task, {
      kind: "form",
      title: req.message,
      schema: req.requestedSchema,
      url: req.mode === "url" ? req.url : undefined,
    });
    return reply.action === "accept"
      ? { action: "accept", content: reply.content ?? {} }
      : { action: "cancel" };
  }
}
