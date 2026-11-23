import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, TextInput, View, type ViewProps } from "react-native";
import { Button, space, T, useTheme } from "@/ui";

const EmojiField = Platform.OS === "ios" && requireOptionalNativeModule("BotkinsEmoji")
  ? requireNativeView<ViewProps & { onChange: (event: { nativeEvent: { text: string } }) => void }>("BotkinsEmoji")
  : null;

export function ReactionPicker({ close, submit }: { close: () => void; submit: (emoji: string) => void }) {
  const [emoji, setEmoji] = useState("");
  const { colors } = useTheme();
  return (
    <Modal transparent visible onRequestClose={close} animationType="fade">
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.scrim, padding: space.xl, justifyContent: "center" }}>
        <View accessibilityViewIsModal style={{ padding: space.lg, gap: space.md, borderRadius: 16, backgroundColor: colors.canvas }}>
          <T variant="headline">React to message</T>
          <T variant="subhead" color="muted">Choose one emoji from your keyboard.</T>
          {EmojiField ? <EmojiField style={{ height: 48 }} onChange={({ nativeEvent }) => setEmoji(nativeEvent.text)} />
            : <TextInput accessibilityLabel="Reaction emoji" autoFocus value={emoji} onChangeText={setEmoji} maxLength={64}
                autoCorrect={false} style={{ fontSize: 24, color: colors.ink, textAlign: "center" }} />}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
            <Button title="Cancel" variant="secondary" onPress={close} />
            <Button title="React" disabled={!emoji} onPress={() => submit(emoji)} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
