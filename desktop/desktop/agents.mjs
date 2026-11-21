// Bot and chat management: primary bot, pins, hiding, sections, duplication and deletion.
// How a bot looks is in desktop/looks.mjs.
import { randomUUID } from "node:crypto";
import { textField } from "./panels.mjs";
import { nextLook } from "./looks.mjs";
import { GROUP_MIN, isGroup, memberSessionId } from "./groups.mjs";
import { helperSessionId } from "./teamwork.mjs";

/** A bot's instructions hold as much as a Copilot agent's prompt, so an existing agent fits as it is. */
export const INSTRUCTIONS_MAX = 30000;
export function instructionsField(value) {
  if (typeof value === "string" && value.length > INSTRUCTIONS_MAX)
    throw new Error("Use up to 30,000 characters for instructions.");
  return textField(value, INSTRUCTIONS_MAX, "instructions");
}

const clip = (text, max) => (text.length <= max ? text : text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…");

/** A short role from an agent's description: its first clause. */
export function roleFrom(description, fallback) {
  const sentence = String(description ?? "")
    .split(/(?<=[.!?])\s/)[0]
    .replace(/[.!?]$/, "")
    .trim();
  if (!sentence) return fallback;
  if (sentence.length <= 60) return sentence;
  const cut = sentence.search(/\s(?:for|that|who|which|to)\s|[,:;(]|\s[-–—]\s/);
  const clause = cut > 2 ? sentence.slice(0, cut).trim() : "";
  return clause.length >= 3 && clause.length <= 90 ? clause : clip(sentence, 90);
}

export function summaryField(value) {
  if (typeof value !== "string" || value.length > 240) throw new Error("Use up to 240 characters for About.");
  return value.trim();
}

/** Brings older workspace files up to the agent-management model. Runs on every load. */
export function migrateAgents(state) {
  state.sections ??= [];
  for (const bot of state.bots) {
    if (bot.sectionId && !state.sections.some((s) => s.id === bot.sectionId)) bot.sectionId = null;
  }
  // The primary bot always shows.
  if (state.bots[0]) state.bots[0].hidden = false;
}

export class Agents {
  constructor(ws) {
    this.ws = ws;
  }
  get state() {
    return this.ws.state;
  }
  section(id) {
    const section = this.state.sections.find((s) => s.id === id);
    if (!section) throw new Error("Unknown section");
    return section;
  }
  botChats(botId) {
    return this.state.chats.filter((c) => c.botId === botId);
  }
  assertIdle(chats, what) {
    if (chats.some((c) => this.ws.active.has(c.id)))
      throw new Error("Stop the running reply before deleting this " + what + ".");
  }
  /**
   * Agents the person already has with a model provider (for Copilot, ~/.copilot/agents), as the
   * bots Botkins would make of them. `added` marks one that is a bot already.
   */
  async importable() {
    const agents = await this.ws.providers.agents();
    return agents.map((a) => ({
      key: a.provider + ":" + a.name,
      provider: a.provider,
      providerName: a.providerName,
      agent: a.name,
      name: clip(a.title, 48),
      role: roleFrom(a.description, a.providerName + " agent"),
      summary: clip(a.description ?? "", 240),
      instructions: a.instructions,
      ...(a.model && { model: a.model, modelName: a.modelName ?? a.model.model }),
      ...(a.missingModel && { missingModel: String(a.missingModel).slice(0, 80) }),
      ...(a.file && { file: a.file }),
      ownTools: !!a.ownTools,
      added: this.state.bots.some((b) => b.origin?.provider === a.provider && b.origin.agent === a.name),
      ...(a.instructions.length > INSTRUCTIONS_MAX && { problem: "Its instructions are longer than 30,000 characters." }),
    }));
  }
  /** Where a bot made from an agent came from. The bot is a copy: later changes to the agent don't reach it. */
  origin(agent) {
    return { provider: agent.provider, agent: agent.agent, ...(agent.file && { file: agent.file }) };
  }
  /** Makes a bot of each chosen agent, in the order given. Agents that are bots already are skipped. */
  async importAgents(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 100 || keys.some((k) => typeof k !== "string"))
      throw new Error("Choose at least one agent.");
    const offered = await this.importable();
    const chosen = [...new Set(keys)].map((key) => {
      const agent = offered.find((a) => a.key === key);
      if (!agent) throw new Error("One of those agents is no longer available. Check the list and try again.");
      if (agent.problem) throw new Error(agent.name + " can't be added. " + agent.problem);
      return agent;
    });
    // Every bot is made before any is added, so a problem with one agent adds none.
    const made = [];
    for (const agent of chosen) {
      if (agent.added) continue;
      const id = randomUUID();
      const bot = {
        id,
        name: textField(agent.name, 48, "name"),
        role: textField(agent.role, 90, "role"),
        instructions: instructionsField(agent.instructions),
        face: "idle",
        ...(agent.summary && { summary: summaryField(agent.summary) }),
        ...(agent.model && { model: agent.model }),
        look: nextLook(id, [...this.state.bots, ...made].map((b) => b.look)),
        origin: this.origin(agent),
      };
      made.push(bot);
    }
    this.state.bots.push(...made);
    const ids = made.map((bot) => bot.id);
    if (ids.length) {
      this.ws.clearCatalogs();
      this.ws.save();
    }
    return ids;
  }
  /** Creates a bot from the Create a bot form. `data.agent` names the existing agent the form started from. */
  async create(data) {
    if (data?.agent == null) return this.ws.addBot(data);
    const agent = (await this.importable()).find((a) => a.key === data.agent);
    if (!agent) throw new Error("That agent is no longer available. Choose it again.");
    const id = this.ws.addBot(data);
    const bot = this.ws.bot(id);
    bot.origin = this.origin(agent);
    if (agent.model) bot.model = agent.model;
    this.ws.save();
    return id;
  }
  setBotFlags(id, patch) {
    const bot = this.ws.bot(id);
    const next = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      // teamwork: false keeps a bot out of bot-to-bot help (desktop/teamwork.mjs).
      if (key === "pinned" || key === "hidden" || key === "teamwork") {
        if (typeof value !== "boolean") throw new Error("Invalid bot flag");
        next[key] = value;
      } else if (key === "sectionId") {
        if (value !== null) this.section(value);
        next.sectionId = value;
      } else throw new Error("Unknown bot flag");
    }
    if (next.hidden && this.state.bots[0] === bot) throw new Error("The primary bot can't be hidden.");
    Object.assign(bot, next);
    this.ws.save();
  }
  makePrimary(id) {
    const bot = this.ws.bot(id);
    this.state.bots.splice(this.state.bots.indexOf(bot), 1);
    this.state.bots.unshift(bot);
    bot.hidden = false;
    this.ws.save();
  }
  reorderBots(ids) {
    const bots = this.state.bots;
    if (!Array.isArray(ids) || ids.length !== bots.length || new Set(ids).size !== ids.length)
      throw new Error("List every bot once to reorder.");
    this.state.bots = ids.map((id) => this.ws.bot(id));
    if (this.state.bots[0]) this.state.bots[0].hidden = false;
    this.ws.save();
  }
  duplicateBot(id) {
    const source = this.ws.bot(id);
    const copy = structuredClone(source);
    Object.assign(copy, {
      id: randomUUID(),
      name: (source.name + " copy").slice(0, 48),
      pinned: false,
      hidden: false,
    });
    this.state.bots.splice(this.state.bots.indexOf(source) + 1, 0, copy);
    this.ws.save();
    return copy.id;
  }
  async deleteBot(id) {
    const bot = this.ws.bot(id);
    if (this.state.bots.length === 1) throw new Error("Keep at least one bot.");
    // Group chats lose this member. A group left with fewer than two bots is deleted with it.
    const groups = this.state.chats.filter((c) => isGroup(c) && c.botIds.includes(id));
    const chats = this.botChats(id).filter((c) => !isGroup(c));
    this.assertIdle([...chats, ...groups], "bot");
    const ended = groups.filter((g) => g.botIds.length - 1 < GROUP_MIN);
    chats.push(...ended);
    const memberSessions = [];
    for (const group of groups) {
      if (ended.includes(group)) continue;
      if (group.members?.[id]?.established) memberSessions.push(memberSessionId(group, id));
      group.botIds = group.botIds.filter((b) => b !== id);
      delete group.members?.[id];
      if (group.botId === id) group.botId = group.botIds[0];
    }
    // Sessions this bot kept as a helping teammate in other bots' chats (desktop/teamwork.mjs).
    for (const chat of this.state.chats) {
      if (!chat.helpers?.[id]) continue;
      if (chat.helpers[id].established && !chats.includes(chat)) memberSessions.push(helperSessionId(chat, id));
      delete chat.helpers[id];
    }
    const chatIds = new Set(chats.map((c) => c.id));
    this.state.bots = this.state.bots.filter((b) => b !== bot);
    this.state.chats = this.state.chats.filter((c) => !chatIds.has(c.id));
    this.state.runs = this.state.runs.filter((r) => !chatIds.has(r.chatId));
    for (const panel of this.state.panels) {
      if (panel.botId !== id) continue;
      this.ws.frames?.removeOwner("panel:" + panel.id);
      // The space lost a panel: its count goes up, so whoever shows it (a link's copy too) reads it again.
      this.ws.spaces?.touch(panel.spaceId);
    }
    for (const chatId of chatIds) this.ws.frames?.removeOwner("chat:" + chatId);
    this.state.panels = this.state.panels.filter((p) => p.botId !== id);
    this.ws.board?.removeBot(id);
    this.ws.apps?.removeChats([...chatIds]);
    this.ws.tasks?.removeBot(id);
    this.ws.memory?.remove(id);
    this.state.bots[0].hidden = false;
    this.ws.clearCatalogs();
    this.ws.save();
    await this.deleteSessions(chats, memberSessions);
  }
  addSection(name) {
    const section = { id: randomUUID(), name: textField(name, 40, "section name") };
    this.state.sections.push(section);
    this.ws.save();
    return section.id;
  }
  renameSection(id, name) {
    this.section(id).name = textField(name, 40, "section name");
    this.ws.save();
  }
  deleteSection(id) {
    this.section(id);
    this.state.sections = this.state.sections.filter((s) => s.id !== id);
    for (const bot of this.state.bots) if (bot.sectionId === id) bot.sectionId = null;
    this.ws.save();
  }
  setChatFlags(id, patch) {
    const chat = this.ws.chat(id);
    const next = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!["pinned", "archived", "unread"].includes(key)) throw new Error("Unknown chat flag");
      if (typeof value !== "boolean") throw new Error("Invalid chat flag");
      next[key] = value;
    }
    Object.assign(chat, next);
    this.ws.save();
  }
  renameChat(id, title) {
    this.ws.chat(id).title = textField(title, 120, "chat title");
    this.ws.save();
  }
  async deleteChat(id) {
    const chat = this.ws.chat(id);
    this.assertIdle([chat], "chat");
    this.state.chats = this.state.chats.filter((c) => c !== chat);
    this.state.runs = this.state.runs.filter((r) => r.chatId !== id);
    for (const panel of this.state.panels) if (panel.refreshChatId === id) delete panel.refreshChatId;
    this.ws.catalogs.delete(id);
    this.ws.frames?.removeOwner("chat:" + id);
    this.ws.apps?.removeChats([id]);
    this.ws.save();
    await this.deleteSessions([chat]);
  }
  /** Removes the provider session history behind deleted chats. Missing sessions are fine. */
  async deleteSessions(chats, extra = []) {
    // A group chat has one session per member (desktop/groups.mjs); any chat may hold teammates' sessions.
    const sessions = chats.flatMap((c) => [
      ...(isGroup(c)
        ? Object.entries(c.members ?? {})
            .filter(([, m]) => m.established)
            .map(([botId, m]) => [memberSessionId(c, botId), m.sessionProvider])
        : c.established
          ? [[c.id, c.sessionProvider]]
          : []),
      ...Object.entries(c.helpers ?? {})
        .filter(([, h]) => h.established)
        .map(([botId, h]) => [helperSessionId(c, botId), h.sessionProvider]),
    ]);
    sessions.push(...extra.map((id) => [id, undefined]));
    if (!sessions.length) return;
    const results = await Promise.allSettled(sessions.map(([id, provider]) => this.ws.providers.get(provider).deleteSession(id)));
    const failed = results.find((r) => r.status === "rejected" && !/not found/i.test(String(r.reason?.message)));
    if (failed) console.error("Session cleanup:", failed.reason?.message);
  }
}
