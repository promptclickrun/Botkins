// Renderer smoke for the ordered turn timeline. It uses only synthetic workspace data: no
// provider call is made. The folded transcript must retain the person's steer, and the side pane's
// Activity tab (Details) must expose work hidden by the Thinking and updates preference.
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
  }, { steps, stepsPicked: true, thinking, thinkingPicked: true, foldFinishedSteps });
  const current = await page.evaluate(() => window.botkins.snapshot());
  // The window keeps the newest whole state it was sent (src/hotState.ts): the test's states stay newer
  // than any the app sends while the test clicks around.
  let seq = 1e9;
  const publish = () => app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send("changed", snapshot), { ...current, seq: ++seq });
  await display("folded", "hidden", true);
  await expect(page.locator(".timeline-fold-line")).toContainText("Worked for");
  await expect(page.locator("article.user").filter({ hasText: "Continue with the second file" })).toBeVisible();
  await expect(page.locator("article.assistant")).toContainText("All done.");
  const order = await page.locator(".chat-column > *").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.ok(order.findIndex((text) => text.includes("Continue with the second file")) < order.findIndex((text) => text.includes("All done.")), "the steer stays above the reply");
  await page.locator(".timeline-fold-line").click();
  await expect(page.locator(".timeline-person")).toContainText("Continue with the second file");
  // The fold opens to the turn's chapters, one line each.
  await expect(page.locator(".timeline-fold-body .chapter-summary")).toContainText("I checked the first file.");
  await page.getByRole("region", { name: "Turn activity" }).getByRole("button", { name: "Details", exact: true }).click();
  // Details is the side pane's Activity tab: the whole story, the thinking and updates the chat hides included.
  const activity = page.locator(".activity-inspector");
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(activity).toContainText("I checked the first file.");
  await expect(activity).toContainText("Read the workspace before writing");
  const inOrder = (text, words) => words.map((word) => text.indexOf(word)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]));
  const seeded = structuredClone(current);
  const chips = await page.locator(".canvas-chips .canvas-chip").allInnerTexts();
  assert.equal(chips.some((c) => /In the background/.test(c)), false, "no background helper bar above the message box");
  const story = await activity.locator(".insp-list").innerText();
  assert.ok(inOrder(story, ["Read the workspace before writing", "I checked the first file.", "Read file", "Build in background", "Inspect result"]), "the story is in the order it happened: " + story);
  // Once finished, the crew summary is folded into the turn's fold line rather than a separate crew card.
  await expect(page.getByRole("region", { name: "Crew" })).toHaveCount(0);
  await expect(page.locator(".timeline-fold-line")).toContainText("1 helper finished");
  const taskRail = page.getByRole("button", { name: /^Todos / });
  await expect(taskRail).toHaveCount(1);
  await expect(taskRail).toHaveText("Todos 1/2");
  await taskRail.click();
  await expect(page.locator("#task-drawer")).toContainText("Write the summary");
  await taskRail.click();
  const activeRun = current.runs.find((run) => run.id === runId);
  activeRun.status = "Working";
  await publish();
  // While the turn runs, the crew card sits in the feed and a row opens the Crew tab on that helper.
  const crewCard = page.getByRole("region", { name: "Crew" });
  await expect(crewCard.locator(".crew-card-head")).toHaveAttribute("aria-expanded", "false");
  await expect(crewCard).toContainText("1 helper");
  await crewCard.locator(".crew-card-head").click();
  await crewCard.getByRole("button", { name: /^File reader/ }).click();
  await expect(page.getByRole("tab", { name: "Crew" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".crew-member")).toContainText("Reads the second file");
  await crewCard.locator(".crew-card-head").click();
  // A live turn's quiet status line above the message box opens Activity on it, and the story follows new steps.
  const statusLine = page.locator(".turn-status-line");
  await statusLine.click();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(activity.locator(".insp-row").last()).toContainText("Inspect result");
  activeRun.steps.push({ id: "live", name: "bash", label: "Check result", status: "Running", started: now + 31 });
  await publish();
  await expect(activity.locator(".insp-row").last()).toContainText("Check result");
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
  await expect(page.getByRole("button", { name: "Todos 1/2" })).toBeVisible();
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
  const liveStatus = page.locator(".turn-status-line");
  // Assert on the closed canvas first, then open the actual rail to verify each call is accessible.
  // A helper's own step ("Helper search") is the crew's, not the bot's: 5 steps.
  await expect(liveStatus).toContainText("5 steps");
  await expect(column).not.toContainText(titles[0]);
  await expect(column).not.toContainText(firstThought);
  await expect(column).not.toContainText(secondThought);
  // Updates are their own switch: they stay in the chat whatever Steps and Thinking are set to.
  await expect(column).toContainText(interim);
  const ownTitles = titles.filter((title) => title !== "Helper search");
  // The live status line opens Activity: every step of the bot's, the thinking and the update.
  await liveStatus.click();
  for (const title of [...ownTitles, "Read the workspace before writing", "Now check the second file", interim]) await expect(activity).toContainText(title);
  // The helper's step is on the Crew tab, under that helper.
  await page.getByRole("tab", { name: "Crew" }).click();
  await expect(page.locator(".crew-member")).toContainText("Helper search");
  const closeRail = async () => {
    const close = page.getByRole("button", { name: "Close side pane" });
    if (await close.isVisible()) await close.click();
  };
  await closeRail();
  await display("open", "open", false);
  // Open is the activity island: the newest four lines in one card, updates still in the chat,
  // and every line in order once its header is clicked open.
  const island = column.getByRole("region", { name: "Turn status" });
  await expect(island.locator(".island-window .island-row")).toHaveCount(4);
  await expect(island.locator(".island-window")).toHaveClass(/clipped/);
  await expect(column).toContainText(interim);
  await expect(column.locator(".work-step-label")).toHaveCount(0);
  await island.locator(".island-head").click();
  await expect(island.locator(".island-head")).toHaveAttribute("aria-expanded", "true");
  assert.ok(inOrder(await island.locator(".island-list").innerText(), ["Read the workspace before writing", titles[0], "Now check the second file", ...ownTitles.slice(1)]), "the island lists every line in event order");
  // A line in the full list opens Activity on it.
  await island.locator(".island-item-open", { hasText: "Failed check" }).click();
  await expect(activity.locator(".insp-sel")).toContainText("Failed check");
  await closeRail();
  await island.getByRole("button", { name: "Show less" }).click();
  await expect(island.locator(".island-head")).toHaveAttribute("aria-expanded", "false");
  run.status = "Completed";
  run.finished = now + 40;
  chat.messages.push(final);
  await publish();
  await expect(column).toContainText("All done.");
  // The finished island folds into a receipt under the answer.
  await expect(column.locator(".island-rc")).toContainText("5 steps");
  assert.ok(inOrder(await column.innerText(), ["All done.", "Worked"]), "the receipt is under the answer");
  // The receipt opens Activity on the first failed step.
  await column.locator(".island-rc").click();
  await expect(activity.locator(".insp-sel")).toContainText("Failed check");
  await closeRail();
  await expect(rail).toHaveCount(0);
  await display("failed", "hidden", false);
  await expect(column.locator(".work-step-label")).toHaveText(["Failed check"]);
  // A finished turn's update folds with its thinking (src/liveDisplay.ts): it is in the fold, not the chat.
  await expect(column.locator(".interim-update")).toHaveCount(0);
  await expect(column).not.toContainText(firstThought);
  // The failed step's row opens Activity on it.
  await column.locator(".work-step-open", { hasText: "Failed check" }).click();
  await expect(activity.locator(".insp-sel")).toContainText("Failed check");
  await closeRail();
  await rail.click();
  await expect(column.locator(".chapter-summary")).toContainText(interim);
  await expect(column).not.toContainText(firstThought);
  await page.getByRole("region", { name: "Turn activity" }).getByRole("button", { name: "Details", exact: true }).click();
  for (const title of ownTitles) await expect(activity).toContainText(title);
  await closeRail();
  await display("failed", "hidden", true);
  await expect(rail).toContainText("5 steps");
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
  await expect(column.getByRole("region", { name: "Turn status" })).toHaveCount(1);
  await expect(column.locator(".island-head")).toHaveCount(1);
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
  await expect(page.locator(".chapter-summary")).toContainText("Pip is checking");
  const groupRun = current.runs.find((item) => item.id === groupRunId);
  groupRun.status = "Working";
  delete groupRun.finished;
  await publish();
  const groupRail = page.getByRole("region", { name: "Turn status" }).locator(".timeline-fold-line");
  // A live rail opens the turn's Activity at once.
  await groupRail.click();
  await expect(page.locator(".activity-inspector")).toContainText("Pip is checking");
  await page.getByRole("button", { name: "Close side pane" }).click();
  groupRun.status = "Completed";
  groupRun.finished = groupNow + 50;
  await publish();
  await expect(page.getByRole("region", { name: "Turn activity" }).locator(".timeline-fold-line")).toHaveAttribute("aria-expanded", "false");
  console.log("Timeline renderer smoke: single and group turns retain order, speaker identity, and folded activity.");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
