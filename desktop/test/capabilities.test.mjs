import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";

test("browsing a new chat's slash menu never establishes an empty Copilot conversation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opened = [],
    deleted = [];
  const rpc = {
    commands: { list: async () => ({ commands: [] }) },
    skills: {
      ensureLoaded: async () => {},
      list: async () => ({ skills: [] }),
    },
    plugins: { list: async () => ({ plugins: [] }) },
    mcp: { list: async () => ({ servers: [] }) },
    tools: {
      initializeAndValidate: async () => {},
      getCurrentMetadata: async () => ({
        tools: [{ name: "today_list", description: "List panels" }],
      }),
    },
  };
  const client = {
    createSession: async (cfg) => {
      opened.push(cfg.sessionId);
      const handlers = new Set();
      const emit = (event) => handlers.forEach((handler) => handler(event));
      return {
        sessionId: cfg.sessionId,
        rpc,
        disconnect: async () => {},
        abort: async () => {},
        on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
        send: async () => {
          const messageId = cfg.sessionId + ":message";
          emit({ type: "user.message", id: messageId, data: { messageId } });
          emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Reply" } });
          emit({ type: "session.idle", data: { mode: "interactive" } });
          return messageId;
        },
      };
    },
    deleteSession: async (id) => deleted.push(id),
    // A session that never received a message isn't kept by the runtime.
    resumeSession: async (id) => {
      throw new Error("Session not found: " + id);
    },
  };
  const ws = new Workspace(
    dir,
    async () => client,
    () => {},
    () => ({ kind: "reject" }),
  );
  const id = ws.createChat("pip");
  const menu = await ws.catalog("pip", id);
  assert.equal(menu.choices[0].command, "tool:today_list");
  assert.equal(ws.state.chats[0].established, false);
  // The menu comes from the bot's own menu session, which is kept (never deleted) for the next menu.
  assert.match(opened[0], /^menu-/);
  assert.deepEqual(deleted, []);
  await ws.catalog("pip", id);
  assert.equal(opened.length, 1);
  ws.clearCatalogs();
  await ws.catalog("pip", id);
  assert.deepEqual(opened, [opened[0], opened[0]], "the same menu session serves the bot again");
  await ws.send(id, "First message");
  assert.equal(opened.at(-1), id);
  assert.equal(ws.state.runs[0].status, "Completed");
  // A bot's menu before any chat exists (the Home composer) uses that bot's menu session too.
  const before = opened.length;
  const home = await ws.catalog("scout");
  assert.equal(home.choices[0].command, "tool:today_list");
  assert.equal(opened.length, before + 1);
  assert.match(opened.at(-1), /^menu-/);
  assert.notEqual(opened.at(-1), opened[0], "each bot has its own");
  assert.deepEqual(deleted, []);
});
