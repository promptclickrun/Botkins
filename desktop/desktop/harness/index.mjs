// The harness: what runs a bot's turn (the loop, the tools, the approvals) around the model.
//
// Settings › General offers four choices (settings.harness), in this order:
//   "pi", "provider", "copilot", "omp". Pi is the default (2026-11-23). A choice the person made
//   (settings.harnessPicked) is kept; while nobody chose, a default whose program isn't on this
//   computer gives way to the next in the order (Harness.effective).
//   "copilot"   One harness for every plan. The Copilot runtime runs the turn, and the model's own
//               plan answers the model requests: GitHub Copilot's models as always, and a ChatGPT
//               plan, a Claude plan and OpenCode's models through the gateway (gateway.mjs).
//               Skills, tools, MCP servers and their sign-ins, plugins and approvals are then the
//               same whichever model a chat uses, because one program carries them.
//   "provider"  Each provider's own tool runs the turn, as before: Codex for ChatGPT, Claude Code
//               for Claude, the Copilot runtime for GitHub Copilot, OpenCode for its models.
//   "pi"        Pi (pi.dev, desktop/providers/pi) runs the turns of ChatGPT and Claude plan
//               models, GitHub Copilot's models and OpenCode's models, each answered through the
//               same gateway.
//   "omp"       OMP (omp.sh), the enhanced Pi harness, runs the same models through the same
//               gateway and Botkins safety layer.
//
// How the gateway reaches each provider's models (no sign-in ever reaches a harness):
//   ChatGPT   the person's ChatGPT plan, with Codex's sign-in (chatgpt.mjs)
//   Claude    the person's Claude plan, one turn of Claude Code at a time (claude.mjs)
//   Copilot   GitHub Copilot's model API, signed with headers a Copilot runtime of Botkins' own
//             lends (providers/copilot/relay.mjs, copilot.mjs); Botkins never reads the keychain.
//             Copilot's "auto" model is chosen inside the runtime, so it stays on the runtime.
//   OpenCode  one model step of an OpenCode session that can do nothing else (opencode.mjs);
//             OpenCode keeps its sign-ins.
//
// OpenRouter, Azure Foundry and an OpenAI endpoint (desktop/providers/keyed) are model endpoints
// with no program of their own, so a harness always runs their turns: Pi or OMP when one of
// those is chosen, Pi (else OMP) when "provider" is chosen, the Copilot runtime when "copilot"
// is. The person's key stays in the gateway (gateway.mjs, /key/<provider>).
//
// The ACP agents (desktop/providers/acp) are whole agents with no model endpoint of their own:
// the Agent Client Protocol carries prompts and tool calls of the agent's own loop, never one
// model request, so they always run themselves, whichever is chosen.
import { join } from "node:path";
import { Gateway } from "./gateway.mjs";
import { OpenCodeRelay } from "./opencode.mjs";
import { chatgptSignIn } from "./chatgpt.mjs";
import { friendlyModel } from "../modelnames.mjs";
import { KEYED, KEYED_IDS } from "../providers/keyed/config.mjs";
import { copilotApi } from "../providers/copilot/relay.mjs";

export const HARNESSES = ["pi", "provider", "copilot", "omp"];
export const DEFAULT_HARNESS = "pi";
/** The program harnesses: each needs its program on this computer. */
const PROGRAMS = ["pi", "omp"];
/** How long whether a program is on this computer is believed before it is looked for again. */
const PROGRAM_CHECK_MS = 60_000;
/** A saved choice made whole: anything unknown is the usual one. */
export const harnessField = (value) => (HARNESSES.includes(value) ? value : DEFAULT_HARNESS);

/** The provider whose runtime is the one harness. */
export const HOST = "copilot";
/** The harness provider Pi (desktop/providers/pi). */
export const PI = "pi";
/** The enhanced Pi harness OMP (desktop/providers/omp). */
export const OMP = "omp";
const PI_COMPATIBLE = new Set([PI, OMP]);
/**
 * The plans the Copilot runtime can use for model requests, by the provider whose plan it is:
 * the name the runtime knows the connection by, and the format it speaks to the gateway.
 */
export const PLANS = {
  codex: { name: "chatgpt", type: "openai", wireApi: "responses", path: "/chatgpt", speed: true },
  claude: { name: "claude", type: "anthropic", path: "/claude", speed: true },
  opencode: { name: "opencode", type: "openai", wireApi: "completions", path: "/opencode" },
};
/** Copilot's model that the runtime itself chooses a model for: only the runtime can run it. */
export const COPILOT_AUTO = "auto";

