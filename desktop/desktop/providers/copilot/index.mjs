// GitHub Copilot as a Botkins model provider, on the Copilot SDK 2.0.
// This folder is the only code that imports the SDK. The rest of Botkins uses the contract in
// desktop/providers/provider.mjs.
//
// Whose sign-in, and who asks the keychain for it (macOS):
// - The person's GitHub sign-in for Copilot sits in keychain entries named "copilot-cli", which
//   every Copilot program on the Mac shares: the Copilot CLI, editors, other agents. macOS lets
//   an entry be used without asking only by the programs it lists, and it lists them by who
//   signed them. The runtime can be loaded into the host's own process, and Botkins did that:
//   every read and every saved token then came from "Botkins", not from GitHub's Copilot. A
//   save put Botkins' mark on the entry, the person's other Copilot programs were locked out of
//   it, and macOS asked them ("copilot wants to access key “copilot-cli” in your keychain"),
//   and asked again after every time Botkins saved, whatever they had answered. The same
//   happened to Botkins the other way round.
// - So on a Mac the runtime always runs as its own program, the one GitHub signed and ships in
//   the SDK. To the keychain it is Copilot, the same as the person's Copilot CLI, and Botkins
//   itself never touches the entry. Do not load it in-process on a Mac.
// - A trial run (a data folder of its own: tests, a development copy) doesn't use the keychain
//   sign-in at all: it is given a token, or runs signed out (see `github` in the constructor).
//
// Speed:
// - The runtime keeps its state in Botkins' own folder instead of ~/.copilot, so opening a
//   session doesn't load every global MCP server, plugin and thousands of unrelated sessions.
//   (On Windows and Linux it runs in-process; on a Mac as a child process, for the reason above.)
// - A finished turn's session stays warm. The next message in that chat reuses it and only
//   swaps in the new turn's tools and handlers.
// - Sessions are closed as rarely as possible. In this runtime, a session that starts soon after
//   another one closed waits seconds (sometimes tens of seconds) before its tools are ready,
//   while one that starts beside open sessions is ready in well under a second. So a model or
//   approval change is applied to the open session, and nothing here opens a session only to
//   close it again.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection, defineTool as sdkTool } from "@microsoft/copilot-sdk";
import { ModelProvider, ProviderSession } from "../provider.mjs";
import { QUIET_CHECK_MS, watchQuiet } from "../liveness.mjs";
import { decide } from "./permissions.mjs";
import { inventory, resolvePrompt } from "./commands.mjs";
import { matchModel, readAgents } from "./agents.mjs";
import { env } from "../../home.mjs";
import { modelDetails } from "../../modeldetails.mjs";
import { copilotUsage } from "../../providerusage.mjs";

const permissionMode = { all: "allow-all", assisted: "assisted" };
const RUNTIME_SKILLS = ["customize-cloud-agent", "github-pr-media", "pr-stack"];
// What the runtime's errors say when the session is gone: its connection closed, its process
// exited, or it no longer holds the session. Any other error from a liveness check is no news.
const GONE = /connection (?:is |got )?(?:closed|disposed)|not connected|(?:client|session) (?:is )?disconnected|session not found|server exited|\bEPIPE\b/i;
// BOTKINS_TIMING=1 prints how long each runtime step took.
const timed = env("TIMING")
  ? async (label, action) => {
      const start = performance.now();
      if (env("TIMING") === "2") console.error("[timing] " + label + " starts");
      try {
        return await action();
      } finally {
        console.error("[timing] " + label + " " + Math.round(performance.now() - start) + " ms");
      }
    }
  : (_label, action) => action();
const sdkTools = (tools) =>
  (tools ?? []).map(({ name, description, parameters, handler, skipPermission, defer }) =>
    sdkTool(name, { description, parameters: typedSchema(parameters), handler: spoken(name, handler), skipPermission, defer }),
  );
/**
 * A tool's schema with a `type` on every `enum` and `const` that has none, taken from its values.
 * Gemini models turn a whole request down ("400 invalid request body") when one tool has an
 * untyped enum in some places, such as inside the items of one of an anyOf's choices. The other
 * models don't mind the type. A schema from an MCP app is passed on as its server wrote it, so
 * this is done here for every tool rather than in each tool's source. The schema given is not changed.
 */
export function typedSchema(schema) {
  if (Array.isArray(schema)) return schema.map(typedSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    // `enum`, `const`, `default` and `examples` hold values, not schemas.
    if (SCHEMA_VALUES.has(key)) out[key] = value;
    // `properties` and the like are maps of schemas, whose keys are names (a property may be called "const").
    else if (SCHEMA_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value))
      out[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, typedSchema(entry)]));
    else out[key] = typedSchema(value);
  }
  if (out.type === undefined) {
    const values = Array.isArray(out.enum) ? out.enum : Object.hasOwn(out, "const") ? [out.const] : null;
    const type = values?.length ? valueType(values) : null;
    if (type) out.type = type;
  }
  return out;
}
/**
 * The answer to a sign-in that GitHub finished but the runtime hasn't kept yet, or undefined.
 * - "needs-plaintext-consent": the computer has no keychain (a Linux server, a container), so the
 *   runtime asks before it keeps the sign-in in a file in its own folder, as the GitHub CLI does.
 *   Without the answer the person signs in at GitHub and Copilot still isn't signed in.
 * - "needs-account-selection": the account GitHub signed in, when it is among those offered.
 */
