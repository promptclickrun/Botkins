// Two-way audio for live voice (iPhone): the microphone as small pieces of sound, and a speaker
// queue to play the answer, with the phone's echo cancelling on, so the bot does not hear itself.
// Sound is 16-bit mono PCM, base64, at the rates asked for. The native half is
// ios/BotkinsAudioModule.swift; a build without it has `DuplexAudio === null`.
import { type EventSubscription, requireOptionalNativeModule } from "expo-modules-core";

export type AudioFrame = {
  /** Base64 of 16-bit little-endian mono PCM at the input rate, about 40 ms of it. */
  data: string;
  /** How loud it is, 0 to 1, for a level meter. */
  level: number;
};
export type DuplexOptions = {
  /** The microphone's rate, such as 16000 or 24000. */
  inputRate: number;
  /** The rate of the sound given to `play`. */
  outputRate: number;
  /** Use the phone speaker or the connected call accessory / earpiece. */
  speaker?: boolean;
};

type Native = {
  /** Asks for the microphone if it has to, then starts both ways. Rejects with a plain sentence when the microphone is refused. */
  start(options: DuplexOptions): Promise<void>;
  /** Queues sound to play, in order. */
  play(base64: string): void;
  /** Drops everything queued and playing: the person started talking. */
  flush(): void;
  /** While muted no frames are sent. */
  setMuted(muted: boolean): void;
  /** Moves the sound to the speaker or the earpiece while a call is under way. */
  setSpeaker(on: boolean): void;
  stop(): Promise<void>;
  addListener(name: "frame", listener: (frame: AudioFrame) => void): EventSubscription;
  /** How loud what is playing is, 0 to 1, a few times a second. */
  addListener(name: "output", listener: (event: { level: number }) => void): EventSubscription;
  /** The system took the sound away (a phone call) or gave it back. `failed`: the sound could not be kept going, and the call is over. */
  addListener(name: "interrupted", listener: (event: { began: boolean; failed?: boolean }) => void): EventSubscription;
};

type CallRoutes = {
  accessory(): string | null;
  addListener(name: "devicesChanged", listener: () => void): EventSubscription;
  // WebRTC call routing. Socket calls configure the duplex engine directly.
  setSpeaker?(speaker: boolean): void;
  endCall?(): void;
};

export const callRoutes = requireOptionalNativeModule<CallRoutes>("BotkinsCallRoutes");

export const DuplexAudio = requireOptionalNativeModule<Native>("BotkinsAudio");
