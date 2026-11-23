// The settings of the three providers that run on a key (OpenRouter, Azure Foundry, an OpenAI
// endpoint): what each takes, and the checks every value passes before it is kept. Nothing here
// touches a file, the network or a key.
//
//   openrouter  no settings; the address is fixed.
//   foundry     endpoint (the Azure resource, kept as <origin>/openai/v1), apiVersion, models.
//   openai-api  baseUrl, api ("responses" | "completions"), models.
//
// A model is { id, name?, api?, contextWindow?, maxOutput? }. `id` is what the endpoint calls it
// (for Foundry, the deployment's name).

export const KEYED_IDS = ["openrouter", "foundry", "openai-api"];

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const KEYED = {
  openrouter: {
    name: "OpenRouter",
    description: "Hundreds of models through one OpenRouter key.",
    fields: [],
    keyOptional: false,
    keyUrl: "https://openrouter.ai/keys",
  },
  foundry: {
    name: "Azure Foundry",
    description: "The models you deployed in your Azure AI Foundry resource.",
    fields: ["endpoint", "apiVersion", "models"],
    keyOptional: false,
    keyUrl: "https://ai.azure.com",
  },
  "openai-api": {
    name: "OpenAI endpoint",
    description: "OpenAI's API, or any server that speaks it (Ollama, vLLM, LM Studio).",
    fields: ["baseUrl", "api", "models"],
    keyOptional: true,
  },
};

/** What a request can be sent to, through the gateway (harness/gateway.mjs). */
export const KEY_PATHS = ["chat/completions", "responses"];

export const MODEL_ID = /^[\w.:/@+-]{1,128}$/;
export const MAX_MODELS = 50;
export const MAX_NAME = 80;
const MAX_TOKENS = 100_000_000;
const MODEL_KEYS = ["id", "name", "api", "contextWindow", "maxOutput"];
const APIS = ["responses", "completions"];

const blank = (value) => value === undefined || value === null || value === "";
const fail = (message) => {
  throw Object.assign(new Error(message), { code: "BAD_CONFIG" });
};

/** True for this computer and the private network: a name that never leaves it, or a private address. */
export function isLocalHost(hostname) {
  const host = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

/** True when an address names this computer or the private network (a server there needs no key). */
export function isLocalAddress(address) {
  try {
    return isLocalHost(new URL(String(address)).hostname);
  } catch {
    return false;
  }
}

/** A web address, checked: https (http for the local network only where `local` is set), no login, query or fragment. */
function address(value, what, { local = false } = {}) {
  if (typeof value !== "string") fail(what + " has to be a web address.");
  const text = value.trim();
  if (!text || text.length > 300) fail(what + " has to be a web address of at most 300 characters.");
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(what + " isn't a web address.");
  }
  if (url.protocol !== "https:" && !(local && url.protocol === "http:" && isLocalHost(url.hostname)))
    fail(what + " has to start with https://" + (local ? " (http:// works only for this computer or your own network)." : "."));
  if (url.username || url.password) fail(what + " can't hold a user name or password. The key is kept apart.");
  if (url.search || url.hash) fail(what + " can't hold a query or a fragment.");
  return url;
}

/** `https://NAME.services.ai.azure.com`, with or without `/openai` or `/openai/v1`, as `<origin>/openai/v1`. */
export function foundryEndpoint(value) {
  const url = address(value, "The endpoint");
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/openai" && path !== "/openai/v1") fail("The endpoint is your Azure resource's address, like https://NAME.services.ai.azure.com.");
  return url.origin + "/openai/v1";
}

function modelList(raw) {
  if (blank(raw)) return [];
  if (!Array.isArray(raw)) fail("The models have to be a list.");
  if (raw.length > MAX_MODELS) fail("Botkins takes at most " + MAX_MODELS + " models here.");
  const seen = new Set();
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("Each model needs an id.");
    for (const key of Object.keys(entry)) if (!MODEL_KEYS.includes(key) && !blank(entry[key])) fail('A model doesn\'t take "' + key + '".');
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!MODEL_ID.test(id)) fail("A model's id is its name at the endpoint: letters, digits and . _ : / @ + - (at most 128).");
    if (seen.has(id)) fail("The model " + id + " is listed twice.");
    seen.add(id);
    const out = { id };
    if (!blank(entry.name)) {
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) fail("A model's name is one line of at most " + MAX_NAME + " characters.");
      out.name = name;
    }
    if (!blank(entry.api)) {
      if (!APIS.includes(entry.api)) fail('A model\'s api is "responses" or "completions".');
      out.api = entry.api;
    }
    for (const key of ["contextWindow", "maxOutput"])
      if (!blank(entry[key])) {
        if (!Number.isInteger(entry[key]) || entry[key] < 1 || entry[key] > MAX_TOKENS) fail("A model's " + key + " is a whole number of tokens.");
        out[key] = entry[key];
      }
    return out;
  });
}

/**
 * A provider's settings, checked and made plain. Throws a sentence for the first thing wrong. A
 * setting the provider doesn't have is refused by name; a blank one is the same as none.
 */
export function normaliseConfig(id, raw) {
  const spec = KEYED[id];
  if (!spec) fail("Unknown model provider.");
  const given = blank(raw) ? {} : raw;
  if (typeof given !== "object" || Array.isArray(given)) fail("The settings have to be an object.");
  for (const key of Object.keys(given)) if (!spec.fields.includes(key) && !blank(given[key])) fail(spec.name + ' doesn\'t take "' + key + '".');
  const config = {};
  if (spec.fields.includes("endpoint") && !blank(given.endpoint)) config.endpoint = foundryEndpoint(given.endpoint);
  if (spec.fields.includes("baseUrl") && !blank(given.baseUrl)) {
    const url = address(given.baseUrl, "The address", { local: true });
    config.baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
  }
  if (spec.fields.includes("api")) {
    if (!blank(given.api) && !APIS.includes(given.api)) fail('The api is "responses" or "completions".');
    config.api = blank(given.api) ? "responses" : given.api;
  }
  if (spec.fields.includes("apiVersion") && !blank(given.apiVersion)) {
    if (typeof given.apiVersion !== "string" || !/^[\w.-]{1,40}$/.test(given.apiVersion.trim())) fail("The api version is like 2024-10-21 or preview.");
    config.apiVersion = given.apiVersion.trim();
  }
  if (spec.fields.includes("models")) config.models = modelList(given.models);
  return config;
}

/** The API a configured model is spoken to in: its own, else the provider's, else Chat Completions. */
export const modelApi = (config, model) => model?.api ?? config.api ?? "completions";

/** The one sentence on what is still missing, or null. */
export function needs(id, config, hasKey) {
  if (id === "openrouter") return hasKey ? null : "Paste your OpenRouter key (it starts with sk-or-).";
  if (id === "foundry") {
    if (!hasKey) return "Paste your Azure resource's key.";
    if (!config.endpoint) return "Add your Azure resource's endpoint, like https://NAME.services.ai.azure.com.";
    return config.models?.length ? null : "Add at least one deployment: the name you gave a model in your Azure resource.";
  }
  if (!config.baseUrl) return "Add the server's address, like https://api.openai.com/v1 or http://localhost:11434/v1.";
  if (!hasKey && !isLocalAddress(config.baseUrl)) return "Paste an API key. Only a server on this computer or your own network works without one.";
  return null;
}
