// Run with node test/pi-secure-input-live.mjs. The installed Pi runs a real Botkins chat.
// The model and form recipient are local fixtures. No account is needed. By default
// the answer arrives after Pi's ordinary 60-second MCP request timeout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { headlessHost } from "../desktop/host/headless.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { performSecureUse } from "../desktop/secure-input.mjs";
import { seedBots } from "./starter.mjs";

const waitMs = Number(process.env.PI_SECURE_ANSWER_DELAY_MS ?? 65000);
const form = { operation: "https_form", url: "https://example.org/sign-in", title: "Sign in", fields: [
  { key: "username", label: "User name", kind: "text" }, { key: "password", label: "Password", kind: "password" },
  { key: "code", label: "Optional code", kind: "code", optional: true },
] };

function modelReply(id, name, args) {
  const item = name ? { id: "fc_" + id, call_id: "call_" + id, type: "function_call", name, arguments: JSON.stringify(args), status: "completed" }
    : { id: "msg_" + id, type: "message", role: "assistant", content: [{ type: "output_text", text: "Done", annotations: [] }], status: "completed" };
  const response = { id: "resp_" + id, status: "in_progress", output: [] };
  const event = (type, data) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";
  const body = event("response.created", { response }) +
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(name ? { arguments: "" } : { content: [] }) } }) +
    (name ? event("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments })
      : event("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: "Done" })) +
    event("response.output_item.done", { output_index: 0, item }) +
    event("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("real Pi applies the completed secure prompt exactly once", { timeout: waitMs + 30000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "botkins-pi-secure-"));
  seedBots(dataDir);
  const runtime = await createRuntime({ host: headlessHost({ version: "1.0.0" }), dataDir, trial: true, link: { port: 0, announce: false } });
  t.after(async () => { await runtime.stop(); rmSync(dataDir, { force: true, recursive: true }); });
  const secrets = { username: "synthetic-private-user", password: "synthetic-vault-password" };
  const credential = await runtime.handlers.saveSavedCredential({ name: "Fixture login", kind: "login", value: secrets.password });
  const ws = runtime.workspace, chat = ws.chat(ws.createChat("pip"));
  ws.state.settings.harness = "pi";
  chat.model = { provider: "codex", model: "fixture" };
  if (process.env.PI_BINARY) runtime.providers.require("pi").binary = process.env.PI_BINARY;
  t.mock.method(runtime.providers, "models", async () => [{ provider: "codex", id: "fixture", tools: true }]);
  const gateway = ws.harness.gateway;
  gateway.chatgpt = { signIn: () => ({ token: "fixture" }) };

  let grant, failure, answer, cards = 0, modelCalls = 0;
  const submissions = [];
  t.mock.method(ws.secureInputs, "use", (plan, values, adapters) => performSecureUse(plan, values, { ...adapters, fetch: async (url, init) => {
    assert.equal(url, form.url);
    assert.equal(init.method, "POST");
    submissions.push(Object.fromEntries(init.body));
    return new Response(null, { status: 204 });
  } }));
  ws.events.on("request", view => {
    cards++;
    answer = (async () => {
      assert.equal(view.kind, "secure");
      await assert.rejects(runtime.handlers.respond(view.id, { action: "accept", content: { username: secrets.username } }), /required secure fields/);
      await delay(waitMs);
      await runtime.handlers.respond(view.id, { action: "accept", content: { username: secrets.username, password: { $credential: credential } } });
    })().catch(error => { failure ??= error; });
  });

  t.mock.method(gateway, "fetch", async (_url, init) => {
    try {
      for (const value of Object.values(secrets)) assert.ok(!init.body.includes(value), "a secret reached the model");
      const { input, tools } = JSON.parse(init.body);
      const toolName = name => tools.find(tool => tool.name?.endsWith(name)).name;
      const output = input.filter(item => item.type === "function_call_output").at(-1)?.output;
      const text = Array.isArray(output) ? output.map(part => part.text).join("") : output;
      switch (++modelCalls) {
        case 1: return modelReply("ask", toolName("request_secure_input"), form);
        case 2:
          assert.match(text, /^\s*\{/, "Pi should receive the handles after approval");
          grant = JSON.parse(text);
          assert.deepEqual(Object.keys(grant.handles).sort(), ["password", "username"]);
          return modelReply("apply", toolName("use_secure_input"), grant);
        case 3:
          assert.match(text, /^\s*\{/, "Pi should accept the same handles object");
          assert.deepEqual(JSON.parse(text), { applied: true });
          return modelReply("replay", toolName("use_secure_input"), grant);
        case 4:
          assert.match(text, /expired|unavailable|used/i);
          return modelReply("done");
        default: throw new Error("Unexpected extra model request");
      }
    } catch (error) { failure ??= error; return modelReply("failed"); }
  });
  await ws.send(chat.id, "Sign in with my saved login.");
  await answer;
  if (failure) throw failure;
  assert.equal(chat.sessionProvider, "pi", ws.state.runs[0].detail);
  assert.equal(chat.messages.at(-1).text, "Done", ws.state.runs[0].detail);
  assert.equal(cards, 1);
  assert.equal(modelCalls, 4);
  assert.deepEqual(submissions, [secrets]);
  const saved = readFileSync(join(dataDir, "workspace.json"), "utf8");
  for (const value of Object.values(secrets)) assert.ok(!saved.includes(value));
});
