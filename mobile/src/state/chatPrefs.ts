// How chats look and behave on this phone: steps, thinking, rich cards, Markdown, code, typing and
// reading aloud. Saved on the phone only; the computer keeps its own two (Show thinking, Fold steps).
import { keep, readKept } from "@/state/keep";
import { Platform } from "react-native";
import { create } from "zustand";
import { useApp } from "./store";

const KEY = "botkins.chatPrefs.v1";

export type ChatPrefs = {
  /** A turn's tool calls. show: every step. summary: one line. failed: failed steps only. hide: nothing. */
  steps: "show" | "summary" | "failed" | "hide";
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
  /** Return sends; off makes Return a new line. */
  enterSends: boolean;
  /** Each finished reply in the open chat is read aloud. */
  readAloud: boolean;
  /** The person chose `readAloud` on this phone. Until then it follows the computer's Settings › Voice. */
  readAloudPicked?: boolean;
};

export const chatPrefDefaults: ChatPrefs = {
  steps: "show",
  thinking: "folded",
  richCards: true,
  markdown: true,
  highlight: true,
  wrapCode: false,
  timestamps: false,
  // A phone has no Shift key, so Return makes a new line unless asked otherwise. A tablet with a keyboard may prefer sending.
  enterSends: Platform.OS === "ios" && Platform.isPad,
  readAloud: false,
};

export const useChatPrefs = create<ChatPrefs>(() => chatPrefDefaults);

let loading: Promise<void> | null = null;

/** Reads the saved choices once. Called by itself the first time this module is used. */
export function loadChatPrefs(): Promise<void> {
  loading ??= (async () => {
    try {
      const saved = await readKept(KEY);
      if (saved) useChatPrefs.setState({ ...chatPrefDefaults, ...(JSON.parse(saved) as Partial<ChatPrefs>) });
    } catch {
      // Unreadable choices fall back to the defaults.
    }
  })();
  return loading;
}

export function setChatPrefs(given: Partial<ChatPrefs>) {
  const patch = "readAloud" in given ? { ...given, readAloudPicked: true } : given;
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
