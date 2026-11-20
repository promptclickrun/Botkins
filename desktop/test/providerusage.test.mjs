// Plans and limits of the model providers (desktop/providerusage.mjs): what each provider's own
// answer is read as, the one shape every screen gets, and how answers are kept and read again.
// The answers below have the shape the real tools gave in November 2026, with made-up ids and
// numbers. Nothing here starts a provider or reaches a network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDER_USAGE, ProviderUsage, claudePlan, claudeUsage, codexUsage, copilotPlan, copilotUsage, instant, normalizeUsage } from "../desktop/providerusage.mjs";

const NOW = Date.parse("2026-11-19T17:00:00Z");

// ---- Claude Code's get_usage ----

const CLAUDE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 3902, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 34, resets_at: "2026-11-25T09:00:01.497321+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, utilization: null, currency: "USD", decimal_places: 2, disabled_reason: "out_of_credits" },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 34, severity: "normal", resets_at: "2026-11-25T09:00:01.497321+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 43, severity: "normal", resets_at: "2026-11-25T09:00:00.497494+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
    model_scoped: [{ display_name: "Fable", utilization: 43, resets_at: "2026-11-25T09:00:00.497494+00:00" }],
  },
  behaviors: null,
};

test("a Claude plan is named from its subscription and its tier", () => {
  assert.equal(claudePlan("max", "max_20x"), "Claude Max 20x");
  assert.equal(claudePlan("max", "default_claude_max_5x"), "Claude Max 5x");
  assert.equal(claudePlan("max"), "Claude Max");
  assert.equal(claudePlan("pro", null), "Claude Pro");
  assert.equal(claudePlan("Team", "team_standard"), "Claude Team");
  assert.equal(claudePlan("ultra"), "Claude Ultra", "a subscription the table doesn't have is named as Claude Code named it");
  assert.equal(claudePlan(""), "Claude plan");
});

test("Claude: the weekly window and each model counted by itself, with their reset times", () => {
  const out = claudeUsage(CLAUDE);
  assert.equal(out.account, "subscription");
  assert.deepEqual(out.limits, [
    { id: "weekly", label: "Weekly, all models", window: "week", percentUsed: 34, resetAt: Date.parse("2026-11-25T09:00:01.497Z") },
    { id: "weekly-fable", label: "Weekly, Fable", window: "week", percentUsed: 43, resetAt: Date.parse("2026-11-25T09:00:00.497Z"), model: "Fable" },
  ]);
  assert.ok(!out.limits.some((limit) => limit.id === "session"), "no 5-hour window was reported, so none is made up");
  assert.ok(!out.limits.some((limit) => limit.id === "extra"), "extra usage that is switched off is not a limit");
});

test("Claude: a 5-hour window, the older per-model windows and extra usage when Anthropic reports them", () => {
  const out = claudeUsage({
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 61.26, resets_at: "2026-11-19T19:10:00Z" },
      seven_day: { utilization: 12, resets_at: null },
      seven_day_opus: { utilization: 80, resets_at: "2026-11-24T00:00:00Z" },
      seven_day_sonnet: { utilization: null, resets_at: null },
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 },
    },
  });
  assert.deepEqual(out.limits, [
    { id: "session", label: "5-hour session", window: "session", percentUsed: 61.3, resetAt: Date.parse("2026-11-19T19:10:00Z") },
    { id: "weekly", label: "Weekly, all models", window: "week", percentUsed: 12 },
    { id: "weekly-opus", label: "Weekly, Opus", window: "week", percentUsed: 80, resetAt: Date.parse("2026-11-24T00:00:00Z"), model: "Opus" },
    { id: "extra", label: "Extra usage", window: "month", percentUsed: 25 },
  ]);
  assert.equal(claudeUsage({ subscription_type: "pro", rate_limits_available: true, rate_limits: { seven_day: { utilization: 5, resets_at: null } } }).limits[0].label, "Weekly", "with no model counted by itself it is just the weekly limit");
});

