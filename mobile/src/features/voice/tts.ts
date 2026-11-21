// Reading aloud, app-wide: one thing at a time. "This phone" speaks with expo-speech; every other
// provider is asked through the computer (`link.voice.speak`) part by part, each part written to a
// cache file and played in order with expo-audio, at most two parts asked ahead of the one playing.
// If the computer fails part-way, the phone's own voice reads the rest.
import { create } from "zustand";
import type { TtsProvider } from "@/link/types";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { audioModule, fileSystemModule, speechModule } from "./native";
import { effectiveTts } from "./botVoice";
import { usePhoneVoice } from "./prefs";
import { speakable, splitForSpeech } from "./speakable";
import { botVoiceOf, botVoiceSupported, ttsProvider, voiceSettings } from "./state";

export const NEEDS_APP_UPDATE = "This needs the newest Botkins app.";

/** What is being read aloud now, by the id its caller gave, or null. */
export const useSpeakingNow = create<{ id: string | null }>(() => ({ id: null }));

type Job = { id: string; text: string; provider?: TtsProvider; voice?: string; speed?: number; quiet?: boolean; botId?: string };
type Clip = { uri: string; remove(): void };

class Reading {
  stopped = false;
  private clips = new Set<Clip>();
  private stopPlayer: (() => void) | null = null;
  constructor(readonly job: Job) {}

  keep(clip: Clip) {
    this.clips.add(clip);
  }
  drop(clip: Clip) {
    this.clips.delete(clip);
    clip.remove();
  }
  playing(stop: (() => void) | null) {
    this.stopPlayer = stop;
  }
  stop() {
    this.stopped = true;
    this.stopPlayer?.();
    this.stopPlayer = null;
    for (const clip of this.clips) clip.remove();
    this.clips.clear();
  }
}

let current: Reading | null = null;
const waiting: Job[] = [];

/** Sound plays with the ring switch off, and other apps' sound dips while a reply is read. */
async function playbackSession() {
  try {
    await audioModule()?.setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false, interruptionMode: "duckOthers", shouldPlayInBackground: false });
  } catch {
    // The phone keeps its current session.
  }
}

/** The phone's own voice. Resolves when it finished or was stopped. */
function speakOnPhone(reading: Reading, text: string): Promise<void> {
  const Speech = speechModule();
  if (!Speech || !text) return Promise.resolve();
  const { voice, speed } = usePhoneVoice.getState();
  // A bot may read in a system voice of its own on this phone (the choice is saved here: a system voice isn't portable).
  const own = reading.job.botId ? usePhoneVoice.getState().bots?.[reading.job.botId] : undefined;
  const rate = reading.job.provider === "device" && reading.job.speed ? reading.job.speed : (own?.speed ?? speed);
  const chosen = reading.job.provider === "device" && reading.job.voice ? reading.job.voice : (own?.voice ?? voice);
  // Android has a length limit per utterance; the parts are queued by the phone itself.
  const limit = Math.max(200, (Speech.maxSpeechInputLength || 4000) - 100);
  const pieces = text.length > limit ? splitForSpeech(text).flatMap((part) => (part.length > limit ? part.match(new RegExp(".{1," + limit + "}(\\s|$)", "g")) ?? [part] : [part])) : [text];
  return new Promise((resolve) => {
    let left = pieces.length;
    const finished = () => {
      reading.playing(null);
      resolve();
    };
    const done = () => {
      left -= 1;
      if (left <= 0 || reading.stopped) finished();
    };
    reading.playing(() => {
      void Speech.stop().catch(() => {});
      finished();
    });
    for (const piece of pieces) Speech.speak(piece, { voice: chosen, rate, onDone: done, onStopped: finished, onError: done });
  });
}

/** Writes one part's audio to a cache file. */
async function writeClip(index: number, audio: string, format: string): Promise<Clip> {
  const fs = fileSystemModule();
  if (!fs) throw new Error(NEEDS_APP_UPDATE);
  const file = new fs.File(fs.Paths.cache, "botkins-speech-" + Date.now().toString(36) + "-" + index + "." + (format === "wav" ? "wav" : "mp3"));
  file.create({ overwrite: true });
  await file.write(audio, { encoding: "base64" });
  return {
    uri: file.uri,
    remove() {
      try {
        if (file.exists) file.delete();
      } catch {
        // Already gone.
      }
    },
  };
}

/** Plays one file to its end. Rejects when it can't be played. */
function playClip(reading: Reading, clip: Clip): Promise<void> {
  const audio = audioModule();
  if (!audio) return Promise.reject(new Error(NEEDS_APP_UPDATE));
  return new Promise((resolve, reject) => {
    const player = audio.createAudioPlayer(clip.uri, { updateInterval: 250 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      reading.playing(null);
      try {
        player.pause();
        player.remove();
      } catch {
        // Already released.
      }
      if (error) reject(error);
      else resolve();
    };
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.error) finish(new Error("This phone couldn't play that sound."));
      else if (status.didJustFinish) finish();
    });
    reading.playing(() => finish());
    player.play();
  });
}

const sentence = (error: unknown) => (error instanceof Error && error.message ? error.message : "Your computer couldn't read that aloud.");

