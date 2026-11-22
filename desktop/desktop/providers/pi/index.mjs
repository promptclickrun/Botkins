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
// (PI_CODING_AGENT_DIR). Only Botkins and explicitly enabled marketplace packages are loaded.
import { PiPackages } from "./packages.mjs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { cliEnv, findBinary, run, versionOf } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { SessionStore, serversWithTokens, transcriptContext, uuidFor } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";

export const PI_ID = "pi";
export const OMP_ID = "omp";
/** The bridge's name among a session's MCP servers. Its tools never ask. */
export const BRIDGE = "botkins";
/** How the extension asks for an approval (extension.mjs). */
export const ASK = "botkins:permission";
const PROVIDER_DIR = dirname(fileURLToPath(import.meta.url));
export const EXTENSION = join(PROVIDER_DIR, "extension.mjs");
export const OMP_EXTENSION = join(PROVIDER_DIR, "..", "omp", "extension.mjs");
export const INSTALL = { url: "https://pi.dev", command: "curl -fsSL https://pi.dev/install.sh | sh" };
export const OMP_INSTALL = { url: "https://omp.sh", command: "curl -fsSL https://omp.sh/install | sh" };
const RUNTIMES = {
  [PI_ID]: {
    id: PI_ID,
    name: "Pi",
    binary: "pi",
    description: "The Pi coding agent, as the harness for ChatGPT and Claude plans.",
    install: INSTALL,
    extension: EXTENSION,
    sessionEnv: "BOTKINS_PI_SESSION",
  },
  [OMP_ID]: {
    id: OMP_ID,
    name: "OMP",
    binary: "omp",
    description: "OMP, the enhanced Pi coding agent, as the harness for ChatGPT and Claude plans.",
    install: OMP_INSTALL,
    extension: OMP_EXTENSION,
    sessionEnv: "BOTKINS_OMP_SESSION",
  },
};
/** Pi's thinking levels. Botkins' efforts are the same words. */
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const level = (effort) => (effort === "none" ? "off" : LEVELS.has(effort) ? effort : null);
/** A conversation lets go of its Pi after this long unused; the next turn starts it again on the same session. */
const IDLE_MS = 15 * 60 * 1000;
/** How long Pi lets one call to Botkins' tool server take. A call can wait for the person (a secure prompt), so it is longer than Pi's 60 seconds. */
const BRIDGE_CALL_TIMEOUT_S = 10 * 60;
const MAX_LIVE = 8;
/** Pi's session ids: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. */
const piSessionId = (id) => (/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(id) ? id : uuidFor(id));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const READS = new Set(["read", "grep", "find", "ls"]);
const WRITES = new Set(["write", "edit"]);
/** [tool, MCP server or undefined] for a Pi or OMP MCP tool name. */
function splitName(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(name ?? "")) ?? /^mcp__([^_]+)_(.+)$/.exec(String(name ?? ""));
  return match ? [match[2], match[1]] : [String(name ?? "tool"), undefined];
}
const toolIdentity = (call) => {
  const [fallbackName, fallbackServer] = splitName(call.toolName);
  return { name: call.mcpToolName ?? fallbackName, server: call.mcpServerName ?? fallbackServer };
};
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
/** A Botkins MCP server record in OMP's native mcp.json format. */
function ompServer(server) {
  if (server.type === "stdio") return { type: "stdio", command: server.command, ...(server.args?.length && { args: server.args }), ...(server.env && Object.keys(server.env).length && { env: server.env }), ...(server.cwd && { cwd: server.cwd }) };
  if (!server.url) return null;
  return { type: server.type === "sse" ? "sse" : "http", url: server.url, ...(server.headers && { headers: server.headers }) };
}

/**
 * A `pi --mode rpc` process: commands in, events out, one JSON object per line. Lines are split on
 * LF only, as Pi's framing says: a JSON string may hold U+2028, which a line reader splits on.
 */