/**
 * A plan's model as the Copilot runtime is told of it. The runtime can't look these models up, and
 * what it isn't told it assumes: 128,000 tokens of prompt and 8,192 of reply (measured, runtime
 * 2.0.1), which is a sixth of what a current model holds and a fraction of what it may write. So
 * it is told what the model's own provider states (the catalog entry, desktop/modeldetails.mjs):
 *   maxContextWindowTokens  the model's window
 *   maxOutputTokens         the most it may write; the runtime asks for all of it as reply room
 *   maxPromptTokens         the provider's own prompt limit; else the window less that reply room
 *                           (a request's prompt and reply room share the window); else the window
 *   capabilities            pictures and tools as the provider states them, and a thinking level
 *                           when it lists any
 * A value the provider doesn't state is left out. Nothing is made up here.
 */
export function planModel(provider, model) {
  const window = model.contextWindow;
  const output = model.maxOutput;
  const prompt = model.maxPrompt ?? (window && output && window > output ? window - output : window);
  return {
    id: model.id,
    provider,
    name: model.name ?? friendlyModel(model.id),
    ...(prompt && { maxPromptTokens: prompt }),
    ...(window && { maxContextWindowTokens: window }),
    ...(output && { maxOutputTokens: output }),
    capabilities: {
      supports: {
        ...(typeof model.vision === "boolean" && { vision: model.vision }),
        ...(typeof model.tools === "boolean" && { toolCalls: model.tools }),
        reasoningEffort: (model.efforts?.length ?? 0) > 0,
      },
    },
  };
}

/**
 * The plans as Pi is told of them (desktop/providers/pi/extension.mjs registers each): the name Pi
 * knows the connection by, and Pi's API for the gateway's path. The ChatGPT path takes the bot's
 * instructions as `instructions`, which Pi sends only when it isn't told to use a developer message.
 */
// Pi keeps a conversation's prompt cache for an hour (Settings › Keep prompt cache longer, which
// sets PI_CACHE_RETENTION) on a connection whose models don't say `supportsLongCacheRetention:
// false`. Measured live (2026-11-25): GitHub Copilot takes the longer cache on all three of its
// APIs; ChatGPT's plan endpoint refuses the request ("Unsupported parameter:
// prompt_cache_retention"); Claude Code decides a Claude plan's cache itself. A key provider's
// host may not know the field, and on a key a longer cache costs more to write: they keep the default.
export const PI_PLANS = {
  codex: { name: "botkins-chatgpt", title: "ChatGPT", api: "openai-responses", path: "/chatgpt", compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false }, speed: true },
  claude: { name: "botkins-claude", title: "Claude", api: "anthropic-messages", path: "/claude", speed: true },
  // The relay reads every system message, and OpenCode keeps no store: Pi is told so. The relay
  // names its session after the cache key, which OpenCode makes its own cache key (opencode.mjs).
  opencode: { name: "botkins-opencode", title: "OpenCode", api: "openai-completions", path: "/opencode", compat: { supportsDeveloperRole: false, supportsStore: false, promptCacheKeyMode: "enabled" } },
};
/**
 * GitHub Copilot's connections for Pi and OMP: one for each API Copilot's models speak, since a
 * connection has one (copilotApi in providers/copilot/relay.mjs says which a model speaks).
 */
export const COPILOT_CONNECTIONS = {
  messages: { name: "botkins-copilot-claude", title: "GitHub Copilot (Claude)", api: "anthropic-messages" },
  responses: { name: "botkins-copilot", title: "GitHub Copilot", api: "openai-responses", authHeader: true },
  completions: { name: "botkins-copilot-chat", title: "GitHub Copilot (Chat Completions)", api: "openai-completions", authHeader: true, compat: { supportsDeveloperRole: false, supportsStore: false } },
};
/**
 * A plan's model as Pi is told of it. Pi needs a window and a reply size; a model that states
 * neither gets Pi's own defaults. Pi reads `compat` from each model, not from its connection. A
 * model that thinks only adaptively says so, or Pi asks it for a thinking budget it refuses.
 */
