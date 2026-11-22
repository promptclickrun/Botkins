// Chat canvas smoke: thinking, work summary, todos, usage, queue, attachments and fork.
// Live checks need BOTKINS_LIVE=1. Set BOTKINS_CANVAS_SHOTS to a folder to save screenshots.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-canvas-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const live = process.env.BOTKINS_LIVE === "1";
const shots = process.env.BOTKINS_CANVAS_SHOTS;
let app, page;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const entry = () => page.getByRole("combobox", { name: "Message", exact: true });
const snap = () => page.evaluate(() => window.botkins.snapshot());
const wait = (fn, timeout = 300000) => expect.poll(fn, { timeout, intervals: [200, 500, 1000] });
const theme = (mode) =>
  page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
async function shot(name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
}
const chatOf = async (id) => (await snap()).chats.find((c) => c.id === id);
const runOf = async (id, title) =>
  (await snap()).runs.find((r) => r.chatId === id && r.title === title.slice(0, 100));
async function done(id, title) {
  await wait(async () => {
    const s = await snap();
    const r = s.runs.find((r) => r.chatId === id && r.title === title.slice(0, 100));
    return r && r.status !== "Working" && s.streams[id] === undefined ? r.status : "pending";
  }).not.toBe("pending");
  const r = await runOf(id, title);
  assert.equal(r.status, "Completed", r.detail);
  return r;
}
async function openChat(name = "Pip") {
  await button("New chat").click();
  await page.getByRole("dialog").getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const s = await snap();
  return s.chats[0].id;
}

