import { router } from "expo-router";
import { Activity as ActivityIcon, ChevronDown, ChevronUp, CircleDashed, Plus, Trash2, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, Switch, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Bot, BotTask, ChatSchedule, ChatSummary, Panel } from "@/link/types";
import { type RoutineEntry, useBots, useCan, useChats, useMember, usePart, useRoutines } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { upcoming } from "@/state/time";
import { BotAvatar, Button, Dot, EmptyState, Group, haptic, HoldMenu, IconButton, IconTile, Label, Loading, Mascot, Page, Row, Segmented, space, switchColors, T, useTheme } from "@/ui";
import { isFinished, routineName, routineSubtitle, SplitRow, taskSubtitle } from "./bits";
import { buildNotifyTargetView } from "./notifyTargets";
import { ProjectList } from "@/features/projects/Projects";
import { ActivityList } from "./Activity";
import { cronLabel, scheduleLabel } from "./cron";

type Segment = "routines" | "projects" | "tasks";
const SEGMENTS: { value: Segment; label: string }[] = [
  { value: "routines", label: "Routines" },
  { value: "projects", label: "Projects" },
  { value: "tasks", label: "Tasks" },
];
// Work opens on the tab last looked at, while the app runs.
let lastSegment: Segment = "routines";

const openChat = (id: string) => router.push({ pathname: "/chat/[id]", params: { id } });
const openTask = (id: string) => router.push({ pathname: "/task/[id]", params: { id } });
const openRoutine = (id: string) => router.push({ pathname: "/routine/[id]", params: { id } });

// Needs you

type Need = { key: string; bot?: Bot; title: string; caption: string; onPress: () => void };

function NeedsYou({ needs }: { needs: Need[] }) {
  const { colors } = useTheme();
  if (needs.length === 0) return null;
  return (
    <View>
      <Label>{"Needs you · " + needs.length}</Label>
      <Group flat inset={space.lg + 40 + space.md}>
        {needs.map((need) => (
          <Row
            key={need.key}
            leading={need.bot ? <BotAvatar bot={need.bot} state="waiting" size={40} /> : <IconTile icon={CircleDashed} color={colors.warning} size={40} />}
            title={need.title}
            subtitle={need.caption}
            trailing={<Dot tone="warning" />}
            chevron
            onPress={need.onPress}
          />
        ))}
      </Group>
    </View>
  );
}

// Routines

function RoutineRow({ routine }: { routine: RoutineEntry }) {
  const { colors } = useTheme();
  const meta = usePart("meta");
  const team = usePart("team");
  const phones = usePart("phones");
  const settings = usePart("settings");
  const canUse = useCan("today", "use");
  const canCreate = useCan("today", "create");
  const canManage = useCan("today", "manage");
  const canDelete = useCan("today", "delete");
  const name = routineName(routine);
  const on = routine.entry.enabled !== false;
  const finished = isFinished(routine);
  const targetView = useMemo(
    () => (routine.entry.notifyTargets ? buildNotifyTargetView({ meta, team, phones, settings, botId: routine.chat.botId }) : null),
    [routine.entry.notifyTargets, meta, team, phones, settings, routine.chat.botId],
  );
  const remove = () =>
    Alert.alert("Delete " + name + "?", "Its chat and past runs are deleted too.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void attempt(api.deleteRoutine(routine.id), "Routine deleted") },
    ]);
  return (
    <HoldMenu
      actions={[
        ...(canUse ? [{ id: "run", title: "Run now", image: "play" }] : []),
        { id: "chat", title: "Open chat", image: "bubble.left" },
        ...(canCreate ? [{ id: "duplicate", title: "Duplicate", image: "plus.square.on.square" }] : []),
        ...(canDelete ? [{ id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } }] : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "run") void attempt(api.runRoutine(routine.id), "Running " + name);
        else if (action === "chat") openChat(routine.id);
        else if (action === "duplicate") void attempt(api.duplicateRoutine(routine.id, routine.chat.botId), "Routine duplicated");
        else if (action === "delete") remove();
      }}
    >
      <SplitRow
        leading={<BotAvatar bot={routine.bot ?? { id: routine.chat.botId }} size={44} />}
        title={name}
        subtitle={routineSubtitle(routine, targetView)}
        muted={!on || finished}
        hint="Long press for more"
        onPress={canManage ? () => openRoutine(routine.id) : () => openChat(routine.id)}
        accessory={
          canManage && !finished && (
            <Switch
              value={on}
              onValueChange={(next) => {
                haptic.select();
                void attempt(api.setRoutineEnabled(routine.id, next));
              }}
              {...switchColors(colors, on)}
              style={{ alignSelf: "center" }}
              accessibilityLabel={name + (on ? ", on" : ", paused")}
            />
          )
        }
      />
    </HoldMenu>
  );
}

