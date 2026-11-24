// Market › Apps: the computer's own apps catalog, with a search, a chip for each category, the
// featured apps in a wide carousel, and each category as a carousel of cards ("See all" opens it as a
// grid). On a Mac its Mail and Messages come first; Composio is one card at the end, never a gate.
import { router } from "expo-router";
import { LayoutGrid, Monitor } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { McpCatalogEntry } from "@/link/types";
import { useMember, usePart } from "@/state/hooks";
import { Button, Chip, Group, IconTile, Page, Row, space, T } from "@/ui";
import { appChips, appsBlocks } from "./catalog";
import { AppCard, CARD, FeaturedAppCard, SectionHead, Shelf } from "./catalogParts";
import { loadMcpCatalog, useMcpCatalog } from "./data";
import { RowSkeleton, SearchField } from "./parts";

/** The gap between cards, in a grid and in a carousel. */
const GAP = space.md;
/** Cards of a grid per row. */
const COLUMNS = 2;

/** Cards two to a row, for a category opened in full. */
function Grid({ entries }: { entries: McpCatalogEntry[] }) {
  const rows: McpCatalogEntry[][] = [];
  for (let index = 0; index < entries.length; index += COLUMNS) rows.push(entries.slice(index, index + COLUMNS));
  return (
    <View style={{ gap: GAP }}>
      {rows.map((row) => (
        <View key={row[0].id} style={{ flexDirection: "row", gap: GAP, alignItems: "stretch" }}>
          {row.map((entry) => (
            <AppCard key={entry.id} entry={entry} />
          ))}
          {Array.from({ length: COLUMNS - row.length }, (_, index) => (
            <View key={"gap" + index} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </View>
  );
}

export default function Apps() {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const { supported, allowed, catalog, error } = useMcpCatalog();
  const member = useMember();
  const mac = usePart("meta")?.platform === "darwin" && !member;
  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);
  const chips = useMemo(() => appChips(entries), [entries]);
  // A chosen category that the catalog no longer has is All again.
  const chip = chips.some((item) => item.key === picked) ? picked : "all";
  const blocks = useMemo(() => appsBlocks(entries, { mac, query, category: chip, featured: true }), [entries, mac, query, chip]);
  const direct = supported && allowed;
  const narrowed = !!query.trim() || chip !== "all";

  const reload = async () => {
    if (!direct) return;
    setRefreshing(true);
    await loadMcpCatalog();
    setRefreshing(false);
  };
  const clear = () => {
    setQuery("");
    setPicked("all");
  };

  return (
    <Page title="Apps" keyboard onRefresh={direct ? reload : undefined} refreshing={refreshing}>
      {direct && <SearchField value={query} onChange={(text) => setQuery(text.slice(0, 200))} label="Search apps" />}
      {direct && chips.length > 2 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl, marginTop: -space.sm }} contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: 2, gap: space.sm }}>
          {chips.map((item) => (
            <Chip key={item.key} label={item.label} selected={item.key === chip} onPress={() => setPicked(item.key)} />
          ))}
        </ScrollView>
      )}
      {direct && !catalog && (error ? (
        <Group>
          <Row title="The apps didn't load" tone="accent" value="Try again" onPress={() => void loadMcpCatalog()} />
        </Group>
      ) : (
        <RowSkeleton rows={5} />
      ))}
      {!supported && (
        <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
          Update the app on your computer to add apps from here
        </T>
      )}
      {direct && !!catalog && narrowed && !blocks.some((block) => block.kind === "category") && (
        <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.huge }}>
          <T variant="subhead" color="muted" center>
            No apps match
          </T>
          <Button title="Clear" variant="secondary" size="sm" onPress={clear} />
        </View>
      )}
      {blocks.map((block) => {
        if (block.kind === "mac")
          return (
            <Group key="mac">
              <Row leading={<IconTile icon={Monitor} size={36} />} title="On your Mac" subtitle="Mail and Messages" chevron onPress={() => router.push("/tools/device")} />
            </Group>
          );
        if (block.kind === "composio")
          return (
            <Group key="composio">
              <Row leading={<IconTile icon={LayoutGrid} size={36} />} title="More apps through Composio" subtitle="Gmail, Google Workspace, Slack and more" chevron onPress={() => router.push("/market/composio" as never)} />
            </Group>
          );
        if (block.kind === "featured")
          return (
            <View key="featured">
              <SectionHead title="Featured" />
              <Shelf gap={GAP}>
                {block.entries.map((entry) => (
                  <FeaturedAppCard key={entry.id} entry={entry} />
                ))}
              </Shelf>
            </View>
          );
        // One category chosen: all of it, as a grid. Otherwise a carousel with "See all".
        const full = chip !== "all";
        return (
          <View key={block.id}>
            <SectionHead title={block.name} link={full || block.entries.length <= 2 ? undefined : "See all"} onLink={() => setPicked(block.id)} />
            {full ? (
              <Grid entries={block.entries} />
            ) : (
              <Shelf gap={GAP}>
                {block.entries.map((entry) => (
                  <AppCard key={entry.id} entry={entry} width={CARD.app.width} />
                ))}
              </Shelf>
            )}
          </View>
        );
      })}
    </Page>
  );
}
