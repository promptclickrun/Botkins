import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";

test("a chat survives reopen, resumes its session and records one work item per prompt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    send: async ({ prompt }) => {
      const messageId = "message:" + prompt;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: prompt } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const client = async () => ({
    createSession: async (cfg) => {
      calls.push(cfg.sessionId);
      return session;
    },
    resumeSession: async (id) => {
      calls.push(id);
      return session;
    },
  });
  const open = () =>
    new Workspace(
      dir,
      client,
      () => {},
      () => ({ kind: "reject" }),
    );
  const first = open();
  const bot = first.addBot({
    name: "Nova",
    role: "Editor",
    instructions: "Edit prose",
    face: "idle",
  });
  const id = first.createChat(bot);
  const started = first.send(id, "First");
  assert.throws(() => first.send(id, "Overlap"));
  await started;
  const second = open();
  await second.send(id, "Second");
  assert.deepEqual(calls, [id, id]);
  assert.deepEqual(
    second.state.chats[0].messages.map((m) => m.text),
    ["First", "First", "Second", "Second"],
  );
  assert.deepEqual(
    second.state.runs.map((r) => r.status),
    ["Completed", "Completed"],
  );
});

test("a failed reply can be retried and an active run resumes in place after restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = new Set();
  const emit = (event) => handlers.forEach((handler) => handler(event));
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit,
    send: async () => {
      throw new Error("Copilot is unavailable");
    },
    abort: async () => {},
    disconnect: async () => {},
  };
  const client = async () => ({
    createSession: async () => session,
    resumeSession: async () => session,
  });
  const open = () =>
    new Workspace(
      dir,
      client,
      () => {},
      () => ({ kind: "reject" }),
    );
  const workspace = open();
  const id = workspace.createChat("pip");
  await workspace.send(id, "Hello");
  assert.equal(workspace.state.runs[0].status, "Needs you");
  assert.match(workspace.state.runs[0].detail, /unavailable/);
  session.send = async () => {
    const messageId = "message:retry";
    emit({ type: "user.message", id: messageId, data: { messageId } });
    emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Hello again" } });
    emit({ type: "session.idle", data: { mode: "interactive" } });
    return messageId;
  };
  await workspace.send(id, "Retry");
  assert.equal(workspace.state.runs[0].status, "Completed");
  let finish;
  session.send = () =>
    new Promise((resolve) => {
      finish = () => {
        const messageId = "message:stopped";
        emit({ type: "user.message", id: messageId, data: { messageId } });
        emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "late" } });
        emit({ type: "session.idle", data: { mode: "interactive" } });
        resolve(messageId);
      };
    });
  const started = workspace.send(id, "One more");
  await new Promise((resolve) => setImmediate(resolve));
  const again = open();
  const resumed = [];
  session.send = async ({ prompt }) => {
    resumed.push(prompt);
    const messageId = "message:resume";
    emit({ type: "user.message", id: messageId, data: { messageId } });
    emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Finished after restart" } });
    emit({ type: "session.idle", data: { mode: "interactive" } });
    return messageId;
  };
  assert.equal(again.state.runs[0].status, "Working");
  await Promise.all(again.resumeActive());
  assert.match(resumed[0], /One more/);
  assert.match(resumed[0], /continue/i);
  assert.equal(again.state.runs[0].id, workspace.state.runs[0].id);
  assert.equal(again.state.runs[0].status, "Completed");
  assert.deepEqual(again.chat(id).messages.slice(-2).map((m) => m.text), ["One more", "Finished after restart"]);
  assert.deepEqual(again.resumeActive(), []);
  await workspace.stop(id);
  finish();
  await started;
  assert.equal(workspace.state.runs[0].status, "Stopped");
  assert.equal(Object.keys(workspace.snapshot().streams).length, 0);
});

