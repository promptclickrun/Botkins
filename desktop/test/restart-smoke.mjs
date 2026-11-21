// Exercise the real Electron boot path and abrupt process loss with an isolated Codex CLI.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-restart-"));
const cli = join(dir, "codex");
const file = join(dir, "data", "workspace.json");
seedApp(dir);
const state = JSON.parse(readFileSync(file));
state.settings = { onboarded: true, harness: "provider", model: { provider: "codex", model: "test" } };
writeFileSync(file, JSON.stringify(state));
writeFileSync(cli, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const send = (m) => console.log(JSON.stringify(m));
if (process.argv.includes("--version")) { console.log("codex-cli 1.0.0"); process.exit(0); }
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id == null) return;
  let result = {};
  if (method === "initialize") result = { userAgent: "codex-cli/1.0" };
  if (method === "account/read") result = { account: { type: "chatgpt", planType: "plus" } };
  if (method === "model/list") result = { data: [{ id: "test", model: "test", displayName: "Test", isDefault: true, supportedReasoningEfforts: [] }] };
  if (method === "thread/start" || method === "thread/resume") result = { thread: { id: "chat-thread" } };
  if (method === "thread/read") result = { thread: { turns: [{ id: "original-turn", status: "interrupted", items: [] }] } };
  if (method === "turn/interrupt") throw Error("Steering must not interrupt");
  if (method === "turn/steer") {
    if (params.expectedTurnId !== "original-turn") throw Error("Wrong turn");
    appendFileSync(process.env.BOTKINS_TEST_SENT, JSON.stringify(params.input[0].text) + "\\n");
  }
  if (method === "turn/start") {
    const prompt = params.input[0].text;
    appendFileSync(process.env.BOTKINS_TEST_SENT, JSON.stringify(prompt) + "\\n");
    const resumed = prompt.startsWith("Continue the unfinished reply");
    const turnId = resumed ? "continued-turn" : "original-turn";
    send({ id, result: { turn: { id: turnId } } });
    if (resumed) {
      send({ method: "item/completed", params: { threadId: params.threadId, item: { type: "agentMessage", id: "reply", text: "Finished after restart" } } });
      send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
    }
    return;
  }
  send({ id, result });
});
`, { mode: 0o700 });
const sent = join(dir, "sent");
const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "codex", BOTKINS_CODEX_BINARY: cli, BOTKINS_TEST_SENT: sent };
delete env.ELECTRON_RUN_AS_NODE;
const binary = process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY;
const launch = () => _electron.launch({ executablePath: binary, args: binary ? [] : ["."], env });
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  await page.waitForFunction(() => !!window.botkins);
  const chatId = await page.evaluate(() => window.botkins.createChat("pip"));
  await page.evaluate((id) => window.botkins.send(id, "Finish the restart check"), chatId);
  const disk = () => JSON.parse(readFileSync(file)).runs[0];
  await expect.poll(() => disk()?.eventId).toBe("original-turn");
  const runId = disk().id;
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("button", { name: /Finish the restart check/ }).click();
  const entry = page.getByRole("combobox", { name: "Message", exact: true });
  await entry.fill("Use the small example");
  await entry.press("Enter");
  await expect(page.locator("article.user").last()).toContainText("Use the small example");
  await entry.fill("Use green");
  await page.getByRole("button", { name: "Queue message" }).click();
  await page.getByRole("button", { name: "Steer now" }).click();
  await expect(page.locator("article.user").last()).toContainText("Use green");
  assert.equal(disk().status, "Working");
  assert.equal(disk().id, runId);
  const died = once(app.process(), "exit");
  app.process().kill("SIGKILL");
  await died;
  app = await launch();
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.botkins);
  await expect.poll(() => disk()?.status).toBe("Completed");
  const snapshot = await page.evaluate(() => window.botkins.snapshot());
  assert.deepEqual(snapshot.runs.map((r) => r.id), [runId]);
  assert.deepEqual(snapshot.chats.find((c) => c.id === chatId).messages.map((m) => m.text),
    ["Finish the restart check", "Use the small example", "Use green", "Finished after restart"]);
  const requests = readFileSync(sent, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(requests.slice(0, 3), ["Finish the restart check", "Use the small example", "Use green"]);
  assert.equal(requests.length, 4);
  assert.match(requests[3], /Use the small example[\s\S]*Use green/);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("button", { name: /Finish the restart check/ }).click();
  await expect(page.locator("article.assistant")).toHaveText(/Finished after restart/);
  console.log("Killed Electron during a turn. The relaunched app completed the same run and chat.");
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
