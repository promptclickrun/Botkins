import type { Token } from "marked";

type Tokens = Token[] & { links?: unknown };
type MarkdownLex = (text: string) => Token[];
export type MarkdownStreamCache = { sourcePrefix: string; tokens: Token[] };

/** A list or blockquote may still absorb indented continuation lines across a blank line. Keep
 * those in the tail until a later, unambiguous block has also ended. */
function canSeal(token: Token) {
  return token.type === "paragraph" || token.type === "heading" || token.type === "hr" || token.type === "table" ||
    (token.type === "code" && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw));
}

// A real reference link definition begins at the start of a line (optional 0-3 spaces).
// Checking `text.includes("]:")` would falsely disable caching for TypeScript index signatures
// or JSON/code snippets containing `]:`.
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:/m;

/** Reuse marked's actual tokens up to a proven block boundary. The next pass starts with the
 * blank separator so the lexer retains the same top-level context. */
export function parseStreamingMarkdown(text: string, lex: MarkdownLex, previous?: MarkdownStreamCache, hasFootnotes = false): { tokens: Token[]; cache?: MarkdownStreamCache } {
  // A late reference definition may change links in any earlier paragraph. Marked normalizes CRLF.
  if (hasFootnotes || REF_DEF.test(text) || text.includes("\r")) return { tokens: lex(text) };
  const prefix = previous && text.startsWith(previous.sourcePrefix) ? previous : undefined;
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
  return { tokens, cache };
}