function Routines({ routines, chats, bots }: { routines: RoutineEntry[]; chats: ChatSummary[]; bots: Map<string, Bot> }) {
  const panels = usePart("panels");
  const canCreate = useCan("today", "create");
  const withRoutine = useMemo(() => (panels ?? []).filter((panel) => panel.routine), [panels]);
  // Schedules a bot made in a chat with /every or /after: every schedule that isn't a routine.
  const schedules = useMemo(() => chats.flatMap((chat) => (chat.schedules ?? []).filter((entry) => !entry.routine).map((entry) => ({ chat, entry }))), [chats]);
  return (
    <View style={{ gap: space.xl }}>
      {routines.length === 0 ? (
        <EmptyState art={<Mascot size={104} state="planning" />} title="No routines yet" action={canCreate ? "New routine" : undefined} onAction={canCreate ? () => openRoutine("new") : undefined} />
      ) : (
        <Group>
          {routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} />
          ))}
        </Group>
      )}
      {withRoutine.length > 0 && (
        <View>
          <Label>{"Today panels · " + withRoutine.length}</Label>
          <Group>
            {withRoutine.map((panel) => (
              <PanelRoutineRow key={panel.id} panel={panel} bot={bots.get(panel.botId)} />
            ))}
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
            Change these from each panel on Today.
          </T>
        </View>
      )}
      {schedules.length > 0 && (
        <View>
          <Label>{"Chat schedules · " + schedules.length}</Label>
          <Group>
            {schedules.map(({ chat, entry }) => (
              <ScheduleRow key={chat.id + ":" + entry.id} chat={chat} entry={entry} bot={bots.get(chat.botId)} />
            ))}
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
            Prompts scheduled in a chat with /every or /after.
          </T>
        </View>
      )}
    </View>
  );
}

/** A Today panel that refreshes itself; it opens Today, where its menu changes it. */
function PanelRoutineRow({ panel, bot }: { panel: Panel; bot?: Bot }) {
  const routine = panel.routine!;
  const when = routine.enabled && routine.nextAt ? "Next " + upcoming(routine.nextAt) : "Paused";
  return (
    <Row
      leading={<BotAvatar bot={bot ?? { id: panel.botId }} size={44} />}
      title={panel.title}
      subtitle={[cronLabel(routine.cron), routine.timezone, bot?.name, when].filter(Boolean).join(" · ")}
      subtitleLines={2}
      chevron
      onPress={() => router.push("/today")}
    />
  );
}

