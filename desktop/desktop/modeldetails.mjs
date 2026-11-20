// What is known about a model: how much it can read at once, how long a reply can be, whether it
// takes pictures and tools, and the like. Every entry of the model catalog can carry these:
//
//   contextWindow  tokens the model can hold at once
//   maxPrompt      tokens a request may hold, where the provider names a limit below the window
//   maxOutput      tokens one reply may hold
//   vision, tools  whether it takes pictures, whether it can call tools
//   effortNotes    { [thinking level]: the provider's own line about it }
//   description    the provider's own line about the model
//   knowledge      its knowledge cut-off, as the provider writes it
//   vendor         who made it, where a provider serves several makers' models
//   tier           the provider's price or speed class, as it names it
//
// Every value comes from the provider that serves the model: its listing, its own catalog file,
// what its tool reported after a turn, or (Claude only) the table Anthropic publishes. A value
// nobody stated is left out. Nothing in this file is a default, and nothing may become one: a
// wrong number here is shown to a person as a fact, and is what a chat's context meter counts to.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const tokens = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);
const flag = (value) => (typeof value === "boolean" ? value : undefined);
const line = (value, most = 400) => (typeof value === "string" && value.trim() ? value.trim().slice(0, most) : undefined);

/** The details given, with everything that isn't a real value left out. */
export function modelDetails(raw = {}) {
  const notes = Object.fromEntries(
    Object.entries(raw.effortNotes && typeof raw.effortNotes === "object" ? raw.effortNotes : {})
      .map(([effort, note]) => [effort, line(note, 200)])
      .filter(([, note]) => note),
  );
  const out = {
    contextWindow: tokens(raw.contextWindow),
    maxPrompt: tokens(raw.maxPrompt),
    maxOutput: tokens(raw.maxOutput),
    vision: flag(raw.vision),
    tools: flag(raw.tools),
    effortNotes: Object.keys(notes).length ? notes : undefined,
    description: line(raw.description),
    knowledge: line(raw.knowledge, 40),
    vendor: line(raw.vendor, 60),
    tier: line(raw.tier, 40),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/**
 * What a chat's context meter counts to for a model: the most a request may hold. That is the
 * provider's prompt limit where it names one, else the model's window. Undefined when neither is known.
 */
export const meterLimit = (model) => tokens(model?.maxPrompt) ?? tokens(model?.contextWindow);

// Anthropic's published limits and knowledge cut-offs, by model id
// (https://platform.claude.com/docs/en/about-claude/models/overview, read 19 November 2026).
// Used for a Claude model until Claude Code has reported the model's limits on this person's own
// plan, which then count instead. A model that isn't in the table gets nothing from it.
const M = 1_000_000;
const CURRENT = { contextWindow: M, maxOutput: 128_000, knowledge: "Jun 2026", vision: true, tools: true };
const LARGE = { contextWindow: M, maxOutput: 128_000 };
const PUBLISHED = {
  "claude-fable-5-2": CURRENT,
  "claude-opus-5-5": CURRENT,
  "claude-sonnet-5-5": CURRENT,
  "claude-haiku-5-5": CURRENT,
  "claude-mythos-5-2": LARGE,
  "claude-fable-5-1": LARGE,
  "claude-mythos-5-1": LARGE,
  "claude-fable-5": LARGE,
  "claude-mythos-5": LARGE,
  "claude-opus-5": LARGE,
  "claude-opus-4-8": LARGE,
  "claude-opus-4-7": LARGE,
  "claude-opus-4-6": LARGE,
  "claude-sonnet-5": LARGE,
  "claude-sonnet-4-6": LARGE,
  "claude-opus-4-5": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-sonnet-4-5": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-haiku-4-5": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-sonnet-4": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-opus-4-1": { contextWindow: 200_000, maxOutput: 32_000 },
  "claude-opus-4": { contextWindow: 200_000, maxOutput: 32_000 },
};
/** A Claude model's id without what Claude Code and dated snapshots add to it ("[1m]", "-20251101"). */
export const claudeModelId = (id) => String(id ?? "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").toLowerCase();
/** What Anthropic publishes about a Claude model, or {} for a model its table doesn't have. */
export const claudePublished = (id) => ({ ...(PUBLISHED[claudeModelId(id)] ?? {}) });

/**
 * The limits a provider's own tool reported for a model after a turn, kept in a file so they are
 * known the next time the app starts: { [model]: { contextWindow?, maxOutput?, maxPrompt? } }.
 * Without a file (a test, a trial run) they are kept for this run only.
 */
export class ReportedLimits {
  constructor(file) {
    this.file = file || null;
    this.known = {};
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const [model, limits] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
        const kept = this.clean(limits);
        if (Object.keys(kept).length) this.known[model] = kept;
      }
    } catch {
      // Nothing reported yet.
    }
  }
  clean(limits) {
    const { contextWindow, maxOutput, maxPrompt } = modelDetails(limits ?? {});
    return { ...(contextWindow && { contextWindow }), ...(maxOutput && { maxOutput }), ...(maxPrompt && { maxPrompt }) };
  }
  /** What was reported for a model, or {}. */
  for(model) {
    return { ...(this.known[model] ?? {}) };
  }
  /** Takes a report. Returns true when it said something new. */
  note(model, limits) {
    if (typeof model !== "string" || !model) return false;
    const next = { ...this.known[model], ...this.clean(limits) };
    if (!Object.keys(next).length || JSON.stringify(next) === JSON.stringify(this.known[model])) return false;
    this.known[model] = next;
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.known, null, 2));
      } catch {
        // Kept for this run.
      }
    }
    return true;
  }
}
