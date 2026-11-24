// The model provider layer: the registry, the Copilot adapter's session options and warm
// sessions, account flows, and a conversation moving to a second provider.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Providers, ModelProvider, ProviderSession, defineTool } from "../desktop/providers/index.mjs";
import { CopilotProvider, loginAnswer, sessionOptions, spoken, typedSchema } from "../desktop/providers/copilot/index.mjs";
import { SignIns } from "../desktop/terminal/signin.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { pass, settle, watching } from "./quiet-turns.mjs";

/** A workspace on the Copilot adapter with warm sessions on, over a fake SDK client. */
function warm(t, reply, options = {}) {
  const dir = tempDir(t);
  const fake = fakeClient(reply, options.extra);
  const copilot = new CopilotProvider({ connect: fake.client, keepWarmMs: options.keepWarmMs ?? 60000, maxWarm: options.maxWarm ?? 6, keepOne: options.keepOne, quietCheckMs: options.quietCheckMs });
  t.after(() => copilot.stop());
  const ws = new Workspace(join(dir, "data"), new Providers([copilot, ...(options.more ?? [])]), () => {});
  return { ws, dir, copilot, ...fake };
}

test("the registry falls back to the default provider and merges model lists", async () => {
  class Fixed extends ModelProvider {
    constructor(id, models, fails) {
      super();
      Object.assign(this, { id, name: id, list: models, fails });
    }
    async models() {
      if (this.fails) throw new Error("offline");
      return this.list;
    }
  }
  const a = new Fixed("a", [{ id: "m1", provider: "a" }]);
  const b = new Fixed("b", [{ id: "m2", provider: "b" }]);
  const providers = new Providers([a, b]);
  assert.equal(providers.default, a);
  assert.equal(providers.for({ model: "x", provider: "b" }), b);
  assert.equal(providers.for({ model: "x" }), a, "a selection without a provider uses the default");
  assert.equal(providers.for({ model: "x", provider: "gone" }), a, "an unknown provider falls back to the default");
  assert.deepEqual((await providers.models()).map((m) => m.id), ["m1", "m2"]);
  // A provider that is down doesn't hide the others' models, whichever it is. With nothing to list, the reason is given.
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    assert.deepEqual((await new Providers([a, new Fixed("b", [], true)]).models()).map((m) => m.id), ["m1"]);
    assert.deepEqual((await new Providers([new Fixed("a", [], true), b]).models()).map((m) => m.id), ["m2"]);
    await assert.rejects(new Providers([new Fixed("a", [], true)]).models(), /offline/);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 3, "each failure is logged");
  assert.throws(() => new Providers([]), /at least one/);
  assert.throws(() => new Providers([{ id: "x" }]), /Invalid model provider/);
});

test("a session spec becomes grouped SDK 2.0 options, with the turn's handlers behind a swap", async () => {
  const calls = [];
  const turn = {
    handlers: {
      permission: async (request) => (calls.push(["permission", request.kind, request.label]), { allow: true, interactive: true }),
      question: async (request) => (calls.push(["question", request.question]), { answer: "Team", wasFreeform: false }),
      planExit: async () => ({ approved: true }),
      autoSwitch: async () => "yes",
      form: async () => ({ action: "accept", content: {} }),
    },
  };
  const options = sessionOptions(
    {
      sessionId: "s1",
      folder: "/work",
      coding: false,
      model: { model: "gpt-x", reasoningEffort: "high" },
      approval: "ask",
      instructions: "You are Pip.",
      context: "\nMemory: likes teal.",
      tools: [defineTool("hello", { description: "Says hello", parameters: { type: "object", properties: {} }, handler: () => "hi" })],
      skills: { directories: ["/skills"], disabled: ["old"] },
      mcpServers: { files: { type: "stdio", command: "npx", args: ["x"], env: {}, tools: ["*"] } },
      plugins: ["/plugin"],
      pluginHooks: { handlers: { onSessionStart: async () => ({ additionalContext: "plugin" }) } },
      pluginRevision: 7,
    },
    turn,
  );
  assert.equal(options.model, "gpt-x");
  assert.equal(options.workingDirectory, "/work");
  assert.equal(options.enableConfigDiscovery, false, "nothing is picked up from the folder or the person's Copilot setup");
  assert.deepEqual(options.inference, { reasoningEffort: "high", reasoningSummary: "detailed" });
  assert.equal(options.events.streaming, true);
  assert.equal(options.permissions.mode, "manual");
  assert.deepEqual(options.tools.definitions.map((x) => [x.name, x.skipPermission, x.defer]), [["hello", true, "never"]]);
  assert.equal(options.tools.manageScheduleEnabled, false);
  assert.ok(options.tools.excludedTools.includes("builtin:run_dynamic_workflow"));
  assert.ok(options.tools.excludedTools.includes("builtin:semantic_code_search"), "code search is for project folders");
  assert.deepEqual(options.skills, { enabled: true, directories: ["/skills"], disabledSkills: ["old", "customize-cloud-agent", "github-pr-media", "pr-stack"] });
  assert.ok(!("includedBuiltinSkills" in options.skills), "that filter makes the SDK update options after opening, which is slow");
  assert.deepEqual(Object.keys(options.mcp.servers), ["files"]);
  assert.deepEqual(options.plugins.directories, ["/plugin"]);
  assert.equal(typeof options.hooks.handlers.onSessionStart, "function");
  assert.deepEqual(options.systemMessage, { mode: "append", content: "You are Pip.\nMemory: likes teal." });
  // The SDK's request reaches Botkins in neutral terms, and the answer goes back as an SDK result.
  assert.deepEqual(await options.permissions.onRequest({ kind: "shell", fullCommandText: "ls" }, {}), {
    kind: "approve-once",
    approvedInteractively: true,
  });
  assert.deepEqual(calls[0], ["permission", "shell", "Shell command"]);
  assert.deepEqual(await options.interaction.onUserInputRequest({ question: "Audience?" }), { answer: "Team", wasFreeform: false });
  // Between turns nothing is approved and nobody can be asked.
  turn.handlers = null;
  assert.deepEqual(await options.permissions.onRequest({ kind: "shell", fullCommandText: "ls" }, {}), { kind: "reject" });
  assert.throws(() => options.interaction.onUserInputRequest({ question: "?" }), /No active turn/);
  assert.deepEqual(options.interaction.onElicitationRequest({}), { action: "cancel" });
  assert.equal(options.interaction.onAutoModeSwitchRequest({}), "no");
  // A coding chat keeps code search and the runtime's own skills; other approval levels map through.
  const coding = sessionOptions({ model: { model: "m" }, approval: "all", instructions: "", coding: true, tools: [] }, {});
  assert.ok(!coding.tools.excludedTools.includes("builtin:semantic_code_search"));
  assert.deepEqual(coding.skills.disabledSkills, [], "a coding chat keeps the runtime's pull-request skills");
  assert.equal(coding.permissions.mode, "allow-all");
  assert.equal(sessionOptions({ model: { model: "m" }, approval: "assisted", instructions: "", tools: [] }, {}).permissions.mode, "assisted");
});

test("a plugin revision invalidates a warm Copilot session and callbacks reach SDK options", async (t) => {
  const dir = tempDir(t);
  const fake = fakeClient();
  const copilot = new CopilotProvider({ connect: fake.client, keepWarmMs: 60_000 });
  t.after(() => copilot.stop());
  const hook = { handlers: { onSessionStart: async () => ({ additionalContext: "plugin context" }) } };
  const spec = {
    sessionId: "plugin-chat",
    folder: dir,
    model: { model: "auto" },
    approval: "ask",
    instructions: "",
    skills: { directories: [], disabled: [] },
    mcpServers: {},
    plugins: [],
    tools: [],
    pluginHooks: hook,
    pluginRevision: 1,
  };
  const first = await copilot.openSession(spec);
  await first.close();
  assert.deepEqual(fake.log.created, ["plugin-chat"]);
  const second = await copilot.openSession({ ...spec, pluginRevision: 2, pluginHooks: { handlers: { onSessionStart: async () => ({ additionalContext: "new context" }) } } });
  await second.close();
  assert.deepEqual(fake.log.disconnected, ["plugin-chat"]);
  assert.deepEqual(fake.log.resumed, [], "revision change creates a fresh warm SDK session");
  assert.deepEqual(fake.log.created, ["plugin-chat", "plugin-chat"]);
  assert.equal(fake.log.configs.get("plugin-chat").hooks.handlers.onSessionStart !== hook.handlers.onSessionStart, true);
});