/** A schedule a bot made in a chat: Pause or Resume, and Delete. */
function ScheduleRow({ chat, entry, bot }: { chat: ChatSummary; entry: ChatSchedule; bot?: Bot }) {
  const { colors } = useTheme();
  const paused = entry.enabled === false;
  const canManage = useCan("today", "manage");
  const canDelete = useCan("today", "delete");
  const when = paused ? "Paused" : entry.nextAt != null ? "Next " + upcoming(entry.nextAt) : undefined;
  const change = (action: "pause" | "resume" | "delete", done?: string) => void attempt(api.changeSchedule(chat.id, entry.id, action), done);
  const remove = () =>
    Alert.alert("Delete this schedule?", entry.prompt, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => change("delete", "Schedule deleted") },
    ]);
  return (
    <SplitRow
      leading={<BotAvatar bot={bot ?? { id: chat.botId }} size={44} />}
      title={entry.prompt}
      subtitle={[scheduleLabel(entry), chat.title, when].filter(Boolean).join(" · ")}
      muted={paused}
      onPress={() => openChat(chat.id)}
      accessory={
        (canManage || canDelete) ? <View style={{ flexDirection: "row", alignItems: "center" }}>
          {canManage && <Button title={paused ? "Resume" : "Pause"} variant="ghost" size="sm" onPress={() => change(paused ? "resume" : "pause")} accessibilityLabel={(paused ? "Resume " : "Pause ") + entry.prompt} />}
          {canDelete && <IconButton icon={Trash2} label={"Delete " + entry.prompt} size={44} color={colors.faint} onPress={remove} />}
        </View> : undefined
      }
    />
  );
}

// Tasks

function TaskRow({ task, bot }: { task: BotTask; bot?: Bot }) {
  const { colors } = useTheme();
  const subtitle = taskSubtitle(task, bot);
  const action =
    task.status === "review" ? (
      <Button title="Approve" variant="ghost" size="sm" onPress={() => void attempt(api.moveTask(task.id, "done"), "Approved")} accessibilityLabel={"Approve " + task.title} />
    ) : (task.status === "later" || task.status === "ready") && task.botId ? (
      <Button title="Start" variant="ghost" size="sm" onPress={() => void attempt(api.startTask(task.id), "Started")} accessibilityLabel={"Start " + task.title} />
    ) : undefined;
  return (
    <SplitRow
      leading={bot ? <BotAvatar bot={bot} size={40} state={task.status === "working" ? "working" : "idle"} /> : <IconTile icon={CircleDashed} color={colors.faint} size={40} />}
      title={task.title}
      subtitle={subtitle}
      muted={task.status === "done"}
      onPress={() => openTask(task.id)}
      label={task.title + ", " + subtitle}
      accessory={action}
    />
  );
}

const SECTIONS: { title: string; statuses: BotTask["status"][] }[] = [
  { title: "Needs you", statuses: ["review", "blocked"] },
  { title: "Working", statuses: ["working"] },
  { title: "Ready", statuses: ["ready"] },
  { title: "Later", statuses: ["later"] },
];
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

function Tasks({ tasks, bots }: { tasks: BotTask[]; bots: Map<string, Bot> }) {
  const [showDone, setShowDone] = useState(false);
  const sections = useMemo(
    () =>
      SECTIONS.map((section) => ({
        ...section,
        tasks: tasks.filter((task) => section.statuses.includes(task.status)).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt - a.updatedAt),
      })).filter((section) => section.tasks.length > 0),
    [tasks],
  );
  const done = useMemo(() => tasks.filter((task) => task.status === "done").sort((a, b) => b.updatedAt - a.updatedAt), [tasks]);
  if (sections.length === 0 && done.length === 0) return <EmptyState art={<Mascot size={104} state="working" />} title="No tasks yet" action="New task" onAction={() => openTask("new")} />;
  const botOf = (task: BotTask) => (task.botId ? bots.get(task.botId) : undefined);
  return (
    <View style={{ gap: space.xl }}>
      {sections.map((section) => (
        <View key={section.title}>
          <Label>{section.title}</Label>
          <Group>
            {section.tasks.map((task) => (
              <TaskRow key={task.id} task={task} bot={botOf(task)} />
            ))}
          </Group>
        </View>
      ))}
      {done.length > 0 && (
        <View>
          {showDone && <Label>Done</Label>}
          <Group>
            {showDone ? done.map((task) => <TaskRow key={task.id} task={task} bot={botOf(task)} />) : []}
            <Row
              key="toggle"
              title={showDone ? "Hide done" : "Show done"}
              value={showDone ? undefined : String(done.length)}
              tone="accent"
              onPress={() => setShowDone(!showDone)}
              trailing={<ToggleIcon open={showDone} />}
            />
          </Group>
        </View>
      )}
    </View>
  );
}

