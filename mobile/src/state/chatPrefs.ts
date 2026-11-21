// How chats look and behave on this phone: steps, thinking, rich cards, Markdown, code, typing and
// reading aloud. Saved on the phone only; the computer keeps its own two (Show thinking, Fold steps).
import { type CompletionPosition, completionPositionOf } from "@/features/chat/completion";
import { settleSteps, type StepsChoice } from "@/features/chat/fold";
import { type BotTap, botTapOf } from "@/features/chat/habits";
import { keep, readKept } from "@/state/keep";
import { Platform } from "react-native";
import { create } from "zustand";
import { useApp } from "./store";

const KEY = "botkins.chatPrefs.v1";

export type ChatPrefs = {
  /** A turn's work. folded: one line per turn (the default). show: every step, thought and update in order. failed: failed steps only. hide: nothing. */
  steps: StepsChoice;
  /** The person chose `steps`. Until then it is Folded (settleSteps in src/features/chat/fold.ts). */
  stepsPicked?: boolean;
  /** A bot's live reasoning. */
  thinking: "show" | "folded" | "hide";
  /** Cards, charts, tables and suggested replies a bot attaches. Off keeps only a card's title. */
  richCards: boolean;
  /** Off shows replies as plain text. */
  markdown: boolean;
  /** Colors in code blocks. */
  highlight: boolean;
  /** Long code lines wrap instead of scrolling sideways. */
  wrapCode: boolean;
  /** A small time under each message. */
  timestamps: boolean;
  /** Where a chat lands once a reply has finished: at its end (latest) or its beginning (src/features/chat/completion.ts). */
  completionPosition: CompletionPosition;
  /** What selecting a bot on Home opens: its latest chat, or a new one each time (src/features/chat/habits.ts). */
  botTap: BotTap;
  /** Return sends; off makes Return a new line. */
  enterSends: boolean;
  /** Each finished reply in the open chat is read aloud. */
  readAloud: boolean;
  /** The person chose `readAloud` on this phone. Until then it follows the computer's Settings › Voice. */
  readAloudPicked?: boolean;
  /**
   * A reply as the bot writes it. direct: only when not through the relay (each update costs a relay
   * message). Without it a reply lands whole and is shown word by word here (src/features/chat/reveal.ts).
   */
  liveText: LiveText;
};

export type LiveText = "always" | "direct" | "off";
const LIVE_TEXT: readonly LiveText[] = ["always", "direct", "off"];

/** Whether a reply's text is followed as it is written, on this route. */
export const liveTextOn = (choice: LiveText, route: "direct" | "relay" | null) => choice === "always" || (choice === "direct" && route !== "relay");

export const chatPrefDefaults: ChatPrefs = {
  steps: "folded",
  thinking: "folded",
  richCards: true,
  markdown: true,
  highlight: true,
  wrapCode: false,
  timestamps: false,
  completionPosition: "latest",
  botTap: "latest",
  // A phone has no Shift key, so Return makes a new line unless asked otherwise. A tablet with a keyboard may prefer sending.
  enterSends: Platform.OS === "ios" && Platform.isPad,
  readAloud: false,
  liveText: "direct",
};

export const useChatPrefs = create<ChatPrefs>(() => chatPrefDefaults);

let loading: Promise<void> | null = null;

/** Reads the saved choices once. Called by itself the first time this module is used. */
export function loadChatPrefs(): Promise<void> {
  loading ??= (async () => {
    try {
      const saved = await readKept(KEY);
      if (saved) {
        const read = JSON.parse(saved) as Partial<ChatPrefs>;
        useChatPrefs.setState({ ...chatPrefDefaults, ...read, steps: settleSteps(read), completionPosition: completionPositionOf(read.completionPosition), botTap: botTapOf(read.botTap), liveText: LIVE_TEXT.includes(read.liveText!) ? read.liveText! : chatPrefDefaults.liveText });
      }
    } catch {
      // Unreadable choices fall back to the defaults.
    }
  })();
  return loading;
}

export function setChatPrefs(given: Partial<ChatPrefs>) {
  const patch = { ...given, ...("readAloud" in given && { readAloudPicked: true }), ...("steps" in given && { stepsPicked: true }) };
  useChatPrefs.setState(patch);
  // Saved after the stored choices were read, so a change made early never writes the defaults over them.
  void loadChatPrefs().then(() => {
    useChatPrefs.setState(patch);
    return keep(KEY, JSON.stringify(useChatPrefs.getState())).catch(() => {});
  });
}

/** Without a choice of its own, the phone reads replies aloud when the computer's voice settings say so. */
function followComputer() {
  const prefs = useChatPrefs.getState();
  if (prefs.readAloudPicked) return;
  const auto = useApp.getState().parts.voice?.tts.auto;
  if (typeof auto === "boolean" && auto !== prefs.readAloud) useChatPrefs.setState({ readAloud: auto });
}

void loadChatPrefs().then(() => {
  followComputer();
  useApp.subscribe((state, before) => {
    if (state.parts.voice !== before.parts.voice) followComputer();
  });
});
