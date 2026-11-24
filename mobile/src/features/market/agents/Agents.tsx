// Market › Bots: the computer's agent templates, with a search, a chip for each group and category,
// the Starters in a carousel of tall cards, and every other group as a grid of cards. The computer
// reads the catalogs; the phone never fetches them. A tap opens the template; Add starts a bot from it.
import { Bot } from "lucide-react-native";
import { type ReactNode, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { MarketAgent } from "@/link/types";
import { useCan, useCapability } from "@/state/hooks";
import { attempt } from "@/state/link";
import { Button, Chip, EmptyState, Page, radius, space, T, useTheme } from "@/ui";
import { botChips, botSections } from "../catalog";
import { BotCard, SectionHead, Shelf, StarterCard } from "../catalogParts";
import { useTemplates } from "../data";
import { SearchField } from "../parts";
import { refreshCatalogs, useCanRefresh } from "../plugins/calls";
import { AGENTS_CAPABILITY } from "./logic";

/** Cards of a grid per row. */
const COLUMNS = 2;
/** The gap between cards, in a grid and in a carousel. */
const GAP = space.md;

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

/** Grey stand-ins for the cards while the list loads. */
function Skeleton() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: GAP }} accessibilityLabel="Loading bots">
      <View style={{ height: 300, borderRadius: radius.xl, backgroundColor: colors.surface }} />
      <View style={{ flexDirection: "row", gap: GAP }}>
        {[0, 1].map((card) => (
          <View key={card} style={{ flex: 1, height: 220, borderRadius: radius.lg, backgroundColor: colors.surface }} />
        ))}
      </View>
    </View>
  );
}

/** Cards two to a row; a short last row leaves its second place empty so cards keep one width. */
function Grid({ agents }: { agents: MarketAgent[] }) {
  const rows: MarketAgent[][] = [];
  for (let index = 0; index < agents.length; index += COLUMNS) rows.push(agents.slice(index, index + COLUMNS));
  return (
    <View style={{ gap: GAP }}>
      {rows.map((row) => (
        <View key={row[0].id} style={{ flexDirection: "row", gap: GAP, alignItems: "stretch" }}>
          {row.map((agent) => (
            <BotCard key={agent.id} agent={agent} />
          ))}
          {Array.from({ length: COLUMNS - row.length }, (_, index) => (
            <View key={"gap" + index} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Agents() {
  // The templates are in the plugin catalogs, so a refresh reads those again (with the plugins' permission).
  const canCatalogs = useCan("plugins", "view");
  const canRefresh = useCanRefresh();
  const templates = useTemplates();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState("all");
  const [refreshing, setRefreshing] = useState(false);

  const agents = useMemo(() => templates.value ?? [], [templates.value]);
  const chips = useMemo(() => botChips(agents), [agents]);
  // A chosen chip that the list no longer has (after a refresh) is All again.
  const chip = chips.some((item) => item.key === picked) ? picked : "all";
  const sections = useMemo(() => botSections(agents, { query, chip }), [agents, query, chip]);
  const narrowed = !!query.trim() || chip !== "all";

  const reload = async () => {
    setRefreshing(true);
    if (canCatalogs) await attempt(refreshCatalogs(canRefresh));
    templates.reload();
    setRefreshing(false);
  };
  const clear = () => {
    setQuery("");
    setPicked("all");
  };

  let body: ReactNode;
  if (!templates.value) {
    body = templates.error ? <EmptyState icon={Bot} title="The bots didn't load" text={templates.error} action="Try again" onAction={templates.reload} /> : <Skeleton />;
  } else if (!sections.length) {
    body = (
      <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.huge }}>
        <T variant="subhead" color="muted" center>
          {narrowed ? "No bots match" : "No bots here yet"}
        </T>
        {narrowed && <Button title="Clear" variant="secondary" size="sm" onPress={clear} />}
      </View>
    );
  } else {
    body = sections.map((section) => (
      <View key={section.key}>
        <SectionHead title={section.title} />
        {section.key === "starters" ? (
          <Shelf gap={GAP}>
            {section.agents.map((agent) => (
              <StarterCard key={agent.id} agent={agent} />
            ))}
          </Shelf>
        ) : (
          <Grid agents={section.agents} />
        )}
      </View>
    ));
  }

  return (
    <Page title="Bots" keyboard refreshing={refreshing} onRefresh={reload}>
      <SearchField value={query} onChange={(text) => setQuery(text.slice(0, 200))} label="Search bots" />
      {chips.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl, marginTop: -space.sm }} contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: 2, gap: space.sm }}>
          {chips.map((item) => (
            <Chip key={item.key} label={item.label} selected={item.key === chip} onPress={() => setPicked(item.key)} />
          ))}
        </ScrollView>
      )}
      {body}
    </Page>
  );
}
