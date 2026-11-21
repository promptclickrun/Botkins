import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { qrPath } from "../desktop/link/qr.mjs";
import { _electron, expect } from "@playwright/test";
import { LinkHost } from "../desktop/link/index.mjs";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = join(root, ".teams-smoke-" + process.pid);
const userData = join(scratch, "app");
// Pictures go where TEAMS_SHOTS says, else into this run's own scratch folder, which is removed at the end.
const shots = process.env.TEAMS_SHOTS ?? join(scratch, "shots");
mkdirSync(shots, { recursive: true });
mkdirSync(userData, { recursive: true });
seedApp(userData);

const seed = new LinkHost({
  dir: join(userData, "data", "link"),
  relay: false,
  backend: {
    info: () => ({ app: "botkins", version: "test", platform: process.platform }),
    snapshot: () => ({ bots: [], chats: [], runs: [] }),
    call: async () => null,
    subscribe: () => () => {},
  },
});
seed.renameTeam("Northstar");
await seed.createInvite({ groupId: "g_everyone", days: 7, maxUses: 5 });
const invite = seed.store.data.team.invites[0];
seed.store.data.team.requests.push({
  id: "q_smoke_avery",
  status: "pending",
  publicKey: "A".repeat(43),
  code: invite.code,
  name: "Avery Chen",
  platform: "darwin",
  kind: "desktop",
  presenceKey: null,
  groupId: "g_everyone",
  inviteId: invite.id,
  at: Date.now() - 3 * 60_000,
});
// Someone already on the team, to invite into a chat. Their role may use every bot: an invite never widens a role.
await seed.saveRole({ ...structuredClone(seed.team().roles.find((role) => role.id === "r_guest")), bots: "all" });
// (The member is written into the seed's store, which is this run's own.)
seed.store.data.team.members.push({ id: "m_blake", name: "Blake Ortiz", groupId: "g_everyone", joinedAt: Date.now() - 86_400_000, deviceIds: [] });
seed.store.save();
await seed.stop();

const env = {
  ...process.env,
  BOTKINS_DATA_DIR: userData,
  COMMANDER_DATA_DIR: userData,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."],
    executablePath: process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY,
    env,
  });
  const page = await skipWelcome(await app.firstWindow());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [1190, 830]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Team", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Team", level: 2 })).toBeVisible();
  await expect(settings.getByText("Avery Chen", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, "teams-desktop-requests.png") });

  await settings.getByRole("tab", { name: "Invite", exact: true }).click();
  await expect(settings.locator(".team-invite-code")).toContainText("-");
  // The invite's link as a QR code beside its code, for the phone app's "Join a team" to scan.
  const qr = settings.getByRole("img", { name: "Invite QR code" });
  await expect(qr).toBeVisible();
  const link = await settings.locator(".team-invite-link code").textContent();
  assert.match(link, /\/join#/);
  assert.equal(await qr.locator("svg path").getAttribute("d"), qrPath(link).d, "the code holds the invite's link");
  const square = await qr.boundingBox();
  assert.ok(square.width >= 160 && Math.abs(square.width - square.height) < 1, "large enough to scan from a screen");
  await expect(settings.locator(".team-invite-qr")).toContainText("Scan to join");
  await page.screenshot({ path: join(shots, "teams-desktop-invite.png") });

  await settings.getByRole("tab", { name: "Roles", exact: true }).click();
  await settings.getByRole("button", { name: "Edit", exact: true }).first().click();
  await expect(settings.getByText("Visible agents", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, "teams-desktop-roles.png") });

  // "Invite" in a chat's header opens "People in this chat": a switch for each person on the team.
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await expect(settings).toBeHidden();
  const chatId = await page.evaluate(() => window.botkins.createChat("pip"));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", id), chatId);
  await expect(page.locator(".chathead h2")).toHaveText("Pip");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const people = page.getByRole("dialog", { name: "People in this chat" });
  const rows = people.getByRole("list", { name: "People" }).getByRole("listitem");
  await expect(rows).toHaveText([/^You\s*Started this chat/, /Blake Ortiz\s*Not in this chat/]);
  await expect(rows.nth(0).getByRole("switch")).toBeChecked();
  await expect(rows.nth(0).getByRole("switch")).toBeDisabled();
  const blake = people.getByRole("switch", { name: "Blake Ortiz" });
  await expect(blake).toBeEnabled();
  await expect(blake).not.toBeChecked();
  await blake.check();
  await expect(rows.nth(1)).toContainText("Invited");
  assert.deepEqual(await page.evaluate((id) => window.botkins.chatPeople(id), chatId), { createdBy: "owner", invited: ["m_blake"] });
  await expect(people.getByRole("button", { name: "Leave chat" })).toHaveCount(0);
  await page.screenshot({ path: join(shots, "teams-desktop-chat-people.png") });
  await blake.uncheck();
  await expect(rows.nth(1)).toContainText("Not in this chat");
  assert.deepEqual((await page.evaluate((id) => window.botkins.chatPeople(id), chatId)).invited, []);
  // What the link refuses is said in the sheet.
  assert.match(await page.evaluate((id) => window.botkins.inviteToChat(id, "m_nobody").then(() => "invited", (e) => e.message), chatId), /That person is no longer on the team\./);
  await blake.check();
  await people.getByRole("button", { name: "Done", exact: true }).click();
  await expect(people).toBeHidden();
  // Deleting the chat from the window works with people in it (the link is told to forget them).
  await page.evaluate((id) => window.botkins.deleteChat(id), chatId);
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).chats.some((chat) => chat.id === chatId), false);

  assert.deepEqual(errors, []);
} finally {
  if (app) await app.close();
  rmSync(scratch, { recursive: true, force: true });
}
