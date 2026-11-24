// The voice dock: a chat's message box, turned into its live voice call. The bot stands on the
// dock's top edge, large; under it one line says what is happening, then the controls: the keyboard
// (back to typing, the call goes on), Mute, the sound strip, Speaker and End. The chat above stays
// as it is and shows what is said. In push to talk the sound strip is the button and Mute is gone,
// because the microphone is open only while the strip is held.
import { Keyboard, Mic, MicOff, PhoneOff, Speaker, Volume1 } from "lucide-react-native";
import { useEffect } from "react";
import { Animated, View } from "react-native";
import { useBot } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, IconButton, radius, space, T, Tap, useTheme } from "@/ui";
import { endLiveCall, setLiveTyping, useLiveCall } from "./liveCall";
import type { LiveStatus } from "./live/types";
import { useLiveSession } from "./useLiveSession";

/** The bot on the dock, and how far it stands above the dock's top edge. */
const AVATAR = 112;
const RISE = AVATAR / 2;
/** Every control in the dock's row. */
const CONTROL = 44;

const WAVE = [4, 8, 14, 22, 16, 10, 18, 26, 20, 12, 6, 16, 24, 28, 18, 8, 12, 20, 14, 6, 4];
const CALM = WAVE.map((height) => Math.max(4, Math.round(height / 3)));

/**
 * The sound strip. Its color says who has the sound, and its bars rise with how loud that sound is
 * (`level`, moved on the native side: no render per sound). Without a level (Reduce Motion, or a
 * call that reports none) it holds one still shape per state: tall for a voice, low while the
 * microphone waits. With no sound to show it is flat.
 */
function SoundStrip({ shape, color, bars = WAVE.length, level }: { shape: "voice" | "open" | "quiet"; color: string; bars?: number; level?: Animated.Value }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, height: 28, overflow: "hidden" }}>
      {WAVE.slice(0, bars).map((height, i) =>
        level && shape !== "quiet" ? (
          <Animated.View key={i} style={{ width: 3, height, borderRadius: 2, backgroundColor: color, transform: [{ scaleY: level.interpolate({ inputRange: [0, 1], outputRange: [4 / height, 1], extrapolate: "clamp" }) }] }} />
        ) : (
          <View key={i} style={{ width: 3, borderRadius: 2, backgroundColor: color, height: shape === "voice" ? height : shape === "open" ? CALM[i] : 4 }} />
        ),
      )}
    </View>
  );
}

/**
 * Push to talk: the sound strip, held. VoiceOver can't hold easily, so its activation starts on one
 * double tap and sends on the next.
 */
function HoldStrip({ holding, disabled, level, onDown, onUp }: { holding: boolean; disabled: boolean; level?: Animated.Value; onDown: () => void; onUp: () => void }) {
  const { colors } = useTheme();
  const ink = holding ? colors.onAccent : colors.ink;
  return (
    <Tap
      feel="none"
      sink={0.97}
      disabled={disabled}
      onPressIn={onDown}
      onPressOut={onUp}
      testID="voice-hold"
      accessibilityLabel={holding ? "Send" : "Hold to talk"}
      accessibilityHint="Hold while you talk, and let go to send. With VoiceOver, double tap to start and double tap again to send."
      accessibilityState={{ selected: holding, disabled }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName !== "activate") return;
        if (holding) onUp();
        else onDown();
      }}
      style={{ flex: 1, height: 56, borderRadius: 28, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.md, backgroundColor: holding ? colors.accent : colors.sunken, borderWidth: 4, borderColor: holding ? colors.accentSoft : "transparent" }}
    >
      <SoundStrip shape={holding ? "voice" : "quiet"} color={ink} bars={7} level={level} />
      <T variant="subhead" weight="600" color={ink} numberOfLines={1} style={{ flexShrink: 1 }}>
        {holding ? "Let go to send" : "Hold to talk"}
      </T>
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

