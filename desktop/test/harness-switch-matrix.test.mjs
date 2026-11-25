// Comprehensive harness-switching matrix & stale-ref recovery tests.
//
// Covers:
//  1. A -> B -> A: A's native session is NOT deleted on switch, B sees A's turns via transcript
//     handoff, and switching back to A resumes A's native session with B's turns handed off.
//  2. A -> B -> C -> A across 3+ harnesses (including Main chat, ordinary chat, native-forked chat).
//  3. Native fork keeps Botkins' chat.id separate from the harness-native ref, so switching to
//     another harness afterwards never leaks harness A's ref into harness B.
//  4. Group-member sessions (memberSessionId) survive harness switches and retain context.
//  5. Helper/teammate sessions (helperSessionId) survive harness switches and retain context.
//  6. Migration of legacy single-provider chat shape (including Sherlock's broken OMP chat where
//     a foreign ref was handed to OMP / missing from omp/sessions.json) recovers automatically
//     with no manual steps and preserves the transcript.
//  7. Stale / missing native ref recovery via shared `resumeOrRecover` on ALL 7 providers:
//     Pi, OMP, Claude Code, Codex, Copilot, OpenCode, and ACP — each falls back to a fresh
//     session with the Botkins transcript instead of throwing, and persists the new ref.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace, starterBots } from "./starter.mjs";
import { ModelProvider, ProviderSession, Providers } from "../desktop/providers/index.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { CodexProvider } from "../desktop/providers/codex/index.mjs";
import { ClaudeProvider } from "../desktop/providers/claude/index.mjs";
import { OpenCodeProvider } from "../desktop/providers/opencode/index.mjs";
import { AcpProvider } from "../desktop/providers/acp/index.mjs";
import { PiProvider } from "../desktop/providers/pi/index.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { resumeOrRecover, missingConversation, migrateChatSessions } from "../desktop/providers/sessions.mjs";
import { memberSessionId } from "../desktop/groups.mjs";
import { helperSessionId } from "../desktop/teamwork.mjs";
import { fakeClient } from "./fake-copilot.mjs";

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-switch-matrix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Stand-in provider that mimics a real harness with its own native session map.
 * - Rejects resume if the session was never created (or was deleted) unless recovered via resumeOrRecover.
 * - Records every create, resume, delete, fork, and prompt received.
 */
class StandInProvider extends ModelProvider {
  constructor(id, { harness = false, failResumeOnce = false } = {}) {
    super();
    this.id = id;
    this.name = id;
    this.harness = harness;
    this.failResumeOnce = failResumeOnce;
    this.nativeSessions = new Map(); // ref -> { prompts: string[] }
    this.log = { created: [], resumed: [], deleted: [], forked: [], prompts: [] };
    this.nextSeq = 1;
  }
  async status() { return { installed: true, connected: true, signIn: null, signOut: false }; }
  async models() {
    if (this.harness) return [];
    return [{ id: "m1", name: this.id + " Model", available: true }];
  }
  async openSession(spec) {
    const provider = this;
    const { value: ref, recovered, lost } = await resumeOrRecover({
      spec,
      hasRef: !!spec.established,
      resume: async () => {
        if (provider.failResumeOnce) {
          provider.failResumeOnce = false;
          throw new Error(`Session "${spec.sessionId}" not found.`);
        }
        if (!provider.nativeSessions.has(spec.sessionId)) {
          throw new Error(`Session "${spec.sessionId}" not found.`);
        }
        provider.log.resumed.push(spec.sessionId);
        return spec.sessionId;
      },
      create: async () => {
        const ref = spec.sessionId;
        provider.nativeSessions.set(ref, { prompts: [] });
        provider.log.created.push(ref);
        return ref;
      },
    });
    let pendingLost = recovered && spec.established ? lost : "";
    return new class extends ProviderSession {
      id = ref;
      async send({ prompt }) {
        const full = (pendingLost ? pendingLost + "\n\n" : "") + prompt;
        pendingLost = "";
        provider.nativeSessions.get(ref).prompts.push(full);
        provider.log.prompts.push({ ref, prompt: full });
        const lastLine = prompt.split("\n\n").at(-1);
        return { text: `${provider.id}:${lastLine}` };
      }
      async currentModel() { return { model: spec.model.model }; }
    }();
  }
  async forkSession(sessionId) {
    const forked = `${this.id}-native-fork-${this.nextSeq++}`;
    this.nativeSessions.set(forked, { prompts: [...(this.nativeSessions.get(sessionId)?.prompts ?? [])] });
    this.log.forked.push({ from: sessionId, to: forked });
    return forked;
  }
  async deleteSession(sessionId) {
    this.log.deleted.push(sessionId);
    this.nativeSessions.delete(sessionId);
  }
}

