import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventory } from "../desktop/providers/copilot/commands.mjs";
import { decide } from "../desktop/providers/copilot/permissions.mjs";
import { Workspace } from "./starter.mjs";

const commands = [
  {
    name: "model",
    aliases: ["models"],
    kind: "builtin",
    description: "Choose model",
  },
  { name: "fresh-command", kind: "client", description: "From an extension" },
  { name: "fleet", kind: "builtin", description: "Run in fleet mode" },
  {
    name: "sample",
    kind: "skill",
    description: "Skill",
    aliases: ["sample-alias"],
  },
];
const models = [
  { id: "auto", name: "Auto" },
  {
    id: "model-a",
    name: "Model A",
    supportedReasoningEfforts: ["low", "high"],
  },
  { id: "model-b", name: "Model B", supportedReasoningEfforts: ["medium"] },
];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-controls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [],
    prompts = [],
    questions = [],
    fleets = [];
  let cfg;
  const rpc = {
    mcp: { list: async () => ({ servers: [] }) },
    plugins: { list: async () => ({ plugins: [] }) },
    skills: {
      ensureLoaded: async () => {},
      list: async () => ({
        skills: [
          {
            name: "sample",
            enabled: true,
            userInvocable: true,
            source: "plugin",
            description: "Skill",
          },
        ],
      }),
    },
    tools: {
      initializeAndValidate: async () => {},
      getCurrentMetadata: async () => ({ tools: [] }),
    },
    commands: {
      list: async () => ({ commands }),
      invoke: async ({ name }) => ({ kind: "text", text: "Output of " + name }),
    },
    fleet: {
      // Like the runtime: the call returns at once, then the turn and its background helpers run.
      start: async ({ prompt }) => {
        fleets.push(prompt);
        setTimeout(() => {
          const messageId = "fleet-" + fleets.length;
          session.emit({ type: "user.message", id: messageId, data: { messageId, delivery: "idle" } });
          session.emit({ type: "subagent.started", agentId: "w1", data: { toolCallId: "h1", agentName: "research", agentDisplayName: "worker" } });
          session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Dispatched." } });
          setTimeout(() => {
            session.emit({ type: "subagent.completed", agentId: "w1", data: { toolCallId: "h1", agentName: "research", agentDisplayName: "worker" } });
            session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Fleet answer" } });
            session.emit({ type: "session.idle", data: { mode: "interactive" } });
          }, 5);
        });
        return { started: true };
      },
    },
    model: {
      switchTo: async (args) => {
        calls.push(args);
        return { modelId: args.modelId };
      },
    },
    ui: {
      ephemeralQuery: async ({ question }) => {
        questions.push(question);
        return { answer: "Side answer" };
      },
    },
  };
  const handlers = new Set();
  const session = {
    rpc,
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      prompts.push(prompt);
      const messageId = "message";
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Main answer" } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const client = {
    createSession: async (c) => {
      cfg = c;
      return session;
    },
    resumeSession: async (_, c) => {
      cfg = c;
      return session;
    },
    listModels: async () => models,
    deleteSession: async () => {},
  };
  const open = () =>
    new Workspace(
      dir,
      async () => client,
      () => {},
      () => ({ kind: "reject" }),
    );
  return { open, rpc, calls, prompts, questions, fleets, config: () => cfg };
}
test("the slash menu includes dynamically advertised commands, aliases, skills and native side questions", async (t) => {
  const f = fixture(t);
  const menu = (await inventory({ rpc: f.rpc })).choices;
  for (const cmd of commands)
    assert.equal(
      menu.filter((x) => x.command === cmd.name).length,
      1,
      cmd.name,
    );
  assert.ok(menu.find((x) => x.command === "model").aliases.includes("models"));
  assert.ok(
    menu.some((x) => [x.command, ...(x.aliases || [])].includes("btw")),
  );
});
test("chat, bot and global overrides persist, clear and reach Copilot on create and resume", async (t) => {
  const f = fixture(t);
  let ws = f.open();
  const id = ws.createChat("pip");
  await ws.setModel("global", null, {
    model: "model-a",
    reasoningEffort: "high",
  });
  await ws.setModel("bot", "pip", {
    model: "model-b",
    reasoningEffort: "medium",
  });
  await ws.setModel("chat", id, { model: "model-a", reasoningEffort: "low" });
  await ws.send(id, "First");
  assert.equal(f.config().model, "model-a");
  assert.equal(f.config().inference.reasoningEffort, "low");
  ws = f.open();
  await ws.setModel("chat", id, null);
  await ws.send(id, "Second");
  assert.equal(f.config().model, "model-b");
  assert.equal(f.config().inference.reasoningEffort, "medium");
  await ws.setModel("bot", "pip", null);
  await ws.setModel("global", null, { model: "model-a" });
  await ws.send(id, "Third");
  assert.deepEqual(f.calls.at(-1), {
    modelId: "model-a",
    reasoningEffort: null,
  });
  await assert.rejects(
    ws.setModel("chat", id, { model: "model-b", reasoningEffort: "high" }),
  );
});
test("native command output and transient side questions never become model prompts", async (t) => {
  const f = fixture(t),
    ws = f.open(),
    id = ws.createChat("pip");
  await ws.send(id, "Hello");
  await ws.send(id, "/fresh-command");
  assert.equal(
    ws.state.chats[0].messages.at(-1).text,
    "Output of fresh-command",
  );
  const saved = JSON.stringify(ws.state);
  assert.equal(await ws.sideQuestion(id, "Why?"), "Side answer");
  assert.equal(JSON.stringify(ws.state), saved);
  assert.deepEqual(f.prompts, ["Hello"]);
  assert.deepEqual(f.questions, ["Why?"]);
});
test("/fleet runs as a turn that waits for its background helpers and keeps the final answer", async (t) => {
  const f = fixture(t),
    ws = f.open(),
    id = ws.createChat("pip");
  await ws.send(id, "/fleet find the cities");
  const run = ws.state.runs[0];
  assert.deepEqual(f.fleets, ["find the cities"]);
  assert.deepEqual(f.prompts, []);
  assert.equal(run.status, "Completed");
  assert.deepEqual(run.agents.map((a) => [a.name, a.status]), [["worker", "Done"]]);
  assert.deepEqual(ws.state.chats[0].messages.map((m) => [m.role, m.text]), [
    ["user", "/fleet find the cities"],
    ["assistant", "Fleet answer"],
  ]);
});
test("approval levels, managed requests, remembered scopes and cancellation resolve the correct callback", async (t) => {
  const f = fixture(t),
    ws = f.open(),
    chat = ws.chat(ws.createChat("pip")),
    task = { stopped: false };
  const read = { kind: "read", path: "/sample/file", intention: "Read sample" };
  // The Copilot adapter describes each SDK request to Botkins and turns the answer back into an SDK result.
  const request = (req, ctx) =>
    decide((r) => ws.interactions.permission(chat, task, r), req, ctx);
  const first = request(read);
  const [prompt] = ws.snapshot().requests;
  assert.equal(prompt.kind, "permission");
  assert.ok(prompt.remember);
  ws.interactions.respond(prompt.id, { action: "remember" });
  assert.equal((await first).approvedInteractively, true);
  assert.equal((await request(read)).kind, "approve-once");
  assert.equal(ws.snapshot().requests.length, 0);
  ws.setPreferences({ approval: "read" });
  assert.equal(
    (await request({ ...read, path: "/other" })).kind,
    "approve-once",
  );
  const write = request({
    kind: "write",
    fileName: "sample.txt",
    diff: "x".repeat(85000),
  });
  assert.ok(ws.snapshot().requests[0].detail.length > 85000);
  ws.interactions.respond(ws.snapshot().requests[0].id, { action: "deny" });
  assert.equal((await write).kind, "reject");
  ws.setPreferences({ approval: "all" });
  assert.equal(
    (await request({ kind: "shell", fullCommandText: "echo sample" })).kind,
    "approve-once",
  );
  const managed = request(
    { ...read, managedApprovalRequired: true },
    { managedSettingsEnabled: true },
  );
  assert.equal(ws.snapshot().requests[0].remember, null);
  ws.interactions.cancel(chat.id);
  assert.equal((await managed).kind, "reject");
  ws.clearApprovals();
  assert.equal(ws.chat(chat.id).approvals, undefined);
});
test("Copilot clarification settings reach the agent; a choice or freeform answer is routed to its own question", async (t) => {
  const f = fixture(t),
    ws = f.open(),
    chat = ws.chat(ws.createChat("pip")),
    task = { stopped: false };
  ws.setPreferences({
    clarify: ["choices"],
    clarificationInstructions: "Ask which audience to write for.",
  });
  await ws.send(chat.id, "Start");
  assert.match(f.config().systemMessage.content, /which audience/);
  const q = ws.interactions.question(chat, task, {
    question: "Audience?",
    choices: ["Team", "Public"],
    allowFreeform: true,
  });
  const form = ws.interactions.elicit(chat, task, {
    message: "Details?",
    requestedSchema: { properties: { title: { type: "string" } } },
  });
  const [one, two] = ws.snapshot().requests;
  ws.interactions.respond(two.id, {
    action: "accept",
    content: { title: "Sample" },
  });
  ws.interactions.respond(one.id, { action: "answer", value: "Partners" });
  assert.deepEqual(await q, { answer: "Partners", wasFreeform: true });
  assert.deepEqual(await form, {
    action: "accept",
    content: { title: "Sample" },
  });
  assert.equal(ws.snapshot().requests.length, 0);
});
test("tool activity streams ordered calls, bounded previews and outcomes; a rich chat card survives reopen", async (t) => {
  const { recordActivity } = await import("../desktop/activity.mjs");
  const f = fixture(t),
    w = f.open(),
    chat = w.chat(w.createChat("pip")),
    run = { id: "sample", chatId: chat.id, status: "Working" },
    task = {};
  w.active.set(chat.id, task);
  w.state.runs.push(run);
  const tools = w.panels.tools(w.bot("pip"), chat, run, task);
  const tool = tools.find((t) => t.name === "render_card");
  const count = [];
  const event = (type, data) =>
    recordActivity(run, { type, data }, () => count.push(type));
  event("tool.execution_start", {
    toolCallId: "1",
    toolName: "shell",
    arguments: { command: "echo hello", env: { SECRET: "private" } },
  });
  event("tool.shell_output", { toolCallId: "1", text: "hello" });
  assert.equal(run.steps[0].status, "Running");
  assert.equal(run.steps[0].output, "hello");
  assert.ok(!run.steps[0].input.includes("private"));
  event("tool.execution_complete", { toolCallId: "1", success: true });
  event("tool.execution_start", {
    toolCallId: "2",
    toolName: "browse",
    arguments: { url: "https://example.org" },
  });
  event("tool.execution_complete", {
    toolCallId: "2",
    success: false,
    error: { message: "Unavailable" },
  });
  assert.equal(run.steps[1].status, "Failed");
  assert.deepEqual(run.usedTools, ["shell"]);
  assert.equal(count.length, 5);
  await tool.handler({
    title: "Sample",
    blocks: [{ type: "metric", label: "Count", value: "3" }],
    replies: ["Show the table"],
  });
  assert.equal(f.open().state.runs[0].cards[0].blocks[0].value, "3");
  assert.throws(
    () =>
      tool.handler({
        title: "Unsafe",
        blocks: [{ type: "script", text: "<b>Text</b>" }],
      }),
    /Unknown panel block/,
  );
  // An html block is a page of its own (desktop/frames.mjs); without one there is nothing to show.
  assert.throws(() => tool.handler({ title: "No page", blocks: [{ type: "html", text: "<b>Text</b>" }] }), /An html block needs its page/);
});
test("a recurring native chat schedule survives restart and dispatches one overdue Copilot turn", async (t) => {
  const { tickChatSchedules } = await import("../desktop/schedules.mjs");
  const f = fixture(t),
    first = f.open(),
    chat = first.chat(first.createChat("pip"));
  chat.schedules = [
    { id: 1, prompt: "Tick", nextAt: 1000, intervalMs: 60000, recurring: true },
  ];
  first.save();
  const ws = f.open();
  tickChatSchedules(ws, 67000);
  tickChatSchedules(ws, 67000);
  await ws.active.get(chat.id).done;
  assert.equal(ws.state.runs.length, 1);
  assert.equal(ws.state.runs[0].trigger, "scheduled");
  assert.equal(ws.chat(chat.id).schedules[0].nextAt, 121000);
});

test("fast mode persists separately from the model at all three scopes", async (t) => {
  const f = fixture(t);
  let ws = f.open();
  const id = ws.createChat("pip");
  const speed = () => ws.effectiveModel(ws.chat(id)).fastMode;
  await ws.setModel("global", null, { model: "model-a" }, "ultrafast");
  await ws.setModel("bot", "pip", null, "off");
  assert.equal(speed(), "off");
  await ws.setModel("chat", id, null, "fast");
  assert.equal(ws.chat(id).model, undefined);
  await ws.send(id, "Hello");
  assert.equal(f.config().model, "model-a");
  ws = f.open();
  assert.equal(speed(), "fast");
  await ws.setModel("chat", id, { model: "model-b" });
  assert.equal(speed(), "fast", "a model-only edit preserves speed");
  await assert.rejects(ws.setModel("chat", id, null, "invalid"));
  assert.equal(ws.chat(id).model.model, "model-b");
  await ws.setModel("chat", id, null, null);
  assert.equal(speed(), "off");
  await ws.setModel("bot", "pip", null, null);
  assert.equal(speed(), "ultrafast");
});
