// React adapter for the shared live-voice controller. The Watch companion uses the same controller
// with a WatchConnectivity audio endpoint instead of this phone's native duplex endpoint.
import { useEffect, useRef, useState } from "react";
import { Animated, AppState } from "react-native";
import { type AvatarState, useCapability } from "@/state/hooks";
import { showToast, useApp } from "@/state/store";
import { haptic } from "@/ui";
import { useReducedMotion } from "@/ui/BotAvatar";
import { endLiveCall } from "./liveCall";
import { LiveSessionController, type LiveSessionState, phoneLiveKit } from "./live/session";
import type { LiveStatus } from "./live/types";
import { effectiveLive } from "./botVoice";
import { audioModule, keepAwakeModule } from "./native";
import { useVoiceSupported, useVoiceSettings } from "./state";

const UPDATE_APP = "Update the app to use this live voice.";
/** How long an iPhone-owned call may sit in the background. A Watch-owned call uses reachability. */
const BACKGROUND_LIMIT = 30_000;

const AVATAR: Record<LiveStatus, AvatarState> = {
  connecting: "pending",
  listening: "listening",
  thinking: "thinking",
  talking: "talking",
  ended: "idle",
};

const INITIAL: LiveSessionState = {
  status: "connecting",
  problem: null,
  started: false,
  muted: false,
  speaker: true,
  input: "conversation",
  holding: false,
  level: 0,
  metered: false,
  savesTurns: false,
  savesHistory: false,
};

const display = (state: LiveSessionState) => ({
  status: state.status,
  problem: state.problem,
  started: state.started,
  muted: state.muted,
  speaker: state.speaker,
  input: state.input,
  holding: state.holding,
  savesTurns: state.savesTurns,
  savesHistory: state.savesHistory,
});

/**
 * Runs one iPhone-owned call while this hook is mounted. The provider transport, history writer,
 * tools and audio gate live in LiveSessionController, which the Watch can run without this hook.
 */
export function useLiveSession({ chatId, botId, computer }: { chatId: string; botId: string; computer?: string }) {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const own = useApp((state) => state.parts.bots?.find((bot) => bot.id === botId)?.voice?.live);
  const provider = voice ? effectiveLive(voice.live, own).provider : null;
  const savesTurns = useCapability("voice-turns-v1");
  const savesHistory = useCapability("voice-history-v1");
  const request = useApp((state) => state.parts.live?.requests.find((item) => item.chatId === chatId));
  const [state, setState] = useState(display(INITIAL));
  const [levels, setLevels] = useState(false);
  const [level] = useState(() => new Animated.Value(0));
  const controller = useRef<LiveSessionController | null>(null);
  const still = useReducedMotion();
  const stillNow = useRef(true);
  useEffect(() => {
    stillNow.current = still;
  }, [still]);

  const ready = supported && !!computer;
  useEffect(() => {
    if (!ready || !chatId || !botId) return;
    if (!provider) {
      setState(display({ ...INITIAL, problem: "Pick a live voice in Settings › Voice.", status: "ended" }));
      return;
    }
    const kit = phoneLiveKit(async (speaker) => {
      await audioModule()?.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: !speaker }).catch(() => {});
    });
    const next = new LiveSessionController({ chatId, botId, computer, provider, kit, savesTurns, savesHistory });
    controller.current = next;
    let old = display(INITIAL);
    const off = next.subscribe((value) => {
      if (value.metered && !stillNow.current) {
        setLevels(true);
        Animated.timing(level, {
          toValue: Math.min(1, Math.sqrt(value.level) * 1.5),
          duration: 110,
          useNativeDriver: true,
          isInteraction: false,
        }).start();
      }
      const current = display(value);
      if (JSON.stringify(current) !== JSON.stringify(old)) {
        old = current;
        setState(current);
      }
    });
    void next.start();
    return () => {
      off();
      controller.current = null;
      next.end();
      void audioModule()?.setAudioModeAsync({ allowsRecording: false, shouldRouteThroughEarpiece: false }).catch(() => {});
    };
  }, [ready, chatId, botId, provider, savesHistory, savesTurns, computer, level]);

  const keepAwake = ready && state.started && state.status !== "ended";
  useEffect(() => {
    if (!keepAwake) return;
    const module = keepAwakeModule();
    void module?.activateKeepAwakeAsync("live-voice").catch(() => {});
    return () => {
      void module?.deactivateKeepAwake("live-voice").catch(() => {});
    };
  }, [keepAwake]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (!timer) {
        timer = setTimeout(endLiveCall, BACKGROUND_LIMIT);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, []);

  const blocked = !supported ? UPDATE_APP + "." : state.problem;
  const failed = !!blocked && (state.status === "ended" || state.status === "connecting" || !controller.current);
  const live = !failed && !!controller.current && state.status !== "connecting" && state.status !== "ended";
  const over = state.status === "ended" && !blocked;
  useEffect(() => {
    if (over) endLiveCall();
  }, [over]);

  return {
    status: state.status,
    blocked,
    failed,
    live,
    push: state.input === "push",
    holding: state.holding,
    muted: state.muted,
    speaker: state.speaker,
    asking: !!request,
    avatar: (failed ? "error" : request ? "waiting" : state.holding && live ? "listening" : AVATAR[state.status]) as AvatarState,
    savesTurns: state.savesTurns,
    level: levels && !still ? level : undefined,
    toggleMute() {
      if (!controller.current) return showToast(state.problem ?? "The call has not started.", "error");
      controller.current.toggleMute();
    },
    toggleSpeaker() {
      controller.current?.toggleSpeaker();
    },
    talkDown() {
      haptic.tap();
      controller.current?.press();
    },
    talkUp() {
      haptic.select();
      controller.current?.release();
    },
    interrupt() {
      haptic.tap();
      controller.current?.interrupt();
    },
  };
}
