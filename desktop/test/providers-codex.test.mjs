// The ChatGPT provider (desktop/providers/codex) against a stand-in for `codex app-server`:
// the account and sign-in, the model list, a turn's requests and events, approvals, resuming,
// forking, and a whole chat through the workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Providers, defineTool } from "../desktop/providers/index.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { BRIDGE, CodexProvider, approvalSettings, threadConfig } from "../desktop/providers/codex/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { pass, until as soon, watching } from "./quiet-turns.mjs";

/** Waits until `ready()` is true. A stand-in server works at its own pace, so a fixed time is not enough on a slow runner. */
const until = async (ready, what) => {
  for (let waited = 0; !ready() && waited < 500; waited++) await tick(10);
  assert.ok(ready(), what);
};

/**
 * A stand-in for the app-server. `answer(method, params, server)` answers each request;
 * `server.emit` sends a notification and `server.ask` makes a request of the client, as Codex does.
 */
function fakeCodex(answer = () => ({})) {
  const log = [];
  const listeners = new Set();
  const notified = (method, params) => [...listeners].forEach((fn) => fn(method, params));
  let asked = async () => ({});
  let threads = 0;
  let turns = 0;
  const server = {
    emit: (method, params) => notified(method, params),
    ask: (method, params) => asked(method, params),
    newThread: () => "thread-" + ++threads,
    newTurn: () => "turn-" + ++turns,
  };
  const peer = {
    exited: new Promise(() => {}),
    onNotification: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    onRequest: (fn) => void (asked = fn),
    notify: (method, params) => void log.push([method, params]),
    async request(method, params) {
      log.push([method, params]);
      if (method === "initialize") return { userAgent: "botkins/9.8.7 (test)" };
      return answer(method, params, server);
    },
    close: async () => {},
  };
  return { peer, log, server, sent: (method) => log.filter(([m]) => m === method).map(([, p]) => p) };
}

/** A provider on a fake app-server and a real tool bridge. */
function setup(t, answer, options = {}) {
  const dir = options.dir ?? tempDir(t);
  const fake = fakeCodex(answer);
  const bridge = new ToolBridge();
  const provider = new CodexProvider({ dataDir: join(dir, "codex"), bridge, spawn: async () => fake.peer, version: "1.2.3", home: options.home });
  t.after(() => Promise.all([provider.stop(), bridge.stop()]));
  return { dir, provider, bridge, ...fake };
}

const spec = (over = {}) => ({
  sessionId: "chat-1",
  established: false,
  hasReplies: false,
  temporary: false,
  folder: "/work",
  coding: false,
  model: { model: "gpt-x", provider: "codex", reasoningEffort: "high" },
  approval: "ask",
  instructions: "You are Pip.",
  context: "\nMemory: likes teal.",
  tools: [],
  mcpServers: {},
  history: () => [],
  handlers: null,
  ...over,
});

/** Answers a turn the way Codex does: thread, turn id, then the events `play` emits, then completion. */
function turns(play) {
  return (method, params, server) => {
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") return { thread: { id: params.threadId && method === "thread/resume" ? params.threadId : server.newThread() } };
    if (method === "thread/unsubscribe") {
      setImmediate(() => server.emit("thread/closed", { threadId: params.threadId }));
      return { status: "unsubscribed" };
    }
    if (method === "turn/start") {
      const id = server.newTurn();
      setImmediate(async () => {
        const status = (await play({ params, server, turnId: id, threadId: params.threadId })) ?? "completed";
        server.emit("turn/completed", { threadId: params.threadId, turn: { id, status: typeof status === "string" ? status : "failed", error: status.error ?? null, durationMs: 1200 } });
      });
      return { turn: { id } };
    }
    return {};
  };
}
const say = (server, threadId, id, text) => {
  server.emit("item/started", { threadId, item: { type: "agentMessage", id, text: "" } });
  for (const part of text.match(/.{1,6}/gs) ?? []) server.emit("item/agentMessage/delta", { threadId, itemId: id, delta: part });
  server.emit("item/completed", { threadId, item: { type: "agentMessage", id, text } });
};

