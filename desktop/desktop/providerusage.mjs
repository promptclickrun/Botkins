// Each connected model provider's plan and what is left of its limits (docs/PROVIDER_USAGE.md).
//
// Every number here was said by the provider's own tool, with the sign-in that tool already has:
//
//   Claude          Claude Code's `get_usage` (the data behind its /usage), read from Anthropic
//   ChatGPT         the Codex app server's `account/rateLimits/read`
//   GitHub Copilot  the Copilot runtime's `account.getQuota`, and the plan of the signed-in account
//
// A provider's adapter reads it (ModelProvider.usage) and hands over what the functions below make
// of the answer. Nothing in this file is a default and nothing may become one: a value the
// provider didn't state is left out, and a limit without a percent is shown without a bar. No
// token, email or account id is read into an answer, kept in the file or logged.
//
// One entry, as the window and a paired phone get it (the call `providerUsage`):
//
//   { provider, name, plan?, account?: "subscription" | "api-key", limits: [...], credits?,
//     note?, source?, updatedAt?, error? }
//   limit: { id, label, percentRemaining?, percentUsed?, resetAt?, primary?, window?, model?,
//            used?, limit?, unit?, unlimited? }
//
// Times are milliseconds since 1970.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PROVIDER_USAGE = "provider-usage-v1";

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const round = (value) => Math.round(value * 10) / 10;
/** A percentage between 0 and 100 with one decimal, or undefined for anything that isn't a number. */
const percent = (value) => {
  const n = number(typeof value === "string" && value.trim() ? Number(value) : value);
  return n === undefined ? undefined : round(Math.min(100, Math.max(0, n)));
};
const text = (value, most = 80) => (typeof value === "string" && value.trim() ? value.trim().slice(0, most) : undefined);
const slug = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const words = (value) => String(value ?? "").replace(/[_-]+/g, " ").trim();
const capital = (value) => value.charAt(0).toUpperCase() + value.slice(1);

/** Milliseconds since 1970 from a date as a provider writes one: ISO text, seconds or milliseconds. */
export function instant(value) {
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value);
    return Number.isFinite(time) && time > 0 ? time : undefined;
  }
  const n = number(value);
  if (n === undefined || n <= 0) return undefined;
  // Seconds reach this size in the year 5138; milliseconds passed it in 1973.
  return Math.round(n < 1e11 ? n * 1000 : n);
}

// ---- Claude ----

