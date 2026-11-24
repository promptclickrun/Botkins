// The three starter bots (desktop/starters.mjs): the owner's pick of 2026-11-24, the same on the phone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { STARTERS, starterById } from "../desktop/starters.mjs";
import { headIds, originalHeadIds } from "../desktop/link/botkin-heads.mjs";

test("the starters are Chief of Staff, Coding partner and Money manager, in that order", () => {
  assert.deepEqual(STARTERS.map((s) => [s.name, s.summary]), [
    ["Chief of Staff", "Plans the day, keeps track of what's open, follows up."],
    ["Coding partner", "Reads and changes code, runs tests, opens pull requests."],
    ["Money manager", "Tracks spending and bills, budgets, flags anything unusual."],
  ]);
  for (const s of STARTERS) {
    assert.equal(s.role, s.name, "the default name is the role itself");
    assert.ok(s.name.length <= 48 && s.role.length <= 90 && s.summary.length <= 240);
    assert.ok(s.instructions.length > 200 && s.instructions.length < 1200, s.id + ": a short paragraph");
    assert.ok(!s.instructions.includes("\n"), s.id + ": one paragraph");
  }
  assert.equal(starterById("money-manager")?.name, "Money manager");
  assert.equal(starterById("nope"), undefined);
});

test("each starter wears one of the ten newer characters", () => {
  const newer = headIds.filter((id) => !originalHeadIds.includes(id));
  assert.deepEqual(newer.sort(), ["brim", "clover", "drip", "dune", "gloop", "mallow", "orbit", "pebble", "ripple", "wisp"]);
  assert.deepEqual(STARTERS.map((s) => s.look.head), ["drip", "mallow", "pebble"]);
  for (const s of STARTERS) assert.ok(newer.includes(s.look.head), s.id);
});

test("Chief of Staff and Money manager suggest the Proactive agent", () => {
  assert.deepEqual(STARTERS.map((s) => [s.id, s.suggestProactive === true]), [
    ["chief-of-staff", true],
    ["coding-partner", false],
    ["money-manager", true],
  ]);
});

test("a bot made from a starter keeps which one, and the Proactive suggestion", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-starters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({ deleteSession: async () => {} }), () => {});
  const make = (id, name) => {
    const s = starterById(id);
    return ws.bot(ws.addBot({ name: name ?? s.name, role: s.role, instructions: s.instructions, summary: s.summary, look: s.look, starter: id }));
  };
  const chief = make("chief-of-staff", "Ada");
  assert.equal(chief.name, "Ada", "a person can rename it");
  assert.equal(chief.starter, "chief-of-staff");
  assert.equal(chief.suggestProactive, true);
  assert.deepEqual(chief.look, { head: "drip", palette: "original" });
  const coder = make("coding-partner");
  assert.equal(coder.starter, "coding-partner");
  assert.equal(coder.suggestProactive, undefined);
  const plain = ws.bot(ws.addBot({ name: "Mine", role: "Helper", instructions: "Help.", starter: "made-up", suggestProactive: true }));
  assert.equal(plain.starter, undefined, "only a known starter is kept");
  assert.equal(plain.suggestProactive, undefined, "the flag comes from the starter, not the caller");
});

test("the phone keeps the same starters file", () => {
  for (const name of ["starters.mjs", "starters.d.mts"]) {
    const desktop = readFileSync(new URL("../desktop/" + name, import.meta.url), "utf8");
    const phone = readFileSync(new URL("../../mobile/link-host/" + name, import.meta.url), "utf8");
    assert.equal(phone, desktop, "copy desktop/desktop/" + name + " to mobile/link-host/" + name);
  }
});
