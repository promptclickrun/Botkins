// The names, and what is missing, for each voice provider. Pure, for the tests.
import type { LiveProvider, SttProvider, TtsProvider, VoiceKeyProvider, VoiceSettings } from "@/link/types";

export const STT_PROVIDERS: SttProvider[] = ["device", "openai", "azure", "elevenlabs", "custom", "local"];
export const TTS_PROVIDERS: TtsProvider[] = ["device", "openai", "azure", "elevenlabs", "gemini", "custom", "local"];
export const LIVE_PROVIDERS: LiveProvider[] = ["codex", "openai", "azure", "gemini", "elevenlabs"];
export const KEY_PROVIDERS: VoiceKeyProvider[] = ["openai", "azure", "elevenlabs", "gemini", "custom"];

const NAMES: Record<string, string> = {
  device: "This phone",
  openai: "OpenAI",
  azure: "Azure",
  elevenlabs: "ElevenLabs",
  gemini: "Gemini",
  custom: "Your own server",
  local: "On your computer",
  codex: "ChatGPT sign-in",
};
export const providerName = (provider: string) => NAMES[provider] ?? provider;

/** The `ProviderIcon` id for a provider's mark, where it has one. */
export const markOf = (provider: string): string | undefined => (provider === "codex" ? "openai" : provider === "device" || provider === "local" || provider === "custom" ? undefined : provider);

type Kind = "stt" | "tts" | "live";

/** One line on what a provider still needs before it can work, or null when it is ready. */
export function missing(kind: Kind, provider: string, voice: VoiceSettings): string | null {
  const p = voice.providers;
  switch (provider) {
    case "device":
      return null;
    case "openai":
      return p.openai.hasKey ? null : "Needs an OpenAI key";
    case "gemini":
      return p.gemini.hasKey ? null : "Needs a Gemini key";
    case "elevenlabs":
      return p.elevenlabs.hasKey ? null : "Needs an ElevenLabs key";
    case "azure": {
      if (!p.azure.hasKey) return "Needs an Azure key";
      // Live voice is on the resource's own address, whichever service dictation and reading use.
      if (kind === "live") return p.azure.endpoint ? null : "Needs an Azure resource endpoint";
      if (p.azure.kind === "speech") return p.azure.endpoint || p.azure.region ? null : "Needs an Azure region or endpoint";
      if (!p.azure.endpoint) return "Needs an Azure endpoint";
      // A model typed for Azure OpenAI audio is the deployment's name.
      if (kind === "stt" && !p.azure.sttDeployment && !(voice.stt.provider === "azure" && voice.stt.model)) return "Needs a transcription deployment";
      if (kind === "tts" && !p.azure.ttsDeployment && !(voice.tts.provider === "azure" && voice.tts.model)) return "Needs a speech deployment";
      return null;
    }
    case "custom":
      return p.custom.baseUrl ? null : "Needs your server's address";
    case "local": {
      if (!p.local.available) return "Not available on this computer";
      return p.local.models.some((model) => model.installed && model.kind === kind) ? null : "Install a model on your computer";
    }
    case "codex":
      if (!p.codex.available) return "Not available on this computer";
      return p.codex.signedIn ? null : "Sign in to ChatGPT on your computer";
    default:
      return null;
  }
}

/** A provider row's state in Settings › Voice › Providers. */
export function providerState(provider: string, voice: VoiceSettings): string {
  const p = voice.providers;
  switch (provider) {
    case "codex":
      return !p.codex.available ? "Not available on this computer" : p.codex.signedIn ? "Signed in" : "Not signed in";
    case "local": {
      if (!p.local.available) return "Not available on this computer";
      const installed = p.local.models.filter((model) => model.installed).length;
      return installed ? installed + " installed" : "None installed";
    }
    case "custom":
      return !p.custom.baseUrl ? "No address" : p.custom.hasKey ? "Key saved" : "No key";
    case "openai":
    case "azure":
    case "elevenlabs":
    case "gemini":
      return p[provider].hasKey ? "Key saved" : "No key";
    default:
      return "";
  }
}

export type Item = { value: string; label: string; subtitle?: string };

/** The choice that opens a field to type a model or a voice that isn't in the list (the desktop app says the same words). */
export const OTHER = "__other__";
export type Typing = { choice: string; title: string; message: string; confirm: string };
export const OTHER_MODEL: Typing = {
  choice: "Other model…",
  title: "Other model",
  message: "Type the model's name, such as MAI-Transcribe-2. For Azure OpenAI audio, type the deployment's name.",
  confirm: "Use",
};
export const OTHER_VOICE: Typing = { choice: "Other voice…", title: "Other voice", message: "Type the voice's name, such as en-US-Harper:MAI-Voice-2.1.", confirm: "Use" };

/** A list of choices with what is saved but not listed (a typed model), then the entry that lets the person type another. */
export function withTyped(items: Item[], current: string | undefined, typing: Typing): Item[] {
  const typed = current && !items.some((item) => item.value === current) ? [{ value: current, label: current }] : [];
  return [...items, ...typed, { value: OTHER, label: typing.choice }];
}

/** Languages offered for dictation. "" lets the provider decide. */
export const LANGUAGES: { value: string; label: string }[] = [
  { value: "", label: "Automatic" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "it-IT", label: "Italian" },
  { value: "pt-BR", label: "Portuguese" },
  { value: "nl-NL", label: "Dutch" },
  { value: "sv-SE", label: "Swedish" },
  { value: "pl-PL", label: "Polish" },
  { value: "ru-RU", label: "Russian" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "tr-TR", label: "Turkish" },
  { value: "ar-SA", label: "Arabic" },
  { value: "hi-IN", label: "Hindi" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
  { value: "zh-CN", label: "Chinese" },
];

export const sizeLabel = (megabytes?: number) => (!megabytes ? "" : megabytes >= 1000 ? (megabytes / 1000).toFixed(1).replace(/\.0$/, "") + " GB" : Math.round(megabytes) + " MB");
