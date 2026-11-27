// A project's Jobs ("project-jobs-v1"; the computer's src/ProjectJobs.tsx, in the same words): write a prompt, or a
// batch of them, pick the bots that can open the project, and each bot gets its own chat on its own branch, in a git
// worktree made from the checkout. The feed under it is every job, newest first; a job opens its sheet
// (`/projects/job`), where it is brought back. "Where it works" (`/projects/where`) shows the checkout and the
// repository's setup commands, which need the person's yes. The plain logic is `jobLogic.ts`.
import { router } from "expo-router";
import { GitBranch, Plus, Rocket, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import type { ChatMode, JobSetup, Project } from "@/link/types";
import { canUseProject } from "@/features/bots/projectAccess";
import { useBots, useChats, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { BotAvatar, Button, Chip, Field, Group, IconButton, IconTile, Label, Row, Segmented, space, T, useTheme } from "@/ui";
import { FolderChoice } from "./ProjectFolders";
import { baseName, jobCounts, jobStage, launchable, launchLabel, projectJobs, STAGE_LABELS, toggleBot, type Draft } from "./jobLogic";
import { MODES } from "./logic";

const WHERE = [
  { value: "worktree" as const, label: "Own worktree" },
  { value: "checkout" as const, label: "Your checkout" },
];

/** Where a project's jobs start, read again when the folder changes and when a job is brought in (the checkout moves). */
export function useJobSetup(project: Project, folder: string | undefined, again: unknown) {
  const [setup, setSetup] = useState<JobSetup | null>(null);
  const load = useCallback(() => {
    if (!project.folder) return;
    void attempt(api.projectJobSetup(project.id, folder)).then((found) => found && setSetup(found));
  }, [project.id, project.folder, folder]);
  useEffect(() => {
    setSetup(null);
    load();
  }, [load, again]);
  return { setup, load };
}

/** YOLO gives each request a yes with no question, so starting in it asks first, as the computer does. */
const askYolo = (count: number) =>
  new Promise<boolean>((resolve) =>
    Alert.alert("Start in YOLO mode?", "Each request of the bot in " + (count === 1 ? "this job" : "these jobs") + " gets a yes with no question, but for one that leaves the sandbox.", [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Start", style: "destructive", onPress: () => resolve(true) },
    ]),
  );

export function Jobs({ project }: { project: Project }) {
  const { colors } = useTheme();
  const settings = usePart("settings");
  const live = usePart("live");
  const online = useOnline();
  const allBots = useBots();
  const bots = allBots.filter((bot) => canUseProject(settings, bot, project));
  const chats = useChats();
  const jobs = projectJobs(chats, project.id);
  const [folder, setFolder] = useState<string>();
  const chosenFolder = project.folders?.includes(folder ?? "") ? folder : undefined;
  const broughtIn = jobs.filter((chat) => chat.job?.state === "brought-in").length;
  const { setup } = useJobSetup(project, chosenFolder, broughtIn);
  const repo = setup?.repo ? setup : null;
  const [pickedWhere, setWhere] = useState<"worktree" | "checkout">("worktree");
  const where = repo ? pickedWhere : "checkout";
  const inCheckout = where === "checkout";
  const [mode, setMode] = useState<ChatMode>(project.mode ?? "default");
  const [carry, setCarry] = useState(false);
  const first = bots[0]?.id;
  const [drafts, setDrafts] = useState<Draft[]>([{ id: 1, prompt: "", botIds: first ? [first] : [] }]);
  const [busy, setBusy] = useState(false);
  // A draft written before the bots arrived, or whose bot lost its access, gets the first bot that can open the project.
  const known = bots.map((bot) => bot.id).join(",");
  useEffect(() => {
    setDrafts((list) =>
      list.map((draft) => {
        const kept = draft.botIds.filter((id) => known.split(",").includes(id));
        return { ...draft, botIds: kept.length ? kept : first ? [first] : [] };
      }),
    );
  }, [known, first]);
  const { ready, jobs: count } = launchable(drafts);
  const needsYes = !inCheckout && !!repo && !repo.approved && !repo.error;
  const update = (id: number, patch: Partial<Draft>) => setDrafts((list) => list.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  const openWhere = () => router.push({ pathname: "/projects/where", params: { id: project.id, ...(chosenFolder && { folder: chosenFolder }) } });
  const chooseWhere = (next: "worktree" | "checkout") => {
    setWhere(next);
    // Your checkout takes one job at a time: one prompt, one bot.
    if (next === "checkout") setDrafts((list) => [{ ...list[0]!, botIds: list[0]!.botIds.slice(0, 1) }]);
  };
  const launch = async () => {
    if (!ready.length || busy) return;
    if (needsYes) return openWhere();
    if (mode === "yolo" && project.folder && !(await askYolo(count))) return;
    setBusy(true);
    for (const draft of ready) {
      const ids = await attempt(api.startProjectJob(project.id, { botIds: draft.botIds, prompt: draft.prompt.trim(), where, mode: project.folder ? mode : "default", ...(chosenFolder && { folder: chosenFolder }), ...(carry && !inCheckout && { carry: true }) }));
      if (!ids) break;
      // A draft that started leaves the batch: when a later one fails, what is left is what didn't start.
      setDrafts((list) => (list.length > 1 ? list.filter((entry) => entry.id !== draft.id) : [{ id: draft.id + 1, prompt: "", botIds: draft.botIds }]));
    }
    setCarry(false);
    setBusy(false);
  };

  const fromLine = repo ? (repo.base ?? "detached") + " @ " + (repo.short ?? "no commit") : "";
  const counts = jobCounts(live, jobs);
  return (
    <View style={{ gap: space.md }}>
      <View>
        <Label>{counts ? "Jobs · " + counts : "Jobs"}</Label>
        <Group>
          {!!project.folder && (
            <Row
              leading={<IconTile icon={GitBranch} color={needsYes ? colors.warning : undefined} />}
              title={repo ? baseName(repo.root) + " · " + fromLine : setup ? "Not a git repository" : "Reading the checkout…"}
              subtitle={needsYes ? "Setup commands need your yes" : repo ? (repo.changed ? repo.changed + (repo.changed === 1 ? " change" : " changes") + " not committed" : "Clean") : "Jobs work right in the folder"}
              chevron
              onPress={openWhere}
            />
          )}
          {bots.length === 0 ? (
            <Row title="No bot can open this project yet" subtitle="Give one access under Access" />
          ) : (
            drafts.map((draft, index) => (
              <View key={draft.id} style={{ padding: space.lg, gap: space.sm }}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                  <Field
                    area
                    placeholder={index === 0 ? "What should it do?" : "And another job…"}
                    accessibilityLabel={drafts.length > 1 ? "Prompt " + (index + 1) : "Prompt"}
                    value={draft.prompt}
                    onChangeText={(prompt) => update(draft.id, { prompt })}
                    maxLength={32000}
                    containerStyle={{ flex: 1 }}
                  />
                  {drafts.length > 1 && <IconButton icon={X} label={"Remove prompt " + (index + 1)} size={36} onPress={() => setDrafts((list) => list.filter((entry) => entry.id !== draft.id))} />}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm }}>
                  {bots.map((bot) => (
                    <Chip
                      key={bot.id}
                      label={bot.name}
                      selected={draft.botIds.includes(bot.id)}
                      onPress={() => update(draft.id, { botIds: toggleBot(draft, bot.id, inCheckout) })}
                      leading={<BotAvatar bot={bot} size={24} badge={false} style={{ marginLeft: -8 }} />}
                    />
                  ))}
                </ScrollView>
              </View>
            ))
          )}
          {bots.length > 0 && !inCheckout && drafts.length < 10 && (
            <Row
              leading={<Plus size={20} color={colors.accentText} strokeWidth={2.4} />}
              title="Add a prompt"
              tone="accent"
              onPress={() => setDrafts((list) => [...list, { id: Math.max(...list.map((entry) => entry.id)) + 1, prompt: "", botIds: list.at(-1)!.botIds }])}
            />
          )}
          {!!repo && !inCheckout && repo.changed > 0 && <Row title="Bring uncommitted changes" toggled={carry} onToggle={setCarry} />}
        </Group>
      </View>
      {bots.length > 0 && (
        <>
          {!!repo && <Segmented options={WHERE} value={where} onChange={chooseWhere} />}
          {!!project.folder && <Segmented options={MODES} value={mode} onChange={setMode} />}
          <FolderChoice project={project} value={folder} change={setFolder} />
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {!project.folder
              ? "Each prompt starts its own chat in this project."
              : inCheckout
                ? "Works right in your checkout, one job at a time."
                : "Each bot gets its own chat, on its own branch from " + fromLine + "."}
            {mode === "yolo" && project.folder ? " " + MODES.find((item) => item.value === "yolo")!.hint : ""}
          </T>
          <Button title={busy ? "Starting…" : launchLabel(count)} icon={Rocket} wide loading={busy} disabled={!count || !online || (!!project.folder && !setup)} onPress={() => void launch()} />
        </>
      )}
      {jobs.length > 0 && (
        <Group flat inset={space.lg + 36 + space.md}>
          {jobs.map((chat) => {
            const bot = allBots.find((entry) => entry.id === chat.botId);
            const stage = jobStage(live, chat);
            return (
              <Row
                key={chat.id}
                leading={<BotAvatar bot={bot ?? { id: chat.botId }} size={36} badge={false} />}
                title={chat.title || "Job"}
                subtitle={[bot?.name, chat.job!.where === "checkout" ? "Your checkout" : chat.job!.branch].filter(Boolean).join(" · ")}
                value={STAGE_LABELS[stage]}
                chevron
                onPress={() => router.push({ pathname: "/projects/job", params: { id: chat.id } })}
              />
            );
          })}
        </Group>
      )}
    </View>
  );
}
