// The harness: what runs a bot's turn (the loop, the tools, the approvals) around the model.
//
// Settings › General offers two (settings.harness):
//   "copilot"   One harness for every plan. The Copilot runtime runs the turn, and the model's own
//               plan answers the model requests: GitHub Copilot's models as always, a ChatGPT plan
//               and a Claude plan through the gateway (gateway.mjs). Skills, tools, MCP servers
//               and their sign-ins, plugins and approvals are then the same whichever model a chat
//               uses, because one program carries them. This is the usual choice.
//   "provider"  Each provider's own tool runs the turn, as before: Codex for ChatGPT, Claude Code
//               for Claude, the Copilot runtime for GitHub Copilot.
//
// OpenCode and the ACP agents are whole agents, not model endpoints, so they always run
// themselves, whichever is chosen.
import { join } from "node:path";
import { Gateway } from "./gateway.mjs";
import { chatgptSignIn } from "./chatgpt.mjs";
import { friendlyModel } from "../modelnames.mjs";

export const HARNESSES = ["copilot", "provider"];
export const DEFAULT_HARNESS = "copilot";
/** A saved choice made whole: anything unknown is the usual one. */
export const harnessField = (value) => (HARNESSES.includes(value) ? value : DEFAULT_HARNESS);

/** The provider whose runtime is the one harness. */
export const HOST = "copilot";
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

export class Harness {
  /**
   * @param options.providers  The registry (desktop/providers/index.mjs).
   * @param options.choice     () => "copilot" | "provider", the person's setting.
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
    const owner = this.providers.for(selection);
    return harnessField(this.choice()) === "copilot" && !!this.host && owner !== this.host && Object.hasOwn(PLANS, owner.id);
  }
  /** The provider that runs a selection's turns. */
  runner(selection) {
    return this.hosts(selection) ? this.host : this.providers.for(selection);
  }
  /**
   * What the Copilot runtime is given to run a selection of another provider's plan:
   * { model, inference }. `model` names the selection the runtime's way; `inference` is the
   * connections to the gateway and the models each plan offers, so a chat can change model
   * without a new session.
   */
  async session(selection) {
    const base = await this.gateway.start();
    const owner = this.providers.for(selection);
    const plan = PLANS[owner.id];
    // A chat on a Claude plan's model is opening: Claude Code is started now, so it has finished
    // starting when the first message comes (harness/claude.mjs).
    if (owner.id === "claude") void this.gateway.warm?.(selection.model);
    const catalog = await this.providers.models().catch(() => []);
    const models = [];
    for (const [id, each] of Object.entries(PLANS)) {
      const listed = catalog.filter((model) => model.provider === id && model.available !== false);
      // The chosen model is offered even when its provider's list couldn't be read just now.
      if (id === owner.id && !listed.some((model) => model.id === selection.model)) listed.push({ id: selection.model, name: friendlyModel(selection.model), efforts: selection.reasoningEffort ? [selection.reasoningEffort] : [] });
      for (const model of listed) models.push(planModel(each.name, model));
    }
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
