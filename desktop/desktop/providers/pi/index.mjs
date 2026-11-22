// Pi (pi.dev, the `pi` command, MIT) as a harness: Settings › Harness › Pi.
//
// Pi is a coding agent: the loop, the tools (read, bash, edit, write, grep, find, ls) and the
// session files. It isn't a model provider here. A chat on a ChatGPT or Claude plan's model runs
// in Pi, and the plan answers Pi's model requests through Botkins' gateway (desktop/harness), the
// same connection the Copilot runtime uses. Pi keeps no sign-in of its own for this.
//
// Each Botkins conversation is one `pi --mode rpc` process, kept running between turns and
// started again on Pi's own session file when it was let go. Botkins' extension
// (extension.mjs) gives Pi the gateway connections, the session's MCP servers (Botkins' own tools
// among them, through the tool bridge), the bot's instructions, and Botkins' approvals: Pi asks
// before every tool that isn't Botkins' own, and Botkins' rules and the person decide.
//
// The person's own Pi setup (~/.pi) is left alone: Pi runs with a folder of Botkins' own
// (PI_CODING_AGENT_DIR), no extensions or skills of its own, and nothing from a project's .pi.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { cliEnv, findBinary, run, versionOf } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { SessionStore, serversWithTokens, transcriptContext, uuidFor } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";

export const PI_ID = "pi";
/** The bridge's name among a session's MCP servers. Its tools never ask. */
export const BRIDGE = "botkins";
/** How the extension asks for an approval (extension.mjs). */
export const ASK = "botkins:permission";
export const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "extension.mjs");
export const INSTALL = { url: "https://pi.dev", command: "curl -fsSL https://pi.dev/install.sh | sh" };
/** Pi's thinking levels. Botkins' efforts are the same words. */
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const level = (effort) => (effort === "none" ? "off" : LEVELS.has(effort) ? effort : null);
/** A conversation lets go of its Pi after this long unused; the next turn starts it again on the same session. */
const IDLE_MS = 15 * 60 * 1000;
const MAX_LIVE = 8;
/** Pi's session ids: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. */
const piSessionId = (id) => (/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(id) ? id : uuidFor(id));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const READS = new Set(["read", "grep", "find", "ls"]);
const WRITES = new Set(["write", "edit"]);
/** [tool, MCP server or undefined] for a Pi tool name: MCP tools are "mcp__<server>__<tool>". */
function splitName(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ""));
  return match ? [match[2], match[1]] : [String(name ?? "tool"), undefined];
}
/**
 * Pi's words for a failed request ("402 {…}", "<provider> API error (400): {…}") as the
 * provider's own message, which is what a person can act on. Anything else is kept as it is.
 */
export function errorText(text) {
  const raw = String(text ?? "").trim();
  const at = raw.indexOf("{");
  if (at < 0) return raw;
  try {
    const body = JSON.parse(raw.slice(at));
    const message = body?.error?.message ?? body?.message;
    return typeof message === "string" && message ? message : raw;
  } catch {
    return raw;
  }
}
/**
 * Claude can bill a request as extra usage because of what its system prompt says, although the
 * plan has room (Pi's own prompt did, until the extension left a section out: extension.mjs). So
 * when one is refused for extra usage, the person is told where else their plan answers.
 */
export const EXTRA_USAGE = " If your Claude plan still has room, Claude may have counted this chat as extra usage because of what it was sent. The Copilot SDK harness (Settings › General › Harness) also answers on your plan.";
const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : part?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");

/** A Botkins MCP server record as Pi's, or null for a kind Pi can't connect to (SSE). */
function piServer(server) {
  if (server.type === "stdio") return { command: server.command, args: server.args ?? [], ...(server.env && { env: server.env }), ...(server.cwd && { cwd: server.cwd }), exposure: "direct" };
  if (server.type === "sse" || !server.url) return null;
  return { url: server.url, ...(server.headers && { headers: server.headers }), exposure: "direct" };
}

/**
 * A `pi --mode rpc` process: commands in, events out, one JSON object per line. Lines are split on
 * LF only, as Pi's framing says: a JSON string may hold U+2028, which a line reader splits on.
 */
