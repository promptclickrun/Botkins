// A bot's Access card (the desktop's src/BotAccess.tsx): all projects, or the ones it may chat in.
import { router, useLocalSearchParams } from "expo-router";
import { FolderKanban, Infinity as All } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import type { Bot, BotAccessGrant } from "@/link/types";
import { useBot, usePart, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { EmptyState, Field, Group, IconTile, Label, Loading, Page, Row, space, T, useTheme } from "@/ui";
import { globalAccess, grantOf, sortedProjects, toggleProject } from "./projectAccess";

export default function Access() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const synced = useApp((state) => state.synced);
  if (!bot)
    return <Page title="Access">{synced ? <EmptyState title="This bot is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Page>;
  return <AccessCard bot={bot} />;
}

function AccessCard({ bot }: { bot: Bot }) {
  const { colors } = useTheme();
  const settings = useSettings();
  const everyone = globalAccess(settings);
  const projects = sortedProjects(usePart("projects"));
  const grant = grantOf(bot);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const many = projects.length > 8;
  const set = (next: Partial<BotAccessGrant>) => void attempt(api.setBotAccess(bot.id, { ...grant, ...next }));

  return (
    <Page title="Access" caption={everyone ? "All bots can use every project right now. This applies when that's off in Settings › Access." : "The projects " + bot.name + " can chat in."}>
      <Group>
        <Row leading={<IconTile icon={All} color={colors.info} />} title="All projects" subtitle="Includes ones you add later." toggled={grant.all} onToggle={(all) => set({ all })} />
      </Group>
      {!grant.all && (
        <View style={{ gap: space.md }}>
          {many && <Field placeholder="Filter" value={query} onChangeText={setQuery} accessibilityLabel="Filter projects" autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" />}
          <View>
            <Label>Projects</Label>
            {projects.length === 0 ? (
              <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
                No projects yet.
              </T>
            ) : (
              <Group>
                {projects
                  .filter((project) => !q || project.name.toLowerCase().includes(q))
                  .map((project) => (
                    <Row
                      key={project.id}
                      leading={<IconTile icon={FolderKanban} color={colors.ink2} />}
                      title={project.name}
                      toggled={grant.projects.includes(project.id)}
                      onToggle={(on) => set(toggleProject(grant, project.id, on))}
                    />
                  ))}
              </Group>
            )}
          </View>
        </View>
      )}
    </Page>
  );
}