test("a chat's session stays warm: the next turn reuses it with that turn's tools and handlers", async (t) => {
  const { ws, log } = warm(t);
  const id = ws.createChat("pip");
  await ws.send(id, "One");
  assert.deepEqual(log.created, [id]);
  assert.deepEqual(log.disconnected, [], "a finished turn keeps its session open");
  const first = log.tools.get(id);
  await ws.send(id, "Two");
  assert.deepEqual(log.created, [id]);
  assert.deepEqual(log.resumed, [], "the second turn neither creates nor resumes");
  assert.notEqual(log.tools.get(id), first, "the second turn's tools replaced the first's");
  assert.deepEqual(log.sent.map((s) => s[1]), ["One", "Two"]);
  assert.equal(log.sessions.get(id).listeners(), 0, "no event listener is left behind");
  // The first turn's tools are dead: they belong to a task that ended.
  const stale = first.find((x) => x.name === "wiki_search");
  assert.throws(() => stale.handler({}), /no longer active/);
  // The "/" menu and a side question borrow the same warm session.
  log.sessions.get(id).rpc.ui = { ephemeralQuery: async () => ({ answer: "Side" }) };
  assert.equal(await ws.sideQuestion(id, "Why?"), "Side");
  assert.deepEqual([log.created.length, log.resumed.length, log.disconnected.length], [1, 0, 0]);
});

test("model and approval changes apply to the open session; changed instructions reopen it", async (t) => {
  const { ws, log } = warm(t, undefined, { extra: { models: [{ id: "auto" }, { id: "gpt-x", supportedReasoningEfforts: ["high"] }] } });
  const id = ws.createChat("pip");
  const other = ws.createChat("pip");
  await ws.send(id, "One");
  await ws.send(other, "Hello");
  // Closing a session makes the next one slow to start, so these change the session in place.
  ws.setPreferences({ approval: "all" });
  await ws.setModel("chat", id, { model: "gpt-x", reasoningEffort: "high" });
  await ws.send(id, "Two");
  assert.deepEqual([log.disconnected, log.resumed], [[], []], "nothing was closed or reopened");
  assert.deepEqual(log.modes, [[id, "allow-all"]]);
  assert.deepEqual(log.models, [[id, "gpt-x", "high"]]);
  ws.setPreferences({ approval: "read" });
  await ws.send(id, "Three");
  assert.deepEqual(log.modes, [[id, "allow-all"], [id, "manual"]], "Botkins' read level is the SDK's manual mode plus its own rule");
  // What the bot is told is fixed when a session opens, so a change there reopens it.
  ws.updateBot("pip", { instructions: "Answer in one sentence." });
  await ws.send(id, "Four");
  assert.deepEqual(log.disconnected, [id]);
  assert.deepEqual(log.resumed, [id]);
  assert.match(log.configs.get(id).systemMessage.content, /Answer in one sentence/);
  assert.equal(log.configs.get(id).permissions.mode, "manual");
  assert.equal(log.configs.get(id).model, "gpt-x");
  log.resumed.length = 0;
  // Memory rides outside the reuse check, so the saving chat's session survives its own save…
  ws.active.set(id, { stopped: false });
  log.disconnected.length = 0;
  const entry = ws.providers.default.pool.get(id);
  entry.busy = true;
  ws.memory.save("pip", "Likes teal");
  await tick();
  // …while the bot's other open chat closes so its next turn starts with the new memory.
  assert.deepEqual(log.disconnected, [other]);
  entry.busy = false;
  ws.active.delete(id);
  await ws.send(other, "Again");
  assert.match(log.configs.get(other).systemMessage.content, /Likes teal/);
  assert.deepEqual(log.resumed, [other]);
});

test("warm sessions are limited, expire, are never kept for disposable or failed turns, and close on stop", async (t) => {
  const { ws, log, copilot } = warm(t, async (_id, options) => {
    if (options.prompt === "Fail") throw new Error("model error");
    return { data: { content: "ok" } };
  }, { maxWarm: 2 });
  const chats = [ws.createChat("pip"), ws.createChat("scout"), ws.createChat("patch")];
  for (const id of chats) await ws.send(id, "Hi");
  assert.deepEqual(log.disconnected, [chats[0]], "the least recently used session closes when a third opens");
  assert.deepEqual([...copilot.pool.keys()], [chats[1], chats[2]]);
  // A failed turn's session is closed rather than reused.
  await ws.send(chats[2], "Fail");
  assert.equal(ws.state.runs[0].status, "Needs you");
  assert.ok(log.disconnected.includes(chats[2]));
  assert.ok(!copilot.pool.has(chats[2]));
  // The "/" menu of a brand-new chat uses the bot's menu session, which stays open like any other.
  const fresh = ws.createChat("pip");
  await ws.catalog("pip", fresh).catch(() => {}); // the fake has no inventory RPCs; the session is still released
  await tick(5);
  assert.ok([...copilot.pool.keys()].some((key) => key.startsWith("menu-")));
  assert.ok([...copilot.pool.values()].every((entry) => !entry.busy));
  assert.equal(log.deleted.length, 0);
  assert.ok(!ws.chat(fresh).established, "browsing the menu doesn't start the chat's conversation");
  await copilot.stop();
  assert.equal(copilot.pool.size, 0);
  assert.equal(log.stopped, undefined, "a client supplied from outside is not stopped by the provider");
});

test("a warm session closes by itself after the keep-warm time", async (t) => {
  const { ws, log, copilot } = warm(t, undefined, { keepWarmMs: 15 });
  const id = ws.createChat("pip");
  await ws.send(id, "One");
  assert.ok(copilot.pool.has(id));
  await tick(60);
  assert.deepEqual(log.disconnected, [id]);
  assert.ok(!copilot.pool.has(id));
  await ws.send(id, "Two");
  assert.deepEqual(log.resumed, [id]);
});

test("with keepOne, the last open session outlives the keep-warm time, and only the last", async (t) => {
  const { ws, log, copilot } = warm(t, undefined, { keepWarmMs: 15, keepOne: true });
  const first = ws.createChat("pip");
  const second = ws.createChat("pip");
  await ws.send(first, "One");
  await ws.send(second, "Two");
  await tick(60);
  assert.deepEqual(log.disconnected, [first], "the older one closes; the newest stays open");
  await tick(60);
  assert.ok(copilot.pool.has(second), "the last one stays open beyond the keep-warm time");
  await ws.send(second, "Three");
  assert.deepEqual(log.resumed ?? [], [], "its next message needs no reopening");
});

test("opening a new chat starts the harness's runtime without opening a session", async (t) => {
  const { ws, log, copilot } = warm(t);
  let warmed = 0;
  copilot.warm = async () => void warmed++;
  const id = ws.createChat("pip");
  await ws.prewarm(id);
  assert.equal(warmed, 1, "the runtime is started while the person writes");
  assert.deepEqual(log.created, [], "no session is opened for a chat with no conversation");
  assert.equal(ws.chat(id).established, false);
  await ws.warmUp();
  assert.equal(warmed, 2, "launch starts the default harness's runtime too");
});

test("Copilot activity keeps a turn alive beyond the old wall-clock deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { ws, copilot } = warm(t, undefined, {
    extra: {
      send: async (_id, _options, session) => {
        session.emit({ type: "user.message", id: "user-event", data: { messageId: "request" } });
        let count = 0;
        const timer = setInterval(() => {
          count++;
          session.emit({ type: "assistant.intent", data: { intent: "working " + count } });
          if (count === 8) {
            clearInterval(timer);
            session.emit({ type: "assistant.message", id: "reply", data: { originatingMessageId: "request", content: "Finished" } });
            session.emit({ type: "session.idle", data: { mode: "interactive" } });
          }
        }, 100000);
        return "request";
      },
    },
  });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  const reply = session.send({ prompt: "Long" });
  // Advance the fake clock 800 seconds: the old wall-clock deadline has passed, and the turn goes on.
  await Promise.resolve();
  t.mock.timers.tick(800000);
  await assert.doesNotReject(reply);
  await session.close();
  await copilot.stop();
});

/** A session that admits the message and then says nothing until the test says more. */
const quiet = {
  send: async (_id, _options, session) => {
    session.emit({ type: "user.message", id: "user-event", data: { messageId: "request" } });
    return "request";
  },
};
/** A quiet session whose connection is closed once its message has been sent (the model lookup before that works). */
function dying() {
  const sent = new WeakSet();
  return {
    send: (id, options, session) => (sent.add(session), quiet.send(id, options, session)),
    current: async (_id, session) => (sent.has(session) ? Promise.reject(new Error("Connection is closed.")) : { modelId: "auto" }),
  };
}
const finish = (session) => {
  session.emit({ type: "assistant.message", id: "reply", data: { originatingMessageId: "request", content: "Finished" } });
  session.emit({ type: "session.idle", data: { mode: "interactive" } });
};

