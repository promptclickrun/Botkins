// The pose of a folding iPhone (iPhone Duo): the hinge, the fold's band and the vertical bar's edge.
// The native half is ios/BotkinsFoldModule.swift; a build without it, Android, or an iPhone before
// iOS 27.1 has `Fold === null` (or reports no hinge), and the layout falls back to the safe area.
import { type EventSubscription, requireOptionalNativeModule } from "expo-modules-core";

export type FoldRect = { x: number; y: number; width: number; height: number };
export type NativeFold = {
  /** null on a phone without a hinge. "partial" is anything between closed and open. */
  hinge: "unknown" | "closed" | "partial" | "open" | null;
  /** Degrees, 0 closed to 180 open. */
  angle?: number;
  /** Which edge holds the vertical bar (the side rail), when there is one. */
  edge: "leading" | "trailing" | null;
  /** The band the fold takes on the inner display, in window points. */
  fold: FoldRect | null;
};

type Native = {
  available(): boolean;
  state(): Promise<NativeFold>;
  addListener(name: "changed", listener: (state: NativeFold) => void): EventSubscription;
};

export const Fold = requireOptionalNativeModule<Native>("BotkinsFold");
