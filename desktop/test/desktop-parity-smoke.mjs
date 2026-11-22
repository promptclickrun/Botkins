// Isolated desktop parity smoke. It exercises the user-facing pieces shared with the phone
// without contacting a model provider or touching a real Botkins profile.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp, starterBots } from "./starter.mjs";
import { home } from "./welcome-helper.mjs";

const data = mkdtempSync(join(tmpdir(), "botkins-parity-ui-"));
const qa = process.env.BOTKINS_QA_DIR;
if (qa) mkdirSync(qa, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;

function seedChat() {
  const time = Date.now() - 10_000;
  writeFileSync(join(data, "data", "workspace.json"), JSON.stringify({
    bots: starterBots,
    chats: [{
      id: "fold-smoke-chat",
      botId: "pip",
      title: "Folded turn fixture",
      time,
      messages: [
        { role: "user", text: "Summarise the fixture.", runId: "fold-smoke-run", time },
        { role: "assistant", text: "I checked the fixture files.", interim: true, runId: "fold-smoke-run", time: time + 100 },
        { role: "assistant", text: "The fixture is ready.", runId: "fold-smoke-run", time: time + 300 },
      ],
    }],
    runs: [{
      id: "fold-smoke-run",
      chatId: "fold-smoke-chat",
      title: "Summarise the fixture.",
      time,
      status: "Completed",
      detail: "Completed",
      finished: time + 800,
      steps: [{ id: "step-1", name: "read", label: "Read fixture", status: "completed", started: time + 150, finished: time + 250 }],
      summary: "Read 1 file",
    }],
  }));
}

const launch = () => _electron.launch({
  args: process.env.BOTKINS_BINARY ? [] : ["."],
  executablePath: process.env.BOTKINS_BINARY,
  env,
  timeout: 120_000,
});
const shot = async (page, name) => {
  if (qa) await page.screenshot({ path: join(qa, name + ".png"), fullPage: true });
};
const snap = (page) => page.evaluate(() => window.botkins.snapshot());

seedApp(data);
seedChat();
let app;
try {
  app = await launch();
  const page = await home(app);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await shot(page, "home-initial");

  const initial = await snap(page);
  assert.equal(initial.bots[0].id, "pip", "the primary bot starts first");
  assert.equal(await page.locator('.botcard-wrap[draggable="true"]').count(), 2, "only non-primary bots can be dragged");

  // Add an empty section, then use the same HTML drag/drop path as a person moving a bot.
  const emptySection = await page.evaluate(() => window.botkins.addSection("Empty section"));
  await expect.poll(async () => (await snap(page)).sections.some((section) => section.id === emptySection)).toBe(true);
  async function dragTo(botId, label) {
    await page.evaluate((id) => {
      const source = [...document.querySelectorAll(".botcard-wrap")].find((item) => item.textContent.includes(id === "scout" ? "Scout" : "Patch"));
      if (!source) throw new Error("drag source not found: " + id);
      const data = new DataTransfer();
      data.setData("application/x-botkins-bot", id);
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    }, botId);
    await expect(page.locator(".bot-drop-zones")).toBeVisible();
    await page.evaluate(({ botId, label }) => {
      const zone = [...document.querySelectorAll(".bot-drop-zones > div")].find((item) => item.textContent.trim().includes(label));
      if (!zone) throw new Error("drop zone not found: " + label);
      const data = new DataTransfer();
      data.setData("application/x-botkins-bot", botId);
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: data }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
    }, { botId, label });
  }
  await dragTo("scout", "Pinned");
  await expect.poll(async () => (await snap(page)).bots.find((bot) => bot.id === "scout")?.pinned).toBe(true);
  await page.waitForTimeout(150);
  await dragTo("patch", "Empty section");
  await expect.poll(async () => (await snap(page)).bots.find((bot) => bot.id === "patch")?.sectionId).toBe(emptySection);
  await shot(page, "home-arranged");

  // The saved arrangement survives a renderer restart in this isolated profile.
  await app.close();
  app = await launch();
  const restarted = await home(app);
  await expect(restarted.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const persisted = await snap(restarted);
  assert.equal(persisted.bots.find((bot) => bot.id === "scout")?.pinned, true);
  assert.equal(persisted.bots.find((bot) => bot.id === "patch")?.sectionId, emptySection);

  const settings = restarted.getByRole("dialog", { name: "Settings" });
  await restarted.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  const tabs = settings.getByRole("tablist", { name: "Settings" });
  await tabs.getByRole("tab", { name: "Voice", exact: true }).click();
  await expect(settings.getByText("Dictation", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: /Dictation/ }).click();
  await expect(settings.locator("h2", { hasText: "Dictation" })).toBeVisible();
  await settings.getByRole("combobox", { name: "Speech to text" }).selectOption("openai");
  await expect(settings.getByRole("button", { name: "Set up OpenAI", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Set up OpenAI", exact: true }).click();
  await expect(settings.locator("h2", { hasText: "Keys and servers" })).toBeVisible();
  await expect(settings.locator('[data-voice-provider="openai"]')).toBeVisible();
  await settings.getByRole("button", { name: /Voice$/ }).click();
  await settings.getByRole("button", { name: /Reading aloud/ }).click();
  await expect(settings.locator("h2", { hasText: "Reading aloud" })).toBeVisible();
  await settings.getByRole("button", { name: /Voice$/ }).click();
  await settings.getByRole("button", { name: /Live voice/ }).click();
  await expect(settings.locator("h2", { hasText: "Live voice" })).toBeVisible();
  const ptt = settings.getByRole("radio", { name: "Push to talk" });
  await ptt.click();
  assert.equal(await restarted.evaluate(() => localStorage.getItem("botkins.liveInput")), "ptt");
  await settings.getByRole("button", { name: /Voice$/ }).click();
  await settings.getByRole("button", { name: /^Keys and servers/ }).click();
  await expect(settings.locator("h2", { hasText: "Keys and servers" })).toBeVisible();
  await shot(restarted, "settings-voice");

  await settings.locator('.set-sidebar [role="tab"]').filter({ hasText: "Chat" }).click();
  await expect(settings.getByText(/Fold finished tool activity|Steps/).first()).toBeVisible();
  await expect(settings.getByText(/Show the bot.s thinking|Thinking and updates/).first()).toBeVisible();
  await shot(restarted, "settings-chat");
  await settings.getByRole("button", { name: "Close dialog" }).click();

  // Open the seeded chat and check the final reply and the interim text remain in the renderer.
  await restarted.getByRole("button", { name: "Chats", exact: true }).click();
  await restarted.getByRole("button", { name: /Folded turn fixture/ }).click();
  await expect(restarted.locator("main").getByText("The fixture is ready.", { exact: true })).toBeVisible();
  const work = restarted.getByRole("button", { name: /Worked for .*1 step/ });
  await expect(work).toBeVisible();
  await work.click();
  await expect(restarted.locator("main").getByText("I checked the fixture files.", { exact: true })).toBeVisible();
  await shot(restarted, "chat-folded");

  assert.deepEqual(errors, [], "renderer has no uncaught errors");
  console.log("desktop parity smoke: ok" + (qa ? ". Screenshots in " + qa : ""));
} finally {
  await app?.close().catch(() => {});
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
