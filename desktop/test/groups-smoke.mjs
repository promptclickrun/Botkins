// Group chats and coding sessions smoke: a 2-bot group made in the New chat dialog, labeled replies,
// @mention routing, a coding chat in a temp git repo, Project Changes with a diff, and Plan mode.
// Live checks need BOTKINS_LIVE=1. Set BOTKINS_GROUPS_SHOTS to a folder to save screenshots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-groups-ui-"));
const repo = join(dir, "repo");
const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "app"), COMMANDER_DATA_DIR: join(dir, "app") };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(join(dir, "app"));
delete env.ELECTRON_RUN_AS_NODE;
const live = (process.env.BOTKINS_LIVE ?? process.env.COMMANDER_LIVE) === "1";
const shots = (process.env.BOTKINS_GROUPS_SHOTS ?? process.env.COMMANDER_GROUPS_SHOTS);
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
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
}
const chatOf = async (id) => (await snap()).chats.find((c) => c.id === id);
const cancelled = [];
/** Waits for a run to end. Answers questions such as Plan mode's "exit plan" prompt with Cancel. */
async function finished(id, title, { cancelQuestions = false } = {}) {
  await wait(async () => {
    const s = await snap();
    if (cancelQuestions)
      for (const r of s.requests.filter((r) => r.chatId === id && r.kind !== "permission"))
        cancelled.push(r.title),
        await page.evaluate((rid) => window.botkins.respond(rid, { action: "cancel" }).catch(() => {}), r.id);
    const asked = s.requests.find((r) => r.chatId === id && r.kind === "permission");
    if (asked) return "asked: " + asked.title;
    const r = s.runs.find((r) => r.chatId === id && r.title === title.slice(0, 100));
    return r && r.status !== "Working" && s.streams[id] === undefined ? r.status : "pending";
  }).not.toBe("pending");
  const s = await snap();
  const asked = s.requests.find((r) => r.chatId === id && r.kind === "permission");
  assert.ok(!asked, "unexpected approval request: " + asked?.title);
  return s.runs.find((r) => r.chatId === id && r.title === title.slice(0, 100));
}
async function say(text) {
  await entry().fill(text);
  await entry().press("Escape");
  await button("Send message").click();
  await expect(entry()).toHaveValue("");
}

mkdirSync(repo);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "smoke@example.com");
git("config", "user.name", "Smoke");
writeFileSync(join(repo, "README.md"), "# Smoke repo\n");
git("add", "-A");
git("commit", "-qm", "first");