test("A -> B -> A preserves A's native session, hands A's turns to B, and hands B's turns back to A", async (t) => {
  const dir = folder(t);
  const a = new StandInProvider("copilot");
  const b = new StandInProvider("codex");
  const registry = new Providers([a, b]);
  const ws = new Workspace(dir, registry, () => {});
  ws.setPreferences({ harness: "provider" });

  const id = ws.createChat("pip");
  await ws.setModel("chat", id, { provider: "copilot", model: "m1" });
  await ws.send(id, "Turn 1 on A");
  assert.deepEqual(a.log.created, [id]);
  assert.deepEqual(a.log.deleted, [], "A is alive");

  // Switch to B: A's native session must NOT be deleted; B gets A's transcript.
  await ws.setModel("chat", id, { provider: "codex", model: "m1" });
  await ws.send(id, "Turn 2 on B");
  assert.deepEqual(a.log.deleted, [], "switching A -> B must NOT delete A's native session");
  assert.deepEqual(b.log.created, [id]);
  assert.match(b.log.prompts[0].prompt, /<earlier-conversation>[\s\S]*Turn 1 on A[\s\S]*copilot:Turn 1 on A[\s\S]*<\/earlier-conversation>/);

  // Switch back to A: A resumes its native session and receives only B's missed turns.
  await ws.setModel("chat", id, { provider: "copilot", model: "m1" });
  await ws.send(id, "Turn 3 back on A");
  assert.deepEqual(a.log.resumed, [id], "A resumes its preserved native session");
  assert.deepEqual(b.log.deleted, [], "B's native session is also preserved");
  const turn3Prompt = a.log.prompts[1].prompt;
  assert.match(turn3Prompt, /<earlier-conversation>[\s\S]*Turn 2 on B[\s\S]*codex:Turn 2 on B[\s\S]*<\/earlier-conversation>/);
  assert.doesNotMatch(turn3Prompt, /Turn 1 on A/, "A already has Turn 1 in its native session; only missed turns are handed off");
});

test("A -> B -> C -> A works across 3 harnesses on both ordinary chats and Main chats", async (t) => {
  const dir = folder(t);
  const a = new StandInProvider("copilot");
  const b = new StandInProvider("codex");
  const c = new StandInProvider("claude");
  const registry = new Providers([a, b, c]);
  const ws = new Workspace(dir, registry, () => {});
  ws.setPreferences({ harness: "provider" });

  for (const kind of ["ordinary", "main"]) {
    const id = kind === "main" ? ws.mainChat("pip") : ws.createChat("pip");
    await ws.setModel("chat", id, { provider: "copilot", model: "m1" });
    await ws.send(id, `${kind}-1`);

    await ws.setModel("chat", id, { provider: "codex", model: "m1" });
    await ws.send(id, `${kind}-2`);

    await ws.setModel("chat", id, { provider: "claude", model: "m1" });
    await ws.send(id, `${kind}-3`);

    await ws.setModel("chat", id, { provider: "copilot", model: "m1" });
    await ws.send(id, `${kind}-4`);

    assert.equal(a.log.deleted.length, 0);
    assert.equal(b.log.deleted.length, 0);
    assert.equal(c.log.deleted.length, 0);
    assert.ok(a.log.resumed.includes(id), `${kind}: A resumed on return`);

    const cPrompt = c.log.prompts.at(-1).prompt;
    assert.match(cPrompt, new RegExp(`${kind}-1`), `${kind}: C saw A's turn`);
    assert.match(cPrompt, new RegExp(`${kind}-2`), `${kind}: C saw B's turn`);

    const aBackPrompt = a.log.prompts.at(-1).prompt;
    assert.match(aBackPrompt, new RegExp(`${kind}-2`), `${kind}: A saw B's turn on return`);
    assert.match(aBackPrompt, new RegExp(`${kind}-3`), `${kind}: A saw C's turn on return`);
    assert.doesNotMatch(aBackPrompt, new RegExp(`${kind}-1`), `${kind}: A did not replay its own earlier turn`);
  }
});

