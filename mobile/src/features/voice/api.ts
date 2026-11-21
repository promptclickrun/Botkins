// What the rest of the app uses from voice: dictation into a field, reading text aloud, and
// opening live voice. The chat composer and the messages call these; the screens are in this folder.
import { router } from "expo-router";
import { useDictationImpl } from "./dictation";
import { canRecognize, canRecord } from "./native";
import { useSttProvider, useVoiceSettings, useVoiceSupported, voiceSettings, voiceSupported } from "./state";
import { speakText, stopSpeech, useSpeakingNow } from "./tts";
import { startTalk } from "./talk";

export type Dictation = {
  /** Dictation can be used: the phone has speech recognition, or the computer has a provider set. */
  available: boolean;
  listening: boolean;
  /** How loud the microphone is, 0 to 1, while listening. */
  level: number;
  /** Starts listening. Asks for the microphone the first time; shows a toast when it is refused. */
  start(): void;
  /** Stops and delivers the last text. */
  stop(): void;
};

/**
 * Dictation into a text field. `onText` gets the words so far while the person speaks (`final`
 * false: replace the last partial text) and the finished text (`final` true: keep it).
 */
export function useDictation(options: { onText(text: string, final: boolean): void }): Dictation {
  return useDictationImpl(options);
}

export type Speaker = {
  /** The id of what is being read aloud now, or null. */
  speaking: string | null;
  /** Reads `text` aloud (Markdown is cleaned first), stopping what was being read. `id` names it, such as a message's key. */
  speak(id: string, text: string): void;
  stop(): void;
};
export function useSpeaker(): Speaker {
  const speaking = useSpeakingNow((state) => state.id);
  return { speaking, speak: speakText, stop: stopSpeech };
}

// ---- Talking by turns (the voice button, when live voice is off)
export { endTalk, skipToListening, startTalk, useTalk } from "./talk";
export { TalkBar } from "./TalkBar";
/** This build can listen with the chosen dictation, so the voice button can talk by turns. */
export function useTalkReady(): boolean {
  const provider = useSttProvider();
  return provider === "device" ? canRecognize() : canRecord();
}

/** Live voice can be opened: the computer supports voice and a live provider is chosen. */
export function useLiveVoiceReady(): boolean {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  return supported && !!voice?.live.provider;
}

/** The chat's voice button and the voice shortcut use the same mode. */
export function startChatVoice(chatId: string, botId: string) {
  if (voiceSettings()?.live.provider) openLiveVoice(chatId, botId);
  else startTalk(chatId);
}

/** Opens live voice with a bot, in a chat. When it isn't set up yet, opens Settings › Voice instead. */
export function openLiveVoice(chatId: string, botId: string) {
  if (!voiceSupported() || !voiceSettings()?.live.provider) {
    router.push("/settings/voice");
    return;
  }
  router.push({ pathname: "/voice/live", params: { chatId, botId } });
}
