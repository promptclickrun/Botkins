// Live voice with a bot: full duplex, through the provider chosen in Settings › Voice. The voice model
// is only the bot's voice; what needs doing goes to the bot in its chat (the `ask_bot` tool).
import { router, useLocalSearchParams } from "expo-router";
import { Mic, MicOff, PhoneOff, Speaker, Volume1 } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LiveProvider } from "@/link/types";
import { type AvatarState, useBot, useWatchedChat } from "@/state/hooks";
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import { BotAvatar, Button, IconButton, space, T, useTheme } from "@/ui";
import { RequestPanel } from "../chat/RequestPanel";
import { chatAccess } from "./chatAccess";
import { chatTools, type Kit, type Line, type LiveStatus, type LiveTransport, planFor, socketTransport, webrtcTransport } from "./live/index";
import type { Connect, SocketLike } from "./live/types";
import { audioModule, duplexAudio, keepAwakeModule, webrtcModule } from "./native";
import { UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "./state";
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

export default function Live() {
  const { chatId, botId } = useLocalSearchParams<{ chatId: string; botId: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const bot = useBot(botId);
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const provider = voice?.live.provider ?? null;
  const request = useApp((state) => state.parts.live?.requests.find((item) => item.chatId === chatId));
  useWatchedChat(chatId);

  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [callStarted, setCallStarted] = useState(false);
  const transport = useRef<LiveTransport | null>(null);

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

    const attach = (next: LiveTransport) => {
      held.current = next;
      transport.current = next;
      offs.push(
        next.on("status", setStatus),
        next.on("line", (line) => setLines((held) => [...held.filter((item) => item.id !== line.id), line].slice(-6))),
        next.on("error", (message) => {
          setProblem(message);
          // A problem the call lives through is shown for a moment.
          setTimeout(() => {
            if (!gone && next.status !== "ended") setProblem(null);
          }, 5000);
        }),
      );
    };
    const run = chatTools(chatAccess(chatId));
    void (async () => {
      try {
        if (plan === "offer") {
          const next = webrtcTransport(
            tools,
            async (sdp) => {
              const session = await api["link.voice.live"]({ chatId, botId, provider, sdp });
              sessionId = session.id;
              if (session.kind !== "webrtc") throw new Error(UPDATE_COMPUTER + ".");
              return session;
            },
            run,
          );
          attach(next);
          await next.start();
        } else {
          const session = await api["link.voice.live"]({ chatId, botId, provider });
          sessionId = session.id;
          if (gone) return;
          const next = socketTransport(session, tools, run);
          if (!next) throw new Error(UPDATE_APP);
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
      for (const off of offs) off();
      held.current?.end();
      transport.current = null;
      // A session the computer set up is ended there too, however the screen closed.
      const id = sessionId ?? (held.current as { sessionId?: string | null } | null)?.sessionId;
      if (id) void api["link.voice.endLive"](id).catch(() => {});
      setCallStarted(false);
      void audioModule()?.setAudioModeAsync({ allowsRecording: false, shouldRouteThroughEarpiece: false }).catch(() => {});
    };
  }, [ready, chatId, botId, provider]);

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
    void Promise.resolve(transport.current?.setSpeaker(next)).catch(() => {});
  };

  const blocked = !supported ? UPDATE_COMPUTER + "." : problem;
  const failed = !!blocked && (status === "ended" || status === "connecting" || !transport.current);
  const line = blocked ?? (request ? "Needs you" : muted && status !== "ended" ? "Muted" : statusLine(status));
  const avatar: AvatarState = failed ? "error" : request ? "waiting" : AVATAR[status];

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas, paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.xl }}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md }}>
        <BotAvatar bot={bot} size={180} state={avatar} />
        <T variant="title1" center numberOfLines={1}>
          {bot?.name ?? "Bot"}
        </T>
        <T variant="subhead" color={failed ? "danger" : "muted"} center numberOfLines={2} accessibilityLiveRegion="polite">
          {line}
        </T>
      </View>

      {request ? (
        <RequestPanel request={request} bot={bot} maxHeight={320} />
      ) : (
        <View style={{ minHeight: 120, justifyContent: "flex-end", gap: space.sm, paddingBottom: space.lg }} accessibilityLabel="Transcript">
          {lines.slice(-4).map((item) => (
            <T key={item.id} variant={item.who === "bot" ? "body" : "callout"} color={item.who === "bot" ? "ink" : "muted"} numberOfLines={3}>
              {item.text.trim()}
            </T>
          ))}
        </View>
      )}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: space.md }}>
        <IconButton icon={muted ? MicOff : Mic} variant="soft" size={56} label={muted ? "Unmute" : "Mute"} onPress={toggleMute} disabled={failed} />
        <Button title="End" icon={PhoneOff} variant="danger" onPress={close} accessibilityLabel="End live voice" />
        <IconButton icon={speaker ? Speaker : Volume1} variant="soft" size={56} label={speaker ? "Use the earpiece" : "Use the speaker"} onPress={toggleSpeaker} disabled={failed} />
      </View>
    </View>
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