test("the side menu's order and collapsed state are settings", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SIDEBAR, sidebarField } = await import("../desktop/preferences.mjs");
  const dir = mkdtempSync(join(tmpdir(), "botkins-sidebar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  // The usual menu shows icons only.
  assert.deepEqual(ws.state.settings.sidebar, { order: ["Home", "Today", "Chats", "Work", "Wiki"], collapsed: true });
  // A new order names the places it cares about; the rest follow in their usual order. Unknown and repeated names are dropped.
  ws.setPreferences({ sidebar: { order: ["Wiki", "Chats", "Nope", "Wiki"] } });
  assert.deepEqual(ws.state.settings.sidebar, { order: ["Wiki", "Chats", "Home", "Today", "Work"], collapsed: true }, "reordering is not a choice about icons");
  // Opening the menu is the person's choice, and is kept as one.
  ws.setPreferences({ sidebar: { collapsed: false } });
  assert.deepEqual(ws.state.settings.sidebar, { order: ["Wiki", "Chats", "Home", "Today", "Work"], collapsed: false, picked: true }, "opening keeps the order");
  ws.setPreferences({ sidebar: { order: [...SIDEBAR].reverse() } });
  assert.equal(ws.state.settings.sidebar.collapsed, false, "reordering keeps the open menu");
  for (const bad of ["Home", ["Home"], { order: "Home" }, { order: [1] }, { collapsed: "yes" }, { picked: "yes" }])
    assert.throws(() => ws.setPreferences({ sidebar: bad }), /side menu/);
  // It survives a restart, and a menu saved before a place existed gains that place.
  const again = new Workspace(dir, async () => ({}), () => {});
  assert.deepEqual(again.state.settings.sidebar, { order: [...SIDEBAR].reverse(), collapsed: false, picked: true });
  again.setPreferences({ sidebar: { collapsed: true } });
  assert.deepEqual(new Workspace(dir, async () => ({}), () => {}).state.settings.sidebar, { order: [...SIDEBAR].reverse(), collapsed: true, picked: true }, "so does collapsing it again");
  assert.deepEqual(sidebarField({ order: ["Chats", "Home"] }).order, ["Chats", "Home", "Today", "Work", "Wiki"]);
  // Places that no longer exist are dropped. The remaining places keep their order.
  assert.deepEqual(sidebarField({ order: ["Wiki", "Old page", "Home", "Projects"], collapsed: true }).order, ["Wiki", "Home", "Today", "Chats", "Work"]);
  assert.deepEqual(sidebarField({ order: ["Projects", "Work", "Wiki", "Home", "Today", "Chats"] }).order, ["Work", "Wiki", "Home", "Today", "Chats"]);
  const old = join(dir, "old");
  mkdirSync(old);
  writeFileSync(join(old, "workspace.json"), JSON.stringify({ bots: [], chats: [], runs: [], settings: { sidebar: { order: ["Work", "Home"], collapsed: "broken" } } }));
  assert.deepEqual(new Workspace(old, async () => ({}), () => {}).state.settings.sidebar, { order: [...SIDEBAR], collapsed: true }, "a damaged setting falls back to the usual menu");
  // A menu saved open before the choice was recorded was only the usual menu of its day: it becomes
  // today's usual menu, in its own order. One saved collapsed stays collapsed.
  const earlier = join(dir, "earlier");
  mkdirSync(earlier);
  writeFileSync(join(earlier, "workspace.json"), JSON.stringify({ bots: [], chats: [], runs: [], settings: { sidebar: { order: ["Work", "Home"], collapsed: false } } }));
  const moved = new Workspace(earlier, async () => ({}), () => {});
  assert.deepEqual(moved.state.settings.sidebar, { order: ["Work", "Home", "Today", "Chats", "Wiki"], collapsed: true });
  assert.deepEqual(sidebarField({ order: SIDEBAR, collapsed: true }), { order: [...SIDEBAR], collapsed: true });
  // Once opened by the person, it stays open across restarts.
  moved.setPreferences({ sidebar: { collapsed: false } });
  assert.equal(new Workspace(earlier, async () => ({}), () => {}).state.settings.sidebar.collapsed, false);
});

test("a turn's live text starts a new paragraph when a new message begins", async () => {
  const { appendStream } = await import("../desktop/workspace.mjs");
  // The Copilot runtime: two pieces of commentary around a tool call, each under its own message id.
  const task = { stream: "" };
  for (const data of [
    { messageId: "a", deltaContent: "I'll pull a fresh copy of today's" },
    { messageId: "a", deltaContent: " calendar." },
    { messageId: "b", deltaContent: "Two calendars had more results" },
    { messageId: "b", deltaContent: ", so I'm getting the rest." },
  ])
    appendStream(task, data);
  assert.equal(task.stream, "I'll pull a fresh copy of today's calendar.\n\nTwo calendars had more results, so I'm getting the rest.");
  // A message that starts with nothing adds no break yet; one that follows a line break adds none either.
  appendStream(task, { messageId: "c", deltaContent: "" });
  assert.ok(task.stream.endsWith("the rest."));
  appendStream(task, { messageId: "c", deltaContent: "Done." });
  assert.ok(task.stream.endsWith("the rest.\n\nDone."));
  const listed = { stream: "First.\n" };
  appendStream(listed, { messageId: "x", deltaContent: "one" });
  appendStream(listed, { messageId: "y", deltaContent: "two" });
  assert.equal(listed.stream, "First.\none\n\ntwo");
  // The other providers' adapters send no id and put their own break in: their text is taken as it comes.
  const plain = { stream: "" };
  for (const deltaContent of ["One.", "\n\n", "Two."]) appendStream(plain, { deltaContent });
  assert.equal(plain.stream, "One.\n\nTwo.");
});

// A chat's context meter counts to the catalog's limit for the model (maxPrompt, else contextWindow).
function metering(t, known) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-meter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {}, () => ({ kind: "reject" }));
  const asked = [];
  ws.providers.known = (selection) => (asked.push(selection), typeof known === "function" ? known(selection) : known);
  return { ws, asked };
}
const usage = (data = { currentTokens: 1200, tokenLimit: 128000 }, extra = {}) => ({ type: "session.usage_info", data, ...extra });
const selection = { model: "gpt-x", provider: "codex" };

