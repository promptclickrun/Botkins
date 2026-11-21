// Isolated Electron smoke for Artifacts and verified chat paths. It creates no user-profile data.
import assert from "node:assert/strict";
import { _electron, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileDetails } from "../desktop/artifact-files.mjs";
import { seedApp } from "./starter.mjs";
import { skipWelcome } from "./welcome-helper.mjs";

/** A small picture of one colour, as a PNG file's bytes. */
function png(width, height, [r, g, b]) {
  const part = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), part("IHDR", head), part("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), part("IEND", Buffer.alloc(0))]);
}

const dir = mkdtempSync(join(tmpdir(), "botkins-artifacts-ui-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
seedApp(dir);
const executablePath = process.env.BOTKINS_BINARY;
const launch = () => _electron.launch({ args: executablePath ? [] : ["."], executablePath, env, timeout: 120000 });
let app;
try {
  app = await launch();
  const first = await skipWelcome(await app.firstWindow());
  await first.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.close();
  const workspacePath = join(dir, "data", "workspace.json");
  const workspace = JSON.parse(readFileSync(workspacePath, "utf8"));
  const bot = workspace.bots[0];
  const chat = { id: "artifact-smoke-chat", botId: bot.id, title: "Artifact smoke", time: Date.now(), established: false, messages: [] };
  workspace.chats.push(chat);
  const fixture = join(dir, "artifact-preview.txt");
  writeFileSync(fixture, "Artifacts preview fixture\n");
  chat.messages.push({ role: "assistant", text: `Saved ${fixture}.`, time: Date.now(), botId: bot.id });
  const unindexed = join(dir, "unindexed-preview.txt");
  writeFileSync(unindexed, "Unindexed local preview fixture\n");
  chat.messages.push({ role: "assistant", text: `Also saved ${unindexed}.`, time: Date.now(), botId: bot.id });
  for (let i = 0; i < 36; i++) chat.messages.push({ role: "user", text: "Field note " + (i + 1) });
  const sentIndex = chat.messages.length;
  chat.messages.push({ role: "assistant", text: "MEDIA:" + fixture, botId: bot.id });
  // A reply with MEDIA: lines, in the shape of the owner's report: each picture on the line after its
  // heading. One file is written twice, one is a file the computer does not know, one does not exist.
  const pictureOne = join(dir, "01-anatomy.png");
  const pictureTwo = join(dir, "02-closed.png");
  const stranger = join(dir, "not-the-chats.png");
  writeFileSync(pictureOne, png(900, 300, [40, 120, 200]));
  writeFileSync(pictureTwo, png(200, 1200, [200, 120, 40]));
  writeFileSync(stranger, png(20, 20, [0, 0, 0]));
  const mediaIndex = chat.messages.length;
  chat.messages.push({ role: "assistant", botId: bot.id, time: Date.now(), text: [
    "Here are the mockups, one image each:",
    "",
    "**1. Side menu layout.** The numbers mark the order.",
    "MEDIA:" + pictureOne,
    "",
    "**2. Closed**",
    "MEDIA:" + pictureTwo,
    "",
    "The first again: MEDIA:" + pictureOne,
    "",
    "The notes: MEDIA:" + fixture,
    "",
    "MEDIA:" + stranger,
    "",
    "MEDIA:" + join(dir, "never-written.png"),
    "",
    "That is all.",
  ].join("\n") });
  writeFileSync(workspacePath, JSON.stringify(workspace));
  const sentPicture = (path, id) => { const file = fileDetails(path); return { botId: bot.id, chatId: chat.id, path: file.path, identity: file.identity, time: Date.now(), id, messageIndex: mediaIndex, source: "media" }; };
  const info = fileDetails(fixture);
  assert.ok(info);
  const record = { botId: bot.id, chatId: chat.id, path: info.path, identity: info.identity, time: Date.now() };
  writeFileSync(join(dir, "data", "artifacts.json"), JSON.stringify([
    { ...record, id: "smoke-artifact", messageIndex: 0, source: "tool" },
    { ...record, id: "smoke-sent", messageIndex: sentIndex, source: "media" },
    sentPicture(pictureOne, "smoke-picture-one"),
    sentPicture(pictureTwo, "smoke-picture-two"),
  ]));

  app = await launch();
  const page = await skipWelcome(await app.firstWindow());
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chat.id);
  await expect(page.locator("aside.side-pane")).toBeVisible();
  await page.getByRole("tab", { name: /^Artifacts/ }).click();
  await expect(page.locator(".artifact-list")).toContainText("artifact-preview.txt");
  const written = page.getByRole("button", { name: /artifact-preview\.txt.*Written/ });
  const sent = page.getByRole("button", { name: /artifact-preview\.txt.*Sent/ });
  await expect(written).toContainText("Written", { timeout: 3000 });
  await expect(sent).toContainText("Sent");
  await written.click();
  await expect(page.locator(".artifact-text")).toContainText("Artifacts preview fixture");
  // "Add to a project…" is offered once there is a project, and puts the artifact on that project's list.
  await expect(page.getByRole("button", { name: "Add to a project…" })).toHaveCount(0);
  const projectId = await page.evaluate(() => window.botkins.createProject({ name: "Field notes" }));
  await page.getByRole("button", { name: "Add to a project…" }).click();
  const toProject = page.getByRole("dialog", { name: "Add to a project" });
  await expect(toProject).toContainText("artifact-preview.txt");
  await expect(toProject.getByRole("list", { name: "Projects" }).getByRole("listitem")).toHaveText([/Field notes.*Nothing attached yet\./]);
  await toProject.getByRole("button", { name: "Add to Field notes" }).click();
  await expect(toProject.getByRole("button", { name: "Added to Field notes" })).toBeDisabled();
  await toProject.getByRole("button", { name: "Done", exact: true }).click();
  await expect(toProject).toBeHidden();
  assert.deepEqual((await page.evaluate(() => window.botkins.snapshot())).projects.find((p) => p.id === projectId).artifacts, ["smoke-artifact"]);
  // The same from the right-click menu.
  await sent.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to a project…" }).click();
  await toProject.getByRole("button", { name: "Add to Field notes" }).click();
  await toProject.getByRole("button", { name: "Done", exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.botkins.snapshot())).projects.find((p) => p.id === projectId).artifacts, ["smoke-sent", "smoke-artifact"]);
  await written.click();
  if (process.env.BOTKINS_QA_DIR) {
    mkdirSync(process.env.BOTKINS_QA_DIR, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => window.botkins.setPreferences({ appearance: { theme } }), theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", theme);
      await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "artifact-preview-" + theme + ".png") });
    }
  }
  await page.getByRole("button", { name: "Go to message" }).click();
  const firstMessage = page.locator(`#message-${chat.id}-0`);
  const sentMessage = page.locator(`#message-${chat.id}-${sentIndex}`);
  await expect(firstMessage).toBeInViewport();
  await expect(sentMessage).not.toBeInViewport();
  await page.getByRole("tab", { name: /^Artifacts/ }).click();
  await sent.click();
  await page.getByRole("button", { name: "Go to message" }).click();
  await expect(sentMessage).toBeInViewport();
  await expect(firstMessage).not.toBeInViewport();
  const unindexedLink = page.getByRole("link", { name: unindexed });
  await unindexedLink.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview in Artifacts" }).click();
  await expect(page.locator(".artifact-text")).toContainText("Unindexed local preview fixture");
  const resolved = await page.evaluate((input) => window.botkins["artifacts.resolve"](input), { chatId: chat.id, paths: [fixture] });
  assert.ok(resolved.items[0], JSON.stringify(resolved));
  const listed = await page.evaluate((id) => window.botkins["artifacts.list"]({ botId: id, kind: "files" }).catch((error) => ({ error: String(error) })), bot.id);
  assert.ok(!("error" in listed), JSON.stringify(listed));
  await app.evaluate(({ shell }) => {
    globalThis.__openedPath = null;
    shell.openPath = async (path) => { globalThis.__openedPath = path; return ""; };
  });
  const link = page.getByRole("link", { name: fixture, exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect.poll(() => app.evaluate(() => globalThis.__openedPath)).toBe(info.path);
  // MEDIA: attachments are drawn in the reply where their lines were, and no raw line is shown.
  const reply = page.locator(`#message-${chat.id}-${mediaIndex}`);
  await reply.scrollIntoViewIfNeeded();
  const pictures = reply.locator(".chat-media-picture img");
  await expect(pictures).toHaveCount(2); // the one written twice is drawn once
  await expect.poll(() => pictures.evaluateAll((all) => all.map((img) => img.complete && img.naturalWidth))).toEqual([900, 200]);
  // As wide as the reply up to 420, and at most 480 high.
  const sizes = await pictures.evaluateAll((all) => all.map((img) => { const box = img.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; }));
  assert.ok(sizes[0][0] <= 420 && sizes[0][0] > 200 && Math.abs(sizes[0][0] / sizes[0][1] - 3) < 0.1, "a wide picture: " + sizes[0]);
  assert.ok(sizes[1][1] <= 480 && sizes[1][1] > 300 && Math.abs(sizes[1][1] / sizes[1][0] - 6) < 0.2, "a tall picture: " + sizes[1]);
  // Another kind of file is a chip in its place, with the words beside it kept.
  await expect(reply.locator(".chat-media-chip")).toHaveText(/artifact-preview\.txt/);
  const replyText = await reply.innerText();
  assert.match(replyText, /The notes:/);
  assert.match(replyText, /The first again:/);
  for (const path of [pictureOne, pictureTwo, fixture]) assert.ok(!replyText.includes("MEDIA:" + path), "no raw line for " + path);
  // What the computer does not know stays as the text it is: a file of another place (a link, as before), and no file at all.
  assert.ok(replyText.includes("MEDIA:" + stranger) && replyText.includes("MEDIA:" + join(dir, "never-written.png")), replyText);
  await expect(reply.getByRole("link", { name: "MEDIA:" + stranger })).toBeVisible();
  // The heading stays above its picture.
  const order = await reply.evaluate((node) => { const at = (el) => el.getBoundingClientRect().top; const strong = [...node.querySelectorAll("strong")]; const imgs = [...node.querySelectorAll(".chat-media-picture")]; return at(strong[0]) < at(imgs[0]) && at(imgs[0]) < at(strong[1]) && at(strong[1]) < at(imgs[1]); });
  assert.ok(order, "each picture is under its own heading");
  if (process.env.BOTKINS_QA_DIR) await page.screenshot({ path: join(process.env.BOTKINS_QA_DIR, "chat-media.png") });
  // A click opens the picture in Artifacts.
  await pictures.first().click();
  await expect(page.locator("aside.side-pane")).toContainText("01-anatomy.png");
  // An older reply whose only line is a MEDIA: file is the chip alone.
  await expect(sentMessage.locator(".chat-media-chip")).toHaveText(/artifact-preview\.txt/);
  assert.ok(!(await sentMessage.innerText()).includes("MEDIA:"));
  console.log("Artifacts Electron smoke passed: list, preview pane, verified path link, open IPC and MEDIA: attachments drawn in a reply.");
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
