// What a session was told when it began, kept so the start of every request stays the same.
//
// A model's prompt cache holds the start of a request: its tools, then its system prompt, then the
// conversation. A request that changes any of it pays for the whole of it again. So a session's
// system prompt and tool list are fixed when it begins, here, and stay byte for byte the same on
// every turn of it, including after Botkins or the harness restarts:
//   - The parts of a bot's instructions that change while it works (its memory, the project, the
//     space, its team) are taken as they were. When one changes, the turn's own message tells the
//     model what changed ("[Botkins: context updated since this session began] …", contextNote),
//     once; the system prompt stays as it was.
//   - The tools are those the session began with, in a fixed order (by name). A tool that isn't
//     there for a turn (a turn type without it, a server that doesn't answer) stays listed and says
//     why when it is called. A tool that first appears later is added, which changes the list once.
//   - Each MCP server Botkins runs stays on the side it began on: Botkins' own (its tools come with
//     Botkins' tools) or the harness's. One that doesn't answer for a turn isn't moved to the
//     harness, where its tools would have other names.
// A new session starts afresh: a new chat, a restart of its session (a moved folder, another
// provider, a compacted Main chat), a compaction, another model, or a change to the bot's own
// instructions or profile, which are the part of the prompt that is never told as a change.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The parts of a bot's instructions that change while a session lasts, as a context note names them. */
export const LIVE_PARTS = {
  project: "Project",
  space: "Space",
  team: "Your team",
  subagents: "Subagents",
  wiki: "Wiki",
  notes: "Working notes",
  memory: "Your memory",
};

export const NOTE_HEAD = "[Botkins: context updated since this session began]";

const linesOf = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Lines of `after` that `before` doesn't have, and lines of `before` that `after` doesn't, each kept in order. Repeated lines count. */
export function lineDelta(before, after) {
  const left = linesOf(before);
  const right = linesOf(after);
  const count = (lines) => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
  const take = (lines, other) => {
    const spare = count(other);
    return lines.filter((line) => {
      const n = spare.get(line) ?? 0;
      if (n > 0) {
        spare.set(line, n - 1);
        return false;
      }
      return true;
    });
  };
  return { added: take(right, left), removed: take(left, right) };
}

/**
 * The note that tells a session what changed in the live parts since it was last told, or "" when
 * nothing did. `told` is what the session knows (its system prompt, then each note it was given);
 * `now` is the parts as they are.
 */
export function contextNote(told, now) {
  const sections = [];
  for (const [part, label] of Object.entries(LIVE_PARTS)) {
    if ((told?.[part] ?? "") === (now?.[part] ?? "")) continue;
    const { added, removed } = lineDelta(told?.[part], now?.[part]);
    if (!added.length && !removed.length) continue;
    if (added.length) sections.push(label + ", now also:\n" + added.map((line) => "+ " + line).join("\n"));
    if (removed.length) sections.push(label + ", no longer:\n" + removed.map((line) => "- " + line).join("\n"));
  }
  return sections.length ? NOTE_HEAD + " These replace what your instructions said above where they differ.\n" + sections.join("\n") : "";
}

/** The start of the line that tells a session which of its tools came and went (toolChanges). */
export const TOOLS_HEAD = "[Botkins: your tools changed]";
const NAMED = 40; // tool names in one line of that note

/**
 * What a turn tells its session about its tools, with its message. A session's tool list stays as
 * it began (stableTools): a tool that is new is added without a word, and one the turn hasn't
 * stays listed and only says so when it is called. So the model is told here, by name. Nothing is
 * kept by hand: the names are the turn's own tools, whatever made them (Botkins, a server, a plugin).
 *   - A tool the session lists for the first time is told once ("Now yours to use"). That is the
 *     turn in which the tool list changes anyway.
 *   - The tools a turn hasn't are told when they are not the ones last told ("Not in this turn").
 *     So a session whose turns take turns (a person's and a routine's, an owner's and a member's)
 *     is told once what the other kind of turn lacks, not with every message.
 *   known    the names the session listed before this turn (none for a session that begins: its
 *            tool list says it all)
 *   current  the names this turn has
 *   told     { untold?, missing? } of the session's record: the new names it was not told yet (a
 *            turn that was stopped before its message was sent), and the missing ones last told
 * Returns { note, added, missing }: `added` are the names to keep as untold until the message is
 * answered, `missing` the ones to keep as told then (null when nothing was said of them).
 */
