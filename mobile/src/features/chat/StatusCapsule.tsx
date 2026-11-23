// While a turn runs, its status floats over the message box on glass, the way T3 Code shows a
// working thread: the bot's face (held still, for battery), what it is doing, how long it has been
// at it and how many steps ("Coding | 0:42 · 3 steps"). A tap opens the turn's activity. The clock
// ticks once a second only while the chat is on screen and the app is in front.
import { router, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Bot, Run } from "@/link/types";
import { activityLabel, useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, Glass, T, Tap, useTheme } from "@/ui";
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

/** Now, once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  const [front, setFront] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setFront(next === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!on || !front) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on, front]);
  return now;
}

export function StatusCapsule({ chatId, bot, group, bots, run }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; /** The turn under way, once the computer has started it. */ run?: Run }) {
  const { colors } = useTheme();
  const state = useChatActivity(chatId);
  const speakerId = useApp((s) => s.parts.live?.speakers[chatId]);
  const now = useNow(useIsFocused() && !!run);
  const face = (group && speakerId ? bots.get(speakerId) : undefined) ?? bot;
  const doing = (activityLabel(state) || "Working").replace(/…$/, "");
  const own = run?.steps ?? [];
  const count = stepCount(own.length);
  const facts = [run ? clock(now - run.time) : "", count].filter(Boolean).join(" · ");
  const name = face?.name && !group ? face.name + " is " + doing.toLowerCase() : doing;
  return (
    // It goes at once when the turn ends: the fold line takes its place under the reply.
    <Animated.View entering={FadeIn.duration(180)} pointerEvents="box-none" style={{ alignItems: "center" }}>
      <Tap
        onPress={run ? () => router.push({ pathname: "/chat/activity", params: { chatId, runId: run.id } }) : undefined}
        disabled={!run}
        feel="select"
        sink={0.96}
        accessibilityLabel={name + (facts ? ", " + facts : "") + (run ? ", show activity" : "")}
      >
        {/* The glass only draws: the press belongs to the button around it. */}
        <View pointerEvents="none">
          <Glass style={{ height: CAPSULE, borderRadius: CAPSULE / 2, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8, paddingRight: 16 }}>
            <BotAvatar bot={face} size={28} state={state === "idle" ? "thinking" : state} animated={false} />
            <T variant="footnote" weight="600" numberOfLines={1}>
              {doing}
            </T>
            {!!facts && (
              <>
                <View style={{ width: 1, height: 16, backgroundColor: colors.line }} />
                <T variant="footnote" color="muted" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
                  {facts}
                </T>
              </>
            )}
          </Glass>
        </View>
      </Tap>
    </Animated.View>
  );
}
