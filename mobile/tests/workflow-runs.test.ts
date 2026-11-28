// RunsView mounts with React Compiler enabled, including runs without pendingApproval.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import type { Workflow, WorkflowNode, WorkflowRun } from "../src/link/types";
import { mount, phoneModule } from "./render-phone";

function loadRuns(
  apiCalls: { approve: unknown[][]; retry: unknown[][]; cancel: unknown[][] },
  hooks?: {
    alerts?: Array<{ title: string; message?: string; buttons?: Array<{ text?: string; onPress?: () => void }> }>;
    openedUrls?: string[];
  },
) {
  return phoneModule("../src/features/workflows/Runs", {
    "lucide-react-native": {
      ChevronDown: "ChevronDown",
      ChevronRight: "ChevronRight",
      ExternalLink: "ExternalLink",
      ShieldCheck: "ShieldCheck",
      TriangleAlert: "TriangleAlert",
    },
    "react-native": {
      Alert: {
        alert: (title: string, message?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) => {
          hooks?.alerts?.push({ title, message, buttons });
        },
      },
      Linking: {
        openURL: (url: string) => {
          hooks?.openedUrls?.push(url);
          return Promise.resolve();
        },
      },
      ScrollView: "ScrollView",
      View: "View",
    },
    "@/state/link": {
      api: {
        workflowRespondApproval: (...args: unknown[]) => {
          apiCalls.approve.push(args);
          return Promise.resolve();
        },
        workflowRetryRun: (...args: unknown[]) => {
          apiCalls.retry.push(args);
          return Promise.resolve();
        },
        workflowCancelRun: (...args: unknown[]) => {
          apiCalls.cancel.push(args);
          return Promise.resolve();
        },
      },
      attempt: (p: Promise<unknown>) => p,
    },
    "@/ui": {
      Button: "Button",
      Dot: "Dot",
      EmptyState: "EmptyState",
      Field: "Field",
      Group: "Group",
      Row: "Row",
      T: "T",
      Tap: "Tap",
      radius: { sm: 8 },
      space: { xs: 4, sm: 8, md: 12, lg: 16 },
      useShape: () => ({ wide: false }),
      useTheme: () => ({ colors: { muted: "#888", warningSoft: "#320", warning: "#fa0", dangerSoft: "#300", line: "#444" } }),
    },
  }) as { RunsView: (props: { workflow: Workflow; runs: WorkflowRun[]; nodes: WorkflowNode[]; canUse: boolean; isOwner?: boolean }) => ReturnType<typeof el> };
}

const nodes: WorkflowNode[] = [
  { id: "t1", kind: "trigger", triggerKind: "task", label: "Task enters review", config: {} },
  { id: "a1", kind: "agent", label: "Draft review", config: {} },
  { id: "ap1", kind: "approval", label: "Approve release", config: { message: "Ship build?", noteField: "reason" } },
  { id: "o1", kind: "output", label: "Post summary", config: {} },
];

const workflow: Workflow = {
  id: "wf-1",
  name: "Release handoff",
  enabled: true,
  nodes,
  edges: [
    { id: "e1", from: "t1", to: "a1" },
    { id: "e2", from: "a1", to: "ap1" },
    { id: "e3", from: "ap1", to: "o1", branch: "approved" },
  ],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

function makeRun(overrides: Partial<WorkflowRun> & { id: string }): WorkflowRun {
  const startedAt = overrides.startedAt ?? 1_700_000_100_000;
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "completed",
    triggerKind: "task",
    manual: false,
    startedAt,
    finishedAt: startedAt + 5_000,
    steps: {
      t1: { nodeId: "t1", kind: "trigger", label: "Task enters review", status: "completed", startedAt, finishedAt: startedAt + 200, summary: "Task #42" },
      a1: { nodeId: "a1", kind: "agent", label: "Draft review", status: "completed", startedAt: startedAt + 300, finishedAt: startedAt + 4_500, summary: "Looks good", outputs: { verdict: "ok" } },
    },
    ...overrides,
  };
}

