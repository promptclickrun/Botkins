// Pure GitHub workflow UI helpers shared in spirit across desktop and mobile:
// - Owner-grouped multi-repo picker helpers
// - Color-coded label catalog helpers (preserving selected labels across overlapping repo changes)
// - Inline access alert derivation (missing / readOnly / eventsOff)
// - Delivery log grouping (waiting / started / skipped) with skip-reason metadata and replayable event lookup
// - GitHub output step metadata & PR-only action guard

export interface WorkflowGithubRepoAccess {
  fullName: string;
  writable?: boolean;
  events?: boolean;
  isPrivate?: boolean;
}

export interface WorkflowGithubLabelOption {
  name: string;
  color: string;
  description?: string;
}

export interface WorkflowGithubAssigneeOption {
  login: string;
  type?: string;
}

export interface WorkflowGithubCatalog {
  repos: string[];
  labels: WorkflowGithubLabelOption[];
  assignees: WorkflowGithubAssigneeOption[];
}

export type WorkflowGithubDeliveryOutcome = "waiting" | "started" | "skipped";
export type WorkflowGithubSkipReason = "filter" | "self" | "chain" | "offline" | "refused";

export interface WorkflowGithubDelivery {
  workflowId: string;
  nodeId: string;
  deliveryId: string;
  event: string;
  repository: string | null;
  number: number | null;
  pullRequest: boolean | null;
  title: string | null;
  url?: string | null;
  receivedAt: string;
  outcome: WorkflowGithubDeliveryOutcome;
  reason: WorkflowGithubSkipReason | null;
  reasonDetail?: string | null;
  runId: string | null;
  waitsForRunId?: string | null;
  replayable?: boolean;
}

export interface RepoGroup {
  owner: string;
  repos: string[];
}

export type GithubAccessAlertKind = "missing" | "readOnly" | "eventsOff";

export interface GithubAccessAlert {
  kind: GithubAccessAlertKind;
  repos: string[];
  title: string;
  detail: string;
  action: "connect" | "reconnect" | "github";
}

export interface DeliveryGroup {
  outcome: WorkflowGithubDeliveryOutcome;
  label: string;
  items: WorkflowGithubDelivery[];
}

export type WorkflowGithubAction =
  | "comment"
  | "label.add"
  | "label.remove"
  | "assign"
  | "review.request"
  | "review.approve"
  | "review.changes"
  | "close"
  | "reopen"
  | "issue.create";

export const WORKFLOW_GITHUB_EVENT_GROUPS: Array<{
  group: string;
  events: Array<{ value: string; label: string; hint: string }>;
}> = [
  {
    group: "Issues",
    events: [
      { value: "issue.opened", label: "Issue opened", hint: "New issue created" },
      { value: "issue.closed", label: "Issue closed", hint: "Issue closed" },
      { value: "issue.labeled", label: "Issue labeled", hint: "Label added to an issue" },
    ],
  },
  {
    group: "Pull requests",
    events: [
      { value: "pr.opened", label: "PR opened", hint: "New pull request" },
      { value: "pr.updated", label: "PR updated", hint: "New commits pushed to PR" },
      { value: "pr.reviewRequested", label: "Review requested", hint: "Reviewer requested on PR" },
      { value: "pr.reviewSubmitted", label: "Review submitted", hint: "PR review submitted" },
      { value: "pr.checksFailed", label: "Checks failed", hint: "CI check suite failed or timed out" },
      { value: "pr.merged", label: "PR merged", hint: "Pull request merged" },
    ],
  },
  {
    group: "Both",
    events: [
      { value: "comment", label: "Comment", hint: "New issue or PR comment" },
      { value: "mention", label: "Mention", hint: "Configured @handle mentioned" },
      { value: "assigned", label: "Assigned", hint: "Issue or PR assigned" },
    ],
  },
];

