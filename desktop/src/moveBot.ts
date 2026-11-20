export type BotPlace = { pinned: boolean; sectionId: string | null };
type Row = { id: string; pinned?: boolean; hidden?: boolean; sectionId?: string | null };

/** Plan a drop using the complete order so filtered and hidden bots keep their places. */
export function moveBot(bots: Row[], id: string, targetPlace: BotPlace, target?: string, after = false) {
  const bot = bots.find(item => item.id === id);
  if (!bot || bot === bots[0] || bot.hidden || target === id) return null;
  const flags = { ...targetPlace };
  // Pinning keeps the previous section so the context menu's Unpin returns the bot there.
  if (flags.pinned) flags.sectionId = bot.sectionId ?? null;
  const neighbors = bots.filter(item => item !== bots[0] && item !== bot && !item.hidden &&
    (flags.pinned ? item.pinned : !item.pinned && (item.sectionId ?? null) === flags.sectionId));
  const at = target ? neighbors.findIndex(item => item.id === target) : neighbors.length;
  if (at < 0) return null;
  const slot = at + Number(!!target && after);
  const before = neighbors[slot - 1], next = neighbors[slot];
  const index = bots.indexOf(bot);
  const ids = bots.map(item => item.id);
  if ((before && bots.indexOf(before) > index) || (next && bots.indexOf(next) < index)) {
    ids.splice(index, 1);
    ids.splice(next ? ids.indexOf(next.id) : ids.indexOf(before.id) + 1, 0, id);
  }
  return { flags, ids };
}
