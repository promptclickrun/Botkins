// "@" and "#" mentions and the Teamwork rail, in an isolated data folder. No Copilot turns unless BOTKINS_LIVE=1.
// Seeds a project, a chat and a file in Pip's folder; picks each from the composer menus, removes chips and
// checks what Send passes (the send IPC is wrapped, so no model turn runs). "@" opens a menu only in a group
// chat. Then seeds a stored chat with sent mentions (one saved by an earlier version as a customer, which shows
// as a plain label) and teammate asks, and checks the chips, rail rows and detail popup.
// Set BOTKINS_MENTION_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-mentions-ui-"));
const dataDir = join(dir, "app");
const env = { ...process.env, BOTKINS_DATA_DIR: dataDir, COMMANDER_DATA_DIR: dataDir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dataDir);
delete env.ELECTRON_RUN_AS_NODE;
const live = (process.env.BOTKINS_LIVE ?? process.env.COMMANDER_LIVE) === "1";
const shots = (process.env.BOTKINS_MENTION_SHOTS ?? process.env.COMMANDER_MENTION_SHOTS);
let app, page;
const errors = [];
const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
const entry = () => page.getByRole("combobox", { name: "Message", exact: true });
const snap = () => page.evaluate(() => window.botkins.snapshot());
const sidebar = (name) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name, exact: true });
const theme = (mode) => page.evaluate((mode) => window.botkins.setPreferences({ appearance: { theme: mode } }), mode);
const chips = () => page.locator(".composer-shell").getByRole("list", { name: "Mentions" });
const noMenu = async () => {
  await page.waitForTimeout(150);
  await expect(page.locator(".record-menu")).toHaveCount(0);
};
async function shot(name, locator, keepFocus = false) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const mode of ["light", "dark"]) {
    await theme(mode);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
    if (keepFocus) await entry().focus();
    await page.waitForTimeout(250);
    const path = join(shots, name + "-" + mode + ".png");
    // The composer's menus open above it, so its shots include the space over it.
    if (keepFocus && locator) {
      const box = await locator.boundingBox();
      const top = Math.max(0, box.y - 330);
      await page.screenshot({ path, clip: { x: box.x, y: top, width: box.width, height: box.y + box.height - top } });
    } else await (locator ?? page).screenshot({ path });
  }
  await theme("light");
  if (keepFocus) await entry().focus();
}
async function launch() {
  app = await _electron.launch({ args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."], executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY), env });
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 860));
}
/** Types at the end of the message, the way a person does. */
async function typeAtEnd(text) {
  await entry().focus();
  await entry().press("End");
  await page.keyboard.type(text);
}

