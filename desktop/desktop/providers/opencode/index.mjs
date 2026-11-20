// OpenCode as a Botkins model provider.
//
// Botkins starts `opencode serve` on this computer and talks to its HTTP API; replies arrive on
// its event stream. OpenCode keeps the sign-ins itself: the person connects model services (an
// OpenCode account, an API key, a subscription OpenCode can use) and every model those services
// offer appears in Botkins. Connecting a service from Settings goes through OpenCode's own
// "integration" calls, so a key or a token is handed to OpenCode and never kept by Botkins.
//
// A Botkins session is an OpenCode session; sessions.json remembers which. Botkins' own
// tools reach OpenCode through the tool bridge (desktop/providers/toolbridge.mjs). OpenCode keeps
// MCP servers per folder, not per session, so each session's bridge has a name of its own and the
// session's rules allow that one and no other session's.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { cliEnv, findBinary, run, versionOf } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { SessionStore, serversWithTokens, transcriptContext } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";
import { env } from "../../home.mjs";
import { modelDetails } from "../../modeldetails.mjs";

/** Every session's bridge is named with this prefix, so one rule can close them all to a session. */
export const BRIDGE_PREFIX = "botkins-";
const INSTRUCTIONS_KEY = "botkins";
// A server that has just started loads its plugins and model catalog before its first answers.
const SLOW = 180000;
// Services shown first when the person looks for one to connect.
const FEATURED = ["opencode", "opencode-go", "openai", "anthropic", "google", "github-copilot", "xai", "openrouter", "groq", "mistral", "deepseek", "ollama-cloud"];

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** The rules an OpenCode session runs under. The last matching rule wins. */
export function sessionRules(approval, { plan = false, bridge, servers = [] } = {}) {
  const rule = (action, effect) => ({ action, resource: "*", effect });
  return [
    ...(approval === "all" ? [rule("*", "allow")] : [rule("shell", "ask"), rule("edit", "ask"), rule("external_directory", "ask"), ...servers.map((name) => rule(name + "_*", "ask"))]),
    ...(plan ? [rule("edit", "deny")] : []),
    // Other sessions' bridges are in the same folder: closed to this one. Its own never asks.
    rule(BRIDGE_PREFIX + "*", "deny"),
    ...(bridge ? [rule(bridge + "_*", "allow")] : []),
  ];
}

/**
 * A Botkins MCP server record as OpenCode's. `codemode` is off: OpenCode would otherwise wrap
 * the server's tools in one "run this code" tool, and a step would no longer say which tool ran
 * or ask for it by name.
 */
function openCodeServer(server) {
  if (server.type === "stdio")
    return {
      type: "local",
      command: [server.command, ...(server.args ?? [])],
      ...(server.env && Object.keys(server.env).length && { environment: server.env }),
      ...(server.workingDirectory && { cwd: server.workingDirectory }),
      codemode: false,
    };
  return { type: "remote", url: server.url, ...(server.headers && Object.keys(server.headers).length && { headers: server.headers }), oauth: false, codemode: false };
}

const contentText = (content) =>
  (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : part?.type ? "[" + part.type + "]" : ""))
    .filter(Boolean)
    .join("\n");