test("native fork keeps Botkins chat.id separate from harness-native ref and survives switching harnesses", async (t) => {
  const dir = folder(t);
  const a = new StandInProvider("copilot");
  const b = new StandInProvider("codex");
  const registry = new Providers([a, b]);
  const ws = new Workspace(dir, registry, () => {});
  ws.setPreferences({ harness: "provider" });

  const sourceId = ws.createChat("pip");
  await ws.setModel("chat", sourceId, { provider: "copilot", model: "m1" });
  await ws.send(sourceId, "Original message");

  const forkId = await ws.forkChat(sourceId, 1);
  const fork = ws.chat(forkId);
  assert.notEqual(forkId, "copilot-native-fork-1", "chat.id stays a Botkins UUID, never overwritten by harness ref");
  assert.equal(fork.sessions.copilot.ref, "copilot-native-fork-1", "native ref lives inside sessions[providerId].ref");

  // Continue on A: resumes the native forked ref.
  await ws.send(forkId, "Continue on A");
  assert.deepEqual(a.log.resumed, ["copilot-native-fork-1"]);

  // Switch to B: uses Botkins' forkId (NOT copilot-native-fork-1) and gets the full transcript.
  await ws.setModel("chat", forkId, { provider: "codex", model: "m1" });
  await ws.send(forkId, "Switch fork to B");
  assert.deepEqual(b.log.created, [forkId], "B receives Botkins chat id, never A's native fork ref");
  assert.match(b.log.prompts[0].prompt, /Original message[\s\S]*Continue on A/);

  // Switch back to A: resumes copilot-native-fork-1 with B's turn handed off.
  await ws.setModel("chat", forkId, { provider: "copilot", model: "m1" });
  await ws.send(forkId, "Back on A fork");
  assert.deepEqual(a.log.resumed, ["copilot-native-fork-1", "copilot-native-fork-1"]);
  assert.match(a.log.prompts.at(-1).prompt, /Switch fork to B/);
});

test("group-member sessions (memberSessionId) survive A -> B -> A harness switches", async (t) => {
  const dir = folder(t);
  const a = new StandInProvider("copilot");
  const b = new StandInProvider("codex");
  const registry = new Providers([a, b]);
  const ws = new Workspace(dir, registry, () => {});
  ws.setPreferences({ harness: "provider" });

  await ws.setModel("bot", "pip", { provider: "copilot", model: "m1" });
  await ws.setModel("bot", "scout", { provider: "copilot", model: "m1" });
  const groupId = ws.createGroupChat(["pip", "scout"]);
  await ws.send(groupId, "Round 1");

  const pipSession = memberSessionId(ws.chat(groupId), "pip");
  assert.deepEqual(a.log.created.filter((x) => x === pipSession).length, 1);

  // Switch Pip to Codex (B); Scout stays on Copilot.
  await ws.setModel("bot", "pip", { provider: "codex", model: "m1" });
  await ws.send(groupId, "Round 2");
  assert.deepEqual(a.log.deleted, [], "Pip's Copilot member session is not deleted");
  assert.ok(b.log.created.includes(pipSession));
  assert.match(b.log.prompts.at(-1).prompt, /Round 1/, "Pip on Codex sees Round 1");
  assert.match(b.log.prompts.at(-1).prompt, /Round 2/, "Pip on Codex sees Round 2");

  // Switch Pip back to Copilot (A): resumes Pip's Copilot member session and catches up on Round 2.
  await ws.setModel("bot", "pip", { provider: "copilot", model: "m1" });
  await ws.send(groupId, "Round 3");
  assert.ok(a.log.resumed.includes(pipSession), "Pip resumed its Copilot member session");
  const pipBackPrompt = a.log.prompts.filter((p) => p.ref === pipSession).at(-1).prompt;
  assert.match(pipBackPrompt, /Round 2/, "Pip back on Copilot sees Round 2");
  assert.match(pipBackPrompt, /Round 3/, "Pip back on Copilot sees Round 3");
});