export const WORKFLOW_GITHUB_EVENT_LABELS: Record<string, string> = Object.fromEntries(
  WORKFLOW_GITHUB_EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e.value, e.label])),
);

export const LEGACY_EVENT_TO_CANONICAL: Record<string, string[]> = {
  pr_opened: ["pr.opened"],
  pr_updated: ["pr.updated", "pr.merged"],
  pr_review: ["pr.reviewSubmitted"],
  ci_status: ["pr.checksFailed"],
  issue_opened: ["issue.opened"],
  issue_updated: ["issue.closed", "issue.labeled"],
  issue_comment: ["comment"],
  user_mentioned: ["mention"],
  bot_mentioned: ["mention"],
};

export const WORKFLOW_GITHUB_ACTION_OPTIONS: Array<{
  value: WorkflowGithubAction;
  label: string;
  hint: string;
  prOnly?: boolean;
  needsBody?: boolean;
  optionalBody?: boolean;
  needsTitle?: boolean;
  usesLabels?: boolean;
  usesAssignees?: boolean;
  usesReviewers?: boolean;
  usesCloseReason?: boolean;
}> = [
  { value: "comment", label: "Post comment", hint: "Comment on the issue or PR", needsBody: true },
  { value: "label.add", label: "Add labels", hint: "Add one or more labels", usesLabels: true },
  { value: "label.remove", label: "Remove labels", hint: "Remove labels (404 safe)", usesLabels: true },
  { value: "assign", label: "Assign people", hint: "Add assignees to the issue or PR", usesAssignees: true },
  { value: "review.request", label: "Request review", hint: "Request PR reviewers", prOnly: true, usesReviewers: true },
  { value: "review.approve", label: "Approve PR", hint: "Submit an APPROVE review", prOnly: true, optionalBody: true },
  { value: "review.changes", label: "Request changes", hint: "Submit REQUEST_CHANGES review", prOnly: true, needsBody: true },
  { value: "close", label: "Close item", hint: "Close the issue or PR", usesCloseReason: true },
  { value: "reopen", label: "Reopen item", hint: "Reopen a closed issue or PR" },
  { value: "issue.create", label: "Create issue", hint: "Open a new issue", needsTitle: true, optionalBody: true, usesLabels: true, usesAssignees: true },
];

export const PR_ONLY_ACTIONS = new Set<WorkflowGithubAction>([
  "review.request",
  "review.approve",
  "review.changes",
]);

export const SKIP_REASON_META: Record<WorkflowGithubSkipReason, { label: string; description: string }> = {
  filter: { label: "Filtered out", description: "Did not match trigger filters" },
  self: { label: "Self-loop guard", description: "Caused by this workflow's own GitHub action" },
  chain: { label: "Chain cap", description: "Hit 3 bot-caused runs in 10 minutes for this item" },
  offline: { label: "Offline gap", description: "Relay was disconnected during this window" },
  refused: { label: "Refused", description: "Refused by host policy or paused workflow" },
};

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const HEX_COLOR_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/** Extracts deduplicated, trimmed `owner/repo` strings from a trigger node config (`repos` / `repositories` / `repo`). */
export function extractConfiguredRepos(config: Record<string, any> | null | undefined): string[] {
  const candidates: string[] = [];
  const push = (val: unknown) => {
    if (Array.isArray(val)) {
      for (const item of val) candidates.push(String(item ?? ""));
    } else if (typeof val === "string" && val.trim()) {
      for (const part of val.split(/[\n,]+/)) candidates.push(part);
    }
  };
  push(config?.repos);
  push(config?.repositories);
  push(config?.repo);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const cleaned = raw.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned || !REPO_RE.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 100) break;
  }
  return out;
}

