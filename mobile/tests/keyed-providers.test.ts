// OpenRouter, Azure Foundry and an OpenAI endpoint from the phone ("keyed-providers-v1"): the
// link's cut of the settings call, its owner-only rule, and the demo computer's answers, so the
// phone's screens can be tried against it. The computer's own checks are in
// desktop/test/providers-keyed.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteArgs, REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { TEAM_METHODS } from "../link-host/team.mjs";
import type { ProviderStatus } from "../src/link/types";

const status = async (backend: MockBackend, id: string) => ((await backend.call("providers", [])) as ProviderStatus[]).find((entry) => entry.id === id)!;

test("the settings call is the owner's, and is cut to its shape before the computer sees it", () => {
  assert.ok(REMOTE_METHODS.has("providerConfigure"));
  assert.equal(TEAM_METHODS.providerConfigure, "owner");
  const [id, config] = remoteArgs("providerConfigure", ["foundry", { endpoint: "https://n.openai.azure.com", secret: "x", models: [{ id: "a", extra: 1 }] }]) as [string, Record<string, unknown>];
  assert.equal(id, "foundry");
  assert.deepEqual(config, { endpoint: "https://n.openai.azure.com", models: [{ id: "a", name: undefined, api: undefined, contextWindow: undefined, maxOutput: undefined }] });
  assert.deepEqual((remoteArgs("providerConfigure", ["foundry", "nonsense"]) as unknown[])[1], {});
});

test("the demo names the capability and shows the three providers off, with what each is missing", async () => {
  const demo = new MockBackend({ speed: 0.01 });
  assert.ok(demo.capabilities.includes("keyed-providers-v1"));
  const router = await status(demo, "openrouter");
  assert.deepEqual([router.signIn, router.enabled, router.connected, router.signInWays], ["key", false, false, { guided: false, token: true }]);
  assert.deepEqual([router.keyed?.fields, router.keyed?.hasKey, router.keyed?.keyOptional, router.keyed?.keyUrl], [[], false, false, "https://openrouter.ai/keys"]);
  assert.match(router.keyed?.needs ?? "", /sk-or-/);
  assert.deepEqual((await status(demo, "foundry")).keyed?.fields, ["endpoint", "apiVersion", "models"]);
  assert.deepEqual((await status(demo, "openai-api")).keyed?.fields, ["baseUrl", "api", "models"]);
  assert.equal((await status(demo, "openai-api")).keyed?.keyOptional, true);
});

test("in the demo a key and complete settings switch a provider on, its models appear, and signing out keeps the settings", async () => {
  const demo = new MockBackend({ speed: 0.01 });
  assert.equal((await demo.call("models", [])).some((model: { provider: string }) => model.provider === "foundry"), false);
  await assert.rejects(demo.call("providerUseToken", ["openrouter", "not-a-router-key", {}]), /sk-or-/);
  const keyed = await demo.call("providerUseToken", ["foundry", "azure-key", {}]);
  assert.equal(keyed.connected, false);
  assert.match(keyed.needs, /endpoint/);
  await assert.rejects(demo.call("providerConfigure", ["foundry", { endpoint: "http://insecure.example" }]), /https/);
  const ready = (await demo.call("providerConfigure", ["foundry", { endpoint: "https://n.cognitiveservices.azure.com", models: [{ id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" }] }])) as ProviderStatus;
  assert.deepEqual([ready.enabled, ready.connected, ready.keyed?.needs, ready.keyed?.config.endpoint], [true, true, null, "https://n.cognitiveservices.azure.com/openai/v1"]);
  const models = (await demo.call("models", [])) as { id: string; provider: string }[];
  assert.deepEqual(models.filter((model) => model.provider === "foundry").map((model) => model.id), ["DeepSeek-V4-Pro"]);
  await demo.call("signOut", ["foundry"]);
  const out = await status(demo, "foundry");
  assert.deepEqual([out.connected, out.keyed?.hasKey, out.keyed?.config.models?.length], [false, false, 1]);
  assert.equal(JSON.stringify(await demo.call("providers", [])).includes("azure-key"), false);
});
