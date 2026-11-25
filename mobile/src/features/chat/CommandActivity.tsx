// One background command (route /chat/command, a sheet), read as a live terminal: the command, its
// state and who started it when, the thought the bot was on when it started it, any links it
// printed (a tap opens the browser), and its output with the newest line at the bottom. A step that
// came without its whole output (`more`, "step-details-v1") reads it from the computer, again when
// it finishes. "Copy output", and "Stop process" while it runs and the computer can stop it
// ("stop-helper-v1").
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { CircleDashed, ExternalLink } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { StepDetail } from "@/link/types";
import { useBot, useCapability, useChat, useWatchedChat } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { Badge, Button, EmptyState, Label, radius, Sheet, space, T, type Tone, useOnShow, useTheme } from "@/ui";
import { openLink } from "@/ui/LinkHold";
import { parseStepInput } from "./activityModel";
import { clockOffset, commandOf, linkLabel, onComputer, outputLinks, outputTail, whyThought } from "./crew";
import { confirmStop, Elapsed, STOP_HELPER, useRun } from "./CrewCard";
import { useWatchedReasoning } from "./useWatchedReasoning";

const TONE: Record<string, Tone> = { Running: "accent", Done: "success", Failed: "danger" };
/** The newest lines the sheet draws at most. */
const LINES = 400;

export default function CommandActivity() {
  const { colors } = useTheme();
  const { chatId, runId, stepId } = useLocalSearchParams<{ chatId: string; runId: string; stepId: string }>();
  useWatchedChat(chatId);
  const run = useRun(chatId, runId);
  const turnLive = useApp((state) => state.running[chatId]?.id === runId && state.running[chatId]?.status === "Working");
  // A turn under way sends its thoughts' text only to a screen that watches them.
  useWatchedReasoning(chatId, turnLive);
  const canStop = useCapability(STOP_HELPER);
  const onShow = useOnShow();
  const chatBot = useChat(chatId)?.botId;
  const bot = useBot(run?.speakers?.at(-1) ?? chatBot);
  const insets = useSafeAreaInsets();
  const step = run ? commandOf(run, stepId) : undefined;

  const [detail, setDetail] = useState<StepDetail | "failed">();
  const fetches = !!step?.more;
  const finished = step?.finished;
  useEffect(() => {
    if (!fetches) return;
    let live = true;
    api["link.step"](chatId, runId, stepId).then(
      (value) => live && setDetail(value ?? {}),
      () => live && setDetail((held) => held ?? "failed"),
    );
    return () => {
      live = false;
    };
  }, [fetches, chatId, runId, stepId, finished]);

  if (!run || !step)
    return (
      <Sheet title="Command">
        <EmptyState icon={CircleDashed} title="Nothing to show" />
      </Sheet>
    );

  const read = typeof detail === "object" ? detail : undefined;
  const output = read?.output ?? step.output;
  const live = step.status === "Running";
  // While it runs, its progress is the newest; once it ended, its whole output.
  const text = (live ? step.progress || output : output || step.progress) ?? "";
  const tail = outputTail(text, LINES);
  const links = outputLinks(text);
  const parsed = parseStepInput(step);
  const name = parsed.command?.split("\n")[0]?.trim() || step.label || step.name;
  const botName = bot?.name ?? "The bot";
  const why = whyThought(run.reasoning, step.started);
  const stoppable = canStop && live && !!step.stoppable;
  const copy = () => void Clipboard.setStringAsync(text).then(() => showToast("Copied", "success"));

  return (
    <Sheet
      title="Command"
      footer={
        <View style={{ flexDirection: "row", gap: space.sm, paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
          <View style={{ flex: 1 }}>
            <Button title="Copy output" variant="secondary" wide disabled={!text} onPress={copy} />
          </View>
          {stoppable && (
            <View style={{ flex: 1 }}>
              <Button title="Stop process" variant="danger" wide onPress={() => confirmStop(chatId, step.id, name, "command")} />
            </View>
          )}
        </View>
      }
    >
      <View style={{ gap: space.xs }}>
        <T variant="mono" weight="600" selectable numberOfLines={4}>
          {name}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={step.status} tone={TONE[step.status] ?? "neutral"} />
          <Elapsed started={step.started} finished={step.finished} on={onShow && live} />
        </View>
        <T variant="footnote" color="muted" numberOfLines={2}>
          {"Started by " + botName + " at " + clockOffset(step.started - run.time)}
        </T>
      </View>

      {!!why && (
        <View>
          <Label>{"Why " + botName + " started it"}</Label>
          <T variant="subhead" color="ink2" selectable numberOfLines={8}>
            {why}
          </T>
        </View>
      )}

      {links.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {links.map((url) =>
            onComputer(url) ? (
              <T key={url} variant="footnote" color="muted" selectable>
                {linkLabel(url) + " · on your computer"}
              </T>
            ) : (
              <Button key={url} title={linkLabel(url)} icon={ExternalLink} variant="secondary" size="sm" onPress={() => openLink(url)} accessibilityLabel={"Open " + linkLabel(url)} />
            ),
          )}
        </View>
      )}

      <View>
        <Label>Output</Label>
        {fetches && !detail && !text ? (
          <ActivityIndicator color={colors.muted} style={{ alignSelf: "flex-start" }} />
        ) : text ? (
          <View style={{ backgroundColor: colors.sunken, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
            {tail.hidden > 0 && (
              <T variant="caption" color="faint">
                {tail.hidden === 1 ? "1 earlier line" : tail.hidden + " earlier lines"}
              </T>
            )}
            <T variant="mono" color="ink2" selectable>
              {tail.text}
            </T>
          </View>
        ) : (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {detail === "failed" ? "Couldn't read this from your computer." : live ? "No output yet." : "No output."}
          </T>
        )}
      </View>
    </Sheet>
  );
}
