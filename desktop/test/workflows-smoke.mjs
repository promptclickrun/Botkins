// Workflows canvas UI smoke test & light/dark screenshot capture, with isolated app data.
// BOTKINS_QA_DIR=<dir> saves light and dark screenshots of the Workflows canvas there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-workflows-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.BOTKINS_QA_DIR;

const now = Date.now();
const bots = [
  ["alfie", "Alfie", "Chief of Staff", "pip", true],
  ["glory", "Glory", "Coding partner", "muse", false],
  ["shepherd", "Shepherd", "PR watcher", "sprig", false],
].map(([id, name, role, head, primary]) => ({
  id,
  name,
  role,
  primary,
  instructions: "Help the user.",
  face: "idle",
  sources: [],
  look: { head, palette: "original" },
}));

const chats = [
  { id: "chat-alfie", botId: "alfie", title: "Alfie", main: true, time: now - 3600_000, messages: [], established: false },
  { id: "chat-glory", botId: "glory", title: "Glory", main: true, time: now - 7200_000, messages: [], established: false },
];

const workflows = [
  {
    id: "wf-review-handoff",
    name: "Task Review → Alfie Summary",
    description: "When a Task Board job moves to Review, route PR summaries through Alfie and post back to chat.",
    enabled: true,
    createdAt: now - 86400_000,
    updatedAt: now - 600_000,
    nodes: [
      {
        id: "t1",
        kind: "trigger",
        triggerKind: "task",
        label: "Task moves to Review",
        position: { x: 40, y: 155 },
        config: { event: "status_changed", toStatus: "review" },
      },
      {
        id: "c1",
        kind: "condition",
        label: "Has PR result?",
        position: { x: 375, y: 155 },
        config: {
          match: "all",
          rules: [
            { field: "to", op: "equals", value: "review" },
            { field: "result", op: "exists", value: "" },
          ],
        },
      },
      {
        id: "a1",
        kind: "agent",
        label: "Alfie summarizes review",
        position: { x: 725, y: 40 },
        config: {
          botId: "alfie",
          outputKey: "agent_reply",
          prompt: "Review task {{title}} from {{bot}} (moved {{from}} → {{to}}). Summarize the result and PR link:\n\n{{result}}",
        },
      },
      {
        id: "o1",
        kind: "output",
        label: "Post to Alfie chat",
        position: { x: 1065, y: 40 },
        config: {
          destination: "chat",
          botId: "alfie",
          chatId: "chat-alfie",
          template: "Ready for review: **{{title}}**\n\n{{agent_reply}}",
        },
      },
      {
        id: "ap1",
        kind: "approval",
        label: "Ask before nudging",
        position: { x: 725, y: 260 },
        config: {
          message: "Task {{title}} moved to review with no summary yet. Post a reminder anyway?",
          noteField: "reviewer_note",
        },
      },
      {
        id: "o2",
        kind: "output",
        label: "Post to Today Feed",
        position: { x: 1065, y: 260 },
        config: {
          destination: "feed",
          botId: "alfie",
          title: "Needs summary: {{title}}",
          template: "Reviewer note: {{reviewer_note}}",
        },
      },
    ],
    edges: [
      { id: "e1", from: "t1", to: "c1", branch: "default" },
      { id: "e2", from: "c1", to: "a1", branch: "yes" },
      { id: "e3", from: "a1", to: "o1", branch: "default" },
      { id: "e4", from: "c1", to: "ap1", branch: "no" },
      { id: "e5", from: "ap1", to: "o2", branch: "approved" },
    ],
  },
  {
    id: "wf-github-ci",
    name: "PR CI Failure Alert",
    description: "Polls GitHub PR checks and notifies Glory when CI fails.",
    enabled: false,
    createdAt: now - 172800_000,
    updatedAt: now - 3600_000,
    nodes: [
      { id: "g1", kind: "trigger", triggerKind: "github", label: "Botkins PRs", position: { x: 60, y: 120 }, config: { repo: "promptclickrun/Botkins", events: ["ci_failed"], pollMinutes: 5 } },
      { id: "m1", kind: "model", label: "Classify failure", position: { x: 350, y: 120 }, config: { prompt: "Summarize failure on PR #{{number}} ({{title}})", outputFields: [{ name: "category", type: "string" }] } },
      { id: "o1", kind: "output", label: "Notify", position: { x: 640, y: 120 }, config: { destination: "notification", title: "CI failed on #{{number}}", template: "{{category}}: {{url}}" } },
    ],
    edges: [
      { id: "e1", from: "g1", to: "m1", branch: "default" },
      { id: "e2", from: "m1", to: "o1", branch: "default" },
    ],
  },
];

