// Native modules the chat uses that a build may not have yet (speech, the photo and file pickers).
// Each is loaded the first time it is needed, so a build without one still opens chats; the action
// that needs it explains instead.
import { create } from "zustand";
import { showToast } from "@/state/store";

type SpeechModule = typeof import("expo-speech");
type ImagePickerModule = typeof import("expo-image-picker");
type DocumentPickerModule = typeof import("expo-document-picker");

function load<T>(get: () => T): () => T | null {
  let cached: T | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = get();
    } catch {
      cached = null;
    }
    return cached;
  };
}

export const speechModule = load<SpeechModule>(() => require("expo-speech"));
export const imagePickerModule = load<ImagePickerModule>(() => require("expo-image-picker"));
export const documentPickerModule = load<DocumentPickerModule>(() => require("expo-document-picker"));

export const NEEDS_UPDATE = "This needs the newest Botkins app.";

/** What is being read aloud right now, by a key the caller chooses (a message's key). */
export const useSpeaking = create<{ key: string | null }>(() => ({ key: null }));

/** Markdown symbols out of text that is read aloud, and code left out. */
function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " (code) ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/[*_~`|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads a reply aloud, stopping whatever was being read, or after it with `queue`. */
export function speak(text: string, key: string, queue = false) {
  const Speech = speechModule();
  if (!Speech) {
    // Reading on its own stays quiet; a person who asked hears why not.
    if (!queue) showToast(NEEDS_UPDATE, "error");
    return;
  }
  if (!queue) void Speech.stop().catch(() => {});
  const words = spoken(text);
  if (!words) return;
  useSpeaking.setState({ key });
  const done = () => {
    if (useSpeaking.getState().key === key) useSpeaking.setState({ key: null });
  };
  Speech.speak(words, { onDone: done, onStopped: done, onError: done });
}

export function stopSpeaking() {
  useSpeaking.setState({ key: null });
  void speechModule()?.stop().catch(() => {});
}
