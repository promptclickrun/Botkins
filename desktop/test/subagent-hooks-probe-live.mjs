// What the real Copilot SDK runtime does with plugin hooks around its own native subagents (the
// runtime's `task` tool): which events fire, for which agent, how often, and with what identity,
// for a child that succeeds, one that fails, two in parallel, and one that is stopped. No account,
// no network: the model is this script, on 127.0.0.1. Prints one JSON object per case.
//   node test/subagent-hooks-probe-live.mjs            PROBE_ONLY=ok,fail limits the cases.
//   node test/subagent-hooks-probe-live.mjs --gate     asserts what desktop/subagents.mjs copies for host children.
// Found on SDK 2.0.1 (2026-11-27), for the runtime's own `task` children:
//   order: preToolUse(task), subagentStart, the child's userPromptSubmitted and agentStop (with its agentId),
//   subagentStop (with its reply), postToolUse(task); parallel children interleave, each pair under one agentId;
//   a child whose model fails: subagentStart, its errorOccurred, then postToolUseFailure(task), no subagentStop;
//   a stopped parent: subagentStart, then nothing more for the child;
//   subagentStart's additionalContext goes before the child's prompt; subagentStop's modifiedResponse is the task result;
//   a "block" from a raw SDK handler keeps the child going (case "block"). Botkins' plugin runtime keeps no block
//   for subagentStop (plugin-runtime.mjs parseHookOutput), so through a plugin it never applies, on any harness.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = process.argv.includes("--gate") || process.env.BOTKINS_RELEASE_GATE === "1";
const root = mkdtempSync(join(tmpdir(), "botkins-subagent-probe-"));
process.env.COPILOT_HOME = join(root, "home");
const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
const { planModel } = await import("../desktop/harness/index.mjs");

// The scripted model. A request whose first user message names a child (CHILD-<name>) is that
// child's; anything else is the parent's. `plan.parent` is the parent's replies in order; a child's
// reply is `plan.child(name)`: { say }, { fail }, or { wait, say }.
let plan = null;
let parentTurn = 0;
const requests = [];
// What each child was first told, and what the parent was given back for each task call.
const childFirst = {};
const toolResults = {};
const userText = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(""));
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const parsed = JSON.parse(raw);
  const users = (parsed.messages ?? []).filter((m) => m.role === "user").map(userText);
  const child = users.map((text) => /CHILD-([a-z0-9]+)/.exec(text)?.[1]).find(Boolean);
  requests.push(child ? "child:" + child : "parent");
  if (child) {
    childFirst[child] ??= users.join(" || ").slice(0, 400);
    plan.childCalls = (plan.childCalls ?? 0) + 1;
  } else for (const m of parsed.messages ?? []) if (m.role === "tool") toolResults[m.tool_call_id] = userText(m).slice(0, 300);
  const chunk = (delta, finish) => ({ id: "c", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const send = (events) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
    response.end("data: [DONE]\n\n");
  };
  const say = (text) => send([chunk({ role: "assistant", content: text }, null), chunk({}, "stop")]);
  if (child) {
    const step = plan.child(child);
    if (step.fail) {
      response.writeHead(400, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "child model refused" } }));
    }
    if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
    return say(step.say);
  }
  const step = plan.parent[parentTurn++] ?? { say: "Done." };
  if (step.tasks) {
    const calls = step.tasks.map((name, index) => ({ index, id: "call_" + name, type: "function", function: { name: "task", arguments: JSON.stringify({ description: "Child " + name, prompt: "CHILD-" + name + ": answer in one word.", agent_type: "explore", name: "kid-" + name }) } }));
    return send([chunk({ role: "assistant", tool_calls: calls }, null), chunk({}, "tool_calls")]);
  }
  say(step.say);
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