test("a context report counts to the model's prompt limit when the catalog has one", (t) => {
  const { ws, asked } = metering(t, { id: "gpt-x", maxPrompt: 258400, contextWindow: 272000 });
  const out = ws.metered(usage(), selection);
  assert.deepEqual(out.data, { currentTokens: 1200, tokenLimit: 258400 });
  assert.deepEqual(asked, [selection], "the catalog is asked about the chat's own model");
});

test("a context report counts to the model's window when the catalog has no prompt limit", (t) => {
  const { ws } = metering(t, { id: "gpt-x", contextWindow: 272000 });
  assert.equal(ws.metered(usage(), selection).data.tokenLimit, 272000);
});

test("a context report keeps what the harness reported when the catalog knows neither limit", (t) => {
  for (const known of [{ id: "gpt-x" }, { id: "gpt-x", maxOutput: 4000 }, null, undefined]) {
    const { ws } = metering(t, known);
    const event = usage();
    assert.equal(ws.metered(event, selection), event, "the same event, untouched");
    assert.equal(event.data.tokenLimit, 128000);
  }
});

test("the meter changes only the limit of a report, and leaves the event it was given as it was", (t) => {
  const { ws } = metering(t, { id: "gpt-x", contextWindow: 272000 });
  const event = usage({ currentTokens: 5, tokenLimit: 100, extra: "kept" }, { id: "e1" });
  const out = ws.metered(event, selection);
  assert.deepEqual(out, { type: "session.usage_info", id: "e1", data: { currentTokens: 5, tokenLimit: 272000, extra: "kept" } });
  assert.equal(event.data.tokenLimit, 100, "the original is not changed");
});

test("events of other types are left alone", (t) => {
  const { ws, asked } = metering(t, { id: "gpt-x", contextWindow: 272000 });
  for (const event of [{ type: "assistant.usage", data: { tokenLimit: 1 } }, { type: "assistant.message_delta", data: { deltaContent: "hi" } }, { type: "session.idle", data: {} }]) assert.equal(ws.metered(event, selection), event);
  assert.deepEqual(asked, [], "the catalog is not even asked");
});

test("a report from a helper agent is left alone", (t) => {
  const { ws } = metering(t, { id: "gpt-x", contextWindow: 272000 });
  const event = usage(undefined, { agentId: "t5" });
  assert.equal(ws.metered(event, selection), event);
  assert.equal(event.data.tokenLimit, 128000);
});

test("a report with no data, and no event at all, are left alone", (t) => {
  const { ws } = metering(t, { id: "gpt-x", contextWindow: 272000 });
  const bare = { type: "session.usage_info" };
  assert.equal(ws.metered(bare, selection), bare);
  assert.equal(ws.metered(undefined, selection), undefined);
  assert.equal(ws.metered(null, selection), null);
});

test("a context report is metered by the provider that serves the chat's model", (t) => {
  const { ws } = metering(t, (s) => (s.provider === "claude" ? { contextWindow: 1_000_000 } : { contextWindow: 200000 }));
  assert.equal(ws.metered(usage(), { model: "opus", provider: "claude" }).data.tokenLimit, 1_000_000);
  assert.equal(ws.metered(usage(), { model: "gpt-x", provider: "codex" }).data.tokenLimit, 200000);
});

test("a stopped turn stays stopped across a crash, and its queued message is delivered once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-stopped-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { fakeClient } = await import("./fake-copilot.mjs");
  const pending = Promise.withResolvers();
  const { client } = fakeClient(() => pending.promise);
  const first = new Workspace(dir, client, () => {});
  const id = first.createChat("pip");
  const old = first.send(id, "Stop this");
  await new Promise((resolve) => setImmediate(resolve));
  first.submit(id, "Do this next");
  await first.stop(id);
  const replacement = fakeClient();
  const again = new Workspace(dir, replacement.client, () => {});
  again.resumeActive();
  await again.active.get(id).done;
  assert.deepEqual(again.state.runs.map((r) => r.status), ["Completed", "Stopped"]);
  assert.deepEqual(replacement.log.sent.map(([, prompt]) => prompt), ["Do this next"]);
  assert.equal(again.queues.size, 0);
  first.closing = true;
  pending.resolve({ data: { content: "" } });
  await old;
});

test("live speech streams into the chat and reopens as one user message", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-voice-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => new Workspace(dir, async () => ({}), () => {});
  const ws = open();
  const id = ws.createChat("pip");
  assert.equal(typeof ws.recordVoiceLine, "function");
  ws.recordVoiceLine(id, "call:u1", "Turn", false);
  assert.equal(ws.chat(id).messages.at(-1).text, "Turn");
  ws.recordVoiceLine(id, "call:u1", "Turn left.", true);
  const restored = open();
  restored.recordVoiceLine(id, "call:u1", "Turn", false);
  assert.deepEqual(restored.chat(id).messages.map(m => [m.role, m.text]), [["user", "Turn left."]]);
  assert.equal(restored.state.runs.filter(r => r.chatId === id).length, 0);
});
