import { type Href, router, Stack } from "expo-router";
import { FolderClosed, FolderPlus, Plus, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Project } from "@/link/types";
import { useCapability, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, EmptyState, Field, Group, IconButton, IconTile, Loading, Mascot, Page, Row, space, useTheme } from "@/ui";
import { projectColor } from "./colors";

function subtitleOf(project: Project) {
  const open = project.todos.filter((todo) => !todo.done).length;
  if (open) return open === 1 ? "1 to-do" : open + " to-dos";
  return project.description || (project.todos.length ? "All done" : undefined);
}

/** A new project by name, or from a folder on the computer ("Add folder…"). */
function NewProject({ onClose }: { onClose: () => void }) {
  const canFolders = useCapability("folders-v1");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fromFolder = () => {
    onClose();
    router.push({ pathname: "/folders", params: { use: "project-new" } } as unknown as Href);
  };
  const add = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    const id = await attempt(api.createProject({ name: clean }));
    setBusy(false);
    if (!id) return;
    onClose();
    router.push({ pathname: "/projects/[id]", params: { id } });
  };
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Field
          placeholder="Project name"
          accessibilityLabel="New project name"
          value={name}
          onChangeText={setName}
          autoFocus
          returnKeyType="done"
          maxLength={80}
          onSubmitEditing={() => void add()}
          containerStyle={{ flex: 1 }}
        />
        <Button title="Add" onPress={() => void add()} disabled={!name.trim()} loading={busy} />
      </View>
      {canFolders && <Button title="Add folder…" icon={FolderPlus} variant="ghost" size="sm" onPress={fromFolder} style={{ alignSelf: "flex-start" }} />}
    </View>
  );
}

/** The projects, newest used first, with the form for a new one above them while `adding`. Work's Projects tab draws it. */
export function ProjectList({ adding, setAdding }: { adding: boolean; setAdding: (adding: boolean) => void }) {
  const theme = useTheme();
  const projects = usePart("projects");
  const sorted = useMemo(() => [...(projects ?? [])].sort((a, b) => b.lastUsed - a.lastUsed), [projects]);
  return (
    <View style={{ gap: space.lg }}>
      {adding && <NewProject onClose={() => setAdding(false)} />}
      {sorted.length === 0 ? (
        !adding && <EmptyState art={<Mascot size={104} state="planning" />} title="No projects yet" action="New project" onAction={() => setAdding(true)} />
      ) : (
        <Group>
          {sorted.map((project) => (
            <Row
              key={project.id}
              leading={<IconTile icon={FolderClosed} color={projectColor(project.color, theme)} />}
              title={project.name}
              subtitle={subtitleOf(project)}
              chevron
              onPress={() => router.push({ pathname: "/projects/[id]", params: { id: project.id } })}
            />
          ))}
        </Group>
      )}
    </View>
  );
}

/** The projects on a page of their own (the route `/projects`); they live in Work's Projects tab. */
export default function Projects() {
  const theme = useTheme();
  const synced = useApp((state) => state.synced);
  const [adding, setAdding] = useState(false);
  return (
    <Page title="Projects" keyboard>
      <Stack.Screen
        options={{
          headerRight: () => <IconButton icon={adding ? X : Plus} label={adding ? "Cancel new project" : "New project"} size={44} color={theme.colors.accentText} onPress={() => setAdding(!adding)} />,
        }}
      />
      {!synced ? (
        <Loading />
      ) : (
        <Animated.View entering={FadeIn.duration(200)}>
          <ProjectList adding={adding} setAdding={setAdding} />
        </Animated.View>
      )}
    </Page>
  );
}