test("the ChatGPT account, its plan and the model list come from Codex", async (t) => {
  let account = { type: "chatgpt", email: "ada@example.com", planType: "plus", workspaceName: null };
  const { provider, log, sent } = setup(t, (method, params) => {
    if (method === "account/read") return { account, requiresOpenaiAuth: true };
    if (method === "model/list")
      return params.cursor
        ? { data: [{ id: "b", model: "gpt-b", displayName: "GPT B", hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null }
        : {
            data: [
              { id: "a", model: "gpt-a", displayName: "GPT A", description: "The big one", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" },
              { id: "h", model: "gpt-hidden", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [] },
            ],
            nextCursor: "page-2",
          };
    return {};
  });
  assert.deepEqual(await provider.status(), { installed: true, version: "9.8.7", signIn: "browser", connected: true, signOut: true, account: "ada@example.com", plan: "ChatGPT Plus" });
  assert.deepEqual(log[0], ["initialize", { clientInfo: { name: "botkins", title: "Botkins", version: "1.2.3" }, capabilities: { experimentalApi: true, requestAttestation: false } }]);
  assert.deepEqual(log[1], ["initialized", undefined]);
  assert.deepEqual(await provider.auth(), { connected: true, login: "ada@example.com", type: "ChatGPT Plus" });
  account = { type: "apiKey" };
  assert.deepEqual([(await provider.status()).plan, (await provider.status()).account], ["OpenAI API key", undefined]);
  account = null;
  const out = await provider.status();
  assert.deepEqual([out.connected, out.signOut, out.message], [false, false, "Sign in with your ChatGPT account."]);

  assert.deepEqual(await provider.models(), [
    { id: "gpt-a", name: "GPT A", provider: "codex", efforts: ["low", "high"], defaultEffort: "low", tools: true, description: "The big one", recommended: true, available: true },
    { id: "gpt-b", name: "GPT B", provider: "codex", efforts: [], defaultEffort: undefined, tools: true, available: true },
  ]);
  assert.deepEqual(sent("model/list"), [{}, { cursor: "page-2" }], "every page is read, and hidden models are left out");
  assert.equal(await provider.version(), "Codex CLI 9.8.7 · app-server");
  assert.equal(sent("initialize").length, 1, "one app-server serves every request");
});

test("signing in opens Codex's ChatGPT page and waits for Codex to say it is done", async (t) => {
  let url = "https://auth.openai.com/authorize?x=1";
  const { provider, server, sent } = setup(t, (method) => (method === "account/login/start" ? { type: "chatgpt", loginId: "login-1", authUrl: url } : {}));
  const opened = [];
  const done = provider.signIn({ open: async (u) => void opened.push(u) });
  await tick(10);
  assert.deepEqual(opened, ["https://auth.openai.com/authorize?x=1"]);
  assert.deepEqual(sent("account/login/start"), [{ type: "chatgpt" }]);
  await assert.rejects(provider.signIn({ open: async () => {} }), /already in progress/);
  server.emit("account/login/completed", { loginId: "other", success: true, error: null });
  server.emit("account/login/completed", { loginId: "login-1", success: true, error: null });
  await done;

  // Codex reports a failure; the person cancels; a page that isn't https is never opened.
  const failed = provider.signIn({ open: async () => {} });
  await tick(10);
  server.emit("account/login/completed", { loginId: "login-1", success: false, error: "Access denied" });
  await assert.rejects(failed, /Access denied/);
  const cancelled = provider.signIn({ open: async () => {} });
  await tick(10);
  await provider.cancelSignIn();
  await assert.rejects(cancelled, /cancelled/);
  assert.deepEqual(sent("account/login/cancel"), [{ loginId: "login-1" }, { loginId: "login-1" }], "an attempt that didn't finish is cancelled at Codex too, so the next one can start");
  // Only a page of OpenAI's is opened, whatever Codex hands over.
  for (const bad of ["http://auth.openai.com/authorize", "https://evil.example/login", "https://openai.com.evil.example/x", "not a url"]) {
    url = bad;
    await assert.rejects(provider.signIn({ open: async () => assert.fail("not opened") }), /isn't OpenAI's/);
  }
  url = "https://chatgpt.com/auth";
  const browserFailed = provider.signIn({ open: async () => { throw new Error("No browser"); } });
  await assert.rejects(browserFailed, /No browser/);
  assert.equal(sent("account/login/cancel").length, 7);
  await provider.signOut();
  assert.equal(sent("account/logout").length, 1);
});

test("approval levels and MCP servers become Codex thread settings", () => {
  assert.deepEqual(approvalSettings("ask"), { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  assert.deepEqual(approvalSettings("read"), approvalSettings("ask"), "Codex already runs known-safe reads itself");
  assert.equal(approvalSettings("assisted").approvalsReviewer, "auto_review");
  assert.equal(approvalSettings("assisted").sandbox, "workspace-write");
  assert.equal(approvalSettings("all").sandbox, "danger-full-access");
  assert.equal(approvalSettings("all").approvalPolicy.granular.mcp_elicitations, true, "a server's own sign-in prompt still reaches the person");
  const config = threadConfig(
    {
      files: { type: "stdio", command: "npx", args: ["-y", "files"], env: { TOKEN: "t" }, workingDirectory: "/srv" },
      crm: { type: "http", url: "https://crm.example/mcp", headers: { Authorization: "Bearer k" } },
      bare: { type: "http", url: "https://bare.example/mcp" },
      [BRIDGE]: { type: "http", url: "https://impostor.example" },
    },
    { url: "http://127.0.0.1:1/mcp/abc", headers: { Authorization: "Bearer s" } },
  );
  assert.deepEqual(config["mcp_servers.files"], { command: "npx", args: ["-y", "files"], env: { TOKEN: "t" }, cwd: "/srv" });
  assert.deepEqual(config["mcp_servers.crm"], { url: "https://crm.example/mcp", http_headers: { Authorization: "Bearer k" } });
  assert.deepEqual(config["mcp_servers.bare"], { url: "https://bare.example/mcp" });
  assert.deepEqual(config["mcp_servers." + BRIDGE], { url: "http://127.0.0.1:1/mcp/abc", http_headers: { Authorization: "Bearer s" }, tool_timeout_sec: 900 }, "a server from Settings can't take the bridge's name");
});

test("a turn starts a thread, streams the reply and its work, and reports what it used", async (t) => {
  const { provider, sent, dir } = setup(
    t,
    turns(({ server, threadId }) => {
      server.emit("item/started", { threadId, item: { type: "reasoning", id: "r1", summary: [], content: [] } });
      server.emit("item/reasoning/summaryTextDelta", { threadId, itemId: "r1", delta: "Looking", summaryIndex: 0 });
      server.emit("item/reasoning/summaryPartAdded", { threadId, itemId: "r1", summaryIndex: 1 });
      server.emit("item/reasoning/summaryTextDelta", { threadId, itemId: "r1", delta: "Found it", summaryIndex: 1 });
      server.emit("item/completed", { threadId, item: { type: "reasoning", id: "r1", summary: ["Looking", "Found it"], content: [] } });
      say(server, threadId, "m1", "Let me look.");
      server.emit("item/started", { threadId, item: { type: "commandExecution", id: "c1", command: "ls -la", cwd: "/work", status: "inProgress" } });
      server.emit("item/commandExecution/outputDelta", { threadId, itemId: "c1", delta: "a.txt\n" });
      server.emit("item/completed", { threadId, item: { type: "commandExecution", id: "c1", command: "ls -la", cwd: "/work", status: "completed", exitCode: 0, aggregatedOutput: "a.txt\n" } });
      server.emit("item/started", { threadId, item: { type: "mcpToolCall", id: "t1", server: BRIDGE, tool: "wiki_search", arguments: { query: "teal" }, status: "inProgress" } });
      server.emit("item/mcpToolCall/progress", { threadId, itemId: "t1", message: "Searching" });
      server.emit("item/completed", { threadId, item: { type: "mcpToolCall", id: "t1", server: BRIDGE, tool: "wiki_search", arguments: { query: "teal" }, status: "completed", result: { content: [{ type: "text", text: "2 pages" }] }, error: null } });
      server.emit("item/started", { threadId, item: { type: "mcpToolCall", id: "t2", server: "crm", tool: "find", arguments: {}, status: "inProgress" } });
      server.emit("item/completed", { threadId, item: { type: "mcpToolCall", id: "t2", server: "crm", tool: "find", arguments: {}, status: "failed", result: null, error: { message: "No such account" } } });
      server.emit("item/started", { threadId, item: { type: "fileChange", id: "f1", changes: [{ path: "/work/a.txt", kind: "update", diff: "-a\n+b" }], status: "inProgress" } });
      server.emit("item/completed", { threadId, item: { type: "fileChange", id: "f1", changes: [{ path: "/work/a.txt", kind: "update", diff: "-a\n+b" }], status: "declined" } });
      server.emit("turn/plan/updated", { threadId, plan: [{ step: "Look", status: "completed" }, { step: "Answer", status: "inProgress" }] });
      server.emit("thread/tokenUsage/updated", { threadId, tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 800, outputTokens: 300 }, last: { totalTokens: 900, inputTokens: 700, cachedInputTokens: 500, outputTokens: 200 }, modelContextWindow: 200000 } });
      say(server, threadId, "m2", "It is in a.txt.");
      server.emit("item/agentMessage/delta", { threadId: "someone-elses-thread", itemId: "m2", delta: "IGNORED" });
    }),
  );
  const session = await provider.openSession(spec({ mcpServers: { crm: { type: "http", url: "https://crm.example/mcp" } }, handlers: {}, tools: [defineTool("wiki_search", { description: "Search", parameters: { type: "object", properties: {} }, handler: () => "ok" })] }));
  assert.equal(sent("thread/start").length, 0, "opening a session starts nothing");
  const events = [];
  session.on((e) => events.push(e));
  const { text } = await session.send({ prompt: "Where is it?", attachments: [{ name: "pic.png", path: "/tmp/pic.png", kind: "file" }, { name: "notes.md", path: "/tmp/notes.md", kind: "file" }] });
  assert.equal(text, "Let me look.\n\nIt is in a.txt.", "the messages of a turn read as one reply");

  const [started] = sent("thread/start");
  assert.deepEqual(
    [started.model, started.cwd, started.approvalPolicy, started.sandbox, started.developerInstructions, started.serviceName, started.ephemeral],
    ["gpt-x", "/work", "untrusted", "read-only", "You are Pip.\nMemory: likes teal.", "botkins", undefined],
  );
  assert.deepEqual(Object.keys(started.config).sort(), ["mcp_servers." + BRIDGE, "mcp_servers.crm"]);
  assert.match(started.config["mcp_servers." + BRIDGE].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  const [turn] = sent("turn/start");
  assert.deepEqual(turn.input, [
    { type: "text", text: "Where is it?", text_elements: [] },
    { type: "localImage", path: "/tmp/pic.png" },
    { type: "mention", name: "notes.md", path: "/tmp/notes.md" },
  ]);
  assert.deepEqual([turn.model, turn.effort, turn.summary, turn.sandboxPolicy.type], ["gpt-x", "high", "auto", "readOnly"]);

  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  assert.equal(of("assistant.message_delta").map((d) => d.deltaContent).join(""), "Let me look.\n\nIt is in a.txt.");
  assert.deepEqual(of("assistant.reasoning_delta").map((d) => d.deltaContent), ["Looking", "\n\n", "Found it"]);
  assert.deepEqual(of("assistant.reasoning"), [{ reasoningId: "r1", content: "Looking\n\nFound it" }]);
  assert.deepEqual(of("tool.execution_start"), [
    { toolCallId: "c1", toolName: "shell", arguments: { command: "ls -la", cwd: "/work" } },
    { toolCallId: "t1", toolName: "wiki_search", arguments: { query: "teal" } },
    { toolCallId: "t2", toolName: "find", arguments: {}, mcpServerName: "crm", mcpToolName: "find" },
    { toolCallId: "f1", toolName: "apply_patch", arguments: { description: "/work/a.txt", changes: [{ path: "/work/a.txt", kind: "update" }] } },
  ]);
  assert.deepEqual(of("tool.shell_output"), [{ toolCallId: "c1", text: "a.txt\n" }]);
  assert.deepEqual(of("tool.execution_progress"), [{ toolCallId: "t1", progressMessage: "Searching" }]);
  assert.deepEqual(of("tool.execution_complete"), [
    { toolCallId: "c1", success: true, result: { content: "a.txt\n" } },
    { toolCallId: "t1", success: true, result: { content: "2 pages" } },
    { toolCallId: "t2", success: false, error: { message: "No such account" } },
    { toolCallId: "f1", success: false, result: { content: "-a\n+b" }, error: { message: "Not approved." } },
  ]);
  assert.deepEqual(await session.todos(), { rows: [{ id: "1", title: "Look", status: "completed" }, { id: "2", title: "Answer", status: "inProgress" }], dependencies: [] });
  assert.deepEqual(of("session.usage_info"), [{ currentTokens: 900, tokenLimit: 200000 }]);
  // The thread's first report is its total; what came before this turn's last call is the baseline.
  assert.deepEqual(of("assistant.usage"), [{ inputTokens: 700, outputTokens: 200, cacheReadTokens: 500, model: "gpt-x", duration: 1200 }]);
  assert.deepEqual(events.find((e) => e.type === "user.message").id, "turn-1", "the turn's id is its fork boundary");
  assert.deepEqual(await session.currentModel(), { model: "gpt-x", reasoningEffort: "high" });
  await session.close();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "codex", "sessions.json"), "utf8")), { "chat-1": { ref: "thread-1", turns: ["turn-1"] } });
});