test("helper sessions (helperSessionId) survive A -> B -> A harness switches", async (t) => {
  const dir = folder(t);
  // Asker (pip) calls ask_teammate on Scout; Scout switches harnesses across turns.
  let askCount = 0;
  class AskerProvider extends StandInProvider {
    async openSession(spec) {
      if (spec.sessionId.includes("-team-")) return super.openSession(spec);
      const askTool = spec.tools?.find((t) => t.name === "ask_teammate");
      return new class extends ProviderSession {
        id = spec.sessionId;
        async send({ prompt }) {
          askCount++;
          const res = await askTool.handler({ teammate: "Scout", message: `Ask #${askCount}: ${prompt}` });
          return { text: `Asker got: ${res}` };
        }
        async currentModel() { return { model: spec.model.model }; }
      }();
    }
  }
  const a = new AskerProvider("copilot");
  const b = new StandInProvider("codex");
  const registry = new Providers([a, b]);
  const ws = new Workspace(dir, registry, () => {});
  ws.setPreferences({ harness: "provider" });

  await ws.setModel("bot", "pip", { provider: "copilot", model: "m1" });
  await ws.setModel("bot", "scout", { provider: "copilot", model: "m1" });
  const chatId = ws.createChat("pip");
  const helperId = helperSessionId(ws.chat(chatId), "scout");

  // Turn 1: Scout runs on Copilot (A).
  await ws.send(chatId, "Topic alpha");
  assert.ok(a.log.created.includes(helperId));

  // Turn 2: Switch Scout to Codex (B). Helper session on A is preserved; B sees Turn 1's helper exchange.
  await ws.setModel("bot", "scout", { provider: "codex", model: "m1" });
  await ws.send(chatId, "Topic beta");
  assert.deepEqual(a.log.deleted, []);
  assert.ok(b.log.created.includes(helperId));
  assert.match(b.log.prompts[0].prompt, /<earlier-conversation>[\s\S]*Topic alpha[\s\S]*<\/earlier-conversation>/);

  // Turn 3: Switch Scout back to Copilot (A). Resumes A's helper session and hands off Turn 2.
  await ws.setModel("bot", "scout", { provider: "copilot", model: "m1" });
  await ws.send(chatId, "Topic gamma");
  assert.ok(a.log.resumed.includes(helperId));
  const backPrompt = a.log.prompts.filter((p) => p.ref === helperId).at(-1).prompt;
  assert.match(backPrompt, /Topic beta/);
  assert.doesNotMatch(backPrompt, /Topic alpha/, "A already had Topic alpha in its native helper session");
});

test("migration upgrades legacy single-provider chats (and Sherlock's broken OMP chat) seamlessly", async (t) => {
  const dir = folder(t);
  const brokenId = "01a2101d-2f38-7116-807b-7c7d78a65f20";
  // Legacy workspace.json: Sherlock's chat marked established on omp with a ref OMP does not hold.
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({
      bots: [starterBots[0]],
      chats: [
        {
          id: brokenId,
          botId: "pip",
          title: "Sherlock",
          time: 1000,
          established: true,
          sessionProvider: "omp",
          messages: [
            { role: "user", text: "What clues do we have?" },
            { role: "assistant", text: "Three footprints by the window." },
          ],
        },
      ],
      runs: [],
      settings: { harness: "provider", harnessPicked: true },
    }),
  );

  // Stand-in "omp" provider whose native store does NOT have `brokenId` (simulating stale ref).
  const copilot = new StandInProvider("copilot");
  const omp = new StandInProvider("omp");
  const registry = new Providers([copilot, omp]);
  const ws = new Workspace(dir, registry, () => {});
  const chat = ws.chat(brokenId);

  // Migration populated `sessions.omp` with through === 2 while preserving messages.
  assert.deepEqual(chat.sessions, { omp: { through: 2 } });
  assert.equal(chat.messages.length, 2);

  // Sending a new message on OMP recovers from the missing native ref via transcript fallback instead of failing.
  await ws.setModel("chat", brokenId, { provider: "omp", model: "m1" });
  await ws.send(brokenId, "Try again");
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.match(omp.log.prompts[0].prompt, /Three footprints by the window/, "recovered session received full transcript");
  assert.equal(chat.messages.at(-1).text, "omp:Try again");
});

