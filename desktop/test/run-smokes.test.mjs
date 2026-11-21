// The smokes' runner (test/run-smokes.mjs): its lists name real smokes, the parts cover every
// smoke once, and a failure's line says where it failed.
import test from "node:test";
import assert from "node:assert/strict";
import { allSmokes, BY_CHANCE, failedStep, LEFT_OUT, leftOut, partOf } from "./run-smokes.mjs";

test("the lists name smokes that exist, each with a reason", () => {
  const names = allSmokes();
  assert.ok(names.length >= 42 && names.includes("plugins") && names.includes("spaces"));
  for (const one of LEFT_OUT) {
    assert.ok(names.includes(one.name), one.name + " is not a smoke");
    assert.ok(["ci", "linux", "darwin", "win32"].includes(one.where), one.where);
    assert.ok(one.why.length > 10, "say why " + one.name + " is left out");
  }
  for (const [name, why] of Object.entries(BY_CHANCE)) {
    assert.ok(names.includes(name), name + " is not a smoke");
    assert.ok(why.length > 10, "say why " + name + " can fail by chance");
  }
});

test("a smoke is left out only where its entry says", () => {
  // The rule itself, on entries of this test's own: the real list can be empty.
  const entries = [{ name: "phone", where: "linux", why: "it needs a tool of macOS" }, { name: "today", where: "ci", why: "it needs a signed-in provider" }];
  const rule = (name, place) => entries.find((one) => one.name === name && (one.where === "ci" ? place.ci : one.where === place.platform))?.why;
  assert.equal(rule("phone", { ci: true, platform: "linux" }), "it needs a tool of macOS");
  assert.equal(rule("phone", { ci: true, platform: "darwin" }), undefined);
  assert.equal(rule("today", { ci: true, platform: "darwin" }), "it needs a signed-in provider");
  assert.equal(rule("today", { ci: false, platform: "darwin" }), undefined);
  assert.equal(leftOut("no-such-smoke", { ci: true, platform: "linux" }), undefined);
});

test("parts cover every smoke once", () => {
  const names = allSmokes();
  for (const count of [1, 2, 3, 4]) {
    const parts = Array.from({ length: count }, (_, i) => partOf(names, i + 1, count));
    assert.deepEqual(parts.flat().sort(), names);
    assert.ok(Math.max(...parts.map((p) => p.length)) - Math.min(...parts.map((p) => p.length)) <= 1);
  }
});

test("a failure's line says the step: the smoke's own line and the error's sentence", () => {
  const assertion = ["node:internal/modules/run_main:107", "    triggerUncaughtException(", "", "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:", "+ actual - expected", "    at file:///work/desktop/test/plugins-smoke.mjs:187:10 {"].join("\n");
  assert.equal(failedStep("plugins", assertion, 1), "plugins-smoke.mjs:187: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:");
  const expectation = ["ExpectError: expect(locator).toBeVisible() failed", "", "Locator: locator('aside.side-pane')", "    at callMatcherAsStep (/work/desktop/node_modules/playwright/lib/matchers/expect.js:13342:57)", "    at /work/desktop/test/sidepane-smoke.mjs:194:24 {"].join("\n");
  assert.equal(failedStep("sidepane", expectation, 1), "sidepane-smoke.mjs:194: ExpectError: expect(locator).toBeVisible() failed");
  const other = "page.evaluate: Error: Error invoking remote method 'plugins.addMarketplace': Error: This name is not one word.\n    at call (/work/desktop/test/plugins-smoke.mjs:65:50)";
  assert.equal(failedStep("plugins", other, 1), "plugins-smoke.mjs:65: page.evaluate: Error: Error invoking remote method 'plugins.addMarketplace': Error: This name is not one word.");
  assert.equal(failedStep("today", "Home passed.\n", 3), "it ended with code 3");
});