function ToggleIcon({ open }: { open: boolean }) {
  const { colors } = useTheme();
  const Icon = open ? ChevronUp : ChevronDown;
  return <Icon size={18} color={colors.faint} strokeWidth={2.2} />;
}

export default function Work() {
  const synced = useApp((state) => state.synced);
  const [segment, pickSegment] = useState<Segment>(lastSegment);
  const setSegment = (next: Segment) => {
    lastSegment = next;
    setAddingProject(false);
    pickSegment(next);
  };
  const [addingProject, setAddingProject] = useState(false);
  const allBots = useBots();
  const chats = useChats();
  const routines = useRoutines();
  const allTasks = usePart("tasks");
  const requests = useApp((state) => state.parts.live?.requests);
  const canToday = useCan("today", "view");
  const canCreateToday = useCan("today", "create");
  const member = useMember();
  // Projects and tasks are the owner's; a member's role decides about routines.
  const options = SEGMENTS.filter((option) => (option.value === "routines" ? canToday : !member));

  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const tasks = useMemo(() => (allTasks ?? []).filter((task) => task.status !== "archived"), [allTasks]);
  const needs = useMemo(() => {
    const out: Need[] = [];
    for (const request of requests ?? []) {
      const bot = bots.get(request.botId);
      out.push({ key: "r" + request.id, bot, title: request.title, caption: (bot?.name ?? "A bot") + " is asking", onPress: () => openChat(request.chatId) });
    }
    for (const task of tasks)
      if (task.status === "review" || task.status === "blocked") {
        const bot = task.botId ? bots.get(task.botId) : undefined;
        out.push({ key: "t" + task.id, bot, title: task.title, caption: task.status === "review" ? "Ready for review" : "Blocked", onPress: () => openTask(task.id) });
      }
    return out;
  }, [requests, tasks, bots]);

  const shownSegment = options.some((option) => option.value === segment) ? segment : options[0]?.value;
  const add =
    shownSegment === "routines" && canCreateToday
      ? { label: "New routine", run: () => openRoutine("new") }
      : shownSegment === "projects"
        ? { label: addingProject ? "Cancel new project" : "New project", run: () => setAddingProject(!addingProject) }
        : shownSegment === "tasks"
          ? { label: "New task", run: () => openTask("new") }
          : undefined;

  return (
    <Page
      tab
      title="Work"
      keyboard
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <IconButton icon={ActivityIcon} label="Activity" variant="soft" size={44} onPress={() => router.push("/work/activity")} />
          {add && <IconButton icon={shownSegment === "projects" && addingProject ? X : Plus} label={add.label} variant="accent" size={44} onPress={add.run} />}
        </View>
      }
    >
      {synced && <NeedsYou needs={needs} />}
      {options.length > 1 && <Segmented options={options} value={shownSegment ?? options[0].value} onChange={setSegment} />}
      {!synced ? (
        <Loading />
      ) : (
        <Animated.View key={shownSegment ?? "none"} entering={FadeIn.duration(180)}>
          {shownSegment === "routines" ? (
            <Routines routines={routines} chats={chats} bots={bots} />
          ) : shownSegment === "projects" ? (
            <ProjectList adding={addingProject} setAdding={setAddingProject} />
          ) : shownSegment === "tasks" ? (
            <Tasks tasks={tasks} bots={bots} />
          ) : (
            <ActivityList />
          )}
        </Animated.View>
      )}
    </Page>
  );
}
