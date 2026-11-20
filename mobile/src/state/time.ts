// Times as a person reads them.
import type { Cadence } from "@/link/types";

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);
const daysApart = (a: number, b: number) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** How long ago, as short as a list row needs: "now", "5m", "2h", "Yesterday", "Mon", "Nov 3". */
export function ago(time: number | undefined, now = Date.now()): string {
  if (!time) return "";
  const diff = now - time;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m";
  const days = daysApart(now, time);
  if (days === 0) return Math.floor(diff / 3_600_000) + "h";
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(time);
  return monthDay.format(time);
}

export function dayBucket(time: number, now = Date.now()): "Today" | "Yesterday" | "Earlier" {
  const days = daysApart(now, time);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : "Earlier";
}

/** When something will happen: "Today 8:30 AM", "Tomorrow 8:30 AM", "Fri 4:00 PM", "Nov 28, 9:00 AM". */
export function upcoming(time: number | null | undefined, now = Date.now()): string {
  if (!time) return "";
  const days = daysApart(time, now);
  const at = clock.format(time);
  if (days === 0) return "Today " + at;
  if (days === 1) return "Tomorrow " + at;
  if (days > 1 && days < 7) return weekday.format(time) + " " + at;
  return monthDay.format(time) + ", " + at;
}

export const clockTime = (time: number) => clock.format(time);

/** "09:00" → "9:00 AM", in the phone's own clock style. */
export function clockLabel(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  return clock.format(new Date(2000, 0, 1, +match[1], +match[2]));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A routine's schedule in a few words: "Weekdays at 9:00 AM". */
export function cadenceLabel(cadence: Cadence | undefined): string {
  switch (cadence?.kind) {
    case "once":
      return "Once, " + monthDay.format(new Date(cadence.date + "T12:00:00")) + " at " + clockLabel(cadence.time);
    case "daily":
      return "Daily at " + clockLabel(cadence.time);
    case "weekdays":
      return "Weekdays at " + clockLabel(cadence.time);
    case "weekly":
      return (cadence.days.length === 7 ? "Every day" : cadence.days.map((day) => DAYS[day]).join(", ")) + " at " + clockLabel(cadence.time);
    case "custom":
      return "Custom schedule";
    default:
      return "Scheduled";
  }
}

/** A duration such as "18s" or "2m 5s". */
export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1) + "M";
  if (value >= 1000) return (value / 1000).toFixed(value >= 10_000 ? 0 : 1) + "K";
  return String(Math.round(value));
}
