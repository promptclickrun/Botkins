import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { MenuView } from "@react-native-menu/menu";
import { Camera, Check, Copy, Ellipsis, ExternalLink, KeyRound, LogOut, Monitor, ShieldCheck } from "lucide-react-native";
import { Alert, Text, View } from "react-native";
import { useEffect, useMemo, useState } from "react";
import { usePrefs } from "@/state/prefs";
import { showToast } from "@/state/store";
import {
  beginProfile,
  deleteProfileAccount,
  dismissPrompt,
  finishPending,
  profileDeviceLabel,
  refreshProfile,
  restartProfileAttempt,
  signOutProfile,
  syncLocalPairings,
  updateProfile,
  useProfile,
} from "@/state/profile";
import { PhotoActionSheet, useYourPicture, YourPicture } from "./YourPicture";
import {
  CONFIRM_COPY,
  pendingBannerCopy,
  profileCode,
  profileCodeLabel,
  profileIndexSummary,
  profileInitials,
  profilePrompt,
  PROFILE_BROWSER_COPY,
  PROFILE_INDEX_FOOTNOTE,
  PROFILE_MIGRATION_COPY,
  PROFILE_OPTIONAL_COPY,
  requestDeleteProfile,
  requestSignOutProfile,
} from "./profileLogic";
import { Button, Glass, Group, IconButton, IconTile, Label, Loading, Page, radius, Row, space, T, Tap, tint, useTextPrompt, useTheme } from "@/ui";

function close() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

