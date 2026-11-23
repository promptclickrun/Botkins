// The model provider contract.
//
// Botkins talks to a model backend only through the two classes below. A backend lives in its
// own folder under desktop/providers/<id>/ and is the only code that may import that backend's SDK.
// Adding a backend means adding a folder and registering it in desktop/main.mjs; the workspace,
// the tools and the UI stay as they are. The UI only needs an icon for it (src/ProviderIcon.tsx).
//
// Backends that are command-line tools (Codex, Claude Code, OpenCode, ACP agents) share
// desktop/providers/cli.mjs (finding and running the tool), toolbridge.mjs (Botkins' tools as
// an MCP server), commands.mjs (the "/" menu) and sessions.mjs (which conversation is whose).
//
// Tools
//   defineTool() makes a provider-neutral tool: a name, a description, a JSON Schema for its
//   arguments and a handler. Adapters convert it to their own format.
//
// Session spec (what Workspace.openSession passes to ModelProvider.openSession)
//   sessionId     Stable id of the conversation.
//   established   True when the provider was given this id before (resume instead of create).
//   hasReplies    True when the conversation already holds a reply. A backend that can't find such a
//                 conversation either fails (Copilot) or starts a new one that is given `history`
//                 as its past (the command-line backends, see sessions.mjs transcriptContext).
//   temporary     True for a disposable session, such as the one behind the "/" menu of a new chat.
//   folder        Working directory for file and shell tools.
//   coding        True when the folder is a project folder (load its instruction files, git context).
//   model         { model, source?, reasoningEffort? } chosen for this conversation.
//   approval      "ask" | "read" | "assisted" | "all".
//   instructions  Text added to the system prompt.
//   context       More system prompt text that changes often (the bot's memory). A provider that keeps
//                 sessions open between turns need not reopen one because this changed.
//   tools         Tools from defineTool().
//   skills        { directories: string[], disabled: string[] }.
//   mcpServers    { [name]: { type, command, args, env, workingDirectory } | { type, url, headers } }.
//   mcpAuth       async ({ server, url, reason, scope?, resourceMetadataUrl? }) for a remote MCP server
//                 that answers "sign in first" (OAuth). `reason` is "initial", "refresh" (the token
//                 is ending), "reauth" (the token was turned down) or "upscope". Resolves
//                 { accessToken, tokenType?, expiresIn? }, or null when the person has to sign in.
//   plugins       Plugin folders.
//   history       () => the chat's messages, for backends that keep no session state.
//   handlers      { permission(request), question(request), planExit(request), autoSwitch(request), form(request) }
//
// Permission requests (handlers.permission)
//   The adapter describes each request in neutral terms:
//     { kind, toolName, title, label, preview, detail, remember: [text, ...key] | null,
//       readOnly, sandboxEscape, managed }
//   and the handler answers { allow: boolean, interactive?: boolean }.
//
// Session events (ProviderSession.on)
//   Each event is { type, data, id?, agentId? }. agentId is set for a helper (sub-agent) the
//   backend started itself. Botkins reads these types; an adapter maps its stream onto them:
//     assistant.message_delta        data.deltaContent
//     assistant.reasoning_delta      data.reasoningId, data.deltaContent
//     assistant.reasoning            data.reasoningId, data.content
//     assistant.intent               data.intent
//     assistant.usage                data.inputTokens, outputTokens, cacheReadTokens, cost, duration, model
//     session.usage_info             data.currentTokens, tokenLimit and the optional breakdown
//     session.todos_changed          (then ProviderSession.todos())
//     user.message                   id is the fork boundary of the turn
//     tool.execution_start           data.toolCallId, toolName, mcpServerName, mcpToolName, arguments
//     tool.execution_progress        data.toolCallId, progressMessage
//     tool.shell_output              data.toolCallId, text
//     tool.execution_partial_result  data.toolCallId, partialOutput
//     tool.execution_complete        data.toolCallId, success, result, error
//     subagent.started / completed / failed   see desktop/canvas.mjs

