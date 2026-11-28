// The Work tab: one overview, top to bottom. What needs the person; their projects as cards to swipe,
// each with its to-dos' progress and its bots; tasks under three chips (Active, Later, Done) with the
// first few shown; and the routines that run next. Each part has "See all": Projects (`/projects`),
// Tasks (`/work/tasks`, TasksPage.tsx) and Routines (`/work/routines`). A team member's Work has no
// projects or tasks. Activity is a page of its own, opened by the icon beside the plus.
import { type Href, router } from "expo-router";
import { MenuView } from "@react-native-menu/menu";
import { Activity as ActivityIcon, CircleDashed, FolderClosed, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react-native";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { Alert, ScrollView, Switch, View } from "react-native";
import { openChat } from "@/features/chat/navigate";
import { projectColor } from "@/features/projects/colors";
import type { Bot, BotTask, ChatSchedule, ChatSummary, Panel, Project, Workflow, WorkflowRun } from "@/link/types";
import { type RoutineEntry, useBots, useCan, useChats, useMember, usePart, useRoutines, useWorkflowRuns, useWorkflows } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { ago, clockTime, upcoming } from "@/state/time";
import { BotAvatar, Button, Chip, Dot, EmptyState, Glass, Group, haptic, HoldMenu, IconButton, IconTile, Label, Loading, LoadingGrid, Mascot, Page, radius, Row, space, switchColors, T, Tap, tint, useFrozenWhenHidden, useTabReady, useTheme } from "@/ui";
import { isFinished, routineName, routineSubtitle, SplitRow, taskSubtitle } from "./bits";
import { buildNotifyTargetView } from "./notifyTargets";
import { cronLabel, scheduleLabel } from "./cron";
import { dayWord, projectProgress, taskCounts, tasksIn, type TaskView, upNext } from "./overview";

export const openTask = (id: string) => router.push({ pathname: "/task/[id]", params: { id } });
const openRoutine = (id: string) => router.push({ pathname: "/routine/[id]", params: { id } });
const openProject = (id: string) => router.push({ pathname: "/projects/[id]", params: { id } });
const openWorkflow = (id: string) => router.push({ pathname: "/workflow/[id]", params: { id } });

// Needs you

type Need = { key: string; bot?: Bot; title: string; caption: string; onPress: () => void };

export function NeedsYou({ needs }: { needs: Need[] }) {
  const { colors } = useTheme();
  if (needs.length === 0) return null;
  return (
    <View>
      <Label>{"Needs you · " + needs.length}</Label>
      <Group inset={space.lg + 40 + space.md}>
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

function WorkflowRow({ workflow, latestRun }: { workflow: Workflow; latestRun?: WorkflowRun }) {
  const { colors } = useTheme();
  const canUse = useCan("today", "use");
  const canManage = useCan("today", "manage");
  const triggers = workflow.nodes.filter((n) => n.kind === "trigger").map((n) => n.triggerKind || "trigger");
  const sub = [
    workflow.enabled ? `${workflow.nodes.length} steps` : "Paused",
    triggers.length ? triggers.join(", ") : undefined,
    latestRun ? `Last run: ${latestRun.status.replace("_", " ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <HoldMenu
      actions={[
        ...(canUse ? [{ id: "run", title: "Run now", image: "play" }] : []),
        { id: "open", title: "View runs", image: "list.bullet" },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "run") void attempt(api.workflowRun(workflow.id), "Running " + workflow.name);
        else if (nativeEvent.event === "open") openWorkflow(workflow.id);
      }}
    >
      <SplitRow
        leading={<IconTile icon={WorkflowIcon} color={workflow.enabled ? colors.accent : colors.muted} size={44} />}
        title={workflow.name}
        subtitle={sub}
        muted={!workflow.enabled}
        hint="Tap for runs · long press to run"
        onPress={() => openWorkflow(workflow.id)}
        accessory={
          canManage ? (
            <Switch
              value={workflow.enabled}
              onValueChange={(next) => {
                haptic.select();
                void attempt(next ? api.workflowResume(workflow.id) : api.workflowPause(workflow.id));
              }}
              {...switchColors(colors, workflow.enabled)}
              style={{ alignSelf: "center" }}
              accessibilityLabel={workflow.name + (workflow.enabled ? ", active" : ", paused")}
            />
          ) : undefined
        }
      />
    </HoldMenu>
  );
}

export function Routines({ routines, chats, bots }: { routines: RoutineEntry[]; chats: ChatSummary[]; bots: Map<string, Bot> }) {
  const panels = usePart("panels");
  const workflows = useWorkflows();
  const workflowRuns = useWorkflowRuns();
  const canCreate = useCan("today", "create");
  const withRoutine = useMemo(() => (panels ?? []).filter((panel) => panel.routine), [panels]);
  // Schedules a bot made in a chat with /every or /after: every schedule that isn't a routine.
  const schedules = useMemo(() => chats.flatMap((chat) => (chat.schedules ?? []).filter((entry) => !entry.routine).map((entry) => ({ chat, entry }))), [chats]);
  return (
    <View style={{ gap: space.xl }}>
      {workflows.length > 0 && (
        <View>
          <Label>{"Workflows · " + workflows.length}</Label>
          <Group>
            {workflows.map((wf) => (
              <WorkflowRow key={wf.id} workflow={wf} latestRun={workflowRuns.find((r) => r.workflowId === wf.id)} />
            ))}
          </Group>
          {canCreate && <Button title="New workflow" variant="ghost" size="sm" icon={Plus} style={{ alignSelf: "flex-start", marginTop: space.sm }} onPress={() => openWorkflow("new")} />}
        </View>
      )}
      {routines.length === 0 && workflows.length === 0 ? (
        <View style={{ gap: space.sm }}>
          <EmptyState art={<Mascot size={104} state="planning" />} title="No routines yet" action={canCreate ? "New routine" : undefined} onAction={canCreate ? () => openRoutine("new") : undefined} />
          {canCreate && <Button title="New workflow" variant="ghost" size="sm" icon={Plus} style={{ alignSelf: "center" }} onPress={() => openWorkflow("new")} />}
        </View>
      ) : routines.length > 0 ? (
        <Group>
          {routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} />
          ))}
        </Group>
      ) : null}
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

export function TaskRow({ task, bot, reviewer }: { task: BotTask; bot?: Bot; reviewer?: Bot }) {
  const { colors } = useTheme();
  const subtitle = taskSubtitle(task, bot, reviewer);
  const action =
    task.status === "review" ? (
      <Button title="Approve" variant="ghost" size="sm" onPress={() => void attempt(api.moveTask(task.id, "done"), "Approved")} accessibilityLabel={"Approve " + task.title} />
    ) : task.status === "done" ? (
      <Button title="Reopen" variant="ghost" size="sm" onPress={() => void attempt(api.moveTask(task.id, "ready"), "Reopened")} accessibilityLabel={"Reopen " + task.title} />
    ) : (task.status === "later" || task.status === "ready") && task.botId ? (
      <Button title="Start" variant="ghost" size="sm" onPress={() => void attempt(api.startTask(task.id), "Started")} accessibilityLabel={"Start " + task.title} />
    ) : (task.status === "later" || task.status === "ready") && !task.botId ? (
      <Button title="Pick a bot" variant="ghost" size="sm" onPress={() => openTask(task.id)} accessibilityLabel={"Pick a bot for " + task.title} />
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

/** A part's heading, with "See all" at its right when there is more to see. */
export function PartHead({ title, more, onMore }: { title: string; more?: string; onMore?: () => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.xs }}>
      <Label style={{ marginBottom: 0 }}>{title}</Label>
      {!!more && !!onMore && (
        <Tap onPress={onMore} feel="select" accessibilityLabel={more} style={{ minHeight: 44, justifyContent: "center", paddingLeft: space.md }}>
          <T variant="subhead" weight="600" color="ink2">
            {more}
          </T>
        </Tap>
      )}
    </View>
  );
}

/** The chips over tasks: Active, Later and Done, each with its count. */
export function TaskChips({ view, onChange, counts }: { view: TaskView; onChange: (view: TaskView) => void; counts: Record<TaskView, number> }) {
  const options: { value: TaskView; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "later", label: "Later" },
    { value: "done", label: "Done" },
  ];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm }}>
      {options.map((option) => (
        <Chip key={option.value} label={option.label + (counts[option.value] ? " · " + counts[option.value] : "")} selected={view === option.value} onPress={() => onChange(option.value)} />
      ))}
    </View>
  );
}

// Work opens on the chip last looked at, while the app runs.
let lastView: TaskView = "active";

/** A project as a card on the shelf: its color and name, its to-dos' progress, and the bots in its chats. */
function ProjectCard({ project, chats, bots }: { project: Project; chats: ChatSummary[]; bots: Map<string, Bot> }) {
  const theme = useTheme();
  const { colors, dark } = theme;
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const streams = useApp((state) => state.parts.live?.streams);
  const progress = projectProgress(project);
  const own = chats.filter((chat) => chat.projectId === project.id);
  const working = own.filter((chat) => !!streams && chat.id in streams).length;
  const faces = [...new Set(own.flatMap((chat) => chat.botIds ?? [chat.botId]))].map((id) => bots.get(id)).filter((bot): bot is Bot => !!bot).slice(0, 3);
  const foot = working ? working + (working === 1 ? " chat working" : " chats working") : "Used " + ago(project.lastUsed);
  const body = (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <IconTile icon={FolderClosed} color={projectColor(project.color, theme)} />
        <T variant="title3" numberOfLines={1} style={{ flex: 1 }}>
          {project.name}
        </T>
      </View>
      <T variant="footnote" color="muted" style={{ marginTop: space.md }}>
        {progress.line}
      </T>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.sunken, marginTop: 6, overflow: "hidden" }}>
        <View style={{ width: `${Math.round(progress.share * 100)}%`, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {faces.length > 0 && (
          <View style={{ flexDirection: "row" }}>
            {faces.map((bot, index) => (
              <View key={bot.id} style={{ marginLeft: index ? -6 : 0 }}>
                <BotAvatar bot={bot} size={26} badge={false} />
              </View>
            ))}
          </View>
        )}
        <T variant="footnote" weight={working ? "600" : "400"} color={working ? "ink2" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
          {foot}
        </T>
      </View>
    </>
  );
  const frame = { width: 252, height: 152, borderRadius: radius.lg, padding: space.md + 2, overflow: "hidden" as const };
  return (
    <Tap onPress={() => openProject(project.id)} feel="select" sink={0.98} accessibilityLabel={project.name + ", " + progress.line + ", " + foot}>
      {hasBackdrop ? <Glass tintColor={tint(colors.surface, dark ? 0.3 : 0.42)} style={frame}>{body}</Glass> : <View style={[frame, { backgroundColor: colors.surface }]}>{body}</View>}
    </Tap>
  );
}

function ProjectShelf({ chats, bots }: { chats: ChatSummary[]; bots: Map<string, Bot> }) {
  const projects = usePart("projects");
  const sorted = useMemo(() => [...(projects ?? [])].sort((a, b) => b.lastUsed - a.lastUsed), [projects]);
  return (
    <View>
      <PartHead title="Projects" more={sorted.length ? "See all " + sorted.length : undefined} onMore={() => router.push("/projects")} />
      {sorted.length === 0 ? (
        <Group>
          <Row leading={<IconTile icon={FolderClosed} />} title="Start a project" subtitle="Its chats, to-dos and files in one place" chevron onPress={() => router.push({ pathname: "/projects", params: { new: "1" } } as unknown as Href)} />
        </Group>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.md }}>
          {sorted.map((project) => (
            <ProjectCard key={project.id} project={project} chats={chats} bots={bots} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** Tasks on the overview: the chips, then the first three of the chosen one. */
const TaskPart = memo(function TaskPart({ tasks, bots }: { tasks: BotTask[]; bots: Map<string, Bot> }) {
  const [view, pick] = useState<TaskView>(lastView);
  const deferredView = useDeferredValue(view);
  const setView = useCallback((next: TaskView) => {
    lastView = next;
    pick(next);
  }, []);
  const counts = useMemo(() => taskCounts(tasks), [tasks]);
  const shown = useMemo(() => tasksIn(tasks, deferredView).slice(0, 3), [tasks, deferredView]);
  const total = counts.active + counts.later + counts.done;
  const empty = deferredView === "active" ? "Nothing in progress" : deferredView === "later" ? "Nothing put off" : "Nothing done yet";
  const pending = deferredView !== view;
  return (
    <View>
      <PartHead title="Tasks" more={total ? "See all " + total : undefined} onMore={() => router.push("/work/tasks" as Href)} />
      {total === 0 ? (
        <Group>
          <Row leading={<IconTile icon={CircleDashed} />} title="New task" subtitle="Hand a bot something to do" chevron onPress={() => openTask("new")} />
        </Group>
      ) : (
        <>
          <TaskChips view={view} onChange={setView} counts={counts} />
          {pending ? (
            <View style={{ paddingVertical: 28, alignItems: "center" }}>
              <LoadingGrid label="Loading" />
            </View>
          ) : (
            <Group inset={space.lg + 40 + space.md}>
              {shown.length ? (
                shown.map((task) => <TaskRow key={task.id} task={task} bot={task.botId ? bots.get(task.botId) : undefined} reviewer={task.reviewerBotId ? bots.get(task.reviewerBotId) : undefined} />)
              ) : (
                <Row title={empty} />
              )}
            </Group>
          )}
        </>
      )}
    </View>
  );
});

/** One routine in "Up next": when it runs, its name and bot, and its switch. */
function UpNextRow({ routine }: { routine: RoutineEntry }) {
  const { colors } = useTheme();
  const canManage = useCan("today", "manage");
  const name = routineName(routine);
  const on = routine.entry.enabled !== false;
  const at = routine.entry.nextAt ?? 0;
  return (
    <SplitRow
      leading={
        <View style={{ width: 72 }}>
          <T variant="headline" numberOfLines={1}>
            {clockTime(at)}
          </T>
          <T variant="caption" weight="400" color="muted" numberOfLines={1}>
            {dayWord(at)}
          </T>
        </View>
      }
      title={name}
      subtitle={routine.bot?.name}
      label={name + ", " + upcoming(at)}
      onPress={canManage ? () => openRoutine(routine.id) : () => openChat(routine.id)}
      accessory={
        canManage && (
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
  );
}

function RoutinePart({ routines }: { routines: RoutineEntry[] }) {
  const canCreate = useCan("today", "create");
  const next = useMemo(() => upNext(routines, 3), [routines]);
  return (
    <View>
      <PartHead title="Routines · up next" more={routines.length ? "See all " + routines.length : undefined} onMore={() => router.push("/work/routines" as Href)} />
      <Group inset={space.lg}>
        {next.length ? (
          next.map((routine) => <UpNextRow key={routine.id} routine={routine} />)
        ) : (
          <Row
            title={routines.length ? "Nothing scheduled" : "No routines yet"}
            chevron={!!routines.length || canCreate}
            onPress={routines.length ? () => router.push("/work/routines" as Href) : canCreate ? () => openRoutine("new") : undefined}
          />
        )}
      </Group>
    </View>
  );
}

/** What needs the person across Work: a bot's question or approval, and tasks to review or unblock. */
export function useNeeds(tasks: BotTask[], bots: Map<string, Bot>): Need[] {
  const requests = useApp((state) => state.parts.live?.requests);
  const workflowRuns = useWorkflowRuns();
  return useMemo(() => {
    const out: Need[] = [];
    for (const request of requests ?? []) {
      const bot = bots.get(request.botId);
      out.push({ key: "r" + request.id, bot, title: request.title, caption: (bot?.name ?? "A bot") + " is asking", onPress: () => openChat(request.chatId) });
    }
    for (const run of workflowRuns) {
      if (run.status === "waiting_approval" && run.pendingApproval) {
        out.push({
          key: "wf" + run.id,
          title: run.workflowName,
          caption: "Approval needed · " + run.pendingApproval.label,
          onPress: () => openWorkflow(run.workflowId),
        });
      }
    }
    for (const task of tasks)
      if (task.status === "blocked" || (task.status === "review" && !task.reviewerBotId)) {
        const bot = task.botId ? bots.get(task.botId) : undefined;
        out.push({ key: "t" + task.id, bot, title: task.title, caption: task.status === "review" ? "Ready for review" : "Blocked", onPress: () => openTask(task.id) });
      }
    return out;
  }, [requests, workflowRuns, tasks, bots]);
}

/** The plus at the top: New project, New task, New routine, as the person may. */
function NewMenu({ member, canRoutine }: { member: boolean; canRoutine: boolean }) {
  const { colors } = useTheme();
  const actions = [
    ...(member ? [] : [{ id: "project", title: "New project", image: "folder.badge.plus" }, { id: "task", title: "New task", image: "checklist" }]),
    ...(canRoutine ? [{ id: "routine", title: "New routine", image: "clock.arrow.circlepath" }, { id: "workflow", title: "New workflow", image: "point.3.connected.trianglepath.dotted" }] : []),
  ];
  if (!actions.length) return null;
  const run = (id: string) => {
    if (id === "project") router.push({ pathname: "/projects", params: { new: "1" } } as unknown as Href);
    else if (id === "task") openTask("new");
    else if (id === "routine") openRoutine("new");
    else if (id === "workflow") openWorkflow("new");
  };
  return (
    <MenuView title="New" actions={actions} onPressAction={({ nativeEvent }) => run(nativeEvent.event)}>
      <View accessible accessibilityRole="button" accessibilityLabel="New project, task, routine or workflow" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
        <Plus size={22} color={colors.onAccent} strokeWidth={2.2} />
      </View>
    </MenuView>
  );
}

const WorkContent = memo(function WorkContent({
  synced,
  allBots,
  chats,
  routines,
  allTasks,
  canToday,
  member,
}: {
  synced: boolean;
  allBots: Bot[];
  chats: ChatSummary[];
  routines: RoutineEntry[];
  allTasks: BotTask[] | undefined;
  canToday: boolean;
  member: boolean;
}) {
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const tasks = useMemo(() => (allTasks ?? []).filter((task) => task.status !== "archived"), [allTasks]);
  const needs = useNeeds(tasks, bots);
  if (!synced) return <Loading />;
  return (
    <>
      <NeedsYou needs={needs} />
      {!member && <ProjectShelf chats={chats} bots={bots} />}
      {!member && <TaskPart tasks={tasks} bots={bots} />}
      {canToday && <RoutinePart routines={routines} />}
    </>
  );
});

export default function Work() {
  const ready = useTabReady();
  const rawSynced = useApp((state) => state.synced);
  const rawBots = useBots();
  const rawChats = useChats();
  const rawRoutines = useRoutines();
  const rawTasks = usePart("tasks");
  const canToday = useCan("today", "view");
  const canCreateToday = useCan("today", "create");
  const member = !!useMember();
  // Hold the last visible snapshot while another tab is active so background chat/task updates
  // don't re-render the hidden Work tab.
  const frozen = useFrozenWhenHidden({
    synced: rawSynced,
    allBots: rawBots,
    chats: rawChats,
    routines: rawRoutines,
    allTasks: rawTasks,
  });
  return (
    <Page
      tab
      title="Work"
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <IconButton icon={ActivityIcon} label="Activity" variant="soft" size={44} onPress={() => router.push("/work/activity")} />
          <NewMenu member={member} canRoutine={canCreateToday} />
        </View>
      }
    >
      {!ready ? (
        <Loading />
      ) : (
        <WorkContent
          synced={frozen.synced}
          allBots={frozen.allBots}
          chats={frozen.chats}
          routines={frozen.routines}
          allTasks={frozen.allTasks}
          canToday={canToday}
          member={member}
        />
      )}
    </Page>
  );
}

/** Every routine, Today panels that refresh themselves, and schedules made in a chat (the route `/work/routines`). */
export function RoutinesPage() {
  const synced = useApp((state) => state.synced);
  const allBots = useBots();
  const chats = useChats();
  const routines = useRoutines();
  const canCreate = useCan("today", "create");
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  return (
    <Page title="Routines" actions={canCreate ? <IconButton icon={Plus} label="New routine" variant="accent" size={44} onPress={() => openRoutine("new")} /> : undefined}>
      {!synced ? <Loading /> : <Routines routines={routines} chats={chats} bots={bots} />}
    </Page>
  );
}
