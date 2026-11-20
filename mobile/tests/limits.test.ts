// A provider's plan and limits as words (src/features/models/limits.ts), and the computer's call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { agoWords, cleanUsage, countWords, creditWords, limitLine, limitTone, percentWords, primaryLimit, resetWords, updatedWords } from "../src/features/models/limits";

const NOW = Date.UTC(2026, 10, 19, 16, 0, 0); // Thursday 19 November 2026, 16:00 UTC
const clock = { now: NOW, locale: "en-US", timeZone: "UTC" };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("only what the type says is kept, and a number is never made up", () => {
  const clean = cleanUsage([
    { provider: "claude", plan: " Claude Max 20x ", account: "subscription", updatedAt: NOW, limits: [{ id: "weekly", label: "Weekly", percentRemaining: 140, resetAt: NOW + DAY, primary: true }, { id: "session", label: "5-hour session", percentRemaining: "lots" }, { label: "" }, null] },
    { provider: "codex", limits: "none", account: "enterprise", plan: 7, error: "  It didn't answer. ", updatedAt: "today" },
    { plan: "No provider" },
    "junk",
  ]);
  assert.deepEqual(clean, [
    { provider: "claude", plan: "Claude Max 20x", account: "subscription", limits: [{ id: "weekly", label: "Weekly", percentRemaining: 100, resetAt: NOW + DAY, primary: true }, { id: "session", label: "5-hour session" }], updatedAt: NOW },
    { provider: "codex", limits: [], error: "It didn't answer." },
  ]);
  assert.deepEqual(cleanUsage({ provider: "x" }), []);
  assert.deepEqual(cleanUsage(undefined), []);
  // Below zero is zero left, and a limit without a number has none.
  assert.equal(cleanUsage([{ provider: "a", limits: [{ label: "Weekly", percentRemaining: -4 }] }])[0].limits[0].percentRemaining, 0);
  assert.equal("percentRemaining" in cleanUsage([{ provider: "a", limits: [{ label: "Weekly", percentRemaining: Number.NaN }] }])[0].limits[0], false);
});

test("a reset is said as the desktop says it: short for one line, long in the list", () => {
  assert.equal(resetWords(NOW + 5 * HOUR, clock), "9:00 PM");
  assert.equal(resetWords(NOW + 5 * HOUR, clock, false), "today at 9:00 PM");
  assert.equal(resetWords(NOW + 4 * DAY, clock), "Mon");
  assert.equal(resetWords(NOW + 4 * DAY, clock, false), "Mon, Nov 23 at 4:00 PM");
  assert.equal(resetWords(NOW + 12 * DAY, clock), "Dec 1");
  assert.equal(resetWords(NOW + 12 * DAY, clock, false), "Dec 1");
  assert.equal(resetWords(NOW - HOUR, clock), "", "a reset that has passed isn't shown");
});

test("the picker's line shows the one limit that matters, or nothing", () => {
  const usage = { provider: "codex", limits: [{ id: "session", label: "5-hour session", percentRemaining: 91, resetAt: NOW + 2 * HOUR }, { id: "weekly", label: "Weekly", window: "week" as const, percentRemaining: 61.6, resetAt: NOW + 4 * DAY, primary: true }] };
  assert.equal(limitLine(usage, clock), "61.6% of weekly left · resets Mon");
  assert.equal(primaryLimit({ provider: "codex", limits: usage.limits.map(({ primary: _primary, ...limit }) => limit) })?.id, "session", "without a marked one, the first with a number that counts every model");
  // The desktop's own labels: a week's limit for every model is "weekly", anything else its label with a small first letter.
  const claude = { provider: "claude", limits: [{ id: "weekly-opus", label: "Weekly, Opus", model: "Opus", window: "week" as const, percentRemaining: 5 }, { id: "weekly", label: "Weekly, all models", window: "week" as const, percentRemaining: 40, resetAt: NOW + 4 * DAY }] };
  assert.equal(limitLine(claude, clock), "40% of weekly left · resets Mon", "a limit for one model is never the one shown, unless it is marked");
  assert.equal(limitLine({ provider: "codex", limits: [{ id: "session", label: "5-hour session", window: "session", percentRemaining: 12, primary: true }] }, clock), "12% of 5-hour session left");
  assert.equal(limitLine({ provider: "copilot", limits: [{ id: "premium", label: "Premium requests", percentRemaining: 99.5, resetAt: NOW + 12 * DAY }] }, clock), "99.5% of premium requests left · resets Dec 1");
  assert.equal(limitLine({ provider: "x", limits: [{ id: "w", label: "Monthly spend", percentRemaining: 30, resetAt: NOW - 5 }] }, clock), "30% of monthly spend left", "a reset that has passed is left out");
  // Old numbers, and numbers kept after a failed read, say their age where the reset would be.
  assert.equal(limitLine({ ...claude, updatedAt: NOW - 25 * MIN }, clock), "40% of weekly left · updated 25 min ago");
  assert.equal(limitLine({ ...claude, updatedAt: NOW - 3 * MIN, error: "Claude didn't answer just now." }, clock), "40% of weekly left · updated 3 min ago");
  assert.equal(limitLine({ ...claude, updatedAt: NOW - 3 * MIN }, clock), "40% of weekly left · resets Mon");
  // No number: no line, never a guess. An API key says what it is.
  assert.equal(limitLine({ provider: "claude", limits: [{ id: "weekly", label: "Weekly" }] }, clock), undefined);
  assert.equal(limitLine({ provider: "claude", account: "api-key", limits: [] }, clock), "API key · billed by use");
  assert.equal(limitLine(undefined, clock), undefined);
});