export class PiRpc {
  constructor(file, args, { env, cwd } = {}) {
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderr = "";
    this.child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(file) });
    this.exited = new Promise((resolve) => {
      const done = (error) => {
        if (this.closed) return;
        this.closed = true;
        const reason = error ?? new Error(this.stderr.trim().split("\n").slice(-3).join("\n") || "Pi stopped.");
        // Like any provider's process that stopped: a turn it was running is retried once (desktop/workspace.mjs).
        if (!error) reason.code = "BOTKINS_PROVIDER_EXIT";
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(reason);
        }
        this.pending.clear();
        for (const listener of this.listeners) listener({ type: "botkins_exit", error: reason });
        resolve(reason);
      };
      this.child.on("error", done);
      this.child.on("close", () => done());
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk) => (this.stderr = (this.stderr + chunk).slice(-8000)));
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (line) this.receive(line);
      }
    });
  }
  write(message) {
    if (this.closed) throw new Error("Pi has stopped.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  /** Sends a command and resolves its response's `data`; rejects when Pi refuses it. */
  request(command, timeoutMs = 60000) {
    const id = "bk-" + this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Pi took too long to answer."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.success === false) waiting.reject(new Error(message.error || "Pi refused " + message.command + "."));
      else waiting.resolve(message.data);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Pi event:", error.message);
      }
    }
  }
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 2000);
    await this.exited;
    clearTimeout(timer);
  }
}

