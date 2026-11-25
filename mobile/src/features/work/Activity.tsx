// What the bots ran lately: Work's Activity page (the icon left of the plus), and the whole of Work
// for a team member whose role has no routines.
import { router } from "expo-router";
import { memo, useMemo } from "react";
import { View } from "react-native";
import type { Bot, RunSummary } from "@/link/types";
import { IconStack, ShimmerLabel } from "@/features/chat/ActivityWidgets";
import { formatFeedWork } from "@/features/chat/activityModel";
import { useBots, useChats, usePart, useSettings } from "@/state/hooks";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { useAppActive } from "@/state/useAppActive";
import { Group, Loading, Page, space, T, Tap, useOnShow, useTheme } from "@/ui";
import { RunIcon } from "./bits";
import { buildNotifyTargetView, runNotifyChip } from "./notifyTargets";

type RunRowProps = { run: RunSummary; name?: string; when: string; chip: string | null; pulse: boolean };

/** A progress update keeps the other runs' references, so their rows can skip this render. */
const RunRow = memo(function RunRow({ run, name, when, chip, pulse }: RunRowProps) {
  const { colors, control } = useTheme();
  // The icon says how it went; the words say it too when it didn't simply finish.
  const status = run.status === "Completed" ? undefined : run.status === "Needs you" ? "Failed" : run.status;
  const subtitle = [status, name, when, run.trigger === "scheduled" ? "Scheduled" : undefined, chip].filter(Boolean).join(" · ");
  const work = formatFeedWork(run);
  return (
    <Tap
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: run.chatId } })}
      sink={1}
      feel="select"
      hitSlop={0}
      accessibilityLabel={[run.title || "Run", work.summary, subtitle].filter(Boolean).join(", ")}
      style={{
        minHeight: control.row,
        paddingHorizontal: space.lg,
        paddingVertical: 11,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
      }}
    >
      <RunIcon status={run.status} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <T variant="callout" weight="500" color="ink" numberOfLines={1}>
          {run.title || "Run"}
        </T>
        {(work.kinds.length > 0 || !!work.summary) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
            {work.kinds.length > 0 && <IconStack kinds={work.kinds} ringColor={colors.surface} size={11} badgeSize={19} />}
            {!!work.summary && (
              <ShimmerLabel
                active={pulse && run.status === "Working"}
                text={work.summary}
                variant="footnote"
                color={run.status === "Needs you" ? "danger" : "ink2"}
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              />
            )}
          </View>
        )}
        <T variant="caption" color="muted" numberOfLines={1}>
          {subtitle}
        </T>
      </View>
    </Tap>
  );
});

/** The latest 40 runs; a tap opens the run's chat. */
export function ActivityList() {
  const runs = usePart("runs") ?? [];
  const meta = usePart("meta");
  const team = usePart("team");
  const phones = usePart("phones");
  const settings = useSettings();
  const chats = useChats();
  const allBots = useBots();
  const bots = useMemo(() => new Map<string, Bot>(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const chatBot = useMemo(() => new Map(chats.map((chat) => [chat.id, chat.botId])), [chats]);
  // A mounted tab can be covered while its bots keep working.
  const inView = useAppActive(useOnShow());
  if (runs.length === 0)
    return (
      <T variant="callout" color="muted" center style={{ paddingVertical: space.huge }}>
        No activity yet
      </T>
    );
  return (
    <Group>
      {runs.slice(0, 40).map((run) => {
        const botId = chatBot.get(run.chatId);
        const chip = run.notifyTargets ? runNotifyChip(run.notifyTargets, buildNotifyTargetView({ meta, team, phones, settings, botId: botId ?? null })) : null;
        return <RunRow key={run.id} run={run} name={botId ? bots.get(botId)?.name : undefined} when={ago(run.time)} chip={chip} pulse={inView} />;
      })}
    </Group>
  );
}

export default function Activity() {
  const synced = useApp((state) => state.synced);
  return <Page title="Activity">{synced ? <ActivityList /> : <Loading />}</Page>;
}