export function piModel(model, compat) {
  const told = model.adaptiveThinking ? { ...compat, forceAdaptiveThinking: true } : compat;
  return {
    ...(told && { compat: told }),
    id: model.id,
    name: model.name ?? friendlyModel(model.id),
    reasoning: (model.efforts?.length ?? 0) > 0,
    input: model.vision === false ? ["text"] : ["text", "image"],
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxOutput ?? 16384,
    // The plan pays; Pi counts nothing.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * The connections of the key providers (desktop/providers/keyed): one for each API a provider's
 * models speak, since a connection has one. Chat Completions keeps the provider's own name and
 * the Responses API adds "-responses" (`botkins-foundry`, `botkins-foundry-responses`).
 */
export const keyConnection = (id, api) => (api === "responses" ? id + "-responses" : id);
/** What Pi is told of each key provider's models: the system role (every host takes it), and OpenRouter's reasoning format. */
const keyCompat = (id) => ({ supportsDeveloperRole: false, supportsLongCacheRetention: false, ...(id === "openrouter" && { thinkingFormat: "openrouter" }) });

export class Harness {
  /**
   * @param options.providers  The registry (desktop/providers/index.mjs).
   * @param options.choice     () => "copilot" | "provider" | "pi" | "omp", the person's setting.
   * @param options.dir        The data folder, for Claude Code's working folder.
   * @param options.bridge     The local tool server, which lists the runtime's tools to Claude Code.
   * @param options.version    Botkins' version.
   * @param options.gateway    For tests: a gateway to use instead of making one.
   */
  constructor({ providers, choice, picked = () => true, dir, bridge, version = "", gateway }) {
    Object.assign(this, { providers, choice, picked, dir, bridge });
    // Program harnesses known not to be on this computer, and when that was last looked at.
    this.missing = new Set();
    this.checkedAt = 0;
    const codex = providers.byId.get("codex");
    const claude = providers.byId.get("claude");
    this.gateway =
      gateway ??
      new Gateway({
        version,
        speedTier: async (provider, model, speed) => {
          const catalog = await this.providers.models();
          return catalog.find((m) => m.provider === provider && m.id === model)?.fastModes?.[speed];
        },
        chatgpt: codex && { signIn: () => chatgptSignIn(), renew: () => codex.renewSignIn?.() },
        keyed: (id) => this.providers.byId.get(id)?.connection?.() ?? null,
        copilot: () => this.host?.relay?.() ?? null,
        opencode: () => this.opencodeRelay(),
        claude: claude && (async () => ({ file: await claude.locate(), env: await claude.env(), cwd: join(dir, "harness", "claude"), bridge, report: (modelUsage) => claude.noteLimits?.(modelUsage) })),
        log: (line) => console.error(line),
      });
  }
  /** OpenCode's models for another harness (opencode.mjs), when this app has OpenCode. */
  opencodeRelay() {
    const provider = this.providers.byId.get("opencode");
    if (!provider || typeof provider.server !== "function") return null;
    this.relayed ??= new OpenCodeRelay({ provider, bridge: this.bridge, dir: join(this.dir, "harness", "opencode"), log: (line) => console.error(line) });
    return this.relayed;
  }
  /** The Copilot runtime, when this app has it. */
  get host() {
    return this.providers.byId.get(HOST) ?? null;
  }
  /**
   * True when the Copilot runtime runs this selection's turns although the model is another
   * provider's: the person chose one harness, and that provider's plan can answer its requests.
   */
  hosts(selection) {
    return this.via(selection) === HOST;
  }
  /** Pi, when this app has it. */
  get pi() {
    return this.providers.byId.get(PI) ?? null;
  }
  /** OMP, when this app has it. */
  get omp() {
    return this.providers.byId.get(OMP) ?? null;
  }
  /**
   * The harness that runs turns: the person's choice, or while nobody chose, the default, or the
   * next in the order when the default's program isn't on this computer (as far as `checkPrograms`
   * last saw).
   */
  effective() {
    const choice = harnessField(this.choice());
    if (this.picked() || !this.missing.has(choice)) return choice;
    return HARNESSES.slice(HARNESSES.indexOf(choice) + 1).find((id) => !this.missing.has(id)) ?? choice;
  }
  /** Looks for the program harnesses on this computer, at most once a minute. Never throws. */
  async checkPrograms(now = Date.now()) {
    if (now - this.checkedAt < PROGRAM_CHECK_MS) return this.checking;
    this.checkedAt = now;
    this.checking = Promise.all(
      PROGRAMS.map(async (id) => {
        const provider = this.providers.byId.get(id);
        const file = provider?.locate ? await provider.locate().catch(() => null) : null;
        if (file) this.missing.delete(id);
        else this.missing.add(id);
      }),
    ).then(() => {});
    return this.checking;
  }
  /**
   * Which harness runs a selection's turns when it isn't the model's own provider: "copilot" (the
   * Copilot runtime), "pi", "omp", or null (the provider runs them itself).
   *   ChatGPT, Claude, OpenCode  the chosen harness; "provider" leaves each to its own program
   *   GitHub Copilot             Pi or OMP when chosen; its own runtime otherwise (that is the
   *                              "copilot" harness), and always for its "auto" model
   *   a key provider             always a harness (keyedVia)
   *   an ACP agent               itself: it is a whole agent, with no model endpoint
   */
  via(selection) {
    const owner = this.providers.for(selection);
    const choice = this.effective();
    if (KEYED_IDS.includes(owner.id)) return this.keyedVia(choice);
    if (owner.id === HOST) return this.copilotVia(choice, selection);
    if (!Object.hasOwn(PLANS, owner.id)) return null;
    if (choice === "copilot" && this.host && owner !== this.host) return HOST;
    if (PI_COMPATIBLE.has(choice) && this.providers.byId.has(choice)) return choice;
    return null;
  }
  /** GitHub Copilot's models go to Pi or OMP when one is chosen and the runtime can lend its sign-in. */
  copilotVia(choice, selection) {
    if (!PI_COMPATIBLE.has(choice) || !this.providers.byId.has(choice)) return null;
    if (selection.model === COPILOT_AUTO || typeof this.host?.relay !== "function" || !this.host.relay()) return null;
    return choice;
  }
  /**
   * The route of a key provider's turns. They have no program, so every choice has one: Pi or OMP
   * as chosen; for "provider", Pi, else OMP, while their program is on this computer; the Copilot
   * runtime for "copilot". Null when none can run them (the provider then says why).
   */
  keyedVia(choice) {
    const here = (id) => this.providers.byId.has(id);
    if (PI_COMPATIBLE.has(choice)) return here(choice) ? choice : null;
    if (choice === "copilot") return this.host ? HOST : null;
    return [PI, OMP].find((id) => here(id) && !this.missing.has(id)) ?? (here(PI) ? PI : null);
  }
  /** The provider that runs a selection's turns (`route` as via() says, when known). */
  runner(selection, route = this.via(selection)) {
    return PI_COMPATIBLE.has(route) ? this.providers.byId.get(route) : route === HOST ? this.host : this.providers.for(selection);
  }
  /**
   * What the Copilot runtime is given to run a selection of another provider's plan:
   * { model, inference }. `model` names the selection the runtime's way; `inference` is the
   * connections to the gateway and the models each plan offers, so a chat can change model
   * without a new session.
   */
  async session(selection, route = HOST) {
    const base = await this.gateway.start();
    const owner = this.providers.for(selection);
    const plan = PLANS[owner.id];
    const keyedOwner = KEYED_IDS.includes(owner.id);
    // A chat on a Claude plan's model is opening: Claude Code is started now, so it has finished
    // starting when the first message comes (harness/claude.mjs).
    if (owner.id === "claude") void this.gateway.warm?.(selection.model);
    const catalog = await this.providers.models().catch(() => []);
    // The URL is part of each session's inference configuration. Concurrent chats can
    // have different speeds, and a speed change invalidates a warm harness connection.
    const speed = selection.fastMode;
    const speedPath = speed === "fast" || speed === "ultrafast" ? "/" + speed : "";
    const listed = (id) => {
      const list = catalog.filter((model) => model.provider === id && model.available !== false);
      // The chosen model is offered even when its provider's list couldn't be read just now.
      if (id === owner.id && !list.some((model) => model.id === selection.model))
        list.push({ id: selection.model, name: friendlyModel(selection.model), efforts: selection.reasoningEffort ? [selection.reasoningEffort] : [], ...(keyedOwner && { api: owner.apiFor?.(selection.model) ?? "completions" }) });
      return list;
    };
    // The key providers' models, by connection: [{ id, api, connection, title, models }].
    const keyed = () =>
      KEYED_IDS.filter((id) => this.providers.byId.has(id)).flatMap((id) =>
        ["completions", "responses"]
          .map((api) => ({ id, api, connection: keyConnection(id, api), title: KEYED[id].name + (api === "responses" ? " (Responses)" : ""), models: listed(id).filter((model) => (model.api === "responses" ? "responses" : "completions") === api) }))
          .filter((group) => group.models.length),
      );
    /** The connection that serves the selected model, when its provider is a key provider. */
    const keySource = () => keyConnection(owner.id, owner.apiFor?.(selection.model) ?? listed(owner.id).find((model) => model.id === selection.model)?.api ?? "completions");
    if (PI_COMPATIBLE.has(route)) {
      // GitHub Copilot's models, by the API each speaks (COPILOT_CONNECTIONS). The selected model's
      // API is looked up in GitHub's own list when it is a Copilot model; the others go by what was
      // last looked up, else by their names.
      const copilot = this.copilotRelay();
      const copilotModels = copilot ? listed(HOST).filter((model) => model.id !== COPILOT_AUTO) : [];
      const apis = copilotModels.length ? await this.copilotApis(owner.id === HOST ? selection.model : null) : new Map();
      const apiOf = (id) => apis.get(id) ?? copilotApi(id);
      // Pi and OMP are given a connection for each plan that has models, with those models.
      const providers = [
        ...Object.entries(PI_PLANS)
          .map(([id, each]) => ({ id, each, models: listed(id) }))
          .filter(({ models }) => models.length)
          .map(({ each, models }) => ({
            name: each.name,
            config: { name: each.title, baseUrl: base + each.path + (each.speed ? speedPath : ""), api: each.api, apiKey: this.gateway.secret, ...(each.api !== "anthropic-messages" && { authHeader: true }), models: models.map((model) => piModel(model, each.compat)) },
          })),
        // Copilot's connections: Pi's own header carries this run's secret; the gateway signs the request.
        ...Object.entries(COPILOT_CONNECTIONS)
          .map(([api, each]) => ({ each, models: copilotModels.filter((model) => apiOf(model.id) === api) }))
          .filter(({ models }) => models.length)
          .map(({ each, models }) => ({
            name: each.name,
            config: { name: each.title, baseUrl: base + "/copilot", api: each.api, apiKey: this.gateway.secret, ...(each.authHeader && { authHeader: true }), models: models.map((model) => piModel(model, each.compat)) },
          })),
        // A key provider's connection to the gateway: Pi's own Bearer header carries this run's secret, never the key.
        ...keyed().map((group) => ({
          name: "botkins-" + group.connection,
          config: { name: group.title, baseUrl: base + "/key/" + group.id, api: group.api === "responses" ? "openai-responses" : "openai-completions", apiKey: this.gateway.secret, authHeader: true, models: group.models.map((model) => piModel(model, keyCompat(group.id))) },
        })),
      ];
      const source = keyedOwner ? "botkins-" + keySource() : owner.id === HOST ? COPILOT_CONNECTIONS[apiOf(selection.model)].name : PI_PLANS[owner.id].name;
      return {
        model: { model: selection.model, source, ...(selection.reasoningEffort && { reasoningEffort: selection.reasoningEffort }) },
        inference: { providers },
      };
    }
    const models = [];
    for (const [id, each] of Object.entries(PLANS)) for (const model of listed(id)) models.push(planModel(each.name, model));
    // The Copilot runtime reaches a key provider as an OpenAI connection, in the API the model speaks.
    const groups = keyed();
    for (const group of groups) for (const model of group.models) models.push(planModel(group.connection, model));
    const named = new Set(models.map((model) => model.provider));
    return {
      model: { model: selection.model, source: keyedOwner ? keySource() : plan.name, ...(selection.reasoningEffort && { reasoningEffort: selection.reasoningEffort }) },
      inference: {
        providers: [
          ...Object.values(PLANS)
            .filter((each) => named.has(each.name))
            .map((each) => ({ name: each.name, type: each.type, ...(each.wireApi && { wireApi: each.wireApi }), baseUrl: base + each.path + (each.speed ? speedPath : ""), bearerToken: this.gateway.secret })),
          ...groups.map((group) => ({ name: group.connection, type: "openai", wireApi: group.api, baseUrl: base + "/key/" + group.id, bearerToken: this.gateway.secret })),
        ],
        models,
      },
    };
  }
  /** The Copilot relay (providers/copilot/relay.mjs), when the Copilot runtime can lend its sign-in. */
  copilotRelay() {
    return typeof this.host?.relay === "function" ? this.host.relay() : null;
  }
  /**
   * Which API each Copilot model speaks, as GitHub lists it: looked up (and waited for, up to a
   * few seconds) when `model`, a Copilot model, is the one a chat uses; else what was last looked
   * up. Copilot's own names say the rest (copilotApi).
   */
  async copilotApis(model) {
    const relay = this.copilotRelay();
    if (!relay) return new Map();
    if (!model) return relay.endpointList?.map ?? new Map();
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(relay.endpointList?.map ?? new Map()), 8000)));
    try {
      return await Promise.race([relay.endpoints(model), late]);
    } finally {
      clearTimeout(timer);
    }
  }
  stop() {
    void this.relayed?.stop();
    return this.gateway.stop();
  }
}
