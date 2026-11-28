// Settings › Channels › Connection detail (Screen 2).
// Hero glass card (tile, label, identity/transport, status badge, last test result) with
// Test now + Pause/Resume, DM policy Segmented control, and grouped settings rows.
import { MenuView } from "@react-native-menu/menu";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Check, Ellipsis, KeyRound, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, Modal, Platform, View } from "react-native";
import type { ChannelDmPolicy, ChannelGroupMode, ChannelToolProfile } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { showToast } from "@/state/store";
import {
  Button,
  EmptyState,
  Field,
  Group,
  IconButton,
  Label,
  Page,
  radius,
  Row,
  Segmented,
  Sheet,
  space,
  T,
  useTheme,
} from "@/ui";
import {
  CHANNEL_KIND_SPECS,
  channelStatusMeta,
  DM_POLICY_OPTIONS,
  effectivePolicy,
  formatClock,
  GROUP_MODE_OPTIONS,
  groupSummary,
  limitsSummary,
  TOOL_PROFILE_OPTIONS,
  transportDisplay,
} from "./logic";
import { ChannelKindTile, OwnerOnlyPage, PillBadge, StatusPill, SurfaceCard, useIsChannelsOwner } from "./ui";

type SubSheet = null | "bot" | "groups" | "tools" | "limits";

type TestInfo = {
  ok: boolean;
  detail: string;
  identity?: string;
  at: number;
  ms: number;
};

