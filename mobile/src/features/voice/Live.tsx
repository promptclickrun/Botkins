// Live voice with a bot: full duplex, through the provider chosen in Settings › Voice. The voice model
// is only the bot's voice; what needs doing goes to the bot in its chat (the `ask_bot` tool).
// How the phone listens is this phone's choice (`liveInput`, read when the call starts): hands-free,
// where a tap stops the bot while it talks, or push to talk, where one large button is held to talk.
import { router, useLocalSearchParams } from "expo-router";
import { Hand, Mic, MicOff, PhoneOff, Speaker, Volume1 } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LiveProvider } from "@/link/types";
import { type AvatarState, useBot, useCapability, useWatchedChat } from "@/state/hooks";
import { loadDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";
import { api } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { AvatarMotion, BotAvatar, Button, haptic, IconButton, slopFor, space, T, Tap, useTheme } from "@/ui";
import { RequestPanel } from "../chat/RequestPanel";
import { chatAccess } from "./chatAccess";
import { VoiceCanvas } from "./VoiceCanvas";
import { VoiceTurns } from "../../../link-host/voice-history.mjs";
import { type SpokenLine, updateSpoken, VoiceHistoryWriter } from "./live/history";
import { liveContext } from "./live/context";
import { chatTools, type Kit, type Line, type LiveStatus, type LiveTransport, planFor, socketTransport, webrtcTransport } from "./live/index";
import type { Connect, InputMode, SocketLike } from "./live/types";
import { readLocation } from "./location";
import { audioModule, duplexAudio, keepAwakeModule, webrtcModule } from "./native";
import { loadPhoneVoice, usePhoneVoice } from "./prefs";
import { botVoiceOf, UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "./state";
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

/** The main control's size: one large round button. */
const MAIN = 96;

const AVATAR: Record<LiveStatus, AvatarState> = { connecting: "pending", listening: "listening", thinking: "thinking", talking: "talking", ended: "idle" };

function LiveScreen() {
  const { chatId, botId } = useLocalSearchParams<{ chatId: string; botId: string }>();
  const computer = useApp(state => state.pairing?.serverId);
  return <LiveCall key={JSON.stringify([computer, chatId, botId])} chatId={chatId} botId={botId} computer={computer} />;
}

function LiveCall({ chatId, botId, computer }: { chatId: string; botId: string; computer?: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const bot = useBot(botId);
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  // This bot's own live voice, when it has one, over the shared choice (the computer applies it to the call).
  const provider = voice ? effectiveLive(voice.live, botVoiceOf(botId)?.live).provider : null;
  const request = useApp((state) => state.parts.live?.requests.find((item) => item.chatId === chatId));
  const chat = useWatchedChat(chatId);
  const savesTurns = useCapability("voice-turns-v1");
  const savesHistory = useCapability("voice-history-v1");

  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [problem, setProblem] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<SpokenLine[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [callStarted, setCallStarted] = useState(false);
  const [input, setInputMode] = useState<InputMode>(() => usePhoneVoice.getState().liveInput);
  const [holding, setHolding] = useState(false);
  const transport = useRef<LiveTransport | null>(null);
  const pressing = useRef(false);
  const speakerOn = useRef(true);

  // One session per visit. It is set up once the settings are known, and always ended on the computer.
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
      const snapshot = { ...line, id: sessionId + ":" + line.id };
      const state = useApp.getState();
      const at = state.chats[chatId]?.total ?? state.parts.chats?.find(chat => chat.id === chatId)?.count ?? 0;
      if (!gone) setSpoken(current => updateSpoken(current, snapshot, at));
      if (line.who === "you" && savesHistory) {
        lastSpeech = snapshot;
        writer.put(snapshot);
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
          // screen shows is applied once it has.
          if (plan === "offer" && !routed && value !== "connecting" && value !== "ended") {
            routed = true;
            void tools.route(speakerOn.current);
          }
        }),
        next.on("line", heard),
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
      // A session the computer set up is ended there too, however the screen closed.
      const id = sessionId ?? (held.current as { sessionId?: string | null } | null)?.sessionId;
      if (id) endSession(id);
      setCallStarted(false);
      void audioModule()?.setAudioModeAsync({ allowsRecording: false, shouldRouteThroughEarpiece: false }).catch(() => {});
    };
  }, [ready, chatId, botId, provider, savesHistory, savesTurns, computer]);

  // The phone stays awake while a call is being set up or is on. A call that ended or never started
  // leaves the screen open with its message, and the phone may sleep.
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
      } else if (!timer) {
        timer = setTimeout(() => {
          transport.current?.end();
          if (router.canGoBack()) router.back();
        }, BACKGROUND_LIMIT);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, []);

  const close = () => {
    transport.current?.end();
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    transport.current?.mute(next);
  };
  const toggleSpeaker = () => {
    const next = !speaker;
    setSpeaker(next);
    speakerOn.current = next;
    void Promise.resolve(transport.current?.setSpeaker(next)).catch(() => {});
  };

  // Push to talk: the button down stops the bot and listens; up sends the turn.
  const talkDown = () => {
    if (pressing.current) return;
    pressing.current = true;
    setHolding(true);
    haptic.tap();
    transport.current?.press();
  };
  const talkUp = () => {
    if (!pressing.current) return;
    pressing.current = false;
    setHolding(false);
    haptic.select();
    transport.current?.release();
  };
  const interrupt = () => {
    haptic.tap();
    transport.current?.interrupt();
  };

  const blocked = !supported ? UPDATE_COMPUTER + "." : problem;
  const failed = !!blocked && (status === "ended" || status === "connecting" || !transport.current);
  const live = !failed && status !== "connecting" && status !== "ended";
  const push = input === "push";
  const line = blocked ?? (request ? "Needs you" : holding && live ? "Listening… release to send" : muted && status !== "ended" ? "Muted" : push && status === "listening" ? "Hold to talk" : statusLine(status));
  const avatar: AvatarState = failed ? "error" : request ? "waiting" : holding && live ? "listening" : AVATAR[status];

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas, paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.xl }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <BotAvatar bot={bot} size={52} state={avatar} />
        <View style={{ flex: 1 }}>
          <T variant="title2" numberOfLines={1}>{bot?.name ?? "Bot"}</T>
          <T variant="subhead" color={failed ? "danger" : "muted"} numberOfLines={2} accessibilityLiveRegion="polite">{line}</T>
        </View>
      </View>

      <VoiceCanvas chatId={chatId} chat={chat} spoken={spoken} />
      {supported && !savesHistory && <T variant="footnote" color="muted">Update the app on your computer to save voice messages in this chat.</T>}
      {request && <RequestPanel request={request} bot={bot} maxHeight={260} />}
      <View style={{ height: MAIN, alignItems: "center", justifyContent: "center" }}>
        {push ? (
          <TalkButton holding={holding} disabled={!live} onDown={talkDown} onUp={talkUp} />
        ) : live && status === "talking" ? (
          <IconButton icon={Hand} variant="accent" size={MAIN} label="Interrupt" onPress={interrupt} />
        ) : null}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: space.md }}>
        {push ? <View style={{ width: 56 }} /> : <IconButton icon={muted ? MicOff : Mic} variant="soft" size={56} label={muted ? "Unmute" : "Mute"} onPress={toggleMute} disabled={failed} />}
        <Button title="End" icon={PhoneOff} variant="danger" onPress={close} accessibilityLabel="End live voice" />
        <IconButton icon={speaker ? Speaker : Volume1} variant="soft" size={56} label={speaker ? "Use the earpiece" : "Use the speaker"} onPress={toggleSpeaker} disabled={failed} />
      </View>
    </View>
  );
}