test("a conversation resumes its thread, and one Codex has lost continues from Botkins' transcript", async (t) => {
  let lost = false;
  const play = turns(({ server, threadId }) => say(server, threadId, "m", "Hello"));
  const { provider, sent } = setup(t, (method, params, server) => {
    if (method === "thread/resume" && lost) throw new Error("no rollout found for thread id " + params.threadId);
    return play(method, params, server);
  });
  const first = await provider.openSession(spec());
  await first.send({ prompt: "Hi" });
  await first.close();
  const again = await provider.openSession(spec({ established: true, hasReplies: true }));
  // A model chosen mid-conversation rides with the next turn: a Codex thread takes its model per turn.
  await again.switchModel({ model: "gpt-y", provider: "codex" });
  await again.send({ prompt: "More" });
  await again.close();
  assert.deepEqual([sent("thread/start").length, sent("thread/resume").length], [1, 1]);
  assert.deepEqual([sent("thread/resume")[0].threadId, sent("thread/resume")[0].excludeTurns], ["thread-1", true]);
  assert.deepEqual([sent("turn/start")[1].model, sent("turn/start")[1].effort], ["gpt-y", null]);
  assert.deepEqual(provider.sessions.get("chat-1").turns, ["turn-1", "turn-2"]);

  lost = true;
  const history = [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello" }, { role: "user", text: "Still there?" }];
  const recovered = await provider.openSession(spec({ established: true, hasReplies: true, history: () => history }));
  await recovered.send({ prompt: "Still there?" });
  const restart = sent("thread/start")[1];
  assert.match(restart.developerInstructions, /<earlier-conversation>[\s\S]*User: Hi[\s\S]*Assistant: Hello/);
  assert.doesNotMatch(restart.developerInstructions, /Still there/);
  assert.equal(provider.sessions.get("chat-1").ref, "thread-2", "the new thread takes the conversation's place");
  await recovered.close();
  // Any other failure to resume is reported, not papered over with a new thread.
  lost = false;
  const broken = setup(t, (method) => {
    if (method === "thread/resume") throw new Error("rate limit exceeded");
    return { thread: { id: "x" } };
  });
  broken.provider.sessions.set("chat-1", { ref: "thread-9", turns: [] });
  await assert.rejects((await broken.provider.openSession(spec({ established: true, hasReplies: true }))).send({ prompt: "Hi" }), /rate limit/);
});

test("what Codex asks of the person goes through the turn's handlers", async (t) => {
  const asked = [];
  let allow = true;
  const handlers = {
    permission: async (request) => (asked.push(request), { allow }),
    question: async (request) => (asked.push(request), { answer: request.choices[1] ?? "typed" }),
    form: async (request) => (asked.push(request), { action: "accept", content: { ok: true } }),
  };
  const replies = [];
  const { provider } = setup(
    t,
    turns(async ({ server, threadId }) => {
      server.emit("item/started", { threadId, item: { type: "commandExecution", id: "c1", command: "rm -rf build", cwd: "/work", status: "inProgress" } });
      replies.push(await server.ask("item/commandExecution/requestApproval", { threadId, itemId: "c1", reason: "Needs to delete files" }));
      server.emit("item/started", { threadId, item: { type: "fileChange", id: "f1", changes: [{ path: "/work/a.txt", kind: "update", diff: "-a\n+b" }], status: "inProgress" } });
      replies.push(await server.ask("item/fileChange/requestApproval", { threadId, itemId: "f1" }));
      replies.push(await server.ask("item/permissions/requestApproval", { threadId, itemId: "p1", reason: "Network", permissions: { network: { enabled: true }, fileSystem: null } }));
      replies.push(await server.ask("item/tool/requestUserInput", { threadId, itemId: "q1", questions: [{ id: "audience", header: "Audience", question: "Who is it for?", isOther: false, options: [{ label: "Team" }, { label: "Everyone" }] }] }));
      replies.push(await server.ask("mcpServer/elicitation/request", { threadId, serverName: "crm", mode: "form", message: "Which region?", requestedSchema: { properties: {} }, _meta: null }));
      // Codex asks before an MCP tool call; Botkins' own tools never ask, other servers do.
      replies.push(await server.ask("mcpServer/elicitation/request", { threadId, serverName: BRIDGE, mode: "form", message: "Call?", requestedSchema: {}, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "wiki_write" } }));
      replies.push(await server.ask("mcpServer/elicitation/request", { threadId, serverName: "crm", mode: "form", message: "Call?", requestedSchema: {}, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "delete_account", tool_params: { id: 7 } } }));
      allow = false;
      replies.push(await server.ask("item/commandExecution/requestApproval", { threadId, itemId: "c1", command: "curl example.com", networkApprovalContext: { host: "example.com" } }));
      replies.push(await server.ask("item/permissions/requestApproval", { threadId, itemId: "p2", permissions: { network: { enabled: true } } }));
      say(server, threadId, "m", "Done");
    }),
  );
  const session = await provider.openSession(spec({ handlers }));
  await session.send({ prompt: "Go" });
  assert.deepEqual(replies, [
    { decision: "accept" },
    { decision: "accept" },
    { permissions: { network: { enabled: true } }, scope: "turn" },
    { answers: { audience: { answers: ["Everyone"] } } },
    { action: "accept", content: { ok: true }, _meta: null },
    { action: "accept", content: {}, _meta: null },
    { action: "accept", content: {}, _meta: null },
    { decision: "decline" },
    { permissions: {}, scope: "turn" },
  ]);
  const [command, file, more, question, form, mcp, network] = asked;
  assert.deepEqual([command.kind, command.label, command.preview, command.title, command.remember, command.sandboxEscape], ["shell", "Shell command", "rm -rf build", "Needs to delete files", ["this exact command", "rm -rf build"], false]);
  assert.deepEqual([file.kind, file.label, file.preview, file.remember], ["write", "/work/a.txt", "-a\n+b", ["writes to this path", "/work/a.txt"]]);
  assert.deepEqual([more.kind, more.sandboxEscape, more.remember], ["permissions", true, null], "more access is never remembered");
  assert.deepEqual(question, { question: "Audience: Who is it for?", choices: ["Team", "Everyone"], allowFreeform: false });
  assert.deepEqual([form.message, form.mode], ["Which region?", "form"]);
  assert.deepEqual([mcp.kind, mcp.label, mcp.remember], ["mcp", "crm / delete_account", ["MCP tool crm/delete_account", "crm", "delete_account"]]);
  assert.equal(network.sandboxEscape, true, "a command that wants the network asks even in a chat that allows the rest");
  assert.equal(asked.length, 8, "the bridge's own tool was approved without asking");
  await session.close();

  // Between turns (a session opened only to look) nothing is approved.
  const idle = await provider.openSession(spec({ sessionId: "chat-2" }));
  assert.deepEqual(await idle.requested("item/commandExecution/requestApproval", {}), { decision: "decline" });
  assert.deepEqual(await idle.requested("item/permissions/requestApproval", {}), { permissions: {}, scope: "turn" });
  assert.deepEqual(await idle.requested("mcpServer/elicitation/request", {}), { action: "cancel", content: null, _meta: null });
});