/** A tool Botkins gives a bot. `skipPermission` marks Botkins' own tools, which never ask. */
export function defineTool(name, { description, parameters, handler, skipPermission = true, defer = "never" }) {
  return { name, description, parameters, handler, skipPermission, defer };
}

const unsupported = (what) => {
  throw new Error("This model provider doesn't support " + what + ".");
};

export class ModelProvider {
  /** Registry id, also stored on model selections as `provider`. */
  id = "";
  /** Name shown to the person. */
  name = "";
  /** One line under the name in Settings › Model providers. */
  description = "";
  /** False for a provider the person adds themselves (Settings › Model providers › Add a provider). */
  defaultEnabled = true;

  /** { connected, login?, type?, host? } */
  async auth() {
    return { connected: true };
  }
  /**
   * What the app shows for this provider:
   *   installed  False when the backend needs a tool that isn't on this computer.
   *   version    That tool's version, when known.
   *   connected  True when the provider can answer: signed in, or needing no sign-in.
   *   account    Who is signed in (an email or a login), when known.
   *   plan       The plan or kind of account behind it ("ChatGPT Plus", "Claude Max", "API key").
   *   message    One sentence on what to do next when something is missing.
   *   signIn     "browser" when signIn() opens a sign-in page; "services" when the person connects
   *              model services one at a time (services()); null when there is nothing to sign in to.
   *   signOut    True when signOut() can remove the sign-in.
   *   install    { url, command? }: where to get the tool.
   */
  async status() {
    const auth = await this.auth();
    return { installed: true, connected: !!auth.connected, account: auth.login, signIn: null, signOut: false };
  }
  /**
   * What status() says about this provider while it is switched off, without asking it anything
   * (fields to add to the plain "off" status), or nothing. A provider that is set up in Settings
   * while off (the key providers) says its settings here.
   */
  dormant() {
    return undefined;
  }
  /** Starts an interactive sign-in. `open(url)` opens the person's browser. */
  async signIn(_options) {
    unsupported("signing in from Botkins");
  }
  async cancelSignIn() {}
  async signOut() {
    unsupported("signing out from Botkins");
  }
  /**
   * For a provider that holds several model services (status().signIn === "services"):
   * [{ id, name, connected, via?, methods: [{ type: "key" | "oauth", id?, label }] }].
   */
  async services(_query) {
    return [];
  }
  /**
   * Connects one of those services, with { key } or { method, open }. Resolves { done: true }, or
   * { code: { attempt, instructions } } when the sign-in page gives the person a code (then finishService).
   */
  async connectService(_serviceId, _options) {
    unsupported("connecting model services");
  }
  async finishService(_serviceId, _attempt, _code) {
    unsupported("connecting model services");
  }
  async cancelService(_serviceId) {}
  async disconnectService(_serviceId) {
    unsupported("connecting model services");
  }
  /**
   * [{ id, name, provider, source?, group?, description?, recommended?, efforts, defaultEffort?, available }]
   * `group` names a service inside the provider (OpenCode's "Anthropic", "Google"); `recommended`
   * marks the provider's own pick.
   */
  async models() {
    return [];
  }
  /**
   * Agents the person already set up with this backend, for Botkins to offer as bots:
   * [{ name, title, description, instructions, model?, modelName?, missingModel?, file?, ownTools? }].
   * `model` is a selection from models(); `missingModel` is the model the agent names when the
   * account doesn't have it. `ownTools` marks an agent with its own tool settings, which a
   * Botkins bot does not take over.
   */
  async agents() {
    return [];
  }
  /** Opens (creates or resumes) a conversation session. Returns a ProviderSession. */
  async openSession(_spec) {
    unsupported("conversations");
  }
  /** Forgets a conversation's state. Missing sessions are fine. */
  async deleteSession(_sessionId) {}
  /**
   * The folder this provider's runtime gives one conversation for its own files, or null when it
   * gives none. A bot's tools write there when the bot names no other place, so a file in it is
   * that conversation's bot's own (desktop/artifact-events.mjs).
   */
  sessionFiles(_sessionId) {
    return null;
  }
  /**
   * Releases any warm session held for this id without deleting its state. With `busy`, a
   * session that is in a turn is released when that turn ends.
   */
  async releaseSession(_sessionId, _options) {}
  /** Releases every warm session, for a change that all of them must pick up (such as a new MCP sign-in). */
  async releaseSessions(_options) {}
  /**
   * Starts what this provider's first turn would otherwise start (its runtime, its program), in
   * the background, so that turn doesn't wait for it. It opens no session and must be cheap to call
   * again. A failure is the real turn's to report, so it is ignored here.
   */
  async warm() {}
  /**
   * Lets go of what the provider keeps running (a process, a local server) while the person has
   * it switched off. Unlike stop(), the next use starts it again.
   */
  async suspend() {}
  /** Copies a conversation up to an event. Returns the new session id, or null when unsupported. */
  async forkSession(_sessionId, _options) {
    return null;
  }
  /** A short version line for /version. */
  async version() {
    return this.name;
  }
  /**
   * The signed-in account's plan and what is left of its limits, read from the provider with the
   * sign-in it already has (desktop/providerusage.mjs): { plan?, account?: "subscription" |
   * "api-key", limits: [{ id, label, percentUsed? | percentRemaining?, resetAt?, window?, model?,
   * used?, limit?, unit?, unlimited? }], credits?, note?, source? }. Null when the provider has
   * no way to say. Only what the provider stated: a value it didn't give is left out.
   */
  async usage() {
    return null;
  }
  async stop() {}
}

