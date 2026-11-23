// iPhone side of the Apple Watch companion. WatchConnectivity carries bounded state and controls;
// live PCM is accepted only for the active voice session.
import { type EventSubscription, requireOptionalNativeModule } from "expo-modules-core";
import type { WatchCommand } from "@/features/watch/model";

export type WatchAudioFrame = { sessionId: string; data: string; level: number; sequence: number };
export type WatchReachability = { reachable: boolean; paired: boolean; installed: boolean };

type Native = {
  start(): Promise<void>;
  update(snapshot: string): Promise<void>;
  clear(): Promise<void>;
  voiceStarted(sessionId: string, inputRate: number, outputRate: number): Promise<void>;
  voiceEnded(sessionId: string, reason: string | null): Promise<void>;
  play(sessionId: string, pcm16: string): void;
  flush(sessionId: string): void;
  rtcStart(sessionId: string): Promise<string>;
  rtcAnswer(sessionId: string, sdp: string): Promise<void>;
  rtcSend(sessionId: string, message: string): void;
  rtcInput(sessionId: string, enabled: boolean): void;
  rtcFlush(sessionId: string): void;
  rtcEnd(sessionId: string): Promise<void>;
  addListener(name: "command", listener: (event: { command: WatchCommand; revision?: number; sessionId?: string }) => void): EventSubscription;
  addListener(name: "frame", listener: (event: WatchAudioFrame) => void): EventSubscription;
  addListener(name: "reachability", listener: (event: WatchReachability) => void): EventSubscription;
  addListener(name: "output", listener: (event: { sessionId: string; level: number }) => void): EventSubscription;
  addListener(name: "interrupted", listener: (event: { sessionId: string; began: boolean; failed?: boolean }) => void): EventSubscription;
  addListener(name: "rtcMessage", listener: (event: { sessionId: string; message: string }) => void): EventSubscription;
  addListener(name: "rtcState", listener: (event: { sessionId: string; state: "open" | "connected" | "failed" | "closed" }) => void): EventSubscription;
  addListener(name: "rtcLevel", listener: (event: { sessionId: string; mic: number; output: number }) => void): EventSubscription;
  addListener(name: "rtcInterrupted", listener: (event: { sessionId: string; failed?: boolean }) => void): EventSubscription;
};

export const WatchCompanion = requireOptionalNativeModule<Native>("BotkinsWatch");
