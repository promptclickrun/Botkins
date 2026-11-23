// The model providers and their models, loaded once and shared by every picker, Settings and the
// welcome. Both lists are asked again whenever State.providers.revision goes up (a sign-in finished,
// a slow provider finished starting, one was switched on or off).
import { friendlyModel } from "../desktop/modelnames.mjs";
import { useEffect, useSyncExternalStore } from "react";
import type { ModelChoice, ModelInfo, ProviderStatus } from "./types";

type Entry<T> = { value?: T; error?: string; loading: boolean };
const blank = <T,>(): Entry<T> => ({ loading: false });

/** A main-process error as a sentence: drops Electron's "Error invoking remote method …" prefix. */
export function plainError(e: unknown) {
  return String(e instanceof Error ? e.message : e)
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "")
    .trim();
}

/** One shared list with its loader: a load asked for while one runs waits for it, then runs once more. */
function store<T>(load: (refresh: boolean) => Promise<T>) {
  let entry: Entry<T> = blank();
  let running: Promise<void> | undefined;
  let again: boolean | undefined;
  const listeners = new Set<() => void>();
  const set = (next: Entry<T>) => {
    entry = next;
    listeners.forEach((l) => l());
  };
  function reload(refresh = false): Promise<void> {
    if (running) {
      again = again || refresh;
      return running;
    }
    set({ ...entry, loading: true });
    running = load(refresh)
      .then(
        (value) => set({ value, loading: false }),
        // A failed reload keeps the list it had, so a picker doesn't empty out over a blip.
        (e) => set({ value: entry.value, error: plainError(e) || "Something went wrong.", loading: false }),
      )
      .finally(() => {
        running = undefined;
        if (again !== undefined) {
          const r = again;
          again = undefined;
          void reload(r);
        }
      });
    return running;
  }
  return {
    get: () => entry,
    reload,
    subscribe(fn: () => void) {
      listeners.add(fn);
      watchRevision();
      if (!entry.value && !entry.loading && !entry.error) void reload();
      return () => listeners.delete(fn);
    },
  };
}

const api = () => window.botkins;
const catalog = store(() => api().models());
// GitHub Copilot always signs in through the browser, though its status may not say so yet.
const normalize = (p: ProviderStatus): ProviderStatus =>
  p.id === "copilot" && p.enabled && p.installed && !p.signIn && !p.starting && !p.error ? { ...p, signIn: "browser" } : p;
const statuses = store((refresh) => api().providers(refresh).then((list) => list.map(normalize)));

// Each connected provider's plan and what is left of its limits (docs/PROVIDER_USAGE.md).
const limits = store((refresh) => api().providerUsage(refresh ? { refresh: true } : undefined));

let watching = false;
let revision: number | undefined;
/** Asks both lists again when the main process says providers changed. */
function watchRevision() {
  if (watching) return;
  watching = true;
  api().subscribe((state) => {
    const next = state.providers?.revision;
    if (next === revision) return;
    // The first revision seen also reloads: a slow provider may have finished after the first load began.
    revision = next;
    void catalog.reload();
    void statuses.reload();
    // A provider that was signed in, out or switched has other limits (or none).
    if (limits.get().value) void limits.reload();
  });
  // The app read a provider's limits again behind an earlier answer.
  api().onProviderUsage?.(() => void limits.reload());
}

/** Ask both lists again now (after an action that changes them, in case no revision arrives). */
export function reloadProviders(refresh = false) {
  return Promise.all([statuses.reload(refresh), catalog.reload()]).then(() => {});
}

/** Every model of every switched-on, connected provider, in one list. */
export function useModelCatalog() {
  const entry = useSyncExternalStore(catalog.subscribe, catalog.get);
  return {
    models: entry.value ?? [],
    /** True until the first answer arrives. */
    loading: entry.value === undefined && !entry.error,
    /** A reload is running (the old list is still shown). */
    refreshing: entry.loading,
    error: entry.error,
    reload: () => catalog.reload(),
  };
}

/** Every model provider Botkins knows, switched on or off, in the registry's order. */
export function useProviders() {
  const entry = useSyncExternalStore(statuses.subscribe, statuses.get);
  return {
    providers: entry.value,
    loading: entry.value === undefined && !entry.error,
    error: entry.error,
    /** `refresh` asks each provider again instead of using the half-minute answer. */
    reload: (refresh = false) => statuses.reload(refresh),
  };
}

/**
 * Every connected provider's plan and limits. A screen that shows them asks when it opens; the
 * app answers from what it knows and reads a provider again when its answer is old, so asking is cheap.
 */
export function useProviderUsage() {
  const entry = useSyncExternalStore(limits.subscribe, limits.get);
  useEffect(() => {
    // The first subscriber already made the store ask.
    if (limits.get().value) void limits.reload();
  }, []);
  return {
    usage: entry.value,
    /** True until the first answer arrives. */
    loading: entry.value === undefined && !entry.error,
    refreshing: entry.loading,
    error: entry.error,
    /** Reads every provider again now. */
    refresh: () => limits.reload(true),
  };
}

/** The providers as they were last read, for code that has just asked for them again. */
export const currentProviders = () => statuses.get().value;

/** Opens Settings › Model providers from anywhere (src/app.tsx listens). */
export function openProviderSettings() {
  window.dispatchEvent(new CustomEvent("botkins-open-settings", { detail: "account" }));
}

