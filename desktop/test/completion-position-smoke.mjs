// Exercise the desktop renderer with streamed snapshots in a disposable workspace.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-position-"));
const shots = process.env.BOTKINS_POSITION_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const id = "field-notes";
seedApp(dir);
const file = join(dir, "data", "workspace.json");
const workspace = JSON.parse(readFileSync(file, "utf8"));
workspace.chats.push({ id, botId: workspace.bots[0].id, title: "Field notes", time: Date.now(), messages: [], established: true });
writeFileSync(file, JSON.stringify(workspace));
const notes = [
  ["Before you leave", "Pack a notebook, a pencil and a watch. Choose a place you can visit again. Returning to one spot makes changes easier to see."],
  ["Record the conditions", "Write down the date, the weather and where you stood. A cool, still morning can sound quite different from a windy afternoon."],
  ["Listen first", "Stand still for a minute. Mark the direction of each sound before looking for the bird that made it."],
  ["Describe what you see", "Start with size and shape. A quick sketch of a tail or a wing often helps more than a guess at the species."],
  ["Watch for movement", "Notice where the bird feeds and how it moves between perches. Record a short sequence in your own words."],
  ["Map your route", "Draw the path and mark the stops where you heard or saw something. Include a landmark you can find on the next visit."],
  ["Pause by the water", "Watch the bank from a distance. Sketch the edge of the water and add a mark for each place a bird lands."],
  ["Follow the light", "Keep the sun behind you when possible. Write down any colors you can see and leave uncertain details open."],
  ["Make a sound map", "Put a dot in the middle of a page for your position. Draw a line toward each call, with a short note about its rhythm."],
  ["Leave some space", "Give feeding and nesting birds room. Record what you can see from the path and move on if their behavior changes."],
  ["Choose a return visit", "Pick one part of the walk to repeat next week. Aim for a similar time of day so the two entries are easy to compare."],
  ["Compare your notes", "Read the last entry before you pack up. Mark what changed and leave one question for next time."],
];
const reply = "# A field guide to birdwatching\n\n" + notes.map(([title, body]) => "## " + title + "\n\n" + body).join("\n\n");

