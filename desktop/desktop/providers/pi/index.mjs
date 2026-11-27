// Pi (pi.dev, the `pi` command, MIT) as a harness: Settings › Harness › Pi.
//
// Pi is a coding agent: the loop, the tools (read, bash, edit, write, grep, find, ls) and the
// session files. It isn't a model provider here. A chat on a GitHub Copilot, ChatGPT, Claude,
// OpenCode or key provider's model runs in Pi, and that provider answers Pi's model requests
// through Botkins' gateway (desktop/harness), the same connection the Copilot runtime uses. Pi
// keeps no sign-in of its own for this.
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
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelProvider, ProviderSession, usageData } from "../provider.mjs";
import { cliEnv, findBinary, run, versionOf } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { SessionStore, resumeOrRecover, serversWithTokens, uuidFor } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";
import { describeToolCall } from "./permissions.mjs";
import { permissionName } from "../permission-request.mjs";
import { INVENTORY } from "./extension-shared.mjs";
import { PLAN_INSTRUCTIONS, planFromOmpPhases, planSignature, planToOmpPhases, toTodoResult, updatePlanTool } from "./plan.mjs";

export const PI_ID = "pi";
export const OMP_ID = "omp";
/** The bridge's name among a session's MCP servers. Its tools never ask. */
export const BRIDGE = "botkins";
/** How the extension asks for an approval (extension.mjs). */
export const ASK = "botkins:permission";
const PROVIDER_DIR = dirname(fileURLToPath(import.meta.url));
export const EXTENSION = join(PROVIDER_DIR, "extension.mjs");
const RUN_BUNDLED = join(PROVIDER_DIR, "run-bundled.mjs");
export const OMP_EXTENSION = join(PROVIDER_DIR, "..", "omp", "extension.mjs");
export const INSTALL = { url: "https://pi.dev", command: "curl -fsSL https://pi.dev/install.sh | sh" };
export const OMP_INSTALL = { url: "https://omp.sh", command: "curl -fsSL https://omp.sh/install | sh" };
const RUNTIMES = {
  [PI_ID]: {
    id: PI_ID,
    name: "Pi",
    binary: "pi",
    description: "The Pi coding agent, as the harness for GitHub Copilot, ChatGPT, Claude and OpenCode models.",
    install: INSTALL,
    extension: EXTENSION,
    sessionEnv: "BOTKINS_PI_SESSION",
  },
  [OMP_ID]: {
    id: OMP_ID,
    name: "OMP",
    binary: "omp",
    description: "OMP, the enhanced Pi coding agent, as the harness for GitHub Copilot, ChatGPT, Claude and OpenCode models.",
    install: OMP_INSTALL,
    extension: OMP_EXTENSION,
    sessionEnv: "BOTKINS_OMP_SESSION",
  },
};
/**
 * The Pi that ships with Botkins (the @earendil-works/pi-coding-agent dependency): its command
 * line script, or null where it isn't installed. It runs on this program's own Node.js, the
 * app's Electron or the terminal host's Node.js 24, so nothing else needs installing.
 */
