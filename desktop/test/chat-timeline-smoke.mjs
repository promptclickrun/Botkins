// Renderer smoke for the ordered turn timeline. It uses only synthetic workspace data: no
// provider call is made. The folded transcript must retain the person's steer and the Details
// surface must expose work hidden by the Thinking and updates preference.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-timeline-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
seedApp(dir);
const workspaceFile = join(dir, "data", "workspace.json");
const workspace = JSON.parse(readFileSync(workspaceFile, "utf8"));
const bot = workspace.bots[0];
const chatId = randomUUID();
const runId = randomUUID();
const now = Date.now();
workspace.settings = { steps: "folded", thinking: "hidden" };
workspace.settings.onboarded = true;
workspace.chats.unshift({ id: chatId, botId: bot.id, title: "Ordered turn", time: now, established: true, messages: [
  { role: "user", text: "Start the work", runId, time: now },
  { role: "assistant", text: "I checked the first file.", interim: true, runId, time: now + 10 },
  { role: "user", text: "Continue with the second file", steeredRunId: runId, time: now + 20 },
  { role: "assistant", text: "All done.", runId, time: now + 30 },
] });
workspace.runs.unshift({
  id: runId,
  chatId,
  title: "Start the work",
  time: now,
  finished: now + 40,
  status: "Completed",
  detail: "",
  reasoning: [{ id: randomUUID(), text: "Read the workspace before writing.", started: now + 5 }],
  steps: [{ id: randomUUID(), name: "read_file", label: "Read file", status: "Done", started: now + 15, finished: now + 25 },
    { id: "bg", name: "Bash", label: "Build in background", input: JSON.stringify({ run_in_background: true }), status: "Done", started: now + 16 },
    { id: "latest", name: "view", label: "Inspect result", status: "Done", started: now + 21 }],
  // The activity feed groups these records independently of their storage order.
  todos: [{ id: "t1", title: "Check both files", status: "done" }, { id: "t2", title: "Write the summary", status: "pending" }],
  agents: [{ id: "h1", name: "File reader", description: "Reads the second file", status: "Done", started: now + 12, finished: now + 22 }],
});
const groupChatId = randomUUID();
const groupRunId = randomUUID();
const groupNow = Date.now();
workspace.chats.unshift({
  id: groupChatId,
  botId: workspace.bots[0].id,
  botIds: [workspace.bots[0].id, workspace.bots[1].id],
  title: "Pip, Scout",
  time: groupNow,
  established: true,
  messages: [
    { role: "user", text: "Ask both", runId: groupRunId, time: groupNow },
    { role: "assistant", text: "Pip is checking", interim: true, runId: groupRunId, botId: "pip", time: groupNow + 10 },
    { role: "assistant", text: "Pip found an answer", runId: groupRunId, botId: "pip", time: groupNow + 20 },
    { role: "command", text: "scout-search", runId: groupRunId, time: groupNow + 25 },
    { role: "assistant", text: "Scout is checking", interim: true, runId: groupRunId, botId: "scout", time: groupNow + 30 },
    { role: "assistant", text: "Scout found an answer", runId: groupRunId, botId: "scout", time: groupNow + 40 },
  ],
});
workspace.runs.unshift({
  id: groupRunId,
  chatId: groupChatId,
  title: "Ask both",
  time: groupNow,
  finished: groupNow + 50,
  status: "Completed",
  detail: "",
  speakers: ["pip", "scout"],
  reasoning: [],
  steps: [],
});
writeFileSync(workspaceFile, JSON.stringify(workspace));