export default function Profile() {
  const params = useLocalSearchParams<{ prompt?: string }>();
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const prompt = useProfile((state) => state.prompt);
  const session = useProfile((state) => state.session);
  const attempt = useProfile((state) => state.attempt);
  const home = useProfile((state) => state.home);
  const profilePairings = useProfile((state) => state.pairings);
  const boundLocal = useProfile((state) => state.boundLocal);
  const busy = useProfile((state) => state.busy);
  const error = useProfile((state) => state.error);
  const promptInput = useTextPrompt();
  const pictureState = useYourPicture();
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);

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

  const enrolledIds = useMemo(() => {
    const ids = new Set<string>(Object.keys(profilePairings));
    for (const id of boundLocal) ids.add(id);
    return ids;
  }, [profilePairings, boundLocal]);

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
        {/* A picture is kept by the computer, so it needs no Botkins profile. */}
        <YourPicture />
      </Page>
    );
  }

  const displayName = home?.profile.name || session.name;
  const email = home?.profile.email || session.email;
  const emoji = (home?.profile as { avatar?: string } | undefined)?.avatar;
  const summary = home
    ? profileIndexSummary({
        hosts: home.hosts,
        devices: home.devices,
        enrolledServerIds: enrolledIds,
        currentDeviceLabel: profileDeviceLabel(),
      })
    : null;
  const banner = home ? pendingBannerCopy(home.pending) : null;

  const openEditName = () => {
    promptInput.ask({
      title: "Profile name",
      value: displayName,
      confirm: "Save",
      max: 60,
      onSubmit: (name) => void updateProfile(name),
    });
  };

  const confirmSignOut = () => {
    requestSignOutProfile(Alert.alert, () => {
      void signOutProfile().then((result) => {
        close();
        if (result.offline) {
          Alert.alert(CONFIRM_COPY.signOutOffline.title, CONFIRM_COPY.signOutOffline.message);
        }
      });
    });
  };

  const confirmDelete = () => {
    requestDeleteProfile(
      email,
      Alert.alert,
      (options) => promptInput.ask(options),
      (typedEmail) => void deleteProfileAccount(typedEmail).then((deleted) => deleted && close()),
    );
  };

  const handleMoreAction = (action: string) => {
    if (action === "refresh") refreshAll();
    else if (action === "delete") confirmDelete();
  };

  return (
    <Page quietLink onRefresh={refreshAll} refreshing={busy}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <MenuView
              title="Profile options"
              actions={[
                { id: "refresh", title: "Refresh" },
                {
                  id: "email",
                  title: "Email",
                  subtitle: email,
                  attributes: { disabled: true },
                },
                {
                  id: "delete",
                  title: "Delete profile…",
                  attributes: { destructive: true },
                },
              ]}
              onPressAction={({ nativeEvent }) => handleMoreAction(nativeEvent.event)}
            >
              <IconButton
                icon={Ellipsis}
                label="More profile options"
                variant={hasBackdrop ? "glass" : "soft"}
              />
            </MenuView>
          ),
        }}
      />

      {promptInput.node}
      <PhotoActionSheet visible={photoSheetOpen} onClose={() => setPhotoSheetOpen(false)} state={pictureState} />

      {/* Identity hero */}
      <View style={{ alignItems: "center", paddingTop: space.xs, gap: space.xs }}>
        <Tap
          onPress={() => setPhotoSheetOpen(true)}
          disabled={busy || pictureState.busy}
          feel="select"
          sink={0.96}
          accessibilityLabel={pictureState.picture ? "Change your photo" : "Add a photo"}
          style={{ position: "relative" }}
        >
          <View
            style={{
              width: 92,
              height: 92,
              borderRadius: 46,
              backgroundColor: colors.accentSoft,
              borderWidth: 1,
              borderColor: tint(colors.accent, 0.25),
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {pictureState.picture ? (
              <Image
                source={{ uri: pictureState.picture }}
                style={{ width: 92, height: 92, borderRadius: 46 }}
                contentFit="cover"
                accessibilityIgnoresInvertColors
              />
            ) : (
              <Text
                allowFontScaling={false}
                style={{
                  fontSize: emoji ? 42 : 34,
                  fontWeight: "700",
                  color: colors.accentText,
                }}
              >
                {emoji || profileInitials(displayName)}
              </Text>
            )}
          </View>
          <View
            style={{
              position: "absolute",
              right: -2,
              bottom: -2,
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: colors.surface,
              borderWidth: 2.5,
              borderColor: hasBackdrop ? colors.surface : colors.canvas,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Camera size={15} color={colors.accentText} strokeWidth={2.2} />
          </View>
        </Tap>

        <T variant="title2" center accessibilityRole="header" style={{ marginTop: space.sm }}>
          {displayName}
        </T>
        <T variant="subhead" color="muted" center>
          Signed in with a passkey
        </T>
        <Tap
          onPress={openEditName}
          disabled={busy}
          feel="select"
          accessibilityLabel="Edit name"
          style={{ paddingVertical: space.xs, paddingHorizontal: space.md }}
        >
          <T variant="subhead" weight="600" color="accentText">
            Edit name
          </T>
        </Tap>
      </View>

      {/* Pending approvals banner — only when home.pending is non-empty */}
      {banner && (
        hasBackdrop ? (
          <Glass
            tintColor={tint(colors.warningSoft, dark ? 0.45 : 0.72)}
            style={{ borderRadius: radius.lg, overflow: "hidden" }}
          >
            <PendingBannerBody
              title={banner.title}
              subtitle={banner.subtitle}
              onReview={() => router.push("/profile/devices")}
            />
          </Glass>
        ) : (
          <View style={{ backgroundColor: colors.warningSoft, borderRadius: radius.lg, overflow: "hidden" }}>
            <PendingBannerBody
              title={banner.title}
              subtitle={banner.subtitle}
              onReview={() => router.push("/profile/devices")}
            />
          </View>
        )
      )}

      {!!error && <T variant="footnote" color="danger">{error}</T>}

      {!home ? (
        <Loading label="Loading profile" />
      ) : (
        <View>
          <Label>Your profile</Label>
          <Group inset={space.lg + 32 + space.md}>
            <Row
              leading={<IconTile icon={Monitor} color={colors.accent} />}
              title="Computers"
              subtitle={summary?.computersSubtitle}
              value={String(summary?.computersCount ?? 0)}
              chevron
              onPress={() => router.push("/profile/computers")}
            />
            <Row
              leading={<IconTile icon={ShieldCheck} color={colors.success} />}
              title="Trusted devices"
              subtitle={summary?.devicesSubtitle}
              value={String(summary?.devicesCount ?? 0)}
              chevron
              onPress={() => router.push("/profile/devices")}
            />
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
            {PROFILE_INDEX_FOOTNOTE}
          </T>
        </View>
      )}

      {/* Bottom group: Sign out */}
      <Group>
        <Row
          leading={<IconTile icon={LogOut} color={colors.danger} />}
          title="Sign out"
          subtitle="Local pairings stay on this phone"
          tone="danger"
          disabled={busy}
          onPress={confirmSignOut}
        />
      </Group>
    </Page>
  );
}

function PendingBannerBody({
  title,
  subtitle,
  onReview,
}: {
  title: string;
  subtitle: string;
  onReview: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" weight="600" color="warning" numberOfLines={1}>
          {title}
        </T>
        <T variant="footnote" color="ink2" numberOfLines={1}>
          {subtitle}
        </T>
      </View>
      <Tap
        onPress={onReview}
        feel="select"
        accessibilityLabel="Review pending device"
        style={{
          backgroundColor: colors.warning,
          paddingHorizontal: space.md,
          paddingVertical: space.xs + 2,
          borderRadius: radius.pill,
        }}
      >
        <T variant="footnote" weight="600" color={colors.onPrimary}>
          Review
        </T>
      </Tap>
    </View>
  );
}

export { profilePrompt };