export function loginAnswer(result) {
  if (result?.status === "needs-plaintext-consent") return "allow";
  if (result?.status === "needs-account-selection") {
    const github = (result.accounts ?? []).filter((account) => account?.selectionId);
    const chosen = github.find((account) => result.login && account.login === result.login) ?? (github.length === 1 ? github[0] : null);
    return chosen?.selectionId;
  }
  return undefined;
}
const SCHEMA_VALUES = new Set(["enum", "const", "default", "examples"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** The one JSON Schema type of all these values, or null when they differ or are null. */
function valueType(values) {
  const types = new Set(values.map((v) => (Number.isInteger(v) ? "integer" : typeof v === "number" ? "number" : typeof v)));
  // Whole numbers among fractions are numbers.
  if (types.size === 2 && types.has("integer") && types.has("number")) return "number";
  const [only] = types;
  return types.size === 1 && ["string", "integer", "number", "boolean"].includes(only) ? only : null;
}
/**
 * A Botkins tool's handler as the runtime gets it. When a tool throws, the runtime tells the
 * model only "Tool execution failed": the sentence the tool threw, which says what to do instead
 * ("Create at most ten tasks per reply."), is lost, and the bot concludes that the app is broken.
 * So a failure is handed over as a result that says it failed and carries the tool's own words.
 * (The tool server the other runtimes use already passes the words on: toolbridge.mjs.)
 * With BOTKINS_TIMING=1 the failure is also printed.
 */
export const spoken = (name, handler) => (...args) => {
  const failed = (error) => {
    const message = String(error?.message ?? error ?? "").slice(0, 2000) || "The tool failed.";
    if (env("TIMING")) console.error("[timing] tool " + name + " failed: " + message);
    return { textResultForLlm: message, resultType: "failure", error: message };
  };
  try {
    const result = handler(...args);
    return typeof result?.then === "function" ? result.then((value) => value, failed) : result;
  } catch (error) {
    return failed(error);
  }
};
const sdkAttachments = (list) =>
  list.map((a) => ({ type: a.kind === "directory" ? "directory" : "file", path: a.path, displayName: a.name }));

/**
 * The SDK session options for a Botkins session spec. `turn.handlers` is swapped for each turn
 * that uses the session, and is null while the session waits warm.
 */
/**
 * True when a selection is another provider's plan that this runtime runs (desktop/harness): the
 * session then carries that plan's connection, and the runtime knows the model as "<plan>/<model>".
 */
const planned = (model, inference) => !!model.source && !!inference?.providers?.some((connection) => connection.name === model.source);
const runtimeModel = (model, inference) => (planned(model, inference) ? model.source + "/" + model.model : model.model);

export function sessionOptions(spec, turn) {
  const live = (name, idle) => (request) => (turn.handlers?.[name] ? turn.handlers[name](request) : idle);
  return {
    model: runtimeModel(spec.model, spec.inference),
    // Another provider's plan answers this session's model requests, through Botkins' gateway.
    ...(spec.inference && { providers: spec.inference.providers, models: spec.inference.models }),
    workingDirectory: spec.folder,
    // Botkins supplies skills, MCP servers and plugins itself; nothing is picked up from the folder.
    enableConfigDiscovery: false,
    inference: {
      reasoningEffort: spec.model.reasoningEffort,
      // Models with configurable summaries only stream reasoning when asked for one.
      reasoningSummary: "detailed",
    },
    events: { streaming: true },
    permissions: {
      mode: permissionMode[spec.approval] ?? "manual",
      onRequest: (request, invocation) =>
        turn.handlers?.permission ? decide(turn.handlers.permission, request, invocation) : { kind: "reject" },
    },
    interaction: {
      onUserInputRequest: (request) => {
        if (!turn.handlers?.question) throw new Error("No active turn");
        return turn.handlers.question(request);
      },
      onExitPlanModeRequest: live("planExit", { approved: false }),
      onAutoModeSwitchRequest: live("autoSwitch", "no"),
      onElicitationRequest: live("form", { action: "cancel" }),
    },
    tools: {
      definitions: sdkTools(spec.tools),
      manageScheduleEnabled: false,
      // Botkins has its own routines and tasks, so the runtime's workflow tools only cost tokens
      // (about 1,800 a turn). Code search is for project folders.
      ...(spec.sourcesOnly ? { availableTools: spec.tools.map((tool) => "custom:" + tool.name) } : { excludedTools: [
        "builtin:run_dynamic_workflow",
        "builtin:dynamic_workflows_manage",
        ...(spec.coding ? [] : ["builtin:semantic_code_search"]),
      ] }),
    },
    skills: {
      enabled: !spec.sourcesOnly,
      directories: [...(spec.skills?.directories ?? [])],
      // The runtime's own skills are for pull requests; only coding chats get them. They are
      // switched off by name: the SDK's `includedBuiltinSkills` filter is applied with an
      // options update after the session opens, which makes opening take seconds.
      disabledSkills: [...(spec.skills?.disabled ?? []), ...(spec.coding ? [] : RUNTIME_SKILLS)],
    },
    // Only the servers from Botkins' settings. The runtime's own GitHub MCP server is left
    // out; a person who wants it adds it in Settings like any other server.
    mcp: {
      servers: spec.mcpServers ?? {},
      disabledServers: ["github-mcp-server"],
      // Botkins signs in to OAuth servers itself and keeps the tokens in its vault; the runtime
      // asks for one when a server wants it, and again when the token ends or is turned down.
      ...(spec.mcpAuth && {
        onAuthRequest: async (request) => {
          const token = await spec
            .mcpAuth({
              server: request.serverName,
              url: request.serverUrl,
              reason: request.reason,
              scope: request.wwwAuthenticateParams?.scope,
              resourceMetadataUrl: request.wwwAuthenticateParams?.resourceMetadataUrl,
            })
            .catch(() => null);
          return token?.accessToken ? { kind: "token", ...token } : { kind: "cancelled" };
        },
      }),
    },
    plugins: {
      directories: [...(spec.plugins?.directories ?? spec.plugins ?? [])],
    },
    // Plugin file hooks are projected and run by Botkins so their settings stay scoped and the
    // native plugin directory cannot register the same hook a second time.
    ...(spec.pluginHooks && { hooks: spec.pluginHooks }),
    // `context` is the part that changes often (such as the bot's memory). A warm session keeps
    // the one it opened with; see signatureOf.
    systemMessage: { mode: "append", content: spec.instructions + (spec.context ?? "") },
  };
}

/**
 * What must match for a warm session to serve another turn. Tools and handlers are swapped per
 * turn, the model and approval level are changed on the open session, and `context` is left out
 * on purpose: the workspace releases a bot's idle sessions when its context changes.
 */
const modelKey = (model) => [model.model, model.source ?? "", model.reasoningEffort ?? ""].join("\n");
const signatureOf = (spec) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        spec.folder,
        !!spec.coding,
        spec.instructions,
        spec.skills ?? null,
        spec.mcpServers ?? null,
        spec.plugins ?? null,
        spec.pluginRevision ?? null,
        spec.inference ?? null,
      ]),
    )
    .digest("hex");

