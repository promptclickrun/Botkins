import { router, useLocalSearchParams } from "expo-router";
import { Archive, CircleAlert, MessageCircle, Trash2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { openChat as openChatRoute } from "@/features/chat/navigate";
import type { BotTask, TaskPriority } from "@/link/types";
import { useBots, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { Badge, Button, EmptyState, Field, Group, IconTile, Label, Loading, Markdown, radius, Row, Segmented, Sheet, space, T, useTheme } from "@/ui";
import { BotChips, STATUS_LABEL, STATUS_TONE } from "./bits";

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];
const STARTS: { value: "later" | "ready"; label: string }[] = [
  { value: "later", label: "Later" },
  { value: "ready", label: "Ready" },
];

export default function TaskEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tasks = usePart("tasks");
  const synced = useApp((state) => state.synced);
  const task = tasks?.find((item) => item.id === id);
  if (id !== "new" && !task)
    return <Sheet title="Task">{synced ? <EmptyState title="This task is gone" action="Close" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  return <Editor key={task?.id ?? "new"} task={task} />;
}

function Editor({ task }: { task?: BotTask }) {
  const { colors } = useTheme();
  const bots = useBots();
  const shownBots = useMemo(() => bots.filter((bot) => !bot.hidden || bot.id === task?.botId), [bots, task?.botId]);
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const [botId, setBotId] = useState<string | null>(task ? task.botId : null);
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "normal");
  const [start, setStart] = useState<"later" | "ready">("ready");
  const [saving, setSaving] = useState(false);

  const working = task?.status === "working";
  const ready = !!title.trim() && !working;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    const fields = { title: title.trim(), body: body.trim(), botId, priority };
    const saved = await attempt(api.saveTask(task ? { id: task.id, ...fields } : { ...fields, status: start }), task ? "Saved" : "Task added");
    setSaving(false);
    if (saved) router.back();
  };

  return (
    <Sheet title={task ? "Task" : "New task"} action={working ? undefined : task ? "Save" : "Add"} onAction={() => void save()} actionDisabled={!ready} actionLoading={saving}>
      {task && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge
            label={task.status === "review" && task.reviewerBotId ? "Reviewing: " + (bots.find((b) => b.id === task.reviewerBotId)?.name ?? "Creator") : STATUS_LABEL[task.status]}
            tone={task.status === "review" && task.reviewerBotId ? "accent" : STATUS_TONE[task.status]}
          />
          {working && <ActivityIndicator size="small" color={colors.accent} />}
          <T variant="footnote" color="muted" style={{ flex: 1 }} numberOfLines={1}>
            {working ? "Working on it" : "Updated " + ago(task.updatedAt)}
          </T>
        </View>
      )}

      {!!task?.problem && (
        <View style={{ padding: space.lg, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.dangerSoft }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <CircleAlert size={15} color={colors.danger} strokeWidth={2.4} />
            <T variant="label" color="danger" style={{ textTransform: "uppercase" }}>
              Problem
            </T>
          </View>
          <Markdown text={task.problem} size="small" />
        </View>
      )}
      {!!task?.result && (
        <View style={{ padding: space.lg, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
          <T variant="label" color="muted" style={{ textTransform: "uppercase" }}>
            Result
          </T>
          <Markdown text={task.result} size="small" />
        </View>
      )}

      {task && <StatusActions task={task} />}

      <View style={{ gap: space.lg }} pointerEvents={working ? "none" : "auto"}>
        <Field label="Title" placeholder="Write the launch FAQ" value={title} onChangeText={setTitle} editable={!working} returnKeyType="next" maxLength={160} autoFocus={!task} />
        <Field label="Details" placeholder="Anything the bot should know" value={body} onChangeText={setBody} editable={!working} area />
      </View>

      <View>
        <Label>Bot</Label>
        <BotChips bots={shownBots} value={botId} onChange={setBotId} none="No bot" disabled={working} />
      </View>

      <View style={{ opacity: working ? 0.5 : 1 }} pointerEvents={working ? "none" : "auto"}>
        <Label>Priority</Label>
        <Segmented options={PRIORITIES} value={priority} onChange={setPriority} />
      </View>

      {!task && (
        <View>
          <Label>Start</Label>
          <Segmented options={STARTS} value={start} onChange={setStart} />
          {start === "ready" && !!botId && (
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
              Starts right away.
            </T>
          )}
        </View>
      )}

      {!!task?.history?.length && (
        <View style={{ gap: space.xs }}>
          <Label>History</Label>
          <Group>
            {task.history.slice(-8).reverse().map((h, idx) => (
              <Row
                key={h.at + "-" + idx}
                title={(h.byName ?? h.by) + " · " + h.from + " → " + h.to}
                subtitle={h.note}
              />
            ))}
          </Group>
        </View>
      )}
      {task && <TaskRows task={task} />}
    </Sheet>
  );
}

/** What the person can do next, for the task's state. */
function StatusActions({ task }: { task: BotTask }) {
  const [askingNote, setAskingNote] = useState(false);
  const [note, setNote] = useState("");
  const move = (status: "done" | "ready" | "later", done: string, options?: { note?: string }) =>
    void attempt(api.moveTask(task.id, status, options), done);
  if (task.status === "review")
    return (
      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Button title="Approve" onPress={() => move("done", "Approved")} style={{ flex: 1 }} />
          <Button title="Request changes" variant="secondary" onPress={() => setAskingNote((v) => !v)} style={{ flex: 1 }} />
        </View>
        {askingNote && (
          <View style={{ gap: space.sm }}>
            <Field
              label="Changes requested"
              placeholder="Tell the bot what to change in this chat"
              value={note}
              onChangeText={setNote}
              area
            />
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button title="Move to Later" variant="secondary" onPress={() => move("later", "Moved to Later", note.trim() ? { note: note.trim() } : undefined)} style={{ flex: 1 }} />
              <Button
                title="Send back"
                disabled={!note.trim()}
                onPress={() => {
                  move("ready", "Sent back", { note: note.trim() });
                  setAskingNote(false);
                  setNote("");
                }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        )}
      </View>
    );
  if (task.status === "done") return <Button title="Reopen" variant="secondary" wide onPress={() => move("ready", "Reopened")} />;
  if (task.status === "blocked") return <Button title="Retry" wide onPress={() => move("ready", "Sent back")} />;
  if ((task.status === "later" || task.status === "ready") && task.botId) return <Button title="Start now" wide onPress={() => void attempt(api.startTask(task.id), "Started")} />;
  return null;
}

function TaskRows({ task }: { task: BotTask }) {
  const { colors } = useTheme();
  const remove = () =>
    Alert.alert("Delete this task?", task.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          router.back();
          void attempt(api.deleteTask(task.id), "Task deleted");
        },
      },
    ]);
  const archive = () => {
    router.back();
    void attempt(api.moveTask(task.id, "archived"), "Archived");
  };
  const chatId = task.chatId;
  const openChat = () => {
    if (!chatId) return;
    router.back();
    openChatRoute(chatId);
  };
  return (
    <Group>
      {!!chatId && <Row leading={<IconTile icon={MessageCircle} color={colors.info} />} title="Open chat" chevron onPress={openChat} />}
      {task.status !== "working" && task.status !== "archived" && <Row leading={<IconTile icon={Archive} color={colors.ink2} />} title="Archive" onPress={archive} />}
      <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Delete task" tone="danger" onPress={remove} />
    </Group>
  );
}