test("RunsView renders realistic completed, failed, and waiting_approval runs without crashing under React Compiler", async (t) => {
  const apiCalls = { approve: [] as unknown[][], retry: [] as unknown[][], cancel: [] as unknown[][] };
  const { RunsView } = loadRuns(apiCalls);

  const runs: WorkflowRun[] = [
    makeRun({ id: "run-completed" }),
    makeRun({
      id: "run-failed",
      status: "failed",
      error: "Agent timed out",
      steps: {
        t1: { nodeId: "t1", kind: "trigger", label: "Task enters review", status: "completed", startedAt: 1_700_000_050_000, finishedAt: 1_700_000_050_200 },
        a1: { nodeId: "a1", kind: "agent", label: "Draft review", status: "failed", startedAt: 1_700_000_050_300, finishedAt: 1_700_000_060_000, error: "Timeout after 10s" },
      },
    }),
    makeRun({
      id: "run-approval",
      status: "waiting_approval",
      finishedAt: null,
      pendingApproval: { nodeId: "ap1", label: "Approve release", message: "Ship build?", noteField: "reason" },
      steps: {
        t1: { nodeId: "t1", kind: "trigger", label: "Task enters review", status: "completed", startedAt: 1_700_000_020_000, finishedAt: 1_700_000_020_200 },
        ap1: { nodeId: "ap1", kind: "approval", label: "Approve release", status: "waiting_approval", startedAt: 1_700_000_020_300 },
      },
    }),
  ];

  const screen = await mount(el(RunsView, { workflow, runs, nodes, canUse: true }));
  t.after(screen.unmount);

  const tree = screen.root.root;
  assert.equal(tree.findAllByType("Group" as never).length, 3, "renders all three run cards");
  assert.equal(tree.findAllByType("EmptyState" as never).length, 0);

  // First run is expanded by default and shows its steps.
  const headers = tree.findAllByType("Tap" as never);
  assert.equal(headers[0].props.accessibilityState.expanded, true);
  assert.equal(headers[1].props.accessibilityState.expanded, false);

  // Waiting-approval card can submit an approval with a note.
  const field = tree.findByType("Field" as never);
  await act(async () => field.props.onChangeText("looks good"));
  const approveButton = tree.findAllByType("Button" as never).find((b) => b.props.title === "Approve");
  assert.ok(approveButton, "Approve button is rendered for waiting_approval run");
  await act(async () => approveButton.props.onPress());
  assert.deepEqual(apiCalls.approve, [["run-approval", "ap1", "approved", "looks good"]]);

  // Expand the failed run and trigger retry.
  await act(async () => headers[1].props.onPress());
  const retryButton = tree.findAllByType("Button" as never).find((b) => b.props.title === "Retry Draft review");
  assert.ok(retryButton, "Retry button is rendered when failed run is expanded");
  await act(async () => retryButton.props.onPress());
  assert.deepEqual(apiCalls.retry, [["run-failed", "a1"]]);
});

test("RunsView caps rendered cards at 30 and renders EmptyState when runs is empty", async (t) => {
  const apiCalls = { approve: [] as unknown[][], retry: [] as unknown[][], cancel: [] as unknown[][] };
  const { RunsView } = loadRuns(apiCalls);

  const empty = await mount(el(RunsView, { workflow, runs: [], nodes, canUse: true }));
  t.after(empty.unmount);
  assert.equal(empty.root.root.findAllByType("EmptyState" as never).length, 1);

  const manyRuns = Array.from({ length: 40 }, (_, i) => makeRun({ id: `run-${i}`, startedAt: 1_700_000_000_000 - i * 60_000 }));
  const filled = await mount(el(RunsView, { workflow, runs: manyRuns, nodes, canUse: true }));
  t.after(filled.unmount);
  assert.equal(filled.root.root.findAllByType("Group" as never).length, 30);
});

