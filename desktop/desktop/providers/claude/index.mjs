// Claude as a Botkins model provider, on the Claude Agent SDK.
// This folder is the only code that imports the SDK.
//
// The SDK drives Claude Code: the copy the person installed when there is one (so its sign-in and
// version are the ones they already use), else the copy that ships with the SDK. Signing in is
// Claude Code's own `claude auth login`, which opens the browser; the person's Claude plan pays
// for the models and Botkins never sees a password or a token.
//
// A Botkins session is a Claude Code session. Claude Code only takes UUIDs as session ids, so
// sessions.json remembers which one belongs to which Botkins session, and the message ids a
// fork needs. Botkins' own tools reach Claude through the tool bridge
// (desktop/providers/toolbridge.mjs), as an MCP server named "botkins".
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { cliEnv, findBinary, run, versionOf } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { SessionStore, mcpText, missingConversation, serversWithTokens, transcriptContext, uuidFor } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";
import { env } from "../../home.mjs";
import { ReportedLimits, claudeModelId, claudePublished, modelDetails } from "../../modeldetails.mjs";
import { claudePlan, claudeUsage } from "../../providerusage.mjs";

/** The bridge's name among a session's MCP servers. Its tools are Botkins' own and never ask. */
export const BRIDGE = "botkins";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// A Claude Code session that started Botkins exports these; a child given them would act as part of it.
const HOST_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];
// Commands that only make sense in Claude Code's own terminal screen, or that Botkins answers itself.
const NOT_OFFERED = new Set([
  "clear", "new", "compact", "config", "settings", "help", "login", "logout", "model", "permissions", "resume", "agents", "theme", "vim", "exit", "quit",
  "status", "statusline", "terminal-setup", "ide", "doctor", "upgrade", "bug", "feedback", "release-notes", "mcp", "plugin", "plugins", "hooks", "memory",
  "add-dir", "export", "copy", "btw", "fast", "output-style", "privacy-settings", "install-github-app", "migrate-installer", "todos", "tasks", "rewind",
]);

/** How Botkins' approval levels run in Claude Code. Plan mode wins over all of them. */
export function permissionSettings(approval, mode) {
  if (mode === "plan") return { permissionMode: "plan" };
  if (approval === "all") return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  // Auto mode has Claude Code judge each request itself and ask when it is unsure.
  if (approval === "assisted") return { permissionMode: "auto" };
  return { permissionMode: "default" };
}

/** A Botkins MCP server record as the SDK's. */
function sdkServer(server) {
  if (server.type === "stdio") return { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env && { env: server.env }) };
  return { type: server.type === "sse" ? "sse" : "http", url: server.url, ...(server.headers && { headers: server.headers }) };
}

/** A tool request in Botkins' neutral terms (desktop/providers/provider.mjs). */
export function describeRequest(toolName, input, hints = {}) {
  const base = { toolName, detail: displayValue({ tool: toolName, input, reason: hints.decisionReason, path: hints.blockedPath }, Infinity), sandboxEscape: !!hints.blockedPath, managed: false };
  const title = hints.title || undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp)
    return { ...base, kind: "mcp", toolName: mcp[2], title: title ?? "Use " + mcp[1] + " / " + mcp[2] + "?", label: mcp[1] + " / " + mcp[2], preview: displayValue(input, Infinity), remember: ["MCP tool " + mcp[1] + "/" + mcp[2], mcp[1], mcp[2]], readOnly: false };
  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "PowerShell":
      return { ...base, kind: "shell", title: title ?? input.description ?? "Run this command?", label: "Shell command", preview: String(input.command ?? ""), remember: input.command ? ["this exact command", String(input.command)] : null, readOnly: false };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = String(input.file_path ?? input.notebook_path ?? "");
      const preview = input.content ?? (input.old_string !== undefined ? "- " + input.old_string + "\n+ " + (input.new_string ?? "") : displayValue(input, Infinity));
      return { ...base, kind: "write", title: title ?? "Change this file?", label: path || "File change", preview: String(preview), remember: path ? ["writes to this path", path] : null, readOnly: false };
    }
    case "Read":
    case "Glob":
    case "Grep":
    case "LS": {
      const path = String(input.file_path ?? input.path ?? input.pattern ?? "");
      return { ...base, kind: "read", title: title ?? "Read this?", label: "Read file", preview: path, remember: path ? ["reads of this path", path] : null, readOnly: true };
    }
    case "WebFetch":
      return { ...base, kind: "url", title: title ?? "Open this web page?", label: "Open URL", preview: String(input.url ?? ""), remember: input.url ? ["this URL", String(input.url)] : null, readOnly: true };
    default:
      return { ...base, kind: "custom-tool", title: title ?? "Use " + (hints.displayName || toolName) + "?", label: hints.displayName || toolName, preview: displayValue(input, Infinity), remember: ["tool " + toolName, toolName], readOnly: toolName === "WebSearch" };
  }
}