/**
 * Hold to talk. VoiceOver can't hold easily, so its activation starts on one double tap and sends
 * on the next.
 */
function TalkButton({ holding, disabled, onDown, onUp }: { holding: boolean; disabled: boolean; onDown: () => void; onUp: () => void }) {
  const { colors } = useTheme();
  return (
    <Tap
      feel="none"
      sink={0.92}
      disabled={disabled}
      onPressIn={onDown}
      onPressOut={onUp}
      accessibilityLabel={holding ? "Send" : "Hold to talk"}
      accessibilityHint="Hold while you talk, and let go to send. With VoiceOver, double tap to start and double tap again to send."
      accessibilityState={{ selected: holding, disabled }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName !== "activate") return;
        if (holding) onUp();
        else onDown();
      }}
      hitSlop={slopFor(MAIN)}
      style={{ width: MAIN, height: MAIN, borderRadius: MAIN / 2, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: holding ? colors.accentSoft : "transparent" }}
    >
      <Mic size={40} color={colors.onAccent} strokeWidth={2.2} />
    </Tap>
  );
}

function statusLine(status: LiveStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "listening":
      return "Listening";
    case "thinking":
      return "Working on it…";
    case "talking":
      return "Speaking";
    default:
      return "Call ended";
  }
}

/** Avatars move on this screen (see `AvatarMotion`). */
export default function Live() {
  return (
    <AvatarMotion>
      <LiveScreen />
    </AvatarMotion>
  );
}
