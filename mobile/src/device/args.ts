// Checking a tool's arguments, and the dates in them. No React Native imports.
//
// A bad argument throws a DeviceError with one plain sentence; run.ts turns it into the answer.

/** A failure a bot can read: one plain sentence. */
export class DeviceError extends Error {}

export type Args = Record<string, unknown>;

/** The arguments as an object, refusing names the tool doesn't take. */
export function checkArgs(args: unknown, allowed: readonly string[]): Args {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new DeviceError("The arguments must be an object.");
  const given = args as Args;
  const unknown = Object.keys(given).filter((key) => !allowed.includes(key) && given[key] !== undefined);
  if (unknown.length) throw new DeviceError("Unknown argument" + (unknown.length > 1 ? "s" : "") + ": " + unknown.slice(0, 5).join(", ") + ".");
  return given;
}

export function optString(args: Args, key: string, max = 10_000): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DeviceError("`" + key + "` must be text.");
  if (value.length > max) throw new DeviceError("`" + key + "` is too long (at most " + max + " characters).");
  return value;
}

export function reqString(args: Args, key: string, max = 10_000): string {
  const value = optString(args, key, max);
  if (value === undefined || !value.trim()) throw new DeviceError("`" + key + "` is needed.");
  return value;
}

export function optBool(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new DeviceError("`" + key + "` must be true or false.");
  return value;
}

export function optNumber(args: Args, key: string, range: { min?: number; max?: number } = {}): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DeviceError("`" + key + "` must be a number.");
  if (range.min !== undefined && value < range.min) throw new DeviceError("`" + key + "` must be at least " + range.min + ".");
  if (range.max !== undefined && value > range.max) throw new DeviceError("`" + key + "` must be at most " + range.max + ".");
  return value;
}

/** A count such as `limit`: a whole number from 1, cut to `max`, `fallback` when not given. */
export function limitOf(args: Args, fallback: number, max: number, key = "limit"): number {
  const value = optNumber(args, key, { min: 1 });
  if (value === undefined) return fallback;
  return Math.min(max, Math.floor(value));
}

export function optStringList(args: Args, key: string, maxItems = 50, maxLength = 320): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new DeviceError("`" + key + "` must be a list of text.");
  if (value.length > maxItems) throw new DeviceError("`" + key + "` has too many entries (at most " + maxItems + ").");
  const list = (value as string[]).map((item) => item.trim()).filter(Boolean);
  if (list.some((item) => item.length > maxLength)) throw new DeviceError("An entry in `" + key + "` is too long.");
  return list;
}

export function optList<T>(args: Args, key: string, item: (entry: Args, index: number) => T, maxItems = 20): T[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new DeviceError("`" + key + "` must be a list.");
  if (value.length > maxItems) throw new DeviceError("`" + key + "` has too many entries (at most " + maxItems + ").");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new DeviceError("Each entry in `" + key + "` must be an object.");
    return item(entry as Args, index);
  });
}

// ---- Dates

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/i;

export type When = { date: Date; dateOnly: boolean };

/**
 * An ISO 8601 date or date and time. A date alone is the start of that day in the phone's time
 * zone; a time without an offset is the phone's local time.
 */
export function parseWhen(text: string): When | null {
  const value = text.trim();
  const day = DATE_ONLY.exec(value);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const local = new Date(year, month - 1, date);
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== date) return null;
    return { date: local, dateOnly: true };
  }
  if (!DATE_TIME.test(value)) return null;
  // "+0600" and "+06" are ISO too, but JavaScript only reads "+06:00".
  const normal = value.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normal);
  return Number.isNaN(date.getTime()) ? null : { date, dateOnly: false };
}

export function optWhen(args: Args, key: string): When | undefined {
  const text = optString(args, key, 64);
  if (text === undefined || !text.trim()) return undefined;
  const when = parseWhen(text);
  if (!when) throw new DeviceError("`" + key + "` must be an ISO 8601 date, such as 2026-11-19 or 2026-11-19T09:00:00-06:00.");
  return when;
}

export function reqWhen(args: Args, key: string): When {
  const when = optWhen(args, key);
  if (!when) throw new DeviceError("`" + key + "` is needed.");
  return when;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of the day `date` falls on, in the phone's time zone. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The day after, at midnight, in the phone's time zone (a day with a clock change is still one day). */
export function nextDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

/**
 * A span from two dates. A `to` that is a date alone and isn't after `from` means the end of that
 * day, so "from 2026-11-19 to 2026-11-19" is that whole day.
 */
export function spanOf(from: When, to: When, maxDays = 400): { start: Date; end: Date } {
  let end = to.date;
  if (to.dateOnly && end.getTime() <= from.date.getTime()) end = nextDay(end);
  if (end.getTime() < from.date.getTime()) throw new DeviceError("`to` is before `from`.");
  if (end.getTime() - from.date.getTime() > maxDays * DAY_MS) throw new DeviceError("That span is too long (at most " + maxDays + " days).");
  return { start: from.date, end };
}

const pad = (value: number, size = 2) => String(Math.abs(Math.trunc(value))).padStart(size, "0");

/** ISO 8601 with the phone's offset: 2026-11-19T09:00:00-06:00. */
export function isoLocal(when: Date | string | number): string {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) return "";
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds()) +
    sign + pad(Math.floor(Math.abs(offset) / 60)) + ":" + pad(Math.abs(offset) % 60)
  );
}

/** The day `date` falls on, in the phone's time zone: 2026-11-19. */
export function dayKey(when: Date | number): string {
  const date = when instanceof Date ? when : new Date(when);
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}
