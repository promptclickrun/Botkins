// The native modules voice uses, each loaded the first time it is needed. A build without one
// reports it missing (null) instead of crashing, and the feature that needs it says so.
import type { DuplexAudio as DuplexAudioType } from "../../../modules/botkins-audio";

type SpeechRecognitionModule = typeof import("expo-speech-recognition");
type AudioModule = typeof import("expo-audio");
type SpeechModule = typeof import("expo-speech");
type FileSystemModule = typeof import("expo-file-system");
type WebRTCModule = typeof import("react-native-webrtc");
type KeepAwakeModule = typeof import("expo-keep-awake");
export type Duplex = NonNullable<typeof DuplexAudioType>;

function load<T>(get: () => T, check?: (module: T) => boolean): () => T | null {
  let cached: T | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      const module = get();
      cached = !check || check(module) ? module : null;
    } catch {
      cached = null;
    }
    return cached;
  };
}

export const recognitionModule = load<SpeechRecognitionModule>(
  () => require("expo-speech-recognition"),
  (module) => !!module.ExpoSpeechRecognitionModule && typeof module.ExpoSpeechRecognitionModule.start === "function",
);
export const audioModule = load<AudioModule>(() => require("expo-audio"), (module) => typeof module.createAudioPlayer === "function");
export const speechModule = load<SpeechModule>(() => require("expo-speech"));
export const fileSystemModule = load<FileSystemModule>(() => require("expo-file-system"));
export const webrtcModule = load<WebRTCModule>(() => require("react-native-webrtc"), (module) => typeof module.RTCPeerConnection === "function" && !!module.mediaDevices);
export const keepAwakeModule = load<KeepAwakeModule>(() => require("expo-keep-awake"));
export const duplexAudio = load<Duplex>(() => (require("../../../modules/botkins-audio") as typeof import("../../../modules/botkins-audio")).DuplexAudio as Duplex, (module) => !!module);

/** The phone can recognize speech by itself. Asked again at most every 30 seconds. */
let recognizes: { value: boolean; at: number } | null = null;
export function canRecognize(): boolean {
  if (recognizes && Date.now() - recognizes.at < 30_000) return recognizes.value;
  const module = recognitionModule()?.ExpoSpeechRecognitionModule;
  let value = false;
  try {
    value = !!module && module.isRecognitionAvailable();
  } catch {
    value = false;
  }
  recognizes = { value, at: Date.now() };
  return value;
}

/** The phone can record audio to send to the computer. */
export const canRecord = () => !!audioModule() && !!fileSystemModule();