test("a Copilot turn that is quiet for hours while its session is alive does not fail, and completes when the events arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let asked = 0;
  const { ws, copilot } = warm(t, undefined, { extra: { ...quiet, current: async () => (asked++, { modelId: "auto" }) } });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  const { seen, done } = watching(session.send({ prompt: "Long" }));
  await settle();
  // Three hours with nothing from the session: the old limit was ten minutes.
  await pass(t, 3 * 60 * 60 * 1000);
  assert.equal(seen.state, "pending", "a quiet session that answers the check is not failed");
  assert.ok(asked >= 10, "the session was asked whether it is still there");
  finish(session.sdk);
  await done;
  assert.deepEqual(seen.value, { text: "Finished" });
  await session.close();
  await copilot.stop();
});

test("a check that gets no answer, or an odd one, is no news: the turn keeps waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answers = [() => new Promise(() => {}), () => Promise.reject(new Error("Internal error")), () => ({ modelId: "auto" })];
  let asked = 0;
  const { ws, copilot } = warm(t, undefined, { extra: { ...quiet, current: async () => answers[Math.min(asked++, 2)]() } });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  const { seen, done } = watching(session.send({ prompt: "Long" }));
  await settle();
  await pass(t, 20 * 60 * 1000);
  assert.ok(asked >= 3);
  assert.equal(seen.state, "pending");
  finish(session.sdk);
  await done;
  assert.equal(seen.state, "done");
  await session.close();
  await copilot.stop();
});

test("a Copilot turn whose session dies during the silence fails with a clear error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let dead = false;
  const { ws, copilot } = warm(t, undefined, {
    extra: { ...quiet, current: async () => (dead ? Promise.reject(new Error("Connection is closed.")) : { modelId: "auto" }) },
  });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  const reply = session.send({ prompt: "Long" });
  const failed = assert.rejects(reply, (error) => error.code === "BOTKINS_SESSION_LOST" && /Copilot stopped before it finished this reply \(Connection is closed\.\)/.test(error.message));
  await settle();
  await pass(t, 30 * 60 * 1000);
  dead = true;
  await pass(t, 5 * 60 * 1000);
  await failed;
  assert.equal(session.sdk.listeners(), 0, "the turn's listener is removed");
  await session.close();
  await copilot.stop();
});

test("a Copilot turn that never gets its message admitted fails once the session is gone, and not before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let dead = false;
  const { ws, copilot } = warm(t, undefined, {
    extra: { send: async () => new Promise(() => {}), current: async () => (dead ? Promise.reject(new Error("Session not found: gone")) : { modelId: "auto" }) },
  });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  const admission = session.send({ prompt: "Never admitted" });
  const failed = assert.rejects(admission, (error) => error.code === "BOTKINS_SESSION_LOST");
  await settle();
  await pass(t, 60 * 60 * 1000);
  dead = true;
  await pass(t, 5 * 60 * 1000);
  await failed;
  assert.equal(session.sdk.listeners(), 0);
  await session.close();
  await copilot.stop();
});

test("Stop ends a Copilot turn at once, even one whose message was never admitted", async (t) => {
  const { ws, copilot } = warm(t, undefined, { extra: { send: async () => new Promise(() => {}), current: async () => ({ modelId: "auto" }) } });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  const reply = session.send({ prompt: "Hangs" });
  await tick(5);
  await session.abort();
  await assert.rejects(reply, /aborted/);
  assert.equal(session.sdk.listeners(), 0);
  await session.close();
  await copilot.stop();
});

test("a caller that names a time limit gets it: Copilot gives up on a background turn after that long", async (t) => {
  const { ws, copilot } = warm(t, undefined, { extra: { send: async () => new Promise(() => {}), current: async () => ({ modelId: "auto" }) } });
  const id = ws.createChat("pip");
  const session = await ws.openSession(ws.chat(id), ws.bot("pip"), null, null);
  await assert.rejects(session.send({ prompt: "Summarize" }, 20), (error) => error.code === "BOTKINS_TURN_TIMEOUT");
  assert.equal(session.sdk.listeners(), 0);
  await session.close();
  await copilot.stop();
});

test("a Copilot turn whose session died still recovers the reply it journaled before Needs you", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, copilot } = warm(t, undefined, {
    extra: {
      ...dying(),
      events: async () => [
        { type: "user.message", id: "user-event", data: { messageId: "request" } },
        { type: "assistant.message", data: { originatingMessageId: "request", content: "Recovered from journal" } },
        { type: "assistant.turn_end" },
      ],
    },
  });
  const id = ws.createChat("pip");
  const turn = ws.send(id, "Long request");
  await settle();
  await pass(t, 5 * 60 * 1000);
  await turn;
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.equal(ws.chat(id).messages.at(-1).text, "Recovered from journal");
  await copilot.stop();
});

test("a Copilot turn whose session died and journaled nothing ends as Needs you, not Timed out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, copilot, log } = warm(t, undefined, { extra: dying() });
  const id = ws.createChat("pip");
  let done = false;
  const turn = ws.send(id, "Long request").then(() => (done = true));
  // A lost connection is tried once more on a fresh session (retryConnection), which is lost too.
  for (let i = 0; i < 30 && !done; i++) await pass(t, 60000);
  await turn;
  assert.equal(log.sent.length, 2);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Needs you");
  assert.equal(run.ending, "failed");
  assert.match(run.detail, /Copilot stopped before it finished this reply/);
  await copilot.stop();
});

test("opening a chat readies its session; a stopped turn's session stays open", async (t) => {
  let release;
  const { ws, log, copilot } = warm(t, async (_id, options, session) => {
    if (options.prompt !== "Slow") return { data: { content: "ok" } };
    await new Promise((resolve) => {
      release = resolve;
      session.onAbort = resolve;
    });
    return { data: { content: "late" } };
  });
  const id = ws.createChat("pip");
  await ws.prewarm(id);
  assert.deepEqual(log.created, [], "a chat with no conversation yet isn't opened ahead of time");
  await ws.send(id, "One");
  await copilot.releaseSessions();
  assert.deepEqual(log.disconnected, [id]);
  await ws.prewarm(id);
  assert.deepEqual(log.resumed, [id], "opening the chat resumes its session before any message");
  await ws.send(id, "Two");
  assert.deepEqual(log.resumed, [id], "the message then starts on the session that is already open");
  const turn = ws.send(id, "Slow");
  await tick(5);
  await ws.stop(id);
  await turn;
  assert.equal(ws.state.runs[0].status, "Stopped");
  assert.ok(copilot.pool.has(id), "Stop doesn't close the session");
  await ws.send(id, "After stop");
  assert.deepEqual(log.resumed, [id], "the next message uses it without reopening");
  assert.equal(ws.chat(id).messages.at(-1).text, "ok");
  void release;
});

test("conversations made under ~/.copilot are copied into Botkins' own Copilot state once", (t) => {
  const dir = tempDir(t);
  const legacy = join(dir, "home");
  const base = join(dir, "data", "copilot");
  for (const id of ["chat-1", "chat-2", "chat-1-pip"]) {
    mkdirSync(join(legacy, "session-state", id, "checkpoints"), { recursive: true });
    writeFileSync(join(legacy, "session-state", id, "events.jsonl"), id);
  }
  const copilot = new CopilotProvider({ baseDirectory: base, userHome: legacy, connect: async () => ({}) });
  assert.equal(copilot.adoptSessions(["chat-1", "chat-1-pip", "missing", "../escape", 7]), 2);
  assert.equal(readFileSync(join(base, "session-state", "chat-1", "events.jsonl"), "utf8"), "chat-1");
  assert.ok(existsSync(join(base, "session-state", "chat-1-pip", "checkpoints")));
  assert.ok(!existsSync(join(base, "session-state", "chat-2")), "only this workspace's conversations are copied");
  assert.ok(existsSync(join(legacy, "session-state", "chat-1")), "the originals stay");
  // A conversation that has moved on in Botkins is never overwritten.
  writeFileSync(join(base, "session-state", "chat-1", "events.jsonl"), "newer");
  assert.equal(copilot.adoptSessions(["chat-1", "chat-2"]), 1);
  assert.equal(readFileSync(join(base, "session-state", "chat-1", "events.jsonl"), "utf8"), "newer");
  assert.equal(new CopilotProvider({ userHome: legacy }).adoptSessions(["chat-1"]), 0, "nothing to do when Botkins shares ~/.copilot");
});

