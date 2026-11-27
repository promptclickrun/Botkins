// Run with: node test/omp-botkins-tools-live.mjs
// Real installed OMP runs a seeded Botkins chat against a local model fixture. No account or
// network access is needed. Verifies direct typed Botkins tool discovery and execution in both
// cold and prewarmed chats (wiki_search, request_secure_input/use_secure_input, ask_teammate),
// plus restricted-turn filtering, tool errors, cancellation, and external MCP support.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { headlessHost } from "../desktop/host/headless.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { performSecureUse } from "../desktop/secure-input.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { defineTool } from "../desktop/providers/provider.mjs";
import { seedBots } from "./starter.mjs";
import { modelReply } from "./fixtures/pi-model-response.mjs";

const form = {
  operation: "https_form",
  url: "https://example.org/sign-in",
  title: "Sign in",
  fields: [
    { key: "username", label: "User name", kind: "text" },
    { key: "password", label: "Password", kind: "password" },
  ],
};

function lastToolOutput(input) {
  const output = input.filter((item) => item.type === "function_call_output").at(-1)?.output;
  return Array.isArray(output) ? output.map((part) => part.text).join("") : output;
}

function findTypedTool(tools, suffix) {
  const found = (tools ?? []).find((tool) => tool.name?.endsWith(suffix));
  assert.ok(found, `expected direct typed tool schema ending with ${suffix} in request.tools`);
  assert.equal(found.type, "function");
  assert.equal(found.parameters?.type, "object", `${found.name} should expose an object parameter schema`);
  return found;
}

