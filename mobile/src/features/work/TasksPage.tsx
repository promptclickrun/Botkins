// Every task (the route `/work/tasks`, from "See all" on Work), as a pipeline: the computer's board, left to right.
// Needs you comes first, each as a card that shows what the bot said (its result for a review, what it needs
// when blocked) with the answer right under it. Then a strip of the stages (Later › Ready › Working › Review ›
// Done), each with its count; the chosen stage's tasks are under it. The stages and their order are `overview.ts`.
import { ChevronRight, CircleDashed, Plus } from "lucide-react-native";
import { Fragment, useMemo, useState } from "react";
import { View } from "react-native";
import { openChat } from "@/features/chat/navigate";
import type { Bot, BotTask } from "@/link/types";
import { useBots, useMember, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { BotAvatar, Button, EmptyState, Glass, Group, IconButton, IconTile, Label, Loading, Mascot, Page, radius, space, T, Tap, useTheme } from "@/ui";
import { firstStage, pipeline, STAGES, type TaskStage } from "./overview";
import { openTask, TaskRow } from "./Work";

// The stage the person last chose, kept while the app runs; null opens where something moves.
let lastStage: TaskStage | null = null;

/** A task that waits on the person (or is under review by its creator bot): who and why, what the bot said, and actions. */
function NeedCard({ task, bot, reviewer }: { task: BotTask; bot?: Bot; reviewer?: Bot }) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const review = task.status === "review";
  const creatorReview = review && Boolean(task.reviewerBotId);
  const said = review ? task.result : task.problem;
  const move = async (to: "done" | "ready", done: string) => {
    if (busy) return;
    setBusy(to);
    await attempt(api.moveTask(task.id, to), done);
    setBusy(null);
  };
  return (
    <View style={{ padding: space.lg, gap: space.md }}>
      <Tap
        onPress={() => openTask(task.id)}
        feel="select"
        sink={0.99}
        hitSlop={0}
        accessibilityLabel={task.title + ", " + (creatorReview ? "reviewing by " + (reviewer?.name ?? "creator") : review ? "ready for review" : "blocked")}
        style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
      >
        {bot ? <BotAvatar bot={bot} size={40} state="waiting" /> : <IconTile icon={CircleDashed} color={colors.warning} size={40} />}
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {task.title}
          </T>
          <T variant="footnote" weight={review ? "400" : "600"} color={creatorReview ? "accent" : review ? "muted" : "warning"} numberOfLines={1}>
            {(bot?.name ?? "No bot") + (creatorReview ? " · Reviewing: " + (reviewer?.name ?? "Creator") : review ? " · ready for review" : " · blocked")}
          </T>
        </View>
      </Tap>
      {!!said && (
        <View style={{ borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm + 2, backgroundColor: review ? colors.sunken : colors.warningSoft }}>
          <T variant="subhead" color="ink2" numberOfLines={4}>
            {said}
          </T>
        </View>
      )}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
        {review ? (
          <>
            <Button title="Request changes" variant="secondary" size="sm" disabled={!!busy} onPress={() => openTask(task.id)} />
            <Button title="Approve" size="sm" loading={busy === "done"} disabled={!!busy} onPress={() => void move("done", "Approved")} />
          </>
        ) : (
          <>
            {!!task.chatId && <Button title="Open chat" variant="secondary" size="sm" disabled={!!busy} onPress={() => openChat(task.chatId!)} />}
            <Button title="Retry" size="sm" loading={busy === "ready"} disabled={!!busy} onPress={() => void move("ready", "Sent back")} />
          </>
        )}
      </View>
    </View>
  );
}

export default function TasksPage() {
  const synced = useApp((state) => state.synced);
  const allBots = useBots();
  const allTasks = usePart("tasks");
  const member = !!useMember();
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const tasks = useMemo(() => (allTasks ?? []).filter((task) => task.status !== "archived"), [allTasks]);
  const { needs, stages } = useMemo(() => pipeline(tasks), [tasks]);
  const [chosen, choose] = useState<TaskStage | null>(lastStage);
  const stage = chosen ?? firstStage(stages);
  const pick = (next: TaskStage) => {
    lastStage = next;
    choose(next);
  };
  const botOf = (task: BotTask) => (task.botId ? bots.get(task.botId) : undefined);
  const add = <IconButton icon={Plus} label="New task" variant="accent" size={44} onPress={() => openTask("new")} />;
  if (member)
    return (
      <Page title="Tasks">
        <EmptyState title="Tasks are your computer owner’s" />
      </Page>
    );
  const shown = stages[stage];
  return (
    <Page title="Tasks" actions={add}>
      {!synced ? (
        <Loading />
      ) : tasks.length === 0 ? (
        <EmptyState art={<Mascot size={104} state="working" />} title="No tasks yet" action="New task" onAction={() => openTask("new")} />
      ) : (
        <>
          {needs.length > 0 && (
            <View>
              <Label>{"Needs you · " + needs.length}</Label>
              <Group inset={0}>
                {needs.map((task) => (
                  <NeedCard key={task.id} task={task} bot={botOf(task)} />
                ))}
              </Group>
            </View>
          )}
          <StageStrip stages={stages} stage={stage} onPick={pick} />
          {shown.length === 0 ? (
            <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
              {STAGES.find((item) => item.id === stage)!.empty}
            </T>
          ) : stage === "reviewing" ? (
            <Group inset={0}>
              {shown.map((task) => (
                <NeedCard key={task.id} task={task} bot={botOf(task)} reviewer={task.reviewerBotId ? bots.get(task.reviewerBotId) : undefined} />
              ))}
            </Group>
          ) : (
            <Group inset={space.lg + 40 + space.md}>
              {shown.map((task) => (
                <TaskRow key={task.id} task={task} bot={botOf(task)} reviewer={task.reviewerBotId ? bots.get(task.reviewerBotId) : undefined} />
              ))}
            </Group>
          )}
        </>
      )}
    </Page>
  );
}

/** The pipeline as a row of stages, each its count over its name; the chosen one is filled. A task moves left to right. */
function StageStrip({ stages, stage, onPick }: { stages: Record<TaskStage, unknown[]>; stage: TaskStage; onPick: (stage: TaskStage) => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      {STAGES.map((item, index) => {
        const on = item.id === stage;
        const count = stages[item.id].length;
        const tile = (
          <View style={{ height: 62, alignItems: "center", justifyContent: "center", gap: 1, borderRadius: radius.lg, ...(on && { backgroundColor: colors.accent }) }}>
            <T variant="title3" weight="700" color={on ? "onAccent" : count ? "ink" : "faint"}>
              {String(count)}
            </T>
            <T variant="caption" weight={on ? "700" : "600"} color={on ? "onAccent" : "muted"} numberOfLines={1}>
              {item.label}
            </T>
          </View>
        );
        return (
          <Fragment key={item.id}>
            {index > 0 && <ChevronRight size={12} color={colors.faint} strokeWidth={2.4} />}
            <Tap onPress={() => onPick(item.id)} feel="select" sink={0.95} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={item.label + ", " + count} style={{ flex: 1, minWidth: 0 }}>
              {on ? tile : <Glass style={{ borderRadius: radius.lg }}>{tile}</Glass>}
            </Tap>
          </Fragment>
        );
      })}
    </View>
  );
}
