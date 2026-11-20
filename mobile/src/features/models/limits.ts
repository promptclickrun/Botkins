// A provider's plan and what is left of its limits, as words and numbers for a screen. No React
// Native imports, so tests/limits.test.ts runs it. Nothing here makes a number up: a value the
// computer didn't send stays absent, and a screen then says "Not available" or shows nothing.
import type { ProviderLimit, ProviderUsage } from "@/link/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const percent = (value: unknown) => {
  const n = number(value);
  return n === undefined ? undefined : Math.min(100, Math.max(0, n));
};

/** What the computer sent, kept only where it is what the type says. A percent is kept within 0 to 100. */
export function cleanUsage(raw: unknown): ProviderUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderUsage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.provider !== "string" || !entry.provider) continue;
    const limits: ProviderLimit[] = [];
    for (const each of Array.isArray(entry.limits) ? entry.limits : []) {
      if (!each || typeof each !== "object") continue;
      const limit = each as Record<string, unknown>;
      const label = text(limit.label, 60);
      if (!label) continue;
      const unlimited = limit.unlimited === true;
      // What is left, as the provider says it, or as 100 less what it says is used. An allowance without a limit has no percent.
      const used = percent(limit.percentUsed);
      const left = unlimited ? undefined : (percent(limit.percentRemaining) ?? (used === undefined ? undefined : 100 - used));
      const resetAt = number(limit.resetAt);
      const counted = number(limit.used);
      const most = number(limit.limit);
      limits.push({
        id: text(limit.id, 60) ?? label,
        label,
        ...(left !== undefined && { percentRemaining: left }),
        ...(used !== undefined && !unlimited && { percentUsed: used }),
        ...(resetAt !== undefined && resetAt > 0 && { resetAt }),
        ...(limit.primary === true && { primary: true }),
        ...((limit.window === "session" || limit.window === "week" || limit.window === "month") && { window: limit.window }),
        ...(text(limit.model, 40) && { model: text(limit.model, 40) }),
        ...(counted !== undefined && counted >= 0 && { used: counted }),
        ...(most !== undefined && most > 0 && { limit: most }),
        ...((limit.unit === "requests" || limit.unit === "credits") && { unit: limit.unit }),
        ...(unlimited && { unlimited: true }),
      });
    }
    const credits = entry.credits && typeof entry.credits === "object" ? (entry.credits as Record<string, unknown>) : null;
    const amount = number(credits?.amount);
    const updatedAt = number(entry.updatedAt);
    out.push({
      provider: entry.provider,
      ...(text(entry.name, 60) && { name: text(entry.name, 60) }),
      ...(text(entry.plan, 80) && { plan: text(entry.plan, 80) }),
      ...((entry.account === "subscription" || entry.account === "api-key") && { account: entry.account }),
      limits,
      ...(updatedAt !== undefined && updatedAt > 0 && { updatedAt }),
      ...(text(entry.error, 200) && { error: text(entry.error, 200) }),
      ...(text(entry.source, 40) && { source: text(entry.source, 40) }),
      ...(text(entry.note, 200) && { note: text(entry.note, 200) }),
      ...(credits && text(credits.label, 40) && amount !== undefined && { credits: { label: text(credits.label, 40)!, amount, unit: text(credits.unit, 20) ?? "" } }),
    });
  }
  return out;
}

// The words below are the desktop app's own (its src/ProviderLimits.tsx), so both show the same.

/** "62%", or "99.5%" when the provider gives a part of a percent (one decimal at most). */
export function percentWords(percent: number): string {
  const tenth = Math.round(percent * 10) / 10;
  return (Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1)) + "%";
}

export type Clock = { now?: number; locale?: string; timeZone?: string };

/** Numbers older than this say their age where they would say when the limit starts again. */
export const OLD_MS = 10 * 60_000;