test("Claude: an API key or a cloud sign-in has no plan limits, and a plan whose limits weren't reported says so", () => {
  assert.deepEqual(claudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }), { account: "api-key", limits: [] });
  const quiet = claudeUsage({ subscription_type: "team", rate_limits_available: false, rate_limits: null });
  assert.equal(quiet.account, "subscription");
  assert.deepEqual(quiet.limits, []);
  assert.match(quiet.note, /didn't report/);
  assert.deepEqual(claudeUsage({ subscription_type: "max", rate_limits_available: true, rate_limits: {} }).limits, [], "an answer with no windows gives no limits");
  assert.throws(() => claudeUsage(null), /didn't say anything/);
});

// ---- The Codex app server's account/rateLimits/read ----

const CODEX_LIMIT = {
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1795630138 },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: "26355.8736420000" },
  individualLimit: null,
  spendControlReached: false,
  planType: "prolite",
  rateLimitReachedType: null,
};
const CODEX = {
  ordinaryUsageAllowed: true,
  rateLimits: CODEX_LIMIT,
  rateLimitsByLimitId: { codex: CODEX_LIMIT },
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: "RateLimitResetCredit_sample", resetType: "codexRateLimits", status: "available", grantedAt: 1793477046, expiresAt: 1796069046, title: "Full reset", description: "One free rate limit reset." }] },
  accountId: "00000000-0000-4000-8000-000000000000",
  rateLimitUpsell: null,
};

test("ChatGPT: the weekly window, the plan type and the credit balance", () => {
  assert.deepEqual(codexUsage(CODEX), {
    account: "subscription",
    planType: "prolite",
    limits: [{ id: "weekly", label: "Weekly", window: "week", percentUsed: 8, resetAt: 1795630138000 }],
    credits: { label: "Credits", amount: 26355.87, unit: "credits" },
  });
  assert.ok(!JSON.stringify(codexUsage(CODEX)).includes("00000000"), "the account id is not read into the answer");
});

test("ChatGPT: a 5-hour window beside the weekly one, windows of other lengths, and a model counted by itself", () => {
  const out = codexUsage({
    rateLimits: { limitId: "codex", primary: { usedPercent: 40.04, windowDurationMins: 300, resetsAt: 1795112000 }, secondary: { usedPercent: 71, windowDurationMins: 10080, resetsAt: 1795630138 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "plus" },
    rateLimitsByLimitId: {
      codex: {},
      codex_spark: { limitId: "codex_spark", limitName: "GPT-6 Spark", primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1795630138 }, secondary: null },
      other_model: { limitId: "other_model", limitName: null, primary: { usedPercent: 9, windowDurationMins: 1440, resetsAt: null }, secondary: null },
    },
  });
  assert.deepEqual(out.limits, [
    { id: "session", label: "5-hour session", window: "session", percentUsed: 40, resetAt: 1795112000000 },
    { id: "weekly", label: "Weekly", window: "week", percentUsed: 71, resetAt: 1795630138000 },
    { id: "weekly-gpt-6-spark", label: "Weekly, GPT-6 Spark", window: "week", percentUsed: 3, resetAt: 1795630138000, model: "GPT-6 Spark" },
    { id: "daily-other-model", label: "Daily, other model", percentUsed: 9, model: "other model" },
  ]);
  assert.equal(out.credits, undefined, "no balance, no credits line");
  const odd = codexUsage({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 180 }, secondary: { usedPercent: 2, windowDurationMins: null }, credits: { hasCredits: true, unlimited: true, balance: "0" } } });
  assert.deepEqual(odd.limits.map((limit) => [limit.id, limit.label]), [["3-hour", "3-hour window"], ["secondary", "Second usage limit"]]);
  assert.equal(odd.credits, undefined, "an unlimited balance is not a number");
});

test("ChatGPT: an answer without limits is a failure, and windows without numbers are left out", () => {
  assert.throws(() => codexUsage({}), /didn't say anything/);
  assert.deepEqual(codexUsage({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 10080, resetsAt: null }, secondary: null } }).limits, []);
});

// ---- The Copilot runtime's account.getQuota and the signed-in account ----

