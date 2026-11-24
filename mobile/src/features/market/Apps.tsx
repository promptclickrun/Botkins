// Market › Apps: the computer's own apps catalog by category, with search and each app's state. On a
// Mac its Mail and Messages come first; Composio is one quiet row at the end, never a gate.
import { router } from "expo-router";
import { LayoutGrid, Monitor } from "lucide-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useMember, usePart } from "@/state/hooks";
import { Group, IconTile, Label, Page, Row, space, T } from "@/ui";
import { appsBlocks } from "./catalog";
import { CatalogRow } from "./catalogParts";
import { loadMcpCatalog, useMcpCatalog } from "./data";
import { RowSkeleton, SearchField } from "./parts";

export default function Apps() {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const { supported, allowed, catalog, error } = useMcpCatalog();
  const member = useMember();
  const mac = usePart("meta")?.platform === "darwin" && !member;
  const blocks = useMemo(() => appsBlocks(catalog?.entries ?? [], { mac, query }), [catalog, mac, query]);
  const direct = supported && allowed;

  const reload = async () => {
    if (!direct) return;
    setRefreshing(true);
    await loadMcpCatalog();
    setRefreshing(false);
  };

  return (
    <Page title="Apps" keyboard onRefresh={direct ? reload : undefined} refreshing={refreshing}>
      {direct && <SearchField value={query} onChange={(text) => setQuery(text.slice(0, 200))} label="Search apps" />}
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
      {direct && !!catalog && !!query.trim() && !blocks.some((block) => block.kind === "category") && (
        <T variant="subhead" color="muted" center style={{ paddingVertical: space.xl }}>
          No apps match
        </T>
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
        return (
          <View key={block.id}>
            <Label>{block.name}</Label>
            <Group inset={space.lg + 40 + space.md}>
              {block.entries.map((entry) => (
                <CatalogRow key={entry.id} entry={entry} />
              ))}
            </Group>
          </View>
        );
      })}
    </Page>
  );
}
