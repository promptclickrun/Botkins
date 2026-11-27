// Settings › Channels (Screen 1: Channels hub).
// Owner-only overview: pending pairings & broken connection callouts, connected channels
// grouped list (no pause switch on the list), and Today activity stats strip linking to Activity.
import { type Href, router, Stack } from "expo-router";
import { AlertCircle, Plus, Radio, UserRound } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ChannelAuditEntry, ChannelConnection } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import {
  Button,
  EmptyState,
  Group,
  IconButton,
  Label,
  Page,
  radius,
  Row,
  space,
  T,
  Tap,
  useTheme,
} from "@/ui";
import {
  CHANNEL_KIND_SPECS,
  channelStatusMeta,
  collectPendingPairings,
  computeTodayStats,
  formatShortTime,
  isBrokenConnection,
  transportDisplay,
} from "./channels/logic";
import { ChannelKindTile, OwnerOnlyPage, StatusPill, SurfaceCard, useIsChannelsOwner } from "./channels/ui";

function connectionSubtitle(conn: ChannelConnection, botName: string): string {
  const status = channelStatusMeta(conn);
  if (status.state === "auth_error") {
    return `${botName} · ${conn.status?.detail ? conn.status.detail : "auth failed"}`;
  }
  if (status.state === "waiting_permission") {
    return `${botName} · ${conn.status?.detail || "waiting for macOS permission"}`;
  }
  if (conn.paused) {
    return `${botName} · ${transportDisplay(conn)}`;
  }
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (conn.dailyUsage?.date === todayKey && conn.dailyUsage.turns > 0) {
    return `${botName} · ${conn.dailyUsage.turns} ${conn.dailyUsage.turns === 1 ? "turn" : "turns"} today`;
  }
  if (conn.status?.lastEventAt) {
    return `${botName} · ${formatShortTime(conn.status.lastEventAt)}`;
  }
  return `${botName} · ${transportDisplay(conn)}`;
}