/** Normalizes configured event names into canonical event IDs (mapping legacy names cleanly). */
export function extractCanonicalEvents(rawEvents: unknown): string[] {
  const list = Array.isArray(rawEvents)
    ? rawEvents.map((s) => String(s ?? "").trim()).filter(Boolean)
    : typeof rawEvents === "string" && rawEvents.trim()
      ? rawEvents.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  if (!list.length) return ["issue.opened"];
  const knownByLower = new Map(Object.keys(WORKFLOW_GITHUB_EVENT_LABELS).map((k) => [k.toLowerCase(), k]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const low = raw.toLowerCase();
    const canonical = knownByLower.get(low);
    if (canonical) {
      if (!seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
      continue;
    }
    const mapped = LEGACY_EVENT_TO_CANONICAL[low];
    if (mapped) {
      for (const ev of mapped) {
        if (!seen.has(ev)) {
          seen.add(ev);
          out.push(ev);
        }
      }
    }
  }
  return out.length ? out : ["issue.opened"];
}

/**
 * Groups `owner/repo` strings alphabetically by owner (case-insensitive), deduplicating
 * case-insensitively and applying an optional search query over `owner/repo`.
 */
export function groupReposByOwner(repos: readonly string[], query = ""): RepoGroup[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const byOwner = new Map<string, { owner: string; repos: string[] }>();

  for (const raw of repos) {
    const cleaned = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned || !REPO_RE.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (needle && !key.includes(needle)) continue;
    const slash = cleaned.indexOf("/");
    const owner = cleaned.slice(0, slash);
    const ownerKey = owner.toLowerCase();
    let bucket = byOwner.get(ownerKey);
    if (!bucket) {
      bucket = { owner, repos: [] };
      byOwner.set(ownerKey, bucket);
    }
    bucket.repos.push(cleaned);
  }

  return [...byOwner.values()]
    .sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()))
    .map((g) => ({
      owner: g.owner,
      repos: g.repos.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    }));
}

/**
 * Returns whether changing selected repos should clear previously selected labels:
 * per UX spec, keep labels when the new repo list overlaps the previous list,
 * and clear them only when there is zero overlap (or the new selection is empty).
 */
export function shouldClearLabelsOnRepoChange(prevRepos: readonly string[], nextRepos: readonly string[]): boolean {
  if (!prevRepos.length) return false;
  if (!nextRepos.length) return true;
  const prevSet = new Set(prevRepos.map((r) => r.trim().toLowerCase()).filter(Boolean));
  for (const next of nextRepos) {
    if (prevSet.has(next.trim().toLowerCase())) return false;
  }
  return true;
}

/** Normalizes a GitHub hex color string (with or without leading `#`) to `#rrggbb`, or a muted fallback. */
export function normalizeLabelColor(color: string | null | undefined, fallback = "#6b7280"): string {
  const raw = String(color ?? "").trim();
  const match = HEX_COLOR_RE.exec(raw);
  if (!match) return fallback;
  const hex = match[1];
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }
  return `#${hex}`.toLowerCase();
}

