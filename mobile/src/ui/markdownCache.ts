import type { Token, Tokens as MarkedTokens } from "marked";

type Tokens = Token[] & { links?: unknown };
type MarkdownLex = (text: string) => Token[];
type Fence = {
  opening: string;
  start: number;
  sourcePrefix: string;
  codePrefix: string;
  before: Tokens;
};
export type MarkdownStreamCache = { sourcePrefix: string; tokens: Token[]; fence?: Fence };

// Marked handles closing delimiters, indentation and the last newline. Once a content line
// contains ordinary text, everything up to that point can be represented by a single "x" on
// that line. Ask marked about the remaining suffix, then put the original code back in its token.
const FENCE_OPEN = /^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/;
function fenceCut(raw: string, opening: string, code: string): number | undefined {
  const end = raw.endsWith("\n") ? raw.length - 1 : raw.length;
  const line = Math.max(opening.length, raw.lastIndexOf("\n", end - 1) + 1);
  if (end <= line || code.endsWith("\n") || !/[^\s`~]/.test(raw.slice(line, end))) return;
  return end;
}

function rememberFence(text: string, tokens: Tokens, cache?: MarkdownStreamCache): MarkdownStreamCache | undefined {
  const last = tokens.at(-1);
  if (last?.type !== "code") return cache;
  const code = last as MarkedTokens.Code;
  const opening = FENCE_OPEN.exec(code.raw)?.[0];
  if (!opening || !text.endsWith(code.raw)) return cache;
  const cut = fenceCut(code.raw, opening, code.text);
  if (cut === undefined) return cache;
  const before: Tokens = tokens.slice(0, -1);
  if (tokens.links !== undefined) before.links = tokens.links;
  const start = text.length - code.raw.length;
  return {
    sourcePrefix: cache?.sourcePrefix ?? "", tokens: cache?.tokens ?? [],
    fence: { opening, start, sourcePrefix: text.slice(0, start + cut), codePrefix: code.text, before },
  };
}

function extendFence(text: string, lex: MarkdownLex, cache: MarkdownStreamCache, fence: Fence) {
  if (!text.startsWith(fence.sourcePrefix)) return;
  const suffix = text.slice(fence.sourcePrefix.length);
  if (suffix.includes("\r")) return;
  const input = fence.opening + "x" + suffix;
  const parsed = lex(input);
  const code = parsed[0] as MarkedTokens.Code | undefined;
  // A new block or a reference definition after the closer needs the ordinary document parser.
  if (parsed.length !== 1 || code?.type !== "code" || code.raw !== input || !code.text.startsWith("x")) return;
  const body = fence.codePrefix + code.text.slice(1);
  const tokens: Tokens = [...fence.before, { ...code, raw: text.slice(fence.start), text: body }];
  if (fence.before.links !== undefined) tokens.links = fence.before.links;
  const cut = fenceCut(input, fence.opening, code.text);
  const next = cut === undefined ? fence : { ...fence, sourcePrefix: text.slice(0, text.length - (input.length - cut)), codePrefix: body };
  return { tokens, cache: { ...cache, fence: next } };
}

/** A list or blockquote may still absorb indented continuation lines across a blank line. Keep
 * those in the tail until a later, unambiguous block has also ended. */
function canSeal(token: Token) {
  return token.type === "paragraph" || token.type === "heading" || token.type === "hr" || token.type === "table" ||
    (token.type === "code" && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw));
}

// A real reference link definition begins at the start of a line (optional 0-3 spaces).
// Checking `text.includes("]:")` would falsely disable caching for TypeScript index signatures
// or JSON/code snippets containing `]:`.
// A link reference definition, also inside block quotes and list items ("> [a]: url", "- [a]: url").
// Over-matching only costs a full lex; missing one leaves an earlier [a] as plain text.
const REF_DEF = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*\[[^\]\n]+\]:/m;

/** Reuse marked's actual tokens up to a proven block boundary. The next pass starts with the
 * blank separator so the lexer retains the same top-level context. */
export function parseStreamingMarkdown(text: string, lex: MarkdownLex, previous?: MarkdownStreamCache, hasFootnotes = false): { tokens: Token[]; cache?: MarkdownStreamCache } {
  if (previous?.fence && !hasFootnotes) {
    const extended = extendFence(text, lex, previous, previous.fence);
    if (extended) return extended;
  }
  // A late reference definition may change links in any earlier paragraph. Marked normalizes CRLF.
  if (hasFootnotes || REF_DEF.test(text) || text.includes("\r")) return { tokens: lex(text) };
  const prefix = previous && text.startsWith(previous.sourcePrefix) ? { sourcePrefix: previous.sourcePrefix, tokens: previous.tokens } : undefined;
  const start = prefix?.sourcePrefix.length ?? 0;
  const tail = text.slice(start);
  const tailTokens: Tokens = lex(tail);
  const tokens: Tokens = prefix ? [...prefix.tokens, ...tailTokens] : tailTokens;
  if (tailTokens.links !== undefined) tokens.links = tailTokens.links;

  let end = 0;
  let count = 0;
  let offset = 0;
  for (let i = 0; i < tailTokens.length; i++) {
    const token = tailTokens[i];
    // Stop at any syntax where marked's raw does not match the source (e.g. normalized indentation).
    if (!tail.startsWith(token.raw, offset)) break;
    if (i > 0 && i + 1 < tailTokens.length && token.type === "space" && canSeal(tailTokens[i - 1])) {
      end = offset;
      count = i;
    }
    offset += token.raw.length;
  }
  const cache = count ? { sourcePrefix: text.slice(0, start + end), tokens: tokens.slice(0, (prefix?.tokens.length ?? 0) + count) } : prefix;
  return { tokens, cache: rememberFence(text, tokens, cache) };
}
