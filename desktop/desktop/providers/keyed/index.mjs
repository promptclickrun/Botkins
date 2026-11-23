// Model providers that answer on a key: OpenRouter, Azure Foundry and an OpenAI endpoint
// (Settings › Model providers, `botkins providers login|set`).
//
// None of them has a program of its own. A chat on one of their models runs in a harness (Pi,
// OMP, or the Copilot runtime, see desktop/harness/index.mjs), and the harness sends its model
// requests to the local gateway (desktop/harness/gateway.mjs, POST /key/<id>/…), which adds the
// real key from the credential vault and forwards them. So the key never reaches a harness, a
// log or the app's page: this class reads it from the vault only to say whether there is one
// (status) and to give the gateway its connection (connection).
//
// The settings that are not secret (an endpoint, the models a person deployed) are kept in
// <data>/keyed/<id>.json, checked by config.mjs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelProvider } from "../provider.mjs";
import { modelDetails } from "../../modeldetails.mjs";
import { KEYED, KEYED_IDS, OPENROUTER_BASE, modelApi, needs, normaliseConfig } from "./config.mjs";

/**
 * A server's model list is often every model it has, most of which can't hold a chat: an Azure
 * resource listed 501, from DALL·E and Whisper up (Nov 2026). These are left out of the picker. A
 * person can still name one by hand (the configured models).
 */
const NOT_CHAT = /(^|[/:_-])(text-embedding|embedding|embed|tts|whisper|dall-e|gpt-image|image|moderation|transcribe|realtime|audio|davinci|babbage|sora|computer-use|search-preview)(?=$|[/:_.-])/i;
/** An entry whose server says it can't chat (Azure's `capabilities`), or whose retirement date has passed. */
function chats(item) {
  if (!item || typeof item !== "object") return false;
  const can = item.capabilities;
  if (can && typeof can === "object" && can.chat_completion === false) return false;
  const retired = Date.parse(item.deprecation?.inference ?? "");
  return !(Number.isFinite(retired) && retired < Date.now());
}

export { KEYED, KEYED_IDS, KEY_PATHS } from "./config.mjs";

/** Where a provider's key is kept in the vault: the same place as a token pasted for any provider (desktop/terminal/signin.mjs). */
export const keyVaultId = (id) => "terminal-provider-" + id;

const LIST_MS = 7000;
/** OpenRouter's list is large and changes slowly. */
const OPENROUTER_FRESH = 10 * 60_000;
const MAX_LISTED = 500;
/** What OpenRouter takes as `reasoning.effort`. */
const EFFORTS = ["low", "medium", "high"];

export class KeyedProvider extends ModelProvider {
  /**
   * @param options.id       "openrouter", "foundry" or "openai-api".
   * @param options.dataDir  Where the settings file is kept.
   * @param options.vault    () => the credential vault.
   * @param options.fetch    For tests.
   */
  constructor({ id, dataDir, vault, fetch: fetcher = globalThis.fetch }) {
    super();
    if (!KEYED[id]) throw new Error("Unknown keyed provider " + id);
    const spec = KEYED[id];
    this.id = id;
    this.name = spec.name;
    this.description = spec.description;
    // Off until the person adds a key (or settings) for it.
    this.defaultEnabled = false;
    this.spec = spec;
    this.file = join(dataDir, id + ".json");
    this.vault = vault;
    this.fetch = fetcher;
    this.saved = undefined;
    this.listed = null;
  }

  // ── Key and settings ────────────────────────────────────────────────────────────────────────