function Dock({ chatId, botId, computer, typing }: { chatId: string; botId: string; computer?: string; typing: boolean }) {
  const { colors } = useTheme();
  const bot = useBot(botId);
  const call = useLiveSession({ chatId, botId, computer });
  const name = bot?.name ?? "the bot";
  // Hands-free, a tap on the bot stops it while it talks.
  const interruptible = call.live && !call.push && call.status === "talking";
  const line =
    call.blocked ??
    (call.asking ? "Needs you"
      : call.holding && call.live ? "Listening to you"
      : call.muted ? "Muted"
      : call.push && call.status === "listening" ? "Your turn"
      : interruptible && !typing ? "Speaking · tap " + name + " to interrupt"
      : statusLine(call.status));

  // The message box is back: the call goes on, as one quiet row above the box that opens the dock again.
  if (typing)
    return (
      <Tap onPress={() => setLiveTyping(false)} testID="voice-dock-row" accessibilityLabel={"Live voice with " + name + ". " + line + ". Show the call"} style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface }}>
        <BotAvatar bot={bot} size={28} state={call.avatar} />
        <T variant="subhead" color={call.failed ? "danger" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
          {line}
        </T>
        <SoundStrip shape={call.status === "talking" ? "voice" : call.live && !call.muted ? "open" : "quiet"} color={call.status === "talking" ? colors.accent : call.live && !call.muted ? colors.success : colors.lineStrong} bars={7} level={call.level} />
      </Tap>
    );

  const face = <BotAvatar bot={bot} size={AVATAR} state={call.avatar} />;
  const speaking = call.status === "talking";
  const open = call.live && !call.muted && call.status === "listening";
  return (
    // The room above the dock is the bot's: the chat ends over its head.
    <View testID="voice-dock" style={{ paddingTop: RISE + space.xs }}>
      <View style={{ backgroundColor: colors.surface, borderRadius: 32, borderWidth: 1, borderColor: colors.line, paddingTop: RISE + space.xs, paddingHorizontal: space.sm, paddingBottom: space.sm, alignItems: "center", gap: space.sm }}>
        <T variant="subhead" color={call.failed ? "danger" : "muted"} center numberOfLines={3} accessibilityLiveRegion="polite" style={{ paddingHorizontal: space.sm }}>
          {line}
        </T>
        {!call.savesTurns && !call.failed && (
          <T variant="footnote" color="muted" center>
            Update the app on your computer to save the whole call in this chat.
          </T>
        )}
        <View style={{ alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <IconButton icon={Keyboard} variant="soft" size={CONTROL} label="Type a message" onPress={() => setLiveTyping(true)} />
          {call.failed ? (
            <View style={{ flex: 1 }} />
          ) : call.push ? (
            <HoldStrip holding={call.holding} disabled={!call.live} level={call.level} onDown={call.talkDown} onUp={call.talkUp} />
          ) : (
            <>
              <IconButton icon={call.muted ? MicOff : Mic} variant="soft" size={CONTROL} label={call.muted ? "Unmute" : "Mute"} onPress={call.toggleMute} />
              <View style={{ flex: 1 }}>
                <SoundStrip shape={speaking ? "voice" : open ? "open" : "quiet"} color={speaking ? colors.accent : open ? colors.success : colors.lineStrong} level={call.level} />
              </View>
            </>
          )}
          {!call.failed && <IconButton icon={call.speaker ? Speaker : Volume1} variant="soft" size={CONTROL} disabled={!call.live} label={call.speaker ? "Use headset or earpiece" : "Use the phone speaker"} onPress={call.toggleSpeaker} />}
          <IconButton icon={PhoneOff} size={CONTROL} color={colors.danger} label={call.failed ? "Close" : "End live voice"} onPress={endLiveCall} style={{ backgroundColor: colors.dangerSoft }} />
        </View>
      </View>
      {/* Beside the dock, not inside it, so a touch on the part above the dock's edge still lands. */}
      <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" }}>
        {interruptible ? (
          <Tap onPress={call.interrupt} feel="none" sink={0.96} testID="voice-interrupt" accessibilityLabel={"Interrupt " + name}>
            {face}
          </Tap>
        ) : (
          face
        )}
      </View>
    </View>
  );
}

/**
 * Draws a chat's live voice call, when it has one. It takes the message box's place (the chat's
 * screen leaves the box out while `typing` is off), and the call ends when this goes away.
 */
export function VoiceDock({ chatId }: { chatId: string }) {
  const call = useLiveCall((state) => state.call);
  const computer = useApp((state) => state.pairing?.serverId);
  useEffect(() => {
    // A call belongs to the chat on screen: one left over from another chat is dropped.
    const current = useLiveCall.getState().call;
    if (current && current.chatId !== chatId) endLiveCall();
    return () => {
      if (useLiveCall.getState().call?.chatId === chatId) endLiveCall();
    };
  }, [chatId]);
  if (!call || call.chatId !== chatId) return null;
  // A new call, another bot or another computer starts from nothing.
  return <Dock key={JSON.stringify([computer, chatId, call.botId])} chatId={chatId} botId={call.botId} computer={computer} typing={call.typing} />;
}
