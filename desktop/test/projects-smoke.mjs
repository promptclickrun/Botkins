// Projects and agent access smoke, in an isolated data folder. No Copilot turns.
// Projects are a tab of Work. Creates a project with to-dos, adds a chat that already exists (and removes it), attaches an
// artifact, then turns global access off and checks that a bot without access is blocked in the UI and the
// backend until it gets a grant. Set BOTKINS_CP_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { openToday } from "./spaces-helper.mjs";
import { seedApp } from "./starter.mjs";
import { fileDetails } from "../desktop/artifact-files.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-cp-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: join(dir, "app") };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(join(dir, "app"));
// A chat that has started, for "Add a chat…", and a file a bot made in it, for "Attach an artifact…".
{
  const file = join(dir, "app", "data", "workspace.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const time = Date.now() - 60_000;
  data.chats.push({ id: "seeded-pip", botId: "pip", title: "Mailbox plan", time, established: false, messages: [
    { role: "user", text: "Plan the mailbox move.", time },
    { role: "assistant", text: "Here is a first plan.", time, botId: "pip" },
  ] });
  writeFileSync(file, JSON.stringify(data));
  const made = join(dir, "cutover-plan.md");
  writeFileSync(made, "# Cutover plan\n\nFinance moves first.\n");
  const info = fileDetails(made);
  writeFileSync(join(dir, "app", "data", "artifacts.json"), JSON.stringify([
    { id: "seeded-plan", botId: "pip", chatId: "seeded-pip", messageIndex: 1, source: "tool", path: info.path, identity: info.identity, time },
  ]));
}
delete env.ELECTRON_RUN_AS_NODE;
const shots = process.env.BOTKINS_CP_SHOTS;
let app, page;
const errors = [];
const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
const snap = () => page.evaluate(() => window.botkins.snapshot());
const sidebar = (name) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name, exact: true });
// Projects are the middle tab of Work.
const openProjects = async () => {
  await sidebar("Work").click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute("aria-selected", "true");
};
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
async function shot(name, locator, tall = false) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  // A tall element is captured whole by letting the page grow past the window for the shot.
  const unclip = ".shell{height:auto!important}.shell main,.content{overflow:visible!important}.project-menu{position:static!important}";
  if (tall) await page.addStyleTag({ content: unclip });
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
    await page.waitForTimeout(250);
    await (locator ?? page).screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
  if (tall) await page.evaluate(() => document.querySelectorAll("style").forEach((el) => el.textContent?.startsWith(".shell{height:auto") && el.remove()));
}

