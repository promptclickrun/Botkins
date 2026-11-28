// Unit tests for pure GitHub workflow UI logic on mobile (and parity with desktop/src/workflowGithub.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canShowUncertainRetry,
  deriveGithubAccessAlerts,
  extractCanonicalEvents,
  extractConfiguredRepos,
  filterLabelOptions,
  GITHUB_UNCERTAIN_STATUS_LABEL,
  groupDeliveriesByOutcome,
  groupReposByOwner,
  hasGithubUncertainFailure,
  isIssueOnlyGithubTrigger,
  latestReplayableDelivery,
  normalizeLabelColor,
  resolveGithubUncertainDetails,
  resolveOutputTargetRepos,
  shouldClearLabelsOnRepoChange,
  workflowRunStatusLabel,
  workflowStepStatusLabel,
  type WorkflowGithubDelivery,
} from "../src/features/workflows/github";

test("mobile github helpers stay in exact parity with desktop/src/workflowGithub.ts", () => {
  const mobile = readFileSync(new URL("../src/features/workflows/github.ts", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("../../desktop/src/workflowGithub.ts", import.meta.url), "utf8");
  assert.equal(mobile, desktop);
});

test("groupReposByOwner groups alphabetically by owner, deduplicates case-insensitively, and filters by query", () => {
  const repos = [
    "zeta/app",
    "Alpha/core",
    "alpha/CORE",
    "alpha/docs",
    "Beta/cli",
    "invalid-repo-name",
    "beta/api",
  ];
  const all = groupReposByOwner(repos);
  assert.deepEqual(
    all.map((g) => [g.owner, g.repos]),
    [
      ["Alpha", ["Alpha/core", "alpha/docs"]],
      ["Beta", ["beta/api", "Beta/cli"]],
      ["zeta", ["zeta/app"]],
    ],
  );

  const filtered = groupReposByOwner(repos, "doc");
  assert.deepEqual(filtered, [{ owner: "alpha", repos: ["alpha/docs"] }]);
});

test("shouldClearLabelsOnRepoChange preserves labels on overlapping repos and clears on disjoint or empty selection", () => {
  assert.equal(shouldClearLabelsOnRepoChange([], ["org/a"]), false);
  assert.equal(shouldClearLabelsOnRepoChange(["org/a", "org/b"], ["ORG/B", "org/c"]), false);
  assert.equal(shouldClearLabelsOnRepoChange(["org/a"], ["org/b"]), true);
  assert.equal(shouldClearLabelsOnRepoChange(["org/a"], []), true);
});

test("normalizeLabelColor and filterLabelOptions preserve selected labels and sort selected first", () => {
  assert.equal(normalizeLabelColor("d73a4a"), "#d73a4a");
  assert.equal(normalizeLabelColor("#0f8"), "#00ff88");
  assert.equal(normalizeLabelColor("not-a-color"), "#6b7280");

  const opts = filterLabelOptions(
    [
      { name: "enhancement", color: "a2eeef", description: "New feature" },
      { name: "bug", color: "d73a4a", description: "Broken" },
    ],
    ["custom-tag", "bug"],
    "",
  );
  assert.deepEqual(
    opts.map((o) => [o.name, o.color]),
    [
      ["bug", "#d73a4a"],
      ["custom-tag", "#6b7280"],
      ["enhancement", "#a2eeef"],
    ],
  );
});

test("deriveGithubAccessAlerts surfaces missing, readOnly, and eventsOff accurately", () => {
  // Not connected -> missing
  const unauth = deriveGithubAccessAlerts({
    role: "trigger",
    selectedRepos: ["org/repo"],
    status: { installed: true, authenticated: false, scopes: [], repos: [] },
  });
  assert.deepEqual(unauth.map((a) => a.kind), ["missing"]);

  // Connected but selected repo missing + eventsOff
  const triggerAlerts = deriveGithubAccessAlerts({
    role: "trigger",
    selectedRepos: ["org/known", "org/unshared"],
    status: {
      installed: true,
      authenticated: true,
      scopes: ["repo"],
      repos: ["org/known"],
      repoAccess: [{ fullName: "org/known", writable: true, events: false }],
    },
  });
  assert.deepEqual(triggerAlerts.map((a) => a.kind), ["missing", "eventsOff"]);
  assert.deepEqual(triggerAlerts[0].repos, ["org/unshared"]);
  assert.deepEqual(triggerAlerts[1].repos, ["org/known"]);

  // Output step with read-only repo access -> readOnly
  const outputReadOnly = deriveGithubAccessAlerts({
    role: "output",
    selectedRepos: ["org/readonly"],
    status: {
      installed: true,
      authenticated: true,
      scopes: ["repo"],
      repos: ["org/readonly"],
      repoAccess: [{ fullName: "org/readonly", writable: false }],
    },
  });
  assert.deepEqual(outputReadOnly.map((a) => a.kind), ["readOnly"]);

  // Output step with missing write scope -> readOnly
  const scopeReadOnly = deriveGithubAccessAlerts({
    role: "output",
    selectedRepos: ["org/known"],
    status: {
      installed: true,
      authenticated: true,
      scopes: ["read:org", "read:user"],
      repos: ["org/known"],
    },
  });
  assert.deepEqual(scopeReadOnly.map((a) => a.kind), ["readOnly"]);
});

test("groupDeliveriesByOutcome orders waiting -> started -> skipped, newest-first, and finds replayable event", () => {
  const deliveries: WorkflowGithubDelivery[] = [
    {
      workflowId: "wf1",
      nodeId: "n1",
      deliveryId: "d-skip-offline",
      event: "offline",
      repository: null,
      number: null,
      pullRequest: null,
      title: "Offline gap",
      receivedAt: "2026-11-27T12:10:00Z",
      outcome: "skipped",
      reason: "offline",
      runId: null,
      replayable: false,
    },
    {
      workflowId: "wf1",
      nodeId: "n1",
      deliveryId: "d-start-old",
      event: "issue.opened",
      repository: "org/repo",
      number: 10,
      pullRequest: false,
      title: "Old issue",
      receivedAt: "2026-11-27T12:00:00Z",
      outcome: "started",
      reason: null,
      runId: "r1",
      replayable: true,
    },
    {
      workflowId: "wf1",
      nodeId: "n1",
      deliveryId: "d-wait",
      event: "comment",
      repository: "org/repo",
      number: 10,
      pullRequest: false,
      title: "Follow-up comment",
      receivedAt: "2026-11-27T12:05:00Z",
      outcome: "waiting",
      reason: null,
      runId: null,
      waitsForRunId: "r1",
      replayable: true,
    },
    {
      workflowId: "wf1",
      nodeId: "n1",
      deliveryId: "d-skip-self",
      event: "comment",
      repository: "org/repo",
      number: 10,
      pullRequest: false,
      title: "Bot reply",
      receivedAt: "2026-11-27T12:03:00Z",
      outcome: "skipped",
      reason: "self",
      runId: null,
      replayable: true,
    },
  ];

  const grouped = groupDeliveriesByOutcome(deliveries);
  assert.deepEqual(
    grouped.map((g) => [g.outcome, g.items.map((i) => i.deliveryId)]),
    [
      ["waiting", ["d-wait"]],
      ["started", ["d-start-old"]],
      ["skipped", ["d-skip-offline", "d-skip-self"]],
    ],
  );

  // Only started, non-offline deliveries are replayable (skips offline, waiting, and filter/self skipped rows).
  const latest = latestReplayableDelivery(deliveries);
  assert.equal(latest?.deliveryId, "d-start-old");
});

test("extractConfiguredRepos, extractCanonicalEvents, issue-only check, and output target repo resolution", () => {
  assert.deepEqual(extractConfiguredRepos({ repos: ["org/a", "ORG/A", "org/b"], repo: "org/c" }), ["org/a", "org/b", "org/c"]);
  assert.deepEqual(extractCanonicalEvents(["pr_opened", "pr_updated", "ci_status"]), ["pr.opened", "pr.updated", "pr.merged", "pr.checksFailed"]);
  assert.equal(isIssueOnlyGithubTrigger([{ triggerKind: "github", config: { events: ["issue.opened", "issue.labeled"] } }]), true);
  assert.equal(isIssueOnlyGithubTrigger([{ triggerKind: "github", config: { events: ["issue.opened", "pr.opened"] } }]), false);

  assert.deepEqual(
    resolveOutputTargetRepos(
      { sameRepository: true },
      [{ triggerKind: "github", config: { repos: ["org/one", "org/two"] } }],
    ),
    ["org/one", "org/two"],
  );
  assert.deepEqual(
    resolveOutputTargetRepos(
      { sameRepository: false, repository: "org/custom" },
      [{ triggerKind: "github", config: { repos: ["org/one"] } }],
    ),
    ["org/custom"],
  );
});

test("Canvas.tsx uses Glass, withSpring, SharedValue drag offset, and no 1D ScrollView fallback", () => {
  const src = readFileSync(new URL("../src/features/workflows/Canvas.tsx", import.meta.url), "utf8");
  assert.match(src, /import\s+\{[^}]*\bGlass\b[^}]*\}\s+from\s+["']@\/ui["']/);
  assert.match(src, /\bwithSpring\b/);
  assert.match(src, /\bdragOffset\s*=\s*useSharedValue\b/);
  assert.doesNotMatch(src, /\bScrollView\b/);
});

test("GithubPickers.tsx virtualizes repo, label, people, and delivery lists with SectionList/FlatList", () => {
  const src = readFileSync(new URL("../src/features/workflows/GithubPickers.tsx", import.meta.url), "utf8");
  assert.match(src, /<SectionList\b/);
  assert.match(src, /<FlatList\b/);
});

test("mobile githubUncertain helpers detect state, format action/target/link, and restrict Retry anyway to owner", () => {
  const run = {
    id: "run-gh-1",
    status: "failed",
    errorCode: "githubUncertain",
    error: 'Post comment: Previous attempt for non-repeatable GitHub action "comment" on org/repo#42 did not finish cleanly; refusing to double-post (githubUncertain).',
    githubUncertain: {
      nodeId: "o1",
      stepLabel: "Post comment",
      action: "comment",
      repository: "org/repo",
      number: 42,
      pullRequest: false,
      url: "https://github.com/org/repo/issues/42",
    },
    steps: {
      o1: {
        nodeId: "o1",
        kind: "output",
        label: "Post comment",
        status: "failed",
        errorCode: "githubUncertain",
        error: "refusing to double-post (githubUncertain)",
        githubUncertain: {
          nodeId: "o1",
          stepLabel: "Post comment",
          action: "comment",
          repository: "org/repo",
          number: 42,
          pullRequest: false,
          url: "https://github.com/org/repo/issues/42",
        },
      },
    },
  };

  assert.equal(hasGithubUncertainFailure(run), true);
  assert.equal(workflowRunStatusLabel(run), GITHUB_UNCERTAIN_STATUS_LABEL);
  assert.equal(workflowStepStatusLabel(run.steps.o1, run), GITHUB_UNCERTAIN_STATUS_LABEL);

  const details = resolveGithubUncertainDetails(run);
  assert.ok(details);
  assert.equal(details.actionLabel, "Post comment");
  assert.equal(details.target, "org/repo#42");
  assert.equal(details.url, "https://github.com/org/repo/issues/42");

  // Owner with permission sees Retry anyway; member or lacking permission does not
  assert.equal(canShowUncertainRetry({ run, isOwner: true, canUse: true }), true);
  assert.equal(canShowUncertainRetry({ run, isOwner: false, canUse: true }), false);
  assert.equal(canShowUncertainRetry({ run, isOwner: true, canUse: false }), false);
});
