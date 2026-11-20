// Live Activities (the Lock Screen and the Dynamic Island) for a chat's running turn, and the key
// the notification extension opens sealed alerts with (iPhone). The native half is
// ios/BotkinsActivityModule.swift; a build without it has `Activities === null`.
import { type EventSubscription, requireOptionalNativeModule } from "expo-modules-core";
import type { ActivityState } from "@/link/types";

/** Who the activity is about. It is fixed for the life of one activity. */
export type ActivityAbout = { chatId: string; botId: string; botName: string; head: string; palette: string; eyes: string; colors: string[] };

type Native = {
  /** Live Activities are allowed for this app in Settings. */
  enabled(): boolean;
  /** Starts an activity for a chat (replacing one already running for it) and resolves with its id. Needs the app in front. */
  start(about: ActivityAbout, state: ActivityState): Promise<string>;
  update(chatId: string, state: ActivityState): Promise<void>;
  /** Ends it; the last state stays on the Lock Screen for `lingerSeconds`. */
  end(chatId: string, state: ActivityState | null, lingerSeconds: number): Promise<void>;
  /** The chats that have an activity now. */
  running(): Promise<string[]>;
  /** The address Apple delivers each running activity's updates to, for the ones that have one now. */
  tokens(): Promise<{ chatId: string; token: string }[]>;
  /** Saves (or with null removes) the key sealed alerts are opened with, where the notification extension can read it. */
  setPushKey(base64: string | null): Promise<void>;
  /**
   * Saves one key for each paired computer (`host` is the computer's id), in place of every key kept
   * before; an empty list removes them all. The notification extension tries each on a sealed alert
   * and notes which computer's key opened it. Missing in a build from before several computers.
   */
  setPushKeys?(keys: { host: string; key: string }[]): Promise<void>;
  /** An activity got the token Apple delivers its updates to. */
  addListener(name: "token", listener: (event: { chatId: string; token: string }) => void): EventSubscription;
  /** The token that can start an activity from afar (iOS 17.2 or later). */
  addListener(name: "startToken", listener: (event: { token: string }) => void): EventSubscription;
  /** An activity ended (the person dismissed it, or it ran out). */
  addListener(name: "ended", listener: (event: { chatId: string }) => void): EventSubscription;
};

export const Activities = requireOptionalNativeModule<Native>("BotkinsActivity");
