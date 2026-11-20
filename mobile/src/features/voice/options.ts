// The models and voices a provider offers, asked of the computer once per provider and settings.
import { useEffect, useState } from "react";
import type { VoiceOptions, VoiceSettings } from "@/link/types";
import { api } from "@/state/link";

const kept = new Map<string, Promise<VoiceOptions>>();
const EMPTY: VoiceOptions = { models: [], voices: [] };

/** Changes to a provider's key or connection ask again. */
function revisionOf(voice: VoiceSettings | undefined, provider: string) {
  const providers = voice?.providers as Record<string, unknown> | undefined;
  const section = provider === "codex" ? providers?.codex : providers?.[provider];
  return JSON.stringify(section ?? null);
}

/** undefined while loading; an empty list when the provider has none or the computer couldn't say. */
export function useVoiceOptions(kind: "stt" | "tts" | "live", provider: string | null | undefined, voice: VoiceSettings | undefined): VoiceOptions | undefined {
  const key = provider && voice && provider !== "device" ? kind + ":" + provider + ":" + revisionOf(voice, provider) : null;
  const [loaded, setLoaded] = useState<{ key: string; options: VoiceOptions } | null>(null);
  useEffect(() => {
    if (!key || !provider) return;
    let live = true;
    let asked = kept.get(key);
    if (!asked) {
      asked = api["link.voice.options"](kind, provider).catch(() => EMPTY);
      kept.set(key, asked);
      // Asked again after a while, so a list the provider changed shows up.
      setTimeout(() => kept.delete(key), 5 * 60_000);
    }
    void asked.then((options) => {
      if (live) setLoaded({ key, options: options ?? EMPTY });
    });
    return () => {
      live = false;
    };
  }, [key, kind, provider]);
  if (!key) return EMPTY;
  return loaded?.key === key ? loaded.options : undefined;
}