test("a turn can fail, be stopped, or be planned without touching anything", async (t) => {
  let outcome = "failed";
  const { provider, sent, server } = setup(
    t,
    turns(async ({ server, threadId }) => {
      if (outcome === "failed") {
        server.emit("error", { threadId, willRetry: true, error: { message: "Retrying" } });
        server.emit("error", { threadId, willRetry: false, error: { message: "You've hit your usage limit." } });
        return { error: null };
      }
      if (outcome === "interrupted") {
        say(server, threadId, "m", "Half an ans");
        await new Promise((resolve) => (server.release = resolve));
        return "interrupted";
      }
      say(server, threadId, "m", "A plan");
    }),
  );
  const session = await provider.openSession(spec());
  await assert.rejects(session.send({ prompt: "Go" }), /usage limit/);
  outcome = "interrupted";
  const stopped = session.send({ prompt: "Go" });
  // The stand-in server takes the turn at its own pace, and only then is there something to release.
  // So wait until it holds the turn, not for a fixed time (a slow runner was not there after 20 ms).
  await until(() => typeof server.release === "function", "the stand-in server holds the turn");
  await assert.rejects(session.send({ prompt: "Again" }), /already working/);
  await session.abort();
  assert.deepEqual(sent("turn/interrupt"), [{ threadId: "thread-1", turnId: "turn-2" }]);
  server.release();
  assert.deepEqual(await stopped, { text: "Half an ans" }, "a stopped turn keeps what was written");
  // Plan mode: the read-only sandbox whatever the approval level, and the model is told.
  outcome = "ok";
  const yolo = await provider.openSession(spec({ sessionId: "chat-2", approval: "all" }));
  assert.equal(await yolo.setMode("plan"), true);
  await yolo.send({ prompt: "Refactor it" });
  const planned = sent("turn/start").at(-1);
  assert.equal(planned.sandboxPolicy.type, "readOnly");
  assert.match(planned.input[0].text, /^Plan mode: do not change any file[\s\S]*Refactor it$/);
  await yolo.setMode("interactive");
  await yolo.send({ prompt: "Do it" });
  assert.deepEqual([sent("turn/start").at(-1).sandboxPolicy.type, sent("turn/start").at(-1).input[0].text], ["dangerFullAccess", "Do it"]);
  await yolo.compact();
  assert.deepEqual(sent("thread/compact/start"), [{ threadId: "thread-2" }]);
});

test("a fork stops before the chosen turn, a side question never joins the conversation, and delete forgets the thread", async (t) => {
  const { provider, sent } = setup(t, turns(({ server, threadId, params }) => say(server, threadId, "m", "Reply to " + params.input[0].text)));
  const session = await provider.openSession(spec());
  await session.send({ prompt: "one" });
  await session.send({ prompt: "two" });
  await session.send({ prompt: "three" });
  assert.equal(await session.sideQuestion("Why?"), "Reply to Why?");
  const fork = sent("thread/fork")[0];
  assert.deepEqual([fork.threadId, fork.ephemeral, fork.sandbox], ["thread-1", true, "read-only"]);
  assert.deepEqual(provider.sessions.get("chat-1").turns, ["turn-1", "turn-2", "turn-3"], "the side question left no turn behind");
  await session.close();

  const copy = await provider.forkSession("chat-1", { toEventId: "turn-3" });
  assert.deepEqual(sent("thread/fork")[1], { threadId: "thread-1", excludeTurns: true, lastTurnId: "turn-2" }, "Codex forks through a turn, so the copy runs through the one before");
  assert.deepEqual(provider.sessions.get(copy), { ref: "thread-3", turns: ["turn-1", "turn-2"] });
  assert.deepEqual(sent("thread/unsubscribe").at(-1), { threadId: "thread-3" }, "Codex loads the copy without Botkins' tools; it is let go so its first turn loads it with them");
  const whole = await provider.forkSession("chat-1");
  assert.equal(sent("thread/fork")[2].lastTurnId, undefined);
  assert.equal(provider.sessions.get(whole).turns.length, 3);
  assert.equal(await provider.forkSession("chat-1", { toEventId: "turn-1" }), null, "nothing comes before the first turn: Botkins forks from its transcript");
  assert.equal(await provider.forkSession("unknown"), null);

  await provider.deleteSession("chat-1");
  assert.deepEqual(sent("thread/delete"), [{ threadId: "thread-1" }]);
  assert.equal(provider.sessions.get("chat-1"), undefined);
  await provider.deleteSession("chat-1");
  assert.equal(sent("thread/delete").length, 1, "a session Codex never had is fine to delete");
});

