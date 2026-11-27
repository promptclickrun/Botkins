// Settings › Channels › Who can DM (Screen 4).
// Waiting pairing cards with time-left badge and Approve/Deny (channelPairApprove/Deny),
// search field, "Allowed · N" list with origin (Paired vs Added by you), red Remove pill
// and swipe-left-to-remove gesture, plus '+' button to add a sender ID manually.
import { Stack, useLocalSearchParams } from "expo-router";
import { Plus, Search, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Modal, TextInput, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import type { ChannelAllowlistEntry } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import {
  Button,
  EmptyState,
  Field,
  Glass,
  Group,
  IconButton,
  Label,
  Page,
  radius,
  Row,
  Sheet,
  space,
  T,
  Tap,
  tint,
  useTheme,
} from "@/ui";
import {
  addAllowlistSender,
  allowlistOriginLine,
  collectPendingPairings,
  effectivePolicy,
  filterAllowlist,
  formatTimeLeft,
  removeAllowlistSender,
} from "./logic";
import { OwnerOnlyPage, PillBadge, SenderAvatar, SurfaceCard, useIsChannelsOwner } from "./ui";

function SearchBox({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { colors, dark, type, control } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const inner = (
    <>
      <Search size={17} color={colors.muted} strokeWidth={2.3} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search name or ID"
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        maxFontSizeMultiplier={1.3}
        accessibilityLabel="Search name or ID"
        style={[type.callout, { flex: 1, color: colors.ink, paddingVertical: 0, height: control.field }]}
      />
      {!!value && (
        <Tap
          onPress={() => onChange("")}
          accessibilityLabel="Clear search"
          feel="select"
          sink={0.9}
          style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
        >
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              backgroundColor: colors.faint,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={12} color={colors.sunken} strokeWidth={3} />
          </View>
        </Tap>
      )}
    </>
  );
  const frame = {
    height: control.field,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: value ? 0 : space.md,
    borderRadius: radius.md,
    overflow: "hidden" as const,
  };
  if (hasBackdrop) {
    return (
      <Glass tintColor={tint(colors.surface, dark ? 0.28 : 0.42)} style={frame}>
        {inner}
      </Glass>
    );
  }
  return <View style={[frame, { backgroundColor: colors.sunken }]}>{inner}</View>;
}

function SwipeableAllowedRow({
  entry,
  busy,
  online,
  showRemoveButton,
  onToggleReveal,
  onRemove,
}: {
  entry: ChannelAllowlistEntry;
  busy: boolean;
  online: boolean;
  showRemoveButton: boolean;
  onToggleReveal: () => void;
  onRemove: () => void;
}) {
  const translateX = useSharedValue(0);
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    onUpdate: (e) => {
      translateX.value = Math.max(-72, Math.min(0, e.translationX));
    },
    onDeactivate: (e) => {
      if (e.translationX < -36) {
        onToggleReveal();
      }
      translateX.value = withSpring(0, { damping: 20, stiffness: 280 });
    },
    onFinalize: () => {
      translateX.value = withSpring(0, { damping: 20, stiffness: 280 });
    },
  });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const name = entry.display || entry.senderId;
  const origin = allowlistOriginLine(entry);

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={animatedStyle}>
        <Row
          leading={<SenderAvatar name={name} seed={entry.senderId} size={38} owner={entry.source !== "pairing"} />}
          title={name}
          subtitle={origin}
          onPress={onToggleReveal}
          trailing={
            showRemoveButton ? (
              <Button
                title="Remove"
                variant="danger"
                size="sm"
                style={{ borderRadius: radius.pill }}
                disabled={!online || busy}
                onPress={onRemove}
              />
            ) : undefined
          }
        />
      </Animated.View>
    </GestureDetector>
  );
}

