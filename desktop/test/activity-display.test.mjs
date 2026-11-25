// Open-mode (T3 Code) and Fold-mode (OpenBot) activity presentation model,
// foldThinking preference validation, and link runSummary enrichment.
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStep,
  clipLines,
  formatFeedWork,
  formatWorkingDuration,
  groupForOpenMode,
  isCodingKind,
  parseStepInput,
  partitionForFoldMode,
  stepHeadline,
  toolKind,
  uniqueKinds,
} from "../desktop/link/activityModel.mjs";
import { baseParts } from "../desktop/link/parts.mjs";
import { changeSettings, defaultSettings } from "../desktop/preferences.mjs";

const step = (id, name, extra = {}) => ({
  id,
  name,
  label: extra.label ?? name,
  status: extra.status ?? "Done",
  started: 1_795_000_000_000,
  ...extra,
});

test("tool classification maps tool families, hides quiet internal steps, and keeps failed ones", () => {
  assert.equal(toolKind("bash"), "command");
  assert.equal(toolKind("run_command"), "command");
  assert.equal(toolKind("view"), "read");
  assert.equal(toolKind("edit"), "edit");
  assert.equal(toolKind("create"), "write");
  assert.equal(toolKind("grep"), "search-files");
  assert.equal(toolKind("web_search"), "web");
  assert.equal(toolKind("web_fetch"), "web-page");
  assert.equal(toolKind("update_todo"), "plan");
  assert.equal(toolKind("report_intent"), null);
  assert.equal(toolKind("think"), null);
  assert.equal(toolKind("task_complete"), null);
  assert.equal(toolKind("custom_mcp_action"), "tool");

  assert.equal(classifyStep(step("q1", "report_intent")), null);
  assert.equal(classifyStep(step("q2", "report_intent", { status: "Failed" })), "tool");
  assert.equal(classifyStep(step("m1", "view", { source: "linear" })), "tool");

  assert.equal(isCodingKind("command"), true);
  assert.equal(isCodingKind("edit"), true);
  assert.equal(isCodingKind("write"), true);
  assert.equal(isCodingKind("read"), false);
});

test("parseStepInput extracts shell commands, old/new diffs, unified patches, and created files", () => {
  const cmd = parseStepInput(
    step("s1", "bash", {
      input: JSON.stringify({ command: "npm test\necho done", description: "Run unit tests" }),
    }),
  );
  assert.equal(cmd.kind, "command");
  assert.equal(cmd.command, "npm test\necho done");
  assert.equal(cmd.description, "Run unit tests");
  assert.equal(stepHeadline(step("s1", "bash"), cmd), "Run unit tests");

  const edited = parseStepInput(
    step("s2", "edit", {
      input: JSON.stringify({
        path: "src/app/ChatView.tsx",
        old_str: "const a = 1;\nconst b = 2;\nconst c = 3;",
        new_str: "const a = 1;\nconst b = 20;\nconst d = 4;\nconst c = 3;",
      }),
    }),
  );
  assert.equal(edited.fileName, "ChatView.tsx");
  assert.equal(edited.diff.removed, 1);
  assert.equal(edited.diff.added, 2);
  assert.deepEqual(
    edited.diff.lines.map((l) => l.kind + ":" + l.text),
    ["ctx:const a = 1;", "del:const b = 2;", "add:const b = 20;", "add:const d = 4;", "ctx:const c = 3;"],
  );
  assert.equal(stepHeadline(step("s2", "edit"), edited), "Edited ChatView.tsx");
  assert.equal(stepHeadline(step("s2", "edit", { status: "Running" }), edited), "Editing ChatView.tsx");

  const patched = parseStepInput(
    step("s3", "apply_patch", {
      input: "*** Begin Patch\n*** Update File: desktop/src/Work.tsx\n@@ -1,2 +1,2 @@\n-old line\n+new line\n*** End Patch",
    }),
  );
  assert.equal(patched.filePath, "desktop/src/Work.tsx");
  assert.equal(patched.fileName, "Work.tsx");
  assert.equal(patched.diff.added, 1);
  assert.equal(patched.diff.removed, 1);

  const created = parseStepInput(
    step("s4", "create", {
      input: JSON.stringify({ path: "src/activityModel.ts", file_text: "export const x = 1;\nexport const y = 2;" }),
    }),
  );
  assert.equal(created.fileName, "activityModel.ts");
  assert.equal(created.diff.added, 2);
  assert.equal(created.diff.removed, 0);
});

test("groupForOpenMode merges consecutive same-kind steps for T3 Code inline rows", () => {
  const steps = [
    step("0", "report_intent"),
    step("1", "view", { input: JSON.stringify({ path: "a.ts" }) }),
    step("2", "read_file", { input: JSON.stringify({ path: "b.ts" }) }),
    step("3", "bash", { input: JSON.stringify({ command: "npm run build" }), status: "Running" }),
    step("4", "view", { input: JSON.stringify({ path: "c.ts" }) }),
  ];
  const groups = groupForOpenMode(steps);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].primaryKind, "read");
  assert.equal(groups[0].steps.length, 2);
  assert.equal(groups[0].label, "Read 2 files");
  assert.equal(groups[1].primaryKind, "command");
  assert.equal(groups[1].running, true);
  assert.equal(groups[1].label, "npm run build");
  assert.equal(groups[2].primaryKind, "read");
  assert.equal(groups[2].label, "Read c.ts");
});

