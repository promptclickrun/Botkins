// The providers set up with a key ("keyed-providers-v1"): OpenRouter, Azure Foundry and an OpenAI
// endpoint. Here: the plain logic behind their settings, which the desktop app shares word for word.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeyedProvider } from "../src/link/types";
import { configFromForm, formChanged, formFromConfig, formProblems, hasProblems, keyedParts, keyedWords, keyPage, newRow, urlProblem } from "../src/features/models/keyed";
import { providerAction } from "../src/features/models/signin";
import { providerBadge, providerLine } from "../src/features/models/status";

const openrouter: KeyedProvider = { fields: [], hasKey: false, keyOptional: false, config: {}, needs: "Add your OpenRouter API key.", keyUrl: "https://openrouter.ai/keys" };
const foundry: KeyedProvider = { fields: ["endpoint", "apiVersion", "models"], hasKey: true, keyOptional: false, config: {}, needs: "Add the endpoint." };
const endpoint: KeyedProvider = { fields: ["baseUrl", "api", "models"], hasKey: false, keyOptional: true, config: { baseUrl: "http://localhost:11434/v1", api: "completions" }, needs: null };

test("each provider shows only its own fields", () => {
  assert.deepEqual(keyedParts(openrouter), { endpoint: false, baseUrl: false, api: false, apiVersion: false, models: false, modelApi: false, any: false });
  const f = keyedParts(foundry);
  assert.ok(f.endpoint && f.apiVersion && f.models && f.modelApi && !f.baseUrl && !f.api);
  const e = keyedParts(endpoint);
  assert.ok(e.baseUrl && e.api && e.models && !e.modelApi && !e.endpoint && !e.apiVersion);
});

test("the words: a resource key for Foundry, and an optional key for an endpoint", () => {
  assert.equal(keyedWords("foundry", foundry).keyLabel, "Resource key");
  assert.equal(keyedWords("foundry", foundry).models.id, "Deployment name");
  assert.equal(keyedWords("openrouter", openrouter).keyHint, undefined);
  assert.equal(keyedWords("openai-api", endpoint).keyHint, "Leave empty for a server that needs none.");
  assert.equal(keyedWords("openai-api", endpoint).models.id, "Model id");
  assert.equal(keyedWords("foundry", foundry).endpoint.placeholder, "https://your-resource.services.ai.azure.com");
  assert.equal(keyedWords("openai-api", endpoint).baseUrl.placeholder, "https://api.openai.com/v1");
  assert.equal(keyedWords("foundry", foundry).apiVersion.placeholder, "Leave empty for the v1 API");
});

test("Foundry's config: trimmed, blank rows dropped, each model with its API, kept facts kept", () => {
  const form = formFromConfig({ endpoint: "https://a.services.ai.azure.com", models: [{ id: "gpt-5", api: "responses", contextWindow: 400000 }] });
  form.endpoint = "  https://a.services.ai.azure.com/ ";
  form.apiVersion = " 2025-04-01-preview ";
  form.models.push({ ...newRow(), id: " phi-5 ", name: " Phi " }, newRow());
  assert.deepEqual(configFromForm(foundry, form), {
    endpoint: "https://a.services.ai.azure.com",
    apiVersion: "2025-04-01-preview",
    models: [
      { id: "gpt-5", api: "responses", contextWindow: 400000 },
      { id: "phi-5", name: "Phi", api: "completions" },
    ],
  });
});

test("an endpoint's config has the API once, and models without one", () => {
  const form = formFromConfig(endpoint.config);
  form.models.push({ ...newRow("responses"), id: "llama-4" });
  assert.deepEqual(configFromForm(endpoint, form), { baseUrl: "http://localhost:11434/v1", api: "completions", models: [{ id: "llama-4" }] });
  // Fields the provider doesn't take never go out.
  form.endpoint = "https://x";
  form.apiVersion = "1";
  assert.equal(configFromForm(endpoint, form).endpoint, undefined);
  assert.equal(configFromForm(endpoint, form).apiVersion, undefined);
});

test("an endpoint with no API saved starts on Responses", () => {
  assert.equal(formFromConfig({}).api, "responses");
});

test("addresses: Foundry's is https, an endpoint may be http", () => {
  assert.equal(urlProblem("", true), null);
  assert.equal(urlProblem("https://a.services.ai.azure.com", true), null);
  assert.match(urlProblem("http://a.services.ai.azure.com", true)!, /https:\/\//);
  assert.equal(urlProblem("http://localhost:1234/v1", false), null);
  assert.match(urlProblem("api.openai.com/v1", false)!, /whole address/);
  assert.match(urlProblem("ftp://x", false)!, /https:\/\/ or http:\/\//);
});

test("the checks before Save: a name without an id, spaces, a model twice", () => {
  const form = formFromConfig({});
  form.endpoint = "nope";
  const a = { ...newRow(), name: "Only a name" };
  const b = { ...newRow(), id: "gpt 5" };
  const c = { ...newRow(), id: "gpt-5" };
  const d = { ...newRow(), id: "gpt-5" };
  form.models = [a, b, c, d, newRow()];
  form.apiVersion = "2025 01";
  const problems = formProblems("foundry", foundry, form);
  assert.ok(problems.endpoint);
  assert.ok(problems.apiVersion);
  assert.equal(problems.models?.[a.row], "Type the deployment name.");
  assert.equal(problems.models?.[b.row], "A deployment name has no spaces.");
  assert.equal(problems.models?.[c.row], undefined);
  assert.equal(problems.models?.[d.row], "gpt-5 is in the list twice.");
  assert.equal(hasProblems(formProblems("foundry", foundry, formFromConfig({}))), false);
});

test("Save waits for a change", () => {
  const keyed = { ...foundry, config: { endpoint: "https://a.services.ai.azure.com", models: [{ id: "gpt-5", api: "responses" as const }] } };
  const form = formFromConfig(keyed.config);
  assert.equal(formChanged(keyed, form), false);
  form.models.push(newRow());
  assert.equal(formChanged(keyed, form), false, "a blank row is no change");
  form.models[0].api = "completions";
  assert.equal(formChanged(keyed, form), true);
});

test("Get a key opens only an https page", () => {
  assert.equal(keyPage(openrouter), "https://openrouter.ai/keys");
  assert.equal(keyPage({ keyUrl: "javascript:alert(1)" }), null);
  assert.equal(keyPage(undefined), null);
});

const status = (keyed: KeyedProvider, connected = false) =>
  ({ id: "openrouter", name: "OpenRouter", description: "Models from many makers, with one key.", enabled: true, default: false, installed: true, connected, signIn: "key", signOut: keyed.hasKey, signInWays: { guided: false, token: true }, keyed }) as const;

test("the phone's page: a keyed provider is set up on its page, not signed in", () => {
  assert.deepEqual(providerAction(status(openrouter), true), { kind: "key" });
  assert.deepEqual(providerAction(status(openrouter), false), { kind: "key" });
  assert.deepEqual(providerBadge(status(openrouter)), { label: "Not set up", tone: "accent" });
  assert.equal(providerLine(status(openrouter)), "Add your OpenRouter API key.");
  assert.deepEqual(providerBadge(status({ ...openrouter, hasKey: true, needs: null }, true)), { label: "Connected", tone: "success" });
});