/** Filters label catalog options by search query, keeping selected labels visible at the top if desired. */
export function filterLabelOptions(
  catalog: readonly WorkflowGithubLabelOption[],
  selected: readonly string[],
  query = "",
): WorkflowGithubLabelOption[] {
  const needle = query.trim().toLowerCase();
  const byLower = new Map<string, WorkflowGithubLabelOption>();
  for (const item of catalog) {
    const name = String(item?.name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byLower.has(key)) {
      byLower.set(key, {
        name,
        color: normalizeLabelColor(item.color),
        description: item.description ? String(item.description).trim() : "",
      });
    }
  }
  // Ensure already-selected labels that aren't in the fetched catalog still appear so the user can deselect them.
  for (const sel of selected) {
    const name = String(sel ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byLower.has(key)) {
      byLower.set(key, { name, color: "#6b7280", description: "" });
    }
  }
  const selectedSet = new Set(selected.map((s) => s.trim().toLowerCase()));
  return [...byLower.values()]
    .filter((item) => !needle || item.name.toLowerCase().includes(needle) || (item.description ?? "").toLowerCase().includes(needle))
    .sort((a, b) => {
      const aSel = selectedSet.has(a.name.toLowerCase()) ? 0 : 1;
      const bSel = selectedSet.has(b.name.toLowerCase()) ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
}

/**
 * Derives inline GitHub access alerts (`missing` / `readOnly` / `eventsOff`) for a trigger or output step.
 * - `missing`: GitHub is not connected, or one or more selected repos are not accessible in the connected repo catalog.
 * - `readOnly`: Output step requires write permission, but token scopes or repo access metadata indicate read-only access.
 * - `eventsOff`: Trigger step uses webhook events on a repo whose installation reports `events: false`.
 */
export function deriveGithubAccessAlerts(input: {
  role: "trigger" | "output";
  selectedRepos: readonly string[];
  status: {
    installed?: boolean;
    authenticated?: boolean;
    scopes?: readonly string[];
    repos?: readonly string[];
    repoAccess?: readonly WorkflowGithubRepoAccess[];
    webhookEventsEnabled?: boolean;
  } | null | undefined;
}): GithubAccessAlert[] {
  const { role, selectedRepos, status } = input;
  const alerts: GithubAccessAlert[] = [];
  if (!status) return alerts;

  const cleanedRepos = selectedRepos
    .map((r) => String(r ?? "").trim())
    .filter((r) => REPO_RE.test(r));

  if (!status.installed || !status.authenticated) {
    alerts.push({
      kind: "missing",
      repos: cleanedRepos,
      title: !status.installed ? "GitHub CLI not installed" : "GitHub not connected",
      detail: !status.installed
        ? "Install the GitHub CLI (gh) on this computer to access repositories."
        : role === "output"
          ? "Connect GitHub to allow this output step to write to repositories."
          : "Connect GitHub to watch repository events and load labels.",
      action: "connect",
    });
    return alerts;
  }

  // Build lookup of known accessible repositories (from rich repoAccess or plain repos list).
  const accessMap = new Map<string, WorkflowGithubRepoAccess>();
  for (const r of status.repos ?? []) {
    const clean = String(r ?? "").trim();
    if (clean) accessMap.set(clean.toLowerCase(), { fullName: clean });
  }
  for (const entry of status.repoAccess ?? []) {
    const clean = String(entry?.fullName ?? "").trim();
    if (clean) accessMap.set(clean.toLowerCase(), { ...accessMap.get(clean.toLowerCase()), ...entry, fullName: clean });
  }

  const hasCatalog = accessMap.size > 0;
  if (hasCatalog && cleanedRepos.length > 0) {
    const missing = cleanedRepos.filter((r) => !accessMap.has(r.toLowerCase()));
    if (missing.length > 0) {
      alerts.push({
        kind: "missing",
        repos: missing,
        title: missing.length === 1 ? "Repository access missing" : `${missing.length} repositories not accessible`,
        detail: `${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not found in your connected GitHub repositories. Check repository permissions or reconnect.`,
        action: "reconnect",
      });
    }
  }

  // Check readOnly for output steps:
  // 1. Explicit per-repo `writable === false` in `repoAccess`, OR
  // 2. Token scopes listed and none grant repo write (`repo`, `public_repo`, `write:discussion`, etc.).
  if (role === "output") {
    const readOnlyRepos = cleanedRepos.filter((r) => accessMap.get(r.toLowerCase())?.writable === false);
    const scopes = (status.scopes ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean);
    const hasWriteScope =
      scopes.length === 0 ||
      scopes.some((s) => s === "repo" || s === "public_repo" || s.startsWith("repo:"));
    if (readOnlyRepos.length > 0 || !hasWriteScope) {
      alerts.push({
        kind: "readOnly",
        repos: readOnlyRepos.length > 0 ? readOnlyRepos : cleanedRepos,
        title: "Read-only GitHub access",
        detail:
          readOnlyRepos.length > 0
            ? `Your GitHub credentials only have read access to ${readOnlyRepos.join(", ")}. Reconnect with write access so this step can post.`
            : "Your connected GitHub token is missing the repo write scope. Reconnect GitHub to grant write access.",
        action: "reconnect",
      });
    }
  }

  // Check eventsOff for trigger steps:
  // 1. Explicit per-repo `events === false` in `repoAccess`, OR
  // 2. Global `webhookEventsEnabled === false` when repos are selected.
  if (role === "trigger" && cleanedRepos.length > 0) {
    const eventsOffRepos = cleanedRepos.filter((r) => accessMap.get(r.toLowerCase())?.events === false);
    if (eventsOffRepos.length > 0) {
      alerts.push({
        kind: "eventsOff",
        repos: eventsOffRepos,
        title: "Webhook events off",
        detail: `Real-time GitHub App webhook events are disabled for ${eventsOffRepos.join(", ")}. Enable events in GitHub or rely on local polling.`,
        action: "github",
      });
    } else if (status.webhookEventsEnabled === false) {
      alerts.push({
        kind: "eventsOff",
        repos: cleanedRepos,
        title: "Webhook events off",
        detail: "GitHub App webhook subscriptions are turned off for this connection. Local polling fallback is active.",
        action: "github",
      });
    }
  }

  return alerts;
}

const OUTCOME_ORDER: Array<{ outcome: WorkflowGithubDeliveryOutcome; label: string }> = [
  { outcome: "waiting", label: "Waiting" },
  { outcome: "started", label: "Started" },
  { outcome: "skipped", label: "Skipped" },
];

/**
 * Groups GitHub delivery records into `waiting`, `started`, and `skipped` sections (in that order),
 * sorting entries newest-first within each group. Empty groups are omitted.
 */
export function groupDeliveriesByOutcome(deliveries: readonly WorkflowGithubDelivery[]): DeliveryGroup[] {
  const buckets: Record<WorkflowGithubDeliveryOutcome, WorkflowGithubDelivery[]> = {
    waiting: [],
    started: [],
    skipped: [],
  };
  for (const item of deliveries) {
    if (!item || !buckets[item.outcome]) continue;
    buckets[item.outcome].push(item);
  }
  const sortNewest = (a: WorkflowGithubDelivery, b: WorkflowGithubDelivery) =>
    Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || "");

  const groups: DeliveryGroup[] = [];
  for (const { outcome, label } of OUTCOME_ORDER) {
    const list = buckets[outcome];
    if (!list.length) continue;
    list.sort(sortNewest);
    groups.push({ outcome, label, items: list });
  }
  return groups;
}

/** Returns the newest replayable (`outcome === "started"`, non-offline) delivery, or null if none exist. */
export function latestReplayableDelivery(deliveries: readonly WorkflowGithubDelivery[]): WorkflowGithubDelivery | null {
  const sorted = [...deliveries]
    .filter((d) => d && d.outcome === "started" && d.reason !== "offline" && d.replayable !== false)
    .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""));
  return sorted[0] ?? null;
}