/** A provider through the computer: parts asked ahead, played in order, the phone's voice if it fails. */
async function speakThroughComputer(reading: Reading, parts: string[]) {
  const { voice, speed, botId } = reading.job;
  const asked: (Promise<Clip> | undefined)[] = [];
  const ask = (index: number) => {
    if (index >= parts.length || asked[index]) return;
    const clip = api["link.voice.speak"]({ text: parts[index]!, voice, speed, ...(botId && { botId }) }).then(async ({ audio, format }) => {
      const written = await writeClip(index, audio, format);
      if (reading.stopped) written.remove();
      else reading.keep(written);
      return written;
    });
    clip.catch(() => {});
    asked[index] = clip;
  };
  for (let index = 0; index < parts.length; index++) {
    if (reading.stopped) return;
    // The one to play and at most two after it.
    ask(index);
    ask(index + 1);
    ask(index + 2);
    try {
      const clip = await asked[index]!;
      if (reading.stopped) return;
      await playClip(reading, clip);
      reading.drop(clip);
    } catch (error) {
      if (reading.stopped) return;
      showToast(sentence(error) + " Reading with this phone's voice.", "error");
      await speakOnPhone(reading, parts.slice(index).join(" "));
      return;
    }
  }
}

async function run(job: Job) {
  const reading = new Reading(job);
  current = reading;
  useSpeakingNow.setState({ id: job.id });
  try {
    const words = speakable(job.text);
    if (words) {
      await playbackSession();
      const provider = job.provider ?? ttsProvider();
      if (provider === "device" || !audioModule() || !fileSystemModule()) await speakOnPhone(reading, words);
      else await speakThroughComputer(reading, splitForSpeech(words));
    }
  } finally {
    reading.stop();
    if (current === reading) {
      current = null;
      const next = waiting.shift();
      if (next) void run(next);
      else useSpeakingNow.setState({ id: null });
    }
  }
}

export type SpeakOptions = {
  /** After what is being read now, instead of stopping it. */
  queue?: boolean;
  /** A provider, voice and speed other than the chosen ones (Settings' "Play sample"). */
  provider?: TtsProvider;
  voice?: string;
  speed?: number;
  /** No toast when this build can't speak at all (reading on its own stays quiet). */
  quiet?: boolean;
  /** The bot speaking: it may have a voice of its own ("bot-voice-v1"), which the computer applies over the shared one. */
  botId?: string;
};

/** Reads `text` (Markdown is cleaned first). Stops what was being read, unless `queue`. */
export function speakText(id: string, text: string, options: SpeakOptions = {}) {
  if (!speechModule() && !audioModule()) {
    if (!options.quiet) showToast(NEEDS_APP_UPDATE, "error");
    return;
  }
  const settings = voiceSettings()?.tts;
  // A bot with a voice of its own: the computer picks the voice and speed (sent with `botId`), so the shared ones aren't sent over them.
  const own = !options.provider && options.botId ? botVoiceOf(options.botId)?.tts : undefined;
  const mine = own && settings ? effectiveTts(settings, own) : undefined;
  const job: Job = {
    id,
    text,
    provider: options.provider ?? (own?.provider ? mine?.provider : undefined),
    // A system voice and speed are this phone's own (above), never the computer's.
    voice: options.voice ?? (options.provider || own?.provider === "device" ? undefined : (mine ?? settings)?.voice),
    speed: options.speed ?? (options.provider || own?.provider === "device" ? undefined : (mine ?? settings)?.speed),
    quiet: options.quiet,
    ...(options.botId && botVoiceSupported() && { botId: options.botId }),
  };
  if (options.queue && current) {
    if (current.job.id !== id && !waiting.some((item) => item.id === id)) waiting.push(job);
    return;
  }
  stopSpeech();
  void run(job);
}

/** Stops everything being read and waiting, at once, and removes the sound files. */
export function stopSpeech() {
  waiting.length = 0;
  const reading = current;
  current = null;
  reading?.stop();
  useSpeakingNow.setState({ id: null });
}

export type PhoneVoice = { id: string; name: string; language: string; quality: "premium" | "enhanced" | "default" };

/** The phone's voices for a language ("en-US" or "en"), best quality first. Novelty voices are left out. */
export async function phoneVoices(language?: string): Promise<PhoneVoice[]> {
  const Speech = speechModule();
  if (!Speech) return [];
  let voices: Awaited<ReturnType<typeof Speech.getAvailableVoicesAsync>> = [];
  try {
    voices = await Speech.getAvailableVoicesAsync();
  } catch {
    return [];
  }
  const wanted = (language ?? "").toLowerCase().replace("_", "-");
  const base = wanted.split("-")[0];
  const matches = (voiceLanguage: string) => {
    const lang = voiceLanguage.toLowerCase().replace("_", "-");
    return !base || lang === wanted || lang.split("-")[0] === base;
  };
  const quality = (identifier: string, given: string): PhoneVoice["quality"] => (/premium/i.test(identifier) ? "premium" : given === "Enhanced" || /enhanced/i.test(identifier) ? "enhanced" : "default");
  const rank = { premium: 0, enhanced: 1, default: 2 };
  return voices
    .filter((voice) => matches(voice.language) && !/speech\.synthesis\.voice|eloquence/i.test(voice.identifier))
    .map((voice) => ({ id: voice.identifier, name: voice.name, language: voice.language, quality: quality(voice.identifier, String(voice.quality)) }))
    .sort((a, b) => rank[a.quality] - rank[b.quality] || (a.language === language ? -1 : 0) - (b.language === language ? -1 : 0) || a.name.localeCompare(b.name));
}

/** The phone's language, such as "en-US". */
export function phoneLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}
