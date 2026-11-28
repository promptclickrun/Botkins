// Project index (Channels-style hub): header with progress bar + folder chip,
// New chat & Start job buttons side by side, "Pick up where you left off", and three fixed groups
// (Work, Files and views, Settings) that drill into dedicated subpages.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import {
  Check,
  CheckSquare,
  Ellipsis,
  FolderOpen,
  GitCompareArrows,
  LayoutGrid,
  MessagesSquare,
  Paperclip,
  SquarePen,
  Users,
  Zap,
} from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { openChat } from "@/features/chat/navigate";
import { useSpaces, useSpacesOn } from "@/features/spaces/data";
import { projectProgress } from "@/features/work/overview";
import type { Artifact, Project, ProjectColor } from "@/link/types";
import { useBots, useCan, useCapability, useChats, useMember, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import {
  Badge,
  BotAvatar,
  Button,
  Chip,
  EmptyState,
  Field,
  Group,
  IconButton,
  IconTile,
  Label,
  Loading,
  Page,
  Row,
  space,
  T,
  Tap,
  useTheme,
} from "@/ui";
import { PROJECT_COLORS, projectColor } from "./colors";
import { buildProjectIndex, folderLabel, type ProjectIndexKey, type ProjectIndexRow } from "./logic";

export default function ProjectPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useApp((state) => state.parts.projects?.find((item) => item.id === id));
  const synced = useApp((state) => state.synced);
  if (!project) {
    return (
      <Page>
        {synced ? <EmptyState title="This project is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}
      </Page>
    );
  }
  return <ProjectIndex project={project} />;
}

function BarButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Tap
      onPress={onPress}
      feel="select"
      accessibilityLabel={title}
      style={{ minWidth: 44, height: 44, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}
    >
      <T variant="headline" color="accentText">
        {title}
      </T>
    </Tap>
  );
}

function removeProject(project: Project) {
  Alert.alert("Delete " + project.name + "?", "Its chats are kept.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: () => {
        router.back();
        void attempt(api.removeProject(project.id), "Project deleted");
      },
    },
  ]);
}

function EditProject({ project, onDone }: { project: Project; onDone: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [color, setColor] = useState<ProjectColor>(project.color ?? "gray");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const ok = await attempt(
      api.updateProject(project.id, { name: name.trim(), description: description.trim(), color }).then(() => true),
      "Saved",
    );
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <View style={{ gap: space.lg }}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={80} autoFocus returnKeyType="next" />
      <Field label="Description" placeholder="What it's about" value={description} onChangeText={setDescription} maxLength={200} />
      <View>
        <Label>Color</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }} accessibilityRole="radiogroup">
          {PROJECT_COLORS.map((option) => {
            const on = option.value === color;
            const fill = projectColor(option.value, theme);
            return (
              <Tap
                key={option.value}
                onPress={() => setColor(option.value)}
                feel="select"
                sink={0.9}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ selected: on }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 2,
                  borderColor: on ? colors.ink : "transparent",
                }}
              >
                <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: fill, alignItems: "center", justifyContent: "center" }}>
                  {on && <Check size={16} color={colors.onPrimary} strokeWidth={3} />}
                </View>
              </Tap>
            );
          })}
        </View>
      </View>
      <Button title="Save" wide onPress={() => void save()} loading={busy} disabled={!name.trim()} />
    </View>
  );
}

