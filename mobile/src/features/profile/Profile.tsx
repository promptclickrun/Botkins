import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import { Check, Copy, ExternalLink, KeyRound, Link2, LogOut, Monitor, Pencil, ShieldCheck, Smartphone, UserRound, UserX } from "lucide-react-native";
import { Alert, View } from "react-native";
import { useEffect } from "react";
import type { ProfileHost } from "@/link/profile";
import { deviceName } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { useProfile, approveDevice, beginProfile, deleteProfileAccount, dismissPrompt, finishPending, profileDeviceLabel, refreshProfile, removeProfileHost, restartProfileAttempt, revokeDevice, selectProfileHost, signOutProfile, syncLocalPairings, updateProfile } from "@/state/profile";
import { pendingDeviceLabel, profileCode, profileCodeLabel, profileHostIsLocal, profileHostSubtitle, PROFILE_BROWSER_COPY, PROFILE_MIGRATION_COPY, PROFILE_OPTIONAL_COPY } from "./profileLogic";
import { Badge, Button, EmptyState, Group, IconTile, Label, Loading, Page, Row, space, T, useTextPrompt, useTheme } from "@/ui";

function close() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

export default function Profile() {
  const params = useLocalSearchParams<{ prompt?: string }>();
  const { colors } = useTheme();
  const prompt = useProfile((state) => state.prompt);
  const session = useProfile((state) => state.session);
  const attempt = useProfile((state) => state.attempt);
  const home = useProfile((state) => state.home);
  const profilePairings = useProfile((state) => state.pairings);
  const boundLocal = useProfile((state) => state.boundLocal);
  const pendingRemovals = useProfile((state) => state.pendingRemovals);
  const pairings = useApp((state) => state.pairings);
  const busy = useProfile((state) => state.busy);
  const error = useProfile((state) => state.error);
  const promptInput = useTextPrompt();

  useEffect(() => {
    if (session) void refreshProfile();
  }, [session?.token]);

  const first = params.prompt === "first" || prompt === "first";
  const migration = params.prompt === "migration" || prompt === "migration";
  const start = async () => {
    await beginProfile(profileDeviceLabel());
  };
  const browser = attempt
    ? async () => {
        await WebBrowser.openBrowserAsync(attempt.url).catch(() => {});
        void finishPending();
      }
    : start;
  const noThanks = () => {
    void dismissPrompt();
    close();
  };
  const refreshAll = () => void syncLocalPairings();

  if (!session) {
    return (
      <Page quietLink title={migration ? "Use a Botkins profile" : first ? "Set up your Botkins profile" : "Botkins profile"}>
        <View style={{ alignItems: "center", gap: space.md, paddingTop: space.lg }}>
          <IconTile icon={KeyRound} color={colors.accent} size={56} />
          <T variant="title2" center accessibilityRole="header">
            {migration ? "Bring your Botkins identity with you" : "Use your Botkins identity across devices"}
          </T>
          <T variant="callout" color="muted" center>
            {migration ? PROFILE_MIGRATION_COPY : PROFILE_OPTIONAL_COPY}
          </T>
        </View>

        {attempt ? (
          <Group>
            <View style={{ padding: space.lg, gap: space.sm }}>
              <T variant="headline">Verify in your browser</T>
              <T variant="subhead" color="muted">{PROFILE_BROWSER_COPY}</T>
              <T variant="display" center selectable accessibilityLabel={profileCodeLabel(attempt.code)} style={{ letterSpacing: 6, fontVariant: ["tabular-nums"], paddingVertical: space.md }}>
                {profileCode(attempt.code)}
              </T>
              <T variant="footnote" color="muted" center>
                This code matches the request in the browser.
              </T>
            </View>
            <Row leading={<IconTile icon={ExternalLink} color={colors.accent} />} title="Open profile.botkins.app" subtitle="Your passkey and email stay in the system browser" chevron disabled={busy} onPress={() => void browser()} />
            <Row leading={<IconTile icon={Copy} color={colors.ink2} />} title="Copy" chevron disabled={busy} onPress={() => void Clipboard.setStringAsync(attempt.code).then(() => showToast("Code copied", "success"))} />
            <Row leading={<IconTile icon={Check} color={colors.success} />} title="Finish" subtitle="Return here once you finish in the browser" chevron disabled={busy} onPress={() => void finishPending()} />
            <Row leading={<IconTile icon={KeyRound} color={colors.ink2} />} title="Start over" subtitle="Use this if the browser request expired" chevron disabled={busy} onPress={() => void restartProfileAttempt()} />
          </Group>
        ) : (
          <Group>
            <Row leading={<IconTile icon={ShieldCheck} color={colors.success} />} title="Set up a profile" subtitle="Create one or sign in, with a passkey" chevron disabled={busy} onPress={() => void browser()} />
            <Row leading={<IconTile icon={Monitor} color={colors.ink2} />} title="Continue without a profile" subtitle="Your local pairings stay here and are not changed" chevron onPress={noThanks} />
          </Group>
        )}
        {!!error && <T variant="footnote" color="danger">{error}</T>}
        {!!attempt && <Button title="Continue without a profile" variant="ghost" wide onPress={noThanks} />}
      </Page>
    );
  }

  const avatar = (home?.profile as { avatar?: string } | undefined)?.avatar;
  return (
    <Page quietLink
      title="Botkins profile"
      actions={<Button title="Refresh" variant="ghost" size="sm" disabled={busy} onPress={refreshAll} />}
    >
      {promptInput.node}
      <Group>
        <Row leading={<IconTile icon={UserRound} color={colors.accent} />} title={(avatar ? avatar + " " : "") + (home?.profile.name || session.name)} subtitle={home?.profile.email || session.email} trailing={<Pencil size={17} color={colors.faint} />} chevron disabled={busy} onPress={() => promptInput.ask({ title: "Profile name", value: home?.profile.name || session.name, confirm: "Save", max: 60, onSubmit: (name) => void updateProfile(name) })} />
        <Row leading={<IconTile icon={Smartphone} color={colors.ink2} />} title="This device" value={profileDeviceLabel()} />
      </Group>

      {!!error && <T variant="footnote" color="danger">{error}</T>}
      {!home ? <Loading label="Loading profile" /> : <>
        <View>
          <Label>Profile hosts</Label>
          {home.hosts.length === 0 ? (
            <EmptyState icon={Link2} title="No profile hosts yet" text="Connect a computer or enroll one from its profile host list." action="Connect a computer" onAction={() => router.push("/pair/scan")} />
          ) : (
            <View style={{ gap: space.sm }}>
              {home.hosts.map((host) => <HostRow key={host.serverId} host={host} busy={busy} local={profileHostIsLocal(host, pairings)} enrolled={!!profilePairings[host.serverId] || boundLocal.includes(host.serverId)} pending={pendingRemovals.includes(host.serverId)} />)}
            </View>
          )}
        </View>

        <View>
          <Label>Trusted devices</Label>
          <Group>
            {home.devices.map((device) => (
              <Row key={device.id} leading={<IconTile icon={device.current ? Check : Smartphone} color={device.current ? colors.success : colors.ink2} />} title={device.label || "Device"} subtitle={device.current ? "This device" : undefined} trailing={device.current ? <Badge label="Current" tone="accent" /> : undefined} />
            ))}
            {home.devices.filter((device) => !device.current).map((device) => <Row key={"revoke:" + device.id} leading={<IconTile icon={UserX} color={colors.danger} />} title={"Revoke " + (device.label || "device")} tone="danger" disabled={busy} onPress={() => Alert.alert("Revoke trusted device?", "It will need approval before it can use this profile again.", [{ text: "Cancel", style: "cancel" }, { text: "Revoke", style: "destructive", onPress: () => void revokeDevice(device.id) }])} />)}
          </Group>
        </View>

        {home.pending.length > 0 && <View>
          <Label>Pending approvals</Label>
          <Group>
            {home.pending.map((pending) => (
              <Row key={pending.id} leading={<IconTile icon={Smartphone} color={colors.warning} />} title={pendingDeviceLabel(pending.label)} subtitle={"Code " + profileCode(pending.code)} chevron disabled={busy} onPress={() => promptInput.ask({ title: "Approve device", message: "Enter the code shown on that device.", confirm: "Approve", max: 6, onSubmit: (code) => void approveDevice(pending.id, code) })} />
            ))}
          </Group>
        </View>}
      </>}

      <Group>
        <Row leading={<IconTile icon={LogOut} color={colors.danger} />} title="Sign out of profile" subtitle="Unrelated local-only pairings stay on this phone" tone="danger" disabled={busy} onPress={() => Alert.alert("Sign out of profile?", "Profile-enrolled host access and protected profile data will be removed. Unrelated local-only pairings stay; migrated profile-bound keys are removed.", [{ text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => void signOutProfile().then((result) => { close(); if (result.offline) Alert.alert("Signed out on this phone", "The profile service was unreachable, so this device could not be revoked there. Connect to the internet and sign in again to check trusted devices."); }) }])} />
        <Row leading={<IconTile icon={UserX} color={colors.danger} />} title="Delete profile account" subtitle="Permanently delete your profile and its trusted-device access" tone="danger" disabled={busy} onPress={() => Alert.alert("Delete Botkins profile?", "This permanently deletes the profile, its host directory and trusted devices. Local-only pairings and workspaces stay on this phone.", [{ text: "Cancel", style: "cancel" }, { text: "Continue", style: "destructive", onPress: () => promptInput.ask({ title: "Confirm profile deletion", message: "Type your verified email: " + session.email, confirm: "Delete permanently", max: 254, onSubmit: (email) => void deleteProfileAccount(email).then((deleted) => deleted && close()) }) }])} />
      </Group>
    </Page>
  );
}

function HostRow({ host, busy, local, enrolled, pending }: { host: ProfileHost; busy: boolean; local: boolean; enrolled: boolean; pending: boolean }) {
  const { colors } = useTheme();
  const selectable = local || host.hosts.length > 0;
  const choose = async () => {
    const pairing = await selectProfileHost(host);
    if (pairing) router.dismissTo("/");
  };
  const confirmRemove = () => Alert.alert("Remove profile host?", "This revokes profile access on the host. A migrated local pairing may be removed with it; unrelated local-only pairings stay on this phone.", [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => void removeProfileHost(host.serverId) }]);
  return (
    <Group>
      <Row leading={<IconTile icon={host.member ? UserRound : Monitor} color={host.member ? colors.accent : colors.info} />} title={host.name || "Computer"} subtitle={pending ? "Removal will retry when this phone is online" : profileHostSubtitle(host, local, enrolled)} trailing={enrolled ? <Badge label="Enrolled" tone="accent" /> : undefined} chevron={selectable} disabled={busy || !selectable} onPress={() => void choose()} />
      <Row title="Remove from profile" tone="danger" disabled={busy} onPress={confirmRemove} />
    </Group>
  );
}
