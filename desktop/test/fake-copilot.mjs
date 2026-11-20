// A fake Copilot SDK client for unit tests. It records what the Copilot adapter asks of it.
// `reply(sessionId, options, session)` answers each send; it may emit events or call tools first.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A session's tool as the tests call it. The adapter hands the runtime a tool whose failure is a
 * result carrying the tool's own words (so the model can read them; see `spoken` in
 * desktop/providers/copilot/index.mjs). For a test, a failed tool is a thrown error with those
 * words, which is what the tests check: "this tool refuses, and says this".
 */
const asTests = (tool) => ({
  ...tool,
  handler: (...args) => {
    const check = (result) => {
      if (result && typeof result === "object" && result.resultType === "failure") throw new Error(result.textResultForLlm);
      return result;
    };
    const out = tool.handler(...args);
    return typeof out?.then === "function" ? out.then(check) : check(out);
  },
});

export const tick = (ms = 0) => new Promise((resolve) => (ms ? setTimeout(resolve, ms) : setImmediate(resolve)));

export function fakeClient(reply = async () => ({ data: { content: "ok" } }), extra = {}) {
  const log = {
    created: [],
    resumed: [],
    deleted: [],
    disconnected: [],
    aborted: [],
    sent: [],
    /** The options each session was last created or resumed with. */
    configs: new Map(),
    /** The tools each session currently holds (after setTools on a warm session). */
    tools: new Map(),
    sessions: new Map(),
    /** Model and approval changes made on open sessions: [session id, value]. */
    models: [],
    modes: [],
  };
  const make = (id, config) => {
    const handlers = new Set();
    const session = {
      sessionId: id,
      on(fn) {
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
      emit(event) {
        for (const fn of [...handlers]) fn(event);
      },
      listeners: () => handlers.size,
      rpc: extra.rpc?.(id, log) ?? {
        model: { switchTo: async (params) => (log.models.push([id, params.modelId, params.reasoningEffort]), {}) },
        permissions: { setMode: async ({ mode }) => (log.modes.push([id, mode]), { success: true, mode }) },
      },
      /** Calls one of the session's current tools the way the runtime would. */
      tool(name, args) {
        const tool = log.tools.get(id).find((t) => t.name === name);
        if (!tool) throw new Error("No tool named " + name + " in session " + id);
        return tool.handler(args);
      },
      toolNames: () => log.tools.get(id).map((t) => t.name),
      config: () => log.configs.get(id),
      abort: async () => {
        log.aborted.push(id);
        session.onAbort?.();
      },
      disconnect: async () => {
        log.disconnected.push(id);
      },
      setTools: async (tools) => {
        log.tools.set(id, tools.map(asTests));
      },
      async send(options) {
        log.sent.push([id, options.prompt, options]);
        const messageId = id + ":message:" + log.sent.length;
        session.emit({ type: "user.message", id: messageId, data: { messageId } });
        const response = await reply(id, options, session);
        const content = response?.data?.content ?? "";
        session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content } });
        session.emit({ type: "session.idle", data: { mode: "interactive" } });
        return messageId;
      },
      ...(extra.send && { send: (options) => (log.sent.push([id, options.prompt, options]), extra.send(id, options, session)) }),
      ...(extra.events && { getEvents: () => extra.events(id, session) }),
    };
    log.configs.set(id, config);
    log.tools.set(id, (config.tools?.definitions ?? []).map(asTests));
    log.sessions.set(id, session);
    return session;
  };
  const sdk = {
    createSession: async (config) => {
      const id = config.sessionId ?? "auto-" + (log.created.length + 1);
      log.created.push(id);
      return make(id, config);
    },
    resumeSession: async (id, config) => {
      if (extra.missing?.(id)) throw new Error("Session not found: " + id);
      log.resumed.push(id);
      return make(id, config);
    },
    deleteSession: async (id) => {
      log.deleted.push(id);
    },
    listModels: async () => extra.models ?? [{ id: "auto", name: "Auto" }],
    getAuthStatus: async () => extra.auth?.() ?? { isAuthenticated: true, login: "octo", authType: "user", host: "https://github.com" },
    getStatus: async () => ({ version: "9.9.9", protocolVersion: 3 }),
    rpc: { sessions: { fork: async () => ({ sessionId: null }) } },
    stop: async () => {
      log.stopped = true;
    },
    ...extra.client,
  };
  return { client: async () => sdk, sdk, log };
}

export function tempDir(t, prefix = "botkins-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