export function toolChanges(known, current, { untold = [], missing: told = [] } = {}) {
  if (!known.length) return { note: "", added: [], missing: null };
  const before = new Set(known);
  const now = new Set(current);
  const added = [...new Set([...untold, ...current.filter((name) => !before.has(name))])].filter((name) => now.has(name)).sort();
  const gone = [...new Set(known)].filter((name) => !now.has(name)).sort();
  const said = gone.length > 0 && (gone.length !== told.length || gone.some((name, index) => name !== told[index]));
  const names = (list) => list.slice(0, NAMED).join(", ") + (list.length > NAMED ? " and " + (list.length - NAMED) + " more" : "");
  const note =
    added.length || said
      ? TOOLS_HEAD +
        (added.length ? "\nNow yours to use: " + names(added) + "." : "") +
        (said ? "\nNot in this turn (still listed, but they answer that they aren't available): " + names(gone) + "." : "")
      : "";
  return { note, added, missing: said ? gone : null };
}

/** A digest of anything, for comparing what a session began with to what it would begin with now. */
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A tool as the model is told of it: what is compared and kept. Whether it asks first, and its handler, are the turn's own. */
const declared = ({ name, description, parameters }) => ({ name, description, parameters: parameters ?? null });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A session's tools for one turn: every tool the session has listed, in order of name (so the
 * order never depends on which server answered first). A tool the turn has is the turn's own, as
 * it is now; `known` keeps its definition, and takes a changed one (which changes the list once,
 * as a tool seen for the first time does). A tool the turn hasn't stays listed as it was last
 * seen and answers `missing(name)`: nothing runs. Returns { tools, changed }.
 */
export function stableTools(known, current, missing) {
  let changed = false;
  for (const tool of current) {
    const at = known.findIndex((each) => each.name === tool.name);
    if (at < 0) known.push(declared(tool));
    else if (!same(known[at], declared(tool))) known[at] = declared(tool);
    else continue;
    changed = true;
  }
  known.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const now = new Map(current.map((tool) => [tool.name, tool]));
  const tools = known.map((tool) => {
    const live = now.get(tool.name);
    if (live) return live;
    const { parameters, ...rest } = tool;
    return {
      ...rest,
      ...(parameters !== null && { parameters }),
      // The tool's own checks ran for the turns that had it. One that isn't here does nothing.
      skipPermission: true,
      defer: "never",
      handler: async () => {
        throw new Error(missing(tool.name));
      },
    };
  });
  return { tools, changed };
}

/** A record as read from its file, or null when it isn't one (a damaged or older file). */
function valid(record, key) {
  const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  return object(record) && record.key === key && typeof record.basis === "string" && object(record.parts) && object(record.told) && Array.isArray(record.tools) && object(record.routes) ? record : null;
}

/** How many records are kept in memory; one that is let go is read again from its file. */
const HELD = 400;
/** A record not used for this long is removed: the model's cache of that session is long gone. */
export const RECORD_DAYS = 30;

/**
 * Each session's record, kept in a file of its own in Botkins' data folder (or in memory without
 * one, and for a temporary session), so it outlives a restart of Botkins or of the harness:
 *   { key, chatId, botId, basis, parts, told, tools, untold?, missing?, routes, stale? }
 *   chatId, botId  whose session it is (forget)
 *   basis   digest of what starts a new record when it changes
 *   parts   the live parts as the system prompt has them
 *   told    the live parts as the session knows them now (parts, then each context note)
 *   tools   the tools the session lists, without handlers
 *   untold  the names of tools that are new to the session and that it was not told of yet (toolChanges)
 *   missing the names of the tools that the session was last told a turn hadn't
 *   routes  { [server name]: "botkins" | "harness" }
 *   stale   set after a compaction: the next turn starts a new record
 */
