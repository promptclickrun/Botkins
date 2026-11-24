// While a turn runs, its status floats over the message box on an opaque theme pill (the composer
// keeps the sole glass layer over the streaming transcript so GPU backdrop compositing doesn't
// multiply every frame): the bot's face (held still, for battery), what it is doing, how long it
// has been at it and how many steps ("Coding | 0:42 · 3 steps"). A tap opens the turn's activity.
// The clock ticks once a second only while the chat is on screen and the app is in front.
import { router } from "expo-router";
import { useElapsedClock } from "./useElapsedClock";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Bot, Run } from "@/link/types";
import { activityLabel, useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, T, Tap, useTheme } from "@/ui";
import { stepCount } from "./fold";

/** The capsule's height: ChatScreen keeps this much room above the message box while a turn runs. */
export const CAPSULE = 44;

/** "0:42", "12:05", "1:02:09". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? hours + ":" + String(minutes).padStart(2, "0") + ":" + seconds : minutes + ":" + seconds;
}

export function StatusCapsule({ chatId, bot, group, bots, run }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; /** The turn under way, once the computer has started it. */ run?: Run }) {
  const { colors } = useTheme();
  const state = useChatActivity(chatId);
  const speakerId = useApp((s) => s.parts.live?.speakers[chatId]);
  const now = useElapsedClock(!!run);
  const face = (group && speakerId ? bots.get(speakerId) : undefined) ?? bot;
  const doing = (activityLabel(state) || "Working").replace(/…$/, "");
  const own = run?.steps ?? [];
  const count = stepCount(own.length);
  const facts = [run ? clock(now - run.time) : "", count].filter(Boolean).join(" · ");
  const name = face?.name && !group ? face.name + " is " + doing.toLowerCase() : doing;
  return (
    // It goes at once when the turn ends: the fold line takes its place under the reply.
    <Animated.View entering={FadeIn.duration(180)} pointerEvents="box-none" style={{ flexShrink: 1, minWidth: 0 }}>
      <Tap
        onPress={run ? () => router.push({ pathname: "/chat/activity", params: { chatId, runId: run.id } }) : undefined}
        disabled={!run}
        feel="select"
        sink={0.96}
        accessibilityLabel={name + (facts ? ", " + facts : "") + (run ? ", show activity" : "")}
      >
        {/* Opaque surface pill: avoids a second backdrop-blur layer over the streaming transcript. */}
        <View
          pointerEvents="none"
          style={{
            height: CAPSULE,
            borderRadius: CAPSULE / 2,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingLeft: 8,
            paddingRight: 16,
            backgroundColor: colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.lineStrong,
          }}
        >
          <BotAvatar bot={face} size={28} state={state === "idle" ? "thinking" : state} animated={false} />
          <T variant="footnote" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {doing}
          </T>
          {!!facts && (
            <>
              <View style={{ width: 1, height: 16, backgroundColor: colors.line }} />
              <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1, fontVariant: ["tabular-nums"] }}>
                {facts}
              </T>
            </>
          )}
        </View>
      </Tap>
    </Animated.View>
  );
}