try {
  app = await _electron.launch({
    args: process.env.BOTKINS_BINARY ? [] : ["."],
    executablePath: process.env.BOTKINS_BINARY,
    env,
  });
  page = await home(app);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1190, height: 830 }).catch(() => {});
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.evaluate(() => window.botkins.setPreferences({ approval: "all" }));

  // Empty chat: a role-fitting question with starter prompts that fill the composer.
  const id = await openChat();
  await expect(page.getByRole("heading", { name: "What can Pip help with?" })).toBeVisible();
  const starter = page.locator(".starters button").first();
  const starterText = await starter.textContent();
  await starter.click();
  await expect(entry()).toHaveValue(starterText);
  await shot("empty");
  await entry().fill("");
  console.log("Empty chat shows starters that fill the composer.");

  if (!live) {
    console.log("Set BOTKINS_LIVE=1 for real Copilot turns.");
  } else {
    const code = "kestrel-" + randomUUID().slice(0, 6);
    const main =
      "Remember the codeword " +
      code +
      ". Before you answer, think it through. Then: 1) make a 3-step plan with your todo list tool (insert three rows into the todos table with the sql tool), " +
      "2) run `ls -la` in your working folder with your shell tool, 3) mark all three todos done. Finally reply with one short sentence.";
    await entry().fill(main);
    await button("Send message").click();
    await expect(entry()).toHaveValue("");
    // Queue a message while the bot works.
    await wait(async () => (await snap()).streams[id] !== undefined, 60000).toBe(true);
    const queuedText = "Reply with the single word QUEUED-OK and nothing else.";
    await entry().fill(queuedText);
    await button("Queue message").click();
    await expect(page.getByRole("region", { name: "Queued messages" })).toContainText("QUEUED-OK");
    assert.equal((await snap()).queued[id]?.[0]?.text, queuedText);
    // Wait for visible work so the live screenshot shows it.
    await wait(async () => ((await runOf(id, main))?.steps?.length ?? 0) > 0, 180000).toBe(true);
    await expect(page.locator(".work-live")).toBeVisible();
    await expect(page.locator(".work-live")).toContainText("Pip is working");
    await shot("live-turn");
    const run = await done(id, main);
    assert.ok(run.steps.length >= 1, "steps recorded");
    assert.ok(run.summary, "work summary recorded");
    assert.ok(run.usage && run.usage.input > 0 && run.usage.output > 0, JSON.stringify(run.usage));
    console.log(
      "Main turn: " + run.steps.length + " steps · summary “" + run.summary + "” · usage " + JSON.stringify(run.usage),
    );
    console.log(
      run.reasoning?.length
        ? "Reasoning recorded: " + run.reasoning.length + " block(s), " + run.reasoning.reduce((n, r) => n + r.text.length, 0) + " chars."
        : "The model emitted no reasoning for this turn (model " + (run.usage?.model ?? run.model?.model) + ").",
    );
    if (run.todos?.length) console.log("Todos: " + run.todos.map((t) => t.status).join(", "));
    else console.log("The model did not write todos this turn.");
    const ctx = (await chatOf(id)).context;
    console.log("Context: " + JSON.stringify(ctx));
    // The queued message goes next.
    const queuedRun = await done(id, queuedText);
    assert.ok(queuedRun.time >= run.time);
    const replies = (await chatOf(id)).messages;
    assert.match(replies.at(-1).text, /QUEUED-OK/);
    assert.equal((await snap()).queued[id], undefined);
    console.log("Queued message was sent after the turn and answered.");
    // Finished turn UI: one folded row with the summary.
    const trail = page.locator(".work-done").first();
    await expect(trail).toContainText("Worked for");
    await expect(trail).toContainText(run.summary);
    if (run.reasoning?.length) await expect(page.locator(".reasoning").first()).toContainText("Thought for");
    if (run.todos?.length || (await chatOf(id)).todos?.length) {
      await page.locator(".canvas-chip", { hasText: "Tasks" }).click();
      await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();
    }
    if (ctx) await expect(page.locator(".context-meter")).toContainText("% of context");
    const scrollable = await page
      .locator(".messages")
      .evaluate((el) => ((el.scrollTop = 0), el.scrollHeight - el.clientHeight > 60));
    await shot("finished-turn");
    if (scrollable) {
      await expect(button("Scroll to latest message")).toBeVisible();
      await button("Scroll to latest message").click();
      await expect(button("Scroll to latest message")).toBeHidden();
      console.log("Scroll to latest message appears when scrolled up and goes back.");
    }

    // Attachment: the bot reads a temp file.
    const secret = "plum-" + randomUUID().slice(0, 6);
    const file = join(dir, "attached-note.txt");
    writeFileSync(file, "The secret word is " + secret + ".\n");
    const ask = "What is the secret word in the attached file? Reply with the word only.";
    await page.evaluate(
      ([id, ask, file]) => window.botkins.send(id, ask, { attachments: [{ path: file, name: "attached-note.txt" }] }),
      [id, ask, file],
    );
    await done(id, ask);
    const chat = await chatOf(id);
    assert.ok(chat.messages.at(-1).text.includes(secret), chat.messages.at(-1).text);
    assert.equal(chat.messages.findLast((m) => m.role === "user").attachments[0].name, "attached-note.txt");
    await expect(page.locator("article.user .attach-chips").last()).toContainText("attached-note.txt");
    console.log("The bot read the attached file.");

    // Fork from the first reply: the fork knows the codeword.
    const index = chat.messages.findIndex((m) => m.role === "assistant");
    const forkId = await page.evaluate(([id, i]) => window.botkins.forkChat(id, i), [id, index]);
    const fork = await chatOf(forkId);
    assert.equal(fork.messages.length, index + 1);
    console.log("Forked " + (fork.forkContext ? "with a transcript" : "with Copilot's native fork") + ".");
    const recall = "What codeword did I ask you to remember? Reply with the codeword only.";
    await page.evaluate(([id, t]) => window.botkins.send(id, t), [forkId, recall]);
    await done(forkId, recall);
    const answer = (await chatOf(forkId)).messages.at(-1).text;
    assert.ok(answer.includes(code), answer);
    console.log("The fork remembered the codeword.");
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Canvas smoke passed. No renderer exceptions.");
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