test("resumeOrRecover recovers on missingConversation errors and rethrows unrelated errors", async () => {
  let missingCalled = 0;
  const spec = {
    hasReplies: true,
    history: () => [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" },
      { role: "user", text: "Follow up" },
    ],
  };
  const ok = await resumeOrRecover({
    spec,
    hasRef: true,
    resume: async () => { throw new Error('Session "01a2101d-2f38-7116-807b-7c7d78a65f20" not found.'); },
    onMissing: () => { missingCalled++; },
    create: async () => "fresh-ref",
  });
  assert.equal(ok.value, "fresh-ref");
  assert.equal(ok.recovered, true);
  assert.equal(missingCalled, 1);
  assert.match(ok.lost, /Hello[\s\S]*Hi there/);
  assert.doesNotMatch(ok.lost, /Follow up/, "current user prompt is excluded from earlier-conversation");

  // Unrelated errors (e.g. model not found, network error) must NOT trigger recovery.
  await assert.rejects(
    resumeOrRecover({
      spec,
      hasRef: true,
      resume: async () => { throw new Error("Model not found"); },
      create: async () => assert.fail("must not create over a model error"),
    }),
    /Model not found/,
  );
  assert.equal(missingConversation(new Error('OMP couldn\'t start. Error: Session "abc-123" not found.')), true);
});

// ── Stale-ref recovery across ALL 7 real provider adapters ──────────────────────────────────────

const HISTORY = [
  { role: "user", text: "Remember the secret word: marmalade" },
  { role: "assistant", text: "Got it, marmalade." },
  { role: "user", text: "What was the word?" },
];

const baseSpec = (dir, extra = {}) => ({
  sessionId: "stale-chat-1",
  established: true,
  hasReplies: true,
  temporary: false,
  folder: dir,
  coding: false,
  model: { model: "m1" },
  approval: "ask",
  instructions: "You are Helpful.",
  context: "",
  tools: [],
  skills: { directories: [], disabled: [] },
  mcpServers: {},
  plugins: [],
  history: () => HISTORY,
  handlers: { permission: async () => ({ allow: true }), question: async () => ({ action: "cancel" }) },
  ...extra,
});

test("stale ref recovery on CopilotProvider falls back to fresh session with transcript (even when hasReplies is true)", async (t) => {
  const dir = folder(t);
  const { client, log } = fakeClient();
  const baseClient = await client();
  // Inject a resumeSession that throws "Session not found" on the stale ref.
  let resumeAttempts = 0;
  const wrappedClient = async () => ({
    ...baseClient,
    resumeSession: async () => {
      resumeAttempts++;
      throw new Error("Session not found: stale-chat-1");
    },
  });
  const provider = new CopilotProvider({ connect: wrappedClient, baseDirectory: dir, keepWarmMs: 0 });
  const session = await provider.openSession(baseSpec(dir));
  const { text } = await session.send({ prompt: "What was the word?" });
  await session.close();
  assert.equal(resumeAttempts, 1);
  assert.equal(log.created.length, 1);
  assert.match(log.sent[0][1], /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);
  assert.ok(text.length > 0);
});

