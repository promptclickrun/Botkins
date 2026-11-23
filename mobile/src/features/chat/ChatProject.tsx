// A chat's project and mode, chosen before its first message (the desktop's ProjectPicker in
// src/ProjectChanges.tsx), and the answer to a side question (/btw, /ask), shown beside the chat.
import type { MenuAction } from "@react-native-menu/menu";
import { MenuView } from "@react-native-menu/menu";
import { ChevronDown, FolderGit2, FolderKanban, X } from "lucide-react-native";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { MODE_LABELS, projectBlock, sortedProjects } from "@/features/bots/projectAccess";
import type { Bot, ChatMode, ChatSummary, Preferences, Project } from "@/link/types";
import { useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Markdown, radius, space, T, Tap, useTheme } from "@/ui";

const MODES: ChatMode[] = ["default", "plan", "yolo"];

type ProjectContext = { chat: ChatSummary; projects: Project[] | undefined; settings: Preferences | undefined; bots: Map<string, Bot> };

/** "Project" (No project, then each project, greyed out with the reason when the chat's bots can't use it) and, for a project with a folder, "Mode". */
export function projectActions({ chat, projects, settings, bots }: ProjectContext, multiple = false): MenuAction[] {
  const list = sortedProjects(projects);
  if (!list.length) return [];
  const members = (chat.botIds?.length ? chat.botIds : [chat.botId]).flatMap((id) => bots.get(id) ?? []);
  const group = members.length > 1;
  const chosen = list.find((project) => project.id === chat.projectId);
  const mode = chat.mode ?? "default";
  const out: MenuAction[] = [
    {
      id: "project",
      title: "Project",
      subtitle: chosen?.name ?? "No project",
      image: "folder",
      subactions: [
        { id: "project:", title: "No project", state: chosen ? "off" : "on" },
        ...list.map((project): MenuAction => {
          const reason = projectBlock(settings, members, project, group);
          return { id: "project:" + project.id, title: project.name, subtitle: reason || undefined, state: project.id === chosen?.id ? "on" : "off", attributes: { disabled: !!reason && project.id !== chosen?.id } };
        }),
      ],
    },
  ];
  if (chosen?.folder && !group)
    out.push({
      id: "mode",
      title: "Mode",
      subtitle: MODE_LABELS[mode].label,
      image: "slider.horizontal.3",
      subactions: MODES.map((value) => ({ id: "mode:" + value, title: MODE_LABELS[value].label, subtitle: MODE_LABELS[value].hint, state: value === mode ? "on" : "off" })),
    });
  if (multiple && chosen?.folders && chosen.folders.length > 1) out.push({
    id: "folder", title: "Folder", image: "folder", subactions: chosen.folders.map((path) => ({
      id: "folder:" + path, title: path, state: path === (chat.folder ?? chosen.folder) ? "on" : "off",
    })),
  });
  return out;
}

/** Carries out a choice from `projectActions`. Answers false for any other menu choice. */
export function runProjectChoice(chat: ChatSummary, event: string, savesMode = false): boolean {
  const mode = chat.mode ?? "default";
  if (event.startsWith("project:")) {
    const id = event.slice("project:".length) || null;
    if (id !== (chat.projectId ?? null)) void attempt(api.setChatProject(chat.id, id, savesMode ? undefined : mode));
    return true;
  }
  if (event.startsWith("folder:")) {
    void attempt(api.setChatFolder(chat.id, event.slice(7)));
    return true;
  }
  if (event.startsWith("mode:")) {
    const next = event.slice("mode:".length) as ChatMode;
    if (chat.projectId && savesMode) void attempt(api.updateProject(chat.projectId, { mode: next }).then(() => api.setChatProject(chat.id, chat.projectId ?? null, next)));
    else if (next !== mode) void attempt(api.setChatProject(chat.id, chat.projectId ?? null, next));
    return true;
  }
  return false;
}

/** On a chat with no messages yet: its project and mode, as one quiet pill that opens the choices. */
export function ProjectPill(context: ProjectContext) {
  const { colors } = useTheme();
  const multiple = useCapability("project-folders-v1");
  const savesMode = useCapability("project-mode-v1");
  const actions = projectActions(context, multiple);
  if (!actions.length) return null;
  const project = context.projects?.find((p) => p.id === context.chat.projectId);
  const Icon = project?.folder ? FolderGit2 : FolderKanban;
  const label = project ? project.name + (multiple && project.folder ? " · " + (context.chat.folder ?? project.folder) : "") + (project.folder && actions.length > 1 ? " · " + MODE_LABELS[context.chat.mode ?? "default"].label : "") : "Work in a project…";
  return (
    <MenuView actions={actions} onPressAction={({ nativeEvent }) => runProjectChoice(context.chat, nativeEvent.event, savesMode)}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={project ? "Project, " + label : label}
        style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}
      >
        <Icon size={15} color={colors.muted} strokeWidth={2.2} />
        <T variant="subhead" weight="600" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
          {label}
        </T>
        <ChevronDown size={14} color={colors.faint} strokeWidth={2.4} />
      </View>
    </MenuView>
  );
}

export type Side = { question: string; answer?: string; error?: string };

/** The answer to a side question. It is not part of the chat, and goes when dismissed. */
export function SideAnswer({ side, onDismiss }: { side: Side; onDismiss: () => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel="Side answer" style={{ gap: 4, paddingLeft: space.md, paddingBottom: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <T variant="caption" weight="700" color="muted" style={{ flex: 1 }}>
          Side question
        </T>
        <Tap onPress={onDismiss} feel="select" accessibilityLabel="Dismiss side answer" style={{ width: 44, height: 40, alignItems: "center", justifyContent: "center" }}>
          <X size={15} color={colors.muted} strokeWidth={2.4} />
        </Tap>
      </View>
      <View style={{ paddingRight: space.md, gap: space.xs }}>
        <T variant="footnote" color="muted" numberOfLines={2}>
          {side.question}
        </T>
        {side.answer ? (
          <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
            <Markdown text={side.answer} />
          </ScrollView>
        ) : side.error ? (
          <T variant="subhead" color="danger">
            {side.error}
          </T>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <ActivityIndicator color={colors.muted} size="small" />
            <T variant="subhead" color="muted">
              Asking the model…
            </T>
          </View>
        )}
      </View>
    </View>
  );
}
