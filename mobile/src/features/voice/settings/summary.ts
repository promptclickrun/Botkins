// Settings › Voice's overview: one line for each of dictation, reading aloud and live voice, the two
// ways live voice listens, and which provider sheet sets a provider up. Plain, for the tests.
import type { BotVoice, VoiceKeyProvider, VoiceSettings } from "@/link/types";
import type { PhoneVoicePrefs } from "../prefs";
import { effectiveLive, effectiveTts } from "../botVoice";
import { KEY_PROVIDERS, LANGUAGES, missing, providerName } from "../choices";

/** A provider whose key or models are set in `ProviderSheet`. */
export type SheetProvider = VoiceKeyProvider | "local";

/** What an overview row shows: the provider at the right, one line under the title, and whether it still needs something. */
export type Summary = { value: string; subtitle?: string; needs: boolean };

export type LiveInput = PhoneVoicePrefs["liveInput"];

/** Said of a live provider this build of the app has no transport for. */
export const UNBUILT = "Update the app for this one";

export const LIVE_INPUTS: { value: LiveInput; label: string }[] = [
  { value: "conversation", label: "Live conversation" },
  { value: "push", label: "Push to talk" },
];
const INPUT_LINES: Record<LiveInput, string> = {
  conversation: "Talk freely. It listens while you speak and answers when you pause.",
  push: "Hold the button while you talk. Let go and it answers.",
};
export const liveInputLine = (input: LiveInput) => INPUT_LINES[input];
const inputName = (input: LiveInput) => LIVE_INPUTS.find((item) => item.value === input)?.label ?? "";

export const languageName = (code?: string) => (code ? (LANGUAGES.find((item) => item.value === code)?.label ?? code) : "Automatic");

/** Without the computer's settings (no voice-v1, or not yet arrived) dictation is the phone's own. */
export function dictationSummary(voice: VoiceSettings | undefined): Summary {
  const provider = voice?.stt.provider ?? "device";
  const lack = voice ? missing("stt", provider, voice) : null;
  return { value: providerName(provider), subtitle: lack ?? languageName(voice?.stt.language), needs: !!lack };
}

export function readingSummary(voice: VoiceSettings | undefined, readAloud: boolean): Summary {
  const provider = voice?.tts.provider ?? "device";
  const lack = voice ? missing("tts", provider, voice) : null;
  return { value: providerName(provider), subtitle: lack ?? (readAloud ? "Reads replies aloud" : undefined), needs: !!lack };
}

/** `built` says whether this build of the app can talk to a live provider (`planFor`). */
export function liveSummary(voice: VoiceSettings, input: LiveInput, built: (provider: NonNullable<VoiceSettings["live"]["provider"]>) => boolean): Summary {
  const provider = voice.live.provider;
  if (!provider) return { value: "Off", subtitle: undefined, needs: false };
  const lack = missing("live", provider, voice) ?? (built(provider) ? null : UNBUILT);
  return { value: providerName(provider), subtitle: lack ?? inputName(input), needs: !!lack };
}

/** How many providers have a key on the computer. Never the keys themselves. */
export function keysSummary(voice: VoiceSettings): string {
  const saved = KEY_PROVIDERS.filter((provider) => voice.providers[provider].hasKey).length;
  return saved === 0 ? "No keys saved" : saved === 1 ? "1 key saved" : saved + " keys saved";
}

/** The sheet that sets a provider up, or null for one set up elsewhere (this phone; ChatGPT sign-in is on the computer). */
export function setupFor(provider: string | null | undefined): SheetProvider | null {
  if (provider === "local") return "local";
  return (KEY_PROVIDERS as string[]).includes(provider ?? "") ? (provider as VoiceKeyProvider) : null;
}

/** A voice id as a person would say it ("nova" is "Nova"). An opaque id (an ElevenLabs voice) is left out: only the list knows its name. */
const voiceWord = (id: string | undefined) => (id && !/^[A-Za-z0-9_-]{20,}$/.test(id) ? id.charAt(0).toUpperCase() + id.slice(1) : undefined);

/**
 * One line for a bot's own voice on its page: "Same as Settings", or what it changes, such as
 * "OpenAI · Nova · Live: Gemini · Puck". Only what the bot sets is named; the provider of a part
 * it sets only a voice for is the shared one.
 */
/** A system voice's name from its id ("com.apple.voice.compact.en-GB.Daniel", "com.apple.ttsbundle.Moira-compact"). */
export const phoneVoiceName = (id: string) => id.split(".").pop()?.split("-")[0] || undefined;

/**
 * One line for a bot's voice. `phone` is the system voice and speed this phone keeps for the bot,
 * which count only while the bot reads with "This phone".
 */
export function botVoiceSummary(own: BotVoice | undefined, shared: VoiceSettings | undefined, phone?: { voice?: string; speed?: number }): string {
  const parts: string[] = [];
  const tts = own?.tts;
  const onPhone = (shared ? effectiveTts(shared.tts, tts).provider : tts?.provider) === "device";
  if (onPhone && (phone?.voice || phone?.speed !== undefined)) {
    parts.push(...["This phone", phone.voice && phoneVoiceName(phone.voice), phone.speed !== undefined ? Math.round(phone.speed * 100) / 100 + "×" : undefined].filter((part): part is string => !!part));
  } else if (tts && Object.keys(tts).length) {
    const provider = shared ? effectiveTts(shared.tts, tts).provider : tts.provider;
    parts.push(...[provider && providerName(provider), voiceWord(tts.voice), tts.speed !== undefined && provider !== "gemini" ? Math.round(tts.speed * 100) / 100 + "×" : undefined].filter((part): part is string => !!part));
  }
  const live = own?.live;
  if (live && Object.keys(live).length) {
    const provider = shared ? effectiveLive(shared.live, live).provider : live.provider;
    const words = [provider && providerName(provider), voiceWord(live.voice)].filter((part): part is string => !!part);
    parts.push("Live: " + (words.join(" · ") || "Settings"));
  }
  return parts.join(" · ") || "Same as Settings";
}
