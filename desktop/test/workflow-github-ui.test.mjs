// Tests for desktop GitHub workflow UI helpers (repo grouping, label picker rules,
// access alert derivation, delivery grouping) and host delivery/catalog/replay RPC methods.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Workflows } from "../desktop/workflows.mjs";

// Load TypeScript helper module via Vite/Node-compatible transpile? Node 24+ runs TS directly with strip-types.
const gh = await import("../src/workflowGithub.ts");

function makeFakeWorkspace() {
  const events = new EventEmitter();
  return {
    events,
    state: {
      bots: [{ id: "b1", name: "Glory" }],
      chats: [],
      tasks: [],
      workflows: [],
      workflowRuns: [],
      workflowGithubActions: {},
      workflowGithubDeliveries: [],
    },
    saved: 0,
    save() {
      this.saved += 1;
    },
    mainChat() {
      return { id: "c1", botId: "b1", title: "Main", messages: [] };
    },
    chat() {
      return { id: "c1", botId: "b1", title: "Main", messages: [] };
    },
    appendMessage() {},
    addBoardItem() {},
    notify() {},
  };
}

test("desktop workflowGithub.ts groups repos by owner and filters case-insensitively", () => {
  const groups = gh.groupReposByOwner([
    "promptclickrun/Botkins",
    "acme/tools",
    "PROMPTCLICKRUN/botkins",
    "acme/api",
  ]);
  assert.deepEqual(groups, [
    { owner: "acme", repos: ["acme/api", "acme/tools"] },
    { owner: "promptclickrun", repos: ["promptclickrun/Botkins"] },
  ]);
  assert.deepEqual(gh.groupReposByOwner(["promptclickrun/Botkins", "acme/api"], "botk"), [
    { owner: "promptclickrun", repos: ["promptclickrun/Botkins"] },
  ]);
});

test("desktop workflowGithub.ts derives missing, readOnly, and eventsOff alerts", () => {
  const alerts = gh.deriveGithubAccessAlerts({
    role: "trigger",
    selectedRepos: ["org/a", "org/missing"],
    status: {
      installed: true,
      authenticated: true,
      scopes: ["repo"],
      repos: ["org/a"],
      repoAccess: [{ fullName: "org/a", writable: true, events: false }],
    },
  });
  assert.deepEqual(
    alerts.map((a) => ({ kind: a.kind, repos: a.repos })),
    [
      { kind: "missing", repos: ["org/missing"] },
      { kind: "eventsOff", repos: ["org/a"] },
    ],
  );

  const outAlerts = gh.deriveGithubAccessAlerts({
    role: "output",
    selectedRepos: ["org/ro"],
    status: {
      installed: true,
      authenticated: true,
      scopes: ["repo"],
      repos: ["org/ro"],
      repoAccess: [{ fullName: "org/ro", writable: false }],
    },
  });
  assert.deepEqual(outAlerts.map((a) => a.kind), ["readOnly"]);
});

test("desktop workflowGithub.ts groups deliveries waiting -> started -> skipped and picks replayable event", () => {
  const deliveries = [
    {
      workflowId: "w1",
      nodeId: "t1",
      deliveryId: "d1",
      event: "issue.opened",
      repository: "org/a",
      number: 1,
      pullRequest: false,
      title: "First",
      receivedAt: "2026-11-27T10:00:00Z",
      outcome: "started",
      reason: null,
      runId: "r1",
      replayable: true,
    },
    {
      workflowId: "w1",
      nodeId: "t1",
      deliveryId: "d2",
      event: "comment",
      repository: "org/a",
      number: 1,
      pullRequest: false,
      title: "Queued",
      receivedAt: "2026-11-27T10:02:00Z",
      outcome: "waiting",
      reason: null,
      runId: null,
      waitsForRunId: "r1",
      replayable: true,
    },
    {
      workflowId: "w1",
      nodeId: "t1",
      deliveryId: "d3",
      event: "comment",
      repository: "org/a",
      number: 1,
      pullRequest: false,
      title: "Filtered",
      receivedAt: "2026-11-27T10:01:00Z",
      outcome: "skipped",
      reason: "filter",
      runId: null,
      replayable: true,
    },
  ];
  const groups = gh.groupDeliveriesByOutcome(deliveries);
  assert.deepEqual(groups.map((g) => g.outcome), ["waiting", "started", "skipped"]);
  assert.equal(gh.latestReplayableDelivery(deliveries)?.deliveryId, "d2");
});

test("Workflows records started/skipped GitHub deliveries, fetches repo catalog, and replays last event", async () => {
  const ws = makeFakeWorkspace();
  const fakeAuth = {
    async listRepoLabels(repo) {
      return repo === "org/a"
        ? [{ name: "bug", color: "d73a4a", description: "Bug" }]
        : [{ name: "docs", color: "0075ca", description: "Docs" }];
    },
    async listRepoAssignees() {
      return [{ login: "octocat", type: "User" }];
    },
  };
  const workflows = new Workflows(ws, { githubAuth: fakeAuth });
  const wf = workflows.create({
    name: "GH test",
    enabled: true,
    nodes: [
      {
        id: "t1",
        kind: "trigger",
        triggerKind: "github",
        label: "GitHub",
        config: { repos: ["org/a", "org/b"], events: ["issue.opened"], notBot: true },
      },
      {
        id: "o1",
        kind: "output",
        label: "Notify",
        config: { destination: "notification", template: "{{title}}" },
      },
    ],
    edges: [{ from: "t1", to: "o1", branch: "default" }],
  });

  // 1. Catalog aggregates labels and assignees across repos
  const catalog = await workflows.githubCatalog({ repos: ["org/a", "org/b"] });
  assert.deepEqual(
    catalog.labels.map((l) => l.name),
    ["bug", "docs"],
  );
  assert.deepEqual(
    catalog.assignees.map((a) => a.login),
    ["octocat"],
  );

  // 2. Filtered bot event records a skipped/filter delivery
  const triggerNode = wf.nodes[0];
  workflows.fireGithubEvent(
    wf,
    triggerNode,
    "org/a",
    "issue.opened",
    { number: 42, title: "Bot PR", author: { login: "dependabot[bot]", type: "Bot" }, state: "open" },
    { itemType: "issue", pullRequest: false, deliveryId: "del-bot" },
  );
  let deliveries = workflows.listGithubDeliveries(wf.id, "t1");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].outcome, "skipped");
  assert.equal(deliveries[0].reason, "filter");

  // 3. Passing human event records a started delivery with runId
  workflows.fireGithubEvent(
    wf,
    triggerNode,
    "org/a",
    "issue.opened",
    { number: 43, title: "Real issue", author: { login: "alice", type: "User" }, state: "open" },
    { itemType: "issue", pullRequest: false, deliveryId: "del-human" },
  );
  deliveries = workflows.listGithubDeliveries(wf.id, "t1");
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries.some((d) => d.deliveryId === "del-human" && d.outcome === "started" && d.runId), true);

  // 4. Replay last event launches a new manual run with the stored payload
  const replayedRun = workflows.replayLastGithubEvent(wf.id, "t1");
  assert.equal(replayedRun.workflowId, wf.id);
  assert.equal(replayedRun.manual, true);
  assert.equal(replayedRun.context.number, 43);
});

test("Workflows.tsx starter template uses valid {{state}} field (not broken {{status}})", () => {
  const src = readFileSync(new URL("../src/Workflows.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\{\{status\}\}/);
  assert.match(src, /destination:\s*"chat"/);
});