class PiSession extends ProviderSession {
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
    this.lost = "";
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(type, data) {
    for (const handler of this.handlers) handler({ type, data });
  }
  /** The plan connection and model this session's model is on, in Pi's terms. */
  target(model = this.model) {
    const connection = this.spec.inference?.providers?.find((each) => each.name === model.source) ?? this.spec.inference?.providers?.[0];
    if (!connection) throw new Error("Pi runs ChatGPT and Claude plan models. Choose one of those for this chat.");
    return { provider: connection.name, modelId: model.model };
  }
  /** What the extension reads (extension.mjs): the connections, the MCP servers and the instructions. */
  async describe() {
    const { spec } = this;
    const servers = {};
    for (const [name, server] of Object.entries(await serversWithTokens(spec))) {
      if (name === BRIDGE) continue;
      const entry = piServer(server);
      if (entry) servers[name] = entry;
    }
    if (this.bridge) servers[BRIDGE] = { url: this.bridge.url, headers: this.bridge.headers, exposure: "direct" };
    return {
      providers: (spec.inference?.providers ?? []).map(({ name, config }) => ({ name, config })),
      servers,
      prompt: (spec.instructions ?? "") + this.skills.instructions + (spec.context ?? "") + this.lost,
    };
  }
  async start() {
    const { provider, spec } = this;
    const tools = spec.handlers ? [...spec.tools, ...this.skills.tools] : [];
    this.bridge ??= await provider.bridge?.open(tools, spec.temporary ? {} : { key: provider.id + ":" + spec.sessionId });
    this.bridge?.set(tools);
    const known = provider.sessions.get(spec.sessionId);
    // A conversation Pi doesn't hold (new to Pi, or its folder moved) goes on from Botkins' transcript.
    if (spec.established && spec.hasReplies && (!known || known.folder !== spec.folder)) this.lost = transcriptContext(spec);
    const described = await this.describe();
    this.live = await provider.process(this, described);
    if (!spec.temporary && !known) provider.sessions.set(spec.sessionId, { ref: this.live.ref, folder: spec.folder });
    return this.live;
  }
  async send(message, timeoutMs = 600000) {
    if (this.turn || this.sending) throw new Error("This conversation is already working.");
    this.sending = true;
    this.stopRequested = false;
    let stop = () => {};
    try {
      const live = await this.start();
      if (this.stopRequested || this.closed) return { text: "" };
      const { rpc } = live;
      const turn = (this.turn = { text: "", parts: [], thinking: null, gap: false, error: null, stopReason: null });
      const settled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Pi took too long to answer.")), timeoutMs);
        const off = rpc.on((event) => {
          if (event.type === "botkins_exit") return reject(event.error);
          this.event(event);
          if (event.type === "agent_settled") resolve(event);
        });
        stop = () => {
          clearTimeout(timer);
          off();
        };
      });
      const files = (message.attachments ?? []).map((a) => "- " + a.path).join("\n");
      const text =
        (this.mode === "plan" ? "Plan mode: do not change any file. Work out a plan, show it, and ask before carrying it out.\n\n" : "") +
        message.prompt +
        (files ? "\n\nAttached:\n" + files : "");
      this.emit("user.message", {});
      try {
        await rpc.request({ type: "prompt", message: text }, 30000);
        await settled;
      } catch (error) {
        this.interrupt();
        throw error;
      }
      if (this.lost) {
        // Pi has the conversation in its own session now.
        this.lost = "";
        await this.provider.write(live, await this.describe());
      }
      const reply = turn.text.trim();
      if (!reply && turn.stopReason === "error") {
        const said = errorText(turn.error) || "Pi couldn't get an answer from the model.";
        throw new Error(/out of extra usage/i.test(said) ? said + EXTRA_USAGE : said);
      }
      if (!reply && turn.stopReason === "length") throw new Error("Pi ran out of room before it could answer.");
      return { text: reply };
    } finally {
      stop();
      this.turn = null;
      this.sending = false;
      this.provider.touch(this.spec.sessionId);
    }
  }
  /** One of Pi's events, as Botkins' (desktop/providers/provider.mjs). */
  event(event) {
    const turn = this.turn;
    if (!turn) return;
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent ?? {};
        if (update.type === "text_delta" && update.delta) {
          // Text after a tool call is a new paragraph of the same reply.
          const delta = (turn.gap && turn.text ? "\n\n" : "") + update.delta;
          turn.gap = false;
          turn.text += delta;
          this.emit("assistant.message_delta", { deltaContent: delta });
        } else if (update.type === "thinking_delta" && update.delta) {
          turn.thinking ??= "thought-" + Date.now();
          this.emit("assistant.reasoning_delta", { reasoningId: turn.thinking, deltaContent: update.delta });
        }
        return;
      }
      case "message_end": {
        const message = event.message ?? {};
        if (message.role !== "assistant") return;
        turn.stopReason = message.stopReason ?? null;
        turn.error = message.errorMessage ?? null;
        turn.thinking = null;
        const usage = message.usage;
        if (usage) {
          this.emit("assistant.usage", { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0, model: this.model.model });
          const window = this.windowOf(this.model.model);
          const used = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
          if (window && used) this.emit("session.usage_info", { currentTokens: used, tokenLimit: window });
        }
        return;
      }
      case "tool_execution_start": {
        Object.assign(turn, { thinking: null, gap: true });
        const [name, server] = splitName(event.toolName);
        const own = server === BRIDGE;
        this.emit("tool.execution_start", {
          toolCallId: event.toolCallId,
          toolName: name,
          arguments: event.args && typeof event.args === "object" ? event.args : {},
          ...(server && !own && { mcpServerName: server, mcpToolName: name }),
        });
        return;
      }
      case "tool_execution_end": {
        const output = textOf(event.result?.content) || (event.result?.details ? displayValue(event.result.details, 12000) : "");
        const success = !event.isError;
        this.emit("tool.execution_complete", { toolCallId: event.toolCallId, success, ...(output && { result: { content: output } }), ...(!success && { error: { message: output || "Failed" } }) });
        return;
      }
    }
  }
  windowOf(id) {
    for (const connection of this.spec.inference?.providers ?? []) {
      const model = connection.config?.models?.find((m) => m.id === id);
      if (model?.contextWindow) return model.contextWindow;
    }
    return null;
  }
  /** The extension's question before a tool runs: Botkins' rules and the person decide. */
  async permission(call) {
    const handlers = this.spec.handlers;
    if (!handlers || !this.turn) return false;
    const [name, server] = splitName(call.toolName);
    if (server === BRIDGE) return true;
    const input = call.input && typeof call.input === "object" ? call.input : {};
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
    let request;
    if (server)
      request = { kind: "mcp", label: server + " / " + name, title: "Use " + server + " / " + name + "?", preview: displayValue(input, Infinity), remember: ["MCP tool " + server + "/" + name, server, name] };
    else if (name === "bash") {
      const command = String(input.command ?? "");
      request = { kind: "shell", label: "Shell command", title: "Run this command?", preview: command, remember: command ? ["this exact command", command] : null };
    } else if (WRITES.has(name))
      request = { kind: "write", label: path || name, title: (name === "edit" ? "Edit" : "Write") + " this file?", preview: String(input.content ?? input.newText ?? (displayValue(input, Infinity) || path)), remember: path ? ["writes to this path", path] : null };
    else if (READS.has(name)) request = { kind: "read", label: path || name, title: "Read " + (path || "files") + "?", preview: path || displayValue(input, Infinity), remember: path ? ["reads of this path", path] : null };
    else request = { kind: "custom-tool", label: name, title: "Use " + name + "?", preview: displayValue(input, Infinity), remember: null };
    try {
      const answer = await handlers.permission({ ...request, toolName: name, detail: displayValue(call, Infinity), readOnly: request.kind === "read", sandboxEscape: false, managed: false });
      return !!answer?.allow;
    } catch {
      return false;
    }
  }
  interrupt() {
    try {
      this.live?.rpc.write({ type: "abort" });
    } catch {
      // Pi has stopped: there is nothing to stop.
    }
  }
  async abort() {
    this.stopRequested = true;
    if (this.turn) this.interrupt();
  }
  async close({ discard = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    if (this.turn) this.interrupt();
    this.bridge?.close();
    this.provider.detach(this, { discard });
  }
  async currentModel() {
    return { model: this.model.model, reasoningEffort: this.model.reasoningEffort };
  }
  async switchModel(selection) {
    this.model = { ...this.model, ...selection };
    const live = this.live;
    if (!live || live.rpc.closed) return;
    await live.rpc.request({ type: "set_model", ...this.target() });
    const wanted = level(this.model.reasoningEffort);
    if (wanted) await live.rpc.request({ type: "set_thinking_level", level: wanted }).catch(() => {});
  }
  async setMode(mode) {
    this.mode = mode === "plan" ? "plan" : "interactive";
    return true;
  }
  async todos() {
    return null;
  }
  async compact() {
    const live = await this.start();
    await live.rpc.request({ type: "compact" }, 600000);
  }
  async inventory() {
    const servers = Object.keys(this.spec.mcpServers ?? {}).map((name) => ({ name, status: "not started" }));
    return buildInventory({ name: "Pi", tools: this.spec.tools, servers, native: skillChoices(this.skills.list), compact: true });
  }
  resolvePrompt(prompt, run, chat, host) {
    return resolvePrompt(this, prompt, run, chat, host);
  }
}

