// MEDIA: attachments in a reply, drawn where they were written (the phone has the same rules:
// mobile/src/features/artifacts/logic.ts, `messageParts`).
//
// - A `MEDIA:` attachment the computer knows is drawn in the reply where its line was, and the raw
//   `MEDIA:` text is not shown. Words beside it stay.
// - A picture is shown itself. A video, a sound or another file is a chip in the same place.
// - An attachment the computer does not know stays as the text it is.
// - The same file written twice in one message is drawn once, at its first place.
import type { Artifact } from "./types";

/** The largest picture read whole to draw it in a reply. A larger one shows the small picture the computer makes, or a chip. */
export const INLINE_PICTURE_MAX = 8 * 1024 * 1024;

export type MediaSpan = { path: string; start: number; end: number; media?: boolean };
/** What stands at a `MEDIA:` place: the attachment, and `again` when an earlier place already draws it. */
export type MediaPlace = { media: Artifact; again: boolean };

/**
 * For each span, in the text's order: what is drawn there. Nothing for a path that is not a
 * `MEDIA:` attachment, and nothing for one the computer does not know (`known` has no entry).
 */
export function mediaPlaces(spans: readonly MediaSpan[], known: ReadonlyMap<string, Artifact>): (MediaPlace | undefined)[] {
  const seen = new Set<string>();
  const order = spans.map((span, index) => ({ span, index })).sort((a, b) => a.span.start - b.span.start);
  const out: (MediaPlace | undefined)[] = spans.map(() => undefined);
  for (const { span, index } of order) {
    const media = span.media ? known.get(span.path) : undefined;
    if (!media) continue;
    out[index] = { media, again: seen.has(media.id) };
    seen.add(media.id);
  }
  return out;
}

/** A picture is shown itself; everything else is a chip. */
export const isPicture = (item: Pick<Artifact, "kind">) => item.kind === "image";
/** Whether a picture's own file is read to draw it. */
export const readsWhole = (item: Pick<Artifact, "size">) => item.size != null && item.size > 0 && item.size <= INLINE_PICTURE_MAX;

type MdNode = { type: string; value?: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } }; data?: unknown };
export type FoundSpan = { start: number; end: number; media?: Artifact; again?: boolean };

const KEPT = ["link", "image", "linkReference", "imageReference", "definition", "code"];
const fileNode = (index: number, label: string): MdNode => ({ type: "chatFile", data: { hName: "span", hProperties: { "data-chat-file": index } }, children: [{ type: "text", value: label }] });
const mediaNode = (index: number): MdNode => ({ type: "chatMedia", data: { hName: "span", hProperties: { "data-chat-media": index } }, children: [] });

/**
 * A Markdown rule for a reply's file paths. A path the computer answered for becomes a link, at
 * the exact text the detector found. A `MEDIA:` attachment the computer knows becomes the
 * attachment itself in place of its text, once. Markdown's own links keep their destinations
 * and labels.
 */
export function pathMarkup(text: string, found: readonly FoundSpan[]) {
  return () => (tree: MdNode) => {
    // MEDIA:`a path` is two nodes: the word, then the code. Both go, and the attachment stands there.
    function acrossCode(children: MdNode[]): MdNode[] {
      const out: MdNode[] = [];
      for (let i = 0; i < children.length; i++) {
        const node = children[i];
        const next = children[i + 1];
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const nextEnd = next?.position?.end.offset;
        const index = node.type === "text" && next?.type === "inlineCode" && start != null && end != null && nextEnd != null && node.value
          ? found.findIndex((span) => !!span.media && span.start >= start && span.start < end && span.end === nextEnd)
          : -1;
        const cut = index < 0 ? -1 : node.value!.lastIndexOf("MEDIA:");
        if (cut < 0) {
          out.push(node);
          continue;
        }
        if (cut > 0) out.push({ ...node, value: node.value!.slice(0, cut) });
        if (!found[index].again) out.push(mediaNode(index));
        i++;
      }
      return out;
    }
    function replace(node: MdNode): MdNode[] {
      if (KEPT.includes(node.type)) return [node];
      if (node.type !== "text" && node.type !== "inlineCode") {
        if (node.children) node.children = acrossCode(node.children).flatMap(replace);
        return [node];
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null || !node.value) return [node];
      const out: MdNode[] = [];
      let consumed = 0;
      let changed = false;
      found.forEach((span, index) => {
        if (span.start < start || span.end > end) return;
        const label = text.slice(span.start, span.end);
        const begin = node.value!.indexOf(label, consumed);
        if (begin < 0) return;
        if (begin > consumed) out.push({ type: "text", value: node.value!.slice(consumed, begin) });
        if (!span.media) out.push(fileNode(index, label));
        else if (!span.again) out.push(mediaNode(index));
        consumed = begin + label.length;
        changed = true;
      });
      if (!changed) return [node];
      if (consumed < node.value.length) out.push({ type: "text", value: node.value.slice(consumed) });
      return out;
    }
    replace(tree);
  };
}
