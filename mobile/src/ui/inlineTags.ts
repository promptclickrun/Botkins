// Words in a message drawn as tags (a chat's "@Name" mentions): the chat says which and how, through
// this context; Markdown and SelectableText only ask. Outside a chat there is none, and text is drawn
// as it always was. Code (spans and blocks) never holds a tag.
import { createContext, type ReactNode } from "react";
import type { TextStyle } from "react-native";

export type InlineTagSpan = { start: number; end: number; target: unknown };
export type InlineTags = {
  /** The tags in a run of text, in order and not overlapping. */
  find: (text: string) => InlineTagSpan[];
  /** A tag as it is drawn inside a line of text, in the text's own color. */
  draw: (span: InlineTagSpan, text: string, key: string, color: string | undefined) => ReactNode;
  /** A tag's style while the message is being selected: one native text view, so no pill, only its tint and weight. */
  selected: (span: InlineTagSpan, color: string | undefined) => TextStyle;
};

export const InlineTagsContext = createContext<InlineTags | null>(null);

/** Text with its tags drawn, each plain piece passed through `rest` (paths that open something). */
export function withTags(text: string, tags: InlineTags | null, color: string | undefined, key: string, rest: (piece: string, key: string) => ReactNode): ReactNode {
  if (!tags || !text || !text.includes("@")) return rest(text, key);
  let spans: InlineTagSpan[];
  try {
    spans = tags.find(text);
  } catch {
    return rest(text, key);
  }
  if (!spans.length) return rest(text, key);
  const out: ReactNode[] = [];
  let last = 0;
  for (const span of spans) {
    if (span.start < last || span.end > text.length) continue;
    if (span.start > last) out.push(rest(text.slice(last, span.start), key + "s" + last));
    out.push(tags.draw(span, text.slice(span.start, span.end), key + "m" + span.start, color));
    last = span.end;
  }
  if (last < text.length) out.push(rest(text.slice(last), key + "s" + last));
  return out;
}
