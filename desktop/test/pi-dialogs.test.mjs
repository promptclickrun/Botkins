import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DETACHED_NOTE, Interactions } from "../desktop/interactions.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";
import { bundledPi, PiProvider } from "../desktop/providers/pi/index.mjs";
import { modelReply } from "./fixtures/pi-model-response.mjs";

function setup(handlers = {}, spec = {}) {
  const replies = [];
  const provider = new PiProvider();
  const session = { spec: { handlers, nativeDialogs: true, ...spec }, turn: {}, mode: "interactive" };
  const live = { session, rpc: { write: response => replies.push(response) } };
  const request = (id, method, fields = {}) => provider.dialog(live, { id, method, ...fields });
  return { provider, live, session, request, replies };
}

test("Pi select and input return the chat's answer, not a default", async () => {
  const { request, replies } = setup({
    question: async req => {
      if (req.question === "Pick one") {
        assert.deepEqual(req.choices, ["First", "Next"]);
        assert.equal(req.allowFreeform, false);
        return { answer: "Next" };
      }
      return { answer: "A real answer" };
    },
  });
  await request("1", "select", { title: "Pick one", options: ["First", "Next"] });
  await request("2", "input", { title: "Input" });
  assert.deepEqual(replies.map(({ id, value }) => [id, value]), [["1", "Next"], ["2", "A real answer"]]);
});

test("a harness cancellation ends only its own dialog and sends no stale response", async () => {
  const { request, replies } = setup({
    question: req => req.question === "Old" ? new Promise((_, reject) => {
      req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
    }) : { answer: "New answer" },
  });
  const old = request("1", "input", { title: "Old" });
  const next = request("2", "input", { title: "New" });
  await request("drop", "cancel", { targetId: "1" });
  await Promise.all([old, next]);
  await request("2", "input", { title: "New" });
  assert.deepEqual(replies, [{ type: "extension_ui_response", id: "2", value: "New answer" }]);
});

test("Stop replies once, even if the person responds later", async () => {
  const answer = Promise.withResolvers();
  const { provider, live, request, replies } = setup({ question: () => answer.promise });
  const dialog = request("1", "editor", { title: "Write a note" });
  provider.cancelDialogs(live);
  answer.resolve({ answer: "too late" });
  await dialog;
  assert.deepEqual(replies, [{ type: "extension_ui_response", id: "1", cancelled: true }]);
});

test("secret, helper and unattended requests never enter an ordinary chat question", async () => {
  const question = () => assert.fail("must not offer an ordinary question");
  for (const [spec, fields] of [[{}, { secret: true }], [{ nativeDialogs: false }, {}]]) {
    const { request, replies } = setup({ question }, spec);
    await request("1", "input", { title: "Ask", ...fields });
    assert.deepEqual(replies, [{ type: "extension_ui_response", id: "1", cancelled: true }]);
  }
});

test("OMP form shows inert fields on the shared interaction and returns submitted data only", async () => {
  let shown;
  const { request, replies } = setup({ form: async req => {
    shown = req;
    return { action: "accept", content: { region: "west", notes: "Ship it", unexpected: "discard" } };
  } });
  await request("1", "form", { html: '<form><label>Region <select name="region" required><option value="west">West</option><option value="east">East</option></select></label><label>Notes <textarea name="notes"></textarea></label></form>' });
  assert.deepEqual(shown?.requestedSchema.required, ["region"]);
  assert.deepEqual(shown?.requestedSchema.properties.region.oneOf, [{ const: "west", title: "West" }, { const: "east", title: "East" }]);
  assert.deepEqual(replies, [{ type: "extension_ui_response", id: "1", data: { region: "west", notes: "Ship it" } }]);
});

test("a native confirmation in plan mode needs an explicit affirmative plan-exit answer", async () => {
  let preview;
  const { session, request, replies } = setup({ planExit: async ({ planContent, actions }) => {
    preview = planContent;
    return { approved: true, selectedAction: actions[0] };
  } });
  session.mode = "plan";
  await request("1", "confirm", { title: "Execute the plan?", message: "Fixture plan" });
  assert.equal(preview, "Fixture plan");
  assert.deepEqual(replies, [{ type: "extension_ui_response", id: "1", confirmed: true }]);
});

