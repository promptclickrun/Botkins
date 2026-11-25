// A bot's artifacts, newest first: what it made or was given. All · Files · Media at the top (not
// inside a folder), more pages as the person reaches the end, pull to refresh. A folder opens the
// same page for what is in it.
import { useLocalSearchParams } from "expo-router";
import { FolderOpen, Package } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Artifact } from "@/link/types";
import { useBot, useCapability, useOnline } from "@/state/hooks";
import { usePrefs } from "@/state/prefs";
import { BackdropLayer, Chip, EmptyState, Group, LinkBanner, Loading, space, T, useTheme } from "@/ui";
import { ArtifactRow } from "./ArtifactBits";
import { useArtifactList } from "./data";
import { type Filter, FILTERS } from "./logic";

// The rows' text starts after the 40-point picture and the gap beside it.
const LINE_INSET = 40 + space.md;

export default function ArtifactList() {
  const params = useLocalSearchParams<{ botId?: string; folder?: string; title?: string }>();
  const botId = params.botId ?? "";
  const folder = params.folder || undefined;
  const { colors } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const insets = useSafeAreaInsets();
  const can = useCapability("artifacts-v1");
  const online = useOnline();
  const bot = useBot(botId);
  const [filter, setFilter] = useState<Filter>("all");
  const shownFilter: Filter = folder ? "all" : filter;
  const list = useArtifactList({ botId, folder, filter: shownFilter, enabled: can });

  const title = folder ? params.title || "Folder" : "Artifacts";
  const header = (
    <View style={{ gap: space.lg, paddingBottom: space.md }}>
      <View style={{ gap: 2 }}>
        <T variant="display" accessibilityRole="header" numberOfLines={2}>
          {title}
        </T>
        {!folder && !!bot && (
          <T variant="subhead" color="muted" numberOfLines={1}>
            {bot.name}
          </T>
        )}
      </View>
      <LinkBanner />
      {can && !folder && (
        <View style={{ flexDirection: "row", gap: space.sm }} accessibilityRole="tablist">
          {FILTERS.map((each) => (
            <Chip key={each.id} label={each.label} selected={filter === each.id} onPress={() => setFilter(each.id)} />
          ))}
        </View>
      )}
    </View>
  );

  const empty = !can ? (
    <EmptyState icon={Package} title="Update the app on your computer" />
  ) : !list.loaded ? (
    online ? <Loading /> : <EmptyState icon={Package} title="Can't reach your computer" />
  ) : list.error && list.items.length === 0 ? (
    <EmptyState icon={Package} title="Couldn't load artifacts" text={list.error} action="Try again" onAction={list.retry} />
  ) : (
    <EmptyState icon={folder ? FolderOpen : Package} title={folder ? "Nothing in this folder" : filter === "media" ? "No media yet" : filter === "files" ? "No files yet" : "No artifacts yet"} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <FlatList<Artifact>
        style={{ backgroundColor: "transparent" }}
        data={can ? list.items : []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Group flat>
            <ArtifactRow artifact={item} />
          </Group>
        )}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={list.loadingMore ? <ActivityIndicator color={colors.muted} style={{ paddingVertical: space.lg }} /> : undefined}
        onEndReached={() => !list.end && list.more()}
        onEndReachedThreshold={0.5}
        refreshControl={can ? <RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refresh()} tintColor={colors.muted} /> : undefined}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.xxl }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={14}
        windowSize={9}
      />
    </View>
  );
}

function Separator() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: LINE_INSET }} />;
}
