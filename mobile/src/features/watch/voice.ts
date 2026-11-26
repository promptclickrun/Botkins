// Watch-owned live voice: the iPhone owns the provider/session, while WatchAudioEndpoint owns the
// microphone and speaker route.
import { WatchAudioEndpoint } from "./audio";
import { lastOrNewChat } from "@/features/open/opening";
import { LiveSessionController, type LiveSessionState, companionLiveKit, selectedLiveProvider } from "@/features/voice/live/session";
import { useLiveCall } from "@/features/voice/liveCall";
import type { WatchVoice } from "./model";
import { holdBackgroundLink, syncForPush } from "@/state/link";
import { useApp } from "@/state/store";

type Listener = (voice: WatchVoice) => void;
const listeners = new Set<Listener>();
let controller: LiveSessionController | null = null;
let generation = 0;
let current: WatchVoice = { status: "idle", muted: false, push: false, level: 0 };

function update(next: Partial<WatchVoice>) {
  current = { ...current, ...next };
  for (const listener of listeners) listener(current);
}

export function watchVoiceState() {
  return current;
}

export function subscribeWatchVoice(listener: Listener) {
  listeners.add(listener);
  listener(current);
  return () => void listeners.delete(listener);
}

useLiveCall.subscribe((state) => {
  if (state.call) endWatchVoice("Live voice moved to iPhone.");
});

function sessionCapability(name: string) {
  return !!useApp.getState().parts.meta?.capabilities.includes(name);
}

/** Starts the selected full live provider for the primary Botkin's latest chat. */
export async function startWatchVoice() {
  if (current.status === "connecting" || controller) return;
  const attempt = ++generation;
  update({ status: "connecting", sessionId: undefined, chatId: undefined, problem: undefined });
  const releaseHold = holdBackgroundLink("watch");
  try {
    await connect(attempt);
  } catch (error) {
    if (attempt === generation) endWatchVoice(error instanceof Error ? error.message : "The Watch call could not start.");
  } finally {
    // LiveSessionController acquires its own "watch" hold in start() before connect() returns,
    // so releasing this startup hold keeps the link held for active calls and releases on failure.
    releaseHold();
  }
}

async function connect(attempt: number) {
  if (useLiveCall.getState().call) throw new Error("A live voice call is already open on iPhone. End it there before starting from Watch.");
  // When the phone was backgrounded/locked or cold-woken by WatchConnectivity, the relay socket may
  // have been put to sleep or the initial sync may not have landed yet. Wake and sync before
  // checking bots/voice settings or making RPCs.
  let state = useApp.getState();
  if (!state.booted || !state.pairing || !state.parts.bots?.length || state.link !== "online") {
    await syncForPush(12_000);
    if (generation !== attempt) return;
    state = useApp.getState();
  }
  const computer = state.pairing?.serverId;
  const bot = state.parts.bots?.find((item) => !item.hidden);
  if (!computer || !bot) throw new Error("Pair Botkins with a computer and add a Botkin first.");
  const provider = selectedLiveProvider(bot.id);
  if (!provider) throw new Error("Pick a live voice in Settings › Voice.");
  const chatId = await lastOrNewChat(bot.id);
  if (generation !== attempt || useApp.getState().pairing?.serverId !== computer) return;
  if (!chatId) throw new Error("A chat could not be opened.");
  const id = `watch-${computer}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const watchEndpoint = new WatchAudioEndpoint(id);
  const next = new LiveSessionController({
    chatId,
    botId: bot.id,
    computer,
    provider,
    kit: companionLiveKit(watchEndpoint, watchEndpoint.rtc),
    savesTurns: sessionCapability("voice-turns-v1"),
    savesHistory: sessionCapability("voice-history-v1"),
  });
  controller = next;
  let started = false;
  function publish(state: LiveSessionState) {
    if (attempt !== generation) return;
    if (state.status === "ended") controller = null;
    update({
      status: started || state.status === "ended" ? state.status : "connecting",
      sessionId: state.status === "ended" ? undefined : id,
      chatId: state.status === "ended" ? undefined : chatId,
      muted: state.muted,
      push: state.input === "push",
      level: state.level,
      ...(state.problem ? { problem: state.problem } : { problem: undefined }),
    });
  }
  next.subscribe(publish);
  await next.start();
  started = true;
  publish(next.current);
}

export function muteWatchVoice(muted: boolean) {
  if (!controller) return;
  if (controller.current.muted !== muted) controller.toggleMute();
}

export function interruptWatchVoice() {
  controller?.interrupt();
}

export function pressWatchVoice() {
  controller?.press();
}

export function releaseWatchVoice() {
  controller?.release();
}

export function endWatchVoice(reason?: string) {
  if (!controller && !["connecting", "listening", "thinking", "talking"].includes(current.status)) return;
  generation += 1;
  controller?.end(reason);
  controller = null;
  update({ status: "ended", muted: false, push: false, level: 0, sessionId: undefined, chatId: undefined, ...(reason ? { problem: reason } : { problem: undefined }) });
}
