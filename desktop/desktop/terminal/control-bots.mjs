// More of a bot, and templates: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls; each
// checks what it is given, and these wrap them with a lookup by name.
//
// What is here:
//  - a bot's copy, order, primary place, flags (pinned, hidden, teamwork, section) and memory,
//  - the sections that group the bots,
//  - the agents that a model provider already has, which can become bots,
//  - bot templates: save, list, rename, remove, and the text of a template file in and out.
//
// A bot's memory, an agent's instructions and a template's text are words that steer a bot. They
// come out and go in as they are (the command line shows them before a change that brings in
// words from elsewhere). No call here answers a secret: none of these things holds one.
import { isDeepStrictEqual } from "node:util";
import { templateForReader } from "../link/template-bundle.mjs";
import { parseTemplateFile } from "../../desktop/templates.mjs";
import { defaultBotProactive } from "../proactive-settings.mjs";
import { personName } from "../team-turn.mjs";
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
/**
 * One of a list by its id, by its exact name (capitals do not matter), or by the start of a name
 * that only one has. `names(entry)` are the words that name an entry. A name that two have is refused, and the sentence says which.
 * With `exact`, the start of a name is not enough: a removal never takes a thing that was not named in full.
 */
function pick(list, ref, what, see, names = (entry) => [entry.name], exact = false) {
  const wanted = text(ref, 300, "a " + what + "'s name or id");
  const id = (entry) => entry.id ?? entry.key;
  const byId = list.find((entry) => id(entry) === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const whole = list.filter((entry) => names(entry).some((name) => String(name ?? "").toLowerCase() === lower));
  const found = whole.length || exact ? whole : list.filter((entry) => names(entry).some((name) => String(name ?? "").toLowerCase().startsWith(lower)));
  if (found.length > 1) throw new ControlError("More than one " + what + " matches " + wanted + ": " + found.map((entry) => names(entry)[0]).join(", ") + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  if (!found.length) throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
  return found[0];
}

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function botsApi({ workspace, handlers, bot }) {
  const state = () => workspace.state;
  const sections = () => state().sections ?? [];
  const section = (ref, exact) => pick(sections(), ref, "section", "botkins bots sections list", undefined, exact);
  const templates = () => workspace.templates.all;
  const template = (ref, exact) => pick(templates(), ref, "template", "botkins templates list", undefined, exact);
  const time = (value) => (value ? new Date(value).toISOString() : null);

  /** A person's name for the command line: "owner", or a team member's name. */
  const personLabel = (person) => (person === "owner" ? "owner" : personName(workspace.teamOf(), person) || person);
  /** A person by "owner", a member's id, or a member's name (capitals do not matter). */
  const person = (ref) => {
    const wanted = text(ref, 200, "a person: owner, or a team member's name or id");
    if (["owner", "me"].includes(wanted.toLowerCase())) return "owner";
    const members = workspace.teamOf()?.members ?? [];
    const found = members.find((member) => member.id === wanted) ?? members.filter((member) => String(member.name ?? "").toLowerCase() === wanted.toLowerCase());
    if (Array.isArray(found) && found.length > 1) throw new ControlError("Two team members are named " + wanted + ". Use the member's id (see `botkins team members`).", "AMBIGUOUS");
    const one = Array.isArray(found) ? found[0] : found;
    if (!one) throw new ControlError("No team member is named " + wanted + ". Say owner, or a member's name or id.", "NOT_FOUND");
    return one.id;
  };
  /**
   * A bot's Proactive agent as the command line shows it: its settings (the usual ones when it has none), who it looks
   * out for, and what the owner's own check did. `running` is the owner's check; each person has their own.
   */
  const proactiveView = (entry) => {
    const { activity: _others, people, ...view } = { ...defaultBotProactive, ...workspace.proactive.view(entry.id) };
    return {
      id: entry.id,
      name: entry.name,
      computerOn: workspace.proactive.master,
      running: workspace.proactive.active(entry.id, "owner"),
      ...view,
      people: Object.entries(people).map(([id, own]) => ({ id, name: personLabel(id), on: own.on, notify: own.notify, running: workspace.proactive.active(entry.id, id) })),
      // What the owner was told lately and may still act on (`bots alert`).
      alerts: workspace.proactive.alerts(entry.id, "owner"),
    };
  };

  /** What a bot has of its place in the list: where it stands, and its flags. */
  const placeView = (entry) => {
    const own = sections().find((item) => item.id === entry.sectionId);
    return {
      id: entry.id,
      name: entry.name,
      role: entry.role,
      primary: state().bots[0]?.id === entry.id,
      pinned: entry.pinned === true,
      hidden: entry.hidden === true,
      // Bots may ask each other for help; a bot with this off is left out of that.
      teamwork: entry.teamwork !== false,
      section: own ? { id: own.id, name: own.name } : null,
    };
  };
  const sectionView = (entry) => ({ id: entry.id, name: entry.name, bots: state().bots.filter((item) => item.sectionId === entry.id).map((item) => ({ id: item.id, name: item.name })) });
  /** A template without its text: what a list shows. */
  const templateView = (entry) => ({
    id: entry.id,
    name: entry.name,
    role: entry.role,
    ...(entry.summary && { summary: entry.summary }),
    source: entry.source,
    ...(entry.from && { from: entry.from }),
    characters: entry.instructions.length,
    createdAt: time(entry.createdAt),
  });
  /** A template whole: its instructions too. */
  const templateWhole = (entry) => ({ ...templateView(entry), instructions: entry.instructions, ...(entry.bundle && { bundle: entry.bundle }), ...(entry.look && { look: true }) });

  /** The agents a provider has, as the app offers them (desktop/agents.mjs `importable`). */
  const agentView = (entry) => ({
    key: entry.key,
    name: entry.name,
    agent: entry.agent,
    role: entry.role,
    provider: entry.provider,
    providerName: entry.providerName,
    ...(entry.summary && { summary: entry.summary }),
    ...(entry.modelName && { model: entry.modelName }),
    ...(entry.missingModel && { missingModel: entry.missingModel }),
    ...(entry.file && { file: entry.file }),
    ownTools: entry.ownTools === true,
    added: entry.added === true,
    ...(entry.problem && { problem: entry.problem }),
    instructions: entry.instructions,
  });
  const agents = async () => (await handlers.importableAgents()).map(agentView);
  const agentsNamed = async (refs) => {
    if (!Array.isArray(refs) || !refs.length || refs.length > 100) throw new ControlError("Name at least one agent.", "BAD_ARGUMENT");
    const offered = await agents();
    if (!offered.length) throw new ControlError("No provider has an agent to bring in. See `botkins bots import`.", "NOT_FOUND");
    const chosen = [];
    for (const ref of refs) {
      const found = pick(offered, ref, "agent", "botkins bots import", (entry) => [entry.name, entry.agent, entry.key]);
      if (!chosen.includes(found)) chosen.push(found);
    }
    return chosen;
  };

  return {
    // ── A bot's place and flags ──
    /** Makes a copy of a bot. The answer is the copy. */
    async "bots.duplicate"([ref]) {
      const found = bot(ref);
      const id = await handlers.duplicateBot(found.id);
      return { ...placeView(bot(id)), from: { id: found.id, name: found.name } };
    },
    /**
     * Puts the named bots first, in the order given. The other bots follow in the order they have
     * now. The first bot is the primary bot. The answer is every bot, in the new order.
     */
    async "bots.order"([refs]) {
      if (!Array.isArray(refs) || !refs.length) throw new ControlError("Name at least one bot.", "BAD_ARGUMENT");
      const named = refs.map((ref) => bot(ref));
      const twice = named.find((entry, index) => named.indexOf(entry) !== index);
      if (twice) throw new ControlError(twice.name + " is named twice.", "BAD_ARGUMENT");
      const ids = [...named, ...state().bots.filter((entry) => !named.includes(entry))].map((entry) => entry.id);
      await handlers.reorderBots(ids);
      return state().bots.map(placeView);
    },
    /** Makes a bot the primary bot: the first one, which is never hidden. */
    async "bots.primary"([ref]) {
      const found = bot(ref);
      await handlers.makePrimary(found.id);
      return placeView(bot(found.id));
    },
    /** A bot's flags and section. */
    "bots.flags": ([ref]) => placeView(bot(ref)),
    /**
     * Changes a bot's flags: { pinned?, hidden?, teamwork? } as true or false, and
     * `section` as a section's name or id, or null for none. Only what is given changes.
     */
    async "bots.flags.set"([ref, patch]) {
      const found = bot(ref);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      const next = {};
      for (const key of ["pinned", "hidden", "teamwork"]) {
        if (patch[key] === undefined) continue;
        if (typeof patch[key] !== "boolean") throw new ControlError(key + " is true or false.", "BAD_ARGUMENT");
        next[key] = patch[key];
      }
      if (patch.section !== undefined) next.sectionId = patch.section === null ? null : section(patch.section).id;
      if (!Object.keys(next).length) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      await handlers.setBotFlags(found.id, next);
      return placeView(bot(found.id));
    },

    // ── A bot's Proactive agent (experimental) ──
    /** A bot's Proactive agent: its settings, and whether it runs now (the computer's switch is `preferences`' `proactive.enabled`). */
    "bots.proactive": ([ref]) => proactiveView(bot(ref)),
    /**
     * Changes a bot's Proactive agent: { enabled?, setUp?, every?, sweepHours?, maxPerDay?, deliver?, watch?, instructions?,
     * people? }, or null to forget its settings and routines. `people` is `{ [person]: { on?, notify? } | null }`, each person
     * by "owner" or a team member's name or id; null takes a person out. Turning it on, or marking its setup as finished
     * (`setUp`), needs `{ agreed: true }` as the third argument: the caller showed the person that the bot then wakes with
     * nobody watching, reads what its tools reach and messages them, and got a yes.
     */
    async "bots.proactive.set"([ref, patch, options]) {
      const found = bot(ref);
      if (patch !== null && (!patch || typeof patch !== "object" || Array.isArray(patch))) throw new ControlError("Give what to change, or null to forget the settings.", "BAD_ARGUMENT");
      const held = workspace.proactive.config(found.id);
      if (((patch?.enabled === true && held?.enabled !== true) || (patch?.setUp === true && held?.setUp !== true)) && options?.agreed !== true)
        throw new ControlError("Turning on a bot's Proactive agent lets it wake on its own, read what its tools reach (such as your inbox and calendar) and message you, with nobody watching. Each wake uses the model. Show that to the person, and give `{ \"agreed\": true }` after the settings (on the command line, `--yes`).", "NEEDS_YES");
      let next = patch;
      if (patch?.people !== undefined) {
        if (!patch.people || typeof patch.people !== "object" || Array.isArray(patch.people)) throw new ControlError("Give the people as { person: { on, notify } }, or null to take a person out.", "BAD_ARGUMENT");
        next = { ...patch, people: Object.fromEntries(Object.entries(patch.people).map(([who, own]) => [person(who), own])) };
      }
      await handlers.setBotProactive(found.id, next);
      return proactiveView(bot(found.id));
    },
    /**
     * What the owner does with an alert a bot sent them: "take" starts a normal turn in a new private chat with what the bot
     * offered (it answers that chat's id; tools still ask for approval), "later" holds the evidence back across their bots
     * for a day. The alert is named by its run id (`bots.proactive` lists them).
     */
    async "bots.proactive.act"([ref, runId, action]) {
      const found = bot(ref);
      const answer = await handlers.proactiveAct(found.id, text(runId, 200, "the alert's id (see `botkins bots alert <bot>`)"), action);
      return { id: found.id, name: found.name, alert: runId, action, ...answer };
    },

    // ── A bot's memory ──
    /** What a bot remembers: the text of its memory file. */
    async "bots.memory"([ref]) {
      const found = bot(ref);
      const memory = await handlers.botMemory(found.id);
      return { id: found.id, name: found.name, characters: memory.length, text: memory };
    },
    /** Replaces a bot's memory with the text given. An empty text clears it. */
    async "bots.memory.set"([ref, memory]) {
      const found = bot(ref);
      if (typeof memory !== "string") throw new ControlError("Give the memory as text.", "BAD_ARGUMENT");
      await handlers.setBotMemory(found.id, memory);
      return { id: found.id, name: found.name, characters: (await handlers.botMemory(found.id)).length };
    },

    // ── The sections that group the bots ──
    "bots.sections": () => sections().map(sectionView),
    /** One section. With `{ exact: true }` a name is taken only in full (the command line asks before a removal with this). */
    "bots.sections.get": ([ref, options]) => sectionView(section(ref, options?.exact === true)),
    async "bots.sections.add"([name]) {
      const id = await handlers.addSection(name);
      return sectionView(section(id));
    },
    async "bots.sections.rename"([ref, name]) {
      const found = section(ref);
      await handlers.renameSection(found.id, name);
      return sectionView(section(found.id));
    },
    /** Moves one section to a place (1 is the top); the others keep their order around it. */
    async "bots.sections.move"([ref, place]) {
      const found = section(ref);
      const at = Number(place);
      const list = sections().filter((item) => item.id !== found.id);
      if (!Number.isInteger(at) || at < 1 || at > list.length + 1) throw new ControlError("Give a place from 1 to " + (list.length + 1) + ".", "BAD_ARGUMENT");
      list.splice(at - 1, 0, found);
      await handlers.orderSections(list.map((item) => item.id));
      return sections().map(sectionView);
    },
    /** Removes a section. Its bots stay and are in no section. */
    async "bots.sections.remove"([ref]) {
      const found = section(ref, true);
      const view = sectionView(found);
      await handlers.deleteSection(found.id);
      return { removed: found.id, name: found.name, bots: view.bots };
    },

    // ── The agents that a model provider already has ──
    /** The agents of the providers that are on, with their instructions, and whether each is a bot already. */
    "bots.importable": () => agents(),
    /** What bringing in the named agents would add: each agent as it is, before anything is made. */
    "bots.import.preview": async ([refs]) => (await agentsNamed(refs)).map((entry) => ({ ...entry, willAdd: !entry.added && !entry.problem })),
    /** Makes a bot of each named agent. An agent that is a bot already is left out. */
    async "bots.import"([refs]) {
      const chosen = await agentsNamed(refs);
      const ids = await handlers.importAgents(chosen.map((entry) => entry.key));
      return {
        added: ids.map((id) => ({ id, name: bot(id).name })),
        skipped: chosen.filter((entry) => entry.added).map((entry) => entry.name),
      };
    },

    // ── Templates ──
    "templates.list": () => templates().map(templateView),
    "templates.get": ([ref, options]) => templateWhole(template(ref, options?.exact === true)),
    /** Saves a bot's setup as a template, under its own name or the one given. */
    async "templates.save"([ref, name]) {
      const found = bot(ref);
      if (name !== undefined && name !== null) text(name, 48, "the template a name");
      const id = await handlers.saveTemplate(found.id, name ?? undefined);
      return templateWhole(template(id));
    },
    async "templates.rename"([ref, name]) {
      const found = template(ref);
      await handlers.renameTemplate(found.id, name);
      return templateView(template(found.id));
    },
    async "templates.remove"([ref]) {
      const found = template(ref, true);
      await handlers.deleteTemplate(found.id);
      return { removed: found.id, name: found.name };
    },
    /**
     * The text of a template's file, from a template ({ template }) or from a bot ({ bot }), with
     * the name to save it under: { name, text }. The app keeps a copy among the bot's files, as it does for a phone's export.
     */
    async "templates.export"([target]) {
      if (!target || typeof target !== "object" || (target.template === undefined) === (target.bot === undefined)) throw new ControlError("Give a template or a bot, one of them.", "BAD_ARGUMENT");
      const file = await handlers.exportTemplateText(target.template !== undefined ? { templateId: template(target.template).id } : { botId: bot(target.bot).id });
      return { name: file.name, text: file.text };
    },
    /** What a template file holds, before anything is saved: the fields as the app would keep them. */
    "templates.import.preview": ([file]) => {
      const { name, fields } = importFile(file);
      const { look, ...plain } = fields;
      return { ...plain, ...(name && { from: name }), look: look !== undefined, exists: templates().some((entry) => entry.name.toLowerCase() === fields.name.toLowerCase()) };
    },
    // ── Agent templates in the marketplaces ("agent-templates-v1") ──
    /** The templates the marketplaces offer: { agents, categories }, as Marketplace › Agents shows them. */
    "templates.browse": ([query]) => handlers["agents.browse"](query ?? {}),
    /** One marketplace template with its instructions (its id is name@marketplace). */
    "templates.market": ([id, version]) => handlers["agents.template"](id, version),
    /** Create from the template the person reviewed. Older clients can use any plain marketplace template. */
    async "templates.use"([id, name, review]) {
      const found = review?.saved === true ? workspace.templates.get(id) : await handlers["agents.template"](id, review?.version);
      templateForReader(found, review?.version);
      if (review?.version === 2 && !isDeepStrictEqual(review.template, review.saved ? templateWhole(found) : found)) {
        throw new ControlError("This template changed. Review it again before creating the bot.", "BAD_ARGUMENT");
      }
      if (name !== undefined && name !== null) text(name, 48, "the bot a name");
      const botId = await handlers.addBot({ name: name ?? found.name, role: found.role, instructions: found.instructions, ...(found.summary && { summary: found.summary }), ...(found.look && { look: found.look }), ...(found.bundle && { bundle: found.bundle }) });
      const made = bot(botId);
      return { id: made.id, name: made.name, role: made.role, template: found.id };
    },
    /** Saves the template of a file that someone shared: { name?, text }. It makes no bot. */
    async "templates.import"([file]) {
      importFile(file);
      const id = await handlers.importTemplateText({ ...(file.name && { name: file.name }), text: file.text });
      return templateWhole(template(id));
    },
  };
}

/** A file as the command line sends it: { name?, text }. Its text is read as the app reads a template file. */
function importFile(file) {
  if (!file || typeof file !== "object" || typeof file.text !== "string") throw new ControlError("Give the file's text.", "BAD_ARGUMENT");
  const name = typeof file.name === "string" && file.name.trim() ? file.name.trim().split(/[\\/]/).pop().slice(0, 120) : undefined;
  return { name, fields: parseTemplateFile(file.text) };
}
