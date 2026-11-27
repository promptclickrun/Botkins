import { DETACHED_NOTE } from "../../interactions.mjs";
import { dialogForm, formData } from "./dialog-form.mjs";

const METHODS = new Set(["select", "input", "editor", "confirm", "form"]);
const cancelled = { cancelled: true };
const text = (value) => typeof value === "string" && value.length <= 32000 ? value : "";

export class NativeDialogs {
  pending = new Map();
  seen = new Set();

  cancel(id, reply = false) {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.finish(reply ? cancelled : null);
    entry.controller.abort();
  }

  stop() {
    for (const id of this.pending.keys()) this.cancel(id, true);
  }

  async handle(live, request) {
    if (request.method === "cancel") return this.cancel(request.targetId);
    const { id, method } = request;
    if (!METHODS.has(method) || typeof id !== "string" || !id || this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    const session = live.session;
    const turn = session?.turn;
    const handlers = session?.spec.handlers;
    const controller = new AbortController();
    const { signal } = controller;
    const finish = (answer) => {
      if (!this.pending.delete(id) || !answer || live.rpc.closed) return;
      try {
        live.rpc.write({ type: "extension_ui_response", id, ...answer });
      } catch (error) {
        if (!live.rpc.closed) throw error;
      }
    };
    this.pending.set(id, { controller, finish });
    let response = cancelled;
    try {
      if (handlers && turn && !turn.ended && !session.stopRequested && !session.closed && session.spec.nativeDialogs === true && !session.spec.sourcesOnly &&
          request.secret !== true && request.selectionMarker !== "checkbox") {
        response = await respond(session, handlers, request, signal);
      }
    } catch {
      // A dismissed or unavailable shared interaction is a native cancellation.
    }
    if (signal.aborted) return;
    finish(live.session === session && session?.turn === turn && !session?.stopRequested ? response : cancelled);
  }
}

async function respond(session, handlers, request, signal) {
  const { method } = request;
  if (method === "form") {
    const form = dialogForm(request.html);
    if (!form || !handlers.form) return cancelled;
    const answer = await handlers.form({ ...form, mode: "form", signal });
    const data = answer?.action === "accept" && formData(form.requestedSchema, answer.content);
    return data ? { data } : cancelled;
  }
  const title = text(request.title);
  if (!title) return cancelled;
  const options = method === "select" && Array.isArray(request.options) && request.options.length <= 100
    ? request.options.map(text) : [];
  if (method === "select" && (!options.length || options.some(option => !option))) return cancelled;
  if (method === "confirm" && session.mode === "plan" && handlers.planExit) {
    const actions = ["Approve"];
    const reply = await handlers.planExit({ summary: title, planContent: text(request.message), actions, signal });
    return { confirmed: reply?.approved === true && reply.selectedAction === actions[0] };
  }
  if (!handlers.question) return cancelled;
  const choices = method === "confirm" ? ["Yes", "No"] : options;
  const question = method === "confirm" && text(request.message) ? `${title}\n\n${request.message}` : title;
  const answer = await handlers.question({ question, choices, allowFreeform: choices.length === 0, signal });
  if (method === "confirm") return { confirmed: answer?.answer === "Yes" };
  if (typeof answer?.answer !== "string" || (choices.length && !choices.includes(answer.answer))) return cancelled;
  if (answer.answer === DETACHED_NOTE && method === "editor") return cancelled;
  return { value: answer.answer };
}
