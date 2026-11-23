// The model picker a page at a time (src/modelPages.ts): 25 models per provider with a "Show 25
// more" row, the model in use always drawn, and a search paged across every provider. It is the
// phone's (mobile/src/features/models/pages.ts) word for word below its marker line; the phone's
// test (mobile/tests/model-pages.test.ts) covers the cases in full.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as pages from "../src/modelPages.ts";

const MARKER = "// ---- Everything below this line is the same in both apps.\n";
const group = (provider, count) => ({
  provider,
  sections: [{ models: Array.from({ length: count }, (_, i) => ({ m: { id: provider + "-" + i, provider }, index: i })) }],
});

test("the same logic and words as the phone's picker", (t) => {
  const phone = new URL("../../mobile/src/features/models/pages.ts", import.meta.url);
  if (!existsSync(phone)) return t.skip("the phone app isn't beside this one");
  const body = (url) => readFileSync(url, "utf8").split(MARKER)[1];
  assert.ok(body(phone), "the phone's file has the marker line");
  assert.equal(body(new URL("../src/modelPages.ts", import.meta.url)), body(phone));
});

test("a big provider shows a page, the model in use first, and a Show more row", () => {
  const big = group("openrouter", 414);
  const chosen = big.sections[0].models[300];
  const [paged] = pages.pageGroups([big], {}, (row) => row === chosen);
  assert.equal(paged.sections[0].models[0], chosen);
  assert.deepEqual([paged.shown, paged.rest], [26, 388]);
  assert.equal(pages.moreLabel(paged.rest), "Show 25 more");
  assert.equal(pages.moreAccessibilityLabel(paged.rest, "OpenRouter"), "Show 25 more models from OpenRouter");
  const [small] = pages.pageGroups([group("claude", 8)], {}, () => false);
  assert.deepEqual([small.shown, small.rest], [8, 0]);
});

test("1,000 models across 3 providers draw a bounded number of rows, quickly", () => {
  const groups = [group("openrouter", 414), group("openai-api", 501), group("claude", 85)];
  const chosen = groups[1].sections[0].models[450];
  const start = performance.now();
  const paged = pages.pageGroups(groups, {}, (row) => row === chosen);
  const search = pages.pageMatches(groups, 1, (row) => row === chosen);
  const took = performance.now() - start;
  assert.ok(pages.rowCount(paged) <= 3 * pages.PAGE_SIZE + 1 + 3);
  assert.ok(pages.rowCount(search.groups, search.rest) <= pages.PAGE_SIZE + 1 + 1);
  assert.ok(took < 50, took + "ms");
});