export function bundledPi() {
  try {
    const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = join(dirname(main), "bundle", "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}
/**
 * How to start a Pi program: a script (the bundled Pi) runs on this program's own Node.js, as
 * Node even inside Electron; anything else runs as it is.
 */
export function launcher(file, args) {
  if (!/\.[cm]?js$/.test(file)) return { file, args, env: {} };
  return { file: process.execPath, args: [RUN_BUNDLED, file, ...args], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}
/** Pi's thinking levels. Botkins' efforts are the same words. */
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const level = (effort) => (effort === "none" ? "off" : LEVELS.has(effort) ? effort : null);
/** A conversation lets go of its Pi after this long unused; the next turn starts it again on the same session. */
const IDLE_MS = 15 * 60 * 1000;
/** How long Pi lets one call to Botkins' tool server take. A call can wait for the person (a secure prompt), so it is longer than Pi's 60 seconds. */
const BRIDGE_CALL_TIMEOUT_S = 10 * 60;
/**
 * How long OMP waits for initial MCP discovery before answering `get_state`. Local Botkins bridge
 * discovery finishes in milliseconds, so this keeps cold and prewarmed sessions populated while
 * keeping unreachable external servers bounded.
 */
const OMP_MCP_STARTUP_TIMEOUT_MS = 2000;
/**
 * OMP's isolated config overlay (`botkins.yml`).
 * - `mcp.enableProjectConfig: false`: never pull a repo's `.omp/mcp.json` into Botkins.
 * - `mcp.shared: false`: keep each session's ToolBridge token and MCP catalog out of OMP's shared daemon.
 * - `tools.commands: false`: expose Botkins and MCP tools directly as typed model tool schemas
 *   rather than hiding them behind OMP's bash command wrapper.
 * - `todo.enabled: false` and `todo.reminders: false`: Botkins owns the chat plan (via `update_plan`
 *   and `set_todos` sync) and continuation decisions (`keep-moving.mjs`), so disable OMP's competing
 *   schema-less `todo` tool and internal reminder loop.
 */
const OMP_CONFIG = [
  "mcp:",
  "  enableProjectConfig: false",
  "  shared: false",
  "  startupTimeoutMs: " + OMP_MCP_STARTUP_TIMEOUT_MS,
  "enabledProviders: []",
  "tools:",
  "  commands: false",
  "todo:",
  "  enabled: false",
  "  reminders: false",
  "",
].join("\n");
const MAX_LIVE = 8;
/** Pi's session ids: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. */
const piSessionId = (id) => (/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(id) ? id : uuidFor(id));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const INVENTORY_WAIT_MS = 1500;
const INVENTORY_STEP_MS = 100;
const PI_MCP_PROBE_MS = 700;
const OMP_MCP_PROBE_MS = 1200;
const OMP_PROBE_TTL_MS = 5000;
/** [tool, MCP server or undefined] for a Pi or OMP MCP tool name. */
function splitName(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(name ?? "")) ?? /^mcp__([^_]+)_(.+)$/.exec(String(name ?? ""));
  return match ? [match[2], match[1]] : [String(name ?? "tool"), undefined];
}
/** Resolves an MCP tool's [remoteTool, server] even when an OMP server name contains underscores. */
function splitMcpTool(name, knownServers = []) {
  const raw = String(name ?? "");
  const double = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (double) return [double[2], double[1]];
  if (raw.startsWith("mcp__") && knownServers.length) {
    const sorted = [...knownServers].sort((a, b) => b.length - a.length);
    for (const server of sorted) {
      const prefix = "mcp__" + server + "_";
      if (raw.startsWith(prefix) && raw.length > prefix.length) return [raw.slice(prefix.length), server];
    }
  }
  return splitName(raw);
}
const toolIdentity = (call) => {
  const [fallbackName, fallbackServer] = splitName(call.toolName);
  return { name: call.mcpToolName ?? fallbackName, server: call.mcpServerName ?? fallbackServer };
};
function normalizeMcpState(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/needs?\s+sign[- ]in|\b401\b|unauthorized|oauth|www-authenticate/.test(text)) return "needs-auth";
  if (text.startsWith("connected")) return "connected";
  if (text.startsWith("connecting") || text.startsWith("starting") || text.startsWith("pending")) return "pending";
  if (text.startsWith("disconnected")) return "disconnected";
  if (text.startsWith("disabled")) return "disabled";
  if (text.startsWith("failed") || text.startsWith("error")) return "failed";
  return null;
}
/** Parses Pi's `builtin:mcp` notifications (startup problem notices and `/mcp` status lines). */
export function parsePiMcpNotify(message) {
  const text = String(message ?? "").trim();
  if (!text) return null;
  const states = new Map();
  let settled = false;
  if (/^No MCP servers configured\b/i.test(text)) return { states, settled: true };
  if (/^MCP servers need attention:/i.test(text)) {
    settled = true;
    for (const line of text.split("\n").slice(1)) {
      const match = /^\s+([^\s:]+):\s+(.+)$/.exec(line);
      if (!match) continue;
      const status = normalizeMcpState(match[2]);
      if (status) states.set(match[1], status);
    }
    return { states, settled };
  }
  for (const line of text.split("\n")) {
    const match = /^([^\s:]+):\s+(connected|connecting|starting|needs sign-in|failed|disconnected|disabled)\b(.*)$/i.exec(line);
    if (!match) continue;
    const status = normalizeMcpState(match[2] + match[3]);
    if (status) states.set(match[1], status);
  }
  return states.size ? { states, settled: true } : null;
}
/** Parses OMP's `/mcp test <name>` command_output text. */
export function parseOmpMcpOutput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const ok = /^Server\s+"([^"]+)"\s+connected\b/i.exec(raw);
  if (ok) return { name: ok[1], status: "connected" };
  const fail = /^Connection to\s+"([^"]+)"\s+failed:\s*([\s\S]*)$/i.exec(raw);
  if (fail) {
    const reason = fail[2] ?? "";
    const status = /\b401\b|unauthorized|oauth|sign[- ]in|www-authenticate/i.test(reason) ? "needs-auth" : "failed";
    return { name: fail[1], status };
  }
  const missing = /^Server\s+"([^"]+)"\s+not found\b/i.exec(raw);
  if (missing) return { name: missing[1], status: "unavailable" };
  return null;
}
function createRuntimeState() {
  return {
    startedAt: Date.now(),
    tools: null,
    servers: null,
    mcpStates: new Map(),
    mcpSettled: false,
    mcpProbeInFlight: null,
    toolCommands: new Set(),
    availableCommands: null,
    probed: new Map(),
  };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    // Decode as the bytes arrive: a character split across two reads must not become U+FFFD.
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
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
      const timer = timeoutMs > 0 && setTimeout(() => {
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
  get interruptsForSteering() { return this.provider.runtime === PI_ID; }
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
    this.plan = undefined;
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
    if (!connection) throw new Error(this.provider.name + " can't run this model: its provider has no connection here. Choose another model for this chat.");
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
      prompt: (spec.instructions ?? "") + (this.bridge && this.planTools().length ? "\n\n" + PLAN_INSTRUCTIONS + "\n\n" : "") + this.skills.instructions + (spec.context ?? ""),
    };
  }
  /** In-chat progress checklist tool for Pi and OMP; omitted in throwaway or sources-only sessions. */
  planTools() {
    return !this.spec.temporary && !this.spec.sourcesOnly ? [updatePlanTool(this)] : [];
  }
  /** The plan currently known for this conversation, from this turn, a warm process, or the persisted session record. */
  storedPlan() {
    if (this.plan !== undefined) return this.plan;
    if (this.spec.temporary) return null;
    const live = this.provider.live.get(this.spec.sessionId);
    if (live && live.folder === this.spec.folder && live.plan !== undefined) return live.plan;
    return this.provider.storedPlan(this.spec.sessionId, this.spec.folder);
  }
  /** Records a normalized `{ rows, dependencies }` plan, persists it, optionally mirrors to OMP `set_todos`, and emits `session.todos_changed`. */
  async setPlan(plan, { syncNative = false, emit = true } = {}) {
    const normalized = toTodoResult(plan);
    this.plan = normalized;
    if (this.live) this.live.plan = normalized;
    if (!this.spec.temporary) this.provider.savePlan(this.spec.sessionId, this.spec.folder, normalized);
    if (syncNative && this.provider.runtime === OMP_ID && this.live && !this.live.rpc.closed) {
      await this.live.rpc.request({ type: "set_todos", phases: planToOmpPhases(normalized) }, 15000).catch(() => {});
    }
    if (emit) this.emit("session.todos_changed", {});
  }
  /** Reconciles OMP's native `todoPhases` into Botkins' plan without ever inventing dependency edges. */
  syncFromOmpPhases(phases, { emit = true, allowEmpty = false } = {}) {
    const current = this.storedPlan();
    const next = planFromOmpPhases(phases, current, { allowEmpty });
    if (!next || planSignature(next) === planSignature(current)) return false;
    this.plan = next;
    if (this.live) this.live.plan = next;
    if (!this.spec.temporary) this.provider.savePlan(this.spec.sessionId, this.spec.folder, next);
    if (emit) this.emit("session.todos_changed", {});
    return true;
  }
  async syncOmpTodos(rpc, { emit = true } = {}) {
    if (this.provider.runtime !== OMP_ID || !rpc || rpc.closed) return;
    const state = await rpc.request({ type: "get_state" }, 15000).catch(() => null);
    if (Array.isArray(state?.todoPhases)) {
      this.syncFromOmpPhases(state.todoPhases, { emit, allowEmpty: !!this.storedPlan() });
    }
  }
  /** Starts this conversation's process when its chat opens, so its first message doesn't wait for it (Workspace.prewarm). */
  async warm() {
    await this.start();
  }
  start() {
    // The slash menu and a turn can both need the same process as it starts.
    this.starting ??= this.openProcess().finally(() => { this.starting = null; });
    return this.starting;
  }
  async openProcess() {
    const { provider, spec } = this;
    // Every tool is declared, also when the chat is only warmed (no turn, no handlers): Pi lists the
    // bridge's tools once, when it connects, and keeps that list for as long as the process runs.
    // A warmed process started with none would leave the conversation without Botkins' tools until
    // Pi restarts. Each tool checks for its turn itself and refuses to run without one.
    const tools = [...spec.tools, ...this.skills.tools, ...this.planTools()];
    const bridgeShape = provider.runtime === OMP_ID
      ? hash(tools.map(({ name, description, parameters }) => ({ name, description: description ?? "", parameters: parameters ?? null })))
      : null;
    this.bridgeShape = bridgeShape;
    const bridgeKey = spec.temporary ? undefined : provider.bridgeKey(spec.sessionId, bridgeShape);
    this.bridge ??= await provider.bridge?.open(tools, bridgeKey ? { key: bridgeKey } : {});
    this.bridge?.set(tools);
    const known = provider.sessions.get(spec.sessionId);
    const folderChanged = !!(known && known.folder !== spec.folder);
    const described = await this.describe();
    const { value: live, recovered, lost } = await resumeOrRecover({
      spec,
      hasRef: !!(known && !folderChanged),
      resume: () => provider.process(this, described, { ref: known.ref }),
      onMissing: () => {
        if (!spec.temporary) {
          provider.sessions.delete(spec.sessionId);
          provider.clearPlan(spec.sessionId);
        }
      },
      create: () => provider.process(this, described, { fresh: true }),
    });
    this.live = live;
    if (recovered) {
      this.plan = null;
      live.plan = null;
      if (folderChanged && !spec.temporary) provider.clearPlan(spec.sessionId);
    } else {
      const carried = this.storedPlan();
      if (carried !== null) {
        this.plan = carried;
        live.plan = carried;
      }
      if (provider.runtime === OMP_ID) {
        const phases = live.state?.todoPhases;
        if (Array.isArray(phases) && phases.some((phase) => Array.isArray(phase?.tasks) && phase.tasks.length)) {
          this.syncFromOmpPhases(phases, { emit: true });
        } else if (live.plan?.rows?.length && !live.rpc.closed) {
          await live.rpc.request({ type: "set_todos", phases: planToOmpPhases(live.plan) }, 15000).catch(() => {});
        }
      }
    }
    // Only inject transcript context when the workspace believed this harness already held the session
    // (or when resuming a stale ref failed). A brand-new session on a fresh chat needs no transcript.
    if (recovered && lost && (spec.established || known)) this.lost = lost;
    if (!spec.temporary && (!known || recovered || known.ref !== this.live.ref || known.folder !== spec.folder)) {
      const preservedPlan = !recovered && !folderChanged ? (live.plan ?? known?.plan) : undefined;
      provider.sessions.set(spec.sessionId, { ref: this.live.ref, folder: spec.folder, ...(preservedPlan !== undefined && preservedPlan !== null && { plan: preservedPlan }) });
    }
    return this.live;
  }
  /**
   * Sends one message. There is no time limit: the person stops a turn that runs long, and Pi's
   * process ending ends the turn (PiRpc tells the turn). `timeoutMs` is for a caller with nobody
   * to stop it, such as a background summary. `onReady(deliver)` is called once the harness is
   * working on it. Pi interrupts the old operation and admits the new instruction on the same
   * session. OMP uses its native steering queue.
   */
  async send(message, timeoutMs, onReady) {
    if (this.turn || this.sending) throw new Error("This conversation is already working.");
    this.sending = true;
    this.stopRequested = false;
    let stop = () => {};
    try {
      const live = await this.start();
      if (this.stopRequested || this.closed) return { text: "" };
      const { rpc } = live;
      // `users`: the person's messages the harness took into the run (the prompt, then each steer it
      // delivered); `steered`: the steers it accepted.
      const turn = (this.turn = { text: "", parts: [], thinking: null, gap: false, error: null, stopReason: null, calls: new Map(), rows: new Map(), users: 0, steered: 0, ended: false });
      // One listener for the whole turn; a run started again for a late steer waits on a new settle.
      let settle = () => {};
      let fail = () => {};
      const nextSettle = () => {
        const next = Promise.withResolvers();
        settle = next.resolve;
        fail = next.reject;
        // A process can exit while the prompt acknowledgement is still outstanding.
        next.promise.catch(() => {});
        return next.promise;
      };
      let settled = nextSettle();
      const timer = timeoutMs > 0 && setTimeout(() => fail(new Error(this.provider.name + " took too long to answer.")), timeoutMs);
      const off = rpc.on((event) => {
        if (event.type === "botkins_exit") return fail(event.error);
        if (turn.buffer) turn.buffer.push(event);
        else this.event(event);
        if (this.provider.settled(event) || (event.type === "prompt_result" && event.agentInvoked === false)) settle(event);
      });
      stop = () => {
        clearTimeout(timer);
        off();
      };
      const withFiles = (prompt, attachments) => {
        const files = (attachments ?? []).map((a) => "- " + a.path).join("\n");
        return prompt + (files ? "\n\nAttached:\n" + files : "");
      };
      // A conversation the harness doesn't hold goes on from Botkins' transcript, told once in the
      // first message (never in the system prompt, which stays the same on every turn).
      const text =
        (this.lost ? this.lost + "\n\n" : "") +
        (this.mode === "plan" ? "Plan mode: do not change any file. Work out a plan, show it, and ask before carrying it out.\n\n" : "") +
        withFiles(message.prompt, message.attachments);
      this.emit("user.message", {});
      const deliver = async ({ prompt, attachments }) => {
        if (this.turn !== turn || turn.ended || this.stopRequested || this.closed) return false;
        await rpc.request({ type: "steer", message: withFiles(prompt, attachments) }, 30000);
        turn.steered++;
        return true;
      };
      try {
        const answer = await rpc.request({ type: "prompt", message: text }, 30000);
        // `before_agent_start` has now registered any pending server config updates on warm Pi.
        if (live.pendingConfigs) {
          live.registeredConfigs ??= new Map();
          for (const [name, serialized] of live.pendingConfigs) live.registeredConfigs.set(name, serialized);
        }
        // An extension or built-in slash command (e.g. OMP `/todo`) can finish inside prompt() without starting an agent turn.
        const handled = answer?.disposition === "handled" || answer?.agentInvoked === false;
        if (!handled && this.interruptsForSteering && onReady) {
          await this.runSteerablePi(rpc, turn, settled, nextSettle, withFiles, onReady);
        } else if (!handled) {
          onReady?.(deliver);
          await settled;
          // A steer the harness took as the run was ending, but never delivered, goes as one more
          // prompt in the same turn, so nothing the person wrote is dropped.
          while (!this.stopRequested && !this.closed && turn.steered > Math.max(0, turn.users - 1)) {
            const left = await rpc.request({ type: "clear_queue" }, 15000).catch(() => null);
            const pending = [...(left?.steering ?? []), ...(left?.followUp ?? [])].filter((each) => typeof each === "string" && each);
            turn.users = turn.steered + 1;
            if (!pending.length) break;
            settled = nextSettle();
            const again = await rpc.request({ type: "prompt", message: pending.join("\n\n") }, 30000);
            if (again?.disposition !== "handled" && again?.agentInvoked !== false) await settled;
          }
        }
        if (this.provider.runtime === OMP_ID && (handled || turn.ompCommandOutput)) {
          await this.syncOmpTodos(rpc, { emit: true });
        }
        turn.ended = true;
      } catch (error) {
        turn.ended = true;
        this.interrupt();
        throw error;
      }
      // The harness has the conversation in its own session now.
      this.lost = "";
      const reply = turn.text.trim();
      if (!reply && turn.stopReason === "error") {
        const said = errorText(turn.error) || this.provider.name + " couldn't get an answer from the model.";
        throw new Error(/out of extra usage/i.test(said) ? said + EXTRA_USAGE : said);
      }
      if (!reply && turn.stopReason === "length") throw new Error(this.provider.name + " ran out of room before it could answer.");
      return { text: reply };
    } finally {
      // A call that never ran (stopped, or the process went away) must not stay Running.
      if (this.turn) this.stopRows(this.turn);
      stop();
      this.turn = null;
      this.sending = false;
      this.provider.touch(this.spec.sessionId);
    }
  }
  /** The caller serializes user submissions. Keep the turn open across the old settle, the
   * abort acknowledgement (Pi is now idle), and the replacement's own settle. */
  async runSteerablePi(rpc, turn, settled, nextSettle, withFiles, onReady) {
    const pending = [];
    let aborting = null;
    let running = true;
    let current;
    const active = () => this.turn === turn && !turn.ended && !this.stopRequested && !this.closed;
    const interruptForInput = () => {
      if (!running || aborting || !pending.length || !active()) return;
      // A refused abort leaves the original operation running. Preserve the input for the
      // workspace's ordinary queue. A dead RPC also rejects the outstanding settle.
      turn.redirected = true;
      aborting = rpc.request({ type: "abort" }, 0).catch(error => {
        for (const item of pending.splice(0)) item.ack.reject(error);
        aborting = null;
      });
      this.spec.handlers?.cancelForSteer?.();
    };
    if (!active()) this.interrupt();
    onReady(({ prompt, attachments }) => {
      if (!active()) return false;
      const ack = Promise.withResolvers();
      pending.push({ text: withFiles(prompt, attachments), ack });
      interruptForInput();
      return ack.promise;
    });
    try {
      for (;;) {
        await settled;
        if (aborting) await aborting;
        if (!active() || !pending.length) break;
        current = pending.shift();
        aborting = null;
        running = false;
        settled = nextSettle();
        // A fast Pi can send the new prompt acknowledgement and reply in a single stdout
        // chunk. Let the workspace commit the user's message before surfacing those deltas.
        turn.buffer = [];
        const answer = await rpc.request({ type: "prompt", message: current.text }, 0);
        current.ack.resolve(true);
        current = null;
        await Promise.resolve();
        this.stopRows(turn);
        Object.assign(turn, { text: "", gap: false, thinking: null, error: null, stopReason: null });
        const early = turn.buffer;
        delete turn.buffer;
        for (const event of early) this.event(event);
        running = answer?.disposition !== "handled";
        if (!running) settled = Promise.resolve();
        else if (!active()) this.interrupt();
        else interruptForInput();
      }
    } catch (error) {
      // The interrupted prompt may already have changed files. Workspace recovery must never
      // replay it just because the process was lost while admitting the new instruction.
      if (turn.redirected && error?.code === "BOTKINS_PROVIDER_EXIT") throw new Error("Pi stopped during redirection.", { cause: error });
      throw error;
    } finally {
      turn.ended = true;
      current?.ack.resolve(false);
      for (const item of pending) item.ack.resolve(false);
    }
  }
  /** One of Pi's events, as Botkins' (desktop/providers/provider.mjs). */
  event(event) {
    // Pi compacted the conversation (by itself, near the end of the window): the workspace begins
    // the session's next turn from its current prompt (desktop/session-prompts.mjs).
    if (event.type === "compaction_end") this.emit("session.compaction_complete", {});
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
        } else if (update.type === "toolcall_start" && update.id) {
          // The row appears while the model is still writing the call's arguments.
          this.toolRow(turn, update.id, { toolName: update.toolName });
        } else if (update.type === "toolcall_end" && update.toolCall?.id) {
          // The arguments are complete: the row's label can say what it will do.
          const call = update.toolCall;
          this.toolRow(turn, call.id, { toolName: call.name ?? call.toolName }, call.arguments);
        }
        return;
      }
      case "turn_end":
      case "agent_end":
        this.stopRows(turn);
        return;
      case "message_end": {
        const message = event.message ?? {};
        if (message.role === "user") turn.users++;
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
          // pi-ai's `input` is the uncached input for every API it speaks (it takes the cached part out of OpenAI's).
          this.emit("assistant.usage", usageData({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, model: this.model.model }));
          const window = this.windowOf(this.model.model);
          const used = usage.contextTokens ?? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
          if (window && used) this.emit("session.usage_info", { currentTokens: used, tokenLimit: window });
        }
        return;
      }
      case "tool_execution_start": {
        this.toolRow(turn, event.toolCallId, event, event.args);
        return;
      }
      case "command_output": {
        if (this.provider.runtime === OMP_ID) turn.ompCommandOutput = true;
        return;
      }
      case "tool_execution_end": {
        turn.calls.delete(event.toolCallId);
        turn.rows.delete(event.toolCallId);
        if (this.provider.runtime === OMP_ID && !event.isError && event.toolName === "todo") {
          const details = event.result?.details;
          if (details && details.op !== "view" && Array.isArray(details.phases)) {
            this.syncFromOmpPhases(details.phases, { emit: true, allowEmpty: true });
          }
        }
        const output = textOf(event.result?.content) || (event.result?.details ? displayValue(event.result.details, 12000) : "");
        const success = !event.isError;
        this.emit("tool.execution_complete", { toolCallId: event.toolCallId, success, ...(output && { result: { content: output } }), ...(!success && { error: { message: output || "Failed" } }) });
        return;
      }
    }
  }
  /**
   * The step for one tool call, shown from Pi's `toolcall_start` and kept as the same step through
   * `tool_execution_start`: the first call emits `tool.execution_start`, and a later one repeats it
   * only when the arguments are new, which the activity record uses to improve the label.
   */
  toolRow(turn, id, call, args) {
    Object.assign(turn, { thinking: null, gap: true });
    const row = turn.rows.get(id);
    const given = args && typeof args === "object" && Object.keys(args).length ? args : null;
    const key = given ? JSON.stringify(given) : "";
    // What the permission question learned (an MCP tool's server and name) beats what the name alone says.
    const { name, server } = turn.calls.get(id) ?? toolIdentity(call);
    if (row && (!given || row.args === key) && row.name === name && row.server === server) return;
    turn.rows.set(id, { name, server, args: key || row?.args || "" });
    this.emit("tool.execution_start", {
      toolCallId: id,
      toolName: name,
      arguments: given ?? {},
      ...(server && server !== BRIDGE && { mcpServerName: server, mcpToolName: name }),
    });
  }
  /** Ends every step that began but never finished: its call was stopped before it could run. */
  stopRows(turn) {
    for (const id of turn.rows.keys()) this.emit("tool.execution_complete", { toolCallId: id, success: false, stopped: true, error: { message: "Stopped" } });
    turn.rows.clear();
    turn.calls.clear();
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
    const turn = this.turn;
    const active = () => turn && this.turn === turn && !turn.ended && !this.stopRequested && !this.closed;
    if (!handlers?.permission || !active() || !permissionName(call?.toolName)) return false;
    const { name, server } = toolIdentity(call);
    if (!permissionName(name) || (server !== undefined && !permissionName(server))) return false;
    turn.calls?.set(call.toolCallId, { name, server });
    if (server === BRIDGE)
      return !!this.bridge && call.registryServer === BRIDGE && !call.managed && !call.sandboxEscape;
    // Pi keeps every server Botkins gave it registered, so its tool list stays the same; one this
    // turn doesn't have (the person writing may not use it) does nothing. (A Pi package's own server isn't Botkins'.)
    if (server && this.live?.given?.has(server) && !Object.hasOwn(this.spec.mcpServers ?? {}, server)) return false;
    try {
      const answer = await handlers.permission(describeToolCall(call, {
        name, server, configured: !!server && Object.hasOwn(this.spec.mcpServers ?? {}, server),
      }));
      return !!answer?.allow && !!active();
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
  /** The plan kept on this session (rows + explicit dependencies), or null when none exists. */
  async todos() {
    const plan = this.storedPlan();
    return plan ? toTodoResult(plan) : null;
  }
  async compact() {
    const live = await this.start();
    await live.rpc.request({ type: "compact" }, 600000);
  }
  /** Maps a Botkins server name to its harness name when a plugin alias is active (PR #321 compatibility). */
  harnessServerName(name) {
    for (const [alias, real] of this.aliases ?? []) if (real === name) return alias;
    return name;
  }
  /** Maps a harness server name (including a plugin alias) back to Botkins' own server name. */
  realServerName(name) {
    return (name && this.aliases?.get(name)) ?? name;
  }
  /** Classifies live runtime tools into Botkins bridge tools and per-server MCP tools with direct/indirect exposure. */
  classifyTools(live, state, allowedServers) {
    const rt = live?.runtime;
    const isOmp = this.provider.runtime === OMP_ID;
    const knownServers = [BRIDGE, ...allowedServers, ...(this.aliases?.keys() ?? [])];
    const directDump = isOmp && Array.isArray(state?.dumpTools) ? new Map(state.dumpTools.filter((t) => t?.name).map((t) => [String(t.name), t])) : null;
    const byServer = new Map();
    const record = (server, tool) => {
      let map = byServer.get(server);
      if (!map) byServer.set(server, (map = new Map()));
      const prev = map.get(tool.name);
      // Direct exposure wins over indirect if seen through multiple channels.
      if (!prev || (prev.exposure === "indirect" && tool.exposure === "direct")) map.set(tool.name, tool);
    };
    for (const tool of rt?.tools ?? []) {
      if (!tool?.name) continue;
      const [fallbackName, fallbackServer] = splitMcpTool(tool.name, knownServers);
      const server = this.realServerName(tool.mcpServerName ?? fallbackServer);
      if (!server || (server !== BRIDGE && !allowedServers.includes(server))) continue;
      const name = tool.mcpToolName ?? fallbackName;
      if (!name) continue;
      let exposure = null;
      if (isOmp) {
        if (directDump) {
          if (directDump.has(tool.name)) exposure = "direct";
          else if (tool.active !== false || rt.toolCommands.has(tool.name)) exposure = "indirect";
        } else if (rt.toolCommands.has(tool.name)) {
          exposure = "indirect";
        } else if (tool.active !== false) {
          exposure = "direct";
        }
      } else {
        if (tool.exposure === "hidden" || tool.active === false) continue;
        exposure = tool.exposure && tool.exposure !== "direct" ? "indirect" : "direct";
      }
      if (!exposure) continue;
      record(server, { name, description: String(tool.description ?? ""), exposure });
    }
    if (directDump) {
      for (const [fullName, tool] of directDump) {
        const [name, rawServer] = splitMcpTool(fullName, knownServers);
        const server = this.realServerName(rawServer);
        if (!server || (server !== BRIDGE && !allowedServers.includes(server))) continue;
        record(server, { name, description: String(tool.description ?? ""), exposure: "direct" });
      }
    }
    if (isOmp) {
      for (const fullName of rt?.toolCommands ?? []) {
        const [name, rawServer] = splitMcpTool(fullName, knownServers);
        const server = this.realServerName(rawServer);
        if (!server || (server !== BRIDGE && !allowedServers.includes(server))) continue;
        const exposure = directDump?.has(fullName) ? "direct" : "indirect";
        record(server, { name, description: "", exposure });
      }
    }
    return byServer;
  }
  async probePiMcp(live) {
    const rt = live.runtime;
    if (rt.mcpProbeInFlight) return rt.mcpProbeInFlight;
    const before = rt.mcpStates.size;
    const probe = (async () => {
      try {
        await Promise.race([
          live.rpc.request({ type: "prompt", message: "/mcp" }, PI_MCP_PROBE_MS).catch(() => null),
          delay(PI_MCP_PROBE_MS),
        ]);
        // Give the trailing notify event a tick to arrive after the response.
        if (rt.mcpStates.size === before) await delay(30);
      } finally {
        rt.mcpProbeInFlight = null;
      }
    })();
    rt.mcpProbeInFlight = probe;
    return probe;
  }
  async probeOmpMcp(live, name) {
    if (!name || /\s/.test(name)) return;
    const rt = live.runtime;
    const last = rt.probed.get(name) ?? 0;
    if (Date.now() - last < OMP_PROBE_TTL_MS) return;
    rt.probed.set(name, Date.now());
    let settled = false;
    const waiter = Promise.withResolvers();
    const off = live.rpc.on((event) => {
      if (event.type !== "command_output") return;
      const parsed = parseOmpMcpOutput(event.text);
      if (parsed?.name === name) {
        settled = true;
        waiter.resolve(parsed.status);
      }
    });
    try {
      const req = live.rpc.request({ type: "prompt", message: "/mcp test " + name }, OMP_MCP_PROBE_MS).catch(() => null);
      await Promise.race([waiter.promise, req.then(() => delay(30)), delay(OMP_MCP_PROBE_MS)]);
      if (!settled && !rt.mcpStates.has(name)) rt.mcpStates.set(name, "pending");
    } finally {
      off();
    }
  }
  async inventory() {
    const isOmp = this.provider.runtime === OMP_ID;
    // Asking for the menu during a turn must never restart its process.
    const activeTurn = !!this.turn;
    const live = activeTurn ? this.live : await this.start();
    const configured = Object.entries(this.spec.mcpServers ?? {}).filter(([name]) => name !== BRIDGE);
    const configuredNames = configured.map(([name]) => name);
    const supportedNames = [];
    const unsupported = new Set();
    const describedServers = new Map();
    for (const [name, cfg] of configured) {
      const entry = this.provider.serverRecord(cfg);
      if (!entry) unsupported.add(name);
      else {
        supportedNames.push(name);
        describedServers.set(name, JSON.stringify(entry));
      }
    }
    const harnessName = (name) => this.harnessServerName(name);
    const recordedState = (name) => {
      const h = harnessName(name);
      return live?.runtime?.mcpStates.get(h) ?? live?.runtime?.mcpStates.get(name);
    };
    const clearPendingState = (name) => {
      const h = harnessName(name);
      if (live?.runtime?.mcpStates.get(h) === "pending") live.runtime.mcpStates.delete(h);
      if (live?.runtime?.mcpStates.get(name) === "pending") live.runtime.mcpStates.delete(name);
    };
    const staleConfig = (name) => {
      if (!live?.registeredConfigs) return false;
      const current = describedServers.get(name);
      const h = harnessName(name);
      const registered = live.registeredConfigs.get(h) ?? live.registeredConfigs.get(name);
      return registered !== undefined && current !== undefined && registered !== current;
    };
    const unregisteredOnWarmPi = (name) => {
      if (isOmp || !live) return false;
      const h = harnessName(name);
      if (Array.isArray(live.runtime?.servers)) return !live.runtime.servers.some((s) => s.name === h || s.name === name);
      if (live.registeredConfigs) return !live.registeredConfigs.has(h) && !live.registeredConfigs.has(name);
      return false;
    };
    let state = live ? await live.rpc.request({ type: "get_state" }, activeTurn ? 1500 : 10000).catch(() => null) : null;
    const rawCommands = !live
      ? null
      : isOmp
        ? (await live.rpc.request({ type: "get_available_commands" }, activeTurn ? 1500 : 5000).catch(() => null))?.commands ?? live.runtime?.availableCommands ?? null
        : (await live.rpc.request({ type: "get_commands" }, activeTurn ? 1500 : 5000).catch(() => null))?.commands ?? null;
    const commands = Array.isArray(rawCommands) ? rawCommands : [];
    const hasMcpCommand = commands.some((c) => c?.name === "mcp");
    const hasTelemetry = () => live?.runtime?.tools !== null || (isOmp && Array.isArray(state?.dumpTools));
    // Wait briefly after cold start so fast local/HTTP MCP servers and the Botkins bridge settle before returning.
    if (!activeTurn && live && (supportedNames.length > 0 || (this.provider.bridge && this.spec.tools.length > 0))) {
      const deadline = Date.now() + INVENTORY_WAIT_MS;
      while (Date.now() < deadline && !this.turn && !this.closed) {
        if (!hasTelemetry()) break;
        const toolsByServer = this.classifyTools(live, state, supportedNames);
        const bridgeReady = !this.provider.bridge || !this.spec.tools.length || (toolsByServer.get(BRIDGE)?.size ?? 0) > 0 || live.runtime.mcpStates.has(BRIDGE);
        const serversReady = supportedNames.every((name) =>
          unregisteredOnWarmPi(name) || staleConfig(name) || (toolsByServer.get(name)?.size ?? 0) > 0 || !!recordedState(name),
        );
        if (bridgeReady && serversReady) break;
        await delay(INVENTORY_STEP_MS);
        if (isOmp) state = (await live.rpc.request({ type: "get_state" }, 2000).catch(() => null)) ?? state;
      }
    }
    let toolsByServer = live ? this.classifyTools(live, state, supportedNames) : new Map();
    // When idle, probe unresolved registered servers so 0-tool connected, failed, needs-auth and pending are distinguished.
    if (!activeTurn && live && hasMcpCommand) {
      const unresolved = supportedNames.filter(
        (name) => !unregisteredOnWarmPi(name) && !staleConfig(name) && !(toolsByServer.get(name)?.size > 0) && !recordedState(name),
      );
      if (unresolved.length > 0) {
        if (isOmp) {
          const probeDeadline = Date.now() + 2500;
          for (const name of unresolved) {
            if (this.turn || this.closed || Date.now() >= probeDeadline) break;
            await this.probeOmpMcp(live, harnessName(name));
          }
          state = (await live.rpc.request({ type: "get_state" }, 2000).catch(() => null)) ?? state;
        } else {
          await this.probePiMcp(live);
        }
        toolsByServer = this.classifyTools(live, state, supportedNames);
      }
    }
    const servers = configuredNames.map((name) => {
      if (unsupported.has(name)) return { name, status: "unavailable", tools: [] };
      if (!live) return { name, status: "not started", tools: [] };
      if (unregisteredOnWarmPi(name) || staleConfig(name)) return { name, status: "configured", tools: [] };
      const observed = [...(toolsByServer.get(name)?.values() ?? [])];
      const recorded = recordedState(name);
      if (observed.length > 0 && (!recorded || recorded === "connected" || recorded === "pending")) {
        if (recorded === "pending") clearPendingState(name);
        return { name, status: "connected", tools: observed };
      }
      if (recorded && recorded !== "connected") return { name, status: recorded, tools: [] };
      if (recorded === "connected") return { name, status: "connected", tools: [] };
      if (!isOmp && hasTelemetry() && !live.runtime.mcpSettled) return { name, status: "pending", tools: [] };
      if (isOmp && state?.hasPendingAsyncWork) return { name, status: "pending", tools: [] };
      return { name, status: "unobservable", tools: [] };
    });
    // Botkins' own tools: when real runtime telemetry is active on a bridged session, reflect observed exposure and availability.
    let botkinsTools = this.spec.tools;
    if (live && this.provider.bridge && hasTelemetry()) {
      const bridgeTools = toolsByServer.get(BRIDGE);
      const bridgeState = live.runtime.mcpStates.get(BRIDGE);
      if (bridgeState && bridgeState !== "connected") {
        botkinsTools = [];
      } else if (bridgeTools && bridgeTools.size > 0) {
        botkinsTools = [];
        for (const tool of this.spec.tools) {
          const match = bridgeTools.get(tool.name) ?? bridgeTools.get(tool.name.replace(/[^A-Za-z0-9_]/g, "_"));
          if (match) botkinsTools.push({ ...tool, exposure: match.exposure });
        }
      } else {
        botkinsTools = [];
      }
    }
    const inventory = buildInventory({ name: this.provider.name, tools: botkinsTools, servers, native: skillChoices(this.skills.list), compact: true });
    if (this.provider.packages.activePaths().length) {
      const taken = new Set(inventory.choices.flatMap((item) => [item.command, ...(item.aliases ?? [])]));
      for (const cmd of commands) {
        if (!cmd?.name || taken.has(cmd.name)) continue;
        if (isOmp) {
          if ((cmd.source !== "extension" && cmd.source !== "skill") || cmd.name === "autoresearch") continue;
        } else {
          if (cmd.sourceInfo?.path?.startsWith("builtin:")) continue;
        }
        inventory.choices.push({
          name: cmd.name,
          command: cmd.name,
          aliases: [],
          kind: cmd.source === "skill" ? "Skill" : "Command",
          source: this.provider.name,
          description: String(cmd.description ?? "").split("\n")[0].slice(0, 300),
          duringTurn: false,
          native: true,
        });
        taken.add(cmd.name);
      }
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
  description = "The Pi coding agent, as the harness for GitHub Copilot, ChatGPT, Claude and OpenCode models.";
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
    // Botkins session id → { folder, plan }: in-memory plan mirror alongside sessions.json.
    this.plans = new Map();
    // Botkins session id → { rpc, ref, key, file, folder, session, timer, plan, state }: one process per conversation.
    this.live = new Map();
    // OMP session id → current ToolBridge key (rotated when declared bridge schemas change so OMP refreshes tools/list).
    this.bridgeKeys = new Map();
    this.packages = packages ?? new PiPackages({ dataDir: this.dataDir, install: (source, dir) => this.installPackage(source, dir) });
  }
  storedPlan(sessionId, folder) {
    const record = this.sessions.get(sessionId);
    if (record && record.folder === folder && record.plan !== undefined) return record.plan;
    const entry = this.plans.get(sessionId);
    if (entry && entry.folder === folder) return entry.plan;
    return null;
  }
  savePlan(sessionId, folder, plan) {
    this.plans.set(sessionId, { folder, plan });
    this.sessions.update(sessionId, (record) => {
      if (record.folder === folder) record.plan = plan;
    });
  }
  clearPlan(sessionId) {
    this.plans.delete(sessionId);
    this.sessions.update(sessionId, (record) => {
      delete record.plan;
    });
  }
  async installPackage(source, dir) {
    const file = await this.locate();
    if (!file) throw new Error("Install Pi on this computer in Settings › General › Harness first.");
    const env = await cliEnv({
      PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      // Older Pi versions can ask npm for a global install. Keep that prefix inside staging too.
      npm_config_prefix: join(dir, "npm"), npm_config_registry: "https://registry.npmjs.org",
    }, this.baseEnv);
    const start = launcher(file, ["install", source, "--no-approve"]);
    const result = await run(start.file, start.args, { cwd: dir, env: { ...env, ...start.env }, timeoutMs: 120000 });
    if (result.code !== 0) throw new Error("Pi couldn't install the package. " + (result.stderr || result.stdout).trim().slice(-600));
  }
  /**
   * Where the program is. Pi: the copy that ships with Botkins, which this adapter is built and
   * tested against, else one on the PATH. OMP: on the PATH (it doesn't ship with Botkins).
   */
  async locate() {
    if (this.binary) return findBinary(this.program.binary, { override: this.binary, env: this.baseEnv });
    if (this.runtime === PI_ID) {
      const bundled = this.bundled === undefined ? bundledPi() : this.bundled;
      if (bundled) return bundled;
    }
    return findBinary(this.program.binary, { env: this.baseEnv });
  }
  async status() {
    const file = await this.locate();
    const start = file && launcher(file, ["--version"]);
    const version = start ? versionOf((await run(start.file, start.args, { env: { ...(await cliEnv({ PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" }, this.baseEnv)), ...start.env }, timeoutMs: 15000 }).catch(() => ({ stdout: "" }))).stdout) : "";
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
  async process(session, described, { ref: explicitRef, fresh = false } = {}) {
    const { spec } = session;
    const target = session.target();
    // Both harnesses take connections and package state at start; OMP also takes its isolated MCP config.
    const packages = spec.sourcesOnly ? [] : this.packages.activePaths();
    // An hour's prompt cache where a connection can keep one (pi-ai's PI_CACHE_RETENTION, read as each request is made).
    const retention = spec.cacheRetention === "long" ? "long" : "short";
    // OMP discovers bridge tool schemas at startup: restart only when the declared bridge schema set changes.
    const key = hash([spec.folder, described.providers, spec.temporary, packages, retention, ...(this.runtime === OMP_ID ? [described.servers, session.bridgeShape ?? null] : [])]);
    let live = this.live.get(spec.sessionId);
    if (live && (fresh || live.key !== key || live.rpc.closed)) {
      this.live.delete(spec.sessionId);
      await live.rpc.close().catch(() => {});
      live = null;
    }
    if (live) {
      live.session = session;
      await this.write(live, described);
      clearTimeout(live.timer);
      const state = await live.rpc.request({ type: "get_state" }, 15000).catch(() => null);
      live.state = state;
      if (state?.model && (state.model.provider !== target.provider || state.model.id !== target.modelId)) await live.rpc.request({ type: "set_model", ...target });
      const wanted = level(session.model.reasoningEffort);
      if (wanted && state?.thinkingLevel !== wanted) await live.rpc.request({ type: "set_thinking_level", level: wanted }).catch(() => {});
      return live;
    }
    const file = await this.locate();
    if (!file) throw new Error(this.name + " isn't installed. Install it in Settings › Harness, or choose another harness.");
    const remembered = fresh ? undefined : (explicitRef ?? this.sessions.get(spec.sessionId)?.ref);
    const ref = this.runtime === OMP_ID
      ? remembered
      : (fresh && explicitRef === undefined && this.sessions.get(spec.sessionId) === undefined && spec.established
          ? piSessionId(spec.sessionId + ":" + randomBytes(4).toString("hex"))
          : remembered ?? piSessionId(spec.sessionId));
    const dir = join(this.dataDir, "run");
    // Files left by processes of an earlier run of Botkins (they hold session secrets) go first.
    if (!this.runCleared) {
      this.runCleared = true;
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const agentDir = this.agentDir(spec);
    const launchDir = this.runtime === OMP_ID ? join(this.dataDir, "launch", hash(spec.sessionId).slice(0, 24)) : spec.folder;
    if (this.runtime === OMP_ID) mkdirSync(launchDir, { recursive: true, mode: 0o700 });
    live = {
      ref,
      key,
      folder: spec.folder,
      // A file of this process's own: one let go a moment ago may still be exiting, and removes its own.
      file: join(dir, hash(spec.sessionId).slice(0, 24) + "-" + randomBytes(4).toString("hex") + ".json"),
      config: join(agentDir, "botkins.yml"),
      agentDir,
      session,
      timer: null,
      plan: undefined,
      state: null,
      runtime: createRuntimeState(),
      registeredConfigs: new Map(Object.entries(described.servers ?? {}).map(([name, cfg]) => [name, JSON.stringify(cfg)])),
      pendingConfigs: null,
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
      // A connection that can't keep a longer cache says so in its models' compat (desktop/harness/index.mjs).
      PI_CACHE_RETENTION: retention === "long" ? "long" : undefined,
      [this.program.sessionEnv]: live.file,
    }, this.baseEnv);
    const start = launcher(file, args);
    live.rpc = new PiRpc(start.file, start.args, { env: { ...env, ...start.env }, cwd: launchDir, name: this.name, ...(this.runtime === OMP_ID && { protocolVersion: 2 }) });
    live.rpc.on((event) => {
      this.observeRuntime(live, event);
      if (event.type === "extension_ui_request") void this.dialog(live, event);
    });
    live.rpc.exited.then(() => {
      if (this.live.get(spec.sessionId) === live) this.live.delete(spec.sessionId);
      // Its own file only: a process let go a moment ago can exit after the next turn's process
      // started, and that one's file must stay (without it Pi starts with no connections: "Model … not found").
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
      live.state = state;
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
    // Every server Botkins gave this process (PiSession.permission).
    live.given = new Set([...(live.given ?? []), ...Object.keys(described.servers ?? {})]);
    live.pendingConfigs = new Map(Object.entries(described.servers ?? {}).map(([name, cfg]) => [name, JSON.stringify(cfg)]));
    mkdirSync(live.agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(live.file, JSON.stringify(described), { mode: 0o600 });
    if (this.runtime === OMP_ID) {
      writeFileSync(join(live.agentDir, "mcp.json"), JSON.stringify({ mcpServers: described.servers }), { mode: 0o600 });
      writeFileSync(live.config, OMP_CONFIG, { mode: 0o600 });
    }
  }
  /** Passively tracks runtime tool snapshots, MCP notices and command updates from the harness stream. */
  observeRuntime(live, event) {
    const rt = live.runtime;
    if (!rt || !event) return;
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus" && event.statusKey === INVENTORY && typeof event.statusText === "string") {
        try {
          const parsed = JSON.parse(event.statusText);
          if (Array.isArray(parsed?.tools)) rt.tools = parsed.tools;
          if (Array.isArray(parsed?.servers)) rt.servers = parsed.servers;
        } catch {
          // Ignore malformed telemetry payloads.
        }
        return;
      }
      if (event.method === "notify" && typeof event.message === "string") {
        const parsed = parsePiMcpNotify(event.message);
        if (parsed) {
          if (parsed.settled) rt.mcpSettled = true;
          for (const [name, status] of parsed.states) rt.mcpStates.set(name, status);
        }
      }
      return;
    }
    if (event.type === "notice" && event.source === "toolCommands" && typeof event.message === "string") {
      const match = /^Tool commands:\s+(added|removed)\s+(.+)$/i.exec(event.message.trim());
      if (match) {
        const adding = match[1].toLowerCase() === "added";
        for (const name of match[2].split(/[\s,]+/).filter(Boolean)) {
          if (adding) rt.toolCommands.add(name);
          else rt.toolCommands.delete(name);
        }
      }
      return;
    }
    if (event.type === "available_commands_update" && Array.isArray(event.commands)) {
      rt.availableCommands = event.commands;
      return;
    }
    if (event.type === "command_output" && typeof event.text === "string") {
      const parsed = parseOmpMcpOutput(event.text);
      if (parsed) rt.mcpStates.set(parsed.name, parsed.status);
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
  /** Stable ToolBridge key per session. For OMP, rotates when declared bridge tool schemas change so OMP's discovery cache refreshes. */
  bridgeKey(sessionId, shape) {
    const base = this.id + ":" + sessionId;
    if (this.runtime !== OMP_ID) return base;
    const next = shape ? base + ":" + shape.slice(0, 16) : base;
    const prev = this.bridgeKeys.get(sessionId);
    if (prev && prev !== next) this.bridge?.forget(prev);
    this.bridgeKeys.set(sessionId, next);
    return next;
  }
  async deleteSession(sessionId) {
    this.release(sessionId);
    const prev = this.bridgeKeys.get(sessionId);
    this.bridgeKeys.delete(sessionId);
    this.plans.delete(sessionId);
    this.bridge?.forget(prev ?? this.id + ":" + sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
  }
}