test("the slash menu lists Botkins' tools and a running thread's MCP servers", async (t) => {
  const { provider, sent } = setup(t, (method, params, server) => {
    if (method === "mcpServerStatus/list")
      return {
        data: [
          { name: BRIDGE, tools: { x: { name: "x" } }, authStatus: "unsupported", runtimeStatus: "connected" },
          { name: "crm", tools: { find: { name: "find", description: "Finds an account" } }, authStatus: "bearerToken", runtimeStatus: "connected", toolsError: null },
          { name: "mail", tools: {}, authStatus: "notLoggedIn", runtimeStatus: "connected", toolsError: null },
          { name: "from-the-persons-own-codex-config", tools: {}, authStatus: "unsupported" },
        ],
        nextCursor: null,
      };
    return turns(() => {})(method, params, server);
  });
  const servers = { crm: { type: "http", url: "https://crm.example" }, mail: { type: "http", url: "https://mail.example" }, down: { type: "stdio", command: "nope" } };
  const tools = [defineTool("today_publish", { description: "Publish", parameters: { type: "object", properties: {} }, handler: () => "ok" })];
  // A session that hasn't run (a menu) starts nothing; its servers are simply not started.
  const menu = await provider.openSession(spec({ mcpServers: servers, tools }));
  const idle = await menu.inventory();
  assert.deepEqual(idle.servers, [{ name: "crm", status: "not started" }, { name: "mail", status: "not started" }, { name: "down", status: "not started" }]);
  assert.ok(idle.choices.some((c) => c.command === "tool:today_publish"));
  assert.ok(idle.choices.some((c) => c.command === "compact"));
  assert.equal(sent("thread/start").length, 0);
  // A test of a server (a temporary session) starts a thread and asks Codex what it connected.
  const probe = await provider.openSession(spec({ sessionId: "probe", temporary: true, mcpServers: servers, tools }));
  const found = await probe.inventory();
  assert.equal(sent("thread/start")[0].ephemeral, true);
  assert.deepEqual(found.servers, [{ name: "crm", status: "connected" }, { name: "mail", status: "needs-auth" }, { name: "down", status: "failed" }]);
  assert.deepEqual(found.choices.filter((c) => c.source === "crm").map((c) => c.command), ["tool:find"]);
  assert.equal(provider.sessions.get("probe"), undefined, "a temporary session leaves no record");
});

test("a chat on a ChatGPT model runs through the workspace with Botkins' tools on the bridge", async (t) => {
  const dir = tempDir(t);
  const copilot = new CopilotProvider({ connect: fakeClient().client });
  let called;
  const bridges = new Map();
  const bridgeOf = (threadId) => bridges.get(threadId);
  const { provider, bridge, sent } = setup(
    t,
    (method, params, server) => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "ada@example.com", planType: "pro" }, requiresOpenaiAuth: true };
      if (method === "model/list") return { data: [{ id: "gpt-x", model: "gpt-x", displayName: "GPT X", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }], nextCursor: null };
      if (method === "thread/resume") bridges.set(params.threadId, params.config["mcp_servers." + BRIDGE]);
      if (method === "thread/start") {
        const started = turns(() => {})(method, params, server);
        bridges.set(started.thread.id, params.config["mcp_servers." + BRIDGE]);
        return started;
      }
      return turns(async ({ server, threadId }) => {
        // Codex calls one of Botkins' tools the way it really does: over MCP, at the bridge
        // address the thread was last started or resumed with.
        const { url, http_headers } = bridgeOf(threadId);
        const call = (body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...http_headers }, body: JSON.stringify(body) }).then((r) => r.json());
        const listed = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        server.emit("item/started", { threadId, item: { type: "mcpToolCall", id: "t1", server: BRIDGE, tool: "memory_read", arguments: {}, status: "inProgress" } });
        called = { names: listed.result.tools.map((x) => x.name), result: await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_read", arguments: {} } }) };
        server.emit("item/completed", { threadId, item: { type: "mcpToolCall", id: "t1", server: BRIDGE, tool: "memory_read", arguments: {}, status: "completed", result: called.result.result, error: null } });
        say(server, threadId, "m", "Noted.");
      })(method, params, server);
    },
    { dir },
  );
  t.after(() => copilot.stop());
  const ws = new Workspace(join(dir, "data"), new Providers([copilot, provider]), () => {});
  // This is Codex running its own chats (Settings › General › Harness: Provider default).
  ws.setPreferences({ harness: "provider" });
  assert.deepEqual((await ws.models()).filter((m) => m.provider === "codex").map((m) => [m.id, m.providerName, m.recommended]), [["gpt-x", "ChatGPT", true]]);
  const id = ws.createChat("pip");
  await ws.setModel("chat", id, { model: "gpt-x", provider: "codex", reasoningEffort: "low" });
  await ws.send(id, "Remember that I like teal");
  const chat = ws.chat(id);
  assert.deepEqual(chat.messages.map((m) => [m.role, m.text]), [["user", "Remember that I like teal"], ["assistant", "Noted."]]);
  assert.equal(chat.sessionProvider, "codex");
  const run = ws.state.runs.find((r) => r.chatId === id);
  assert.equal(run.status, "Completed");
  assert.deepEqual(run.steps.map((s) => [s.name, s.source, s.status]), [["memory_read", undefined, "Done"]], "Botkins' own tool is shown as its own, not as an MCP server's");
  assert.ok(called.names.includes("memory_read") && called.names.includes("wiki_search"), "the bot's tools were offered over the bridge");
  // Botkins' skills come along: named in the instructions, read through a tool.
  assert.ok(called.names.includes("skill_read"));
  assert.match(sent("thread/start")[0].developerInstructions, /Your skills:\n- today-panel: /);
  assert.equal(called.result.result.isError, undefined);
  assert.match(sent("thread/start")[0].developerInstructions, /Pip/);
  assert.equal(run.eventId, "turn-1");
  // Between turns the conversation keeps its bridge address, but there is no tool behind it.
  const { url, http_headers } = sent("thread/start")[0].config["mcp_servers." + BRIDGE];
  const late = (body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...http_headers }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.deepEqual((await late({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools, []);
  assert.equal((await late({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_read", arguments: {} } })).result.isError, true);
  // The next message goes to the thread Codex still has loaded, at the same bridge address:
  // a loaded thread would not learn of a new one.
  await ws.send(id, "And green");
  assert.deepEqual([sent("thread/start").length, sent("thread/resume").length, sent("thread/unsubscribe").length], [1, 1, 0]);
  assert.equal(sent("thread/resume")[0].config["mcp_servers." + BRIDGE].url, url);
  assert.deepEqual(ws.state.runs.filter((r) => r.chatId === id).map((r) => r.status), ["Completed", "Completed"]);
  // The bot's instructions changed: the thread is unloaded so the next turn loads it with them.
  ws.updateBot("pip", { instructions: "Always answer in rhyme." });
  await ws.send(id, "And blue");
  assert.deepEqual(sent("thread/unsubscribe"), [{ threadId: "thread-1" }]);
  assert.match(sent("thread/resume")[1].developerInstructions, /Always answer in rhyme\./);
  // Deleting the chat forgets the thread and closes the address for good.
  await ws.agents.deleteChat(id);
  await tick(20);
  assert.deepEqual(sent("thread/delete"), [{ threadId: "thread-1" }]);
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...http_headers }, body: "{}" })).status, 401);
  assert.equal(bridge.endpoints.size, 0);
  assert.ok(existsSync(join(dir, "codex", "sessions.json")));
});

