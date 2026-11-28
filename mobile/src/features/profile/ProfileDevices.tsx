// Profile › Devices: "Waiting for you" (pending approvals) + "Trusted" (current device first,
// labelled "This device"). Swipe or long press on any non-current device reveals Revoke, which
// always opens the confirmation Alert before any API call. Current device cannot be revoked.
import { Monitor, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { approveDevice, refreshProfile, revokeDevice, useProfile } from "@/state/profile";
import { Badge, EmptyState, Group, IconTile, Label, Loading, Page, Row, space, T, useTextPrompt, useTheme } from "@/ui";
import { orderTrustedDevices, pendingDeviceLabel, profileCodeDisplay, requestRevokeDevice } from "./profileLogic";
import { SwipeActionRow } from "./SwipeActionRow";

function deviceIcon(label: string) {
  return /mac|pc|desktop|laptop|studio|mini|linux|windows|server|vps/i.test(label) ? Monitor : Smartphone;
}

export default function ProfileDevices() {
  const { colors } = useTheme();
  const home = useProfile((state) => state.home);
  const busy = useProfile((state) => state.busy);
  const error = useProfile((state) => state.error);
  const promptInput = useTextPrompt();
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const pending = home?.pending ?? [];
  const trusted = home ? orderTrustedDevices(home.devices) : [];

  const confirmRevoke = (device: { id: string; current: boolean }) => {
    requestRevokeDevice(device, Alert.alert, (id) => void revokeDevice(id));
  };

  return (
    <Page quietLink title="Devices" caption="Can use your profile" onRefresh={() => void refreshProfile()} refreshing={busy}>
      {promptInput.node}

      {!!error && <T variant="footnote" color="danger">{error}</T>}

      {!home ? (
        <Loading label="Loading devices" />
      ) : pending.length === 0 && trusted.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title="No trusted devices yet"
          text="Devices signed in to your Botkins profile will appear here."
        />
      ) : (
        <>
          {pending.length > 0 && (
            <View>
              <Label>Waiting for you</Label>
              <Group inset={space.lg + 32 + space.md}>
                {pending.map((item) => (
                  <Row
                    key={item.id}
                    leading={<IconTile icon={deviceIcon(item.label)} color={colors.warning} />}
                    title={pendingDeviceLabel(item.label)}
                    subtitle={"Code " + profileCodeDisplay(item.code)}
                    trailing={<Badge label="Approve" tone="warning" />}
                    disabled={busy}
                    onPress={() =>
                      promptInput.ask({
                        title: "Approve device",
                        message: "Enter the code shown on that device.",
                        confirm: "Approve",
                        max: 6,
                        onSubmit: (code) => void approveDevice(item.id, code),
                      })
                    }
                  />
                ))}
              </Group>
            </View>
          )}

          <View>
            <Label>Trusted</Label>
            <Group inset={space.lg + 32 + space.md}>
              {trusted.map((device) => {
                const label = device.label || "Device";
                const icon = deviceIcon(label);
                if (device.current) {
                  return (
                    <Row
                      key={device.id}
                      leading={<IconTile icon={icon} color={colors.success} />}
                      title={label}
                      subtitle="This device"
                    />
                  );
                }
                return (
                  <SwipeActionRow
                    key={device.id}
                    actionLabel="Revoke"
                    actionId="revoke"
                    menuTitle={label}
                    disabled={busy}
                    revealed={revealedId === device.id}
                    onRevealChange={(next) => setRevealedId(next ? device.id : null)}
                    onAction={() => confirmRevoke(device)}
                  >
                    <Row
                      leading={<IconTile icon={icon} color={colors.ink2} />}
                      title={label}
                      subtitle="Trusted device"
                    />
                  </SwipeActionRow>
                );
              })}
            </Group>
            {trusted.some((d) => !d.current) && (
              <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
                Swipe or long press a device to revoke it.
              </T>
            )}
          </View>
        </>
      )}
    </Page>
  );
}
