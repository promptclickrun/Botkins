// The harness: what runs a bot's turn (the loop, the tools, the approvals) around the model.
//
// Settings › General offers four choices (settings.harness):
//   "copilot"   One harness for every plan. The Copilot runtime runs the turn, and the model's own
//               plan answers the model requests: GitHub Copilot's models as always, a ChatGPT plan
//               and a Claude plan through the gateway (gateway.mjs). Skills, tools, MCP servers
//               and their sign-ins, plugins and approvals are then the same whichever model a chat
//               uses, because one program carries them. This is the usual choice.
//   "provider"  Each provider's own tool runs the turn, as before: Codex for ChatGPT, Claude Code
//               for Claude, the Copilot runtime for GitHub Copilot.
//   "pi"        Pi (pi.dev, desktop/providers/pi) runs the turns of ChatGPT and Claude plan
//               models, and the plan answers through the same gateway. GitHub Copilot's models
//               stay on the Copilot runtime, which their plan needs.
//   "omp"       OMP (omp.sh), the enhanced Pi harness, runs the same plan models through the
//               same gateway and Botkins safety layer.
//
// OpenCode and the ACP agents are whole agents, not model endpoints, so they always run
// themselves, whichever is chosen.
import { join } from "node:path";
import { Gateway } from "./gateway.mjs";
import { chatgptSignIn } from "./chatgpt.mjs";
import { friendlyModel } from "../modelnames.mjs";

export const HARNESSES = ["copilot", "provider", "pi", "omp"];
export const DEFAULT_HARNESS = "copilot";
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
  codex: { name: "chatgpt", type: "openai", wireApi: "responses", path: "/chatgpt" },
  claude: { name: "claude", type: "anthropic", path: "/claude" },
};

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
export const PI_PLANS = {
  codex: { name: "botkins-chatgpt", title: "ChatGPT", api: "openai-responses", path: "/chatgpt", compat: { supportsDeveloperRole: false } },
  claude: { name: "botkins-claude", title: "Claude", api: "anthropic-messages", path: "/claude" },
};
/**
 * A plan's model as Pi is told of it. Pi needs a window and a reply size; a model that states
 * neither gets Pi's own defaults. Pi reads `compat` from each model, not from its connection.
 */
export function piModel(model, compat) {
  return {
    ...(compat && { compat }),
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

export class Harness {
  /**
   * @param options.providers  The registry (desktop/providers/index.mjs).
   * @param options.choice     () => "copilot" | "provider" | "pi" | "omp", the person's setting.
   * @param options.dir        The data folder, for Claude Code's working folder.
   * @param options.bridge     The local tool server, which lists the runtime's tools to Claude Code.
   * @param options.version    Botkins' version.
   * @param options.gateway    For tests: a gateway to use instead of making one.
   */
  constructor({ providers, choice, dir, bridge, version = "", gateway }) {
    Object.assign(this, { providers, choice, dir, bridge });
    const codex = providers.byId.get("codex");
    const claude = providers.byId.get("claude");
    this.gateway =
      gateway ??
      new Gateway({
        version,
        chatgpt: codex && { signIn: () => chatgptSignIn(), renew: () => codex.renewSignIn?.() },
        claude: claude && (async () => ({ file: await claude.locate(), env: await claude.env(), cwd: join(dir, "harness", "claude"), bridge, report: (modelUsage) => claude.noteLimits?.(modelUsage) })),
        log: (line) => console.error(line),
      });
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
   * Which harness runs a selection's turns when it isn't the model's own provider: "copilot" (the
   * Copilot runtime), "pi", "omp", or null. Only a plan the gateway carries can be run by another.
   */
  via(selection) {
    const owner = this.providers.for(selection);
    if (!Object.hasOwn(PLANS, owner.id)) return null;
    const choice = harnessField(this.choice());
    if (choice === "copilot" && this.host && owner !== this.host) return HOST;
    if (PI_COMPATIBLE.has(choice) && this.providers.byId.has(choice)) return choice;
    return null;
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
    // A chat on a Claude plan's model is opening: Claude Code is started now, so it has finished
    // starting when the first message comes (harness/claude.mjs).
    if (owner.id === "claude") void this.gateway.warm?.(selection.model);
    const catalog = await this.providers.models().catch(() => []);
    const listed = (id) => {
      const list = catalog.filter((model) => model.provider === id && model.available !== false);
      // The chosen model is offered even when its provider's list couldn't be read just now.
      if (id === owner.id && !list.some((model) => model.id === selection.model)) list.push({ id: selection.model, name: friendlyModel(selection.model), efforts: selection.reasoningEffort ? [selection.reasoningEffort] : [] });
      return list;
    };
    if (PI_COMPATIBLE.has(route)) {
      // Pi and OMP are given a connection for each plan that has models, with those models.
      const providers = Object.entries(PI_PLANS)
        .map(([id, each]) => ({ id, each, models: listed(id) }))
        .filter(({ models }) => models.length)
        .map(({ each, models }) => ({
          name: each.name,
          config: { name: each.title, baseUrl: base + each.path, api: each.api, apiKey: this.gateway.secret, ...(each.api === "openai-responses" && { authHeader: true }), models: models.map((model) => piModel(model, each.compat)) },
        }));
      return {
        model: { model: selection.model, source: PI_PLANS[owner.id].name, ...(selection.reasoningEffort && { reasoningEffort: selection.reasoningEffort }) },
        inference: { providers },
      };
    }
    const models = [];
    for (const [id, each] of Object.entries(PLANS)) for (const model of listed(id)) models.push(planModel(each.name, model));
    const named = new Set(models.map((model) => model.provider));
    return {
      model: { model: selection.model, source: plan.name, ...(selection.reasoningEffort && { reasoningEffort: selection.reasoningEffort }) },
      inference: {
        providers: Object.values(PLANS)
          .filter((each) => named.has(each.name))
          .map((each) => ({ name: each.name, type: each.type, ...(each.wireApi && { wireApi: each.wireApi }), baseUrl: base + each.path, bearerToken: this.gateway.secret })),
        models,
      },
    };
  }
  stop() {
    return this.gateway.stop();
  }
}