async function probe(label, { parent, child, answers = {}, abortWhen }) {
  plan = { parent, child };
  parentTurn = 0;
  requests.length = 0;
  for (const key of Object.keys(childFirst)) delete childFirst[key];
  for (const key of Object.keys(toolResults)) delete toolResults[key];
  const log = [];
  const sdkEvents = [];
  const handlers = {};
  let abort = () => {};
  for (const name of EVENTS)
    handlers[name] = async (input) => {
      const pick = { event: name.slice(2) };
      for (const key of ["agentId", "agentType", "agentName", "agentDisplayName", "parentAgentId", "toolName", "toolCallId", "stopReason", "stopHookActive", "response", "reason", "errorContext"]) if (input?.[key] !== undefined) pick[key] = typeof input[key] === "string" ? input[key].slice(0, 60) : input[key];
      log.push(pick);
      if (abortWhen?.(pick)) setTimeout(() => abort(), 50);
      const answer = answers[name];
      return typeof answer === "function" ? answer(input) : answer;
    };
  const spec = { sessionId: "probe-" + label, folder: work, model: { model: "local", source: "fixture" }, inference, approval: "all", instructions: "Probe.", tools: [], skills: { directories: [], disabled: [] }, pluginHooks: { handlers } };
  const session = await client.createSession({ ...sessionOptions(spec, { handlers: { permission: async () => ({ allow: true }) } }), github: { capi: { enabled: false } } });
  abort = () => session.abort().catch(() => {});
  const off = session.on?.((event) => {
    if (/^subagent\./.test(event?.type ?? "")) sdkEvents.push({ type: event.type, toolCallId: event.data?.toolCallId, agentId: event.agentId ?? event.data?.agentId, agentName: event.data?.agentName });
  });
  let outcome;
  try {
    const reply = await session.sendAndWait({ prompt: "PROBE" }, 90_000);
    outcome = "reply:" + (reply?.data?.content ?? "").slice(0, 80);
  } catch (error) {
    outcome = "error:" + String(error?.message ?? error).slice(0, 100);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  off?.();
  await session.disconnect().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = { label, outcome, requests: [...requests], log, sdkEvents, childFirst: { ...childFirst }, toolResults: { ...toolResults } };
  console.log(JSON.stringify(result));
  return result;
}

const only = !gate && process.env.PROBE_ONLY ? new Set(process.env.PROBE_ONLY.split(",")) : null;
const results = {};
const run = async (label, options) => (!only || only.has(label) ? (results[label] = await probe(label, options)) : null);
let failed = false;
try {
  await run("ok", { parent: [{ tasks: ["a"] }, { say: "Done." }], child: () => ({ say: "kid answer" }) });
  await run("fail", { parent: [{ tasks: ["b"] }, { say: "Done." }], child: () => ({ fail: true }) });
  await run("parallel", { parent: [{ tasks: ["c", "d"] }, { say: "Done." }], child: (name) => ({ wait: name === "c" ? 400 : 50, say: "kid " + name }) });
  await run("stopped", { parent: [{ tasks: ["e"] }, { say: "Done." }], child: () => ({ wait: 3000, say: "too late" }), abortWhen: (entry) => entry.event === "SubagentStart" });
  let blocks = 0;
  await run("block", { parent: [{ tasks: ["g"] }, { say: "Done." }], child: () => ({ say: "kid try" }), answers: { onSubagentStop: () => (blocks++ < 2 ? { decision: "block", reason: "child keep going" } : undefined) } });
  await run("modify", { parent: [{ tasks: ["f"] }, { say: "Done." }], child: () => ({ say: "original kid answer" }), answers: { onSubagentStart: () => ({ additionalContext: "START CTX" }), onSubagentStop: () => ({ modifiedResponse: "REWRITTEN" }) } });
  if (gate) {
    const of = (r, event) => r.log.filter((entry) => entry.event === event);
    const checks = [
      ["ok: one subagentStart and one subagentStop for the child", of(results.ok, "SubagentStart").length === 1 && of(results.ok, "SubagentStop").length === 1],
      // The child's own hooks carry its agentId; the parent's carry none (Botkins' childHooks does the same for host children).
      ["ok: the parent's agentStop runs once with no agentId, the child's once with its agentId", of(results.ok, "AgentStop").filter((e) => !e.agentId).length === 1 && of(results.ok, "AgentStop").filter((e) => e.agentId === of(results.ok, "SubagentStart")[0]?.agentId).length === 1],
      ["ok: start and stop name the same child, and the stop has its reply", of(results.ok, "SubagentStop")[0]?.agentId === of(results.ok, "SubagentStart")[0]?.agentId && of(results.ok, "SubagentStop")[0]?.response === "kid answer"],
      ["ok: the child runs no sessionStart or sessionEnd of its own", results.ok.log.filter((e) => (e.event === "SessionStart" || e.event === "SessionEnd") && e.agentId).length === 0],
      ["modify: subagentStart's context goes before the child's prompt", /START CTX\s+CHILD-f/.test(results.modify.childFirst.f ?? "")],
      ["modify: subagentStop's modifiedResponse is what the parent gets", results.modify.toolResults.call_f === "REWRITTEN"],
      ["fail: one subagentStart, no subagentStop", of(results.fail, "SubagentStart").length === 1 && of(results.fail, "SubagentStop").length === 0],
      ["parallel: one start and one stop for each child, each pair with its own id", of(results.parallel, "SubagentStart").length === 2 && of(results.parallel, "SubagentStop").length === 2 && new Set(of(results.parallel, "SubagentStop").map((e) => e.agentId)).size === 2 && of(results.parallel, "SubagentStop").every((e) => of(results.parallel, "SubagentStart").some((x) => x.agentId === e.agentId))],
      ["stopped: one subagentStart, no subagentStop, no agentStop", of(results.stopped, "SubagentStart").length === 1 && of(results.stopped, "SubagentStop").length === 0 && of(results.stopped, "AgentStop").length === 0],
    ];
    for (const [what, ok] of checks) if (!ok) (failed = true), console.log("FAILED " + what);
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
