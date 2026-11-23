// The model picker a page at a time: a provider can list hundreds of models (OpenRouter, an OpenAI
// endpoint), so each provider shows its first 25 with a "Show 25 more" row under them. The same
// choices and words as the phone's picker (mobile/src/features/models/pages.ts, the source of this
// copy); test/model-pages.test.mjs checks this file and compares the two when the phone's is beside it.
// ---- Everything below this line is the same in both apps.

/** How many models one page shows. */
export const PAGE_SIZE = 25;

/** A run of models under one heading (a provider's service, or the provider itself). */
export type PageSection<T> = { models: T[] };
/** A provider's models, in their sections, in the provider's own order. */
export type PageGroup<T, S extends PageSection<T> = PageSection<T>> = { provider: string; sections: S[] };
/** A provider cut to the rows drawn: `rest` models are behind its "Show more" row. */
export type PagedGroup<T, S extends PageSection<T> = PageSection<T>, G extends PageGroup<T, S> = PageGroup<T, S>> = {
  group: G;
  sections: S[];
  /** How many of its models are drawn. */
  shown: number;
  /** How many are still behind "Show more". */
  rest: number;
  /** The model in use, drawn first because its place is on a later page. */
  pinned?: T;
};

const total = <T>(sections: PageSection<T>[]) => sections.reduce((sum, section) => sum + section.models.length, 0);

/**
 * The first `limit` models of the sections, in order, with the model in use drawn first in its
 * section when its own place is further down. Sections left empty are dropped.
 */
function cut<T, S extends PageSection<T>>(sections: S[], limit: number, isChosen: (model: T) => boolean) {
  let left = Math.max(0, limit);
  let pinned: T | undefined;
  let shown = 0;
  const out: S[] = [];
  for (const section of sections) {
    const head = section.models.slice(0, left);
    left -= head.length;
    const later = head.length < section.models.length ? section.models.slice(head.length).find(isChosen) : undefined;
    if (later !== undefined && pinned === undefined) pinned = later;
    const models = later !== undefined && pinned === later ? [later, ...head] : head;
    if (!models.length) continue;
    shown += models.length;
    out.push(models.length === section.models.length ? section : { ...section, models });
  }
  return { sections: out, shown, pinned };
}

/**
 * Each provider with its first pages: `pages[provider]` pages (one when not set) of PAGE_SIZE
 * models. A provider at or under one page is drawn whole, as before.
 */
export function pageGroups<T, S extends PageSection<T>, G extends PageGroup<T, S>>(
  groups: G[],
  pages: Record<string, number>,
  isChosen: (model: T) => boolean,
): PagedGroup<T, S, G>[] {
  return groups.map((group) => {
    const all = total(group.sections);
    const { sections, shown, pinned } = cut<T, S>(group.sections, (pages[group.provider] ?? 1) * PAGE_SIZE, isChosen);
    return { group, sections, shown, rest: all - shown, pinned };
  });
}

/**
 * A search's matches across every provider, a page at a time: the first `pages` × PAGE_SIZE matches
 * in the list's order, then one "Show more" row for all of them (`rest`). The model in use, when it
 * matches, is drawn first in its provider. Providers with nothing drawn are left out.
 */
export function pageMatches<T, S extends PageSection<T>, G extends PageGroup<T, S>>(
  groups: G[],
  pages: number,
  isChosen: (model: T) => boolean,
): { groups: PagedGroup<T, S, G>[]; rest: number } {
  let left = Math.max(1, pages) * PAGE_SIZE;
  let rest = 0;
  const out: PagedGroup<T, S, G>[] = [];
  for (const group of groups) {
    const all = total(group.sections);
    const { sections, shown, pinned } = cut<T, S>(group.sections, left, isChosen);
    left -= shown - (pinned === undefined ? 0 : 1);
    rest += all - shown;
    if (shown) out.push({ group, sections, shown, rest: 0, pinned });
  }
  return { groups: out, rest };
}

/** How many models the next "Show more" reveals. */
export const nextPage = (rest: number) => Math.min(PAGE_SIZE, Math.max(0, rest));

/** The "Show more" row's words: "Show 25 more", or "Show the last 3" when fewer are left. */
export function moreLabel(rest: number) {
  const next = nextPage(rest);
  if (rest > PAGE_SIZE) return "Show " + next + " more";
  return next === 1 ? "Show the last one" : "Show the last " + next;
}

/**
 * What the row says to VoiceOver and screen readers: "Show 25 more models from OpenRouter", or
 * "Show 25 more matching models" under a search (no provider).
 */
export function moreAccessibilityLabel(rest: number, providerName?: string) {
  const next = nextPage(rest);
  const what = next === 1 ? (providerName ? "model" : "matching model") : providerName ? "models" : "matching models";
  const lead = rest > PAGE_SIZE ? "Show " + next + " more " : next === 1 ? "Show the last " : "Show the last " + next + " ";
  return lead + what + (providerName ? " from " + providerName : "");
}

/** The models drawn, in the order they are drawn: the pinned model first in its section. */
export const shownModels = <T>(paged: PagedGroup<T, PageSection<T>, PageGroup<T, PageSection<T>>>[]) =>
  paged.flatMap((entry) => entry.sections.flatMap((section) => section.models));

/** How many rows a paged list draws: one per model shown, and one per "Show more" row. */
export function rowCount<T>(paged: PagedGroup<T, PageSection<T>, PageGroup<T, PageSection<T>>>[], searchRest = 0) {
  return paged.reduce((sum, entry) => sum + entry.shown + (entry.rest > 0 ? 1 : 0), 0) + (searchRest > 0 ? 1 : 0);
}
