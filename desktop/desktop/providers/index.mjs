// The registry of model providers. The first one registered is the default: the provider of a
// model selection that names none. Selections saved before the registry existed are such
// selections (they were GitHub Copilot's), and so is one that names a provider that was removed.
// That is all "default" means here. It does not make that provider the one a person is steered
// to: a new workspace's default model comes from the provider the person connects
// (Workspace.firstDefaultModel).
//
// The person chooses which providers Botkins uses (Settings › Model providers). The registry
// keeps each provider's status and model list for a short while, because the pickers ask often
// and a provider built on a command-line tool can take seconds to answer.
import { ModelProvider } from "./provider.mjs";
import { friendlyName } from "../modelnames.mjs";

export { defineTool, ModelProvider, ProviderSession } from "./provider.mjs";

/**
 * The three providers a person is offered first when they set the app up, in the order they are
 * shown: ChatGPT, Claude, GitHub Copilot (alphabetical). None is recommended over the others.
 */
export const SETUP_ORDER = ["codex", "claude", "copilot"];

const STATUS_FRESH = 30_000;
const MODELS_FRESH = 60_000;

/** Resolves with `value` after `ms` unless `promise` settles first. */
const within = (promise, ms, value) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(value), ms)))]).finally(() => clearTimeout(timer));
};
const WAITING = Symbol("waiting");