const quotaOf = (more) => ({ isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, usageAllowedWithExhaustedQuota: false, overage: 0, overageAllowedWithExhaustedQuota: false, remainingPercentage: 100, resetDate: "2026-11-19T17:00:00.000Z", hasQuota: true, tokenBasedBilling: false, overageEntitlement: 0, ...more });
const COPILOT = {
  quotaSnapshots: {
    chat: quotaOf({ isUnlimitedEntitlement: true }),
    completions: quotaOf({ isUnlimitedEntitlement: true }),
    premium_interactions: quotaOf({ entitlementRequests: 1500, usedRequests: 570, usageAllowedWithExhaustedQuota: true, overageAllowedWithExhaustedQuota: true, remainingPercentage: 62 }),
  },
};
const COPILOT_USER = { login: "sample-login", access_type_sku: "plus_monthly_subscriber_quota", copilot_plan: "individual_pro", quota_reset_date: "2026-12-01", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", organization_login_list: ["sample-org"] };

test("a Copilot plan is named from the account's plan", () => {
  assert.equal(copilotPlan("individual_pro"), "GitHub Copilot Pro+");
  assert.equal(copilotPlan("individual"), "GitHub Copilot Pro");
  assert.equal(copilotPlan("free"), "GitHub Copilot Free");
  assert.equal(copilotPlan("business"), "GitHub Copilot Business");
  assert.equal(copilotPlan("enterprise"), "GitHub Copilot Enterprise");
  assert.equal(copilotPlan("student_pack"), "GitHub Copilot Student pack", "a plan the table doesn't have is named as GitHub named it");
  assert.equal(copilotPlan(undefined), undefined);
});

test("Copilot: premium requests with their counts and the month's reset, and what is unlimited", () => {
  const out = copilotUsage(COPILOT, COPILOT_USER, { now: NOW });
  assert.deepEqual(out, {
    account: "subscription",
    plan: "GitHub Copilot Pro+",
    limits: [
      { id: "premium", label: "Premium requests", window: "month", percentRemaining: 62, resetAt: Date.parse("2026-12-01T00:00:00Z"), used: 570, limit: 1500, unit: "requests" },
      { id: "chat", label: "Chat", window: "month", unlimited: true },
      { id: "completions", label: "Code completions", window: "month", unlimited: true },
    ],
  });
  assert.ok(!JSON.stringify(out).includes("sample-"), "no login or organization is read into the answer");
});

test("Copilot: a quota's own reset date only counts when it lies ahead", () => {
  // Without the account, the quota's date is the time of the call: not a reset time.
  const bare = copilotUsage(COPILOT, null, { now: NOW });
  assert.equal(bare.plan, undefined);
  assert.equal(bare.limits[0].resetAt, undefined);
  const ahead = copilotUsage({ quotaSnapshots: { premium_interactions: quotaOf({ entitlementRequests: 300, usedRequests: 30, remainingPercentage: 90, resetDate: "2026-12-01T00:00:00.000Z" }) } }, { copilot_plan: "individual" }, { now: NOW });
  assert.equal(ahead.limits[0].resetAt, Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(copilotUsage(COPILOT, { quota_reset_date: "2026-12-01" }, { now: NOW }).limits[0].resetAt, Date.parse("2026-12-01T00:00:00Z"), "the account's date without a time is midnight UTC");
});

test("Copilot: a free plan's counted chat, credits under token billing, quotas the plan doesn't have, and unknown ones", () => {
  const out = copilotUsage(
    {
      quotaSnapshots: {
        chat: quotaOf({ entitlementRequests: 50, usedRequests: 20, remainingPercentage: 60 }),
        completions: quotaOf({ hasQuota: false }),
        premium_interactions: quotaOf({ entitlementRequests: 1000000, usedRequests: 5000, remainingPercentage: 99.5, tokenBasedBilling: true }),
        agent_sessions: quotaOf({ entitlementRequests: 10, usedRequests: 1, remainingPercentage: 90 }),
        broken: null,
      },
    },
    { copilot_plan: "free" },
    { now: NOW },
  );
  assert.deepEqual(out.limits.map((limit) => [limit.id, limit.label, limit.percentRemaining, limit.used, limit.limit, limit.unit]), [
    ["premium", "Premium requests", 99.5, 5000, 1000000, "credits"],
    ["chat", "Chat", 60, 20, 50, "requests"],
    ["agent-sessions", "Agent sessions", 90, 1, 10, "requests"],
  ]);
  assert.throws(() => copilotUsage({}, null), /didn't say anything/);
});

// ---- The common shape ----

test("times are read from ISO text, seconds and milliseconds, and nothing else", () => {
  assert.equal(instant("2026-12-01T00:00:00.000Z"), 1796083200000);
  assert.equal(instant(1795630138), 1795630138000);
  assert.equal(instant(1795630138000), 1795630138000);
  for (const bad of [0, -5, null, undefined, "", "soon", NaN, {}]) assert.equal(instant(bad), undefined, String(bad));
});

test("the common shape fills in both percents, marks one limit primary and leaves out what isn't real", () => {
  const out = normalizeUsage(
    {
      plan: " Claude Max 20x ",
      account: "subscription",
      source: "Claude Code",
      limits: [
        { id: "session", label: "5-hour session", window: "session", percentUsed: 20, resetAt: NOW + 3600_000 },
        { id: "weekly", label: "Weekly, all models", window: "week", percentUsed: 34.04, resetAt: NOW + 86400_000 },
        { id: "weekly-fable", label: "Weekly, Fable", window: "week", percentUsed: 90, model: "Fable" },
        { id: "premium", label: "Premium requests", window: "month", percentRemaining: 140, used: 5, limit: 10, unit: "requests", resetAt: NOW - 1000 },
        { id: "chat", label: "Chat", unlimited: true, percentRemaining: 100 },
        { id: "weekly", label: "Twice" },
        { id: "odd", label: "Odd", percentUsed: "many", window: "year", unit: "tokens", used: 3 },
        { label: "No id", percentUsed: 1 },
        null,
      ],
      credits: { label: "Credits", amount: 12.5, unit: "credits" },
    },
    { now: NOW },
  );
  assert.deepEqual(out, {
    plan: "Claude Max 20x",
    account: "subscription",
    limits: [
      { id: "session", label: "5-hour session", percentRemaining: 80, percentUsed: 20, resetAt: NOW + 3600_000, window: "session" },
      { id: "weekly", label: "Weekly, all models", percentRemaining: 66, percentUsed: 34, resetAt: NOW + 86400_000, window: "week", primary: true },
      { id: "weekly-fable", label: "Weekly, Fable", percentRemaining: 10, percentUsed: 90, window: "week", model: "Fable" },
      { id: "premium", label: "Premium requests", percentRemaining: 100, percentUsed: 0, window: "month", used: 5, limit: 10, unit: "requests" },
      { id: "chat", label: "Chat", unlimited: true },
      { id: "odd", label: "Odd" },
    ],
    credits: { label: "Credits", amount: 12.5, unit: "credits" },
    source: "Claude Code",
  });
});

test("the primary limit is the one with the least left among those that count every model", () => {
  const primary = (limits) => normalizeUsage({ limits }, { now: NOW }).limits.find((limit) => limit.primary)?.id;
  assert.equal(primary([{ id: "session", label: "S", window: "session", percentUsed: 95 }, { id: "weekly", label: "W", window: "week", percentUsed: 30 }]), "session");
  assert.equal(primary([{ id: "session", label: "S", window: "session", percentUsed: 30 }, { id: "weekly", label: "W", window: "week", percentUsed: 30 }]), "weekly", "the weekly one on a tie");
  assert.equal(primary([{ id: "weekly-opus", label: "O", window: "week", percentUsed: 99, model: "Opus" }, { id: "weekly", label: "W", window: "week", percentUsed: 1 }]), "weekly", "never a limit of one model");
  assert.equal(primary([{ id: "chat", label: "Chat", unlimited: true }, { id: "x", label: "X" }]), undefined, "none without a percent");
  assert.deepEqual(normalizeUsage(null), { limits: [] });
  assert.deepEqual(normalizeUsage({ account: "team", limits: "many", credits: { amount: "5" } }), { limits: [] });
});

// ---- Keeping answers and reading again ----

/** A registry of stand-in providers and a service on a clock the test moves. */
function rig(t, { file = false, usage = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-provider-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { now: NOW };
  const calls = [];
  const state = {
    statuses: [
      { id: "claude", name: "Claude", enabled: true, connected: true, account: "someone", plan: "Claude Max 20x" },
      { id: "codex", name: "ChatGPT", enabled: true, connected: true, account: "someone", plan: "ChatGPT Pro" },
      { id: "opencode", name: "OpenCode", enabled: true, connected: true },
      { id: "copilot", name: "GitHub Copilot", enabled: true, connected: false },
      { id: "acp", name: "Other", enabled: false, connected: false },
    ],
    usage: {
      claude: async () => ({ plan: "Claude Max 20x", account: "subscription", source: "Claude Code", limits: [{ id: "weekly", label: "Weekly", window: "week", percentUsed: 34, resetAt: NOW + 86400_000 }] }),
      codex: async () => ({ plan: "ChatGPT Pro", account: "subscription", source: "Codex", limits: [{ id: "weekly", label: "Weekly", window: "week", percentUsed: 8 }] }),
      opencode: async () => null,
      ...usage,
    },
  };
  const providers = {
    statuses: async () => state.statuses,
    require: (id) => ({ id, name: state.statuses.find((status) => status.id === id).name, usage: () => (calls.push(id), state.usage[id]()) }),
  };
  let changed = 0;
  const path = file ? join(dir, "provider-usage.json") : null;
  const make = () => new ProviderUsage({ providers, file: path, now: () => clock.now, changed: () => changed++, waitMs: 200 });
  return { service: make(), make, clock, calls, state, path, changes: () => changed };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("only providers that are switched on and connected are listed, each with its plan, limits and when they were read", async (t) => {
  const { service, calls } = rig(t);
  assert.equal(PROVIDER_USAGE, "provider-usage-v1");
  const list = await service.list();
  assert.deepEqual(list.map((entry) => entry.provider), ["claude", "codex", "opencode"]);
  assert.deepEqual(list[0], {
    provider: "claude",
    name: "Claude",
    plan: "Claude Max 20x",
    account: "subscription",
    limits: [{ id: "weekly", label: "Weekly", percentRemaining: 66, percentUsed: 34, resetAt: NOW + 86400_000, window: "week", primary: true }],
    source: "Claude Code",
    updatedAt: NOW,
  });
  assert.deepEqual(list[2], { provider: "opencode", name: "OpenCode", limits: [], note: "OpenCode doesn't report plan limits.", updatedAt: NOW }, "a provider that can't say is listed with no limits and no error");
  assert.deepEqual(calls.sort(), ["claude", "codex", "opencode"]);
});

test("a second call answers from what is known, an old answer is read again behind it, and a refresh reads now", async (t) => {
  const { service, calls, clock, changes } = rig(t);
  await service.list();
  calls.length = 0;
  clock.now += 60_000;
  await service.list();
  assert.deepEqual(calls, [], "a minute-old answer is not asked for again");
  clock.now += 120_000;
  const stale = await service.list();
  assert.equal(stale[0].updatedAt, NOW, "the old answer is what comes back");
  await settle();
  assert.deepEqual(calls.sort(), ["claude", "codex", "opencode"], "and each provider was read again behind it");
  assert.equal(changes(), 3, "the window is told when each has come in");
  assert.equal((await service.list())[0].updatedAt, clock.now);
  calls.length = 0;
  clock.now += 30_000;
  const fresh = await service.list({ refresh: true });
  assert.deepEqual(calls.sort(), ["claude", "codex", "opencode"]);
  assert.equal(fresh[1].updatedAt, clock.now);
  calls.length = 0;
  clock.now += 2_000;
  await service.list({ refresh: true });
  assert.deepEqual(calls, [], "asking again within seconds reads nothing: a provider isn't hammered");
});

test("a failed read keeps the last numbers with their age and says what went wrong", async (t) => {
  const { service, state, clock } = rig(t);
  await service.list();
  state.usage.claude = async () => {
    throw new Error("Claude Code closed before it answered.");
  };
  clock.now += 600_000;
  const [claude] = await service.list({ refresh: true });
  assert.equal(claude.error, "Couldn't read Claude's limits: Claude Code closed before it answered.");
  assert.equal(claude.updatedAt, NOW, "the numbers are the earlier ones, with the time they were read");
  assert.equal(claude.limits[0].percentRemaining, 66);
  state.usage.claude = async () => ({ account: "subscription", limits: [{ id: "weekly", label: "Weekly", percentUsed: 50 }] });
  clock.now += 60_000;
  const [again] = await service.list({ refresh: true });
  assert.equal(again.error, undefined);
  assert.equal(again.limits[0].percentRemaining, 50);
});

test("a provider that never answered is listed with the failure and no numbers", async (t) => {
  const { service, clock, calls } = rig(t, { usage: { codex: async () => Promise.reject(new Error("no app server")) } });
  const list = await service.list();
  assert.deepEqual(list[1], { provider: "codex", name: "ChatGPT", limits: [], error: "Couldn't read ChatGPT's limits: no app server." });
  calls.length = 0;
  clock.now += 5_000;
  await service.list();
  assert.ok(!calls.includes("codex"), "and it isn't asked again within seconds");
  clock.now += 10_000;
  await service.list();
  assert.ok(calls.includes("codex"));
});

test("a provider that is slow to answer doesn't hold the others up", async (t) => {
  let finish;
  const { service, changes } = rig(t, { usage: { claude: () => new Promise((resolve) => (finish = () => resolve({ account: "subscription", limits: [{ id: "weekly", label: "Weekly", percentUsed: 10 }] }))) } });
  const list = await service.list();
  assert.deepEqual(list[0], { provider: "claude", name: "Claude", limits: [], error: "Claude hasn't answered yet." });
  assert.equal(list[1].limits[0].percentRemaining, 92);
  finish();
  await settle();
  assert.equal(changes(), 1, "the window is told when it has");
  assert.equal((await service.list())[0].limits[0].percentRemaining, 90);
});

test("a reset time that has passed is no longer shown, and another account's numbers are dropped", async (t) => {
  const { service, clock, state, calls } = rig(t);
  await service.list();
  clock.now += 100_000;
  assert.equal((await service.list())[0].limits[0].resetAt, NOW + 86400_000);
  clock.now = NOW + 86400_000 + 1;
  const late = service.view(state.statuses[0]);
  assert.equal(late.limits[0].resetAt, undefined);
  assert.equal(late.limits[0].percentRemaining, 66, "the last number is still shown, with its age");
  state.statuses[0] = { ...state.statuses[0], account: "someone else" };
  state.usage.claude = async () => ({ account: "subscription", limits: [{ id: "weekly", label: "Weekly", percentUsed: 1 }] });
  calls.length = 0;
  const [other] = await service.list();
  assert.ok(calls.includes("claude"), "a different account is read at once");
  assert.equal(other.limits[0].percentRemaining, 99);
});

test("the last answers are kept in a file without anything that says whose they are, and shown when the app opens again", async (t) => {
  const { service, make, path, clock, calls, state } = rig(t, { file: true });
  state.statuses[0].account = "person@example.com";
  await service.list();
  const kept = readFileSync(path, "utf8");
  assert.ok(!kept.includes("example.com") && !kept.includes("someone"), "no account name is written");
  assert.deepEqual(Object.keys(JSON.parse(kept)).sort(), ["claude", "codex", "opencode"]);
  clock.now += 3600_000;
  calls.length = 0;
  const reopened = make();
  const [claude] = await reopened.list();
  assert.equal(claude.updatedAt, NOW, "the kept answer comes back with the time it was read");
  assert.equal(claude.limits[0].percentRemaining, 66);
  await settle();
  assert.ok(calls.includes("claude"), "and is read again behind it");
  writeFileSync(path, "{ not json");
  assert.deepEqual((await make().list()).map((entry) => entry.provider), ["claude", "codex", "opencode"], "a file that can't be read is the same as none");
  reopened.forget("claude");
  assert.ok(!Object.keys(JSON.parse(readFileSync(path, "utf8"))).includes("claude"));
});
