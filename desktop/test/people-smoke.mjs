// People in a chat, in the real window: another person's messages on the left with their name tag
// and round badge (a picture, or an initial), "@Name" drawn as tags for people and bots (never in
// code), and Settings › Profile › Your picture, set through its own file picker. Synthetic data
// only: no provider call is made. Pictures go where PEOPLE_SHOTS says, light and dark.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { _electron, expect } from "@playwright/test";
import { LinkHost } from "../desktop/link/index.mjs";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

/** A PNG of `width` by `height` whose color at each pixel `paint` gives as [r, g, b]. */
function pngOf(width, height, paint) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) rows.set(paint(x, y), at + 1 + x * 3);
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])) >>> 0, 0);
    return Buffer.concat([head, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
/** A made-up face: a warm disc on a cool ground, with two eyes. */
const face = (size, ground, skin) => (x, y) => {
  const c = size / 2;
  const d = Math.hypot(x - c, y - c * 1.05);
  const eye = Math.hypot(x - c * 0.72, y - c * 0.85) < size * 0.05 || Math.hypot(x - c * 1.28, y - c * 0.85) < size * 0.05;
  if (d < size * 0.36) return eye ? [40, 30, 30] : skin;
  return ground.map((v, i) => Math.max(0, Math.min(255, v - Math.round((y / size) * 40) + i * 2)));
};

const dir = mkdtempSync(join(tmpdir(), "botkins-people-ui-"));
const shots = process.env.PEOPLE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
seedApp(dir);

// The team: the owner (named after the computer here) and two members. Sam set a picture; Kim did not.
const chatId = randomUUID();
const seed = new LinkHost({
  dir: join(dir, "data", "link"),
  relay: false,
  backend: { info: () => ({ app: "botkins", version: "test", platform: process.platform }), snapshot: () => ({ bots: [], chats: [], runs: [] }), call: async () => null, subscribe: () => () => {} },
});
seed.store.data.name = "Robin";
seed.store.data.team.members.push(
  { id: "m_sam", name: "Sam Rivera", groupId: "g_everyone", joinedAt: Date.now() - 86_400_000, deviceIds: [] },
  { id: "m_kim", name: "Kim Ito", groupId: "g_everyone", joinedAt: Date.now() - 86_400_000, deviceIds: [] },
);
seed.store.data.team.chats = { [chatId]: ["m_sam", "m_kim"] };
seed.setAvatar("m_sam", "data:image/png;base64," + pngOf(256, 256, face(256, [70, 120, 190], [236, 188, 150])).toString("base64"));
seed.store.save();
await seed.stop();

const workspaceFile = join(dir, "data", "workspace.json");
const workspace = JSON.parse(readFileSync(workspaceFile, "utf8"));
const now = Date.now() - 60_000;
workspace.settings = { ...workspace.settings, onboarded: true };
workspace.chats.unshift({
  id: chatId,
  botId: "pip",
  botIds: ["pip", "scout"],
  title: "Launch week",
  time: now,
  established: true,
  messages: [
    { role: "user", text: "Morning! @Sam Rivera can you check the launch list? @Scout, please draft the notes.", time: now },
    { role: "user", text: "On it. I'll pair with @kim ito on the copy.", author: { memberId: "m_sam", name: "Sam Rivera" }, time: now + 1000 },
    { role: "user", text: "Also pushed yesterday's fixes.", author: { memberId: "m_sam", name: "Sam Rivera" }, time: now + 2000 },
    { role: "user", text: "Sounds good. @Robin, drafts by noon. Ping @Pip if the build breaks.", author: { memberId: "m_kim", name: "Kim Ito" }, time: now + 3000 },
    { role: "assistant", botId: "scout", text: "Draft notes are ready for @Sam Rivera and @Kim Ito. The flag stays `@Robin` in code, and an email like robin@example.com stays text.", time: now + 4000 },
  ],
});
writeFileSync(workspaceFile, JSON.stringify(workspace));

// The owner's own picture, chosen in Settings: wider than tall, so the middle square is kept.
const upload = join(dir, "me.png");
writeFileSync(upload, pngOf(400, 300, face(300, [60, 150, 110], [200, 150, 120])));

let app;
try {
  app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
  const page = await home(app);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 860));
  await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));

  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  const sam = page.locator("article.from-person", { hasText: "On it." });
  await expect(sam).toBeVisible();
  // Another person's message: on the left, with their name and their picture.
  await expect(sam.locator(".person-speaker")).toHaveText("Sam Rivera");
  await expect(sam.locator(".person-side-badge img")).toHaveCount(1);
  // The second of Sam's run shows neither again.
  const again = page.locator("article.from-person", { hasText: "yesterday's fixes" });
  await expect(again.locator(".person-speaker")).toHaveCount(0);
  await expect(again.locator(".person-side-badge")).toHaveCount(0);
  // Kim has no picture: the badge is her initial.
  const kim = page.locator("article.from-person", { hasText: "drafts by noon" });
  await expect(kim.locator(".person-side-badge")).toHaveAttribute("data-initial", "K");
  await expect(kim.locator(".person-side-badge img")).toHaveCount(0);
  // The owner's own message is on the right, with no name tag.
  const mine = page.locator("article.user", { hasText: "Morning!" });
  await expect(mine).not.toHaveClass(/from-person/);
  const box = await mine.boundingBox();
  const theirs = await sam.boundingBox();
  assert.ok(box && theirs && box.x > theirs.x + 100, "the viewer's message is on the right, another person's on the left");
  // Tags: people and bots, in any case; not in code, not an email.
  await expect(mine.locator(".mention-tag")).toHaveText(["@Sam Rivera", "@Scout"]);
  await expect(sam.locator(".mention-tag")).toHaveText(["@kim ito"]);
  const reply = page.locator("article.assistant", { hasText: "Draft notes" });
  await expect(reply.locator(".mention-tag")).toHaveText(["@Sam Rivera", "@Kim Ito"]);
  await expect(reply.locator("code")).toHaveText("@Robin");
  await expect(reply.locator("code .mention-tag")).toHaveCount(0);
  if (shots) {
    await page.screenshot({ path: join(shots, "group-chat-light.png") });
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "dark" } }));
    await expect(page.locator("html[data-mode=dark]")).toHaveCount(1);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, "group-chat-dark.png") });
    await reply.screenshot({ path: join(shots, "mention-tags-dark.png") });
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
    await page.waitForTimeout(300);
    await reply.screenshot({ path: join(shots, "mention-tags-light.png") });
  }

  // Settings › Profile › Your picture.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Profile", exact: true }).click();
  const picture = settings.locator(".your-picture");
  await expect(picture).toContainText("No picture yet");
  await picture.locator('input[type="file"]').setInputFiles(upload);
  await expect(picture).toContainText("Your picture is set.");
  await expect(picture.locator(".your-picture-preview img")).toHaveCount(1);
  const kept = await page.evaluate(async () => (await window.botkins.team()).people.find((person) => person.id === "owner")?.avatar ?? "");
  assert.match(kept, /^data:image\/jpeg;base64,/, "the picture is kept as a JPEG");
  assert.ok(kept.length - kept.indexOf(",") - 1 <= 96 * 1024);
  // A file that is not a picture says so in a sentence.
  const notPicture = join(dir, "notes.png");
  writeFileSync(notPicture, "not a picture");
  await picture.locator('input[type="file"]').setInputFiles(notPicture);
  await expect(picture.getByRole("alert")).toContainText("can't be read");
  if (shots) {
    await picture.locator('input[type="file"]').setInputFiles(upload);
    await expect(picture.getByRole("alert")).toHaveCount(0);
    await settings.screenshot({ path: join(shots, "your-picture-light.png") });
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "dark" } }));
    await page.waitForTimeout(300);
    await settings.screenshot({ path: join(shots, "your-picture-dark.png") });
  }
  // Remove takes it away again (confirm dialog guards destructive removal).
  page.once("dialog", (dialog) => dialog.accept());
  await picture.getByRole("button", { name: "Remove" }).click();
  await expect(picture).toContainText("No picture yet");
  assert.deepEqual(errors, []);
  console.log("people smoke ok");
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}
