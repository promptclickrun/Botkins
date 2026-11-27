// Settings › Channels › Activity (Screen 5).
// Filter Chips (All / Blocked n / Replied / Pairing / Errors), connection filter button,
// channelLogs grouped by day (time + status badge + who + subtitle, metadata only — never
// message bodies). Tapping a Blocked event opens a sheet with the exact channelSetPolicy fix.
import { MenuView } from "@react-native-menu/menu";
import { Stack, useLocalSearchParams } from "expo-router";
import { AlertCircle, ChevronRight, ListFilter } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import type { ChannelAuditEntry, ChannelConnection } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import {
  Button,
  Chip,
  EmptyState,
  Group,
  IconButton,
  Label,
  Loading,
  Page,
  radius,
  space,
  T,
  Tap,
  useTheme,
} from "@/ui";
import {
  type ActivityFilter,
  auditEntryDisplay,
  blockedEventFixPlan,
  type BlockedFixAction,
  CHANNEL_KIND_SPECS,
  filterAuditEntries,
  formatClock,
  groupAuditByDay,
} from "./logic";
import { OwnerOnlyPage, PillBadge, useIsChannelsOwner } from "./ui";

function eventSubtitle(
  entry: ChannelAuditEntry,
  conn: ChannelConnection | undefined,
  botName: string | undefined,
  reasonText: string,
): string {
  const kindName = CHANNEL_KIND_SPECS[entry.kind as keyof typeof CHANNEL_KIND_SPECS]?.name ?? String(entry.kind);
  const place = entry.conversationId
    ? entry.conversationId.startsWith("#")
      ? `${kindName} ${entry.conversationId}`
      : `${kindName} · ${entry.conversationId}`
    : conn?.label || kindName;
  const parts = [place];
  if (entry.decision === "reply_sent" && botName) parts.push(botName);
  if (reasonText) parts.push(reasonText);
  return parts.join(" · ");
}

