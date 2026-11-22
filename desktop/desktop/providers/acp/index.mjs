// Any agent that speaks the Agent Client Protocol (ACP) as a Botkins model provider.
//
// ACP is a JSON-RPC protocol over an agent's standard input and output that several coding
// agents implement (see agentclientprotocol.com). One adapter therefore serves all of them: each
// is this class with the command that starts it (desktop/providers/acp/agents.mjs lists the ones
// Botkins knows). The agent keeps its own sign-in, which the person does in a terminal with
// the agent's own command; Botkins says which.
//
// A Botkins session is an ACP session; sessions.json remembers which. ACP has no place for a
// system prompt, so a bot's instructions are sent ahead of the first message of a session, and
// again when they change. Botkins' own tools reach the agent through the tool bridge
// (desktop/providers/toolbridge.mjs), as an MCP server named "botkins".
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { StdioRpc, cliEnv, findBinary } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { SessionStore, missingConversation, serversWithTokens, transcriptContext } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";
import { ReportedLimits, modelDetails } from "../../modeldetails.mjs";

/** The bridge's name among a session's MCP servers. */
export const BRIDGE = "botkins";
// How an ACP tool kind counts in Botkins' work summary (desktop/canvas.mjs).
const TOOL_NAMES = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "shell", think: "think", fetch: "web_fetch", switch_mode: "task_complete" };
const PERMISSION_KINDS = { execute: "shell", edit: "write", delete: "write", move: "write", read: "read", search: "read", fetch: "url" };
// Kinds an agent gives its own built-in tools. A call of one of these is never an MCP server's,
// whatever its title says: for a shell call the title is the command line, which the model writes.
const BUILT_IN = new Set(Object.keys(PERMISSION_KINDS));
/** True when an error says nobody is signed in. -32000 is ACP's "authentication required". */
const signedOut = (error) => error?.code === -32000 || /auth(entication|orization)? required|not (logged|signed) in|(log|sign) ?in (first|required)|unauthenticated|please (log|sign) ?in/i.test(String(error?.message ?? ""));

const pairs = (object) => Object.entries(object ?? {}).map(([name, value]) => ({ name, value: String(value) }));
/** A Botkins MCP server record as ACP's, or null when the agent can't connect to that kind. */
function acpServer(name, server, capabilities) {
  if (server.type === "stdio") return { name, command: server.command, args: server.args ?? [], env: pairs(server.env) };
  const type = server.type === "sse" ? "sse" : "http";
  if (!capabilities?.[type]) return null;
  return { type, name, url: server.url, headers: pairs(server.headers) };
}
const textOf = (content) =>
  (Array.isArray(content) ? content : content ? [content] : [])
    .map((part) => part?.text ?? part?.content?.text ?? (part?.type === "diff" ? (part.path ?? "") + "\n" + (part.newText ?? "") : ""))
    .filter(Boolean)
    .join("\n");
/** Matches a tool call's title when the tool is one of `server`'s, and captures the tool's own name. */
const ofServer = (server) => new RegExp("^(?:mcp__)?" + server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:__|_|-|: ?|\\/|\\.)(.+)$", "i");
/** The session's thinking-level choice, when the agent offers one as a setting. */
const effortOption = (options) => (options ?? []).find((o) => o.type === "select" && /reason|effort|thought|thinking/i.test(o.id + " " + (o.category ?? "")));