const resultText = (content) => (typeof content === "string" ? content : mcpText({ content }));

/**
 * A project folder's own instructions for a coding chat: its CLAUDE.md (or AGENTS.md), as text
 * for the system prompt. Botkins reads the file itself. Letting Claude Code load the folder's
 * settings would also load its permission rules and hooks, and a folder someone else wrote could
 * then approve its own commands.
 */
export function projectInstructions(folder) {
  for (const file of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "AGENTS.md"]) {
    try {
      const text = readFileSync(join(folder, file), "utf8").trim();
      if (text) return "\n\nThe project folder has its own instructions, in " + file + ":\n<project-instructions>\n" + text.slice(0, 40000) + "\n</project-instructions>";
    } catch {
      // No such file here.
    }
  }
  return "";
}
/** True when version `have` is older than `need` ("2.1.325" against "2.1.327"). An unknown version counts as older. */
function older(have, need) {
  const parts = (v) => String(v ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  if (!have) return true;
  const [a, b] = [parts(have), parts(need)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

class ClaudeSession extends ProviderSession {
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
    this.tasks = new Map();
    this.todoList = null;
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(type, data, id, agentId) {
    for (const handler of this.handlers) handler({ type, data, ...(id && { id }), ...(agentId && { agentId }) });
  }
  /** The Claude Code session behind this one: its record, and whether it holds a conversation to resume. */
  async target() {
    const { provider, spec } = this;
    const record = provider.sessions.get(spec.sessionId) ?? { ref: uuidFor(spec.sessionId), dir: spec.folder, turns: [] };
    // Asked of Claude Code itself: a first turn that failed may or may not have saved a session.
    return { record, exists: await this.exists(record) };
  }
  async exists(record) {
    try {
      return !!(await (await this.provider.sdk()).getSessionInfo(record.ref, { dir: record.dir }));
    } catch {
      return false;
    }
  }
  /** The SDK options every query of this session shares. */
  async options(extra = {}) {
    const { provider, spec } = this;
    const servers = Object.fromEntries(Object.entries(await serversWithTokens(spec)).filter(([name]) => name !== BRIDGE).map(([name, server]) => [name, sdkServer(server)]));
    // Botkins' tools are always in the prompt: looking them up first would cost a model call every turn.
    if (this.bridge) servers[BRIDGE] = { type: "http", url: this.bridge.url, headers: this.bridge.headers, alwaysLoad: true };
    const effort = this.model.reasoningEffort;
    const binary = await provider.locate();
    // What Claude Code says this model can do; unknown models get the plain options.
    const info = ((await provider.capabilities().catch(() => null))?.models ?? []).find((m) => m.value === this.model.model);
    return {
      cwd: spec.folder,
      env: await provider.env(),
      ...(binary && { pathToClaudeCodeExecutable: binary }),
      model: this.model.model,
      ...(info?.supportsFastMode && this.model.fastMode === "fast" && { settings: { fastMode: true } }),
      ...(EFFORTS.includes(effort) && (!info || (info.supportedEffortLevels ?? []).includes(effort)) && { effort }),
      // Thinking streams as short summaries; without this a model that thinks shows nothing while it does.
      ...(info?.supportsAdaptiveThinking && { thinking: { type: "adaptive", display: "summarized" } }),
      includePartialMessages: true,
      // Botkins supplies instructions, tools and MCP servers itself. No settings file is read:
      // not the person's own, and not a project folder's, whose permission rules and hooks would
      // otherwise decide what runs without asking. A coding chat's CLAUDE.md is read by Botkins
      // (projectInstructions).
      settingSources: [],
      // The same goes for the skills in the person's own Claude Code: a bot has Botkins' (this.skills).
      skills: [],
      strictMcpConfig: true,
      mcpServers: servers,
      // Server addresses and their secrets go to Claude Code over its input, not on its command line.
      mcpServersDelivery: (await provider.sendsServersOnInput()) ? "initialize" : "argv",
      persistSession: !spec.temporary,
      ...permissionSettings(spec.approval, this.mode),
      ...extra,
    };
  }

  /**
   * Sends one message. There is no time limit: the person stops a turn that runs long, and Claude
   * Code's process ending (it exits, or its stream closes) ends the turn. `timeoutMs` is for a
   * caller with nobody to stop it, such as a background summary.
   */
  async send(message, timeoutMs) {
    if (this.turn) throw new Error("This conversation is already working.");
    const { provider, spec } = this;
    const { query } = await provider.sdk();
    this.bridge ??= await provider.bridge.open(spec.handlers ? [...spec.tools, ...this.skills.tools] : []);
    const { record, exists } = await this.target();
    const abort = new AbortController();
    const turn = (this.turn = { text: [], streamed: 0, seen: 0, any: false, live: null, last: null, abort, userId: randomUUID(), failure: "", stderr: "", context: 0 });
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const prompt =
      message.prompt + ((message.attachments ?? []).length ? "\n\nAttached:\n" + message.attachments.map((a) => "- " + a.path + (a.kind === "directory" ? " (folder)" : "")).join("\n") : "");
    // Approvals need the channel to Claude Code kept open, so the message goes in as a stream that
    // stays open until the reply is complete.
    const input = (async function* () {
      yield { type: "user", uuid: turn.userId, session_id: "", parent_tool_use_id: null, message: { role: "user", content: prompt } };
      await held;
    })();
    // A conversation Claude Code doesn't hold continues from Botkins' own transcript.
    const lost = !exists && spec.established && spec.hasReplies ? transcriptContext(spec) : "";
    const options = await this.options({
      abortController: abort,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: spec.instructions + this.skills.instructions + (spec.coding ? projectInstructions(spec.folder) : "") + (spec.context ?? "") + lost,
      },
      ...(exists ? { resume: record.ref } : { sessionId: record.ref }),
      ...(spec.handlers && {
        canUseTool: (toolName, toolInput, hints) => this.decide(toolName, toolInput, hints),
        onElicitation: async (request) => {
          const reply = await spec.handlers.form({ message: request.message, requestedSchema: request.requestedSchema, mode: request.mode === "url" ? "url" : "form", url: request.url });
          return reply?.action === "accept" ? { action: "accept", content: reply.content ?? {} } : { action: "cancel" };
        },
      }),
      stderr: (text) => (turn.stderr = (turn.stderr + text).slice(-4000)),
    });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        turn.timeout = Object.assign(new Error("Claude didn't finish in time."), {code:"BOTKINS_TURN_TIMEOUT"});
        abort.abort();
      }, timeoutMs);
      timer.unref?.();
    }
    let result;
    const q = (turn.query = query({ prompt: input, options }));
    try {
      this.emit("user.message", {}, turn.userId);
      // Read by hand: leaving a `for await` early would wait for Claude Code to exit before the reply is returned.
      const events = q[Symbol.asyncIterator]();
      for (;;) {
        const { value: event, done } = await events.next();
        if (done) break;
        this.received(event);
        if (event.type === "result") {
          result = event;
          break;
        }
      }
    } catch (error) {
      if (turn.timeout) throw turn.timeout;
      if (!turn.stopped) throw new Error(turn.failure || this.problem(error, turn.stderr));
    } finally {
      clearTimeout(timer);
      release();
      try {
        q.close?.();
      } catch {
        // Already closed.
      }
      this.turn = null;
    }
    if (!spec.temporary && (result || turn.last)) {
      const turns = [...(provider.sessions.get(this.id)?.turns ?? record.turns ?? []), { user: turn.userId, last: turn.last }].slice(-400);
      provider.sessions.set(this.id, { ref: record.ref, dir: spec.folder, turns });
    }
    const text = turn.text.map((t) => t.trim()).filter(Boolean).join("\n\n");
    if (turn.stopped) return { text };
    if (turn.timeout) throw turn.timeout;
    if (!result) throw new Error(turn.failure || "Claude stopped before it finished this reply.");
    this.report(result, turn);
    if (result.subtype !== "success" || (result.is_error && !text))
      throw new Error(turn.failure || (result.errors ?? []).join(" ") || (typeof result.result === "string" && result.result) || "Claude couldn't finish this reply.");
    return { text: text || (typeof result.result === "string" ? result.result.trim() : "") };
  }
  /** A plain sentence for a failure of the Claude Code process. */
  problem(error, stderr) {
    const text = String(stderr || "") + " " + String(error?.message ?? error);
    if (/authentication_failed|not logged in|invalid api key|oauth token|please run \/login|unauthorized/i.test(text)) return "Claude isn't signed in. Open Settings › Model providers and sign in to Claude.";
    if (/ENOENT|not found on PATH|native binary/i.test(text) && !/session/i.test(text)) return "Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup and try again.";
    const last = String(stderr || "").trim().split("\n").filter(Boolean).at(-1);
    return last ? "Claude Code stopped: " + last.slice(0, 400) : "Claude Code stopped: " + String(error?.message ?? error).slice(0, 400);
  }
  /** One message from the SDK's stream. */
  received(event) {
    const turn = this.turn;
    if (!turn) return;
    const agentId = event.parent_tool_use_id || undefined;
    switch (event.type) {
      case "stream_event": {
        const e = event.event;
        if (e.type === "content_block_start") {
          turn.live = e.content_block?.type === "thinking" ? { kind: "thinking", id: randomUUID() } : e.content_block?.type === "text" ? { kind: "text", any: false } : null;
        } else if (e.type === "content_block_delta" && turn.live) {
          if (e.delta?.type === "text_delta" && turn.live.kind === "text" && e.delta.text) {
            if (!agentId) {
              // Several messages in a turn read as paragraphs of one reply.
              if (!turn.live.any) {
                if (turn.any) this.emit("assistant.message_delta", { deltaContent: "\n\n" });
                turn.streamed++;
              }
              turn.live.any = turn.any = true;
            }
            this.emit("assistant.message_delta", { deltaContent: e.delta.text }, undefined, agentId);
          } else if (e.delta?.type === "thinking_delta" && turn.live.kind === "thinking" && e.delta.thinking)
            this.emit("assistant.reasoning_delta", { reasoningId: turn.live.id, deltaContent: e.delta.thinking }, undefined, agentId);
        } else if (e.type === "content_block_stop") {
          if (turn.live?.kind === "thinking") this.emit("assistant.reasoning", { reasoningId: turn.live.id }, undefined, agentId);
          turn.live = null;
        }
        return;
      }
      case "assistant": {
        if (event.error) turn.failure = event.error === "authentication_failed" ? "Claude isn't signed in. Open Settings › Model providers and sign in to Claude." : turn.failure;
        if (!agentId && event.uuid) turn.last = event.uuid;
        const usage = event.message?.usage;
        if (!agentId && usage) turn.context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text && !agentId) {
            turn.text.push(block.text);
            // A message that didn't stream (partial messages off, or dropped) is shown whole.
            if (++turn.seen > turn.streamed) {
              this.emit("assistant.message_delta", { deltaContent: (turn.any ? "\n\n" : "") + block.text });
              turn.streamed = turn.seen;
              turn.any = true;
            }
          } else if (block.type === "tool_use") this.toolStarted(block, agentId);
        }
        return;
      }
      case "user": {
        if (!agentId && event.uuid && !event.isSynthetic) turn.last = event.uuid;
        const content = event.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== "tool_result") continue;
          const text = resultText(block.content);
          this.emit("tool.execution_complete", { toolCallId: block.tool_use_id, success: !block.is_error, ...(text && { result: { content: text } }), ...(block.is_error && { error: { message: text || "Failed" } }) }, undefined, agentId);
          if (this.tasks.has(block.tool_use_id)) {
            this.tasks.delete(block.tool_use_id);
            this.emit(block.is_error ? "subagent.failed" : "subagent.completed", { toolCallId: block.tool_use_id, ...(block.is_error ? { error: text } : { result:text }) });
          }
        }
        return;
      }
    }
  }
  toolStarted(block, agentId) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name);
    const own = mcp?.[1] === BRIDGE;
    this.emit(
      "tool.execution_start",
      {
        toolCallId: block.id,
        toolName: mcp ? mcp[2] : block.name,
        arguments: block.input ?? {},
        ...(mcp && !own && { mcpServerName: mcp[1], mcpToolName: mcp[2] }),
      },
      undefined,
      agentId,
    );
    if ((block.name === "Agent" || block.name === "Task") && !agentId) {
      this.tasks.set(block.id, true);
      this.emit("subagent.started", { toolCallId: block.id, agentName: block.input?.subagent_type || block.input?.name || "Helper", agentDescription: block.input?.description, ...(block.input?.prompt && {prompt:block.input.prompt}) });
    }
    if (block.name === "TodoWrite" && Array.isArray(block.input?.todos) && !agentId) {
      this.todoList = block.input.todos.map((t, i) => ({ id: String(i + 1), title: t.content, status: t.status }));
      this.emit("session.todos_changed", {});
    }
  }
  /** Token use and the context window, from the result that ends a turn. */
  report(result, turn) {
    const usage = result.usage ?? {};
    const models = Object.entries(result.modelUsage ?? {});
    this.provider.noteLimits(result.modelUsage);
    const main = models.find(([name]) => name.includes(this.model.model)) ?? models[0];
    this.emit("assistant.usage", {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      // A plan isn't billed by the token; a cost is only shown for a metered account.
      ...(this.provider.metered && typeof result.total_cost_usd === "number" && { cost: result.total_cost_usd }),
      duration: result.duration_ms,
      model: main?.[0] ?? this.model.model,
    });
    if (main?.[1]?.contextWindow && turn.context) this.emit("session.usage_info", { currentTokens: turn.context, tokenLimit: main[1].contextWindow });
  }
  /** Answers one of Claude Code's permission prompts through this turn's handlers. */
  async decide(toolName, input, hints = {}) {
    const handlers = this.spec.handlers;
    const deny = (message) => ({ behavior: "deny", message });
    if (!handlers || !this.turn) return deny("This turn is no longer active.");
    // Botkins' own tools never ask.
    if (toolName.startsWith("mcp__" + BRIDGE + "__")) return { behavior: "allow", updatedInput: input };
    try {
      if (toolName === "AskUserQuestion") {
        const answers = {};
        for (const q of input.questions ?? []) {
          const reply = await handlers.question({ question: q.question, choices: (q.options ?? []).map((o) => o.label), allowFreeform: true });
          answers[q.question] = reply.answer;
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
      if (toolName === "ExitPlanMode") {
        const reply = await handlers.planExit({ summary: "The plan is ready. Carry it out?", planContent: String(input.plan ?? ""), actions: ["Carry out the plan"] });
        if (!reply?.approved) return deny(reply?.feedback ? "The person wants changes to the plan: " + reply.feedback : "The person didn't approve the plan. Ask what to change.");
        this.mode = "interactive";
        return { behavior: "allow", updatedInput: input };
      }
      const answer = await handlers.permission(describeRequest(toolName, input, hints));
      return answer?.allow ? { behavior: "allow", updatedInput: input } : deny("The person declined this request.");
    } catch (error) {
      return deny(error.message || "The request was dismissed.");
    }
  }

  async abort() {
    const turn = this.turn;
    if (!turn) return;
    turn.stopped = true;
    // Interrupt lets Claude Code save where it stopped; if it doesn't answer, the process is ended.
    const hard = setTimeout(() => turn.abort.abort(), 3000);
    hard.unref?.();
    try {
      await turn.query?.interrupt?.();
    } catch {
      turn.abort.abort();
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    if (this.turn) {
      this.turn.stopped = true;
      this.turn.abort.abort();
    }
    this.bridge?.close();
  }
  async currentModel() {
    return { model: this.model.model, reasoningEffort: this.model.reasoningEffort };
  }
  /** The next turn runs on the new model: each turn names its own. */
  async switchModel(selection) {
    this.model = { ...selection };
  }
  async setMode(mode) {
    this.mode = mode === "plan" ? "plan" : "interactive";
    return true;
  }
  /** Runs one prompt against a copy of the conversation that is never saved, and returns the reply. */
  async aside(prompt, extra = {}) {
    const { query } = await this.provider.sdk();
    const { record, exists } = await this.target();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 180000);
    timer.unref?.();
    let text = "";
    try {
      const options = await this.options({
        abortController: abort,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.spec.instructions + (this.spec.context ?? "") },
        ...(exists && { resume: record.ref, forkSession: true }),
        persistSession: false,
        mcpServers: {},
        permissionMode: "dontAsk",
        ...extra,
      });
      const q = query({ prompt, options });
      const events = q[Symbol.asyncIterator]();
      for (;;) {
        const { value: event, done } = await events.next();
        if (done) break;
        if (event.type === "assistant" && !event.parent_tool_use_id) for (const block of event.message?.content ?? []) if (block.type === "text") text += (text ? "\n\n" : "") + block.text;
        if (event.type === "result") {
          if (!text && typeof event.result === "string") text = event.result;
          break;
        }
      }
      q.close?.();
    } finally {
      clearTimeout(timer);
    }
    return text.trim();
  }
  async sideQuestion(question) {
    const answer = await this.aside(question, { maxTurns: 1 });
    if (!answer) throw new Error("Claude returned an empty side answer.");
    return answer;
  }
  /** Claude Code's own /compact, run in the real conversation. */
  async compact() {
    const { query } = await this.provider.sdk();
    const { record, exists } = await this.target();
    if (!exists) return;
    const options = await this.options({ resume: record.ref, mcpServers: {}, permissionMode: "dontAsk", systemPrompt: { type: "preset", preset: "claude_code", append: this.spec.instructions } });
    for await (const event of query({ prompt: "/compact", options })) if (event.type === "result") break;
  }
  async todos() {
    return this.todoList ? { rows: this.todoList, dependencies: [] } : null;
  }
  async inventory() {
    let servers = Object.keys(this.spec.mcpServers ?? {}).map((name) => ({ name, status: "not started" }));
    // A test of one MCP server (a temporary session) asks Claude Code to connect and say what it found.
    if (this.spec.temporary && servers.length) servers = await this.provider.serverStatus(await this.options({ systemPrompt: "" }), servers);
    return buildInventory({ name: this.provider.name, tools: this.spec.tools, servers, native: [...skillChoices(this.skills.list), ...(await this.provider.commands())], compact: true });
  }
  resolvePrompt(prompt, run, chat, host) {
    return resolvePrompt(this, prompt, run, chat, host);
  }
}

