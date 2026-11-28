// The first tab's row of bots, as numbers: every bot has a slot of one narrow width, the row
// scrolls sideways and snaps slot by slot, and the bot whose slot is in the middle is the one on
// show, drawn large. The small faces stand close together; the ones beside the large face are
// pushed out of its way, so the row shows as many bots as it can. The functions are worklets:
// BotHome.tsx runs them on the UI thread as the row scrolls. No React Native imports, so
// tests/home-bot.test.ts runs them too.

export const STRIP = {
  /** One bot's slot: a small face and the space to the next. The row snaps by this much. */
  slot: 48,
  /** How far the bots on either side of the large face stand aside for it. */
  push: 25,
  /** The bot on show, and the others beside it: well over twice the size, so there is no doubt which bot the chat is with. */
  face: 88,
  small: 34,
  /** How far the name's pill sits up over the foot of the large face. */
  tuck: 12,
  /** How much of the others shows through: beside the bot on show, and three or more away. */
  dim: 0.5,
  far: 0.25,
  /** The round buttons at the row's ends: All bots at the start, the chat's menu at the end, with the chat's context ring as its edge. */
  button: 48,
  /** With the name tag off (Settings › Appearance): how long it stays once a bot is on show, and how long it takes to go. */
  tagStaysMs: 2500,
  tagFadeMs: 350,
  /** The room each end of the row keeps for its button. */
  side: 56,
  /** Dots under the name say where the bot is in the row, up to this many bots. */
  dots: 12,
} as const;

/** The scroll offset that puts the bot at `index` in the middle of the row. */
export const offsetOf = (index: number) => {
  "worklet";
  return Math.max(0, index) * STRIP.slot;
};

/** The bot in the middle of the row at a scroll offset. */
export const indexAt = (offset: number, count: number) => {
  "worklet";
  return count <= 0 ? 0 : Math.max(0, Math.min(count - 1, Math.round(offset / STRIP.slot)));
};

/**
 * The room at each end of the row's content, so that the first and the last bot can reach the
 * middle too. With it, `offsetOf` is right whatever the row's width.
 */
export const edgeRoom = (width: number) => {
  "worklet";
  return Math.max(0, (width - STRIP.slot) / 2);
};

/** How many slots a bot is from the middle of the row at a scroll offset: 0 for the bot on show, negative before it. */
export const slotsAway = (index: number, offset: number) => {
  "worklet";
  return (index * STRIP.slot - offset) / STRIP.slot;
};

/** How far a bot stands aside for the large face: nothing in the middle, all of `push` from one slot away on. */
export const pushOf = (away: number) => {
  "worklet";
  return Math.max(-1, Math.min(1, away)) * STRIP.push;
};

/** Where a bot's middle is in the row's own frame, at a scroll offset. */
export const middleOf = (index: number, offset: number, width: number) => {
  "worklet";
  return edgeRoom(width) + index * STRIP.slot + STRIP.slot / 2 - offset + pushOf(slotsAway(index, offset));
};

/** How large a face is drawn, as a share of the large one: 1 in the middle, the small size from one slot away on. */
export const faceScale = (away: number) => {
  "worklet";
  const near = 1 - Math.min(1, Math.abs(away));
  return STRIP.small / STRIP.face + (1 - STRIP.small / STRIP.face) * near;
};

/** How much of a face shows: whole in the middle, dimmed beside it, and fainter the further off, so a bot at the row's end reads as "there are more". */
export const faceShown = (away: number) => {
  "worklet";
  const off = Math.abs(away);
  if (off <= 1) return 1 - (1 - STRIP.dim) * off;
  return STRIP.dim - (STRIP.dim - STRIP.far) * Math.min(1, (off - 1) / 2);
};

/** The words of the pill under the bot on show: its name, and what it is for when the computer says. */
export function pillWords(bot: { name: string; role?: string }): { name: string; role: string } {
  return { name: bot.name.trim() || "Your bot", role: (bot.role ?? "").trim() };
}
