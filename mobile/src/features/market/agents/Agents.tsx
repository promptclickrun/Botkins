// Marketplace › Agents: agent templates from the computer's marketplaces, with search and a chip per
// category. The computer reads the catalogs; the phone never fetches them. A tap opens the template.
import { router } from "expo-router";
import { Bot } from "lucide-react-native";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { MarketAgent, MarketAgentCategory } from "@/link/types";
import { useCan, useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { BotAvatar, Chip, EmptyState, Group, Label, Page, space, T, Tap, useTheme } from "@/ui";
import { templateGroups } from "../catalog";
import { SearchField } from "../parts";
import { refreshCatalogs, useCanRefresh } from "../plugins/calls";
import { AGENTS_CAPABILITY, agentChips, agentHref, listLine } from "./logic";

const AVATAR = 48;

/** One search of one category. */
type Listing = { key: string; agents: MarketAgent[]; categories: MarketAgentCategory[]; error?: string };

export function AgentsPage() {
  const ready = useCapability(AGENTS_CAPABILITY);
  const allowed = useCan("agents", "create");
  if (ready && allowed) return <Agents />;
  return (
    <Page title="Bots">
      <EmptyState icon={Bot} title={allowed ? "Update the app on your computer" : "Your team role can't create bots"} />
    </Page>
  );
}

/** A template in the list: its Botkin, its name, two lines of what it does, and where it is from. */
const AgentRow = memo(function AgentRow({ agent }: { agent: MarketAgent }) {
  const { control } = useTheme();
  const line = listLine(agent);
  return (
    <Tap onPress={() => router.push(agentHref(agent.id))} sink={1} feel="select" hitSlop={0} accessibilityLabel={[agent.name, agent.summary, line].filter(Boolean).join(", ")}>
      <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <BotAvatar bot={{ id: agent.id, look: agent.look }} size={AVATAR} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {agent.name}
          </T>
          {!!agent.summary && (
            <T variant="subhead" color="ink2" numberOfLines={2}>
              {agent.summary}
            </T>
          )}
          {!!line && (
            <T variant="footnote" color="muted" numberOfLines={1}>
              {line}
            </T>
          )}
        </View>
      </View>
    </Tap>
  );
});

/** Grey stand-ins for templates while the list loads. */
function Skeleton() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.lg, paddingVertical: space.sm }} accessibilityLabel="Loading agents">
      {[0, 1, 2, 3].map((row) => (
        <View key={row} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: colors.sunken }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "40%", height: 12, borderRadius: 6, backgroundColor: colors.sunken }} />
            <View style={{ width: "85%", height: 10, borderRadius: 5, backgroundColor: colors.sunken }} />
            <View style={{ width: "30%", height: 10, borderRadius: 5, backgroundColor: colors.sunken }} />
          </View>
        </View>
      ))}
    </View>
  );
}

function Agents() {
  const online = useOnline();
  // The templates are in the plugin catalogs, so a refresh reads those again (with the plugins' permission).
  const canCatalogs = useCan("plugins", "view");
  const canRefresh = useCanRefresh();
  const [chosen, setChosen] = useState<{ id: string; name: string }>();
  const category = chosen?.id;
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [tries, setTries] = useState(0);
  const [listing, setListing] = useState<Listing>();
  const [refreshing, setRefreshing] = useState(false);

  // A search is asked a moment after the typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const key = (category ?? "") + "|" + asked + "|" + tries;
  useEffect(() => {
    if (!online) return;
    let live = true;
    api["agents.browse"]({ ...(asked && { query: asked }), ...(category && { category }) }).then(
      (page) => {
        if (live) setListing({ key, agents: page.agents, categories: page.categories });
      },
      (error: unknown) => {
        if (live) setListing((was) => ({ key, agents: [], categories: was?.categories ?? [], error: error instanceof Error ? error.message : "The agents didn't load." }));
      },
    );
    return () => {
      live = false;
    };
  }, [online, asked, category, key]);

  const shown = listing?.key === key ? listing : undefined;

  // A pull down: the computer reads the catalogs again, then this list. The old list stays until
  // the new one comes, and stays when it fails.
  const reload = async () => {
    if (!online) return;
    setRefreshing(true);
    const at = key;
    await attempt(
      (async () => {
        let failed: unknown;
        if (canCatalogs) await refreshCatalogs(canRefresh).catch((error: unknown) => (failed = error));
        const page = await api["agents.browse"]({ ...(asked && { query: asked }), ...(category && { category }) });
        setListing((now) => (now?.key === at ? { key: at, agents: page.agents, categories: page.categories } : now));
        if (failed) throw failed;
      })(),
    );
    setRefreshing(false);
  };
  // The chips keep the last categories while the next list loads, so they don't jump.
  const chips = useMemo(() => agentChips(listing?.categories ?? [], chosen), [listing?.categories, chosen]);

  let body: ReactNode;
  if (!shown) body = <Skeleton />;
  else if (shown.error) body = <EmptyState icon={Bot} title="The agents didn't load" text={shown.error} action="Try again" onAction={() => setTries((n) => n + 1)} />;
  else if (!shown.agents.length)
    body = (
      <T variant="subhead" color="muted" center style={{ paddingVertical: space.huge }}>
        {asked || category ? "No agents match" : "No agents here yet"}
      </T>
    );
  else {
    // Starters first, then Botkins' Everyday and Builder, then each other marketplace.
    const groups = templateGroups(shown.agents);
    body = groups.map((group) => (
      <View key={group.key}>
        {groups.length > 1 && <Label>{group.title}</Label>}
        <Group flat inset={space.lg + AVATAR + space.md}>
          {group.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </Group>
      </View>
    ));
  }

  return (
    <Page title="Bots" keyboard refreshing={refreshing} onRefresh={reload}>
      <SearchField value={query} onChange={setQuery} label="Search agents" />
      {chips.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl, marginTop: -space.sm }} contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: 2, gap: space.sm }}>
          {chips.map((item) => (
            <Chip key={item.key} label={item.label} selected={item.category === category} onPress={() => setChosen(item.category ? { id: item.category, name: item.name ?? item.label } : undefined)} />
          ))}
        </ScrollView>
      )}
      {body}
    </Page>
  );
}
