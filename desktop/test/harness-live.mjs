// The one harness, live: real turns on this computer's own ChatGPT plan and Claude plan, run by the
// Copilot runtime (desktop/harness). It needs Codex and Claude Code signed in here, costs a few
// tokens of each plan, and is not part of `npm test`. Run it after `npm run build`:
//   node test/harness-live.mjs            both plans, then the same Claude model on its own harness
//   HARNESS_PLANS=codex node test/…       one plan
// Set BOTKINS_BINARY to test a packaged app. The data folder is the test's own.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-harness-"));
seedApp(dir);
const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot,codex,claude" };
delete env.ELECTRON_RUN_AS_NODE;
const binary = process.env.BOTKINS_BINARY;
const plans = (process.env.HARNESS_PLANS ?? "codex,claude").split(",");
const app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
const errors = [];
// What the app's own process said, kept for a failure's report.
const said = [];
for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", (chunk) => said.push(...String(chunk).split("\n").filter(Boolean)));
try {
  const page = await skipWelcome(await app.firstWindow());
  page.on("pageerror", (e) => errors.push(e.message));
  const snap = () => page.evaluate(() => window.botkins.snapshot());
  assert.equal((await snap()).settings.harness, "copilot", "one harness is the usual choice");
  // The catalog, once every provider has answered.
  let models = [];
  for (let tries = 0; tries < 40; tries++) {
    models = await page.evaluate(() => window.botkins.models());
    if (plans.every((plan) => models.some((m) => m.provider === plan && m.available))) break;
    await page.waitForTimeout(1500);
  }
  // Every model goes by a name people read: none is an id.
  for (const model of models) assert.ok(/\s/.test(model.name) || !/[-_/]/.test(model.name), "a model is shown by its id: " + model.name + " (" + model.id + ")");
  /** One turn in a new chat on `model`; returns what the workspace recorded about it. */
  async function turn(model, word) {
    const chatId = await page.evaluate(() => window.botkins.createChat("pip"));
    // With a thinking level when the model has any, as a person's choice would carry one.
    const effort = (model.efforts ?? []).includes("low") ? "low" : (model.efforts ?? [])[0];
    await page.evaluate(([id, value]) => window.botkins.setModel("chat", id, value), [chatId, { model: model.id, provider: model.provider, ...(effort && { reasoningEffort: effort }) }]);
    await page.evaluate(([id, text]) => window.botkins.send(id, text), [chatId, "Call your memory_read tool once, then reply with exactly: harness " + word]);
    let run;
    for (let tries = 0; tries < Number(process.env.HARNESS_TRIES ?? 150); tries++) {
      await page.waitForTimeout(1200);
      const state = await snap();
      run = state.runs.find((r) => r.chatId === chatId);
      if (run && run.status !== "Working") {
        const chat = state.chats.find((c) => c.id === chatId);
        return { status: run.status, detail: run.detail, ranOn: chat.sessionProvider, model: run.model, reply: chat.messages.at(-1)?.text?.slice(0, 120), steps: (run.steps ?? []).map((s) => s.name) };
      }
    }
    return { status: "timed out", run: run && { status: run.status, detail: run.detail, model: run.model, steps: (run.steps ?? []).map((s) => s.name) }, app: said.slice(-12).map((line) => line.slice(0, 300)) };
  }
  const results = {};
  for (const plan of plans) {
    const mine = models.filter((m) => m.provider === plan && m.available);
    assert.ok(mine.length, plan + " offers no models here: is its tool signed in?");
    // The smallest model of each plan is enough.
    const model = mine.find((m) => /haiku|mini|luna|nano/i.test(m.id + m.name)) ?? mine.find((m) => m.recommended) ?? mine[0];
    const result = (results[plan] = { asked: model.name + " (" + model.id + ")", ...(await turn(model, plan === "codex" ? "kestrel" : "wren")) });
    assert.equal(result.status, "Completed", plan + ": " + JSON.stringify(result));
    assert.equal(result.ranOn, "copilot", plan + ": the Copilot runtime ran the turn");
    assert.deepEqual({ provider: result.model.provider, harness: result.model.harness, model: result.model.model }, { provider: plan, harness: "copilot", model: model.id }, plan + ": the run is still that plan's model");
    assert.match(result.reply, /harness (kestrel|wren)/i);
    console.log(plan + ": the Copilot runtime ran a turn on " + result.asked + " with tools " + JSON.stringify(result.steps) + " and the reply was " + JSON.stringify(result.reply));
  }
  if (plans.includes("claude")) {
    // The other choice: the provider's own tool runs the same model.
    await page.evaluate(() => window.botkins.setPreferences({ harness: "provider" }));
    const model = models.filter((m) => m.provider === "claude" && m.available).find((m) => /haiku/i.test(m.id + m.name)) ?? models.find((m) => m.provider === "claude");
    const own = await turn(model, "wren");
    assert.equal(own.status, "Completed", JSON.stringify(own));
    assert.equal(own.ranOn, "claude", "with each provider's own harness, Claude Code runs the turn");
    assert.equal(own.model.harness, undefined);
    console.log("claude, provider's own harness: Claude Code ran the turn, and the reply was " + JSON.stringify(own.reply));
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("harness live: ok");
} finally {
  await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
