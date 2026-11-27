// What the real OMP (OMP_BINARY or `omp` on PATH) tells Botkins about its own native subagents
// (its `task` tool): with `set_subagent_subscription` at "progress", it sends `subagent_lifecycle`
// frames. This prints, for a child that succeeds, one that fails, two in parallel and one that is
// stopped, every lifecycle frame and the task call's own events. No account, no network.
//   node test/omp-subagent-probe-live.mjs          prints the frames and the hooks Botkins ran from them
//   node test/omp-subagent-probe-live.mjs --gate   asserts them (desktop/providers/pi/index.mjs subagentLifecycle):
//     one subagentStart per child and one subagentStop for each that completed, with OMP's child id and
//     reply; none for a child that failed or was cancelled; no duplicates across parallel children.
// Found on OMP 19.1.0 (2026-11-27): `set_subagent_subscription` "progress" sends `subagent_lifecycle`
// {id, agent, status: started|completed|failed|aborted, index, parentToolCallId, detached: true}.
// The children are background jobs: the `task` call returns "Spawned agent …" at once, and a child
// goes on after the parent's turn is stopped (it reports `completed`). `cancel_subagent` gives `aborted`.
// There is no frame or extension event before a child's first turn that can add to its prompt, nor one
// at its end that can change what the parent gets: subagentStart's additionalContext and subagentStop's
// modifiedResponse can't apply to OMP's own children (an upstream limit, not a Botkins one).
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { findBinary } from "../desktop/providers/cli.mjs";
const gate = process.argv.includes("--gate") || process.env.BOTKINS_RELEASE_GATE === "1";