export class PiRpc {
  constructor(file, args, { env, cwd, name = "Pi", protocolVersion } = {}) {
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderr = "";
    this.name = name;
    this.protocolVersion = protocolVersion;
    this.negotiated = false;
    this.chunks = new Map();
    this.child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(file) });
    this.exited = new Promise((resolve) => {
      const done = (error) => {
        if (this.closed) return;
        this.closed = true;
        const reason = error ?? new Error(this.stderr.trim().split("\n").slice(-3).join("\n") || this.name + " stopped.");
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
    if (this.closed) throw new Error(this.name + " has stopped.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  /** Sends a command and resolves its response's `data`; rejects when Pi refuses it. */
  request(command, timeoutMs = 60000) {
    const id = "bk-" + this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.name + " took too long to answer."));
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
      if (message.success === false) waiting.reject(new Error(message.error || this.name + " refused " + message.command + "."));
      else waiting.resolve(message.data);
      return;
    }
    if (message.type === "rpc_chunk") return this.receiveChunk(message);
    if (message.type === "ready" && this.protocolVersion === 2 && !this.negotiated && message.supportedProtocolVersions?.includes?.(2)) {
      this.negotiated = true;
      void this.request({ type: "negotiate_protocol", protocolVersion: 2 }, 15000).catch((error) => console.error("OMP protocol negotiation:", error.message));
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Pi event:", error.message);
      }
    }
  }
  receiveChunk(message) {
    const id = String(message.chunkId ?? "");
    const count = Number(message.count);
    const index = Number(message.index);
    const total = Number(message.byteLength);
    const data = typeof message.data === "string" ? Buffer.from(message.data, "base64") : null;
    if (!id || !Number.isSafeInteger(count) || count < 1 || count > 10000 || !Number.isSafeInteger(index) || index < 0 || index >= count || !Number.isSafeInteger(total) || total < 1 || total > 67_108_864 || !data) return;
    let chunks = this.chunks.get(id);
    if (!chunks) {
      chunks = { count, total, received: 0, parts: new Array(count) };
      this.chunks.set(id, chunks);
    }
    if (chunks.count !== count || chunks.total !== total || chunks.parts[index]) {
      this.chunks.delete(id);
      return;
    }
    chunks.parts[index] = data;
    chunks.received++;
    if (chunks.received !== count) return;
    this.chunks.delete(id);
    const joined = Buffer.concat(chunks.parts);
    if (joined.length !== total) return;
    try {
      this.receive(joined.toString("utf8"));
    } catch (error) {
      console.error("OMP chunk:", error.message);
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
  /** The plan connection and model this session's model is on, in the harness's terms. */
  target(model = this.model) {
    const connection = this.spec.inference?.providers?.find((each) => each.name === model.source) ?? this.spec.inference?.providers?.[0];
    if (!connection) throw new Error(this.provider.name + " runs ChatGPT and Claude plan models. Choose one of those for this chat.");
    return { provider: connection.name, modelId: model.model };
  }
  /** What the extension reads (extension.mjs): the connections, the MCP servers and the instructions. */
  async describe() {
    const { spec } = this;
    const servers = {};
    for (const [name, server] of Object.entries(await serversWithTokens(spec))) {
      if (name === BRIDGE) continue;
      const entry = this.provider.serverRecord(server);
      if (entry) servers[name] = entry;
    }
    if (this.bridge) {
      const entry = this.provider.serverRecord({ type: "http", url: this.bridge.url, headers: this.bridge.headers });
      // Pi defaults to 60 seconds per MCP call. A person has five minutes to answer a secure prompt.
      if (entry) servers[BRIDGE] = this.provider.runtime === PI_ID ? { ...entry, timeout: BRIDGE_CALL_TIMEOUT_S } : entry;
    }
    return {
      providers: (spec.inference?.providers ?? []).map(({ name, config }) => ({ name, config })),
      servers,
      prompt: (spec.instructions ?? "") + this.skills.instructions + (spec.context ?? "") + this.lost,
    };
  }
  start() {
    // The slash menu and a turn can both need the same process as it starts.
    this.starting ??= this.openProcess().finally(() => { this.starting = null; });
    return this.starting;
  }
  async openProcess() {
    const { provider, spec } = this;
    const tools = spec.handlers ? [...spec.tools, ...this.skills.tools] : [];
    this.bridge ??= await provider.bridge?.open(tools, spec.temporary ? {} : { key: provider.id + ":" + spec.sessionId });
    this.bridge?.set(tools);
    const known = provider.sessions.get(spec.sessionId);
    // A conversation the harness doesn't hold (new to it, or its folder moved) goes on from Botkins' transcript.
    if (spec.established && spec.hasReplies && (!known || known.folder !== spec.folder)) this.lost = transcriptContext(spec);
    const described = await this.describe();
    this.live = await provider.process(this, described);
    if (!spec.temporary && !known) provider.sessions.set(spec.sessionId, { ref: this.live.ref, folder: spec.folder });
    return this.live;
  }
  /**
   * Sends one message. There is no time limit: the person stops a turn that runs long, and Pi's
   * process ending ends the turn (PiRpc tells the turn). `timeoutMs` is for a caller with nobody
   * to stop it, such as a background summary.
   */
  async send(message, timeoutMs) {
    if (this.turn || this.sending) throw new Error("This conversation is already working.");
    this.sending = true;
    this.stopRequested = false;
    let stop = () => {};
    try {
      const live = await this.start();
      if (this.stopRequested || this.closed) return { text: "" };
      const { rpc } = live;
      const turn = (this.turn = { text: "", parts: [], thinking: null, gap: false, error: null, stopReason: null, calls: new Map() });
      const settled = new Promise((resolve, reject) => {
        const timer = timeoutMs > 0 && setTimeout(() => reject(new Error(this.provider.name + " took too long to answer.")), timeoutMs);
        const off = rpc.on((event) => {
          if (event.type === "botkins_exit") return reject(event.error);
          this.event(event);
          if (this.provider.settled(event) || (event.type === "prompt_result" && event.agentInvoked === false)) resolve(event);
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
        const answer = await rpc.request({ type: "prompt", message: text }, 30000);
        // An extension command can finish inside prompt() without starting an agent turn.
        if (answer?.disposition !== "handled") await settled;
      } catch (error) {
        this.interrupt();
        throw error;
      }
      if (this.lost) {
        // The harness has the conversation in its own session now.
        this.lost = "";
        await this.provider.write(live, await this.describe());
      }
      const reply = turn.text.trim();
      if (!reply && turn.stopReason === "error") {
        const said = errorText(turn.error) || this.provider.name + " couldn't get an answer from the model.";
        throw new Error(/out of extra usage/i.test(said) ? said + EXTRA_USAGE : said);
      }
      if (!reply && turn.stopReason === "length") throw new Error(this.provider.name + " ran out of room before it could answer.");
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
        const finalText = textOf(message.content);
        if (!turn.text && finalText) {
          turn.text = finalText;
          this.emit("assistant.message_delta", { deltaContent: finalText });
        }
        turn.stopReason = message.stopReason ?? null;
        turn.error = message.errorMessage ?? null;
        turn.thinking = null;
        const usage = message.usage;
        if (usage) {
          this.emit("assistant.usage", { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0, model: this.model.model });
          const window = this.windowOf(this.model.model);
          const used = usage.contextTokens ?? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
          if (window && used) this.emit("session.usage_info", { currentTokens: used, tokenLimit: window });
        }
        return;
      }
      case "tool_execution_start": {
        Object.assign(turn, { thinking: null, gap: true });
        const metadata = turn.calls.get(event.toolCallId) ?? toolIdentity(event);
        const { name, server } = metadata;
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
        turn.calls.delete(event.toolCallId);
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
    const { name, server } = toolIdentity(call);
    this.turn.calls?.set(call.toolCallId, { name, server });
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
    const inventory = buildInventory({ name: this.provider.name, tools: this.spec.tools, servers, native: skillChoices(this.skills.list), compact: true });
    if (this.provider.runtime !== PI_ID || !this.provider.packages.activePaths().length) return inventory;
    // Asking for the menu during a turn must never restart its process for a changed package.
    const live = this.turn ? this.live : await this.start();
    const { commands } = await live.rpc.request({ type: "get_commands" });
    const taken = new Set(inventory.choices.flatMap((item) => [item.command, ...(item.aliases ?? [])]));
    for (const cmd of commands ?? []) {
      if (!cmd.name || taken.has(cmd.name) || cmd.sourceInfo?.path?.startsWith("builtin:")) continue;
      inventory.choices.push({ name: cmd.name, command: cmd.name, aliases: [], kind: cmd.source === "skill" ? "Skill" : "Command",
        source: this.provider.name, description: String(cmd.description ?? "").split("\n")[0].slice(0, 300), duringTurn: false, native: true });
      taken.add(cmd.name);
    }
    return inventory;
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
   * @param options.dataDir  Botkins' folder for the harness: config, session files and extension data.
   * @param options.bridge   The tool bridge Botkins' tools are offered through.
   * @param options.binary   For tests: the program to run.
   * @param options.env      For tests: what the program runs with instead of this computer's environment.
   * @param options.runtime  Internal: `pi` or `omp`.
   * @param options.packages The Marketplace › Pi packages to load. Pi owns them; OMP is given Pi's, so
   *                         a package turned on in the Marketplace reaches both harnesses.
   */
  constructor({ dataDir, bridge, binary, env, runtime = PI_ID, packages } = {}) {
    super();
    const program = RUNTIMES[runtime];
    if (!program) throw new Error("Unknown Pi-compatible harness " + runtime);
    Object.assign(this, {
      runtime,
      program,
      id: program.id,
      name: program.name,
      description: program.description,
      dataDir: dataDir ?? join(tmpdir(), "botkins-" + runtime),
      bridge,
      binary,
      baseEnv: env,
    });
    this.sessions = new SessionStore(dataDir && join(this.dataDir, "sessions.json"));
    // Botkins session id → { rpc, ref, key, file, session, timer }: one process per conversation.
    this.live = new Map();
    this.packages = packages ?? new PiPackages({ dataDir: this.dataDir, install: (source, dir) => this.installPackage(source, dir) });
  }
  async installPackage(source, dir) {
    const file = await this.locate();
    if (!file) throw new Error("Install Pi on this computer in Settings › General › Harness first.");
    const env = await cliEnv({
      PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      // Older Pi versions can ask npm for a global install. Keep that prefix inside staging too.
      npm_config_prefix: join(dir, "npm"), npm_config_registry: "https://registry.npmjs.org",
    }, this.baseEnv);
    const result = await run(file, ["install", source, "--no-approve"], { cwd: dir, env, timeoutMs: 120000 });
    if (result.code !== 0) throw new Error("Pi couldn't install the package. " + (result.stderr || result.stdout).trim().slice(-600));
  }
  locate() {
    return findBinary(this.program.binary, { override: this.binary, env: this.baseEnv });
  }
  async status() {
    const file = await this.locate();
    const version = file ? versionOf((await run(file, ["--version"], { env: await cliEnv({ PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" }, this.baseEnv), timeoutMs: 15000 }).catch(() => ({ stdout: "" }))).stdout) : "";
    // The version answer distinguishes the harness from another program with the same command name.
    if (!version)
      return {
        installed: false,
        connected: false,
        signIn: null,
        signOut: false,
        message: "Install " + this.name + " on this computer to use it as the harness.",
        ...(process.platform !== "win32" ? { install: this.program.install } : { install: { url: this.program.install.url } }),
      };
    return { installed: true, version, connected: true, signIn: null, signOut: false };
  }
  async version() {
    return this.name + " " + ((await this.status()).version ?? "");
  }
  serverRecord(server) {
    return this.runtime === OMP_ID ? ompServer(server) : piServer(server);
  }
  settled(event) {
    return event.type === (this.runtime === OMP_ID ? "session_settled" : "agent_settled");
  }
  agentDir(spec) {
    return this.runtime === OMP_ID ? join(this.dataDir, "agents", hash(spec.sessionId).slice(0, 24)) : join(this.dataDir, "agent");
  }
  /** Each active package is an extension path to both harnesses (a folder whose package.json lists `pi.extensions`). */
  launchArgs(live, spec, target, wanted, packages = []) {
    const loadPackages = packages.flatMap((path) => ["-e", path]);
    if (this.runtime === OMP_ID) {
      return [
        "--mode", "rpc-ui",
        ...(spec.temporary ? ["--no-session"] : ["--session-dir", join(this.dataDir, "sessions"), ...(live.ref ? ["--resume", live.ref] : [])]),
        "--cwd", spec.folder,
        "--allow-home",
        "--model", target.provider + "/" + target.modelId,
        ...(wanted ? ["--thinking", wanted] : []),
        "--auto-approve", "--offline",
        "--no-extensions", "--no-skills", "--no-rules",
        "--config", live.config,
        "-e", this.program.extension,
        ...loadPackages,
      ];
    }
    return [
      "--mode", "rpc",
      ...(spec.temporary ? ["--no-session"] : ["--session-dir", join(this.dataDir, "sessions"), "--session-id", live.ref]),
      "--model", target.provider + "/" + target.modelId,
      ...(wanted ? ["--thinking", wanted] : []),
      // Nothing of the person's own Pi setup or of a project's .pi: Botkins supplies skills, tools and servers.
      "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "-e", "builtin:mcp", "-e", this.program.extension,
      ...loadPackages,
    ];
  }
  /** The harness process for a session, started when it has none or when its startup inputs changed. */
  async process(session, described) {
    const { spec } = session;
    const target = session.target();
    // Both harnesses take connections and package state at start; OMP also takes its isolated MCP config.
    const packages = this.packages.activePaths();
    const key = hash([spec.folder, described.providers, spec.temporary, packages, ...(this.runtime === OMP_ID ? [described.servers] : [])]);
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
    if (!file) throw new Error(this.name + " isn't installed. Install it in Settings › Harness, or choose another harness.");
    const remembered = this.sessions.get(spec.sessionId)?.ref;
    const ref = this.runtime === OMP_ID ? remembered : remembered ?? piSessionId(spec.sessionId);
    const dir = join(this.dataDir, "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const agentDir = this.agentDir(spec);
    const launchDir = this.runtime === OMP_ID ? join(this.dataDir, "launch", hash(spec.sessionId).slice(0, 24)) : spec.folder;
    if (this.runtime === OMP_ID) mkdirSync(launchDir, { recursive: true, mode: 0o700 });
    live = {
      ref,
      key,
      file: join(dir, hash(spec.sessionId).slice(0, 24) + ".json"),
      config: join(agentDir, "botkins.yml"),
      agentDir,
      session,
      timer: null,
    };
    await this.write(live, described);
    const wanted = level(session.model.reasoningEffort);
    const args = this.launchArgs(live, spec, target, wanted, packages);
    const env = await cliEnv({
      PI_CODING_AGENT_DIR: live.agentDir,
      ...(this.runtime === OMP_ID && {
        // Keep inherited named profiles and overlays from redirecting an embedded Botkins run
        // to the person's interactive OMP setup. PI_CONFIG_DIR is relative to the home folder.
        PI_CONFIG_DIR: relative(homedir(), join(live.agentDir, "config-root")),
        OMP_PROFILE: undefined,
        PI_PROFILE: undefined,
        PI_CONFIG_FILES: undefined,
      }),
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
      [this.program.sessionEnv]: live.file,
    }, this.baseEnv);
    live.rpc = new PiRpc(file, args, { env, cwd: launchDir, name: this.name, ...(this.runtime === OMP_ID && { protocolVersion: 2 }) });
    live.rpc.on((event) => {
      if (event.type === "extension_ui_request") void this.dialog(live, event);
    });
    live.rpc.exited.then(() => {
      if (this.live.get(spec.sessionId) === live) this.live.delete(spec.sessionId);
      rmSync(live.file, { force: true });
    });
    this.live.set(spec.sessionId, live);
    // The fewest at once: the conversation used longest ago lets go of its harness.
    if (this.live.size > MAX_LIVE) {
      const idle = [...this.live.entries()].find(([, other]) => other !== live && !other.session?.turn);
      if (idle) this.release(idle[0]);
    }
    // A process that cannot start says why on its error output.
    let state;
    try {
      state = await live.rpc.request({ type: "get_state" }, 60000);
      if (this.runtime === OMP_ID && state?.sessionId) live.ref = state.sessionId;
    } catch (error) {
      this.live.delete(spec.sessionId);
      await live.rpc.close().catch(() => {});
      throw new Error(this.name + " couldn't start. " + String(live.rpc.stderr.trim().split("\n").slice(-2).join(" ") || error.message).slice(0, 400));
    }
    return live;
  }
  /** Writes the files the extension and OMP read, each containing session secrets and user-only. */
  async write(live, described) {
    mkdirSync(live.agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(live.file, JSON.stringify(described), { mode: 0o600 });
    if (this.runtime === OMP_ID) {
      writeFileSync(join(live.agentDir, "mcp.json"), JSON.stringify({ mcpServers: described.servers }), { mode: 0o600 });
      writeFileSync(live.config, "mcp:\n  enableProjectConfig: false\nenabledProviders: []\n", { mode: 0o600 });
    }
  }
  /** The extension dialogs. Only Botkins' approval question is answered; any other is cancelled. */
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
