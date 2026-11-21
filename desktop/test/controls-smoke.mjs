import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-controls-ui-"));
// GitHub Copilot and Claude only, so the picker shows two providers whatever else this computer has.
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot,claude", COMMANDER_PROVIDERS: "copilot,claude" };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  _electron.launch({
    args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."],
    executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY),
    env,
  });
// A second runtime with its own state, to read Copilot's command list for comparison.
const probe = new CopilotClient({
  mode: "coding-agent",
  runtime: RuntimeConnection.forInProcess({ baseDirectory: join(dir, "probe") }),
});
const live = (process.env.BOTKINS_LIVE ?? process.env.COMMANDER_LIVE) === "1";
let app, page, session;
const errors = [];
async function start() {
  app = await launch();
  page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
}
const button = (name) => page.getByRole("button", { name, exact: true });
const entry = () =>
  page.getByRole("combobox", { name: "Message", exact: true });
const snap = () => page.evaluate(() => window.botkins.snapshot());
const dialog = () => page.getByRole("dialog");
const wait = (fn) =>
  expect.poll(fn, { timeout: 120000, intervals: [100, 250, 500] });
// The model picker (src/ModelPicker.tsx): a listbox of models grouped by provider, and the thinking levels as radios.
const listbox = () => dialog().getByRole("listbox", { name: "Model", exact: true });
const choice = (m) =>
  listbox().getByRole("group", { name: m.providerName, exact: true }).getByRole("option", { name: m.name, exact: true });
