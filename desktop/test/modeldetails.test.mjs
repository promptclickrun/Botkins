// What a model's details keep and drop (desktop/modeldetails.mjs): a value nobody stated is left out,
// the context meter's limit, Anthropic's published table, and the limits a tool reported after a turn.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ReportedLimits, claudeModelId, claudePublished, meterLimit, modelDetails } from "../desktop/modeldetails.mjs";
import { tempDir } from "./fake-copilot.mjs";

test("model details keep real values of every kind", () => {
  const all = {
    contextWindow: 200000,
    maxPrompt: 128000,
    maxOutput: 16000,
    vision: true,
    tools: false,
    effortNotes: { low: "Fast", high: "Careful" },
    description: "A good model",
    knowledge: "Jun 2026",
    vendor: "Example Labs",
    tier: "premium",
  };
  assert.deepEqual(modelDetails(all), all);
});

test("model details with nothing given are empty", () => {
  assert.deepEqual(modelDetails(), {});
  assert.deepEqual(modelDetails({}), {});
});

test("model details drop token counts that are zero, negative, not whole or not numbers", () => {
  for (const bad of [0, -5, NaN, Infinity, 1.5, "200000", null, undefined, {}, [100]]) {
    assert.deepEqual(modelDetails({ contextWindow: bad, maxPrompt: bad, maxOutput: bad }), {}, "dropped: " + String(bad));
  }
});

test("model details keep a real count next to a dropped one", () => {
  assert.deepEqual(modelDetails({ contextWindow: 8000, maxPrompt: 0, maxOutput: "4000" }), { contextWindow: 8000 });
});

test("model details keep vision and tools only when they are true or false", () => {
  assert.deepEqual(modelDetails({ vision: false, tools: false }), { vision: false, tools: false });
  assert.deepEqual(modelDetails({ vision: "true", tools: 1 }), {});
  assert.deepEqual(modelDetails({ vision: null, tools: undefined }), {});
});

test("model details drop text that is empty, blank or not text", () => {
  assert.deepEqual(modelDetails({ description: "", knowledge: "   ", vendor: "\n\t", tier: 5 }), {});
  assert.deepEqual(modelDetails({ description: ["a"], vendor: { name: "x" } }), {});
});

test("model details trim the text they keep", () => {
  assert.deepEqual(modelDetails({ description: "  Hello  ", vendor: "\tAcme\n" }), { description: "Hello", vendor: "Acme" });
});

test("model details cut long text to its limit", () => {
  const out = modelDetails({ description: "d".repeat(500), knowledge: "k".repeat(100), vendor: "v".repeat(100), tier: "t".repeat(100) });
  assert.deepEqual([out.description.length, out.knowledge.length, out.vendor.length, out.tier.length], [400, 40, 60, 40]);
});

test("model details keep a thinking level's note and drop notes that are not text", () => {
  const out = modelDetails({ effortNotes: { low: "Fast", mid: "", high: "  ", xhigh: 3, max: null, none: undefined, odd: ["x"] } });
  assert.deepEqual(out, { effortNotes: { low: "Fast" } });
});

test("model details cut a thinking level's note to 200 characters", () => {
  assert.equal(modelDetails({ effortNotes: { low: "n".repeat(300) } }).effortNotes.low.length, 200);
});

test("model details drop thinking level notes entirely when none is left", () => {
  const out = modelDetails({ effortNotes: { low: "", high: 4 }, description: "x" });
  assert.deepEqual(out, { description: "x" });
  assert.equal("effortNotes" in out, false);
});

test("model details drop thinking level notes that are not an object", () => {
  for (const bad of ["fast", 5, true, null]) assert.deepEqual(modelDetails({ effortNotes: bad }), {});
});

test("model details do not copy keys they do not know", () => {
  assert.deepEqual(modelDetails({ contextWindow: 1000, name: "Pip", id: "x", price: 3 }), { contextWindow: 1000 });
});

test("the meter counts to the prompt limit first", () => {
  assert.equal(meterLimit({ maxPrompt: 128000, contextWindow: 200000 }), 128000);
});

test("the meter counts to the window when there is no prompt limit", () => {
  assert.equal(meterLimit({ contextWindow: 200000 }), 200000);
  assert.equal(meterLimit({ maxPrompt: 0, contextWindow: 200000 }), 200000);
});

