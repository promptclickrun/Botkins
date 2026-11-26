// Marketplace format version 2 ("marketplace-v2-v1"; the botkins-marketplace repository's
// docs/FORMAT.md): a catalog with `"schemaVersion": 2` may list `skills` (whole skill folders),
// `packs` (named sets of catalog skills and plugins) and `templates` (bot templates in format
// version 3, which can require catalog skills, packs and plugins). `plugins` and `agents` are read
// as before (desktop/plugin-catalog.mjs); a version 1 catalog lists nothing here.
//
// Everything is read at one commit of the catalog: the listing, each skill folder (every file pinned
// by its Git blob id) and each template file. An install names that commit, and is refused when
// the catalog has moved on since the review. Installing never runs anything.
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AGENT_CATEGORIES } from "./plugin-catalog.mjs";
import { REFERENCE, storedBundle } from "./link/template-bundle.mjs";
import { MARKET_V2_METHODS } from "./link/methods.mjs";

export const MARKETPLACE_V2 = "marketplace-v2-v1";
export { MARKET_V2_METHODS };
export const SKILL_TOOLS = ["shell", "node", "python", "browser", "network"];
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SPDX = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;
const MAX_LISTINGS = 200;
const MAX_IMAGE = 1024 * 1024;
const REVIEW_TTL = 10 * 60_000;

const parts = (version) => version.split(".").map(Number);
/** Negative, zero or positive as `a` is below, equal to or above `b` (both MAJOR.MINOR.PATCH). */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Whether `version` meets `range`: `^x.y.z`, `~x.y.z` or an exact `x.y.z`, as npm reads them. */
export function satisfies(version, range) {
  const m = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!m || !SEMVER.test(m[2]) || !SEMVER.test(version ?? "")) return false;
  const [op, base] = [m[1], m[2]];
  if (!op) return compareVersions(version, base) === 0;
  if (compareVersions(version, base) < 0) return false;
  const [v, b] = [parts(version), parts(base)];
  if (op === "~") return v[0] === b[0] && v[1] === b[1];
  if (b[0] > 0) return v[0] === b[0];
  if (b[1] > 0) return v[0] === 0 && v[1] === b[1];
  return compareVersions(version, base) === 0;
}

/** `name@range` as { name, range }, or null. */
export function reference(text) {
  const m = typeof text === "string" ? REFERENCE.exec(text) : null;
  return m ? { name: m[1], range: m[2] } : null;
}

const words = (value, max) => (typeof value === "string" && value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value) ? value.trim().slice(0, max) : undefined);
const category = (value) => {
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  return word ? (Object.hasOwn(AGENT_CATEGORIES, word) ? word : "other") : undefined;
};
const authorOf = (author) => words(typeof author === "string" ? author : author?.name, 80);
const keywordsOf = (list) => (Array.isArray(list) ? list.map((k) => words(k, 40)).filter(Boolean).slice(0, 12) : []);
const common = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !NAME.test(raw.name ?? "") || !SEMVER.test(raw.version ?? "")) return null;
  const keywords = keywordsOf(raw.keywords);
  const author = authorOf(raw.author);
  const cat = category(raw.category);
  return { name: raw.name, version: raw.version, summary: words(raw.summary, 240) ?? "", ...(cat && { category: cat }), ...(keywords.length && { keywords }), ...(author && { author }) };
};
const refs = (list) => (Array.isArray(list) ? list.filter((item) => reference(item)).slice(0, 64) : []);

