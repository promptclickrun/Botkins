// Live Activities (the Lock Screen and the Dynamic Island) for a chat's running turn, and the key
// the notification extension opens sealed alerts with (iPhone). The native half is
// ios/BotkinsActivityModule.swift; a build without it has `Activities === null`.
import { type EventSubscription, requireOptionalNativeModule } from "expo-modules-core";
import type { ActivityState } from "@/link/types";
import type { QueuedAnswer } from "./types";

export type { QueuedAnswer } from "./types";

/** Who the activity is about. It is fixed for the life of one activity. */
export type ActivityAbout = { chatId: string; botId: string; botName: string; head: string; palette: string; eyes: string; colors: string[] };
/** Who a Botkin's card is about ("activity-bots-v1"). Its key is "bot:" + botId. */
export type CardAbout = Omit<ActivityAbout, "chatId">;


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
  /**
   * Takes away activities that have ended but still show on the Lock Screen (iOS keeps one there for
   * hours after it ends by itself). Missing in an older build.
   */
  dismissEnded?(): Promise<void>;
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
  /**
   * Starts a Botkin's card (the app must be in front) and resolves with its id. `state` is the
   * card's state as JSON (link-host/cards.d.mts, CardState); `detail` is the part only the phone may
   * see, sealed here with the push key of computer `host` before it goes into the card.
   * Missing in a build from before one card per Botkin.
   */
  startCard?(about: CardAbout, state: string, detail: string | null, host: string | null, relevance: number): Promise<string>;
  /**
   * Starts the card for all Botkins ("activity-all-v1"; key "all"), the same way. Missing in a build
   * from before it, which has no view for it either.
   */
  startAllCard?(state: string, detail: string | null, host: string | null, relevance: number): Promise<string>;
  updateCard?(key: string, state: string, detail: string | null, host: string | null, relevance: number): Promise<void>;
  /** Ends a card; its last state stays on the Lock Screen for `lingerSeconds`. */
  endCard?(key: string, lingerSeconds: number): Promise<void>;
  /** Every answer not yet sent, oldest first. They stay queued until `answered`. */
  takeAnswers?(): Promise<QueuedAnswer[]>;
  /** An answer was sent (or refused): it leaves the queue, and its card shows so. */
  answered?(id: string, ok: boolean): Promise<void>;
  /** Saves what the widgets show (JSON, src/state/widgetData.ts) where they read it, and asks iOS to draw them again. */
  setWidgetData?(json: string): Promise<void>;
  /** What the widgets were last given, or null. */
  getWidgetData?(): Promise<string | null>;
  /** The kinds of widget the person has put somewhere ("BotkinsBot", "BotkinsCrew", "BotkinsUsage"). */
  installedWidgets?(): Promise<string[]>;
  /** Reads a staged iOS Share Extension payload (JSON string with resolved file:// URIs) by id, or null. */
  readShare?(id: string): Promise<string | null>;
  /** Removes a staged iOS Share Extension directory after it has been sent or dismissed. */
  clearShare?(id: string): Promise<void>;
  /** An answer was given while the app runs. */
  addListener(name: "answer", listener: (answer: QueuedAnswer) => void): EventSubscription;
  /** An activity got the token Apple delivers its updates to. `chatId` is the card's key: a chat's id, or "bot:" + a Botkin's. */
  addListener(name: "token", listener: (event: { chatId: string; token: string }) => void): EventSubscription;
  /** The token that can start an activity from afar (iOS 17.2 or later). */
  addListener(name: "startToken", listener: (event: { token: string }) => void): EventSubscription;
  /** An activity ended (the person dismissed it, or it ran out). */
  addListener(name: "ended", listener: (event: { chatId: string }) => void): EventSubscription;
};

export const Activities = requireOptionalNativeModule<Native>("BotkinsActivity");