try {
  await launch();

  // Seed a project and a file in Pip's folder.
  const projectId = await page.evaluate(() => window.botkins.createProject({ name: "Mail migration", description: "Cutover code word: PELICAN-7" }));
  mkdirSync(join(dataDir, "data", "files", "pip", "notes"), { recursive: true });
  writeFileSync(join(dataDir, "data", "files", "pip", "report.md"), "# Report\n");
  writeFileSync(join(dataDir, "data", "files", "pip", "notes", "older.txt"), "old\n");
  const hourAgo = new Date(Date.now() - 3600000);
  utimesSync(join(dataDir, "data", "files", "pip", "notes", "older.txt"), hourAgo, hourAgo);

  // A chat with Pip in the project.
  await button("New chat").click();
  await page.getByRole("dialog").getByRole("button", { name: /Pip/ }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const chatId = (await snap()).chats[0].id;
  await page.evaluate(([id, p]) => window.botkins.setChatProject(id, p), [chatId, projectId]);
  await expect(page.locator(".project-label")).toContainText("Mail migration");

  // Send goes to a stand-in, so no model turn runs.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__sent = [];
    ipcMain.removeHandler("send");
    ipcMain.handle("send", (_e, id, text, options) => {
      globalThis.__sent.push({ id, text, options });
    });
  });

  // "@" or "#" inside a word opens nothing, and "/" still opens the command menu.
  await entry().fill("");
  await typeAtEnd("mail me@example.com");
  await noMenu();
  await entry().fill("");
  await typeAtEnd("I write C#");
  await noMenu();
  await entry().fill("");
  await typeAtEnd("/");
  await expect(page.getByRole("listbox", { name: "Commands, skills and tools" })).toBeVisible();
  await entry().fill("");
  await expect(page.getByRole("listbox", { name: "Commands, skills and tools" })).toHaveCount(0);
  console.log("me@example.com and C# open no menu; / still opens commands.");

  // "@" in a chat with one bot has nothing to offer, so it opens no menu.
  await typeAtEnd("@");
  await noMenu();
  await entry().fill("");
  await typeAtEnd("ask @sc");
  await noMenu();
  await entry().fill("");
  console.log("@ opens no menu in a chat with one bot.");

  // "#" lists projects (the chat's own marked) and files, newest first.
  await typeAtEnd("about #");
  const records = page.getByRole("listbox", { name: "Mention a project, wiki page or file" });
  await expect(records.getByRole("group", { name: "Projects" }).getByRole("option")).toHaveText([/Mail migration.*This chat/]);
  await expect(records.getByRole("group", { name: "Files" }).getByRole("option")).toHaveText([/report\.md.*Bot files/, /older\.txt.*notes · Bot files/]);
  await shot("hash-menu", page.locator(".composewrap"), true);
  // Keyboard for the project.
  await page.keyboard.press("Enter");
  await expect(entry()).toHaveValue("about #Mail migration ");
  // Click for the file.
  await typeAtEnd("and #rep");
  await expect(records.getByRole("option")).toHaveCount(1);
  await records.getByRole("option", { name: /report\.md/ }).click();
  await expect(entry()).toHaveValue("about #Mail migration and #report.md ");
  await expect(chips().getByRole("listitem")).toHaveText(["Mail migration", "report.md"]);
  await shot("composer-chips", page.locator(".composewrap"), true);
  console.log("# lists the project (This chat) and files; keyboard and click each insert a token and a chip.");

  // Removing a chip leaves the text; deleting a token drops its chip.
  await button("Remove Mail migration").click();
  await expect(chips().getByRole("listitem")).toHaveText(["report.md"]);
  await expect(entry()).toHaveValue("about #Mail migration and #report.md ");
  await entry().fill("about #Mail migration and ");
  await expect(chips()).toHaveCount(0);
  // Pick the file, then the project, so the order picked shows in what is sent.
  await typeAtEnd("#rep");
  await page.keyboard.press("Enter");
  await expect(chips().getByRole("listitem")).toHaveText(["report.md"]);
  await typeAtEnd("#Mail");
  await page.keyboard.press("Tab");
  await expect(chips().getByRole("listitem")).toHaveText(["report.md", "Mail migration"]);
  console.log("Removing a chip keeps the text; deleting a token drops its chip.");

  // Send passes the text and the mentions in the order picked, minus removed ones.
  const files = await page.evaluate((chatId) => window.botkins.mentionables(chatId), chatId);
  const report = files.files.find((f) => f.name === "report.md");
  assert.ok(report, "report.md is listed");
  await button("Send message").click();
  await expect.poll(() => app.evaluate(() => globalThis.__sent.length)).toBe(1);
  const [sent] = await app.evaluate(() => globalThis.__sent);
  assert.equal(sent.id, chatId);
  assert.equal(sent.text, "about #Mail migration and #report.md #Mail migration");
  assert.deepEqual(sent.options.mentions, [
    { kind: "file", path: report.path },
    { kind: "project", id: projectId },
  ]);
  await expect(chips()).toHaveCount(0);
  await expect(entry()).toHaveValue("");
  console.log("Send passed the text and mentions [file, project].");

  // The Home composer lists the first bot's records before a chat exists.
  await sidebar("Home").click();
  await typeAtEnd("#");
  await expect(page.getByRole("listbox", { name: "Mention a project, wiki page or file" }).getByRole("option", { name: /report\.md/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await entry().fill("");
  console.log("The Home composer lists the bot's records.");

  // In a group chat "@" lists its bots and "everyone"; a bot is picked as plain text, with no chip.
  await page.evaluate(() => window.botkins.createGroupChat(["pip", "scout"], "Mentions group"));
  await sidebar("Chats").click();
  await page.locator("main").getByText("Mentions group").first().click();
  await expect(entry()).toBeVisible();
  await typeAtEnd("@");
  const members = page.getByRole("listbox", { name: "Mention a bot" });
  await expect(members.getByRole("group", { name: "Bots" })).toBeVisible();
  await expect(members.getByRole("option")).toHaveText([/@Pip/, /@Scout/, /@everyone/]);
  await page.keyboard.type("Sc");
  await expect(members.getByRole("option")).toHaveCount(1);
  await expect(members.getByRole("option")).toContainText("@Scout");
  await shot("at-menu", page.locator(".composewrap"), true);
  await page.keyboard.press("Enter");
  await expect(entry()).toHaveValue("@Scout ");
  await expect(members).toHaveCount(0);
  await expect(chips()).toHaveCount(0);
  // A query that matches nothing shows one muted line; Escape closes and keeps the text.
  await typeAtEnd("@zzz");
  await expect(page.getByRole("listbox", { name: "Mention a bot" })).toContainText("No matching bots");
  await page.keyboard.press("Escape");
  await noMenu();
  await expect(entry()).toHaveValue("@Scout @zzz");
  await entry().fill("");
  console.log("In a group chat @ lists the members and everyone; Enter inserts @Scout as text with no chip; no match shows a muted line.");

  // Stored data: a sent message with mentions and a turn with teammate asks.
  await app.close();
  app = undefined;
  const file = join(dataDir, "data", "workspace.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const chat = data.chats.find((c) => c.id === chatId);
  const t = Date.now() - 600000;
  const step = (id, name, label, status, start, secs) => ({ id, name, label, status, started: t + start, finished: t + start + secs * 1000 });
  chat.title = "Migration check-in";
  // Nothing was sent in it above (the send is a stand-in), so leaving it archived it. With messages it is a conversation again.
  delete chat.archived;
  chat.messages = [
    {
      role: "user",
      text: "@Contoso how is #Mail migration going? See #report.md",
      time: t,
      runId: "run-team",
      mentions: [
        // Saved by an earlier version, when "@" could mention a customer.
        { kind: "customer", id: "removed-customer", label: "Contoso" },
        { kind: "project", id: projectId, label: "Mail migration" },
        { kind: "file", path: report.path, label: "report.md" },
      ],
    },
    { role: "assistant", text: "Scout checked the cutover notes. Finance moves Friday.", time: t + 90000, runId: "run-team" },
    { role: "user", text: "Ask the others too", time: t + 100000, runId: "run-live" },
    { role: "assistant", text: "Still collecting answers.", time: t + 200000, runId: "run-live" },
  ];
  const ask = (id, botId, status, extra = {}) => ({ id, botId, fromBotId: "pip", message: "Can you help?", status, started: t + 5000, ...extra });
  data.runs.unshift(
    {
      id: "run-live", chatId, title: "Ask the others too", time: t + 100000, finished: t + 200000, status: "Completed", detail: "",
      teamwork: [
        ask("a5", "patch", "waiting"),
        ask("a6", "scout", "working", { intent: "Searching the web" }),
        ask("a7", "gone-bot", "working"),
        ask("a8", "scout", "stopped", { finished: t + 9000 }),
      ],
    },
    {
      id: "run-team", chatId, title: "@Contoso how is #Mail migration going?", time: t, finished: t + 90000, status: "Completed", detail: "",
      teamwork: [
        ask("a1", "scout", "answered", {
          message: "What is the Contoso mail cutover date?",
          expecting: "A date and who signed off",
          finished: t + 47000,
          reply: "**Friday, 14:00 UTC.** Signed off by:\n\n- Ada Park\n- Lin Ortiz",
          steps: [step("s1", "web_search", "Searching for Contoso cutover", "Done", 6000, 12), step("s2", "view", "Reading report.md", "Done", 20000, 3)],
        }),
        ask("a2", "patch", "failed", { error: "Patch is busy in another chat.", finished: t + 50000 }),
        ask("a3", "scout", "answered", { reply: "Pilot group is done.", finished: t + 60000 }),
        ask("a4", "scout", "answered", { message: "And the legal hold?", reply: "Still pending review.", finished: t + 70000 }),
      ],
    },
  );
  writeFileSync(file, JSON.stringify(data));
  await launch();
  await sidebar("Chats").click();
  await page.locator("main").getByText("Migration check-in").first().click();
  await expect(page.locator(".chathead h2")).toHaveText("Pip");

  // Sent chips under the user message.
  const sentChips = page.locator("article.user").first().getByRole("list", { name: "Mentions" });
  await expect(sentChips.getByRole("listitem")).toHaveText(["Contoso", "Mail migration", "report.md"]);
  await expect(sentChips.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(sentChips.getByRole("listitem").nth(2)).toHaveAttribute("title", report.path);
  // The old customer mention is a plain label: nothing to open and nothing that says customer.
  await expect(sentChips.getByRole("listitem").first().getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Open customer/ })).toHaveCount(0);
  await shot("sent-chips", page.locator("article.user").first());

  // Rail rows, merged and by status.
  const rails = page.getByRole("region", { name: "Teamwork" });
  await expect(rails).toHaveCount(2);
  await expect(rails.nth(0).getByRole("button")).toHaveText(["Scout answered", "Patch didn't answer", "2 messages with Scout"]);
  await expect(rails.nth(1).getByRole("button")).toHaveText(["Waiting for Patch", "Scout: Searching the web", "Asking a bot…", "Ask to Scout stopped"]);
  await expect(rails.nth(1).locator(".team-row.live")).toHaveCount(3);
  await shot("rail", rails.nth(0));
  await shot("rail-live", rails.nth(1));
  // The rail stays when tool calls fold and thinking is hidden.
  await page.evaluate(() => window.botkins.setPreferences({ foldTools: true, showThinking: false }));
  await expect(rails.nth(0).getByRole("button")).toHaveCount(3);

  // The detail: the message, what they need back, the reply as Markdown and the steps.
  const row = button("Scout answered", rails.nth(0));
  await row.click();
  const detail = page.getByRole("dialog", { name: "Pip asked Scout" });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("What is the Contoso mail cutover date?");
  await expect(detail).toContainText("What they need back: A date and who signed off");
  await expect(detail.locator("strong", { hasText: "Friday, 14:00 UTC." })).toBeVisible();
  await expect(detail.getByRole("listitem").filter({ hasText: "Ada Park" })).toBeVisible();
  await expect(detail).toContainText("What Scout did");
  await expect(detail).toContainText("web_search");
  await expect(detail).toContainText("Reading report.md");
  await expect(detail).toContainText("2 steps · Took 42s");
  await shot("rail-detail", detail);
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(row).toBeFocused();
  // The failed ask shows its error; a merged row shows both messages.
  await button("Patch didn't answer", rails.nth(0)).click();
  await expect(page.getByRole("dialog", { name: "Pip asked Patch" })).toContainText("Patch is busy in another chat.");
  await button("Close", page.getByRole("dialog", { name: "Pip asked Patch" })).click();
  await button("2 messages with Scout", rails.nth(0)).click();
  await expect(page.getByRole("dialog", { name: "Pip asked Scout" })).toContainText("Still pending review.");
  await expect(page.getByRole("dialog", { name: "Pip asked Scout" })).toContainText("Message 2 of 2");
  await page.keyboard.press("Escape");
  // A deleted bot shows as "a bot" without crashing.
  await button("Asking a bot…", rails.nth(1)).click();
  await expect(page.getByRole("dialog", { name: "Pip asked a bot" })).toBeVisible();
  await page.keyboard.press("Escape");
  console.log("Sent chips render; rail rows merge and show each status; the detail opens and Escape returns focus.");

  // The smallest window still fits the rail and chips.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, "no horizontal scroll at 760×560");
  await shot("small-window");
  await typeAtEnd("#");
  await expect(page.getByRole("listbox", { name: "Mention a project, wiki page or file" })).toBeVisible();
  await shot("small-hash-menu", undefined, true);
  await page.keyboard.press("Escape");
  await entry().fill("");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 860));

  // The project chip opens its project.
  await button("Open project Mail migration").click();
  await expect(page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Work", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Mail migration" }).first()).toBeVisible();
  console.log("The project chip opens its project; the old customer mention stays a plain label.");

  if (live) {
    await button("New chat").click();
    await page.getByRole("dialog").getByRole("button", { name: /Pip/ }).click();
    await typeAtEnd("What is the cutover code word of #Mail");
    await page.keyboard.press("Enter");
    await typeAtEnd("? Answer with the code word only.");
    await page.keyboard.press("Enter");
    const id = (await snap()).chats[0].id;
    await expect
      .poll(async () => (await snap()).chats.find((c) => c.id === id)?.messages.find((m) => m.role === "assistant")?.text ?? "", { timeout: 180000 })
      .toContain("PELICAN-7");
    console.log("Live: the reply used the mentioned project's description.");
  } else console.log("Set BOTKINS_LIVE=1 for a real turn that mentions a project.");

  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Mentions smoke passed. No renderer exceptions." + (shots ? " Screenshots in " + shots : ""));
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
}
