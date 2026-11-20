// The line above the message box while the person talks with a bot by turns (talk.ts): what the
// phone is doing, the words it heard, and a tap to stop the reading and speak again.
import { AudioLines, Ear, Loader, Volume2 } from "lucide-react-native";
import { View } from "react-native";
import { radius, space, T, Tap, useTheme } from "@/ui";
import { skipToListening, type TalkPhase, useTalk } from "./talk";

const WORDS: Record<Exclude<TalkPhase, "off">, string> = { listening: "Listening", sending: "Sending", waiting: "Waiting for the reply", speaking: "Speaking. Tap to talk" };
const ICONS = { listening: Ear, sending: Loader, waiting: Loader, speaking: Volume2 } as const;

export function TalkBar({ chatId }: { chatId: string }) {
  const { colors } = useTheme();
  const talk = useTalk();
  if (talk.chatId !== chatId || talk.phase === "off") return null;
  const Icon = ICONS[talk.phase] ?? AudioLines;
  const speaking = talk.phase === "speaking";
  // While listening the ring grows with the voice.
  const ring = talk.phase === "listening" ? 1 + Math.min(1, talk.level) * 0.5 : 1;
  const line = talk.phase === "listening" && talk.heard ? talk.heard : WORDS[talk.phase];
  const style = { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface } as const;
  const inside = (
    <>
      <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: 28, height: 28, borderRadius: 14, backgroundColor: colors.sunken, transform: [{ scale: ring }] }} />
        <Icon size={15} color={colors.ink} strokeWidth={2.2} />
      </View>
      <T variant="subhead" color={talk.phase === "listening" && talk.heard ? "ink" : "muted"} numberOfLines={2} style={{ flex: 1 }}>
        {line}
      </T>
    </>
  );
  // Only while a reply is read is there something to tap: it stops the reading and listens again.
  if (!speaking)
    return (
      <View style={style} accessibilityLabel={line} accessibilityLiveRegion="polite">
        {inside}
      </View>
    );
  return (
    <Tap onPress={skipToListening} accessibilityLabel="Speaking. Stop reading and talk" style={style}>
      {inside}
    </Tap>
  );
}
