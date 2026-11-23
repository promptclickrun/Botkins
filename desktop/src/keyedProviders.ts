// The providers set up with a key ("keyed-providers-v1"): OpenRouter, Azure Foundry and an OpenAI
// endpoint. The plain logic behind their cards in Settings › Model providers, with the same choices
// and words as the phone's page (mobile/src/features/models/keyed.ts, the source of this copy);
// test/keyed-providers.test.mjs checks this file and compares the two when the phone's is beside it.
import type { KeyApi, KeyedConfig, KeyedModel, KeyedProvider } from "./types";
// ---- Everything below this line is the same in both apps.

/** The computer's capability for the configure fields. */
export const KEYED_CAPABILITY = "keyed-providers-v1";

/** The two ways to call a model, as people choose them. */
export const API_CHOICES: { value: KeyApi; label: string }[] = [
  { value: "completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
];
/** The endpoint's API when none was saved. */
export const DEFAULT_API: KeyApi = "responses";
/** A new Foundry model row's API. */
export const DEFAULT_MODEL_API: KeyApi = "completions";

/** One model row in the editor. `row` keeps the row's place while rows come and go. */
export type ModelRow = { row: string; id: string; name: string; api: KeyApi; extra?: Pick<KeyedModel, "contextWindow" | "maxOutput"> };
export type KeyedForm = { endpoint: string; baseUrl: string; api: KeyApi; apiVersion: string; models: ModelRow[] };
/** What is wrong with the form, by field; a model's problem is under its row. */
export type FormProblems = { endpoint?: string; baseUrl?: string; apiVersion?: string; models?: Record<string, string> };

/** The words and placeholders of one provider's settings. */
export type KeyedWords = {
  keyLabel: string;
  /** The key's name inside a sentence. */
  keyName: string;
  keyHint?: string;
  endpoint: { label: string; placeholder: string };
  baseUrl: { label: string; placeholder: string };
  apiVersion: { label: string; placeholder: string };
  api: { label: string };
  models: { label: string; hint: string; id: string; idPlaceholder: string; name: string; namePlaceholder: string; add: string };
};

export function keyedWords(providerId: string, keyed: Pick<KeyedProvider, "keyOptional">): KeyedWords {
  const foundry = providerId === "foundry";
  return {
    keyLabel: foundry ? "Resource key" : "API key",
    keyName: foundry ? "resource key" : "API key",
    keyHint: keyed.keyOptional ? "Leave empty for a server that needs none." : undefined,
    endpoint: { label: "Endpoint", placeholder: "https://your-resource.services.ai.azure.com" },
    baseUrl: { label: "Base URL", placeholder: "https://api.openai.com/v1" },
    apiVersion: { label: "API version", placeholder: "Leave empty for the v1 API" },
    api: { label: "API" },
    models: foundry
      ? {
          label: "Models",
          hint: "Each deployment in your resource that bots may use.",
          id: "Deployment name",
          idPlaceholder: "gpt-5-mini",
          name: "Display name",
          namePlaceholder: "Optional",
          add: "Add a model",
        }
      : {
          label: "Extra models",
          hint: "Models the server doesn't list by itself. Optional.",
          id: "Model id",
          idPlaceholder: "llama-4-scout",
          name: "Display name",
          namePlaceholder: "Optional",
          add: "Add a model",
        },
  };
}

/** Which parts of the settings show for a provider. */
export function keyedParts(keyed: Pick<KeyedProvider, "fields">) {
  const has = (field: KeyedProvider["fields"][number]) => keyed.fields.includes(field);
  return {
    endpoint: has("endpoint"),
    baseUrl: has("baseUrl"),
    api: has("api"),
    apiVersion: has("apiVersion"),
    models: has("models"),
    /** Each model chooses its API when the provider has no API of its own (Foundry). */
    modelApi: has("models") && !has("api"),
    /** Anything besides the key. */
    any: keyed.fields.length > 0,
  };
}

let rows = 0;
/** A new, empty model row. */
export const newRow = (api: KeyApi = DEFAULT_MODEL_API): ModelRow => ({ row: "r" + ++rows, id: "", name: "", api });

/** The form as the computer's config has it. */
export function formFromConfig(config: KeyedConfig | undefined): KeyedForm {
  const c = config ?? {};
  return {
    endpoint: c.endpoint ?? "",
    baseUrl: c.baseUrl ?? "",
    api: c.api ?? DEFAULT_API,
    apiVersion: c.apiVersion ?? "",
    models: (c.models ?? []).map((m) => {
      const extra = { ...(m.contextWindow !== undefined && { contextWindow: m.contextWindow }), ...(m.maxOutput !== undefined && { maxOutput: m.maxOutput }) };
      return { ...newRow(m.api ?? DEFAULT_MODEL_API), id: m.id, name: m.name ?? "", ...(Object.keys(extra).length > 0 && { extra }) };
    }),
  };
}

/** A row the person left blank is dropped, not an error. */
const blankRow = (r: ModelRow) => !r.id.trim() && !r.name.trim();

/** The whole config to send (providerConfigure replaces it): only this provider's fields, trimmed, empty ones left out. */
export function configFromForm(keyed: Pick<KeyedProvider, "fields">, form: KeyedForm): KeyedConfig {
  const parts = keyedParts(keyed);
  const config: KeyedConfig = {};
  if (parts.endpoint && form.endpoint.trim()) config.endpoint = trimUrl(form.endpoint);
  if (parts.baseUrl && form.baseUrl.trim()) config.baseUrl = trimUrl(form.baseUrl);
  if (parts.api) config.api = form.api;
  if (parts.apiVersion && form.apiVersion.trim()) config.apiVersion = form.apiVersion.trim();
  if (parts.models)
    config.models = form.models
      .filter((r) => !blankRow(r))
      .map((r) => ({
        id: r.id.trim(),
        ...(r.name.trim() && { name: r.name.trim() }),
        ...(parts.modelApi && { api: r.api }),
        ...r.extra,
      }));
  return config;
}

/** An address without spaces around it or a slash at its end. */
const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** Why an address can't be used, or null when it can. `secure` asks for https only. */
export function urlProblem(url: string, secure: boolean): string | null {
  const text = url.trim();
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "Type the whole address, starting with " + (secure ? "https://" : "https:// or http://") + ".";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && !secure) return null;
  return secure ? "Use an address that starts with https://." : "Use an address that starts with https:// or http://.";
}

