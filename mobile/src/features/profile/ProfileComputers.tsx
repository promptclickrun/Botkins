// Profile › Computers: one row per profile host with a compact status Badge.
// Swipe or long press reveals Remove, which always opens the confirmation Alert before any API call.
import { router, Stack } from "expo-router";
import { Link2, Monitor, Plus, UserRound } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { ProfileHost } from "@/link/profile";
import { usePrefs } from "@/state/prefs";
import { removeProfileHost, selectProfileHost, syncLocalPairings, useProfile } from "@/state/profile";
import { useApp } from "@/state/store";
import { Badge, EmptyState, Group, IconButton, IconTile, Loading, Page, Row, space, T, useTheme } from "@/ui";
import { profileHostIsLocal, profileHostStatus, requestRemoveProfileHost } from "./profileLogic";
import { SwipeActionRow } from "./SwipeActionRow";

export default function ProfileComputers() {
  const { colors } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const home = useProfile((state) => state.home);
  const profilePairings = useProfile((state) => state.pairings);
  const boundLocal = useProfile((state) => state.boundLocal);
  const pendingRemovals = useProfile((state) => state.pendingRemovals);
  const busy = useProfile((state) => state.busy);
  const error = useProfile((state) => state.error);
  const pairings = useApp((state) => state.pairings);
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const hosts = home?.hosts ?? [];
  const caption = home
    ? hosts.length === 1
      ? "1 in your profile"
      : `${hosts.length} in your profile`
    : undefined;

  const choose = async (host: ProfileHost) => {
    setRevealedId(null);
    const pairing = await selectProfileHost(host);
    if (pairing) router.dismissTo("/");
  };

  const confirmRemove = (serverId: string) => {
    requestRemoveProfileHost(serverId, Alert.alert, (id) => void removeProfileHost(id));
  };

  return (
    <Page quietLink title="Computers" caption={caption} onRefresh={() => void syncLocalPairings()} refreshing={busy}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={Plus}
              label="Connect a computer"
              variant={hasBackdrop ? "glass" : "soft"}
              onPress={() => router.push("/pair/scan")}
            />
          ),
        }}
      />

      {!!error && <T variant="footnote" color="danger">{error}</T>}

      {!home ? (
        <Loading label="Loading computers" />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No profile hosts yet"
          text="Connect a computer or enroll one from its profile host list."
          action="Connect a computer"
          onAction={() => router.push("/pair/scan")}
        />
      ) : (
        <View>
          <Group inset={space.lg + 32 + space.md}>
            {hosts.map((host) => {
              const local = profileHostIsLocal(host, pairings);
              const enrolled = !!profilePairings[host.serverId] || boundLocal.includes(host.serverId);
              const pendingRemoval = pendingRemovals.includes(host.serverId);
              const status = profileHostStatus(host, { local, enrolled, pendingRemoval });
              const tileColor = host.member
                ? colors.accent
                : status.kind === "offline" || status.kind === "removing"
                  ? colors.muted
                  : colors.info;
              return (
                <SwipeActionRow
                  key={host.serverId}
                  actionLabel="Remove"
                  actionId="remove"
                  menuTitle={host.name || "Computer"}
                  disabled={busy}
                  revealed={revealedId === host.serverId}
                  onRevealChange={(next) => setRevealedId(next ? host.serverId : null)}
                  onAction={() => confirmRemove(host.serverId)}
                >
                  <Row
                    leading={<IconTile icon={host.member ? UserRound : Monitor} color={tileColor} />}
                    title={host.name || "Computer"}
                    subtitle={status.subtitle}
                    trailing={<Badge label={status.label} tone={status.tone} />}
                    disabled={busy || !status.selectable}
                    onPress={status.selectable ? () => void choose(host) : undefined}
                  />
                </SwipeActionRow>
              );
            })}
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
            Swipe or long press a computer to remove it from your profile.
          </T>
        </View>
      )}
    </Page>
  );
}