function IndexRow({
  row,
  onPress,
}: {
  row: ProjectIndexRow;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const tileSpec: Record<ProjectIndexKey, { icon: typeof Zap; color: string }> = {
    jobs: { icon: Zap, color: colors.warning },
    todos: { icon: CheckSquare, color: colors.success },
    chats: { icon: MessagesSquare, color: colors.accent },
    artifacts: { icon: Paperclip, color: colors.warning },
    spaces: { icon: LayoutGrid, color: colors.info },
    changes: { icon: GitCompareArrows, color: colors.ink2 },
    access: { icon: Users, color: colors.muted },
    folders: { icon: FolderOpen, color: colors.muted },
  };
  const spec = tileSpec[row.key];
  return (
    <Row
      leading={<IconTile icon={spec.icon} color={spec.color} size={36} />}
      title={row.title}
      subtitle={row.subtitle}
      value={row.badge ? undefined : row.count !== undefined ? String(row.count) : undefined}
      trailing={row.badge ? <Badge label={row.badge.label} tone={row.badge.tone} /> : undefined}
      chevron
      onPress={onPress}
    />
  );
}

export function ProjectIndex({ project }: { project: Project }) {
  const theme = useTheme();
  const { colors } = theme;
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const [editing, setEditing] = useState(false);

  const online = useOnline();
  const member = useMember();
  const canChat = useCan("agents", "chat");
  const jobsOn = useCapability("project-jobs-v1") && !member;
  const artifactsOn = useCapability("project-artifacts-v1");
  const cloneOn = useCapability("project-clone-v1");
  const spacesOn = useSpacesOn();

  const chats = useChats();
  const live = usePart("live");
  const bots = useBots();
  const settings = usePart("settings");
  const todays = usePart("panels");
  const everywhere = usePart("projectPanels");
  const spaces = useSpaces();

  const [artifacts, setArtifacts] = useState<Artifact[]>();
  const artifactIds = (project.artifacts ?? []).join(" ");
  useEffect(() => {
    if (!artifactsOn || !online || !(project.artifacts?.length)) {
      setArtifacts(undefined);
      return;
    }
    let active = true;
    api.projectArtifacts(project.id).then(
      (answer) => active && setArtifacts(answer.items),
      () => active && setArtifacts((prev) => prev ?? []),
    );
    return () => {
      active = false;
    };
  }, [artifactsOn, online, project.id, artifactIds]);

  const [gitState, setGitState] = useState<{ repo: boolean; changed: number | null }>({
    repo: false,
    changed: null,
  });
  useEffect(() => {
    if (!project.folder) {
      setGitState({ repo: false, changed: null });
      return;
    }
    if (!online) {
      setGitState((prev) => ({ repo: prev.repo || true, changed: prev.changed }));
      return;
    }
    let active = true;
    api
      .projectChanges(project.id)
      .then((res) => {
        if (!active) return;
        setGitState(res.repo ? { repo: true, changed: res.files.length } : { repo: false, changed: null });
      })
      .catch(() => {
        if (!active) return;
        setGitState({ repo: false, changed: null });
      });
    return () => {
      active = false;
    };
  }, [online, project.id, project.folder]);

  const panels = useMemo(
    () => (spacesOn && everywhere ? everywhere : todays) ?? [],
    [spacesOn, everywhere, todays],
  );

  const index = useMemo(
    () =>
      buildProjectIndex({
        project,
        chats,
        live,
        bots,
        settings,
        artifacts,
        spaces,
        panels,
        changedFiles: gitState.changed,
        features: {
          jobs: jobsOn,
          artifacts: artifactsOn,
          spaces: spacesOn,
          changes: gitState.repo,
        },
      }),
    [project, chats, live, bots, settings, artifacts, spaces, panels, gitState, jobsOn, artifactsOn, spacesOn],
  );

  const progress = projectProgress(project);
  const dotColor = projectColor(project.color, theme);
  const folders = project.folders?.length ? project.folders : project.folder ? [project.folder] : [];
  const recentChat = index.recentChat;
  const recentBot = recentChat ? bots.find((b) => b.id === recentChat.botId) : undefined;

  const openSubpage = (key: ProjectIndexKey) => {
    if (key === "changes") {
      router.push(("/chat/changes?id=" + encodeURIComponent(project.id)) as Href);
      return;
    }
    const routeByKey: Record<Exclude<ProjectIndexKey, "changes">, string> = {
      jobs: "/projects/[id]/jobs",
      todos: "/projects/[id]/todos",
      chats: "/projects/[id]/chats",
      artifacts: "/projects/[id]/artifacts",
      spaces: "/projects/[id]/spaces",
      access: "/projects/[id]/access",
      folders: "/projects/[id]/folders",
    };
    router.push({ pathname: routeByKey[key] as any, params: { id: project.id } });
  };

  const menuActions = [
    { id: "edit", title: "Edit project", image: "pencil" },
    ...(cloneOn ? [{ id: "clone", title: "Clone repository", image: "arrow.down.circle" }] : []),
    { id: "delete", title: "Delete project", image: "trash", attributes: { destructive: true } },
  ];

  const inset = space.lg + 36 + space.md;

  return (
    <Page title={editing ? "Edit project" : project.name} caption={editing ? undefined : project.description} keyboard={editing}>
      <Stack.Screen
        options={{
          headerRight: () =>
            editing ? (
              <BarButton title="Cancel" onPress={() => setEditing(false)} />
            ) : (
              <MenuView
                title={project.name}
                actions={menuActions}
                onPressAction={({ nativeEvent }) => {
                  const action = nativeEvent.event;
                  if (action === "edit") setEditing(true);
                  else if (action === "clone") {
                    router.push({ pathname: "/projects/[id]/folders" as any, params: { id: project.id, clone: "1" } });
                  } else if (action === "delete") removeProject(project);
                }}
              >
                <IconButton
                  icon={Ellipsis}
                  label="Project actions"
                  variant={hasBackdrop ? "glass" : "soft"}
                />
              </MenuView>
            ),
        }}
      />

      {editing ? (
        <EditProject project={project} onDone={() => setEditing(false)} />
      ) : (
        <>
          <View style={{ gap: space.md, marginTop: -space.sm }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}
              accessible
              accessibilityLabel={progress.line + ", used " + ago(project.lastUsed)}
            >
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor }} />
              <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.sunken, overflow: "hidden" }}>
                <View style={{ width: `${Math.round(progress.share * 100)}%`, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
              </View>
              <T variant="footnote" weight="600" color="ink2">
                {progress.line}
              </T>
            </View>

            {folders.length > 0 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Chip
                  label={folderLabel(folders[0]!)}
                  icon={FolderOpen}
                  accessibilityLabel={"Folder " + folders[0]}
                  onPress={() => openSubpage("folders")}
                />
                {folders.length > 1 && (
                  <Chip
                    label={"+" + (folders.length - 1) + (folders.length === 2 ? " folder" : " folders")}
                    onPress={() => openSubpage("folders")}
                  />
                )}
              </View>
            )}

            {(canChat || jobsOn) && (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {canChat && (
                  <View style={{ flex: 1 }}>
                    <Button
                      title="New chat"
                      icon={SquarePen}
                      variant="primary"
                      wide
                      onPress={() =>
                        router.push({ pathname: "/chat/new", params: { project: project.id } } as unknown as Href)
                      }
                    />
                  </View>
                )}
                {jobsOn && (
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Start job"
                      icon={Zap}
                      variant={hasBackdrop ? "glass" : "secondary"}
                      wide
                      onPress={() => openSubpage("jobs")}
                    />
                  </View>
                )}
              </View>
            )}
          </View>

          {recentChat && (
            <View>
              <Label>Pick up where you left off</Label>
              <Group inset={inset}>
                <Row
                  leading={<BotAvatar bot={recentBot ?? { id: recentChat.botId }} size={36} badge={false} />}
                  title={recentChat.title || recentBot?.name || "Chat"}
                  subtitle={[recentBot?.name, ago(recentChat.time)].filter(Boolean).join(" · ")}
                  chevron
                  onPress={() => openChat(recentChat.id)}
                />
              </Group>
            </View>
          )}

          <View>
            <Label>Work</Label>
            <Group inset={inset}>
              {index.work.map((row) => (
                <IndexRow key={row.key} row={row} onPress={() => openSubpage(row.key)} />
              ))}
            </Group>
          </View>

          <View>
            <Label>Files and views</Label>
            <Group inset={inset}>
              {index.files.map((row) => (
                <IndexRow key={row.key} row={row} onPress={() => openSubpage(row.key)} />
              ))}
            </Group>
          </View>

          <View>
            <Label>Settings</Label>
            <Group inset={inset}>
              {index.settings.map((row) => (
                <IndexRow key={row.key} row={row} onPress={() => openSubpage(row.key)} />
              ))}
            </Group>
          </View>
        </>
      )}
    </Page>
  );
}
