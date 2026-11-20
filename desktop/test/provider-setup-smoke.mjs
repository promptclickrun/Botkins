// Exercise Settings with isolated IPC fixtures. No software or credentials are installed on the test machine.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-provider-setup-"));
seedApp(dir);
const file = join(dir, "data", "workspace.json");
const state = JSON.parse(readFileSync(file));
state.settings = { ...state.settings, onboarded: true };
writeFileSync(file, JSON.stringify(state));
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir, BOTKINS_PROVIDERS: "codex" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  await app.evaluate(({ ipcMain }) => {
    const provider = { id: "codex", name: "ChatGPT", enabled: true, installed: false, connected: false, signIn: "browser", install: { command: "example install", url: "https://example.org" } };
    let tries = 0;
    let cancelRead;
    const handlers = {
      providers: () => [provider],
      installProvider: () => ({ session: String(++tries) }),
      providerSignInRead: (_e, id, after) => {
        if (!after) return { events: [{ n: 1, type: "output", text: "Preparing the tool" }], next: 1, done: false };
        if (after !== 1) throw Error("Wrong output cursor");
        if (id === "1") return new Promise(resolve => { cancelRead = resolve; });
        if (id === "2") return { next: 1, events: [], done: true, error: "The install didn't finish. Tool unavailable." };
        Object.assign(provider, { installed: true, version: "1.2.3", signInWays: { guided: true, token: true } });
        return { next: 1, events: [], done: true, result: { installed: true, version: "1.2.3" } };
      },
      providerSignInCancel: (_e, id) => {
        if (id === "1") cancelRead?.({ events: [], next: 1, done: true, error: "Install cancelled." });
      },
      providerUseToken: (_e, id, value) => {
        if (id !== "codex" || value !== "test-value") throw Error("Unexpected input");
        if (provider.connected) throw Error("Token already sent");
        provider.connected = true;
        return { connected: true };
      },
    };
    for (const [name, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(name);
      ipcMain.handle(name, handler);
    }
  });
  await page.reload();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Model providers", exact: true }).click();
  const card = page.locator("[data-provider-card=codex]");
  await expect(card.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  const install = card.getByRole("button", { name: "Install on your computer", exact: true });
  await expect(install).toBeVisible();
  await install.click();
  await expect(card.getByText("Preparing the tool")).toBeVisible();
  await card.getByRole("button", { name: "Cancel install" }).click();
  await expect(card.getByText("Install cancelled.")).toBeVisible();
  await install.click();
  await expect(card.getByText("The install didn't finish. Tool unavailable.")).toBeVisible();
  await install.click();
  await expect(card.getByText("Preparing the tool")).toBeVisible();
  await expect(card.getByText("ChatGPT is installed (1.2.3).")).toBeVisible();
  await expect(card.getByRole("button", { name: "Sign in to ChatGPT" })).toBeVisible();
  await card.getByRole("button", { name: "Use a token instead" }).click();
  const input = card.getByLabel("Token", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("rejected-test-value");
  await card.getByRole("button", { name: "Sign in with token" }).click();
  await expect(card.getByRole("alert")).toHaveText("Sign-in didn't finish. Check the token and try again.");
  await expect(input).toHaveValue("");
  await input.fill("test-value");
  await card.getByRole("button", { name: "Sign in with token" }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  assert.ok(!(await card.innerText()).includes("test-value"));
  console.log("Provider Settings passed cancellation, install failure, retry, output, sign-in handoff and masked token submission.");
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}
