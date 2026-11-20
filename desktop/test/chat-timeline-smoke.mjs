// Renderer smoke for the ordered turn timeline. It uses only synthetic workspace data: no
// provider call is made. The folded transcript must retain the person's steer and the Details
// surface must expose work hidden by the Thinking and updates preference.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-timeline-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
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
  steps: [{ id: randomUUID(), name: "read_file", label: "Read file", status: "Done", started: now + 15, finished: now + 25 }],
});
writeFileSync(workspaceFile, JSON.stringify(workspace));

let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const page = await skipWelcome(await app.firstWindow());
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await expect(page.locator(".chathead-title h2")).toContainText(bot.name);
  // Exercise the renderer's current setting, rather than relying on how the host happened to
  // serialize a fixture workspace. (The settings IPC is intentionally still owned by the host
  // preference work; this injects only an isolated renderer snapshot.)
  const current = await page.evaluate(() => window.botkins.snapshot());
  current.settings.steps = "folded";
  current.settings.thinking = "hidden";
  await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send("changed", snapshot), current);
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
  // A group turn has one run but several speakers. Each final reply must stay in the message
  // order around the shared activity, and the run's current speaker owns the live/status avatar.
  const groupChatId = randomUUID();
  const groupRunId = randomUUID();
  const groupNow = Date.now();
  current.chats.unshift({
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
  current.runs.unshift({
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
  await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send("changed", snapshot), current);
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
  console.log("Timeline renderer smoke: single and group turns retain order, speaker identity, and folded activity.");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