/** A fake accounts RPC on a short-lived session, as SDK 2.0 runs sign-in. */
function accountsFixture(t, steps, auth) {
  const calls = [];
  let advance = 0;
  const fake = fakeClient(undefined, {
    auth,
    rpc: () => ({
      accounts: {
        login: {
          begin: async (params) => (calls.push(["begin", params]), { flowId: "f1", step: steps.first }),
          advance: async (params) => {
            calls.push(["advance", params]);
            const step = steps.next[Math.min(advance++, steps.next.length - 1)];
            if (step instanceof Error) throw step;
            if (typeof step === "function") return step();
            return step;
          },
          cancel: async () => void calls.push(["cancel"]),
        },
        set: async (params) => (calls.push(["set", params]), { ok: true }),
      },
    }),
  });
  const copilot = new CopilotProvider({ connect: fake.client });
  t.after(() => copilot.stop());
  return { copilot, calls, ...fake };
}

test("sign-in opens GitHub in the browser, waits, and cleans up its session", async (t) => {
  let signedIn = false;
  const { copilot, calls, log } = accountsFixture(
    t,
    {
      first: { kind: "open-url", url: "https://github.com/login/oauth/authorize?client_id=x" },
      next: [{ kind: "awaiting" }, () => ((signedIn = true), { kind: "completed" })],
    },
    () => ({ isAuthenticated: signedIn, login: "octo", authType: "user" }),
  );
  const opened = [];
  await copilot.signIn({ open: async (url) => void opened.push(url) });
  assert.deepEqual(opened, ["https://github.com/login/oauth/authorize?client_id=x"]);
  assert.deepEqual(calls.map((c) => c[0]), ["begin", "advance", "advance", "cancel"]);
  assert.deepEqual(calls[0][1], { kind: "githubDotCom", method: "web" });
  assert.deepEqual(log.configs.get(log.created[0]).tools.availableTools, [], "the sign-in session has no tools");
  assert.deepEqual(log.disconnected, log.created);
  assert.deepEqual(log.deleted, log.created);
  assert.deepEqual(await copilot.auth(), { connected: true, login: "octo", type: "user", host: undefined });
});

test("a sign-in GitHub finished is kept: the runtime's question about a computer with no keychain is answered", async (t) => {
  // What the runtime does on a Linux server (seen with a real sign-in): GitHub says yes, then the
  // runtime asks before it keeps the sign-in in a file, and only the answer finishes the sign-in.
  let signedIn = false;
  const { copilot, calls } = accountsFixture(
    t,
    {
      first: { kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 },
      next: [
        { kind: "awaiting" },
        { kind: "completed", result: { status: "needs-plaintext-consent" } },
        () => ((signedIn = true), { kind: "completed", result: { status: "completed", host: "https://github.com", login: "octo" } }),
      ],
    },
    () => ({ isAuthenticated: signedIn, login: "octo", authType: "user" }),
  );
  await copilot.signIn({ device: async () => {} });
  assert.deepEqual(calls.map((c) => c[0]), ["begin", "advance", "advance", "advance", "cancel"]);
  assert.deepEqual(calls[3][1], { flowId: "f1", input: "allow" });
  assert.equal(calls[2][1].input, undefined, "only the question is answered");
  assert.deepEqual(await copilot.auth(), { connected: true, login: "octo", type: "user", host: undefined });
});

test("a sign-in is not reported done while the runtime still waits, even when another sign-in is there", async (t) => {
  // A computer signed in through the GitHub CLI is authenticated all along: that is no sign that this one was kept.
  const declined = accountsFixture(
    t,
    { first: { kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900 }, next: [{ kind: "completed", result: { status: "needs-plaintext-consent" } }, { kind: "completed", result: { status: "declined" } }] },
    () => ({ isAuthenticated: true, login: "octo", authType: "gh-cli" }),
  );
  await assert.rejects(declined.copilot.signIn({ device: async () => {} }), /wasn't saved on this computer/);
  // The same question again means the answer wasn't taken: it is not asked for ever.
  const again = accountsFixture(
    t,
    { first: { kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900 }, next: [{ kind: "completed", result: { status: "needs-account-selection", accounts: [] } }] },
    () => ({ isAuthenticated: true, login: "octo", authType: "gh-cli" }),
  );
  await assert.rejects(again.copilot.signIn({ device: async () => {} }), /which account to use/);
  assert.deepEqual(again.calls.map((c) => c[0]), ["begin", "advance", "cancel"]);
  const twice = accountsFixture(
    t,
    { first: { kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900 }, next: [{ kind: "completed", result: { status: "needs-plaintext-consent" } }] },
    () => ({ isAuthenticated: true, login: "octo", authType: "gh-cli" }),
  );
  await assert.rejects(twice.copilot.signIn({ device: async () => {} }), /Sign-in incomplete|wasn't saved/);
  assert.deepEqual(twice.calls.map((c) => c[0]), ["begin", "advance", "advance", "cancel"]);
});

test("the account GitHub signed in is the one chosen when the runtime asks", () => {
  const accounts = [
    { selectionId: "s1", login: "other", host: "https://github.com", kind: "user" },
    { selectionId: "s2", login: "octo", host: "https://github.com", kind: "user" },
  ];
  assert.equal(loginAnswer({ status: "needs-account-selection", login: "octo", accounts }), "s2");
  assert.equal(loginAnswer({ status: "needs-account-selection", accounts: [accounts[0]] }), "s1", "the only one");
  assert.equal(loginAnswer({ status: "needs-account-selection", accounts }), undefined, "never a guess among several");
  assert.equal(loginAnswer({ status: "completed" }), undefined);
  assert.equal(loginAnswer(undefined), undefined);
});

test("every tool's enum and const has a type, which Gemini models need", () => {
  // Gemini turned down a whole turn (400 invalid request body) for one untyped enum inside the
  // items of an anyOf choice: the badges block of render_card and today_publish.
  const badges = {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        items: { anyOf: [{ type: "object", properties: { type: { const: "badges" }, items: { type: "array", items: { type: "object", properties: { tone: { enum: ["neutral", "positive"] } } } } } }] },
      },
      const: { type: "string" },
      level: { enum: [1, 2, 3] },
      ratio: { enum: [0.5, 1] },
      mixed: { enum: ["a", 1] },
      on: { const: true },
    },
  };
  const before = JSON.stringify(badges);
  const typed = typedSchema(badges);
  assert.equal(JSON.stringify(badges), before, "the schema given is not changed");
  const choice = typed.properties.blocks.items.anyOf[0];
  assert.deepEqual(choice.properties.type, { const: "badges", type: "string" });
  assert.deepEqual(choice.properties.items.items.properties.tone, { enum: ["neutral", "positive"], type: "string" });
  assert.deepEqual(typed.properties.const, { type: "string" }, "a property may be called const");
  assert.equal(typed.properties.level.type, "integer");
  assert.equal(typed.properties.ratio.type, "number");
  assert.equal(typed.properties.mixed.type, undefined, "no type is made up for values of several kinds");
  assert.equal(typed.properties.on.type, "boolean");
  assert.equal(typedSchema(undefined), undefined);
});

test("Botkins' own tools type their enums, so every harness gets schemas Gemini takes", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stopped: false };
  ws.active.set(chat.id, task);
  const run = { id: "run-1", chatId: chat.id, status: "Working" };
  ws.state.runs.push(run);
  const untyped = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((entry) => walk(entry, where));
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.enum) && !node.type) untyped.push(where);
    for (const [key, value] of Object.entries(node)) if (key !== "enum" && key !== "const") walk(value, where + "." + key);
  };
  for (const tool of ws.sessionTools(ws.bot("pip"), chat, run, task)) walk(tool.parameters, tool.name);
  assert.deepEqual(untyped, []);
});

