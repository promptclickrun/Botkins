// Human @mentions in shared chats: detects when a person or bot addresses someone in the chat
// by @Name so Botkins can send them a "{Name} mentioned you in a chat" notification.

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Replace fenced code blocks and inline code spans with spaces so code examples don't trigger mentions. */
function stripCode(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length))
    .replace(/`[^`\n]+`/g, (match) => " ".repeat(match.length));
}

/**
 * Find people in a chat who are @mentioned in `text`.
 *
 * - Matches each person's full display name (case-insensitive), plus their first name when that
 *   first name is unambiguous among the people in the chat.
 * - Requires `@` to not be preceded by a word character (so emails like `colt@example.com` are ignored)
 *   and the matched name to not be followed by a word character.
 * - Never includes `excludeId` (e.g. a sender mentioning themselves).
 * - Returns matching person objects deduped by `id`, in order of first mention.
 *
 * @param {string} text
 * @param {Array<{ id: string, name: string }>} people
 * @param {{ excludeId?: string }} [options]
 */
export function findHumanMentions(text, people, { excludeId } = {}) {
  if (typeof text !== "string" || !text.includes("@") || !Array.isArray(people) || !people.length) return [];
  const valid = people
    .filter((person) => person && typeof person.id === "string" && person.id && typeof person.name === "string" && person.name.trim())
    .map((person) => ({ id: person.id, name: person.name.trim() }));
  if (!valid.length) return [];

  // Count full names and first names across ALL people in the chat (including the sender) so an
  // ambiguous first name never silently routes to the wrong person.
  const fullNames = new Set(valid.map((person) => person.name.toLowerCase()));
  const firstCounts = new Map();
  for (const person of valid) {
    const first = person.name.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first && first !== person.name.toLowerCase()) {
      firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
    }
  }

  /** @type {Array<{ token: string, person: { id: string, name: string } }>} */
  const candidates = [];
  for (const person of valid) {
    if (excludeId && person.id === excludeId) continue;
    const full = person.name.toLowerCase();
    candidates.push({ token: full, person });
    const first = full.split(/\s+/)[0] ?? "";
    if (first && first !== full && first.length >= 2 && firstCounts.get(first) === 1 && !fullNames.has(first)) {
      candidates.push({ token: first, person });
    }
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => b.token.length - a.token.length);

  const cleaned = stripCode(text);
  const lower = cleaned.toLowerCase();
  /** @type {Map<string, { at: number, person: { id: string, name: string } }>} */
  const matched = new Map();

  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== "@") continue;
    if (i > 0 && WORD_CHAR.test(lower[i - 1])) continue;
    for (const { token, person } of candidates) {
      if (!lower.startsWith(token, i + 1)) continue;
      const end = i + 1 + token.length;
      if (end < lower.length && WORD_CHAR.test(lower[end])) continue;
      if (!matched.has(person.id)) matched.set(person.id, { at: i, person });
      i = end - 1;
      break;
    }
  }

  return [...matched.values()].sort((a, b) => a.at - b.at).map((entry) => entry.person);
}

/** Notification title for a human @mention. */
export function mentionTitle(byName) {
  const who = typeof byName === "string" && byName.trim() ? byName.trim() : "Someone";
  return `${who} mentioned you in a chat`;
}
