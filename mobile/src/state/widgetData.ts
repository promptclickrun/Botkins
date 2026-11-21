// What the Home Screen and Lock Screen widgets show (targets/widgets), as plain data. The app writes
// it to its App Group (`widgets.json`, docs/live-cards.md section 8) and asks iOS to draw the
// widgets again; nothing in it leaves the phone. Each paired computer keeps its own part, so a widget
// for a Botkin on another computer still shows it. No React Native imports: tests/widgets.test.ts runs it.
import type { Bot, ChatSummary, ModelInfo, PanelBlock, PanelView, ProviderUsage, RunSummary, SpaceSummary } from "@/link/types";
import { activityLabel, type AvatarState, botActivity, chatActivity } from "./sessionActivity";
import type { QuietLive } from "./store";

/** A Botkin as a widget draws it. `state` is the avatar's state (sessionActivity.ts); `label` its words, else the role. */
export type WidgetBot = {
  id: string;
  name: string;
  role: string;
  head: string;
  palette: string;
  eyes: string;
  provider?: string;
  state: AvatarState;
  label: string;
  pinned?: true;
  /** The chat at work or waiting for the person, newest first. */
  chat?: { id: string; title: string; startedAt?: number };
  /** What the Botkin asks the person, when it does. */
  ask?: string;
};
/** One of a Botkin's newest chats. Times are Unix seconds. */
export type WidgetChat = { id: string; title: string; provider?: string; state: "working" | "needs-you" | "done" | "failed" | "idle"; label: string; startedAt?: number; finishedAt?: number };
/**
 * A panel of a space as a widget draws it ("spaces-v1"): its title, the one thing it says (a number
 * and a short line under it), its space and its bot's Botkin. `at` is when it last changed, in Unix
 * seconds. A tap opens the panel in its space.
 */
export type WidgetPanel = { id: string; spaceId: string; space: string; title: string; value?: string; note?: string; head: string; palette: string; eyes: string; at: number };
export type WidgetComputer = {
  name: string;
  /** When this part was written, in Unix seconds. */
  at: number;
  bots: WidgetBot[];
  chats: Record<string, WidgetChat[]>;
  /** The computer's last answer about plans and limits ("provider-usage-v1"), as the computer sent it. */
  usage?: ProviderUsage[];
  usageAt?: number;
  /** A model's name by its id, so a card or a widget can name a chat's model. */
  models: Record<string, string>;
  /** The panels of the person's spaces, pinned spaces first. A space the phone has not read since it started keeps the panels it had. */
  panels?: WidgetPanel[];
};
export type WidgetSnapshot = { v: 1; at: number; inUse?: string; computers: Record<string, WidgetComputer> };

const secs = (ms: number) => Math.floor(ms / 1000);
const WORKING = new Set<AvatarState>(["thinking", "planning", "browsing", "coding", "working", "talking", "listening", "retrying"]);

type Looked = Pick<Bot, "id" | "name" | "role" | "model" | "pinned" | "hidden" | "look">;
type Input = {
  name: string;
  bots: Looked[];
  chats: ChatSummary[];
  runs: RunSummary[];
  live: QuietLive | undefined;
  /** The computer's default model, for a chat and a Botkin without one of their own. */
  defaultProvider?: string;
  models: ModelInfo[] | undefined;
  usage?: { items?: ProviderUsage[]; fetchedAt?: number };
  look: (bot: Looked) => { head: string; palette: string; eyes?: string };
  now: number;
  /** The panels a widget can show (`panelParts`). */
  panels?: WidgetPanel[];
};

// ── A panel as a widget shows it ────────────────────────────────────────────────────────────────

export const PANEL_WIDGET = { panels: 24, title: 60, value: 24, note: 90 };
const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);
/** One line of a bot's text with no Markdown marks. */
const plain = (text: unknown) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") ?? "";
/** A number as a person reads it: "1,284", "62.5". */
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? (Math.round(value * 100) / 100).toLocaleString("en-US") : "");