export class ClaudeProvider extends ModelProvider {
  id = "claude";
  name = "Claude";
  description = "Your Claude plan, through Claude Code.";
  /**
   * @param options.dataDir  Where the session records are kept. Omit to keep them in memory.
   * @param options.bridge   The tool bridge Botkins' tools are offered through.
   * @param options.binary   A path to Claude Code, instead of looking for `claude`.
   * @param options.sdk      For tests: an object shaped like the Claude Agent SDK module.
   * @param options.cli      For tests: async (args) => { code, stdout, stderr } instead of running Claude Code.
   */
  constructor({ dataDir, bridge, binary, sdk, cli } = {}) {
    super();
    Object.assign(this, { bridge, binary, fakeSdk: sdk, fakeCli: cli });
    this.sessions = new SessionStore(dataDir && join(dataDir, "sessions.json"));
    // Each model's limits as Claude Code reported them after a turn.
    this.reported = new ReportedLimits(dataDir && join(dataDir, "model-limits.json"));
    this.catalog = null;
    this.login = null;
    this.metered = false;
  }
  sdk() {
    this.module ??= this.fakeSdk ? Promise.resolve(this.fakeSdk) : import("@anthropic-ai/claude-agent-sdk");
    return this.module;
  }
  /**
   * Claude Code as the person installed it, else the copy that ships with the SDK, else null.
   * When both are here and the installed one is older than the SDK expects, the SDK's copy is used.
   */
  async locate() {
    if (this.fakeSdk) return null;
    this.located ??= (async () => {
      const override = this.binary || env("CLAUDE_BINARY");
      const installed = await findBinary("claude", { override });
      let bundled = null;
      let wanted = "";
      try {
        // The SDK doesn't export its package.json, so it is read from beside the SDK's entry file.
        const sdk = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
        wanted = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).claudeCodeVersion ?? "";
        const file = join(sdk, "..", "claude-agent-sdk-" + process.platform + "-" + process.arch, process.platform === "win32" ? "claude.exe" : "claude");
        if (existsSync(file)) bundled = file;
      } catch {
        // The SDK's own copy isn't part of this build.
      }
      if (!installed) return bundled ? { file: bundled, current: true } : null;
      const version = await run(installed, ["--version"], { env: await this.env(), timeoutMs: 15000 }).then(({ stdout }) => versionOf(stdout), () => "");
      // An older Claude Code can't take MCP servers on its input (see sendsServersOnInput).
      const current = !!wanted && !older(version, wanted);
      if (!current && bundled && !override) return { file: bundled, current: true };
      // A version that couldn't be read is asked for again next time, not remembered.
      return { file: installed, current, retry: !version };
    })();
    const found = await this.located;
    // Not found is looked up again next time: the person may have just installed it.
    if (!found || found.retry) this.located = null;
    return found?.file ?? null;
  }
  /**
   * A Claude Code at least as new as the one the SDK ships with reads MCP servers from the SDK's
   * first message. An older one only takes them as an argument, where another user of the
   * computer could read a server's secret; it is still used that way rather than not at all.
   */
  async sendsServersOnInput() {
    if (this.fakeSdk) return true;
    await this.locate();
    return !!(await this.located)?.current;
  }
  async env() {
    const env = await cliEnv({
      CLAUDE_CODE_ENTRYPOINT: "botkins",
      // Botkins supplies a bot's MCP servers itself. The connectors of the person's claude.ai
      // account and a running editor are left alone: waiting for them made every turn start slowly.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    });
    for (const name of HOST_VARIABLES) delete env[name];
    return env;
  }
  async cli(args, options) {
    if (this.fakeCli) return this.fakeCli(args);
    const file = await this.locate();
    if (!file) throw new Error("Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup and try again.");
    return run(file, args, { env: await this.env(), ...options });
  }
  async stop() {
    this.login?.kill();
  }

  // Account
  async status() {
    if (!this.fakeCli && !(await this.locate()))
      return {
        installed: false,
        connected: false,
        signIn: "browser",
        signOut: false,
        message: "Install Claude Code to use your Claude plan.",
        install: { url: "https://code.claude.com/docs/en/setup", command: "curl -fsSL https://claude.ai/install.sh | bash" },
      };
    const [{ stdout }, version] = await Promise.all([this.cli(["auth", "status", "--json"]), this.cli(["--version"]).catch(() => ({ stdout: "" }))]);
    let info;
    try {
      info = JSON.parse(stdout.slice(stdout.indexOf("{")));
    } catch {
      // Not an answer about signing in: reported as a problem, never as "signed out".
      throw new Error("Claude Code didn't say whether it is signed in. Update Claude Code and try again.");
    }
    const base = { installed: true, version: versionOf(version.stdout), signIn: "browser" };
    if (!info.loggedIn) return { ...base, connected: false, signOut: false, message: "Sign in with your Claude account." };
    // Only a claude.ai sign-in is a plan; an API key or a cloud provider is billed by use.
    this.metered = info.authMethod !== "claude.ai";
    return {
      ...base,
      connected: true,
      signOut: info.authMethod === "claude.ai" || info.authMethod === "console",
      account: info.email || undefined,
      plan:
        info.apiProvider && info.apiProvider !== "firstParty"
          ? "Claude on " + info.apiProvider
          : info.authMethod === "claude.ai"
            ? claudePlan(info.subscriptionType, info.planTier)
            : "Anthropic API",
    };
  }
  async auth() {
    const status = await this.status();
    return { connected: status.connected, login: status.account, type: status.plan };
  }
  /**
   * The plan and what is left of its limits, as Claude Code's own /usage reads them from Anthropic
   * with its own sign-in. Claude Code is started without a prompt for it, so nothing is used from
   * the plan, and the scan of the person's transcripts that /usage also does is skipped.
   */
  async usage() {
    const status = await this.status();
    if (!status.connected) throw new Error("Claude Code isn't signed in.");
    if (this.metered) return { account: "api-key", limits: [], source: "Claude Code" };
    const reply = await this.probe((q) => {
      // The SDK says this call's name will change when it is no longer experimental.
      const ask = q.getUsage ?? q.usage ?? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      return typeof ask === "function" ? ask.call(q, { skipBehaviors: true }) : null;
    });
    if (!reply) return { account: "subscription", plan: status.plan, limits: [], note: "This version of Claude Code doesn't report plan limits.", source: "Claude Code" };
    return { ...claudeUsage(reply), plan: status.plan, source: "Claude Code" };
  }
  /** Claude Code's own sign-in. It opens the browser itself and ends when the person is done. */
  async signIn() {
    if (this.login) throw new Error("A sign-in is already in progress.");
    if (this.fakeCli) return void (await this.fakeCli(["auth", "login"]));
    const file = await this.locate();
    if (!file) throw new Error("Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup and try again.");
    const child = (this.login = spawn(file, ["auth", "login", "--claudeai"], { env: await this.env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
    child.stdin.on("error", () => {});
    let output = "";
    const collect = (chunk) => (output = (output + chunk).slice(-4000));
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      if (child.cancelled) throw new Error("Sign-in cancelled.");
      if (code !== 0) throw new Error("Sign-in didn't finish. " + (output.trim().split("\n").filter((l) => !/https?:\/\//.test(l)).at(-1) ?? "").slice(0, 300));
    } finally {
      clearTimeout(timer);
      this.login = null;
      this.catalog = null;
    }
    if (!(await this.status()).connected) throw new Error("Sign-in didn't finish. Try again.");
  }
  async cancelSignIn() {
    const child = this.login;
    if (!child) return;
    child.cancelled = true;
    child.kill();
  }
  async signOut() {
    const { code, stderr } = await this.cli(["auth", "logout"]);
    this.catalog = null;
    if (code !== 0) throw new Error("Claude didn't sign out. " + stderr.trim().slice(0, 300));
  }

  /**
   * What Claude Code says it offers: models and commands. It is asked with a prompt that never
   * sends anything, so no request reaches Anthropic and nothing is used from the plan.
   */
  capabilities() {
    const fresh = this.catalog && Date.now() - this.catalog.time < 10 * 60 * 1000;
    if (!fresh) {
      const loading = this.probe((q) => q.initializationResult());
      this.catalog = { time: Date.now(), loading };
      loading.catch(() => this.catalog?.loading === loading && (this.catalog = null));
    }
    return this.catalog.loading;
  }
  /** Starts Claude Code without a prompt, runs `ask` on the open query, and closes it. */
  async probe(ask, options = {}) {
    const { query } = await this.sdk();
    const abort = new AbortController();
    const binary = await this.locate();
    const q = query({
      prompt: (async function* () {
        await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
      })(),
      options: {
        env: await this.env(),
        ...(binary && { pathToClaudeCodeExecutable: binary }),
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        mcpServersDelivery: (await this.sendsServersOnInput()) ? "initialize" : "argv",
        persistSession: false,
        ...options,
        abortController: abort,
      },
    });
    const timer = setTimeout(() => abort.abort(), 60000);
    try {
      return await ask(q);
    } finally {
      clearTimeout(timer);
      abort.abort();
      try {
        q.close?.();
      } catch {
        // Already closed.
      }
    }
  }
  async models() {
    const { models = [] } = await this.capabilities();
    // "default" is Claude Code's own pick; Botkins lists the model it stands for once, marked.
    const recommended = models.find((m) => m.value === "default")?.resolvedModel;
    const seen = new Set();
    return models
      .filter((m) => m.value !== "default")
      .filter((m) => !seen.has(m.resolvedModel ?? m.value) && seen.add(m.resolvedModel ?? m.value))
      .map((m) => ({
        id: m.value,
        name: /^claude/i.test(m.displayName) ? m.displayName : "Claude " + m.displayName,
        provider: this.id,
        ...(m.supportsFastMode && { fastModes: { fast: "fast" } }),
        efforts: m.supportsEffort === false ? [] : [...(m.supportedEffortLevels ?? [])],
        // Claude Code's list has its own line about a model and no numbers. The limits are the ones
        // Claude Code reported for the model on this person's plan, and until it has, Anthropic's
        // published ones.
        // Claude Code lists the models that can run Claude Code, which works by calling tools.
        ...modelDetails({ description: m.description, tools: true, ...claudePublished(m.resolvedModel ?? m.value), ...this.reported.for(claudeModelId(m.resolvedModel ?? m.value)) }),
        ...(recommended && (m.resolvedModel ?? m.value) === recommended && { recommended: true }),
        available: true,
      }));
  }
  /**
   * Takes what Claude Code said about its models at the end of a turn (a result's `modelUsage`):
   * each model's window and the most it may write, on this person's plan.
   */
  noteLimits(modelUsage) {
    for (const [model, use] of Object.entries(modelUsage && typeof modelUsage === "object" ? modelUsage : {}))
      this.reported.note(claudeModelId(model), { contextWindow: use?.contextWindow, maxOutput: use?.maxOutputTokens });
  }
  /** Claude Code's own commands and skills that work without its terminal screen. */
  async commands() {
    const { commands = [] } = await this.capabilities().catch(() => ({}));
    return commands
      .filter((c) => c?.name && !NOT_OFFERED.has(c.name))
      .map((c) => ({ name: c.name, description: c.description ?? "", hint: c.argumentHint || undefined, source: "Claude" }));
  }
  /** Connects the given MCP servers in a short session and reports each one's status and tools. */
  async serverStatus(options, servers) {
    const { mcpServers } = options;
    delete mcpServers[BRIDGE];
    const found = await this.probe(
      async (q) => {
        let list = await q.mcpServerStatus();
        for (let tries = 0; tries < 30 && list.some((s) => s.status === "pending"); tries++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          list = await q.mcpServerStatus();
        }
        return list;
      },
      { mcpServers },
    ).catch(() => []);
    return servers.map((server) => {
      const status = found.find((s) => s.name === server.name);
      return status
        ? { name: server.name, status: status.status === "needs-auth" ? "needs-auth" : status.status, tools: (status.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })) }
        : { ...server, status: "failed" };
    });
  }
  async version() {
    const { stdout } = await this.cli(["--version"]);
    return "Claude Code " + versionOf(stdout) + " · Claude Agent SDK";
  }

  // Sessions
  async openSession(spec) {
    return new ClaudeSession(this, spec);
  }
  async deleteSession(sessionId) {
    const record = this.sessions.get(sessionId) ?? { ref: uuidFor(sessionId) };
    this.sessions.delete(sessionId);
    const { deleteSession } = await this.sdk();
    await deleteSession?.(record.ref, record.dir ? { dir: record.dir } : undefined).catch(() => {});
  }
  /**
   * Copies a conversation into a new session. `toEventId` is the person's message the copy stops
   * before; Claude Code forks through a message, so the copy runs through the reply before it.
   */
  async forkSession(sessionId, { toEventId } = {}) {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    let turns = record.turns ?? [];
    let upToMessageId;
    if (toEventId) {
      const index = turns.findIndex((t) => t.user === toEventId);
      upToMessageId = index > 0 ? turns[index - 1].last : null;
      if (!upToMessageId) return null;
      turns = turns.slice(0, index);
    }
    const { forkSession } = await this.sdk();
    const forked = await forkSession(record.ref, { ...(record.dir && { dir: record.dir }), ...(upToMessageId && { upToMessageId }) });
    const id = randomUUID();
    this.sessions.set(id, { ref: forked.sessionId, dir: record.dir, turns: [...turns] });
    return id;
  }
}
