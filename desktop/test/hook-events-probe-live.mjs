// What the real Copilot SDK runtime does with each plugin hook event: the order, how many times,
// the input's keys, and what a block or an abort does. The answers are what Pi and OMP copy
// (desktop/providers/pi/index.mjs). No account, no network: the model is this script, on 127.0.0.1.
//   node test/hook-events-probe-live.mjs     (prints one JSON object per case)
//   PROBE_ONLY=tools,abort limits the cases; PROBE_MESSAGES=1 also prints what the model was sent.
//   node test/hook-events-probe-live.mjs --gate   (or BOTKINS_RELEASE_GATE=1): runs every case and asserts
//   what Pi and OMP rely on (#315). It doesn't pin retry counts, timing or error wording. Exit 0 only when all hold.
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

const gate = process.argv.includes("--gate") || process.env.BOTKINS_RELEASE_GATE === "1";
let script = [];
let turn = 0;
let failedRequests = 0;
// slow_tool says when it has started, so the abort case stops the turn while the tool runs.
let slowStarted = null;
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
    failedRequests++;
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
  defineTool("slow_tool", { description: "Takes a while.", parameters: { type: "object", properties: {} }, handler: async () => (slowStarted?.(), await new Promise((r) => setTimeout(r, 4000)), "slow"), skipPermission: true }),
];

async function probe(label, steps, { answers = {}, abortOnSlow = false, prompts = ["PROBE"], disconnect = true } = {}) {
  script = steps;
  turn = 0;
  failedRequests = 0;
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
      if (abortOnSlow) {
        const started = new Promise((resolve) => (slowStarted = resolve));
        void started.then(() => session.abort().catch(() => {}));
      }
      const reply = await session.sendAndWait({ prompt }, 60_000);
      outcome.push("reply:" + (reply?.data?.content ?? "").slice(0, 60));
    } catch (error) {
      outcome.push("error:" + String(error?.message ?? error).slice(0, 100));
    }
  }
  slowStarted = null;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const endsBefore = log.filter((entry) => entry.event === "SessionEnd").length;
  if (disconnect) await session.disconnect().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = { label, outcome, modelRequests: turn, failedRequests, endsBefore, prompts: [...seenPrompts], log };
  console.log(JSON.stringify(result));
  return result;
}

// What Pi and OMP copy (desktop/providers/pi/index.mjs), as checks on the cases' results.
const count = (r, event, test = () => true) => r.log.filter((entry) => entry.event === event && test(entry)).length;
const names = (r) => r.log.map((entry) => entry.event);
const failedOutcome = (r) => r.outcome.some((item) => item.startsWith("error:"));
const CHECKS = {
  tools: (r) => [
    ["a tool that succeeded has postToolUse, not postToolUseFailure", count(r, "PostToolUse", (e) => e.toolName === "ok_tool") === 1 && count(r, "PostToolUseFailure", (e) => e.toolName === "ok_tool") === 0],
    ["a tool that failed has postToolUseFailure, not postToolUse", count(r, "PostToolUseFailure", (e) => e.toolName === "bad_tool") === 1 && count(r, "PostToolUse", (e) => e.toolName === "bad_tool") === 0],
    ["the order is sessionStart, userPromptSubmitted, pre/post per call, agentStop", JSON.stringify(names(r).filter((n) => n !== "SessionEnd")) === JSON.stringify(["SessionStart", "UserPromptSubmitted", "PreToolUse", "PostToolUse", "PreToolUse", "PostToolUseFailure", "AgentStop"])],
  ],
  "two-turns": (r) => [
    ["sessionStart once for the session", count(r, "SessionStart") === 1],
    ["userPromptSubmitted and agentStop once for each turn", count(r, "UserPromptSubmitted") === 2 && count(r, "AgentStop") === 2],
  ],
  "stop-block": (r) => {
    const list = names(r);
    const followed = list.every((name, i) => name !== "AgentStop" || i + 1 >= list.length || list[i + 1] === "SessionEnd" || (list[i + 1] === "UserPromptSubmitted" && r.log[i + 1].prompt === "keep going"));
    const reentries = r.log.filter((e) => e.event === "AgentStop").slice(1);
    return [
      ["a block happened at least once", count(r, "AgentStop") > 1],
      ["each block's reason is the next userPromptSubmitted", followed],
      ["a stop after a block says stopHookActive", reentries.length > 0 && reentries.every((e) => e.stopHookActive === true) && r.log.find((e) => e.event === "AgentStop").stopHookActive === false],
    ];
  },
  "model-error": (r) => [
    ["the turn failed", failedOutcome(r)],
    ["one errorOccurred for each failed model request", count(r, "ErrorOccurred") === r.failedRequests && r.failedRequests > 0],
    ["the errors are model_call", r.log.filter((e) => e.event === "ErrorOccurred").every((e) => e.errorContext === "model_call")],
    ["no agentStop after a failed turn", count(r, "AgentStop") === 0],
  ],
  abort: (r) => [
    ["the turn was stopped", failedOutcome(r) && /abort/i.test(r.outcome.join(" "))],
    ["the stopped tool's preToolUse ran", count(r, "PreToolUse", (e) => e.toolName === "slow_tool") === 1],
    ["no result hook and no agentStop after a stop", count(r, "PostToolUse") === 0 && count(r, "PostToolUseFailure") === 0 && count(r, "AgentStop") === 0],
  ],
  "post-modify": () => [],
  "error-baseline": (r) => [["one errorOccurred for each failed model request", count(r, "ErrorOccurred") === r.failedRequests && r.failedRequests > 0]],
};
// errorHandling: compared with the baseline that answers nothing. Copilot ignored it (2.0.1); Pi and OMP ignore it too.
const sameAsBaseline = (r, base) => [
  ["one errorOccurred for each failed model request", count(r, "ErrorOccurred") === r.failedRequests && r.failedRequests > 0],
  ["the outcome is the baseline's", failedOutcome(r) === failedOutcome(base) && JSON.stringify(names(r)) === JSON.stringify(names(base))],
];

