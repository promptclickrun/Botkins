// The shape of the screen the app lays out on, as plain logic (tested in tests/shape.test.ts).
//
// On iPhone Duo (iOS 27.1) the system moves the status bar, the navigation bar's items and the tab
// bar into one vertical bar on an edge, the side rail, and adds its width to the safe area on that
// edge. Content must stay out of it, and nothing needs room for a tab bar at the bottom any more.
// Opened, the inner display has room for two panes (a list beside what it opens). Partly folded,
// the fold is a band to keep taps and text out of: upright (book) it splits left from right, flat
// on a table (laptop) it splits top from bottom.

export type Insets = { top: number; right: number; bottom: number; left: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type NativeFoldState = { hinge: "unknown" | "closed" | "partial" | "open" | null; angle?: number; edge: "leading" | "trailing" | null; fold: Rect | null };

export type Shape = {
  /** The side the system's vertical bar is on, when there is one. */
  rail: "left" | "right" | null;
  /** Room to leave on each side: the safe area, which holds the rail. */
  left: number;
  right: number;
  /** Room to leave at the bottom for the tab bar: none when the tab bar is in the rail. */
  tabRoom: number;
  /** Room for a list beside what it opens. */
  wide: boolean;
  /** "book": the fold runs top to bottom; "laptop": it runs side to side. "flat": nothing in the way. */
  pose: "flat" | "book" | "laptop";
  /** The fold's band, in window points, while the hinge is partly open. */
  fold: Rect | null;
};

/** The narrowest content that gets a second pane: the opened iPhone Duo (669 points upright) and up. */
export const WIDE_MIN = 640;
/** And the least height: a phone on its side is wide enough but too short for a list beside a chat. */
const TALL_MIN = 500;
/** A side inset this big on one side only is the rail; the notch's inset in landscape is on both. */
const RAIL_MIN = 44;

/**
 * `ios` false (Android, iPad): the inset is not guessed to be a vertical bar. Android's own buttons
 * can sit on one side in landscape, and an iPad window can have a one-sided inset, with the tab bar
 * still at the bottom. The system's own word (`native.edge`) counts everywhere.
 */
export function shapeOf(input: { width: number; height: number; insets: Insets; tabBar: number; native?: NativeFoldState | null; rtl?: boolean; ios?: boolean }): Shape {
  const { width, height, insets, tabBar, native, rtl = false, ios = true } = input;
  const left = Math.max(0, insets.left);
  const right = Math.max(0, insets.right);
  let rail: Shape["rail"] = null;
  if (native?.edge) rail = (native.edge === "leading") !== rtl ? "left" : "right";
  else if (ios && right >= RAIL_MIN && left < RAIL_MIN / 2) rail = "right";
  else if (ios && left >= RAIL_MIN && right < RAIL_MIN / 2) rail = "left";
  const fold = native?.hinge === "partial" && native.fold && native.fold.width >= 0 && native.fold.height >= 0 ? native.fold : null;
  const pose = !fold ? "flat" : fold.height >= fold.width ? "book" : "laptop";
  return { rail, left, right, tabRoom: rail ? 0 : tabBar, wide: width - left - right >= WIDE_MIN && height >= TALL_MIN, pose, fold };
}

/**
 * The list's width beside what it opens: a list column while flat, and the page before the fold in
 * book pose (both panes snap to the fold, then relax again when the phone lies flat).
 */
export function listWidth(shape: Shape, width: number): number {
  const content = width - shape.left - shape.right;
  if (shape.pose === "book" && shape.fold) return Math.max(0, shape.fold.x - shape.left);
  return Math.round(Math.min(380, Math.max(280, content * 0.36)));
}

/** The gap the fold leaves between two panes in book pose; none while flat. */
export function foldGap(shape: Shape): number {
  return shape.pose === "book" && shape.fold ? shape.fold.width : 0;
}