test("a thread stays loaded for the next message and is unloaded when it is let go", async (t) => {
  const { provider, sent } = setup(t, turns(({ server, threadId }) => say(server, threadId, "m", "ok")));
  provider.maxWarm = 2;
  const run = async (sessionId, over = {}) => {
    const session = await provider.openSession(spec({ sessionId, established: !!provider.sessions.get(sessionId), ...over }));
    await session.send({ prompt: "Hi" });
    await session.close(over.close);
    return session;
  };
  await run("a");
  await run("a");
  assert.deepEqual([...provider.loaded.keys()], ["thread-1"], "the thread is still loaded after its turn");
  assert.equal(sent("thread/unsubscribe").length, 0);
  // Settings from Settings › MCP servers changed: Codex only reads them when it loads the thread.
  await run("a", { mcpServers: { crm: { type: "http", url: "https://crm.example/mcp" } } });
  assert.deepEqual(sent("thread/unsubscribe"), [{ threadId: "thread-1" }]);
  assert.ok("mcp_servers.crm" in sent("thread/resume").at(-1).config);
  // Only the most recently used conversations stay loaded.
  await run("b");
  await run("c");
  assert.deepEqual([...provider.loaded.keys()].sort(), ["thread-2", "thread-3"]);
  assert.deepEqual(sent("thread/unsubscribe").at(-1), { threadId: "thread-1" });
  // The workspace lets a bot's sessions go when its memory changes; a failed turn's session is discarded.
  await provider.releaseSession("b");
  assert.deepEqual([...provider.loaded.keys()], ["thread-3"]);
  await run("c", { close: { discard: true } });
  assert.deepEqual([...provider.loaded.keys()], []);
  // A session in a turn is let go when the turn ends.
  const busy = await provider.openSession(spec({ sessionId: "d" }));
  await busy.send({ prompt: "Hi" });
  await provider.releaseSessions({ busy: true });
  assert.equal(provider.loaded.size, 1, "a thread in use is not unloaded under its turn");
  await busy.close();
  assert.equal(provider.loaded.size, 0);
  // With no keeping warm, every turn's thread is unloaded at once.
  provider.keepWarmMs = 0;
  await run("e");
  assert.equal(provider.loaded.size, 0);
});

test("a ChatGPT turn that is quiet for hours is not given up on; it ends when Codex says the thread is gone, or when it is stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let state = "active";
  const play = turns(async ({ server, threadId }) => {
    say(server, threadId, "m", "Working");
    await new Promise((resolve) => (release = resolve));
  });
  const { provider, sent } = setup(t, (method, params, server) => {
    if (method === "thread/read") {
      if (state === "missing") throw Object.assign(new Error("thread not found: " + params.threadId), { code: -32600 });
      if (state === "flaky") throw new Error("Internal error");
      return { thread: { id: params.threadId, status: { type: state } } };
    }
    // Codex ends an interrupted turn.
    if (method === "turn/interrupt") release?.();
    return play(method, params, server);
  });
  const session = await provider.openSession(spec());
  const quiet = async (message) => {
    release = undefined;
    const sending = watching(session.send({ prompt: message }));
    await soon(() => release, "the turn is quiet");
    await pass(t, 3 * 60 * 60 * 1000);
    return sending;
  };
  // Alive, and Codex's answer to the check is odd once: no news, and the turn goes on.
  state = "flaky";
  const first = await quiet("One");
  assert.equal(first.seen.state, "pending", "three hours of silence did not end the turn");
  assert.ok(sent("thread/read").length > 10, "Codex was asked whether it still runs the turn");
  state = "active";
  await pass(t, 10 * 60 * 1000);
  assert.equal(first.seen.state, "pending");
  release();
  await first.done;
  assert.deepEqual(first.seen.value, { text: "Working" });
  // Codex says the thread is idle although the turn never completed: it is gone.
  state = "idle";
  const idle = await quiet("Two");
  await idle.done;
  assert.equal(idle.seen.value.code, "BOTKINS_SESSION_LOST");
  assert.match(idle.seen.value.message, /stopped working on this reply/);
  assert.deepEqual(sent("turn/interrupt").at(-1), { threadId: "thread-1", turnId: "turn-2" }, "what Codex may still run is stopped");
  // Codex no longer has the thread.
  state = "missing";
  const missing = await quiet("Three");
  await missing.done;
  assert.equal(missing.seen.value.code, "BOTKINS_SESSION_LOST");
  // Stop ends a quiet turn.
  state = "active";
  const stopping = await quiet("Four");
  await session.abort();
  await stopping.done;
  assert.equal(stopping.seen.state, "done");
  assert.deepEqual(sent("turn/interrupt").at(-1), { threadId: "thread-1", turnId: "turn-4" });
});

test("a caller that names a time limit gets it from Codex", async (t) => {
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const { provider } = setup(t, turns(() => new Promise(() => {})));
  const session = await provider.openSession(spec());
  await assert.rejects(session.send({ prompt: "Summarize" }, 40), (error) => error.code === "BOTKINS_TURN_TIMEOUT");
});