test("stale ref recovery on CodexProvider falls back to thread/start with transcript and saves new ref", async (t) => {
  const dir = folder(t);
  const requests = [];
  const provider = new CodexProvider({ dataDir: dir, home: dir });
  provider.sessions.set("stale-chat-1", { ref: "dead-thread-id", turns: [] });
  provider.bridge = { open: async () => ({ url: "http://127.0.0.1:1", headers: {}, close() {} }), forget() {} };
  let activeSession;
  provider.attach = (s) => { activeSession = s; };
  provider.detach = () => {};
  provider.unloadIfChanged = async () => {};
  provider.rpc = async () => ({
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/resume") throw new Error("no rollout found for thread dead-thread-id");
      if (method === "thread/start") return { thread: { id: "fresh-thread-99" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          activeSession.notified("item/started", { threadId: "fresh-thread-99", item: { type: "agentMessage", id: "i1", text: "" } });
          activeSession.notified("item/agentMessage/delta", { threadId: "fresh-thread-99", itemId: "i1", delta: "marmalade" });
          activeSession.notified("item/completed", { threadId: "fresh-thread-99", item: { type: "agentMessage", id: "i1", text: "marmalade" } });
          activeSession.notified("turn/completed", { threadId: "fresh-thread-99", turn: { id: "t1", status: "completed" } });
        });
        return { turn: { id: "t1" } };
      }
      return {};
    },
  });

  const session = await provider.openSession(baseSpec(dir));
  const { text } = await session.send({ prompt: "What was the word?" });
  assert.equal(text, "marmalade");
  assert.equal(provider.sessions.get("stale-chat-1").ref, "fresh-thread-99");
  const turnInput = requests.find((r) => r.method === "turn/start").params.input[0].text;
  assert.match(turnInput, /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);
});

test("stale ref recovery on ClaudeProvider falls back to fresh session with transcript when resume fails", async (t) => {
  const dir = folder(t);
  const queries = [];
  const provider = new ClaudeProvider({
    dataDir: dir,
    sdk: {
      // Simulate getSessionInfo reporting the stale ref exists, then query({ resume }) failing with "No conversation found".
      getSessionInfo: async () => ({ sessionId: "stale-uuid" }),
      query: ({ prompt, options }) => {
        const entry = { options, prompt: null };
        queries.push(entry);
        return (async function* () {
          for await (const msg of prompt) {
            entry.prompt = msg.message.content;
            break;
          }
          if (options.resume) {
            throw new Error("No conversation found with session ID: stale-uuid");
          }
          yield { type: "result", subtype: "success", result: "marmalade", is_error: false };
        })();
      },
    },
  });
  provider.capabilities = async () => ({ models: [] });
  provider.bridge = { open: async () => ({ url: "http://127.0.0.1:1", headers: {}, close() {} }), forget() {} };
  provider.sessions.set("stale-chat-1", { ref: "stale-uuid", dir, turns: [] });

  const session = await provider.openSession(baseSpec(dir));
  const { text } = await session.send({ prompt: "What was the word?" });
  assert.equal(text, "marmalade");
  assert.equal(queries.length, 2, "first query tried resume, second created fresh session");
  assert.equal(queries[0].options.resume, "stale-uuid");
  assert.ok(queries[1].options.sessionId && queries[1].options.sessionId !== "stale-uuid");
  assert.match(queries[1].prompt, /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);
  assert.equal(provider.sessions.get("stale-chat-1").ref, queries[1].options.sessionId);
});

