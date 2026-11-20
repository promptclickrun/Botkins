// One helper's activity (route /chat/helper, a sheet): what it was asked, its state and time, the
// steps it runs as they happen, and what it came back with. It follows the turn live. An older
// computer doesn't say which steps were a helper's; the sheet says where to get that.
import { useLocalSearchParams } from "expo-router";
import { CircleDashed } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useCapability, useWatchedChat } from "@/state/hooks";
import { useApp } from "@/state/store";
import { duration } from "@/state/time";
import { Badge, EmptyState, Group, Label, Markdown, Sheet, space, T, type Tone, useOnShow, useTheme } from "@/ui";
import { helperDetail } from "./helpers";
import { StepRow } from "./RunActivity";
import { TIMELINE_V1 } from "./turn";

const TONE: Record<string, Tone> = { Running: "accent", Done: "success", Failed: "danger" };

/** The time now, once a second while `ticking` and the sheet is on show. */
function useNow(ticking: boolean) {
  const seen = useOnShow();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking || !seen) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, seen]);
  return now;
}

export default function HelperActivity() {
  const { colors } = useTheme();
  const { chatId, runId, helperId } = useLocalSearchParams<{ chatId: string; runId: string; helperId: string }>();
  useWatchedChat(chatId);
  const saved = useApp((state) => state.chats[chatId]?.runs[runId]);
  const running = useApp((state) => state.running[chatId]);
  const run = running?.id === runId ? running : saved;
  const timeline = useCapability(TIMELINE_V1);
  const ticking = run?.agents?.find((agent) => agent.id === helperId)?.status === "Running";
  const now = useNow(ticking);
  const detail = run ? helperDetail(run, helperId, timeline, now) : null;

  if (!detail)
    return (
      <Sheet title="Helper">
        <EmptyState icon={CircleDashed} title="Nothing to show" />
      </Sheet>
    );

  const { helper, asked, answer, steps } = detail;
  const doing = helper.status === "Running" ? helper.intent : undefined;
  return (
    <Sheet title={helper.name}>
      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={helper.status} tone={TONE[helper.status] ?? "neutral"} />
          <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {duration(detail.took) + (doing ? " · " + doing : "")}
          </T>
        </View>
        {!!helper.description && helper.description !== asked && (
          <T variant="subhead" color="ink2">
            {helper.description}
          </T>
        )}
      </View>

      {!!asked && (
        <View>
          <Label>Asked</Label>
          <Group>
            <View style={{ padding: space.lg }}>
              <T variant="callout" selectable>
                {asked}
              </T>
            </View>
          </Group>
        </View>
      )}

      <View>
        <Label>{steps ? (steps.length === 1 ? "1 step" : steps.length + " steps") : "Steps"}</Label>
        {steps === null ? (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            Update the app on your computer to see this helper's steps.
          </T>
        ) : steps.length ? (
          <Group>
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </Group>
        ) : (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {helper.status === "Running" ? "No steps yet." : "No steps."}
          </T>
        )}
      </View>

      {!!answer && (
        <View>
          <Label>{helper.status === "Failed" ? "What went wrong" : "Came back with"}</Label>
          <Group>
            <View style={{ padding: space.lg }}>
              <Markdown text={answer} color={helper.status === "Failed" ? colors.danger : undefined} />
            </View>
          </Group>
        </View>
      )}
    </Sheet>
  );
}
