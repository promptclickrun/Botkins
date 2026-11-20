import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import { LinkHost } from "../desktop/link/index.mjs";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = join(root, ".teams-smoke-" + process.pid);
const userData = join(scratch, "app");
const shots = process.env.TEAMS_SHOTS ?? join("/srv/hermes/workspace/botkins/screenshots");
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
  await page.screenshot({ path: join(shots, "teams-desktop-invite.png") });

  await settings.getByRole("tab", { name: "Roles", exact: true }).click();
  await settings.getByRole("button", { name: "Edit", exact: true }).first().click();
  await expect(settings.getByText("Visible agents", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, "teams-desktop-roles.png") });

  assert.deepEqual(errors, []);
} finally {
  if (app) await app.close();
  rmSync(scratch, { recursive: true, force: true });
}
