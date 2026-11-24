// ChatGPT as a Botkins model provider, through the Codex CLI's app-server.
//
// Botkins starts `codex app-server` once and talks to it in JSON-RPC over its standard input
// and output. Signing in is Codex's own "Sign in with ChatGPT" (account/login/start), so the
// person's ChatGPT plan pays for the models and Botkins never sees a password or a token.
// A Botkins session is a Codex thread; sessions.json remembers which.
//
// Botkins' own tools reach Codex through the tool bridge (desktop/providers/toolbridge.mjs),
// as an MCP server named "botkins" that each thread is started with.
//
// Codex keeps a thread loaded while Botkins is subscribed to it, and a loaded thread goes on
// with the settings it was loaded with (its MCP servers, its instructions). So a conversation's
// bridge address stays the same from turn to turn, a thread stays loaded for a while after its
// last turn (the next message then starts at once), and a thread whose settings changed is
// unloaded first so that it is loaded again with the new ones.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { StdioRpc, cliEnv, findBinary, versionOf } from "../cli.mjs";
import { buildInventory, resolvePrompt } from "../commands.mjs";
import { watchQuiet } from "../liveness.mjs";
import { SessionStore, mcpText, missingConversation, serversWithTokens, transcriptContext } from "../sessions.mjs";
import { skillChoices, skillSupport } from "../skills.mjs";
import { displayValue } from "../../display.mjs";
import { env } from "../../home.mjs";
import { ReportedLimits, modelDetails } from "../../modeldetails.mjs";
import { tierRejected } from "../../model-speed.mjs";
import { codexUsage } from "../../providerusage.mjs";

/** Translate account-specific catalog labels to the tier ids Codex accepts. */
function fastModes(model) {
  const modes = {};
  for (const tier of model.serviceTiers ?? []) {
    if (!tier?.id) continue;
    const name = String(tier.name ?? tier.id).toLowerCase().replace(/[ _-]/g, "");
    if (name === "ultrafast" || tier.id === "ultrafast") modes.ultrafast = tier.id;
    else if (name === "fast" || tier.id === "priority") modes.fast = tier.id;
  }
  // Older Codex versions report the UI name for priority rather than the wire tier.
  if (!model.serviceTiers && model.additionalSpeedTiers?.includes("fast")) modes.fast = "priority";
  return modes;
}

/** The bridge's name among a thread's MCP servers. */
export const BRIDGE = "botkins";

const PLANS = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
};
/** A ChatGPT plan's name from Codex's `planType`. */
const planName = (planType) => PLANS[planType] ?? (planType && planType !== "unknown" ? "ChatGPT " + planType : "ChatGPT");

/**
 * How Botkins' approval levels run in Codex. "ask" and "read" keep Codex in its read-only
 * sandbox, where it runs known-safe commands itself and asks for the rest; Botkins' own rules
 * then answer or ask the person. "all" turns the sandbox off, as the setting says.
 */
export function approvalSettings(approval) {
  if (approval === "all")
    return {
      // "never" would also refuse sign-in prompts from MCP servers, so only those still ask.
      approvalPolicy: { granular: { mcp_elicitations: true, request_permissions: false, rules: false, sandbox_approval: false, skill_approval: false } },
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  if (approval === "assisted")
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    };
  return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
}

/** A Botkins MCP server record as a Codex `mcp_servers` entry. */
function codexServer(server) {
  if (server.type === "stdio")
    return {
      command: server.command,
      args: server.args ?? [],
      ...(server.env && Object.keys(server.env).length && { env: server.env }),
      ...(server.workingDirectory && { cwd: server.workingDirectory }),
    };
  return { url: server.url, ...(server.headers && Object.keys(server.headers).length && { http_headers: server.headers }) };
}

/** The `config` a thread starts with: Botkins' bridge and the MCP servers from Settings. */
export function threadConfig(servers, bridge) {
  const config = {};
  for (const [name, server] of Object.entries(servers ?? {})) if (name !== BRIDGE) config["mcp_servers." + name] = codexServer(server);
  if (bridge)
    config["mcp_servers." + BRIDGE] = {
      url: bridge.url,
      http_headers: bridge.headers,
      // A teammate's whole turn can run behind one tool call.
      tool_timeout_sec: 900,
    };
  return config;
}

/** True for an https page of OpenAI's, the only kind Codex's ChatGPT sign-in opens. */
function signInPage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && /(^|\.)(openai\.com|chatgpt\.com)$/i.test(hostname);
  } catch {
    return false;
  }
}

const userInput = ({ prompt, attachments }) => [
  { type: "text", text: prompt, text_elements: [] },
  ...(attachments ?? []).map((a) =>
    a.kind !== "directory" && /\.(png|jpe?g|gif|webp)$/i.test(a.path)
      ? { type: "localImage", path: a.path }
      : { type: "mention", name: a.name, path: a.path },
  ),
];

