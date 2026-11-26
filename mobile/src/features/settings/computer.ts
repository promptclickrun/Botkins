// Plain logic for the settings that belong to the app on the computer: its side menu, its fonts and
// text sizes, quiet hours, who can use which project, storage and usage figures. No React Native
// imports, so tests/settings.test.ts runs it. The words and lists are the desktop app's own
// (desktop app: src/places.ts, src/themes.ts, desktop/themes.json, src/access.ts, src/Usage.tsx).
import type { Appearance, Bot, Preferences, Project, UsageReport, UsageTotals } from "@/link/types";

// ---- The side menu (desktop src/places.ts) ----

// Projects is a tab of Work now, on the computer and on the phone, so it is not a place of its own.
export const PLACES = ["Home", "Today", "Chats", "Work", "Wiki", "Market"] as const;
export type Place = (typeof PLACES)[number];

/** The person's order made whole: every place once. Unknown names are dropped; missing places keep their usual position at the end. */
export function placeOrder(order?: string[]): Place[] {
  const named = [...new Set((order ?? []).filter((place): place is Place => (PLACES as readonly string[]).includes(place)))];
  return [...named, ...PLACES.filter((place) => !named.includes(place))];
}

/** The order with one place moved up (-1) or down (1). Unchanged at either end. */
export function movePlace(order: Place[], place: Place, by: -1 | 1): Place[] {
  const from = order.indexOf(place);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, place);
  return next;
}

export const isUsualOrder = (order: Place[]) => order.join() === PLACES.join();

// ---- Fonts and text sizes on the computer (desktop desktop/themes.json, src/themes.ts) ----

/** The fonts the computer's app offers, in its menu order. `windowsName` is shown on Windows; a face Windows lacks has `windows: false`. */
const DESKTOP_FONTS: { id: string; name: string; windowsName?: string; windows: boolean }[] = [
  { id: "system", name: "San Francisco", windowsName: "Segoe UI", windows: true },
  { id: "botkins", name: "Botkins", windows: true },
  { id: "rounded", name: "SF Rounded", windows: false },
  { id: "avenir", name: "Avenir Next", windows: false },
  { id: "georgia", name: "Georgia", windows: true },
  { id: "lora", name: "Lora", windows: true },
  { id: "mono", name: "SF Mono", windowsName: "Cascadia Mono", windows: true },
];
export const DESKTOP_DEFAULT_FONT = "system";

const onWindows = (platform: string | undefined) => platform === "win32" || /windows/i.test(platform ?? "");

/** The fonts the computer can show, with the names its own menu uses. */
export function desktopFonts(platform: string | undefined): { id: string; name: string }[] {
  const windows = onWindows(platform);
  return DESKTOP_FONTS.filter((font) => !windows || font.windows).map((font) => ({ id: font.id, name: (windows && font.windowsName) || font.name }));
}

/** The font the computer draws for a choice: the choice, or its system face when it lacks that one. */
export function desktopFontShown(id: string | undefined, platform: string | undefined): string {
  return desktopFonts(platform).some((font) => font.id === id) ? id! : DESKTOP_DEFAULT_FONT;
}

export const DESKTOP_TEXT_SIZES: { value: NonNullable<Appearance["textSize"]>; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

export const isHexColor = (value: string | undefined): value is string => /^#[0-9a-f]{6}$/i.test(value ?? "");

// ---- Quiet hours ("HH:MM", the computer's own clock) ----

/** "22:00" as today's date at that time, for a time picker. A broken value reads as midnight. */
export function clockToDate(clock: string, today = new Date()): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  const date = new Date(today);
  date.setHours(match ? Math.min(23, Number(match[1])) : 0, match ? Math.min(59, Number(match[2])) : 0, 0, 0);
  return date;
}

/** A picked time as the computer saves it: "07:05". */
export const dateToClock = (date: Date) => String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");

// ---- Access (desktop src/access.ts) ----

/** Every bot can use every project unless the computer says otherwise. */
export const everyBotAllowed = (settings: Pick<Preferences, "access"> | undefined) => settings?.access?.allBots !== false;

/** A short summary of a bot's grant, in the desktop's words. */
export function grantSummary(allBots: boolean, bot: Pick<Bot, "access">, projects: Pick<Project, "id">[]): string {
  if (allBots) return "Every project";
  if (bot.access?.all === true) return "All projects";
  const count = (bot.access?.projects ?? []).filter((id) => projects.some((project) => project.id === id)).length;
  return count ? count + (count === 1 ? " project" : " projects") : "No projects";
}

// ---- About and storage ----

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
export const platformName = (platform: string) => PLATFORMS[platform] ?? platform;

/** A size in megabytes with one decimal, as the desktop shows the browser cache. */
export const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + " MB";

// ---- Usage (desktop src/Usage.tsx) ----

/** 1234 → "1.2K", as the desktop writes token counts. */
export function tokens(count: number): string {
  if (count >= 1e6) return (count / 1e6).toFixed(count >= 1e7 ? 0 : 1) + "M";
  if (count >= 1e3) return (count / 1e3).toFixed(count >= 1e4 ? 0 : 1) + "K";
  return String(Math.round(count));
}

/** A cache hit rate as a whole percent ("<1%" under one), or "" when the computer didn't count one. */
export const cachePercent = (rate: number | null | undefined) => (typeof rate !== "number" ? "" : rate > 0 && rate < 0.01 ? "<1%" : Math.round(rate * 100) + "%");

/** One line for a model's or a bot's share: "12 turns · 1.2M in · 80K out · 64% cached". */
export const shareLine = (totals: UsageTotals) =>
  totals.turns + (totals.turns === 1 ? " turn" : " turns") + " · " + tokens(totals.input) + " in · " + tokens(totals.output) + " out" + (cachePercent(totals.cacheHitRate) ? " · " + cachePercent(totals.cacheHitRate) + " cached" : "");

const DAY = 86_400_000;
const keyOf = (time: number) => new Date(time).toISOString().slice(0, 10);
const timeOf = (key: string) => Date.parse(key + "T00:00:00Z");

export type UsageDay = { time: number; turns: number; input: number; output: number };

/** Every day of the range, oldest first, ending today (`today` is a UTC midnight); a day without turns counts as zero. */
export function usageDays(report: UsageReport, days: number, today: number): UsageDay[] {
  const byDate = new Map(report.byDay.map((day) => [day.date, day]));
  const latest = report.byDay.reduce((max, day) => Math.max(max, timeOf(day.date) || 0), 0);
  const end = Math.max(today, latest);
  return Array.from({ length: days }, (_, index) => {
    const time = end - (days - 1 - index) * DAY;
    const day = byDate.get(keyOf(time));
    return { time, turns: day?.turns ?? 0, input: day?.input ?? 0, output: day?.output ?? 0 };
  });
}