test("real OMP exposes and invokes typed Botkins tools in both cold and warm seeded chats", { timeout: 120000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "botkins-omp-tools-"));
  seedBots(dataDir);
  const runtime = await createRuntime({ host: headlessHost({ version: "1.0.0" }), dataDir, trial: true, link: { port: 0, announce: false } });
  t.after(async () => {
    await runtime.stop();
    rmSync(dataDir, { force: true, recursive: true });
  });

  const ws = runtime.workspace;
  ws.wiki.write("notes/greenhouse.md", "# Greenhouse\n\nTomatoes are watered every Tuesday morning at 07:00.\n");

  const secrets = { username: "synthetic-omp-user", password: "synthetic-omp-password" };
  const credential = await runtime.handlers.saveSavedCredential({ name: "OMP Fixture Login", kind: "login", value: secrets.password });

  const chat = ws.chat(ws.createChat("pip"));
  ws.state.settings.harness = "omp";
  ws.state.settings.model = { provider: "codex", model: "fixture" };
  chat.model = { provider: "codex", model: "fixture" };
  const omp = runtime.providers.require("omp");
  if (process.env.OMP_BINARY) omp.binary = process.env.OMP_BINARY;
  t.mock.method(runtime.providers, "models", async () => [{ provider: "codex", id: "fixture", tools: true }]);
  const gateway = ws.harness.gateway;
  gateway.chatgpt = { signIn: () => ({ token: "fixture" }) };

  const submissions = [];
  t.mock.method(ws.secureInputs, "use", (plan, values, adapters) =>
    performSecureUse(plan, values, {
      ...adapters,
      fetch: async (url, init) => {
        assert.equal(url, form.url);
        assert.equal(init.method, "POST");
        submissions.push(Object.fromEntries(init.body));
        return new Response(null, { status: 204 });
      },
    }),
  );

  let failure;
  let secureCards = 0;
  const answers = [];
  ws.events.on("request", (view) => {
    secureCards++;
    answers.push(
      runtime.handlers
        .respond(view.id, { action: "accept", content: { username: secrets.username, password: { $credential: credential } } })
        .catch((error) => { failure ??= error; }),
    );
  });

  let phase = "cold";
  let mainCalls = 0;
  let helperCalls = 0;
  let grant = null;
  const seenHelperToolLists = [];

  t.mock.method(gateway, "fetch", async (_url, init) => {
    try {
      for (const value of Object.values(secrets)) assert.ok(!init.body.includes(value), "a secret reached the model");
      const { input, instructions, tools } = JSON.parse(init.body);
      const isHelper = typeof instructions === "string" && instructions.includes("You are Scout");
      if (isHelper) {
        helperCalls++;
        const names = (tools ?? []).map((tool) => tool.name);
        seenHelperToolLists.push(names);
        // Restricted helper turn: keeps wiki_search, never exposes ask_teammate or secure input.
        findTypedTool(tools, "wiki_search");
        assert.ok(!names.some((name) => name.endsWith("ask_teammate")), "helper turn must not receive ask_teammate");
        assert.ok(!names.some((name) => name.endsWith("request_secure_input")), "helper turn must not receive request_secure_input");
        return modelReply(`helper-${helperCalls}`, null, null, `Scout helper reply (${phase})`);
      }

      const wikiTool = findTypedTool(tools, "wiki_search");
      const reqSecure = findTypedTool(tools, "request_secure_input");
      const useSecure = findTypedTool(tools, "use_secure_input");
      const askTool = findTypedTool(tools, "ask_teammate");
      assert.ok(wikiTool.parameters.properties?.query, "wiki_search schema should declare query");
      assert.ok(reqSecure.parameters.properties?.operation, "request_secure_input schema should declare operation");
      assert.ok(askTool.parameters.properties?.teammate, "ask_teammate schema should declare teammate");

      const text = lastToolOutput(input);
      switch (++mainCalls) {
        case 1:
          return modelReply("search wiki", wikiTool.name, { query: "Tomatoes" });
        case 2:
          assert.match(text, /greenhouse\.md/i, `${phase}: wiki_search should return greenhouse.md`);
          return modelReply("ask secure", reqSecure.name, form);
        case 3:
          assert.match(text, /^\s*\{/, `${phase}: request_secure_input should return handles JSON`);
          grant = JSON.parse(text);
          assert.deepEqual(Object.keys(grant.handles).sort(), ["password", "username"]);
          return modelReply("apply secure", useSecure.name, grant);
        case 4:
          assert.deepEqual(JSON.parse(text), { applied: true });
          return modelReply("replay secure", useSecure.name, grant);
        case 5:
          assert.match(text, /expired|unavailable|used/i, `${phase}: replaying handles must fail`);
          return modelReply("ask scout", askTool.name, { teammate: "Scout", message: `Confirm ${phase} handoff` });
        case 6:
          assert.match(text, new RegExp(`Scout helper reply \\(${phase}\\)`), `${phase}: ask_teammate should return Scout's reply`);
          return modelReply(`done-${phase}`, null, null, `${phase} complete`);
        default:
          throw new Error(`Unexpected extra model request #${mainCalls} in ${phase}`);
      }
    } catch (error) {
      failure ??= error;
      return modelReply("failed", null, null, "failed");
    }
  });

  // 1. Cold chat
  await ws.send(chat.id, "Check the greenhouse wiki, sign in, and ask Scout.");
  await Promise.all(answers);
  if (failure) throw failure;
  assert.equal(chat.sessionProvider, "omp", ws.state.runs[0]?.detail);
  assert.equal(chat.messages.at(-1).text, "cold complete", ws.state.runs[0]?.detail);
  assert.equal(mainCalls, 6);
  assert.equal(helperCalls, 1);

  // 2. Warm chat (release OMP, prewarm the same established chat, verify warm PID reuse)
  await omp.releaseSession(chat.id, { busy: true });
  await ws.prewarm(chat.id);
  const warmLive = omp.live.get(chat.id);
  assert.ok(warmLive && !warmLive.rpc.closed, "prewarm should leave a live OMP process for the chat");
  const warmPid = warmLive.rpc.child.pid;

  phase = "warm";
  mainCalls = 0;
  grant = null;
  await ws.send(chat.id, "Run the same checks again on the warmed chat.");
  await Promise.all(answers);
  if (failure) throw failure;
  assert.equal(omp.live.get(chat.id)?.rpc.child.pid, warmPid, "warm turn should reuse the prewarmed OMP process without restarting");
  assert.equal(chat.messages.at(-1).text, "warm complete", ws.state.runs.at(-1)?.detail);
  assert.equal(mainCalls, 6);
  assert.equal(helperCalls, 2);
  assert.equal(secureCards, 2);
  assert.deepEqual(submissions, [secrets, secrets]);
  assert.equal(seenHelperToolLists.length, 2);
  const saved = readFileSync(join(dataDir, "workspace.json"), "utf8");
  for (const value of Object.values(secrets)) assert.ok(!saved.includes(value));
});