test("partitionForFoldMode lifts commands and file edits into coding frames and groups surrounding steps", () => {
  const steps = [
    step("1", "view", { input: JSON.stringify({ path: "a.ts" }) }),
    step("2", "grep", { input: JSON.stringify({ pattern: "foldThinking" }) }),
    step("3", "bash", { input: JSON.stringify({ command: "npm test" }), output: "ok" }),
    step("4", "edit", { input: JSON.stringify({ path: "a.ts", old_str: "x", new_str: "y" }) }),
    step("5", "web_search", { input: JSON.stringify({ query: "openbot" }) }),
    step("6", "web_fetch", { input: JSON.stringify({ url: "https://example.com/docs" }), status: "Failed" }),
  ];
  const blocks = partitionForFoldMode(steps);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["group", "command", "diff", "group"],
  );
  assert.deepEqual(blocks[0].kinds, ["read", "search-files"]);
  assert.equal(blocks[0].label, "Read a file, searched files");
  assert.equal(blocks[1].parsed.command, "npm test");
  assert.equal(blocks[2].parsed.fileName, "a.ts");
  assert.equal(blocks[2].parsed.diff.added, 1);
  assert.deepEqual(blocks[3].kinds, ["web", "web-page"]);
  assert.equal(blocks[3].failedCount, 1);
});

test("clipLines, formatWorkingDuration, uniqueKinds, and formatFeedWork handle edge cases", () => {
  assert.deepEqual(clipLines("a\nb\nc\nd\ne", 3), { text: "a\nb\nc", totalLines: 5, clipped: true });
  assert.deepEqual(clipLines("a\nb\nc\nd\ne", 2, true), { text: "d\ne", totalLines: 5, clipped: true });
  assert.equal(formatWorkingDuration(0), "0s");
  assert.equal(formatWorkingDuration(45_900), "45s");
  assert.equal(formatWorkingDuration(65_000), "1m 5s");
  assert.equal(formatWorkingDuration(3_720_000), "1h 2m");

  const kinds = uniqueKinds([
    step("1", "view"),
    step("2", "grep"),
    step("3", "bash"),
    step("4", "edit"),
    step("5", "web_search"),
  ]);
  assert.deepEqual(kinds, ["read", "search-files", "command", "edit"]);

  assert.deepEqual(
    formatFeedWork({
      status: "Completed",
      steps: [step("1", "view"), step("2", "bash", { status: "Failed" })],
    }),
    { kinds: ["read", "command"], summary: "Read a file, ran a command", stepCount: 2, failedCount: 1 },
  );
  assert.deepEqual(
    formatFeedWork({ status: "Completed", usedTools: ["grep", "web_search", "report_intent"] }),
    { kinds: ["search-files", "web"], summary: "Searched files, searched the web", stepCount: 2, failedCount: 0 },
  );
});

test("foldThinking defaults to true, toggles independently, and rejects non-booleans", () => {
  assert.equal(defaultSettings.foldThinking, true);
  const opened = changeSettings(defaultSettings, { foldThinking: false });
  assert.equal(opened.foldThinking, false);
  assert.equal(opened.showThinking, true);
  assert.equal(opened.foldTools, true);

  const folded = changeSettings(opened, { foldThinking: true });
  assert.equal(folded.foldThinking, true);

  assert.throws(() => changeSettings(defaultSettings, { foldThinking: "open" }), /thinking display preference/i);
});

test("link baseParts enriches run summaries with stepKinds, stepCount, failedCount, and fallback summary", () => {
  const parts = baseParts(
    {
      runs: [
        {
          id: "r1",
          chatId: "c1",
          title: "Fix build",
          time: 1_795_000_000_000,
          status: "Completed",
          steps: [
            step("s1", "view", { input: JSON.stringify({ path: "a.ts" }) }),
            step("s2", "bash", { input: JSON.stringify({ command: "npm test" }), status: "Failed" }),
            step("s3", "report_intent"),
          ],
        },
        {
          id: "r2",
          chatId: "c1",
          title: "Explicit summary",
          time: 1_795_000_001_000,
          status: "Completed",
          summary: "Custom work line",
          usedTools: ["web_search"],
        },
      ],
    },
    {},
  );
  assert.equal(parts.runs.length, 2);
  assert.deepEqual(parts.runs[0].stepKinds, ["read", "command"]);
  assert.equal(parts.runs[0].stepCount, 2);
  assert.equal(parts.runs[0].failedCount, 1);
  assert.equal(parts.runs[0].summary, "Read a file, ran a command");

  assert.equal(parts.runs[1].summary, "Custom work line");
  assert.deepEqual(parts.runs[1].stepKinds, ["web"]);
  assert.equal(parts.runs[1].stepCount, 1);
  assert.equal(parts.runs[1].failedCount, undefined);
});
