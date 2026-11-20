import { router, useLocalSearchParams } from "expo-router";
import { Plus } from "lucide-react-native";
import { View } from "react-native";
import { useBot, usePart, useSkills } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Group, IconTile, Label, Loading, Page, Row } from "@/ui";

const toggle = (list: string[] | undefined, item: string, on: boolean) => (on ? (list ?? []).filter((entry) => entry !== item) : [...(list ?? []).filter((entry) => entry !== item), item]);

/** Which skills and tools one bot may use, within what is on for everyone. */
export default function Capabilities() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const skills = useSkills();
  const offForAll = usePart("skills")?.disabled;
  const servers = usePart("mcp");

  if (!bot)
    return (
      <Page title="Skills & tools">
        <EmptyState title="This bot is gone" />
      </Page>
    );
  return (
    <Page title="Skills & tools" caption={bot.name}>
      <View>
        <Label>Skills</Label>
        {!skills ? (
          <Group>
            <Loading />
          </Group>
        ) : (
          <Group>
            {skills.map((skill) => {
              const everyone = !skill.enabled || !!offForAll?.includes(skill.name);
              return (
                <Row
                  key={skill.name}
                  title={skill.name}
                  subtitle={skill.description}
                  value={everyone ? "Off for everyone" : undefined}
                  toggled={!everyone && !bot.skillsOff?.includes(skill.name)}
                  disabled={everyone}
                  onToggle={(on) => void attempt(api.setBotIntegrations(bot.id, { skillsOff: toggle(bot.skillsOff, skill.name, on) }))}
                />
              );
            })}
            {skills.length === 0 && <Row leading={<IconTile icon={Plus} />} title="Add a skill" tone="accent" chevron onPress={() => router.push("/skills")} />}
          </Group>
        )}
      </View>
      <View>
        <Label>Tools</Label>
        <Group>
          {(servers ?? []).map((server) => {
            const everyone = !server.enabled;
            return (
              <Row
                key={server.id}
                title={server.name}
                subtitle={server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")}
                value={everyone ? "Off for everyone" : undefined}
                toggled={!everyone && !bot.mcpOff?.includes(server.id)}
                disabled={everyone}
                onToggle={(on) => void attempt(api.setBotIntegrations(bot.id, { mcpOff: toggle(bot.mcpOff, server.id, on) }))}
              />
            );
          })}
          {(servers ?? []).length === 0 && <Row leading={<IconTile icon={Plus} />} title="Add a tool" tone="accent" chevron onPress={() => router.push("/tools")} />}
        </Group>
      </View>
    </Page>
  );
}
