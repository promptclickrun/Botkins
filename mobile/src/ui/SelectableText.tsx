// A message as text a person can select part of, with the phone's own handles and its own menu
// (Copy, Look Up, Share…). It is one native text view that can't be edited, holding the message as
// styled runs of plain text (selectable.ts), so what is copied has no Markdown marks in it.
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import { Text, TextInput, type TextStyle } from "react-native";
import { selectableRuns, selectableText, type TextRun } from "./selectable";
import { type Colors, type TypeScale, useTheme } from "./theme";

function styleOf(run: TextRun, colors: Colors, scale: TypeScale): TextStyle | undefined {
  if (!run.bold && !run.italic && !run.code && !run.link && !run.strike && !run.heading && !run.quote) return undefined;
  return {
    ...(run.bold && { fontWeight: "700" }),
    ...(run.italic && { fontStyle: "italic" }),
    ...(run.code && { fontFamily: scale.mono.fontFamily, fontSize: scale.mono.fontSize, backgroundColor: colors.sunken }),
    ...(run.link && { textDecorationLine: "underline" }),
    ...(run.strike && { textDecorationLine: "line-through" }),
    ...(run.heading && { fontSize: scale.callout.fontSize + (run.heading === 1 ? 5 : run.heading === 2 ? 3 : 1) }),
    ...(run.quote && { color: colors.ink2 }),
  };
}

export type SelectableTextProps = {
  text: string;
  /** False for text that is shown as written (a person's own message). */
  markdown?: boolean;
  color?: string;
  /** The person tapped somewhere else: selecting is over. */
  onDone: () => void;
};

export function SelectableText({ text, markdown = true, color, onDone }: SelectableTextProps) {
  const { colors, type: scale } = useTheme();
  const runs = useMemo(() => selectableRuns(text, markdown), [text, markdown]);
  const length = useMemo(() => selectableText(runs).length, [runs]);
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  // The whole message is selected to begin with, so the handles are there to drag.
  useEffect(() => {
    const timer = setTimeout(() => {
      field.current?.focus();
      field.current?.setSelection(0, length);
    }, 60);
    return () => clearTimeout(timer);
  }, [length]);
  return (
    <TextInput
      ref={field}
      editable={false}
      multiline
      scrollEnabled={false}
      onBlur={onDone}
      // The phone's own selection color: it reads on every theme, light and dark.
      contextMenuHidden={false}
      maxFontSizeMultiplier={1.35}
      accessibilityLabel="Message text. Drag the handles to select part of it."
      style={[scale.callout, { color: color ?? colors.ink, padding: 0, paddingTop: 0, paddingBottom: 0, margin: 0 }]}
    >
      {runs.map((run, index) => (
        <Text key={index} style={styleOf(run, colors, scale)}>
          {run.text}
        </Text>
      ))}
    </TextInput>
  );
}
