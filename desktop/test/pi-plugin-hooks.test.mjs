// Every hook event Copilot runs, on Pi and OMP (#309), against the stand-in OMP
// (test/fixtures/fake-omp.mjs). One fixture plugin, read by Botkins' own pluginSession(), has a
// hook for each event that writes what it was told and answers what the case asks. What must
// hold is what the real Copilot runtime did (test/hook-events-probe-live.mjs): the order, one run
// for each event, the stop limits, nothing after a stop, and no hook at all without plugin access.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { newStops, pluginSession, STOP_BLOCKS } from "../desktop/plugin-runtime.mjs";

const skip = process.platform === "win32" && "The stand-in is a shell script.";
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "botkins-plugin-hooks-"));
after(() => rmSync(root, { recursive: true, force: true }));
const binary = join(root, "omp");
writeFileSync(binary, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(FIXTURE) + ' "$@"\n');
chmodSync(binary, 0o755);

const EVENTS = ["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "sessionEnd", "errorOccurred"];
const plugin = join(root, "every-hook");
mkdirSync(plugin, { recursive: true });
writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "every", hooks: "hooks.json" }));
// Each hook writes "<event> <what it was told>" and answers the JSON in answers/<event>.json, if any.
writeFileSync(
  join(plugin, "hook.mjs"),
  [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    "const event = process.argv[2];",
    'let d = ""; process.stdin.on("data", (b) => (d += b)).on("end", () => {',
    "  const x = JSON.parse(d);",
    "  const said = { source: x.source, toolName: x.toolName, stopHookActive: x.stopHookActive, reason: x.reason, errorContext: x.errorContext, error: x.error, result: x.toolResult?.textResultForLlm };",
    '  appendFileSync(process.env.PLUGIN_DATA + "/events.log", JSON.stringify({ event, ...said }) + "\\n");',
    '  const file = process.env.PLUGIN_DATA + "/answers/" + event + ".json";',
    '  console.log(existsSync(file) ? readFileSync(file, "utf8").trim() : "{}");',
    "});",
  ].join("\n"),
);
writeFileSync(join(plugin, "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ type: "command", command: 'node "${PLUGIN_ROOT}/hook.mjs" ' + event }]])) }));
const record = (more = {}) => ({ id: "every", folder: plugin, config: [], status: "ready", enabled: true, bots: "all", ...more });
const CONNECTION = { name: "botkins-claude", config: { name: "Claude", baseUrl: "http://127.0.0.1:1/claude", api: "anthropic-messages", apiKey: "s", models: [{ id: "opus", name: "Opus", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };

let n = 0;
function setup(answers = {}, plugins = [record()], { hooks = true } = {}) {
  const dir = join(root, "case-" + ++n);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "log.jsonl");
  const provider = new OmpProvider({ dataDir: dir, binary, env: { ...process.env, FAKE_OMP_LOG: logFile } });
  const seen = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const stops = newStops();
  const session = pluginSession(plugins, { dir, chatId: "chat-1", botId: "bot-1", stops });
  // The hook's own data folder, where it reads its answers and writes what it was told.
  const data = () => {
    const base = join(dir, ".botkins-plugin-data");
    return existsSync(base) ? readdirSync(base).map((name) => join(base, name)) : [];
  };
  for (const folder of data()) {
    mkdirSync(join(folder, "answers"), { recursive: true });
    for (const [event, answer] of Object.entries(answers)) writeFileSync(join(folder, "answers", event + ".json"), JSON.stringify(answer));
  }
  const events = () => data().flatMap((folder) => (existsSync(join(folder, "events.log")) ? readFileSync(join(folder, "events.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []));
  const asked = [];
  const spec = {
    sessionId: "chat-1", established: false, hasReplies: false, folder: root,
    model: { model: "opus", source: "botkins-claude", reasoningEffort: "high" }, inference: { providers: [CONNECTION] },
    instructions: "You are Testy.", context: "", tools: [], skills: { directories: [], disabled: [] },
    mcpServers: session.mcpServers, plugins: session.directories,
    // As the workspace hands them: none for a turn without plugin access (Workspace.openSession).
    pluginHooks: hooks ? session.hooks : undefined,
    history: () => [], handlers: { permission: async (request) => (asked.push(request), { allow: true }) },
  };
  return { provider, seen, events, spec, asked, stops };
}
const names = (list) => list.map((entry) => entry.event);

test("the hooks run in Copilot's order, once each, and end with the harness process", { skip }, async () => {
  const { provider, events, spec } = setup();
  const session = await provider.openSession(spec);
  await session.send({ prompt: "run bash:ls" });
  await session.send({ prompt: "badtool bash:make" });
  await session.close();
  await provider.stop();
  // Copilot (test/hook-events-probe-live.mjs, case "tools" and "two-turns"): sessionStart once, then per turn
  // userPromptSubmitted, preToolUse, postToolUse or postToolUseFailure, agentStop; sessionEnd when the session goes.
  assert.deepEqual(names(events()), ["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "agentStop", "userPromptSubmitted", "preToolUse", "postToolUseFailure", "agentStop", "sessionEnd"]);
  const all = events();
  assert.equal(all[0].source, "new");
  assert.equal(all[3].result, "ran");
  assert.equal(all[7].error, "tool broke");
  assert.equal(all[4].stopHookActive, false);
  assert.equal(all.at(-1).reason, "user_exit");
});

test("what the hooks add and change reaches the model as on Copilot", { skip }, async () => {
  const { provider, seen, spec } = setup({
    sessionStart: { additionalContext: "start ctx" },
    userPromptSubmitted: { additionalContext: "prompt ctx" },
    postToolUse: { modifiedResult: { textResultForLlm: "CHANGED RESULT", resultType: "success" }, additionalContext: "post ctx" },
  });
  const session = await provider.openSession(spec);
  await session.send({ prompt: "run bash:ls" });
  await session.send({ prompt: "again bash:ls" });
  const prompts = seen().filter((entry) => entry.command?.type === "prompt").map((entry) => entry.command.message);
  assert.match(prompts[0], /^start ctx\n\nrun bash:ls\n\n<system_reminder>\nprompt ctx\n<\/system_reminder>$/);
  assert.ok(!prompts[1].includes("start ctx"), "sessionStart's context goes with the first message only");
  const result = seen().filter((entry) => entry.result).map((entry) => entry.result.text);
  assert.equal(result[0], 'CHANGED RESULT\n\nTool "bash" succeeded. Additional guidance from postToolUse hooks:\npost ctx');
  await session.close();
  await provider.stop();
});

test("agentStop's block sends its reason as the next message, and Botkins' limit ends the chain", { skip }, async () => {
  const { provider, seen, events, spec } = setup({ agentStop: { decision: "block", reason: "keep going" } });
  const session = await provider.openSession(spec);
  const { text } = await session.send({ prompt: "hello" });
  const prompts = seen().filter((entry) => entry.command?.type === "prompt").map((entry) => entry.command.message);
  // One plugin may keep a turn going STOP_BLOCKS times (plugin-runtime.mjs); the next block is dropped.
  assert.deepEqual(prompts, ["hello", ...Array(STOP_BLOCKS).fill("keep going")]);
  const stops = events().filter((entry) => entry.event === "agentStop");
  assert.deepEqual(stops.map((entry) => entry.stopHookActive), [false, true, true, true]);
  // Each reason goes through the prompt hook as a message of the person's would (Copilot, probe case "stop-block").
  assert.deepEqual(names(events()).slice(1, 9), ["userPromptSubmitted", "agentStop", "userPromptSubmitted", "agentStop", "userPromptSubmitted", "agentStop", "userPromptSubmitted", "agentStop"]);
  assert.equal(text, "echo: keep going");
  // The next turn starts the count again.
  await session.send({ prompt: "second" });
  assert.equal(seen().filter((entry) => entry.command?.type === "prompt").length, 2 * (STOP_BLOCKS + 1));
  await session.close();
  await provider.stop();
});

test("a failed model request runs errorOccurred once, and the turn goes on", { skip }, async () => {
  const { provider, events, spec } = setup();
  const session = await provider.openSession(spec);
  const { text } = await session.send({ prompt: "failonce" });
  assert.equal(text, "echo: failonce");
  const errors = events().filter((entry) => entry.event === "errorOccurred");
  assert.equal(errors.length, 1);
  assert.deepEqual([errors[0].errorContext, errors[0].error], ["model_call", "flaky"]);
  // A turn that ends in an error has no natural stop: no agentStop (Copilot, case "model-error").
  await assert.rejects(session.send({ prompt: "fail" }), /The plan said no\./);
  assert.deepEqual(names(events()).slice(-2), ["userPromptSubmitted", "errorOccurred"]);
  await session.close();
  await provider.stop();
});

test("a stopped turn runs no result or stop hook, and a refused call no result hook", { skip }, async () => {
  const { provider, events, spec } = setup({ preToolUse: { permissionDecision: "deny", permissionDecisionReason: "no" } });
  const session = await provider.openSession(spec);
  await session.send({ prompt: "run bash:rm" });
  assert.deepEqual(names(events()), ["sessionStart", "userPromptSubmitted", "preToolUse", "agentStop"], "a denied call has no postToolUse");
  await session.close();
  await provider.stop();

  const second = setup();
  const live = await second.provider.openSession(second.spec);
  const turn = live.send({ prompt: "slowtool bash:sleep" });
  // Stopped while the tool runs, after its preToolUse hook (as in Copilot's case "abort").
  while (!second.seen().some((entry) => entry.ran)) await new Promise((resolve) => setTimeout(resolve, 10));
  await live.abort();
  await turn;
  // Copilot (case "abort"): preToolUse, then nothing for the turn.
  assert.deepEqual(names(second.events()), ["sessionStart", "userPromptSubmitted", "preToolUse"]);
  await live.close();
  await second.provider.stop();
  assert.equal(names(second.events()).at(-1), "sessionEnd");
});

test("no hook runs for a turn without plugin access, or for a switched-off plugin", { skip }, async () => {
  for (const [label, made] of [["no access", setup({}, [record()], { hooks: false })], ["switched off", setup({}, [record({ enabled: false })])], ["another bot's", setup({}, [record({ bots: ["bot-2"] })])]]) {
    const session = await made.provider.openSession(made.spec);
    await session.send({ prompt: "run bash:ls" });
    await session.close();
    await made.provider.stop();
    assert.deepEqual(made.events(), [], label);
    const { started } = made.seen().find((entry) => entry.started);
    assert.ok(!started.described.preToolUse && !started.described.postToolUse, label + ": the extension asks nothing more");
    assert.equal(made.asked.length, 1, label + ": the call still goes to Botkins' approval");
  }
});
