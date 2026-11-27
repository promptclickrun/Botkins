// Real Pi 1.6.0 + Real OMP 19.1.0 plan sync verification against a local model endpoint.
// No provider account or plan is used.
//   OMP_BINARY=/path/to/omp node test/pi-omp-plan-live.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProvider } from "../desktop/providers/pi/index.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { mapTodos } from "../desktop/canvas.mjs";
import { nextMove, openSteps } from "../desktop/keep-moving.mjs";

const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
const readBody = (request) =>
  new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(JSON.parse(data)));
  });
const textOutput = (id, text) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const callOutput = (id, callId, name, args) => ({
  id,
  type: "function_call",
  call_id: callId,
  name,
  status: "completed",
  arguments: JSON.stringify(args),
});

const INITIAL_STEPS = [
  { id: "a", text: "Read the code", status: "completed" },
  { id: "b", text: "Write the fix", status: "in_progress", dependsOn: ["a"] },
  { id: "c", text: "Run the tests", status: "pending", dependsOn: ["b"] },
];
const FINISHED_STEPS = [
  { id: "a", text: "Read the code", status: "completed" },
  { id: "b", text: "Write the fix", status: "completed", dependsOn: ["a"] },
  { id: "c", text: "Run the tests", status: "completed", dependsOn: ["b"] },
];

const expectedInitial = [
  { id: "a", title: "Read the code", status: "done" },
  { id: "b", title: "Write the fix", status: "in_progress", dependsOn: ["a"] },
  { id: "c", title: "Run the tests", status: "pending", dependsOn: ["b"] },
];
const expectedFinished = [
  { id: "a", title: "Read the code", status: "done" },
  { id: "b", title: "Write the fix", status: "done", dependsOn: ["a"] },
  { id: "c", title: "Run the tests", status: "done", dependsOn: ["b"] },
];

function createLocalModel(handler) {
  let turn = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    const input = await readBody(request);
    requests.push(input);
    const n = ++turn;
    const output = handler(n, input);
    const responseId = "resp_" + n;
    const item = output[0];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(
      sse("response.created", { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } }) +
        sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: item.type === "message"
            ? { ...item, status: "in_progress", content: [] }
            : { ...item, status: undefined, arguments: "" },
        }) +
        (item.type === "message"
          ? sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text })
          : sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments })) +
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
        sse("response.completed", {
          type: "response.completed",
          response: { id: responseId, status: "completed", output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
        }),
    );
  });
  return { server, requests };
}

const findPlanToolName = (input) => {
  const names = (input.tools ?? []).map((tool) => tool.name).filter(Boolean);
  return names.find((name) => name === "update_plan" || name.endsWith("_update_plan"));
};

const modelConnection = (port) => ({
  name: "botkins-test",
  config: {
    name: "Local test",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-responses",
    apiKey: "test",
    authHeader: true,
    models: [{
      id: "test",
      name: "Test",
      reasoning: false,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    }],
  },
});

const baseSpec = (sessionId, folder, port, extra = {}) => ({
  sessionId,
  established: false,
  hasReplies: false,
  folder,
  model: { model: "test", source: "botkins-test" },
  inference: { providers: [modelConnection(port)] },
  instructions: "You are Testy.",
  context: "",
  tools: [],
  skills: { directories: [], disabled: [] },
  mcpServers: {},
  history: () => [],
  handlers: { permission: async () => ({ allow: true }) },
  ...extra,
});

