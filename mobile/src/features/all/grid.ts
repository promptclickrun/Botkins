// Tiles in groups, a few to a row, that a person puts in order by hand: where each one sits, where
// a dragged one would land, and the list after a drop. A group is a heading and its tiles; a group
// with none keeps one empty place to drop into. Nothing here is measured: every place follows from
// the list's order and the width, so the list a drag shows and the list a drop saves are the same
// list. No React Native imports, so tests/tile-grid.test.ts runs it. The functions the gesture calls
// on the UI thread are marked "worklet" (the mark is a plain string in Node).

/** One item, top to bottom: a heading opens a group, a tile is a place in it, and "empty" stands in a group with no tile. */
export type GridItem =
  | { key: string; kind: "head"; zone: string }
  | { key: string; kind: "empty"; zone: string }
  | { key: string; kind: "tile"; zone: string; /** The groups this tile may be dropped into. */ to: readonly string[] };

/** The grid's sizes, in points. */
export type GridMetrics = { columns: number; gap: number; tile: number; head: number; /** More room above every heading but the first. */ section: number };

/** A group that holds `max` tiles at most. One more, and its last tile (never the one just dropped) moves to the top of `spill`. */
export type GridCap = { zone: string; max: number; spill: string };

/** Each item's key and frame, in the list's order, and the height of the whole grid. */
export type GridLayout = { keys: string[]; xs: number[]; ys: number[]; ws: number[]; hs: number[]; height: number };

export const emptyKey = (zone: string) => "empty:" + zone;

/** The list with every group in order: its heading, its tiles, or one empty place when it has none. */
export function tidy(items: readonly GridItem[]): GridItem[] {
  "worklet";
  const out: GridItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i];
    if (head.kind !== "head") continue;
    out.push(head);
    let count = 0;
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      if (item.kind === "tile" && item.zone === head.zone) {
        out.push(item);
        count++;
      }
    }
    if (count === 0) out.push({ key: emptyKey(head.zone), kind: "empty", zone: head.zone });
  }
  return out;
}

/** Where every item sits in a grid `width` wide. */
export function layoutOf(items: readonly GridItem[], width: number, m: GridMetrics): GridLayout {
  "worklet";
  const keys: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  const hs: number[] = [];
  const tileWidth = Math.max(0, (width - m.gap * (m.columns - 1)) / m.columns);
  let y = 0;
  let column = 0;
  let any = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    keys.push(item.key);
    if (item.kind === "tile") {
      xs.push(column * (tileWidth + m.gap));
      ys.push(y);
      ws.push(tileWidth);
      hs.push(m.tile);
      column++;
      if (column === m.columns) {
        y += m.tile + m.gap;
        column = 0;
      }
    } else {
      // A row with a tile in it is closed before whatever is not a tile.
      if (column > 0) {
        y += m.tile + m.gap;
        column = 0;
      }
      if (item.kind === "head" && any) y += m.section;
      const height = item.kind === "head" ? m.head : m.tile;
      xs.push(0);
      ys.push(y);
      ws.push(width);
      hs.push(height);
      y += height + (item.kind === "head" ? 0 : m.gap);
    }
    any = true;
  }
  if (column > 0) y += m.tile + m.gap;
  return { keys, xs, ys, ws, hs, height: Math.max(0, y - (items.length > 0 && items[items.length - 1].kind !== "head" ? m.gap : 0)) };
}

/** How many tiles a group holds, leaving `skip` out. */
export function countIn(items: readonly GridItem[], zone: string, skip = ""): number {
  "worklet";
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "tile" && item.zone === zone && item.key !== skip) count++;
  }
  return count;
}

/**
 * The list with the tile `key` at place `index` of the group `zone` (among that group's other
 * tiles). A group over its cap hands its last tile to the group it spills into.
 */