const binary = process.env.OMP_BINARY ?? (await findBinary("omp"));
if (!binary) {
  console.log("omp: not installed");
  process.exit(1);
}
const root = mkdtempSync(join(tmpdir(), "botkins-omp-subagent-probe-"));
let plan = null;
let parentTurn = 0;
const requests = [];
const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
const textOf = (item) => (typeof item?.content === "string" ? item.content : (item?.content ?? []).map((p) => p.text ?? "").join(""));
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  const all = JSON.stringify(body.input ?? body.messages ?? []);
  const child = /CHILD-([a-z]+)/.exec(all)?.[1];
  const isChild = child && !/"function_call"[^]*"name":"task"/.test(all);
  requests.push(isChild ? "child:" + child : "parent");
  let item;
  if (isChild) {
    const step = plan.child(child);
    if (step.fail) {
      response.writeHead(400, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "child model refused" } }));
    }
    if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
    // An OMP task child ends by calling its `yield` tool with the result, else by answering.
    const tools = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
    const done = /function_call_output/.test(all);
    item = tools.includes("yield") && !done
      ? { id: "fc_y", type: "function_call", call_id: "call_y_" + child, name: "yield", status: "completed", arguments: JSON.stringify({ result: { data: step.say } }) }
      : { id: "msg_c", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: step.say, annotations: [] }] };
  } else {
    const step = plan.parent[parentTurn++] ?? { say: "Done." };
    item = step.tasks
      ? { id: "fc_t", type: "function_call", call_id: "call_task", name: "task", status: "completed", arguments: JSON.stringify({ context: "Probe.", tasks: step.tasks.map((name) => ({ name: "kid-" + name, agent: "task", task: "CHILD-" + name + ": answer in one word.", solutionSpace: "one word" })) }) }
      : { id: "msg_p", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: step.say, annotations: [] }] };
  }
  const id = "resp_" + requests.length;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    sse("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }) +
      sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, status: undefined, arguments: "" } }) +
      (item.type === "message"
        ? sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text })
        : sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments })) +
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
      sse("response.completed", { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const connection = { name: "botkins-test", config: { name: "Local test", baseUrl: "http://127.0.0.1:" + model.address().port + "/v1", api: "openai-responses", apiKey: "test", authHeader: true, models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] } };

async function probe(label, { parent, child, stopOnStart = false, cancelOnStart = false, settleMs = 500 }) {
  plan = { parent, child };
  parentTurn = 0;
  requests.length = 0;
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const provider = new OmpProvider({ dataDir: join(dir, "data"), binary });
  const frames = [];
  const reads = [];
  const hooks = [];
  const log = (name) => async (input) => void hooks.push({ event: name, agentId: input.agentId, agentType: input.agentType, response: input.response, parentAgentId: input.parentAgentId });
  const session = await provider.openSession({
    sessionId: "probe-" + label, established: false, hasReplies: false, folder: dir,
    model: { model: "test", source: "botkins-test" }, inference: { providers: [connection] },
    instructions: "Probe.", context: "", tools: [], skills: { directories: [], disabled: [] }, mcpServers: {},
    history: () => [], handlers: { permission: async () => ({ allow: true }) },
    pluginHooks: { handlers: { onSubagentStart: log("subagentStart"), onSubagentStop: log("subagentStop") } },
  });
  const live = await session.start();
  const level = "subscribed by Botkins at the turn";
  live.rpc.on((event) => {
    if (event.type === "subagent_lifecycle") {
      const p = event.payload ?? {};
      frames.push({ type: "lifecycle", id: p.id, status: p.status, agent: p.agent, index: p.index, parentToolCallId: p.parentToolCallId, detached: p.detached });
      if (stopOnStart && p.status === "started") setTimeout(() => void session.abort(), 100);
      if (cancelOnStart && p.status === "started") setTimeout(() => void live.rpc.request({ type: "cancel_subagent", subagentId: p.id }, 15000).then((r) => frames.push({ type: "cancel", r })).catch((e) => frames.push({ type: "cancel", error: e.message })), 100);
      if (p.status !== "started") reads.push(live.rpc.request({ type: "get_subagent_messages", subagentId: p.id }, 15000).then((m) => frames.push({ type: "messages", id: p.id, roles: (m?.messages ?? []).map((x) => x.role + (Array.isArray(x.content) ? ":" + x.content.map((c) => c.type + (c.name ? "=" + c.name : "")).join("+") : "")), lastText: JSON.stringify((m?.messages ?? []).filter((x) => x.role === "assistant").at(-1)?.content ?? null).slice(0, 200) })).catch((e) => frames.push({ type: "messages", id: p.id, error: e.message })));
    } else if (event.type === "tool_execution_end" && event.toolName === "task") frames.push({ type: "task_end", isError: !!event.isError, text: JSON.stringify(event.result?.content ?? "").slice(0, 160) });
  });
  let outcome;
  try {
    outcome = "reply:" + (await session.send({ prompt: "PROBE" })).text.slice(0, 80);
  } catch (error) {
    outcome = "error:" + String(error?.message ?? error).slice(0, 160);
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  await Promise.allSettled(reads);
  await session.close();
  await provider.stop();
  const result = { label, subscription: level, outcome, requests: [...requests], frames, hooks };
  console.log(JSON.stringify(result));
  return result;
}
const results = {};

let failed = false;
try {
  results.ok = await probe("ok", { parent: [{ tasks: ["a"] }, { say: "Done." }], child: () => ({ say: "kid answer" }) });
  results.fail = await probe("fail", { parent: [{ tasks: ["b"] }, { say: "Done." }], child: () => ({ fail: true }) });
  results.parallel = await probe("parallel", { parent: [{ tasks: ["c", "d"] }, { say: "Done." }], child: (name) => ({ wait: name === "c" ? 400 : 50, say: "kid " + name }) });
  // The parent's turn is stopped while the child runs; then wait past the child's own end.
  results.stopped = await probe("stopped", { parent: [{ tasks: ["e"] }, { say: "Done." }], child: () => ({ wait: 3000, say: "too late" }), stopOnStart: true, settleMs: 5000 });
  // OMP's own way to stop one child.
  results.cancelled = await probe("cancelled", { parent: [{ tasks: ["h"] }, { say: "Done." }], child: () => ({ wait: 3000, say: "too late" }), cancelOnStart: true, settleMs: 5000 });
  if (gate) {
    const of = (r, event, id) => r.hooks.filter((h) => h.event === event && (!id || h.agentId === id));
    const kid = (r) => r.frames.find((f) => f.type === "lifecycle")?.id;
    const checks = [
      ["ok: one start and one stop with OMP's child id and reply", of(results.ok, "subagentStart", "kid-a").length === 1 && of(results.ok, "subagentStop", "kid-a").length === 1 && of(results.ok, "subagentStop")[0]?.response === "kid answer"],
      ["ok: no other hooks", results.ok.hooks.length === 2],
      ["fail: a start and no stop", of(results.fail, "subagentStart").length === 1 && of(results.fail, "subagentStop").length === 0],
      ["parallel: one start and one stop for each child, no duplicates", ["kid-c", "kid-d"].every((id) => of(results.parallel, "subagentStart", id).length === 1 && of(results.parallel, "subagentStop", id).length === 1) && results.parallel.hooks.length === 4],
      ["parallel: each stop has its own child's reply", of(results.parallel, "subagentStop", "kid-c")[0]?.response === "kid c" && of(results.parallel, "subagentStop", "kid-d")[0]?.response === "kid d"],
      ["cancelled: a start and no stop", of(results.cancelled, "subagentStart").length === 1 && of(results.cancelled, "subagentStop").length === 0 && results.cancelled.frames.some((f) => f.status === "aborted")],
      ["every hook names OMP's child and the parent conversation", Object.values(results).every((r) => r.hooks.every((h) => h.agentId === kid(r) || r.label === "parallel") && r.hooks.every((h) => h.parentAgentId === "probe-" + r.label))],
    ];
    for (const [what, ok] of checks) if (!ok) (failed = true), console.log("FAILED " + what);
  }
} catch (error) {
  failed = true;
  console.log("FAILED: OMP could not run the probe: " + String(error?.message ?? error).slice(0, 300) + (process.env.PROBE_DEBUG ? "\n" + error?.stack : ""));
} finally {
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
if (gate) console.log(failed ? "FAILED" : "PASSED " + JSON.stringify(Object.keys(results)));
process.exit(failed ? 1 : 0);