try {
  app = await _electron.launch({
    args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."],
    executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY),
    env,
  });
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  // The native folder dialog can't be driven, so "Add folder…" gets the temp repo.
  await app.evaluate(({ BrowserWindow, dialog }, folder) => {
    BrowserWindow.getAllWindows()[0].setSize(1190, 830);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, repo);
  await page.evaluate(() => window.botkins.setPreferences({ approval: "all" }));

  // 1. A 2-bot group chat from the New chat dialog.
  await button("New chat").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Pick Pip" }).check();
  await expect(dialog.getByLabel("Project")).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Pick Scout" }).check();
  // A group can join a project without a folder, so the picker stays; Add folder… is for one bot.
  await expect(dialog.getByLabel("Project")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add folder…" })).toBeHidden();
  await shot("new-chat-dialog");
  await dialog.getByRole("button", { name: "Start group chat" }).click();
  await expect(dialog).toBeHidden();
  const groupId = (await snap()).chats[0].id;
  const group = await chatOf(groupId);
  assert.deepEqual(group.botIds, ["pip", "scout"]);
  await expect(page.locator(".chathead h2")).toHaveText("Pip, Scout");
  await expect(page.locator(".chathead .group-avatars .bot-avatar")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Start the group chat" })).toBeVisible();
  await expect(button("Attach files")).toHaveCount(0);
  // Typing @ offers the members and everyone.
  await entry().fill("@");
  const mentions = page.getByRole("listbox", { name: "Mention a bot" });
  await expect(mentions.getByRole("option")).toHaveText([/@Pip/, /@Scout/, /@everyone/]);
  await entry().press("ArrowDown");
  await entry().press("Enter");
  await expect(entry()).toHaveValue("@Scout ");
  await entry().fill("");
  // The / menu still works.
  await entry().fill("/");
  await expect(page.getByRole("listbox", { name: "Commands, skills and tools" })).toBeVisible();
  await entry().fill("");
  console.log("Group chat made in the dialog; @ offers members and everyone; / still opens commands.");

  if (!live) {
    console.log("Set BOTKINS_LIVE=1 for real Copilot turns.");
  } else {
    // 2. Both bots answer, labeled, and the second sees the first.
    const first =
      "Quick game. Pip: reply with exactly one word, the name of a fruit, and nothing else. " +
      "Scout: reply with the exact fruit Pip named, in capital letters, and nothing else.";
    await say(first);
    await expect(page.locator("article.live")).toBeVisible({ timeout: 60000 });
    await expect(page.locator("article.live .speaker-name")).toContainText(/Pip|Scout/);
    await expect(page.locator("article.live")).not.toContainText("The group");
    const run1 = await finished(groupId, first);
    assert.equal(run1.status, "Completed", run1.detail);
    let replies = (await chatOf(groupId)).messages.filter((m) => m.role === "assistant");
    assert.deepEqual(replies.map((m) => m.botId), ["pip", "scout"]);
    const fruit = replies[0].text.replace(/[^\p{L}]/gu, "").toUpperCase();
    assert.ok(fruit.length > 1, replies[0].text);
    assert.ok(replies[1].text.toUpperCase().includes(fruit), "Scout echoed " + fruit + ": " + replies[1].text);
    await expect(page.locator("article.assistant .speaker-name")).toHaveText(["Pip", "Scout"]);
    console.log("Pip said " + JSON.stringify(replies[0].text) + "; Scout said " + JSON.stringify(replies[1].text) + ".");

    // 3. @mention: only Scout answers.
    const second = "@Scout reply with only the word ONLY-SCOUT.";
    await say(second);
    const run2 = await finished(groupId, second);
    assert.equal(run2.status, "Completed", run2.detail);
    replies = (await chatOf(groupId)).messages.filter((m) => m.role === "assistant");
    assert.deepEqual(replies.map((m) => m.botId), ["pip", "scout", "scout"]);
    assert.match(replies[2].text, /ONLY-SCOUT/);
    // Scout's two replies sit under one label only when they follow each other; here a user message is between.
    await expect(page.locator("article.assistant .speaker-name")).toHaveCount(3);
    console.log("@Scout routed the message to Scout only.");
    await shot("group-chat");

    // 4. A coding chat in a project, made in the New chat dialog with Add folder… and YOLO.
    await page.evaluate(() => window.botkins.setPreferences({ approval: "ask" }));
    await button("New chat").click();
    await dialog.getByRole("checkbox", { name: "Pick Patch" }).check();
    await dialog.getByRole("button", { name: "Add folder…" }).click();
    await expect(dialog.getByLabel("Project")).toHaveValue(/.+/);
    await dialog.getByRole("radio", { name: "YOLO" }).click();
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(dialog).toBeHidden();
    const codeId = (await snap()).chats[0].id;
    const code = await chatOf(codeId);
    const project = (await snap()).projects.find((p) => p.id === code.projectId);
    assert.equal(project.folder, repo);
    assert.equal(code.mode, "yolo");
    await expect(page.locator(".project-label")).toContainText("repo");
    await expect(page.locator(".project-label")).toContainText("YOLO");
    const create =
      "Create a file named hello.txt in the current working directory containing exactly the line: hi from patch. " +
      "Use your file creation tool, then reply with one short sentence.";
    await say(create);
    const run3 = await finished(codeId, create);
    assert.equal(run3.status, "Completed", run3.detail);
    assert.ok(existsSync(join(repo, "hello.txt")), "hello.txt was created in the project");
    console.log("Patch created hello.txt in the project folder without asking (YOLO).");

    // 5. Project Changes lists the file and shows its diff.
    await button("Changes").click();
    const panel = page.getByRole("region", { name: "Project changes" });
    await expect(panel).toContainText("main");
    await expect(panel.locator(".pc-files")).toContainText("hello.txt");
    await shot("project-changes");
    await panel.getByRole("button", { name: /hello\.txt/ }).click();
    await expect(panel.locator(".diff-view")).toContainText("+hi from patch");
    await shot("project-diff");
    console.log("Project Changes showed hello.txt and its diff.");

    // 6. Plan mode doesn't change files, even with approvals set to allow everything.
    await page.evaluate(() => window.botkins.setPreferences({ approval: "all" }));
    await button("New chat").click();
    await dialog.getByRole("checkbox", { name: "Pick Patch" }).check();
    await dialog.getByLabel("Project").selectOption({ label: "repo" });
    await dialog.getByRole("radio", { name: "Plan" }).click();
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(dialog).toBeHidden();
    const planId = (await snap()).chats[0].id;
    assert.equal((await chatOf(planId)).mode, "plan");
    await expect(page.locator(".project-label")).toContainText("Plan");
    const plan = "Create a file named plan-test.txt in the current working directory containing the word plan.";
    await say(plan);
    const run4 = await finished(planId, plan, { cancelQuestions: true });
    assert.ok(!existsSync(join(repo, "plan-test.txt")), "plan mode must not create files");
    console.log(
      "Plan mode left the project unchanged (run " + run4.status + ": " + (run4.detail || "no detail") + "). " +
        "Questions cancelled: " + JSON.stringify(cancelled.map((t) => String(t).slice(0, 80))),
    );
    // The chats list shows group members and the coding chat's folder.
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats" }).click();
    await expect(page.locator(".row-folder").first()).toContainText("repo");
    await expect(page.locator(".row .group-avatars")).toHaveCount(1);
    await shot("chats-list");
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Groups smoke passed. No renderer exceptions.");
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
}
