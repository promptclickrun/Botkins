// One live voice call with a bot: full duplex, through the provider chosen in Settings › Voice. The
// voice model is only the bot's voice; what needs doing goes to the bot in its chat (the `ask_bot`
// tool), and what is said is saved to the chat by the computer, so the chat shows the call.
// How the phone listens is this phone's choice (`liveInput`, read when the call starts): hands-free,
// where a tap on the bot stops it while it talks, or push to talk, where the sound strip is held to talk.
import { useEffect, useRef, useState } from "react";
import { Animated, AppState } from "react-native";
import type { LiveProvider } from "@/link/types";
import { type AvatarState, useCapability } from "@/state/hooks";
import { loadDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";
import { api } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { haptic } from "@/ui";
import { useReducedMotion } from "@/ui/BotAvatar";
import { chatAccess } from "./chatAccess";
import { VoiceTurns } from "../../../link-host/voice-history.mjs";
import { VoiceHistoryWriter } from "./live/history";
import { liveContext } from "./live/context";
import { chatTools, type Kit, type Line, type LiveStatus, type LiveTransport, planFor, socketTransport, webrtcTransport } from "./live/index";
import type { Connect, InputMode, SocketLike } from "./live/types";
import { endLiveCall } from "./liveCall";
import { readLocation } from "./location";
import { audioModule, duplexAudio, keepAwakeModule, webrtcModule } from "./native";
import { loadPhoneVoice, usePhoneVoice } from "./prefs";
import { botVoiceOf, UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported, voiceSettings } from "./state";
import { effectiveLive } from "./botVoice";
import { stopSpeech } from "./tts";

const UPDATE_APP = "Update the app to use this live voice.";
/** How long the app may sit in the background before the call ends. */
const BACKGROUND_LIMIT = 30_000;

const connect: Connect = (url, protocols, headers) => {
  // React Native's WebSocket takes headers in a third argument.
  const NativeSocket = WebSocket as unknown as new (url: string, protocols?: string[] | null, options?: { headers: Record<string, string> } | null) => SocketLike & { binaryType: string };
  const socket = new NativeSocket(url, protocols ?? null, headers ? { headers } : null);
  // Some providers send JSON in binary frames; bytes are easier to read than a Blob.
  socket.binaryType = "arraybuffer";
  return socket;
};

function kit(): Kit {
  return {
    webrtc: webrtcModule(),
    duplex: duplexAudio(),
    connect,
    route: async (speaker) => {
      await audioModule()
        ?.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: !speaker })
        .catch(() => {});
    },
  };
}

const AVATAR: Record<LiveStatus, AvatarState> = { connecting: "pending", listening: "listening", thinking: "thinking", talking: "talking", ended: "idle" };

/**
 * Runs the call for as long as the component that calls it is mounted, and ends it on the computer
 * however that component goes away. Used once, by the chat's voice dock.
 */