export class ProviderSession {
  /** The conversation id. */
  id = "";

  /**
   * Starts what this session's first message would start (a harness program), ahead of it. A
   * session that starts nothing of its own does nothing (Workspace.prewarm).
   */
  async warm() {}

  /** Subscribes to session events (see the contract above). Returns an unsubscribe function. */
  on(_handler) {
    return () => {};
  }
  /**
   * Sends one message and resolves with { text } when the reply is complete. A turn has no time
   * limit (see liveness.mjs): it ends when the reply is done, when the person stops it (abort), or
   * when the harness is gone (its process exited, its connection closed, its session no longer
   * exists), which rejects with that error. `_timeoutMs` is for a caller with nobody to stop it,
   * such as a background summary: past it the turn rejects with code BOTKINS_TURN_TIMEOUT.
   */
  async send(_message, _timeoutMs) {
    unsupported("sending messages");
  }
  /** Stops the reply in progress. */
  async abort() {}
  /** Ends this use of the session. The provider may keep it warm for the next turn. */
  async close() {}
  /** { model, reasoningEffort } the session is really using, or null. */
  async currentModel() {
    return null;
  }
  /** Switches the conversation's model. */
  async switchModel(_selection) {
    unsupported("switching models mid-conversation");
  }
  /** "plan" | "interactive" for backends with a plan mode. */
  async setMode(_mode, _options) {}
  /** Answers a side question without adding it to the conversation. */
  async sideQuestion(_question) {
    unsupported("side questions");
  }
  /** The backend's own task list for this turn, in the shape desktop/canvas.mjs mapTodos() reads. */
  async todos() {
    return null;
  }
  /** The backend's name for the conversation, if it keeps one. */
  async title() {
    return null;
  }
  /** What the "/" menu lists: { choices, servers, plugins }. */
  async inventory() {
    return { choices: [], servers: [], plugins: [] };
  }
  /**
   * Turns a typed message into what to do with it. A backend without slash commands sends
   * everything to the model.
   */
  async resolvePrompt(prompt, _run, _chat, _host) {
    return { kind: "agent-prompt", prompt };
  }
}
