// Project subpage: Artifacts (search, newest first, 20 at first then "Show N older",
// + opens existing attach screen, hold menu offers "Go to chat" and "Remove from project").
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Paperclip, Plus } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { ArtifactRow } from "@/features/artifacts/ArtifactBits";
import { openChat } from "@/features/chat/navigate";
import type { Artifact, Project } from "@/link/types";
import { useBots, useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { Button, EmptyState, Field, Group, HoldMenu, IconButton, Loading, Page, space, T } from "@/ui";
import { artifactCount, filterProjectArtifacts, PAGE_SIZE, pageItems } from "./logic";

export function ProjectArtifactsContent({ project }: { project: Project }) {
  const capable = useCapability("project-artifacts-v1");
  const online = useOnline();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const allBots = useBots();
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const ids = (project.artifacts ?? []).join(" ");
  const [items, setItems] = useState<Artifact[]>();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!capable || !online) return;
    let live = true;
    api.projectArtifacts(project.id).then(
      (answer) => live && setItems(answer.items),
      () => live && setItems((held) => held ?? []),
    );
    return () => {
      live = false;
    };
  }, [capable, online, project.id, ids]);

  const openAttach = () => router.push({ pathname: "/projects/attach", params: { id: project.id } });
  const count = items?.length ?? project.artifacts?.length ?? 0;

  const filtered = useMemo(() => {
    const sorted = [...(items ?? [])].sort((a, b) => b.time - a.time);
    return filterProjectArtifacts(sorted, query, (botId) => bots.get(botId)?.name);
  }, [items, query, bots]);
  const paged = useMemo(() => pageItems(filtered, limit), [filtered, limit]);

  if (!capable) {
    return (
      <Page title="Artifacts">
        <EmptyState
          icon={Paperclip}
          title="Artifacts are unavailable"
          text="Update Botkins on your computer to attach artifacts to projects."
          action="Go back"
          onAction={() => router.back()}
        />
      </Page>
    );
  }

  return (
    <Page title="Artifacts" caption={artifactCount(count)} keyboard>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={Plus}
              label="Attach an artifact"
              variant={hasBackdrop ? "glass" : "soft"}
              onPress={openAttach}
            />
          ),
        }}
      />

      {items === undefined && count > 0 ? (
        <Loading />
      ) : count === 0 ? (
        <EmptyState
          icon={Paperclip}
          title="No artifacts attached"
          text="Keep files your bots made or received in one place for this project."
          action="Attach an artifact"
          onAction={openAttach}
        />
      ) : (
        <View style={{ gap: space.lg }}>
          <Field
            placeholder="Search artifacts"
            accessibilityLabel="Search artifacts"
            value={query}
            onChangeText={(next) => {
              setQuery(next);
              setLimit(PAGE_SIZE);
            }}
            autoCorrect={false}
            returnKeyType="search"
          />

          {paged.visible.length === 0 ? (
            <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
              No artifacts match.
            </T>
          ) : (
            <Group inset={space.lg + 40 + space.md}>
              {paged.visible.map((artifact) => (
                <HoldMenu
                  key={artifact.id}
                  actions={[
                    ...(artifact.chatId ? [{ id: "chat", title: "Go to chat", image: "bubble.left" }] : []),
                    { id: "remove", title: "Remove from project", image: "minus.circle", attributes: { destructive: true } },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "chat" && artifact.chatId) {
                      openChat(
                        artifact.chatId,
                        artifact.messageIndex !== undefined ? { at: String(artifact.messageIndex) } : undefined,
                      );
                    } else if (nativeEvent.event === "remove") {
                      void attempt(api.removeProjectArtifact(project.id, artifact.id), "Removed from " + project.name);
                    }
                  }}
                >
                  <ArtifactRow artifact={artifact} />
                </HoldMenu>
              ))}
            </Group>
          )}

          {paged.older > 0 && (
            <Button
              title={`Show ${paged.older} older`}
              variant="ghost"
              wide
              onPress={() => setLimit((prev) => prev + PAGE_SIZE)}
            />
          )}
        </View>
      )}
    </Page>
  );
}

export default function ProjectArtifactsPage() {
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
  return <ProjectArtifactsContent project={project} />;
}