/** The friendly words for a thinking level; anything else is shown as given, capitalized. */
const EFFORTS: Record<string, string> = { xhigh: "Extra high", max: "Max", none: "None", minimal: "Minimal" };
export function effortLabel(effort: string) {
  return EFFORTS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * The catalog entry a choice names. A choice saved without a provider belongs to the default
 * provider; two providers can have a model with the same id.
 */
export function findModel(models: ModelInfo[], choice?: ModelChoice, defaultProvider?: string) {
  if (!choice) return undefined;
  const same = models.filter((m) => m.id === choice.model);
  const provider = choice.provider ?? defaultProvider;
  return provider ? same.find((m) => m.provider === provider) ?? (choice.provider ? undefined : same[0]) : same[0];
}

/**
 * A choice's model name, as people read it: "Claude Opus 5.5". While the catalog loads, or for a
 * model it no longer has, the id is made readable ("gpt-6.2-sol" reads "GPT-6.2 Sol"); an id is
 * never shown as it is.
 */
export { friendlyModel };
export function modelName(choice: ModelChoice, models: ModelInfo[] = [], defaultProvider?: string) {
  if (choice.model === "auto" && (choice.provider ?? defaultProvider ?? "copilot") === "copilot") return "Auto";
  return findModel(models, choice, defaultProvider)?.name ?? friendlyModel(choice.model);
}

/** The provider ids whose names people know, for a choice that hasn't loaded yet. */
export const PROVIDER_NAMES: Record<string, string> = {
  copilot: "GitHub Copilot",
  codex: "ChatGPT",
  claude: "Claude",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  foundry: "Azure Foundry",
  "openai-api": "OpenAI endpoint",
};

/**
 * The three providers offered first wherever a person sets the app up, in the order they are
 * shown: ChatGPT, Claude, GitHub Copilot. They are equals: none is recommended or chosen ahead.
 * (The same order as SETUP_ORDER in desktop/providers/index.mjs.)
 */
export const SETUP_PROVIDERS = ["codex", "claude", "copilot"];
/** Those three first, in that order, then the rest as they come. */
export function inSetupOrder<T extends { id: string }>(list: T[]): T[] {
  const place = (p: T) => (SETUP_PROVIDERS.includes(p.id) ? SETUP_PROVIDERS.indexOf(p.id) : SETUP_PROVIDERS.length);
  return list.map((p, index) => ({ p, index })).sort((a, b) => place(a.p) - place(b.p) || a.index - b.index).map(({ p }) => p);
}

/** A switched-on provider counts as connected when it can answer. */
export const isConnected = (p: ProviderStatus) => p.enabled && p.connected;

/** One line about a provider, for a provider that doesn't describe itself. */
const DESCRIPTIONS: Record<string, string> = {
  copilot: "Your GitHub Copilot plan, or Copilot Free.",
  codex: "Your ChatGPT plan, through the Codex CLI.",
  claude: "Your Claude plan, through Claude Code.",
  opencode: "Free models, and the model services you connect.",
};
export const describe = (p: Pick<ProviderStatus, "id" | "description">) => p.description || DESCRIPTIONS[p.id] || "";

/** The tool a provider runs on, for "Get …" buttons. */
const TOOLS: Record<string, string> = { codex: "the Codex CLI", claude: "Claude Code", opencode: "OpenCode" };
export const toolName = (p: Pick<ProviderStatus, "id" | "name">) => TOOLS[p.id] ?? p.name;

/** "Sign in with GitHub" for Copilot, "Sign in to ChatGPT" for the others. */
export const signInLabel = (p: Pick<ProviderStatus, "id" | "name">) => (p.id === "copilot" ? "Sign in with GitHub" : "Sign in to " + p.name);

/** A token count as people read it: 1,000,000 → "1M", 936,000 → "936K", 1,048,576 → "1.05M". */
export function tokenCount(tokens: number) {
  if (tokens >= 1_000_000) return String(Math.round(tokens / 10_000) / 100) + "M";
  if (tokens >= 1000) return Math.round(tokens / 1000) + "K";
  return String(tokens);
}

/**
 * What a model's provider states about it, as short facts for a list: [text, the exact value].
 * A fact the provider doesn't state isn't in the list. `providerName` drops a maker that only
 * repeats the provider ("Anthropic" under Claude says nothing).
 */
export function modelFacts(m: ModelInfo): { text: string; exact: string }[] {
  const exact = (n: number, what: string) => n.toLocaleString() + " tokens " + what;
  const facts: { text: string; exact: string }[] = [];
  if (m.contextWindow) facts.push({ text: tokenCount(m.contextWindow) + " context", exact: exact(m.contextWindow, "of context") });
  if (m.maxPrompt && m.maxPrompt !== m.contextWindow) facts.push({ text: tokenCount(m.maxPrompt) + " per request", exact: exact(m.maxPrompt, "at most in one request") });
  if (m.maxOutput) facts.push({ text: tokenCount(m.maxOutput) + " reply", exact: exact(m.maxOutput, "at most in one reply") });
  if (m.vision === true) facts.push({ text: "Pictures", exact: "Takes pictures" });
  if (m.vision === false) facts.push({ text: "Text only", exact: "Doesn't take pictures" });
  if (m.tools === false) facts.push({ text: "No tools", exact: "Can't call tools" });
  if (m.vendor && m.vendor.toLowerCase() !== (m.providerName ?? "").toLowerCase()) facts.push({ text: m.vendor, exact: "Made by " + m.vendor });
  if (m.tier) {
    const price = ["low", "medium", "high"].includes(m.tier.toLowerCase());
    facts.push({ text: price ? m.tier[0].toUpperCase() + m.tier.slice(1).toLowerCase() + " price" : m.tier, exact: (m.providerName ?? "The provider") + "'s " + (price ? "price class" : "class") + ": " + m.tier });
  }
  if (m.knowledge) facts.push({ text: "Knowledge to " + m.knowledge, exact: "Knowledge cut-off: " + m.knowledge });
  return facts;
}
