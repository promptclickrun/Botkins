// What the real Copilot SDK runtime does with each plugin hook event: the order, how many times,
// the input's keys, and what a block or an abort does. The answers are what Pi and OMP copy
// (desktop/providers/pi/index.mjs). No account, no network: the model is this script, on 127.0.0.1.
//   node test/hook-events-probe-live.mjs     (prints one JSON object per case)
//   PROBE_ONLY=tools,abort limits the cases; PROBE_MESSAGES=1 also prints what the model was sent.
// Findings on SDK 2.0.1 (2026-11-27), which test/pi-plugin-hooks.test.mjs holds Pi and OMP to:
//   order: sessionStart, userPromptSubmitted, preToolUse, postToolUse | postToolUseFailure, agentStop, sessionEnd (on disconnect);
//   sessionStart once per session, its context as a user message before the first prompt;
//   userPromptSubmitted context as <system_reminder> after the prompt, and it runs on each agentStop "block" reason too;
//   postToolUse modifiedResult replaces the result, additionalContext follows it with a fixed sentence;
//   errorOccurred once per failed model request; its errorHandling changed nothing; no agentStop after a failed turn;
//   abort: preToolUse, then no result hook, no agentStop; sessionEnd still on disconnect.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "botkins-hook-probe-"));
process.env.COPILOT_HOME = join(root, "home");
const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
const { planModel } = await import("../desktop/harness/index.mjs");
const { defineTool } = await import("../desktop/providers/provider.mjs");

let script = [];
let turn = 0;
const seenPrompts = [];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const parsed = JSON.parse(raw);
  const users = (parsed.messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("")));
  seenPrompts.push(users.at(-1)?.replace(/<current_datetime>[^<]*<\/current_datetime>\s*/, "").slice(0, 200));
  if (process.env.PROBE_MESSAGES) {
    const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
    seenPrompts.push("[" + (parsed.messages ?? []).filter((m) => m.role !== "system").map((m) => m.role + ":" + text(m).replace(/<current_datetime>[^<]*<\/current_datetime>\s*/, "").slice(0, 160)).join(" | ") + "]");
    const system = (parsed.messages ?? []).filter((m) => m.role === "system").map(text).join("\n");
    for (const marker of ["start ctx", "post ctx", "fail ctx", "prompt ctx"]) if (system.includes(marker)) seenPrompts.push("system has " + marker);
  }
  const step = script[turn++] ?? { say: "Done." };
  if (step.fail) {
    response.writeHead(step.fail, { "content-type": "application/json" });
    return response.end(JSON.stringify({ error: { message: "probe model failure" } }));
  }
  if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
  const chunk = (delta, finish) => ({ id: "c", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const events = step.tool
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + turn, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }, null), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: step.say }, null), chunk({}, "stop")];
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const inference = {
  providers: [{ name: "fixture", type: "openai", baseUrl: "http://127.0.0.1:" + model.address().port + "/v1", bearerToken: "synthetic" }],
  models: [planModel("fixture", { id: "local", name: "Local", tools: true, contextWindow: 64_000, maxOutput: 4_096 })],
};
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const client = new CopilotClient({ mode: "coding-agent", github: { useLoggedInUser: false }, runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: join(root, "copilot"), workingDirectory: work }) });
await client.start();

const EVENTS = ["onSessionStart", "onUserPromptSubmitted", "onPreToolUse", "onPostToolUse", "onPostToolUseFailure", "onAgentStop", "onSubagentStart", "onSubagentStop", "onSessionEnd", "onErrorOccurred"];
const tools = [
  defineTool("ok_tool", { description: "Succeeds.", parameters: { type: "object", properties: {} }, handler: async () => "ok result", skipPermission: true }),
  defineTool("bad_tool", { description: "Fails.", parameters: { type: "object", properties: {} }, handler: async () => { throw new Error("bad tool broke"); }, skipPermission: true }),
  defineTool("slow_tool", { description: "Takes a while.", parameters: { type: "object", properties: {} }, handler: async () => (await new Promise((r) => setTimeout(r, 4000)), "slow"), skipPermission: true }),
];

