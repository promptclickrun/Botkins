// Approvals, questions and forms a turn needs from the person.
// Requests arrive in the provider-neutral shape of desktop/providers/provider.mjs.
import { createHash, randomUUID } from "node:crypto";

import { secureAnswer } from "./secure-input.mjs";

export { displayValue } from "./display.mjs";

export class Interactions {
  entries = new Map();
  constructor(ws) {
    this.ws = ws;
  }
  snapshot() {
    return [...this.entries.values()].map((e) => e.view);
  }
  request(chat, task, view, timeout) {
    if (task.stopped || task.ended || this.ws.closing)
      return Promise.resolve({ action: "cancel" });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.entries.set(id, {
        view: { botId: chat.botId, ...view, id, chatId: chat.id },
        timer: timeout && setTimeout(() => this.respond(id, { action: "cancel" }), timeout).unref(),
        resolve,
      });
      this.ws.notify();
      this.ws.events?.emit("request", this.entries.get(id).view);
    });
  }
  respond(id, answer) {
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
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.resolve(answer);
    this.ws.notify();
  }
  cancel(chatId) {
    this.ws.secureInputs?.cancel(chatId);
    for (const { view } of this.entries.values())
      if (!chatId || view.chatId === chatId)
        this.respond(view.id, { action: "cancel" });
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
    });
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