const CLAUDE_PLANS = { pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise", free: "Claude Free" };
/**
 * A Claude plan's name from what Claude Code says about the sign-in (`claude auth status --json`):
 * `subscriptionType` ("max") and, where there is one, `planTier` ("max_20x").
 */
export function claudePlan(subscriptionType, planTier) {
  const subscription = String(subscriptionType ?? "").toLowerCase().trim();
  const base = CLAUDE_PLANS[subscription] ?? (subscription ? "Claude " + capital(subscription) : "Claude plan");
  const times = /(?:^|_)(\d{1,3})x$/.exec(String(planTier ?? "").toLowerCase())?.[1];
  return times ? base + " " + times + "x" : base;
}

/**
 * What Claude Code's `get_usage` reply says about the plan's limits. `utilization` is the percent
 * of a window that is used. A window Anthropic doesn't report (null) is left out.
 */
export function claudeUsage(reply) {
  if (!reply || typeof reply !== "object") throw new Error("Claude Code didn't say anything about usage.");
  const limits = reply.rate_limits && typeof reply.rate_limits === "object" ? reply.rate_limits : null;
  // Claude Code says so itself when plan limits don't apply (an API key, Bedrock, Vertex).
  if (reply.rate_limits_available === false || !limits)
    return reply.subscription_type ? { account: "subscription", limits: [], note: "Anthropic didn't report this plan's limits." } : { account: "api-key", limits: [] };
  const out = [];
  const add = (id, label, window, entry, more) => {
    if (!entry || typeof entry !== "object" || out.some((limit) => limit.id === id)) return;
    const used = percent(entry.utilization);
    const resetAt = instant(entry.resets_at);
    if (used === undefined && resetAt === undefined) return;
    out.push({ id, label, window, ...(used !== undefined && { percentUsed: used }), ...(resetAt && { resetAt }), ...more });
  };
  const models = (Array.isArray(limits.model_scoped) ? limits.model_scoped : []).filter((row) => text(row?.display_name));
  const perModel = models.length > 0 || !!limits.seven_day_opus || !!limits.seven_day_sonnet;
  add("session", "5-hour session", "session", limits.five_hour);
  add("weekly", perModel ? "Weekly, all models" : "Weekly", "week", limits.seven_day);
  for (const row of models) {
    const model = text(row.display_name, 40);
    add("weekly-" + slug(model), "Weekly, " + model, "week", row, { model });
  }
  add("weekly-opus", "Weekly, Opus", "week", limits.seven_day_opus, { model: "Opus" });
  add("weekly-sonnet", "Weekly, Sonnet", "week", limits.seven_day_sonnet, { model: "Sonnet" });
  // Paid extra usage has a monthly cap of its own. Its amounts are left out: only the percent is unambiguous.
  if (limits.extra_usage?.is_enabled === true) add("extra", "Extra usage", "month", { utilization: limits.extra_usage.utilization });
  return { account: "subscription", limits: out };
}

// ---- ChatGPT (Codex) ----

/** A Codex limit window by its length in minutes. */
function codexWindow(minutes) {
  const m = number(minutes);
  if (!m || m <= 0) return null;
  if (m === 300) return { id: "session", label: "5-hour session", window: "session" };
  if (m === 10080) return { id: "weekly", label: "Weekly", window: "week" };
  if (m >= 40320 && m <= 44640) return { id: "monthly", label: "Monthly", window: "month" };
  if (m === 1440) return { id: "daily", label: "Daily" };
  if (m % 1440 === 0) return { id: m / 1440 + "-day", label: m / 1440 + "-day window" };
  if (m % 60 === 0) return { id: m / 60 + "-hour", label: m / 60 + "-hour window" };
  return { id: m + "-minute", label: m + "-minute window" };
}

/**
 * What the Codex app server's `account/rateLimits/read` says: up to two windows per limit, each
 * with the percent used, its length and when it resets; more limits by id where a model is
 * counted by itself; and a bought credit balance.
 */
export function codexUsage(reply) {
  const main = reply?.rateLimits && typeof reply.rateLimits === "object" ? reply.rateLimits : null;
  if (!main) throw new Error("Codex didn't say anything about limits.");
  const out = [];
  const take = (snapshot, model) => {
    for (const key of ["primary", "secondary"]) {
      const window = snapshot?.[key];
      if (!window || typeof window !== "object") continue;
      const used = percent(window.usedPercent);
      const resetAt = instant(window.resetsAt);
      if (used === undefined && resetAt === undefined) continue;
      const named = codexWindow(window.windowDurationMins) ?? { id: key, label: key === "primary" ? "Usage limit" : "Second usage limit" };
      const id = model ? named.id + "-" + slug(model) : named.id;
      if (out.some((limit) => limit.id === id)) continue;
      out.push({
        id,
        label: model ? named.label + ", " + model : named.label,
        ...(named.window && { window: named.window }),
        ...(used !== undefined && { percentUsed: used }),
        ...(resetAt && { resetAt }),
        ...(model && { model }),
      });
    }
  };
  take(main);
  const others = reply.rateLimitsByLimitId && typeof reply.rateLimitsByLimitId === "object" ? reply.rateLimitsByLimitId : {};
  for (const [id, snapshot] of Object.entries(others)) {
    if (!snapshot || typeof snapshot !== "object" || id === main.limitId) continue;
    take(snapshot, text(snapshot.limitName, 40) ?? words(id).slice(0, 40));
  }
  const balance = main.credits?.hasCredits === true && main.credits.unlimited !== true ? Number(main.credits.balance) : NaN;
  return {
    account: "subscription",
    planType: text(main.planType, 40),
    limits: out,
    ...(Number.isFinite(balance) && balance >= 0 && { credits: { label: "Credits", amount: Math.round(balance * 100) / 100, unit: "credits" } }),
  };
}

// ---- GitHub Copilot ----

const COPILOT_PLANS = {
  free: "GitHub Copilot Free",
  individual: "GitHub Copilot Pro",
  individual_pro: "GitHub Copilot Pro+",
  business: "GitHub Copilot Business",
  enterprise: "GitHub Copilot Enterprise",
};
/** A Copilot plan's name from the signed-in account's `copilot_plan`, or undefined when it has none. */
export function copilotPlan(value) {
  const plan = String(value ?? "").toLowerCase().trim();
  if (!plan) return undefined;
  return COPILOT_PLANS[plan] ?? "GitHub Copilot " + capital(words(plan)).slice(0, 40);
}
const COPILOT_QUOTAS = { premium_interactions: ["premium", "Premium requests"], chat: ["chat", "Chat"], completions: ["completions", "Code completions"] };

/**
 * What the Copilot runtime's `account.getQuota` says, with the signed-in account (`copilotUser` of
 * `account.getCurrentAuth`) for the plan and the month's reset date.
 *
 * A quota's own `resetDate` is the time of the call when GitHub gives no reset for it, so it only
 * counts when it lies ahead; the account's `quota_reset_date_utc` is taken first.
 */
export function copilotUsage(quota, user, { now = Date.now() } = {}) {
  const snapshots = quota?.quotaSnapshots && typeof quota.quotaSnapshots === "object" ? quota.quotaSnapshots : null;
  if (!snapshots) throw new Error("GitHub Copilot didn't say anything about its quota.");
  const monthly = instant(user?.quota_reset_date_utc) ?? instant(user?.quota_reset_date);
  const keys = [...Object.keys(COPILOT_QUOTAS), ...Object.keys(snapshots).filter((key) => !COPILOT_QUOTAS[key]).sort()];
  const out = [];
  for (const key of keys) {
    const snapshot = snapshots[key];
    if (!snapshot || typeof snapshot !== "object" || snapshot.hasQuota === false) continue;
    const [id, label] = COPILOT_QUOTAS[key] ?? [slug(key), capital(words(key)).slice(0, 60)];
    if (!id) continue;
    if (snapshot.isUnlimitedEntitlement === true) {
      out.push({ id, label, window: "month", unlimited: true });
      continue;
    }
    const remaining = percent(snapshot.remainingPercentage);
    const limit = number(snapshot.entitlementRequests) > 0 ? snapshot.entitlementRequests : undefined;
    const used = limit !== undefined && number(snapshot.usedRequests) >= 0 ? snapshot.usedRequests : undefined;
    if (remaining === undefined && limit === undefined) continue;
    const own = instant(snapshot.resetDate);
    const resetAt = monthly ?? (own !== undefined && own > now + 60_000 ? own : undefined);
    out.push({
      id,
      label,
      window: "month",
      ...(remaining !== undefined && { percentRemaining: remaining }),
      ...(resetAt && { resetAt }),
      ...(used !== undefined && { used, limit, unit: snapshot.tokenBasedBilling === true ? "credits" : "requests" }),
    });
  }
  const plan = copilotPlan(user?.copilot_plan);
  return { account: "subscription", ...(plan && { plan }), limits: out };
}

// ---- The common shape ----

const WINDOWS = ["session", "week", "month"];
const UNITS = ["requests", "credits"];

/**
 * A provider's answer in the one shape every screen reads. Anything that isn't a real value is
 * left out, both percents are filled in from whichever was given, a reset time that has passed
 * is dropped, and one limit is marked `primary`: of the limits that count every model, the one
 * with the least left (the weekly one when two have the same).
 */
export function normalizeUsage(raw, { now = Date.now() } = {}) {
  const limits = [];
  for (const item of Array.isArray(raw?.limits) ? raw.limits : []) {
    const id = text(item?.id, 60);
    const label = text(item?.label, 80);
    if (!id || !label || limits.some((limit) => limit.id === id)) continue;
    const unlimited = item.unlimited === true;
    let remaining = unlimited ? undefined : percent(item.percentRemaining);
    let used = unlimited ? undefined : percent(item.percentUsed);
    if (remaining === undefined && used !== undefined) remaining = round(100 - used);
    if (remaining !== undefined) used = round(100 - remaining);
    const resetAt = instant(item.resetAt);
    const most = number(item.limit) > 0 ? item.limit : undefined;
    const count = most !== undefined && number(item.used) >= 0 ? item.used : undefined;
    const model = text(item.model, 40);
    limits.push({
      id,
      label,
      ...(remaining !== undefined && { percentRemaining: remaining, percentUsed: used }),
      ...(resetAt !== undefined && resetAt > now && { resetAt }),
      ...(WINDOWS.includes(item.window) && { window: item.window }),
      ...(model && { model }),
      ...(count !== undefined && { used: count, limit: most, ...(UNITS.includes(item.unit) && { unit: item.unit }) }),
      ...(unlimited && { unlimited: true }),
    });
  }
  const rank = { week: 0, session: 1, month: 2 };
  const first = limits
    .filter((limit) => limit.percentRemaining !== undefined && !limit.model)
    .sort((a, b) => a.percentRemaining - b.percentRemaining || (rank[a.window] ?? 3) - (rank[b.window] ?? 3))[0];
  if (first) first.primary = true;
  const plan = text(raw?.plan, 60);
  const note = text(raw?.note, 200);
  const source = text(raw?.source, 60);
  const amount = number(raw?.credits?.amount);
  return {
    ...(plan && { plan }),
    ...((raw?.account === "subscription" || raw?.account === "api-key") && { account: raw.account }),
    limits,
    ...(amount !== undefined && amount >= 0 && text(raw.credits.label, 40) && { credits: { label: text(raw.credits.label, 40), amount, unit: text(raw.credits.unit, 20) ?? "credits" } }),
    ...(note && { note }),
    ...(source && { source }),
  };
}

/** Resolves with `value` after `ms` unless `promise` settles first. */
const within = (promise, ms, value) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(value), ms)))]).finally(() => clearTimeout(timer));
};
const WAITING = Symbol("waiting");
/** Whose numbers these are, without keeping who that is: a short digest of the signed-in account. */
const whoOf = (status) => createHash("sha256").update(String(status.account ?? "") + "\n" + String(status.plan ?? "")).digest("hex").slice(0, 12);