/** How long ago something was read: "just now", "5 min ago", "3 hr ago", "2 days ago". */
export function agoWords(then: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " hr ago";
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

/**
 * When a limit starts again. Short, for one line: "2:10 PM" today, "Mon" within a week, else
 * "Dec 1". Long: "today at 2:10 PM", "Mon, Nov 25 at 3:00 AM", "Dec 1". Empty when it already has.
 */
export function resetWords(resetAt: number, clock: Clock = {}, short = true): string {
  const now = clock.now ?? Date.now();
  if (resetAt <= now) return "";
  const format = (options: Intl.DateTimeFormatOptions, at = resetAt) => new Intl.DateTimeFormat(clock.locale, { ...options, timeZone: clock.timeZone }).format(at);
  const day = (at: number) => format({ year: "numeric", month: "numeric", day: "numeric" }, at);
  const time = format({ hour: "numeric", minute: "2-digit" });
  if (day(resetAt) === day(now)) return short ? time : "today at " + time;
  const date = format({ month: "short", day: "numeric" });
  if (resetAt - now < 7 * DAY) {
    const weekday = format({ weekday: "short" });
    return short ? weekday : weekday + ", " + date + " at " + time;
  }
  return date;
}

/** The one limit to show where there is room for one: the one the computer marks, else the first with a number that counts every model. */
export function primaryLimit(usage: ProviderUsage | undefined): ProviderLimit | undefined {
  return usage?.limits.find((limit) => limit.primary && limit.percentRemaining !== undefined) ?? usage?.limits.find((limit) => limit.percentRemaining !== undefined && !limit.model);
}

/** A limit inside a sentence: a week's limit for every model is "weekly", anything else its own label with a small first letter. */
const noun = (limit: ProviderLimit) => (limit.window === "week" && !limit.model ? "weekly" : limit.label.charAt(0).toLowerCase() + limit.label.slice(1));

/**
 * The line under a provider in the model picker: "62% of weekly left · resets Mon". Old numbers,
 * and numbers kept from before a failed read, say their age instead of the reset. An API key says
 * so. Undefined when the provider gave no limit to show.
 */
export function limitLine(usage: ProviderUsage | undefined, clock: Clock = {}): string | undefined {
  if (!usage) return undefined;
  const limit = primaryLimit(usage);
  if (!limit || limit.percentRemaining === undefined) return usage.account === "api-key" ? "API key · billed by use" : undefined;
  const now = clock.now ?? Date.now();
  const old = usage.updatedAt !== undefined && (!!usage.error || now - usage.updatedAt > OLD_MS);
  const reset = limit.resetAt ? resetWords(limit.resetAt, clock) : "";
  const tail = old ? "updated " + agoWords(usage.updatedAt!, now) : reset ? "resets " + reset : "";
  return percentWords(limit.percentRemaining) + " of " + noun(limit) + " left" + (tail ? " · " + tail : "");
}

const count = (value: number, locale?: string, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);

/** The counts behind a percent, where the provider gives them: "570 of 1,500 requests used". */
export function countWords(limit: ProviderLimit, locale?: string): string | undefined {
  if (limit.used === undefined || limit.limit === undefined) return undefined;
  return count(limit.used, locale) + " of " + count(limit.limit, locale) + (limit.unit ? " " + limit.unit : "") + " used";
}

/** A bought balance, as the provider counts it: "1,250". */
export function creditWords(credits: NonNullable<ProviderUsage["credits"]>, locale?: string): string {
  return count(credits.amount, locale, 2);
}

/** How much of a limit is left, for its color: a tenth or less is low, nothing is out. */
export function limitTone(percent: number): "ok" | "low" | "out" {
  return percent <= 0 ? "out" : percent <= 10 ? "low" : "ok";
}

/** "Updated 5 min ago · from Claude Code", under a provider's limits. */
export function updatedWords(updatedAt: number | undefined, now = Date.now(), source?: string): string | undefined {
  if (!updatedAt) return undefined;
  return "Updated " + agoWords(updatedAt, now) + (source ? " · from " + source : "");
}
