// One helper (route /chat/helper, a sheet), read as a small chat: what the bot asked it, its steps
// as they happen (oldest first), what it is doing now, and its answer as its reply. "Stop helper"
// shows while it runs, when the computer can stop it on its own ("stop-helper-v1"). It follows the
// turn live. An older computer doesn't say which steps were a helper's; the sheet says where to get that.
import { useLocalSearchParams } from "expo-router";
import { CircleDashed } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBot, useCapability, useChat, useWatchedChat } from "@/state/hooks";
import { Badge, BotAvatar, Button, EmptyState, Group, Label, Markdown, Sheet, space, T, type Tone, useOnShow, useTheme } from "@/ui";
import { Shimmer } from "@/ui/Shimmer";
import { StepMark } from "./bits";
import { clockOffset } from "./crew";
import { confirmStop, Elapsed, STOP_HELPER, useRun } from "./CrewCard";
import { helperDetail } from "./helpers";
import { StepRow } from "./RunActivity";
import { TIMELINE_V1 } from "./turn";

const TONE: Record<string, Tone> = { Running: "accent", Done: "success", Failed: "danger" };

export default function HelperActivity() {
  const { colors } = useTheme();
  const { chatId, runId, helperId } = useLocalSearchParams<{ chatId: string; runId: string; helperId: string }>();
  useWatchedChat(chatId);
  const run = useRun(chatId, runId);
  const timeline = useCapability(TIMELINE_V1);
  const canStop = useCapability(STOP_HELPER);
  const onShow = useOnShow();
  const chatBot = useChat(chatId)?.botId;
  const bot = useBot(run?.speakers?.at(-1) ?? chatBot);
  const insets = useSafeAreaInsets();
  const detail = run ? helperDetail(run, helperId, timeline) : null;

  if (!run || !detail)
    return (
      <Sheet title="Helper">
        <EmptyState icon={CircleDashed} title="Nothing to show" />
      </Sheet>
    );

  const { helper, asked, answer } = detail;
  const steps = detail.steps && [...detail.steps].reverse();
  const live = helper.status === "Running";
  const botName = bot?.name ?? "The bot";
  const stoppable = canStop && live && !!helper.stoppable;
  const bubble = { backgroundColor: colors.surface, borderRadius: 18, paddingHorizontal: space.md, paddingVertical: space.sm + 2 } as const;
  const line = (color: "muted" | "ink") => (
    <T variant="footnote" color={color} numberOfLines={2}>
      {helper.intent}
    </T>
  );

  return (
    <Sheet
      title={helper.name}
      footer={
        stoppable ? (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
            <Button title="Stop helper" variant="danger" wide onPress={() => confirmStop(chatId, helper.id, helper.name, "helper")} />
          </View>
        ) : undefined
      }
    >
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={helper.status} tone={TONE[helper.status] ?? "neutral"} />
          <Elapsed started={helper.started} finished={helper.finished} on={onShow && live} />
        </View>
        <T variant="footnote" color="muted" numberOfLines={2}>
          {"Helper of " + botName + " · started at " + clockOffset(helper.started - run.time)}
        </T>
      </View>

      {!!asked && (
        <View style={{ gap: space.xs }}>
          <Label>{botName + " asked"}</Label>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
            <BotAvatar bot={bot} size={28} animated={false} />
            <View style={[bubble, { flexShrink: 1 }]}>
              <T variant="callout" selectable>
                {asked}
              </T>
            </View>
          </View>
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
              <StepRow key={step.id} step={step} chatId={chatId} runId={runId} />
            ))}
          </Group>
        ) : (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {live ? "No steps yet." : "No steps."}
          </T>
        )}
        {live && !!helper.intent && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, paddingTop: space.md }} accessible accessibilityLabel={"Now: " + helper.intent}>
            <StepMark status="Running" size={14} />
            <Shimmer on={onShow} lit={line("ink")} style={{ flex: 1 }}>
              {line("muted")}
            </Shimmer>
          </View>
        )}
      </View>

      {helper.status === "Failed" ? (
        <T variant="callout" color="danger" selectable>
          {helper.detail || answer || "It stopped with an error."}
        </T>
      ) : (
        !!answer && (
          <View style={{ gap: space.xs }}>
            <Label>{helper.name + " answered"}</Label>
            <View style={bubble}>
              <Markdown text={answer} />
            </View>
          </View>
        )
      )}
    </Sheet>
  );
}
