// Dictation into a text field. "This phone" uses the phone's own recognizer (on-device when it can),
// with words as they come. Any other provider records a 16 kHz mono WAV, sends it to the computer
// (`link.voice.transcribe`) when the person stops or after 100 seconds, and delivers the text once.
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { hasSpeech } from "./clip";
import { audioModule, canRecognize, canRecord, fileSystemModule, recognitionModule } from "./native";
import { nextPhrase } from "./speakable";
import { stopSpeech } from "./tts";
import { sttProvider, useSttProvider, voiceSettings } from "./state";

/** The longest recording sent to the computer, in seconds. */
export const MAX_RECORDING = 100;

const MIC_REFUSED = "Allow the microphone and speech recognition for Botkins in the phone's Settings.";
const MIC_ONLY_REFUSED = "Allow the microphone for Botkins in the phone's Settings.";

export type Session = { stop(): void; cancel(): void };
export type Handlers = { onText(text: string, final: boolean): void; setLevel(level: number): void; /** Listening stopped; the text may still come. */ quiet(): void; ended(): void };

/** The phone's recognizer. */
async function startOnPhone(handlers: Handlers): Promise<Session | null> {
  const module = recognitionModule()?.ExpoSpeechRecognitionModule;
  if (!module) return null;
  const permission = await module.requestPermissionsAsync().catch(() => null);
  if (!permission?.granted) {
    showToast(MIC_REFUSED, "error");
    return null;
  }
  let partial = "";
  let closed = false;
  // On-device recognition can fail to start (its language model isn't on the phone yet). Then
  // dictation starts once more through Apple's servers, as the keyboard's own dictation does.
  let onDevice = false;
  let heard = false;
  let restarting = false;
  const language = voiceSettings()?.stt.language;
  const begin = (local: boolean) =>
    module.start({
      lang: language || undefined,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      requiresOnDeviceRecognition: local,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      iosTaskHint: "dictation",
      // What is read aloud afterwards comes out of the speaker, not the earpiece.
      iosCategory: { category: "playAndRecord", categoryOptions: ["defaultToSpeaker", "allowBluetooth"], mode: "default" },
    });
  const subscriptions = [
    module.addListener("result", (event) => {
      heard = true;
      const text = event.results[0]?.transcript ?? "";
      const { done, current } = nextPhrase(partial, text);
      if (done) handlers.onText(done, true);
      if (event.isFinal) {
        if (current) handlers.onText(current, true);
        partial = "";
      } else {
        partial = current;
        handlers.onText(current, false);
      }
    }),
    module.addListener("volumechange", (event) => handlers.setLevel(Math.max(0, Math.min(1, event.value / 10)))),
    module.addListener("error", (event) => {
      // Silence and stopping aren't failures worth a word.
      if (event.error === "no-speech" || event.error === "aborted" || event.error === "speech-timeout") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") showToast(MIC_REFUSED, "error");
      // Nothing was heard yet and the on-device recognizer gave up: the other way is tried, once, when this run has ended.
      else if (onDevice && !heard && !closed) restarting = true;
      else if (event.error === "language-not-supported") showToast("This phone can't take dictation in that language.", "error");
      else showToast("Dictation stopped. Try again.", "error");
    }),
    module.addListener("end", () => {
      if (restarting && !closed) {
        restarting = false;
        onDevice = false;
        try {
          begin(false);
          return;
        } catch {
          showToast("Dictation stopped. Try again.", "error");
        }
      }
      finish();
    }),
  ];
  const finish = () => {
    if (closed) return;
    closed = true;
    if (partial) handlers.onText(partial, true);
    partial = "";
    for (const subscription of subscriptions) subscription.remove();
    handlers.ended();
  };
  try {
    onDevice = module.supportsOnDeviceRecognition();
  } catch {
    onDevice = false;
  }
  try {
    begin(onDevice);
  } catch {
    finish();
    showToast("Dictation couldn't start. Try again.", "error");
    return null;
  }
  return {
    stop: () => {
      try {
        module.stop();
      } catch {
        finish();
      }
    },
    cancel: () => {
      partial = "";
      try {
        module.abort();
      } catch {
        // Already stopped.
      }
      finish();
    },
  };
}

/** Linear PCM on iPhone (16 kHz, mono, 16-bit little-endian, WAV); AAC on Android, which can't write WAV. */
function recordingOptions(audio: NonNullable<ReturnType<typeof audioModule>>) {
  const common = { extension: Platform.OS === "ios" ? ".wav" : ".m4a", sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, isMeteringEnabled: true, directory: "cache" as const };
  if (Platform.OS === "ios")
    return { ...common, outputFormat: audio.IOSOutputFormat.LINEARPCM, audioQuality: audio.AudioQuality.HIGH, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false };
  return { ...common, bitRate: 64000, outputFormat: "mpeg4" as const, audioEncoder: "aac" as const, audioSource: "voice_recognition" as const };
}

