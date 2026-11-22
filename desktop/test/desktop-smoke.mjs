import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";
const dir = mkdtempSync(join(tmpdir(), "botkins-ui-"));
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
let app = await launch();
try {
  let page = await home(app);
  page.on("pageerror", (e) => console.error(e.message));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor({timeout:3000});
  await page.locator(".heroface img.bot-avatar").waitFor();
  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Nova");
  await page.getByLabel("Role", { exact: true }).fill("Editor");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Give concise replies.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create bot", exact: true })
    .click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Nova/ }).click();
  await page
    .locator(".chathead")
    .getByRole("heading", { name: "Nova" })
    .waitFor();
  const nonce = randomUUID().slice(0, 8);
  if (process.env.BOTKINS_LIVE === "1") {
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .fill(
        "Remember the code " +
          nonce +
          ". Reply with only this code. Do not use tools.",
      );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () =>
              (await window.botkins.snapshot()).runs.filter(
                (r) => r.status !== "Working",
              ).length,
          ),
        { timeout: 150000 },
      )
      .toBe(1);
    let data = await page.evaluate(() => window.botkins.snapshot());
    assert.equal(data.runs[0].status, "Completed", data.runs[0].detail);
    assert.ok(data.chats[0].messages.at(-1).text.includes(nonce));
    await app.close();
    app = await launch();
    page = await home(app);
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp("Remember the code " + nonce) })
      .click();
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .fill("What was the code? Reply with only the code. Do not use tools.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () =>
              (await window.botkins.snapshot()).runs.filter(
                (r) => r.status !== "Working",
              ).length,
          ),
        { timeout: 150000 },
      )
      .toBe(2);
    data = await page.evaluate(() => window.botkins.snapshot());
    assert.equal(data.runs[0].status, "Completed", data.runs[0].detail);
    assert.ok(data.chats[0].messages.at(-1).text.includes(nonce));
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await page.getByRole("button", { name: /What was the code/ }).click();
    assert.equal(await page.locator("article.assistant").count(), 2);
    console.log(
      "Live reply, packaged restart, context recall and Work navigation passed.",
    );
  }
  console.log(
    "Desktop navigation, animated avatar, bot creation and new chat passed.",
  );
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