test("Stop reaches a turn that hasn't started yet, and a turn nobody waits for is not left running", async (t) => {
  // The provider's own timers never keep a process alive; this test waits on one, so it keeps the loop running itself.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  let release;
  const play = turns(async ({ server, threadId }) => {
    say(server, threadId, "m", "Working");
    await new Promise((resolve) => (release = resolve));
  });
  let hold;
  const { provider, sent } = setup(t, async (method, params, server) => {
    // The thread takes a moment to start, as a resume or a slow CLI does.
    if (method === "thread/start") await new Promise((resolve) => (hold = resolve));
    return play(method, params, server);
  });
  // Stop while the thread is still starting: the turn never begins.
  const early = await provider.openSession(spec({ approval: "all" }));
  const sending = early.send({ prompt: "Delete everything" });
  await until(() => typeof hold === "function", "the thread is starting");
  await early.abort();
  hold();
  assert.deepEqual(await sending, { text: "" });
  assert.equal(sent("turn/start").length, 0, "nothing ran after Stop");
  // The next message in the same session is not affected by the earlier Stop.
  const second = early.send({ prompt: "Hi" });
  await until(() => typeof release === "function", "the stand-in server holds the turn");
  assert.equal(sent("turn/start").length, 1);
  // A turn that times out on Botkins' side is interrupted at Codex.
  await assert.rejects(early.send({ prompt: "Again" }), /already working/);
  release();
  await second;
  const slow = early.send({ prompt: "Slow" }, 30);
  await assert.rejects(slow, /didn't finish in time/);
  assert.deepEqual(sent("turn/interrupt").at(-1), { threadId: "thread-1", turnId: "turn-2" });
  release();
  // Closing a session whose turn is still running interrupts it, and a session closed while its thread starts is not left attached.
  const third = early.send({ prompt: "Third" });
  const closed = assert.rejects(third, /closed/);
  await tick(20);
  await early.close();
  await closed;
  assert.deepEqual(sent("turn/interrupt").at(-1), { threadId: "thread-1", turnId: "turn-3" });
  release();
  const late = await provider.openSession(spec({ sessionId: "chat-9" }));
  const starting = late.send({ prompt: "Hi" });
  const refused = assert.rejects(starting, /closed/);
  await tick(10);
  await late.close();
  hold();
  await refused;
  assert.equal(provider.threads.size, 0);
  assert.deepEqual([...provider.loaded.keys()], ["thread-1"], "only the first conversation's thread stays loaded; the one closed while starting was let go");
  assert.deepEqual(sent("thread/unsubscribe").at(-1), { threadId: "thread-2" });
});

test("an app-server that starts but won't shake hands is closed, not left running", async (t) => {
  let closed = 0;
  const bridge = new ToolBridge();
  t.after(() => bridge.stop());
  const provider = new CodexProvider({
    bridge,
    spawn: async () => ({
      exited: new Promise(() => {}),
      onNotification: () => () => {},
      onRequest: () => {},
      notify: () => {},
      request: async () => {
        throw new Error("The model provider didn't answer in time (initialize).");
      },
      close: async () => void closed++,
    }),
  });
  await assert.rejects(provider.status(), /didn't answer in time/);
  await assert.rejects(provider.models(), /didn't answer in time/);
  assert.equal(closed, 2, "each failed start closes the process it started");
});

// What the model list says about each model's window and abilities.
const LISTING = [
  {
    id: "a",
    model: "gpt-a",
    displayName: "GPT A",
    description: "The big one",
    hidden: false,
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast replies" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh", description: "  " }],
    defaultReasoningEffort: "low",
  },
  { id: "b", model: "gpt-b", displayName: "GPT B", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: [] },
  { id: "c", model: "gpt-c", displayName: "GPT C", hidden: false, supportedReasoningEfforts: [] },
];
const listing = (data = LISTING) => (method) => (method === "model/list" ? { data, nextCursor: null } : {});
const catalogIn = (home, models) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "models_cache.json"), typeof models === "string" ? models : JSON.stringify({ fetched_at: "2026-01-01T00:00:00Z", models }));
};
const byId = (list, id) => list.find((m) => m.id === id);

test("a model's window and prompt limit come from the models_cache.json in Codex's home", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, [{ slug: "gpt-a", context_window: 272000, effective_context_window_percent: 95 }, { slug: "gpt-b", context_window: 128000 }]);
  const { provider } = setup(t, listing(), { home });
  const list = await provider.models();
  assert.deepEqual([byId(list, "gpt-a").contextWindow, byId(list, "gpt-a").maxPrompt], [272000, 258400], "the prompt limit is the window times the share Codex fills");
  assert.equal(byId(list, "gpt-b").contextWindow, 128000);
  assert.equal("maxPrompt" in byId(list, "gpt-b"), false, "no share said, no prompt limit");
});

test("a share of the window that is not between none and all gives no prompt limit", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, [{ slug: "gpt-a", context_window: 1000, effective_context_window_percent: 100 }, { slug: "gpt-b", context_window: 1000, effective_context_window_percent: 0 }, { slug: "gpt-c", context_window: 1000, effective_context_window_percent: "95" }]);
  const { provider } = setup(t, listing(), { home });
  const list = await provider.models();
  assert.deepEqual(list.map((m) => [m.contextWindow, "maxPrompt" in m]), [[1000, false], [1000, false], [1000, false]]);
});

test("a model's prompt limit is rounded down to a whole number of tokens", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, [{ slug: "gpt-a", context_window: 1001, effective_context_window_percent: 95 }]);
  const { provider } = setup(t, listing(), { home });
  assert.equal(byId(await provider.models(), "gpt-a").maxPrompt, 950);
});

test("a model that takes images is marked for vision, one that does not is marked without, one that says nothing has no mark", async (t) => {
  const { provider } = setup(t, listing());
  const list = await provider.models();
  assert.equal(byId(list, "gpt-a").vision, true);
  assert.equal(byId(list, "gpt-b").vision, false);
  assert.equal("vision" in byId(list, "gpt-c"), false);
});

test("each thinking level that has a description gets it as a note, and the others get none", async (t) => {
  const { provider } = setup(t, listing());
  const list = await provider.models();
  assert.deepEqual(byId(list, "gpt-a").effortNotes, { low: "Fast replies" });
  assert.equal("effortNotes" in byId(list, "gpt-b"), false, "a model with no levels has no notes");
});

test("a model carries Codex's own line about it and is marked as one that calls tools", async (t) => {
  const { provider } = setup(t, listing());
  const list = await provider.models();
  assert.deepEqual([byId(list, "gpt-a").description, byId(list, "gpt-a").tools], ["The big one", true]);
  assert.equal("description" in byId(list, "gpt-b"), false);
});

test("a home without a models_cache.json gives no window", async (t) => {
  const home = join(tempDir(t), "empty-home");
  mkdirSync(home, { recursive: true });
  const { provider } = setup(t, listing(), { home });
  const list = await provider.models();
  assert.equal(list.some((m) => "contextWindow" in m || "maxPrompt" in m), false);
});

test("a models_cache.json that is not JSON gives no window", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, "{ not json at all");
  const { provider } = setup(t, listing(), { home });
  assert.equal((await provider.models()).some((m) => "contextWindow" in m), false);
  assert.deepEqual(provider.catalogLimits(), {});
});

test("a models_cache.json with something other than a list of models gives no window", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, JSON.stringify({ models: "none" }));
  const { provider } = setup(t, listing(), { home });
  assert.deepEqual(provider.catalogLimits(), {});
});

