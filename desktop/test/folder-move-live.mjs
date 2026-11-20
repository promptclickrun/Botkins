// Live: a chat goes on after its data folder is renamed, the way a "Commander" folder becomes
// "Botkins" (desktop/home.mjs adoptFolder). One real GitHub Copilot turn before the rename and one
// after, in a folder of the test's own. Needs Copilot signed in here; not part of `npm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-move-"));
const before = join(root, "Commander");
const after = join(root, "Botkins");
mkdirSync(before);
seedApp(before);
const binary = process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY;
const launch = (dir) => {
  const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot", COMMANDER_PROVIDERS: "copilot" };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
};
async function turn(page, chatId, text) {
  await page.evaluate(([id, text]) => window.botkins.send(id, text), [chatId, text]);
  for (let tries = 0; tries < 120; tries++) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => window.botkins.snapshot());
    const chat = state.chats.find((c) => c.id === chatId);
    const runs = state.runs.filter((r) => r.chatId === chatId);
    if (runs.length && runs.every((r) => r.status !== "Working") && chat.messages.at(-1)?.role === "assistant") return { status: runs[0].status, detail: runs[0].detail, reply: chat.messages.at(-1).text, folderSeen: chat.messages.at(-1).text };
  }
  throw new Error("The turn didn't finish.");
}
let app;
try {
  app = await launch(before);
  let page = await skipWelcome(await app.firstWindow());
  const chatId = await page.evaluate(() => window.botkins.createChat("pip"));
  const first = await turn(page, chatId, "Remember the code kestrel-42. Reply with only: noted. Do not use tools.");
  assert.equal(first.status, "Completed", JSON.stringify(first));
  await app.close();
  // The rename, and the link left at the old name.
  renameSync(before, after);
  symlinkSync(after, before, "dir");
  app = await launch(after);
  page = await skipWelcome(await app.firstWindow());
  const second = await turn(page, chatId, "Run `pwd` with your shell tool, then reply with exactly two lines: the code I asked you to remember, and the folder you are in.");
  assert.equal(second.status, "Completed", JSON.stringify(second));
  assert.match(second.reply, /kestrel-42/, "the conversation went on: " + second.reply);
  assert.match(second.reply, /Botkins\/data\/files\/pip/, "the bot works under the new name: " + second.reply);
  assert.doesNotMatch(second.reply, /Commander/, "and never sees the old one: " + second.reply);
  console.log("After the folder was renamed, the same chat went on and the bot answered: " + JSON.stringify(second.reply));
  console.log("folder move live: ok");
} finally {
  await app?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
