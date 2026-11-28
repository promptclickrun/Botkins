// Project subpage: Folders (existing folder list: make default, remove, add folder; plus existing clone form).
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { FolderMinus, FolderOpen, GitCompareArrows, Plus } from "lucide-react-native";
import { Alert, View } from "react-native";
import type { Project } from "@/link/types";
import { useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { Button, EmptyState, Group, HoldMenu, IconButton, IconTile, Label, Loading, Page, Row, space, T, useTheme } from "@/ui";
import { CloneForm } from "./ProjectFolders";

export function ProjectFoldersContent({ project, defaultCloneOpen = false }: { project: Project; defaultCloneOpen?: boolean }) {
  const { colors } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const canFolders = useCapability("folders-v1");
  const multiple = useCapability("project-folders-v1");
  const folders = project.folders?.length ? project.folders : project.folder ? [project.folder] : [];
  const pickFolder = () => router.push({ pathname: "/folders", params: { use: "project", id: project.id } } as unknown as Href);

  const removeSingle = () =>
    Alert.alert(
      "Remove the folder from " + project.name + "?",
      "Chats here lose the coding modes. Nothing in the folder is touched.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove folder",
          style: "destructive",
          onPress: () => void attempt(api.updateProject(project.id, { folder: null }), "Folder removed"),
        },
      ],
    );

  const removeMulti = (folder: string) =>
    Alert.alert("Remove this folder?", folder + " stays on the computer.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove folder",
        style: "destructive",
        onPress: () => void attempt(api.editProjectFolder(project.id, "remove", folder)),
      },
    ]);

  const caption =
    folders.length === 0
      ? "No folder"
      : folders.length === 1
        ? "1 folder"
        : `${folders.length} folders`;

  return (
    <Page title="Folders" caption={caption} keyboard>
      {canFolders && (
        <Stack.Screen
          options={{
            headerRight: () => (
              <IconButton
                icon={Plus}
                label={multiple ? "Add folder" : "Choose folder"}
                variant={hasBackdrop ? "glass" : "soft"}
                onPress={pickFolder}
              />
            ),
          }}
        />
      )}

      {folders.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No folder attached"
          text={
            canFolders
              ? "Add a folder on your computer to enable coding modes and git changes."
              : "Update the app on your computer to choose a folder from here."
          }
          action={canFolders ? "Add folder" : undefined}
          onAction={canFolders ? pickFolder : undefined}
        />
      ) : multiple ? (
        <View style={{ gap: space.md }}>
          <View>
            <Label>Folders</Label>
            <Group inset={space.lg + 32 + space.md}>
              {folders.map((folder, index) => (
                <HoldMenu
                  key={folder}
                  actions={[
                    ...(index > 0 ? [{ id: "default", title: "Make default", image: "star" }] : []),
                    { id: "remove", title: "Remove folder", image: "trash", attributes: { destructive: true } },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "default") void attempt(api.editProjectFolder(project.id, "default", folder));
                    else if (nativeEvent.event === "remove") removeMulti(folder);
                  }}
                >
                  <Row
                    leading={<IconTile icon={FolderOpen} color={colors.ink2} />}
                    title={folder}
                    subtitle={index === 0 ? "Default folder" : "Hold for options"}
                    titleLines={2}
                  />
                </HoldMenu>
              ))}
            </Group>
          </View>
          {folders.length > 1 && (
            <Group>
              {folders.slice(1).map((folder) => (
                <Row
                  key={"def-" + folder}
                  title={`Make ${folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder} default`}
                  tone="accent"
                  onPress={() => void attempt(api.editProjectFolder(project.id, "default", folder))}
                />
              ))}
            </Group>
          )}
          {canFolders && <Button title="Add folder…" variant="secondary" wide onPress={pickFolder} />}
        </View>
      ) : (
        <Group>
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }}
            accessible
            accessibilityLabel={"Folder on your computer, " + project.folder}
          >
            <FolderOpen size={18} color={colors.muted} strokeWidth={2.2} />
            <T variant="mono" color="ink2" numberOfLines={2} ellipsizeMode="middle" style={{ flex: 1 }}>
              {project.folder}
            </T>
          </View>
          {canFolders && <Row leading={<IconTile icon={FolderOpen} color={colors.ink2} />} title="Change folder…" onPress={pickFolder} />}
          <Row leading={<IconTile icon={FolderMinus} color={colors.danger} />} title="Remove folder" tone="danger" onPress={removeSingle} />
        </Group>
      )}

      {!!project.folder && (
        <Group>
          <Row
            leading={<IconTile icon={GitCompareArrows} color={colors.ink2} />}
            title="View changes"
            subtitle="Inspect uncommitted edits"
            chevron
            onPress={() => router.push(("/chat/changes?id=" + encodeURIComponent(project.id)) as Href)}
          />
        </Group>
      )}

      <View>
        <Label>Clone repository</Label>
        <CloneForm id={project.id} defaultOpen={defaultCloneOpen} />
      </View>
    </Page>
  );
}

export default function ProjectFoldersPage() {
  const { id, clone } = useLocalSearchParams<{ id: string; clone?: string }>();
  const project = useApp((state) => state.parts.projects?.find((item) => item.id === id));
  const synced = useApp((state) => state.synced);
  if (!project) {
    return (
      <Page>
        {synced ? <EmptyState title="This project is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}
      </Page>
    );
  }
  return <ProjectFoldersContent project={project} defaultCloneOpen={clone === "1"} />;
}