const root = mkdtempSync(join(tmpdir(), "botkins-pi-omp-plan-live-"));
try {
  // 1. Real Pi 1.6.0
  const piModel = createLocalModel((turn, input) => {
    const planTool = findPlanToolName(input);
    if (turn === 1) {
      assert.equal(planTool, "mcp__botkins__update_plan", "Pi must expose update_plan via Botkins bridge");
      const def = input.tools.find((t) => t.name === planTool);
      assert.ok(def?.parameters?.properties?.steps?.items?.properties?.dependsOn, "Pi update_plan schema exposes dependsOn");
      return [callOutput("fc_pi_1", "call_pi_1", planTool, { steps: INITIAL_STEPS })];
    }
    if (turn === 2) return [textOutput("msg_pi_1", "Read the code. Moving to the fix.")];
    if (turn === 3) return [callOutput("fc_pi_2", "call_pi_2", planTool, { steps: FINISHED_STEPS })];
    return [textOutput("msg_pi_2", "All steps done.")];
  });
  await new Promise((resolve) => piModel.server.listen(0, "127.0.0.1", resolve));
  const piPort = piModel.server.address().port;
  const piDataDir = join(root, "pi-data");
  const piFolder = join(root, "pi-work");
  mkdirSync(piFolder, { recursive: true });
  const piBridge = new ToolBridge();
  const pi = new PiProvider({ dataDir: piDataDir, bridge: piBridge });
  let piInitialMapped;
  let piFinalMapped;
  try {
    const s1 = await pi.openSession(baseSpec("pi-plan-live", piFolder, piPort));
    const events1 = [];
    s1.on((event) => events1.push(event));
    const r1 = await s1.send({ prompt: "Start the work." });
    assert.equal(r1.text, "Read the code. Moving to the fix.");
    assert.ok(events1.some((e) => e.type === "session.todos_changed"), "Pi emitted session.todos_changed");
    piInitialMapped = mapTodos(await s1.todos());
    assert.deepEqual(piInitialMapped, expectedInitial);

    const decision1 = nextMove({ text: r1.text, todos: piInitialMapped, chain: { count: 0, stalls: 0, signature: "" } });
    assert.equal(decision1.move, "continue");
    assert.equal(decision1.reason, "plan");
    assert.equal(decision1.open.length, 2);

    // Warm reuse before sending turn 2: todos() is already visible for todoHandoff
    const s2 = await pi.openSession(baseSpec("pi-plan-live", piFolder, piPort, { established: true, hasReplies: true }));
    assert.deepEqual(mapTodos(await s2.todos()), expectedInitial, "Pi warm session keeps dependent plan before send");
    const r2 = await s2.send({ prompt: decision1.input });
    assert.equal(r2.text, "All steps done.");
    piFinalMapped = mapTodos(await s2.todos());
    assert.deepEqual(piFinalMapped, expectedFinished);
    assert.equal(openSteps(piFinalMapped).length, 0);
    assert.equal(nextMove({ text: r2.text, todos: piFinalMapped, chain: { count: 1, stalls: 0, signature: decision1.signature } }).move, "stop");
  } finally {
    await pi.stop();
    await piBridge.stop();
  }

  // Cold restart / resume on Pi
  const piRestartedBridge = new ToolBridge();
  const piRestarted = new PiProvider({ dataDir: piDataDir, bridge: piRestartedBridge });
  try {
    const s3 = await piRestarted.openSession(baseSpec("pi-plan-live", piFolder, piPort, { established: true, hasReplies: true }));
    assert.deepEqual(mapTodos(await s3.todos()), expectedFinished, "Pi cold restart recovers persisted dependent plan");
    await piRestarted.deleteSession("pi-plan-live");
    const s4 = await piRestarted.openSession(baseSpec("pi-plan-live", piFolder, piPort));
    assert.equal(await s4.todos(), null, "Pi deleteSession clears persisted plan");
  } finally {
    await piRestarted.stop();
    await piRestartedBridge.stop();
    piModel.server.close();
  }
  console.log("pi-plan-live: ok (bundled Pi)");

  // 2. Real OMP 19.1.0
  const ompModel = createLocalModel((turn, input) => {
    const names = (input.tools ?? []).map((t) => t.name).filter(Boolean);
    assert.equal(names.includes("todo"), false, `OMP native todo tool must be disabled (got: ${names.join(", ")})`);
    const planTool = findPlanToolName(input);
    if (turn === 1) {
      assert.ok(planTool, `OMP must expose update_plan (got: ${names.join(", ")})`);
      return [callOutput("fc_omp_1", "call_omp_1", planTool, { steps: INITIAL_STEPS })];
    }
    return [textOutput("msg_omp_1", "Read the code. Moving to the fix.")];
  });
  await new Promise((resolve) => ompModel.server.listen(0, "127.0.0.1", resolve));
  const ompPort = ompModel.server.address().port;
  const ompDataDir = join(root, "omp-data");
  const ompFolder = join(root, "omp-work");
  mkdirSync(ompFolder, { recursive: true });
  const ompBridge = new ToolBridge();
  const omp = new OmpProvider({ dataDir: ompDataDir, bridge: ompBridge, ...(process.env.OMP_BINARY && { binary: process.env.OMP_BINARY }) });
  let ompInitialMapped;
  let ompAfterSlash;
  try {
    const s1 = await omp.openSession(baseSpec("omp-plan-live", ompFolder, ompPort));
    const events1 = [];
    s1.on((event) => events1.push(event));
    const r1 = await s1.send({ prompt: "Start the work." });
    assert.equal(r1.text, "Read the code. Moving to the fix.");
    assert.ok(events1.some((e) => e.type === "session.todos_changed"), "OMP emitted session.todos_changed");
    ompInitialMapped = mapTodos(await s1.todos());
    assert.deepEqual(ompInitialMapped, piInitialMapped, "OMP dependent plan matches Pi identically");

    // Verify OMP's own RPC todoPhases mirrored the plan via set_todos and overlay disables native todo + reminders
    const live = omp.live.get("omp-plan-live");
    assert.ok(live, "OMP live process is warm");
    const botkinsYml = readFileSync(live.config, "utf8");
    assert.match(botkinsYml, /todo:\s*\n\s+enabled:\s*false\s*\n\s+reminders:\s*false/);
    const state = await live.rpc.request({ type: "get_state" }, 15000);
    assert.equal(state.todoPhases?.length, 1);
    assert.deepEqual(
      state.todoPhases[0].tasks.map((t) => ({ content: t.content, status: t.status })),
      [
        { content: "Read the code", status: "completed" },
        { content: "Write the fix", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    );

    // Verify native OMP /todo slash commands sync back into Botkins without hanging or inventing deps
    const s2 = await omp.openSession(baseSpec("omp-plan-live", ompFolder, ompPort, { established: true, hasReplies: true }));
    const events2 = [];
    s2.on((event) => events2.push(event));
    assert.deepEqual(mapTodos(await s2.todos()), expectedInitial, "OMP warm session keeps dependent plan before send");
    await s2.send({ prompt: "/todo done Write the fix" });
    assert.ok(events2.some((e) => e.type === "session.todos_changed"), "OMP /todo done emitted session.todos_changed");
    assert.deepEqual(mapTodos(await s2.todos()), [
      { id: "a", title: "Read the code", status: "done" },
      { id: "b", title: "Write the fix", status: "done", dependsOn: ["a"] },
      // OMP promotes the next pending task to in_progress when the active task is marked done.
      { id: "c", title: "Run the tests", status: "in_progress", dependsOn: ["b"] },
    ]);

    // Verify /todo drop -> abandoned -> cancelled (closes open steps cleanly)
    await s2.send({ prompt: "/todo drop Run the tests" });
    ompAfterSlash = mapTodos(await s2.todos());
    assert.deepEqual(ompAfterSlash, [
      { id: "a", title: "Read the code", status: "done" },
      { id: "b", title: "Write the fix", status: "done", dependsOn: ["a"] },
      { id: "c", title: "Run the tests", status: "cancelled", dependsOn: ["b"] },
    ]);
    assert.equal(openSteps(ompAfterSlash).length, 0, "abandoned -> cancelled closes step for keepMoving");
    assert.equal(nextMove({ text: "Done.", todos: ompAfterSlash, chain: { count: 0, stalls: 0, signature: "" } }).move, "stop");

    // Verify native OMP todoPhases with an extra task syncs without inventing dependencies
    const nextPhases = [
      {
        id: "phase-1",
        name: "Plan",
        tasks: [
          { id: "task-1", content: "Read the code", status: "completed" },
          { id: "task-2", content: "Write the fix", status: "completed" },
          { id: "task-3", content: "Run the tests", status: "abandoned" },
          { id: "task-4", content: "Ship release", status: "pending" },
        ],
      },
    ];
    await live.rpc.request({ type: "set_todos", phases: nextPhases }, 15000);
    await s2.syncOmpTodos(live.rpc, { emit: true });
    const withAdded = mapTodos(await s2.todos());
    assert.equal(withAdded.length, 4);
    assert.equal(withAdded[3].title, "Ship release");
    assert.equal(withAdded[3].status, "pending");
    assert.equal(withAdded[3].dependsOn, undefined, "OMP native todoPhases sync must never invent dependencies");
    assert.deepEqual(withAdded[1].dependsOn, ["a"]);
    assert.deepEqual(withAdded[2].dependsOn, ["b"]);
    ompAfterSlash = withAdded;
  } finally {
    await omp.stop();
    await ompBridge.stop();
  }

  // Cold restart / --resume on real OMP 19.1.0
  const ompRestartedBridge = new ToolBridge();
  const ompRestarted = new OmpProvider({ dataDir: ompDataDir, bridge: ompRestartedBridge, ...(process.env.OMP_BINARY && { binary: process.env.OMP_BINARY }) });
  try {
    const s3 = await ompRestarted.openSession(baseSpec("omp-plan-live", ompFolder, ompPort, { established: true, hasReplies: true }));
    assert.deepEqual(mapTodos(await s3.todos()), ompAfterSlash, "OMP cold restart recovers persisted rows and explicit dependencies");
    await ompRestarted.deleteSession("omp-plan-live");
    const s4 = await ompRestarted.openSession(baseSpec("omp-plan-live", ompFolder, ompPort));
    assert.equal(await s4.todos(), null, "OMP deleteSession clears persisted plan");
  } finally {
    await ompRestarted.stop();
    await ompRestartedBridge.stop();
    ompModel.server.close();
  }
  console.log("pi-omp-plan-live: ok (bundled Pi + real OMP)");
} finally {
  rmSync(root, { recursive: true, force: true });
}