const inherit = (name) => listbox().getByRole("option", { name, exact: true });
const levels = () => dialog().getByRole("radiogroup", { name: "Thinking level" });
/** Moves the thinking level with the keyboard, from the level that is checked. */
async function level(...keys) {
  await levels().getByRole("radio", { checked: true }).focus();
  for (const key of keys) await page.keyboard.press(key);
}
const EFFORTS = { xhigh: "Extra high", max: "Max", none: "None", minimal: "Minimal" };
const effortLabel = (e) => EFFORTS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
async function send(prompt) {
  await expect(dialog()).toBeHidden();
  await entry().click();
  await entry().fill(prompt);
  await expect(entry()).toHaveValue(prompt);
  await button("Send message").click();
  await expect(entry()).toHaveValue("");
}
async function finished(label) {
  await wait(async () => {
    const r = (await snap()).runs[0];
    return r?.status !== "Working" && r?.title === label.slice(0, 100);
  }).toBe(true);
  const r = (await snap()).runs[0];
  assert.equal(r.status, "Completed", r.detail);
  return r;
}
async function record(name) {
  if ((process.env.BOTKINS_QA_DIR ?? process.env.COMMANDER_QA_DIR)) {
    mkdirSync((process.env.BOTKINS_QA_DIR ?? process.env.COMMANDER_QA_DIR), { recursive: true });
    await page.screenshot({
      path: join((process.env.BOTKINS_QA_DIR ?? process.env.COMMANDER_QA_DIR), name + ".png"),
    });
  }
}
try {
  await start();
  await probe.start();
  session = await probe.createSession({
    model: "auto",
    permissions: { onRequest: () => ({ kind: "reject" }) },
  });
  const commands = (await session.rpc.commands.list()).commands.filter(
    (c) => c.kind === "builtin",
  );
  const menu = await page.evaluate(() => window.botkins.catalog("pip"));
  for (const c of commands) {
    const item = menu.choices.find((i) => i.command === c.name);
    assert.ok(item, c.name);
    for (const a of c.aliases ?? []) assert.ok(item.aliases.includes(a), a);
  }
  const models = await page.evaluate(() => window.botkins.models());
  // The Copilot model the turns below run on (the /usage checks need Copilot's runtime).
  const candidates = models.filter(
    (m) =>
      m.provider === "copilot" && m.available && m.efforts.includes("low") && m.efforts.includes("high"),
  );
  const model = candidates.find((m) => m.id.includes("sol")) ?? candidates[0];
  assert.ok(model);
  await button("Settings").click();
  // Models are grouped under their provider, each heading with the provider's mark.
  await choice(model).waitFor();
  const groups = await listbox().getByRole("group").evaluateAll((gs) => gs.map((g) => g.getAttribute("aria-label")));
  assert.ok(groups.includes("GitHub Copilot"), groups.join(", "));
  await expect(listbox().locator(".mp-group-head .provider-icon[data-provider=copilot]")).toHaveCount(1);
  if (models.some((m) => m.provider === "claude")) {
    assert.ok(groups.includes("Claude"), groups.join(", "));
    assert.ok(groups.indexOf("GitHub Copilot") < groups.indexOf("Claude"), "providers keep the registry's order");
    await expect(listbox().locator(".mp-group-head .provider-icon[data-provider=claude]")).toHaveCount(1);
    const claude = models.find((m) => m.provider === "claude");
    await expect(choice(claude)).toHaveCount(1);
    console.log("The picker groups GitHub Copilot and Claude models under their own headings and marks.");
  } else console.log("Claude isn't connected on this computer; only the GitHub Copilot group was checked.");
  // Search filters by name and provider; nothing found says so.
  await dialog().getByLabel("Search models").fill(model.name);
  await expect(choice(model)).toBeVisible();
  await dialog().getByLabel("Search models").fill("no-such-model-zz");
  await dialog().getByText("No models match", { exact: false }).waitFor();
  await dialog().getByLabel("Search models").fill("");
  await choice(model).click();
  await expect(choice(model)).toHaveAttribute("aria-selected", "true");
  await level("Home", "ArrowRight");
  await expect(levels().getByRole("radio", { name: effortLabel(model.efforts[0]), exact: true })).toBeChecked();
  await button("Save model").click();
  await wait(async () => (await snap()).settings.model.reasoningEffort).toBe(
    model.efforts[0],
  );
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await dialog().getByRole("radiogroup", { name: "Light or dark" }).getByRole("radio", { name: "Dark", exact: true }).click();
  await dialog().getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Bluebell", exact: true }).click();
  await wait(async () => (await snap()).settings.appearance.colorTheme).toBe("bluebell");
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme === "dark",
      ),
    )
    .toBe(true);
  await dialog().getByLabel("Use the theme's color").uncheck();
  await dialog().getByLabel("Bubble color").fill("#8bc6b2");
  await wait(async () => (await snap()).settings.appearance.bubble).toBe(
    "#8bc6b2",
  );
  await record("appearance");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await dialog().getByLabel("Approval level").selectOption("read");
  await dialog()
    .getByLabel("Custom question instructions")
    .fill("When I request a team brief, ask which audience should read it.");
  await button("Save instructions").click();
  await button("Close dialog").click();
  await button("New chat").click();
  await dialog().getByRole("button", { name: /Pip/ }).click();
  await button("Bot settings").click();
  await choice(model).click();
  await level("End");
  await button("Save model").click();
  await wait(async () => (await snap()).bots[0].model?.reasoningEffort).toBe(
    model.efforts.at(-1),
  );
  await button("Close dialog").click();
  await entry().fill("/models");
  await expect(
    page.getByRole("option", { selected: true }).first(),
  ).toContainText("/model", { timeout: 45000 });
  await entry().press("Enter");
  await expect(inherit("Use the bot's default")).toHaveAttribute("aria-selected", "true");
  // Arrow keys move the choice through the list; the first model follows the default.
  const first = models.find((m) => m.available);
  await listbox().focus();
  await page.keyboard.press("ArrowDown");
  await expect(choice(first)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(inherit("Use the bot's default")).toHaveAttribute("aria-selected", "true");
  await choice(model).click();
  await level("Home", "ArrowRight");
  await record("chat-model");
  await button("Save model").click();
  await wait(async () => (await snap()).chats[0].model?.reasoningEffort).toBe(
    model.efforts[0],
  );
  await expect(dialog()).toBeHidden();
  // The chat header names the model with its provider's mark and thinking level.
  const header = page.getByRole("button", { name: /^Model: / });
  await expect(header).toContainText(model.name);
  await expect(header).toContainText(effortLabel(model.efforts[0]));
  await expect(header.locator(".provider-icon[data-provider=copilot]")).toHaveCount(1);
  await entry().click();
  await entry().fill("/btw");
  await expect(
    page.getByRole("option", { selected: true }).first(),
  ).toContainText("/btw", { timeout: 45000 });
  await entry().press("Escape");
  await send("/usage");
  await finished("/usage");
  const usage = (await snap()).chats[0].messages.at(-1);
  assert.match(usage.text, /usage/i);
  assert.equal(usage.plain, true);
  const output = page.locator("article.command pre.command-output").last();
  await output.waitFor({ timeout: 5000 });
  assert.equal(await output.textContent(), usage.text);
  console.log(
    "Matched " +
      commands.length +
      " native commands and their aliases. " +
      models.length +
      " models; global, bot and chat pickers, dark appearance and /usage verified.",
  );
  if (live) {
    const code = randomUUID().slice(0, 8);
    const basic =
      "Remember " + code + ". Reply with that code only. Do not use tools.";
    await send(basic);
    const main = await finished(basic);
    assert.equal(main.model.model, model.id);
    assert.equal(main.model.reasoningEffort, model.efforts[0]);
    const before = await snap();
    await send(
      "/btw Which code did I ask you to remember? Reply with the code.",
    );
    const side = page.getByRole("region", { name: "Side answer" });
    await expect(side).toContainText(code, { timeout: 120000 });
    const after = await snap();
    assert.equal(after.runs.length, before.runs.length);
    assert.equal(
      after.chats[0].messages.length,
      before.chats[0].messages.length,
    );
    await button("Dismiss side answer").click();
    const question =
      "Create a team brief. First use the ask_user tool right now to ask which audience, with the choices Partners and Editors. Wait for my answer, then reply with the audience only.";
    await send(question);
    const q = page.getByRole("region", { name: "Clarifying question" });
    await q.waitFor({ timeout: 120000 });
    const qcode = "Editors";
    const choice = q.getByRole("button", { name: qcode, exact: true });
    if (await choice.count()) await choice.click();
    else await q.getByLabel("Your answer").fill(qcode);
    await record("clarification");
    await q.getByRole("button", { name: "Send answer" }).click();
    await finished(question);
    assert.match((await snap()).chats[0].messages.at(-1).text, /Editors/i);
    const card =
      "Call the render_card tool exactly once with title Test report, a metric labeled Samples with value 3, and reply button Show details. Reply briefly after the card.";
    await send(card);
    await finished(card);
    await expect(
      page.getByRole("region", { name: "Test report" }),
    ).toContainText("Samples");
    await button("Show details").click();
    await expect(entry()).toHaveValue("Show details");
    const trail = page.getByRole("region", { name: "Tool activity" }).last();
    await expect(trail.locator("button").first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await trail.locator("button").first().click();
    await expect(trail).toContainText("render_card");
    await record("tool-card");
    console.log(
      "Actual SDK model/effort, native side question with context, ask_user choice and rich-card/tool trail passed.",
    );
  }
  // The composer's model button names the model it shows the provider's mark of.
  await page.getByRole("button", { name: /^Chat model and thinking/ }).click();
  await inherit("Use the bot's default").click();
  await button("Save model").click();
  const botCheck = "/usage ";
  await send(botCheck);
  await wait(async () => (await snap()).runs[0].model?.reasoningEffort).toBe(
    model.efforts.at(-1),
  );
  await button("Bot settings").click();
  await inherit("Use the global default").click();
  await button("Save model").click();
  await button("Close dialog").click();
  await button("Settings").click();
  await level("Home");
  await expect(levels().getByRole("radio", { name: "Default", exact: true })).toBeChecked();
  await button("Save model").click();
  await button("Close dialog").click();
  const count = (await snap()).runs.length;
  await send("/usage");
  await wait(async () => {
    const s = await snap();
    return s.runs.length === count + 1 && s.runs[0].status === "Completed";
  }).toBe(true);
  const inherited = (await snap()).runs[0].model;
  assert.equal(inherited.model, model.id);
  assert.equal(inherited.reasoningEffort, undefined);
  const scheduled = "/after 4h Say hello";
  await send(scheduled);
  await finished(scheduled);
  await send("/every stop 1");
  await finished("/every stop 1");
  assert.equal((await snap()).chats[0].schedules.length, 0);
  console.log(
    "A resumed SDK session adopted the bot override, then the global provider-default effort. Native schedule registration and removal passed.",
  );
  await app.close();
  app = undefined;
  await start();
  const persisted = await snap();
  assert.equal(persisted.settings.appearance.theme, "dark");
  assert.equal(persisted.settings.approval, "read");
  assert.equal(persisted.chats[0].model, undefined);
  assert.equal(persisted.settings.model.model, model.id);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Relaunch preserved settings and chat. No renderer exceptions.");
} finally {
  if (app) await app.close();
  if (session) {
    await session.disconnect();
    await probe.deleteSession(session.sessionId).catch(() => {});
  }
  await probe.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