test("a model the models_cache.json does not have gives no window, and entries without a real window are skipped", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, [{ slug: "gpt-a", context_window: 272000 }, { slug: "gpt-b", context_window: 0 }, { slug: "gpt-c", context_window: "big" }, { context_window: 5000 }, null]);
  const { provider } = setup(t, listing(), { home });
  const list = await provider.models();
  assert.equal(byId(list, "gpt-a").contextWindow, 272000);
  assert.equal("contextWindow" in byId(list, "gpt-b"), false);
  assert.equal("contextWindow" in byId(list, "gpt-c"), false);
});

test("a provider made without a home reads no catalog, whatever CODEX_HOME says", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, [{ slug: "gpt-a", context_window: 272000 }]);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => (before === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = before)));
  const { provider } = setup(t, listing());
  assert.equal(provider.home, null);
  assert.deepEqual(provider.catalogLimits(), {});
  assert.equal("contextWindow" in byId(await provider.models(), "gpt-a"), false);
});

const TURN_MODELS = [{ id: "x", model: "gpt-x", displayName: "GPT X", hidden: false, supportedReasoningEfforts: [] }, { id: "y", model: "gpt-y", displayName: "GPT Y", hidden: false, supportedReasoningEfforts: [] }];
/** A provider that runs one turn on `gpt-x`, in which Codex reports a window of `window` tokens. */
const runTurnWithWindow = async (t, window, options = {}) => {
  const made = setup(
    t,
    (method, params, server) => (method === "model/list" ? { data: [...TURN_MODELS], nextCursor: null } : turns(({ server: s, threadId }) => {
      s.emit("thread/tokenUsage/updated", { threadId, tokenUsage: { total: { totalTokens: 10 }, last: { totalTokens: 10 }, modelContextWindow: window } });
      say(s, threadId, "m1", "Hi.");
    })(method, params, server)),
    options,
  );
  const session = await made.provider.openSession(spec());
  await session.send({ prompt: "Hello" });
  await session.close();
  return made;
};

test("the window Codex reports in a turn is listed for that model when the catalog file does not have it", async (t) => {
  const { provider } = await runTurnWithWindow(t, 200000);
  const list = await provider.models();
  assert.equal(byId(list, "gpt-x").contextWindow, 200000);
  assert.equal("maxPrompt" in byId(list, "gpt-x"), false);
  assert.equal("contextWindow" in byId(list, "gpt-y"), false, "a model that has not run has none");
});

test("the window Codex reports in a turn is kept for a new provider on the same folder", async (t) => {
  const dir = tempDir(t);
  await runTurnWithWindow(t, 200000, { dir });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "codex", "model-limits.json"), "utf8")), { "gpt-x": { contextWindow: 200000 } });
  const later = setup(t, listing(TURN_MODELS), { dir });
  assert.equal(byId(await later.provider.models(), "gpt-x").contextWindow, 200000);
});

test("the catalog file's window wins over the one Codex reported in a turn", async (t) => {
  const home = join(tempDir(t), "codex-home");
  catalogIn(home, [{ slug: "gpt-x", context_window: 272000, effective_context_window_percent: 95 }]);
  const { provider } = await runTurnWithWindow(t, 200000, { home });
  const model = byId(await provider.models(), "gpt-x");
  assert.deepEqual([model.contextWindow, model.maxPrompt], [272000, 258400]);
});

test("the ChatGPT plan's limits come from Codex's app server, and an API key has none", async (t) => {
  let account = { type: "chatgpt", email: "ada@example.com", planType: "prolite", workspaceName: null };
  const limit = { limitId: "codex", limitName: null, primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1795630138 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "120.5000" }, planType: "prolite" };
  const { provider, sent } = setup(t, (method) => {
    if (method === "account/read") return { account, userId: "user-sample", requiresOpenaiAuth: true };
    if (method === "account/rateLimits/read") return { ordinaryUsageAllowed: true, rateLimits: limit, rateLimitsByLimitId: { codex: limit }, accountId: "00000000-0000-4000-8000-000000000000" };
    return {};
  });
  const usage = await provider.usage();
  assert.deepEqual(usage, {
    account: "subscription",
    limits: [{ id: "weekly", label: "Weekly", window: "week", percentUsed: 8, resetAt: 1795630138000 }],
    credits: { label: "Credits", amount: 120.5, unit: "credits" },
    plan: "ChatGPT Pro",
    source: "Codex",
  });
  assert.ok(!/ada@|user-sample|00000000/.test(JSON.stringify(usage)), "nothing that names the account is in the answer");
  account = { type: "apiKey" };
  assert.deepEqual(await provider.usage(), { account: "api-key", limits: [], source: "Codex" });
  assert.equal(sent("account/rateLimits/read").length, 1, "an API key isn't asked about plan limits");
  account = null;
  await assert.rejects(provider.usage(), /isn't signed in/);
});

test("recovery attaches to the original live Codex turn without starting a second one", async (t) => {
  const { provider, sent } = setup(t, (method, params, server) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/read") {
      setImmediate(() => {
        say(server, params.threadId, "message-2", "Finished");
        server.emit("turn/completed", { threadId: params.threadId, turn: { id: "active", status: "completed" } });
      });
      return { thread: { turns: [{ id: "active", status: "inProgress", items: [{ type: "agentMessage", id: "message-1", text: "Checking" }] }] } };
    }
    return {};
  });
  provider.sessions.set("chat-1", { ref: "thread-1", turns: ["active"] });
  const session = await provider.openSession(spec({ established: true }));
  let sentSteer;
  assert.equal(await session.completedReply("active", steer => { sentSteer = steer({ prompt: "Focus on the error" }); }), "Checking\n\nFinished");
  assert.equal(await sentSteer, true);
  assert.equal(sent("turn/steer")[0].expectedTurnId, "active");
  assert.equal(sent("turn/start").length, 0);
  await session.close();
});

test("fast mode uses the account's model-specific service tier and skips unsupported speeds", async (t) => {
  const normal = turns(() => {});
  const { provider, sent } = setup(t, (method, params, server) => method === "model/list"
    ? { data: [{ model: "gpt-x", serviceTiers: [{ id: "priority", name: "Fast" }, { id: "premium", name: "Ultra Fast" }] }] }
    : normal(method, params, server));
  for (const [model, fastMode, expected] of [["gpt-x", "fast", "priority"], ["gpt-x", "ultrafast", "premium"], ["other", "ultrafast", null]]) {
    const session = await provider.openSession(spec({ model: { model, fastMode } }));
    await session.send({ prompt: "Hello" }, 2000);
    assert.equal(sent("turn/start").at(-1).serviceTier, expected);
    await session.close();
  }
});

test("a tier rejected at turn start falls back once before the prompt is accepted", async (t) => {
  const normal = turns(() => {});
  const { provider, sent } = setup(t, (method, params, server) => {
    if (method === "model/list") return { data: [{ model: "gpt-x", additionalSpeedTiers: ["fast"] }] };
    if (method === "turn/start" && params.serviceTier) throw new Error("Service tier not available for this model");
    return normal(method, params, server);
  });
  const session = await provider.openSession(spec({ model: { model: "gpt-x", fastMode: "fast" } }));
  await session.send({ prompt: "Hello" }, 2000);
  assert.deepEqual(sent("turn/start").map((p) => p.serviceTier), ["priority", null]);
});