export class Providers {
  /**
   * @param options.statusWait  How long a status may take before the provider is reported as still starting.
   * @param options.modelsWait  How long the catalog waits for one provider's models before going on without them.
   */
  constructor(list, { statusWait = 12000, modelsWait = 8000 } = {}) {
    if (!list?.length) throw new Error("Botkins needs at least one model provider.");
    for (const p of list) if (!(p instanceof ModelProvider) || !p.id) throw new Error("Invalid model provider");
    // A harness (Pi) runs other providers' models and has none of its own: it is found by its id,
    // for the conversations it runs, but it isn't one of the model providers.
    this.list = list.filter((p) => !p.harness);
    this.harnesses = list.filter((p) => p.harness);
    if (!this.list.length) throw new Error("Botkins needs at least one model provider.");
    this.byId = new Map(list.map((p) => [p.id, p]));
    this.default = this.list[0];
    this.statusWait = statusWait;
    this.modelsWait = modelsWait;
    this.statusCache = new Map();
    this.modelCache = new Map();
    // Until the workspace says otherwise, each provider is on or off as it comes.
    this.isEnabled = (provider) => provider.defaultEnabled !== false;
    this.changed = () => {};
  }
  /**
   * @param options.enabled  (provider) => whether the person has this provider switched on.
   * @param options.changed  Called when a provider that was slow to answer has answered, so the app can look again.
   */
  configure({ enabled, changed } = {}) {
    if (enabled) this.isEnabled = enabled;
    if (changed) this.changed = changed;
  }
  get(id) {
    return this.byId.get(id) ?? this.default;
  }
  /** The folders that the providers' runtimes give one conversation for its own files (most give none). */
  sessionFolders(sessionId) {
    return this.list.map((provider) => provider.sessionFiles(sessionId)).filter(Boolean);
  }
  /** The provider with this id. Unlike get(), an unknown id is an error. */
  require(id) {
    const provider = this.byId.get(id);
    if (!provider) throw new Error("Unknown model provider");
    return provider;
  }
  /** The provider behind a model selection. */
  for(selection) {
    return this.get(selection?.provider);
  }
  enabled() {
    return this.list.filter((p) => this.isEnabled(p));
  }
  /** Forgets what is remembered about one provider (or all), after a sign-in, a sign-out or a switch. */
  invalidate(id) {
    for (const cache of [this.statusCache, this.modelCache]) id ? cache.delete(id) : cache.clear();
  }
  /** A cached answer: the remembered one while fresh, else a new request that everyone waiting shares. */
  cached(cache, id, fresh, load) {
    const entry = cache.get(id);
    if (entry && (entry.loading || Date.now() - entry.time < fresh)) return entry;
    const next = { time: entry?.time ?? 0, value: entry?.value, error: undefined };
    next.loading = load()
      .then(
        (value) => Object.assign(next, { value, error: undefined }),
        (error) => Object.assign(next, { error }),
      )
      .finally(() => {
        next.time = Date.now();
        next.loading = null;
      });
    cache.set(id, next);
    return next;
  }
  /**
   * Every provider as Settings shows it: { id, name, description, enabled, default, ...status() }.
   * A provider that is switched off is not asked anything. One that fails is reported with `error`;
   * one that takes too long is reported with `starting` and asked about again when it answers.
   */
  async statuses({ refresh = false } = {}) {
    if (refresh) this.statusCache.clear();
    return Promise.all(
      this.list.map(async (provider) => {
        const base = { id: provider.id, name: provider.name, description: provider.description, enabled: this.isEnabled(provider), default: provider === this.default };
        if (!base.enabled) return { ...base, installed: true, connected: false, signIn: null, signOut: false };
        const entry = this.cached(this.statusCache, provider.id, STATUS_FRESH, () => provider.status());
        if (entry.loading) {
          const done = await within(entry.loading, this.statusWait, WAITING);
          if (done === WAITING) {
            entry.loading?.then(() => this.changed());
            return { ...base, installed: true, connected: !!entry.value?.connected, signIn: null, signOut: false, ...entry.value, starting: true };
          }
        }
        if (entry.error) return { ...base, installed: true, connected: false, signIn: null, signOut: false, error: String(entry.error.message ?? entry.error).slice(0, 500) };
        return { ...base, ...entry.value };
      }),
    );
  }
  /** One provider's status, as statuses() reports it; a harness's as harnessStatuses() does. */
  async status(id) {
    const provider = this.require(id);
    if (provider.harness) return (await this.harnessStatuses()).find((s) => s.id === provider.id);
    return (await this.statuses()).find((s) => s.id === provider.id);
  }
  /** Each harness (Pi), as statuses() reports a provider, with `harness: true`. */
  async harnessStatuses() {
    return Promise.all(
      this.harnesses.map(async (provider) => {
        const base = { id: provider.id, name: provider.name, description: provider.description, enabled: true, default: false, harness: true };
        const entry = this.cached(this.statusCache, provider.id, STATUS_FRESH, () => provider.status());
        if (entry.loading) await entry.loading;
        if (entry.error) return { ...base, installed: false, connected: false, signIn: null, signOut: false, error: String(entry.error.message ?? entry.error).slice(0, 500) };
        return { ...base, ...entry.value };
      }),
    );
  }
  /**
   * The models of every provider that is switched on and connected, in one catalog. Each entry
   * names its provider. A provider that fails or is slow is left out this time (a slow one's
   * earlier list is used when there is one); the catalog only fails when nothing could be listed.
   */
  async models() {
    const statuses = await this.statuses();
    const errors = [];
    const lists = await Promise.all(
      statuses.map(async (status) => {
        const provider = this.byId.get(status.id);
        if (!status.enabled) return [];
        // Signed out means no models. A status that couldn't be read says nothing, so the models are still asked for.
        if (!status.connected && !status.error) return [];
        const entry = this.cached(this.modelCache, provider.id, MODELS_FRESH, () => provider.models());
        if (entry.loading) {
          const done = await within(entry.loading, this.modelsWait, WAITING);
          if (done === WAITING) entry.loading?.then(() => this.changed());
        }
        if (entry.error && !entry.loading) {
          errors.push(entry.error);
          console.error(provider.name + " models:", entry.error.message);
        }
        // Every model goes by a name people read, never by its id (desktop/modelnames.mjs).
        return (entry.value ?? []).map((model) => ({ ...model, name: friendlyName(model.name, model.id), provider: provider.id, providerName: provider.name }));
      }),
    );
    const catalog = lists.flat();
    if (!catalog.length && errors.length) throw errors[0];
    return catalog;
  }
  /**
   * What the catalog last said about a selection's model, without asking again: its entry, or
   * null when its provider hasn't listed it yet. For code that can't wait (a turn's events).
   */
  known(selection) {
    if (!selection?.model) return null;
    const provider = this.for(selection);
    return (this.modelCache.get(provider.id)?.value ?? []).find((model) => model.id === selection.model) ?? null;
  }
  /** Every enabled provider's existing agents (ModelProvider.agents), each with its provider's id and name. */
  async agents() {
    const lists = await Promise.all(
      this.enabled().map((p) =>
        p
          .agents()
          .then((agents) => agents.map((agent) => ({ ...agent, provider: p.id, providerName: p.name })))
          .catch((error) => {
            console.error(p.name + " agents:", error.message);
            return [];
          }),
      ),
    );
    return lists.flat();
  }
  async stop() {
    await Promise.allSettled([...this.list, ...this.harnesses].map((p) => p.stop()));
  }
}