export default function WhoCanDm() {
  const owner = useIsChannelsOwner();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const online = useOnline();
  const channels = usePart("channels") ?? [];
  const conn = id ? channels.find((c) => c.id === id) : channels[0];

  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [senderIdDraft, setSenderIdDraft] = useState("");
  const [displayDraft, setDisplayDraft] = useState("");

  const pairings = useMemo(
    () => collectPendingPairings(channels, id || undefined),
    [channels, id],
  );

  const policy = effectivePolicy(conn);
  const filtered = useMemo(() => filterAllowlist(policy.allowlist, query), [policy.allowlist, query]);

  if (!owner) return <OwnerOnlyPage title="Who can DM" />;

  async function decidePairing(code: string, connectionId: string, approve: boolean) {
    setBusyKey(`pair:${code}`);
    try {
      if (approve) {
        await attempt(api.channelPairApprove(code, connectionId), "Sender approved");
      } else {
        await attempt(api.channelPairDeny(code, connectionId), "Request denied");
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRemove(senderId: string) {
    if (!conn) return;
    setBusyKey(`rm:${senderId}`);
    try {
      const next = removeAllowlistSender(policy.allowlist, senderId);
      await attempt(api.channelSetPolicy(conn.id, { allowlist: next }), "Removed from allowlist");
      setRevealedId(null);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAddSender() {
    if (!conn) return;
    const trimmed = senderIdDraft.trim();
    if (!trimmed) return;
    setBusyKey("add");
    try {
      const next = addAllowlistSender(policy.allowlist, trimmed, displayDraft.trim() || undefined);
      const ok = await attempt(api.channelSetPolicy(conn.id, { allowlist: next }), "Added to allowlist");
      if (ok) {
        setSenderIdDraft("");
        setDisplayDraft("");
        setAddOpen(false);
      }
    } finally {
      setBusyKey(null);
    }
  }

  const caption = conn ? conn.label : "All channels";

  return (
    <Page title="Who can DM" caption={caption}>
      <Stack.Screen
        options={{
          headerRight: conn
            ? () => (
                <IconButton
                  icon={Plus}
                  label="Add sender"
                  variant={hasBackdrop ? "glass" : "soft"}
                  onPress={() => setAddOpen(true)}
                />
              )
            : undefined,
        }}
      />

      {/* Waiting pairing cards */}
      {pairings.length > 0 && (
        <View style={{ gap: space.sm }}>
          {pairings.map((p) => {
            const who = p.display || p.senderId;
            const busy = busyKey === `pair:${p.code}`;
            return (
              <SurfaceCard key={`${p.connectionId}-${p.code}`} style={{ padding: space.md, gap: space.md }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                  <SenderAvatar name={who} seed={p.senderId} size={38} />
                  <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                    <T variant="callout" weight="600" numberOfLines={1}>
                      {`${who} wants in`}
                    </T>
                    <T variant="footnote" color="muted" numberOfLines={1}>
                      {`${p.senderId} · code ${p.code}`}
                    </T>
                  </View>
                  <PillBadge label={formatTimeLeft(p.expiresAt)} tone="warning" />
                </View>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <Button
                    title="Approve"
                    variant="primary"
                    size="sm"
                    wide
                    style={{ flex: 1, borderRadius: radius.pill }}
                    loading={busy}
                    disabled={!online || busyKey !== null}
                    onPress={() => void decidePairing(p.code, p.connectionId, true)}
                  />
                  <Button
                    title="Deny"
                    variant="secondary"
                    size="sm"
                    wide
                    style={{ flex: 1, borderRadius: radius.pill }}
                    disabled={!online || busyKey !== null}
                    onPress={() => void decidePairing(p.code, p.connectionId, false)}
                  />
                </View>
              </SurfaceCard>
            );
          })}
        </View>
      )}

      {conn && (
        <>
          <SearchBox value={query} onChange={setQuery} />

          <View>
            <Label>{`Allowed · ${policy.allowlist.length}`}</Label>
            {filtered.length === 0 ? (
              <EmptyState
                title={query ? "No matches" : "No one allowlisted yet"}
                text={
                  query
                    ? `No allowed sender matches "${query}".`
                    : "Approve a pairing request or tap + to add a sender ID."
                }
              />
            ) : (
              <Group inset={space.lg + 38 + space.md}>
                {filtered.map((entry, idx) => {
                  const showRemove =
                    revealedId === entry.senderId ||
                    (revealedId === null && idx === filtered.length - 1 && filtered.length > 1);
                  return (
                    <SwipeableAllowedRow
                      key={entry.senderId}
                      entry={entry}
                      busy={busyKey === `rm:${entry.senderId}`}
                      online={online}
                      showRemoveButton={showRemove}
                      onToggleReveal={() =>
                        setRevealedId((cur) => (cur === entry.senderId ? null : entry.senderId))
                      }
                      onRemove={() => void handleRemove(entry.senderId)}
                    />
                  );
                })}
              </Group>
            )}
            {filtered.length > 0 && (
              <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
                Tap or swipe left on a person to remove them from this channel's allowlist.
              </T>
            )}
          </View>
        </>
      )}

      {!conn && pairings.length === 0 && (
        <EmptyState
          title="No pending requests"
          text="When someone messages a channel using Pairing mode, they will show up here."
        />
      )}

      {/* Manual add sender modal */}
      <Modal
        visible={addOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAddOpen(false)}
      >
        <Sheet
          title="Allow sender"
          action="Add"
          actionDisabled={!senderIdDraft.trim()}
          actionLoading={busyKey === "add"}
          onAction={() => void handleAddSender()}
          onClose={() => setAddOpen(false)}
        >
          <Field
            label="Sender ID"
            placeholder="U0123456, 8812034, or +15551234567"
            hint="The platform user ID or phone handle for this channel."
            value={senderIdDraft}
            onChangeText={setSenderIdDraft}
            autoCapitalize="none"
            autoCorrect={false}
            mono
            autoFocus
          />
          <Field
            label="Display name (optional)"
            placeholder="Alex Rivera"
            value={displayDraft}
            onChangeText={setDisplayDraft}
          />
        </Sheet>
      </Modal>
    </Page>
  );
}