async function probe(label, steps, { answers = {}, abortAfterMs, prompts = ["PROBE"], disconnect = true } = {}) {
  script = steps;
  turn = 0;
  seenPrompts.length = 0;
  const log = [];
  const handlers = {};
  for (const name of EVENTS)
    handlers[name] = async (input) => {
      const keys = Object.keys(input ?? {}).filter((k) => !["timestamp", "sessionId", "workingDirectory", "traceparent", "tracestate"].includes(k)).sort();
      const pick = {};
      for (const key of ["source", "toolName", "stopReason", "stopHookActive", "reason", "error", "errorContext", "recoverable", "agentName", "finalMessage", "prompt"]) if (input?.[key] !== undefined) pick[key] = typeof input[key] === "string" ? input[key].slice(0, 80) : input[key];
      log.push({ event: name.slice(2), keys, ...pick });
      const answer = answers[name];
      return typeof answer === "function" ? answer(input, log) : answer;
    };
  const spec = { sessionId: "probe-" + label, folder: work, model: { model: "local", source: "fixture" }, inference, approval: "all", instructions: "Probe.", tools, skills: { directories: [], disabled: [] }, pluginHooks: { handlers } };
  const session = await client.createSession({ ...sessionOptions(spec, { handlers: { permission: async () => ({ allow: true }) } }), github: { capi: { enabled: false } } });
  const outcome = [];
  for (const prompt of prompts) {
    try {
      if (abortAfterMs) setTimeout(() => session.abort().catch(() => {}), abortAfterMs);
      const reply = await session.sendAndWait({ prompt }, 60_000);
      outcome.push("reply:" + (reply?.data?.content ?? "").slice(0, 60));
    } catch (error) {
      outcome.push("error:" + String(error?.message ?? error).slice(0, 100));
    }
  }
  if (disconnect) await session.disconnect().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(JSON.stringify({ label, outcome, modelRequests: turn, prompts: seenPrompts, log }));
}

const only = process.env.PROBE_ONLY ? new Set(process.env.PROBE_ONLY.split(",")) : null;
const run = (label, ...args) => (!only || only.has(label) ? probe(label, ...args) : null);
try {
  await run("tools", [{ tool: "ok_tool" }, { tool: "bad_tool" }, { say: "Done." }]);
  await run("two-turns", [{ say: "One." }, { say: "Two." }], { prompts: ["first", "second"] });
  await run("stop-block", [{ say: "A." }, { say: "B." }, { say: "C." }, { say: "D." }, { say: "E." }, { say: "F." }, { say: "G." }, { say: "H." }], { answers: { onAgentStop: () => ({ decision: "block", reason: "keep going" }) } });
  await run("model-error", [{ fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 }]);
  await run("abort", [{ tool: "slow_tool" }, { say: "late" }], { abortAfterMs: 1500 });
  await run("post-modify", [{ tool: "ok_tool" }, { tool: "bad_tool" }, { say: "Done." }], { answers: {
    onPostToolUse: () => ({ modifiedResult: { textResultForLlm: "CHANGED RESULT", resultType: "success" }, additionalContext: "post ctx" }),
    onPostToolUseFailure: () => ({ additionalContext: "fail ctx" }),
    onSessionStart: () => ({ additionalContext: "start ctx" }),
    onUserPromptSubmitted: () => ({ additionalContext: "prompt ctx" }),
  } });
  await run("error-abort", [{ fail: 500 }, { fail: 500 }, { fail: 500 }], { answers: { onErrorOccurred: () => ({ errorHandling: "abort", userNotification: "plugin says stop" }) } });
  await run("error-skip", [{ fail: 500 }, { fail: 500 }, { fail: 500 }], { answers: { onErrorOccurred: () => ({ errorHandling: "skip" }) } });
} finally {
  await client.stop().catch(() => {});
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
