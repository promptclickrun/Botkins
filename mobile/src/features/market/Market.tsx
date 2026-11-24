// Market: one search over bots, apps and skills; a featured bot; shelves of bots, apps and skills,
// each with "See all"; and quiet rows to Plugins and Pi. Everything browses without a sign-in: the
// apps are the computer's own catalog, and Composio is one way in on the Apps page.
import { router } from "expo-router";
import { BookOpen, Package, Puzzle, Search } from "lucide-react-native";
import { type ReactNode, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { MarketAgent } from "@/link/types";
import { useCan, useCapability } from "@/state/hooks";
import { BotAvatar, Button, Group, IconTile, Page, radius, Row, space, T, Tap, useTheme } from "@/ui";
import { agentHref } from "./agents/logic";
import { cardLine, landingResults, landingShelves } from "./catalog";
import { addTemplate, BotCard, CatalogRow, SectionHead, SkillCard, SkillRow, skillsHref, TileGrid } from "./catalogParts";
import { loadMcpCatalog, useFeaturedSkills, useMcpCatalog, useTemplates } from "./data";
import { SearchField, TileSkeleton } from "./parts";

const openSkill = (id: string) => router.push(("/market/skills?open=" + encodeURIComponent(id)) as never);

/** The featured bot: its Botkin (bare), name, category and summary, and Add. */
function Hero({ agent }: { agent: MarketAgent }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md }}>
      <Tap onPress={() => router.push(agentHref(agent.id))} sink={0.97} hitSlop={0} accessibilityLabel={[agent.name, agent.categoryName, agent.summary].filter(Boolean).join(", ")} style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
        <BotAvatar bot={{ id: agent.id, look: agent.look }} size={84} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {!!agent.categoryName && (
            <T variant="caption" color="muted" numberOfLines={1}>
              {agent.categoryName}
            </T>
          )}
          <T variant="title2" numberOfLines={2}>
            {agent.name}
          </T>
          {!!agent.summary && (
            <T variant="subhead" color="ink2" numberOfLines={3}>
              {agent.summary}
            </T>
          )}
        </View>
      </Tap>
      <Button title="Add" wide accessibilityLabel={"Add " + agent.name} onPress={() => addTemplate(agent.id)} />
    </View>
  );
}

/** A grey stand-in for the featured bot while the templates load. */
function HeroSkeleton() {
  const { colors } = useTheme();
  return <View style={{ height: 172, borderRadius: radius.lg, backgroundColor: colors.surface }} accessibilityLabel="Loading bots" />;
}

/** A horizontal shelf that runs to the page's edges. */
function Shelf({ children }: { children: ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
      {children}
    </ScrollView>
  );
}