class AcpSession extends ProviderSession {
  constructor(provider, spec) {
    super();
    this.provider = provider;
    this.spec = spec;
    this.id = spec.sessionId;
    this.model = { ...spec.model };
    this.skills = skillSupport(spec);
    this.handlers = new Set();
    this.mode = "interactive";
    this.turn = null;
    this.calls = new Map();
    this.plan = null;
    // The names of Botkins' own tools on this session's bridge. Only an exact name is trusted.
    this.own = new Set();
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(type, data, id) {
    for (const handler of this.handlers) handler({ type, data, ...(id && { id }) });
  }
  /** Everything the agent is told once per session, since ACP has no system prompt. */
  preamble() {
    return this.spec.instructions + this.skills.instructions + (this.spec.context ?? "");
  }
  session() {
    this.starting ??= this.start().catch((error) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }
  async start() {
    const { provider, spec } = this;
    const { rpc, capabilities } = await provider.agent();
    const tools = spec.handlers ? [...spec.tools, ...this.skills.tools] : [];
    // An agent that can't connect to an HTTP MCP server gets no Botkins tools (its status says so).
    this.bridge = capabilities.mcpCapabilities?.http ? await provider.bridge.open(tools, spec.temporary ? {} : { key: provider.id + ":" + spec.sessionId }) : null;
    this.own = new Set(this.bridge ? tools.map((tool) => tool.name) : []);
    const servers = Object.entries(await serversWithTokens(spec))
      .filter(([name]) => name !== BRIDGE)
      .map(([name, server]) => acpServer(name, server, capabilities.mcpCapabilities))
      .filter(Boolean);
    if (this.bridge) servers.push({ type: "http", name: BRIDGE, url: this.bridge.url, headers: pairs(this.bridge.headers) });
    const known = spec.established && provider.sessions.get(spec.sessionId);
    let opened;
    if (known && provider.live.has(known.ref)) {
      // The agent still has the session from an earlier turn: it goes on, with the servers it was given then.
      this.sessionId = known.ref;
      opened = provider.live.get(known.ref);
    } else if (known && capabilities.loadSession) {
      // Loading replays the conversation as updates; they are the past, not this turn.
      this.replaying = true;
      try {
        opened = await rpc.request("session/load", { sessionId: known.ref, cwd: spec.folder, mcpServers: servers }, 120000);
        this.sessionId = known.ref;
      } catch (error) {
        if (/already loaded/i.test(error.message)) this.sessionId = known.ref;
        else if (!missingConversation(error) && error.code !== -32002) throw error;
      } finally {
        this.replaying = false;
      }
    }
    if (!this.sessionId) {
      opened = await rpc.request("session/new", { cwd: spec.folder, mcpServers: servers }, 120000);
      this.sessionId = opened.sessionId;
      // A conversation the agent doesn't hold continues from Botkins' own transcript.
      this.lost = spec.established && spec.hasReplies ? transcriptContext(spec) : "";
      if (!spec.temporary) provider.sessions.set(spec.sessionId, { ref: this.sessionId, told: "" });
    }
    this.options = opened?.configOptions ?? [];
    provider.learn(opened);
    // What the agent's session is on now: kept up to date as the model and thinking level are set.
    if (!provider.live.has(this.sessionId)) provider.live.set(this.sessionId, { configOptions: this.options, models: opened?.models, model: opened?.models?.currentModelId });
    provider.attach(this);
    await this.applyModel();
    return this.sessionId;
  }
  /** Puts the session on this chat's model and thinking level, where the agent lets a client choose. */
  async applyModel() {
    const { rpc } = await this.provider.agent();
    const live = this.provider.live.get(this.sessionId);
    const wanted = this.model.model;
    if (wanted && wanted !== "default" && live && wanted !== live.model) {
      await rpc.request("session/set_model", { sessionId: this.sessionId, modelId: wanted }, 30000);
      live.model = wanted;
    }
    const option = effortOption(this.options);
    const effort = this.model.reasoningEffort;
    if (option && effort && option.currentValue !== effort && option.options?.some((o) => o.value === effort))
      await rpc.request("session/set_config_option", { sessionId: this.sessionId, configId: option.id, value: effort }, 30000).then(
        () => (option.currentValue = effort),
        () => {},
      );
  }

  /**
   * Sends one message. There is no time limit: the person stops a turn that runs long, and the
   * agent's process ending ends the turn (the request fails). `timeoutMs` is for a caller with
   * nobody to stop it, such as a background summary; 0 is no limit.
   */
  async send(message, timeoutMs = 0) {
    if (this.turn || this.sending) throw new Error("This conversation is already working.");
    this.sending = true;
    this.stopRequested = false;
    try {
      const sessionId = await this.session();
      const { provider, spec } = this;
      const { rpc } = await provider.agent();
      // Stop was pressed while the agent was still starting: the turn never begins.
      if (this.stopRequested || this.closed) return { text: "" };
      const turn = (this.turn = { text: [], thinking: null, gap: false });
      // The bot's instructions go ahead of the first message, and again whenever they changed.
      const preamble = this.preamble();
      const told = createHash("sha256").update(preamble).digest("hex");
      const record = provider.sessions.get(spec.sessionId);
      const fresh = spec.temporary || record?.told !== told;
      const text =
        (fresh && (preamble || this.lost) ? "<instructions>\n" + preamble.trim() + (this.lost ?? "") + "\n</instructions>\n\n" : "") +
        (this.mode === "plan" ? "Plan mode: do not change any file. Work out a plan, show it, and ask before carrying it out.\n\n" : "") +
        message.prompt;
      const prompt = [
        { type: "text", text },
        ...(message.attachments ?? []).map((a) => ({ type: "resource_link", uri: "file://" + a.path, name: a.name })),
      ];
      this.emit("user.message", {});
      let result;
      try {
        result = await rpc.request("session/prompt", { sessionId, prompt }, timeoutMs);
      } catch (error) {
        // Whatever went wrong here, the agent must not go on working on a turn nobody is waiting for.
        this.interrupt();
        throw signedOut(error) ? new Error(provider.signedOutMessage()) : error;
      }
      if (!spec.temporary) provider.sessions.update(spec.sessionId, (r) => (r.told = told));
      this.lost = "";
      if (result?.usage)
        this.emit("assistant.usage", {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cacheReadTokens: result.usage.cachedReadTokens ?? 0,
          model: this.model.model,
        });
      const reply = turn.text.join("").trim();
      if (result?.stopReason === "refusal" && !reply) throw new Error(provider.name + " declined to answer this.");
      if (result?.stopReason === "max_tokens" && !reply) throw new Error(provider.name + " ran out of room before it could answer.");
      return { text: reply };
    } finally {
      this.turn = null;
      this.sending = false;
    }
  }
  /** One session/update notification. */
  updated(update) {
    if (this.replaying) return;
    const turn = this.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.text;
        if (!turn || !text) return;
        // Text after a tool call is a new paragraph of the same reply.
        if (turn.gap && turn.text.length) {
          turn.text.push("\n\n");
          this.emit("assistant.message_delta", { deltaContent: "\n\n" });
        }
        turn.gap = false;
        turn.text.push(text);
        this.emit("assistant.message_delta", { deltaContent: text });
        return;
      }
      case "agent_thought_chunk": {
        const text = update.content?.text;
        if (!turn || !text) return;
        turn.thinking ??= "thought-" + Date.now();
        this.emit("assistant.reasoning_delta", { reasoningId: turn.thinking, deltaContent: text });
        return;
      }
      case "tool_call": {
        if (turn) Object.assign(turn, { thinking: null, gap: true });
        this.toolCall(update);
        return;
      }
      case "tool_call_update": {
        const call = this.toolCall(update);
        if (update.status !== "completed" && update.status !== "failed") return;
        if (call.done) return;
        call.done = true;
        const output = textOf(update.content) || (typeof update.rawOutput === "string" ? update.rawOutput : update.rawOutput ? displayValue(update.rawOutput, 12000) : "");
        const success = update.status === "completed";
        this.emit("tool.execution_complete", { toolCallId: update.toolCallId, success, ...(output && { result: { content: output } }), ...(!success && { error: { message: output || "Failed" } }) });
        return;
      }
      case "plan":
        this.plan = (update.entries ?? []).map((entry, i) => ({ id: String(i + 1), title: entry.content, status: entry.status }));
        this.emit("session.todos_changed", {});
        return;
      case "usage_update":
        if (update.size) {
          this.emit("session.usage_info", { currentTokens: update.used ?? 0, tokenLimit: update.size });
          // An ACP agent's model list has no numbers: the window it reports for a turn is kept for the list.
          if (this.model.model) this.provider.reported.note(this.model.model, { contextWindow: update.size });
        }
        return;
      case "config_option_update":
        this.options = update.configOptions ?? this.options;
        if (this.provider.live.has(this.sessionId)) this.provider.live.get(this.sessionId).configOptions = this.options;
        return;
    }
  }
  /** Records a tool call the first time it is seen, with whatever the agent has said about it so far. */
  toolCall(update) {
    let call = this.calls.get(update.toolCallId);
    if (!call) {
      call = { done: false };
      this.calls.set(update.toolCallId, call);
      const [name, server] = this.toolName(update);
      this.emit("tool.execution_start", {
        toolCallId: update.toolCallId,
        toolName: name,
        arguments: update.rawInput && typeof update.rawInput === "object" ? update.rawInput : { description: update.title ?? name },
        ...(server && { mcpServerName: server, mcpToolName: name }),
      });
    }
    return call;
  }
  /**
   * [name, MCP server or undefined, whether it is one of Botkins' own tools] for a tool call.
   * Agents name MCP tools "server: tool", "server__tool", "server-tool" and so on. Only a call
   * that isn't one of the agent's built-in kinds can be an MCP server's, and it is Botkins'
   * own only when what follows the bridge's name is exactly a tool this session offers.
   */
  toolName(update) {
    const title = String(update.title ?? "");
    if (!BUILT_IN.has(update.kind)) {
      const own = ofServer(BRIDGE).exec(title)?.[1].trim();
      if (own && this.own.has(own)) return [own, undefined, true];
      for (const server of Object.keys(this.spec.mcpServers ?? {})) {
        const match = ofServer(server).exec(title);
        if (match) return [match[1].trim(), server, false];
      }
    }
    return [TOOL_NAMES[update.kind] ?? (title.split(/[\s(:]/)[0] || "tool"), undefined, false];
  }
  /** session/request_permission: Botkins' rules and the person decide; the answer picks one of the agent's options. */
  async permission(request) {
    const options = request.options ?? [];
    const pick = (...kinds) => kinds.map((kind) => options.find((o) => o.kind === kind)).find(Boolean);
    const allowed = { outcome: { outcome: "selected", optionId: (pick("allow_once", "allow_always") ?? options[0])?.optionId } };
    const refused = pick("reject_once", "reject_always") ? { outcome: { outcome: "selected", optionId: pick("reject_once", "reject_always").optionId } } : { outcome: { outcome: "cancelled" } };
    const handlers = this.spec.handlers;
    if (!handlers || !this.turn) return refused;
    const call = request.toolCall ?? {};
    const [name, server, own] = this.toolName(call);
    // Botkins' own tools never ask.
    if (own) return allowed;
    const kind = server ? "mcp" : (PERMISSION_KINDS[call.kind] ?? "custom-tool");
    const preview = call.rawInput?.command ?? call.rawInput?.path ?? call.rawInput?.url ?? (textOf(call.content) || displayValue(call.rawInput ?? {}, Infinity));
    try {
      const answer = await handlers.permission({
        kind,
        toolName: name,
        title: call.title || "Allow this?",
        label: kind === "shell" ? "Shell command" : server ? server + " / " + name : (call.locations?.[0]?.path ?? name),
        preview: String(preview),
        detail: displayValue(call, Infinity),
        remember: typeof preview === "string" && preview && kind !== "custom-tool" ? ["this exact request", kind, preview] : null,
        readOnly: kind === "read",
        sandboxEscape: false,
        managed: false,
      });
      return answer?.allow ? allowed : refused;
    } catch {
      return refused;
    }
  }

  /** Tells the agent to stop this session's turn. Never starts the agent. */
  interrupt() {
    if (!this.sessionId) return;
    try {
      this.provider.rpcNow?.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      // The agent has stopped: there is nothing left to cancel.
    }
  }
  async abort() {
    // Remembered too, for a Stop that arrives while the agent is still starting (see send).
    this.stopRequested = true;
    if (this.turn) this.interrupt();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    // A turn nobody waits for any more is not left running.
    if (this.turn) this.interrupt();
    this.bridge?.close();
    this.provider.detach(this);
  }
  async currentModel() {
    return { model: this.model.model, reasoningEffort: this.model.reasoningEffort };
  }
  async switchModel(selection) {
    this.model = { ...selection };
    if (this.sessionId) await this.applyModel();
  }
  async setMode(mode) {
    this.mode = mode === "plan" ? "plan" : "interactive";
    return true;
  }
  async todos() {
    return this.plan ? { rows: this.plan, dependencies: [] } : null;
  }
  async inventory() {
    const servers = Object.keys(this.spec.mcpServers ?? {}).map((name) => ({ name, status: "not started" }));
    return buildInventory({ name: this.provider.name, tools: this.spec.tools, servers, native: skillChoices(this.skills.list) });
  }
  resolvePrompt(prompt, run, chat, host) {
    return resolvePrompt(this, prompt, run, chat, host);
  }
}

export class AcpProvider extends ModelProvider {
  defaultEnabled = false;
  /**
   * @param options.id, name, description  How the provider appears in Botkins.
   * @param options.command   The agent's command-line tool, such as "grok".
   * @param options.args      What starts it in ACP mode, such as ["agent", "stdio"].
   * @param options.signIn    The command the person runs in a terminal to sign in, such as "grok login".
   * @param options.install   { url?, command? }: where to get the tool.
   * @param options.dataDir   Where the session records are kept. Omit to keep them in memory.
   * @param options.bridge    The tool bridge Botkins' tools are offered through.
   * @param options.spawn     For tests: async () => a StdioRpc-shaped peer instead of the real tool.
   */
  constructor({ id, name, description = "", command, args = [], signIn, install, dataDir, bridge, binary, spawn, version = "0" } = {}) {
    super();
    Object.assign(this, { id, name, description, command, args, signInCommand: signIn, install, dataDir, bridge, binary, spawn, appVersion: version });
    this.sessions = new SessionStore(dataDir && join(dataDir, "sessions.json"));
    this.reported = new ReportedLimits(dataDir && join(dataDir, "model-limits.json"));
    this.open = new Map();
    // Sessions the running agent holds in memory: ACP session id → what it reported when it was opened.
    this.live = new Map();
    this.connection = null;
    this.known = { models: [], efforts: [] };
  }
  locate() {
    return findBinary(this.command, { override: this.binary });
  }
  signedOutMessage() {
    return this.name + " isn't signed in. " + (this.signInCommand ? "Run `" + this.signInCommand + "` in a terminal, then try again." : "Sign in with its own command in a terminal, then try again.");
  }
  /** The running agent: { rpc, capabilities, authMethods }. It starts on first use and again after it stops. */
  agent() {
    this.connection ??= this.connect().catch((error) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }
  async connect() {
    let rpc;
    if (this.spawn) rpc = await this.spawn();
    else {
      const file = await this.locate();
      if (!file) throw new Error(this.name + " isn't installed.");
      rpc = new StdioRpc(file, this.args, { jsonrpc: true, env: await cliEnv() });
    }
    rpc.exited?.then(() => {
      if (this.rpcNow !== rpc) return;
      this.connection = null;
      this.rpcNow = null;
      this.open.clear();
      this.live.clear();
    });
    rpc.onNotification((method, params) => {
      if (method === "session/update") this.open.get(params?.sessionId)?.updated(params.update ?? {});
    });
    rpc.onRequest((method, params) => {
      const session = this.open.get(params?.sessionId);
      if (method === "session/request_permission") return session ? session.permission(params) : { outcome: { outcome: "cancelled" } };
      // Botkins offers the agent no file or terminal access of its own: the agent uses its own tools.
      throw Object.assign(new Error("Botkins doesn't support " + method + "."), { code: -32601 });
    });
    let started;
    try {
      started = await rpc.request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "botkins", title: "Botkins", version: this.appVersion } },
        60000,
      );
    } catch (error) {
      // A tool that started but doesn't speak ACP is not left running.
      await rpc.close().catch(() => {});
      throw error;
    }
    this.rpcNow = rpc;
    return { rpc, capabilities: started?.agentCapabilities ?? {}, authMethods: started?.authMethods ?? [], info: started?.agentInfo ?? {} };
  }
  /** Remembers the models and thinking levels a session reported, for the catalog. */
  learn(opened) {
    const models = opened?.models?.availableModels;
    if (models?.length) {
      const seen = new Set();
      this.known.models = models.filter((m) => m.modelId && !seen.has(m.modelId) && seen.add(m.modelId)).map((m) => ({ id: m.modelId, name: m.name || m.modelId, description: m.description, current: m.modelId === opened.models.currentModelId }));
    }
    const option = effortOption(opened?.configOptions);
    if (option) this.known.efforts = (option.options ?? []).map((o) => o.value).filter((v) => typeof v === "string");
  }
  attach(session) {
    this.open.set(session.sessionId, session);
  }
  detach(session) {
    if (this.open.get(session.sessionId) === session) this.open.delete(session.sessionId);
  }
  /**
   * A session the agent holds keeps the MCP servers (and their sign-in tokens) it was opened with.
   * With no session in a turn, the agent's process is let go, so every conversation is loaded
   * again with what is current; the next use starts it.
   */
  async releaseSessions() {
    if (![...this.open.values()].some((session) => session.turn || session.sending)) await this.stop();
  }
  suspend() {
    return this.stop();
  }
  async stop() {
    const connection = this.connection;
    this.connection = null;
    this.rpcNow = null;
    this.open.clear();
    this.live.clear();
    if (connection) await connection.then(({ rpc }) => rpc.close()).catch(() => {});
  }
  /** A folder of the provider's own, for the session that only asks what the agent offers. */
  home() {
    const dir = join(this.dataDir ?? join(tmpdir(), "botkins-" + this.id), "home");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Whether the agent is installed and signed in. ACP has no "who am I": the agent is asked for
   * a session, which it refuses when nobody is signed in, and which also says what models it has.
   */
  async status() {
    const install = this.install;
    if (!this.spawn && !(await this.locate()))
      return { installed: false, connected: false, signIn: null, signOut: false, message: "Install " + this.name + " (the `" + this.command + "` command) to use it here.", ...(install && { install }) };
    const { rpc, info, capabilities } = await this.agent();
    let opened;
    try {
      opened = await rpc.request("session/new", { cwd: this.home(), mcpServers: [] }, 60000);
    } catch (error) {
      // Only "nobody is signed in" is an answer. Anything else is a failure, reported as one.
      if (!signedOut(error)) throw new Error(this.name + " couldn't start a session: " + String(error.message).slice(0, 300));
      return { installed: true, version: info.version, connected: false, signIn: null, signOut: false, message: this.signedOutMessage() };
    }
    this.learn(opened);
    rpc.request("session/close", { sessionId: opened.sessionId }, 5000).catch(() => {});
    return {
      installed: true,
      version: info.version,
      connected: true,
      signIn: null,
      signOut: false,
      ...(!capabilities.mcpCapabilities?.http && { message: this.name + " can't connect to Botkins' tools, so its bots can chat but can't use panels, the wiki, memory or tasks." }),
    };
  }
  async auth() {
    const status = await this.status();
    return { connected: status.connected };
  }
  async models() {
    if (!this.known.models.length) await this.status();
    const list = this.known.models.length ? this.known.models : [{ id: "default", name: this.name + " default", current: true }];
    return list.map((m) => ({
      id: m.id,
      name: m.name,
      provider: this.id,
      efforts: [...this.known.efforts],
      // The agent's own line about the model, and the window it reported after a turn on it.
      ...modelDetails({ description: m.description, ...this.reported.for(m.id) }),
      ...(m.current && { recommended: true }),
      available: true,
    }));
  }
  async version() {
    const { info } = await this.agent();
    return [info.title || info.name || this.name, info.version, "· ACP"].filter(Boolean).join(" ");
  }

  async openSession(spec) {
    return new AcpSession(this, spec);
  }
  async deleteSession(sessionId) {
    const record = this.sessions.get(sessionId);
    this.bridge?.forget(this.id + ":" + sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
    this.live.delete(record.ref);
    const agent = await this.agent().catch(() => null);
    await agent?.rpc.request("session/close", { sessionId: record.ref }, 5000).catch(() => {});
  }
}