/** Records and sends the recording to the computer. */
async function startRecording(handlers: Handlers): Promise<Session | null> {
  const audio = audioModule();
  const fs = fileSystemModule();
  if (!audio || !fs) return null;
  const permission = await audio.requestRecordingPermissionsAsync().catch(() => null);
  if (!permission?.granted) {
    showToast(MIC_ONLY_REFUSED, "error");
    return null;
  }
  await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
  const recorder = new audio.AudioModule.AudioRecorder(recordingOptions(audio));
  try {
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_RECORDING });
  } catch {
    recorder.release();
    await audio.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    showToast("The microphone couldn't start. Try again.", "error");
    return null;
  }
  let closed = false;
  let sending = false;
  const started = Date.now();
  // The loudest level of the recording, so a clip with no speech in it is never sent to be read.
  let peak = 0;
  let metered = false;
  const meter = setInterval(() => {
    let status;
    try {
      status = recorder.getStatus();
    } catch {
      return;
    }
    // Metering is in decibels, about -60 (quiet) to 0 (loud).
    if (typeof status.metering === "number") {
      const level = Math.max(0, Math.min(1, (status.metering + 60) / 60));
      metered = true;
      peak = Math.max(peak, level);
      handlers.setLevel(level);
    }
    // The limit stops the recorder by itself; then the recording is sent.
    if ((!status.isRecording && Date.now() - started > 1000) || Date.now() - started > (MAX_RECORDING + 1) * 1000) void send();
  }, 100);
  const close = async () => {
    clearInterval(meter);
    try {
      await recorder.stop();
    } catch {
      // Already stopped.
    }
    const uri = recorder.uri ?? recorder.getStatus().url;
    recorder.release();
    await audio.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    return uri;
  };
  const remove = (uri: string | null) => {
    if (!uri) return;
    try {
      const file = new fs.File(uri);
      if (file.exists) file.delete();
    } catch {
      // Already gone.
    }
  };
  const send = async () => {
    if (closed || sending) return;
    sending = true;
    handlers.quiet();
    const uri = await close();
    try {
      if (!uri) throw new Error("Nothing was recorded.");
      // A tap, or a clip as quiet as the room: a speech model would make up a word for it. Without metering only the length is known.
      if (!hasSpeech(Date.now() - started, metered ? peak : 1)) return;
      const data = await new fs.File(uri).base64();
      const language = voiceSettings()?.stt.language;
      const { text } = await api["link.voice.transcribe"]({ audio: data, format: Platform.OS === "ios" ? "wav" : "m4a", language: language || undefined });
      if (text.trim()) handlers.onText(text.trim(), true);
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : "Your computer couldn't read that.", "error");
    } finally {
      remove(uri);
      closed = true;
      handlers.ended();
    }
  };
  return {
    stop: () => void send(),
    cancel: () => {
      if (closed) return;
      closed = true;
      void close().then(remove);
      handlers.ended();
    },
  };
}

/** Whether this build can listen with the chosen provider (the phone's recognizer, or a recording for the computer). */
export const canListen = () => (sttProvider() === "device" ? canRecognize() : canRecord());

/** Starts listening with the chosen provider. Resolves to null when it could not start (a toast said why). */
export function listen(handlers: Handlers): Promise<Session | null> {
  stopSpeech();
  return sttProvider() === "device" ? startOnPhone(handlers) : startRecording(handlers);
}

export type DictationState = { available: boolean; listening: boolean; level: number; start(): void; stop(): void };

export function useDictationImpl(options: { onText(text: string, final: boolean): void }): DictationState {
  const provider = useSttProvider();
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const session = useRef<Session | null>(null);
  const starting = useRef(false);
  const onText = useRef(options.onText);
  useEffect(() => {
    onText.current = options.onText;
  });

  // A screen that closes mid-sentence stops listening and throws the rest away.
  useEffect(
    () => () => {
      session.current?.cancel();
      session.current = null;
    },
    [],
  );

  const onPhone = provider === "device";
  const available = onPhone ? canRecognize() : canRecord();

  const start = () => {
    if (session.current || starting.current) return;
    if (!available) {
      showToast(onPhone ? "This phone can't take dictation." : "This needs the newest Botkins app.", "error");
      return;
    }
    starting.current = true;
    stopSpeech();
    const handlers: Handlers = {
      onText: (text, final) => onText.current(text, final),
      setLevel,
      quiet: () => {
        setListening(false);
        setLevel(0);
      },
      ended: () => {
        session.current = null;
        setListening(false);
        setLevel(0);
      },
    };
    void (onPhone ? startOnPhone(handlers) : startRecording(handlers))
      .then((started) => {
        session.current = started;
        setListening(!!started);
      })
      .catch(() => showToast("Dictation couldn't start. Try again.", "error"))
      .finally(() => {
        starting.current = false;
      });
  };
  const stop = () => {
    session.current?.stop();
  };
  return { available, listening, level, start, stop };
}