test("a host with no browser signs in with GitHub's one-time code, and only on GitHub's own page", async (t) => {
  let signedIn = false;
  const { copilot, calls } = accountsFixture(
    t,
    {
      first: { kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 },
      next: [{ kind: "awaiting" }, () => ((signedIn = true), { kind: "completed" })],
    },
    () => ({ isAuthenticated: signedIn, login: "octo", authType: "user" }),
  );
  const shown = [];
  await copilot.signIn({ device: async (code) => void shown.push(code) });
  assert.deepEqual(shown, [{ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900 }]);
  assert.deepEqual(calls[0][1], { kind: "githubDotCom", method: "device-code" });
  assert.deepEqual(calls.map((c) => c[0]), ["begin", "advance", "advance", "cancel"]);
  assert.deepEqual(await copilot.auth(), { connected: true, login: "octo", type: "user", host: undefined });
  // A code to type anywhere but GitHub is never shown, and neither is a page offered in place of a code.
  for (const first of [{ kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresIn: 900 }, { kind: "open-url", url: "https://github.com/login/oauth/authorize" }]) {
    const bad = accountsFixture(t, { first, next: [{ kind: "completed" }] });
    const seen = [];
    await assert.rejects(bad.copilot.signIn({ device: async (code) => void seen.push(code) }), /didn't offer a one-time code/);
    assert.deepEqual(seen, []);
  }
});

test("sign-in refuses a link that isn't GitHub, reports failure, and can be cancelled", async (t) => {
  const bad = accountsFixture(t, { first: { kind: "open-url", url: "https://example.com/phish" }, next: [{ kind: "completed" }] });
  const opened = [];
  await assert.rejects(bad.copilot.signIn({ open: async (url) => void opened.push(url) }), /run \/login/);
  assert.deepEqual(opened, [], "nothing is opened");
  assert.deepEqual(bad.log.deleted, bad.log.created);

  const failed = accountsFixture(t, { first: { kind: "open-url", url: "https://github.com/x" }, next: [{ kind: "error", message: "Access denied" }] });
  await assert.rejects(failed.copilot.signIn({ open: async () => {} }), /Access denied/);

  let resume;
  const waiting = accountsFixture(t, {
    first: { kind: "open-url", url: "https://github.com/x" },
    next: [() => new Promise((resolve) => (resume = () => resolve({ kind: "awaiting" })))],
  });
  const pending = waiting.copilot.signIn({ open: async () => {} });
  await tick(5);
  await waiting.copilot.cancelSignIn();
  resume();
  await assert.rejects(pending, /Sign-in cancelled/);
  assert.ok(waiting.calls.filter((c) => c[0] === "cancel").length >= 1);
  assert.deepEqual(waiting.log.deleted, waiting.log.created);
  await waiting.copilot.cancelSignIn(); // nothing waiting: no error
});

test("sign-out removes a Copilot sign-in and explains the ones Botkins can't remove", async (t) => {
  const user = accountsFixture(t, { first: {}, next: [] }, () => ({ isAuthenticated: true, authType: "user" }));
  await user.copilot.signOut();
  assert.deepEqual(user.calls, [["set", { command: { kind: "logout" } }]]);
  const gh = accountsFixture(t, { first: {}, next: [] }, () => ({ isAuthenticated: true, authType: "gh-cli" }));
  await assert.rejects(gh.copilot.signOut(), /gh auth logout/);
  assert.deepEqual(gh.calls, []);
  const env = accountsFixture(t, { first: {}, next: [] }, () => ({ isAuthenticated: true, authType: "env" }));
  await assert.rejects(env.copilot.signOut(), /token from its environment/);
});

test("phone sign-in while Copilot is off and sign-out when the host keychain refuses removal", async (t) => {
  const baseDirectory = tempDir(t);
  let saved = false;
  let loadedAccount = "octo";
  let verification;
  let retryApproval;
  let vaultReadOnly = false;
  let enabled = false;
  let rejectLogout = true;
  let approve = true;
  let logoutCalls = 0;
  const vault = new Map();
  const sdk = {
    RuntimeConnection: runtimeSdk().sdk.RuntimeConnection,
    CopilotClient: class {
      constructor({ github }) {
        this.loadSaved = github?.useLoggedInUser !== false;
        this.connected = github?.token ? github.token === "good-token" : saved && github?.useLoggedInUser !== false;
      }
      async start() {}
      async stop() { this.connected = false; }
      async getAuthStatus() {
        if (this.connected && verification) {
          verification.started.resolve();
          await verification.continue.promise;
        }
        return { isAuthenticated: this.connected, authType: "user", host: "https://github.com", login: this.connected ? loadedAccount : undefined };
      }
      async createSession() {
        const accounts = {
          login: {
            begin: async () => ({ flowId: "login", step: { kind: "device-code", userCode: "TEST", verificationUri: "https://github.com/login/device" } }),
            advance: async () => {
              if (retryApproval) await retryApproval.promise;
              if (!approve) return { kind: "error", message: "Approval declined" };
              saved = true;
              this.connected = this.loadSaved;
              return { kind: "completed", result: { status: "completed", login: "octo", host: "https://github.com" } };
            },
            cancel: async () => {},
          },
          set: async () => {
            logoutCalls++;
            if (rejectLogout) throw new Error("Request session.accounts.set failed with message: Failed to remove token: Keychain error: Couldn't access platform storage: Invalid attempt to change the owner of this item.");
            saved = this.connected = false;
            return { ok: true };
          },
        };
        return { rpc: { accounts }, sessionId: "account", disconnect: async () => {} };
      }
      async deleteSession() {}
    },
  };
  const make = () => {
    const provider = new CopilotProvider({ baseDirectory, sdk, github: () => signIns.copilotGitHub() });
    const registry = new Providers([provider]);
    registry.configure({ enabled: () => enabled });
    const signIns = new SignIns({
      providers: () => registry,
      vault: () => ({
        get: (id) => vault.get(id),
        has: (id) => vault.has(id),
        put: (value, _meta, id) => vault.set(id, value),
        remove: (id) => {
          if (vaultReadOnly) throw new Error("Vault is read-only.");
          return vault.delete(id);
        },
      }),
      enable: async () => { enabled = true; },
      changed: async () => registry.invalidate(),
    });
    return { signIns, provider };
  };
  async function login(signIns, expectedError) {
    const { session } = await signIns.start("copilot");
    let view;
    let after = 0;
    do {
      view = await signIns.read(session, { after });
      after = view.next;
    } while (!view.done);
    if (expectedError) assert.match(view.error, expectedError);
    else {
      assert.equal(view.error, undefined);
      assert.equal(view.result.account, "octo");
    }
  }
  const first = make();
  await login(first.signIns);
  assert.equal(enabled, true);
  await first.provider.stop();
  const second = make();
  assert.equal((await second.provider.auth()).connected, true);
  assert.deepEqual(await second.signIns.signOut("copilot"), { connected: false });
  assert.equal(saved, true, "the keychain still owns its item");
  await second.provider.stop();
  const third = make();
  assert.equal((await third.provider.auth()).connected, false);
  approve = false;
  await login(third.signIns, /Approval declined/);
  assert.equal((await third.provider.auth()).connected, false);
  approve = true;
  loadedAccount = "someone-else";
  await login(third.signIns, /approved account/);
  assert.equal((await third.provider.auth()).connected, false);
  loadedAccount = "octo";
  verification = { started: Promise.withResolvers(), continue: Promise.withResolvers() };
  const { session } = await third.signIns.start("copilot");
  await verification.started.promise;
  const overlap = third.provider.signIn({ device: async () => {} });
  const refused = assert.rejects(overlap, /already in progress/);
  await third.signIns.cancel(session);
  retryApproval = Promise.withResolvers();
  const { session: retry } = await third.signIns.start("copilot");
  await third.signIns.cancel(session); // A delayed repeat from the first phone session.
  await third.provider.cancelSignIn(); // The overlapping desktop never owned this login.
  verification.continue.resolve();
  verification = null;
  await refused;
  await third.signIns.sessions.get(session).over;
  assert.match(third.signIns.sessions.get(session).error ?? "", /cancelled/i);
  const view = await third.signIns.read(retry, { after: 0 });
  assert.ok(view.events.some(event => event.type === "code"));
  assert.equal((await third.provider.auth()).connected, false);
  retryApproval.resolve();
  await third.signIns.sessions.get(retry).over;
  assert.equal(third.signIns.sessions.get(retry).error, null);
  assert.equal((await third.provider.auth()).connected, true);
  await third.provider.stop();
  const fourth = make();
  assert.equal((await fourth.provider.auth()).connected, true);
  rejectLogout = false;
  assert.deepEqual(await fourth.signIns.signOut("copilot"), { connected: false });
  assert.equal(saved, false);
  await fourth.provider.stop();

  saved = true;
  enabled = false;
  const pasted = make();
  await assert.rejects(pasted.signIns.useToken("copilot", "bad-token"), /didn.t accept/);
  assert.equal(vault.size, 0);
  assert.equal(enabled, false);
  assert.equal((await pasted.signIns.useToken("copilot", "good-token")).connected, true);
  assert.equal(enabled, true);
  await assert.rejects(pasted.signIns.useToken("copilot", "bad-token"), /didn.t accept/);
  assert.equal(pasted.signIns.token("copilot"), "good-token");
  const marker = pasted.provider.signedOutFile;
  pasted.provider.signedOutFile = join(marker, "unwritable");
  await assert.rejects(pasted.signIns.signOut("copilot"), /ENOTDIR/);
  assert.equal(pasted.signIns.token("copilot"), "good-token");
  pasted.provider.signedOutFile = join(baseDirectory, "new-marker");
  vaultReadOnly = true;
  await assert.rejects(pasted.signIns.signOut("copilot"), /read-only/);
  assert.equal(existsSync(pasted.provider.signedOutFile), false);
  pasted.provider.signedOutFile = marker;
  await assert.rejects(pasted.signIns.signOut("copilot"), /read-only/);
  assert.equal(existsSync(marker), true);
  vaultReadOnly = false;
  assert.deepEqual(await pasted.signIns.signOut("copilot"), { connected: false });
  assert.equal(logoutCalls, 2, "removing a pasted token leaves the shared credential alone");
  assert.equal(vault.size, 0);
  await pasted.provider.stop();
});

test("the Copilot model list names its provider and each model's source", async (t) => {
  const { ws } = warm(t, undefined, {
    extra: {
      models: [
        { id: "gpt-x", name: "GPT X", provider: { id: "copilot", kind: "copilot" }, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
        { id: "local", policy: { state: "disabled" } },
      ],
    },
  });
  const models = await ws.models();
  assert.deepEqual(models[0], { id: "gpt-x", name: "GPT X", provider: "copilot", providerName: "GitHub Copilot", source: "copilot", efforts: ["low", "high"], defaultEffort: "low", available: true });
  assert.deepEqual(models[1], { id: "local", name: "Local", provider: "copilot", providerName: "GitHub Copilot", efforts: [], defaultEffort: undefined, available: false });
  await ws.setModel("global", null, { model: "gpt-x", provider: "copilot", reasoningEffort: "high" });
  assert.deepEqual(ws.state.settings.model, { model: "gpt-x", provider: "copilot", source: "copilot", reasoningEffort: "high" });
  // A selection saved before sources existed still matches.
  await ws.setModel("bot", "pip", { model: "gpt-x" });
  await assert.rejects(ws.setModel("bot", "pip", { model: "gpt-x", provider: "elsewhere" }), /unavailable/);
});

test("a second provider serves the chats whose model belongs to it, and a chat can move to it", async (t) => {
  // A provider with no session state of its own: it answers from the history it is handed.
  const seen = [];
  class EchoSession extends ProviderSession {
    constructor(spec) {
      super();
      this.id = spec.sessionId;
      this.spec = spec;
    }
    async send({ prompt }) {
      seen.push({ id: this.id, prompt, instructions: this.spec.instructions, history: this.spec.history().length, tools: this.spec.tools.map((x) => x.name) });
      return { text: "echo: " + prompt };
    }
  }
  class Echo extends ModelProvider {
    id = "echo";
    name = "Echo";
    deleted = [];
    async models() {
      return [{ id: "echo-1", name: "Echo 1", provider: "echo", efforts: [], available: true }];
    }
    async openSession(spec) {
      return new EchoSession(spec);
    }
    async deleteSession(id) {
      this.deleted.push(id);
    }
  }
  const echo = new Echo();
  const { ws, log } = warm(t, async (_id, options) => ({ data: { content: "copilot: " + options.prompt } }), { more: [echo] });
  assert.deepEqual((await ws.models()).map((m) => [m.id, m.provider]), [["auto", "copilot"], ["echo-1", "echo"]]);
  const id = ws.createChat("pip");
  await ws.send(id, "First");
  assert.equal(ws.chat(id).messages.at(-1).text, "copilot: First");
  assert.equal(ws.chat(id).sessionProvider, "copilot");
  // The chat's model moves to the other provider: its Copilot session ends and the transcript goes along.
  await ws.setModel("chat", id, { model: "echo-1", provider: "echo" });
  await ws.send(id, "Second");
  const chat = ws.chat(id);
  assert.equal(chat.messages.at(-1).text, "echo: Second");
  assert.equal(chat.sessionProvider, "echo");
  assert.deepEqual(log.deleted, [id], "the old provider's session is removed");
  assert.equal(seen[0].prompt, "Second");
  assert.match(seen[0].instructions, /earlier-conversation[\s\S]*First[\s\S]*copilot: First/);
  assert.doesNotMatch(seen[0].instructions, /earlier-conversation[\s\S]*User: Second/, "the new message isn't repeated in the transcript");
  assert.ok(seen[0].tools.includes("memory_save"), "Botkins' own tools work with any provider");
  assert.equal(seen[0].history, 3);
  // A bot whose default model is on the second provider starts there directly; deleting its chat tells that provider.
  await ws.setModel("bot", "scout", { model: "echo-1", provider: "echo" });
  const second = ws.createChat("scout");
  await ws.send(second, "Hello");
  assert.equal(ws.chat(second).messages.at(-1).text, "echo: Hello");
  assert.deepEqual(log.created, [id], "Copilot never saw the second bot's chat");
  await ws.agents.deleteChat(second);
  assert.deepEqual(echo.deleted, [second]);
});

test("only the Copilot adapter folder imports the Copilot SDK", async () => {
  const { readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const offenders = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") scan(path);
      } else if (/\.(mjs|cjs|ts|tsx)$/.test(entry.name) && /copilot-sdk|@github\/copilot/.test(readFileSync(path, "utf8")))
        offenders.push(path);
    }
  };
  const root = fileURLToPath(new URL("../", import.meta.url));
  scan(join(root, "desktop"));
  scan(join(root, "src"));
  const adapter = join(root, "desktop", "providers", "copilot");
  assert.deepEqual(offenders.filter((path) => !path.startsWith(adapter)), [], "a model backend's SDK stays inside its provider folder");
  assert.ok(offenders.length >= 1);
});