export default function ChannelActivity() {
  const owner = useIsChannelsOwner();
  const params = useLocalSearchParams<{ id?: string; filter?: string }>();
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const online = useOnline();
  const channels = usePart("channels") ?? [];
  const bots = usePart("bots") ?? [];

  const [connFilter, setConnFilter] = useState<string>(params.id ?? "");
  const [filter, setFilter] = useState<ActivityFilter>(
    params.filter === "blocked" ||
      params.filter === "replied" ||
      params.filter === "pairing" ||
      params.filter === "errors"
      ? params.filter
      : "all",
  );
  const [entries, setEntries] = useState<ChannelAuditEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedBlocked, setSelectedBlocked] = useState<ChannelAuditEntry | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!owner) return;
    const res = await attempt(api.channelLogs(connFilter || null, { limit: 150 }));
    if (Array.isArray(res)) setEntries(res);
    else setEntries((cur) => cur ?? []);
  }, [owner, connFilter]);

  useEffect(() => {
    if (online && owner) void load();
  }, [online, owner, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const blockedCount = useMemo(
    () => (entries ?? []).filter((e) => auditEntryDisplay(e).category === "blocked").length,
    [entries],
  );

  const visible = useMemo(
    () => filterAuditEntries(entries ?? [], filter, connFilter || undefined),
    [entries, filter, connFilter],
  );

  const grouped = useMemo(() => groupAuditByDay(visible), [visible]);

  if (!owner) return <OwnerOnlyPage title="Activity" />;

  const activeConn = connFilter ? channels.find((c) => c.id === connFilter) : undefined;
  const caption = activeConn ? `${activeConn.label} · metadata only` : "All channels · metadata only";

  const selectedConn = selectedBlocked
    ? channels.find((c) => c.id === selectedBlocked.connectionId)
    : undefined;
  const fixPlan = selectedBlocked ? blockedEventFixPlan(selectedBlocked, selectedConn) : null;

  async function applyFix(action: BlockedFixAction) {
    if (!selectedBlocked) return;
    setApplyingId(action.id);
    try {
      const ok = await attempt(
        api.channelSetPolicy(selectedBlocked.connectionId, action.patch),
        action.successToast,
      );
      if (ok) {
        setSelectedBlocked(null);
        await load();
      }
    } finally {
      setApplyingId(null);
    }
  }

  const filterChips: { value: ActivityFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "blocked", label: blockedCount > 0 ? `Blocked ${blockedCount}` : "Blocked" },
    { value: "replied", label: "Replied" },
    { value: "pairing", label: "Pairing" },
    { value: "errors", label: "Errors" },
  ];

  return (
    <Page title="Activity" caption={caption} onRefresh={onRefresh} refreshing={refreshing}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <MenuView
              title="Filter by channel"
              actions={[
                {
                  id: "",
                  title: "All channels",
                  state: connFilter === "" ? "on" : "off",
                },
                ...channels.map((c) => ({
                  id: c.id,
                  title: c.label,
                  state: connFilter === c.id ? ("on" as const) : ("off" as const),
                })),
              ]}
              onPressAction={({ nativeEvent }) => setConnFilter(nativeEvent.event)}
            >
              <IconButton
                icon={ListFilter}
                label="Filter by channel"
                variant={hasBackdrop ? "glass" : "soft"}
              />
            </MenuView>
          ),
        }}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -space.xl }}
        contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}
      >
        {filterChips.map((chip) => (
          <Chip
            key={chip.value}
            label={chip.label}
            selected={filter === chip.value}
            onPress={() => setFilter(chip.value)}
          />
        ))}
      </ScrollView>

      {entries === null ? (
        <Loading label="Loading activity" />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No activity yet"
          text={
            filter === "all"
              ? "Inbound decisions, pairings, and replies appear here with metadata only — never message bodies."
              : `No ${filter} events in this view.`
          }
        />
      ) : (
        <View style={{ gap: space.lg }}>
          {grouped.map((day) => (
            <View key={day.key}>
              {grouped.length > 1 && <Label>{day.label}</Label>}
              <Group inset={space.lg + 44 + space.md}>
                {day.entries.map((entry, idx) => {
                  const display = auditEntryDisplay(entry);
                  const conn = channels.find((c) => c.id === entry.connectionId);
                  const botName = conn ? bots.find((b) => b.id === conn.botId)?.name : undefined;
                  const who = entry.senderId || conn?.label || String(entry.kind);
                  const subtitle = eventSubtitle(entry, conn, botName, display.reasonText);
                  const rowKey = `${entry.time}-${entry.connectionId}-${idx}`;
                  const rowContent = (
                    <View
                      style={{
                        minHeight: 58,
                        paddingHorizontal: space.lg,
                        paddingVertical: 10,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.md,
                      }}
                    >
                      <T
                        variant="footnote"
                        color="muted"
                        style={{ width: 44, fontVariant: ["tabular-nums"] }}
                        numberOfLines={1}
                      >
                        {formatClock(entry.time)}
                      </T>
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                          <PillBadge label={display.badgeLabel} tone={display.tone} />
                          <T variant="callout" weight="600" numberOfLines={1} style={{ flex: 1 }}>
                            {who}
                          </T>
                        </View>
                        <T variant="footnote" color="muted" numberOfLines={1}>
                          {subtitle}
                        </T>
                      </View>
                      {display.blocked && (
                        <ChevronRight size={18} color={colors.faint} strokeWidth={2.2} />
                      )}
                    </View>
                  );
                  if (!display.blocked) {
                    return <View key={rowKey}>{rowContent}</View>;
                  }
                  return (
                    <Tap
                      key={rowKey}
                      onPress={() => setSelectedBlocked(entry)}
                      feel="select"
                      sink={1}
                      accessibilityLabel={`${display.badgeLabel} ${who}, ${subtitle}. Open fix options`}
                    >
                      {rowContent}
                    </Tap>
                  );
                })}
              </Group>
            </View>
          ))}
        </View>
      )}

      {/* Blocked-event bottom sheet */}
      <Modal
        visible={!!selectedBlocked && !!fixPlan}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedBlocked(null)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim }}>
          <Tap
            onPress={() => setSelectedBlocked(null)}
            accessibilityLabel="Dismiss"
            style={StyleSheet.absoluteFill}
          />
          {fixPlan && (
            <View
              style={{
                backgroundColor: colors.raised,
                borderTopLeftRadius: radius.xl,
                borderTopRightRadius: radius.xl,
                paddingHorizontal: space.xl,
                paddingTop: space.md,
                paddingBottom: space.huge,
                gap: space.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderColor: dark ? "rgba(255,255,255,0.14)" : colors.line,
              }}
            >
              <View
                style={{
                  width: 38,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: colors.lineStrong,
                  alignSelf: "center",
                  marginBottom: space.xs,
                }}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: colors.dangerSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <AlertCircle size={20} color={colors.danger} strokeWidth={2.2} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="headline" weight="700" numberOfLines={2}>
                    {fixPlan.title}
                  </T>
                  <T variant="footnote" color="muted" numberOfLines={1}>
                    {fixPlan.subtitle}
                  </T>
                </View>
              </View>

              <T variant="subhead" color="muted">
                {fixPlan.explanation}
              </T>

              <View style={{ gap: space.sm, marginTop: space.xs }}>
                {fixPlan.actions.map((action) => (
                  <Button
                    key={action.id}
                    title={action.label}
                    variant={action.variant}
                    size="md"
                    wide
                    style={{ borderRadius: radius.pill }}
                    loading={applyingId === action.id}
                    disabled={!online || applyingId !== null}
                    onPress={() => void applyFix(action)}
                  />
                ))}
                {fixPlan.actions.length === 0 && (
                  <Button
                    title="Close"
                    variant="secondary"
                    size="md"
                    wide
                    style={{ borderRadius: radius.pill }}
                    onPress={() => setSelectedBlocked(null)}
                  />
                )}
              </View>
            </View>
          )}
        </View>
      </Modal>
    </Page>
  );
}
