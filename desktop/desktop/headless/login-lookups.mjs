import { randomUUID } from "node:crypto";

// The workspace has no connection into the vault container. Its next state response
// carries only the requested origin. The link can answer that request on this socket.
export class LoginLookups {
  #pending = new Map();

  async find(chatId, origin) {
    if (this.#pending.size >= 8) throw new Error("The vault is busy. Try again.");
    const id = randomUUID();
    const reply = Promise.withResolvers();
    this.#pending.set(id, { chatId, origin, reply });
    const timer = setTimeout(() => reply.reject(new Error("The vault host did not answer. You can still ask the person to choose a saved credential.")), 8000).unref();
    try { return await reply.promise; } finally {
      this.#pending.delete(id);
      clearTimeout(timer);
    }
  }

  requests() {
    return Array.from(this.#pending, ([id, { chatId, origin }]) => ({ id, chatId, origin }));
  }

  answer(id, entries) {
    const job = this.#pending.get(id);
    if (job && Array.isArray(entries)) {
      job.reply.resolve(
        entries.map((entry) => {
          const out = {};
          for (const key of [
            "id", "name", "kind", "source", "website", "username", "aliases",
            "hasTotp", "copied", "linked", "manager", "vaultId", "itemId", "fieldId",
          ]) {
            if (entry?.[key] !== undefined) out[key] = entry[key];
          }
          return out;
        }),
      );
    }
  }
}
