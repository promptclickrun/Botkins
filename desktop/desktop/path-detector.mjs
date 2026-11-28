const BEFORE = /[\s([{<"'“‘]/;
const TRAILING = /[.,;:!?)\]}>&"'”’…]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isLinkablePath(value, spaces = false) {
  if (!value || value.length > 1024 || CONTROL.test(value) || value.includes("://")) return false;
  if (!spaces && /\s/.test(value)) return false;
  if (value !== value.trim()) return false;
  let rest;
  let least;
  if (/^[A-Za-z]:[\\/]/.test(value)) { rest = value.slice(3); least = 1; }
  else if (value.startsWith("~/")) { rest = value.slice(2); least = 1; }
  else if (value.startsWith("/") && !value.startsWith("//")) { rest = value.slice(1); least = 2; }
  else return false;
  const windows = /^[A-Za-z]:/.test(value);
  const parts = rest.split(windows ? /[\\/]/ : "/");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length < least) return false;
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && part.trim() === part);
}

const fence = (line) => /^\s*(```|~~~)/.test(line);

// Bare MEDIA: on its own line (optionally after a list or quote mark) can carry unquoted spaces
// such as macOS "/Users/.../Application Support/Botkins/..." or Windows "C:\Users\A B\...".
const MEDIA_LINE_LEAD = /^\s*(?:[-*+]|\d+[.)]|>)?\s*$/;

function inLine(line, at) {
  const spans = [];
  const taken = [];
  const free = (start, end) => taken.every(([from, to]) => end <= from || start >= to);
  const boundary = (index) => index === 0 || BEFORE.test(line[index - 1]);
  const add = (start, end, path, media) => { spans.push({ start: at + start, end: at + end, path, ...(media && { media: true }) }); taken.push([start, end]); };
  for (const match of line.matchAll(/MEDIA:[ ]?(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+))/g)) {
    const start = match.index;
    if (!boundary(start) || !free(start, start + match[0].length)) continue;
    const quoted = match[1] ?? match[2] ?? match[3];
    if (quoted !== undefined) { if (isLinkablePath(quoted, true)) add(start, start + match[0].length, quoted, true); continue; }
    if (MEDIA_LINE_LEAD.test(line.slice(0, start))) {
      const restStart = start + match[0].length - match[4].length;
      const tail = line.slice(restStart).replace(/[ \t]+$/, "");
      if (/\s/.test(tail) && !/(?:^|\s)MEDIA:/i.test(tail)) {
        // Prefer whole line when it is a path with spaces (macOS Application Support, Windows dirs),
        // unless the first token is already a complete path followed by prose words ("MEDIA:/a.png and the source is ...").
        const firstToken = match[4].replace(TRAILING, "");
        const whole = tail.replace(TRAILING, "");
        const restAfterFirst = tail.slice(match[4].length);
        const looksLikeProse = isLinkablePath(firstToken) && /^\s+(?:and|or|then|is|was|are|were|in|on|at|to|for|with|from|as|by|of|the|a|an|that|this|which|here|there|see|open|check|shows?|has|have|had)\b/i.test(restAfterFirst);
        if (!looksLikeProse && isLinkablePath(whole, true)) {
          add(start, restStart + whole.length, whole, true);
          continue;
        }
      }
    }
    const bare = match[4].replace(TRAILING, "");
    if (isLinkablePath(bare)) add(start, start + match[0].length - (match[4].length - bare.length), bare, true);
  }
  for (const match of line.matchAll(/(`+)([^`\n]+?)\1/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!free(start, end)) continue;
    const inner = match[2];
    const open = start + match[1].length;
    if (isLinkablePath(inner, true)) add(open, open + inner.length, inner); else taken.push([start, end]);
  }
  for (const match of line.matchAll(/"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”/g)) {
    const start = match.index;
    const inner = match[1] ?? match[2] ?? match[3];
    if (!boundary(start) || !free(start, start + match[0].length) || !isLinkablePath(inner, true)) continue;
    add(start + 1, start + 1 + inner.length, inner);
  }
  for (const match of line.matchAll(/(?:~\/|\/(?!\/)|[A-Za-z]:[\\/])\S*/g)) {
    const start = match.index;
    if (!boundary(start) || (line[start - 1] === "(" && line[start - 2] === "]")) continue;
    const path = match[0].replace(TRAILING, "");
    const end = start + path.length;
    if (!free(start, end) || !isLinkablePath(path)) continue;
    add(start, end, path);
  }
  return spans;
}

export function findPathSpans(text) {
  const spans = [];
  let at = 0;
  let inFence = false;
  for (const line of String(text ?? "").split("\n")) {
    if (fence(line)) inFence = !inFence;
    else if (inFence) {
      const trimmed = line.trim();
      const quoted = /^(['"`]).+\1$/.test(trimmed);
      const path = quoted ? trimmed.slice(1, -1) : trimmed;
      const start = at + line.indexOf(trimmed) + (quoted ? 1 : 0);
      if (isLinkablePath(path, true)) spans.push({ start, end: start + path.length, path });
    } else spans.push(...inLine(line, at));
    at += line.length + 1;
  }
  return spans.sort((a, b) => a.start - b.start);
}

export const findPathCandidates = (text) => findPathSpans(text).map((span) => span.path);
