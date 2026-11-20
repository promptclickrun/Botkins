// Marketplace › Plugins: the computer's plugin catalogs with search, a chip per marketplace, and
// what is installed. The computer reads the catalogs; the phone never fetches them itself.
import { router } from "expo-router";
import { FolderPlus, Puzzle, Store } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import type { PluginListing } from "@/link/types";
import { useCapability, useOnline } from "@/state/hooks";
import { attempt } from "@/state/link";
import { Button, Chip, EmptyState, Group, Loading, Page, space, T } from "@/ui";
import { SearchField } from "../parts";
import { addFolderHref, addMarketplaceHref, loadMarketplaces, pluginCalls, pluginHref, useInstalledPlugins, usePluginMarketplaces, usePluginsReady } from "./calls";
import { byLine, matchInstalled, pluginChips } from "./logic";
import { PluginRow } from "./parts";

/** One search of one marketplace, page by page. */
type Listing = { key: string; plugins: PluginListing[]; cursor?: string; error?: string; more?: boolean };

export function PluginsPage({ switcher }: { switcher: ReactNode }) {
  const can = usePluginsReady();
  if (can) return <Plugins switcher={switcher} />;
  return (
    <Page tab title="Marketplace">
      {switcher}
      <EmptyState icon={Puzzle} title="Update the app on your computer" />
    </Page>
  );
}

function Plugins({ switcher }: { switcher: ReactNode }) {
  const online = useOnline();
  const folders = useCapability("folders-v1");
  const markets = usePluginMarketplaces();
  const installed = useInstalledPlugins();
  const [chip, setChip] = useState("all");
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [tries, setTries] = useState(0);
  const [listing, setListing] = useState<Listing>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (online) void loadMarketplaces();
  }, [online]);
  // A search is asked a moment after the typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const chips = useMemo(() => pluginChips(markets.list), [markets.list]);
  const current = chips.find((item) => item.key === chip) ?? chips[0];
  const market = markets.list?.find((item) => item.id === current.marketplace);
  const key = current.key + "|" + asked + "|" + tries;
  const browsing = current.key !== "installed" && !market?.error;

  useEffect(() => {
    if (!online || !browsing) return;
    let live = true;
    pluginCalls.browse({ ...(current.marketplace && { marketplace: current.marketplace }), ...(asked && { query: asked }) }).then(
      (page) => live && setListing({ key, plugins: page.plugins, cursor: page.cursor }),
      (error: unknown) => live && setListing({ key, plugins: [], error: error instanceof Error ? error.message : "The plugins didn't load." }),
    );
    return () => {
      live = false;
    };
  }, [online, browsing, current.marketplace, asked, key]);

  const shown = listing?.key === key ? listing : undefined;
  const installedIds = useMemo(() => new Set((installed ?? []).map((plugin) => plugin.id)), [installed]);

  const more = async () => {
    if (!shown?.cursor || shown.more) return;
    const at = shown;
    setListing({ ...at, more: true });
    try {
      const page = await pluginCalls.browse({ ...(current.marketplace && { marketplace: current.marketplace }), ...(asked && { query: asked }), cursor: at.cursor });
      setListing((now) => (now?.key === at.key ? { key: at.key, plugins: [...at.plugins, ...page.plugins.filter((item) => !at.plugins.some((had) => had.id === item.id))], cursor: page.cursor } : now));
    } catch (error) {
      setListing((now) => (now?.key === at.key ? { ...at, more: false, error: error instanceof Error ? error.message : "The plugins didn't load." } : now));
    }
  };

  const reload = async () => {
    setRefreshing(true);
    await loadMarketplaces();
    setTries((n) => n + 1);
    setRefreshing(false);
  };

  const remove = () => {
    if (!market || market.builtIn) return;
    Alert.alert("Remove " + market.name + "?", "Plugins you installed from it stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void attempt(pluginCalls.removeMarketplace(market.id), "Marketplace removed").then(() => {
            setChip("all");
            void loadMarketplaces();
          }),
      },
    ]);
  };

  const rows = (items: PluginListing[]) => (
    <Group flat>
      {items.map((item) => (
        <PluginRow key={item.id} listing={item} by={byLine(item, markets.list)} installed={installedIds.has(item.id) || !!item.installed} onPress={() => router.push(pluginHref(item.id))} />
      ))}
    </Group>
  );

  let body: ReactNode;
  if (current.key === "installed") {
    const mine = matchInstalled(installed ?? [], asked);
    body = !installed ? <Loading /> : mine.length ? rows(mine) : <EmptyState icon={Puzzle} title={asked ? "No installed plugins match" : "No plugins installed yet"} />;
  } else if (market?.error) {
    body = <EmptyState icon={Store} title="This marketplace couldn't be read" text={market.error} action="Try again" onAction={() => void loadMarketplaces()} />;
  } else if (!shown) {
    body = <Loading />;
  } else if (shown.error && !shown.plugins.length) {
    body = <EmptyState icon={Puzzle} title="The plugins didn't load" text={shown.error} action="Try again" onAction={() => setTries((n) => n + 1)} />;
  } else if (!shown.plugins.length) {
    body = (
      <T variant="subhead" color="muted" center style={{ paddingVertical: space.huge }}>
        {asked ? "No plugins match" : "No plugins here yet"}
      </T>
    );
  } else {
    body = (
      <>
        {rows(shown.plugins)}
        {!!shown.cursor && <Button title="Show more" variant="secondary" loading={shown.more} onPress={() => void more()} />}
      </>
    );
  }

  return (
    <Page tab title="Marketplace" onRefresh={reload} refreshing={refreshing}>
      {switcher}
      <SearchField value={query} onChange={setQuery} label="Search plugins" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl, marginTop: -space.sm }} contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: 2, gap: space.sm }}>
        {chips.map((item) => (
          <Chip key={item.key} label={item.label} selected={item.key === current.key} onPress={() => setChip(item.key)} />
        ))}
      </ScrollView>
      {body}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.xs }}>
        <Button title="Add a marketplace" icon={Store} variant="ghost" size="sm" disabled={!online} onPress={() => router.push(addMarketplaceHref)} />
        {folders && <Button title="Add from your computer" icon={FolderPlus} variant="ghost" size="sm" disabled={!online} onPress={() => router.push(addFolderHref)} />}
        {!!market && !market.builtIn && <Button title={"Remove " + market.name} variant="ghost" size="sm" disabled={!online} onPress={remove} />}
      </View>
    </Page>
  );
}
