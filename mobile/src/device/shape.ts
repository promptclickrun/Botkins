// Shaping what a tool found into a small answer. No React Native imports.
import { dayKey, nextDay, startOfDay } from "./args";

/** The computer refuses an answer over 256 KB; this leaves room for the envelope. */
export const MAX_ANSWER = 200 * 1024;

/** Text cut to `max` characters, with an ellipsis when cut; empty text is left out. */
export function clip(text: unknown, max = 1000): string | undefined {
  if (typeof text !== "string") return undefined;
  const value = text.trim();
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/** A number rounded to `digits` places. */
export function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Fields that are undefined, null or empty lists are left out, so answers stay small. */
export function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

const size = (value: unknown) => JSON.stringify(value ?? null).length;

/**
 * An answer that fits: when the list under `key` makes it too large, entries are dropped from its
 * end and `truncated` is set, so a bot knows to ask for less.
 */
export function fit<T extends Record<string, unknown>>(result: T, key: keyof T & string, max = MAX_ANSWER): T {
  const list = result[key];
  if (!Array.isArray(list) || size(result) <= max) return result;
  let keep = list.length;
  let next: T = result;
  while (keep > 0) {
    keep = Math.floor(keep * 0.75);
    next = { ...result, [key]: list.slice(0, keep), truncated: true };
    if (size(next) <= max) return next;
  }
  return { ...result, [key]: [], truncated: true };
}

/** Lowercase, no accents, single spaces: how names are compared. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---- Contacts

/** Apple's built-in labels ("_$!<Mobile>!$_") as plain words. */
export function cleanLabel(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  const inner = /^_\$!<(.+)>!\$_$/.exec(label);
  return (inner ? inner[1] : label).toLowerCase();
}

const APPLE_PHONE_LABELS: Record<string, string> = { mobile: "_$!<Mobile>!$_", home: "_$!<Home>!$_", work: "_$!<Work>!$_", main: "_$!<Main>!$_", iphone: "iPhone", other: "_$!<Other>!$_", "home fax": "_$!<HomeFAX>!$_", "work fax": "_$!<WorkFAX>!$_", pager: "_$!<Pager>!$_" };
const APPLE_EMAIL_LABELS: Record<string, string> = { home: "_$!<Home>!$_", work: "_$!<Work>!$_", other: "_$!<Other>!$_", icloud: "iCloud", school: "_$!<School>!$_" };

/** A plain label as the one iPhone uses, so "mobile" shows as Mobile; any other label is kept as written. */
export function appleLabel(label: string | undefined, kind: "phone" | "email"): string | undefined {
  if (!label?.trim()) return undefined;
  const table = kind === "phone" ? APPLE_PHONE_LABELS : APPLE_EMAIL_LABELS;
  return table[fold(label)] ?? label.trim();
}

export type ContactCard = {
  id: string;
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  company?: string | null;
  phones?: { label?: string; number?: string }[];
  emails?: { label?: string; address?: string }[];
};

const digits = (text: string) => text.replace(/\D/g, "");

/** Whether a contact matches a search by name, company, phone number or email. */
export function matchContact(card: ContactCard, query: string): boolean {
  const words = fold(query);
  if (!words) return false;
  const name = fold([card.fullName ?? [card.givenName, card.familyName].filter(Boolean).join(" "), card.givenName, card.familyName].filter(Boolean).join(" "));
  const company = fold(card.company ?? "");
  // Every word must be in the name or company, so "ana lopez" finds "Ana María López".
  if (words.split(" ").every((word) => name.includes(word) || company.includes(word))) return true;
  const number = digits(query);
  if (number.length >= 3 && (card.phones ?? []).some((phone) => digits(phone.number ?? "").includes(number))) return true;
  return (card.emails ?? []).some((email) => fold(email.address ?? "").includes(words));
}

/** A contact as a search returns it. */
export function contactSummary(card: ContactCard) {
  const name = card.fullName?.trim() || [card.givenName, card.familyName].filter(Boolean).join(" ").trim();
  return compact({
    id: card.id,
    name: name || undefined,
    company: clip(card.company, 200),
    phones: (card.phones ?? []).filter((phone) => phone.number).map((phone) => compact({ label: cleanLabel(phone.label), number: phone.number })),
    emails: (card.emails ?? []).filter((email) => email.address).map((email) => compact({ label: cleanLabel(email.label), email: email.address })),
  });
}

/** A contact's birthday as 2026-11-19, or --11-19 when the year isn't known. */
export function contactDate(date: { year?: number; month: number; day: number } | null | undefined): string | undefined {
  if (!date || !date.month || !date.day) return undefined;
  const md = String(date.month).padStart(2, "0") + "-" + String(date.day).padStart(2, "0");
  return date.year ? String(date.year).padStart(4, "0") + "-" + md : "--" + md;
}

// ---- Health

/** The days a span covers, each from midnight to midnight in the phone's time zone. */
export function daysOf(start: Date, end: Date, maxDays = 93): { key: string; start: Date; end: Date }[] {
  const days: { key: string; start: Date; end: Date }[] = [];
  for (let day = startOfDay(start); day.getTime() < end.getTime() && days.length < maxDays; day = nextDay(day)) {
    days.push({ key: dayKey(day), start: day, end: nextDay(day) });
  }
  return days;
}

/** HealthKit's sleep stages, by their category value. */
export const SLEEP_STAGES: Record<number, string> = { 0: "inBed", 1: "asleep", 2: "awake", 3: "core", 4: "deep", 5: "rem" };
const ASLEEP = new Set([1, 3, 4, 5]);

export type Span = { start: Date | number; end: Date | number; value?: number };
const ms = (value: Date | number) => (value instanceof Date ? value.getTime() : value);

/**
 * Hours asleep, by the day a night ends on (the morning after), so last night's sleep is today's.
 * Overlapping records (a watch and a phone) are counted once.
 */
export function sleepByDay(samples: Span[]): Record<string, number> {
  const asleep = samples.filter((sample) => sample.value !== undefined && ASLEEP.has(sample.value)).map((sample) => [ms(sample.start), ms(sample.end)] as const);
  asleep.sort((a, b) => a[0] - b[0]);
  // Merge overlaps, then credit each stretch to the day it ends on.
  const merged: [number, number][] = [];
  for (const [start, end] of asleep) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const hours: Record<string, number> = {};
  for (const [start, end] of merged) {
    const key = dayKey(end);
    hours[key] = (hours[key] ?? 0) + (end - start) / 3_600_000;
  }
  for (const key of Object.keys(hours)) hours[key] = round(hours[key], 2);
  return hours;
}

/** The minutes between two times. */
export const minutesBetween = (start: Date | number, end: Date | number) => round(Math.max(0, ms(end) - ms(start)) / 60_000, 1);