/**
 * Reads every connected provider's usage, remembers the answers (in `file`, so there is something
 * to show the moment the app opens, with its age) and reads again when they are old.
 */
export class ProviderUsage {
  /**
   * @param options.providers  The registry (desktop/providers Providers).
   * @param options.file       Where the last answers are kept. Omit to keep them for this run only.
   * @param options.freshMs    An answer older than this is read again in the background when asked for.
   * @param options.againMs    The least time between two reads of one provider, also when a refresh is asked for.
   * @param options.waitMs     How long a call waits for a provider before it answers without it.
   * @param options.changed    Called when a read that nobody waited for has come in.
   */
  constructor({ providers, file = null, now = () => Date.now(), freshMs = 120_000, againMs = 10_000, waitMs = 25_000, changed = () => {} }) {
    Object.assign(this, { providers, file, now, freshMs, againMs, waitMs, changed });
    this.entries = new Map();
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const [id, entry] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
        const updatedAt = instant(entry?.updatedAt);
        if (!updatedAt || typeof entry.who !== "string") continue;
        // Read through the same checks as a fresh answer; never asked about at once (checkedAt 0).
        this.entries.set(id, { value: normalizeUsage(entry.value, { now: 0 }), updatedAt, who: entry.who, checkedAt: 0 });
      }
    } catch {
      // Nothing kept yet.
    }
  }
  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const kept = Object.fromEntries([...this.entries].filter(([, entry]) => entry.value && entry.updatedAt).map(([id, entry]) => [id, { value: entry.value, updatedAt: entry.updatedAt, who: entry.who }]));
      writeFileSync(this.file, JSON.stringify(kept, null, 2));
    } catch {
      // Kept for this run.
    }
  }
  /** Forgets what one provider said (or all), after a sign-in, a sign-out or a switch. */
  forget(id) {
    id ? this.entries.delete(id) : this.entries.clear();
    this.save();
  }
  /** Asks one provider now. Everyone who asks while it is being read shares the one read. */
  read(status) {
    const id = status.id;
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, (entry = { checkedAt: 0 }));
    if (entry.loading) return entry.loading;
    const provider = this.providers.require(id);
    const who = whoOf(status);
    const started = this.now();
    entry.loading = Promise.resolve()
      .then(() => provider.usage())
      .then(
        (raw) => {
          const value = normalizeUsage(raw ?? { limits: [], note: provider.name + " doesn't report plan limits." }, { now: this.now() });
          Object.assign(entry, { value, updatedAt: this.now(), who, error: undefined });
          this.save();
        },
        (error) => {
          const message = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
          console.error(provider.name + " usage:", message);
          entry.error = "Couldn't read " + provider.name + "'s limits" + (message ? ": " + message.replace(/[.!]+$/, "") + "." : ".");
        },
      )
      .finally(() => {
        entry.checkedAt = Math.max(started, this.now());
        entry.loading = null;
      });
    return entry.loading;
  }
  /**
   * Every provider that is switched on and connected, with its plan and limits. Without `refresh`
   * the answer is what is known (a provider never asked is asked first), and an old answer is
   * read again behind it; with `refresh` every provider is read again now.
   */
  async list({ refresh = false } = {}) {
    const statuses = (await this.providers.statuses()).filter((status) => status.enabled && status.connected);
    return Promise.all(
      statuses.map(async (status) => {
        let entry = this.entries.get(status.id);
        // Another account's numbers are nobody's to show.
        if (entry?.value && entry.who !== whoOf(status)) this.entries.delete(status.id), (entry = undefined);
        const age = this.now() - (entry?.checkedAt ?? 0);
        if (refresh === true || !entry?.value) {
          if (entry?.loading || age >= this.againMs) {
            const loading = this.read(status);
            if ((await within(loading, this.waitMs, WAITING)) === WAITING) loading.then(() => this.changed());
          }
        } else if (age >= this.freshMs) this.read(status).then(() => this.changed());
        return this.view(status);
      }),
    );
  }
  /** One provider's entry as it is known now, without asking. */
  view(status) {
    const entry = this.entries.get(status.id) ?? {};
    const now = this.now();
    const value = entry.value ?? { limits: [] };
    return {
      provider: status.id,
      name: status.name,
      ...value,
      // A window that has reset since it was read no longer says when.
      limits: value.limits.map((limit) => (limit.resetAt !== undefined && limit.resetAt <= now ? (({ resetAt: _gone, ...rest }) => rest)(limit) : limit)),
      ...(entry.value && entry.updatedAt && { updatedAt: entry.updatedAt }),
      ...(entry.error ? { error: entry.error } : !entry.value && entry.loading && { error: status.name + " hasn't answered yet." }),
    };
  }
}
