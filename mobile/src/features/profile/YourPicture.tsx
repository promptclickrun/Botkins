// "Your picture" ("people-avatars-v1"): the picture people in your chats see beside your messages
// and in an "@" tag. It is kept by the computer this phone uses, for the owner or for a member; each
// person sets only their own (`setMyAvatar`). The photo is cut to a square and made small here
// (avatarImage.ts), so the computer is sent at most 96 KB.
import { Camera, ImageIcon, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, Linking, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { manipulatorModule } from "@/device/native";
import { OWNER, myself } from "@/features/chat/people";
import { PersonBadge } from "@/features/chat/PersonBadge";
import { isAvatar } from "@/features/chat/personLook";
import { imagePickerModule, NEEDS_UPDATE } from "@/features/chat/native";
import { useCapability, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useProfile } from "@/state/profile";
import { showToast, useApp } from "@/state/store";
import { Glass, Group, IconTile, Label, radius, Row, space, T, tint, useTheme } from "@/ui";
import { AvatarError, type Manipulator, makeAvatar } from "./avatarImage";
import { requestRemovePhoto } from "./profileLogic";

export const AVATARS = "people-avatars-v1";

export type YourPictureState = {
  paired: boolean;
  capable: boolean;
  computer: string;
  me: string;
  name: string;
  picture: string | undefined;
  emoji: string | undefined;
  busy: boolean;
  choose: () => void;
  take: () => void;
  removeWithConfirm: () => void;
};

/** Shared state & actions for choosing, taking, and removing the person's picture. */
export function useYourPicture(): YourPictureState {
  const paired = useApp((state) => !!state.pairing);
  const computer = useApp((state) => state.pairing?.name) ?? "your computer";
  const capable = useCapability(AVATARS);
  const meta = usePart("meta");
  const people = usePart("team")?.people;
  const me = myself(meta);
  const emoji = useProfile((state) => (me === OWNER ? state.home?.profile.avatar : undefined));
  const sent = people?.find((person) => person.id === me);
  const name = sent?.name || (meta?.you?.kind === "member" ? meta.you.name : "") || "You";
  const fromComputer = sent?.avatar ?? meta?.you?.avatar;
  // What this phone just set, until the computer's next list says the same.
  const [chosen, setChosen] = useState<{ value: string | null; from: string | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = chosen && chosen.from === fromComputer ? chosen.value : (fromComputer ?? null);
  const picture = isAvatar(current) ? current : undefined;

  const save = async (image: string | null) => {
    setBusy(true);
    try {
      const answer = await api.setMyAvatar(image);
      setChosen({ value: answer?.avatar ?? null, from: fromComputer });
      showToast(image ? "Picture saved" : "Picture removed", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The picture couldn't be saved.", "error");
    } finally {
      setBusy(false);
    }
  };

  const applyAsset = async (asset: { uri: string; width: number; height: number }) => {
    const manipulator = manipulatorModule();
    if (!manipulator) return showToast(NEEDS_UPDATE, "error");
    setBusy(true);
    let image: string;
    try {
      image = await makeAvatar(manipulator as unknown as Manipulator, asset.uri, asset.width, asset.height);
    } catch (error) {
      setBusy(false);
      return showToast(error instanceof AvatarError ? error.message : "That photo couldn't be read.", "error");
    }
    await save(image);
  };

  const chooseWork = async () => {
    const ImagePicker = imagePickerModule();
    if (!ImagePicker) return showToast(NEEDS_UPDATE, "error");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
    if (!result.canceled && result.assets[0]) await applyAsset(result.assets[0]);
  };

  const takeWork = async () => {
    const ImagePicker = imagePickerModule();
    if (!ImagePicker) return showToast(NEEDS_UPDATE, "error");
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera access is off", "Turn it on in Settings to take a photo here.", [
        { text: "Not now", style: "cancel" },
        { text: "Settings", onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1, cameraType: ImagePicker.CameraType.front });
    if (!result.canceled && result.assets[0]) await applyAsset(result.assets[0]);
  };

  const run = (work: () => Promise<void>) => () =>
    void work().catch((error: unknown) => showToast(error instanceof Error ? error.message : "Couldn't open that.", "error"));

  const removeWithConfirm = () => {
    requestRemovePhoto(Alert.alert, () => void save(null));
  };

  return {
    paired,
    capable,
    computer,
    me,
    name,
    picture,
    emoji,
    busy,
    choose: run(chooseWork),
    take: run(takeWork),
    removeWithConfirm,
  };
}

/**
 * Bottom action sheet shown when tapping the Profile hero avatar:
 * Choose photo, Take photo, and Remove photo (only when a picture exists, always confirming first).
 */
export function PhotoActionSheet({
  visible,
  onClose,
  state,
}: {
  visible: boolean;
  onClose: () => void;
  state: YourPictureState;
}) {
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  const choose = () => {
    onClose();
    state.choose();
  };
  const take = () => {
    onClose();
    state.take();
  };
  const remove = () => {
    onClose();
    state.removeWithConfirm();
  };

  const sheetContent = (
    <View style={{ paddingVertical: space.xs }}>
      {!state.paired || !state.capable ? (
        <View style={{ padding: space.lg, gap: space.xs }}>
          <T variant="headline">Your picture</T>
          <T variant="footnote" color="muted">
            {!state.paired
              ? "Pair a computer first to set a picture that people in your chats see."
              : "Update the app on " + state.computer + " to choose a picture."}
          </T>
        </View>
      ) : (
        <>
          <Row
            leading={<IconTile icon={ImageIcon} color={colors.accent} />}
            title="Choose photo"
            disabled={state.busy}
            onPress={choose}
          />
          <Row
            leading={<IconTile icon={Camera} color={colors.ink2} />}
            title="Take photo"
            disabled={state.busy}
            onPress={take}
          />
          {!!state.picture && (
            <Row
              leading={<IconTile icon={Trash2} color={colors.danger} />}
              title="Remove photo"
              tone="danger"
              disabled={state.busy}
              onPress={remove}
            />
          )}
        </>
      )}
    </View>
  );

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", paddingHorizontal: space.sm, paddingBottom: Math.max(insets.bottom, space.sm) }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss photo menu"
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }}
        />
        {hasBackdrop ? (
          <Glass
            tintColor={tint(colors.surface, dark ? 0.55 : 0.72)}
            style={{ borderRadius: radius.lg, overflow: "hidden" }}
          >
            {sheetContent}
          </Glass>
        ) : (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, overflow: "hidden" }}>
            {sheetContent}
          </View>
        )}
      </View>
    </Modal>
  );
}

