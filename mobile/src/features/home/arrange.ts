// The bot list in the computer's order: the primary bot, pinned bots, each section, then the rest.
// Hidden bots are left out, and shown only by the "Hidden" filter. No React Native imports, so
// tests/bots-chats.test.ts runs it.
import type { Bot, Section } from "@/link/types";

export type BotFilter = "All" | "Pinned" | "Hidden";

export function arrangeBots<B extends Pick<Bot, "id" | "hidden" | "pinned" | "sectionId">>(bots: B[], sections: Section[] | undefined) {
  const [primary, ...others] = bots;
  const visible = others.filter((bot) => !bot.hidden);
  const pinned = visible.filter((bot) => bot.pinned);
  const groups = (sections ?? []).map((section) => ({ section, bots: visible.filter((bot) => !bot.pinned && bot.sectionId === section.id) }));
  const known = new Set(groups.map((group) => group.section.id));
  const rest = visible.filter((bot) => !bot.pinned && !(bot.sectionId && known.has(bot.sectionId)));
  return { primary: primary as B | undefined, pinned, sections: groups, rest, hidden: others.filter((bot) => bot.hidden) };
}

/** The bots a filter shows, in order. "All" leaves hidden bots out. */
export function filterBots<B extends Pick<Bot, "hidden" | "pinned">>(bots: B[], filter: BotFilter) {
  return bots.filter((bot) => (filter === "Hidden" ? bot.hidden : filter === "Pinned" ? bot.pinned && !bot.hidden : !bot.hidden));
}

/** The filter chips' words: "Pinned · 2", "Hidden · 1". */
export function filterLabels(bots: Pick<Bot, "hidden" | "pinned">[]): { value: BotFilter; label: string }[] {
  const hidden = bots.filter((bot) => bot.hidden).length;
  const pinned = bots.filter((bot) => bot.pinned && !bot.hidden).length;
  return [
    { value: "All", label: "All" },
    { value: "Pinned", label: pinned ? "Pinned · " + pinned : "Pinned" },
    { value: "Hidden", label: "Hidden · " + hidden },
  ];
}

/** The section a bot is in, or undefined when it is in none (or in one that is gone). */
export const sectionOf = (bot: Pick<Bot, "sectionId">, sections: Section[] | undefined) => (bot.sectionId ? sections?.find((section) => section.id === bot.sectionId) : undefined);
