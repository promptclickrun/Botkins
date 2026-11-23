// OpenRouter, Azure Foundry and an OpenAI endpoint (desktop/providers/keyed): the settings and
// their checks, the status and the model lists, the gateway that carries a harness's requests with
// the person's key, the harness's routes and connections, and the key's way through the vault.
// No test reaches a real service: models come from an injected fetch, requests from a stand-in
// server on 127.0.0.1.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNet } from "node:net";
import { Readable } from "node:stream";
import { main } from "../cli/main.mjs";
import { ControlError } from "../desktop/terminal/socket.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYED_IDS, KeyedProvider, keyVaultId } from "../desktop/providers/keyed/index.mjs";
import { foundryEndpoint, isLocalAddress, needs, normaliseConfig } from "../desktop/providers/keyed/config.mjs";
import { Gateway } from "../desktop/harness/gateway.mjs";
import { Harness, keyConnection } from "../desktop/harness/index.mjs";
import { Providers } from "../desktop/providers/index.mjs";
import { Vault } from "../desktop/vault.mjs";
import { SignIns } from "../desktop/terminal/signin.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";
import { REMOTE_METHODS } from "../desktop/link/methods.mjs";
import { TEAM_METHODS } from "../desktop/link/team.mjs";
import { CAPABILITIES, KEYED_PROVIDERS } from "../desktop/runtime.mjs";

