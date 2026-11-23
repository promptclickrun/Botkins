// The providers set up with a key ("keyed-providers-v1"): the plain logic behind their cards in
// Settings › Model providers (src/keyedProviders.ts). It is the phone's (mobile/src/features/models/keyed.ts)
// word for word below its marker line, so both apps offer the same choices and words.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as keyed from "../src/keyedProviders.ts";

const MARKER = "// ---- Everything below this line is the same in both apps.\n";
const foundry = { fields: ["endpoint", "apiVersion", "models"], hasKey: false, keyOptional: false, config: {}, needs: null };
const endpoint = { fields: ["baseUrl", "api", "models"], hasKey: false, keyOptional: true, config: {}, needs: null };

test("the same logic and words as the phone's page", (t) => {
  const phone = new URL("../../mobile/src/features/models/keyed.ts", import.meta.url);
  if (!existsSync(phone)) return t.skip("the phone app isn't beside this one");
  const body = (url) => readFileSync(url, "utf8").split(MARKER)[1];
  assert.ok(body(phone), "the phone's file has the marker line");
  assert.equal(body(new URL("../src/keyedProviders.ts", import.meta.url)), body(phone));
});

test("Foundry sends each model with its API; an endpoint sends the API once", () => {
  const form = keyed.formFromConfig({});
  form.endpoint = "https://a.services.ai.azure.com/";
  form.baseUrl = "http://localhost:1234/v1";
  form.models = [{ ...keyed.newRow(), id: "gpt-5", name: "GPT-5" }, keyed.newRow()];
  assert.deepEqual(keyed.configFromForm(foundry, form), {
    endpoint: "https://a.services.ai.azure.com",
    models: [{ id: "gpt-5", name: "GPT-5", api: "completions" }],
  });
  assert.deepEqual(keyed.configFromForm(endpoint, form), {
    baseUrl: "http://localhost:1234/v1",
    api: "responses",
    models: [{ id: "gpt-5", name: "GPT-5" }],
  });
});

test("Save is held back by a bad address or a model without its id", () => {
  const form = keyed.formFromConfig({});
  form.endpoint = "http://a.services.ai.azure.com";
  const row = { ...keyed.newRow(), name: "No id" };
  form.models = [row];
  const problems = keyed.formProblems("foundry", foundry, form);
  assert.equal(problems.endpoint, "Use an address that starts with https://.");
  assert.equal(problems.models[row.row], "Type the deployment name.");
  assert.equal(keyed.hasProblems(keyed.formProblems("openai-api", endpoint, keyed.formFromConfig({ baseUrl: "http://localhost/v1" }))), false);
});
