import { useLocalSearchParams } from "expo-router";
import { LayoutGrid } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { FlatList, type ListViewToken, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { searchToolkits } from "@/composio/catalog";
import { type Toolkit, useComposio } from "@/composio/store";
import { EmptyState, space, T, useTheme } from "@/ui";
import { ListCell, RowSkeleton, SearchField } from "./parts";

// The accounts of the rows on screen are read a moment after scrolling stops. FlatList wants these
// two to keep their identity, so they live outside the component.
let settle: ReturnType<typeof setTimeout> | undefined;
const onViewable = ({ viewableItems }: { viewableItems: ListViewToken[] }) => {
  const slugs = viewableItems.map((token) => (token.item as Toolkit).slug);
  clearTimeout(settle);
  settle = setTimeout(() => void useComposio.getState().loadStatus(slugs), 500);
};
const VIEWABILITY = { itemVisiblePercentThreshold: 50, minimumViewTime: 200 };
const keyOf = (toolkit: Toolkit) => toolkit.slug;

/** Every app in a category (or every app, for "all"), most used first. */
export default function Category() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const catalog = useComposio((state) => state.catalog);
  const catalogStatus = useComposio((state) => state.catalogStatus);
  const [query, setQuery] = useState("");

  useEffect(() => {
    useComposio.getState().boot();
    return () => clearTimeout(settle);
  }, []);

  const all = id === "all";
  const category = catalog?.categories.find((entry) => entry.id === id);
  const title = all ? "All apps" : (category?.name ?? "Apps");
  const base = useMemo(() => (!catalog ? [] : all ? catalog.toolkits : catalog.toolkits.filter((toolkit) => toolkit.categories.includes(id))), [catalog, all, id]);
  const items = useMemo(() => searchToolkits(base, query), [base, query]);
  const last = items.length - 1;

  const header = (
    <View style={{ gap: space.xl, paddingBottom: space.xl }}>
      <T variant="display" accessibilityRole="header" numberOfLines={2} style={{ marginBottom: space.xs }}>
        {title}
      </T>
      <SearchField value={query} onChange={setQuery} label={all ? "Search all apps" : "Search " + title} />
    </View>
  );

  const empty = !catalog ? (
    catalogStatus === "error" ? (
      <EmptyState icon={LayoutGrid} title="The app list didn't load" action="Try again" onAction={() => void useComposio.getState().loadCatalog(true)} />
    ) : (
      <RowSkeleton />
    )
  ) : (
    <T variant="subhead" color="muted" center style={{ paddingVertical: space.huge }}>
      {query.trim() ? "No apps match" : "No apps here yet"}
    </T>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <FlatList
        data={items}
        keyExtractor={keyOf}
        renderItem={({ item, index }) => <ListCell toolkit={item} first={index === 0} last={index === last} />}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={VIEWABILITY}
        initialNumToRender={14}
        maxToRenderPerBatch={16}
        windowSize={9}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.xxl }}
      />
    </View>
  );
}