test("RunsView shows githubUncertain state, target link, normal Retry, and confirmed owner-only Retry anyway button", async (t) => {
  const apiCalls = { approve: [] as unknown[][], retry: [] as unknown[][], cancel: [] as unknown[][] };
  const alerts: Array<{ title: string; message?: string; buttons?: Array<{ text?: string; onPress?: () => void }> }> = [];
  const openedUrls: string[] = [];
  const { RunsView } = loadRuns(apiCalls, { alerts, openedUrls });

  const uncertainRun = makeRun({
    id: "run-uncertain",
    status: "failed",
    error: 'Post summary: Previous attempt for non-repeatable GitHub action "comment" on org/repo#88 did not finish cleanly (githubUncertain).',
    errorCode: "githubUncertain",
    githubUncertain: {
      nodeId: "o1",
      stepLabel: "Post summary",
      action: "comment",
      repository: "org/repo",
      number: 88,
      pullRequest: true,
      url: "https://github.com/org/repo/pull/88",
    },
    steps: {
      t1: { nodeId: "t1", kind: "trigger", label: "Task enters review", status: "completed", startedAt: 1_700_000_050_000, finishedAt: 1_700_000_050_200 },
      o1: {
        nodeId: "o1",
        kind: "output",
        label: "Post summary",
        status: "failed",
        startedAt: 1_700_000_050_300,
        finishedAt: 1_700_000_060_000,
        error: "Previous attempt did not finish cleanly (githubUncertain).",
        errorCode: "githubUncertain",
        githubUncertain: {
          nodeId: "o1",
          stepLabel: "Post summary",
          action: "comment",
          repository: "org/repo",
          number: 88,
          pullRequest: true,
          url: "https://github.com/org/repo/pull/88",
        },
      },
    },
  });

  // Owner sees distinct status label, target link, normal Retry, and confirmed "Retry anyway"
  const ownerScreen = await mount(el(RunsView, { workflow, runs: [uncertainRun], nodes, canUse: true, isOwner: true }));
  t.after(ownerScreen.unmount);
  const ownerTexts = ownerScreen.root.root.findAllByType("T" as never).map((n) => String(n.props.children));
  assert.ok(ownerTexts.some((t) => t.includes("May have already posted to GitHub")));
  assert.ok(ownerTexts.some((t) => t.includes("Post comment on org/repo#88")));

  const openBtn = ownerScreen.root.root.findAllByType("Button" as never).find((b) => b.props.title === "Open org/repo#88");
  assert.ok(openBtn, "Owner sees GitHub target link button");
  await act(async () => openBtn.props.onPress());
  assert.deepEqual(openedUrls, ["https://github.com/org/repo/pull/88"]);

  const normalRetry = ownerScreen.root.root.findAllByType("Button" as never).find((b) => b.props.title === "Retry Post summary");
  assert.ok(normalRetry, "Normal Retry stays intact");
  await act(async () => normalRetry.props.onPress());
  assert.deepEqual(apiCalls.retry, [["run-uncertain", "o1"]]);

  const retryAnyway = ownerScreen.root.root.findAllByType("Button" as never).find((b) => b.props.title === "Retry anyway");
  assert.ok(retryAnyway, "Owner sees Retry anyway button");
  await act(async () => retryAnyway.props.onPress());
  assert.equal(alerts.length, 1, "Confirmation alert shown before uncertain retry");
  assert.equal(apiCalls.retry.length, 1, "Retry does not fire before confirmation");

  const confirmBtn = alerts[0].buttons?.find((b) => b.text === "Retry anyway");
  assert.ok(confirmBtn?.onPress);
  await act(async () => confirmBtn.onPress?.());
  assert.deepEqual(apiCalls.retry[1], ["run-uncertain", "o1", { allowUncertainRetry: true }]);

  // Member sees the state and target link, plus normal Retry, but NOT "Retry anyway"
  const memberScreen = await mount(el(RunsView, { workflow, runs: [uncertainRun], nodes, canUse: true, isOwner: false }));
  t.after(memberScreen.unmount);
  const memberButtons = memberScreen.root.root.findAllByType("Button" as never).map((b) => b.props.title);
  assert.ok(memberButtons.includes("Open org/repo#88"));
  assert.ok(memberButtons.includes("Retry Post summary"));
  assert.equal(memberButtons.includes("Retry anyway"), false, "Member must not see Retry anyway button");
});