export default function Market() {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const templates = useTemplates();
  const apps = useMcpCatalog();
  const featured = useFeaturedSkills();
  const canPlugins = useCan("plugins", "view");
  const canSkills = useCan("skills", "read");
  const hasSkillsSh = useCapability("skills-catalog-v1");
  const canSkillsSh = canSkills && hasSkillsSh;

  const agents = useMemo(() => templates.value ?? [], [templates.value]);
  const entries = useMemo(() => apps.catalog?.entries ?? [], [apps.catalog]);
  const skills = useMemo(() => featured.value ?? [], [featured.value]);
  const searching = query.trim().length > 0;
  const shelves = useMemo(() => landingShelves({ agents, entries, skills }), [agents, entries, skills]);
  const results = useMemo(() => (searching ? landingResults(query, { agents, entries, skills }) : undefined), [searching, query, agents, entries, skills]);

  const reload = async () => {
    setRefreshing(true);
    templates.reload();
    featured.retry();
    if (apps.supported && apps.allowed) await loadMcpCatalog();
    setRefreshing(false);
  };

  const showBots = templates.supported && templates.allowed;
  const showSkills = featured.supported && featured.allowed;

  return (
    <Page tab title="Market" keyboard onRefresh={reload} refreshing={refreshing}>
      <SearchField value={query} onChange={(text) => setQuery(text.slice(0, 200))} label="Search bots, apps and skills" />

      {results ? (
        <>
          {results.bots.length > 0 && (
            <View>
              <SectionHead title="Bots" />
              <Group>
                {results.bots.map((agent) => (
                  <Row
                    key={agent.id}
                    leading={<BotAvatar bot={{ id: agent.id, look: agent.look }} size={40} />}
                    title={agent.name}
                    subtitle={cardLine(agent)}
                    onPress={() => router.push(agentHref(agent.id))}
                    trailing={<Button title="Add" size="sm" variant="secondary" accessibilityLabel={"Add " + agent.name} onPress={() => addTemplate(agent.id)} />}
                  />
                ))}
              </Group>
            </View>
          )}
          {results.apps.length > 0 && (
            <View>
              <SectionHead title="Apps" />
              <Group>
                {results.apps.map((entry) => (
                  <CatalogRow key={entry.id} entry={entry} />
                ))}
              </Group>
            </View>
          )}
          {(results.skills.length > 0 || (canSkillsSh && results.skillsSh)) && (
            <View>
              <SectionHead title="Skills" />
              <Group>
                {results.skills.map((skill) => (
                  <SkillRow key={skill.id} skill={skill} onPress={() => openSkill(skill.id)} />
                ))}
                {canSkillsSh && results.skillsSh && <Row leading={<IconTile icon={Search} size={32} />} title={"Search skills.sh for “" + query.trim() + "”"} tone="accent" chevron onPress={() => router.push(skillsHref(query.trim()))} />}
              </Group>
            </View>
          )}
          {!results.bots.length && !results.apps.length && !results.skills.length && !(canSkillsSh && results.skillsSh) && (
            <T variant="subhead" color="muted" center style={{ paddingVertical: space.huge }}>
              Nothing matches
            </T>
          )}
        </>
      ) : (
        <>
          {showBots && (templates.loading && !templates.value ? <HeroSkeleton /> : shelves.hero && <Hero agent={shelves.hero} />)}

          {showBots && shelves.bots.length > 0 && (
            <View>
              <SectionHead title="Popular bots" link="See all" onLink={() => router.push("/market/agents" as never)} />
              <Shelf>
                {shelves.bots.map((agent) => (
                  <BotCard key={agent.id} agent={agent} />
                ))}
              </Shelf>
            </View>
          )}

          <View>
            <SectionHead title="Apps" link="See all" onLink={() => router.push("/market/apps" as never)} />
            {apps.supported && apps.allowed ? (
              apps.catalog ? (
                <TileGrid entries={shelves.apps} />
              ) : apps.error ? (
                <Group>
                  <Row title="The apps didn't load" tone="accent" value="Try again" onPress={() => void loadMcpCatalog()} />
                </Group>
              ) : (
                <TileSkeleton rows={2} />
              )
            ) : (
              <Group>
                <Row title="More apps through Composio" subtitle="Gmail, Google Workspace, Slack and more" chevron onPress={() => router.push("/market/composio" as never)} />
              </Group>
            )}
          </View>

          {showSkills && (featured.value?.length ?? 0) > 0 && (
            <View>
              <SectionHead title="Skills" link="See all" onLink={() => router.push(skillsHref())} />
              <Shelf>
                {shelves.skills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} onPress={() => openSkill(skill.id)} />
                ))}
              </Shelf>
            </View>
          )}

          {(canPlugins || (canSkillsSh && !showSkills)) && (
            <Group>
              {canSkillsSh && !showSkills && <Row leading={<IconTile icon={BookOpen} size={32} />} title="Skills" chevron onPress={() => router.push(skillsHref())} />}
              {canPlugins && <Row leading={<IconTile icon={Puzzle} size={32} />} title="Plugins" chevron onPress={() => router.push("/market/plugins" as never)} />}
              {canPlugins && <Row leading={<IconTile icon={Package} size={32} />} title="Pi packages" chevron onPress={() => router.push("/market/pi" as never)} />}
            </Group>
          )}
        </>
      )}
    </Page>
  );
}