test("stale ref recovery on OpenCodeProvider falls back to new session with transcript on 404", async (t) => {
  const dir = folder(t);
  const calls = [];
  const provider = new OpenCodeProvider({ dataDir: dir });
  provider.sessions.set("stale-chat-1", { ref: "gone-oc-id" });
  provider.bridge = { open: async () => ({ url: "http://127.0.0.1:1", headers: {}, close() {} }), forget() {} };
  provider.agents = async () => ["build"];
  provider.listen = async () => {};
  let activeSession;
  provider.attach = (s) => { activeSession = s; };
  provider.detach = () => {};
  provider.server = async () => ({
    get: async (path) => {
      calls.push({ m: "GET", path });
      if (path === "/api/session/gone-oc-id") throw Object.assign(new Error("Session not found"), { status: 404 });
      return { data: {} };
    },
    put: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    post: async (path, body) => {
      calls.push({ m: "POST", path, body });
      if (path === "/api/session") return { data: { id: "fresh-oc-42" } };
      if (path === "/api/session/fresh-oc-42/prompt") {
        queueMicrotask(() => {
          activeSession.turn.text.push("marmalade");
          activeSession.turn.ended = true;
          activeSession.turn.resolve();
        });
        return { data: { id: "msg-1" } };
      }
      return { data: {} };
    },
  });

  const session = await provider.openSession(baseSpec(dir, { model: { model: "openai/m1" } }));
  const { text } = await session.send({ prompt: "What was the word?" });
  assert.equal(text, "marmalade");
  assert.equal(provider.sessions.get("stale-chat-1").ref, "fresh-oc-42");
  const promptCall = calls.find((c) => c.path === "/api/session/fresh-oc-42/prompt");
  assert.match(promptCall.body.text, /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);
});

test("stale ref recovery on AcpProvider falls back to session/new with transcript when session/load fails", async (t) => {
  const dir = folder(t);
  const requests = [];
  const provider = new AcpProvider({ id: "acp-test", name: "ACP Test", command: "fake-acp", dataDir: dir });
  provider.sessions.set("stale-chat-1", { ref: "gone-acp-id", told: "" });
  provider.bridge = { open: async () => ({ url: "http://127.0.0.1:1", headers: {}, close() {} }), forget() {} };
  provider.attach = () => {};
  provider.detach = () => {};
  provider.agent = async () => ({
    capabilities: { loadSession: true, mcpCapabilities: {} },
    rpc: {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "session/load") throw Object.assign(new Error("Session not found"), { code: -32002 });
        if (method === "session/new") return { sessionId: "fresh-acp-7" };
        if (method === "session/prompt") return { stopReason: "end_turn" };
        return {};
      },
      notify: () => {},
    },
  });

  const session = await provider.openSession(baseSpec(dir));
  await session.send({ prompt: "What was the word?" });
  assert.equal(provider.sessions.get("stale-chat-1").ref, "fresh-acp-7");
  const promptReq = requests.find((r) => r.method === "session/prompt");
  assert.match(promptReq.params.prompt[0].text, /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);
});

const skipShell = process.platform === "win32" && "Stand-in script uses /bin/sh";