const only = !gate && process.env.PROBE_ONLY ? new Set(process.env.PROBE_ONLY.split(",")) : null;
const results = {};
const run = async (label, ...args) => {
  if (only && !only.has(label)) return null;
  return (results[label] = await probe(label, ...args));
};
let failed = false;
try {
  await run("tools", [{ tool: "ok_tool" }, { tool: "bad_tool" }, { say: "Done." }]);
  await run("two-turns", [{ say: "One." }, { say: "Two." }], { prompts: ["first", "second"] });
  await run("stop-block", [{ say: "A." }, { say: "B." }, { say: "C." }, { say: "D." }, { say: "E." }, { say: "F." }, { say: "G." }, { say: "H." }], { answers: { onAgentStop: () => ({ decision: "block", reason: "keep going" }) } });
  await run("model-error", [{ fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 }, { fail: 500 }]);
  await run("abort", [{ tool: "slow_tool" }, { say: "late" }], { abortOnSlow: true });
  await run("post-modify", [{ tool: "ok_tool" }, { tool: "bad_tool" }, { say: "Done." }], { answers: {
    onPostToolUse: () => ({ modifiedResult: { textResultForLlm: "CHANGED RESULT", resultType: "success" }, additionalContext: "post ctx" }),
    onPostToolUseFailure: () => ({ additionalContext: "fail ctx" }),
    onSessionStart: () => ({ additionalContext: "start ctx" }),
    onUserPromptSubmitted: () => ({ additionalContext: "prompt ctx" }),
  } });
  await run("error-baseline", [{ fail: 500 }, { fail: 500 }, { fail: 500 }]);
  await run("error-abort", [{ fail: 500 }, { fail: 500 }, { fail: 500 }], { answers: { onErrorOccurred: () => ({ errorHandling: "abort", userNotification: "plugin says stop" }) } });
  await run("error-skip", [{ fail: 500 }, { fail: 500 }, { fail: 500 }], { answers: { onErrorOccurred: () => ({ errorHandling: "skip" }) } });
  if (gate) {
    for (const [label, r] of Object.entries(results)) {
      const checks = [
        ...(CHECKS[label]?.(r) ?? sameAsBaseline(r, results["error-baseline"])),
        ["no sessionEnd before the session is let go", r.endsBefore === 0],
        ["one sessionEnd after it is let go", count(r, "SessionEnd") === 1],
      ];
      for (const [what, ok] of checks) {
        if (ok) continue;
        failed = true;
        console.log("FAILED " + label + ": " + what + "\n  observed events: " + JSON.stringify(names(r)) + "\n  outcome: " + JSON.stringify(r.outcome) + " failed requests: " + r.failedRequests);
      }
    }
  }
} catch (error) {
  failed = true;
  console.log("FAILED: the Copilot runtime could not run the probe: " + String(error?.message ?? error).slice(0, 300));
} finally {
  await client.stop().catch(() => {});
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
if (gate) console.log(failed ? "FAILED" : "PASSED " + JSON.stringify(Object.keys(results)));
process.exit(failed ? 1 : 0);