let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const page = await home(app);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await expect(page.locator(".chathead-title h2")).toContainText(bot.name);
  // Use the same viewer-local preference record and change event as Settings.
  const display = (steps, thinking, foldFinishedSteps) => page.evaluate((choices) => {
    localStorage.setItem("botkins.chatDisplay", JSON.stringify(choices));
    window.dispatchEvent(new Event("botkins.chatDisplay"));
  }, { steps, stepsPicked: true, thinking, foldFinishedSteps });
  const current = await page.evaluate(() => window.botkins.snapshot());
  const publish = () => app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send("changed", snapshot), current);
  await display("folded", "hidden", true);
  await expect(page.locator(".timeline-fold-line")).toContainText("Worked for");
  await expect(page.locator("article.user").filter({ hasText: "Continue with the second file" })).toBeVisible();
  await expect(page.locator("article.assistant")).toContainText("All done.");
  const order = await page.locator(".chat-column > *").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.ok(order.findIndex((text) => text.includes("Continue with the second file")) < order.findIndex((text) => text.includes("All done.")), "the steer stays above the reply");
  await page.locator(".timeline-fold-line").click();
  await expect(page.locator(".timeline-person")).toContainText("Continue with the second file");
  await page.getByRole("region", { name: "Turn activity" }).getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Work activity" })).toContainText("I checked the first file.");
  await expect(page.getByRole("dialog", { name: "Work activity" })).toContainText("Read the workspace before writing.");
  const inOrder = (text, words) => words.map((word) => text.indexOf(word)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]));
  const seeded = structuredClone(current);
  const chips = await page.locator(".canvas-chips .canvas-chip").allInnerTexts();
  assert.match(chips[0] ?? "", /In the background/, "the helpers' chip is in the row above the message box");
  const orderInFeed = ["Tasks", "Check both files", "Subagents", "File reader", "Build in background", "Tool calls", "Inspect result", "Read file"];
  for (const feed of [page.locator(".timeline-fold-body"), page.getByRole("dialog", { name: "Work activity" })]) {
    const text = await feed.innerText();
    assert.ok(inOrder(text, orderInFeed), "activity sections and newest tools first: " + text);
  }
  const taskRail = page.getByRole("button", { name: /^Todos / });
  await expect(taskRail).toHaveCount(1);
  await expect(taskRail).toHaveText("Todos 1/2");
  await taskRail.click();
  await expect(page.locator("#task-drawer")).toContainText("Write the summary");
  await taskRail.click();
  const activeRun = current.runs.find((run) => run.id === runId);
  activeRun.status = "Working";
  await page.getByRole("button", { name: "Close work activity" }).click();
  await publish();
  await page.locator(".timeline-fold.live .timeline-fold-line").click();
  const liveTools = page.getByRole("dialog", { name: "Work activity" }).getByRole("region", { name: "Tool calls" });
  await expect(liveTools.locator("summary").first()).toContainText("Inspect result");
  activeRun.steps.push({ id: "live", name: "bash", label: "Check result", status: "Running", started: now + 31 });
  await publish();
  await expect(liveTools.locator("summary").first()).toContainText("Check result");
  const workingRail = page.locator(".timeline-fold.live .timeline-fold-line");
  const left = await workingRail.boundingBox();
  const right = await taskRail.boundingBox();
  assert.ok(right.x >= left.x + left.width - 1 && right.y < left.y + left.height, "Todos is to the right of Working");
  const activeChat = current.chats.find((chat) => chat.id === chatId);
  activeRun.status = "Completed";
  activeChat.todos = activeRun.todos;
  const nextTurn = () => {
    const id = randomUUID();
    const run = { id, chatId, time: Date.now(), status: "Working", title: "Next turn" };
    current.runs.unshift(run);
    activeChat.messages.push({ role: "user", text: run.title, runId: id, time: run.time });
    return run;
  };
  const next = nextTurn();
  await publish();
  await expect(workingRail.locator("..").getByRole("button", { name: "Todos 1/2" })).toBeVisible();
  next.todos = activeChat.todos = [
    { id: "t1", title: "Done task", status: "done" },
    { id: "t2", title: "Cancelled task", status: "cancelled" },
    { id: "t3", title: "Failed task", status: "failed" },
  ];
  next.status = "Completed";
  await publish();
  await expect(taskRail).toBeVisible();
  const fresh = nextTurn();
  await publish();
  await expect(taskRail).toHaveCount(0);
  fresh.todos = [{ id: "t4", title: "Fresh task", status: "pending" }];
  await publish();
  await expect(taskRail).toHaveText("Todos 0/1");
  await taskRail.click();
  await expect(page.locator("#task-drawer")).toContainText("Fresh task");
  // Back to the seeded turn, with its one step, for the display choices.
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, structuredClone(seeded));
  current.runs.find((item) => item.id === runId).steps.splice(1);
  await publish();
  if (await page.locator("#task-drawer").isVisible()) await page.getByRole("button", { name: /^Todos / }).click();
  const run = current.runs.find((item) => item.id === runId);
  const chat = current.chats.find((item) => item.id === chatId);
  const final = chat.messages.pop();
  const firstThought = run.reasoning[0].text;
  const secondThought = "Now check the second file.";
  const interim = "I checked the first file.";
  const titles = ["Read file", "Helper search", "Failed check", "Build index", "Verify index", "Load metadata"];
  run.reasoning.push({ id: "thought-two", text: secondThought, started: now + 17 });
  for (const [index, label] of titles.slice(1).entries()) {
    run.steps.push({ id: "extra-" + index, name: "read", label, status: index === 1 ? "Failed" : "Done", started: now + 21 + index, ...(index === 0 && { agentId: "h1" }) });
  }
  run.status = "Working";
  delete run.finished;
  await display("folded", "folded", true);
  await publish();
  const column = page.locator(".chat-column");
  const rail = column.locator(".timeline-fold-line");
  // Assert on the closed canvas first, then open the actual rail to verify each call is accessible.
  await expect(rail).toContainText("6 steps");
  await expect(column).not.toContainText(titles[0]);
  await expect(column).not.toContainText(firstThought);
  await expect(column).not.toContainText(secondThought);
  await expect(column).not.toContainText(interim);
  await rail.click();
  for (const title of [...titles, firstThought, secondThought, interim]) await expect(column).toContainText(title);
  const closeRail = async () => {
    const close = page.getByRole("button", { name: "Close work activity" });
    if (await close.isVisible()) await close.click();
    else await rail.click();
  };
  await closeRail();
  await display("open", "open", false);
  await expect(column.locator(".work-step-label")).toHaveText(titles);
  assert.ok(inOrder(await column.innerText(), [firstThought, interim, titles[0], secondThought, "Continue with the second file", ...titles.slice(1)]), "live activity follows event order");
  run.status = "Completed";
  run.finished = now + 40;
  chat.messages.push(final);
  await publish();
  await expect(column).toContainText("All done.");
  await expect(column.locator(".work-step-label")).toHaveText(titles);
  await expect(rail).toBeVisible();
  await display("failed", "hidden", false);
  await expect(column.locator(".work-step-label")).toHaveText(["Failed check"]);
  await expect(column).not.toContainText(interim);
  await expect(column).not.toContainText(firstThought);
  await rail.click();
  for (const title of titles) await expect(column).toContainText(title);
  await expect(column).not.toContainText(firstThought);
  await closeRail();
  await display("failed", "hidden", true);
  await expect(rail).toContainText("6 steps");
  await expect(column.locator(".work-step-label")).toHaveCount(0);
  await expect(column).toContainText("All done.");
  await display("folded", "folded", true);
  // A remote page can start at a steer, or deliver the run before any of its messages.
  chat.messages = chat.messages.filter((m) => m.text === "Continue with the second file" || m === final);
  await publish();
  await expect(column.locator("article.user")).toHaveCount(1);
  await expect(column.locator("article.assistant")).toHaveCount(1);
  await expect(rail).toHaveCount(1);
  chat.messages = [];
  run.status = "Working";
  delete run.finished;
  await display("open", "open", false);
  await publish();
  await expect(column.locator(".work-step-label")).toHaveText(titles);
  await expect(rail).toHaveCount(1);
  await display("folded", "folded", true);
  // A group turn has one run but several speakers. Each final reply must stay in the message
  // order around the shared activity, and the run's current speaker owns the live/status avatar.
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), groupChatId);
  await expect(page.locator(".chathead-title h2")).toContainText("Pip, Scout");
  await expect(page.locator(".chat-column")).toContainText("Pip found an answer");
  await expect(page.locator(".chat-column")).toContainText("Scout found an answer");
  assert.equal(await page.locator("article.assistant").filter({ hasText: "Pip found an answer" }).count(), 1, "Pip's reply is rendered once");
  assert.equal(await page.locator("article.assistant").filter({ hasText: "Scout found an answer" }).count(), 1, "Scout's reply is rendered once");
  const speakers = await page.locator(".chat-column .speaker-name").allTextContents();
  assert.ok(speakers.includes("Pip") && speakers.includes("Scout"), "group replies retain speaker identity");
  const groupOrder = await page.locator(".chat-column > *").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.ok(groupOrder.findIndex((text) => text.includes("Pip found an answer")) < groupOrder.findIndex((text) => text.includes("Scout found an answer")), "group replies retain order");
  await page.locator(".timeline-fold-line").click();
  await expect(page.locator(".interim-update").filter({ hasText: "Pip is checking" })).toBeVisible();
  const groupRun = current.runs.find((item) => item.id === groupRunId);
  groupRun.status = "Working";
  delete groupRun.finished;
  await publish();
  const groupRail = page.getByRole("region", { name: "Turn status" }).locator(".timeline-fold-line");
  // A live rail opens the turn's details at once.
  if (await groupRail.getAttribute("aria-expanded") === "false") await groupRail.click();
  await expect(groupRail).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "Work activity" })).toContainText("Pip is checking");
  await page.getByRole("button", { name: "Close work activity" }).click();
  groupRun.status = "Completed";
  groupRun.finished = groupNow + 50;
  await publish();
  await expect(page.getByRole("region", { name: "Turn activity" }).locator(".timeline-fold-line")).toHaveAttribute("aria-expanded", "false");
  console.log("Timeline renderer smoke: single and group turns retain order, speaker identity, and folded activity.");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
