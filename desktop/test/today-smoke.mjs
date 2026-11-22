// Uses real local Copilot sessions and temporary sample sources. Set BOTKINS_LIVE=1 for model turns.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { createSources } from "./fixtures/sources.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-today-"));
const fixtures = createSources(dir);
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  _electron.launch({
    args: process.env.BOTKINS_BINARY ? [] : ["."],
    executablePath: process.env.BOTKINS_BINARY,
    env,
  });
let app = await launch(),
  page = await home(app);
const snapshot = () => page.evaluate(() => window.botkins.snapshot());
const button = (name) => page.getByRole("button", { name, exact: true });
const nav = (name) =>
  page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
const entry = () =>
  page.getByRole("combobox", { name: "Message", exact: true });
const watch = (fn) =>
  expect.poll(fn, { timeout: 150000, intervals: [200, 500, 1000] });
const readDisk = () =>
  JSON.parse(readFileSync(join(dir, "data", "workspace.json"), "utf8"));
async function pick(command) {
  await entry().fill("/" + command);
  await expect(
    page.getByRole("option", { selected: true }).first(),
  ).toContainText("/" + command.replace(/^tool:/, ""), { timeout: 45000 });
  await entry().press("Tab");
  await expect(entry()).toHaveValue("/" + command + " ");
}
async function finishTurn(before) {
  await watch(async () => {
    const s = await snapshot();
    return s.runs.length > before && s.runs[0].status !== "Working";
  }).toBe(true);
  const s = await snapshot();
  assert.equal(s.runs[0].status, "Completed", s.runs[0].detail);
  return s;
}
async function submit(command, suffix) {
  await pick(command);
  if (suffix)
    await entry()
      .press("End")
      .then(() => entry().pressSequentially(suffix));
  const before = (await snapshot()).runs.length;
  await button("Send message").click();
  return finishTurn(before);
}
async function settings(tab) {
  await button("Settings").click();
  const d = page.getByRole("dialog");
  // Settings is a side menu of sections; a bot's capabilities sit under Bots & capabilities.
  if (tab === "Capabilities") {
    await d.getByRole("tab", { name: "Bots & capabilities", exact: true }).click();
    await d.getByRole("tab", { name: "Capabilities", exact: true }).click();
  } else await d.getByRole("tab", { name: tab, exact: true }).click();
}
try {
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await entry().fill("/");
  await page
    .getByRole("option", { name: /\/today-panel / })
    .waitFor({ timeout: 45000 });
  await entry().press("Escape");
  assert.equal(await page.getByRole("listbox").count(), 0);
  await nav("Today");
  await page.getByRole("heading", { name: "Build your first panel" }).waitFor();
  await nav("Home");
  await button("Add bot").click();
  await page.getByLabel("Name", { exact: true }).fill("Almanac");
  await page.getByLabel("Role", { exact: true }).fill("Panel editor");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Maintain accurate panels. Use the tools the user requests.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create bot", exact: true })
    .click();
  // Skills, a plugin and an MCP server are added once for every bot (Settings › Skills and › MCP servers).
  // The operating-system folder picker is replaced with a fixed choice; the main process still reads the real folders.
  for (const [kind, path] of [["folder", fixtures.skills], ["plugin", fixtures.plugin]]) {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    assert.equal((await page.evaluate(() => window.botkins.addSkillFolder())).kind, kind);
  }
  assert.deepEqual(
    (await page.evaluate((json) => window.botkins.importMcpServers(json), readFileSync(fixtures.mcp, "utf8"))).added,
    ["botkins-sample"],
  );
  await settings("Capabilities");
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Bot", exact: true })
    .selectOption({ label: "Almanac" });
  await button("Inspect capabilities").click();
  await page
    .getByRole("heading", { name: "Available to Almanac" })
    .waitFor({ timeout: 45000 });
  await page.getByText(/^MCP servers \(/).click();
  await page
    .getByText("botkins-sample · connected", { exact: true })
    .waitFor();
  await button("Close dialog").click();
  await button("New chat").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Almanac/ })
    .click();
  await page
    .locator(".chathead")
    .getByRole("heading", { name: "Almanac" })
    .waitFor();
  await pick("sample-skill");
  await settings("Storage");
  await button("Clear cache").click();
  await page.getByText("Cache cleared.", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.botkins.cacheInfo())).catalogs,
    0,
  );
  await button("Close dialog").click();
  console.log(
    "Home, Today, bot creation, configured sources, live discovery, slash selection and cache clearing passed.",
  );

  if (process.env.BOTKINS_LIVE === "1") {
    let s = await submit("sample-skill", "");
    assert.equal(s.runs[0].skill, "sample-skill");
    assert.ok(
      s.chats[0].messages.at(-1).text.includes(fixtures.skillProof),
      "Expected fixture " +
        fixtures.skillProof +
        " in " +
        JSON.stringify(s.chats[0].messages.at(-1)).slice(0, 250),
    );
    s = await submit("sample-pack:plugin-sample", "");
    assert.equal(s.runs[0].skill, "sample-pack:plugin-sample");
    assert.ok(
      s.chats[0].messages.at(-1).text.includes(fixtures.pluginProof),
      s.chats[0].messages.at(-1).text.slice(0, 180),
    );
    // The tool is called from a new chat. In the chat above, the fixture skills (which say "reply
    // with only this identifier, do not use tools") are still loaded in the open session, and a
    // model may follow them instead of calling a tool.
    await button("New chat").click();
    await page.getByRole("dialog").getByRole("button", { name: /Almanac/ }).click();
    await expect.poll(async () => (await snapshot()).chats[0].messages.length).toBe(0);
    // The new chat's own composer replaces the previous chat's; type only once it is there.
    await page.getByText("botkins-sample-read_sample").first().waitFor({ state: "detached" }).catch(() => {});
    await expect(entry()).toHaveValue("");
    await page.waitForTimeout(500);
    // Only the synthetic read-only fixture may receive approval in this test.
    const approval = page
      .getByRole("region", { name: "Approval request" })
      .filter({ hasText: "botkins-sample" })
      .filter({ hasText: "read_sample" });
    const approve = approval
      .getByRole("button", { name: "Allow once", exact: true })
      .click({ timeout: 45000 })
      .catch(() => {});
    s = await submit(
      "tool:botkins-sample-read_sample",
      "Return the sample identifier verbatim.",
    );
    void approve;
    assert.ok(
      readFileSync(fixtures.receipt, "utf8").includes(fixtures.toolProof),
    );
    assert.ok(s.chats[0].messages.at(-1).text.includes(fixtures.toolProof));
    console.log(
      "Verified separate filesystem skill, plugin skill and MCP tool invocation through slash selections.",
    );

    await nav("Today");
    await button("Create panel").click();
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Bot", exact: true })
      .selectOption({ label: "Almanac" });
    await page
      .getByLabel("What should the panel show?")
      .fill(
        'Create a panel with key "sample-count", title "Sample count", a metric labeled Samples with value 3, and a table with the columns Name and Count and the rows Alpha, 1 and Beta, 2. Do not ask me anything. Set a routine with today_routine using cron "* * * * *" in UTC. Its exact refresh instructions are: Set the metric value to 4 using today_publish; keep the title and the table. Use no outside sources.',
      );
    const before = s.runs.length;
    await button("Ask bot").click();
    s = await finishTurn(before);
    assert.equal(s.panels.length, 1);
    const p = s.panels[0];
    assert.equal(p.routine?.cron, "* * * * *");
    assert.equal(p.routine.enabled, true);
    assert.equal(p.blocks.find((b) => b.type === "metric").value, "3");
    await nav("Today");
    await page
      .getByRole("heading", { name: "Sample count", exact: true })
      .waitFor();
    await page.getByRole("table").waitFor();
    const hiddenAt = Date.now();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      false,
    );
    await watch(() =>
      readDisk().runs.some(
        (r) =>
          r.trigger === "scheduled" &&
          r.time >= hiddenAt &&
          r.status === "Completed",
      ),
    ).toBe(true);
    assert.equal(
      readDisk().panels[0].blocks.find((b) => b.type === "metric").value,
      "4",
    );
    await app.evaluate(({ app }) => app.emit("activate"));
    await button("Manage Sample count").click();
    await button("Pause routine").click();
    await button("Resume routine").waitFor();
    await button("Close dialog").click();
    const updated = (await snapshot()).panels[0];
    await app.close();
    app = await launch();
    page = await home(app);
    await nav("Today");
    await page
      .getByRole("heading", { name: "Sample count", exact: true })
      .waitFor();
    const restored = (await snapshot()).panels[0];
    assert.equal(restored.id, p.id);
    assert.equal(restored.revision, updated.revision);
    assert.equal(restored.routine.enabled, false);
    assert.equal(restored.lastCheck.status, "Updated");
    await nav("Work");
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await page
      .getByRole("button", { name: /Update Sample count.*Scheduled/ })
      .first()
      .click();
    await page.getByRole("heading", { name: "Almanac", exact: true }).waitFor();
    console.log(
      "Real bot published a rich panel, set a cron job and refreshed it with the window closed. Pausing, restart persistence and Work routing passed.",
    );
  }
} finally {
  await app.close();
  // Conversations' Copilot state lives in the test's data folder and goes with it.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
