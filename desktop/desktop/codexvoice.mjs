// Live voice on the person's ChatGPT sign-in, through the Codex app-server (backend.voice.codex in
// desktop/link/VOICE.md). Each session runs its own `codex app-server`, because the realtime calls
// are part of Codex's experimental API and the chats' own app-server runs without it.
//
// How it goes (the same as in Codex's own generated protocol types, and as OpenBot does it):
//  1. `initialize` with `capabilities.experimentalApi: true`.
//  2. `thread/start`: an ephemeral thread in an empty folder, with no tools of Codex's own, the
//     voice's instructions, and the voice's tools as one namespace of dynamic tools.
//  3. `thread/realtime/start` with `{ transport: { type: "webrtc", sdp }, version: "v3",
//     outputModality: "audio", includeStartupContext: false, delegationAckFiller: true,
//     realtimeStartInstructions, initialItems, voice }`. The answer SDP comes in a
//     `thread/realtime/sdp` notification.
//  4. A tool call is the server request `item/tool/call` ({ namespace, tool, arguments }); the
//     answer is its JSON-RPC result, { contentItems: [{ type: "inputText", text }], success }.
//  5. `thread/realtime/stop` ends it, and the process is closed.
// OpenAI doesn't document this; it is EXPERIMENTAL in Codex and may change with a Codex update.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StdioRpc, cliEnv } from "./providers/cli.mjs";

const NAMESPACE = "botkins";
const ANSWER_MS = 20_000;
const VOICES_FRESH_MS = 10 * 60_000;
// Codex's own tools, all off: the voice's thread only relays to the bot.
const NO_FEATURES = {
  shell_tool: false,
  unified_exec: false,
  apply_patch_freeform: false,
  apps: false,
  plugins: false,
  hooks: false,
  codex_hooks: false,
  multi_agent: false,
  js_repl: false,
  browser_use: false,
  computer_use: false,
  image_generation: false,
  memories: false,
  memory_tool: false,
  view_image: false,
  code_mode: { enabled: false, direct_only_tool_namespaces: [NAMESPACE] },
  web_search: false,
  standalone_web_search: false,
  collab: false,
  multi_agent_v2: false,
  goals: false,
  tool_search: false,
  tool_suggest: false,
};

/**
 * Keeps persona, notes and chat context for the realtime v3 voice model while dropping direct-tool
 * instructions meant for providers whose voice model calls `ask_bot` itself (Codex v3's voice model
 * has no `ask_bot` tool; it delegates to the backing Codex thread and acknowledges via
 * `delegationAckFiller`).
 */
const voiceContext = (instructions) => {
  if (typeof instructions !== "string" || !instructions.trim()) return "";
  return instructions
    .split(/\n\n+/)
    .filter((part) => !/\bask_bot\b|Never call a tool silently/i.test(part))
    .join("\n\n")
    .trim()
    .slice(0, 16_000);
};

/** Developer-role voice prompt included in realtime v3 `initialItems` (no unsolicited startup reply). */
const voiceRules = (name, instructions) => {
  const parts = [
    (name ? `You are the voice of my bot "${name}". When I ask who you are, you are ${name}. Never say that you are ChatGPT, Codex, or another OpenAI assistant. ` : "") +
      "You have no tools of your own — your backing assistant runs the bot's tools. For every request beyond simple greetings or asking who you are, you MUST delegate to the assistant immediately. Never just say you will check without delegating, and never guess or make up personal details, calendar events, messages, reminders, files, smart-home state, or web facts. When I stop in the middle of a sentence to think, wait for the rest. Say only what the assistant's answer says. Speak the language I speak.",
  ];
  const extra = voiceContext(instructions);
  if (extra) parts.push(extra);
  return parts.join("\n\n");
};

/** Developer instructions for the backing Codex model when realtime v3 delegates a turn. */
const backendRules = (name) =>
  (name ? `You are the relay for the bot "${name}". ` : "You are the relay for the bot. ") +
  `For every delegated user request, call the ${NAMESPACE}.ask_bot tool immediately with the person's request in their own words. Do not output filler or commentary before calling the tool (the voice model already acknowledges). Never guess or answer without calling ${NAMESPACE}.ask_bot. After receiving the tool result, return a brief spoken answer containing only what the tool returned.`;