/** What one block says in a number and a line, or nothing. */
function said(block: PanelBlock): { value?: string; note?: string } | undefined {
  switch (block.type) {
    case "metric":
      return { value: plain(block.value), note: plain(block.note ?? block.label) };
    case "progress":
      return { value: number(block.value) + " of " + number(block.max), note: plain(block.note ?? block.label) };
    case "bars": {
      const top = [...block.items].sort((a, b) => b.value - a.value)[0];
      return top ? { value: number(top.value), note: plain(top.label) } : undefined;
    }
    case "line": {
      const last = block.series[0]?.values.at(-1);
      return last === undefined ? undefined : { value: number(last), note: plain(block.label) };
    }
    case "list":
      return block.items.length ? { note: plain(block.items[0]) } : undefined;
    case "table":
      return block.rows.length ? { note: block.rows[0].map(plain).filter(Boolean).join(" · ") } : undefined;
    case "badges":
      return block.items.length ? { note: block.items.map((item) => plain(item.label)).filter(Boolean).join(" · ") } : undefined;
    case "markdown":
      return plain(block.text) ? { note: plain(block.text) } : undefined;
    default:
      return undefined;
  }
}

/**
 * The one thing a panel says, for a widget: its first number (a metric, else a progress), else what
 * its first block says. An app panel says what a person last did in it ("Maya ticked Press kit").
 * Nothing is made up: a panel that says nothing shows its title alone.
 */
export function panelHeadline(panel: Pick<PanelView, "blocks" | "last">): { value?: string; note?: string } {
  const blocks = Array.isArray(panel.blocks) ? panel.blocks : [];
  const first = blocks.find((block) => block.type === "metric") ?? blocks.find((block) => block.type === "progress");
  let found = first ? said(first) : undefined;
  for (const block of blocks) {
    if (found) break;
    found = said(block);
  }
  if (!found && panel.last) {
    const label = panel.last.label?.trim();
    const name = panel.last.name.trim().split(/\s+/)[0] || panel.last.name;
    found = { note: name + " " + (label ? label[0]!.toLowerCase() + label.slice(1) : "changed this") };
  }
  const value = found?.value ? cut(found.value, PANEL_WIDGET.value) : "";
  const note = found?.note ? cut(found.note, PANEL_WIDGET.note) : "";
  return { ...(value && { value }), ...(note && { note }) };
}

/**
 * The panels a widget can show: those of the person's spaces, pinned spaces first, in the person's
 * order. `contents` is each space's panels as the phone read them since it started, by space id; a
 * space it has not read keeps the panels the widgets had (`previous`), and a space that is gone
 * takes its panels with it. Hidden panels are left out.
 */
export function panelParts(
  spaces: Pick<SpaceSummary, "id" | "name" | "builtin" | "mine" | "by" | "pinned">[],
  contents: Record<string, Pick<PanelView, "id" | "title" | "blocks" | "last" | "hidden" | "botId" | "updatedAt">[] | undefined>,
  bots: Looked[],
  look: Input["look"],
  title: (space: Pick<SpaceSummary, "name" | "builtin" | "mine" | "by">) => string,
  previous: WidgetPanel[] = [],
): WidgetPanel[] {
  const out: WidgetPanel[] = [];
  for (const space of [...spaces.filter((one) => one.pinned), ...spaces.filter((one) => !one.pinned)]) {
    const read = contents[space.id];
    const name = cut(title(space), PANEL_WIDGET.title);
    const panels = read
      ? read
          .filter((panel) => !panel.hidden)
          .map((panel): WidgetPanel => {
            const bot = bots.find((one) => one.id === panel.botId);
            const face = bot ? look(bot) : { head: "beacon", palette: "original" };
            return { id: panel.id, spaceId: space.id, space: name, title: cut(panel.title, PANEL_WIDGET.title), ...panelHeadline(panel), head: face.head, palette: face.palette, eyes: face.eyes ?? "oval", at: secs(panel.updatedAt) };
          })
      : previous.filter((panel) => panel.spaceId === space.id).map((panel) => ({ ...panel, space: name }));
    out.push(...panels);
  }
  return out.slice(0, PANEL_WIDGET.panels);
}

/** The newest run of each chat a person started (not a routine's or a panel's). */
function latestRuns(runs: RunSummary[]) {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    if (run.scheduleId != null || run.trigger === "scheduled" || run.panelId) continue;
    const before = latest.get(run.chatId);
    if (!before || run.time > before.time) latest.set(run.chatId, run);
  }
  return latest;
}