const root = mkdtempSync(join(tmpdir(), "botkins-keyed-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const folder = () => mkdtempSync(join(root, "d" + counter++ + "-"));

const KEY = "sk-or-v1-secret-key-value";
/** A vault in a folder of its own, and a provider that uses it. */
function make(id, { fetch, key, config } = {}) {
  const dir = folder();
  const vault = new Vault(join(dir, "vault"));
  if (key) vault.put(key, { label: "test" }, keyVaultId(id));
  const provider = new KeyedProvider({ id, dataDir: join(dir, "keyed"), vault: () => vault, ...(fetch && { fetch }) });
  if (config) provider.configure(config);
  return { provider, vault, dir };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- Settings ----

test("a Foundry endpoint of any of the three Azure host forms is kept as <origin>/openai/v1", () => {
  for (const host of ["NAME.services.ai.azure.com", "name.openai.azure.com", "name.cognitiveservices.azure.com"]) {
    const base = "https://" + host.toLowerCase() + "/openai/v1";
    for (const given of ["https://" + host, "https://" + host + "/", "https://" + host + "/openai", "https://" + host + "/openai/", "https://" + host + "/openai/v1", "https://" + host + "/openai/v1/"])
      assert.equal(foundryEndpoint(given), base, given);
  }
});

test("a Foundry endpoint must be https, plain, and the resource's address", () => {
  for (const bad of ["http://name.openai.azure.com", "ftp://x.example", "name.openai.azure.com", "https://u:p@name.openai.azure.com", "https://name.openai.azure.com?x=1", "https://name.openai.azure.com/#top", "https://name.openai.azure.com/models", "", 5, null])
    assert.throws(() => foundryEndpoint(bad), (error) => error.code === "BAD_CONFIG" || bad === "" || bad === null, String(bad));
});

test("an OpenAI endpoint takes https anywhere, and http only for this computer and the private network", () => {
  const ok = (baseUrl) => normaliseConfig("openai-api", { baseUrl }).baseUrl;
  assert.equal(ok("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(ok("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(ok("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1");
  assert.equal(ok("http://[::1]:1234/v1"), "http://[::1]:1234/v1");
  assert.equal(ok("http://192.168.1.20:8080"), "http://192.168.1.20:8080");
  assert.equal(ok("http://10.0.0.5/v1"), "http://10.0.0.5/v1");
  assert.equal(ok("http://172.20.0.2/v1"), "http://172.20.0.2/v1");
  for (const bad of ["http://api.example.com/v1", "http://172.32.0.1/v1", "http://8.8.8.8/v1", "https://a:b@api.example.com/v1", "https://api.example.com/v1?key=1", "file:///etc/passwd", "javascript:alert(1)"])
    assert.throws(() => normaliseConfig("openai-api", { baseUrl: bad }), /address|web/i, bad);
  assert.equal(isLocalAddress("http://localhost:1/v1"), true);
  assert.equal(isLocalAddress("https://api.openai.com/v1"), false);
});

test("models: ids, names, apis and sizes are checked, with at most fifty", () => {
  const good = normaliseConfig("foundry", { endpoint: "https://n.openai.azure.com", apiVersion: "2024-10-21", models: [{ id: "DeepSeek-V4-Pro", name: " Pro ", api: "responses", contextWindow: 128000, maxOutput: 8192 }, { id: "MAI-Image-2.5-Flash" }, { id: "org/model:tag@1+x" }] });
  assert.deepEqual(good, { endpoint: "https://n.openai.azure.com/openai/v1", apiVersion: "2024-10-21", models: [{ id: "DeepSeek-V4-Pro", name: "Pro", api: "responses", contextWindow: 128000, maxOutput: 8192 }, { id: "MAI-Image-2.5-Flash" }, { id: "org/model:tag@1+x" }] });
  const refused = (models, pattern) => assert.throws(() => normaliseConfig("foundry", { models }), pattern);
  refused([{ id: "has space" }], /id/);
  refused([{ id: "" }], /id/);
  refused([{ id: "x".repeat(129) }], /id/);
  refused([{ id: "a" }, { id: "a" }], /twice/);
  refused([{ id: "a", name: "n".repeat(81) }], /name/);
  refused([{ id: "a", name: "two\nlines" }], /name/);
  refused([{ id: "a", api: "chat" }], /api/);
  refused([{ id: "a", contextWindow: -1 }], /contextWindow/);
  refused([{ id: "a", contextWindow: 1.5 }], /contextWindow/);
  refused([{ id: "a", secret: "x" }], /doesn't take/);
  refused("a", /list/);
  refused(Array.from({ length: 51 }, (_, i) => ({ id: "m" + i })), /at most 50/);
  assert.equal(normaliseConfig("foundry", { models: Array.from({ length: 50 }, (_, i) => ({ id: "m" + i })) }).models.length, 50);
});

test("each provider takes only its own settings, and a blank one is none", () => {
  assert.deepEqual(normaliseConfig("openrouter", {}), {});
  assert.deepEqual(normaliseConfig("openrouter", { endpoint: "", models: undefined }), {});
  assert.throws(() => normaliseConfig("openrouter", { baseUrl: "https://x.example" }), /doesn't take "baseUrl"/);
  assert.throws(() => normaliseConfig("foundry", { api: "responses" }), /doesn't take "api"/);
  assert.throws(() => normaliseConfig("openai-api", { apiVersion: "1" }), /doesn't take "apiVersion"/);
  assert.deepEqual(normaliseConfig("openai-api", {}), { api: "responses", models: [] });
  assert.deepEqual(normaliseConfig("openai-api", { baseUrl: "https://x.example/v1", api: "completions" }), { baseUrl: "https://x.example/v1", api: "completions", models: [] });
  assert.throws(() => normaliseConfig("openai-api", { api: "chat" }), /api/);
  assert.throws(() => normaliseConfig("foundry", { apiVersion: "a b" }), /api version/);
  assert.throws(() => normaliseConfig("foundry", "x"), /object/);
  assert.deepEqual(normaliseConfig("foundry", { apiVersion: "" }), { models: [] }, "no api version is not sent");
});

test("the settings are kept in a file of the provider's own, and replaced as a whole", () => {
  const { provider, dir } = make("foundry", { config: { endpoint: "https://n.openai.azure.com", models: [{ id: "a" }] } });
  assert.deepEqual(readdirSync(join(dir, "keyed")), ["foundry.json"]);
  assert.deepEqual(provider.configure({ endpoint: "https://m.openai.azure.com", models: [{ id: "b" }] }), { endpoint: "https://m.openai.azure.com/openai/v1", models: [{ id: "b" }] });
  // A new provider object over the same folder reads them back.
  const again = new KeyedProvider({ id: "foundry", dataDir: join(dir, "keyed"), vault: () => null });
  assert.deepEqual(again.config(), { endpoint: "https://m.openai.azure.com/openai/v1", models: [{ id: "b" }] });
  // A refused setting changes nothing.
  assert.throws(() => provider.configure({ endpoint: "http://bad" }));
  assert.equal(provider.config().endpoint, "https://m.openai.azure.com/openai/v1");
  // A damaged file is no settings.
  writeFileSync(join(dir, "keyed", "foundry.json"), "{nope");
  assert.deepEqual(new KeyedProvider({ id: "foundry", dataDir: join(dir, "keyed"), vault: () => null }).config(), { models: [] });
});

// ---- Status ----

test("OpenRouter is connected with a key and says what is missing without one", async () => {
  const none = make("openrouter");
  const off = await none.provider.status();
  assert.equal(off.connected, false);
  assert.equal(off.signIn, "key");
  assert.match(off.message, /sk-or-/);
  assert.deepEqual(off.keyed, { fields: [], hasKey: false, keyOptional: false, config: {}, needs: off.message, keyUrl: "https://openrouter.ai/keys" });
  const on = await make("openrouter", { key: KEY }).provider.status();
  assert.equal(on.connected, true);
  assert.equal(on.signOut, true);
  assert.equal(on.keyed.hasKey, true);
  assert.equal(on.keyed.needs, null);
  assert.equal(on.message, undefined);
  assert.equal(JSON.stringify(on).includes(KEY), false, "the key is never in a status");
});

test("Foundry needs a key, an endpoint and a deployment, one sentence at a time", async () => {
  const { provider, vault } = make("foundry");
  const say = async () => (await provider.status()).keyed.needs;
  assert.match(await say(), /key/);
  vault.put("azure-key", {}, keyVaultId("foundry"));
  assert.match(await say(), /endpoint/);
  provider.configure({ endpoint: "https://n.openai.azure.com" });
  assert.match(await say(), /deployment/);
  provider.configure({ endpoint: "https://n.openai.azure.com", models: [{ id: "gpt-x" }] });
  const status = await provider.status();
  assert.equal(status.connected, true);
  assert.deepEqual(status.keyed.fields, ["endpoint", "apiVersion", "models"]);
  assert.equal(status.keyed.keyUrl, "https://ai.azure.com");
  assert.equal(status.keyed.keyOptional, false);
});

test("an OpenAI endpoint needs an address, and a key unless it is local", async () => {
  const { provider, vault } = make("openai-api");
  const say = async () => (await provider.status()).keyed.needs;
  assert.match(await say(), /address/);
  provider.configure({ baseUrl: "http://localhost:11434/v1" });
  assert.equal(await say(), null, "a local server needs no key");
  provider.configure({ baseUrl: "https://api.openai.com/v1" });
  assert.match(await say(), /key/);
  vault.put("sk-x", {}, keyVaultId("openai-api"));
  assert.equal(await say(), null);
  const status = await provider.status();
  assert.equal(status.keyed.keyOptional, true);
  assert.equal(status.keyed.keyUrl, undefined);
  assert.deepEqual(status.keyed.fields, ["baseUrl", "api", "models"]);
  assert.equal(needs("openai-api", { baseUrl: "http://192.168.0.4:1/v1" }, false), null);
});

test("a switched-off provider still shows its settings, and a vault that can't be read means no key", async () => {
  const { provider } = make("foundry", { config: { endpoint: "https://n.openai.azure.com" } });
  const dormant = provider.dormant();
  assert.equal(dormant.keyed.config.endpoint, "https://n.openai.azure.com/openai/v1");
  assert.equal(dormant.connected, undefined, "the registry says connected: false for an off provider");
  const lost = new KeyedProvider({ id: "openrouter", dataDir: folder(), vault: () => ({ has: () => { throw new Error("locked"); }, get: () => { throw new Error("locked"); } }) });
  assert.equal((await lost.status()).keyed.hasKey, false);
  assert.equal(lost.connection(), null);
});

test("the three are registered off, with no program of their own", async () => {
  assert.deepEqual(KEYED_IDS, ["openrouter", "foundry", "openai-api"]);
  const { provider } = make("openrouter", { key: KEY });
  assert.equal(provider.defaultEnabled, false);
  await assert.rejects(provider.openSession({}), /no program of its own[\s\S]*Pi, OMP or the Copilot runtime/);
});

// ---- Models ----

const ROUTER = {
  data: [
    { id: "vendor/with-tools", name: "Vendor: With Tools", description: "Does it all.", context_length: 200000, architecture: { input_modalities: ["text", "image"] }, top_provider: { max_completion_tokens: 32000 }, supported_parameters: ["tools", "temperature"] },
    { id: "vendor/thinker", name: "Vendor: Thinker", context_length: 1000000, top_provider: { max_completion_tokens: null }, supported_parameters: ["tools", "reasoning", "include_reasoning"] },
    { id: "vendor/chat-only", name: "Chat Only", context_length: 8000, supported_parameters: ["temperature"] },
    { id: "vendor/no-params", name: "No Params" },
    { name: "no id", supported_parameters: ["tools"] },
  ],
};

test("OpenRouter's models are the ones that can call tools, with what it states about each", async () => {
  const calls = [];
  const { provider } = make("openrouter", { fetch: async (url, init) => (calls.push({ url: String(url), init }), json(ROUTER)) });
  const models = await provider.models();
  assert.deepEqual(models.map((m) => m.id), ["vendor/with-tools", "vendor/thinker"]);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  assert.equal(calls[0].init.headers.authorization, undefined, "the list is public: no key is sent");
  const [plain, thinker] = models;
  assert.deepEqual([plain.name, plain.contextWindow, plain.maxOutput, plain.vision, plain.tools, plain.efforts, plain.provider, plain.vendor, plain.available], ["Vendor: With Tools", 200000, 32000, true, true, [], "openrouter", "vendor", true]);
  assert.deepEqual([thinker.contextWindow, thinker.maxOutput, thinker.efforts.length > 0], [1000000, undefined, true], "a reasoning model offers thinking levels");
  // Remembered for a while, and an earlier list is kept when the next read fails.
  await provider.models();
  assert.equal(calls.length, 1);
  provider.listed.time = 0;
  provider.fetch = async () => json({}, 500);
  assert.equal((await provider.models()).length, 2);
  const fresh = make("openrouter", { fetch: async () => json({}, 503) }).provider;
  await assert.rejects(fresh.models(), /503/);
});

test("Foundry offers exactly the configured deployments, each in its own API", async () => {
  const { provider } = make("foundry", { key: "k", fetch: async () => assert.fail("Foundry's own model list is not used"), config: { endpoint: "https://n.openai.azure.com", models: [{ id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", contextWindow: 128000, maxOutput: 16000 }, { id: "o-x", api: "responses" }] } });
  const models = await provider.models();
  assert.deepEqual(models.map((m) => [m.id, m.name, m.api]), [["DeepSeek-V4-Pro", "DeepSeek V4 Pro", "completions"], ["o-x", "o-x", "responses"]]);
  assert.deepEqual([models[0].contextWindow, models[0].maxOutput], [128000, 16000]);
  assert.equal(provider.apiFor("o-x"), "responses");
  assert.equal(provider.apiFor("unknown"), "completions");
});

test("an OpenAI endpoint lists its own models with the key, and the configured ones win and are added", async () => {
  const seen = [];
  const fetch = async (url, init) => (seen.push({ url: String(url), headers: init.headers }), json({ data: [{ id: "gpt-a" }, { id: "gpt-b" }, { id: "gpt-a" }, { object: "model" }] }));
  const { provider } = make("openai-api", { key: "sk-live", fetch, config: { baseUrl: "https://api.example.com/v1", api: "responses", models: [{ id: "gpt-b", name: "B", api: "completions" }, { id: "extra", contextWindow: 9000 }] } });
  const models = await provider.models();
  assert.deepEqual(models.map((m) => [m.id, m.name, m.api]), [["gpt-b", "B", "completions"], ["extra", "extra", "responses"], ["gpt-a", "gpt-a", "responses"]]);
  assert.equal(seen[0].url, "https://api.example.com/v1/models");
  assert.equal(seen[0].headers.authorization, "Bearer sk-live");
  assert.equal(models[1].contextWindow, 9000);
});

test("an OpenAI endpoint's list leaves out what can't chat: flagged, retired, or of a family that only embeds, speaks, hears or draws", async () => {
  // The shape an Azure resource's /openai/v1/models answers with (Nov 2026), and OpenAI's plain one.
  const data = [
    { id: "gpt-4o", capabilities: { chat_completion: true } },
    { id: "gpt-4-0314", capabilities: { chat_completion: true }, deprecation: { inference: "2024-06-13T00:00:00Z" } },
    { id: "dall-e-3-3.0", capabilities: { chat_completion: false, inference: true } },
    { id: "whisper-001", capabilities: { chat_completion: false } },
    { id: "text-embedding-3-large" }, { id: "tts-1-hd" }, { id: "gpt-4o-realtime-preview" }, { id: "gpt-4o-mini-transcribe" },
    { id: "gpt-image-1" }, { id: "omni-moderation-latest" }, { id: "gpt-4o-audio-preview" }, { id: "mistral-embed" },
    { id: "gpt-5-mini" }, { id: "llama3.1:8b" }, { id: "Phi-4-multimodal-instruct" }, "qwen2.5-coder",
  ];
  const fetch = async () => json({ data });
  const { provider } = make("openai-api", { key: "sk-live", fetch, config: { baseUrl: "https://api.example.com/v1", api: "completions", models: [{ id: "tts-1-hd", name: "Named by hand" }] } });
  const models = await provider.models();
  assert.deepEqual(models.map((m) => m.id), ["tts-1-hd", "gpt-4o", "gpt-5-mini", "llama3.1:8b", "Phi-4-multimodal-instruct", "qwen2.5-coder"]);
});

test("an OpenAI endpoint that can't list its models offers the configured ones, or says why", async () => {
  const fail = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  const withModels = make("openai-api", { fetch: fail, config: { baseUrl: "http://localhost:11434/v1", models: [{ id: "llama3" }] } }).provider;
  assert.deepEqual((await withModels.models()).map((m) => m.id), ["llama3"]);
  const without = make("openai-api", { fetch: fail, config: { baseUrl: "http://localhost:11434/v1" } }).provider;
  await assert.rejects(without.models(), /localhost:11434.*ECONNREFUSED/);
  // No key header goes to a server that has none.
  let headers;
  const local = make("openai-api", { fetch: async (_url, init) => ((headers = init.headers), json({ data: [{ id: "m" }] })), config: { baseUrl: "http://localhost:1/v1" } }).provider;
  await local.models();
  assert.equal(headers.authorization, undefined);
});

// ---- The gateway ----

const http = (base, path, { method = "POST", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest(base + path, { method, headers: { ...(payload !== null && { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }), ...headers }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(payload);
  });

/** A server that stands in for the provider: it records each request and answers by `reply`. */
async function upstream(t, reply) {
  const seen = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, text });
      reply(request, response, text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))));
  return { seen, base: "http://127.0.0.1:" + server.address().port };
}
const answerJson = (_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
/** A gateway whose key providers are the given connections. */
async function gatewayFor(t, connections) {
  const gate = new Gateway({ keyed: (id) => connections[id] ?? null, log: () => {} });
  const base = await gate.start();
  t.after(() => gate.stop());
  return { gate, base, bearer: { authorization: "Bearer " + gate.secret } };
}
const CHAT = { model: "DeepSeek-V4-Pro", messages: [{ role: "user", content: "hi" }] };

test("the gateway carries a request to OpenRouter's address with the person's key and Botkins' name, not the run's secret", async (t) => {
  const up = await upstream(t, answerJson);
  // The provider's own connection, pointed at the stand-in.
  const { provider } = make("openrouter", { key: KEY });
  const connection = { ...provider.connection(), baseUrl: up.base + "/api/v1" };
  assert.equal(provider.connection().baseUrl, "https://openrouter.ai/api/v1");
  const { base, bearer, gate } = await gatewayFor(t, { openrouter: connection });
  const answer = await http(base, "/key/openrouter/chat/completions", { headers: bearer, body: CHAT });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json(), { ok: true });
  const [sent] = up.seen;
  assert.equal(sent.url, "/api/v1/chat/completions");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.authorization, "Bearer " + KEY);
  assert.equal(sent.headers["http-referer"], "https://botkins.app");
  assert.equal(sent.headers["x-title"], "Botkins");
  assert.equal(sent.headers["api-key"], undefined);
  assert.equal(JSON.stringify(sent.headers).includes(gate.secret), false, "the run's secret goes no further");
  assert.deepEqual(JSON.parse(sent.text), CHAT);
});

test("for Foundry the key is an api-key header, and an api version is added only when one is set", async (t) => {
  const up = await upstream(t, answerJson);
  const foundry = (config) => {
    const { provider } = make("foundry", { key: "azure-key", config });
    return { ...provider.connection(), baseUrl: up.base + "/openai/v1" };
  };
  const base1 = { endpoint: "https://n.cognitiveservices.azure.com", models: [{ id: "DeepSeek-V4-Pro" }] };
  const plain = await gatewayFor(t, { foundry: foundry(base1) });
  assert.equal((await http(plain.base, "/key/foundry/responses", { headers: plain.bearer, body: { model: "m", input: "hi" } })).status, 200);
  const dated = await gatewayFor(t, { foundry: foundry({ ...base1, apiVersion: "2025-03-01-preview" }) });
  assert.equal((await http(dated.base, "/key/foundry/chat/completions", { headers: dated.bearer, body: CHAT })).status, 200);
  const [one, two] = up.seen;
  assert.equal(one.url, "/openai/v1/responses", "no api version when none is set");
  assert.equal(one.headers["api-key"], "azure-key");
  assert.equal(one.headers.authorization, undefined);
  assert.equal(two.url, "/openai/v1/chat/completions?api-version=2025-03-01-preview");
  assert.equal(two.headers["api-key"], "azure-key");
});

test("an OpenAI endpoint with no key gets no auth header", async (t) => {
  const up = await upstream(t, answerJson);
  const { provider } = make("openai-api", { config: { baseUrl: "http://localhost:11434/v1" } });
  const { base, bearer } = await gatewayFor(t, { "openai-api": { ...provider.connection(), baseUrl: up.base + "/v1" } });
  assert.equal((await http(base, "/key/openai-api/chat/completions", { headers: bearer, body: CHAT })).status, 200);
  assert.equal(up.seen[0].headers.authorization, undefined);
});

test("the gateway turns away a key request without the secret, with an origin, the wrong method, another path or another provider", async (t) => {
  const up = await upstream(t, answerJson);
  const connection = { baseUrl: up.base, headers: { authorization: "Bearer real" }, secrets: ["real"] };
  const { base, bearer } = await gatewayFor(t, { openrouter: connection, foundry: connection, "openai-api": connection });
  assert.equal((await http(base, "/key/openrouter/chat/completions", { body: CHAT })).status, 401);
  assert.equal((await http(base, "/key/openrouter/chat/completions", { headers: { authorization: "Bearer nope" }, body: CHAT })).status, 401);
  assert.equal((await http(base, "/key/openrouter/chat/completions", { headers: { ...bearer, origin: "https://evil.example" }, body: CHAT })).status, 403);
  assert.equal((await http(base, "/key/openrouter/chat/completions", { method: "GET", headers: bearer })).status, 405);
  for (const path of ["/key/openrouter/models", "/key/openrouter/embeddings", "/key/openrouter/chat/completions/x", "/key/openrouter/../chat/completions", "/key/openrouter/", "/key/codex/responses", "/key/__proto__/responses", "/key/constructor/chat/completions", "/key/openrouter"])
    assert.equal((await http(base, path, { headers: bearer, body: CHAT })).status, 404, path);
  assert.equal((await http(base, "/key/openrouter/responses", { headers: bearer, body: "not json" })).status, 400);
  assert.equal(up.seen.length, 0, "nothing of that went on to the provider");
});

test("a provider with nothing set up is a 503 in a sentence, with no key in it", async (t) => {
  const { base, bearer } = await gatewayFor(t, {});
  const answer = await http(base, "/key/foundry/chat/completions", { headers: bearer, body: CHAT });
  assert.equal(answer.status, 503);
  assert.match(answer.json().error.message, /Azure Foundry isn't set up/);
});

test("the gateway streams an answer back as it comes, with the status and content type of the provider's", async (t) => {
  const up = await upstream(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'), 150);
  });
  const { base, bearer } = await gatewayFor(t, { openrouter: { baseUrl: up.base, headers: {}, secrets: [] } });
  // The first piece is read before the stream has ended.
  const first = await new Promise((resolve, reject) => {
    const req = httpRequest(base + "/key/openrouter/chat/completions", { method: "POST", headers: { ...bearer, "content-type": "application/json", accept: "text/event-stream" }, agent: false }, (res) => {
      let text = "";
      let early = null;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        early ??= { status: res.statusCode, type: res.headers["content-type"], cache: res.headers["cache-control"], text };
      });
      res.on("end", () => resolve({ early, text }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ ...CHAT, stream: true }));
  });
  assert.equal(first.early.status, 200);
  assert.equal(first.early.type, "text/event-stream; charset=utf-8");
  assert.equal(first.early.cache, "no-cache");
  assert.match(first.early.text, /Hel/);
  assert.equal(first.early.text.includes("lo"), false, "it was not held back until the end");
  assert.equal(first.text, 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(up.seen[0].headers.accept, "text/event-stream");
});

test("the provider's refusal comes back as it is, without the key where it was named", async (t) => {
  const up = await upstream(t, (_request, response) => response.writeHead(401, { "content-type": "application/json", "retry-after": "7" }).end(JSON.stringify({ error: { message: "Incorrect API key provided: " + KEY + "." } })));
  const { base, bearer } = await gatewayFor(t, { openrouter: { baseUrl: up.base, headers: { authorization: "Bearer " + KEY }, secrets: [KEY] } });
  const answer = await http(base, "/key/openrouter/chat/completions", { headers: bearer, body: CHAT });
  assert.equal(answer.status, 401);
  assert.equal(answer.headers["retry-after"], "7");
  assert.equal(answer.text.includes(KEY), false);
  assert.match(answer.json().error.message, /Incorrect API key provided: \[key\]/);
});

test("a provider that can't be reached is a 502 that names no key", async (t) => {
  const port = await new Promise((resolve) => {
    const probe = createNet();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const { base, bearer } = await gatewayFor(t, { openrouter: { baseUrl: "http://127.0.0.1:" + port, headers: { authorization: "Bearer " + KEY }, secrets: [KEY] } });
  const answer = await http(base, "/key/openrouter/chat/completions", { headers: bearer, body: CHAT });
  assert.equal(answer.status, 502);
  assert.match(answer.json().error.message, /Couldn't reach OpenRouter/);
  assert.equal(answer.text.includes(KEY), false);
});

test("a redirect from the provider is not followed, so the key goes nowhere else", async (t) => {
  const elsewhere = await upstream(t, answerJson);
  const up = await upstream(t, (_request, response) => response.writeHead(307, { location: elsewhere.base + "/stolen" }).end());
  const { base, bearer } = await gatewayFor(t, { openrouter: { baseUrl: up.base, headers: { authorization: "Bearer " + KEY }, secrets: [KEY] } });
  assert.equal((await http(base, "/key/openrouter/chat/completions", { headers: bearer, body: CHAT })).status, 502);
  assert.equal(elsewhere.seen.length, 0);
});

// ---- The harness ----

/** A registry of made-up providers for the harness: the real key providers and stand-ins for the rest. */
function registry({ ids = ["copilot", "pi", "omp"], keyed = ["openrouter", "foundry", "openai-api"], models = [], configs = {} } = {}) {
  const byId = new Map(ids.map((id) => [id, { id }]));
  for (const id of keyed) {
    const { provider } = make(id, { config: configs[id] });
    byId.set(id, provider);
  }
  return { byId, for: (selection) => byId.get(selection.provider), models: async () => models };
}
const standIn = () => {
  const gate = { started: 0, secret: "s", start: async () => (gate.started++, "http://127.0.0.1:1"), stop() {} };
  return gate;
};
const harness = (providers, choice, gate = standIn()) => new Harness({ providers, choice: () => choice, dir: root, bridge: null, gateway: gate });
const CATALOG = [
  { id: "vendor/a", name: "A", provider: "openrouter", efforts: ["low", "high"], contextWindow: 200000, maxOutput: 32000, api: "completions" },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", provider: "foundry", efforts: [], api: "completions" },
  { id: "o-x", name: "O X", provider: "foundry", efforts: [], api: "responses", contextWindow: 100000 },
  { id: "llama3", name: "Llama 3", provider: "openai-api", efforts: [], api: "responses" },
];
const FOUNDRY_CONFIG = { endpoint: "https://n.openai.azure.com", models: [{ id: "DeepSeek-V4-Pro" }, { id: "o-x", api: "responses" }] };

test("a key provider's turns go to Pi or OMP when one is chosen, to Pi for 'provider', to the Copilot runtime for 'copilot'", () => {
  const providers = registry();
  const selection = { provider: "openrouter", model: "vendor/a" };
  assert.equal(harness(providers, "pi").via(selection), "pi");
  assert.equal(harness(providers, "omp").via(selection), "omp");
  assert.equal(harness(providers, "provider").via(selection), "pi", "they have no program of their own");
  assert.equal(harness(providers, "copilot").via(selection), "copilot");
  assert.equal(harness(providers, "copilot").hosts(selection), true);
  for (const id of KEYED_IDS) assert.equal(harness(providers, "pi").runner({ provider: id, model: "m" }), providers.byId.get("pi"));
  assert.equal(harness(providers, "copilot").runner(selection), providers.byId.get("copilot"));
});

test("a key provider's turns have no route when no harness can run them, and the provider says so", async () => {
  const none = registry({ ids: ["copilot"] });
  const selection = { provider: "foundry", model: "m" };
  assert.equal(harness(none, "pi").via(selection), null);
  assert.equal(harness(none, "omp").via(selection), null);
  assert.equal(harness(none, "provider").via(selection), null);
  assert.equal(harness(registry({ ids: ["pi"] }), "copilot").via(selection), null, "no Copilot runtime");
  const runner = harness(none, "pi").runner(selection);
  assert.equal(runner, none.byId.get("foundry"));
  await assert.rejects(runner.openSession({}), /no program of its own/);
  // 'provider' goes on to OMP when Pi's program is known to be missing.
  const both = harness(registry({ ids: ["pi", "omp"] }), "provider");
  both.missing.add("pi");
  assert.equal(both.via(selection), "omp");
  both.missing.add("omp");
  assert.equal(both.via(selection), "pi", "with neither found, Pi's own error says to install it");
});

test("the plans' routes are as they were", () => {
  const providers = new Map([["codex", { id: "codex" }], ["claude", { id: "claude" }], ["pi", { id: "pi" }], ["copilot", { id: "copilot" }]]);
  const registryOf = { byId: providers, for: (selection) => providers.get(selection.provider), models: async () => [] };
  assert.equal(harness(registryOf, "pi").via({ provider: "codex", model: "m" }), "pi");
  assert.equal(harness(registryOf, "provider").via({ provider: "codex", model: "m" }), null);
  assert.equal(harness(registryOf, "copilot").via({ provider: "claude", model: "m" }), "copilot");
});

test("Pi is given a connection to the gateway for each configured key provider, and the models' own APIs", async () => {
  const gate = standIn();
  const providers = registry({ models: CATALOG, configs: { foundry: FOUNDRY_CONFIG, "openai-api": { baseUrl: "http://localhost:1/v1" } } });
  const out = await harness(providers, "pi", gate).session({ provider: "foundry", model: "o-x" }, "pi");
  assert.deepEqual(out.model, { model: "o-x", source: "botkins-foundry-responses" });
  const by = Object.fromEntries(out.inference.providers.map((p) => [p.name, p.config]));
  assert.deepEqual(Object.keys(by), ["botkins-openrouter", "botkins-foundry", "botkins-foundry-responses", "botkins-openai-api-responses"]);
  const completions = by["botkins-foundry"];
  assert.deepEqual({ ...completions, models: undefined }, { name: "Azure Foundry", baseUrl: "http://127.0.0.1:1/key/foundry", api: "openai-completions", apiKey: "s", authHeader: true, models: undefined });
  assert.deepEqual(completions.models.map((m) => m.id), ["DeepSeek-V4-Pro"]);
  const responses = by["botkins-foundry-responses"];
  assert.equal(responses.api, "openai-responses");
  assert.equal(responses.baseUrl, "http://127.0.0.1:1/key/foundry");
  assert.deepEqual(responses.models.map((m) => [m.id, m.contextWindow]), [["o-x", 100000]]);
  const router = by["botkins-openrouter"];
  assert.equal(router.baseUrl, "http://127.0.0.1:1/key/openrouter");
  assert.deepEqual([router.models[0].contextWindow, router.models[0].maxTokens, router.models[0].reasoning], [200000, 32000, true]);
  assert.equal(router.models[0].compat.thinkingFormat, "openrouter");
  assert.equal(by["botkins-openai-api-responses"].baseUrl, "http://127.0.0.1:1/key/openai-api");
  // The key is nowhere in what a harness is given, and the secret is the run's own.
  assert.equal(JSON.stringify(out).includes("azure-key"), false);
  for (const connection of Object.values(by)) assert.equal(connection.apiKey, "s");
  assert.equal(gate.started, 1);
});

test("the chosen model is offered with its API even when its provider's list couldn't be read", async () => {
  const providers = registry({ models: [], configs: { foundry: FOUNDRY_CONFIG } });
  const out = await harness(providers, "omp").session({ provider: "foundry", model: "o-x", reasoningEffort: "high" }, "omp");
  assert.deepEqual(out.model, { model: "o-x", source: "botkins-foundry-responses", reasoningEffort: "high" });
  assert.deepEqual(out.inference.providers.map((p) => p.name), ["botkins-foundry-responses"]);
  const unknown = await harness(registry({ models: [] }), "pi").session({ provider: "openrouter", model: "vendor/new" }, "pi");
  assert.equal(unknown.model.source, "botkins-openrouter");
});

test("the Copilot runtime is given an OpenAI connection for each API in use, and the models under it", async () => {
  const providers = registry({ models: CATALOG, configs: { foundry: FOUNDRY_CONFIG } });
  const out = await harness(providers, "copilot").session({ provider: "foundry", model: "DeepSeek-V4-Pro" });
  assert.deepEqual(out.model, { model: "DeepSeek-V4-Pro", source: "foundry" });
  assert.deepEqual(out.inference.providers, [
    { name: "openrouter", type: "openai", wireApi: "completions", baseUrl: "http://127.0.0.1:1/key/openrouter", bearerToken: "s" },
    { name: "foundry", type: "openai", wireApi: "completions", baseUrl: "http://127.0.0.1:1/key/foundry", bearerToken: "s" },
    { name: "foundry-responses", type: "openai", wireApi: "responses", baseUrl: "http://127.0.0.1:1/key/foundry", bearerToken: "s" },
    { name: "openai-api-responses", type: "openai", wireApi: "responses", baseUrl: "http://127.0.0.1:1/key/openai-api", bearerToken: "s" },
  ]);
  assert.deepEqual(out.inference.models.filter((m) => m.provider.startsWith("foundry")).map((m) => [m.id, m.provider, m.maxContextWindowTokens]), [["DeepSeek-V4-Pro", "foundry", undefined], ["o-x", "foundry-responses", 100000]]);
  assert.equal(keyConnection("foundry", "responses"), "foundry-responses");
  assert.equal(keyConnection("foundry", "completions"), "foundry");
});

test("a harness made without a gateway makes one that reaches the key providers' connections", async (t) => {
  const providers = registry({ configs: {} });
  const { provider } = make("openrouter", { key: KEY });
  providers.byId.set("openrouter", provider);
  const one = new Harness({ providers, choice: () => "pi", dir: root, bridge: null });
  t.after(() => one.stop());
  assert.equal(one.gateway.keyed("openrouter").headers.authorization, "Bearer " + KEY);
  assert.equal(one.gateway.keyed("foundry"), null, "not set up");
  assert.equal(one.gateway.keyed("copilot"), null, "not a key provider");
});

// ---- Keys, the vault and the calls ----

test("a pasted key goes to the vault only, a first-time key needs no sign-in page, and signing out keeps the settings", async () => {
  const dir = folder();
  const vault = new Vault(join(dir, "vault"));
  const keyed = KEYED_IDS.map((id) => new KeyedProvider({ id, dataDir: join(dir, "keyed"), vault: () => vault }));
  const registryOf = new Providers([...keyed]);
  const enabled = [];
  const changed = [];
  const signIns = new SignIns({ providers: () => registryOf, vault: () => vault, changed: async (id) => void changed.push(id), enable: async (id) => void enabled.push(id) });
  assert.deepEqual(signIns.ways(keyed[1]), { guided: false, token: true });
  // OpenRouter: a key is all it needs.
  await assert.rejects(signIns.useToken("openrouter", "sk-wrong"), /start with sk-or-/);
  assert.equal(vault.has(keyVaultId("openrouter")), false);
  assert.deepEqual(await signIns.useToken("openrouter", " " + KEY + "\n"), { connected: true, account: null, plan: "API key" });
  assert.equal(vault.get(keyVaultId("openrouter")), KEY);
  assert.deepEqual(enabled, ["openrouter"]);
  assert.equal(signIns.hasToken("openrouter"), true);
  // Foundry: the key is kept, and what is missing is said; it is not switched on yet.
  const foundry = await signIns.useToken("foundry", "azure-key");
  assert.equal(foundry.connected, false);
  assert.match(foundry.needs, /endpoint/);
  assert.equal(vault.get(keyVaultId("foundry")), "azure-key");
  assert.deepEqual(enabled, ["openrouter"]);
  await assert.rejects(signIns.useToken("foundry", "two words"), /one word/);
  await assert.rejects(signIns.start("foundry"), /no sign-in page: it takes a key/);
  keyed[1].configure({ endpoint: "https://n.openai.azure.com", models: [{ id: "a" }] });
  // Nothing of any key is in a file but the sealed vault.
  const files = [join(dir, "vault", "vault.json"), ...readdirSync(join(dir, "keyed"), { withFileTypes: true }).map((e) => join(dir, "keyed", e.name))];
  for (const file of files) assert.equal(readFileSync(file, "utf8").includes("azure-key") || readFileSync(file, "utf8").includes(KEY), false, file);
  // Signing out removes the key and keeps the settings.
  assert.deepEqual(await signIns.signOut("foundry"), { connected: false });
  assert.equal(vault.has(keyVaultId("foundry")), false);
  assert.equal(keyed[1].config().models.length, 1);
  assert.equal((await keyed[1].status()).keyed.hasKey, false);
});

test("the calls: providerConfigure is owner-only on the link and a capability is named for it", () => {
  assert.equal(REMOTE_METHODS.has("providerConfigure"), true);
  assert.equal(TEAM_METHODS.providerConfigure, "owner");
  assert.equal(KEYED_PROVIDERS, "keyed-providers-v1");
  assert.ok(CAPABILITIES.includes("keyed-providers-v1"));
});

const freePort = () =>
  new Promise((resolve) => {
    const probe = createNet();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

test("a running service sets a key provider up from the command line's calls, switches it on, and shows no key", async (t) => {
  // A short folder straight in the system's temp folder: on macOS that is already long, and a Unix
  // socket's path has a limit of about a hundred characters (as test/terminal-coverage.test.mjs does).
  const dir = mkdtempSync(join(tmpdir(), "bk-keyed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ providers: { only: ["openrouter", "foundry", "openai-api"] }, link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(() => running.stop("the test ended"));
  const control = controlClient(paths.socket, { timeout: 40_000 });
  const listed = async () => Object.fromEntries((await control.call("providers.list", true)).map((entry) => [entry.id, entry]));
  const first = await listed();
  assert.deepEqual([first.foundry.enabled, first.foundry.connected, first.foundry.keyed.hasKey], [false, false, false]);
  assert.match(first.foundry.keyed.needs, /key/);
  // The key first: Foundry is still missing an endpoint, so it stays off.
  const keyed = await control.call("providers.login", "foundry", { token: "azure-key-value" });
  assert.equal(keyed.connected, false);
  assert.match((await listed()).foundry.keyed.needs, /endpoint/);
  assert.equal((await listed()).foundry.token, "kept by Botkins");
  // Settings by pieces: what is given replaces that setting and the rest stay. (The key is kept already, so its address needs the mark.)
  await assert.rejects(control.call("providers.set", "foundry", { endpoint: "https://n.cognitiveservices.azure.com/openai/v1/" }), /needs a yes/);
  await control.call("providers.set", "foundry", { endpoint: "https://n.cognitiveservices.azure.com/openai/v1/" }, { agreed: true });
  const done = await control.call("providers.set", "foundry", { models: [{ id: "DeepSeek-V4-Flash" }, { id: "DeepSeek-V4-Pro", api: "responses" }] });
  assert.deepEqual(done, { id: "foundry", name: "Azure Foundry", enabled: true, connected: true, hasKey: true, needs: null, config: { endpoint: "https://n.cognitiveservices.azure.com/openai/v1", models: [{ id: "DeepSeek-V4-Flash" }, { id: "DeepSeek-V4-Pro", api: "responses" }] } });
  const now = (await listed()).foundry;
  assert.deepEqual([now.enabled, now.connected], [true, true]);
  assert.equal(JSON.stringify(await control.call("providers.list")).includes("azure-key-value"), false);
  assert.equal((await control.call("providers.set", "foundry", { clearModels: true })).config.models.length, 0);
  await assert.rejects(control.call("providers.set", "foundry", { endpoint: "http://insecure.example" }), /https/);
  await assert.rejects(control.call("providers.set", "openrouter", { endpoint: "https://x.example" }), /doesn't take/);
  // A kept key goes to the address that is set: a new address needs the mark, the same one (or none kept) does not.
  await control.call("providers.login", "foundry", { token: "azure-key-value" }, { agreed: true });
  await control.call("providers.set", "foundry", { endpoint: "https://n.cognitiveservices.azure.com", apiVersion: "preview" });
  await assert.rejects(control.call("providers.set", "foundry", { endpoint: "https://other.openai.azure.com" }), /other\.openai\.azure\.com[\s\S]*needs a yes/);
  assert.equal((await listed()).foundry.keyed.config.endpoint, "https://n.cognitiveservices.azure.com/openai/v1");
  assert.equal((await control.call("providers.set", "foundry", { endpoint: "https://other.openai.azure.com" }, { agreed: true })).config.endpoint, "https://other.openai.azure.com/openai/v1");
  // Signing out removes the key and keeps the endpoint.
  await control.call("providers.logout", "foundry", { agreed: true });
  const out = (await listed()).foundry;
  assert.equal(out.keyed.hasKey, false);
  assert.equal(out.keyed.config.endpoint, "https://other.openai.azure.com/openai/v1");
  // With no key kept, an address is set with no question.
  assert.equal((await control.call("providers.set", "foundry", { endpoint: "https://third.openai.azure.com" })).config.endpoint, "https://third.openai.azure.com/openai/v1");
  // The vault is where the key was, and the settings are under the data folder's own "keyed" folder.
  assert.equal(readdirSync(join(paths.root, "data", "keyed")).includes("foundry.json"), true);
});

// ---- The command line ----

/** The command line against a stand-in service: { exit, out, err, calls }. */
async function botkins(argv, answers, input = "") {
  const calls = [];
  let out = "";
  let err = "";
  const stdin = Readable.from(input ? [input] : []);
  stdin.isTTY = false;
  const client = {
    running: async () => true,
    hello: async () => ({ app: "botkins", api: 1, version: "9.9.9", pid: 1 }),
    async call(method, ...args) {
      calls.push([method, ...args]);
      if (!Object.hasOwn(answers, method)) throw new ControlError("The service has no call named " + method + ".", "UNKNOWN_METHOD");
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(...args) : answer;
    },
  };
  const exit = await main(argv, { stdout: { write: (text) => void (out += text), isTTY: false }, stderr: { write: (text) => void (err += text), isTTY: false }, stdin, env: { BOTKINS_DATA_DIR: "/nowhere/botkins" }, client });
  return { exit, out, err, calls, json: () => JSON.parse(out) };
}
const SET_ANSWER = { id: "foundry", name: "Azure Foundry", enabled: true, connected: true, hasKey: true, needs: null, config: {} };

test("`providers set` sends the options as settings: models replace the list, names and apis go with their model", async () => {
  const answers = { "providers.set": SET_ANSWER, "providers.list": [{ id: "foundry" }, { id: "openai-api" }] };
  const done = await botkins(["providers", "set", "foundry", "--endpoint", "https://n.openai.azure.com", "--api-version", "2025-03-01-preview", "--model", "DeepSeek-V4-Pro", "--model", "o-x=responses", "--model-name", "o-x=O X", "--json"], answers);
  assert.equal(done.exit, 0, done.err);
  assert.deepEqual(done.calls.at(-1), ["providers.set", "foundry", { endpoint: "https://n.openai.azure.com", apiVersion: "2025-03-01-preview", models: [{ id: "DeepSeek-V4-Pro" }, { id: "o-x", name: "O X", api: "responses" }] }]);
  assert.equal(done.json().connected, true);
  const local = await botkins(["providers", "set", "openai-api", "--base-url", "http://localhost:11434/v1", "--api", "completions"], answers);
  assert.deepEqual(local.calls.at(-1), ["providers.set", "openai-api", { baseUrl: "http://localhost:11434/v1", api: "completions" }]);
  assert.match(local.out, /Azure Foundry is set\. It is ready\./);
  const cleared = await botkins(["providers", "set", "foundry", "--clear-models"], { "providers.set": { ...SET_ANSWER, connected: false, needs: "Add at least one deployment: the name you gave a model in your Azure resource." } });
  assert.deepEqual(cleared.calls[0], ["providers.set", "foundry", { clearModels: true }]);
  assert.match(cleared.out, /Still missing: Add at least one deployment/);
});

test("`providers set` asks before a kept key is sent to a new address, and says where", async () => {
  const kept = { id: "foundry", token: "kept by Botkins", keyed: { hasKey: true, config: { endpoint: "https://a.openai.azure.com/openai/v1" } } };
  const answers = { "providers.list": [kept], "providers.set": SET_ANSWER };
  const unasked = await botkins(["providers", "set", "foundry", "--endpoint", "https://b.openai.azure.com"], answers);
  assert.equal(unasked.exit, 2);
  assert.match(unasked.err, /sent to the address[\s\S]*https:\/\/b\.openai\.azure\.com/);
  assert.equal(unasked.calls.some(([name]) => name === "providers.set"), false);
  const agreed = await botkins(["providers", "set", "foundry", "--endpoint", "https://b.openai.azure.com", "--yes"], answers);
  assert.equal(agreed.exit, 0, agreed.err);
  assert.deepEqual(agreed.calls.at(-1), ["providers.set", "foundry", { endpoint: "https://b.openai.azure.com" }, { agreed: true }]);
  // The same address, or settings that are not an address, ask nothing.
  const same = await botkins(["providers", "set", "foundry", "--endpoint", "https://a.openai.azure.com", "--model", "m"], answers);
  assert.deepEqual([same.exit, same.calls.at(-1).length], [0, 3]);
});

test("`providers set` refuses what makes no sense before it asks the service", async () => {
  for (const argv of [["providers", "set"], ["providers", "set", "foundry"], ["providers", "set", "foundry", "--api", "chat"], ["providers", "set", "foundry", "--model", "a=chat"], ["providers", "set", "foundry", "--model", "a", "--clear-models"], ["providers", "set", "foundry", "--model", "a", "--model-name", "b=B"], ["providers", "set", "foundry", "--model-name", "a=A"], ["providers", "set", "foundry", "--model", "a", "--model-name", "a"]]) {
    const refused = await botkins(argv, { "providers.set": SET_ANSWER });
    assert.equal(refused.exit, 2, argv.join(" "));
    assert.equal(refused.calls.length, 0, argv.join(" "));
  }
});

test("`providers login` takes a key from standard input for a key provider, and never prints it", async () => {
  const list = [{ id: "foundry", name: "Azure Foundry", keyed: { hasKey: false } }];
  const needsKey = new ControlError("Azure Foundry takes a key, not a sign-in page. Give it as a token.", "NEEDS_KEY");
  const answers = { "providers.list": list, "providers.login": (id, options) => (options.token ? { connected: false, account: null, plan: "API key", needs: "Add your Azure resource's endpoint, like https://NAME.services.ai.azure.com." } : Promise.reject(needsKey)) };
  const done = await botkins(["providers", "login", "foundry"], answers, "azure-secret\n");
  assert.equal(done.exit, 0, done.err);
  assert.deepEqual(done.calls.at(-1), ["providers.login", "foundry", { token: "azure-secret", service: undefined }]);
  assert.match(done.out, /Key saved\. Still missing: Add your Azure resource's endpoint/);
  assert.equal((done.out + done.err).includes("azure-secret"), false);
  // With a key kept already, replacing it asks first.
  const again = await botkins(["providers", "login", "foundry", "--token"], { ...answers, "providers.list": [{ ...list[0], token: "kept by Botkins" }] }, "azure-secret\n");
  assert.equal(again.exit, 2);
  assert.match(again.err, /--yes/);
});

test("`providers list` shows what a key provider is missing", async () => {
  const entry = { id: "openrouter", name: "OpenRouter", enabled: false, installed: true, connected: false, message: "Paste your OpenRouter key (it starts with sk-or-).", keyed: { hasKey: false, needs: "Paste your OpenRouter key (it starts with sk-or-)." } };
  const shown = await botkins(["providers", "list"], { "providers.list": [entry] });
  assert.match(shown.out, /openrouter\s+OpenRouter\s+off/);
  assert.match(shown.out, /sk-or-/);
});