export class CodexVoice {
  /**
   * @param options.provider  the CodexProvider: locate() finds the CLI, status() says whether it is signed in.
   * @param options.onTool    async (sessionId, name, args) => text: runs a tool the voice called.
   * @param options.onEvent   (sessionId, { type, role?, text?, final?, reason? }) for the page: transcripts and the end.
   * @param options.onSession (sessionId, { chatId, botId }) => void: a session was started for that chat (the
   *                          link says so for a phone's session), so its tool calls can be run there.
   * @param options.botName   () => the name of the bot whose session is starting, for a caller that doesn't say.
   * @param options.spawn     async () => a JSON-RPC peer, for tests (in place of starting the CLI).
   */
  constructor({ provider, onTool, onEvent = () => {}, onSession = () => {}, botName = () => "", spawn, log = () => {} } = {}) {
    Object.assign(this, { provider, onTool, onEvent, onSession, botName, spawn, log });
    this.signed = false;
    this.sessions = new Map();
    this.voiceList = null;
  }
  /**
   * The voices Codex's live voice has: [{ id, name }]. Only Codex knows them, and they are not the
   * ones in its published types, so it is asked (`thread/realtime/listVoices`), in a short run of
   * its own, and the answer is kept for ten minutes. [] when it can't be asked.
   */
  async voices() {
    if (this.voiceList && Date.now() - this.voiceList.time < VOICES_FRESH_MS) return this.voiceList.list;
    let rpc;
    try {
      rpc = await this.connect();
      await rpc.request("initialize", { clientInfo: { name: "botkins-voice", title: "Botkins voice", version: "1" }, capabilities: { experimentalApi: true } }, 30_000);
      rpc.notify("initialized");
      const answer = await rpc.request("thread/realtime/listVoices", {}, 15_000);
      const ids = Array.isArray(answer?.voices?.v3) ? answer.voices.v3.filter((id) => typeof id === "string" && id) : [];
      const list = ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
      this.voiceList = { time: Date.now(), list };
      return list;
    } catch (error) {
      this.log("Codex voice: its voices couldn't be listed: " + (error?.message ?? error));
      return [];
    } finally {
      await rpc?.close?.().catch(() => {});
    }
  }
  /** Read by voice.mjs, which wants an answer at once: the last result of refresh(). */
  signedIn() {
    return this.signed;
  }
  /** Asks Codex whether it is installed and signed in. */
  async refresh() {
    try {
      const status = await this.provider.status();
      this.signed = !!(status?.installed && status?.connected);
    } catch {
      this.signed = false;
    }
    return this.signed;
  }
  async connect() {
    if (this.spawn) return this.spawn();
    const file = await this.provider.locate();
    if (!file) throw new Error("The Codex CLI isn't installed.");
    return new StdioRpc(file, ["app-server"], { env: await cliEnv({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Botkins" }) });
  }

  /**
   * Starts one session for a WebRTC offer. Resolves with { sdp, id } once Codex has the answer.
   * `chatId`, `botId` and `botName` say whom the voice speaks for; the link passes them for a
   * phone's session, and the desktop's own (desktop/voicedesk.mjs) passes them too.
   */
  async live({ sdp, voice, instructions, tools = [], chatId, botId, botName, name, author }) {
    const id = "codex-" + randomUUID();
    const session = { id, threadId: null, rpc: null, dir: null, ended: false };
    this.sessions.set(id, session);
    // Before anything is started: a tool call must find its chat as soon as the voice can speak.
    if (chatId) this.onSession(id, { chatId, botId, ...(author && { author }) });
    try {
      session.dir = await mkdtemp(join(tmpdir(), "botkins-voice-"));
      const rpc = (session.rpc = await this.connect());
      let answer;
      const answered = new Promise((resolve, reject) => (answer = { resolve, reject }));
      answered.catch(() => {});
      // Newer app servers identify transcript items. Some also emit the older flat stream.
      // Use one stream for this session so a second delivery cannot duplicate the words.
      const roles = new Map();
      let transcriptFormat;
      rpc.onNotification((method, params) => {
        if (!method.startsWith("thread/realtime/") || !session.threadId || params?.threadId !== session.threadId) return;
        if (method === "thread/realtime/sdp" && typeof params.sdp === "string") answer.resolve(params.sdp);
        else if (method === "thread/realtime/error") {
          const message = String(params.message ?? "Codex reported an error.");
          this.log("Codex voice error: " + message);
          answer.reject(new Error(message));
          this.closed(session, "Codex ended the live voice.");
        } else if (method === "thread/realtime/closed") {
          answer.reject(new Error("Codex closed the live voice."));
          this.closed(session, null);
        } else if (method === "thread/realtime/item/started" || method === "thread/realtime/item/completed") {
          const item = params.item;
          if (item?.type !== "transcriptSegment" || typeof item.id !== "string" || !["user", "assistant"].includes(item.role)) return;
          transcriptFormat ??= "items";
          if (transcriptFormat !== "items") return;
          const final = method.endsWith("/completed");
          if (final) roles.delete(item.id);
          else roles.set(item.id, item.role);
          this.onEvent(id, { type: "transcript", role: item.role, item: item.id, text: item.text ?? "", final, started: !final });
        } else if (method === "thread/realtime/item/transcript/delta") {
          const role = roles.get(params.itemId);
          if (role && typeof params.delta === "string") this.onEvent(id, { type: "transcript", role, item: params.itemId, text: params.delta, final: false });
        } else if (method === "thread/realtime/transcript/delta" || method === "thread/realtime/transcript/done") {
          transcriptFormat ??= "flat";
          if (transcriptFormat !== "flat") return;
          const final = method.endsWith("/done");
          const text = final ? params.text : params.delta;
          if ((params.role === "user" || params.role === "assistant") && typeof text === "string" && (text || final)) this.onEvent(id, { type: "transcript", role: params.role, text, final });
        }
      });
      rpc.onRequest(async (method, params) => {
        if (method !== "item/tool/call" || params?.threadId !== session.threadId || params?.namespace !== NAMESPACE)
          throw Object.assign(new Error("The live voice has only Botkins' tools."), { code: -32601 });
        try {
          const text = await this.onTool(id, String(params.tool), params.arguments ?? {});
          return { contentItems: [{ type: "inputText", text: String(text ?? "") }], success: true };
        } catch (error) {
          return { contentItems: [{ type: "inputText", text: String(error?.message ?? "That didn't work.") }], success: false };
        }
      });
      rpc.exited?.then(() => this.closed(session, session.ended ? null : "Codex stopped."));
      await rpc.request("initialize", { clientInfo: { name: "botkins-voice", title: "Botkins voice", version: "1" }, capabilities: { experimentalApi: true } }, 30_000);
      rpc.notify("initialized");
      // Every MCP server in the person's Codex settings is off for this thread.
      const config = await rpc.request("config/read", { includeLayers: false }, 15_000).catch(() => null);
      const servers = Object.keys(config?.config?.mcp_servers ?? {});
      const started = await rpc.request(
        "thread/start",
        {
          cwd: session.dir,
          ephemeral: true,
          persistSession: false,
          sandbox: "read-only",
          approvalPolicy: "never",
          dynamicTools: [
            {
              type: "namespace",
              name: NAMESPACE,
              description: "Botkins, which runs the bot.",
              tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.parameters })),
            },
          ],
          baseInstructions: instructions || "You relay requests to the bot with its tool.",
          config: {
            web_search: "disabled",
            mcp_servers: Object.fromEntries(servers.map((s) => [s, { enabled: false }])),
            features: NO_FEATURES,
            agents: { enabled: false },
          },
        },
        30_000,
      );
      // Realtime v3 has voices of its own: a voice it doesn't list is left for Codex to choose.
      const voices = voice ? await rpc.request("thread/realtime/listVoices", {}, 15_000).catch(() => null) : null;
      const usable = !!voice && Array.isArray(voices?.voices?.v3) && voices.voices.v3.includes(voice);
      session.threadId = started?.thread?.id;
      if (!session.threadId) throw new Error("Codex didn't start a thread.");
      const resolvedName = botName ?? name ?? this.botName();
      await rpc.request(
        "thread/realtime/start",
        {
          threadId: session.threadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp },
          version: "v3",
          includeStartupContext: false,
          delegationAckFiller: true,
          realtimeStartInstructions: backendRules(resolvedName),
          initialItems: [{ role: "developer", text: voiceRules(resolvedName, instructions) }],
          ...(usable && { voice }),
        },
        30_000,
      );
      const timer = setTimeout(() => answer.reject(new Error("Codex didn't answer in time.")), ANSWER_MS);
      const remote = await answered.finally(() => clearTimeout(timer));
      return { sdp: remote, id };
    } catch (error) {
      this.log("Codex voice: " + (error?.message ?? error));
      void this.stop(session);
      throw error;
    }
  }
  /**
   * Puts words into a session's conversation outside a tool call, for the voice to act on: the
   * bot's answer to a request that outlasted its tool call. False when the session is gone.
   */
  async say(id, text) {
    const session = this.sessions.get(id);
    if (!session?.rpc || !session.threadId || session.ended) return false;
    try {
      await session.rpc.request("thread/realtime/appendText", { threadId: session.threadId, text: String(text).slice(0, 8000), role: "user" }, 15_000);
      return true;
    } catch (error) {
      this.log("Codex voice: a later message wasn't taken: " + (error?.message ?? error));
      return false;
    }
  }
  /** Ends a session. Unknown ids are ignored. */
  end(id) {
    const session = this.sessions.get(id);
    if (session) void this.stop(session);
  }
  async stop(session) {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    const { rpc, threadId, dir } = session;
    if (rpc && threadId) await rpc.request("thread/realtime/stop", { threadId }, 10_000).catch(() => {});
    await rpc?.close?.().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  /** Codex ended it: the page hears so, once. */
  closed(session, reason) {
    if (session.told) return;
    session.told = true;
    this.onEvent(session.id, { type: "ended", ...(reason && { reason }) });
    void this.stop(session);
  }
  async close() {
    await Promise.allSettled([...this.sessions.values()].map((s) => this.stop(s)));
  }
}
