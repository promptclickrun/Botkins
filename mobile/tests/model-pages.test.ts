// The model picker a page at a time (src/features/models/pages.ts): 25 models per provider with a
// "Show 25 more" row, the model in use always drawn, and a search paged across every provider.
// The desktop's copy is checked against this file in desktop/test/model-pages.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { moreAccessibilityLabel, moreLabel, nextPage, PAGE_SIZE, pageGroups, pageMatches, rowCount, shownModels } from "../src/features/models/pages";

type M = { id: string; provider: string };
const models = (provider: string, count: number): M[] => Array.from({ length: count }, (_, i) => ({ id: provider + "-" + i, provider }));
const group = (provider: string, ...sizes: number[]) => ({ provider, sections: sizes.map((size, s) => ({ title: "s" + s, models: models(provider + s, size) })) });
const none = () => false;
const ids = (list: M[]) => list.map((m) => m.id);

test("a provider at or under a page is drawn whole, with no Show more row", () => {
  const small = group("claude", 7);
  const exact = group("copilot", PAGE_SIZE);
  const [a, b] = pageGroups([small, exact], {}, none);
  assert.equal(a.sections[0], small.sections[0], "the same section, untouched");
  assert.deepEqual([a.shown, a.rest, b.shown, b.rest], [7, 0, 25, 0]);
});

test("a big provider shows 25, then 25 more a page at a time, in its own order", () => {
  const big = group("openrouter", 414);
  const [one] = pageGroups([big], {}, none);
  assert.deepEqual(ids(shownModels([one])), ids(big.sections[0].models.slice(0, 25)));
  assert.equal(one.rest, 389);
  const [three] = pageGroups([big], { openrouter: 3 }, none);
  assert.deepEqual([three.shown, three.rest], [75, 339]);
  const [all] = pageGroups([big], { openrouter: 17 }, none);
  assert.deepEqual([all.shown, all.rest], [414, 0]);
  assert.deepEqual(ids(shownModels([all])), ids(big.sections[0].models));
});

test("a page runs across a provider's sections, and sections past it are left out", () => {
  const sectioned = group("opencode", 20, 20, 20);
  const [paged] = pageGroups([sectioned], {}, none);
  assert.deepEqual(paged.sections.map((s) => s.models.length), [20, 5]);
  assert.equal(paged.rest, 35);
});

test("the model in use is drawn first when its place is on a later page, and only once", () => {
  const big = group("openrouter", 100);
  const chosen = big.sections[0].models[80];
  const [paged] = pageGroups([big], {}, (m) => m === chosen);
  const shown = shownModels([paged]);
  assert.equal(shown[0], chosen);
  assert.equal(shown.length, 26);
  assert.equal(paged.pinned, chosen);
  assert.equal(paged.rest, 74);
  // Once its page is open it is back in its own place.
  const [open] = pageGroups([big], { openrouter: 4 }, (m) => m === chosen);
  assert.equal(open.pinned, undefined);
  assert.equal(shownModels([open]).indexOf(chosen), 80);
  // On the first page already: nothing moves.
  const early = big.sections[0].models[3];
  const [first] = pageGroups([big], {}, (m) => m === early);
  assert.equal(shownModels([first]).indexOf(early), 3);
});

test("a model in use in a section past the page brings its section along", () => {
  const sectioned = group("opencode", 30, 10);
  const chosen = sectioned.sections[1].models[4];
  const [paged] = pageGroups([sectioned], {}, (m) => m === chosen);
  assert.deepEqual(paged.sections.map((s) => ids(s.models).length), [25, 1]);
  assert.equal(paged.sections[1].models[0], chosen);
  assert.equal(paged.sections[1].title, "s1");
});

test("a search pages its matches across all providers, then one Show more row", () => {
  const groups = [group("a", 10), group("b", 30), group("c", 5)];
  const first = pageMatches(groups, 1, none);
  assert.deepEqual(first.groups.map((g) => [g.group.provider, g.shown]), [["a", 10], ["b", 15]]);
  assert.equal(first.rest, 20);
  const second = pageMatches(groups, 2, none);
  assert.deepEqual(second.groups.map((g) => [g.group.provider, g.shown]), [["a", 10], ["b", 30], ["c", 5]]);
  assert.equal(second.rest, 0);
  // The model in use that matches is drawn even when its match is past the page.
  const chosen = groups[2].sections[0].models[2];
  const pinned = pageMatches(groups, 1, (m) => m === chosen);
  assert.deepEqual(pinned.groups.map((g) => [g.group.provider, g.shown]), [["a", 10], ["b", 15], ["c", 1]]);
  assert.equal(pinned.rest, 19);
});

test("the Show more row's words", () => {
  assert.equal(moreLabel(389), "Show 25 more");
  assert.equal(moreLabel(25), "Show the last 25");
  assert.equal(moreLabel(3), "Show the last 3");
  assert.equal(moreLabel(1), "Show the last one");
  assert.equal(moreAccessibilityLabel(389, "OpenRouter"), "Show 25 more models from OpenRouter");
  assert.equal(moreAccessibilityLabel(3, "OpenRouter"), "Show the last 3 models from OpenRouter");
  assert.equal(moreAccessibilityLabel(1, "OpenRouter"), "Show the last model from OpenRouter");
  assert.equal(moreAccessibilityLabel(40), "Show 25 more matching models");
  assert.equal(moreAccessibilityLabel(2), "Show the last 2 matching models");
  assert.deepEqual([nextPage(389), nextPage(7), nextPage(0)], [25, 7, 0]);
});

test("1,000 models across 3 providers draw at most a page each, the pinned model and the Show more rows", () => {
  const groups = [group("openrouter", 414), group("openai-api", 501), group("claude", 85)];
  const chosen = groups[1].sections[0].models[400];
  const paged = pageGroups(groups, {}, (m) => m === chosen);
  const rows = rowCount(paged);
  assert.ok(rows <= 3 * PAGE_SIZE + 1 + 3, rows + " rows");
  assert.equal(rows, 75 + 1 + 3);
  const search = pageMatches(groups, 1, (m) => m === chosen);
  assert.ok(rowCount(search.groups, search.rest) <= PAGE_SIZE + 1 + 1);
});