test("the desktop and paired response contract answer the dialog in its own chat", async () => {
  const events = new EventEmitter();
  const chat = { id: "fixture-chat", botId: "fixture-bot" };
  const task = {};
  const interactions = new Interactions({ events, notify() {}, state: { chats: [chat] } });
  const { request, replies } = setup({
    question: req => interactions.question(chat, task, req),
    form: req => interactions.elicit(chat, task, req),
  });
  const asked = once(events, "request");
  const dialog = request("1", "select", { title: "Audience", options: ["Team", "Public"] });
  const [question] = await asked;
  assert.equal(question.chatId, chat.id);
  interactions.respond(question.id, { action: "answer", value: "Team" });
  await dialog;

  const shown = once(events, "request");
  const form = request("2", "form", { html: '<form><label>Message <input name="message" required></label></form>' });
  const [view] = await shown;
  assert.equal(view.chatId, chat.id);
  interactions.respond(...remoteArgs("respond", [view.id, { action: "accept", content: { message: "From phone" } }]));
  await form;
  assert.deepEqual(replies, [
    { type: "extension_ui_response", id: "1", value: "Team" },
    { type: "extension_ui_response", id: "2", data: { message: "From phone" } },
  ]);
});

test("a detached native question leaves its card open without waiting in Pi", async () => {
  const events = new EventEmitter();
  const chat = { id: "fixture-chat", botId: "fixture-bot" };
  const interactions = new Interactions({ events, notify() {}, save() {}, state: { chats: [chat] } });
  const { request, replies } = setup({ question: req => interactions.question(chat, {}, req) });
  const asked = once(events, "request");
  const waiting = request("1", "input", { title: "Audience" });
  const [view] = await asked;
  interactions.detach(view.id);
  await waiting;
  assert.equal(interactions.snapshot()[0].detached, true);
  assert.deepEqual(replies, [{ type: "extension_ui_response", id: "1", value: DETACHED_NOTE }]);
});

test("an OMP form cannot ask for a password or execute HTML", async () => {
  const { request, replies } = setup({ form: () => assert.fail("must not offer an unsafe form") });
  await request("1", "form", { html: '<form><input name="password" type="password"></form>' });
  await request("2", "form", { html: '<form><input name="message"><script>void 0</script></form>' });
  assert.deepEqual(replies, [
    { type: "extension_ui_response", id: "1", cancelled: true },
    { type: "extension_ui_response", id: "2", cancelled: true },
  ]);
});

const fixtureExtension = fileURLToPath(new URL("./fixtures/native-dialog-extension.mjs", import.meta.url));
for (const [runtime, binary] of [["pi", bundledPi()], ["omp", process.env.BOTKINS_TEST_OMP]]) {
  test(`real ${runtime} returns the native chat dialog results to its extension`, { skip: !binary, timeout: 20000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "bk-native-dialog-"));
    const provider = new PiProvider({
      runtime, binary, dataDir: root,
      packages: { activePaths: () => [fixtureExtension] },
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root },
    });
    const seen = [], models = [];
    const server = createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      models.push(JSON.parse(Buffer.concat(body).toString()));
      const response = modelReply("done");
      res.writeHead(200, Object.fromEntries(response.headers)).end(await response.text());
    });
    t.after(async () => {
      await provider.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const session = await provider.openSession({
      sessionId: "native-fixture", folder: root, model: { source: "fixture", model: "fixture" },
      inference: { providers: [{ name: "fixture", config: {
        baseUrl: `http://127.0.0.1:${server.address().port}/model`, api: "openai-responses", apiKey: "model-fixture",
        models: [{ id: "fixture", name: "Fixture", input: ["text"], contextWindow: 16000, maxTokens: 1000, cost: {} }],
      } }] },
      tools: [], nativeDialogs: true,
      handlers: {
        question: req => (seen.push(req.question), { answer: "Team" }),
        form: req => (seen.push(req.message), { action: "accept", content: { message: "From chat" } }),
        planExit: req => (seen.push(req.summary), { approved: true, selectedAction: req.actions[0] }),
      },
    });
    await session.setMode("plan");
    await session.send({ prompt: "Check native dialogs" });
    assert.deepEqual(seen, ["Fixture question", ...(runtime === "omp" ? ["Answer this form"] : []), "Execute the fixture plan?"]);
    const model = JSON.stringify(models);
    assert.match(model, /\\?"question\\?":\\?"Team\\?"/);
    assert.match(model, /\\?"plan\\?":true/);
    if (runtime === "omp") assert.match(model, /From chat/);
    await session.close();
  });
}
