// Non-live smoke for the Wiki section (src/Wiki.tsx) and wiki pages in "#" mentions, in an isolated data
// folder with the three test bots. No Copilot turns run: Send is replaced by a stand-in.
// Covers sections, reading a page (heading, table, Related), internal and missing links, editing with the
// rich editor (save, Markdown round trip, a change made meanwhile), new pages from templates, sections,
// move/rename, delete, history and restore, search, Activity, the Home suggestion for records without a
// page, the "#" menu and a sent chip. Set WIKI_SHOTS to a folder to save light and dark screenshots at
// 1190×830 and at the smallest window, 760×560.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-wiki-ui-"));
const dataDir = join(dir, "app");
const wikiDir = join(dataDir, "data", "wiki");
seedApp(dataDir);
const env = { ...process.env, BOTKINS_DATA_DIR: dataDir, COMMANDER_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
const shots = process.env.WIKI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const errors = [];
let app, page;

const file = (path) => readFileSync(join(wikiDir, ...path.split("/")), "utf8");
const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
const sidebar = (name) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name, exact: true });
const wikiNav = () => page.getByRole("navigation", { name: "Wiki", exact: true });
const article = () => page.locator(".wiki-article");
const crumbs = () => page.getByRole("navigation", { name: "Breadcrumb" });
const editorBox = () => page.locator(".wiki-editor .ProseMirror");
const related = () => page.getByRole("complementary", { name: "Related" });
const save = (path, content, base) => page.evaluate(([p, c, b]) => window.botkins.saveWikiPage(p, c, b), [path, content, base]);
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);

async function shot(name) {
  if (!shots) return;
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await page.locator(`html[data-mode="${mode}"]`).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, name + "-" + mode + ".png") });
  }
  await theme("light");
}
async function launch() {
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // The page's Content Security Policy blocks anything remote; a blocked load would show here.
    if (m.type() === "error" && /Content Security Policy|net::ERR/i.test(m.text())) errors.push(m.text());
  });
  // Signed in as a made-up account, so the app opens on Home whatever this computer's sign-in is.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("auth");
    ipcMain.handle("auth", () => ({ connected: true, login: "octocat", type: "user" }));
  });
  await page.reload();
  page = await skipWelcome(page);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await size(1190, 830);
}
/** Opens a page from the Wiki side menu: its section, then its title. */
async function openFromNav(section, title) {
  const toggle = wikiNav().getByRole("button", { name: "Expand " + section, exact: true });
  if (await toggle.count()) await toggle.click();
  await wikiNav().getByRole("button", { name: title, exact: true }).click();
  await expect(article().getByRole("heading", { level: 1 }).first()).toBeVisible();
}
async function startEditing() {
  await button("Edit").click();
  await expect(editorBox()).toBeVisible();
  await expect(page.locator(".wiki-updated")).toHaveText("No changes yet");
}
/** Types a new paragraph at the end of the page in the editor. */
async function typeAtEnd(text) {
  // The caret goes to the end of the last block, as a click there would put it.
  await editorBox().evaluate((el) => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el.lastElementChild);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
  await expect(page.locator(".wiki-updated")).toHaveText("Unsaved changes");
}

