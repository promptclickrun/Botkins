import type { ComponentProps } from "react";
import { type StyleProp, TextInput, type TextInputProps, View, type ViewStyle } from "react-native";
import { T } from "./Text";
import { radius, space, useTheme } from "./theme";

export type FieldProps = TextInputProps & {
  label?: string;
  /** Shown under the field in place of the hint when something is wrong. */
  error?: string;
  hint?: string;
  /** A taller, multi-line field. */
  area?: boolean;
  mono?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputRef?: ComponentProps<typeof TextInput>["ref"];
};

/** A labeled text field. */
export function Field({ label, error, hint, area, mono, containerStyle, style, inputRef, ...props }: FieldProps) {
  const { colors, dark, type, control } = useTheme();
  return (
    <View style={[{ gap: 6 }, containerStyle]}>
      {!!label && (
        <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
          {label}
        </T>
      )}
      <TextInput
        ref={inputRef}
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        multiline={area}
        textAlignVertical={area ? "top" : "center"}
        maxFontSizeMultiplier={1.3}
        accessibilityLabel={label ?? props.placeholder}
        {...props}
        style={[
          mono ? type.mono : type.callout,
          { color: colors.ink, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: error ? colors.danger : colors.line, paddingHorizontal: space.lg, paddingVertical: Math.max(8, Math.round((control.field - type.callout.lineHeight) / 2)), minHeight: area ? 120 : control.field },
          style,
        ]}
      />
      {!!(error || hint) && (
        <T variant="footnote" color={error ? "danger" : "muted"} style={{ paddingHorizontal: space.xs }}>
          {error || hint}
        </T>
      )}
    </View>
  );
}
