import { type ReactNode, useState } from "react";
import { Alert, Modal, Platform, Pressable, View } from "react-native";
import { Button } from "./Button";
import { Field } from "./Field";
import { T } from "./Text";
import { lift, radius, space, useTheme } from "./theme";

export type TextPromptOptions = {
  title: string;
  message?: string;
  /** What the field holds when the prompt opens. */
  value?: string;
  /** The button that sends the text. Defaults to "Save". */
  confirm?: string;
  max?: number;
  /** Called with the trimmed text, and only when there is some. */
  onSubmit: (text: string) => void;
};

/**
 * Asks for a line of text on both phones. An iPhone has `Alert.prompt`; Android has nothing like it,
 * so it gets a small dialog of its own. Render `node` once in the screen that calls `ask`.
 */
export function useTextPrompt(): { ask: (options: TextPromptOptions) => void; node: ReactNode } {
  const [shown, setShown] = useState<TextPromptOptions>();
  const ask = (options: TextPromptOptions) => {
    if (Platform.OS !== "ios") return setShown(options);
    Alert.prompt(
      options.title,
      options.message,
      [
        { text: "Cancel", style: "cancel" },
        { text: options.confirm ?? "Save", onPress: (text?: string) => text?.trim() && options.onSubmit(text.trim()) },
      ],
      "plain-text",
      options.value,
    );
  };
  return { ask, node: shown && <PromptDialog options={shown} onClose={() => setShown(undefined)} /> };
}

function PromptDialog({ options, onClose }: { options: TextPromptOptions; onClose: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const [text, setText] = useState(options.value ?? "");
  const ready = text.trim().length > 0;
  const submit = () => {
    if (!ready) return;
    onClose();
    options.onSubmit(text.trim());
  };
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: space.xl }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }} />
        <View accessibilityViewIsModal style={[{ backgroundColor: colors.canvas, borderRadius: radius.xl, padding: space.xl, gap: space.lg }, lift(theme, 2)]}>
          <View style={{ gap: space.xs }}>
            <T variant="headline" accessibilityRole="header">
              {options.title}
            </T>
            {!!options.message && (
              <T variant="subhead" color="muted">
                {options.message}
              </T>
            )}
          </View>
          <Field value={text} onChangeText={setText} maxLength={options.max} autoFocus selectTextOnFocus returnKeyType="done" onSubmitEditing={submit} autoCapitalize="words" />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button title={options.confirm ?? "Save"} disabled={!ready} onPress={submit} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