const ACME = `# Acme Corp

A retail business that buys seats every quarter.

| Plan | Seats |
| --- | --- |
| Pro | 40 |
| Team | 12 |

Our goal with them is [Q3 growth](goals/q3-growth.md). The main contact is [Dana Lee](people/dana-lee.md).
`;
const GOAL = `# Q3 growth

Grow [Acme](projects/acme-corp.md) to 60 seats by September.
`;
// Everything a page must keep when it is opened in the editor and saved.
const ROUND = `# Round trip

Links keep their wiki paths: [Acme](projects/acme-corp.md), [the goal](goals/q3-growth.md) and [a site](https://example.com/docs).

Plain text keeps a < b, <angle> brackets, {curly} braces, $5 and $10, about ~5 minutes, snake_case_name, file_name.md and 5 * 3.

Some **bold**, *italic*, ~~struck out~~ and \`inline code\`.

- First point
- Second point
  - Nested point

1. Step one
2. Step two

- [ ] Open task
- [x] Done task

| Metric | Before | After |
| :-- | --: | :-: |
| Reply time | 9.4 s | **2.1 s** |

> A plain quote
> on two lines.

> [!NOTE]
> A callout stays a callout.

\`\`\`ts
const total = { a: 1 }.a < 2 ? "$5" : "~5";
\`\`\`

---

Last line.
`;
/** A seeded page as it is saved: links to pages that exist are stored relative to the page, as other Markdown apps read them. */
const relative = (text) => text.replace(/\]\((projects|goals|people)\//g, "](../$1/");
/** Table rows without the padding the editor adds, for comparing. */
const tables = (text) =>
  text
    .split("\n")
    .map((line) => (/^\s*\|/.test(line) ? line.replace(/\s*\|\s*/g, "|").replace(/\|:?-+:?(?=\|)/g, (m) => m.replace(/-+/, "--")) : line))
    .join("\n");

try {
  await launch();
  // Two projects: Acme Corp gets its page below, Contoso is offered one.
  await page.evaluate(() => window.botkins.createProject({ name: "Acme Corp" }));
  await page.evaluate(() => window.botkins.createProject({ name: "Contoso" }));
  await save("projects/acme-corp.md", ACME);
  await save("goals/q3-growth.md", GOAL);
  await save("playbooks/round-trip.md", ROUND);

  // ---- Home: sections, recent pages and the offer for records without a page.
  await sidebar("Wiki").click();
  await expect(page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Wiki", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".wiki-home h1")).toHaveText("Wiki");
  const sectionNames = ["Goals", "Meetings", "People", "Playbooks", "Projects"];
  for (const name of sectionNames) await expect(wikiNav().getByRole("button", { name: new RegExp("^" + name + " \\d+ pages?$") })).toBeVisible();
  await expect(page.locator(".wiki-section-card")).toHaveCount(5);
  await expect(page.locator(".wiki-section-card", { hasText: "Projects" })).toContainText("Projects1 page");
  await expect(page.getByRole("region", { name: "Records without a page" })).toContainText("1 project has no page yet");
  await expect(page.getByRole("region", { name: "Records without a page" })).toContainText("Contoso");
  await expect(page.locator(".wiki-home .wiki-row").first()).toContainText("Round trip");
  await shot("home");
  await button("Add page").click();
  await expect(page.getByRole("status").filter({ hasText: "Added 1 page." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Records without a page" })).toHaveCount(0);
  assert.match(file("projects/contoso.md"), /^# Contoso\n/);
  console.log("Home lists the five sections and offers a page for Contoso; Add page creates projects/contoso.md.");

  // ---- A page: breadcrumb, heading, table, Updated, and Related.
  await openFromNav("Projects", "Acme Corp");
  await expect(crumbs()).toHaveText(/Wiki\s*Projects\s*Acme Corp/);
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Acme Corp");
  const table = article().getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Plan", "Seats"]);
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(page.locator(".wiki-updated")).toHaveText(/^Updated /);
  await expect(related().getByRole("region", { name: "Linked from" })).toContainText("Goals");
  await expect(related().getByRole("region", { name: "Linked from" }).getByRole("button")).toHaveText(["Q3 growth", "Round trip"]);
  await expect(related().getByRole("region", { name: "Links to" }).getByRole("button")).toHaveText(["Q3 growth"]);
  await expect(related().getByRole("region", { name: "Not created yet" }).getByRole("button")).toHaveText(["Dana Lee"]);
  await expect(related().getByRole("region", { name: "Record" })).toContainText("Acme Corp");
  await shot("page");
  console.log("Acme Corp shows its breadcrumb, heading, table and Related: linked from Q3 growth and Round trip, links to Q3 growth, Dana Lee not created, the project record.");

  // ---- An internal link opens the page it names; a missing one offers to create it.
  await article().getByRole("link", { name: "Q3 growth" }).click();
  await expect(crumbs()).toHaveText(/Goals\s*Q3 growth/);
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Q3 growth");
  await article().getByRole("link", { name: "Acme" }).click();
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Acme Corp");
  const missing = article().getByRole("link", { name: /Dana Lee/ });
  await expect(missing).toHaveClass(/missing/);
  await expect(missing).toHaveAccessibleName("Dana Lee (not created yet)");
  await missing.click();
  const create = page.getByRole("dialog", { name: "Create “Dana Lee”?" });
  await expect(create).toContainText("in People");
  await button("Create page", create).click();
  await expect(editorBox()).toBeVisible();
  await expect(crumbs()).toHaveText(/People\s*Dana Lee/);
  // The new page is where the link points, from the People outline.
  assert.match(file("people/dana-lee.md"), /^# Dana Lee\n[\s\S]*## What matters to them/);
  await expect(editorBox().getByRole("heading", { level: 2 }).first()).toHaveText("What matters to them");
  await button("Cancel").click();
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Dana Lee");
  console.log("Internal links open their page; the missing Dana Lee link created people/dana-lee.md from the People outline.");

  // ---- Edit, type and save: the file has the new text and keeps its links and table.
  await openFromNav("Projects", "Acme Corp");
  await startEditing();
  assert.ok(
    await page.evaluate(() =>
      [...document.querySelectorAll("link[href], script[src]")].some((el) => /WikiEditor-[\w-]+\.(js|css)$/.test(el.href || el.src)),
    ),
    "the editor's own chunk loaded",
  );
  await shot("edit");
  await typeAtEnd("Renewal is due in March.");
  await page.keyboard.press("Meta+s");
  await expect(article()).toContainText("Renewal is due in March.");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // Focus goes back to Edit (checked in the page, so it holds whether or not the window is in front).
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("wiki-edit"))).toBe(true);
  const acme = file("projects/acme-corp.md");
  assert.match(acme, /^# Acme Corp\n/);
  assert.ok(acme.includes("[Q3 growth](../goals/q3-growth.md)"), "the goal link is saved relative to the page");
  assert.ok(acme.includes("[Dana Lee](../people/dana-lee.md)"), "the person link is saved relative to the page");
  assert.ok(acme.includes("Renewal is due in March."));
  assert.equal(tables(acme), tables(relative(ACME)) + "\nRenewal is due in March.\n", "nothing else changed");
  console.log("Edit, type, Cmd+S: the file has the new paragraph, its links and table, and nothing else changed.");

  // ---- The Markdown round trip: open the editor on everything, add one line, save.
  await openFromNav("Playbooks", "Round trip");
  await startEditing();
  await typeAtEnd("Edited.");
  await button("Save").click();
  await expect(article()).toContainText("Edited.");
  const round = file("playbooks/round-trip.md");
  for (const kept of [
    "# Round trip",
    "[Acme](../projects/acme-corp.md)",
    "[the goal](../goals/q3-growth.md)",
    "[a site](https://example.com/docs)",
    "a < b, <angle> brackets, {curly} braces, $5 and $10, about ~5 minutes, snake_case_name, file_name.md and 5 * 3.",
    "- [ ] Open task",
    "- [x] Done task",
    "> [!NOTE]",
    "```ts\nconst total = { a: 1 }.a < 2 ? \"$5\" : \"~5\";\n```",
    "  - Nested point",
  ])
    assert.ok(round.includes(kept), "the round trip keeps: " + kept + "\n---\n" + round);
  assert.equal(tables(round), tables(relative(ROUND)) + "\nEdited.\n", "the round trip changes nothing but table padding\n---\n" + round);
  await expect(article().getByRole("note")).toContainText("A callout stays a callout.");
  console.log("Round trip: headings, wiki links, tables, task lists, fenced code with its language, quotes, callouts and plain text with < { } $5 ~5 _ are kept; only table padding changes.");

  // ---- A change made meanwhile: a quiet notice, then Keep my version or Load the new version.
  await openFromNav("Projects", "Acme Corp");
  await startEditing();
  await typeAtEnd("My note.");
  const before = await page.evaluate(() => window.botkins.wikiPage("projects/acme-corp.md"));
  await save("projects/acme-corp.md", before.content + "\nA bot's note.\n", before.base);
  await expect(page.getByRole("status").filter({ hasText: "changed somewhere else" })).toBeVisible();
  await expect(editorBox()).not.toContainText("A bot's note.");
  await button("Save").click();
  const conflict = page.getByRole("alert").filter({ hasText: "Someone else changed this page" });
  await expect(conflict).toBeVisible();
  await shot("conflict");
  await button("Keep my version", conflict).click();
  await expect(article()).toContainText("My note.");
  assert.ok(file("projects/acme-corp.md").includes("My note."));
  assert.ok(!file("projects/acme-corp.md").includes("A bot's note."));
  await startEditing();
  await typeAtEnd("Second note.");
  const now = await page.evaluate(() => window.botkins.wikiPage("projects/acme-corp.md"));
  await save("projects/acme-corp.md", now.content + "\nThe bot again.\n", now.base);
  await expect(page.getByRole("status").filter({ hasText: "changed somewhere else" })).toBeVisible();
  await button("Save").click();
  await button("Load the new version", page.getByRole("alert")).click();
  await expect(editorBox()).toContainText("The bot again.");
  await expect(editorBox()).not.toContainText("Second note.");
  await button("Cancel").click();
  console.log("A change made while editing shows a notice; Save offers Keep my version (overwrote) and Load the new version (replaced the editor).");

  // ---- Unsaved changes are guarded when leaving.
  await startEditing();
  await typeAtEnd("Not kept.");
  await sidebar("Home").click();
  const discard = page.getByRole("dialog", { name: "Discard your changes?" });
  await button("Cancel", discard).click();
  await expect(editorBox()).toContainText("Not kept.");
  await wikiNav().getByRole("button", { name: "Home", exact: true }).click();
  await button("Discard", page.getByRole("dialog", { name: "Discard your changes?" })).click();
  await expect(page.locator(".wiki-home h1")).toHaveText("Wiki");
  assert.ok(!file("projects/acme-corp.md").includes("Not kept."));
  console.log("Leaving with unsaved changes asks first, from the app's sidebar and inside the Wiki.");

  // ---- A new page from its section's template.
  await button("New page", page.locator(".wiki-nav-foot")).click();
  const newPage = page.getByRole("dialog", { name: "New page" });
  await newPage.getByLabel("Title").fill("Fabrikam");
  await newPage.getByLabel("Section").selectOption("projects");
  await shot("new-page");
  await button("Create page", newPage).click();
  await expect(editorBox()).toBeVisible();
  await expect(editorBox().getByRole("heading", { level: 1 })).toHaveText("Fabrikam");
  await expect(editorBox().getByRole("heading", { level: 2 }).first()).toHaveText("Scope");
  await typeAtEnd("Met them at Ignite. Like ");
  // Link to another page by picking it from a list.
  await button("Link to page").click();
  const picker = page.getByRole("dialog", { name: "Link to a wiki page" });
  await picker.getByRole("combobox", { name: "Find a page" }).fill("acme");
  await expect(picker.getByRole("option")).toHaveText([/Acme Corp\s*Projects/]);
  await shot("link-picker");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(editorBox().getByRole("link", { name: "Acme Corp" })).toBeVisible();
  await button("Save").click();
  await expect(article()).toContainText("Met them at Ignite.");
  const fabrikam = file("projects/fabrikam.md");
  // The page keeps the Projects outline it started from, with the new line after it.
  assert.match(fabrikam, /^# Fabrikam\n[\s\S]*## Scope[\s\S]*Met them at Ignite\. Like \[Acme Corp\]\(\.\/acme-corp\.md\)/);
  await expect(article().getByRole("link", { name: "Acme Corp" })).toHaveClass(/wiki-link/);
  console.log("New page Fabrikam in Projects started from the projects template; Link to page inserted a link saved as [Acme Corp](./acme-corp.md).");

  // ---- A new section, its template, and moving a page into it: links follow.
  await button("New section", page.locator(".wiki-nav-foot")).click();
  const sectionDialog = page.getByRole("dialog", { name: "New section" });
  await sectionDialog.getByLabel("Section name").fill("Key accounts");
  await button("Create section", sectionDialog).click();
  await expect(page.locator(".wiki-section-view h1")).toHaveText("Key accounts");
  assert.ok(existsSync(join(wikiDir, "key-accounts")));
  await button("More for Key accounts", page.locator(".wiki-section-view")).click();
  await page.getByRole("menuitem", { name: "Edit template" }).click();
  await expect(editorBox()).toBeVisible();
  await expect(crumbs()).toContainText("Template for new pages");
  await button("Cancel").click();
  assert.ok(existsSync(join(wikiDir, "key-accounts", "_template.md")));
  await openFromNav("Goals", "Q3 growth");
  await button("More for this page").click();
  await page.getByRole("menuitem", { name: "Move or rename…" }).click();
  const move = page.getByRole("dialog", { name: "Move or rename “Q3 growth”" });
  await move.getByLabel("Section").selectOption("key-accounts");
  await move.getByLabel("File name").fill("q3-plan");
  await expect(move).toContainText("Saved as key-accounts/q3-plan.md");
  await button("Move page", move).click();
  await expect(crumbs()).toHaveText(/Key accounts\s*Q3 growth/);
  assert.ok(file("projects/acme-corp.md").includes("[Q3 growth](../key-accounts/q3-plan.md)"), "Acme's link followed the move");
  assert.ok(!existsSync(join(wikiDir, "goals", "q3-growth.md")));
  // Renaming the section moves its pages; links follow again.
  await wikiNav().getByRole("button", { name: "More for Key accounts" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const rename = page.getByRole("dialog", { name: "Rename “Key accounts”" });
  await rename.getByLabel("Section name").fill("Top accounts");
  await button("Rename", rename).click();
  await expect(crumbs()).toHaveText(/Top accounts\s*Q3 growth/);
  await expect.poll(() => file("projects/acme-corp.md")).toContain("[Q3 growth](../top-accounts/q3-plan.md)");
  console.log("New section Key accounts, its template, and moving Q3 growth into it; renamed to Top accounts; Acme's link followed each move.");

  // ---- Delete a page.
  await openFromNav("People", "Dana Lee");
  await button("More for this page").click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await button("Delete page", page.getByRole("dialog", { name: "Delete “Dana Lee”?" })).click();
  await expect(page.getByRole("status").filter({ hasText: "“Dana Lee” was deleted." })).toBeVisible();
  assert.ok(!existsSync(join(wikiDir, "people", "dana-lee.md")));
  console.log("Deleted Dana Lee.");

  // ---- History and restore.
  await openFromNav("Projects", "Acme Corp");
  await button("More for this page").click();
  await page.getByRole("menuitem", { name: "History" }).click();
  const history = page.getByRole("dialog", { name: "History of “Acme Corp”" });
  const versions = history.getByRole("listbox", { name: "Versions" }).getByRole("option");
  await expect(versions.first()).toHaveText(/^Before (your|You's) change/);
  assert.ok((await versions.count()) >= 3, "several earlier versions are kept");
  await versions.last().click();
  await expect(history.getByRole("region", { name: "Preview" })).toContainText("The main contact is Dana Lee.");
  await expect(history.getByRole("region", { name: "Preview" })).not.toContainText("Renewal is due in March.");
  await shot("history");
  await button("Restore this version", history).click();
  await expect(history).toBeHidden();
  await expect(article()).not.toContainText("Renewal is due in March.");
  assert.equal(file("projects/acme-corp.md"), ACME);
  console.log("History lists earlier versions; restoring the first brought back the seeded text.");

  // ---- Search and Activity.
  await wikiNav().getByRole("searchbox", { name: "Search the wiki" }).fill("seats");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("button").first()).toContainText("Acme Corp");
  await expect(results.getByRole("button").first()).toContainText("Projects");
  await results.getByRole("button", { name: /Q3 growth/ }).click();
  await expect(crumbs()).toHaveText(/Top accounts\s*Q3 growth/);
  await expect(wikiNav().getByRole("searchbox", { name: "Search the wiki" })).toHaveValue("");
  await wikiNav().getByRole("button", { name: "Activity", exact: true }).click();
  await expect(crumbs()).toContainText("Activity");
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Wiki log");
  await expect(article()).toContainText("You moved");
  await expect(article()).toContainText("You removed");
  await expect(button("Edit")).toHaveCount(0);
  await article().getByRole("link", { name: "Fabrikam" }).first().click();
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Fabrikam");
  console.log("Search finds pages with their section and opens one; Activity shows the log, read-only, with working links.");

  // ---- The guide can't be moved or deleted.
  await wikiNav().getByRole("button", { name: "How this wiki works", exact: true }).click();
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("How this wiki works");
  await button("More for this page").click();
  await expect(page.getByRole("menuitem")).toHaveText(["History", "Show in Finder", "Export…"]);
  await page.keyboard.press("Escape");

  // ---- The project record opens from Related.
  await openFromNav("Projects", "Acme Corp");
  await related().getByRole("button", { name: /Acme Corp/ }).click();
  await expect(page.getByRole("heading", { name: "Acme Corp", level: 1 })).toBeVisible();
  await expect(page.locator(".project-menu")).toBeVisible();
  await sidebar("Wiki").click();

  // ---- Export…: a project and what is related, as Markdown files, a web page and a PDF.
  const exports = join(dir, "exports");
  mkdirSync(exports, { recursive: true });
  await app.evaluate(({ dialog, shell }, folder) => {
    globalThis.saves = [];
    globalThis.revealed = [];
    dialog.showSaveDialog = async (_win, options) => {
      const name = options.defaultPath.split("/").pop();
      globalThis.saves.push(name);
      return { canceled: false, filePath: folder + "/" + globalThis.saves.length + "-" + name };
    };
    shell.showItemInFolder = (path) => void globalThis.revealed.push(path);
  }, exports);
  const exportDialog = () => page.getByRole("dialog", { name: "Export" });
  const exported = () => page.getByRole("dialog", { name: "Export finished" });
  const pageCheck = (title) => exportDialog().locator("label.wiki-export-check:not(.head)", { hasText: title }).getByRole("checkbox");
  /** Exports with what the dialog shows, and returns the saved file. */
  async function exportAs(format) {
    await exportDialog().getByRole("radio", { name: new RegExp("^" + format) }).check();
    await button("Export…", exportDialog()).click();
    await expect(exported()).toBeVisible();
    const file = (await exported().locator(".wiki-export-path").innerText()).trim();
    assert.ok(existsSync(file), "the export was saved: " + file);
    return file;
  }
  // The Wiki's menu has loaded before a section is opened in it.
  await wikiNav().getByRole("button", { name: /^(Expand|Collapse) Projects$/ }).waitFor();
  await openFromNav("Projects", "Acme Corp");
  await button("More for this page").click();
  await page.getByRole("menuitem", { name: "Export…" }).click();
  await expect(exportDialog().getByRole("radio", { name: "A project" })).toHaveAttribute("aria-checked", "true");
  await expect(exportDialog().getByRole("combobox")).toHaveValue("projects/acme-corp.md");
  await expect(exportDialog()).toContainText("the pages linked with it, and the pages related to those");
  const plan = await page.evaluate(() => window.botkins.wikiExportPlan({ scope: "project", path: "projects/acme-corp.md" }));
  const planned = plan.pages.map((p) => p.path);
  assert.ok(planned.includes("projects/acme-corp.md") && planned.length >= 3, "the plan has Acme and what is related: " + planned.join(", "));
  assert.ok(!planned.includes("projects/contoso.md"), "a page nothing links with is left out");
  await expect(exportDialog().getByRole("group", { name: "This page" })).toContainText("Acme Corp");
  await expect(exportDialog().getByRole("group", { name: "Linked with it" })).toBeVisible();
  await expect(exportDialog().locator(".wiki-export-count")).toHaveText(planned.length + " pages");
  await expect(exportDialog().locator("label.wiki-export-check:not(.head) input:checked")).toHaveCount(planned.length);
  await shot("export");
  // Markdown files in a .zip: the pages at their places, and a contents page.
  const zipFile = await exportAs("Markdown files");
  assert.match(zipFile, /Acme Corp wiki export\.zip$/);
  const listing = execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8" }).trim().split("\n");
  for (const path of planned) assert.ok(listing.includes("Acme Corp wiki export/" + path), path + " is in the archive: " + listing.join(", "));
  assert.ok(listing.includes("Acme Corp wiki export/index.md"), "the archive has a contents page");
  assert.ok(!listing.some((f) => /contoso/i.test(f)), "a page nothing links with is not in the archive");
  await expect(exported()).toContainText("Saved to " + zipFile);
  await shot("export-done");
  await button("Show in Finder", exported()).click();
  await expect.poll(() => app.evaluate(() => globalThis.revealed)).toEqual([zipFile]);
  await button("Done", exported()).click();
  await expect(exported()).toHaveCount(0);
  console.log("Export Acme Corp as Markdown files: " + planned.length + " pages and a contents page, nothing unrelated; Show in Finder shows the file.");
  // A web page: one file with each page's heading, places for the pages, and nothing to load. Leave one page out.
  const left = plan.pages.find((p) => p.why !== "start");
  await button("More for this page").click();
  await page.getByRole("menuitem", { name: "Export…" }).click();
  await pageCheck(left.title).uncheck();
  await expect(exportDialog().locator(".wiki-export-count")).toHaveText(planned.length - 1 + " of " + planned.length + " pages");
  if (shots) {
    await size(760, 560);
    await page.waitForTimeout(250);
    const fits = await exportDialog().evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    assert.ok(fits, "the Export dialog fits the smallest window without scrolling");
    await shot("export-min");
    await size(1190, 830);
  }
  const htmlFile = await exportAs("Web page");
  assert.match(htmlFile, /\.html$/);
  const html = readFileSync(htmlFile, "utf8");
  assert.match(html, /^<!doctype html>/i);
  for (const p of plan.pages.filter((x) => x.path !== left.path)) {
    assert.ok(html.includes(">" + p.title + "</h1>"), p.title + "'s heading is in the document");
    assert.ok(html.includes('id="page-' + p.path.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase() + '"'), p.title + " has its place");
  }
  assert.ok(!html.includes('id="page-' + left.path.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase() + '"'), "the unticked page is left out");
  assert.ok(html.includes('href="#page-projects-acme-corp"'), "links between exported pages are places in the document");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<(img|link|iframe|object|embed|video|audio|source)\b/i, "nothing is loaded from anywhere");
  assert.doesNotMatch(html, /(src|srcset|poster)\s*=|url\(\s*['"]?(https?:)?\/\//i, "no asset references");
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) assert.ok(href.startsWith("#") || /^(https?|mailto):/.test(href), "a link is a place or a web link: " + href);
  assert.equal(readdirSync(exports).filter((f) => f.endsWith(".html")).length, 1, "one file");
  if (shots) {
    // The document as it reads, for a look: its first screenful, drawn with scripts off.
    writeFileSync(join(shots, "export-document.html"), html);
    const png = await app.evaluate(async ({ BrowserWindow }, file) => {
      const view = new BrowserWindow({ show: false, width: 900, height: 1300, webPreferences: { javascript: false } });
      try {
        await view.loadFile(file);
        await new Promise((r) => setTimeout(r, 300));
        return (await view.webContents.capturePage()).toPNG().toString("base64");
      } finally {
        view.destroy();
      }
    }, htmlFile);
    writeFileSync(join(shots, "export-document.png"), Buffer.from(png, "base64"));
  }
  await button("Done", exported()).click();
  console.log("Export as a web page: one file, " + (planned.length - 1) + " pages with headings and in-document links, no scripts or remote assets; the unticked " + left.title + " is left out.");
  // PDF.
  await button("More for this page").click();
  await page.getByRole("menuitem", { name: "Export…" }).click();
  const pdfFile = await exportAs("PDF");
  assert.equal(readFileSync(pdfFile).subarray(0, 4).toString(), "%PDF");
  if (shots) writeFileSync(join(shots, "export-document.pdf"), readFileSync(pdfFile));
  await button("Done", exported()).click();
  console.log("Export as PDF: the file starts with %PDF.");
  // The whole wiki from Home, and One page with search.
  await wikiNav().getByRole("button", { name: "Home", exact: true }).click();
  await button("Export…", page.locator(".wiki-home-head")).click();
  await expect(exportDialog().getByRole("radio", { name: "Whole wiki" })).toHaveAttribute("aria-checked", "true");
  await exportDialog().getByRole("radio", { name: "One page" }).click();
  await exportDialog().getByRole("searchbox", { name: "Find a page" }).fill("round");
  await exportDialog().getByRole("option", { name: /Round trip/ }).click();
  await expect(exportDialog().getByRole("group", { name: "This page" })).toContainText("Round trip");
  await shot("export-page");
  await exportDialog().getByRole("radio", { name: "Whole wiki" }).click();
  const allZip = await exportAs("Markdown files");
  const everything = execFileSync("unzip", ["-Z1", allZip], { encoding: "utf8" });
  assert.match(everything, /Botkins wiki export\/WIKI\.md/);
  assert.match(everything, /projects\/fabrikam\.md/);
  await button("Done", exported()).click();
  console.log("Export the whole wiki from Home: the archive holds the whole wiki folder; One page finds a page by search.");

  // ---- The smallest window. With the side menu as icons (the usual menu) the Wiki has room for its
  // menu beside the page.
  await size(760, 560);
  await page.waitForTimeout(250);
  await shot("home-min");
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, "no sideways scroll at 760×560");
  await openFromNav("Projects", "Acme Corp");
  await expect(wikiNav()).toBeVisible();
  await expect(button("All pages")).toBeHidden();
  // Its rows and the breadcrumb keep their own sizes beside the rail of icons.
  const navRow = await wikiNav().locator(".wiki-nav-item").first().boundingBox();
  assert.ok(navRow.width > 150, "the Wiki's menu rows are squeezed: " + navRow.width);
  const crumb = await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: "Projects", exact: true }).boundingBox();
  assert.ok(crumb.height < 40, "the breadcrumb wraps: " + crumb.height);
  overflow = await page.evaluate(() => document.querySelector(".wiki-main").scrollWidth > document.querySelector(".wiki-main").clientWidth + 1);
  assert.equal(overflow, false, "the page never scrolls sideways at 760×560 beside the Wiki's menu");
  await shot("page-min-icons");
  // With the side menu open there is room for one: the menu or the page, and Related under the page.
  await button("Expand side menu").click();
  await page.waitForTimeout(250);
  await expect(wikiNav()).toBeHidden();
  await expect(button("All pages")).toBeVisible();
  const box = await related().boundingBox();
  const text = await article().boundingBox();
  assert.ok(box.y > text.y + text.height - 1, "Related sits under the page in a narrow window");
  await shot("page-min");
  await startEditing();
  await shot("edit-min");
  await button("Cancel").click();
  overflow = await page.evaluate(() => document.querySelector(".wiki-main").scrollWidth > document.querySelector(".wiki-main").clientWidth + 1);
  assert.equal(overflow, false, "the page never scrolls sideways at 760×560");
  await button("All pages").click();
  await expect(wikiNav()).toBeVisible();
  await button("Collapse side menu").click();
  await size(1190, 830);
  console.log("At 760×560 the Wiki shows its menu beside a page with the side menu as icons, and its menu or a page (All pages to go back, Related under the page) with the side menu open.");

  // ---- "Ask about this page" opens a chat with the page as a draft mention.
  await openFromNav("Projects", "Acme Corp");
  await button("Ask about this page").click();
  const entry = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(entry).toHaveValue("#Acme Corp ");
  await expect(page.locator(".composer-shell").getByRole("list", { name: "Mentions" })).toHaveText("Acme Corp");
  const askChat = (await page.evaluate(() => window.botkins.snapshot())).chats[0].id;

  // ---- "#" lists wiki pages; picking one sends a wiki mention.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__sent = [];
    ipcMain.removeHandler("send");
    ipcMain.handle("send", (_e, id, text, options) => {
      globalThis.__sent.push({ id, text, options });
    });
  });
  await entry.fill("");
  await entry.focus();
  await page.keyboard.type("compare with #Fabri");
  const menu = page.getByRole("listbox", { name: "Mention a project, wiki page or file" });
  await expect(menu.getByRole("group", { name: "Wiki" }).getByRole("option")).toHaveText([/Fabrikam.*Projects/]);
  if (shots) {
    for (const mode of ["light", "dark"]) {
      await theme(mode);
      await page.locator(`html[data-mode="${mode}"]`).waitFor();
      await entry.focus();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(shots, "hash-menu-" + mode + ".png") });
    }
    await theme("light");
    await entry.focus();
  }
  await page.keyboard.press("Enter");
  await expect(entry).toHaveValue("compare with #Fabrikam ");
  await button("Send message").click();
  await expect.poll(() => app.evaluate(() => globalThis.__sent.length)).toBe(1);
  const [sent] = await app.evaluate(() => globalThis.__sent);
  assert.equal(sent.id, askChat);
  assert.deepEqual(sent.options.mentions, [{ kind: "wiki", path: "projects/fabrikam.md" }]);
  console.log("Ask about this page drafts #Acme Corp with its chip; # lists Fabrikam under Wiki and Send passes { kind: wiki, path }.");

  // ---- Home's "Tidy the wiki" opens a chat with the primary bot and a prepared message, not sent.
  await sidebar("Wiki").click();
  await button("Tidy the wiki Find gaps, conflicts and stale facts").click();
  await expect(page.locator(".chathead h2")).toHaveText("Pip");
  await expect(entry).toHaveValue(/^Please tidy the wiki: /);
  assert.equal(await app.evaluate(() => globalThis.__sent.length), 1, "the prepared message is not sent");
  console.log("Tidy the wiki opens a chat with Pip and a prepared message that waits to be sent.");

  // ---- A sent message's wiki chip opens the page.
  await app.close();
  app = undefined;
  const workspace = join(dataDir, "data", "workspace.json");
  const data = JSON.parse(readFileSync(workspace, "utf8"));
  const chat = data.chats.find((c) => c.id === askChat);
  chat.title = "Fabrikam notes";
  chat.messages = [
    { role: "user", text: "What do we know about #Fabrikam?", time: Date.now() - 60000, mentions: [{ kind: "wiki", path: "projects/fabrikam.md", label: "Fabrikam" }] },
    { role: "assistant", text: "They met us at Ignite.", time: Date.now() - 50000 },
  ];
  writeFileSync(workspace, JSON.stringify(data));
  await launch();
  await sidebar("Chats").click();
  await page.locator("main").getByText("Fabrikam notes").first().click();
  const chips = page.locator("article.user").first().getByRole("list", { name: "Mentions" });
  await expect(chips.getByRole("listitem")).toHaveText(["Fabrikam"]);
  await expect(chips.getByRole("listitem")).toHaveAttribute("title", "Wiki page · Fabrikam");
  await expect(chips.locator(".lucide-book-open")).toHaveCount(1);
  if (shots)
    for (const mode of ["light", "dark"]) {
      await theme(mode);
      await page.locator(`html[data-mode="${mode}"]`).waitFor();
      await page.waitForTimeout(250);
      await page.locator("article.user").first().screenshot({ path: join(shots, "sent-chip-" + mode + ".png") });
    }
  await theme("light");
  await button("Open wiki page Fabrikam").click();
  await expect(crumbs()).toHaveText(/Projects\s*Fabrikam/);
  await expect(article().getByRole("heading", { level: 1 })).toHaveText("Fabrikam");
  console.log("A sent wiki chip shows the title with a book icon and opens the page in the Wiki.");

  // ---- The page follows changes a bot makes while it is open.
  const fab = await page.evaluate(() => window.botkins.wikiPage("projects/fabrikam.md"));
  await save("projects/fabrikam.md", fab.content + "\nA bot added this.\n", fab.base);
  await expect(article()).toContainText("A bot added this.");
  console.log("A page open in read mode refreshes when the wiki changes.");

  // ---- Closing the window with unsaved edits loses nothing: the draft is offered back.
  await startEditing();
  await typeAtEnd("Typed just before quitting.");
  await page.waitForTimeout(450);
  await app.close();
  assert.ok(!file("projects/fabrikam.md").includes("Typed just before quitting."), "closing does not save by itself");
  await launch();
  await sidebar("Wiki").click();
  const draft = page.getByRole("status").filter({ hasText: "You have unsaved changes to “Fabrikam”" });
  await expect(draft).toBeVisible();
  await shot("draft");
  await button("Restore", draft).click();
  await expect(editorBox()).toContainText("Typed just before quitting.");
  await expect(page.locator(".wiki-updated")).toHaveText("Unsaved changes");
  await expect(page.getByRole("status").filter({ hasText: "These are your unsaved changes from before" })).toBeVisible();
  await button("Save").click();
  await expect(article()).toContainText("Typed just before quitting.");
  assert.ok(file("projects/fabrikam.md").includes("Typed just before quitting."));
  assert.ok(file("projects/fabrikam.md").includes("A bot added this."), "the draft was made after the bot's change, so both are there");
  // Once saved or discarded the draft is gone.
  await startEditing();
  await typeAtEnd("A second draft.");
  await page.waitForTimeout(450);
  await app.close();
  await launch();
  await sidebar("Wiki").click();
  const again = page.getByRole("status").filter({ hasText: "You have unsaved changes to “Fabrikam”" });
  await button("Discard", again).click();
  await expect(again).toHaveCount(0);
  await app.close();
  await launch();
  await sidebar("Wiki").click();
  await expect(page.getByRole("heading", { name: "Wiki", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("You have unsaved changes")).toHaveCount(0);
  assert.ok(!file("projects/fabrikam.md").includes("A second draft."));
  console.log("Quitting with unsaved edits keeps a draft: Restore reopens the editor on it and Save writes it; Discard removes it.");

  assert.deepEqual(errors, [], "no page errors");
  console.log("wiki smoke: ok");
} catch (error) {
  if (process.env.WIKI_FAIL_SHOT) await page?.screenshot({ path: process.env.WIKI_FAIL_SHOT }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
