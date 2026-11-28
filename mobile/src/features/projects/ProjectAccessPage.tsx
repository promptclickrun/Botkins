// Project subpage: Who can use it (existing Access bot rows with toggles and reason line).
import { router, useLocalSearchParams } from "expo-router";
import { Users } from "lucide-react-native";
import { View } from "react-native";
import { globalAccess, grantOf, toggleProject } from "@/features/bots/projectAccess";
import type { Project } from "@/link/types";
import { useBots, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { BotAvatar, EmptyState, Group, Loading, Page, Row, space, T } from "@/ui";
import { ACCESS_REASON, accessVia } from "./logic";

export function ProjectAccessContent({ project }: { project: Project }) {
  const settings = usePart("settings");
  const bots = useBots();
  const everyone = globalAccess(settings);
  const allowedCount = everyone ? bots.length : bots.filter((bot) => !!accessVia(settings, bot, project)).length;
  const caption =
    bots.length === 0
      ? "No bots yet"
      : everyone
        ? "All bots"
        : `${allowedCount} of ${bots.length} ${bots.length === 1 ? "bot" : "bots"}`;

  return (
    <Page title="Who can use it" caption={caption}>
      {bots.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No bots yet"
          text="Create a bot first so it can chat in this project and keep its to-do list."
          action="New bot"
          onAction={() => router.push("/bot/new")}
        />
      ) : (
        <View style={{ gap: space.sm }}>
          <Group inset={space.lg + 32 + space.md}>
            {bots.map((bot) => {
              const via = accessVia(settings, bot, project);
              const locked = via === "everyone" || via === "all";
              return (
                <Row
                  key={bot.id}
                  leading={<BotAvatar bot={bot} size={32} badge={false} />}
                  title={bot.name}
                  subtitle={ACCESS_REASON[via]}
                  toggled={!!via}
                  disabled={locked}
                  onToggle={(on) =>
                    void attempt(api.setBotAccess(bot.id, toggleProject(grantOf(bot), project.id, on)))
                  }
                />
              );
            })}
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {everyone
              ? "All bots can use every project. Change it in Settings › Access."
              : "Bots with access can chat in this project and keep its to-do list."}
          </T>
        </View>
      )}
    </Page>
  );
}

export default function ProjectAccessPage() {
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
  return <ProjectAccessContent project={project} />;
}
