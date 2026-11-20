// Pieces the Marketplace screens share: the search field, app rows and tiles, the connected check.
import { router } from "expo-router";
import { Check, Search, X } from "lucide-react-native";
import { memo } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { type Toolkit, useIsConnected } from "@/composio/store";
import { AppLogo, radius, space, T, Tap, useTheme } from "@/ui";

export const openApp = (slug: string) => router.push({ pathname: "/market/app/[slug]", params: { slug } });

export function SearchField({ value, onChange, label = "Search apps" }: { value: string; onChange: (text: string) => void; label?: string }) {
  const { colors, dark, type } = useTheme();
  return (
    <View style={{ minHeight: 46, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
      <Search size={17} color={colors.muted} strokeWidth={2.3} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="never"
        maxFontSizeMultiplier={1.3}
        accessibilityLabel={label}
        style={[type.callout, { flex: 1, color: colors.ink, paddingVertical: 12 }]}
      />
      {!!value && (
        <Tap onPress={() => onChange("")} accessibilityLabel="Clear search" feel="select" sink={0.9} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.faint, alignItems: "center", justifyContent: "center" }}>
            <X size={12} color={colors.sunken} strokeWidth={3} />
          </View>
        </Tap>
      )}
    </View>
  );
}

/** The small green check that says an app is connected. `ring` is the color it sits on. */
export function CheckBadge({ size = 20, ring }: { size?: number; ring?: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.success, borderWidth: ring ? 2 : 0, borderColor: ring, alignItems: "center", justifyContent: "center" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Check size={Math.round(size * 0.58)} color={colors.canvas} strokeWidth={3.4} />
    </View>
  );
}

/** An app as a tile: its logo, its name under it, and the check when connected. */
export const AppTile = memo(function AppTile({ toolkit, size = 54, width }: { toolkit: Toolkit; size?: number; /** A fixed width (a shelf); otherwise the tile shares its row. */ width?: number }) {
  const { colors } = useTheme();
  const connected = useIsConnected(toolkit.slug);
  return (
    <Tap
      onPress={() => openApp(toolkit.slug)}
      accessibilityLabel={toolkit.name + (connected ? ", connected" : "")}
      sink={0.94}
      hitSlop={0}
      style={[{ alignItems: "center", gap: 6, paddingVertical: 2 }, width ? { width } : { flex: 1, minWidth: 0 }]}
    >
      <View>
        <AppLogo name={toolkit.name} uri={toolkit.logo} size={size} />
        {connected && (
          <View style={{ position: "absolute", top: -5, right: -5 }}>
            <CheckBadge ring={colors.canvas} />
          </View>
        )}
      </View>
      <T variant="caption" weight="600" color="ink2" center numberOfLines={1} style={{ alignSelf: "stretch" }}>
        {toolkit.name}
      </T>
    </Tap>
  );
});

/** An app as a row: logo, name, one line of what it does, and the check when connected. */
export const AppRow = memo(function AppRow({ toolkit }: { toolkit: Toolkit }) {
  const connected = useIsConnected(toolkit.slug);
  return (
    <Tap onPress={() => openApp(toolkit.slug)} sink={1} feel="select" hitSlop={0} accessibilityLabel={toolkit.name + (connected ? ", connected" : "") + (toolkit.description ? ", " + toolkit.description : "")}>
      <View style={{ minHeight: 64, paddingHorizontal: space.lg, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <AppLogo name={toolkit.name} uri={toolkit.logo} size={40} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {toolkit.name}
          </T>
          {!!toolkit.description && (
            <T variant="footnote" color="muted" numberOfLines={1}>
              {toolkit.description}
            </T>
          )}
        </View>
        {connected && <CheckBadge size={22} />}
      </View>
    </Tap>
  );
});

/** A row of a long list drawn as one rounded card: edges on the first and last, hairlines between. */
export const ListCell = memo(function ListCell({ toolkit, first, last }: { toolkit: Toolkit; first: boolean; last: boolean }) {
  const { colors } = useTheme();
  const edge = StyleSheet.hairlineWidth;
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderLeftWidth: edge,
        borderRightWidth: edge,
        borderTopWidth: first ? edge : 0,
        borderBottomWidth: last ? edge : 0,
        borderTopLeftRadius: first ? radius.lg : 0,
        borderTopRightRadius: first ? radius.lg : 0,
        borderBottomLeftRadius: last ? radius.lg : 0,
        borderBottomRightRadius: last ? radius.lg : 0,
        overflow: "hidden",
      }}
    >
      {!first && <View style={{ height: edge, backgroundColor: colors.line, marginLeft: space.lg }} />}
      <AppRow toolkit={toolkit} />
    </View>
  );
});

/** Grey stand-ins for a grid of tiles while the app list loads. */
export function TileSkeleton({ rows = 3, size = 54 }: { rows?: number; size?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.lg }} accessibilityLabel="Loading apps">
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={{ flexDirection: "row", gap: space.sm }}>
          {[0, 1, 2, 3].map((cell) => (
            <View key={cell} style={{ flex: 1, alignItems: "center", gap: 8 }}>
              <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.24), backgroundColor: colors.sunken }} />
              <View style={{ width: size - 8, height: 10, borderRadius: 5, backgroundColor: colors.sunken }} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Grey stand-ins for rows of apps. */
export function RowSkeleton({ rows = 6 }: { rows?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" }} accessibilityLabel="Loading apps">
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={{ height: 64, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: colors.sunken }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "40%", height: 12, borderRadius: 6, backgroundColor: colors.sunken }} />
            <View style={{ width: "75%", height: 10, borderRadius: 5, backgroundColor: colors.sunken }} />
          </View>
        </View>
      ))}
    </View>
  );
}
