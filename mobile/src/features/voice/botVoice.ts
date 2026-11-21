// A voice of a bot's own ("bot-voice-v1"): the choices a bot keeps over Settings › Voice. Plain, for
// the tests. Every field is optional; an absent one is the same as the shared setting. The computer
// resolves the same way (`effectiveTts` and `effectiveLive` in link-host/voice.mjs); tests/voice-phone.test.ts
// keeps the two together.
import type { BotVoice, LiveProvider, TtsProvider, VoiceSettings } from "@/link/types";

export const BOT_VOICE_CAPABILITY = "bot-voice-v1";

type Tts = NonNullable<BotVoice["tts"]>;
type Live = NonNullable<BotVoice["live"]>;

/** What reads a bot's replies: its own choices over the shared ones. The shared model and voice belong to the shared provider, so they count only while the provider is the same. */
export function effectiveTts(shared: VoiceSettings["tts"], own?: Tts): { provider: TtsProvider; model?: string; voice?: string; speed?: number } {
  const provider = own?.provider ?? shared.provider;
  const same = provider === shared.provider;
  return { provider, model: own?.model ?? (same ? shared.model : undefined), voice: own?.voice ?? (same ? shared.voice : undefined), speed: own?.speed ?? shared.speed };
}

/** The same for live voice. */
export function effectiveLive(shared: VoiceSettings["live"], own?: Live): { provider: LiveProvider | null; model?: string; voice?: string } {
  const provider = own?.provider ?? shared.provider;
  const same = provider === shared.provider;
  return { provider, model: own?.model ?? (same ? shared.model : undefined), voice: own?.voice ?? (same ? shared.voice : undefined) };
}

/** A section with only the fields that are set, or undefined when none is. */
const kept = <T extends object>(section: T | undefined): T | undefined => {
  const entries = Object.entries(section ?? {}).filter(([, value]) => value !== undefined && value !== "");
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
};

/** A voice with nothing set is no voice: `null` clears it on the computer. */
export function tidyVoice(voice: BotVoice | undefined): BotVoice | null {
  const tts = kept(voice?.tts);
  const live = kept(voice?.live);
  return tts || live ? { ...(tts && { tts }), ...(live && { live }) } : null;
}

/** `voice` with one section changed. A field set to undefined goes back to the shared setting. */
export function withSection<K extends "tts" | "live">(voice: BotVoice | undefined, section: K, patch: NonNullable<BotVoice[K]>): BotVoice | null {
  return tidyVoice({ ...voice, [section]: { ...voice?.[section], ...patch } });
}

/** Another provider for a section: the old model and voice would not fit it, so they go back to the default. The speed stays. */
export function withProvider(voice: BotVoice | undefined, section: "tts" | "live", provider: string | undefined): BotVoice | null {
  const speed = section === "tts" ? voice?.tts?.speed : undefined;
  return tidyVoice({ ...voice, [section]: { provider, ...(speed !== undefined && { speed }) } as Tts & Live });
}
