// How chats look and behave on this phone: steps, thinking, updates, rich cards, Markdown, code,
// typing and reading aloud. These choices stay on this phone when it connects to another computer.
import { type CompletionPosition, completionPositionOf } from "@/features/chat/completion";
import { settleSteps, settleThinking, type StepsChoice, type ThinkingChoice } from "@/features/chat/fold";
import { type BotTap, botTapOf } from "@/features/chat/habits";
import { keep, readKept } from "@/state/keep";
import { Platform } from "react-native";
import { create } from "zustand";
import { useApp } from "./store";

const KEY = "botkins.chatPrefs.v1";

export type ChatPrefs = {
  /** Which tool calls appear in the conversation. The activity rail always has the full list. */
  steps: StepsChoice;
  /** The person chose `steps`. Until then it is Open (settleSteps in src/features/chat/fold.ts). */
  stepsPicked?: boolean;
  /** A bot's chain of thought (reasoning). */
  thinking: ThinkingChoice;
  /** The person chose `thinking`. Until then the old default, Folded, reads as Open (settleThinking in fold.ts). */
  thinkingPicked?: boolean;
  /** Interim messages and status updates while a bot works. */
  updates: boolean;
  /** Collapse finished activity into a single expandable line. */
  foldFinishedSteps: boolean;
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
  /** What selecting a bot on Home opens: Main chat, its latest chat, or a new one each time (src/features/chat/habits.ts). */
  botTap: BotTap;
  /** Return sends; off makes Return a new line. */
  enterSends: boolean;
  /** Each finished reply in the open chat is read aloud. */
  readAloud: boolean;
  /** The person chose `readAloud` on this phone. Until then it follows the computer's Settings › Voice. */
  readAloudPicked?: boolean;
  /** A reply as the bot writes it. Through the relay this requests updates of a few words every half second or so; the phone shows each received update whole. */
  textStreaming: boolean;
};

/** How a reply's text is followed on this route: as it is written, in chunks through the relay, or whole. */
export const textMode = (on: boolean, route: "direct" | "relay" | null): "live" | "chunks" | "whole" => (!on ? "whole" : route === "relay" ? "chunks" : "live");

export const chatPrefDefaults: ChatPrefs = {
  // Open, the live island, for both (settleSteps and settleThinking say how a saved choice is read).
  steps: "show",
  thinking: "show",
  updates: true,
  foldFinishedSteps: true,
  richCards: true,
  markdown: true,
  highlight: true,
  wrapCode: false,
  timestamps: false,
  completionPosition: "latest",
  botTap: "main",
  // A phone has no Shift key, so Return makes a new line unless asked otherwise. A tablet with a keyboard may prefer sending.
  enterSends: Platform.OS === "ios" && Platform.isPad,
  readAloud: false,
  textStreaming: true,
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
        const steps = settleSteps(read);
        useChatPrefs.setState({
          ...chatPrefDefaults, ...read,
          steps,
          thinking: settleThinking(read),
          updates: typeof read.updates === "boolean" ? read.updates : chatPrefDefaults.updates,
          // Open once kept every finished step in the chat; it is the island now, which always folds.
          foldFinishedSteps: typeof read.foldFinishedSteps === "boolean" ? read.foldFinishedSteps : true,
          completionPosition: completionPositionOf(read.completionPosition),
          botTap: botTapOf(read.botTap),
          textStreaming: typeof read.textStreaming === "boolean" ? read.textStreaming : chatPrefDefaults.textStreaming,
        });
      }
    } catch {
      // Unreadable choices fall back to the defaults.
    }
  })();
  return loading;
}

export function setChatPrefs(given: Partial<ChatPrefs>) {
  const patch = { ...given, ...("readAloud" in given && { readAloudPicked: true }), ...("steps" in given && { stepsPicked: true }), ...("thinking" in given && { thinkingPicked: true }) };
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