/** A provider whose model list is whatever `list` holds, and that can be made to wait before it answers. */
class Listing extends ModelProvider {
  constructor(id, list) {
    super();
    Object.assign(this, { id, name: id, list, gate: null });
  }
  async models() {
    if (this.gate) await this.gate;
    return this.list;
  }
}

test("a selection's catalog entry is unknown until its provider has listed, then it is the entry", async () => {
  const a = new Listing("a", [{ id: "m1", provider: "a", contextWindow: 200000 }, { id: "m2", provider: "a" }]);
  const providers = new Providers([a]);
  assert.equal(providers.known({ model: "m1", provider: "a" }), null, "nothing was asked yet");
  await providers.models();
  assert.deepEqual(providers.known({ model: "m1", provider: "a" }), { id: "m1", provider: "a", contextWindow: 200000 });
  assert.deepEqual(providers.known({ model: "m2", provider: "a" }), { id: "m2", provider: "a" });
});

test("a selection's catalog entry is looked up in the provider that serves it", async () => {
  const a = new Listing("a", [{ id: "shared", provider: "a", contextWindow: 1000 }]);
  const b = new Listing("b", [{ id: "shared", provider: "b", contextWindow: 2000 }]);
  const providers = new Providers([a, b]);
  await providers.models();
  assert.equal(providers.known({ model: "shared", provider: "b" }).contextWindow, 2000);
  assert.equal(providers.known({ model: "shared", provider: "a" }).contextWindow, 1000);
  assert.equal(providers.known({ model: "shared" }).contextWindow, 1000, "a selection without a provider is the default provider's");
});

test("a model the catalog does not have, or a selection that names none, is unknown", async () => {
  const providers = new Providers([new Listing("a", [{ id: "m1", provider: "a" }])]);
  await providers.models();
  assert.equal(providers.known({ model: "nope", provider: "a" }), null);
  assert.equal(providers.known({ provider: "a" }), null);
  assert.equal(providers.known(null), null);
  assert.equal(providers.known(undefined), null);
});

test("a catalog entry is unknown again after the provider is forgotten", async () => {
  const providers = new Providers([new Listing("a", [{ id: "m1", provider: "a" }])]);
  await providers.models();
  providers.invalidate("a");
  assert.equal(providers.known({ model: "m1", provider: "a" }), null);
});

test("a catalog entry stays the old one while a refresh is under way, and is the new one after", async () => {
  const a = new Listing("a", [{ id: "m1", provider: "a", contextWindow: 100000 }]);
  const providers = new Providers([a], { modelsWait: 5 });
  await providers.models();
  const selection = { model: "m1", provider: "a" };
  // Its remembered list has gone stale and the provider is slow to list again.
  providers.modelCache.get("a").time = 0;
  let release;
  a.gate = new Promise((resolve) => (release = resolve));
  a.list = [{ id: "m1", provider: "a", contextWindow: 500000 }];
  await providers.models();
  assert.equal(providers.modelCache.get("a").loading !== null, true, "the refresh is still under way");
  assert.equal(providers.known(selection).contextWindow, 100000, "what was listed before still answers");
  release();
  await providers.modelCache.get("a").loading;
  assert.equal(providers.known(selection).contextWindow, 500000);
});