/** One computer's part of the snapshot. */
export function computerPart({ name, bots, chats, runs, live, defaultProvider, models, usage, look, now, panels }: Input): WidgetComputer {
  const latest = latestRuns(runs);
  const own = (botId: string) => chats.filter((chat) => chat.botId === botId && !chat.botIds && !chat.panelId && !chat.archived && !chat.schedules?.some((schedule) => schedule.routine)).sort((a, b) => b.time - a.time);
  const chatParts: Record<string, WidgetChat[]> = {};
  const shown = bots.filter((bot) => !bot.hidden);
  // Pinned first, then the computer's own order (shared with the desktop app).
  const ordered = [...shown.filter((bot) => bot.pinned), ...shown.filter((bot) => !bot.pinned)];
  const out: WidgetBot[] = ordered.map((bot) => {
    const state = botActivity(live, chats, bot.id);
    const mine = own(bot.id);
    chatParts[bot.id] = mine.slice(0, 3).map((chat) => {
      const run = latest.get(chat.id);
      const activity = chatActivity(live, chat.id);
      const asked = activity === "waiting";
      const working = !asked && (WORKING.has(activity) || (!!live?.active.includes(chat.id) && run?.status === "Working"));
      const chatState: WidgetChat["state"] = asked ? "needs-you" : working ? "working" : run && run.status !== "Working" ? (run.status === "Completed" ? "done" : "failed") : "idle";
      const provider = chat.model?.provider ?? bot.model?.provider ?? defaultProvider;
      return {
        id: chat.id,
        title: chat.title || "New chat",
        ...(provider && { provider }),
        state: chatState,
        label: asked ? "Needs you" : working ? activityLabel(activity) || "Working…" : chatState === "done" ? "Done" : chatState === "failed" ? "Stopped" : "",
        ...(run && { startedAt: secs(run.time) }),
        ...(run?.finished && run.status !== "Working" && { finishedAt: secs(run.finished) }),
      };
    });
    const request = live?.requests.find((item) => item.botId === bot.id);
    const busy = request ? chats.find((chat) => chat.id === request.chatId) : mine.find((chat) => live?.active.includes(chat.id));
    const busyRun = busy ? latest.get(busy.id) : undefined;
    const lookNow = look(bot);
    const provider = bot.model?.provider ?? defaultProvider;
    return {
      id: bot.id,
      name: bot.name,
      role: bot.role,
      head: lookNow.head,
      palette: lookNow.palette,
      eyes: lookNow.eyes ?? "oval",
      ...(provider && { provider }),
      state,
      label: activityLabel(state) || bot.role,
      ...(bot.pinned && { pinned: true as const }),
      ...(busy && (request || state !== "idle") && { chat: { id: busy.id, title: busy.title || "New chat", ...(busyRun?.status === "Working" && { startedAt: secs(busyRun.time) }) } }),
      ...(request && { ask: request.title }),
    };
  });
  const names: Record<string, string> = {};
  for (const model of models ?? []) if (!names[model.id]) names[model.id] = model.name;
  return {
    name,
    at: secs(now),
    bots: out,
    chats: chatParts,
    ...(usage?.items && { usage: usage.items, ...(usage.fetchedAt && { usageAt: secs(usage.fetchedAt) }) }),
    models: names,
    ...(panels?.length && { panels }),
  };
}

/**
 * The snapshot with one computer's part brought up to date. Parts of computers no longer paired
 * are dropped; a computer's last usage and model names are kept when this look has none.
 */
export function withComputer(previous: WidgetSnapshot | undefined, serverId: string, part: WidgetComputer, paired: string[], now: number): WidgetSnapshot {
  const computers: Record<string, WidgetComputer> = {};
  for (const id of paired) if (previous?.computers[id] && id !== serverId) computers[id] = previous.computers[id];
  const before = previous?.computers[serverId];
  computers[serverId] = {
    ...part,
    ...(!part.usage && before?.usage && { usage: before.usage, ...(before.usageAt && { usageAt: before.usageAt }) }),
    models: Object.keys(part.models).length ? part.models : (before?.models ?? {}),
  };
  return { v: 1, at: secs(now), inUse: serverId, computers };
}

/** Whether two snapshots show the same thing (the time they were written aside). */
export const sameSnapshot = (a: WidgetSnapshot | undefined, b: WidgetSnapshot) => !!a && JSON.stringify({ ...a, at: 0, computers: Object.fromEntries(Object.entries(a.computers).map(([id, c]) => [id, { ...c, at: 0 }])) }) === JSON.stringify({ ...b, at: 0, computers: Object.fromEntries(Object.entries(b.computers).map(([id, c]) => [id, { ...c, at: 0 }])) });