/** Inline card kept for the unsigned-in / local-only Profile setup flow. */
export function YourPicture() {
  const { colors } = useTheme();
  const state = useYourPicture();
  if (!state.paired) return null;

  return (
    <View>
      <Label>Your picture</Label>
      <Group>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, padding: space.lg }} accessible accessibilityLabel={state.picture ? "Your picture" : "No picture yet"}>
          <PersonBadge person={{ id: state.me, name: state.name, avatar: state.picture, emoji: state.picture ? undefined : state.emoji }} size={64} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="headline" numberOfLines={1}>
              {state.name}
            </T>
            <T variant="footnote" color="muted" numberOfLines={3}>
              {state.capable ? "People in your chats see it beside your messages and when they @mention you." : "Update the app on " + state.computer + " to choose a picture."}
            </T>
          </View>
        </View>
        {state.capable && (
          <>
            <Row leading={<IconTile icon={ImageIcon} color={colors.accent} />} title="Choose photo" disabled={state.busy} onPress={state.choose} />
            <Row leading={<IconTile icon={Camera} color={colors.ink2} />} title="Take photo" disabled={state.busy} onPress={state.take} />
            {!!state.picture && <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove" tone="danger" disabled={state.busy} onPress={state.removeWithConfirm} />}
          </>
        )}
      </Group>
    </View>
  );
}