export default function ChannelDetail() {
  const owner = useIsChannelsOwner();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const online = useOnline();
  const channels = usePart("channels") ?? [];
  const bots = (usePart("bots") ?? []).filter((b) => !b.hidden);
  const conn = channels.find((c) => c.id === id);

  const [busy, setBusy] = useState<string | null>(null);
  const [testInfo, setTestInfo] = useState<TestInfo | null>(null);
  const [sheet, setSheet] = useState<SubSheet>(null);

  // Groups editor draft
  const [groupsEnabled, setGroupsEnabled] = useState(false);
  const [groupsMode, setGroupsMode] = useState<ChannelGroupMode>("mention");
  const [groupsChannelsText, setGroupsChannelsText] = useState("");

  // Limits editor draft
  const [dailyCapDraft, setDailyCapDraft] = useState("200");
  const [senderRateDraft, setSenderRateDraft] = useState("10");
  const [connRateDraft, setConnRateDraft] = useState("60");
  const [maxLenDraft, setMaxLenDraft] = useState("4000");

  if (!owner) return <OwnerOnlyPage title="Channel" />;

  if (!conn) {
    return (
      <Page title="Channel">
        <EmptyState
          title="Connection not found"
          text="This channel connection may have been removed."
          action="Go back"
          onAction={() => router.back()}
        />
      </Page>
    );
  }

  const policy = effectivePolicy(conn);
  const status = channelStatusMeta(conn);
  const spec = CHANNEL_KIND_SPECS[conn.kind];
  const boundBot = bots.find((b) => b.id === conn.botId);
  const waitingCount = conn.pendingPairings?.length ?? 0;
  const dmDesc = DM_POLICY_OPTIONS.find((o) => o.value === policy.dm)?.description ?? "";
  const identityLine = testInfo?.identity
    ? `${testInfo.identity} · ${transportDisplay(conn)}`
    : `${spec?.name ?? conn.kind} · ${transportDisplay(conn)}`;
  const hasSecrets = (spec?.secrets.length ?? 0) > 0;
  const secretsInVault = (conn.configuredSecrets?.length ?? 0) > 0;

  async function runTest() {
    if (!conn) return;
    setBusy("test");
    const started = Date.now();
    try {
      const res = await attempt(api.channelTest(conn.id));
      const ms = Math.max(1, Date.now() - started);
      if (res) {
        setTestInfo({
          ok: res.ok,
          detail: res.detail,
          identity: res.identity,
          at: Date.now(),
          ms,
        });
        showToast(res.ok ? "Connection OK" : res.detail || "Connection test failed", res.ok ? "success" : "error");
      }
    } finally {
      setBusy(null);
    }
  }

  async function togglePause() {
    if (!conn) return;
    setBusy("pause");
    try {
      if (conn.paused) {
        await attempt(api.channelResume(conn.id), `${conn.label} resumed`);
      } else {
        await attempt(api.channelPause(conn.id), `${conn.label} paused`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function setDmPolicy(dm: ChannelDmPolicy) {
    if (!conn || dm === policy.dm) return;
    setBusy("dm");
    try {
      await attempt(api.channelSetPolicy(conn.id, { dm }));
    } finally {
      setBusy(null);
    }
  }

  async function setNotifyPhone(notifyPhone: boolean) {
    if (!conn) return;
    setBusy("notify");
    try {
      await attempt(api.channelSetPolicy(conn.id, { notifyPhone }));
    } finally {
      setBusy(null);
    }
  }

  async function bindBot(botId: string) {
    if (!conn) return;
    setBusy("bot");
    try {
      const ok = await attempt(api.channelBind(conn.id, botId), "Bound bot updated");
      if (ok) setSheet(null);
    } finally {
      setBusy(null);
    }
  }

  function openGroups() {
    setGroupsEnabled(policy.groups.enabled);
    setGroupsMode(policy.groups.mode);
    setGroupsChannelsText(policy.groups.channels.join(", "));
    setSheet("groups");
  }

  async function saveGroups() {
    if (!conn) return;
    const list = groupsChannelsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy("groups");
    try {
      const ok = await attempt(
        api.channelSetPolicy(conn.id, {
          groups: { enabled: groupsEnabled, mode: groupsMode, channels: list },
        }),
        "Group settings saved",
      );
      if (ok) setSheet(null);
    } finally {
      setBusy(null);
    }
  }

  async function setToolProfile(toolProfile: ChannelToolProfile) {
    if (!conn) return;
    setBusy("tools");
    try {
      const ok = await attempt(
        api.channelSetPolicy(conn.id, { toolProfile }),
        toolProfile === "standard" ? "Switched to Standard tools" : "Switched to Restricted tools",
      );
      if (ok) setSheet(null);
    } finally {
      setBusy(null);
    }
  }

  function openLimits() {
    setDailyCapDraft(String(policy.limits.dailyTurnCap));
    setSenderRateDraft(String(policy.limits.senderPerMinute));
    setConnRateDraft(String(policy.limits.connectionPerMinute));
    setMaxLenDraft(String(policy.limits.maxInboundLength));
    setSheet("limits");
  }

  async function saveLimits() {
    if (!conn) return;
    const parse = (raw: string, fallback: number, min: number, max: number) => {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
    };
    setBusy("limits");
    try {
      const ok = await attempt(
        api.channelSetPolicy(conn.id, {
          limits: {
            dailyTurnCap: parse(dailyCapDraft, policy.limits.dailyTurnCap, 1, 100_000),
            senderPerMinute: parse(senderRateDraft, policy.limits.senderPerMinute, 1, 1000),
            connectionPerMinute: parse(connRateDraft, policy.limits.connectionPerMinute, 1, 10_000),
            maxInboundLength: parse(maxLenDraft, policy.limits.maxInboundLength, 64, 32_000),
          },
        }),
        "Limits saved",
      );
      if (ok) setSheet(null);
    } finally {
      setBusy(null);
    }
  }

  function openReplaceToken() {
    if (!conn) return;
    router.push({
      pathname: "/settings/channels/add" as any,
      params: { mode: "replace", id: conn.id },
    });
  }

  function confirmRemove() {
    if (!conn) return;
    const removeNow = async () => {
      setBusy("remove");
      try {
        const res = await attempt(api.channelRemove(conn.id), `${conn.label} removed`);
        if (res) router.back();
      } finally {
        setBusy(null);
      }
    };
    if (Platform.OS === "web") {
      void removeNow();
      return;
    }
    Alert.alert(
      `Remove ${conn.label}?`,
      "This disconnects the channel and deletes its credentials from your vault.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void removeNow() },
      ],
    );
  }

  const openActivity = () =>
    router.push({
      pathname: "/settings/channels/activity" as any,
      params: { id: conn.id },
    });

  return (
    <Page>
      <Stack.Screen
        options={{
          headerRight: () => (
            <MenuView
              title={conn.label}
              actions={[
                { id: "activity", title: "Activity log" },
                ...(hasSecrets ? [{ id: "replace", title: "Replace token" }] : []),
                { id: "remove", title: "Remove channel", attributes: { destructive: true } },
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "activity") openActivity();
                else if (nativeEvent.event === "replace") openReplaceToken();
                else if (nativeEvent.event === "remove") confirmRemove();
              }}
            >
              <IconButton
                icon={Ellipsis}
                label="More channel actions"
                variant={hasBackdrop ? "glass" : "soft"}
              />
            </MenuView>
          ),
        }}
      />

      {/* Hero glass card */}
      <SurfaceCard style={{ padding: space.lg, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <ChannelKindTile kind={conn.kind} size={54} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="title2" weight="700" numberOfLines={2}>
              {conn.label}
            </T>
            <T variant="footnote" color="muted" numberOfLines={1}>
              {identityLine}
            </T>
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
          <StatusPill status={status} detail />
          {testInfo ? (
            <T variant="footnote" color={testInfo.ok ? "muted" : "danger"} numberOfLines={1} style={{ flexShrink: 1 }}>
              {testInfo.ok
                ? `Tested ${formatClock(testInfo.at)} · ${testInfo.ms} ms`
                : testInfo.detail || "Test failed"}
            </T>
          ) : conn.status?.detail ? (
            <T variant="footnote" color={status.tone === "danger" ? "danger" : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>
              {conn.status.detail}
            </T>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button
            title="Test now"
            variant="primary"
            size="sm"
            wide
            style={{ flex: 1, borderRadius: radius.pill }}
            loading={busy === "test"}
            disabled={!online || busy !== null}
            onPress={() => void runTest()}
          />
          <Button
            title={conn.paused ? "Resume" : "Pause"}
            variant="secondary"
            size="sm"
            wide
            style={{ flex: 1, borderRadius: radius.pill }}
            loading={busy === "pause"}
            disabled={!online || busy !== null}
            onPress={() => void togglePause()}
          />
        </View>
      </SurfaceCard>

      {/* DM policy segmented control */}
      <View>
        <Label>Direct messages</Label>
        <Segmented
          options={DM_POLICY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={policy.dm}
          onChange={(next) => void setDmPolicy(next)}
        />
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
          {dmDesc}
        </T>
      </View>

      {/* Core policy & routing group */}
      <Group>
        <Row
          title="Answers as"
          value={boundBot?.name ?? "Unbound"}
          chevron
          disabled={!online || busy !== null}
          onPress={() => setSheet("bot")}
        />
        <Row
          title="Who can DM"
          trailing={
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {waitingCount > 0 && <PillBadge label={`${waitingCount} waiting`} tone="info" />}
              <T variant="subhead" color="muted" numberOfLines={1}>
                {String(policy.allowlist.length)}
              </T>
            </View>
          }
          chevron
          onPress={() =>
            router.push({
              pathname: "/settings/channels/who" as any,
              params: { id: conn.id },
            })
          }
        />
        <Row
          title="Groups"
          value={groupSummary(policy)}
          chevron
          disabled={!online || busy !== null}
          onPress={openGroups}
        />
        <Row
          title="Tool profile"
          value={policy.toolProfile === "standard" ? "Standard" : "Restricted"}
          chevron
          disabled={!online || busy !== null}
          onPress={() => setSheet("tools")}
        />
        <Row
          title="Limits"
          value={limitsSummary(policy.limits)}
          chevron
          disabled={!online || busy !== null}
          onPress={openLimits}
        />
        <Row
          title="Phone alerts"
          subtitle="Notify on replies · off by default"
          toggled={Boolean(policy.notifyPhone)}
          disabled={!online || busy === "notify"}
          onToggle={(next) => void setNotifyPhone(next)}
        />
      </Group>

      {/* Activity, Credentials & Remove */}
      <Group>
        <Row
          title="Activity"
          subtitle="Metadata-only log"
          chevron
          onPress={openActivity}
        />
        {hasSecrets && (
          <Row
            title="Credentials"
            subtitle="Replace token in vault"
            trailing={secretsInVault ? <PillBadge label="In vault" tone="success" /> : <PillBadge label="Missing" tone="warning" />}
            leading={<KeyRound size={18} color={colors.muted} strokeWidth={2.1} />}
            chevron
            disabled={!online || busy !== null}
            onPress={openReplaceToken}
          />
        )}
        <Row
          title="Remove"
          leading={<Trash2 size={18} color={colors.danger} strokeWidth={2.1} />}
          tone="danger"
          disabled={!online || busy !== null}
          onPress={confirmRemove}
        />
      </Group>

      {/* Bot picker modal */}
      <Modal
        visible={sheet === "bot"}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheet(null)}
      >
        <Sheet title="Answers as" onClose={() => setSheet(null)}>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            Choose which bot replies to messages arriving on {conn.label}.
          </T>
          <Group>
            {bots.map((bot) => (
              <Row
                key={bot.id}
                title={bot.name}
                subtitle={bot.role || undefined}
                trailing={
                  bot.id === conn.botId ? <Check size={18} color={colors.accentText} strokeWidth={2.5} /> : undefined
                }
                disabled={busy === "bot"}
                onPress={() => void bindBot(bot.id)}
              />
            ))}
          </Group>
        </Sheet>
      </Modal>

      {/* Groups modal */}
      <Modal
        visible={sheet === "groups"}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheet(null)}
      >
        <Sheet
          title="Groups"
          action="Save"
          actionLoading={busy === "groups"}
          onAction={() => void saveGroups()}
          onClose={() => setSheet(null)}
        >
          <Group>
            <Row
              title="Allow group channels"
              subtitle="Only listed group IDs are accepted"
              toggled={groupsEnabled}
              onToggle={setGroupsEnabled}
            />
          </Group>

          {groupsEnabled && (
            <>
              <View>
                <Label>Trigger mode</Label>
                <Segmented
                  options={GROUP_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  value={groupsMode}
                  onChange={setGroupsMode}
                />
                <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
                  {GROUP_MODE_OPTIONS.find((o) => o.value === groupsMode)?.description}
                </T>
              </View>

              <Field
                label="Allowed group IDs"
                placeholder="C12345, C67890"
                hint="Comma-separated channel or group chat IDs."
                value={groupsChannelsText}
                onChangeText={setGroupsChannelsText}
                autoCapitalize="none"
                autoCorrect={false}
                mono
                area
              />
            </>
          )}
        </Sheet>
      </Modal>

      {/* Tool profile modal */}
      <Modal
        visible={sheet === "tools"}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheet(null)}
      >
        <Sheet title="Tool profile" onClose={() => setSheet(null)}>
          <Group>
            {TOOL_PROFILE_OPTIONS.map((opt) => (
              <Row
                key={opt.value}
                title={opt.label}
                subtitle={opt.description}
                subtitleLines={3}
                trailing={
                  policy.toolProfile === opt.value ? (
                    <Check size={18} color={colors.accentText} strokeWidth={2.5} />
                  ) : undefined
                }
                disabled={busy === "tools"}
                onPress={() => void setToolProfile(opt.value)}
              />
            ))}
          </Group>
        </Sheet>
      </Modal>

      {/* Limits modal */}
      <Modal
        visible={sheet === "limits"}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheet(null)}
      >
        <Sheet
          title="Limits"
          action="Save"
          actionLoading={busy === "limits"}
          onAction={() => void saveLimits()}
          onClose={() => setSheet(null)}
        >
          <Field
            label="Daily turn cap"
            hint="Pauses inbound replies for the rest of the day once reached."
            value={dailyCapDraft}
            onChangeText={setDailyCapDraft}
            keyboardType="number-pad"
          />
          <Field
            label="Messages per sender / minute"
            value={senderRateDraft}
            onChangeText={setSenderRateDraft}
            keyboardType="number-pad"
          />
          <Field
            label="Messages per connection / minute"
            value={connRateDraft}
            onChangeText={setConnRateDraft}
            keyboardType="number-pad"
          />
          <Field
            label="Max inbound length (characters)"
            value={maxLenDraft}
            onChangeText={setMaxLenDraft}
            keyboardType="number-pad"
          />
        </Sheet>
      </Modal>
    </Page>
  );
}
