// Settings › Access (the desktop's src/AccessSettings.tsx): whether every bot can use every
// project, and if not, who can use what. A bot's row opens its access card.
import { type Href, router } from "expo-router";
import { FolderLock } from "lucide-react-native";
import { View } from "react-native";
import { useBots, useOnline, usePart, useSettings } from "@/state/hooks";
import { api } from "@/state/link";
import { BotAvatar, brand, Group, IconTile, Label, Loading, Page, Row, space, T } from "@/ui";
import { everyBotAllowed, grantSummary } from "./computer";
import { useHeld } from "./shared";

export default function Access() {
  const online = useOnline();
  const settings = useSettings();
  const bots = useBots();
  const projects = usePart("projects") ?? [];
  const [access, hold] = useHeld(settings?.access);
  if (!settings || !access)
    return (
      <Page title="Access">
        <Loading />
      </Page>
    );
  const everyone = everyBotAllowed({ access });
  return (
    <Page title="Access">
      <Group>
        <Row
          leading={<IconTile icon={FolderLock} color={brand.fern} />}
          title="All bots can use every project"
          subtitle={everyone ? "Any bot can chat in any project" : "Each bot uses the projects on its page"}
          toggled={everyone}
          disabled={!online}
          onToggle={(allBots) => void hold({ allBots }, () => api.setPreferences({ access: { allBots } }))}
        />
      </Group>

      {!everyone && (
        <View>
          <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
            <Label>Access by bot</Label>
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
              {projects.length + (projects.length === 1 ? " project" : " projects")}
            </T>
          </View>
          <Group flat inset={space.lg + 40 + space.md}>
            {bots.map((bot) => {
              const summary = grantSummary(false, bot, projects);
              return (
                <Row
                  key={bot.id}
                  leading={<BotAvatar bot={bot} size={40} badge={false} />}
                  title={bot.name}
                  subtitle={summary}
                  chevron
                  onPress={() => router.push({ pathname: "/bot/access" as Href, params: { id: bot.id } } as Href)}
                />
              );
            })}
          </Group>
        </View>
      )}
    </Page>
  );
}