  /** The key, or null. Only the gateway and the model list read it. */
  key() {
    try {
      return this.vault()?.get(keyVaultId(this.id)) || null;
    } catch {
      return null;
    }
  }
  hasKey() {
    try {
      return !!this.vault()?.has(keyVaultId(this.id));
    } catch {
      return false;
    }
  }
  /** The settings kept, as normaliseConfig makes them; a missing or damaged file is no settings. */
  config() {
    if (this.saved === undefined) {
      try {
        this.saved = normaliseConfig(this.id, JSON.parse(readFileSync(this.file, "utf8")));
      } catch {
        this.saved = normaliseConfig(this.id, {});
      }
    }
    return structuredClone(this.saved);
  }
  /** Replaces the settings (the whole of them). Throws a sentence when a value isn't acceptable. */
  configure(raw) {
    const config = normaliseConfig(this.id, raw);
    if (this.spec.fields.length) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + ".tmp", JSON.stringify(config), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    }
    this.saved = config;
    this.listed = null;
    return this.config();
  }
  /** The API a model is spoken to in. */
  apiFor(modelId) {
    const config = this.config();
    return modelApi(config, config.models?.find((model) => model.id === modelId));
  }

  // ── What the gateway needs ──────────────────────────────────────────────────────────────────

  /**
   * Where the gateway sends this provider's requests: { baseUrl, query?, headers, secrets }, or null
   * when something is missing. `secrets` are the values to keep out of any error text.
   */
  connection() {
    const key = this.key();
    const config = this.config();
    if (needs(this.id, config, !!key)) return null;
    if (this.id === "openrouter") return { baseUrl: OPENROUTER_BASE, headers: { authorization: "Bearer " + key, "http-referer": "https://botkins.app", "x-title": "Botkins" }, secrets: [key] };
    if (this.id === "foundry") return { baseUrl: config.endpoint, ...(config.apiVersion && { query: { "api-version": config.apiVersion } }), headers: { "api-key": key }, secrets: [key] };
    return { baseUrl: config.baseUrl, headers: key ? { authorization: "Bearer " + key } : {}, secrets: key ? [key] : [] };
  }

  // ── The contract ────────────────────────────────────────────────────────────────────────────

  /** The status, by what is kept: asks nothing. */
  snapshot() {
    const config = this.config();
    const hasKey = this.hasKey();
    const missing = needs(this.id, config, hasKey);
    return {
      installed: true,
      connected: !missing,
      signIn: "key",
      signOut: hasKey,
      ...(hasKey && { plan: "API key" }),
      ...(missing && { message: missing }),
      keyed: {
        fields: [...this.spec.fields],
        hasKey,
        keyOptional: this.spec.keyOptional,
        config,
        needs: missing,
        ...(this.spec.keyUrl && { keyUrl: this.spec.keyUrl }),
      },
    };
  }
  async status() {
    return this.snapshot();
  }
  /** While switched off the provider still shows its settings, so they can be filled in before it is turned on. */
  dormant() {
    const { connected: _connected, ...rest } = this.snapshot();
    return rest;
  }
  async auth() {
    const status = await this.status();
    return { connected: status.connected, type: status.plan };
  }
  /** The key is removed by the sign-in code (desktop/terminal/signin.mjs); the settings stay. */
  async signOut() {
    this.listed = null;
  }
  async models() {
    if (this.id === "openrouter") return this.openRouterModels();
    const config = this.config();
    const configured = (config.models ?? []).map((model) => this.entry(model.id, model, config));
    if (this.id === "foundry") return configured;
    // The server's own list (ids only), with the configured models over it.
    let found = [];
    try {
      found = await this.serverModels(config);
    } catch (error) {
      if (!configured.length) throw error;
    }
    const known = new Set(configured.map((model) => model.id));
    return [...configured, ...found.filter((id) => !known.has(id)).map((id) => this.entry(id, {}, config))];
  }
  entry(id, model, config) {
    return {
      id,
      name: model.name ?? id,
      provider: this.id,
      api: modelApi(config, model),
      efforts: [],
      // The endpoint's models are used for what a bot does: calling tools.
      ...modelDetails({ tools: true, contextWindow: model.contextWindow, maxOutput: model.maxOutput }),
      available: true,
    };
  }
  async json(url, headers) {
    const answer = await this.fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(LIST_MS), redirect: "error" });
    if (!answer.ok) throw new Error(this.name + " answered " + answer.status + " to the model list.");
    return answer.json();
  }
  /** `GET <baseUrl>/models`: the ids a server lists that a bot can chat with. */
  async serverModels(config) {
    if (!config.baseUrl) return [];
    const key = this.key();
    let body;
    try {
      body = await this.json(config.baseUrl + "/models", key ? { authorization: "Bearer " + key } : {});
    } catch (error) {
      throw new Error("Couldn't read the model list from " + new URL(config.baseUrl).host + ": " + (error?.cause?.code ?? error?.message ?? error));
    }
    const items = (Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []).filter((item) => typeof item === "string" || chats(item));
    const ids = items.map((item) => (typeof item === "string" ? item : item?.id));
    return [...new Set(ids.filter((id) => typeof id === "string" && id && id.length <= 200 && !NOT_CHAT.test(id)))].slice(0, MAX_LISTED);
  }
  /** OpenRouter's public list, keeping the models that can call tools (a bot's work is tool calls). */
  async openRouterModels() {
    if (this.listed && Date.now() - this.listed.time < OPENROUTER_FRESH) return this.listed.models;
    let body;
    try {
      body = await this.json(OPENROUTER_BASE + "/models", {});
    } catch (error) {
      // An earlier list is better than none.
      if (this.listed) return this.listed.models;
      throw error;
    }
    const models = (Array.isArray(body?.data) ? body.data : [])
      .filter((model) => typeof model?.id === "string" && model.id && Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools"))
      .map((model) => {
        const reasoning = model.supported_parameters.includes("reasoning");
        const input = model.architecture?.input_modalities;
        return {
          id: model.id,
          name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id,
          provider: this.id,
          api: "completions",
          efforts: reasoning ? EFFORTS : [],
          ...modelDetails({
            description: model.description,
            vision: Array.isArray(input) ? input.includes("image") : undefined,
            tools: true,
            contextWindow: model.context_length,
            maxOutput: model.top_provider?.max_completion_tokens,
            vendor: model.id.includes("/") ? model.id.split("/")[0] : undefined,
          }),
          available: true,
        };
      });
    this.listed = { time: Date.now(), models };
    return models;
  }
  async openSession() {
    throw new Error(
      this.name + " has no program of its own: a chat on its models runs in Pi, OMP or the Copilot runtime. Choose one in Settings › General › Harness (and install Pi or OMP if it isn't on this computer).",
    );
  }
  async version() {
    return this.name;
  }
}

/** The three providers, for desktop/runtime.mjs. */
export const keyedProviders = (options) => KEYED_IDS.map((id) => new KeyedProvider({ ...options, id }));