/** Returns true if a workflow's upstream GitHub trigger nodes only emit issue events (so PR-only output actions should warn/filter). */
export function isIssueOnlyGithubTrigger(triggerNodes: ReadonlyArray<{ triggerKind?: string; config?: Record<string, any> }>): boolean {
  const ghTriggers = triggerNodes.filter((n) => n.triggerKind === "github");
  if (!ghTriggers.length) return false;
  const allEvents = ghTriggers.flatMap((n) => extractCanonicalEvents(n.config?.events));
  if (!allEvents.length) return false;
  return allEvents.every((ev) => ev.startsWith("issue."));
}

export const GITHUB_UNCERTAIN_WARNING =
  "GitHub may already have this. Retrying could post twice.";

export interface WorkflowStepLike {
  nodeId: string;
  kind?: string;
  label?: string;
  status?: string;
  error?: string | null;
  errorCode?: string | null;
}

export interface WorkflowRunLike {
  id: string;
  status?: string;
  error?: string | null;
  errorCode?: string | null;
  steps?: Record<string, WorkflowStepLike> | null;
}

/** Returns true if an error code or error text indicates a `githubUncertain` failure. */
export function isGithubUncertainError(errorCode?: string | null, errorText?: string | null): boolean {
  if (errorCode === "githubUncertain") return true;
  if (typeof errorText === "string" && /\bgithubUncertain\b/.test(errorText)) return true;
  return false;
}

