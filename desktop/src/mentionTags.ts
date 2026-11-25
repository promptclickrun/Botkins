// "@Name" in a message, drawn as a tag when Name is someone in the chat: the owner, a team member or
// one of its bots. Nothing is stored for it: the tag is found when the message is drawn, so it also
// works for messages written before tags, and for a bot's reply that names a person.
//
// The phone has the same rules (mobile/src): the longest name first, any case, and the name must end
// where a word does. Text inside code is never a tag, and a name that is nobody in the chat stays text.

/** Someone a tag can name. `key` finds what to draw for them (a person's id, or "bot:" and a bot's id). */
export type MentionName = { key: string; name: string };
/** A piece of a text: plain text, or a tag with the text it was written as ("@sam"). */
export type MentionPiece = string | { key: string; text: string };

const WORD = /[\p{L}\p{N}_]/u;

/** The names to look for, the longest first, once each (the first one with a name wins). */
export function mentionNames(names: readonly MentionName[]): (MentionName & { lower: string })[] {
  const seen = new Set<string>();
  const out: (MentionName & { lower: string })[] = [];
  for (const entry of names) {
    const lower = entry.name.trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push({ key: entry.key, name: entry.name.trim(), lower });
  }
  // A stable sort: two names of the same length keep the order they were given in.
  return out.sort((a, b) => b.lower.length - a.lower.length);
}

/**
 * Cuts a text into plain text and tags. An "@" starts a tag only at the start of the text or after
 * a character that is not part of a word (so an email address is not one), and the name must not
 * run on into a longer word ("@Alexander" is not "@Alex").
 */
export function splitMentions(text: string, names: readonly MentionName[], sorted = mentionNames(names)): MentionPiece[] {
  if (!sorted.length || !text.includes("@")) return [text];
  const out: MentionPiece[] = [];
  let from = 0;
  let at = text.indexOf("@");
  while (at >= 0) {
    const before = at > 0 ? text[at - 1] : "";
    let found: { key: string; length: number } | undefined;
    if (!before || (!WORD.test(before) && before !== "@")) {
      for (const entry of sorted) {
        const end = at + 1 + entry.lower.length;
        if (text.slice(at + 1, end).toLowerCase() !== entry.lower) continue;
        if (end < text.length && WORD.test(text[end])) continue;
        found = { key: entry.key, length: 1 + entry.lower.length };
        break;
      }
    }
    if (found) {
      if (at > from) out.push(text.slice(from, at));
      out.push({ key: found.key, text: text.slice(at, at + found.length) });
      from = at + found.length;
      at = text.indexOf("@", from);
    } else at = text.indexOf("@", at + 1);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown };
/** What Markdown keeps as it is: code, links and their kin, and the file links and pictures of a reply. */
const KEPT = new Set(["code", "inlineCode", "link", "linkReference", "image", "imageReference", "definition", "html", "chatFile", "chatMedia"]);

/** A Markdown rule that turns each "@Name" of the text into a tag: `<span data-mention="key">@Name</span>`. */
export function mentionMarkup(names: readonly MentionName[]) {
  const sorted = mentionNames(names);
  return () => (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children) return;
      const next: MdNode[] = [];
      for (const child of node.children) {
        if (KEPT.has(child.type)) next.push(child);
        else if (child.type === "text" && child.value) {
          for (const piece of splitMentions(child.value, names, sorted)) {
            if (typeof piece === "string") next.push({ type: "text", value: piece });
            else next.push({ type: "personMention", data: { hName: "span", hProperties: { "data-mention": piece.key } }, children: [{ type: "text", value: piece.text }] });
          }
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}