function skillEntry(raw) {
  const base = common(raw);
  if (!base || String(raw.source ?? "").replace(/^\.\//, "") !== "skills/" + raw.name) return null;
  const license = typeof raw.license === "string" && SPDX.test(raw.license) && raw.license.length <= 80 ? raw.license : null;
  if (!license) return null;
  const preview = typeof raw.preview === "string" ? raw.preview.replace(/^\.\//, "") : "";
  const tools = (list) => (Array.isArray(list) ? [...new Set(list.filter((t) => SKILL_TOOLS.includes(t)))] : []);
  const needed = tools(raw.requires?.tools);
  const optional = tools(raw.requires?.optional).filter((t) => !needed.includes(t));
  return {
    ...base,
    path: "skills/" + raw.name,
    license,
    ...(preview.startsWith("skills/" + raw.name + "/") && /\.(png|jpe?g|webp)$/i.test(preview) && !preview.split("/").some((p) => p === ".." || p === ".") && { preview }),
    requires: { tools: needed, optional },
  };
}

function packEntry(raw) {
  const base = common(raw);
  if (!base) return null;
  const skills = refs(raw.skills);
  const plugins = refs(raw.plugins);
  return skills.length || plugins.length ? { ...base, skills, plugins } : null;
}

function templateEntry(raw) {
  const base = common(raw);
  if (!base || String(raw.source ?? "").replace(/^\.\//, "") !== "templates/" + raw.name + ".json") return null;
  return { ...base, source: "templates/" + raw.name + ".json" };
}

/**
 * A catalog's version 2 listings: { skills, packs, templates }, or null for a catalog that does not
 * set schemaVersion 2 or later. An entry that breaks the format is left out, as `agents` does.
 */
export function v2Entries(value) {
  if (!Number.isInteger(value?.schemaVersion) || value.schemaVersion < 2) return null;
  const each = (list, read) => {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const entry = read(raw);
      if (!entry || seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
      if (out.length >= MAX_LISTINGS) break;
    }
    return out;
  };
  return { skills: each(value.skills, skillEntry), packs: each(value.packs, packEntry), templates: each(value.templates, templateEntry) };
}

/** Each `name@range` of `list` resolved in `index` (name → entry with a version). Refuses a missing one or an unmet range. */
export function resolveRefs(list, index, kind, catalogName) {
  return (list ?? []).map((item) => {
    const ref = reference(item);
    if (!ref) throw new Error(`"${item}" is not a ${kind} reference (name@range).`);
    const entry = index.get(ref.name);
    if (!entry) throw new Error(`This needs the ${kind} ${ref.name} (${ref.range}), which isn't in ${catalogName}.`);
    if (entry.version && !satisfies(entry.version, ref.range)) throw new Error(`This needs the ${kind} ${ref.name} ${ref.range}, but ${catalogName} has ${entry.version}.`);
    return { ...ref, entry };
  });
}

/**
 * What a template's `requires` or a pack comes to in one catalog: every skill and plugin, each once,
 * with the packs that brought them. `plugins` is the catalog's plugin entries (name → { version? }).
 */
export function resolveRequires(requires, v2, plugins, catalogName) {
  const skillIndex = new Map(v2.skills.map((s) => [s.name, s]));
  const packIndex = new Map(v2.packs.map((p) => [p.name, p]));
  const skills = new Map();
  const pluginNames = new Map();
  const add = (map, items) => {
    for (const item of items) if (!map.has(item.name)) map.set(item.name, item.entry);
  };
  add(skills, resolveRefs(requires.skills, skillIndex, "skill", catalogName));
  add(pluginNames, resolveRefs(requires.plugins, plugins, "plugin", catalogName));
  const packs = resolveRefs(requires.packs, packIndex, "pack", catalogName).map(({ entry }) => entry);
  for (const pack of packs) {
    add(skills, resolveRefs(pack.skills, skillIndex, "skill", catalogName));
    add(pluginNames, resolveRefs(pack.plugins, plugins, "plugin", catalogName));
  }
  return { skills: [...skills.values()], plugins: [...pluginNames.keys()], packs };
}

/** The capabilities this computer gives a bot now: a shell, the node and python commands, a paired browser, the network. */
export function toolsHere(ws, path = process.env.PATH ?? "") {
  const onPath = (...names) =>
    path.split(delimiter).filter(Boolean).some((dir) =>
      names.some((name) => ["", ".exe", ".cmd"].some((ext) => {
        try {
          return statSync(join(dir, name + ext)).isFile();
        } catch {
          return false;
        }
      })),
    );
  return { shell: true, node: onPath("node"), python: onPath("python3", "python"), browser: (ws?.browser?.listed?.().length ?? 0) > 0, network: true };
}

const TOOL_WORDS = { shell: "a shell", node: "the node command", python: "python", browser: "a paired browser", network: "the network" };
/** The sentences for a skill's needed capabilities that this computer can't give a bot now. */
export function toolWarnings(requires, here) {
  const missing = (requires?.tools ?? []).filter((tool) => !here[tool]);
  return missing.map((tool) => `This skill needs ${TOOL_WORDS[tool]}, which bots on this computer can't use now.`);
}

/** What changed between two pinned folders ({ path: blob }): { added, changed, removed }. */
export function fileDiff(before = {}, after = {}) {
  const added = [];
  const changed = [];
  for (const [path, sha] of Object.entries(after)) {
    if (!Object.hasOwn(before, path)) added.push(path);
    else if (before[path] !== sha) changed.push(path);
  }
  const removed = Object.keys(before).filter((path) => !Object.hasOwn(after, path));
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

const listingId = (name, market) => name + "@" + market;
function splitId(id, what) {
  if (typeof id !== "string" || id.length > 300) throw new Error("Choose a " + what + " from the marketplace.");
  const at = id.lastIndexOf("@");
  if (at <= 0) throw new Error("Choose a " + what + " from the marketplace.");
  return [id.slice(0, at), id.slice(at + 1)];
}

/**
 * The version 2 listings of every marketplace, with their reviews and installs. `skills` is the
 * skills catalog (desktop/skills-catalog.mjs), which reads and installs the pinned folders; `plugins`
 * the installed plugins (desktop/plugins.mjs), whose catalog reads the marketplaces.
 */
export class MarketV2 {
  constructor({ ws, skills, plugins, tools = () => toolsHere(ws) }) {
    this.ws = ws;
    this.skills = skills;
    this.plugins = plugins;
    this.tools = tools;
    this.reviews = new Map();
  }
  get catalog() {
    return this.plugins.catalog;
  }
  remember(value) {
    for (const [key, item] of this.reviews) if (item.expires < Date.now()) this.reviews.delete(key);
    if (this.reviews.size >= 32) this.reviews.delete(this.reviews.keys().next().value);
    const token = randomUUID();
    this.reviews.set(token, { value, expires: Date.now() + REVIEW_TTL });
    return token;
  }
  recall(token) {
    const hit = typeof token === "string" ? this.reviews.get(token) : undefined;
    if (!hit || hit.expires < Date.now()) throw new Error("Open the review again before installing.");
    return hit.value;
  }
  /** One marketplace with its version 2 listings, read at its commit. */
  async record(marketId) {
    const record = await this.catalog.v2Record(marketId);
    if (!record?._v2) throw new Error("That marketplace lists no skills, packs or templates.");
    return record;
  }
  /** Where a skill folder's files come from: the catalog's repository at its commit, or its folder. */
  skillItem(record, entry) {
    const info = record._sourceInfo;
    const source = info?.type === "github" ? { type: "github", repo: info.repo } : info?.type === "local" ? { type: "local", root: info.root } : null;
    if (!source) throw new Error("Skills from " + record.name + " can't be installed: its catalog is not a GitHub repository or a folder.");
    return { id: listingId(entry.name, record.id), name: entry.name, version: entry.version, catalog: record.id, catalogName: record.name, commit: record._v2.commit, path: entry.path, license: entry.license, ...(entry.author && { author: entry.author }), source };
  }
  /** Who has a catalog skill now: the shared skills ("all") and the bots that have it for themselves, each with its version. */
  installs(catalogId, name) {
    const listing = this.ws.integrations.skillState.listings?.[name];
    const shared = listing && listing.catalog === catalogId && listing.name === name ? listing : undefined;
    const bots = this.ws.state.bots
      .map((bot) => ({ bot, own: bot.catalogSkills?.find((s) => s.catalog === catalogId && s.name === name) }))
      .filter(({ own }) => own)
      .map(({ bot, own }) => ({ id: bot.id, name: bot.name, version: own.version }));
    return { ...(shared && { shared: { version: shared.version, commit: shared.commit } }), bots };
  }
  skillListing(record, entry) {
    const installed = this.installs(record.id, entry.name);
    const versions = [installed.shared?.version, ...installed.bots.map((b) => b.version)].filter(Boolean);
    const update = versions.some((v) => SEMVER.test(v) && compareVersions(entry.version, v) > 0);
    return {
      id: listingId(entry.name, record.id), kind: "skill", name: entry.name, version: entry.version, summary: entry.summary,
      ...(entry.category && { category: entry.category, categoryName: AGENT_CATEGORIES[entry.category] }),
      ...(entry.keywords && { keywords: entry.keywords }), ...(entry.author && { author: entry.author }),
      license: entry.license, requires: entry.requires, hasPreview: Boolean(entry.preview),
      marketplace: record.id, marketplaceName: record.name, commit: record._v2.commit,
      ...((installed.shared || installed.bots.length) && { installed }),
      ...(update && { update: true }),
      warnings: toolWarnings(entry.requires, this.tools()),
    };
  }
  /** Every skill, pack and template the marketplaces list in format version 2, the built-in Botkins one first. */
  async list() {
    const skills = [];
    const packs = [];
    const templates = [];
    const errors = [];
    for (const record of await this.catalog.v2Records()) {
      if (record._v2Error) errors.push({ marketplace: record.id, error: record._v2Error });
      if (!record._v2) continue;
      for (const entry of record._v2.skills) skills.push(this.skillListing(record, entry));
      for (const entry of record._v2.packs)
        packs.push({ id: listingId(entry.name, record.id), kind: "pack", name: entry.name, version: entry.version, summary: entry.summary, ...(entry.category && { category: entry.category }), ...(entry.author && { author: entry.author }), skills: entry.skills, plugins: entry.plugins, marketplace: record.id, marketplaceName: record.name, commit: record._v2.commit });
      for (const template of await this.catalog.v2Templates(record)) templates.push(template);
    }
    return { skills, packs, templates, ...(errors.length && { errors }) };
  }
  /** A skill's preview picture as a data URL, read at the catalog's commit. */
  async image(id) {
    const [name, marketId] = splitId(id, "skill");
    const record = await this.record(marketId);
    const entry = record._v2.skills.find((s) => s.name === name);
    if (!entry?.preview) throw new Error("This skill has no picture.");
    const bytes = await this.catalog.v2File(record, entry.preview, MAX_IMAGE);
    const type = /\.png$/i.test(entry.preview) ? "image/png" : /\.webp$/i.test(entry.preview) ? "image/webp" : "image/jpeg";
    return "data:" + type + ";base64," + bytes.toString("base64");
  }
  /** One catalog skill's review: its SKILL.md, every file (executables marked), what it needs, and the change from an installed version. */
  async skillReview(record, entry) {
    const preview = await this.skills.listingPreview(this.skillItem(record, entry));
    const installed = this.installs(record.id, entry.name);
    const pinned = [installed.shared && this.ws.integrations.skillState.listings[entry.name]?.files, ...installed.bots.map((b) => this.ws.bot(b.id).catalogSkills.find((s) => s.catalog === record.id && s.name === entry.name)?.files)].find(Boolean);
    const versions = [installed.shared?.version, ...installed.bots.map((b) => b.version)].filter(Boolean);
    const from = versions.sort(compareVersions)[0];
    return {
      ...preview,
      listing: this.skillListing(record, entry),
      ...(from && compareVersions(entry.version, from) > 0 && pinned && { update: { from, to: entry.version, ...fileDiff(pinned, preview.pins) } }),
    };
  }
  async skillPreview(id) {
    const [name, marketId] = splitId(id, "skill");
    const record = await this.record(marketId);
    const entry = record._v2.skills.find((s) => s.name === name);
    if (!entry) throw new Error("That skill is no longer in " + record.name + ".");
    const { pins: _pins, ...review } = await this.skillReview(record, entry);
    return review;
  }
  /** Installs a reviewed catalog skill: for every bot (`bots` "all", the shared skills) or for the bots named. */
  async skillInstall(token, options = {}) {
    return this.skills.install(token, options.replace ?? [], { bots: this.botScope(options.bots) });
  }
  botScope(value) {
    if (value === undefined || value === "all") return "all";
    if (!Array.isArray(value) || !value.length || value.length > 200 || !value.every((id) => typeof id === "string")) throw new Error("Choose the bots that get it.");
    for (const id of value) this.ws.bot(id);
    return [...new Set(value)];
  }
  /** The plugins of a pack or template, each with its review (revision, what it runs and reaches) and whether it's installed. */
  async pluginReviews(record, names) {
    const out = [];
    for (const name of names) {
      const id = name + "@" + record.id;
      const preview = await this.plugins.preview(id);
      const row = this.plugins.records.find((r) => r.preview.id === id);
      out.push({ id, name: preview.name ?? name, ...(preview.version && { version: preview.version }), ...(preview.description && { description: preview.description }), revision: preview.revision, contents: preview.contents, config: preview.config, ...(preview.warnings && { warnings: preview.warnings }), ...(row && { installed: { bots: row.bots, enabled: row.enabled } }) });
    }
    return out;
  }
  async packPreview(id) {
    const [name, marketId] = splitId(id, "pack");
    const record = await this.record(marketId);
    const pack = record._v2.packs.find((p) => p.name === name);
    if (!pack) throw new Error("That pack is no longer in " + record.name + ".");
    const resolved = resolveRequires({ skills: pack.skills, plugins: pack.plugins }, record._v2, this.catalog.pluginIndex(record), record.name);
    const skills = [];
    for (const entry of resolved.skills) skills.push(await this.skillReview(record, entry));
    const plugins = await this.pluginReviews(record, resolved.plugins);
    const token = this.remember({ kind: "pack", id, commit: record._v2.commit, skills: skills.map((s) => s.token), plugins: plugins.map(({ id: pid, revision }) => ({ id: pid, revision })) });
    return { id, name: pack.name, version: pack.version, summary: pack.summary, marketplace: record.id, marketplaceName: record.name, commit: record._v2.commit, token, skills: skills.map(({ pins: _p, ...s }) => s), plugins };
  }
  /** Gives plugins, at the revisions reviewed, to `bots`: installs one that isn't installed, and widens the bots of one that is. */
  async givePlugins(plugins, bots) {
    const done = [];
    for (const { id, revision } of plugins) {
      const row = this.plugins.records.find((r) => r.preview.id === id);
      if (!row) await this.plugins.install(id, { revision, bots });
      else if (row.bots !== "all") await this.plugins.setBots(id, bots === "all" ? "all" : [...new Set([...row.bots, ...bots])]);
      done.push(id);
    }
    return done;
  }
  /** Installs every skill and plugin of a reviewed pack for `bots` ("all" or bot ids). Shared skills that would replace one need `replace`. */
  async packInstall(token, options = {}) {
    const review = this.recall(token);
    if (review.kind !== "pack") throw new Error("Open the pack's review again.");
    if (options.commit !== undefined && options.commit !== review.commit) throw new Error("The catalog changed after this review. Open it again.");
    const bots = this.botScope(options.bots);
    const replace = options.replace ?? [];
    const added = [];
    for (const skill of review.skills) {
      const result = await this.skills.install(skill, replace, { bots });
      if (result.conflicts?.length) return { added, conflicts: result.conflicts, plugins: [] };
      added.push(...result.added);
    }
    const plugins = await this.givePlugins(review.plugins, bots);
    this.reviews.delete(token);
    return { added, conflicts: [], plugins };
  }
  /**
   * A version 3 template's whole review: who the bot is and its full instructions, each catalog
   * skill (version, license, files, executables, what it needs and whether the computer has it), its
   * private skills in full, each plugin with what it runs and reaches, and every routine with its
   * schedule, whether it starts active, and its full prompt.
   */
  async templatePreview(id) {
    const [name, marketId] = splitId(id, "template");
    const record = await this.record(marketId);
    const entry = record._v2.templates.find((t) => t.name === name);
    if (!entry) throw new Error("That template is no longer in " + record.name + ".");
    const template = await this.catalog.v2TemplateFile(record, entry);
    const resolved = resolveRequires(template.requires ?? {}, record._v2, this.catalog.pluginIndex(record), record.name);
    const skills = [];
    for (const skill of resolved.skills) {
      const { pins: _p, ...review } = await this.skillReview(record, skill);
      skills.push(review);
    }
    const plugins = await this.pluginReviews(record, resolved.plugins);
    const routines = (template.bundle?.routines ?? []).map((routine) => ({ ...routine, active: routine.active === true }));
    const token = this.remember({ kind: "template", id, commit: record._v2.commit, template, skills: skills.map((s) => s.token), plugins: plugins.map(({ id: pid, revision }) => ({ id: pid, revision })) });
    return {
      id, token, commit: record._v2.commit, marketplace: record.id, marketplaceName: record.name, version: entry.version,
      name: template.name, role: template.role, summary: template.summary ?? "", instructions: template.instructions, ...(template.look && { look: template.look }),
      ...(template.requires && { requires: template.requires }),
      packs: resolved.packs.map((p) => ({ name: p.name, version: p.version, summary: p.summary })),
      skills, privateSkills: template.bundle?.skills ?? [], plugins, routines,
    };
  }
  /**
   * Makes the bot of a reviewed template: the bot with its private skills and the routines left on
   * (paused unless the template marks one active), then its catalog skills and pack contents for that
   * bot only. A failure after the bot is made takes the bot away again.
   */
  async templateInstall(token, options = {}, person = "owner") {
    const review = this.recall(token);
    if (review.kind !== "template") throw new Error("Open the template's review again.");
    if (options.commit !== undefined && options.commit !== review.commit) throw new Error("The catalog changed after this review. Open it again.");
    const { template } = review;
    const routines = template.bundle?.routines ?? [];
    const on = options.routines === undefined ? routines.map((r) => r.name) : options.routines;
    if (!Array.isArray(on) || !on.every((n) => typeof n === "string")) throw new Error("Choose the routines to keep.");
    const kept = routines.filter((r) => on.includes(r.name));
    const bundle = storedBundle({ ...(template.bundle?.skills && { skills: template.bundle.skills }), ...(kept.length && { routines: kept }) });
    const data = {
      name: options.name ?? template.name, role: template.role, instructions: template.instructions,
      ...(template.summary && { summary: template.summary }), ...(template.look && { look: template.look }),
      ...((bundle?.skills || bundle?.routines) && { bundle }),
    };
    const botId = this.ws.addBot(data, person, { activeRoutines: kept.filter((r) => r.active === true).map((r) => r.name) });
    try {
      const added = [];
      for (const skill of review.skills) added.push(...(await this.skills.install(skill, [], { bots: [botId] })).added);
      const plugins = await this.givePlugins(review.plugins, [botId]);
      this.reviews.delete(token);
      return { botId, skills: added, plugins };
    } catch (error) {
      await this.ws.agents.deleteBot(botId).catch(() => {});
      throw error;
    }
  }
}

/** Whether a folder exists as a plain directory (used for a bot's own catalog skills). */
export const isFolder = (path) => existsSync(path) && statSync(path).isDirectory();
