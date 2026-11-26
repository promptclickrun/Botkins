// Every task (the route `/work/tasks`, from "See all" on Work). Three chips: Active, Later and Done.
// Active is in three groups: Needs you first, each as a card that shows what the bot said (its result
// for a review, what it needs when blocked) with the answer right under it; then Working; then Ready,
// with Start, or Pick a bot for a task that has none. The order and the groups are `overview.ts`.
import { CircleDashed, Plus } from "lucide-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { openChat } from "@/features/chat/navigate";
import type { Bot, BotTask } from "@/link/types";
import { useBots, useMember, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { BotAvatar, Button, EmptyState, Group, IconButton, IconTile, Label, Loading, Mascot, Page, radius, space, T, Tap, useTheme } from "@/ui";
import { activeGroups, taskCounts, tasksIn, type TaskView } from "./overview";
import { openTask, TaskChips, TaskRow } from "./Work";

let lastView: TaskView = "active";

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
  const [view, pick] = useState<TaskView>(lastView);
  const setView = (next: TaskView) => {
    lastView = next;
    pick(next);
  };
  const counts = useMemo(() => taskCounts(tasks), [tasks]);
  const groups = useMemo(() => activeGroups(tasks), [tasks]);
  const list = useMemo(() => (view === "active" ? [] : tasksIn(tasks, view)), [tasks, view]);
  const botOf = (task: BotTask) => (task.botId ? bots.get(task.botId) : undefined);
  const add = <IconButton icon={Plus} label="New task" variant="accent" size={44} onPress={() => openTask("new")} />;
  if (member)
    return (
      <Page title="Tasks">
        <EmptyState title="Tasks are your computer owner’s" />
      </Page>
    );
  return (
    <Page title="Tasks" actions={add}>
      {!synced ? (
        <Loading />
      ) : tasks.length === 0 ? (
        <EmptyState art={<Mascot size={104} state="working" />} title="No tasks yet" action="New task" onAction={() => openTask("new")} />
      ) : (
        <>
          <TaskChips view={view} onChange={setView} counts={counts} />
          {view === "active" ? (
            groups.length === 0 ? (
              <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
                Nothing in progress
              </T>
            ) : (
              groups.map((group) => (
                <View key={group.title}>
                  <Label>{group.title + " · " + group.tasks.length}</Label>
                  <Group inset={group.title === "Needs you" || group.title === "Reviewing" ? 0 : space.lg + 40 + space.md}>
                    {group.title === "Needs you" || group.title === "Reviewing"
                      ? group.tasks.map((task) => <NeedCard key={task.id} task={task} bot={botOf(task)} reviewer={task.reviewerBotId ? bots.get(task.reviewerBotId) : undefined} />)
                      : group.tasks.map((task) => <TaskRow key={task.id} task={task} bot={botOf(task)} reviewer={task.reviewerBotId ? bots.get(task.reviewerBotId) : undefined} />)}
                  </Group>
                </View>
              ))
            )
          ) : list.length === 0 ? (
            <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
              {view === "later" ? "Nothing put off" : "Nothing done yet"}
            </T>
          ) : (
            <Group inset={space.lg + 40 + space.md}>
              {list.map((task) => (
                <TaskRow key={task.id} task={task} bot={botOf(task)} reviewer={task.reviewerBotId ? bots.get(task.reviewerBotId) : undefined} />
              ))}
            </Group>
          )}
        </>
      )}
    </Page>
  );
}
