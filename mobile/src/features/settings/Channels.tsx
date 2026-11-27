// Settings › Channels: owner-only view of external messaging channels (Slack, Telegram, Discord, iMessage),
// live connection status, pending DM pairing approvals, and pause/resume switches.
import { useState } from "react";
import { View } from "react-native";
import type { ChannelConnection, ChannelPairing } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Badge, Button, EmptyState, Group, Label, Page, Row, space, T, type Tone } from "@/ui";

function statusMeta(conn: ChannelConnection): { label: string; tone: Tone } {
  const s = conn.status?.state ?? (conn.paused ? "paused" : conn.enabled ? "disconnected" : "disabled");
  switch (s) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "reconnecting":
      return { label: "Reconnecting", tone: "warning" };
    case "auth_error":
      return { label: "Auth error", tone: "danger" };
    case "waiting_permission":
      return { label: "Waiting for macOS permission", tone: "warning" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "disabled":
      return { label: "Disabled", tone: "neutral" };
    default:
      return { label: "Disconnected", tone: "neutral" };
  }
}

export default function Channels() {
  const channels = usePart("channels") ?? [];
  const bots = usePart("bots") ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);

  const pairings: Array<ChannelPairing & { connectionId: string; connectionLabel: string; kind: string }> = [];
  for (const conn of channels) {
    for (const p of conn.pendingPairings ?? []) {
      pairings.push({
        ...p,
        connectionId: conn.id,
        connectionLabel: conn.label,
        kind: conn.kind,
      });
    }
  }

  async function togglePause(conn: ChannelConnection, active: boolean) {
    setBusyId(conn.id);
    try {
      if (active) await attempt(api.channelResume(conn.id));
      else await attempt(api.channelPause(conn.id));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleNotifyPhone(conn: ChannelConnection, notifyPhone: boolean) {
    const key = `${conn.id}:notify`;
    setBusyId(key);
    try {
      await attempt(api.channelSetPolicy(conn.id, { notifyPhone }));
    } finally {
      setBusyId(null);
    }
  }

  async function decidePair(code: string, connectionId: string, approve: boolean) {
    setBusyId(code);
    try {
      if (approve) await attempt(api.channelPairApprove(code, connectionId));
      else await attempt(api.channelPairDeny(code, connectionId));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Page title="Channels">
      {pairings.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Label>{`Pairing approvals (${pairings.length})`}</Label>
          <Group>
            {pairings.map((p) => (
              <Row
                key={`${p.connectionId}-${p.code}`}
                title={`${p.display || p.senderId} · ${p.kind}`}
                subtitle={`Code ${p.code} · ${p.connectionLabel}`}
                subtitleLines={2}
                trailing={
                  <View style={{ flexDirection: "row", gap: space.xs }}>
                    <Button
                      title="Approve"
                      size="sm"
                      disabled={busyId === p.code}
                      onPress={() => void decidePair(p.code, p.connectionId, true)}
                    />
                    <Button
                      title="Deny"
                      variant="secondary"
                      size="sm"
                      disabled={busyId === p.code}
                      onPress={() => void decidePair(p.code, p.connectionId, false)}
                    />
                  </View>
                }
              />
            ))}
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.sm }}>
            Approving adds the sender to that channel's DM allowlist.
          </T>
        </View>
      )}

      {channels.length === 0 ? (
        <EmptyState
          title="No channels connected"
          text="Add Slack, Telegram, Discord, or iMessage in Settings › Channels on your computer or via `botkins channels add`."
        />
      ) : (
        <View style={{ gap: space.sm }}>
          <Label>Connected channels</Label>
          {channels.map((conn) => {
            const badge = statusMeta(conn);
            const botName = bots.find((b) => b.id === conn.botId)?.name ?? "Unbound";
            const detail = conn.status?.detail
              ? `${conn.kind} · ${botName} · ${conn.status.detail}`
              : `${conn.kind} · ${botName}${conn.nodeHostId ? ` · node ${conn.nodeHostId}` : ""}`;
            return (
              <Group key={conn.id}>
                <Row
                  title={conn.label}
                  subtitle={detail}
                  subtitleLines={3}
                  trailing={<Badge label={badge.label} tone={badge.tone} />}
                  toggled={conn.enabled && !conn.paused}
                  disabled={busyId === conn.id}
                  onToggle={(next) => void togglePause(conn, next)}
                />
                <Row
                  title="Phone notifications for replies"
                  subtitle="Off by default"
                  toggled={Boolean(conn.policy?.notifyPhone)}
                  disabled={busyId === `${conn.id}:notify`}
                  onToggle={(next) => void toggleNotifyPhone(conn, next)}
                />
              </Group>
            );
          })}
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.sm }}>
            Toggle off to pause a channel without removing its credentials. Full setup and other policies are managed on your computer or CLI.
          </T>
        </View>
      )}
    </Page>
  );
}
