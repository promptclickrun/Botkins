// Mobile Open-mode (T3 Code) and Fold-mode (OpenBot) activity presentation model,
// MockBackend foldThinking preference handling, and link-host runSummary enrichment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { baseParts } from "../link-host/parts.mjs";
import {
  classifyStep,
  clipLines,
  formatFeedWork,
  formatWorkingDuration,
  groupForOpenMode,
  parseStepInput,
  partitionForFoldMode,
  stepHeadline,
  toolKind,
} from "../src/features/chat/activityModel";
import type { Step } from "../src/link/types";

const step = (id: string, name: string, extra: Partial<Step> = {}): Step => ({
  id,
  name,
  label: extra.label ?? name,
  status: extra.status ?? "Done",
  started: 1_795_000_000_000,
  ...extra,
});

test("mobile activity model matches desktop grouping for Open mode and coding frames for Fold mode", () => {
  assert.equal(toolKind("bash"), "command");
  assert.equal(toolKind("report_intent"), null);
  assert.equal(classifyStep(step("q", "think", { status: "Failed" })), "tool");

  const steps: Step[] = [
    step("0", "report_intent"),
    step("1", "view", { input: JSON.stringify({ path: "src/App.tsx" }) }),
    step("2", "view", { input: JSON.stringify({ path: "src/Chat.tsx" }) }),
    step("3", "bash", { input: JSON.stringify({ command: "npm run typecheck", description: "Typecheck mobile" }), status: "Running" }),
    step("4", "edit", {
      input: JSON.stringify({ path: "src/Chat.tsx", old_str: "a\nb", new_str: "a\nc\nd" }),
    }),
    step("5", "web_search", { input: JSON.stringify({ query: "t3code" }) }),
  ];

  const openGroups = groupForOpenMode(steps);
  assert.deepEqual(
    openGroups.map((g) => [g.primaryKind, g.steps.length, g.label]),
    [
      ["read", 2, "Read 2 files"],
      ["command", 1, "Typecheck mobile"],
      ["edit", 1, "Edited Chat.tsx"],
      ["web", 1, "Searched web: t3code"],
    ],
  );
  assert.equal(openGroups[1].running, true);

  const foldBlocks = partitionForFoldMode(steps);
  assert.deepEqual(
    foldBlocks.map((b) => b.kind),
    ["group", "command", "diff", "group"],
  );
  assert.equal(foldBlocks[0].kind === "group" && foldBlocks[0].label, "Read 2 files");
  assert.equal(foldBlocks[1].kind === "command" && foldBlocks[1].parsed.command, "npm run typecheck");
  assert.equal(foldBlocks[2].kind === "diff" && foldBlocks[2].parsed.diff?.added, 2);
  assert.equal(foldBlocks[2].kind === "diff" && foldBlocks[2].parsed.diff?.removed, 1);
});

test("parseStepInput handles unified patch input and clipLines / duration helpers", () => {
  const patched = parseStepInput(
    step("p1", "apply_patch", {
      input: "*** Begin Patch\n*** Update File: mobile/src/Work.tsx\n@@ -1 +1 @@\n-foo\n+bar\n*** End Patch",
    }),
  );
  assert.equal(patched.fileName, "Work.tsx");
  assert.equal(patched.diff?.added, 1);
  assert.equal(patched.diff?.removed, 1);
  assert.equal(stepHeadline(step("p1", "apply_patch"), patched), "Edited Work.tsx");

  assert.deepEqual(clipLines("1\n2\n3\n4", 2, true), { text: "3\n4", totalLines: 4, clipped: true });
  assert.equal(formatWorkingDuration(125_000), "2m 5s");
});

test("formatFeedWork works on linked run summaries and MockBackend supports foldThinking", async () => {
  const parts = baseParts(
    {
      runs: [
        {
          id: "r1",
          chatId: "c1",
          title: "Run tests",
          time: 1_795_000_000_000,
          status: "Completed",
          steps: [
            step("1", "grep", { input: JSON.stringify({ pattern: "FoldToolLine" }) }),
            step("2", "bash", { input: JSON.stringify({ command: "npm test" }) }),
          ],
        },
      ],
    },
    {},
  );
  const linkedSummary = parts.runs[0];
  assert.deepEqual(linkedSummary.stepKinds, ["search-files", "command"]);
  assert.equal(linkedSummary.stepCount, 2);
  assert.equal(linkedSummary.summary, "Searched files, ran a command");

  assert.deepEqual(formatFeedWork(linkedSummary), {
    kinds: ["search-files", "command"],
    summary: "Searched files, ran a command",
    stepCount: 2,
    failedCount: 0,
  });

  const backend = new MockBackend();
  assert.equal(backend.state.settings.foldThinking, true);
  await backend.call("setPreferences", [{ foldThinking: false }]);
  assert.equal(backend.state.settings.foldThinking, false);
  await assert.rejects(backend.call("setPreferences", [{ foldThinking: "nope" }]));
});