let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await signedInAs(app);
  await page.reload();
  await skipWelcome(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Chat", exact: true }).click();
  const picker = settings.getByLabel("Position after response completes", { exact: true });
  await expect(picker).toHaveValue("latest");
  await picker.selectOption("beginning");
  await expect(picker).toHaveValue("beginning");
  if (shots) await settings.locator(".set-group").filter({ has: page.getByRole("heading", { name: "Chat", exact: true }) }).screenshot({ path: join(shots, "chat-position-setting.png") });
  await settings.getByRole("button", { name: "Close dialog" }).click();

  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), id);
  await expect(page.locator(".chathead-title h2")).toBeVisible();
  const state = await page.evaluate(() => window.botkins.snapshot());
  const chat = state.chats.find(c => c.id === id);
  // Keep unrelated host refreshes (for example provider status) on the same synthetic transcript.
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    globalThis.positionSnapshot = snapshot;
    contents.send = (channel, ...args) => channel === "changed"
      ? send(channel, globalThis.positionSnapshot) : send(channel, ...args);
  }, state);
  const publish = () => app.evaluate(({ BrowserWindow }, value) => {
    globalThis.positionSnapshot = value;
    BrowserWindow.getAllWindows()[0].webContents.send("changed", value);
  }, state);
  const view = page.locator(".messages");
  const distance = () => view.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  const run = { id: "field-guide", chatId: id, time: Date.now(), status: "Working", title: "Birdwatching", detail: "" };
  state.runs.unshift(run);
  chat.messages.push({ role: "user", text: "Write a field guide for a first birdwatching walk.", runId: run.id });
  state.streams[id] = reply.slice(0, 600);
  await publish();
  await expect(view.locator(".assistant.live")).toBeVisible();
  state.streams[id] = reply;
  await publish();
  await expect(view.getByText("Compare your notes", { exact: true })).toBeVisible();
  await expect.poll(distance).toBeLessThan(2);

  // The host can announce completion before the final chat detail arrives.
  delete state.streams[id];
  run.status = "Completed";
  run.finished = Date.now();
  await publish();
  await expect(view.locator(".assistant.live")).toHaveCount(0);
  chat.messages.push({ role: "assistant", text: reply, time: run.finished, runId: run.id });
  await publish();
  const row = view.locator("article.assistant").last();
  // The reply's top, measured from where the first message rests: below the faded top edge.
  const offset = () => row.evaluate(el => {
    const scroller = el.closest(".messages");
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - parseFloat(getComputedStyle(scroller).paddingTop);
  });
  await expect.poll(async () => Math.abs(await offset())).toBeLessThan(2);
  assert.ok(await distance() > 100, "remaining reply height: " + await distance());
  const top = await offset();
  if (shots) await page.locator(".messages-wrap").screenshot({ path: join(shots, "completed-reply-beginning.png") });
  chat.messages.at(-1).text += "\n\nKeep your field notes together for the next walk.";
  await publish();
  await expect(view.getByText("Keep your field notes together for the next walk.")).toBeVisible();
  await expect.poll(async () => Math.abs(await offset() - top), { message: "a later render keeps the reading position" }).toBeLessThan(2);

  await page.getByRole("button", { name: "Scroll to latest message" }).click();
  await expect.poll(distance).toBeLessThan(2);
  await publish();
  await expect.poll(distance).toBeLessThan(2);
  const nextTurn = async (id) => {
    const turn = { ...run, id, status: "Working", time: Date.now(), finished: undefined };
    state.runs.unshift(turn);
    chat.messages.push({ role: "user", text: "Continue the field notes.", runId: id });
    state.streams[chat.id] = reply;
    await publish();
    await expect(view.locator(".assistant.live")).toBeVisible();
    await expect.poll(distance).toBeLessThan(2);
    return turn;
  };
  const finish = async (turn, text) => {
    turn.status = "Completed";
    turn.finished = Date.now();
    delete state.streams[chat.id];
    chat.messages.push({ role: "assistant", text, runId: turn.id });
    await publish();
    await expect(view.locator(".assistant.live")).toHaveCount(0);
  };

  const manual = await nextTurn("manual-scroll");
  await view.evaluate(el => { el.scrollTop -= 450; });
  await expect(page.getByRole("button", { name: "Scroll to latest message" })).toBeVisible();
  const before = await view.evaluate(el => el.scrollTop);
  await finish(manual, reply);
  await expect.poll(async () => Math.abs(await view.evaluate(el => el.scrollTop) - before)).toBeLessThan(2);

  // The test driver keeps its page focused whatever the window does, and turning that off through
  // the driver did not hold from one step to the next. So while the window is hidden the page itself
  // is told it has no focus, which is what a window in the tray reports, and it gets its own answer
  // back, with the event a real window sends, when the window is shown again.
  const background = await nextTurn("background");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await page.evaluate(() => {
    document.hasFocus = () => false;
  });
  await expect.poll(() => page.evaluate(() => document.hidden || !document.hasFocus())).toBe(true);
  await finish(background, "Pack a notebook and pencil.");
  assert.ok(Math.abs(await offset()) > 2, "the hidden window has not jumped");
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.show();
    win.focus();
  });
  await page.evaluate(() => {
    delete document.hasFocus;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(async () => Math.abs(await offset())).toBeLessThan(2);
  const elsewhere = await nextTurn("another-page");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home", exact: true }).click();
  await expect(view).toHaveCount(0);
  await finish(elsewhere, reply);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), id);
  await expect.poll(async () => Math.abs(await offset())).toBeLessThan(2);
  console.log("The stream followed the bottom. The hydrated reply landed", top, "CSS pixels from the top and stayed there through a later update.");
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