export function useLiveSession({ chatId, botId, computer }: { chatId: string; botId: string; computer?: string }) {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  // This bot's own live voice, when it has one, over the shared choice (the computer applies it to the call).
  const provider = voice ? effectiveLive(voice.live, botVoiceOf(botId)?.live).provider : null;
  const request = useApp((state) => state.parts.live?.requests.find((item) => item.chatId === chatId));
  const savesTurns = useCapability("voice-turns-v1");
  const savesHistory = useCapability("voice-history-v1");

  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [problem, setProblem] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [callStarted, setCallStarted] = useState(false);
  const [input, setInputMode] = useState<InputMode>(() => usePhoneVoice.getState().liveInput);
  const [holding, setHolding] = useState(false);
  // How loud whoever has the sound is, for the dock's sound strip. It is an animated value moved on
  // the native side, so the sound never re-renders the dock. With Reduce Motion it stays where it is.
  const [level] = useState(() => new Animated.Value(0));
  const [levels, setLevels] = useState(false);
  const still = useReducedMotion();
  const stillNow = useRef(true);
  useEffect(() => {
    stillNow.current = still;
  }, [still]);
  const transport = useRef<LiveTransport | null>(null);
  const pressing = useRef(false);
  const speakerOn = useRef(true);

  // One session per call. It is set up once the settings are known, and always ended on the computer.
  const ready = supported && !!voice;
  useEffect(() => {
    if (!ready || !chatId || !botId) return;
    if (!provider) {
      setProblem("Pick a live voice in Settings › Voice.");
      return;
    }
    const tools = kit();
    const plan = planFor(provider as LiveProvider, tools);
    if (!plan) {
      setProblem(UPDATE_APP);
      return;
    }
    let gone = false;
    let sessionId: string | null = null;
    const held: { current: LiveTransport | null } = { current: null };
    const offs: (() => void)[] = [];
    stopSpeech();
    setCallStarted(true);

    const sameComputer = () => useApp.getState().pairing?.serverId === computer;
    const writer = new VoiceHistoryWriter(
      async line => {
        if (!sameComputer()) throw new Error("Computer changed.");
        if (line.who === "bot" && sessionId) {
          await api.recordVoiceLine(chatId, line.id, line.text, line.final, { role: "assistant", sessionId, afterVoiceId: line.afterVoiceId });
        } else await api.recordVoiceLine(chatId, line.id, line.text, line.final);
      },
      () => showToast("Couldn't save a voice message to this chat.", "error"),
    );
    let turns: VoiceTurns | undefined;
    const history = () => turns ??= new VoiceTurns(sessionId!);
    let lastSpeech: Line | undefined;
    let claimed: string | undefined;
    const heard = (line: Line) => {
      // Codex sends its transcript to the computer. Its watched chat already carries those words.
      if (!sessionId || (provider === "codex" && (savesTurns || line.who === "you" && savesHistory))) return;
      if (savesTurns) {
        const turn = history();
        if (line.who === "you") writer.put({ ...line, id: turn.input("input-" + line.id) });
        else {
          const { afterVoiceId } = turn.output(line.id);
          writer.put({ ...line, id: sessionId + ":output-" + line.id, afterVoiceId });
          if (line.final) turn.finishOutput(line.id);
        }
        return;
      }
      // An older computer saves only what the person said.
      if (line.who === "you" && savesHistory) {
        lastSpeech = { ...line, id: sessionId + ":" + line.id };
        writer.put(lastSpeech);
      }
    };
    const endSession = (id: string) => {
      void writer.flush().then(() => {
        if (sameComputer()) return api["link.voice.endLive"](id);
      }).catch(() => {});
    };
    let routed = false;
    const attach = (next: LiveTransport) => {
      held.current = next;
      transport.current = next;
      offs.push(
        next.on("status", (value) => {
          setStatus(value);
          // WebRTC sets up its own sound when the call connects, on the earpiece: the route the
          // dock shows is applied once it has.
          if (plan === "offer" && !routed && value !== "connecting" && value !== "ended") {
            routed = true;
            void tools.route(speakerOn.current);
          }
        }),
        next.on("line", heard),
        next.on("level", (value) => {
          if (stillNow.current) return;
          setLevels(true);
          // Speech is quiet as a number: the root spreads it over the strip's height.
          Animated.timing(level, { toValue: Math.min(1, Math.sqrt(value) * 1.5), duration: 110, useNativeDriver: true, isInteraction: false }).start();
        }),
        next.on("inputItem", item => {
          if (sessionId && savesTurns && provider !== "codex") history().start("input-" + item);
        }),
        next.on("error", (message) => {
          setProblem(message);
          // A problem the call lives through is shown for a moment.
          setTimeout(() => {
            if (!gone && next.status !== "ended") setProblem(null);
          }, 5000);
        }),
      );
    };
    const run = chatTools(chatAccess(chatId), undefined, text => {
      if (savesTurns && sessionId) return history().claim();
      if (!lastSpeech || lastSpeech.id === claimed || lastSpeech.text.trim() !== text.trim()) return;
      claimed = lastSpeech.id;
      return claimed;
    });
    // Roughly where the person is, only with Location on in Device access. Looked for from the
    // start, alongside the rest, and given up on quickly (live/context.ts).
    const where = loadDevicePrefs()
      .then(() => liveContext(useDevicePrefs.getState().sources, readLocation))
      .catch(() => undefined);
    void (async () => {
      try {
        // How this phone listens, as saved when the call starts.
        await loadPhoneVoice();
        const mode = usePhoneVoice.getState().liveInput;
        if (gone) return;
        setInputMode(mode);
        if (plan === "offer") {
          const next = webrtcTransport(
            tools,
            async (sdp) => {
              const context = await where;
              if (gone || !sameComputer()) throw new Error("The call has ended.");
              const session = await api["link.voice.live"]({ chatId, botId, provider, sdp, ...(context && { context }) });
              sessionId = session.id;
              if (gone) endSession(session.id);
              if (session.kind !== "webrtc") throw new Error(UPDATE_COMPUTER + ".");
              return session;
            },
            run,
            voiceSettings()?.stt.language,
          );
          next.setInput(mode);
          attach(next);
          await next.start();
        } else {
          const context = await where;
          if (gone || !sameComputer()) return;
          const session = await api["link.voice.live"]({ chatId, botId, provider, ...(context && { context }) });
          sessionId = session.id;
          if (gone) return endSession(session.id);
          const next = socketTransport(session, tools, run);
          if (!next) throw new Error(UPDATE_APP);
          next.setInput(mode);
          attach(next);
          await next.start();
        }
      } catch (error) {
        if (gone) return;
        setProblem(error instanceof Error && error.message ? error.message : "Live voice couldn't start.");
        held.current?.end();
        setStatus("ended");
      }
    })();

    return () => {
      gone = true;
      held.current?.end();
      for (const off of offs) off();
      transport.current = null;
      // A session the computer set up is ended there too, however the dock went away.
      const id = sessionId ?? (held.current as { sessionId?: string | null } | null)?.sessionId;
      if (id) endSession(id);
      setCallStarted(false);
      void audioModule()?.setAudioModeAsync({ allowsRecording: false, shouldRouteThroughEarpiece: false }).catch(() => {});
    };
  }, [ready, chatId, botId, provider, savesHistory, savesTurns, computer]);

  // The phone stays awake while a call is being set up or is on. A call that never started leaves
  // the dock open with its message, and the phone may sleep.
  const keepAwake = ready && callStarted && status !== "ended";
  useEffect(() => {
    if (!keepAwake) return;
    const module = keepAwakeModule();
    void module?.activateKeepAwakeAsync("live-voice").catch(() => {});
    return () => {
      void module?.deactivateKeepAwake("live-voice").catch(() => {});
    };
  }, [keepAwake]);

  // In the background for long, the call ends.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (!timer) timer = setTimeout(endLiveCall, BACKGROUND_LIMIT);
    });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, []);

  const blocked = !supported ? UPDATE_COMPUTER + "." : problem;
  const failed = !!blocked && (status === "ended" || status === "connecting" || !transport.current);
  const live = !failed && status !== "connecting" && status !== "ended";

  // A call the provider ended, with nothing to say about it, closes its dock.
  const over = status === "ended" && !blocked;
  useEffect(() => {
    if (over) endLiveCall();
  }, [over]);

  return {
    status,
    /** What stopped the call or is wrong with it, as a sentence. */
    blocked,
    /** The call never started or has stopped: only the message and Close are left. */
    failed,
    /** Connected: the controls work. */
    live,
    push: input === "push",
    holding,
    muted,
    speaker,
    /** The bot is asking the person something on the screen. */
    asking: !!request,
    avatar: (failed ? "error" : request ? "waiting" : holding && live ? "listening" : AVATAR[status]) as AvatarState,
    /** The computer saves both sides of the call to the chat. */
    savesTurns,
    /** The sound's level, 0 to 1, once the call reports one and the phone allows motion; else undefined. */
    level: levels && !still ? level : undefined,
    toggleMute() {
      setMuted(!muted);
      transport.current?.mute(!muted);
    },
    toggleSpeaker() {
      const next = !speaker;
      setSpeaker(next);
      speakerOn.current = next;
      void Promise.resolve(transport.current?.setSpeaker(next)).catch(() => {});
    },
    // Push to talk: the strip down stops the bot and listens; up sends the turn.
    talkDown() {
      if (pressing.current) return;
      pressing.current = true;
      setHolding(true);
      haptic.tap();
      transport.current?.press();
    },
    talkUp() {
      if (!pressing.current) return;
      pressing.current = false;
      setHolding(false);
      haptic.select();
      transport.current?.release();
    },
    interrupt() {
      haptic.tap();
      transport.current?.interrupt();
    },
  };
}
