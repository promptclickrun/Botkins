// Agent access: which bots may use which projects.
// settings.access.allBots (on by default) lets every bot use everything. With it off, each bot's
// own grant applies: bot.access.all, or the listed projects.
// Turning access off never deletes anything; it only refuses new turns and hides data from tools.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const defaultBotAccess = () => ({ all: false, projects: [] });

/** A bot's grant, filling in the default for bots made before access control. */
export function botAccess(bot) {
  const a = bot?.access;
  return {
    all: a?.all === true,
    projects: Array.isArray(a?.projects) ? a.projects : [],
  };
}
export const globalAccess = (state) => state.settings?.access?.allBots !== false;

/** A bot may use a project when access is global, it has all, or the project is listed. */
export function canUseProject(state, bot, project) {
  if (typeof project === "string") project = state.projects?.find((p) => p.id === project);
  if (!project) return false;
  if (globalAccess(state)) return true;
  const a = botAccess(bot);
  return a.all || a.projects.includes(project.id);
}
/** Why a bot can't use a project, or "" when it can. */
export function projectRefusal(state, bot, project) {
  if (typeof project === "string") project = state.projects?.find((p) => p.id === project);
  if (!project) return "This project no longer exists.";
  if (canUseProject(state, bot, project)) return "";
  return (
    (bot?.name ?? "This bot") + " doesn't have access to the project “" + project.name + "”. " +
    "Grant it on " + (bot?.name ?? "the bot") + "'s page under Access, or turn on access for all bots in Settings › Access."
  );
}
export function assertProject(state, bot, project) {
  const reason = projectRefusal(state, bot, project);
  if (reason) throw new Error(reason);
}

/**
 * Brings a workspace saved while Botkins still had Customers up to date. A bot keeps the
 * projects it reached through a customer, projects lose their customer, and the customer records
 * are written once to customers-removed.json in the data folder so nothing the person typed is
 * lost. Safe to run on every start.
 */
export function migrateCustomers(state, dir) {
  const projects = state.projects ?? [];
  for (const bot of state.bots ?? []) {
    const a = bot.access;
    if (!a || !("customers" in a)) continue;
    if (Array.isArray(a.customers) && a.customers.length) {
      const listed = new Set(a.customers);
      const own = Array.isArray(a.projects) ? a.projects : [];
      const reached = projects.filter((p) => listed.has(p.customerId)).map((p) => p.id);
      a.projects = [...new Set([...own, ...reached])];
    }
    delete a.customers;
  }
  for (const p of projects) delete p.customerId;
  if (!("customers" in state)) return;
  if (Array.isArray(state.customers) && state.customers.length) {
    // An earlier archive is never overwritten: the next free name is used.
    try {
      mkdirSync(dir, { recursive: true });
      for (let n = 1; ; n++) {
        try {
          writeFileSync(join(dir, n === 1 ? "customers-removed.json" : "customers-removed-" + n + ".json"), JSON.stringify(state.customers, null, 2) + "\n", { flag: "wx", mode: 0o600 });
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
    } catch {
      // Without the archive the records stay in the workspace file, and the next start tries again.
      return;
    }
  }
  delete state.customers;
}

/** Checks a grant from the app: known projects only. */
export function accessField(state, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid access");
  const ids = (list, known, name) => {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > 1000) throw new Error("Invalid " + name);
    const set = new Set(known.map((x) => x.id));
    const out = [...new Set(list)];
    if (out.some((id) => typeof id !== "string" || !set.has(id))) throw new Error("Unknown " + name.replace(/s$/, ""));
    return out;
  };
  if (value.all != null && typeof value.all !== "boolean") throw new Error("Invalid access");
  return {
    all: value.all === true,
    projects: ids(value.projects, state.projects ?? [], "projects"),
  };
}

export class Access {
  constructor(ws) {
    this.ws = ws;
    for (const bot of ws.state.bots) bot.access = botAccess(bot);
  }
  setBotAccess(botId, value) {
    const bot = this.ws.bot(botId);
    bot.access = accessField(this.ws.state, value);
    this.ws.save();
  }
  /** Throws when any bot answering in this chat can't use the chat's project. */
  assertChat(chat, bots) {
    const project = this.ws.projects.projectOf(chat);
    if (!project) return;
    for (const bot of bots) assertProject(this.ws.state, bot, project);
  }
}