/** Returns true if a single workflow step failed with `githubUncertain`. */
export function isGithubUncertainStep(step: WorkflowStepLike | null | undefined): boolean {
  if (!step || step.status !== "failed") return false;
  return isGithubUncertainError(step.errorCode, step.error);
}

/**
 * Finds the failed `githubUncertain` step on a workflow run, if any.
 * Checks failed steps first (preferring `errorCode === "githubUncertain"` or `githubUncertain` in `step.error`),
 * and falls back to the failed output step when `githubUncertain` is recorded at the run level.
 */
export function findGithubUncertainStep<S extends WorkflowStepLike>(
  run: (WorkflowRunLike & { steps?: Record<string, S> | null }) | null | undefined,
): S | null {
  if (!run || run.status !== "failed") return null;
  const steps = Object.values(run.steps ?? {});
  for (const step of steps) {
    if (isGithubUncertainStep(step)) return step;
  }
  if (isGithubUncertainError(run.errorCode, run.error)) {
    const failedOutput = steps.find((s) => s.status === "failed" && s.kind === "output");
    if (failedOutput) return failedOutput;
    const anyFailed = steps.find((s) => s.status === "failed");
    if (anyFailed) return anyFailed;
  }
  return null;
}

/** Returns true when a failed workflow run ended with `githubUncertain`. */
export function hasGithubUncertainFailure(run: WorkflowRunLike | null | undefined): boolean {
  if (!run || run.status !== "failed") return false;
  if (isGithubUncertainError(run.errorCode, run.error)) return true;
  return Object.values(run.steps ?? {}).some((s) => isGithubUncertainStep(s));
}

/**
 * Finds the newest failed run where a specific GitHub output node failed with `githubUncertain`.
 * Useful for surfacing the warning and owner-only "Retry anyway" control directly on the step inspector/sheet.
 */
export function latestGithubUncertainRunForNode<R extends WorkflowRunLike>(
  runs: readonly R[] | null | undefined,
  nodeId: string | null | undefined,
): R | null {
  if (!nodeId || !Array.isArray(runs) || !runs.length) return null;
  for (const run of runs) {
    if (!run || run.status !== "failed") continue;
    const step = run.steps?.[nodeId];
    if (isGithubUncertainStep(step)) return run;
    if (step?.status === "failed" && isGithubUncertainError(run.errorCode, run.error)) return run;
  }
  return null;
}

/** Collects target repository names relevant to a GitHub output node (explicit repository or upstream GitHub trigger repos). */
export function resolveOutputTargetRepos(
  outputConfig: Record<string, any> | null | undefined,
  triggerNodes: ReadonlyArray<{ triggerKind?: string; config?: Record<string, any> }>,
): string[] {
  const cfg = outputConfig ?? {};
  const explicitRepo = String(cfg.repository ?? cfg.repo ?? "").trim();
  const useSame = cfg.sameRepository !== false && (!explicitRepo || explicitRepo === "trigger" || explicitRepo === "same");
  if (!useSame && REPO_RE.test(explicitRepo)) {
    return [explicitRepo];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const trig of triggerNodes) {
    if (trig.triggerKind !== "github") continue;
    for (const r of extractConfiguredRepos(trig.config)) {
      const key = r.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
  }
  return out;
}
