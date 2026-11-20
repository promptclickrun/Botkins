import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";

test("progress, badges and line blocks validate and clamp", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-blocks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  const bot = ws.state.bots[0].id;
  const publish = (blocks, key = "k") => ws.panels.write(bot, "c", { key, title: "T", blocks });
  publish([
    { type: "progress", label: "Books", value: 14, max: 12, note: "Ahead" },
    { type: "badges", items: [{ label: "On track", tone: "positive" }, { label: "Plain", tone: "loud" }] },
    { type: "line", label: "Steps", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Me", values: [3, 5, 4] }] },
  ]);
  const [progress, badges, line] = ws.state.panels[0].blocks;
  assert.equal(progress.value, 12, "progress is clamped to its max");
  assert.deepEqual(badges.items.map((b) => b.tone), ["positive", "neutral"], "an unknown tone falls back to neutral");
  assert.deepEqual(line.series[0].values, [3, 5, 4]);
  assert.throws(() => publish([{ type: "progress", label: "x", value: 1, max: 0 }], "a"), /positive max/);
  assert.throws(() => publish([{ type: "line", label: "x", labels: ["a", "b"], series: [{ name: "s", values: [1] }] }], "b"), /one number per label/);
  assert.throws(() => publish([{ type: "badges", items: [] }], "c"), /Invalid badges/);
});