export default function Channels() {
  const owner = useIsChannelsOwner();
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const online = useOnline();
  const channels = usePart("channels") ?? [];
  const bots = usePart("bots") ?? [];
  const [logs, setLogs] = useState<ChannelAuditEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadLogs = useCallback(async () => {
    if (!owner) return;
    try {
      const result = await api.channelLogs(null, { limit: 150 });
      if (Array.isArray(result)) setLogs(result);
    } catch {
      // Today stats are optional; fail quietly if logs aren't available yet.
    }
  }, [owner]);

  useEffect(() => {
    if (online && owner) void loadLogs();
  }, [online, owner, channels.length, loadLogs]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([attempt(api.channelsList()), loadLogs()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadLogs]);

  const pairings = useMemo(() => collectPendingPairings(channels), [channels]);
  const broken = useMemo(() => channels.filter(isBrokenConnection), [channels]);
  const stats = useMemo(() => (logs ? computeTodayStats(channels, logs) : null), [channels, logs]);

  if (!owner) return <OwnerOnlyPage title="Channels" />;

  const pairingKinds = [...new Set(pairings.map((p) => CHANNEL_KIND_SPECS[p.kind]?.name ?? p.kind))];
  const firstPairingConn = pairings[0]?.connectionId;
  const openAdd = () => router.push("/settings/channels/add" as Href);
  const openActivity = () => router.push("/settings/channels/activity" as Href);

  const dividerColor = hasBackdrop
    ? dark
      ? "rgba(255,255,255,0.12)"
      : "rgba(15,23,42,0.10)"
    : colors.line;

  return (
    <Page
      title="Channels"
      caption="Where people reach your bots."
      onRefresh={onRefresh}
      refreshing={refreshing}
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={Plus}
              label="Add channel"
              variant={hasBackdrop ? "glass" : "soft"}
              onPress={openAdd}
            />
          ),
        }}
      />

      {(pairings.length > 0 || broken.length > 0) && (
        <View style={{ gap: space.sm }}>
          {pairings.length > 0 && (
            <SurfaceCard style={{ padding: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: colors.primary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <UserRound size={19} color={colors.onPrimary} strokeWidth={2.2} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <T variant="callout" weight="600" numberOfLines={1}>
                  {pairings.length === 1 ? "1 wants to talk" : `${pairings.length} want to talk`}
                </T>
                <T variant="footnote" color="muted" numberOfLines={1}>
                  {pairingKinds.join(" · ")}
                </T>
              </View>
              <Button
                title="Review"
                variant="primary"
                size="sm"
                style={{ borderRadius: radius.pill }}
                onPress={() =>
                  router.push({
                    pathname: "/settings/channels/who" as any,
                    params: firstPairingConn ? { id: firstPairingConn } : {},
                  })
                }
              />
            </SurfaceCard>
          )}

          {broken.map((conn) => {
            const status = channelStatusMeta(conn);
            const kindName = CHANNEL_KIND_SPECS[conn.kind]?.name ?? conn.kind;
            const shortName =
              conn.label.length > 14 && conn.label.toLowerCase().includes(kindName.toLowerCase())
                ? kindName
                : conn.label;
            const reason =
              conn.status?.detail ||
              (status.state === "auth_error"
                ? "Token rejected"
                : status.state === "waiting_permission"
                  ? "Waiting for macOS permission"
                  : "Disconnected");
            return (
              <SurfaceCard
                key={conn.id}
                style={{ padding: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 19,
                    backgroundColor: status.tone === "warning" ? colors.warningSoft : colors.dangerSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <AlertCircle
                    size={19}
                    color={status.tone === "warning" ? colors.warning : colors.danger}
                    strokeWidth={2.2}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="callout" weight="600" numberOfLines={1}>
                    {`${shortName} is offline`}
                  </T>
                  <T variant="footnote" color="muted" numberOfLines={1}>
                    {reason}
                  </T>
                </View>
                <Button
                  title="Fix"
                  variant={hasBackdrop ? "glass" : "secondary"}
                  size="sm"
                  style={{ borderRadius: radius.pill }}
                  onPress={() =>
                    router.push({
                      pathname: "/settings/channels/[id]" as any,
                      params: { id: conn.id },
                    })
                  }
                />
              </SurfaceCard>
            );
          })}
        </View>
      )}

      {channels.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No channels connected"
          text="Connect Slack, Telegram, Discord, or iMessage so people can reach your bots."
          action="Add channel"
          onAction={openAdd}
        />
      ) : (
        <View>
          <Label>Connected</Label>
          <Group inset={space.lg + 38 + space.md}>
            {channels.map((conn) => {
              const status = channelStatusMeta(conn);
              const botName = bots.find((b) => b.id === conn.botId)?.name ?? "Unbound";
              return (
                <Row
                  key={conn.id}
                  leading={<ChannelKindTile kind={conn.kind} size={38} />}
                  title={conn.label}
                  subtitle={connectionSubtitle(conn, botName)}
                  trailing={<StatusPill status={status} />}
                  chevron
                  onPress={() =>
                    router.push({
                      pathname: "/settings/channels/[id]" as any,
                      params: { id: conn.id },
                    })
                  }
                />
              );
            })}
          </Group>
        </View>
      )}

      {stats && channels.length > 0 && (
        <View>
          <Label>Today</Label>
          <Tap
            onPress={openActivity}
            feel="select"
            sink={0.99}
            accessibilityLabel={`Today: ${stats.turns} turns, ${stats.blocked} blocked, ${stats.newPeople} new people. Open activity`}
          >
            <SurfaceCard style={{ flexDirection: "row" }}>
              {[
                { value: String(stats.turns), label: "turns" },
                { value: String(stats.blocked), label: "blocked" },
                { value: String(stats.newPeople), label: "new people" },
              ].map((stat, idx) => (
                <View
                  key={stat.label}
                  style={{
                    flex: 1,
                    paddingVertical: space.md,
                    paddingHorizontal: space.lg,
                    borderLeftWidth: idx > 0 ? StyleSheet.hairlineWidth : 0,
                    borderLeftColor: dividerColor,
                  }}
                >
                  <T variant="title2" weight="700" numberOfLines={1}>
                    {stat.value}
                  </T>
                  <T variant="footnote" color="muted" numberOfLines={1}>
                    {stat.label}
                  </T>
                </View>
              ))}
            </SurfaceCard>
          </Tap>
        </View>
      )}
    </Page>
  );
}
