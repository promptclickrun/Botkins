// Finds the file and folder paths written in a message, so a chat can make them links ("artifacts-v1").
// The rules are shared with the app on the computer: docs/path-detection.json holds the cases both
// apps test against, and its "rules" say the same as the comments here. No imports, so it runs anywhere.
//
// A span is only a candidate. It becomes a link after the computer says the path is something it
// can show (`artifacts.resolve`); otherwise the text stays as it is.

/** A path in a message: `text.slice(start, end)` is what becomes the link, `path` is what the computer is asked about. */
export type PathSpan = { start: number; end: number; path: string; /** It was written as a MEDIA: attachment. */ media?: true };

// What may stand right before a path: the start of the text, white space, or an opening bracket or quote.
const BEFORE = /[\s([{<"'“‘]/;
// Punctuation after a path that belongs to the sentence, not to the path.
const TRAILING = /[.,;:!?)\]}>"'”’…]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Whether `value` is a whole path of a kind that is linked:
 * - POSIX absolute with at least two parts ("/Users/sam", not "/model" or "/"),
 * - in the home folder ("~/notes.md"),
 * - Windows with a drive ("C:\Users\sam\a.txt", "D:/work").
 * Never a network path ("//host/share", "\\host\share"), a path with a "." or ".." part, or one
 * with white space unless `spaces` (it was written in quotes or backticks, or it is a whole line).
 */
export function isLinkablePath(value: string, spaces = false): boolean {
  if (!value || value.length > 1024 || CONTROL.test(value) || value.includes("://")) return false;
  if (!spaces && /\s/.test(value)) return false;
  if (value !== value.trim()) return false;
  let rest: string;
  let least: number;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    rest = value.slice(3);
    least = 1;
  } else if (value.startsWith("~/")) {
    rest = value.slice(2);
    least = 1;
  } else if (value.startsWith("/") && !value.startsWith("//")) {
    rest = value.slice(1);
    least = 2;
  } else return false;
  const windows = /^[A-Za-z]:/.test(value);
  const parts = rest.split(windows ? /[\\/]/ : "/");
  // One slash at the end is a folder written with its slash.
  if (parts.at(-1) === "") parts.pop();
  if (parts.length < least) return false;
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && part.trim() === part);
}

const fence = (line: string) => /^\s*(```|~~~)/.test(line);
// Bare MEDIA: on its own line (optionally after a list or quote mark) can carry unquoted spaces
// such as macOS "/Users/.../Application Support/Botkins/..." or Windows "C:\Users\A B\...".
const MEDIA_LINE_LEAD = /^\s*(?:[-*+]|\d+[.)]|>)?\s*$/;

/** The paths in one line of ordinary text (not inside a code block). `at` is where the line starts in the whole text. */
function inLine(line: string, at: number): PathSpan[] {
  const spans: PathSpan[] = [];
  // Parts of the line that are settled: a path already found, or code that is not a path.
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => taken.every(([from, to]) => end <= from || start >= to);
  const boundary = (index: number) => index === 0 || BEFORE.test(line[index - 1]!);
  const add = (start: number, end: number, path: string, media?: true) => {
    spans.push({ start: at + start, end: at + end, path, ...(media && { media }) });
    taken.push([start, end]);
  };

  // 1. MEDIA: attachments: MEDIA:/path, MEDIA: /path, MEDIA:"/path with spaces", MEDIA:`…`,
  //    or bare MEDIA: on its own line carrying spaces (macOS Application Support, Windows user dirs).
  for (const match of line.matchAll(/MEDIA:[ ]?(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+))/g)) {
    const start = match.index;
    if (!boundary(start) || !free(start, start + match[0].length)) continue;
    const quoted = match[1] ?? match[2] ?? match[3];
    if (quoted !== undefined) {
      if (isLinkablePath(quoted, true)) add(start, start + match[0].length, quoted, true);
      continue;
    }
    if (MEDIA_LINE_LEAD.test(line.slice(0, start))) {
      const restStart = start + match[0].length - match[4]!.length;
      const tail = line.slice(restStart).replace(/[ \t]+$/, "");
      if (/\s/.test(tail) && !/(?:^|\s)MEDIA:/i.test(tail)) {
        // Prefer whole line when it is a path with spaces (macOS Application Support, Windows dirs),
        // unless the first token is already a complete path followed by prose words ("MEDIA:/a.png and the source is ...").
        const firstToken = match[4]!.replace(TRAILING, "");
        const whole = tail.replace(TRAILING, "");
        const restAfterFirst = tail.slice(match[4]!.length);
        const looksLikeProse =
          isLinkablePath(firstToken) &&
          /^\s+(?:and|or|then|is|was|are|were|in|on|at|to|for|with|from|as|by|of|the|a|an|that|this|which|here|there|see|open|check|shows?|has|have|had)\b/i.test(restAfterFirst);
        if (!looksLikeProse && isLinkablePath(whole, true)) {
          add(start, restStart + whole.length, whole, true);
          continue;
        }
      }
    }
    const bare = match[4]!.replace(TRAILING, "");
    if (isLinkablePath(bare)) add(start, start + match[0].length - (match[4]!.length - bare.length), bare, true);
  }

  // 2. Inline code. Code that is one whole path is a link; any other code is left alone, with what is in it.
  for (const match of line.matchAll(/(`+)([^`\n]+?)\1/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!free(start, end)) continue;
    const inner = match[2]!;
    const open = start + match[1]!.length;
    if (isLinkablePath(inner, true)) add(open, open + inner.length, inner);
    else taken.push([start, end]);
  }

  // 3. A path in quotes may hold spaces. The quotes are not part of the link.
  for (const match of line.matchAll(/"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”/g)) {
    const start = match.index;
    const inner = match[1] ?? match[2] ?? match[3]!;
    if (!boundary(start) || !free(start, start + match[0].length) || !isLinkablePath(inner, true)) continue;
    add(start + 1, start + 1 + inner.length, inner);
  }

  // 4. A bare path: it starts after white space or an opening bracket and runs to the next white space.
  for (const match of line.matchAll(/(?:~\/|\/(?!\/)|[A-Za-z]:[\\/])\S*/g)) {
    const start = match.index;
    if (!boundary(start)) continue;
    // A Markdown link's target, [words](/a/b), is the writer's own link.
    if (line[start - 1] === "(" && line[start - 2] === "]") continue;
    const path = match[0].replace(TRAILING, "");
    const end = start + path.length;
    if (!free(start, end) || !isLinkablePath(path)) continue;
    add(start, end, path);
  }
  return spans;
}

/**
 * The paths written in `text`, in order, none overlapping another. In a code block (between ``` or
 * ~~~ lines) only a line that is nothing but a path counts; everywhere else the rules of `inLine` apply.
 */
export function detectPaths(text: string): PathSpan[] {
  const spans: PathSpan[] = [];
  let at = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (fence(line)) inFence = !inFence;
    else if (inFence) {
      // A whole-line path: the line, without the white space around it and without quotes around it.
      const trimmed = line.trim();
      const quoted = /^(["'`]).+\1$/.test(trimmed);
      const path = quoted ? trimmed.slice(1, -1) : trimmed;
      const start = at + line.indexOf(trimmed) + (quoted ? 1 : 0);
      if (isLinkablePath(path, true)) spans.push({ start, end: start + path.length, path });
    } else spans.push(...inLine(line, at));
    at += line.length + 1;
  }
  return spans.sort((a, b) => a.start - b.start);
}
