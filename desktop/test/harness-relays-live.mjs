// GitHub Copilot's and OpenCode's models on the other harnesses, live: real turns on this
// computer's Copilot sign-in and OpenCode services, run by Pi, OMP and the Copilot runtime through
// the gateway (desktop/harness). Each turn calls one of Botkins' own tools and answers with what it
// returned. It needs Copilot signed in here and OpenCode with a connected service, costs a few
// requests of each, and is not part of `npm test`. Every folder is the script's own; the Botkins
// app's own data is not touched. Run it with:
//   node test/harness-relays-live.mjs
//   LIVE_CASES=pi:copilot:gpt-5.6-luna,omp:opencode:google/gemini-3.5-flash-lite node test/…
//   LIVE_SWITCH=pi:copilot:gpt-5.6-luna>opencode:google/gemini-3.8-flash node test/…
//                                   one chat whose model changes between its turns (">" between models)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../desktop/harness/index.mjs";
import { Providers } from "../desktop/providers/index.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { OpenCodeProvider } from "../desktop/providers/opencode/index.mjs";
import { PiProvider } from "../desktop/providers/pi/index.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-relays-live-"));
const bridge = new ToolBridge();
const copilot = new CopilotProvider({ baseDirectory: join(dir, "copilot"), workingDirectory: dir });
const opencode = new OpenCodeProvider({ dataDir: join(dir, "opencode"), bridge });
const pi = new PiProvider({ dataDir: join(dir, "pi"), bridge });
const omp = new OmpProvider({ dataDir: join(dir, "omp"), bridge, packages: pi.packages });
const providers = new Providers([copilot, opencode, pi, omp]);
providers.configure({ enabled: () => true });
let choice = "pi";
const harness = new Harness({ providers, choice: () => choice, dir, bridge });
const CASES = (process.env.LIVE_CASES ?? (process.env.LIVE_SWITCH ? "" : null) ?? "pi:copilot:gpt-5.6-luna,omp:copilot:claude-haiku-5.5,pi:copilot:gemini-4-neon,pi:opencode:google/gemini-3.5-flash-lite,omp:opencode:google/gemini-3.5-flash-lite,copilot:opencode:google/gemini-3.5-flash-lite")
  .split(",")
  .filter(Boolean)
  .map((each) => {
    const [harnessId, provider, ...model] = each.split(":");
    return { harnessId, provider, model: model.join(":") };
  });
const results = [];
const SWITCH = process.env.LIVE_SWITCH;
try {
  // A server that has just started can take longer than the catalog waits: each list is read once first.
  if (SWITCH?.includes("opencode:") || CASES.some((each) => each.provider === "opencode")) await opencode.models();
  if (SWITCH?.includes("copilot:") || CASES.some((each) => each.provider === "copilot")) await copilot.models();
  const catalog = await providers.models();
  for (const { harnessId, provider, model } of CASES) {
    choice = harnessId;
    const word = "marmalade-" + Math.floor(1000 + Math.random() * 9000);
    const label = harnessId + " × " + provider + " " + model;
    const started = Date.now();
    try {
      const entry = catalog.find((m) => m.provider === provider && m.id === model);
      assert.ok(entry, model + " is in " + provider + "'s catalog");
      const selection = { provider, model, ...((entry.efforts ?? []).includes("low") && { reasoningEffort: "low" }) };
      const via = harness.via(selection);
      assert.equal(via, harnessId, label + " is routed to " + harnessId);
      const runner = harness.runner(selection, via);
      const hosted = await harness.session(selection, via);
      const calls = [];
      const session = await runner.openSession({
        sessionId: "live-" + Math.random().toString(36).slice(2),
        established: false,
        hasReplies: false,
        folder: dir,
        model: hosted.model,
        inference: hosted.inference,
        instructions: "You are a test bot. Follow the person's instructions exactly.",
        context: "",
        tools: [{ name: "secret_word", description: "Returns today's secret word.", parameters: { type: "object", properties: {} }, handler: async () => (calls.push(1), JSON.stringify({ word })) }],
        skills: { directories: [], disabled: [] },
        mcpServers: {},
        history: () => [],
        approval: "all",
        handlers: { permission: async () => ({ allow: true }), question: async () => ({ answer: "" }) },
      });
      let streamed = 0;
      session.on((event) => {
        if (event.type === "assistant.message_delta") streamed++;
      });
      const reply = await session.send({ prompt: "Call the secret_word tool once, then reply with exactly the word it returns and nothing else." });
      await session.close();
      const ok = reply.text.includes(word) && calls.length >= 1;
      results.push({ label, ok, tool: calls.length, deltas: streamed, ms: Date.now() - started, source: hosted.model.source, reply: reply.text.slice(0, 80) });
    } catch (error) {
      results.push({ label, ok: false, error: String(error?.message ?? error).slice(0, 300), ms: Date.now() - started });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  if (SWITCH) {
    const harnessId = SWITCH.split(":")[0];
    const steps = SWITCH.slice(SWITCH.indexOf(":") + 1).split(">");
    choice = harnessId;
    const catalog = await providers.models();
    const selections = steps.map((step) => {
      const [provider, ...model] = step.split(":");
      return { provider, model: model.join(":") };
    });
    const label = harnessId + " switching " + steps.join(" → ");
    const started = Date.now();
    try {
      for (const selection of selections) assert.ok(catalog.some((m) => m.provider === selection.provider && m.id === selection.model), selection.model + " is in the catalog");
      const first = await harness.session(selections[0], harness.via(selections[0]));
      const words = [];
      const session = await harness.runner(selections[0]).openSession({
        sessionId: "live-switch", established: false, hasReplies: false, folder: dir, model: first.model, inference: first.inference,
        instructions: "You are a test bot. Follow the person's instructions exactly.", context: "",
        tools: [{ name: "secret_word", description: "Returns today's secret word.", parameters: { type: "object", properties: {} }, handler: async () => (words.push("marmalade-" + (1000 + words.length)), JSON.stringify({ word: words.at(-1) })) }],
        skills: { directories: [], disabled: [] }, mcpServers: {}, history: () => [], approval: "all",
        handlers: { permission: async () => ({ allow: true }), question: async () => ({ answer: "" }) },
      });
      const replies = [];
      for (const [index, selection] of selections.entries()) {
        assert.equal(harness.runner(selection), harness.runner(selections[0]), "the same harness runs every model of the chat");
        if (index) await session.switchModel((await harness.session(selection, harness.via(selection))).model);
        const reply = await session.send({ prompt: "Call the secret_word tool once, then reply with exactly the word it returns and nothing else." });
        replies.push(reply.text.trim());
        assert.ok(reply.text.includes(words.at(-1) ?? "none"), "turn " + (index + 1) + " on " + selection.model + " answered " + reply.text);
      }
      await session.close();
      results.push({ label, ok: true, replies, ms: Date.now() - started });
    } catch (error) {
      results.push({ label, ok: false, error: String(error?.message ?? error).slice(0, 300), ms: Date.now() - started });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  await Promise.allSettled([harness.stop(), pi.stop(), omp.stop(), opencode.stop(), copilot.stop(), bridge.stop()]);
  rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length ? failed.length + " of " + results.length + " failed" : "all " + results.length + " passed");
process.exit(failed.length ? 1 : 0);