/** What must change before the form can be saved; empty when it can be. */
export function formProblems(providerId: string, keyed: Pick<KeyedProvider, "fields">, form: KeyedForm): FormProblems {
  const parts = keyedParts(keyed);
  const words = keyedWords(providerId, { keyOptional: false });
  const problems: FormProblems = {};
  const endpoint = parts.endpoint ? urlProblem(form.endpoint, true) : null;
  if (endpoint) problems.endpoint = endpoint;
  const baseUrl = parts.baseUrl ? urlProblem(form.baseUrl, false) : null;
  if (baseUrl) problems.baseUrl = baseUrl;
  if (parts.apiVersion && /\s/.test(form.apiVersion.trim())) problems.apiVersion = "An API version has no spaces, such as 2025-04-01-preview.";
  if (parts.models) {
    const seen = new Set<string>();
    const models: Record<string, string> = {};
    for (const r of form.models) {
      if (blankRow(r)) continue;
      const id = r.id.trim();
      if (!id) models[r.row] = "Type the " + words.models.id.toLowerCase() + ".";
      else if (/\s/.test(id)) models[r.row] = "A " + words.models.id.toLowerCase() + " has no spaces.";
      else if (seen.has(id)) models[r.row] = id + " is in the list twice.";
      seen.add(id);
    }
    if (Object.keys(models).length) problems.models = models;
  }
  return problems;
}

export const hasProblems = (problems: FormProblems) => Object.keys(problems).length > 0;

/** True when saving the form would change what the computer has. */
export function formChanged(keyed: Pick<KeyedProvider, "fields" | "config">, form: KeyedForm): boolean {
  return !sameConfig(configFromForm(keyed, form), configFromForm(keyed, formFromConfig(keyed.config)));
}

function sameConfig(a: KeyedConfig, b: KeyedConfig) {
  const norm = (c: KeyedConfig) =>
    JSON.stringify({
      endpoint: c.endpoint,
      baseUrl: c.baseUrl,
      api: c.api,
      apiVersion: c.apiVersion,
      models: c.models?.map((m) => [m.id, m.name, m.api, m.contextWindow, m.maxOutput]),
    });
  return norm(a) === norm(b);
}

/** The provider's line while something is missing, else null. */
export const keyedNeeds = (keyed: KeyedProvider | undefined) => keyed?.needs ?? null;

/** A "Get a key" page the apps may open: https only. */
export function keyPage(keyed: Pick<KeyedProvider, "keyUrl"> | undefined): string | null {
  if (!keyed?.keyUrl) return null;
  try {
    return new URL(keyed.keyUrl).protocol === "https:" ? keyed.keyUrl : null;
  } catch {
    return null;
  }
}
