// A real Pi process using a local deterministic model through the Botkins gateway.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { headlessHost } from "../desktop/host/headless.mjs";
import { bundledPi } from "../desktop/providers/pi/index.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { modelReply } from "./fixtures/pi-model-response.mjs";
import { seedBots } from "./starter.mjs";

async function until(what, predicate) {
  const end = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(what);
    await delay(25);
  }
}

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-pi-steer-"));
  seedBots(dir);
  const runtime = await createRuntime({ host: headlessHost({ version: "1" }), dataDir: dir, trial: true, link: { port: 0, announce: false } });
  const ws = runtime.workspace;
  const chat = ws.chat(ws.createChat("pip"));
  t.after(async () => {
    writeFileSync(join(dir, "finish"), "");
    await ws.stop(chat.id);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const pi = runtime.providers.require("pi");
  pi.binary = bundledPi();
  assert.ok(pi.binary);
  ws.state.settings.harness = "pi";
  chat.model = { provider: "codex", model: "fixture" };
  t.mock.method(runtime.providers, "models", async () => [{ provider: "codex", id: "fixture", tools: true }]);
  const gateway = ws.harness.gateway;
  gateway.chatgpt = { signIn: () => ({ token: "fixture" }) };
  return { dir, ws, chat, pi, gateway, runtime };
}

test("Pi redirects a running shell tool immediately in the same workspace turn; ordinary queued messages wait", { timeout: 25000, skip: process.platform === "win32" }, async t => {
  const { dir, ws, chat, pi, gateway, runtime } = await setup(t);
  const log = join(dir, "tool.log"), release = join(dir, "finish"), attachment = join(dir, "steer.txt");
  writeFileSync(attachment, "fixture attachment");
  const requests = [];
  const command = `echo started >> '${log}'; while [ ! -f '${release}' ]; do sleep 0.1; done; echo finished >> '${log}'`;
  ws.events.on("request", request => { void runtime.handlers.respond(request.id, { action: "approve" }); });
  t.mock.method(gateway, "fetch", async (_url, init) => {
    const { input, tools } = JSON.parse(init.body);
    const users = input.filter(item => item.role === "user").map(item => JSON.stringify(item.content));
    requests.push(users);
    if (requests.length === 1) return modelReply("shell", tools.find(tool => tool.name === "bash").name, { command });
    return modelReply("answer" + requests.length, null, null, users.at(-1)?.includes("NORMAL-QUEUE") ? "Queue answered" : "Redirect answered");
  });
  const done = ws.submit(chat.id, "Start the shell fixture");
  await until("the initial tool did not start", () => existsSync(log));
  const run = ws.active.get(chat.id).run.id;
  const processId = [...pi.live.values()][0].rpc.child.pid;
  ws.submit(chat.id, "NORMAL-QUEUE");
  ws.submit(chat.id, "REDIRECT-NOW", { delivery: "steer", attachments: [attachment] });
  await until("Pi did not receive the steer while its original bash command was running", () => requests.length > 1);
  await done;
  await until("the normal queued input did not get its own answer", () => chat.messages.some(m => m.text === "Queue answered"));
  assert.equal(requests.length, 3);
  assert.equal(requests[1].filter(text => text.includes("REDIRECT-NOW")).length, 1);
  assert.ok(requests[1].at(-1).includes(attachment));
  assert.ok(!requests[1].some(text => text.includes("NORMAL-QUEUE")));
  assert.equal(readFileSync(log, "utf8"), "started\n", "the old command was interrupted and never replayed");
  assert.equal([...pi.live.values()][0].rpc.child.pid, processId);
  const steer = chat.messages.filter(message => message.text === "REDIRECT-NOW");
  assert.equal(steer.length, 1);
  assert.equal(steer[0].steeredRunId, run);
  assert.equal(chat.messages.find(message => message.text === "Redirect answered")?.runId, run);
  assert.equal(chat.messages.find(message => message.text === "NORMAL-QUEUE")?.steeredRunId, undefined);
});

test("Stop during Pi redirection cancels the old approval and leaves the unadmitted steer for Send now", { timeout: 20000, skip: process.platform === "win32" }, async t => {
  const { dir, ws, chat, pi, gateway } = await setup(t);
  const output = join(dir, "should-not-run");
  let calls = 0, approval;
  ws.events.on("request", request => { approval = request; });
  t.mock.method(gateway, "fetch", async (_url, init) => {
    const { tools } = JSON.parse(init.body);
    if (++calls === 1) return modelReply("approval", tools.find(tool => tool.name === "bash").name, { command: "touch '" + output + "'" });
    return modelReply("next", null, null, "Sent on request");
  });
  const done = ws.submit(chat.id, "Request permission for this fixture command");
  await until("Pi did not ask for approval", () => approval);
  const rpc = [...pi.live.values()][0].rpc;
  const request = rpc.request.bind(rpc);
  const releaseAck = Promise.withResolvers();
  let idle = false;
  t.mock.method(rpc, "request", async (command, timeout) => {
    const result = await request(command, timeout);
    if (command.type === "abort") {
      idle = true;
      await releaseAck.promise;
    }
    return result;
  });
  try {
    ws.submit(chat.id, "Keep this unsent correction", { delivery: "steer" });
    await until("the old approval blocked Pi from reaching idle", () => idle);
    assert.equal(chat.messages.some(item => item.text === "Keep this unsent correction"), false, "steer is not marked delivered while abort is pending");
    await ws.stop(chat.id);
  } finally {
    releaseAck.resolve();
  }
  await done;
  await delay(100);
  assert.equal(calls, 1, "Stop prevents the replacement from running in this or a new turn");
  assert.equal(existsSync(output), false);
  assert.equal(ws.interactions.snapshot().some(item => item.id === approval.id), false);
  const [held] = ws.snapshot().queued[chat.id];
  assert.equal(held.text, "Keep this unsent correction");
  await ws.sendNow(chat.id, held.id);
  await until("the person could not explicitly send the waiting message", () => chat.messages.some(m => m.text === "Sent on request"));
  assert.equal(calls, 2);
});