export class SessionPrompts {
  constructor(dir) {
    this.dir = dir;
    this.records = new Map();
  }
  file(key) {
    return this.dir && join(this.dir, digest(key).slice(0, 32) + ".json");
  }
  get(key) {
    const held = this.records.get(key);
    if (held) {
      // The longest unused is let go first.
      this.records.delete(key);
      this.records.set(key, held);
      return held;
    }
    const file = this.file(key);
    if (!file || !existsSync(file)) return null;
    try {
      const record = valid(JSON.parse(readFileSync(file, "utf8")), key);
      if (record) this.hold(key, record);
      return record;
    } catch {
      // A damaged record only costs one turn's cache.
      return null;
    }
  }
  hold(key, record) {
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > HELD) this.records.delete(this.records.keys().next().value);
  }
  /** `temporary`: a session that ends with its turn (a subagent, a disposable chat) is kept in memory only. */
  set(key, record, { temporary = false } = {}) {
    record.key = key;
    if (temporary) record.temporary = true;
    this.hold(key, record);
    this.save(key, record);
    return record;
  }
  /** Writes a record: the one given (a turn holds its own, even one let go from memory meanwhile), else the one held. */
  save(key, record = this.records.get(key)) {
    const file = this.file(key);
    if (!file || !record || record.temporary) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(file + ".tmp", JSON.stringify(record), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    } catch (error) {
      console.error("Session prompt:", error.message);
    }
  }
  /** A turn used the record: its file's time says so, for sweep. */
  used(key) {
    const file = this.file(key);
    if (!file || this.records.get(key)?.temporary) return;
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      // Not written yet, or gone: the next save writes it.
    }
  }
  /** After a compaction: the session's next turn starts from what is current. */
  stale(key) {
    const record = this.get(key);
    if (!record || record.stale) return;
    record.stale = true;
    this.save(key, record);
  }
  delete(key) {
    this.records.delete(key);
    const file = this.file(key);
    if (file) rmSync(file, { force: true });
  }
  /**
   * Has every record `match(record)` picks begin afresh at its session's next turn, and keeps no
   * more of its text meanwhile: memory the person removed must not stay in a prompt or on disk.
   */
  staleWhere(match) {
    for (const record of this.records.values()) if (match(record)) Object.assign(record, { stale: true, parts: {}, told: {} });
    if (!this.dir || !existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name);
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        if (!match(record)) continue;
        writeFileSync(file, JSON.stringify({ ...record, stale: true, parts: {}, told: {} }), { mode: 0o600 });
      } catch {
        // A damaged or half-written file: the sweep removes it in time.
      }
    }
  }
  /**
   * Removes every record `match(record)` picks, held or written: those of a deleted chat or bot,
   * whose memory and context text must not outlive it.
   */
  forget(match) {
    for (const [key, record] of [...this.records]) if (match(record)) this.records.delete(key);
    if (!this.dir || !existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name);
      try {
        if (match(JSON.parse(readFileSync(file, "utf8")))) rmSync(file, { force: true });
      } catch {
        // A damaged or half-written file: the sweep removes it in time.
      }
    }
  }
  /** Removes the records no session has used for `days` (each turn of a session writes or reads its own). */
  sweep(days = RECORD_DAYS, now = Date.now()) {
    if (!this.dir || !existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name);
      try {
        if (now - statSync(file).mtimeMs < days * 86400000) continue;
        rmSync(file, { force: true });
        removed++;
      } catch {
        // Gone already.
      }
    }
    return removed;
  }
}