export class PiProvider extends ModelProvider {
  id = PI_ID;
  name = "Pi";
  description = "The Pi coding agent, as the harness for ChatGPT and Claude plans.";
  /** A harness, not a model provider: Settings › Model providers doesn't list it. */
  harness = true;
  /**
   * @param options.dataDir  Botkins' folder for Pi: its config folder, session files and the files the extension reads.
   * @param options.bridge   The tool bridge Botkins' tools are offered through.
   * @param options.binary   For tests: the `pi` to run.
   * @param options.env      For tests: what Pi runs with instead of this computer's environment.
   */
  constructor({ dataDir, bridge, binary, env } = {}) {
    super();
    Object.assign(this, { dataDir: dataDir ?? join(tmpdir(), "botkins-pi"), bridge, binary, baseEnv: env });
    this.sessions = new SessionStore(dataDir && join(dataDir, "sessions.json"));
    // Botkins session id → { rpc, ref, key, file, session, timer }: the Pi process each conversation has.
    this.live = new Map();
  }
  locate() {
    return findBinary("pi", { override: this.binary, env: this.baseEnv });
  }
  async status() {
    const file = await this.locate();
    const version = file ? versionOf((await run(file, ["--version"], { env: await cliEnv({ PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" }, this.baseEnv), timeoutMs: 15000 }).catch(() => ({ stdout: "" }))).stdout) : "";
    // Another tool can be called `pi`; Pi answers --version with its version alone.
    if (!version)
      return { installed: false, connected: false, signIn: null, signOut: false, message: "Install Pi on this computer to use it as the harness.", ...(process.platform !== "win32" ? { install: INSTALL } : { install: { url: INSTALL.url } }) };
    return { installed: true, version, connected: true, signIn: null, signOut: false };
  }
  async version() {
    return "Pi " + ((await this.status()).version ?? "");
  }
  /** The Pi process for a session, started when it has none or when what it was started with changed. */
  async process(session, described) {
    const { spec } = session;
    const target = session.target();
    // Pi takes its connections and model list once, at start: a change starts it again on its session file.
    const key = hash([spec.folder, described.providers, spec.temporary]);
    let live = this.live.get(spec.sessionId);
    if (live && (live.key !== key || live.rpc.closed)) {
      this.live.delete(spec.sessionId);
      await live.rpc.close().catch(() => {});
      live = null;
    }
    if (live) {
      live.session = session;
      await this.write(live, described);
      clearTimeout(live.timer);
      const state = await live.rpc.request({ type: "get_state" }, 15000).catch(() => null);
      if (state?.model && (state.model.provider !== target.provider || state.model.id !== target.modelId)) await live.rpc.request({ type: "set_model", ...target });
      const wanted = level(session.model.reasoningEffort);
      if (wanted && state?.thinkingLevel !== wanted) await live.rpc.request({ type: "set_thinking_level", level: wanted }).catch(() => {});
      return live;
    }
    const file = await this.locate();
    if (!file) throw new Error("Pi isn't installed. Install it in Settings › Harness, or choose another harness.");
    const ref = this.sessions.get(spec.sessionId)?.ref ?? piSessionId(spec.sessionId);
    const dir = join(this.dataDir, "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    live = { ref, key, file: join(dir, hash(spec.sessionId).slice(0, 24) + ".json"), session, timer: null };
    await this.write(live, described);
    const wanted = level(session.model.reasoningEffort);
    const args = [
      "--mode", "rpc",
      ...(spec.temporary ? ["--no-session"] : ["--session-dir", join(this.dataDir, "sessions"), "--session-id", ref]),
      "--model", target.provider + "/" + target.modelId,
      ...(wanted ? ["--thinking", wanted] : []),
      // Nothing of the person's own Pi setup or of a project's .pi: Botkins supplies skills, tools and servers.
      "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "-e", "builtin:mcp", "-e", EXTENSION,
    ];
    const env = await cliEnv({ PI_CODING_AGENT_DIR: join(this.dataDir, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1", BOTKINS_PI_SESSION: live.file }, this.baseEnv);
    live.rpc = new PiRpc(file, args, { env, cwd: spec.folder });
    live.rpc.on((event) => {
      if (event.type === "extension_ui_request") void this.dialog(live, event);
    });
    live.rpc.exited.then(() => {
      if (this.live.get(spec.sessionId) === live) this.live.delete(spec.sessionId);
      rmSync(live.file, { force: true });
    });
    this.live.set(spec.sessionId, live);
    // The fewest at once: the conversation used longest ago lets go of its Pi.
    if (this.live.size > MAX_LIVE) {
      const idle = [...this.live.entries()].find(([, other]) => other !== live && !other.session?.turn);
      if (idle) this.release(idle[0]);
    }
    // Pi answers once it has started; a Pi that can't start says why on its error output.
    await live.rpc.request({ type: "get_state" }, 60000).catch(async (error) => {
      this.live.delete(spec.sessionId);
      await live.rpc.close().catch(() => {});
      throw new Error("Pi couldn't start. " + String(live.rpc.stderr.trim().split("\n").slice(-2).join(" ") || error.message).slice(0, 400));
    });
    return live;
  }
  /** Writes the file the extension reads, readable by this user only. */
  async write(live, described) {
    writeFileSync(live.file, JSON.stringify(described), { mode: 0o600 });
  }
  /** Pi's extension dialogs. Only Botkins' approval question is answered; any other is cancelled. */
  async dialog(live, request) {
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
    const title = String(request.title ?? "");
    let allow = false;
    if (request.method === "select" && title.startsWith(ASK + " ")) {
      let call = {};
      try {
        call = JSON.parse(title.slice(ASK.length + 1));
      } catch {
        // Not Botkins' own question.
      }
      allow = live.session ? await live.session.permission(call) : false;
    }
    try {
      live.rpc.write(allow ? { type: "extension_ui_response", id: request.id, value: "allow" } : { type: "extension_ui_response", id: request.id, ...(request.method === "select" && title.startsWith(ASK) ? { value: "deny" } : { cancelled: true }) });
    } catch {
      // Pi has stopped.
    }
  }
  touch(sessionId) {
    const live = this.live.get(sessionId);
    if (!live) return;
    clearTimeout(live.timer);
    live.timer = setTimeout(() => this.release(sessionId), IDLE_MS);
    live.timer.unref?.();
  }
  detach(session, { discard = false } = {}) {
    const live = this.live.get(session.spec.sessionId);
    if (!live || live.session !== session) return;
    live.session = null;
    if (discard || session.spec.temporary) this.release(session.spec.sessionId);
    else this.touch(session.spec.sessionId);
  }
  release(sessionId) {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    clearTimeout(live.timer);
    void live.rpc.close().catch(() => {});
  }
  async openSession(spec) {
    return new PiSession(this, spec);
  }
  async releaseSession(sessionId, { busy = false } = {}) {
    const live = this.live.get(sessionId);
    if (live && (busy || !live.session?.turn)) this.release(sessionId);
  }
  async releaseSessions({ busy = false } = {}) {
    for (const [id, live] of [...this.live]) if (busy || !live.session?.turn) this.release(id);
  }
  suspend() {
    return this.stop();
  }
  async stop() {
    const all = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(all.map((live) => (clearTimeout(live.timer), live.rpc.close())));
  }
  async deleteSession(sessionId) {
    this.release(sessionId);
    this.bridge?.forget(this.id + ":" + sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
  }
}
