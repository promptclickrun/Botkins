// Lets a person answer with a saved credential instead of typing a secret on the phone. The pick is
// a reference; the computer puts the value in, and it never reaches the phone.
import { router } from "expo-router";
import { KeyRound, Plus, Search, X } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import Animated, { SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CredentialRef } from "@/link/types";
import { usePart } from "@/state/hooks";
import { Field, Group, IconButton, IconTile, lift, radius, Row, space, T, Tap, useTheme } from "@/ui";
import { byName, CredentialMark, credentialLine, useSupported } from "./shared";

export type CredentialPickerProps = {
  /** Called with a reference to the chosen credential. The computer fills the value in. */
  onPick: (ref: CredentialRef, name: string) => void;
  /** The button's words. Defaults to "Use a saved credential". */
  label?: string;
  disabled?: boolean;
};

/** A quiet button that opens the list of saved credentials and reports the one chosen. */
export function CredentialPicker({ onPick, label = "Use a saved credential", disabled }: CredentialPickerProps) {
  const { colors } = useTheme();
  const supported = useSupported();
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  return (
    <>
      <Tap
        onPress={() => setOpen(true)}
        disabled={disabled}
        feel="select"
        accessibilityLabel={label}
        style={{ alignSelf: "flex-start", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.xs }}
      >
        <KeyRound size={15} color={colors.accentText} strokeWidth={2.3} />
        <T variant="subhead" weight="600" color="accentText" numberOfLines={1}>
          {label}
        </T>
      </Tap>
      {open && (
        <PickerSheet
          onClose={() => setOpen(false)}
          onPick={(ref, name) => {
            setOpen(false);
            onPick(ref, name);
          }}
        />
      )}
    </>
  );
}

function PickerSheet({ onClose, onPick }: { onClose: () => void; onPick: (ref: CredentialRef, name: string) => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const credentials = usePart("credentials");
  const [query, setQuery] = useState("");

  const all = [...(credentials ?? [])].sort(byName);
  const text = query.trim().toLowerCase();
  const shown = text ? all.filter((credential) => [credential.name, credential.username, credential.website, credential.reference].some((part) => part?.toLowerCase().includes(text))) : all;
  const searchable = all.length > 8;

  const add = () => {
    onClose();
    router.push({ pathname: "/credentials/[id]", params: { id: "new" } });
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }} />
        <Animated.View
          entering={SlideInDown.springify().damping(22).stiffness(220)}
          accessibilityViewIsModal
          style={[{ maxHeight: "78%", backgroundColor: colors.canvas, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingBottom: insets.bottom + space.md }, lift(theme, 2)]}
        >
          <View style={{ alignItems: "center", paddingTop: space.sm }}>
            <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong }} />
          </View>
          <View style={{ height: 56, flexDirection: "row", alignItems: "center", paddingLeft: space.xl, paddingRight: space.md, gap: space.sm }}>
            <T variant="headline" style={{ flex: 1 }} accessibilityRole="header" numberOfLines={1}>
              Saved credentials
            </T>
            <IconButton icon={X} label="Close" size={44} variant="plain" color={colors.ink2} onPress={onClose} />
          </View>
          <View style={{ flexShrink: 1 }}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.sm, gap: space.md }} showsVerticalScrollIndicator={false}>
              {searchable && (
                <View>
                  <Field placeholder="Search" accessibilityLabel="Search credentials" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" style={{ paddingLeft: 42 }} />
                  <View pointerEvents="none" style={{ position: "absolute", left: space.lg, top: 0, bottom: 0, justifyContent: "center" }}>
                    <Search size={17} color={colors.muted} strokeWidth={2.3} />
                  </View>
                </View>
              )}
              <Group>
                {shown.map((credential) => (
                  <Row key={credential.id} leading={<CredentialMark credential={credential} />} title={credential.name} subtitle={credentialLine(credential)} onPress={() => onPick({ $credential: credential.id }, credential.name)} />
                ))}
                {all.length > 0 && shown.length === 0 && <Row title="Nothing matches" />}
                {all.length === 0 && <Row leading={<IconTile icon={Plus} color={colors.accent} size={36} />} title="Add a credential" tone="accent" onPress={add} />}
              </Group>
            </ScrollView>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A picked credential standing in for a secret field: "•••• name", with a way to clear it. */
export function PickedCredential({ name, onClear, disabled }: { name: string; onClear: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ minHeight: 50, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
      <KeyRound size={15} color={colors.accentText} strokeWidth={2.3} />
      <T variant="callout" style={{ flex: 1 }} numberOfLines={1} accessibilityLabel={"Uses the saved credential " + name}>
        {"•••• " + name}
      </T>
      <IconButton icon={X} label={"Stop using " + name} size={44} color={colors.muted} onPress={onClear} disabled={disabled} />
    </View>
  );
}
