// A peer has already proved both host keys. The target alone owns the permission decision and the result.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerReceipt } from "./transcript.mjs";
import { AcpProvider } from "./providers/acp/index.mjs";

class DispatchError extends Error {}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const active = row => row.status === "pending" || row.status === "working";
const result = ({ status, reply, error }) => ({ status, ...(reply && { reply }), ...(error && { error }) });
const name = value => typeof value === "string" && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

export class HostDispatch {
  live = new Map();
  constructor(ws, data = {}) {
    this.ws = ws;
    this.records = Array.isArray(data?.records) ? data.records.filter(row => row && typeof row.id === "string") : [];
    this.grants = Array.isArray(data?.grants) ? data.grants.filter(grant => grant && typeof grant.scope === "string" && (grant.until === null || Number.isFinite(grant.until))) : [];
    // The provider may have received a working request before power was lost. Never run it twice.
    for (const row of this.records) if (row.status === "working") {
      row.status = "failed";
      row.error = "The destination closed during this reply.";
      delete row.message;
    }
  }
  persisted() {
    return this.records.length || this.grants.length ? { hostDispatch: { records: this.records, grants: this.grants } } : {};
  }
  roster() {
    return this.ws.state.settings.teamwork === false ? [] : this.ws.state.bots.filter(b => !b.hidden && b.teamwork !== false && !b.createdBy);
  }
  clearGrants(chatId) {
    const scope = this.ws.state.chats.find(c => c.id === chatId)?.dispatchScope;
    for (const [row, task] of this.live) {
      if ((!chatId || row.scope === scope) && (row.status === "working" || task.sourceReady)) task.grantsCleared = true;
    }
    this.grants = chatId ? this.grants.filter(grant => grant.scope !== scope) : [];
  }
  async receive(peer, operation, payload = {}) {
    // The transport verified the live directory immediately before this call.
    if (this.ws.closing) throw new Error("The destination is closing.");
    const identity = [peer.profileId, peer.serverId, peer.serverKey, peer.targetId, peer.targetKey];
    if (!identity.every(value => typeof value === "string" && value.length)) throw new Error("Missing host identity.");
    if (operation === "list") return this.roster().map(({ id, name, role }) => ({ id, name, role }));
    if (!["submit", "cancel", "status"].includes(operation) || typeof payload?.id !== "string" || !UUID.test(payload.id)) throw new Error("Invalid dispatch request.");
    const host = digest(identity);
    let row = this.records.find(row => row.id === payload.id && row.host === host);
    if (!row && operation === "cancel") {
      // Stop can overtake submit. Retain the tombstone past the latest time its message can be accepted.
      row = { id: payload.id, host, createdAt: Date.now() + 300000, status: "cancelled" };
      this.records = this.records.filter(item => active(item) || item.createdAt >= Date.now() - WEEK);
      this.records.push(row);
      this.ws.save();
    }
    if (operation === "submit") {
      if (row?.status === "cancelled" && !row.fingerprint) return result(row);
      const { sourceBotId, targetBotId, sourceBotName, message, createdAt } = payload;
      if (![sourceBotId, targetBotId, sourceBotName].every(name) || typeof message !== "string" || !message.trim() || message.length > 16000 || !Number.isSafeInteger(createdAt))
        throw new Error("Invalid dispatch message.");
      const fingerprint = digest([sourceBotId, targetBotId, sourceBotName, message, createdAt]);
      if (row && row.fingerprint !== fingerprint) throw new Error("This dispatch ID already identifies a different message.");
      if (!row) {
        const now = Date.now();
        if (createdAt < now - WEEK || createdAt > now + 300000) throw new Error("Dispatch timestamp is outside the retry window.");
        const bot = this.roster().find(b => b.id === targetBotId);
        if (!bot) throw new Error("This teammate is unavailable.");
        const scope = digest([...identity, sourceBotId, targetBotId]);
        const chatId = randomUUID();
        const chat = { id: chatId, botId: bot.id, hostDispatch: true, helper: true, dispatchScope: scope, title: "Request from " + sourceBotName + " on " + peer.name, time: now, messages: [] };
        row = { id: payload.id, host, scope, fingerprint, chatId, sourceBotName, targetBotId, message, createdAt, status: "pending" };
        this.records = this.records.filter(item => active(item) || item.createdAt >= now - WEEK);
        this.records.push(row);
        this.ws.state.chats.unshift(chat);
        this.ws.save();
      }
    }
    if (!row) throw new Error("Unknown dispatch request.");
    if (operation === "cancel" && active(row)) this.cancel(row);
    if (operation === "status" || operation === "submit") this.live.get(row)?.sourceReady?.resolve();
    if (row.status === "pending" && !this.live.has(row)) {
      const task = {};
      this.live.set(row, task);
      void this.process(row, task, peer).catch(error => console.error("Could not finish dispatch:", error.message));
    }
    return result(row);
  }
  cancel(row) {
    const task = this.live.get(row);
    row.status = "cancelled";
    delete row.message;
    if (task) {
      task.stopped = true;
      task.sourceReady?.resolve();
      this.ws.interactions.cancel(row.chatId);
      task.session?.abort().catch(() => {});
    }
    this.ws.save();
  }
  stop(chatId) {
    const row = this.records.find(row => row.chatId === chatId && active(row));
    if (row) this.cancel(row);
  }
  close() {
    for (const row of this.records) if (active(row)) this.cancel(row);
  }
  async process(row, task, peer) {
    let folder;
    try {
      const chat = this.ws.chat(row.chatId);
      const target = () => {
        const bot = this.roster().find(b => b.id === row.targetBotId);
        if (!bot || !chat.hostDispatch || chat.createdBy || chat.botIds || chat.botId !== bot.id || !this.ws.state.chats.includes(chat) || this.ws.chatPeople(chat.id).invited.length)
          throw new Error("This teammate or private dispatch chat is unavailable.");
        return bot;
      };
      const bot = target();
      const grants = () => this.grants.some(g => g.scope === row.scope && (!g.until || g.until > Date.now()));
      let action, until;
      if (!grants()) {
        ({ action } = await this.ws.interactions.request(chat, task, {
          kind: "permission", dispatch: true, title: row.sourceBotName + " on " + peer.name + " wants to ask " + bot.name + " on " + peer.targetName,
          detail: row.message, sourceBotName: row.sourceBotName, targetBotName: bot.name, sourceHostName: peer.name,
          targetHostName: peer.targetName, label: "Allow today and Always allow apply to future messages from this source bot to this destination bot on these two computers.",
        }));
        if (task.stopped) return;
        chat.messages.push({ role: "user", text: answerReceipt({ kind: "permission", dispatch: true }, { action }), time: Date.now() });
        this.ws.save();
        if (action === "deny" || action === "cancel") {
          row.status = action === "deny" ? "denied" : "cancelled";
          return;
        }
        if (action === "today") {
          const midnight = new Date();
          midnight.setHours(24, 0, 0, 0);
          until = midnight.getTime();
        }
        // Stop can happen on A while B is offline. A live source polls this exact request;
        // a stopped or restarted source only withdraws it. Never start on an orphaned yes.
        task.sourceReady = Promise.withResolvers();
        task.intent = "Waiting for " + peer.name;
        this.ws.notify();
        await task.sourceReady.promise;
        delete task.intent;
      }
      if (task.stopped || this.ws.closing) return;
      target();
      if (!action && (task.grantsCleared || !grants())) throw new Error("The destination grant expired or was cleared.");
      row.status = "working";
      this.ws.save();
      // This session gets the local bot's model, role and instructions. It cannot open other chats,
      // use the owner's tools, or read their files or account context.
      const model = this.ws.effectiveModel(chat);
      const { provider, hosted } = await this.ws.runnerFor(model);
      if (task.stopped || this.ws.closing) return;
      // ACP delegates tool policy to an external agent and cannot disable that agent's own tools.
      if (provider instanceof AcpProvider)
        throw new DispatchError("The destination's ACP agent cannot isolate this request. Choose a different harness for this bot.");
      folder = mkdtempSync(join(tmpdir(), "botkins-dispatch-"));
      task.session = await provider.openSession({
        sessionId: "dispatch-" + row.chatId, established: false, hasReplies: false, temporary: true, hostDispatch: true, sourcesOnly: true,
        folder, coding: false, model: hosted?.model ?? model, ...(hosted && { inference: hosted.inference }),
        approval: "ask", instructions: "You are " + bot.name + ", " + bot.role + ". Answer the approved message from your teammate.\n" + (bot.instructions ?? ""),
        context: "", tools: [], skills: { directories: [], disabled: [] }, mcpServers: {}, plugins: [], history: () => [],
        handlers: { permission: () => ({ allow: false }), question: () => { throw new Error("Reply directly to the teammate."); },
          planExit: () => ({ approved: false }), autoSwitch: () => "no", form: () => ({ action: "cancel" }) },
      });
      await peer.verify();
      if (task.stopped || this.ws.closing) return;
      target();
      if (!action && (task.grantsCleared || !grants())) throw new Error("The destination grant expired or was cleared.");
      if (!task.grantsCleared && (action === "remember" || (action === "today" && until > Date.now()))) {
        this.grants = this.grants.filter(grant => grant.until === null || grant.until > Date.now());
        const previous = this.grants.find(grant => grant.scope === row.scope);
        if (!previous) this.grants.push({ scope: row.scope, until: until ?? null });
        else if (action === "remember") previous.until = null;
        else if (previous.until !== null) previous.until = Math.max(previous.until, until);
      }
      chat.messages.push({ role: "user", text: row.message, time: Date.now() });
      this.ws.save();
      const { text } = await task.session.send({ prompt: row.message });
      if (task.stopped || this.ws.closing) return;
      if (typeof text !== "string" || !text.trim()) throw new Error("No reply.");
      row.reply = text.slice(0, 32000);
      chat.messages.push({ role: "assistant", text: row.reply, time: Date.now() });
      row.status = "answered";
    } catch (error) {
      if (!task.stopped) {
        row.status = "failed";
        row.error = error instanceof DispatchError || error?.code === "BOTKINS_DISPATCH_ISOLATION" ? error.message : "The destination could not complete this request.";
      }
    } finally {
      if (active(row)) row.status = "cancelled";
      delete row.message;
      this.live.delete(row);
      try { this.ws.save(); }
      finally { await this.release(task, folder); }
    }
  }
  async release(task, folder) {
    try { await task.session?.close({ discard: true }); }
    catch (error) { console.warn("Could not close dispatch session:", error.message); }
    if (folder) {
      try { rmSync(folder, { recursive: true, force: true }); }
      catch (error) { console.warn("Could not remove dispatch folder:", error.message); }
    }
  }
}