/** One thread item as the start of a step: [toolName, arguments, mcpServerName?]. */
function describeItem(item) {
  switch (item.type) {
    case "commandExecution":
      return ["shell", { command: item.command, cwd: item.cwd }];
    case "fileChange":
      return ["apply_patch", { description: (item.changes ?? []).map((c) => c.path).join(", ") || "File change", changes: (item.changes ?? []).map(({ path, kind }) => ({ path, kind })) }];
    case "mcpToolCall":
      return [item.tool, item.arguments ?? {}, item.server === BRIDGE ? undefined : item.server];
    case "dynamicToolCall":
      return [item.tool, item.arguments ?? {}];
    case "webSearch":
      return ["web_search", { query: item.query }];
    case "imageView":
      return ["view", { path: item.path }];
    case "collabAgentToolCall":
      return ["task", { description: item.prompt ?? String(item.tool) }];
    default:
      return null;
  }
}
function itemResult(item) {
  switch (item.type) {
    case "commandExecution":
      return { success: item.status === "completed" && (item.exitCode ?? 0) === 0, content: item.aggregatedOutput ?? "", error: item.status === "declined" ? "Not approved." : item.exitCode ? "Exit code " + item.exitCode : "" };
    case "fileChange":
      return { success: item.status === "completed", content: (item.changes ?? []).map((c) => c.diff).filter(Boolean).join("\n"), error: item.status === "declined" ? "Not approved." : "" };
    case "mcpToolCall":
      return { success: item.status === "completed" && !item.error, content: mcpText(item.result), error: item.error?.message ?? "" };
    case "dynamicToolCall":
      return { success: item.success !== false, content: "", error: "" };
    case "collabAgentToolCall":
      return { success: !/fail|error/i.test(String(item.status)), content: "", error: "" };
    default:
      return { success: true, content: "", error: "" };
  }
}

