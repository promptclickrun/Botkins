// What voice knows about the computer: whether it speaks voice-v1, and the shared settings.
import type { BotVoice, LiveProvider, SttProvider, TtsProvider, VoiceSettings } from "@/link/types";
import { usePart } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BOT_VOICE_CAPABILITY, effectiveLive } from "./botVoice";

export const VOICE_CAPABILITY = "voice-v1";
export const UPDATE_COMPUTER = "Update Botkins on your computer";

export const voiceSupported = () => !!useApp.getState().parts.meta?.capabilities?.includes(VOICE_CAPABILITY);
export const useVoiceSupported = () => !!usePart("meta")?.capabilities?.includes(VOICE_CAPABILITY);

/** The shared settings, or undefined when the computer has no voice-v1 (or they haven't arrived). */
export function voiceSettings(): VoiceSettings | undefined {
  return voiceSupported() ? useApp.getState().parts.voice : undefined;
}
export function useVoiceSettings(): VoiceSettings | undefined {
  const supported = useVoiceSupported();
  const voice = usePart("voice");
  return supported ? voice : undefined;
}

/** Who turns speech into text right now. Without voice-v1 it is always the phone. */
export const sttProvider = (voice = voiceSettings()): SttProvider => voice?.stt.provider ?? "device";
export const ttsProvider = (voice = voiceSettings()): TtsProvider => voice?.tts.provider ?? "device";

export const useSttProvider = (): SttProvider => useVoiceSettings()?.stt.provider ?? "device";
export const useTtsProvider = (): TtsProvider => useVoiceSettings()?.tts.provider ?? "device";

// ---- A voice of a bot's own ("bot-voice-v1")
export const botVoiceSupported = () => !!useApp.getState().parts.meta?.capabilities?.includes(BOT_VOICE_CAPABILITY);
export const useBotVoiceSupported = () => !!usePart("meta")?.capabilities?.includes(BOT_VOICE_CAPABILITY);

/** The bot's own voice, or undefined when it has none or the computer doesn't keep one. */
export const botVoiceOf = (botId: string | undefined): BotVoice | undefined => (botId && botVoiceSupported() ? useApp.getState().parts.bots?.find((bot) => bot.id === botId)?.voice : undefined);

/** The live provider a call with this bot uses: its own, else the shared one. */
export const liveProviderFor = (botId: string | undefined, voice = voiceSettings()): LiveProvider | null => (voice ? effectiveLive(voice.live, botVoiceOf(botId)?.live).provider : null);
