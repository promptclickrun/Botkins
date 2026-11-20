// Schedules as cron and as words, the way the computer's Routines page reads them (its
// src/Routines.tsx: cadenceFromCron, cronFromCadence, scheduleSummary). No React Native imports,
// so tests/schedules.test.ts runs it.
import type { Cadence, ChatSchedule } from "@/link/types";
import { cadenceLabel } from "../../state/time";

/** Reads a cron string back into a cadence when it is one of the simple shapes; otherwise "custom". */
export function cadenceFromCron(cron: string): Cadence {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(cron.trim().replace(/\s+/g, " "));
  if (!match || +match[1]! > 59 || +match[2]! > 23) return { kind: "custom", cron };
  const time = match[2]!.padStart(2, "0") + ":" + match[1]!.padStart(2, "0");
  if (match[3] === "*") return { kind: "daily", time };
  if (match[3] === "1-5") return { kind: "weekdays", time };
  return { kind: "weekly", time, days: [...new Set(match[3]!.split(",").map(Number))].sort((a, b) => a - b) };
}

/** A panel's routine is kept as cron; this is the computer's own compile. A panel routine can't run once. */
export function cronFromCadence(cadence: Cadence): string {
  if (cadence.kind === "custom") return cadence.cron.trim().replace(/\s+/g, " ");
  if (cadence.kind === "once") throw new Error("Panel routines repeat. Choose Daily, Weekdays, Weekly or Custom.");
  const [h, m] = cadence.time.split(":").map(Number);
  return m + " " + h + " * * " + (cadence.kind === "weekly" ? [...cadence.days].sort((a, b) => a - b).join(",") : cadence.kind === "daily" ? "*" : "1-5");
}

/** A panel routine's schedule in words: "Weekdays at 9:00 AM", or "Custom · 15 6 1 * *". */
export function cronLabel(cron: string): string {
  const cadence = cadenceFromCron(cron);
  return cadence.kind === "custom" ? "Custom · " + cron.trim() : cadenceLabel(cadence);
}

/** "Every 2 hours", "Every minute". */
export function everyLabel(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1000, "second"],
  ];
  const [size, name] = units.find(([unit]) => ms % unit === 0 && ms >= unit) ?? [1000, "second"];
  const count = Math.round(ms / size);
  return "Every " + (count === 1 ? name : count + " " + name + "s");
}

/** Any chat schedule in words: a routine by its cadence, an /every by its interval or cron, an /after as "Once". */
export function scheduleLabel(schedule: Pick<ChatSchedule, "cadence" | "cron" | "recurring" | "intervalMs">): string {
  if (schedule.cadence) return cadenceLabel(schedule.cadence);
  const cadence = schedule.cron ? cadenceFromCron(schedule.cron) : undefined;
  if (cadence && cadence.kind !== "custom") return cadenceLabel(cadence);
  if (schedule.cron) return "Cron · " + schedule.cron;
  if (schedule.recurring && schedule.intervalMs) return everyLabel(schedule.intervalMs);
  return "Once";
}