class CodexSession extends ProviderSession {
  constructor(provider, spec) {
    super();
    this.provider = provider;
    this.spec = spec;
    this.id = spec.sessionId;
    this.model = { ...spec.model };
    // Botkins' skills: listed in the instructions, read through a tool on the bridge.
    this.skills = skillSupport(spec);
    this.handlers = new Set();
    this.items = new Map();
    this.plan = null;
    this.mode = "interactive";
    this.turn = null;
    this.usage = null;
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(type, data, id) {
    for (const handler of this.handlers) handler({ type, data, ...(id && { id }) });
  }
  /** Starts or resumes the thread on first need: a session that is only opened costs nothing. */
  thread() {
    this.starting ??= this.start().catch((error) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }
  async start() {
    const { provider, spec } = this;
    const rpc = await provider.rpc();
    // The address stays with the conversation: a thread that is still loaded keeps using it.
    this.bridge = await provider.bridge.open(spec.handlers ? [...spec.tools, ...this.skills.tools] : [], spec.temporary ? {} : { key: provider.id + ":" + spec.sessionId });
    const settings = approvalSettings(spec.approval);
    const params = {
      model: this.model.model,
      cwd: spec.folder,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      sandbox: settings.sandbox,
      config: {
        ...threadConfig(await serversWithTokens(spec), this.bridge),
        ...(spec.sourcesOnly && { "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false,
          "features.apps": false, "features.plugins": false, "features.computer_use": false, web_search: "disabled" }),
      },
      developerInstructions: spec.instructions + this.skills.instructions + (spec.context ?? ""),
    };
    // What a loaded thread can't take in later. The model and the approval level ride with each
    // turn; `context` (the bot's memory) is left out on purpose: the workspace releases a bot's
    // sessions when it changes.
    this.signature = createHash("sha256").update(JSON.stringify([spec.folder, spec.instructions, this.skills.instructions, params.config])).digest("hex");
    const known = spec.established && provider.sessions.get(spec.sessionId);
    let thread;
    if (known) {
      await provider.unloadIfChanged(known.ref, this.signature);
      for (let tries = 0; !thread; tries++) {
        try {
          ({ thread } = await rpc.request("thread/resume", { ...params, threadId: known.ref, excludeTurns: true }));
        } catch (error) {
          // A thread that was just unloaded takes a moment to close; Codex says to ask again.
          if (/is closing/i.test(error.message) && tries < 40) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          // Codex no longer has the thread (or the first turn failed before it saved anything): start again.
          if (!missingConversation(error)) throw error;
          break;
        }
      }
    }
    if (!thread) {
      // A conversation Codex doesn't hold continues from Botkins' own transcript.
      const lost = spec.established && spec.hasReplies ? transcriptContext(spec) : "";
      ({ thread } = await rpc.request("thread/start", {
        ...params,
        developerInstructions: params.developerInstructions + lost,
        serviceName: "botkins",
        ...(spec.temporary && { ephemeral: true }),
      }));
      if (!spec.temporary) provider.sessions.set(spec.sessionId, { ref: thread.id, turns: [] });
    }
    this.threadId = thread.id;
    // Closed while the thread was starting: it is let go again, not left attached.
    if (this.closed) {
      this.bridge?.close();
      await provider.unsubscribe(thread.id);
      throw new Error("The conversation was closed.");
    }
    provider.attach(this);
    return thread.id;
  }

  // Attach before reading: a surviving turn can finish while thread/read is in flight.
  async completedReply(eventId, onReady) {
    if (!eventId || !this.spec.established) return null;
    const known = this.provider.sessions.get(this.id);
    if (!known) return null;
    const threadId = await this.thread();
    if (threadId !== known.ref) return null;
    const rpc = await this.provider.rpc();
    const finished = Promise.withResolvers();
    finished.promise.catch(() => {});
    const turn = this.turn = { id: eventId, text: [], ...finished };
    let watching;
    try {
      const { thread } = await rpc.request("thread/read", { threadId, includeTurns: true });
      const saved = thread?.turns?.find((t) => t.id === eventId);
      if (!saved || saved.status === "interrupted") return null;
      if (saved.status === "failed") throw new Error(saved.error?.message || "ChatGPT couldn't finish this reply.");
      const messages = (saved.items ?? []).filter((item) => item.type === "agentMessage");
      if (saved.status === "completed") return messages.map((item) => item.text).filter(Boolean).join("\n\n");
      if (saved.status !== "inProgress") throw new Error("Codex could not confirm the state of the earlier turn.");
      // A reloaded journal may end mid-turn even though the fresh process is idle.
      if (thread.status?.type === "idle" || thread.status?.type === "notLoaded") return null;
      for (const item of messages.toReversed()) {
        if (!turn.text.some((entry) => entry.id === item.id)) turn.text.unshift({ id: item.id, text: item.text ?? "" });
      }
      if (this.stopRequested) await this.interrupt();
      else onReady?.(this.steerInput(rpc, threadId, turn));
      watching = this.watch(turn);
      await finished.promise;
      if (turn.recoveryInterrupted) return null;
      return turn.text.map((item) => item.text).filter(Boolean).join("\n\n");
    } catch (error) {
      if (watching) await this.interrupt();
      throw error;
    } finally {
      watching?.stop();
      this.turn = null;
    }
  }

  steerInput(rpc, threadId, turn) {
    return async message => {
      if (this.turn !== turn || turn.interrupted || this.stopRequested) return false;
      await rpc.request("turn/steer", { threadId, expectedTurnId: turn.id, input: userInput(message) }, 10000);
      return true;
    };
  }

  /**
   * Sends one message. There is no time limit: the person stops a turn that runs long, and the
   * turn ends by itself when Codex's CLI stops or its thread is gone (see watch). `timeoutMs` is
   * for a caller with nobody to stop it, such as a background summary.
   */
  async send(message, timeoutMs, onReady) {
    if (this.turn || this.sending) throw new Error("This conversation is already working.");
    this.sending = true;
    this.stopRequested = false;
    let timer;
    let watching;
    try {
      const threadId = await this.thread();
      const rpc = await this.provider.rpc();
      const speed = this.model.fastMode;
      const tier = speed && speed !== "off"
        ? (await this.provider.models().catch(() => [])).find((m) => m.id === this.model.model)?.fastModes?.[speed]
        : undefined;
      // Stop was pressed while the thread was still starting: the turn never begins.
      if (this.stopRequested) return { text: "" };
      const settings = approvalSettings(this.mode === "plan" ? "ask" : this.spec.approval);
      const turn = (this.turn = { text: [], current: null, failure: null, id: null, baseline: this.usage?.total ?? null });
      const finished = new Promise((resolve, reject) => Object.assign(turn, { resolve, reject }));
      // The turn can be failed from elsewhere (the CLI stopping) before anything waits on it.
      finished.catch(() => {});
      if (timeoutMs > 0) {
        timer = setTimeout(() => turn.reject(Object.assign(new Error("ChatGPT didn't finish in time."), {code:"BOTKINS_TURN_TIMEOUT"})), timeoutMs);
        timer.unref?.();
      }
      watching = this.watch(turn);
      try {
        const params = {
          threadId,
          input: userInput({
            ...message,
            // Codex has no plan mode on this channel: its read-only sandbox keeps the promise, and it is told.
            prompt: this.mode === "plan" ? "Plan mode: do not change any file or run anything that changes state. Work out a plan, show it, and ask before carrying it out.\n\n" + message.prompt : message.prompt,
          }),
          model: this.model.model,
          effort: this.model.reasoningEffort ?? null,
          // Reasoning only streams when a summary is asked for.
          summary: "auto",
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: settings.approvalsReviewer,
          sandboxPolicy: settings.sandboxPolicy,
        };
        // Null clears a tier previously set on this thread. Retry only a rejected start,
        // never an accepted turn, an ambiguous transport failure, or a streamed reply.
        const start = (serviceTier) => rpc.request("turn/start", { ...params, serviceTier });
        let started;
        try {
          started = await start(tier ?? null);
        } catch (error) {
          if (this.stopRequested || !tierRejected(error.message)) throw error;
          // An old server may reject the field itself. Otherwise clear any previous thread tier.
          if (/unknown field|unrecognized (field|parameter)/i.test(error.message)) started = await rpc.request("turn/start", params);
          else if (tier) started = await start(null);
          else throw error;
        }
        turn.id = started.turn.id;
        // The turn's id is its fork boundary (see CodexProvider.forkSession).
        if (!this.spec.temporary) this.provider.sessions.update(this.id, (record) => (record.turns = [...(record.turns ?? []), turn.id].slice(-400)));
        this.emit("user.message", {}, turn.id);
        // Stop arrived between asking for the turn and learning its id.
        if (this.stopRequested) this.interrupt();
        else onReady?.(this.steerInput(rpc, threadId, turn));
        const result = await finished;
        return { text: result.trim() };
      } catch (error) {
        // Timed out or failed on this side: Codex must not go on with a turn nobody is waiting for.
        this.interrupt();
        throw error;
      }
    } finally {
      clearTimeout(timer);
      watching?.stop();
      this.turn = null;
      this.sending = false;
    }
  }
  /** One app-server notification for this session's thread. */
  notified(method, params) {
    const turn = this.turn;
    turn?.quiet?.touch();
    switch (method) {
      case "item/started": {
        const item = params.item;
        this.items.set(item.id, item);
        if (item.type === "agentMessage" && turn) {
          // Several messages in a turn read as paragraphs of one reply.
          if (turn.text.length) this.emit("assistant.message_delta", { deltaContent: "\n\n" });
          turn.current = { id: item.id, text: "" };
          turn.text.push(turn.current);
        }
        const step = describeItem(item);
        if (step)
          this.emit("tool.execution_start", {
            toolCallId: item.id,
            toolName: step[0],
            arguments: step[1],
            ...(step[2] && { mcpServerName: step[2], mcpToolName: step[0] }),
          });
        if (item.type === "collabAgentToolCall") this.emit("subagent.started", {
          toolCallId:item.id, agentName:item.tool || "Helper", prompt:item.prompt,
        });
        return;
      }
      case "item/agentMessage/delta": {
        if (!turn) return;
        const entry = turn.text.find((t) => t.id === params.itemId);
        if (!entry) return;
        entry.text += params.delta;
        this.emit("assistant.message_delta", { deltaContent: params.delta });
        return;
      }
      case "item/reasoning/summaryPartAdded":
        if (params.summaryIndex > 0) this.emit("assistant.reasoning_delta", { reasoningId: params.itemId, deltaContent: "\n\n" });
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.emit("assistant.reasoning_delta", { reasoningId: params.itemId, deltaContent: params.delta });
        return;
      case "item/commandExecution/outputDelta":
        this.emit("tool.shell_output", { toolCallId: params.itemId, text: params.delta });
        return;
      case "item/mcpToolCall/progress":
        this.emit("tool.execution_progress", { toolCallId: params.itemId, progressMessage: params.message });
        return;
      case "item/completed": {
        const item = params.item;
        this.items.set(item.id, item);
        if (item.type === "agentMessage" && turn) {
          // The finished message is the truth; deltas may have been dropped.
          const entry = turn.text.find((t) => t.id === item.id);
          if ((!entry || !entry.text) && item.text) this.emit("assistant.message_delta", { deltaContent:item.text, messageId:item.id });
          if (entry) entry.text = item.text || entry.text;
          else turn.text.push({ id: item.id, text: item.text ?? "" });
        } else if (item.type === "reasoning") {
          const content = [...(item.summary ?? [])].join("\n\n") || [...(item.content ?? [])].join("\n\n");
          this.emit("assistant.reasoning", { reasoningId: item.id, content });
        } else if (describeItem(item)) {
          const { success, content, error } = itemResult(item);
          if (item.type === "collabAgentToolCall") this.emit(success ? "subagent.completed" : "subagent.failed", { toolCallId:item.id });
          this.emit("tool.execution_complete", {
            toolCallId: item.id,
            success,
            ...(content && { result: { content } }),
            ...(!success && { error: { message: error || content || "Failed" } }),
          });
        }
        return;
      }
      case "turn/plan/updated":
        this.plan = params.plan ?? [];
        this.emit("session.todos_changed", {});
        return;
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage;
        if (!usage) return;
        // A resumed thread's first report is the baseline its own last call is subtracted from.
        if (turn && !turn.baseline && usage.total && usage.last)
          turn.baseline = Object.fromEntries(Object.keys(usage.total).map((k) => [k, (usage.total[k] ?? 0) - (usage.last[k] ?? 0)]));
        this.usage = usage;
        if (usage.modelContextWindow) {
          this.emit("session.usage_info", { currentTokens: usage.last?.totalTokens ?? 0, tokenLimit: usage.modelContextWindow });
          // Kept for the model list: it is the only place the window of a model outside Codex's catalog is said.
          this.provider.reported.note(this.model.model, { contextWindow: usage.modelContextWindow });
        }
        return;
      }
      case "error":
        if (turn && !params.willRetry) turn.failure = params.error?.message || turn.failure;
        return;
      case "turn/completed": {
        if (!turn || (turn.id && params.turn?.id !== turn.id)) return;
        // Codex has ended the turn itself: there is nothing left to interrupt.
        turn.interrupted = true;
        const done = params.turn;
        if (done.status === "interrupted") turn.recoveryInterrupted = true;
        const total = this.usage?.total;
        if (total) {
          const spent = (key) => Math.max(0, (total[key] ?? 0) - (turn.baseline?.[key] ?? 0));
          this.emit("assistant.usage", {
            inputTokens: spent("inputTokens"),
            outputTokens: spent("outputTokens"),
            cacheReadTokens: spent("cachedInputTokens"),
            model: this.model.model,
            ...(done.durationMs && { duration: done.durationMs }),
          });
        }
        const text = turn.text.map((t) => t.text.trim()).filter(Boolean).join("\n\n");
        if (done.status === "failed") turn.reject(new Error(done.error?.message || turn.failure || "ChatGPT couldn't finish this reply."));
        else turn.resolve(text);
        return;
      }
    }
  }
  /** One request Codex makes of the person, answered through this turn's handlers. */
  async requested(method, params) {
    const handlers = this.spec.handlers;
    const refuse = { "item/commandExecution/requestApproval": { decision: "decline" }, "item/fileChange/requestApproval": { decision: "decline" } };
    if (!handlers) return refuse[method] ?? (method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { action: "cancel", content: null, _meta: null });
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = params.command ?? this.items.get(params.itemId)?.command ?? "";
        const answer = await handlers.permission({
          kind: "shell",
          toolName: "shell",
          title: params.reason || "Run this command?",
          label: "Shell command",
          preview: command,
          detail: displayValue({ command, cwd: params.cwd, reason: params.reason, network: params.networkApprovalContext }, Infinity),
          remember: command ? ["this exact command", command] : null,
          readOnly: false,
          // Codex only asks for a command its sandbox would not run as it is.
          sandboxEscape: !!params.networkApprovalContext,
          managed: false,
        });
        return { decision: answer?.allow ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const changes = this.items.get(params.itemId)?.changes ?? [];
        const paths = changes.map((c) => c.path);
        const answer = await handlers.permission({
          kind: "write",
          toolName: "apply_patch",
          title: params.reason || "Change " + (paths.length === 1 ? "this file" : "these files") + "?",
          label: paths.length === 1 ? paths[0] : paths.length ? paths.length + " files" : "File change",
          preview: changes.map((c) => c.diff).filter(Boolean).join("\n") || paths.join("\n"),
          detail: displayValue({ files: paths, reason: params.reason, grantRoot: params.grantRoot }, Infinity),
          remember: paths.length ? ["writes to " + (paths.length === 1 ? "this path" : "these paths"), ...paths] : null,
          readOnly: false,
          sandboxEscape: !!params.grantRoot,
          managed: false,
        });
        return { decision: answer?.allow ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval": {
        const answer = await handlers.permission({
          kind: "permissions",
          toolName: "permissions",
          title: params.reason || "Give ChatGPT more access for this turn?",
          label: "More access",
          preview: displayValue(params.permissions, Infinity),
          detail: displayValue(params, Infinity),
          remember: null,
          readOnly: false,
          sandboxEscape: true,
          managed: false,
        });
        const granted = Object.fromEntries(Object.entries(params.permissions ?? {}).filter(([, value]) => value != null));
        return { permissions: answer?.allow ? granted : {}, scope: "turn" };
      }
      case "item/tool/requestUserInput": {
        const answers = {};
        for (const q of params.questions ?? []) {
          const reply = await handlers.question({
            question: [q.header, q.question].filter(Boolean).join(": "),
            choices: (q.options ?? []).map((o) => o.label),
            allowFreeform: q.isOther !== false || !q.options?.length,
          });
          answers[q.id] = { answers: [reply.answer] };
        }
        return { answers };
      }
      case "mcpServer/elicitation/request": {
        // Codex asks before it calls an MCP tool by sending the server's name with a form to
        // confirm. Botkins' own tools never ask; other servers go through the approval rules.
        const approval = params._meta?.codex_approval_kind === "mcp_tool_call" || params._meta?.approval_kind === "mcp_tool_call";
        if (approval) {
          if (params.serverName === BRIDGE) return { action: "accept", content: {}, _meta: null };
          const tool = params._meta?.tool_name ?? params._meta?.toolName ?? "tool";
          const answer = await handlers.permission({
            kind: "mcp",
            toolName: tool,
            title: params.message || "Use " + params.serverName + " / " + tool + "?",
            label: params.serverName + " / " + tool,
            preview: displayValue(params._meta?.tool_params ?? params._meta?.arguments ?? {}, Infinity),
            detail: displayValue(params, Infinity),
            remember: ["MCP tool " + params.serverName + "/" + tool, params.serverName, tool],
            readOnly: false,
            sandboxEscape: false,
            managed: false,
          });
          return { action: answer?.allow ? "accept" : "decline", content: answer?.allow ? {} : null, _meta: null };
        }
        const reply = await handlers.form({
          message: params.message,
          requestedSchema: params.requestedSchema,
          mode: params.mode === "url" ? "url" : "form",
          url: params.url,
        });
        return { action: reply?.action === "accept" ? "accept" : "cancel", content: reply?.action === "accept" ? (reply.content ?? {}) : null, _meta: null };
      }
    }
    throw Object.assign(new Error("Unsupported request: " + method), { code: -32601 });
  }

  /**
   * Watches `turn` while Codex is quiet: after each quiet spell Codex is asked whether the thread
   * is still running it. A CLI that stopped ends the turn at once (CodexProvider.connect), so this
   * is for a thread that is gone or has gone idle without telling us.
   */
  watch(turn) {
    return (turn.quiet = watchQuiet({ probe: () => this.alive(turn), onDead: (error) => turn.reject(error) }));
  }
  /** Rejects only when Codex no longer runs `turn`; a check that fails or gets no answer is no news. */
  async alive(turn) {
    const rpc = this.provider.rpcNow;
    if (!rpc) throw Object.assign(new Error("The Codex CLI stopped."), { code: "BOTKINS_PROVIDER_EXIT" });
    if (!turn.id || !this.threadId) return;
    let thread;
    try {
      ({ thread } = await rpc.request("thread/read", { threadId: this.threadId, includeTurns: false }, 15000));
    } catch (error) {
      if (missingConversation(error)) throw Object.assign(new Error("Codex no longer has this conversation."), { code: "BOTKINS_SESSION_LOST" });
      return;
    }
    if (thread?.status?.type === "idle" || thread?.status?.type === "notLoaded") throw Object.assign(new Error("Codex stopped working on this reply without finishing it."), { code: "BOTKINS_SESSION_LOST" });
  }
  /** Asks Codex to stop this session's turn, when one is running. Never starts the CLI. */
  interrupt() {
    const turn = this.turn;
    const rpc = this.provider.rpcNow;
    if (!turn?.id || !this.threadId || !rpc || turn.interrupted) return Promise.resolve();
    turn.interrupted = true;
    return rpc.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id }, 10000).catch(() => {});
  }
  async abort() {
    // Remembered too, for a Stop that arrives while the thread is still starting (see send).
    this.stopRequested = true;
    await this.interrupt();
  }
  async close({ discard = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    // A turn nobody waits for any more is not left running.
    if (this.turn) {
      await this.interrupt();
      this.turn?.reject(new Error("The conversation was closed."));
    }
    this.bridge?.close();
    await this.provider.detach(this, discard || !!this.spec.temporary);
  }
  async currentModel() {
    return { model: this.model.model, reasoningEffort: this.model.reasoningEffort };
  }
  /** The next turn runs on the new model; a Codex thread takes its model with each turn. */
  async switchModel(selection) {
    this.model = { ...selection };
  }
  async setMode(mode) {
    this.mode = mode === "plan" ? "plan" : "interactive";
    return true;
  }
  /** A side question runs in a throwaway copy of the thread, so the conversation never sees it. */
  async sideQuestion(question) {
    const threadId = await this.thread();
    const rpc = await this.provider.rpc();
    const { thread } = await rpc.request("thread/fork", { threadId, ephemeral: true, excludeTurns: true, approvalPolicy: "never", sandbox: "read-only" });
    const side = new CodexSession(this.provider, { ...this.spec, approval: "ask", handlers: null, tools: [], temporary: true });
    side.threadId = thread.id;
    side.starting = Promise.resolve(thread.id);
    side.model = { ...this.model };
    this.provider.attach(side);
    try {
      const { text } = await side.send({ prompt: question }, 180000);
      if (!text) throw new Error("ChatGPT returned an empty side answer.");
      return text;
    } finally {
      await side.close();
    }
  }
  async compact() {
    const threadId = await this.thread();
    await (await this.provider.rpc()).request("thread/compact/start", { threadId });
  }
  async todos() {
    return this.plan ? { rows: this.plan.map((step, i) => ({ id: String(i + 1), title: step.step, status: step.status })), dependencies: [] } : null;
  }
  async inventory() {
    const servers = [];
    // Only a thread that is running knows its servers; a menu never starts one.
    if (this.threadId || this.spec.temporary) {
      const threadId = await this.thread();
      const rpc = await this.provider.rpc();
      const { data } = await rpc.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }, 20000).catch(() => ({ data: [] }));
      for (const server of data ?? []) {
        if (server.name === BRIDGE || !(server.name in (this.spec.mcpServers ?? {}))) continue;
        const tools = Object.values(server.tools ?? {});
        servers.push({
          name: server.name,
          status: server.toolsError ? "failed" : server.authStatus === "notLoggedIn" ? "needs-auth" : server.runtimeStatus === "starting" ? "pending" : "connected",
          tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
        });
      }
    }
    for (const name of Object.keys(this.spec.mcpServers ?? {})) if (!servers.some((s) => s.name === name)) servers.push({ name, status: this.threadId ? "failed" : "not started" });
    return buildInventory({ name: this.provider.name, tools: this.spec.tools, servers, native: skillChoices(this.skills.list), compact: true });
  }
  resolvePrompt(prompt, run, chat, host) {
    return resolvePrompt(this, prompt, run, chat, host);
  }
}