try {
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  page = await home(app);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 860));
  const initial = await snap();
  assert.equal(initial.settings.access.allBots, true, "access is global by default");

  // 1. A project, with to-dos.
  await expect(sidebar("Projects")).toHaveCount(0);
  await sidebar("Work").click();
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Work" }).getByRole("tab")).toHaveText(["Routines", "Projects", "Tasks"]);
  await expect(page.getByRole("tab", { name: "Routines", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await expect(sidebar("Work")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Start a project" })).toBeVisible();
  await button("New project").first().click();
  const create = page.getByRole("dialog", { name: "New project" });
  await expect(create.getByLabel("Name")).toBeVisible();
  await expect(create.getByRole("combobox")).toHaveCount(0);
  await create.getByLabel("Name").fill("Mail migration");
  await create.getByLabel("Description").fill("Move the mailboxes to the cloud by Q3.");
  await button("Create project", create).click();
  await expect(page.getByRole("heading", { name: "Mail migration", level: 1 })).toBeVisible();
  await expect(page.locator(".project-meta")).toHaveCount(0);
  const project = (await snap()).projects.find((p) => p.name === "Mail migration");
  assert.equal(project.folder, undefined);
  const menu = page.getByRole("navigation", { name: "Project sections" });
  await expect(button("Changes", menu)).toHaveCount(0);
  await menu.getByRole("button", { name: /To-do/ }).click();
  for (const text of ["Inventory mailboxes", "Pilot with IT", "Schedule cutover"]) {
    await page.getByLabel("New to-do").fill(text);
    await page.getByLabel("New to-do").press("Enter");
    await expect(page.getByLabel("New to-do")).toHaveValue("");
  }
  await page.getByLabel("Check off Inventory mailboxes").click();
  await expect(page.getByLabel("Reopen Inventory mailboxes")).toBeChecked();
  await button("Move Schedule cutover up").click();
  await expect(page.getByRole("list", { name: "Open to-dos" }).getByRole("listitem")).toHaveText([/Schedule cutover/, /Pilot with IT/]);
  await expect(page.getByRole("list", { name: "Done to-dos" })).toContainText("Inventory mailboxes");
  let todos = (await snap()).projects.find((p) => p.id === project.id).todos;
  assert.deepEqual(todos.map((t) => [t.text, t.done]), [["Inventory mailboxes", true], ["Schedule cutover", false], ["Pilot with IT", false]]);
  console.log("Project made; to-dos added, checked off and reordered.");

  // 2. A chat in the project.
  await menu.getByRole("button", { name: /Chats/ }).click();
  await button("Start chat with Pip").click();
  await expect(page.locator(".chathead h2")).toHaveText("Pip");
  await expect(page.locator(".project-label")).toContainText("Mail migration");
  await expect(button("Changes")).toHaveCount(0);
  const blank = (await snap()).chats[0];
  assert.equal(blank.projectId, project.id);
  assert.equal(blank.mode, "default");
  // A new chat nobody wrote in is archived when it is left.
  await sidebar("Chats").click();
  await expect.poll(async () => (await snap()).chats.find((c) => c.id === blank.id).archived).toBe(true);
  console.log("Started a chat in the project; left without a message, it is archived.");

  // 2b. A chat that already exists is added to the project.
  await openProjects();
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await menu.getByRole("button", { name: /Chats/ }).click();
  await expect(page.getByRole("region", { name: "Chats", exact: true })).toContainText("No chats in this project yet");
  // The sections are the phone app's, in its order, between the computer's own Overview and Changes.
  // (Panels is "Spaces and panels" on a computer with Spaces.)
  await expect(menu.getByRole("button")).toHaveText([/Overview/, /To-do/, /Chats/, /Artifacts/, /[Pp]anels/, /Access/]);
  await button("Add a chat…").click();
  const adding = page.getByRole("dialog", { name: "Add chats" });
  await adding.getByLabel("Search chats").fill("nothing like this");
  await expect(adding).toContainText("No chats match.");
  await adding.getByLabel("Search chats").fill("mailbox");
  await shot("project-add-chat", adding);
  await button("Add Mailbox plan", adding).click();
  await expect(adding).toContainText("There are no other chats to add.");
  await button("Done", adding).click();
  await expect(adding).toBeHidden();
  await expect(page.locator(".project-chats .row")).toHaveCount(1);
  await expect(button("Add a chat…")).toBeDisabled();
  // "Remove from project" in the chat's row menu takes it out; adding it again puts it back.
  await page.locator(".project-chats").getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Remove from project" }).click();
  await expect(page.locator(".project-chats .row")).toHaveCount(0);
  assert.equal("projectId" in (await snap()).chats.find((c) => c.id === "seeded-pip"), false);
  await button("Add a chat…").click();
  await button("Add Mailbox plan", adding).click();
  await button("Done", adding).click();
  await expect(page.locator(".project-chats .row")).toHaveCount(1);
  const pipChat = (await snap()).chats.find((c) => c.id === "seeded-pip");
  assert.equal(pipChat.projectId, project.id);
  assert.equal(pipChat.mode, "default");
  await sidebar("Chats").click();
  await expect(page.locator(".row-folder").first()).toHaveText(/^\s*Mail migration\s*$/);
  console.log("Added an existing chat to the project; the Chats list names the project.");

  // 2c. An artifact is attached to the project, and taken off again.
  await openProjects();
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await menu.getByRole("button", { name: /Artifacts/ }).click();
  const artifacts = page.getByRole("region", { name: "Artifacts", exact: true });
  await expect(artifacts).toContainText("Nothing attached yet.");
  await button("Attach an artifact…", artifacts).click();
  const attaching = page.getByRole("dialog", { name: "Attach artifacts" });
  await expect(attaching.getByRole("list", { name: "Artifacts" }).getByRole("listitem")).toHaveText([/cutover-plan\.md.*Pip.*Mailbox plan/]);
  await shot("project-attach-artifact", attaching);
  await button("Attach cutover-plan.md", attaching).click();
  await expect(button("cutover-plan.md is attached", attaching)).toBeDisabled();
  await button("Done", attaching).click();
  await expect(artifacts.getByRole("list", { name: "Attached artifacts" }).getByRole("listitem")).toHaveText([/cutover-plan\.md/]);
  await expect(artifacts).toContainText("1 artifact");
  await expect(menu.getByRole("button", { name: /Artifacts/ })).toContainText("1");
  assert.deepEqual((await snap()).projects.find((p) => p.id === project.id).artifacts, ["seeded-plan"]);
  await shot("project-artifacts");
  await button("Remove cutover-plan.md from project", artifacts).click();
  await expect(artifacts).toContainText("Nothing attached yet.");
  assert.equal("artifacts" in (await snap()).projects.find((p) => p.id === project.id), false);
  await page.evaluate((id) => window.botkins.addProjectArtifact(id, "seeded-plan"), project.id);
  await expect(artifacts.getByRole("list", { name: "Attached artifacts" }).getByRole("listitem")).toHaveCount(1);
  // "Go to chat" opens the chat the file was made in.
  await button("Go to the chat of cutover-plan.md", artifacts).click();
  await expect(page.locator(".chathead h2")).toHaveText("Pip");
  await expect(page.locator(".project-label")).toContainText("Mail migration");
  console.log("Attached an artifact to the project, took it off, attached it again and opened its chat.");

  // Screenshots of the pages so far.
  await openProjects();
  await expect(page.locator(".project-list .record-row")).toHaveCount(1);
  await page.evaluate(() => window.botkins.createProject({ name: "Personal admin" }));
  await expect(page.locator(".project-list .record-row")).toHaveCount(2);
  await expect(page.locator(".project-list .record-row").first()).toContainText("Mail migration");
  await expect(page.locator(".project-list .record-row").last()).toContainText("Personal admin");
  await shot("projects");
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await menu.getByRole("button", { name: /To-do/ }).click();
  await shot("project-todos");
  await menu.getByRole("button", { name: /Overview/ }).click();
  await shot("project-overview");

  // 3. Global access off: Scout has no grant and is blocked in the UI and the backend. So is Pip.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Access" }).click();
  const global = settings.getByRole("switch", { name: "All bots can use every project" });
  await expect(global).toBeChecked();
  await global.click();
  await expect(global).not.toBeChecked();
  await expect(settings.getByRole("region", { name: "Access by bot" })).toContainText("No projects");
  assert.equal((await snap()).settings.access.allBots, false);
  await shot("settings-access", settings);
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await expect(settings).toBeHidden();

  await openProjects();
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await menu.getByRole("button", { name: /Chats/ }).click();
  await expect(button("Start chat with Scout")).toBeDisabled();
  await expect(page.locator(".bot-pick-list li", { hasText: "Scout" })).toContainText("No access to this project");
  const refused = await page.evaluate((pid) => window.botkins.startProjectChat(["scout"], pid).then(() => "created", (e) => e.message), project.id);
  assert.match(refused, /Scout doesn't have access to the project “Mail migration”/);
  const sendRefused = await page.evaluate((id) => window.botkins.send(id, "hello").then(() => "sent", (e) => e.message), pipChat.id);
  assert.match(sendRefused, /Pip doesn't have access/);
  await page.locator(".project-chats .row").first().click();
  await expect(page.locator(".access-blocked")).toContainText("Pip doesn't have access to the project “Mail migration”");
  assert.equal((await snap()).chats.find((c) => c.id === pipChat.id).projectId, project.id, "nothing is deleted");
  await shot("chat-blocked");
  console.log("With global access off, Scout is disabled in the project and refused by the backend; Pip's chat shows why it's blocked.");

  // 4. Grant Scout the project on its bot page; then it can start a chat in the project.
  await openProjects();
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await menu.getByRole("button", { name: /Chats/ }).click();
  await button("Open Scout's access").click();
  const card = page.getByRole("region", { name: "Access" });
  await expect(card).toBeVisible();
  await card.getByRole("checkbox", { name: "Mail migration", exact: true }).click();
  await expect(card.getByRole("checkbox", { name: "Mail migration", exact: true })).toBeChecked();
  await expect.poll(async () => (await snap()).bots.find((b) => b.id === "scout").access.projects).toEqual([project.id]);
  await card.scrollIntoViewIfNeeded();
  await shot("bot-access", card);
  await openProjects();
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await menu.getByRole("button", { name: /Access/ }).click();
  await expect(page.locator(".access-list li", { hasText: "Scout" })).toContainText("Granted for this project");
  await expect(page.locator(".access-list li", { hasText: "Pip" })).toContainText("No access");
  await shot("project-access");
  await menu.getByRole("button", { name: /Chats/ }).click();
  await expect(button("Start chat with Scout")).toBeEnabled();
  await button("Start chat with Scout").click();
  await expect(page.locator(".chathead h2")).toHaveText("Scout");
  await expect(page.locator(".access-blocked")).toHaveCount(0);
  const scoutChat = (await snap()).chats[0];
  assert.equal(scoutChat.botId, "scout");
  assert.equal(scoutChat.projectId, project.id);
  // The New chat dialog lists the project, disabled for a bot without access.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const newChat = page.getByRole("dialog");
  await newChat.getByRole("checkbox", { name: "Pick Pip" }).check();
  await expect(newChat.getByRole("option", { name: /Mail migration \(Pip can't use it\)/ })).toBeDisabled();
  await newChat.getByRole("checkbox", { name: "Pick Pip" }).uncheck();
  await newChat.getByRole("checkbox", { name: "Pick Scout" }).check();
  await expect(newChat.getByRole("option", { name: "Mail migration", exact: true })).toBeEnabled();
  await newChat.getByLabel("Project").selectOption({ label: "Mail migration" });
  await expect(newChat.getByRole("radiogroup", { name: "Mode" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  console.log("Granting the project on Scout's page lets Scout start a chat in its project; New chat respects access.");

  // Turning global access back on unblocks Pip without changing anything else.
  await page.evaluate(() => window.botkins.setPreferences({ access: { allBots: true } }));
  todos = (await snap()).projects.find((p) => p.id === project.id).todos;
  assert.equal(todos.length, 3);

  // 5. A panel in the project shows on Today with the project's tag, and on the project's Panels.
  // The renderer can't publish panels, so one is written into this test's own data while the app is closed.
  await app.close();
  const file = join(dir, "app", "data", "workspace.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.panels.push({
    id: "panel-1", key: "cutover", botId: "scout", chatId: scoutChat.id, title: "Cutover status", size: "wide", hidden: false,
    revision: 1, updatedAt: Date.now(), routine: null, projectId: project.id,
    blocks: [
      { type: "metric", label: "Mailboxes moved", value: "412 / 1,200", note: "34%" },
      { type: "progress", label: "Pilot group", value: 18, max: 25, note: "18 of 25 users" },
      { type: "list", items: ["Finance moves Friday", "Legal hold review pending"] },
    ],
  });
  writeFileSync(file, JSON.stringify(data));
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  page = await home(app);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 860));
  await openToday(page);
  await expect(page.locator(".live-panel .panel-project")).toHaveText("Mail migration");
  await shot("today-panel");
  await openProjects();
  await page.locator(".record-row", { hasText: "Mail migration" }).click();
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("button", { name: /[Pp]anels/ }).click();
  await expect(page.getByRole("region", { name: "Cutover status" })).toContainText("412 / 1,200");
  await shot("project-panels");
  console.log("A project panel shows on Today with its project tag and on the project's Panels.");
  const second = join(dir, "marketplace");
  mkdirSync(second);
  const sections = page.getByRole("navigation", { name: "Project sections" });
  await sections.getByRole("button", { name: /Overview/ }).click();
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift()] });
  }, [dir, second]);
  await button("Add folder…").click();
  await expect.poll(async () => (await snap()).projects.find((p) => p.id === project.id).folder).toBe(dir);
  await button("Add folder…").click();
  await expect.poll(async () => (await snap()).projects.find((p) => p.id === project.id).folders).toEqual([dir, second]);
  await sections.getByRole("button", { name: /Chats/ }).click();
  await page.getByRole("combobox", { name: "Folder", exact: true }).selectOption(second);
  await button("Start chat with Scout").click();
  await expect(page.locator(".project-label")).toContainText(second);
  assert.equal((await snap()).chats[0].folder, second);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Projects smoke passed. No renderer exceptions." + (shots ? " Screenshots in " + shots : ""));
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