test("a Copilot model carries the limits, abilities, maker and price class GitHub lists for it", async (t) => {
  const fake = fakeClient(undefined, {
    models: [
      {
        id: "gpt-x",
        name: "GPT X",
        vendor: "Example Labs",
        modelPickerPriceCategory: "premium",
        capabilities: { limits: { max_context_window_tokens: 400000, max_prompt_tokens: 272000, max_output_tokens: 128000 }, supports: { vision: true, tool_calls: true } },
      },
      { id: "plain", name: "Plain" },
    ],
  });
  const copilot = new CopilotProvider({ connect: fake.client });
  t.after(() => copilot.stop());
  const [full, plain] = await copilot.models();
  assert.deepEqual(
    [full.contextWindow, full.maxPrompt, full.maxOutput, full.vision, full.tools, full.vendor, full.tier],
    [400000, 272000, 128000, true, true, "Example Labs", "premium"],
  );
  for (const key of ["contextWindow", "maxPrompt", "maxOutput", "vision", "tools", "vendor", "tier", "effortNotes", "description", "knowledge"]) assert.equal(key in plain, false, "a model GitHub says nothing about has no " + key);
});

test("a Copilot model keeps the abilities GitHub says it lacks and drops limits that are not real", async (t) => {
  const fake = fakeClient(undefined, {
    models: [{ id: "small", capabilities: { limits: { max_context_window_tokens: 0, max_prompt_tokens: "big", max_output_tokens: 8192 }, supports: { vision: false, tool_calls: false } } }],
  });
  const copilot = new CopilotProvider({ connect: fake.client });
  t.after(() => copilot.stop());
  const [small] = await copilot.models();
  assert.deepEqual([small.vision, small.tools, small.maxOutput], [false, false, 8192]);
  assert.equal("contextWindow" in small || "maxPrompt" in small, false);
});

test("Copilot's model details reach the workspace's catalog and the context meter's limit", async (t) => {
  const { ws } = warm(t, undefined, { extra: { models: [{ id: "gpt-x", name: "GPT X", capabilities: { limits: { max_context_window_tokens: 400000, max_prompt_tokens: 272000 } } }, { id: "gpt-y", name: "GPT Y", capabilities: { limits: { max_context_window_tokens: 64000 } } }] } });
  const catalog = await ws.models();
  assert.deepEqual([catalog[0].contextWindow, catalog[0].maxPrompt], [400000, 272000]);
  assert.equal(ws.metered({ type: "session.usage_info", data: { currentTokens: 1, tokenLimit: 1 } }, { model: "gpt-x", provider: "copilot" }).data.tokenLimit, 272000);
  assert.equal(ws.metered({ type: "session.usage_info", data: { currentTokens: 1, tokenLimit: 1 } }, { model: "gpt-y", provider: "copilot" }).data.tokenLimit, 64000);
});

// ---- Who asks the keychain for the Copilot sign-in (see the top of desktop/providers/copilot/index.mjs) ----

/** An SDK stand-in that records how the runtime was asked for and what the client was given. */
function runtimeSdk({ failInProcess = false, failSpawned = false } = {}) {
  const log = [];
  const sdk = {
    RuntimeConnection: {
      forInProcess: (options) => (log.push(["inprocess", options]), { kind: "inprocess" }),
      forSpawnedStdio: (options) => (log.push(["spawned", options]), { kind: "spawned" }),
    },
    CopilotClient: class {
      constructor(options) {
        this.options = options;
        log.push(["client", options.runtime.kind, options.github, options.mode]);
      }
      async start() {
        if (this.options.runtime.kind === "inprocess" && failInProcess) throw new Error("the native library didn't load");
        if (this.options.runtime.kind === "spawned" && failSpawned) throw new Error("the program didn't start");
        log.push(["started", this.options.runtime.kind]);
      }
    },
  };
  return { sdk, log };
}
const withRuntimeEnv = async (value, run) => {
  const before = process.env.BOTKINS_COPILOT_RUNTIME;
  if (value === undefined) delete process.env.BOTKINS_COPILOT_RUNTIME;
  else process.env.BOTKINS_COPILOT_RUNTIME = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.BOTKINS_COPILOT_RUNTIME;
    else process.env.BOTKINS_COPILOT_RUNTIME = before;
  }
};

test("on a Mac the Copilot runtime is its own program, never loaded into Botkins, so the keychain sees Copilot", async () => {
  await withRuntimeEnv(undefined, async () => {
    const { sdk, log } = runtimeSdk();
    const provider = new CopilotProvider({ baseDirectory: "/data/copilot", workingDirectory: "/data", platform: "darwin", sdk });
    await provider.client();
    assert.deepEqual(log, [["spawned", { baseDirectory: "/data/copilot", workingDirectory: "/data" }], ["client", "spawned", undefined, "coding-agent"], ["started", "spawned"]]);
    assert.equal(provider.inProcess(), false);
  });
});

test("on a Mac a runtime that can't start is an error, never a quiet switch to the in-process one", async () => {
  await withRuntimeEnv(undefined, async () => {
    const { sdk, log } = runtimeSdk({ failSpawned: true });
    const provider = new CopilotProvider({ baseDirectory: "/data/copilot", platform: "darwin", sdk });
    await assert.rejects(provider.client(), /the program didn't start/);
    assert.ok(!log.some(([kind]) => kind === "inprocess"));
    // The next try starts again rather than remembering the failure.
    await assert.rejects(provider.client(), /the program didn't start/);
  });
});

test("on Windows and Linux the runtime is loaded in-process, with a child process when that can't load", async () => {
  await withRuntimeEnv(undefined, async () => {
    for (const platform of ["win32", "linux"]) {
      const fine = runtimeSdk();
      await new CopilotProvider({ baseDirectory: "/d", platform, sdk: fine.sdk }).client();
      assert.deepEqual(fine.log, [["inprocess", { baseDirectory: "/d" }], ["client", "inprocess", undefined, "coding-agent"], ["started", "inprocess"]], platform);
      const broken = runtimeSdk({ failInProcess: true });
      await new CopilotProvider({ baseDirectory: "/d", workingDirectory: "/w", platform, sdk: broken.sdk }).client();
      assert.deepEqual(broken.log.filter(([kind]) => kind === "client" || kind === "started").map((entry) => entry.slice(0, 2)), [["client", "inprocess"], ["client", "spawned"], ["started", "spawned"]], platform);
    }
  });
});

test("the runtime's place can be chosen for a trial, on any system", async () => {
  await withRuntimeEnv("inprocess", async () => {
    const { sdk, log } = runtimeSdk();
    const provider = new CopilotProvider({ platform: "darwin", sdk });
    assert.equal(provider.inProcess(), true);
    await provider.client();
    assert.deepEqual(log.at(-1), ["started", "inprocess"]);
  });
  await withRuntimeEnv("stdio", async () => {
    const { sdk, log } = runtimeSdk();
    await new CopilotProvider({ platform: "linux", sdk }).client();
    assert.deepEqual(log.at(-1), ["started", "spawned"]);
  });
  // Asked for in-process on a Mac and it can't load: an error, with no fallback either way.
  await withRuntimeEnv("inprocess", async () => {
    const { sdk, log } = runtimeSdk({ failInProcess: true });
    await assert.rejects(new CopilotProvider({ platform: "darwin", sdk }).client(), /native library/);
    assert.ok(!log.some(([kind]) => kind === "spawned"));
  });
});

test("a trial run's runtime is given its sign-in, so it never asks the keychain for the person's", async () => {
  await withRuntimeEnv(undefined, async () => {
    const withToken = runtimeSdk();
    await new CopilotProvider({ platform: "darwin", sdk: withToken.sdk, github: () => ({ token: "token-for-the-test" }) }).client();
    assert.deepEqual(withToken.log.find(([kind]) => kind === "client")[2], { token: "token-for-the-test" });
    const signedOut = runtimeSdk();
    await new CopilotProvider({ platform: "darwin", sdk: signedOut.sdk, github: () => ({ useLoggedInUser: false }) }).client();
    assert.deepEqual(signedOut.log.find(([kind]) => kind === "client")[2], { useLoggedInUser: false });
    // The installed app passes nothing: the runtime uses the person's saved sign-in, as GitHub's own program.
    const own = runtimeSdk();
    await new CopilotProvider({ platform: "darwin", sdk: own.sdk }).client();
    assert.equal(own.log.find(([kind]) => kind === "client")[2], undefined);
    assert.ok(!("github" in own.log.find(([kind]) => kind === "client")), "nothing is passed, not even an empty choice");
  });
});

test("a Botkins tool that throws tells the model why, in the tool's own words, on the Copilot runtime", async () => {
  // Thrown, the runtime tells the model only "Tool execution failed", and the bot can't learn the rule.
  const failing = spoken("task_create", async () => {
    throw new Error("Create at most ten tasks per reply.");
  });
  assert.deepEqual(await failing({}), { textResultForLlm: "Create at most ten tasks per reply.", resultType: "failure", error: "Create at most ten tasks per reply." });
  assert.equal(await spoken("ok", async (args) => JSON.stringify(args))({ a: 1 }), '{"a":1}', "a tool that works is passed through untouched");
  assert.equal(spoken("sync", () => "plain")(), "plain", "a tool that answers at once still does");
  assert.equal(spoken("sync", () => { throw new Error("No."); })().textResultForLlm, "No.");
  assert.equal((await spoken("odd", () => { throw undefined; })()).textResultForLlm, "The tool failed.");
  assert.equal((await spoken("long", () => { throw new Error("x".repeat(5000)); })()).textResultForLlm.length, 2000);
  // Every tool of a session goes to the runtime wrapped this way.
  const options = sessionOptions({ sessionId: "s", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} }, handler: () => { throw new Error("Not like that."); }, skipPermission: true }], handlers: {}, model: { model: "m" }, approval: "ask", instructions: "" }, {});
  const tool = (options.tools?.definitions ?? options.tools ?? []).find((each) => each.name === "t");
  assert.ok(tool, "the tool is defined for the session");
  assert.equal((await tool.handler({}, {})).textResultForLlm, "Not like that.");
});