export class CodexProvider extends ModelProvider {
  id = "codex";
  name = "ChatGPT";
  description = "Your ChatGPT plan, through the Codex CLI.";
  /**
   * @param options.dataDir  Where the session records are kept. Omit to keep them in memory.
   * @param options.bridge   The tool bridge Botkins' tools are offered through.
   * @param options.binary   A path to the Codex CLI, instead of looking for `codex`.
   * @param options.spawn    For tests: async () => a StdioRpc-shaped peer instead of the real CLI.
   * @param options.version  Botkins' version, named to Codex.
   * @param options.keepWarmMs  How long a thread stays loaded after its last turn. 0 unloads it at once.
   * @param options.maxWarm     How many idle threads may stay loaded.
   */
  constructor({ dataDir, bridge, binary, spawn, home, version = "0", keepWarmMs = 30 * 60 * 1000, maxWarm = 6 } = {}) {
    super();
    Object.assign(this, { bridge, binary, spawn, appVersion: version, keepWarmMs, maxWarm });
    this.sessions = new SessionStore(dataDir && join(dataDir, "sessions.json"));
    // The Codex home, for Codex's own model catalog. A stand-in Codex (a test's) has none unless it is given one.
    this.home = home ?? (spawn ? null : process.env.CODEX_HOME || join(homedir(), ".codex"));
    // The window Codex reported for a model after a turn, for a model its catalog file doesn't have.
    this.reported = new ReportedLimits(dataDir && join(dataDir, "model-limits.json"));
    this.threads = new Map();
    // Threads Codex has loaded for Botkins: thread id → { signature, session, timer, used, stale }.
    this.loaded = new Map();
    this.connection = null;
    this.login = null;
  }
  locate() {
    return findBinary("codex", { override: this.binary || env("CODEX_BINARY") });
  }
  /** The connected app-server. It starts on first use and again after it stops. */
  rpc() {
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
      if (!file) throw new Error("The Codex CLI isn't installed. Install it from https://developers.openai.com/codex/cli and try again.");
      // Botkins decides when a thread is unloaded (by unsubscribing); Codex's own delay would only add to that.
      rpc = new StdioRpc(file, ["app-server", "-c", "thread_unload_delay_secs=0"], { env: await cliEnv({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Botkins" }) });
    }
    rpc.exited?.then(() => {
      if (this.rpcNow !== rpc) return;
      this.connection = null;
      this.rpcNow = null;
      for (const session of this.threads.values()) session.turn?.reject(Object.assign(new Error("The Codex CLI stopped."), { code: "BOTKINS_PROVIDER_EXIT" }));
      this.threads.clear();
      for (const entry of this.loaded.values()) clearTimeout(entry.timer);
      this.loaded.clear();
      this.login?.finish(new Error("The Codex CLI stopped before sign-in finished."));
    });
    rpc.onNotification((method, params) => {
      if (method === "account/login/completed") return void this.login?.completed(params);
      const session = params?.threadId && this.threads.get(params.threadId);
      session?.notified(method, params);
    });
    rpc.onRequest((method, params) => {
      const session = params?.threadId && this.threads.get(params.threadId);
      if (!session) throw Object.assign(new Error("No conversation is waiting for this request."), { code: -32000 });
      return session.requested(method, params);
    });
    let started;
    try {
      started = await rpc.request("initialize", {
        clientInfo: { name: "botkins", title: "Botkins", version: this.appVersion },
        // The approval policy of "Run everything" is Codex's granular one (approvalSettings), which
        // Codex 0.169 and later take only from a client that says it uses the experimental API:
        // without this every turn of such a bot ended "askForApproval.granular requires
        // experimentalApi capability". A request Botkins doesn't know is answered as unsupported.
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
    } catch (error) {
      // A CLI that started but won't shake hands is not left running.
      await rpc.close().catch(() => {});
      throw error;
    }
    rpc.notify("initialized");
    this.cliVersion = versionOf(/\/(\S+)/.exec(started?.userAgent ?? "")?.[1]);
    this.rpcNow = rpc;
    return rpc;
  }
  /** A session took up its thread: events and requests for the thread go to it, and the thread counts as loaded. */
  attach(session) {
    this.threads.set(session.threadId, session);
    const entry = this.loaded.get(session.threadId);
    clearTimeout(entry?.timer);
    this.loaded.set(session.threadId, { signature: session.signature, session, timer: null, used: Date.now(), stale: false });
  }
  /** A session is done with its thread: the thread stays loaded for a while, or is unloaded now. */
  async detach(session, unload = false) {
    const threadId = session.threadId;
    if (!threadId) return;
    if (this.threads.get(threadId) === session) this.threads.delete(threadId);
    const entry = this.loaded.get(threadId);
    if (!entry || entry.session !== session) return;
    entry.session = null;
    entry.used = Date.now();
    if (unload || entry.stale || this.keepWarmMs <= 0) return this.unload(threadId);
    entry.timer = setTimeout(() => this.unload(threadId), this.keepWarmMs);
    entry.timer.unref?.();
    // Only the most recently used conversations stay loaded.
    const idle = [...this.loaded].filter(([, e]) => !e.session).sort((a, b) => a[1].used - b[1].used);
    while (idle.length > this.maxWarm) await this.unload(idle.shift()[0]);
  }
  /** Has Codex drop a thread from memory. Its conversation is loaded again by the next message. */
  async unload(threadId) {
    const entry = this.loaded.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.loaded.delete(threadId);
    await this.unsubscribe(threadId);
  }
  /** Unsubscribes from a thread and waits until Codex has closed it. */
  async unsubscribe(threadId) {
    const rpc = this.rpcNow;
    if (!rpc) return;
    // Codex says when the thread has really closed; until then it can't be loaded again.
    let off;
    const closed = new Promise((resolve) => {
      off = rpc.onNotification((method, params) => method === "thread/closed" && params.threadId === threadId && resolve());
      setTimeout(resolve, 5000).unref?.();
    });
    const result = await rpc.request("thread/unsubscribe", { threadId }, 10000).catch(() => null);
    if (result?.status === "unsubscribed") await closed;
    off?.();
  }
  /** A loaded thread keeps the settings it was loaded with; one whose settings changed is unloaded first. */
  async unloadIfChanged(threadId, signature) {
    const entry = this.loaded.get(threadId);
    if (entry && !entry.session && entry.signature !== signature) await this.unload(threadId);
  }
  async releaseSession(sessionId, { busy = false } = {}) {
    const threadId = this.sessions.get(sessionId)?.ref;
    const entry = threadId && this.loaded.get(threadId);
    if (!entry) return;
    if (!entry.session) await this.unload(threadId);
    // What the thread was loaded with is out of date: it is unloaded when its turn ends.
    else if (busy) entry.stale = true;
  }
  async releaseSessions({ busy = false } = {}) {
    for (const [threadId, entry] of [...this.loaded]) {
      if (!entry.session) await this.unload(threadId);
      else if (busy) entry.stale = true;
    }
  }
  /** Switched off: the app-server is let go; the next use starts it again. */
  suspend() {
    return this.stop();
  }
  async stop() {
    const connection = this.connection;
    this.connection = null;
    this.rpcNow = null;
    this.threads.clear();
    for (const entry of this.loaded.values()) clearTimeout(entry.timer);
    this.loaded.clear();
    if (connection) await connection.then((rpc) => rpc.close()).catch(() => {});
  }

  // Account
  async status() {
    if (!this.spawn && !(await this.locate()))
      return {
        installed: false,
        connected: false,
        signIn: "browser",
        signOut: false,
        message: "Install the Codex CLI to use your ChatGPT plan.",
        install: { url: "https://developers.openai.com/codex/cli", command: "npm install -g @openai/codex" },
      };
    const rpc = await this.rpc();
    const { account, requiresOpenaiAuth } = await rpc.request("account/read", { refreshToken: false }, 20000);
    const base = { installed: true, version: this.cliVersion, signIn: "browser" };
    if (!account)
      return { ...base, connected: !requiresOpenaiAuth, signOut: false, ...(requiresOpenaiAuth && { message: "Sign in with your ChatGPT account." }) };
    return {
      ...base,
      connected: true,
      signOut: account.type === "chatgpt" || account.type === "apiKey",
      ...(account.type === "chatgpt"
        ? { account: account.email ?? undefined, plan: planName(account.planType) }
        : { plan: account.type === "apiKey" ? "OpenAI API key" : account.type === "amazonBedrock" ? "Amazon Bedrock" : "Google Cloud" }),
    };
  }
  async auth() {
    const status = await this.status();
    return { connected: status.connected, login: status.account, type: status.plan };
  }
  /** Codex's own "Sign in with ChatGPT": it gives a page to open and says when the person is done. */
  async signIn({ open }) {
    const rpc = await this.rpc();
    if (this.login) throw new Error("A sign-in is already in progress.");
    const login = (this.login = { id: null });
    const done = new Promise((resolve, reject) => {
      login.finish = (error) => (error ? reject(error) : resolve());
      login.completed = (params) => {
        if (params.loginId && login.id && params.loginId !== login.id) return;
        if (params.success) resolve();
        else reject(new Error(params.error || "Sign-in didn't finish."));
      };
    });
    done.catch(() => {});
    let finished = false;
    try {
      const started = await rpc.request("account/login/start", { type: "chatgpt" });
      if (started.type !== "chatgpt" || !started.authUrl) throw new Error("Codex didn't offer a ChatGPT sign-in page.");
      login.id = started.loginId;
      if (!signInPage(started.authUrl)) throw new Error("Codex offered a sign-in page that isn't OpenAI's.");
      await open(started.authUrl);
      await done;
      finished = true;
    } finally {
      if (this.login === login) this.login = null;
      // An attempt that didn't finish is cancelled at Codex too, so its listener doesn't block the next one.
      if (!finished && login.id) await rpc.request("account/login/cancel", { loginId: login.id }, 10000).catch(() => {});
    }
  }
  async cancelSignIn() {
    const login = this.login;
    if (!login) return;
    this.login = null;
    // signIn() sees the failure and cancels the attempt at Codex.
    login.finish(new Error("Sign-in cancelled."));
  }
  async signOut() {
    await (await this.rpc()).request("account/logout", undefined, 20000);
  }

  /**
   * The ChatGPT plan and what is left of its limits, as Codex's own app server reads them with
   * its own sign-in (`account/rateLimits/read`). An API key has no plan limits.
   */
  async usage() {
    const rpc = await this.rpc();
    const { account } = await rpc.request("account/read", { refreshToken: false }, 20000);
    if (!account) throw new Error("Codex isn't signed in.");
    if (account.type !== "chatgpt") return { account: "api-key", limits: [], source: "Codex" };
    const { planType, ...usage } = codexUsage(await rpc.request("account/rateLimits/read", undefined, 20000));
    return { ...usage, plan: planName(planType ?? account.planType), source: "Codex" };
  }
  /**
   * Has Codex renew its ChatGPT sign-in when it is about to end. The gateway asks for this when the
   * Copilot runtime uses the ChatGPT plan (desktop/harness/chatgpt.mjs); Codex keeps the sign-in.
   */
  async renewSignIn() {
    await (await this.rpc()).request("account/read", { refreshToken: true }, 30000);
  }
  async models() {
    const rpc = await this.rpc();
    const list = [];
    let cursor = null;
    do {
      const page = await rpc.request("model/list", cursor ? { cursor } : {}, 30000);
      list.push(...(page.data ?? []));
      cursor = page.nextCursor;
    } while (cursor && list.length < 500);
    // Read Codex's resolved setting so the catalog passed to Pi and the meter uses the same override.
    const config = this.home ? await rpc.request("config/read", { includeLayers: false }, 5000).catch(() => null) : null;
    const catalog = this.catalogLimits(config?.config?.model_context_window);
    return list
      .filter((m) => !m.hidden)
      .map((m) => {
        const id = m.model ?? m.id;
        const speeds = fastModes(m);
        return {
          id,
          ...(Object.keys(speeds).length && { fastModes: speeds }),
          name: m.displayName || m.model || m.id,
          provider: this.id,
          efforts: [...new Set((m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort))],
          defaultEffort: m.defaultReasoningEffort ?? undefined,
          // What Codex says about the model: its own line, what it takes, each thinking level's
          // line and its speed class. The window comes from Codex's catalog and config, else from
          // what Codex reported after a turn on the model.
          ...modelDetails({
            description: m.description,
            vision: Array.isArray(m.inputModalities) ? m.inputModalities.includes("image") : undefined,
            // Codex lists the models that can run Codex, which works by calling tools.
            tools: true,
            effortNotes: Object.fromEntries((m.supportedReasoningEfforts ?? []).map((e) => [e.reasoningEffort, e.description])),
            ...this.reported.for(id),
            ...catalog[id],
          }),
          ...(m.isDefault && { recommended: true }),
          available: true,
        };
      });
  }
  /**
   * The windows in Codex's own model catalog (models_cache.json in the Codex home, which Codex
   * writes when it lists models): { [model]: { contextWindow, maxPrompt? } }. `maxPrompt` is the
   * part of the window Codex fills before it makes room, which is what it reports as a turn's
   * window. {} when the file isn't there or reads differently.
   */
  catalogLimits(override) {
    const out = {};
    const configured = Number.isSafeInteger(override) && override > 0 ? override : null;
    try {
      if (!this.home) return out;
      const saved = JSON.parse(readFileSync(join(this.home, "models_cache.json"), "utf8"));
      for (const model of Array.isArray(saved?.models) ? saved.models : []) {
        if (typeof model?.slug !== "string" || !Number.isInteger(model.context_window) || model.context_window <= 0) continue;
        // Match Codex: the override replaces the default, but cannot exceed the model's stated maximum.
        const max = model.max_context_window;
        const contextWindow = configured === null ? model.context_window : Number.isSafeInteger(max) && max > 0 ? Math.min(configured, max) : configured;
        const share = model.effective_context_window_percent;
        out[model.slug] = { contextWindow, ...(Number.isFinite(share) && share > 0 && share < 100 && { maxPrompt: Math.floor((contextWindow * share) / 100) }) };
      }
    } catch {
      // No catalog file: the windows are learned from turns.
    }
    return out;
  }
  async version() {
    await this.rpc();
    return "Codex CLI " + (this.cliVersion || "") + " · app-server";
  }

  // Sessions
  async openSession(spec) {
    return new CodexSession(this, spec);
  }
  async deleteSession(sessionId) {
    const record = this.sessions.get(sessionId);
    this.bridge?.forget(this.id + ":" + sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
    await this.unload(record.ref);
    const rpc = await this.rpc();
    await rpc.request("thread/delete", { threadId: record.ref }, 20000).catch(() => rpc.request("thread/archive", { threadId: record.ref }, 20000).catch(() => {}));
  }
  /**
   * Copies a conversation into a new thread. `toEventId` is the turn the copy stops before; Codex
   * forks through a turn, so the copy runs through the one before it.
   */
  async forkSession(sessionId, { toEventId } = {}) {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    let lastTurnId;
    let turns = record.turns ?? [];
    if (toEventId) {
      const index = turns.indexOf(toEventId);
      if (index <= 0) return null;
      lastTurnId = turns[index - 1];
      turns = turns.slice(0, index);
    }
    const rpc = await this.rpc();
    const { thread } = await rpc.request("thread/fork", { threadId: record.ref, excludeTurns: true, ...(lastTurnId && { lastTurnId }) });
    // Codex loads the copy as it makes it, without Botkins' tools or the bot's instructions.
    // It is let go here, so its first turn loads it with them.
    await this.unsubscribe(thread.id);
    const id = randomUUID();
    this.sessions.set(id, { ref: thread.id, turns: [...turns] });
    return id;
  }
}