class OpenCodeSession extends ProviderSession {
  constructor(provider, spec) {
    super();
    this.provider = provider;
    this.spec = spec;
    this.id = spec.sessionId;
    this.model = { ...spec.model };
    // Botkins' skills: listed in the instructions, read through a tool on the bridge.
    this.skills = skillSupport(spec);
    this.handlers = new Set();
    this.mode = "interactive";
    this.turn = null;
    this.tools = new Map();
    this.children = new Set();
    this.todoList = null;
    this.bridgeName = BRIDGE_PREFIX + createHash("sha256").update(spec.sessionId).digest("hex").slice(0, 16);
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(type, data, id, agentId) {
    for (const handler of this.handlers) handler({ type, data, ...(id && { id }), ...(agentId && { agentId }) });
  }
  get location() {
    return { directory: this.spec.folder };
  }
  modelRef() {
    const [providerID, ...rest] = this.model.model.split("/");
    return { providerID, id: rest.join("/"), ...(this.model.reasoningEffort && { variant: this.model.reasoningEffort }) };
  }
  rules() {
    return sessionRules(this.spec.approval, { plan: this.mode === "plan", bridge: this.bridge && this.bridgeName, servers: Object.keys(this.spec.mcpServers ?? {}) });
  }
  /** Creates or finds the OpenCode session on first need: a session that is only opened costs nothing. */
  session() {
    this.starting ??= this.start().catch((error) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }
  async start() {
    const { provider, spec } = this;
    const api = await provider.server();
    const known = provider.sessions.get(spec.sessionId);
    // Only "not found" means OpenCode no longer has the session. A timeout or a server error is a
    // failure: starting a new session over it would leave the real conversation behind.
    let info =
      known &&
      (await api.get("/api/session/" + known.ref).then(
        (r) => r.data,
        (error) => {
          if (error.status === 404) return null;
          throw error;
        },
      ));
    // Servers and the bridge are added to the folder before the session, so its first turn sees their tools.
    // The address stays with the conversation, so OpenCode keeps one connection to it from turn to turn.
    const tools = [...(spec.tools ?? []), ...this.skills.tools];
    this.bridge = spec.handlers && tools.length ? await provider.bridge.open(tools, spec.temporary ? {} : { key: provider.id + ":" + spec.sessionId }) : null;
    const servers = await serversWithTokens(spec);
    await Promise.all([
      ...Object.entries(servers).map(([name, server]) => api.put("/api/experimental/mcp/" + encodeURIComponent(name), { config: openCodeServer(server) }, this.location).catch((error) => console.error("OpenCode MCP server " + name + ":", error.message))),
      ...(this.bridge ? [api.put("/api/experimental/mcp/" + this.bridgeName, { config: { type: "remote", url: this.bridge.url, headers: this.bridge.headers, oauth: false, codemode: false, timeout: { execution: 900000 } } }, this.location)] : []),
    ]);
    const lost = !info && spec.established && spec.hasReplies ? transcriptContext(spec) : "";
    if (info) {
      await api.patch("/api/session/" + info.id, { permissions: this.rules() });
      const wanted = this.modelRef();
      if (info.model?.id !== wanted.id || info.model?.providerID !== wanted.providerID || (info.model?.variant ?? "default") !== (wanted.variant ?? "default"))
        await api.post("/api/session/" + info.id + "/model", { model: wanted });
    } else {
      const agents = await provider.agents(this.location);
      ({ data: info } = await api.post("/api/session", {
        location: this.location,
        model: this.modelRef(),
        // The person's own default agent has a role of its own; a bot brings its own instructions.
        ...(agents.includes("build") && { agent: "build" }),
        permissions: this.rules(),
        title: "Botkins",
      }));
      if (!spec.temporary) provider.sessions.set(spec.sessionId, { ref: info.id });
    }
    this.sessionId = info.id;
    await api.put("/api/experimental/session/" + info.id + "/instructions/entries/" + INSTRUCTIONS_KEY, { value: spec.instructions + this.skills.instructions + (spec.context ?? "") + lost });
    provider.attach(this);
    return info.id;
  }

  async send(message, timeoutMs = 600000) {
    if (this.turn || this.sending) throw new Error("This conversation is already working.");
    this.sending = true;
    this.stopRequested = false;
    let timer;
    try {
      const sessionId = await this.session();
      const api = await this.provider.server();
      await this.provider.listen();
      // Stop was pressed while OpenCode was still starting: the turn never begins.
      if (this.stopRequested || this.closed) return { text: "" };
      // The turn before this one was given up on (it timed out, or its session was closed) before
      // OpenCode said it had ended. It is waited out, so its last events are not taken for this turn's.
      if (this.provider.unsettled.delete(sessionId)) await api.post("/api/experimental/session/" + sessionId + "/wait", undefined, undefined, 20000).catch(() => {});
      const turn = (this.turn = { text: [], any: false, usage: { input: 0, output: 0, cacheRead: 0, cost: 0 }, failure: "", started: Date.now(), posted: false, ended: false });
      const finished = new Promise((resolve, reject) => Object.assign(turn, { resolve, reject }));
      finished.catch(() => {});
      timer = setTimeout(() => turn.reject(new Error("OpenCode didn't finish in time.")), timeoutMs);
      timer.unref?.();
      try {
        const { data } = await api.post("/api/session/" + sessionId + "/prompt", {
          text: this.mode === "plan" ? "Plan mode: do not change any file. Work out a plan, show it, and ask before carrying it out.\n\n" + message.prompt : message.prompt,
          ...(message.attachments?.length && { files: message.attachments.filter((a) => a.kind !== "directory").map((a) => ({ uri: pathToFileURL(a.path).href, name: a.name })) }),
        });
        // Only an ending that comes after the message was handed over is this turn's.
        turn.posted = true;
        // The message's id is the fork boundary (see OpenCodeProvider.forkSession).
        this.emit("user.message", {}, data?.id);
        if (this.stopRequested) this.interrupt();
        await finished;
      } catch (error) {
        // Timed out or failed on this side: OpenCode must not go on with a turn nobody is waiting for.
        if (!turn.ended) {
          this.provider.unsettled.add(sessionId);
          await this.interrupt();
        }
        throw error;
      }
      const text = turn.text.map((t) => t.trim()).filter(Boolean).join("\n\n");
      const { usage } = turn;
      if (usage.input || usage.output)
        this.emit("assistant.usage", {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          ...(usage.cost > 0 && { cost: usage.cost }),
          model: this.model.model,
        });
      return { text };
    } finally {
      clearTimeout(timer);
      this.turn = null;
      this.sending = false;
    }
  }
  /**
   * Looks at the session after the event stream was lost and found again: a turn that ended
   * meanwhile is finished from what OpenCode has stored, so it doesn't wait for an event that
   * already went by.
   */
  async resync() {
    const turn = this.turn;
    const api = this.provider.serverIfRunning && (await this.provider.serverIfRunning());
    if (!turn || !api || !this.sessionId) return;
    const info = await api.get("/api/session/" + this.sessionId, undefined, 15000).then((r) => r.data, () => null);
    if (this.turn !== turn || !turn.posted || !info?.time?.idle || info.time.idle < turn.started) return;
    turn.ended = true;
    if (info.outcome === "failed") return turn.reject(new Error(turn.failure || "OpenCode couldn't finish this reply."));
    const messages = await api.get("/api/session/" + this.sessionId + "/message?order=desc&limit=20&type=assistant", undefined, 15000).then((r) => r.data ?? [], () => []);
    const latest = messages.find((m) => (m.time?.created ?? 0) >= turn.started - 1000);
    const text = (latest?.content ?? []).filter((part) => part.type === "text" && part.text).map((part) => part.text);
    if (this.turn !== turn) return;
    if (text.length) turn.text = text;
    turn.resolve();
  }
  /** One event from OpenCode's stream for this session, or for a helper session it started. */
  received(event) {
    const { type, data } = event;
    const child = data.sessionID !== this.sessionId;
    // A helper asks the person through the session that started it.
    if (type === "permission.asked") return void this.permission(data);
    if (type === "form.created") return void this.form(data.form ?? data);
    const turn = this.turn;
    const agentId = child ? data.sessionID : undefined;
    switch (type) {
      case "session.text.started":
        if (turn && !child && turn.any) this.emit("assistant.message_delta", { deltaContent: "\n\n" });
        return;
      case "session.text.delta":
        if (turn && !child) turn.any = true;
        if (data.delta) this.emit("assistant.message_delta", { deltaContent: data.delta }, undefined, agentId);
        return;
      case "session.text.ended":
        if (turn && !child && data.text) {
          turn.text.push(data.text);
          // Text that arrived whole, without deltas, is shown now.
          if (!turn.any) this.emit("assistant.message_delta", { deltaContent: data.text });
          turn.any = true;
        }
        return;
      case "session.reasoning.delta":
        if (data.delta) this.emit("assistant.reasoning_delta", { reasoningId: data.assistantMessageID + ":" + data.ordinal, deltaContent: data.delta }, undefined, agentId);
        return;
      case "session.reasoning.ended":
        this.emit("assistant.reasoning", { reasoningId: data.assistantMessageID + ":" + data.ordinal, content: data.text }, undefined, agentId);
        return;
      case "session.tool.input.started":
        this.tools.set(data.id, { name: data.name, started: false });
        return;
      case "session.tool.called": {
        const tool = this.tools.get(data.id) ?? { name: data.name ?? "tool" };
        this.tools.set(data.id, tool);
        if (tool.started) return;
        tool.started = true;
        const [name, server] = this.toolName(tool.name);
        this.emit("tool.execution_start", { toolCallId: data.id, toolName: name, arguments: data.input ?? {}, ...(server && { mcpServerName: server, mcpToolName: name }) }, undefined, agentId);
        return;
      }
      case "session.tool.success": {
        const text = contentText(data.content);
        if (this.tools.get(data.id)?.name === "todowrite" && Array.isArray(data.metadata?.todos) && !child) {
          this.todoList = data.metadata.todos.map((t, i) => ({ id: String(t.id ?? i + 1), title: t.content, status: t.status }));
          this.emit("session.todos_changed", {});
        }
        this.emit("tool.execution_complete", { toolCallId: data.id, success: true, ...(text && { result: { content: text } }) }, undefined, agentId);
        return;
      }
      case "session.tool.failed":
        this.emit("tool.execution_complete", { toolCallId: data.id, success: false, error: { message: data.error?.message ?? (typeof data.error === "string" ? data.error : "Failed") } }, undefined, agentId);
        return;
      case "session.step.ended":
        if (turn && data.tokens) {
          turn.usage.input += data.tokens.input ?? 0;
          turn.usage.output += (data.tokens.output ?? 0) + (data.tokens.reasoning ?? 0);
          turn.usage.cacheRead += data.tokens.cache?.read ?? 0;
          turn.usage.cost += data.cost ?? 0;
        }
        return;
      case "session.step.failed":
      case "session.execution.failed":
        if (child || !turn) return;
        turn.failure = data.error?.message ?? data.message ?? turn.failure;
        if (type === "session.execution.failed" && turn.posted) {
          turn.ended = true;
          turn.reject(new Error(turn.failure || "OpenCode couldn't finish this reply."));
        }
        return;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        if (child || !turn?.posted) return;
        turn.ended = true;
        turn.resolve();
        return;
    }
  }
  /** A tool's name as the person should read it: [name, MCP server or undefined]. Botkins' own tools lose the bridge's name. */
  toolName(raw) {
    const name = String(raw ?? "tool");
    if (name.startsWith(this.bridgeName + "_")) return [name.slice(this.bridgeName.length + 1)];
    const server = Object.keys(this.spec.mcpServers ?? {}).find((s) => name.startsWith(s + "_"));
    return server ? [name.slice(server.length + 1), server] : [name];
  }
  async permission(request) {
    const api = await this.provider.serverIfRunning();
    if (!api) return;
    const reply = (decision) => api.post("/api/session/" + request.sessionID + "/permission/" + request.id + "/reply", { decision }).catch(() => {});
    const handlers = this.spec.handlers;
    if (!handlers || !this.turn) return reply("reject");
    const resources = (request.resources ?? []).filter((r) => r && r !== "*");
    const [tool, server] = this.toolName(request.action);
    const shell = request.action === "shell";
    const edit = request.action === "edit";
    try {
      const answer = await handlers.permission({
        kind: shell ? "shell" : edit ? "write" : server ? "mcp" : request.action === "external_directory" ? "read" : "custom-tool",
        toolName: tool,
        title: request.message || (shell ? "Run this command?" : edit ? "Change this file?" : "Allow " + tool + "?"),
        label: shell ? "Shell command" : edit ? (resources[0] ?? "File change") : server ? server + " / " + tool : tool,
        preview: String(request.metadata?.command ?? request.metadata?.diff ?? resources.join("\n")),
        detail: displayValue(request, Infinity),
        remember: resources.length ? [shell ? "this exact command" : edit ? "writes to this path" : server ? "MCP tool " + server + "/" + tool : "this request", request.action, ...resources] : null,
        readOnly: false,
        sandboxEscape: request.action === "external_directory",
        managed: false,
      });
      await reply(answer?.allow ? "once" : "reject");
    } catch {
      await reply("reject");
    }
  }
  /** A question from the model: each field is asked in turn, then the answers go back together. */
  async form(form) {
    const api = await this.provider.serverIfRunning();
    if (!api) return;
    const path = "/api/session/" + form.sessionID + "/form/" + form.id;
    const handlers = this.spec.handlers;
    if (!handlers || !this.turn) return void api.delete(path).catch(() => {});
    try {
      const answer = {};
      for (const field of form.fields ?? []) {
        if (field.hidden) {
          if (field.default !== undefined) answer[field.key] = field.default;
          continue;
        }
        const options = (field.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
        const reply = await handlers.question({
          question: [form.title, field.title ?? field.label ?? field.key].filter(Boolean).join(": "),
          choices: options.map((o) => o.label ?? o.value),
          allowFreeform: !options.length || field.custom !== false,
        });
        const picked = options.find((o) => (o.label ?? o.value) === reply.answer);
        const value = picked ? picked.value : reply.answer;
        answer[field.key] = field.type === "multiselect" ? [value] : field.type === "boolean" ? /^(y|yes|true)$/i.test(String(value)) : field.type === "number" || field.type === "integer" ? Number(value) : value;
      }
      await api.post(path + "/reply", { answer });
    } catch {
      await api.delete(path).catch(() => {});
    }
  }

  /** Asks OpenCode to stop this session's turn. Never starts the server. */
  async interrupt() {
    const api = await this.provider.serverIfRunning();
    if (!api || !this.sessionId) return;
    // Once per turn: Stop, a timeout and a close can all ask for the same thing.
    if (this.turn) {
      if (this.turn.interrupted) return;
      this.turn.interrupted = true;
    }
    await api.post("/api/session/" + this.sessionId + "/interrupt", undefined, undefined, 10000).catch(() => {});
  }
  async abort() {
    // Remembered too, for a Stop that arrives while OpenCode is still starting (see send).
    this.stopRequested = true;
    if (this.turn) await this.interrupt();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    // A turn nobody waits for any more is not left running.
    if (this.turn) {
      await this.interrupt();
      this.turn?.reject(new Error("The conversation was closed."));
    }
    this.provider.detach(this);
    this.bridge?.close();
    // Nothing here starts the server again: at shutdown it would outlive the app.
    const api = await this.provider.serverIfRunning();
    if (!api) return;
    // The bridge leaves the folder with the session, so other sessions there never list it.
    if (this.bridge) await api.delete("/api/experimental/mcp/" + this.bridgeName, this.location).catch(() => {});
    // A session made only to look (a server test) is not left in OpenCode's list.
    if (this.spec.temporary && this.sessionId) await api.delete("/api/session/" + this.sessionId).catch(() => {});
  }
  async currentModel() {
    return { model: this.model.model, reasoningEffort: this.model.reasoningEffort };
  }
  async switchModel(selection) {
    this.model = { ...selection };
    if (this.sessionId) await (await this.provider.server()).post("/api/session/" + this.sessionId + "/model", { model: this.modelRef() });
  }
  async setMode(mode) {
    const next = mode === "plan" ? "plan" : "interactive";
    if (next === this.mode) return true;
    this.mode = next;
    if (this.sessionId) await (await this.provider.server()).patch("/api/session/" + this.sessionId, { permissions: this.rules() });
    return true;
  }
  /** OpenCode answers from the conversation's context without adding to it. */
  async sideQuestion(question) {
    const sessionId = await this.session();
    const { data } = await (await this.provider.server()).post("/api/session/" + sessionId + "/generate", { prompt: question }, undefined, 180000);
    if (!data?.text?.trim()) throw new Error("OpenCode returned an empty side answer.");
    return data.text.trim();
  }
  async compact() {
    const sessionId = await this.session();
    const api = await this.provider.server();
    await api.post("/api/session/" + sessionId + "/compact", {});
    await api.post("/api/experimental/session/" + sessionId + "/wait", undefined, undefined, 300000).catch(() => {});
  }
  async todos() {
    return this.todoList ? { rows: this.todoList, dependencies: [] } : null;
  }
  async inventory() {
    const wanted = Object.keys(this.spec.mcpServers ?? {});
    let servers = wanted.map((name) => ({ name, status: "not started" }));
    // Only a session that is running (or a test of one server) connects its servers.
    if (wanted.length && (this.sessionId || this.spec.temporary)) {
      await this.session();
      const api = await this.provider.server();
      const read = async () => (await api.get("/api/mcp", this.location)).data ?? [];
      let list = await read();
      for (let tries = 0; tries < 30 && list.some((s) => wanted.includes(s.name) && s.status?.status === "pending"); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        list = await read();
      }
      servers = wanted.map((name) => {
        const status = list.find((s) => s.name === name)?.status?.status;
        return { name, status: status === "needs_auth" ? "needs-auth" : (status ?? "failed") };
      });
    }
    return buildInventory({ name: this.provider.name, tools: this.spec.tools, servers, native: skillChoices(this.skills.list), compact: true });
  }
  resolvePrompt(prompt, run, chat, host) {
    return resolvePrompt(this, prompt, run, chat, host);
  }
}

/** A small client for the OpenCode server's HTTP API. `location` is sent the way the API reads it. */
function client(base, password, fetcher = fetch) {
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
  const call = async (method, path, body, location, timeoutMs = 60000) => {
    const url = new URL(base + path);
    if (location?.directory) url.searchParams.set("location[directory]", location.directory);
    const response = await fetcher(url, {
      method,
      headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw Object.assign(new Error(data?.message || "OpenCode answered " + response.status + "."), { status: response.status, tag: data?._tag });
    return data;
  };
  // A server that has just started answers "not ready yet" while a folder's plugins load. Reads wait for it.
  const patient = async (path, location, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    for (let wait = 1000; ; wait = Math.min(wait * 2, 8000)) {
      try {
        return await call("GET", path, undefined, location, Math.max(5000, deadline - Date.now()));
      } catch (error) {
        const starting = error.status === 503 || error.tag === "ServiceUnavailableError" || /did not finish activating/i.test(error.message);
        if (!starting || Date.now() + wait > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };
  return {
    base,
    headers,
    get: patient,
    post: (path, body, location, timeoutMs) => call("POST", path, body, location, timeoutMs),
    put: (path, body, location) => call("PUT", path, body, location),
    patch: (path, body, location) => call("PATCH", path, body, location),
    delete: (path, location) => call("DELETE", path, undefined, location),
  };
}

export class OpenCodeProvider extends ModelProvider {
  id = "opencode";
  name = "OpenCode";
  // The person adds OpenCode themselves: it starts a server of its own, and its list of models can be long.
  defaultEnabled = false;
  description = "Any model you connect in OpenCode: its own free and paid models, API keys and other plans.";
  /**
   * @param options.dataDir  Where the session records are kept. Omit to keep them in memory.
   * @param options.bridge   The tool bridge Botkins' tools are offered through.
   * @param options.binary   A path to the OpenCode CLI, instead of looking for `opencode`.
   * @param options.connect  For tests: async () => ({ url, password }) of a server that is already running.
   * @param options.pollMs   How often a sign-in that is waiting for the browser is asked about.
   */
  constructor({ dataDir, bridge, binary, connect, pollMs = 1500 } = {}) {
    super();
    Object.assign(this, { dataDir, bridge, binary, connect, pollMs });
    this.sessions = new SessionStore(dataDir && join(dataDir, "sessions.json"));
    this.open = new Map();
    // OpenCode sessions whose last turn was given up on before OpenCode said it had ended.
    this.unsettled = new Set();
    this.attempts = new Map();
    this.running = null;
    this.stream = null;
  }
  locate() {
    return findBinary("opencode", { override: this.binary || env("OPENCODE_BINARY") });
  }
  /** The API client of the running server. The server starts on first use and again after it stops. */
  server() {
    this.running ??= this.start().catch((error) => {
      this.running = null;
      throw error;
    });
    return this.running;
  }
  /** The API client when the server is running (or starting), else null. Unlike server(), it starts nothing. */
  serverIfRunning() {
    return this.running ? this.running.catch(() => null) : Promise.resolve(null);
  }
  async start() {
    if (this.connect) {
      const { url, password } = await this.connect();
      return client(url, password);
    }
    const file = await this.locate();
    if (!file) throw new Error("OpenCode isn't installed. Install it from https://opencode.ai and try again.");
    const port = await freePort();
    const password = randomBytes(24).toString("base64url");
    // The server's own folder is an empty one: OpenCode loads the folder it starts in as a project,
    // and each session names the folder it really works in.
    const home = join(this.dataDir ?? join(tmpdir(), "botkins-opencode"), "server");
    mkdirSync(home, { recursive: true });
    const child = spawn(file, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: home,
      env: await cliEnv({ OPENCODE_SERVER_PASSWORD: password }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    let output = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCode took too long to start.")), 30000);
      const read = (chunk) => {
        output = (output + chunk).slice(-4000);
        if (/listening on http/i.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.on("error", (error) => (clearTimeout(timer), reject(error)));
      child.on("close", (code) => (clearTimeout(timer), reject(new Error("OpenCode stopped while starting (" + code + "). " + output.trim().split("\n").at(-1)))));
    }).catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = null;
      this.running = null;
      this.stream?.abort.abort();
      this.stream = null;
      for (const session of this.open.values()) session.turn?.reject(Object.assign(new Error("OpenCode stopped."), { code: "BOTKINS_PROVIDER_EXIT" }));
      this.open.clear();
    });
    return client("http://127.0.0.1:" + port, password);
  }
  /**
   * Follows the server's event stream while any session is open, and hands each event to its
   * session. Resolves once the stream is connected, so a turn's first events are not missed.
   */
  listen() {
    if (this.stream) return this.stream.ready;
    const abort = new AbortController();
    let connected;
    const stream = (this.stream = { abort, ready: new Promise((resolve) => (connected = resolve)) });
    const follow = async () => {
      const api = await this.serverIfRunning();
      if (!api) throw new Error("OpenCode isn't running.");
      const response = await fetch(api.base + "/api/event", { headers: api.headers, signal: abort.signal });
      if (!response.ok || !response.body) throw new Error("OpenCode refused its event stream (" + response.status + ").");
      connected();
      // Connected again after a drop: turns that ended meanwhile are finished from what OpenCode stored.
      if (this.streamFailures) for (const session of this.open.values()) session.resync().catch(() => {});
      this.streamFailures = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const data = buffer
            .slice(0, end)
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          buffer = buffer.slice(end + 2);
          if (!data) continue;
          try {
            this.dispatch(JSON.parse(data));
          } catch (error) {
            console.error("OpenCode event:", error.message);
          }
        }
      }
    };
    follow()
      .catch(() => {})
      .finally(() => {
        connected();
        if (this.stream !== stream) return;
        this.stream = null;
        if (!this.open.size || !this.running) return;
        // The stream dropped while replies are being written: follow it again, a few times. Without
        // it a reply can't be read, so after that the waiting turns are told instead of left hanging.
        this.streamFailures = (this.streamFailures ?? 0) + 1;
        if (this.streamFailures > 5) {
          this.streamFailures = 0;
          for (const session of this.open.values()) session.turn?.reject(new Error("Botkins lost its connection to OpenCode. Send the message again."));
          return;
        }
        setTimeout(() => this.listen().catch(() => {}), 500 * this.streamFailures).unref?.();
      });
    return stream.ready;
  }
  dispatch(event) {
    const data = event?.data;
    if (!data || typeof data !== "object") return;
    // A helper session reports to the session that started it.
    if (event.type === "session.created" && data.parentID) {
      const parent = this.owner(data.parentID);
      if (parent) parent.children.add(data.sessionID ?? data.id);
      return;
    }
    const sessionID = data.sessionID ?? data.form?.sessionID;
    const session = sessionID && this.owner(sessionID);
    session?.received({ type: event.type, data: data.sessionID ? data : { ...data, sessionID } });
  }
  owner(sessionID) {
    const own = this.open.get(sessionID);
    if (own) return own;
    for (const session of this.open.values()) if (session.children.has(sessionID)) return session;
    return null;
  }
  attach(session) {
    this.open.set(session.sessionId, session);
  }
  detach(session) {
    if (this.open.get(session.sessionId) === session) this.open.delete(session.sessionId);
    if (!this.open.size) {
      this.stream?.abort.abort();
      this.stream = null;
    }
  }
  /** Switched off: the server is let go; the next use starts it again. */
  suspend() {
    return this.stop();
  }
  async stop() {
    this.stream?.abort.abort();
    this.stream = null;
    this.open.clear();
    const child = this.child;
    this.child = null;
    this.running = null;
    if (!child || child.exitCode !== null) return;
    child.kill();
    // A server that is still loading a folder ignores the polite request.
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(force);
  }
  async agents(location) {
    const api = await this.server();
    const { data } = await api.get("/api/agent", location).catch(() => ({ data: [] }));
    return (data ?? []).map((a) => a.id);
  }

  // Account: OpenCode has no account of its own to sign in to; it holds the person's model services.
  async status() {
    if (!this.connect && !(await this.locate()))
      return {
        installed: false,
        connected: false,
        signIn: "services",
        signOut: false,
        message: "Install OpenCode to use the model services you connect to it.",
        install: { url: "https://opencode.ai", command: "curl -fsSL https://opencode.ai/install | bash" },
      };
    const api = await this.server();
    const [version, integrations, models] = await Promise.all([this.version().catch(() => ""), api.get("/api/integration", undefined, SLOW), this.models()]);
    const connected = (integrations.data ?? []).filter((i) => i.connections?.length).map((i) => i.name);
    return {
      installed: true,
      version: versionOf(version),
      // OpenCode's own free models need no sign-in, so it is usable as soon as it lists a model.
      connected: models.length > 0,
      signIn: "services",
      signOut: false,
      plan: connected.length ? connected.slice(0, 3).join(", ") + (connected.length > 3 ? " and " + (connected.length - 3) + " more" : "") : models.length ? "Free models" : undefined,
      ...(!models.length && { message: "Connect a model service to use OpenCode." }),
    };
  }
  async auth() {
    const status = await this.status();
    return { connected: status.connected, type: status.plan };
  }
  /**
   * The model services OpenCode can connect: [{ id, name, connected, via?, methods }]. A method is
   * { type: "key", label } for an API key or { type: "oauth", id, label } for a sign-in page.
   */
  async services(query = "") {
    const api = await this.server();
    const { data = [] } = await api.get("/api/integration", undefined, SLOW);
    const text = String(query).trim().toLowerCase();
    const rank = (service) => (service.connected ? 0 : FEATURED.includes(service.id) ? 1 + FEATURED.indexOf(service.id) : 1000);
    return data
      .map((i) => ({
        id: i.id,
        name: i.name,
        connected: !!i.connections?.length,
        // A service found in the computer's environment is connected outside OpenCode and can't be removed here.
        ...(i.connections?.length && { via: i.connections.some((c) => c.type !== "env") ? "opencode" : "environment" }),
        methods: (i.methods ?? [])
          .filter((m) => m.type === "key" || m.type === "oauth")
          .map((m) => ({ type: m.type, ...(m.id && { id: m.id }), label: m.label || (m.type === "key" ? "API key" : "Sign in") })),
      }))
      .filter((i) => i.methods.length || i.connected)
      .filter((i) => !text || i.name.toLowerCase().includes(text) || i.id.includes(text))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, text ? 60 : 24);
  }
  /**
   * Connects a model service. With { key } it stores an API key. With { method } it starts that
   * sign-in: the page opens in the browser, and the call resolves { done: true } when OpenCode
   * says it finished, or { code: { attempt, instructions } } when the page gives the person a code
   * to bring back (then finishService).
   */
  async connectService(serviceId, { key, method, open } = {}) {
    const api = await this.server();
    const path = "/api/integration/" + encodeURIComponent(serviceId) + "/connect";
    if (typeof key === "string") {
      if (!key.trim() || key.length > 4000) throw new Error("Enter the API key.");
      await api.post(path + "/key", { key: key.trim() });
      return { done: true };
    }
    const { data: info } = await api.get("/api/integration/" + encodeURIComponent(serviceId));
    const chosen = (info.methods ?? []).find((m) => m.type === "oauth" && m.id === method);
    if (!chosen) throw new Error("This sign-in is no longer offered. Look the service up again.");
    // A sign-in that asks a question first gets its usual answer (the public service, the default server).
    const answer = Object.fromEntries((chosen.form ?? []).filter((f) => !f.when?.length).map((f) => [f.key, f.default ?? f.options?.[0]?.value]).filter(([, value]) => value !== undefined));
    const { data: attempt } = await api.post(path + "/oauth", { methodID: chosen.id, ...(Object.keys(answer).length && { answer }) });
    if (!/^https:\/\//i.test(attempt.url)) throw new Error("OpenCode offered a sign-in page that isn't secure.");
    await open(attempt.url);
    if (attempt.mode === "code") return { code: { attempt: attempt.attemptID, instructions: attempt.instructions || "Paste the code the page shows." } };
    const state = { cancelled: false };
    this.attempts.set(serviceId, state);
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        if (state.cancelled) {
          await api.delete(path + "/oauth/" + attempt.attemptID).catch(() => {});
          throw new Error("Sign-in cancelled.");
        }
        const { data: status } = await api.get(path + "/oauth/" + attempt.attemptID);
        if (status.status === "complete") return { done: true, ...(attempt.instructions && { instructions: attempt.instructions }) };
        if (status.status === "failed") throw new Error(status.message || "Sign-in didn't finish.");
        if (status.status === "expired") throw new Error("The sign-in page expired. Try again.");
      }
    } finally {
      this.attempts.delete(serviceId);
    }
  }
  /** Finishes a sign-in whose page gave the person a code. */
  async finishService(serviceId, attempt, code) {
    if (typeof code !== "string" || !code.trim()) throw new Error("Paste the code the page shows.");
    await (await this.server()).post("/api/integration/" + encodeURIComponent(serviceId) + "/connect/oauth/" + encodeURIComponent(attempt) + "/complete", { code: code.trim() });
    return { done: true };
  }
  async cancelService(serviceId) {
    const state = this.attempts.get(serviceId);
    if (state) state.cancelled = true;
  }
  /** Removes what OpenCode stored for a service: its key or its sign-in. */
  async disconnectService(serviceId) {
    const api = await this.server();
    const { data = [] } = await api.get("/api/credential");
    const mine = data.filter((c) => c.integrationID === serviceId);
    if (!mine.length) throw new Error("This service is connected outside OpenCode (in the computer's environment), so it can't be removed here.");
    for (const credential of mine) await api.delete("/api/credential/" + encodeURIComponent(credential.id));
  }

  async models() {
    const api = await this.server();
    const [{ data: models = [] }, { data: providers = [] }, preferred] = await Promise.all([
      api.get("/api/model", undefined, SLOW),
      api.get("/api/provider", undefined, SLOW),
      api.get("/api/model/default", undefined, SLOW).then((r) => r.data, () => null),
    ]);
    const names = new Map(providers.map((p) => [p.id, p.name]));
    return models
      // Chat needs a model that writes text and can call tools; image, audio and embedding models are left out.
      .filter((m) => m.enabled !== false && m.status !== "deprecated" && m.capabilities?.tools && (m.capabilities.output ?? []).includes("text"))
      .map((m) => ({
        id: m.providerID + "/" + m.id,
        name: m.name || m.id,
        provider: this.id,
        group: names.get(m.providerID) ?? m.providerID,
        efforts: (m.variants ?? []).map((v) => v.id).filter((id) => id && id !== "default"),
        // What OpenCode's listing says: the model's limits and what it takes.
        ...modelDetails({ contextWindow: m.limit?.context, maxPrompt: m.limit?.input, maxOutput: m.limit?.output, vision: Array.isArray(m.capabilities?.input) ? m.capabilities.input.includes("image") : undefined, tools: m.capabilities?.tools }),
        ...(preferred && preferred.id === m.id && preferred.providerID === m.providerID && { recommended: true }),
        available: true,
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  }
  async version() {
    if (this.connect) return "OpenCode " + ((await (await this.server()).get("/api/info")).version ?? "");
    const file = await this.locate();
    if (!file) return "OpenCode";
    return "OpenCode " + versionOf((await run(file, ["--version"], { env: await cliEnv() })).stdout);
  }

  // Sessions
  async openSession(spec) {
    return new OpenCodeSession(this, spec);
  }
  async deleteSession(sessionId) {
    const record = this.sessions.get(sessionId);
    this.bridge?.forget(this.id + ":" + sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
    await (await this.server()).delete("/api/session/" + record.ref).catch(() => {});
  }
  /** Copies a conversation into a new session. `toEventId` is the person's message the copy stops before. */
  async forkSession(sessionId, { toEventId } = {}) {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    const { data } = await (await this.server()).post("/api/session/" + record.ref + "/fork", { ...(toEventId && { before: toEventId }) });
    const id = randomUUID();
    this.sessions.set(id, { ref: data.id });
    return id;
  }
}