test("the Copilot plan and its quota come from GitHub's runtime, with the reset date of the account", async (t) => {
  const snapshot = (more) => ({ isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, usageAllowedWithExhaustedQuota: false, overage: 0, overageAllowedWithExhaustedQuota: false, remainingPercentage: 100, resetDate: new Date().toISOString(), hasQuota: true, ...more });
  let auth = { isAuthenticated: true, login: "octo", authType: "user", host: "https://github.com" };
  const asked = [];
  const fake = fakeClient(undefined, {
    auth: () => auth,
    client: {
      rpc: {
        sessions: { fork: async () => ({ sessionId: null }) },
        account: {
          getQuota: async (params) => (asked.push(params), { quotaSnapshots: { chat: snapshot({ isUnlimitedEntitlement: true }), premium_interactions: snapshot({ entitlementRequests: 1500, usedRequests: 570, remainingPercentage: 62 }) } }),
          getCurrentAuth: async () => ({ authInfo: { type: "user", host: "https://github.com", copilotUser: { login: "octo", copilot_plan: "individual_pro", quota_reset_date_utc: "2099-01-01T00:00:00.000Z", organization_login_list: ["octo-org"] } } }),
        },
      },
    },
  });
  const copilot = new CopilotProvider({ connect: fake.client });
  t.after(() => copilot.stop());
  const usage = await copilot.usage();
  assert.deepEqual(asked, [{}], "the quota of the account that is signed in: no token is handed over");
  assert.deepEqual(usage, {
    account: "subscription",
    plan: "GitHub Copilot Pro+",
    limits: [
      { id: "premium", label: "Premium requests", window: "month", percentRemaining: 62, resetAt: Date.parse("2099-01-01T00:00:00Z"), used: 570, limit: 1500, unit: "requests" },
      { id: "chat", label: "Chat", window: "month", unlimited: true },
    ],
    source: "GitHub Copilot",
  });
  assert.ok(!JSON.stringify(usage).includes("octo"), "no login or organization is in the answer");
  auth = { isAuthenticated: true, authType: "api-key" };
  assert.deepEqual(await copilot.usage(), { account: "api-key", limits: [], source: "GitHub Copilot" });
  auth = { isAuthenticated: false };
  await assert.rejects(copilot.usage(), /isn't signed in/);
  // A runtime without the quota call can't say: null, which the app shows as "not available".
  const old = new CopilotProvider({ connect: fakeClient().client });
  t.after(() => old.stop());
  assert.equal(await old.usage(), null);
});

test("a restarted plan gateway reopens the same session with the new listener and one Work row", async (t) => {
  const plan = Object.assign(new ModelProvider(), { id: "codex", name: "ChatGPT" });
  let oldListener;
  const { ws, log } = warm(t, async (_id, options) => {
    if (!oldListener) {
      oldListener = ws.harness.gateway.server;
      await ws.harness.gateway.stop();
      throw new Error("The model stream ended");
    }
    assert.notEqual(ws.harness.gateway.server, oldListener);
    assert.match(options.prompt, /Continue the unfinished reply/);
    return { data: { content: "Recovered" } };
  }, { more: [plan] });
  t.after(() => ws.harness.stop());
  // The Copilot runtime hosts the plan model: chosen, since Pi is the default now (desktop/harness).
  Object.assign(ws.state.settings, { harness: "copilot", harnessPicked: true });
  const id = ws.createChat("pip");
  ws.chat(id).model = { provider: "codex", model: "plan-model" };
  await ws.send(id, "Make a list");
  assert.deepEqual(log.resumed, [id]);
  assert.deepEqual(ws.state.runs.map((r) => r.status), ["Completed"]);
  assert.deepEqual(ws.chat(id).messages.map((m) => m.text), ["Make a list", "Recovered"]);
});

test("a transport disconnect recovers a journaled final reply without sending another prompt", async (t) => {
  const { ws, sdk, log } = warm(t, async (_id, _options, session) => {
    session.emit({ type: "user.message", id: "event", data: { messageId: "request" } });
    throw new Error("Session disconnected while waiting for a response");
  });
  const resume = sdk.resumeSession;
  sdk.resumeSession = async (...args) => Object.assign(await resume(...args), {
    getEvents: async () => [
      { type: "user.message", id: "event", data: { messageId: "request" } },
      { type: "assistant.message", data: { originatingMessageId: "request", content: "Already finished" } },
      { type: "assistant.turn_end" },
    ],
  });
  const id = ws.createChat("pip");
  await ws.send(id, "Check once");
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.equal(ws.chat(id).messages.at(-1).text, "Already finished");
  assert.equal(log.sent.length, 1);
});

test("an open checklist follows a provider round trip across prewarm and reload", async (t) => {
  const first = [{ id: "a", title: "Inspect archive", status: "in_progress" }];
  const next = [...first.map(row => ({ ...row, status: "done" })), { id: "b", title: "Verify copy", status: "pending" }];
  const finished = next.map(row => ({ ...row, status: "done" }));
  const prompts = [];
  class OtherSession extends ProviderSession {
    on(listener) { this.listener = listener; return () => {}; }
    async todos() { return this.plan ?? null; }
    async send({ prompt }) {
      prompts.push(prompt);
      this.plan = { rows: next };
      this.listener({ type: "session.todos_changed", data: {} });
      return { text: "Ready for verification?" };
    }
  }
  class Other extends ModelProvider {
    id = "other";
    name = "Other";
    async models() { return [{ id: "other-1", provider: this.id, available: true }]; }
    async openSession() { return new OtherSession(); }
    async deleteSession() {}
  }
  const { ws, dir } = warm(t, async (_id, { prompt }, sdk) => {
    prompts.push(prompt);
    sdk.rows = prompt.startsWith("Start") ? first : finished;
    sdk.rpc.plan = { readSqlTodosWithDependencies: async () => ({ rows: sdk.rows }) };
    sdk.emit({ type: "session.todos_changed", data: {} });
    return { data: { content: "Ready?" } };
  }, { more: [new Other()] });
  const chat = ws.createChat("pip");
  await ws.send(chat, "Start");
  assert.deepEqual(ws.chat(chat).todos, first);
  await ws.setModel("chat", chat, { model: "other-1", provider: "other" });
  await ws.prewarm(chat);
  await ws.send(chat, "Advance the checklist");
  assert.ok(prompts.at(-1).includes(JSON.stringify(first)));
  assert.deepEqual(ws.chat(chat).todos, next);
  await ws.setModel("chat", chat, { model: "auto", provider: "copilot" });
  await ws.send(chat, "Finish the checklist");
  assert.ok(prompts.at(-1).includes(JSON.stringify(next)));
  assert.deepEqual(ws.state.runs[0].todos, finished);
  assert.deepEqual(new Workspace(join(dir, "data"), ws.providers, () => {}).chat(chat).todos, finished);
});
