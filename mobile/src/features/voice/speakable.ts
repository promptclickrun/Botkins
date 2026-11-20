// Text made ready to be heard: Markdown cleaned to plain sentences, and long text split into parts
// a speech provider can say one after the other. Pure (no React Native), so tests/voice-phone.test.ts
// runs it.

/** A link's words without its address; a bare address as its site's name. */
function siteOf(url: string): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:www\.)?([^/\s?#:]+)/i.exec(url)?.[1];
  return host ? "a link to " + host : "a link";
}

/**
 * Markdown to words a voice can read. A code block is "code block" said once, never its symbols;
 * an address is not spelled out; list items become sentences; tables say their cells in order.
 */
export function speakable(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  // Fenced code (closed or still open at the end) is said once.
  text = text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "$1\nCode block.\n");
  // Indented code (four spaces after a blank line) the same.
  text = text.replace(/(^|\n\n)((?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*)/g, "$1Code block.");
  // HTML tags and comments.
  text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-z][^>]*>/gi, " ");
  // Images say their description, links their words.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt: string) => (alt.trim() ? "Image: " + alt.trim() + "." : ""));
  text = text.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "");
  text = text.replace(/\[\^[^\]]+\]/g, "");
  // Bare addresses.
  text = text.replace(/<?\b(?:https?|ftp):\/\/[^\s<>()]+[^\s<>().,;:!?'"]>?/gi, (url) => siteOf(url.replace(/^<|>$/g, "")));
  text = text.replace(/\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>()]*/gi, (url) => siteOf("http://" + url));
  // Inline code keeps its words, without the ticks.
  text = text.replace(/`+([^`\n]+)`+/g, "$1");
  // Tables: the separator row goes, cells are read with commas.
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  text = text.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_all, cells: string) => endSentence(cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ")));
  // Rules.
  text = text.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
  // Headings, quotes and list items become sentences.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, (_all, heading: string) => endSentence(heading));
  text = text.replace(/^[ \t]*(>[ \t]?)+/gm, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/gm, (_all, item: string) => endSentence(item));
  // Emphasis and leftover marks.
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2").replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/[*_~`|#]+/g, " ");
  // Lines that end without a mark are their own sentence, so a voice pauses there.
  text = text
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index, lines) => (index < lines.length - 1 ? endSentence(line) : line))
    .join(" ");
  // "Code block." twice in a row is said once.
  text = text.replace(/(Code block\.\s*){2,}/g, "Code block. ");
  return text.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?:;…]["')\]]?$/.test(trimmed) ? trimmed : trimmed + ".";
}

/** The size of the first part (sound starts fast) and the most any later part holds. */
export const FIRST_PART = { min: 40, max: 80 };
export const LATER_PART_MAX = 400;

/** Where a sentence ends: a mark, any closing quotes, then space. */
const SENTENCE = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g;

function sentencesOf(text: string): string[] {
  return (text.match(SENTENCE) ?? []).map((part) => part.trim()).filter(Boolean);
}

/** Cuts a piece longer than `max` at the last comma, semicolon or space before it. */
function cut(piece: string, max: number): [string, string] {
  if (piece.length <= max) return [piece, ""];
  const window = piece.slice(0, max + 1);
  let at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "), window.lastIndexOf(" – "), window.lastIndexOf(" — "));
  if (at < max * 0.4) at = window.lastIndexOf(" ");
  if (at <= 0) at = max;
  else if (/[,;:]/.test(piece[at] ?? "")) at += 1;
  return [piece.slice(0, at).trim(), piece.slice(at).trim()];
}

/**
 * Splits speakable text into parts to synthesize one after another. The first part is short (40 to
 * 80 characters when the text allows) so sound starts soon; later parts grow, up to about 400. A
 * part ends at a sentence when it can, else at a comma, else at a space.
 */
export function splitForSpeech(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = sentencesOf(clean);
  const parts: string[] = [];
  let current = "";
  let limit = FIRST_PART.max;
  const flush = () => {
    if (current) parts.push(current);
    current = "";
    // Each part may be about twice the last, so later parts stay few.
    limit = Math.min(LATER_PART_MAX, Math.max(limit * 2, 160));
  };
  const queue = [...sentences];
  while (queue.length) {
    const sentence = queue.shift()!;
    const joined = current ? current + " " + sentence : sentence;
    if (joined.length <= limit) {
      current = joined;
      // The first part ends as soon as it is long enough.
      if (!parts.length && current.length >= FIRST_PART.min) flush();
      continue;
    }
    if (current) {
      flush();
      queue.unshift(sentence);
      continue;
    }
    // One sentence longer than the limit: cut it.
    const [head, rest] = cut(sentence, limit);
    current = head;
    flush();
    if (rest) queue.unshift(rest);
  }
  flush();
  return parts;
}

/**
 * The phrase dictation is building, given the last partial text and a new one. Most recognizers
 * send the whole phrase so far each time. Some start a fresh phrase after a pause without saying
 * the old one was final; then the old one is kept (`done`) before the new one starts.
 */
export function nextPhrase(previous: string, incoming: string): { done?: string; current: string } {
  const before = previous.trim();
  const now = incoming.trim();
  if (!before || !now) return { current: now };
  const a = before.toLowerCase();
  const b = now.toLowerCase();
  // Same phrase, grown or corrected: it shares its start with what came before.
  const head = Math.min(a.length, b.length, 12);
  if (b.startsWith(a.slice(0, head)) || a.startsWith(b.slice(0, head))) return { current: now };
  // A much shorter text that starts differently is a new phrase.
  if (b.length < a.length * 0.6) return { done: before, current: now };
  return { current: now };
}
