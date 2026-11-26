// Settings' search, as the desktop app's Settings has it: a row matches when every word typed is in
// its title, its line or the other words it answers to ("dark" finds Appearance). Groups keep their
// order and drop out when nothing in them matches. No React Native imports, so
// tests/settings-search.test.ts runs it.

export type Findable = { title: string; subtitle?: string; words?: string };

/** The words of a search, lowercased; an empty search has none. */
const termsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether a row answers to a search. Every row answers to an empty one. */
export function matchesSetting(row: Findable, query: string): boolean {
  const terms = termsOf(query);
  if (!terms.length) return true;
  const hay = [row.title, row.subtitle, row.words].filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/** The groups with only the rows that answer to a search, and only the groups left with any. */
export function findSettings<R extends Findable, G extends { rows: R[] }>(groups: G[], query: string): G[] {
  return groups.map((group) => ({ ...group, rows: group.rows.filter((row) => matchesSetting(row, query)) })).filter((group) => group.rows.length > 0);
}
