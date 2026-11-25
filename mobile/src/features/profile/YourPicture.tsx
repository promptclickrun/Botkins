// "Your picture" ("people-avatars-v1"): the picture people in your chats see beside your messages
// and in an "@" tag. It is kept by the computer this phone uses, for the owner or for a member; each
// person sets only their own (`setMyAvatar`). The photo is cut to a square and made small here
// (avatarImage.ts), so the computer is sent at most 96 KB.
import { Camera, ImageIcon, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { manipulatorModule } from "@/device/native";
import { OWNER, myself } from "@/features/chat/people";
import { PersonBadge } from "@/features/chat/PersonBadge";
import { isAvatar } from "@/features/chat/personLook";
import { imagePickerModule, NEEDS_UPDATE } from "@/features/chat/native";
import { useCapability, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { useProfile } from "@/state/profile";
import { showToast, useApp } from "@/state/store";
import { Group, IconTile, Label, Row, space, T, useTheme } from "@/ui";
import { AvatarError, type Manipulator, makeAvatar } from "./avatarImage";

export const AVATARS = "people-avatars-v1";

export function YourPicture() {
  const { colors } = useTheme();
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
  if (!paired) return null;

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
  const use = async (asset: { uri: string; width: number; height: number }) => {
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
  const choose = async () => {
    const ImagePicker = imagePickerModule();
    if (!ImagePicker) return showToast(NEEDS_UPDATE, "error");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
    if (!result.canceled && result.assets[0]) await use(result.assets[0]);
  };
  const take = async () => {
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
    if (!result.canceled && result.assets[0]) await use(result.assets[0]);
  };
  const run = (work: () => Promise<void>) => () => void work().catch((error: unknown) => showToast(error instanceof Error ? error.message : "Couldn't open that.", "error"));

  return (
    <View>
      <Label>Your picture</Label>
      <Group>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, padding: space.lg }} accessible accessibilityLabel={picture ? "Your picture" : "No picture yet"}>
          <PersonBadge person={{ id: me, name, avatar: picture, emoji: picture ? undefined : emoji }} size={64} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="headline" numberOfLines={1}>
              {name}
            </T>
            <T variant="footnote" color="muted" numberOfLines={3}>
              {capable ? "People in your chats see it beside your messages and when they @mention you." : "Update the app on " + computer + " to choose a picture."}
            </T>
          </View>
        </View>
        {capable && (
          <>
            <Row leading={<IconTile icon={ImageIcon} color={colors.accent} />} title="Choose photo" disabled={busy} onPress={run(choose)} />
            <Row leading={<IconTile icon={Camera} color={colors.ink2} />} title="Take photo" disabled={busy} onPress={run(take)} />
            {!!picture && <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove" tone="danger" disabled={busy} onPress={() => void save(null)} />}
          </>
        )}
      </Group>
    </View>
  );
}