test("stale ref recovery on OmpProvider and PiProvider falls back to fresh session with transcript", { skip: skipShell }, async (t) => {
  const dir = folder(t);
  // Stand-in OMP script that fails on `--resume stale-omp-ref` with the exact error Sherlock hit,
  // and succeeds when launched without `--resume` (fresh session).
  const fakeOmpPath = join(dir, "fake-omp-stale.mjs");
  const ompLog = join(dir, "omp.log.jsonl");
  writeFileSync(
    fakeOmpPath,
    `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = (x) => appendFileSync(${JSON.stringify(ompLog)}, JSON.stringify(x) + "\\n");
if (args.includes("--version")) { console.log("omp/19.1.0"); process.exit(0); }
const resumeAt = args.indexOf("--resume");
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : null;
log({ args, resumed });
if (resumed === "01a2101d-2f38-7116-807b-7c7d78a65f20") {
  process.stderr.write('Error: Session "01a2101d-2f38-7116-807b-7c7d78a65f20" not found. Run \`omp --resume\` without an argument...\\n');
  process.exit(1);
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const ok = (data) => send({ type: "response", id: cmd.id, command: cmd.type, success: true, ...(data && { data }) });
    if (cmd.type === "negotiate_protocol") ok({ protocolVersion: cmd.protocolVersion });
    else if (cmd.type === "get_state") ok({ sessionId: "fresh-omp-session-99", model: { provider: "botkins-claude", id: "opus" }, thinkingLevel: "high", isSettled: true });
    else if (cmd.type === "prompt") {
      log({ prompt: cmd.message });
      ok({ agentInvoked: true });
      send({ type: "agent_start" });
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "marmalade" }], stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } } });
      send({ type: "agent_end", messages: [], isTerminal: true });
      send({ type: "session_settled" });
    } else ok();
  }
});
`,
  );
  const ompBin = join(dir, "omp");
  writeFileSync(ompBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeOmpPath)} "$@"\n`);
  chmodSync(ompBin, 0o755);

  const CONNECTION = { name: "botkins-claude", config: { name: "Claude", baseUrl: "http://127.0.0.1:1/claude", api: "anthropic-messages", apiKey: "s", models: [{ id: "opus", name: "Opus", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };
  const omp = new OmpProvider({ dataDir: join(dir, "omp-data"), binary: ompBin });
  t.after(() => omp.stop());
  // Seed OMP's session store with the stale ref Sherlock hit.
  omp.sessions.set("stale-chat-1", { ref: "01a2101d-2f38-7116-807b-7c7d78a65f20", folder: dir });

  const ompSession = await omp.openSession(baseSpec(dir, { model: { model: "opus", source: "botkins-claude" }, inference: { providers: [CONNECTION] } }));
  const { text: ompReply } = await ompSession.send({ prompt: "What was the word?" });
  await ompSession.close();
  assert.equal(ompReply, "marmalade");
  assert.equal(omp.sessions.get("stale-chat-1").ref, "fresh-omp-session-99", "stale ref replaced with fresh OMP session id");
  const ompEntries = readFileSync(ompLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ompEntries[0].resumed, "01a2101d-2f38-7116-807b-7c7d78a65f20", "first attempt tried stale ref");
  assert.equal(ompEntries[1].resumed, null, "second attempt started fresh without --resume");
  assert.match(ompEntries.find((e) => e.prompt).prompt, /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);

  // Stand-in Pi script that fails on a stale --session-id and succeeds on the recovered fresh id.
  const fakePiPath = join(dir, "fake-pi-stale.mjs");
  const piLog = join(dir, "pi.log.jsonl");
  writeFileSync(
    fakePiPath,
    `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = (x) => appendFileSync(${JSON.stringify(piLog)}, JSON.stringify(x) + "\\n");
if (args.includes("--version")) { console.log("pi/0.68.0"); process.exit(0); }
const idAt = args.indexOf("--session-id");
const sid = idAt >= 0 ? args[idAt + 1] : null;
log({ sid });
if (sid === "stale-pi-ref") {
  process.stderr.write('Error: Session "stale-pi-ref" not found.\\n');
  process.exit(1);
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const ok = (data) => send({ type: "response", id: cmd.id, command: cmd.type, success: true, ...(data && { data }) });
    if (cmd.type === "get_state") ok({ sessionId: sid, model: { provider: "botkins-claude", id: "opus" }, thinkingLevel: "high" });
    else if (cmd.type === "prompt") {
      log({ prompt: cmd.message });
      ok();
      send({ type: "agent_start" });
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "marmalade" }], stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } } });
      send({ type: "agent_end", messages: [] });
      send({ type: "agent_settled" });
    } else ok();
  }
});
`,
  );
  const piBin = join(dir, "pi");
  writeFileSync(piBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePiPath)} "$@"\n`);
  chmodSync(piBin, 0o755);

  const pi = new PiProvider({ dataDir: join(dir, "pi-data"), binary: piBin });
  t.after(() => pi.stop());
  pi.sessions.set("stale-chat-1", { ref: "stale-pi-ref", folder: dir });

  const piSession = await pi.openSession(baseSpec(dir, { model: { model: "opus", source: "botkins-claude" }, inference: { providers: [CONNECTION] } }));
  const { text: piReply } = await piSession.send({ prompt: "What was the word?" });
  await piSession.close();
  assert.equal(piReply, "marmalade");
  assert.notEqual(pi.sessions.get("stale-chat-1").ref, "stale-pi-ref", "stale Pi ref replaced with fresh ref");
  const piEntries = readFileSync(piLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(piEntries[0].sid, "stale-pi-ref");
  assert.notEqual(piEntries[1].sid, "stale-pi-ref");
  assert.match(piEntries.find((e) => e.prompt).prompt, /<earlier-conversation>[\s\S]*marmalade[\s\S]*<\/earlier-conversation>/);
});