test("percents, tones and ages", () => {
  assert.equal(percentWords(0), "0%");
  assert.equal(percentWords(62), "62%");
  assert.equal(percentWords(99.5), "99.5%");
  assert.equal(percentWords(0.44), "0.4%");
  assert.equal(percentWords(61.96), "62%");
  assert.equal(limitTone(0), "out");
  assert.equal(limitTone(10), "low");
  assert.equal(limitTone(10.1), "ok");
  assert.equal(agoWords(NOW - 20_000, NOW), "just now");
  assert.equal(agoWords(NOW - 5 * MIN, NOW), "5 min ago");
  assert.equal(agoWords(NOW - 3 * HOUR, NOW), "3 hr ago");
  assert.equal(agoWords(NOW - DAY, NOW), "1 day ago");
  assert.equal(agoWords(NOW - 2 * DAY, NOW), "2 days ago");
  assert.equal(updatedWords(NOW - 5 * MIN, NOW), "Updated 5 min ago");
  assert.equal(updatedWords(NOW - 5 * MIN, NOW, "Claude Code"), "Updated 5 min ago · from Claude Code");
  assert.equal(updatedWords(undefined, NOW), undefined);
});

test("counts, an allowance without a limit and a balance are shown as the provider gives them", () => {
  const [entry] = cleanUsage([
    {
      provider: "copilot", name: "GitHub Copilot", source: "GitHub Copilot", note: " ", credits: { label: "Credits", amount: 1250.456, unit: "credits" },
      limits: [
        { id: "premium", label: "Premium requests", percentUsed: 38, used: 570, limit: 1500, unit: "requests", window: "month" },
        { id: "chat", label: "Chat", unlimited: true, percentRemaining: 100 },
        { id: "odd", label: "Odd", used: -3, limit: 0, unit: "tokens", window: "year" },
      ],
    },
  ]);
  assert.equal(entry.limits[0].percentRemaining, 62, "what is left is 100 less what is used, when only that is given");
  assert.equal(countWords(entry.limits[0], "en-US"), "570 of 1,500 requests used");
  assert.deepEqual(entry.limits[1], { id: "chat", label: "Chat", unlimited: true }, "no percent and no bar for an allowance without a limit");
  assert.deepEqual(entry.limits[2], { id: "odd", label: "Odd" });
  assert.equal(countWords(entry.limits[2]), undefined);
  assert.equal(creditWords(entry.credits!, "en-US"), "1,250.46");
  assert.equal(entry.name, "GitHub Copilot");
  assert.equal("note" in entry, false);
});

test("a phone may ask the computer for plans and limits, and the demo computer answers in the agreed shape", async () => {
  assert.ok(REMOTE_METHODS.has("providerUsage"));
  const backend = new MockBackend();
  assert.ok(backend.capabilities.includes("provider-usage-v1"));
  // One entry for each provider that is on and signed in.
  assert.equal((await backend.call("providerUsage", [])).some((item: { provider: string }) => item.provider === "opencode"), false);
  await backend.call("setProviderEnabled", ["opencode", true]);
  const raw = await backend.call("providerUsage", []);
  const clean = cleanUsage(raw);
  assert.deepEqual(clean, raw, "the demo sends nothing the phone would drop");
  assert.deepEqual(clean.map((item) => item.provider), ["copilot", "codex", "claude", "opencode"]);
  assert.equal(clean[0].plan, "GitHub Copilot Pro+");
  assert.ok(clean[0].limits.some((limit) => limit.unlimited));
  assert.equal(clean[1].limits.length, 2);
  assert.ok(clean[1].credits);
  assert.ok(clean[2].error && clean[2].limits.some((limit) => limit.percentRemaining === undefined));
  assert.deepEqual(clean[3].limits, []);
  assert.ok(clean[3].note);
  // Nothing of a sign-in travels with it.
  assert.doesNotMatch(JSON.stringify(raw), /token|secret|octocat|example\.com/i);
});