test("the meter has no limit when the model knows neither", () => {
  assert.equal(meterLimit({}), undefined);
  assert.equal(meterLimit({ maxOutput: 4000 }), undefined);
  assert.equal(meterLimit(null), undefined);
  assert.equal(meterLimit(undefined), undefined);
});

test("the meter ignores limits that are not whole numbers", () => {
  assert.equal(meterLimit({ maxPrompt: 1.5, contextWindow: 200000 }), 200000);
  assert.equal(meterLimit({ maxPrompt: "128000", contextWindow: "200000" }), undefined);
  assert.equal(meterLimit({ maxPrompt: NaN, contextWindow: -1 }), undefined);
});

test("a Claude model id loses Claude Code's [1m] mark", () => {
  assert.equal(claudeModelId("claude-opus-5-5[1m]"), "claude-opus-5-5");
});

test("a Claude model id loses a dated suffix", () => {
  assert.equal(claudeModelId("claude-opus-4-5-20251101"), "claude-opus-4-5");
});

test("a Claude model id is lower case", () => {
  assert.equal(claudeModelId("Claude-Sonnet-5-5"), "claude-sonnet-5-5");
});

test("a Claude model id with nothing to strip stays as it is, and an id nobody gave is empty", () => {
  assert.equal(claudeModelId("claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(claudeModelId(undefined), "");
  assert.equal(claudeModelId(null), "");
});

test("Anthropic's table gives a current model its window, output, knowledge, vision and tools", () => {
  assert.deepEqual(claudePublished("claude-opus-5-5"), { contextWindow: 1_000_000, maxOutput: 128_000, knowledge: "Jun 2026", vision: true, tools: true });
});

test("Anthropic's table is read through the id's [1m] mark and date", () => {
  assert.deepEqual(claudePublished("claude-opus-5-5[1m]"), claudePublished("claude-opus-5-5"));
  assert.equal(claudePublished("claude-haiku-4-5-20251001").contextWindow, 200_000);
});

test("Anthropic's table gives an older model a window and output but no knowledge", () => {
  assert.deepEqual(claudePublished("claude-haiku-4-5-20251001"), { contextWindow: 200_000, maxOutput: 64_000 });
  assert.equal("knowledge" in claudePublished("claude-haiku-4-5-20251001"), false);
});

test("Anthropic's table gives Opus 4.1 its smaller output", () => {
  assert.deepEqual(claudePublished("claude-opus-4-1"), { contextWindow: 200_000, maxOutput: 32_000 });
});

test("Anthropic's table has nothing for a model it does not list", () => {
  assert.deepEqual(claudePublished("claude-unknown-9"), {});
  assert.deepEqual(claudePublished("gpt-4"), {});
  assert.deepEqual(claudePublished(undefined), {});
});

test("what Anthropic's table gives is a copy, so changing it changes no later answer", () => {
  const first = claudePublished("claude-opus-5-5");
  first.contextWindow = 1;
  first.extra = true;
  delete first.maxOutput;
  assert.deepEqual(claudePublished("claude-opus-5-5"), { contextWindow: 1_000_000, maxOutput: 128_000, knowledge: "Jun 2026", vision: true, tools: true });
  const old = claudePublished("claude-opus-4-1");
  old.maxOutput = 5;
  assert.equal(claudePublished("claude-opus-4-1").maxOutput, 32_000);
});

test("a limit report that says something new is taken", () => {
  const limits = new ReportedLimits();
  assert.equal(limits.note("model-a", { contextWindow: 200000, maxOutput: 32000 }), true);
  assert.deepEqual(limits.for("model-a"), { contextWindow: 200000, maxOutput: 32000 });
});

test("the same limit report twice says nothing new the second time", () => {
  const limits = new ReportedLimits();
  assert.equal(limits.note("model-a", { contextWindow: 200000 }), true);
  assert.equal(limits.note("model-a", { contextWindow: 200000 }), false);
});

test("a changed limit is new and a report adds to what was known", () => {
  const limits = new ReportedLimits();
  limits.note("model-a", { contextWindow: 200000 });
  assert.equal(limits.note("model-a", { maxOutput: 8000 }), true);
  assert.deepEqual(limits.for("model-a"), { contextWindow: 200000, maxOutput: 8000 });
  assert.equal(limits.note("model-a", { contextWindow: 1000000 }), true);
  assert.deepEqual(limits.for("model-a"), { contextWindow: 1000000, maxOutput: 8000 });
});

test("limits that are not real values are ignored", () => {
  const limits = new ReportedLimits();
  assert.equal(limits.note("model-a", { contextWindow: 0, maxOutput: -1, maxPrompt: "5" }), false);
  assert.equal(limits.note("model-a", { contextWindow: NaN, maxOutput: 1.5 }), false);
  assert.equal(limits.note("model-a", {}), false);
  assert.equal(limits.note("model-a", undefined), false);
  assert.equal(limits.note("model-a", null), false);
  assert.deepEqual(limits.for("model-a"), {});
});

test("a report keeps only the three limits and nothing else it carries", () => {
  const limits = new ReportedLimits();
  limits.note("model-a", { contextWindow: 1000, maxPrompt: 900, maxOutput: 100, vision: true, vendor: "Example Labs", description: "x" });
  assert.deepEqual(limits.for("model-a"), { contextWindow: 1000, maxPrompt: 900, maxOutput: 100 });
});

test("a report without a model name is ignored", () => {
  const limits = new ReportedLimits();
  for (const name of [undefined, null, "", 5, {}]) assert.equal(limits.note(name, { contextWindow: 1000 }), false);
  assert.deepEqual(limits.known, {});
});

test("a model nobody reported on has no limits", () => {
  assert.deepEqual(new ReportedLimits().for("never-seen"), {});
});

test("what is known for a model is a copy", () => {
  const limits = new ReportedLimits();
  limits.note("model-a", { contextWindow: 1000 });
  limits.for("model-a").contextWindow = 5;
  assert.equal(limits.for("model-a").contextWindow, 1000);
});

test("a report is written to the file and a new one on the same file knows it", (t) => {
  const file = join(tempDir(t), "nested", "model-limits.json");
  const first = new ReportedLimits(file);
  assert.equal(first.note("model-a", { contextWindow: 200000, maxOutput: 32000 }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "model-a": { contextWindow: 200000, maxOutput: 32000 } });
  const second = new ReportedLimits(file);
  assert.deepEqual(second.for("model-a"), { contextWindow: 200000, maxOutput: 32000 });
  assert.equal(second.note("model-a", { contextWindow: 200000, maxOutput: 32000 }), false, "what the file said is not new");
});

test("a report that says nothing new does not write the file", (t) => {
  const file = join(tempDir(t), "model-limits.json");
  const limits = new ReportedLimits(file);
  limits.note("model-a", { contextWindow: 1000 });
  writeFileSync(file, "{}");
  limits.note("model-a", { contextWindow: 1000 });
  assert.equal(readFileSync(file, "utf8"), "{}");
});

test("a file with junk in it keeps only the real limits", (t) => {
  const file = join(tempDir(t), "model-limits.json");
  writeFileSync(file, JSON.stringify({ good: { contextWindow: 1000, maxOutput: 0 }, bad: { contextWindow: "big" }, worse: 5, nothing: null }));
  const limits = new ReportedLimits(file);
  assert.deepEqual(limits.known, { good: { contextWindow: 1000 } });
});

test("a damaged file is read as empty and is mended by the next report", (t) => {
  const file = join(tempDir(t), "model-limits.json");
  writeFileSync(file, "{ this is not json");
  const limits = new ReportedLimits(file);
  assert.deepEqual(limits.known, {});
  assert.equal(limits.note("model-a", { contextWindow: 1000 }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "model-a": { contextWindow: 1000 } });
});

test("a file that holds something other than an object is read as empty", (t) => {
  const file = join(tempDir(t), "model-limits.json");
  writeFileSync(file, "[1,2,3]");
  assert.deepEqual(new ReportedLimits(file).known, {});
  writeFileSync(file, "null");
  assert.deepEqual(new ReportedLimits(file).known, {});
});

test("without a file the limits are kept in memory and nothing is written", (t) => {
  const dir = tempDir(t);
  const limits = new ReportedLimits();
  assert.equal(limits.file, null);
  assert.equal(limits.note("model-a", { maxPrompt: 5000 }), true);
  assert.deepEqual(limits.for("model-a"), { maxPrompt: 5000 });
  assert.equal(existsSync(join(dir, "model-limits.json")), false);
  assert.deepEqual(new ReportedLimits().for("model-a"), {}, "another one starts empty");
});

test("a file that can't be written leaves the report kept for this run", (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "model-limits.json")); // a folder where the file should go
  const limits = new ReportedLimits(join(dir, "model-limits.json"));
  assert.equal(limits.note("model-a", { contextWindow: 1000 }), true);
  assert.deepEqual(limits.for("model-a"), { contextWindow: 1000 });
});