const workflowRuns = [
  {
    id: "wfrun-demo-1",
    workflowId: "wf-review-handoff",
    workflowName: "Task Review → Alfie Summary",
    triggerNodeId: "t1",
    triggerKind: "task",
    status: "completed",
    startedAt: now - 180_000,
    finishedAt: now - 171_400,
    error: null,
    context: {
      id: "task-761a",
      title: "Routines: event-based Workflows",
      bot: "Glory",
      from: "working",
      to: "review",
      result: "Opened PR #412 with canvas editor, 7 triggers, and 14/14 passing tests.",
      agent_reply: "Glory finished Workflows (PR #412): visual canvas, 7 triggers, tests & typecheck green.",
    },
    steps: {
      t1: { nodeId: "t1", kind: "trigger", label: "Task moves to Review", status: "completed", startedAt: now - 180_000, finishedAt: now - 179_990, summary: "task · review" },
      c1: { nodeId: "c1", kind: "condition", label: "Has PR result?", status: "completed", branch: "yes", startedAt: now - 179_980, finishedAt: now - 179_975, summary: "to equals review (true) AND result exists (true)" },
      a1: { nodeId: "a1", kind: "agent", label: "Alfie summarizes review", status: "completed", startedAt: now - 179_950, finishedAt: now - 171_700, summary: "Glory finished Workflows (PR #412)..." },
      o1: { nodeId: "o1", kind: "output", label: "Post to Alfie chat", status: "completed", startedAt: now - 171_680, finishedAt: now - 171_400, summary: "Posted to Alfie" },
      ap1: { nodeId: "ap1", kind: "approval", label: "Ask before nudging", status: "skipped", startedAt: now - 179_970, finishedAt: now - 179_970 },
      o2: { nodeId: "o2", kind: "output", label: "Post to Today Feed", status: "skipped", startedAt: now - 179_970, finishedAt: now - 179_970 },
    },
  },
];

mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(join(dir, "data", "workspace.json"), JSON.stringify({ bots, chats, runs: [], panels: [], workflows, workflowRuns }));

let app, page;
const errors = [];

try {
  app = await _electron.launch({
    args: process.env.BOTKINS_BINARY ? [] : ["."],
    executablePath: process.env.BOTKINS_BINARY,
    env,
  });
  page = await home(app);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.locator("aside nav").getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("heading", { name: "Work", exact: true }).waitFor();

  // Existing Work tabs unchanged
  await expect(page.locator("main").getByRole("tablist", { name: "Work" }).getByRole("tab")).toHaveText(["Routines", "Projects", "Tasks"]);

  // Switch Routines -> Workflows view (automatically opens the first workflow canvas)
  await page.getByRole("radio", { name: /^Workflows/ }).click();
  await expect(page.getByRole("textbox", { name: "Workflow name" })).toHaveValue("Task Review → Alfie Summary");
  await expect(page.locator(".wf-canvas-viewport")).toBeVisible();

  // Click the Agent node ("Alfie summarizes review") so the Inspector shows {{field}} chips!
  await page.locator(".wf-node").filter({ hasText: "Alfie summarizes review" }).click();
  await expect(page.locator(".wf-chip").first()).toBeVisible();

  if (qa) {
    mkdirSync(qa, { recursive: true });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), mode);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(qa, `workflows-canvas-${mode}.png`) });
    }
    // Also capture Runs history tab in dark mode for inspection
    await page.getByRole("tab", { name: /^Runs/ }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(qa, "workflows-runs-dark.png") });
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "system" } }));
  }

  // Verify Pause/Resume banner works live
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".wf-paused-banner")).toBeVisible();
  await page.locator(".wf-paused-banner").getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator(".wf-paused-banner")).toBeHidden();

  assert.deepEqual(errors, [], "Unexpected page errors: " + errors.join("; "));
  console.log("workflows-smoke: PASS");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
