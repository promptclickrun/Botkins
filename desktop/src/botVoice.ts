// A voice of a bot's own ("bot-voice-v1"): the choices a bot keeps over Settings › Voice. Plain, so
// a test can run it. Every field is optional; an absent one is the same as the shared setting. The
// main process resolves the same way (`effectiveTts` and `effectiveLive` in desktop/link/voice.mjs),
// and the phone has the same words (mobile/src/features/voice/botVoice.ts).
import type { BotVoice, LiveProvider, TtsProvider, VoiceSettings } from "./types";

type Tts = NonNullable<BotVoice["tts"]>;
type Live = NonNullable<BotVoice["live"]>;

export const TTS_NAMES: Record<TtsProvider, string> = { device: "This computer", openai: "OpenAI", azure: "Azure", elevenlabs: "ElevenLabs", gemini: "Gemini", custom: "Your own server", local: "This computer's own models" };
export const LIVE_NAMES: Record<LiveProvider, string> = { codex: "ChatGPT sign-in", openai: "OpenAI", gemini: "Gemini", elevenlabs: "ElevenLabs" };

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

/** Why a provider can't be used yet, in a few words, or null when it has what it needs. Local models and Codex are asked for only by what the computer reports. */
export function providerLack(kind: "tts" | "live", provider: string, shared: VoiceSettings): string | null {
  const p = shared.providers;
  switch (provider) {
    case "device":
      return null;
    case "openai":
    case "gemini":
    case "elevenlabs":
      return p[provider].hasKey ? null : "needs a key";
    case "azure":
      if (!p.azure.hasKey) return "needs a key";
      if (p.azure.kind === "speech") return p.azure.endpoint || p.azure.region ? null : "needs a region";
      return p.azure.endpoint && p.azure.ttsDeployment ? null : "needs an endpoint";
    case "custom":
      return p.custom.baseUrl ? null : "needs an address";
    case "local":
      return p.local.available && p.local.models.some((model) => model.installed && model.kind === "tts") ? null : "not available";
    case "codex":
      return p.codex.available && p.codex.signedIn ? null : "needs a sign-in";
    default:
      return kind === "tts" ? "not available" : null;
  }
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

/**
 * A model or voice chosen for a bot carries the provider it belongs to. When both are cleared again
 * ("Same as Settings") and that provider is only the shared one, the bot follows Settings again.
 */
export function unpinIfBare(voice: BotVoice | null, section: "tts" | "live", shared: string | null | undefined): BotVoice | null {
  const part = voice?.[section];
  if (!part || part.model || part.voice || part.provider !== shared) return voice;
  const { provider: _provider, ...rest } = part;
  return tidyVoice({ ...voice, [section]: rest });
}

/** Another provider for a section: the old model and voice would not fit it, so they go back to the default. The speed stays. */
export function withProvider(voice: BotVoice | undefined, section: "tts" | "live", provider: string | undefined): BotVoice | null {
  const speed = section === "tts" ? voice?.tts?.speed : undefined;
  return tidyVoice({ ...voice, [section]: { provider, ...(speed !== undefined && { speed }) } as Tts & Live });
}

/** A voice id as a person would say it ("nova" is "Nova"). An opaque id (an ElevenLabs voice) is left out: only the list knows its name. */
const voiceWord = (id: string | undefined) => (id && !/^[A-Za-z0-9_-]{20,}$/.test(id) ? id.charAt(0).toUpperCase() + id.slice(1) : undefined);

/**
 * One line for a bot's own voice: "Same as Settings", or what it changes, such as
 * "OpenAI · Nova · Live: Gemini · Puck". Only what the bot sets is named; the provider of a part
 * it sets only a voice for is the shared one.
 */
export function botVoiceSummary(own: BotVoice | undefined, shared: VoiceSettings | undefined): string {
  const parts: string[] = [];
  const tts = own?.tts;
  if (tts && Object.keys(tts).length) {
    const provider = shared ? effectiveTts(shared.tts, tts).provider : tts.provider;
    parts.push(...[provider && TTS_NAMES[provider], voiceWord(tts.voice), tts.speed !== undefined && provider !== "gemini" ? Math.round(tts.speed * 100) / 100 + "×" : undefined].filter((part): part is string => !!part));
  }
  const live = own?.live;
  if (live && Object.keys(live).length) {
    const provider = shared ? effectiveLive(shared.live, live).provider : live.provider;
    const words = [provider && LIVE_NAMES[provider], voiceWord(live.voice)].filter((part): part is string => !!part);
    parts.push("Live: " + (words.join(" · ") || "Settings"));
  }
  return parts.join(" · ") || "Same as Settings";
}

// ── This computer's own voice for a bot ─────────────────────────────────────────────────────────
// When a bot reads with "This computer", its system voice is kept in this window's own settings:
// a system voice isn't portable between a computer and a phone.

const DEVICE_KEY = "botkins.botDeviceVoices";
export type BotDeviceVoice = { voice?: string; speed?: number };

/** Each bot's system voice and speed saved in this window, by bot id. */
export function botDeviceVoices(): Record<string, BotDeviceVoice> {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** This computer's own voice for one bot. A field set to undefined goes back to the voice from Settings; nothing left forgets the bot. */
export function setBotDeviceVoice(botId: string, patch: BotDeviceVoice) {
  const all = botDeviceVoices();
  const next = Object.fromEntries(Object.entries({ ...all[botId], ...patch }).filter(([, value]) => value !== undefined));
  if (Object.keys(next).length) all[botId] = next;
  else delete all[botId];
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(all));
  } catch {
    // A private browsing profile can refuse local storage. The voice from Settings is used.
  }
}
