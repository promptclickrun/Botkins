// A job, brought back (the sheet `/projects/job`, from a project's Jobs): what it changed on its branch, how far
// the checkout's branch moved since, what clashes, and its one main action, Bring in. A clash offers "Ask … to catch
// up": the bot merges the checkout's branch into its own, in its own worktree. The words are the computer's.
import { router, useLocalSearchParams } from "expo-router";
import { GitBranch, GitMerge, MessageCircle, Play, RefreshCw, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { openChat } from "@/features/chat/navigate";
import type { JobStatus } from "@/link/types";
import { useBot, useChat, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago } from "@/state/time";
import { BotAvatar, Button, EmptyState, Group, IconTile, Label, radius, Row, Sheet, space, T, useTheme } from "@/ui";
import { jobStage, STAGE_LABELS } from "./jobs";

const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);
const confirm = (title: string, body: string, yes: string, danger = false) =>
  new Promise<boolean>((resolve) =>
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: yes, style: danger ? "destructive" : "default", onPress: () => resolve(true) },
    ]),
  );

export default function JobSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useChat(id);
  const bot = useBot(chat?.botId);
  const live = usePart("live");
  const { colors } = useTheme();
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [clashes, setClashes] = useState<string[]>([]);
  const stage = chat ? jobStage(live, chat) : "finished";
  const job = chat?.job;
  // What it changed moves with the chat: read it again when its stage, its messages or its state change.
  useEffect(() => {
    if (!id || !job) return;
    void attempt(api.projectJobStatus(id)).then((found) => found && setStatus(found));
  }, [id, stage, chat?.count, chat?.time, job?.state]);
  if (!chat || !job)
    return (
      <Sheet title="Job">
        <EmptyState title="This job is gone" />
      </Sheet>
    );
  const name = bot?.name ?? "the bot";
  const act = async (what: string, call: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(what);
    await attempt(call(), done);
    setBusy("");
    const found = await attempt(api.projectJobStatus(chat.id));
    if (found) setStatus(found);
  };
  const bringIn = async () => {
    if (!status) return;
    const files = status.files?.length ?? 0;
    if (!(await confirm("Bring this job in?", "Merges " + status.branch + " (" + plural(files, "file") + ") into " + status.base + " in your checkout, then removes its worktree. Its branch stays.", "Bring in"))) return;
    await act("bring", async () => {
      const done = await api.bringInJob(chat.id);
      if (!done.ok) setClashes(done.conflicts);
    });
  };
  const remove = async () => {
    if (!(await confirm("Remove the worktree?", "What wasn't committed is committed on " + (job.branch ?? "its branch") + " first. The branch stays.", "Remove", true))) return;
    await act("remove", () => api.removeJobWorktree(chat.id), "Worktree removed");
  };
  const conflicts = clashes.length ? clashes : status?.conflicts ?? [];
  const idle = stage !== "working" && stage !== "setting-up";
  const open = job.where === "worktree" && job.state === "open";
  return (
    <Sheet title={chat.title || "Job"}>
      <View style={{ gap: space.lg }}>
        <Group>
          <Row leading={<BotAvatar bot={bot ?? { id: chat.botId }} size={36} badge={false} />} title={name} subtitle={STAGE_LABELS[stage] + " · started " + ago(job.createdAt)} />
          {job.where === "worktree" && !!job.branch && (
            <Row
              leading={<IconTile icon={GitBranch} />}
              title={job.branch}
              subtitle={
                "from " + (job.base ?? "main") + " @ " + (job.baseSha ?? "") +
                (status?.ahead !== undefined ? " · " + plural(status.ahead, "commit") + " ahead" : "") +
                (status?.behind ? " · " + status.base + " moved " + status.behind + " on" : "")
              }
              subtitleLines={2}
            />
          )}
          {job.where === "checkout" && <Row leading={<IconTile icon={GitBranch} />} title="Your checkout" subtitle="Its changes are there already" />}
        </Group>
        {!!job.setupError && (
          <View style={{ borderRadius: radius.md, padding: space.md, backgroundColor: colors.dangerSoft }}>
            <T variant="subhead" color="ink2">
              {"Setup failed. " + job.setupError}
            </T>
          </View>
        )}
        {job.carryFailed && (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            Your uncommitted changes didn't apply cleanly, so this worktree started from the last commit.
          </T>
        )}
        {!!status?.files?.length && (
          <View>
            <Label>{"Changes · " + plural(status.files.length, "file")}</Label>
            <Group>
              {status.files.slice(0, 20).map((file) => (
                <Row key={file.path} title={file.path} value={file.new ? "new" : "+" + file.added + " −" + file.removed} />
              ))}
            </Group>
          </View>
        )}
        {conflicts.length > 0 && (
          <View>
            <Label>{"Clashes with " + (status?.base ?? "main") + " · " + plural(conflicts.length, "file")}</Label>
            <Group>
              {conflicts.slice(0, 12).map((path) => (
                <Row key={path} title={path} />
              ))}
            </Group>
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
              {status?.base + " changed the same lines since this job started."}
            </T>
          </View>
        )}
        {job.state === "brought-in" && (
          <T variant="callout" color="muted" style={{ paddingHorizontal: space.xs }}>
            {"Brought in as " + job.mergedSha + ". Its branch stays."}
          </T>
        )}
        {!!status && open && !status.canBringIn && !!status.reason && !conflicts.length && (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {status.reason}
          </T>
        )}
        <View style={{ gap: space.sm }}>
          {open && <Button title={"Bring into " + (status?.base ?? job.base ?? "main")} icon={GitMerge} wide loading={busy === "bring"} disabled={!status?.canBringIn || !!busy} onPress={() => void bringIn()} />}
          {open && idle && (conflicts.length > 0 || (status?.behind ?? 0) > 0) && (
            <Button title={"Ask " + name + " to catch up"} icon={RefreshCw} variant="secondary" wide loading={busy === "catch"} disabled={!!busy} onPress={() => void act("catch", () => api.catchUpJob(chat.id), "Asked " + name)} />
          )}
          {idle && job.state === "open" && (job.setup === "failed" || job.setup === "waiting") && (
            <Button title="Start anyway" icon={Play} variant="secondary" wide loading={busy === "start"} disabled={!!busy} onPress={() => void act("start", () => api.startJobTurn(chat.id))} />
          )}
          <Button
            title="Open chat"
            icon={MessageCircle}
            variant="secondary"
            wide
            onPress={() => {
              // The sheet closes first, as the routine sheet's Open chat does, so the chat isn't under it.
              router.back();
              openChat(chat.id);
            }}
          />
          {open && idle && <Button title="Remove worktree" icon={Trash2} variant="ghost" wide disabled={!!busy} onPress={() => void remove()} />}
        </View>
      </View>
    </Sheet>
  );
}
