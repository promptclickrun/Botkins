// "@Name" in a message, drawn as a tag when Name is someone in the chat: a person (the owner or a
// member) or one of its bots. Nothing new is stored: the tags are found when a message is drawn.
// Names match without regard to case, the longest first, and only as whole words; text in code
// (a `code span` or a fenced block) is left alone, and so is a name nobody in the chat has.
// Plain logic (no React Native imports; tested by tests/mention-tags.test.ts).

export type MentionTarget = { kind: "person" | "bot"; id: string; name: string };
export type MentionSpan = { start: number; end: number; target: MentionTarget };
export type MentionMatcher = { find: (text: string) => MentionSpan[]; /** The same people and bots give the same key. */ key: string };

const WORD = /[\p{L}\p{N}_]/u;
/** How many texts a matcher remembers: a chat's visible messages and then some. */
const REMEMBERED = 400;

/** Where a text has code: fenced blocks (to their closing fence, or the end) and inline code spans. */
export function codeRanges(text: string): [number, number][] {
  if (!text.includes("`") && !text.includes("~~~")) return [];
  const out: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { at: number; mark: string } | null = null;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    const mark = match[1]!;
    if (!open) open = { at: match.index, mark };
    else if (mark[0] === open.mark[0] && mark.length >= open.mark.length && match[0].trim() === mark) {
      out.push([open.at, match.index + match[0].length]);
      open = null;
    }
  }
  if (open) out.push([open.at, text.length]);
  // Inline code: a run of backticks to the next run of the same length, outside fences.
  const inside = (at: number) => out.some(([from, to]) => at >= from && at < to);
  const spans: [number, number][] = [];
  const ticks = /`+/g;
  for (let match = ticks.exec(text); match; match = ticks.exec(text)) {
    if (inside(match.index)) continue;
    const run = match[0];
    let close = -1;
    const again = new RegExp("(?<!`)" + run + "(?!`)", "g");
    again.lastIndex = match.index + run.length;
    const found = again.exec(text);
    if (found && !inside(found.index)) close = found.index;
    if (close < 0) continue;
    spans.push([match.index, close + run.length]);
    ticks.lastIndex = close + run.length;
  }
  return [...out, ...spans].sort((a, b) => a[0] - b[0]);
}

/** A matcher for these people and bots. Names that are empty, or shared by two of them, keep the first. */
export function mentionMatcher(targets: MentionTarget[]): MentionMatcher {
  const seen = new Set<string>();
  const names: { lower: string; length: number; target: MentionTarget }[] = [];
  for (const target of targets) {
    const name = target.name?.trim();
    if (!name) continue;
    const lower = name.toLocaleLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    names.push({ lower, length: name.length, target: { ...target, name } });
  }
  // The longest first, so "@Ana Lopez" wins over "@Ana".
  names.sort((a, b) => b.length - a.length);
  const key = names.map((entry) => entry.target.kind + ":" + entry.target.id + ":" + entry.lower).join("\u0000");
  const memo = new Map<string, MentionSpan[]>();
  const find = (text: string): MentionSpan[] => {
    if (!names.length || !text || !text.includes("@")) return [];
    const kept = memo.get(text);
    if (kept) return kept;
    const code = codeRanges(text);
    const lower = text.toLocaleLowerCase();
    const out: MentionSpan[] = [];
    for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
      if (at > 0 && WORD.test(text[at - 1]!)) continue;
      if (code.some(([from, to]) => at >= from && at < to)) continue;
      for (const entry of names) {
        const end = at + 1 + entry.length;
        if (lower.slice(at + 1, end) !== entry.lower) continue;
        if (end < text.length && WORD.test(text[end]!)) continue;
        out.push({ start: at, end, target: entry.target });
        at = end - 1;
        break;
      }
    }
    if (memo.size >= REMEMBERED) memo.delete(memo.keys().next().value!);
    memo.set(text, out);
    return out;
  };
  return { find, key };
}

/** A text cut into plain pieces and tags, in order. */
export type MentionPiece = { text: string; target?: MentionTarget };
export function mentionPieces(text: string, matcher: MentionMatcher | undefined): MentionPiece[] {
  const spans = matcher?.find(text) ?? [];
  if (!spans.length) return [{ text }];
  const out: MentionPiece[] = [];
  let last = 0;
  for (const span of spans) {
    if (span.start > last) out.push({ text: text.slice(last, span.start) });
    out.push({ text: text.slice(span.start, span.end), target: span.target });
    last = span.end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