async function switchModel(sdk, selection, failure, inference) {
  // A plan's model is one id, "<plan>/<model>", and takes no provider beside it.
  const plan = planned(selection, inference);
  const wanted = runtimeModel(selection, inference);
  // A source-qualified selection needs this session's provider registry, independently of the client catalog.
  if (selection.source && !plan) await sdk.rpc.model.list();
  const changed = await sdk.rpc.model.switchTo({
    modelId: wanted,
    ...(selection.source && !plan && { providerId: selection.source }),
    // Resume can retain an earlier effort. An explicit null restores the model default.
    reasoningEffort: selection.reasoningEffort ?? null,
  });
  if (changed.deferred || changed.status === "confirmation_required" || (changed.modelId && changed.modelId !== wanted))
    throw new Error(failure);
}

class CopilotSession extends ProviderSession {
  constructor(provider, entry) {
    super();
    this.provider = provider;
    this.entry = entry;
    this.sdk = entry.sdk;
    this.id = entry.id;
    this.subscriptions = new Set();
  }
  on(handler) {
    const off = this.sdk.on(handler);
    this.subscriptions.add(off);
    return () => {
      this.subscriptions.delete(off);
      off();
    };
  }
  // Read only the journal segment belonging to this submission. A tool request or
  // commentary message can precede a crash without being the person's final answer.
  async completedReply(eventId) {
    if (!eventId || !this.sdk.getEvents) return null;
    const events = (await this.sdk.getEvents()).filter((event) => !event.agentId && !event.checkpoint);
    const start = events.findIndex((event) => event.id === eventId && event.type === "user.message");
    if (start < 0) return null;
    const messageIds = new Set([events[start].data.messageId]);
    let reply = null;
    let completed = null;
    for (const event of events.slice(start + 1)) {
      if (event.type === "user.message" && event.data?.delivery === "steering") {
        messageIds.add(event.data.messageId);
        completed = reply = null;
        continue;
      }
      if (event.type === "user.message" || event.type === "session.error") break;
      if (event.type === "assistant.turn_start") completed = reply = null;
      if (event.type === "assistant.message") {
        const data = event.data;
        reply = (!data.originatingMessageId || messageIds.has(data.originatingMessageId)) &&
          !data.toolRequests?.length && (!data.phase || data.phase === "final_answer")
          ? data.content?.trim() : null;
      }
      if (reply && event.type === "assistant.turn_end") completed = reply;
    }
    return completed;
  }
  async send({ prompt, attachments, fleet }, timeoutMs, onReady) {
    const options = { prompt, ...(attachments?.length && { attachments: sdkAttachments(attachments) }) };
    // Admit the message and use the session events for completion. The SDK's own completion
    // timeout is a wall-clock deadline; a build or a sub-agent may run for as long as it takes. The
    // turn ends when the reply is done, when the person stops it, or when the session is gone
    // (watchQuiet asks after each quiet spell). `timeoutMs` is for a caller with nobody to stop it.
    let messageId;
    let requestStarted = false;
    let ended = false;
    const steerIds = new Set();
    const pendingSteers = new Map();
    let idleBeforeSteer;
    let lastAssistant;
    let admitted = false;
    let deadline;
    let watch;
    const buffered = [];
    let resolveOutcome;
    let rejectOutcome;
    const outcome = new Promise((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const observe = (event) => {
      if (!event || typeof event !== "object" || event.agentId) return;
      if (event.type === "user.message" && event.data) {
        const { messageId: id, clientTurnId, delivery } = event.data;
        if (pendingSteers.has(clientTurnId) || steerIds.has(id) || delivery === "steering") {
          steerIds.add(id);
          for (const [key, sentId] of pendingSteers) {
            if (key === clientTurnId || (sentId && sentId === id)) pendingSteers.delete(key);
          }
          idleBeforeSteer = undefined;
        }
      }
      // fleet.start returns no message id: its turn is the first new root message after the call.
      if (fleet && !messageId && event.type === "user.message" && event.data?.messageId && event.data.delivery !== "steering")
        messageId = event.data.messageId;
      if (event.type === "user.message" && event.data?.messageId === messageId) {
        requestStarted = true;
      } else if (event.type === "session.warning" && event.data?.warningType === "policy_blocked" && event.data?.originatingMessageId === messageId) {
        requestStarted = true;
      } else if (
        event.type === "assistant.message" &&
        (event.data?.originatingMessageId === messageId || steerIds.has(event.data?.originatingMessageId) || (!event.data?.originatingMessageId && requestStarted))
      ) {
        lastAssistant = event;
        if (event.data?.originatingMessageId === messageId) requestStarted = true;
      } else if (event.type === "session.idle" && requestStarted && event.data?.mode !== "autopilot") {
        // A steer can cross the original idle notification in transit. Keep listening
        // until the runtime consumes that input and reaches idle again.
        if (pendingSteers.size && !event.data?.aborted) {
          idleBeforeSteer = event;
          return;
        }
        ended = true;
        if (event.data?.aborted) rejectOutcome(new Error("The requested run was aborted before completion."));
        else resolveOutcome(lastAssistant);
      } else if (event.type === "session.autopilot_stopped" && messageId && event.data?.requestId === messageId) {
        ended = true;
        if (event.data?.reason === "error") rejectOutcome(new Error("Autopilot request failed"));
        else if (event.data?.reason === "aborted") rejectOutcome(new Error("The requested run was aborted before completion."));
        else resolveOutcome(lastAssistant);
      } else if (event.type === "session.error" && (!event.data?.originatingMessageId || event.data.originatingMessageId === messageId || steerIds.has(event.data.originatingMessageId))) {
        ended = true;
        rejectOutcome(Object.assign(new Error(event.data?.message || "The Copilot session reported an error."), { data: event.data }));
      }
    };
    const onEvent = (event) => {
      // Activity before send() returns its message id still proves that the runtime is alive.
      watch?.touch();
      // A transport can publish deltas and tool activity before its send response arrives. Those
      // events show the runtime is alive, but retaining every payload until correlation
      // is known would make a slow admission an unbounded buffer. Keep only root events that can
      // affect the completion outcome; the rest are observed by the workspace's own listener.
      if (!admitted) {
        if (!event?.agentId && ["user.message", "session.warning", "assistant.message", "session.idle", "session.autopilot_stopped", "session.error"].includes(event?.type))
          buffered.push(event);
      }
      else observe(event);
    };
    const off = this.sdk.on(onEvent);
    // Stop ends the turn here at once, also while the message is not yet admitted.
    this.current = { stop: () => rejectOutcome(new Error("The requested run was aborted before completion.")) };
    watch = watchQuiet({
      every: this.entry.quietCheckMs,
      probe: () => this.alive(),
      onDead: (reason) =>
        rejectOutcome(Object.assign(new Error("Copilot stopped before it finished this reply (" + String(reason?.message ?? reason).trim() + ")."), { code: "BOTKINS_SESSION_LOST" })),
    });
    if (timeoutMs > 0)
      deadline = setTimeout(() => rejectOutcome(Object.assign(new Error("Copilot didn't finish in time."), { code: "BOTKINS_TURN_TIMEOUT" })), timeoutMs);
    try {
      // Race admission itself with the outcome. A provider transport can hang before returning its
      // message id; Stop or a lost session must end this call too. Keep a rejection handler on the
      // admission branch because it may settle after the outcome branch wins.
      const admission = (async () => {
        if (fleet) {
          // session.idle waits for fleet's background helpers, so the turn ends when they all have.
          const { started } = await timed("fleet", () => this.sdk.rpc.fleet.start(options));
          if (!started) throw new Error("Copilot couldn't start fleet mode in this chat.");
        } else messageId = await timed("send", () => this.sdk.send(options));
        admitted = true;
        for (const event of buffered) observe(event);
        if (!ended) onReady?.(async ({ prompt, attachments }) => {
          if (ended) return false;
          const clientTurnId = randomUUID();
          pendingSteers.set(clientTurnId, null);
          try {
            const admission = this.sdk.send({ prompt, mode: "immediate", clientTurnId, ...(attachments?.length && { attachments: sdkAttachments(attachments) }) });
            const id = await Promise.race([admission, outcome.then(() => null)]);
            if (!id) return !pendingSteers.has(clientTurnId);
            if (steerIds.has(id)) pendingSteers.delete(clientTurnId);
            else if (pendingSteers.has(clientTurnId)) pendingSteers.set(clientTurnId, id);
            steerIds.add(id);
            return true;
          } catch (error) {
            pendingSteers.delete(clientTurnId);
            if (idleBeforeSteer && !pendingSteers.size) observe(idleBeforeSteer);
            throw error;
          }
        });
        return outcome;
      })();
      admission.catch(() => {});
      const response = await Promise.race([admission, outcome]);
      return { text: response?.data?.content?.trim() || "" };
    } finally {
      ended = true;
      watch.stop();
      clearTimeout(deadline);
      this.current = null;
      off?.();
    }
  }
  /** Asks the runtime whether this session is still there. Rejects only when it is gone. */
  async alive() {
    if (!this.sdk.rpc?.model?.getCurrent) return;
    try {
      await this.sdk.rpc.model.getCurrent();
    } catch (error) {
      if (GONE.test(String(error?.message ?? error))) throw error;
    }
  }
  abort() {
    this.current?.stop();
    return this.sdk.abort();
  }
  async close({ discard = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.subscriptions) off();
    this.subscriptions.clear();
    await this.provider.release(this.entry, discard);
  }
  async currentModel() {
    if (!this.sdk.rpc?.model?.getCurrent) return null;
    const current = await timed("current model", () => this.sdk.rpc.model.getCurrent());
    return { model: current.modelId, reasoningEffort: current.reasoningEffort };
  }
  switchModel(selection) {
    return switchModel(this.sdk, selection, "Copilot could not switch this chat to the selected model.", this.entry.inference);
  }
  /** Returns true when the session has a mode to set. */
  async setMode(mode, { from, planModel } = {}) {
    if (!this.sdk.rpc?.mode?.set) return false;
    await this.sdk.rpc.mode.set({
      mode,
      ...(from && { expectedMode: from }),
      ...(mode === "plan" && planModel && { planModelConfigured: true, planModel }),
    });
    return true;
  }
  async sideQuestion(question) {
    const { answer } = await this.sdk.rpc.ui.ephemeralQuery({ question });
    if (!answer?.trim()) throw new Error("Copilot returned an empty side answer.");
    return answer;
  }
  async todos() {
    return this.sdk.rpc?.plan?.readSqlTodosWithDependencies ? this.sdk.rpc.plan.readSqlTodosWithDependencies() : null;
  }
  async title() {
    return (await this.sdk.rpc.name.get()).name || null;
  }
  inventory() {
    return timed("inventory", () => inventory(this.sdk));
  }
  resolvePrompt(prompt, run, chat, host) {
    return timed("resolve prompt", () => resolvePrompt(this, prompt, run, chat, host));
  }
}

export class CopilotProvider extends ModelProvider {
  id = "copilot";
  name = "GitHub Copilot";
  description = "Your GitHub Copilot plan, including Copilot Free.";
  /**
   * @param options.baseDirectory  Where the runtime keeps sessions and settings. Omit to share ~/.copilot.
   * @param options.userHome       The person's own Copilot home (~/.copilot). Its agents are offered as bots
   *   (see agents) and its older conversations are copied over (see adoptSessions).
   * @param options.workingDirectory  Folder for a child-process runtime, when one is used.
   * @param options.keepWarmMs     How long a finished turn's session stays open. 0 closes it at once.
   * @param options.maxWarm        How many sessions may stay open.
   * @param options.keepOne        The last open session outlives the keep-warm time, so the runtime
   *                               always has one open and the next new session is ready at once
   *                               (see "Speed" at the top of this file).
   * @param options.connect        For tests: returns an SDK-shaped client instead of starting the runtime.
   * @param options.quietCheckMs   How long a turn is quiet before the runtime is asked whether the session is still there.
   * @param options.github         () => { token?, useLoggedInUser? } | undefined: how the runtime signs in
   *                               to GitHub when it shouldn't use the person's saved sign-in (a trial run).
   *                               With a token it uses that; with useLoggedInUser false and no token it
   *                               runs signed out. Either way it leaves the keychain alone.
   * @param options.platform, options.sdk  For tests of how the runtime is started.
   */
  constructor({ baseDirectory, userHome, workingDirectory, keepWarmMs = 0, maxWarm = 6, keepOne = false, connect, github, platform = process.platform, sdk, quietCheckMs = QUIET_CHECK_MS } = {}) {
    super();
    Object.assign(this, { baseDirectory, userHome, workingDirectory, keepWarmMs, maxWarm, keepOne, connect, github, platform, quietCheckMs });
    this.sdk = sdk ?? { CopilotClient, RuntimeConnection };
    this.pool = new Map();
    // Disconnects in progress. A session opened while one runs is slow, so opens wait for them.
    this.teardowns = new Set();
    this.connection = null;
    this.signInFlow = null;
    this.signedOutFile = baseDirectory && join(baseDirectory, "botkins-signed-out");
  }
  /**
   * The runtime keeps a folder of files for each session: `<baseDirectory>/session-state/<id>/files`.
   * Only for a runtime with a folder of the app's own; a session id is one name, never a path.
   */
  sessionFiles(sessionId) {
    if (!this.baseDirectory || typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)) return null;
    return join(this.baseDirectory, "session-state", sessionId, "files");
  }

  /** The connected SDK client. The runtime starts on first use. */
  client() {
    if (this.shutdown) return this.shutdown.then(() => this.client());
    if (this.connect) return this.connect();
    this.stopping = false;
    this.connection ??= this.start().catch((error) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }
  /**
   * Whether the runtime is loaded into this process. Never on a Mac, where it must be the program
   * GitHub signed (see the top of this file); BOTKINS_COPILOT_RUNTIME=stdio or =inprocess says
   * otherwise, for a trial of one or the other.
   */
  inProcess() {
    const asked = env("COPILOT_RUNTIME");
    if (asked === "stdio") return false;
    if (asked === "inprocess") return true;
    return this.platform !== "darwin";
  }
  async start({ loadSavedAccount = false } = {}) {
    const { CopilotClient: Client, RuntimeConnection: Runtime } = this.sdk;
    const base = this.baseDirectory ? { baseDirectory: this.baseDirectory } : {};
    const spawned = () => Runtime.forSpawnedStdio({ ...base, ...(this.workingDirectory && { workingDirectory: this.workingDirectory }) });
    // "coding-agent" mode uses the person's saved GitHub sign-in (on a Mac, the keychain's
    // "copilot-cli" entries) unless `github` says otherwise. Each session still names its own
    // tools, skills and MCP servers (see sessionOptions).
    // BOTKINS_COPILOT_LOG=debug writes the runtime's detailed log under <baseDirectory>/logs.
    const logLevel = env("COPILOT_LOG");
    const github = this.github?.() ?? (!loadSavedAccount && this.signedOutFile && existsSync(this.signedOutFile) ? { useLoggedInUser: false } : undefined);
    const make = (runtime) =>
      new Client({ mode: "coding-agent", runtime, ...(logLevel && { observability: { logLevel } }), ...(github && { github }) });
    const inProcess = this.inProcess();
    let client = make(inProcess ? Runtime.forInProcess(base) : spawned());
    try {
      await client.start();
    } catch (error) {
      // On a Mac nothing falls back to the in-process runtime: a sign-in that works by breaking
      // the person's other Copilot programs is worse than an error they can read.
      if (!inProcess || this.platform === "darwin") throw error;
      // The in-process runtime is a native library. If it can't load here, a child process still works.
      console.error("Copilot in-process runtime didn't start; using a child process:", error.message);
      client = make(spawned());
      await client.start();
    }
    return client;
  }
  /** Starts the runtime ahead of the first turn (Workspace.warmUp and warmRoute). */
  async warm() {
    if (!this.stopping) await this.client();
  }
  async stop() {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    for (const entry of this.pool.values()) clearTimeout(entry.timer);
    this.pool.clear();
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      // A status check may still be starting the old runtime when the credential changes.
      this.shutdown = connection.then((client) => client.stop(), () => {}).finally(() => { this.shutdown = null; });
      await this.shutdown;
    }
  }

  // Account
  async auth() {
    const status = await (await this.client()).getAuthStatus();
    return { connected: status.isAuthenticated, login: status.login, type: status.authType, host: status.host };
  }
  async status() {
    const auth = await this.auth();
    // A sign-in that came from the GitHub CLI or a token is removed there, not here.
    const elsewhere = { "gh-cli": "the GitHub CLI", env: "an environment token", token: "a token", "api-key": "an API key", hmac: "a GitHub App" };
    const managed = auth.connected && auth.type && auth.type !== "user";
    return {
      installed: true,
      connected: !!auth.connected,
      account: auth.login || undefined,
      signIn: "browser",
      signOut: !!auth.connected && !managed,
      ...(auth.connected && { plan: managed ? "Signed in through " + (elsewhere[auth.type] ?? auth.type) : "GitHub Copilot" }),
      ...(!auth.connected && { message: "Sign in with a GitHub account that has Copilot access." }),
    };
  }
  /**
   * The Copilot plan and what is left of the month's allowances, as GitHub's own runtime reads
   * them with the sign-in it already has. The signed-in account says the plan and the day the
   * month's allowances start again; nothing else about the account is taken from it.
   */
  async usage() {
    const client = await this.client();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error("GitHub Copilot isn't signed in.");
    if (auth.authType === "api-key") return { account: "api-key", limits: [], source: "GitHub Copilot" };
    const account = client.rpc?.account;
    if (typeof account?.getQuota !== "function") return null;
    const [quota, current] = await Promise.all([account.getQuota({}), typeof account.getCurrentAuth === "function" ? account.getCurrentAuth().catch(() => null) : null]);
    const user = current?.authInfo?.copilotUser ?? (auth.copilotPlan ? { copilot_plan: auth.copilotPlan } : null);
    return { ...copilotUsage(quota, user), source: "GitHub Copilot" };
  }
  /** SDK 2.0 runs account flows on a session, so a short-lived session with no tools carries them. */
  async withAccounts(action) {
    const client = await this.client();
    const session = await client.createSession({
      tools: { availableTools: [] },
      permissions: { onRequest: () => ({ kind: "reject" }) },
    });
    try {
      return await action(session.rpc.accounts, client);
    } finally {
      await session.disconnect().catch(() => {});
      await client.deleteSession(session.sessionId).catch(() => {});
    }
  }
  /**
   * GitHub's sign-in. `open(url)` opens the page in the person's browser on this computer. A host
   * with no browser passes `device({ userCode, verificationUri, expiresIn })` instead: GitHub's
   * device sign-in, where the person types a one-time code on a page they open on any device.
   */
  async signIn(options) {
    const flow = {};
    this.signInFlow = flow;
    try {
      const approved = await this.authorizeAccount(options, flow);
      if (this.signInFlow !== flow) throw new Error("Sign-in cancelled.");
      if (approved) await this.resumeApprovedAccount(approved, flow);
    } finally {
      if (this.signInFlow === flow) this.signInFlow = null;
    }
  }
  async authorizeAccount({ open, device }, flow) {
    return this.withAccounts(async (accounts, client) => {
      const { flowId, step } = await accounts.login.begin({ kind: "githubDotCom", method: device ? "device-code" : "web" });
      flow.cancel = () => accounts.login.cancel({ flowId }).catch(() => {});
      const cancelled = () => this.signInFlow !== flow;
      try {
        if (cancelled()) throw new Error("Sign-in cancelled.");
        if (device) {
          if (step.kind !== "device-code" || new URL(step.verificationUri).origin !== "https://github.com")
            throw new Error("GitHub didn't offer a one-time code. Sign in with a GitHub token instead.");
          await device({ userCode: step.userCode, verificationUri: step.verificationUri, expiresIn: step.expiresIn });
        } else {
          if (step.kind !== "open-url" || new URL(step.url).origin !== "https://github.com")
            throw new Error("Open Copilot CLI and run /login to connect your account.");
          await open(step.url);
        }
        let next;
        let input;
        const answered = new Set();
        for (;;) {
          try {
            next = await accounts.login.advance({ flowId, ...(input !== undefined && { input }) });
          } catch (error) {
            throw cancelled() ? new Error("Sign-in cancelled.") : error;
          }
          if (cancelled() || next.kind !== "completed") {
            input = undefined;
            if (next.kind === "awaiting" && !cancelled()) continue;
            break;
          }
          // GitHub said yes, but the runtime may still need an answer before it keeps the sign-in.
          // Each question is answered once: asked again, the answer wasn't taken.
          const question = next.result?.status;
          input = answered.has(question) ? undefined : loginAnswer(next.result);
          if (input === undefined) break;
          answered.add(question);
        }
        if (cancelled()) throw new Error("Sign-in cancelled.");
        const status = next.kind === "completed" ? next.result?.status : undefined;
        if (status === "declined") throw new Error("GitHub Copilot's sign-in wasn't saved on this computer. Sign in with a GitHub token instead.");
        if (status === "needs-account-selection") throw new Error("GitHub Copilot asked which account to use. Sign in with a GitHub token instead.");
        // Any other answer that isn't "completed" left the sign-in unkept. Another sign-in on the
        // computer (the GitHub CLI's) would still make the check below pass, so it is not asked.
        if (status !== undefined && status !== "completed") throw new Error("Sign-in incomplete: GitHub Copilot didn't keep it (" + status + "). Sign in with a GitHub token instead.");
        if (next.kind !== "completed") throw new Error(next.message || "GitHub did not finish approving this sign-in. Try again.");
        if (this.signedOutFile && existsSync(this.signedOutFile)) {
          if (status !== "completed" || !next.result.login) throw new Error("GitHub did not confirm which account it approved. Try again.");
          return next.result;
        }
        if (!(await client.getAuthStatus()).isAuthenticated) throw new Error("Copilot could not load the GitHub sign-in on this host. Try again.");
      } finally {
        await flow.cancel();
        delete flow.cancel;
      }
    });
  }
  // A runtime started with useLoggedInUser:false can save an approved device login but stays
  // anonymous. Status and chat must both wait for the replacement to verify the saved identity.
  async resumeApprovedAccount(approved, flow = this.signInFlow) {
    const stopped = this.stop();
    const ready = stopped.then(async () => {
      this.stopping = false;
      const client = await this.start({ loadSavedAccount: true });
      try {
        const auth = await client.getAuthStatus();
        if (!auth.isAuthenticated || auth.authType !== "user" || auth.login?.toLowerCase() !== approved.login.toLowerCase() ||
            (approved.host && auth.host !== approved.host)) {
          throw new Error("Copilot could not load the approved account on this host. Try signing in again.");
        }
        if (this.connection !== ready || this.signInFlow !== flow) throw new Error("Sign-in cancelled.");
        rmSync(this.signedOutFile, { force: true });
        return client;
      } catch (error) {
        await client.stop();
        throw error;
      }
    });
    this.connection = ready;
    try {
      await ready;
    } catch (error) {
      if (this.connection === ready) this.connection = null;
      throw error;
    }
  }
  async cancelSignIn() {
    const flow = this.signInFlow;
    if (!flow) return;
    this.signInFlow = null;
    await flow.cancel?.();
  }
  // A shared keychain item can belong to another Copilot installation. If the OS protects it,
  // disconnect this host and start the SDK with automatic account loading disabled on every boot.
  async disconnectAccount(removeToken) {
    if (!this.signedOutFile) throw new Error("A Botkins data folder is required to disconnect this account.");
    const alreadyDisconnected = existsSync(this.signedOutFile);
    mkdirSync(this.baseDirectory, { recursive: true });
    writeFileSync(this.signedOutFile, "", { mode: 0o600 });
    try {
      if (removeToken && !removeToken()) throw new Error("Could not remove the saved Copilot token.");
    } catch (error) {
      if (!alreadyDisconnected) rmSync(this.signedOutFile, { force: true });
      throw error;
    }
    await this.stop();
  }
  async signOut() {
    const { type } = await this.auth();
    // Botkins can only remove a sign-in the Copilot runtime owns.
    if (type === "gh-cli")
      throw new Error("This computer is signed in through GitHub CLI. Run “gh auth logout” in a terminal to sign out.");
    if (type === "env" || type === "token")
      throw new Error("This computer signs in with a GitHub token from its environment. Remove that token to sign out.");
    try {
      const result = await this.withAccounts((accounts) => accounts.set({ command: { kind: "logout" } }));
      if (!result?.ok) throw new Error("GitHub Copilot didn't sign out. Try again.");
    } catch (error) {
      if (!this.signedOutFile || !/Failed to remove token: Keychain error: Couldn't access platform storage/i.test(error.message)) throw error;
    }
    if (this.signedOutFile) {
      await this.disconnectAccount();
      if ((await this.auth()).connected) throw new Error("Copilot still has an active account on this host.");
    } else await this.releaseSessions();
  }

  async models() {
    const list = await (await this.client()).listModels();
    return list.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: this.id,
      // The runtime's own reference to where the model comes from (Copilot itself or a configured endpoint).
      ...(m.provider?.id && { source: m.provider.id }),
      efforts: [...new Set(m.supportedReasoningEfforts ?? [])],
      defaultEffort: m.defaultReasoningEffort,
      // What GitHub's listing says about the model: its limits, what it takes, who made it and its price class.
      ...modelDetails({
        contextWindow: m.capabilities?.limits?.max_context_window_tokens,
        maxPrompt: m.capabilities?.limits?.max_prompt_tokens,
        maxOutput: m.capabilities?.limits?.max_output_tokens,
        vision: m.capabilities?.supports?.vision,
        tools: m.capabilities?.supports?.tool_calls,
        vendor: m.vendor,
        tier: m.modelPickerPriceCategory,
      }),
      available: !m.policy || m.policy.state === "enabled",
    }));
  }
  /**
   * The custom agents in the person's Copilot home (<home>/agents/*.agent.md). Each one's `model`
   * becomes a selection from this provider's catalog when the catalog has it.
   */
  async agents() {
    if (!this.userHome) return [];
    const found = readAgents(join(this.userHome, "agents"));
    if (!found.some((a) => a.model)) return found;
    // Signed out, offline or slow to start, the agents are still offered; they use the default model.
    const catalog = await Promise.race([this.models().catch(() => []), new Promise((resolve) => setTimeout(() => resolve([]), 6000))]);
    return found.map(({ model, ...agent }) => {
      const match = matchModel(catalog, model);
      return {
        ...agent,
        ...(match && { model: { model: match.id, provider: this.id, ...(match.source && { source: match.source }) }, modelName: match.name }),
        // The file names a model this account doesn't have. Known only when the model list could be read.
        ...(!match && model && catalog.length > 0 && { missingModel: model }),
      };
    });
  }
  async version() {
    const status = await (await this.client()).getStatus();
    return "Copilot " + status.version + " · protocol " + status.protocolVersion;
  }

  // Sessions
  async openSession(spec) {
    const client = await this.client();
    const pooled = this.keepWarmMs > 0 && !spec.temporary;
    const signature = pooled ? signatureOf(spec) : null;
    const warm = this.pool.get(spec.sessionId);
    if (warm) {
      if (warm.busy) throw new Error("This conversation is already working.");
      if (pooled && warm.signature === signature) {
        clearTimeout(warm.timer);
        warm.busy = true;
        try {
          if (warm.model !== modelKey(spec.model)) {
            await timed("switch model", () =>
              switchModel(warm.sdk, spec.model, "Copilot could not apply the chosen model to this conversation.", spec.inference),
            );
            warm.model = modelKey(spec.model);
          }
          const mode = permissionMode[spec.approval] ?? "manual";
          if (warm.mode !== mode) {
            const result = await warm.sdk.rpc.permissions.setMode({ mode });
            if (!result?.success) throw new Error("the approval level was not applied");
            warm.mode = mode;
          }
          await timed("reuse session", () => warm.sdk.setTools(sdkTools(spec.tools)));
          warm.turn.handlers = spec.handlers;
          return new CopilotSession(this, warm);
        } catch (error) {
          console.error("Warm session:", error.message);
          await this.discard(warm);
        }
      } else await this.discard(warm);
    }
    const turn = { handlers: spec.handlers };
    const options = sessionOptions(spec, turn);
    // A plan's model needs no GitHub sign-in: without one, the runtime's own models are left out
    // of the session rather than asked for.
    if (spec.inference && !(await this.auth().catch(() => ({ connected: false }))).connected) options.github = { capi: { enabled: false } };
    if (this.teardowns.size) await Promise.allSettled([...this.teardowns]);
    let sdk;
    if (spec.established) {
      try {
        sdk = await timed("resume session", () => client.resumeSession(spec.sessionId, options));
      } catch (error) {
        // The first turn may have failed before the runtime persisted any events.
        if (spec.hasReplies || !String(error.message).includes("Session not found")) throw error;
      }
    }
    const resumed = !!sdk;
    sdk ??= await timed("create session", () => client.createSession({ ...options, sessionId: spec.sessionId }));
    // A new session of a plan's model was created on that model already.
    if ((resumed || (spec.model.source && !planned(spec.model, spec.inference))) && sdk.rpc?.model) {
      try {
        await timed("apply model", () =>
          switchModel(
            sdk,
            spec.model,
            "Copilot could not apply the chosen model to this conversation. Choose another model or start a new chat.",
            spec.inference,
          ),
        );
      } catch (error) {
        await sdk.disconnect().catch(() => {});
        throw error;
      }
    }
    const entry = {
      id: spec.sessionId,
      ...(spec.sourcesOnly && { forget: () => client.deleteSession(spec.sessionId) }),
      sdk,
      signature,
      model: modelKey(spec.model),
      inference: spec.inference,
      quietCheckMs: this.quietCheckMs,
      mode: permissionMode[spec.approval] ?? "manual",
      turn,
      busy: true,
      timer: null,
      used: Date.now(),
    };
    if (pooled) this.pool.set(entry.id, entry);
    return new CopilotSession(this, entry);
  }
  /** A turn is done with its session: keep it warm, or disconnect it. */
  async release(entry, discard) {
    entry.turn.handlers = null;
    entry.busy = false;
    if (discard || entry.stale || this.stopping || this.pool.get(entry.id) !== entry) return this.discard(entry);
    entry.used = Date.now();
    this.expireLater(entry);
    // Only the most recently used conversations stay open.
    const idle = [...this.pool.values()].filter((e) => !e.busy).sort((a, b) => a.used - b.used);
    while (this.pool.size > this.maxWarm && idle.length) await this.discard(idle.shift());
  }
  /**
   * Closes a warm session after the keep-warm time. With `keepOne`, the last one open stays: a
   * session opened beside an open one is ready in well under a second, and one opened after the
   * last one closed waits seconds (see "Speed" at the top of this file).
   */
  expireLater(entry) {
    entry.timer = setTimeout(() => {
      if (this.keepOne && !this.stopping && this.pool.get(entry.id) === entry && this.pool.size === 1) return this.expireLater(entry);
      void this.discard(entry);
    }, this.keepWarmMs);
    entry.timer.unref?.();
  }
  async discard(entry) {
    clearTimeout(entry.timer);
    if (this.pool.get(entry.id) === entry) this.pool.delete(entry.id);
    const teardown = timed("disconnect", () => entry.sdk.disconnect().catch(() => {}));
    this.teardowns.add(teardown);
    try {
      await teardown;
      if (entry.forget) await entry.forget().catch(() => {});
    } finally {
      this.teardowns.delete(teardown);
    }
  }
  async releaseSession(sessionId, { busy = false } = {}) {
    const warm = this.pool.get(sessionId);
    if (!warm) return;
    if (!warm.busy) await this.discard(warm);
    // What the session was opened with is out of date: it closes when its turn ends.
    else if (busy) warm.stale = true;
  }
  /**
   * Closes every warm session that isn't in a turn. Their conversations resume on the next
   * message. With `busy`, a session in a turn closes when that turn ends.
   */
  async releaseSessions({ busy = false } = {}) {
    if (busy) for (const entry of this.pool.values()) if (entry.busy) entry.stale = true;
    await Promise.all([...this.pool.values()].filter((e) => !e.busy).map((e) => this.discard(e)));
  }
  async deleteSession(sessionId) {
    const warm = this.pool.get(sessionId);
    if (warm) await this.discard(warm);
    const client = await this.client();
    await timed("delete session", () => client.deleteSession(sessionId));
  }
  async forkSession(sessionId, { toEventId } = {}) {
    const result = await (await this.client()).rpc.sessions.fork({ sessionId, ...(toEventId && { toEventId }) });
    return result?.sessionId ?? null;
  }
  /**
   * Copies conversations made while Botkins shared ~/.copilot into Botkins' own state
   * folder, so they keep their history. Originals are left in place. Returns how many it copied.
   */
  adoptSessions(sessionIds, from = this.userHome) {
    if (!this.baseDirectory || !from) return 0;
    const source = join(from, "session-state");
    const target = join(this.baseDirectory, "session-state");
    let copied = 0;
    for (const id of sessionIds) {
      if (typeof id !== "string" || !/^[\w-]{1,200}$/.test(id)) continue;
      if (existsSync(join(target, id)) || !existsSync(join(source, id))) continue;
      const staging = join(target, ".adopting-" + id);
      try {
        mkdirSync(target, { recursive: true });
        rmSync(staging, { recursive: true, force: true });
        cpSync(join(source, id), staging, { recursive: true });
        renameSync(staging, join(target, id));
        copied++;
      } catch (error) {
        console.error("Conversation copy:", error.message);
        rmSync(staging, { recursive: true, force: true });
      }
    }
    return copied;
  }
}
