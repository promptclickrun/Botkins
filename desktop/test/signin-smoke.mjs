// The real GitHub sign-in hand-off, with no stubbed handlers: a signed-out Botkins asks the
// Copilot runtime to start a sign-in, opens the github.com authorize page (captured here instead
// of opening a browser), waits, and cancels cleanly.
// The computer's own sign-in is hidden by running without the GitHub CLI on PATH and with a new
// data folder, so nothing here touches the real account. Nobody approves the request, so the
// test stops at the browser step.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";
import { setUpHere } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-signin-"));
// Only GitHub Copilot: the other providers' own sign-ins are not part of this hand-off.
const env = { ...process.env, BOTKINS_DATA_DIR: dir, PATH: "/usr/bin:/bin", BOTKINS_PROVIDERS: "copilot" };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
for (const name of ["ELECTRON_RUN_AS_NODE", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) delete env[name];
const app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Record the page Botkins would open, instead of opening the person's browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => void globalThis.__opened.push(url);
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("heading", { name: /^Welcome/ }).waitFor();
  await page.waitForFunction(() => !!window.botkins);
  await setUpHere(page);
  const auth = await page.evaluate(() => window.botkins.auth());
  if (auth.connected) {
    // A token Botkins can't hide (for example one stored by an earlier Botkins sign-in).
    console.log("Sign-in smoke skipped: this computer stays signed in (" + auth.type + ") even without the GitHub CLI.");
  } else {
    await button("Sign in with GitHub").waitFor({ timeout: 30000 });
    // The welcome lists GitHub Copilot with its own Sign in button and nothing connected.
    await expect(page.locator("[data-provider-row=copilot]")).toContainText("GitHub Copilot");
    await expect(button("Get started")).toHaveCount(0);
    await button("Sign in with GitHub").click();
    await page.getByText(/Your browser opened github.com/).waitFor({ timeout: 30000 });
    await expect(page.locator("[data-provider-row=copilot]")).toContainText("Waiting…");
    await expect.poll(() => app.evaluate(() => globalThis.__opened.length), { timeout: 30000 }).toBe(1);
    const opened = await app.evaluate(() => globalThis.__opened);
    const url = new URL(opened[0]);
    assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
    assert.ok(url.searchParams.get("client_id"), "the authorize request names its client");
    // Still waiting a moment later: the runtime is polling GitHub, not failing.
    await page.waitForTimeout(2500);
    await expect(page.getByText(/Your browser opened github.com/)).toBeVisible();
    await button("Cancel").click();
    await page.getByRole("alert").getByText("Sign-in was cancelled.", { exact: false }).waitFor({ timeout: 15000 });
    await button("Sign in with GitHub").waitFor();
    assert.equal((await page.evaluate(() => window.botkins.auth())).connected, false);
    // A second attempt starts a new request.
    await button("Sign in with GitHub").click();
    await expect.poll(() => app.evaluate(() => globalThis.__opened.length), { timeout: 30000 }).toBe(2);
    await button("Cancel").click();
    await page.getByRole("alert").getByText("Sign-in was cancelled.", { exact: false }).waitFor({ timeout: 15000 });
    console.log("Real sign-in hand-off: signed out, opened github.com/login/oauth/authorize, waited, cancelled, and started again.");
  }
  assert.deepEqual(errors, []);
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
