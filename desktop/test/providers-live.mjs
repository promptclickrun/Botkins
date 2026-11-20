// A live check of one model provider against the real tool on this computer and the account it
// is signed in to. It is not part of `npm test`: every run uses a little of that account's plan.
//
//   node test/providers-live.mjs codex [model] [thinking level]
//   node test/providers-live.mjs claude sonnet low
//   node test/providers-live.mjs opencode opencode/big-pickle
//
// It reads the account status and the model list, then runs two short turns: one that has to
// call a Botkins tool through the tool bridge, and one in a reopened session that has to
// remember the first. Add --again for a tool call from the reopened session, --fork for a copy of
// the conversation, --shell for a turn that needs an approval, and --side for a side question.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "../desktop/providers/index.mjs";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";

const [kind, wantedModel, wantedEffort] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name) => process.argv.includes("--" + name);
// An ACP agent's own flags (acp:copilot --acp) are not this script's.
const model = (list) => (wantedModel && !wantedModel.startsWith("--") ? list.find((m) => m.id === wantedModel) : (list.find((m) => m.recommended) ?? list[0]));
const dir = mkdtempSync(join(tmpdir(), "botkins-live-"));
const bridge = new ToolBridge();

const make = {
  codex: async () => new (await import("../desktop/providers/codex/index.mjs")).CodexProvider({ dataDir: join(dir, "codex"), bridge }),
  claude: async () => new (await import("../desktop/providers/claude/index.mjs")).ClaudeProvider({ dataDir: join(dir, "claude"), bridge }),
  opencode: async () => new (await import("../desktop/providers/opencode/index.mjs")).OpenCodeProvider({ dataDir: join(dir, "opencode"), bridge }),
};
// Any ACP agent on this computer checks the shared ACP adapter: acp:<command> [arguments…], such as acp:copilot --acp
if (kind?.startsWith("acp:")) {
  const [command, ...args] = [kind.slice(4), ...process.argv.slice(3).filter((a) => a.startsWith("--") && !["--again", "--shell", "--side", "--release", "--fork"].includes(a))];
  make[kind] = async () => new (await import("../desktop/providers/acp/index.mjs")).AcpProvider({ id: "acp-live", name: command + " (ACP)", command, args, dataDir: join(dir, "acp"), bridge });
}
if (!make[kind]) {
  console.error("Use: node test/providers-live.mjs codex|claude|opencode [model] [thinking level]");
  process.exit(2);
}
const provider = await make[kind]();
const word = "marmalade-" + Math.floor(Math.random() * 9000 + 1000);
let exit = 0;
try {
  const status = await provider.status();
  console.log("status:", JSON.stringify({ ...status, account: status.account ? "<signed-in account>" : undefined }));
  assert.equal(status.installed, true, "the tool is installed");
  assert.equal(status.connected, true, "the account is signed in");

  const models = await provider.models();
  console.log("models:", models.length, "·", models.slice(0, 8).map((m) => m.id + (m.efforts.length ? " [" + m.efforts.join("/") + "]" : "")).join(", "));
  assert.ok(models.length > 0, "the provider lists models");
  const chosen = model(models);
  assert.ok(chosen, "the model " + wantedModel + " is in the list");
  const effort = (wantedEffort && !wantedEffort.startsWith("--") ? wantedEffort : undefined) ?? (chosen.efforts.includes("low") ? "low" : undefined);
  console.log("using:", chosen.id, effort ?? "(default thinking)", "·", await provider.version());

  const seen = { types: new Map(), steps: [], permissions: [], text: "" };
  const calls = [];
  const tools = [
    defineTool("secret_word", {
      description: "Returns the secret word for this test. Call it when asked for the secret word.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: () => (calls.push("secret_word"), JSON.stringify({ word })),
    }),
  ];
  const sessionId = randomUUID();
  const spec = (established) => ({
    sessionId,
    established,
    hasReplies: established,
    temporary: false,
    folder: dir,
    coding: false,
    model: { model: chosen.id, provider: provider.id, ...(chosen.source && { source: chosen.source }), ...(effort && { reasoningEffort: effort }) },
    approval: "ask",
    instructions: "You are a test bot inside Botkins. Follow each instruction exactly and keep replies to one short line.",
    context: "",
    tools,
    skills: { directories: [], disabled: [] },
    mcpServers: {},
    plugins: [],
    history: () => [],
    handlers: {
      permission: async (request) => {
        seen.permissions.push(request.kind + ":" + request.label);
        return { allow: true, interactive: true };
      },
      question: async (request) => ({ answer: request.choices?.[0] ?? "yes", wasFreeform: false }),
      planExit: async () => ({ approved: true }),
      autoSwitch: async () => "no",
      form: async () => ({ action: "cancel" }),
    },
  });
  const watch = (session) =>
    session.on((event) => {
      seen.types.set(event.type, (seen.types.get(event.type) ?? 0) + 1);
      if (event.type === "assistant.message_delta") seen.text += event.data.deltaContent;
      if (event.type === "tool.execution_start") seen.steps.push((event.data.mcpServerName ? event.data.mcpServerName + "/" : "") + event.data.toolName);
    });
  const turn = async (label, established, prompt) => {
    if (flag("release") && label === "turn 2b") await provider.releaseSessions();
    const session = await provider.openSession(spec(established));
    watch(session);
    const started = Date.now();
    try {
      const { text } = await session.send({ prompt }, 240000);
      console.log(label + " (" + (Date.now() - started) + " ms):", JSON.stringify(text.slice(0, 200)));
      return { text, session };
    } finally {
      if (!flag("side") || label !== "turn 2") await session.close();
    }
  };

  const first = await turn("turn 1", false, "Call the secret_word tool, then reply with exactly the word it returns and nothing else.");
  assert.deepEqual(calls, ["secret_word"], "the model called Botkins' tool through the bridge");
  assert.ok(first.text.includes(word), "the reply holds the tool's answer");
  assert.ok(seen.text.includes(word), "the reply streamed as deltas");
  assert.ok(seen.steps.some((s) => s.endsWith("secret_word")), "the tool call was reported as a step");
  assert.ok((seen.types.get("assistant.usage") ?? 0) > 0, "token use was reported");
  assert.ok((seen.types.get("user.message") ?? 0) > 0, "the turn has a fork boundary");

  const second = await turn("turn 2", true, "Without calling any tool: what was the secret word? Reply with just the word.");
  assert.ok(second.text.includes(word), "a reopened session remembers the conversation");
  assert.equal(calls.length, 1, "the second turn used no tool");

  if (flag("again")) {
    // A reopened session gets a new bridge address; the backend has to use that one.
    const again = await turn("turn 2b", true, "Call the secret_word tool once more, then reply with exactly the word it returns.");
    assert.equal(calls.length, 2, "a reopened session still reaches Botkins' tools");
    assert.ok(again.text.includes(word));
  }

  if (flag("fork")) {
    // A copy of the conversation remembers it, and reaches Botkins' tools at an address of its own.
    const copy = await provider.forkSession(sessionId);
    if (!copy) console.log("fork: this provider is forked from Botkins' transcript");
    else {
      const original = sessionId;
      const before = calls.length;
      const forked = async (label, prompt) => {
        const session = await provider.openSession({ ...spec(true), sessionId: copy });
        watch(session);
        try {
          const { text } = await session.send({ prompt }, 240000);
          console.log(label + ":", JSON.stringify(text.slice(0, 120)));
          return text;
        } finally {
          await session.close();
        }
      };
      assert.ok((await forked("fork recalls", "Without calling any tool: what was the secret word? Reply with just the word.")).includes(word), "the copy remembers the conversation");
      await forked("fork calls", "Call the secret_word tool once more, then reply with exactly the word it returns.");
      assert.equal(calls.length, before + 1, "the copy reaches Botkins' tools");
      await provider.deleteSession(copy);
      assert.equal(sessionId, original);
    }
  }
  if (flag("side")) {
    const answer = await second.session.sideQuestion("In one word: what is the secret word in this conversation?");
    console.log("side question:", JSON.stringify(answer.slice(0, 120)));
    assert.ok(answer.includes(word), "a side question sees the conversation");
    await second.session.close();
  }
  if (flag("shell")) {
    seen.permissions.length = 0;
    const third = await turn("turn 3", true, "Run this shell command exactly: echo botkins-live > live-note.txt   Then reply with the single word done.");
    console.log("approvals asked:", seen.permissions.join(" | ") || "(none)");
    assert.ok(/done/i.test(third.text), "the shell turn finished");
    assert.ok(seen.permissions.length > 0, "a command that writes asked for approval");
  }
  console.log("events:", [...seen.types].map(([type, n]) => type + "×" + n).join(", "));
  console.log("steps:", seen.steps.join(", "));
  await provider.deleteSession(sessionId);
  console.log("PASS", kind);
} catch (error) {
  exit = 1;
  console.error("FAIL", kind + ":", error.stack || error.message);
} finally {
  await provider.stop().catch(() => {});
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(exit);
}