test("real OMP preserves tool errors, cancellation, restricted sets, and external MCP approvals", { timeout: 60000 }, async (t) => {
  const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
  let mode = "error";
  let step = 0;
  const requests = [];
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      let item;
      if (++step === 1) {
        if (mode === "error") {
          const failTool = findTypedTool(body.tools, "fail_tool");
          item = { id: "fc_err", type: "function_call", call_id: "call_err", name: failTool.name, status: "completed", arguments: "{}" };
        } else if (mode === "mcp") {
          const echoTool = findTypedTool(body.tools, "echo");
          item = { id: "fc_mcp", type: "function_call", call_id: "call_mcp", name: echoTool.name, status: "completed", arguments: JSON.stringify({ value: "from-ext-mcp" }) };
        } else if (mode === "cancel") {
          const hangTool = findTypedTool(body.tools, "hang_tool");
          item = { id: "fc_hang", type: "function_call", call_id: "call_hang", name: hangTool.name, status: "completed", arguments: "{}" };
        } else {
          item = { id: "m_ok", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "restricted-ok", annotations: [] }] };
        }
      } else {
        item = { id: "m_done", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "after-" + mode, annotations: [] }] };
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(
        sse("response.created", { type: "response.created", response: { id: "r_" + requests.length, status: "in_progress", output: [] } }) +
          sse("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, status: undefined, arguments: "" },
          }) +
          (item.type === "message"
            ? sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text })
            : sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments })) +
          sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
          sse("response.completed", { type: "response.completed", response: { id: "r_" + requests.length, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
      );
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "botkins-omp-preserve-"));
  const bridge = new ToolBridge();
  const provider = new OmpProvider({ dataDir: join(root, "data"), bridge, ...(process.env.OMP_BINARY && { binary: process.env.OMP_BINARY }) });
  let releaseHang;
  t.after(async () => {
    releaseHang?.();
    await provider.stop();
    await bridge.stop();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const connection = {
    name: "botkins-test",
    config: {
      name: "Local test",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
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
  };

  let hangStarted;
  const hangReady = new Promise((resolve) => (hangStarted = resolve));
  const allTools = [
    defineTool("fail_tool", {
      description: "Throws an error",
      parameters: { type: "object", properties: {} },
      skipPermission: true,
      handler: async () => { throw new Error("bridge boom"); },
    }),
    defineTool("hang_tool", {
      description: "Waits until cancelled",
      parameters: { type: "object", properties: {} },
      skipPermission: true,
      handler: async () => {
        hangStarted();
        await new Promise((resolve) => (releaseHang = resolve));
        return "unreachable";
      },
    }),
  ];
  const approvals = [];
  const makeSession = (sessionId, tools, mcpServers = {}) =>
    provider.openSession({
      sessionId,
      established: false,
      hasReplies: false,
      folder: root,
      model: { model: "test", source: "botkins-test" },
      inference: { providers: [connection] },
      instructions: "Test",
      context: "",
      tools,
      skills: { directories: [], disabled: [] },
      mcpServers,
      history: () => [],
      handlers: { permission: async (request) => (approvals.push(request), { allow: true }) },
    });

  const session = await makeSession("omp-preserve-1", allTools, {
    fixture: {
      type: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url))],
    },
  });
  const events = [];
  session.on((event) => events.push(event));

  // 1. Bridge tool error propagates cleanly without approval prompts
  const errReply = await session.send({ prompt: "run fail" });
  assert.equal(errReply.text, "after-error");
  assert.equal(approvals.length, 0, "Botkins bridge tool should not trigger approval");
  assert.match(lastToolOutput(requests[1].input), /bridge boom/);
  const errComplete = events.find((event) => event.type === "tool.execution_complete");
  assert.equal(errComplete.data.success, false);
  assert.match(errComplete.data.error.message, /bridge boom/);

  // 2. External MCP tool is discovered directly and still triggers Botkins MCP approval
  mode = "mcp";
  step = 0;
  const mcpReply = await session.send({ prompt: "run external mcp" });
  assert.equal(mcpReply.text, "after-mcp");
  assert.equal(approvals.length, 1);
  assert.deepEqual([approvals[0].kind, approvals[0].label, approvals[0].toolName], ["mcp", "fixture / echo", "echo"]);
  assert.match(lastToolOutput(requests.at(-1).input), /from-ext-mcp/);

  // 3. Cancellation aborts an in-flight bridge tool cleanly
  mode = "cancel";
  step = 0;
  const cancelTurn = session.send({ prompt: "run hang" });
  await hangReady;
  const abortedAt = Date.now();
  await session.abort();
  const cancelReply = await Promise.race([
    cancelTurn,
    new Promise((_, reject) => setTimeout(() => reject(new Error("OMP abort timed out")), 8000)),
  ]);
  assert.equal(cancelReply.text, "");
  assert.ok(Date.now() - abortedAt < 5000, "abort should settle promptly");
  await session.close();

  // 4. Restricted turn on the same session drops removed tools/servers
  mode = "restricted";
  step = 0;
  const before = requests.length;
  const restricted = await makeSession("omp-preserve-1", [allTools[0]], {});
  const restrictedReply = await restricted.send({ prompt: "restricted turn" });
  assert.equal(restrictedReply.text, "restricted-ok");
  const restrictedNames = requests[before].tools.map((tool) => tool.name);
  assert.ok(restrictedNames.some((name) => name.endsWith("fail_tool")), "allowed bridge tool remains exposed");
  assert.ok(!restrictedNames.some((name) => name.endsWith("hang_tool")), "removed bridge tool is excluded");
  assert.ok(!restrictedNames.some((name) => name.endsWith("echo")), "removed external MCP server tool is excluded");
  await restricted.close();
});
