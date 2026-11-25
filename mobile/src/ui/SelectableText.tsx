// A message as text a person can select part of, with the phone's own handles and its own menu
// (Copy, Look Up, Share…). It is one native text view that can't be edited, holding the message as
// styled runs of plain text (selectable.ts), so what is copied has no Markdown marks in it.
import { type ComponentRef, useContext, useEffect, useMemo, useRef } from "react";
import { Text, TextInput, type TextStyle } from "react-native";
import { InlineTagsContext, type InlineTagSpan } from "./inlineTags";
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
  // A chat's "@Name" tags keep their tint and weight here; the text is unchanged, so what is copied is too.
  const tags = useContext(InlineTagsContext);
  const pieces = useMemo(() => {
    const out: { run: TextRun; tag?: InlineTagSpan }[] = [];
    for (const run of runs) {
      const spans = !tags || run.code ? [] : tags.find(run.text);
      let last = 0;
      for (const span of spans) {
        if (span.start < last) continue;
        if (span.start > last) out.push({ run: { ...run, text: run.text.slice(last, span.start) } });
        out.push({ run: { ...run, text: run.text.slice(span.start, span.end) }, tag: span });
        last = span.end;
      }
      if (!last || last < run.text.length) out.push({ run: last ? { ...run, text: run.text.slice(last) } : run });
    }
    return out;
  }, [runs, tags]);
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
      {pieces.map(({ run, tag }, index) => (
        <Text key={index} style={tag && tags ? [styleOf(run, colors, scale), tags.selected(tag, color ?? colors.ink)] : styleOf(run, colors, scale)}>
          {run.text}
        </Text>
      ))}
    </TextInput>
  );
}
