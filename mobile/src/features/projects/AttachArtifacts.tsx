// "Attach an artifact…" on a project's page (the sheet "Attach artifacts") ("project-artifacts-v1"): one bot's artifacts, each with
// Attach, so a project keeps the files its bots made or were given in one place. Attaching changes
// nothing about the artifact. The words are the desktop app's.
import { MenuView } from "@react-native-menu/menu";
import { useLocalSearchParams } from "expo-router";
import { ChevronsUpDown } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { ArtifactThumb } from "@/features/artifacts/ArtifactBits";
import { useArtifactList } from "@/features/artifacts/data";
import { rowLine } from "@/features/artifacts/logic";
import { useBots, useCapability, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { BotAvatar, Button, EmptyState, Group, Loading, Row, Sheet, space, T, useTheme } from "@/ui";

export default function AttachArtifacts() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = usePart("projects")?.find((item) => item.id === id);
  const capable = useCapability("project-artifacts-v1");
  const bots = useBots();
  const [picked, setPicked] = useState<string>();
  const bot = bots.find((item) => item.id === picked) ?? bots[0];
  const list = useArtifactList({ botId: bot?.id ?? "", enabled: capable && !!bot });
  const [busy, setBusy] = useState<string | null>(null);
  const attached = new Set(project?.artifacts ?? []);

  if (!project || !capable)
    return (
      <Sheet title="Attach artifacts">
        <EmptyState title={project ? "Update the app on your computer" : "This project is gone"} />
      </Sheet>
    );
  const attach = async (artifactId: string) => {
    if (busy) return;
    setBusy(artifactId);
    await attempt(api.addProjectArtifact(project.id, artifactId));
    setBusy(null);
  };
  return (
    <Sheet title="Attach artifacts">
      {!bot ? (
        <EmptyState title="No bots yet" />
      ) : (
        <View style={{ gap: space.lg }}>
          <Group>
            <MenuView title="Bot" actions={bots.map((item) => ({ id: item.id, title: item.name, state: item.id === bot.id ? ("on" as const) : ("off" as const) }))} onPressAction={({ nativeEvent }) => setPicked(nativeEvent.event)}>
              <Row leading={<BotAvatar bot={bot} size={36} badge={false} />} title="Bot" value={bot.name} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.4} />} />
            </MenuView>
          </Group>
          {!list.loaded ? (
            list.error ? (
              <EmptyState title={list.error} action="Try again" onAction={list.retry} />
            ) : (
              <Loading />
            )
          ) : list.items.length === 0 ? (
            <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
              This bot has no artifacts yet.
            </T>
          ) : (
            <Group>
              {list.items.map((artifact) => {
                const has = attached.has(artifact.id);
                return (
                  <Row
                    key={artifact.id}
                    leading={<ArtifactThumb artifact={artifact} />}
                    title={artifact.name}
                    subtitle={rowLine(artifact)}
                    trailing={<Button title={has ? "Attached" : "Attach"} size="sm" variant={has ? "ghost" : "secondary"} disabled={has || (!!busy && busy !== artifact.id)} loading={busy === artifact.id} onPress={() => void attach(artifact.id)} />}
                  />
                );
              })}
            </Group>
          )}
          {list.loaded && !list.end && <Button title="Show more" variant="ghost" wide loading={list.loadingMore} onPress={() => void list.more()} />}
        </View>
      )}
    </Sheet>
  );
}