export function moved(items: readonly GridItem[], key: string, zone: string, index: number, caps: readonly GridCap[] = []): GridItem[] {
  "worklet";
  let dragged: GridItem | undefined;
  for (let i = 0; i < items.length; i++) if (items[i].key === key && items[i].kind === "tile") dragged = items[i];
  if (!dragged || dragged.kind !== "tile") return tidy(items);
  const zones: string[] = [];
  const tiles: Record<string, GridItem[]> = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "head" && !tiles[item.zone]) {
      zones.push(item.zone);
      tiles[item.zone] = [];
    }
  }
  if (!tiles[zone]) return tidy(items);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "tile" && item.key !== key && tiles[item.zone]) tiles[item.zone].push(item);
  }
  const into = tiles[zone];
  into.splice(Math.max(0, Math.min(index, into.length)), 0, { key: dragged.key, kind: "tile", zone, to: dragged.to });
  for (let c = 0; c < caps.length; c++) {
    const cap = caps[c];
    const full = tiles[cap.zone];
    const spill = tiles[cap.spill];
    if (!full || !spill) continue;
    while (full.length > cap.max) {
      const last = full[full.length - 1].key === key ? full.length - 2 : full.length - 1;
      if (last < 0) break;
      const out = full.splice(last, 1)[0];
      if (out.kind === "tile") spill.unshift({ key: out.key, kind: "tile", zone: cap.spill, to: out.to });
    }
  }
  const out: GridItem[] = [];
  for (let z = 0; z < zones.length; z++) {
    out.push({ key: "head:" + zones[z], kind: "head", zone: zones[z] });
    const list = tiles[zones[z]];
    if (list.length === 0) out.push({ key: emptyKey(zones[z]), kind: "empty", zone: zones[z] });
    for (let i = 0; i < list.length; i++) out.push(list[i]);
  }
  // Headings keep the keys they had.
  for (let i = 0; i < out.length; i++) {
    const item = out[i];
    if (item.kind !== "head") continue;
    for (let j = 0; j < items.length; j++) if (items[j].kind === "head" && items[j].zone === item.zone) out[i] = items[j];
  }
  return out;
}

/** A place a dragged tile can land, with the list and the layout that would follow. */
export type GridPick = { zone: string; index: number; items: GridItem[]; layout: GridLayout };

/**
 * The place nearest the middle of a dragged tile, held at (`x`, `y`) in the grid's own coordinates:
 * every place of every group the tile may go to is tried, and the one whose tile would sit closest
 * wins. Undefined when the tile is not in the list.
 */
export function pickPlace(items: readonly GridItem[], width: number, m: GridMetrics, caps: readonly GridCap[], key: string, x: number, y: number): GridPick | undefined {
  "worklet";
  let dragged: GridItem | undefined;
  for (let i = 0; i < items.length; i++) if (items[i].key === key) dragged = items[i];
  if (!dragged || dragged.kind !== "tile") return undefined;
  let best: GridPick | undefined;
  let bestDistance = Infinity;
  for (let i = 0; i < items.length; i++) {
    const head = items[i];
    if (head.kind !== "head" || dragged.to.indexOf(head.zone) < 0) continue;
    const places = countIn(items, head.zone, key);
    for (let index = 0; index <= places; index++) {
      const next = moved(items, key, head.zone, index, caps);
      const layout = layoutOf(next, width, m);
      const at = layout.keys.indexOf(key);
      if (at < 0) continue;
      const dx = layout.xs[at] + layout.ws[at] / 2 - x;
      const dy = layout.ys[at] + layout.hs[at] / 2 - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { zone: head.zone, index, items: next, layout };
      }
    }
  }
  return best;
}

/** The tile `key` one place earlier (-1) or later (1) in its own group, or null at that end. */
export function stepped(items: readonly GridItem[], key: string, by: -1 | 1, caps: readonly GridCap[] = []): GridItem[] | null {
  const tile = items.find((item) => item.key === key);
  if (!tile || tile.kind !== "tile") return null;
  const group = items.filter((item) => item.kind === "tile" && item.zone === tile.zone);
  const to = group.findIndex((item) => item.key === key) + by;
  return to >= 0 && to < group.length ? moved(items, key, tile.zone, to, caps) : null;
}

/** The keys of a group's tiles, in order. */
export const keysIn = (items: readonly GridItem[], zone: string) => items.filter((item) => item.kind === "tile" && item.zone === zone).map((item) => item.key);
