// The harness: a Claude plan or a ChatGPT plan as the model behind the Copilot runtime
// (desktop/harness/*). Claude Code is stood in for by test/fixtures/fake-claude.mjs, the ChatGPT
// plan's endpoint by an injected fetch, and the gateway is reached over real HTTP on 127.0.0.1.
// Nothing here reaches the network or starts the real Claude Code or Codex.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { CALLER, ClaudePool, PlanError, assemble, claudeTurn, cliArgs, extraBody, frames, listedTools, sessionIdFor, startedUp, thinkingLevel, toolNames, toolSchema } from "../desktop/harness/claude.mjs";
import { CHATGPT_URL, chatgptSignIn, chatgptTurn, completeOutput, planRequest } from "../desktop/harness/chatgpt.mjs";
import { Gateway } from "../desktop/harness/gateway.mjs";
import { HARNESSES, Harness, PI_PLANS, harnessField, piModel, planModel } from "../desktop/harness/index.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "botkins-harness-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Starts the stand-in where Claude Code would be started. */
const launch = (_file, args, options) => spawn(process.execPath, [FIXTURE, ...args], options);
const until = async (check, ms = 5000) => {
  const limit = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > limit) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- Claude: the request as frames, the tool list, the command line ----

test("frames turn string content and block content into Claude Code's frames", () => {
  assert.deepEqual(frames([{ role: "user", content: "hi" }]), [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]);
  assert.deepEqual(
    frames([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "again" },
    ]),
    [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    ],
  );
});

test("frames merge turns of one speaker that follow each other", () => {
  const out = frames([
    { role: "user", content: "one" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
    { role: "assistant", content: "x" },
    { role: "assistant", content: "y" },
    { role: "user", content: "last" },
  ]);
  assert.deepEqual(out.map((frame) => frame.type), ["user", "assistant", "user"]);
  assert.deepEqual(out[0].message.content, [{ type: "text", text: "one" }, { type: "tool_result", tool_use_id: "t1", content: "r" }]);
  assert.deepEqual(out[1].message.content, [{ type: "text", text: "x" }, { type: "text", text: "y" }]);
});

test("frames name a tool the way Claude Code lists it, and leave everything else of the block alone", () => {
  const [, assistant] = frames([
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }] },
  ]);
  assert.deepEqual(assistant.message.content, [{ type: "tool_use", id: "toolu_1", name: "mcp__botkins__lookup", input: { q: 1 } }]);
});

test("frames drop cache_control and do not change what they were given", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }];
  const before = structuredClone(messages);
  assert.deepEqual(frames(messages)[0].message.content, [{ type: "text", text: "a" }]);
  assert.deepEqual(messages, before);
});

test("frames skip turns with nothing in them", () => {
  const out = frames([
    { role: "user", content: "a" },
    { role: "assistant", content: "" },
    { role: "assistant", content: [] },
    null,
    { role: "user", content: "b" },
  ]);
  // The empty assistant turns are gone, so the two user turns around them are one.
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].message.content, [{ type: "text", text: "a" }, { type: "text", text: "b" }]);
});

test("frames refuse a conversation that does not end with the person's turn", () => {
  const refused = (messages) => (error) => error instanceof PlanError && error.status === 400 && error.type === "invalid_request_error" && /has to end with/.test(error.message);
  assert.throws(() => frames([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), refused());
  assert.throws(() => frames([]), refused());
  assert.throws(() => frames(undefined), refused());
});

test("listedTools keep only tools that have a name and a schema, and no tool can run", async () => {
  const schema = { type: "object", properties: { q: { type: "string" } } };
  const tools = listedTools([
    { name: "lookup", description: "Looks up.", input_schema: schema },
    { name: "plain", input_schema: schema },
    { name: "", input_schema: schema },
    { description: "no name", input_schema: schema },
    { name: "no-schema" },
    { name: "bad-schema", input_schema: "object" },
    null,
  ]);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.description]), [["lookup", "Looks up."], ["plain", ""]]);
  assert.deepEqual(tools[0].parameters, schema, "the schema goes on as the tool server's `parameters`");
  await assert.rejects(tools[0].handler({ q: "x" }), /Denied/);
  assert.deepEqual(listedTools(undefined), []);
});

test("a tool's schema loses what Anthropic's API refuses at the top, and an object says its properties", () => {
  assert.deepEqual(toolSchema({ type: "object", properties: { a: { type: "string" } }, oneOf: [{ required: ["a"] }] }), { type: "object", properties: { a: { type: "string" } } });
  assert.deepEqual(toolSchema({ anyOf: [{ type: "object" }] }), { type: "object", properties: {} }, "nothing left but the kind");
  assert.deepEqual(toolSchema({ type: "object" }), { type: "object", properties: {} });
  assert.deepEqual(toolSchema(undefined), { type: "object", properties: {} });
  const nested = { type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "number" }] } } };
  assert.deepEqual(toolSchema(nested), nested, "inside a property they are allowed and kept");
});

test("a long tool name is shortened for Claude Code and found again, and two tools never share a name", () => {
  const long = "a_tool_with_a_name_that_is_far_longer_than_the_fifty_characters_allowed";
  const names = toolNames([{ name: "lookup" }, { name: long }]);
  assert.equal(names.native("lookup"), "mcp__botkins__lookup");
  assert.equal(names.original("mcp__botkins__lookup"), "lookup");
  const short = names.of(long);
  assert.equal(short.length, 50);
  assert.equal(names.native(long), "mcp__botkins__" + short);
  assert.equal(names.original("mcp__botkins__" + short), long, "the reply names the tool as the runtime knows it");
  assert.equal(names.native("gone"), "mcp__botkins__gone", "a tool the conversation mentions that is no longer offered keeps its name");
  assert.equal(names.original("plain"), "plain");
  assert.equal(listedTools([{ name: long, input_schema: { type: "object" } }], names)[0].name, short);
});

test("the request's own wishes are kept as extra fields for Claude Code's request", () => {
  const listed = listedTools([{ name: "lookup", description: "Looks something up. ".repeat(200), input_schema: { type: "object", properties: {} } }]);
  const out = extraBody({ thinking: { type: "adaptive", display: "summarized", other: 1 }, output_config: { effort: "high", format: { type: "json_schema" }, x: 1 }, max_tokens: 64000, stop_sequences: ["END"], temperature: 0.2, top_p: 0.9 }, listed);
  assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(out.output_config, { effort: "high", format: { type: "json_schema" } });
  assert.equal(out.max_tokens, 64000);
  assert.deepEqual(out.stop_sequences, ["END"]);
  assert.equal(out.tools[0].name, "mcp__botkins__lookup");
  assert.equal(out.tools[0].description.length, 4000, "the whole description, which Claude Code would shorten");
  assert.ok(!("temperature" in out) && !("top_p" in out), "a plan's models refuse sampling controls");
  assert.deepEqual(extraBody({ thinking: { type: "enabled", budget_tokens: 2048 } }, []), { thinking: { type: "enabled", budget_tokens: 2048 } });
  assert.deepEqual(extraBody({ thinking: "on", output_config: { effort: "turbo" }, max_tokens: 0, stop_sequences: [""] }, []), {}, "nothing that isn't a real value");
  assert.deepEqual(extraBody(undefined, []), {});
});

test("the thinking level is Claude Code's environment, and only a level it knows", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) assert.deepEqual(thinkingLevel(effort), { CLAUDE_CODE_EFFORT_LEVEL: effort });
  for (const effort of ["turbo", "", "HIGH", undefined, null, 3]) assert.deepEqual(thinkingLevel(effort), {}, String(effort));
});

test("sessionIdFor gives one id to the same conversation start, and it looks like a UUID", () => {
  const first = { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
  const id = sessionIdFor("system", first);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(sessionIdFor("system", structuredClone(first)), id);
  assert.notEqual(sessionIdFor("another system", first), id);
  assert.notEqual(sessionIdFor("system", { ...first, message: { ...first.message, content: [{ type: "text", text: "ho" }] } }), id);
  assert.match(sessionIdFor("", undefined), /^[0-9a-f-]{36}$/, "a request with no system and no turn still gets an id");
});

test("cliArgs switch off everything of Claude Code's own and hand over the files", () => {
  const args = cliArgs({ model: "claude-opus-5-5", systemFile: "/t/system.md", mcpFile: "/t/mcp.json", settingsFile: "/t/settings.json", sessionId: "sid" });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes("-p"));
  assert.equal(after("--model"), "claude-opus-5-5");
  assert.equal(after("--max-turns"), "1");
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--tools"), "", "none of Claude Code's own tools");
  assert.equal(after("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(after("--input-format"), "stream-json");
  assert.equal(after("--output-format"), "stream-json");
  assert.equal(after("--system-prompt-file"), "/t/system.md");
  assert.equal(after("--mcp-config"), "/t/mcp.json");
  assert.equal(after("--session-id"), "sid");
  assert.equal(after("--settings"), "/t/settings.json");
  assert.ok(!args.includes("--effort"), "with --effort Claude Code hands the whole reply over at the end");
  assert.ok(!cliArgs({ model: "m", systemFile: "s", mcpFile: "m", sessionId: "i" }).includes("--settings"));
});

test("a run is named for what it is", () => {
  assert.deepEqual(CALLER, { CLAUDE_CODE_ENTRYPOINT: "botkins", CLAUDE_CODE_DISABLE_ARTIFACT: "1" });
});

// ---- Claude: one run of the program ----

const BODY = {
  model: "claude-test",
  system: [{ type: "text", text: "Be brief." }, { type: "text", text: "Use the tools." }],
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "lookup", description: "Looks something up.", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
};

/** A run of claudeTurn against the stand-in, with a real tool bridge. */
function session(t, mode, extra = {}) {
  const bridge = new ToolBridge();
  t.after(() => bridge.stop());
  const dir = mkdtempSync(join(root, "run-"));
  const logFile = join(dir, "log.json");
  const events = [];
  const options = {
    file: "claude",
    env: { PATH: process.env.PATH, FAKE_CLAUDE: mode, FAKE_CLAUDE_LOG: logFile, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_EXTRA_BODY: '{"x":1}', CLAUDE_CODE_EFFORT_LEVEL: "max" },
    cwd: join(dir, "cwd"),
    bridge,
    emit: (event) => events.push(event),
    launch,
    idleMs: 10_000,
    ...extra,
  };
  return { bridge, options, events, logFile, log: () => JSON.parse(readFileSync(logFile, "utf8")), turn: (body = BODY) => claudeTurn(body, options) };
}
const failsWith = (status, type) => (error) => error instanceof PlanError && error.status === status && (!type || error.type === type);

test("a text reply comes back as Anthropic stream events, in order", async (t) => {
  const run = session(t, "text");
  await run.turn();
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(run.events[2].delta.text, "Hello");
  assert.equal(run.events[4].delta.stop_reason, "end_turn");
});

test("a tool reply names the tool as the runtime knows it, without the prefix", async (t) => {
  const run = session(t, "tool");
  await run.turn();
  const start = run.events.find((event) => event.type === "content_block_start");
  assert.equal(start.content_block.type, "tool_use");
  assert.equal(start.content_block.name, "lookup");
  assert.equal(start.content_block.id, "toolu_fake", "the rest of the block is as it came");
  assert.deepEqual(
    run.events.filter((event) => event.type === "content_block_delta").map((event) => event.delta.partial_json),
    ['{"que', 'ry":"x', '"}'],
  );
  assert.equal(run.events.at(-2).delta.stop_reason, "tool_use");
});

test("the program is told the conversation, the system prompt and the tools", async (t) => {
  const run = session(t, "text");
  await run.turn({ ...BODY, output_config: { effort: "high" }, thinking: { type: "adaptive", display: "summarized" }, max_tokens: 64000 });
  const log = run.log();
  assert.equal(log.systemPrompt, "Be brief.\n\nUse the tools.", "the system text is joined into the one file");
  assert.deepEqual(log.frames, frames(BODY.messages));
  assert.equal(log.argv[log.argv.indexOf("--session-id") + 1], sessionIdFor("Be brief.\n\nUse the tools.", frames(BODY.messages)[0]));
  assert.ok(!log.argv.includes("--effort"));
  assert.equal(log.env.CLAUDE_CODE_EFFORT_LEVEL, "high", "the thinking level asked for, over the one left in the environment");
  assert.equal(log.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000", "the reply room the runtime asked for");
  // What else the request asked for travels in a settings file, as extra fields for Claude Code's own request.
  const extra = JSON.parse(log.settings.env.CLAUDE_CODE_EXTRA_BODY);
  assert.deepEqual(extra.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(extra.output_config, { effort: "high" });
  assert.equal(extra.max_tokens, 64000);
  assert.deepEqual(extra.tools, [{ name: "mcp__botkins__lookup", description: "Looks something up.", input_schema: { type: "object", properties: { query: { type: "string" } } } }]);
  assert.equal(log.argv[log.argv.indexOf("--model") + 1], "claude-test");
  // The tool server in the config is the bridge's, with its one-time secret in a header.
  assert.deepEqual(Object.keys(log.mcpConfig.mcpServers), ["botkins"]);
  const server = log.mcpConfig.mcpServers.botkins;
  assert.equal(server.type, "http");
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{24}$/);
  assert.match(server.headers.Authorization, /^Bearer .{20,}$/);
  assert.ok(!log.argv.some((arg) => arg.includes(server.headers.Authorization.slice(7))), "the secret is not on the command line");
});

test("the tool server lists the runtime's tools to the program, and refuses to run one", async (t) => {
  const run = session(t, "text");
  await run.turn({ ...BODY, tools: [...BODY.tools, { name: "no-schema" }] });
  const log = run.log();
  assert.deepEqual(log.tools, ["lookup"]);
  assert.equal(log.toolCall.isError, true);
  assert.match(log.toolCall.content[0].text, /Denied/);
  assert.equal(run.bridge.endpoints.size, 0, "the address is closed when the run is over");
});

test("a request without tools gives the program an empty tool list", async (t) => {
  const run = session(t, "text", { bridge: undefined });
  await run.turn({ ...BODY, tools: undefined });
  assert.deepEqual(run.log().mcpConfig, { mcpServers: {} });
});

test("a conversation with earlier turns is replayed, each replayed turn waiting for its acknowledgement", async (t) => {
  const run = session(t, "text");
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second" },
  ];
  await run.turn({ ...BODY, messages });
  const log = run.log();
  const sent = frames(messages);
  assert.deepEqual(log.frames, [{ ...sent[0], shouldQuery: false }, sent[1], sent[2]]);
  assert.equal(log.frames[2].shouldQuery, undefined, "only the last turn is asked to be answered");
  // The stand-in holds its acknowledgement back for a moment; the next frame must not come before it.
  assert.ok(log.ackTimes[0] - log.frameTimes[0] >= 50);
  assert.ok(log.frameTimes[1] >= log.ackTimes[0], "nothing was sent before the acknowledgement");
  assert.equal(run.events.at(-1).type, "message_stop");
});

test("the program is named for Botkins whatever name the surrounding environment gave it", async (t) => {
  const run = session(t, "text");
  await run.turn();
  const { env } = run.log();
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "botkins");
  assert.equal(env.CLAUDE_CODE_DISABLE_ARTIFACT, "1");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0", "the runtime owns retries");
  assert.equal(env.CLAUDE_CODE_EXTRA_BODY, null, "an extra request body left in the environment is dropped");
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, null, "and so is a thinking level nobody asked this run for");
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, null);
});

test("the caller is told the reply is whole at once, and then what Claude Code said of its models", async (t) => {
  const order = [];
  const run = session(t, "text", { ended: () => order.push("ended"), report: (usage) => order.push(usage) });
  run.options.emit = (event) => event.type === "message_stop" && order.push("stop");
  await run.turn();
  assert.deepEqual(order, ["stop", "ended", { "claude-fake": { inputTokens: 3, outputTokens: 2, contextWindow: 1000000, maxOutputTokens: 128000 } }]);
});

test("a run that never says what it used ends the request all the same, and soon", async (t) => {
  for (const [when, reportMs] of [["none", 4000], ["late", 150]]) {
    const reports = [];
    const run = session(t, "text", { report: (usage) => reports.push(usage), reportMs });
    run.options.env.FAKE_CLAUDE_RESULT = when;
    const began = Date.now();
    await run.turn();
    assert.deepEqual(reports, [], when);
    assert.ok(Date.now() - began < 2500, when + ": the wait for a report is short");
    await until(() => !alive(run.log().pid));
  }
});

// ---- Claude: runs that wait for a request ----

/** A pool whose runs are the stand-in, ended when the test is over. `started` lists every start. */
function waitingRuns(t, options = {}) {
  const started = [];
  const pool = new ClaudePool({
    // The stand-in has no startup to wait out.
    settleMs: 0,
    launch: (file, args, opts) => {
      const child = launch(file, args, opts);
      started.push({ file, args, cwd: opts.cwd, env: opts.env, child });
      return child;
    },
    ...options,
  });
  t.after(() => pool.stop());
  return { pool, started };
}

test("a waiting run is started with no request in it: no files, only the model and the switches", (t) => {
  const { pool, started } = waitingRuns(t);
  const where = { file: "claude", env: { PATH: process.env.PATH, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_EXTRA_BODY: "{}" }, cwd: join(mkdtempSync(join(root, "pool-")), "cwd") };
  pool.ensure({ ...where, model: "claude-test" });
  assert.equal(started.length, 2, "two wait, so one has finished starting when a second request follows at once");
  const { args, env, cwd } = started[0];
  // It keeps Claude Code's own log, in a folder of the pool's, which is how its startup is known to be over.
  const logFile = args[args.indexOf("--debug-file") + 1];
  assert.deepEqual(args, cliArgs({ model: "claude-test", logFile }));
  assert.equal(dirname(logFile), pool.logs);
  assert.notEqual(logFile, started[1].args.at(-1), "each run has a log of its own");
  for (const flag of ["--system-prompt-file", "--mcp-config", "--session-id", "--settings"]) assert.ok(!args.includes(flag), flag);
  for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence", "--include-partial-messages"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  assert.equal(cwd, where.cwd);
  assert.ok(existsSync(where.cwd), "its folder is made");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "botkins");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.ok(!("CLAUDE_CODE_EXTRA_BODY" in env), "nothing left over from whatever started Botkins");
  pool.ensure({ ...where, model: "claude-test" });
  assert.equal(started.length, 2, "asking again starts no more than wait already");
});

test("the run that has waited longest is taken, and only for the same program and sign-in", async (t) => {
  const { pool, started } = waitingRuns(t);
  const where = { file: "claude", env: { PATH: process.env.PATH }, cwd: mkdtempSync(join(root, "pool-")) };
  assert.equal(pool.take(where), null, "none waits yet");
  pool.ensure({ ...where, model: "m" });
  assert.equal(pool.take({ ...where, env: { ...where.env, ANTHROPIC_API_KEY: "other" } }), null, "another sign-in");
  assert.equal(pool.take({ ...where, file: "other-claude" }), null, "another program");
  const first = pool.take(where);
  assert.equal(first.child, started[0].child);
  assert.equal(first.model, "m");
  assert.equal(pool.take(where).child, started[1].child);
  assert.equal(pool.take(where), null);
  first.child.kill();
  started[1].child.kill();
});

test("a run that ended while it waited is not handed a request", async (t) => {
  const { pool, started } = waitingRuns(t, { size: 1 });
  const where = { file: "claude", env: { PATH: process.env.PATH }, cwd: mkdtempSync(join(root, "pool-")) };
  pool.ensure({ ...where, model: "m" });
  started[0].child.kill();
  await until(() => started[0].child.exitCode !== null || started[0].child.signalCode !== null);
  await until(() => pool.waiting.length === 0);
  assert.equal(pool.take(where), null);
  pool.ensure({ ...where, model: "m" });
  assert.equal(started.length, 2, "and another is started when asked");
});

test("waiting runs are ended when the program or sign-in changes, when asked, and after a quiet while", async (t) => {
  const { pool, started } = waitingRuns(t, { size: 1, idleMs: 150 });
  const where = { file: "claude", env: { PATH: process.env.PATH }, cwd: mkdtempSync(join(root, "pool-")) };
  const gone = (index) => until(() => started[index].child.exitCode !== null || started[index].child.signalCode !== null);
  pool.ensure({ ...where, model: "m" });
  pool.ensure({ ...where, env: { ...where.env, X: "1" }, model: "m" });
  await gone(0);
  assert.equal(started.length, 2, "one for the new environment");
  await gone(1);
  assert.equal(pool.waiting.length, 0, "no request came for a while: nothing is left waiting");
  pool.ensure({ ...where, model: "m" });
  pool.stop();
  await gone(2);
  new ClaudePool({ size: 0, launch: () => assert.fail("a pool of none starts nothing") }).ensure({ ...where, model: "m" });
});

/** claudeTurn with a pool: every start is recorded, and the stand-in's log is the run that answered. */
function pooled(t, mode = "text", extra = {}) {
  const run = session(t, mode, extra);
  const { pool, started } = waitingRuns(t);
  run.options.pool = pool;
  run.options.launch = (file, args, opts) => {
    const child = launch(file, args, opts);
    started.push({ file, args, cwd: opts.cwd, env: opts.env, child });
    return child;
  };
  return { ...run, pool, started };
}

test("a request is handed to a run that waits, started then when none did, and another takes its place", async (t) => {
  const run = pooled(t);
  await run.turn();
  assert.equal(run.started.length, 3, "two were started to wait, and one more in place of the one that answered");
  assert.ok(!run.log().argv.includes("--system-prompt-file"), "even the first request is answered by a run that waited, never one started with the request in it");
  run.events.length = 0;
  await run.turn({ ...BODY, output_config: { effort: "high" }, thinking: { type: "adaptive", display: "summarized" }, max_tokens: 64000 });
  const log = run.log();
  assert.ok(!log.argv.includes("--system-prompt-file"), "this run was waiting: it has no files");
  assert.deepEqual(log.controls.map((request) => request.subtype), ["initialize", "mcp_set_servers", "apply_flag_settings"]);
  assert.equal(log.systemPrompt, "Be brief.\n\nUse the tools.", "the system prompt, told by control message");
  assert.deepEqual(log.controls[0].systemPrompt, ["Be brief.\n\nUse the tools."]);
  const server = log.mcpConfig.mcpServers.botkins;
  assert.equal(server.type, "http");
  assert.match(server.headers.Authorization, /^Bearer .{20,}$/);
  assert.deepEqual(log.tools, ["lookup"], "the tool server it was told of lists the runtime's tools");
  const env = log.settings.env;
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "high");
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
  const extra = JSON.parse(env.CLAUDE_CODE_EXTRA_BODY);
  assert.deepEqual(extra.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(extra.tools[0].name, "mcp__botkins__lookup");
  assert.deepEqual(log.frames, frames(BODY.messages));
  assert.deepEqual(run.events.map((event) => event.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(run.started.length, 4, "and another was started in its place");
  await until(() => !alive(log.pid), 5000);
  assert.equal(run.pool.waiting.length, 2);
});

test("a waiting run is told the model only when the request names another", async (t) => {
  const run = pooled(t);
  await run.turn();
  await run.turn();
  assert.ok(!run.log().controls.some((request) => request.subtype === "set_model"), "it was started for this model");
  await run.turn({ ...BODY, model: "claude-other" });
  assert.deepEqual(run.log().controls.at(-1), { subtype: "set_model", model: "claude-other" });
});

test("a request without tools tells a waiting run of no tool server, and a tool reply is named as the runtime knows it", async (t) => {
  const plain = pooled(t);
  await plain.turn({ ...BODY, tools: undefined });
  await plain.turn({ ...BODY, tools: undefined });
  assert.deepEqual(plain.log().controls.map((request) => request.subtype), ["initialize", "apply_flag_settings"]);
  const tool = pooled(t, "tool");
  await tool.turn();
  tool.events.length = 0;
  await tool.turn();
  assert.ok(tool.log().controls.length > 0);
  assert.equal(tool.events.find((event) => event.type === "content_block_start").content_block.name, "lookup");
});

test("a waiting run that refuses or doesn't answer is ended, and the request gets a run of its own", async (t) => {
  for (const how of ["refuse", "silent"]) {
    const run = pooled(t, "text", { handoverMs: 400 });
    await run.turn();
    // The runs that wait now were started with this in their environment.
    run.pool.stop();
    run.options.env.FAKE_CLAUDE_CONTROL = how;
    run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
    const before = run.started.length;
    run.events.length = 0;
    await run.turn();
    assert.ok(run.log().argv.includes("--system-prompt-file"), how + ": answered by a run started for the request");
    assert.equal(run.events.at(-1).type, "message_stop", how);
    const taken = run.started[before - 2].child;
    await until(() => taken.exitCode !== null || taken.signalCode !== null);
  }
});

test("Claude Code's own log says when its startup is over", () => {
  const silent = "t [DEBUG] [fs.watch probe] verdict: silent\nt [WARN] [settings] native file watching is not delivering events on this host (fs_watch_silent); polling settings files every 2000ms instead\n";
  assert.equal(startedUp(""), false, "nothing said yet");
  assert.equal(startedUp("t [DEBUG] [STARTUP] Loading MCP configs...\n"), false);
  assert.equal(startedUp(silent), false, "it has only said that it will switch: the switch is what blocks it");
  assert.equal(startedUp(silent + "t [DEBUG] Polling for /x/.claude to appear every 2000ms\nt [DEBUG] Watching for changes in setting files /x/settings.json... (polling every 2000ms)\n"), true);
  assert.equal(startedUp("t [DEBUG] Watching for changes in setting files /x/settings.json...\n"), false, "the first watch, before the verdict, is not the sign");
  assert.equal(startedUp("t [DEBUG] [fs.watch probe] verdict: ok\n"), true, "any other verdict means there is nothing to switch");
});

test("a request waits for a run that is still starting, and is handed over once the run's log says it is done", async (t) => {
  const run = pooled(t);
  run.pool.settleMs = 10_000;
  run.options.env.FAKE_CLAUDE_STARTUP = "silent:600";
  const began = Date.now();
  await run.turn();
  const log = run.log();
  assert.ok(log.controls.length > 0, "it was handed to the waiting run");
  assert.ok(log.frameTimes[0] - began >= 550, "not before the run had finished starting: " + (log.frameTimes[0] - began));
  assert.ok(log.frameTimes[0] - began < 5000, "and not held for the longest time allowed");
  // A run whose log says at once that there is nothing to wait for is handed the request at once.
  run.pool.stop();
  run.options.env.FAKE_CLAUDE_STARTUP = "ok";
  run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
  await until(() => run.pool.waiting.every((each) => run.pool.settled(each)), 3000);
  const again = Date.now();
  await run.turn();
  assert.ok(run.log().frameTimes[0] - again < 1500);
});

test("a request doesn't wait out a whole startup: with no run ready soon it gets a run of its own, and the waiting ones stay", async (t) => {
  const run = pooled(t);
  run.pool.settleMs = 60_000;
  run.pool.graceMs = 300;
  run.options.env.FAKE_CLAUDE_STARTUP = "silent:8000";
  const began = Date.now();
  await run.turn();
  assert.ok(run.log().argv.includes("--system-prompt-file"), "answered by a run started for the request");
  assert.ok(Date.now() - began < 4000, "after a short wait, not a whole startup");
  assert.equal(run.pool.waiting.length, 2, "the runs that are still starting keep waiting for a later request");
  assert.equal(run.events.at(-1).type, "message_stop");
});

test("a run that has finished starting is taken before one that hasn't, and a run's log goes when the run does", async (t) => {
  const { pool, started } = waitingRuns(t, { settleMs: 10_000 });
  const cwd = mkdtempSync(join(root, "pool-"));
  const slow = { file: "claude", env: { PATH: process.env.PATH, FAKE_CLAUDE_STARTUP: "silent:5000" }, cwd };
  pool.size = 1;
  pool.ensure({ ...slow, model: "m" });
  // The second is started with a startup that is over at once. Both count as the same program and sign-in.
  pool.size = 2;
  const launch = pool.launch;
  pool.launch = (file, args, opts) => launch(file, args, { ...opts, env: { ...opts.env, FAKE_CLAUDE_STARTUP: "ok" } });
  pool.ensure({ ...slow, model: "m" });
  await until(() => pool.settled(pool.waiting[1]), 3000);
  assert.equal(pool.settled(pool.waiting[0]), false);
  const logs = pool.waiting.map((each) => each.logFile);
  assert.ok(existsSync(logs[1]));
  const taken = pool.take(slow);
  assert.equal(taken.child, started[1].child, "the one that is ready, though it started later");
  taken.child.kill();
  await until(() => !existsSync(logs[1]));
  const folder = pool.logs;
  pool.stop();
  await until(() => !existsSync(folder));
});

test("a run that only just started is given its startup time before a request is handed to it", async (t) => {
  const run = pooled(t);
  await run.turn();
  run.pool.stop();
  run.pool.settleMs = 700;
  run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
  const born = run.pool.waiting[0].born;
  await run.turn();
  const log = run.log();
  assert.ok(log.controls.length > 0, "it was handed to the waiting run");
  assert.ok(log.frameTimes[0] - born >= 690, "and not before the run had waited its time: " + (log.frameTimes[0] - born));
  // One that has waited long enough is handed the request at once.
  await new Promise((resolve) => setTimeout(resolve, 750));
  const began = Date.now();
  await run.turn();
  assert.ok(run.log().frameTimes[0] - began < 600);
});

test("a request cancelled while it is handed over ends the waiting run", async (t) => {
  const run = pooled(t, "text", { handoverMs: 5000 });
  await run.turn();
  run.pool.stop();
  run.options.env.FAKE_CLAUDE_CONTROL = "silent";
  run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
  const taken = run.started.at(-2).child;
  const gone = new AbortController();
  run.options.signal = gone.signal;
  const turn = run.turn();
  setTimeout(() => gone.abort(), 100);
  await assert.rejects(turn, failsWith(499));
  await until(() => taken.exitCode !== null || taken.signalCode !== null);
});

test("without a report to make, the run is over at the reply's end", async (t) => {
  const run = session(t, "text");
  run.options.env.FAKE_CLAUDE_RESULT = "late";
  const began = Date.now();
  await run.turn();
  assert.ok(Date.now() - began < 2500);
});

test("the temporary files are gone after a reply and after a failure", async (t) => {
  const done = session(t, "text");
  await done.turn();
  const failed = session(t, "auth");
  await assert.rejects(failed.turn(), failsWith(401));
  for (const run of [done, failed]) {
    const log = run.log();
    assert.ok(log.systemFile && log.mcpFile);
    assert.ok(!existsSync(log.systemFile), "the system prompt file");
    assert.ok(!existsSync(log.mcpFile), "the tool server config");
    assert.ok(!existsSync(dirname(log.systemFile)), "the folder they were in");
  }
  for (const run of [done, failed]) await until(() => !alive(run.log().pid));
});

test("a program that is not signed in is a 401 with Anthropic's kind of error", async (t) => {
  const run = session(t, "auth");
  await assert.rejects(run.turn(), (error) => failsWith(401, "authentication_error")(error) && /isn't signed in/.test(error.message));
  assert.deepEqual(run.events, [], "nothing was passed on");
});

test("a result that is only an error is a 500 that says what Claude Code said", async (t) => {
  const run = session(t, "failed");
  await assert.rejects(run.turn(), (error) => failsWith(500, "api_error")(error) && error.message === "The model said no.");
});

test("a program that stops before it answers is a 500, and one that stops in the middle of a reply is too", async (t) => {
  await assert.rejects(session(t, "crash").turn(), (error) => failsWith(500, "api_error")(error) && /stopped before it answered/.test(error.message));
  const cut = session(t, "cut");
  await assert.rejects(cut.turn(), (error) => failsWith(500, "api_error")(error) && /in the middle of its reply/.test(error.message));
  assert.equal(cut.events.length, 3, "what was said before it stopped was passed on");
});

test("a program that says nothing for too long is a 504, and is stopped", async (t) => {
  let child;
  const run = session(t, "silent", { idleMs: 200, launch: (...args) => (child = launch(...args)) });
  await assert.rejects(run.turn(), failsWith(504, "api_error"));
  // Even when the fixture times out before its first log write, the OS assigned its pid.
  assert.ok(child.pid);
  await until(() => !alive(child.pid));
});

test("an aborted signal stops the program", async (t) => {
  const run = session(t, "silent");
  const controller = new AbortController();
  const pending = claudeTurn(BODY, { ...run.options, signal: controller.signal });
  // Caught if it fails before the abort, so that nothing is left unhandled while the log is awaited.
  const outcome = pending.then(() => null, (error) => error);
  const pid = await until(() => existsSync(run.logFile) && run.log().pid);
  assert.ok(alive(pid));
  controller.abort();
  const error = await outcome;
  assert.ok(failsWith(499)(error), "the request was cancelled");
  await until(() => !alive(pid));
});

test("claudeTurn refuses when it has no program, no model, or no conversation to answer", async (t) => {
  const run = session(t, "text");
  await assert.rejects(claudeTurn(BODY, { ...run.options, file: null }), (error) => failsWith(503, "api_error")(error) && /isn't installed/.test(error.message));
  await assert.rejects(claudeTurn(BODY, { ...run.options, file: "" }), failsWith(503));
  await assert.rejects(claudeTurn({ ...BODY, model: "" }, run.options), failsWith(400, "invalid_request_error"));
  await assert.rejects(claudeTurn({ ...BODY, messages: [{ role: "assistant", content: "x" }] }, run.options), failsWith(400));
  assert.ok(!existsSync(run.logFile), "nothing was started");
});

test("a program that cannot be started is a 503", async (t) => {
  const run = session(t, "text", { launch: (_file, _args, options) => spawn(join(root, "no-such-program"), [], options) });
  await assert.rejects(run.turn(), (error) => failsWith(503, "api_error")(error) && /isn't installed/.test(error.message));
});

// ---- Claude: a reply put together ----

test("assemble puts a text reply's events into one message", () => {
  const whole = assemble();
  assert.equal(whole.message(), null, "nothing yet");
  for (const event of [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ])
    whole.take(event);
  assert.deepEqual(whole.message(), {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  });
});

test("assemble reads a tool call's input from its streamed pieces", () => {
  const whole = assemble();
  for (const event of [
    { type: "message_start", message: { id: "msg_2", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hm." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"que' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ry":"x"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "ping", input: {} } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ])
    whole.take(event);
  const message = whole.message();
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "Hm.", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "x" } },
    { type: "tool_use", id: "toolu_2", name: "ping", input: {} },
  ]);
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 1, output_tokens: 9 });
});

test("assemble over a real run gives the message the runtime would have streamed", async (t) => {
  const run = session(t, "tool");
  await run.turn();
  const whole = assemble();
  run.events.forEach((event) => whole.take(event));
  const message = whole.message();
  assert.deepEqual(message.content, [{ type: "tool_use", id: "toolu_fake", name: "lookup", input: { query: "x" } }]);
  assert.equal(message.stop_reason, "tool_use");
});

// ---- ChatGPT: the sign-in ----

/** A token the way a plan's sign-in has it: header and payload in base64url, any signature. */
const jwt = (payload) => ["eyJhbGciOiJub25lIn0", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

test("a ChatGPT plan's sign-in is read from Codex's auth file, with the end of the token from its exp claim", () => {
  const token = jwt({ exp: 1_900_000_000, sub: "u" });
  const paths = [];
  const read = (path, encoding) => (paths.push([path, encoding]), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: "acct_1", refresh_token: "r" } }));
  assert.deepEqual(chatgptSignIn({ home: "/codex-home", read }), { token, account: "acct_1", expiresAt: 1_900_000_000_000 });
  assert.deepEqual(paths, [[join("/codex-home", "auth.json"), "utf8"]]);
});

test("a sign-in without an account id or with a token that is not a JWT still works", () => {
  const read = (token, extra = {}) => () => JSON.stringify({ tokens: { access_token: token, ...extra } });
  assert.equal(chatgptSignIn({ home: "/h", read: read(jwt({ exp: 5 })) }).account, "");
  assert.deepEqual(chatgptSignIn({ home: "/h", read: read("opaque", { account_id: 7 }) }), { token: "opaque", account: "", expiresAt: 0 });
  assert.equal(chatgptSignIn({ home: "/h", read: read(jwt({ sub: "no exp" })) }).expiresAt, 0);
});

test("no auth file and an API-key-only auth file are both a 401, each with its own message", () => {
  const missing = (() => {
    try {
      chatgptSignIn({ home: "/h", read: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    } catch (error) {
      return error;
    }
  })();
  const apiKey = (() => {
    try {
      chatgptSignIn({ home: "/h", read: () => JSON.stringify({ OPENAI_API_KEY: "sk-test" }) });
    } catch (error) {
      return error;
    }
  })();
  for (const error of [missing, apiKey]) {
    assert.ok(error instanceof PlanError);
    assert.equal(error.status, 401);
    assert.equal(error.type, "authentication_error");
  }
  assert.match(missing.message, /isn't signed in/);
  assert.match(apiKey.message, /API key/);
  assert.notEqual(missing.message, apiKey.message);
  // A file that is not JSON is as good as none.
  assert.throws(() => chatgptSignIn({ home: "/h", read: () => "{" }), /isn't signed in/);
});

// ---- ChatGPT: the request ----

test("planRequest moves system messages into instructions, after any instructions already there", () => {
  const out = planRequest({
    model: "gpt-6-astra",
    instructions: "Base.",
    input: [
      { type: "message", role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { type: "message", role: "system", content: [{ type: "input_text", text: "Use " }, { type: "input_text", text: "tools." }] },
      { type: "message", role: "assistant", content: "ok" },
    ],
  });
  assert.equal(out.instructions, "Base.\n\nBe brief.\n\nUse tools.");
  assert.deepEqual(out.input, [{ role: "user", content: "hi" }, { type: "message", role: "assistant", content: "ok" }]);
  assert.equal(out.model, "gpt-6-astra", "the rest of the request is as it was");
});

test("planRequest makes the request one that is not stored and does stream, whatever was asked", () => {
  for (const asked of [{ store: true, stream: false }, {}, { store: true }, { stream: false }]) {
    const out = planRequest({ input: "hi", instructions: "Sys", ...asked });
    assert.equal(out.store, false);
    assert.equal(out.stream, true);
  }
});

test("planRequest refuses a request with no instructions, and never writes any itself", () => {
  const refused = (error) => error instanceof PlanError && error.status === 400 && error.type === "invalid_request_error" && /needs instructions/.test(error.message);
  assert.throws(() => planRequest({ input: [{ role: "user", content: "hi" }] }), refused);
  assert.throws(() => planRequest({ input: "hi" }), refused);
  assert.throws(() => planRequest({ input: [], instructions: "" }), refused);
  assert.equal(planRequest({ input: [{ role: "user", content: "hi" }], instructions: "Mine." }).instructions, "Mine.");
});

test("planRequest sends a function tool that doesn't say strict as not strict, and keeps what a tool does say", () => {
  const schema = { type: "object", properties: { q: { type: "string", format: "strip" } } };
  const out = planRequest({
    instructions: "Sys",
    input: "hi",
    tools: [{ type: "function", name: "loose", parameters: schema }, { type: "function", name: "tight", strict: true, parameters: schema }, { type: "web_search" }],
  });
  assert.deepEqual(
    out.tools.map((tool) => tool.strict),
    [false, true, undefined],
  );
  assert.deepEqual(out.tools[0].parameters, schema, "the schema is sent as it was");
});

test("planRequest does not change the object it was given", () => {
  const body = { store: true, stream: false, instructions: "Base.", input: [{ type: "message", role: "system", content: "S" }, { role: "user", content: "hi" }], tools: [{ type: "function", name: "t", parameters: {} }] };
  const before = structuredClone(body);
  planRequest(body);
  assert.deepEqual(body, before);
});

// ---- ChatGPT: the stream's last event ----

const sse = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
const message = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
/** A Responses stream. `output` is what its last event says the output is. */
const stream = (output = [], extra = {}) =>
  [
    sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }),
    ": keep-alive\n\n",
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message("one") }),
    sse("response.output_text.delta", { type: "response.output_text.delta", delta: "tw" }),
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: message("two") }),
    sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output, usage: { input_tokens: 1, output_tokens: 2 }, ...extra } }),
  ].join("");

/** Runs text through completeOutput, cut into pieces at the given byte positions. */
async function through(text, cuts = [], seen) {
  const fix = completeOutput(seen);
  let out = "";
  fix.on("data", (chunk) => (out += chunk.toString("utf8")));
  const finished = new Promise((resolve, reject) => fix.on("end", resolve).on("error", reject));
  const bytes = Buffer.from(text);
  let at = 0;
  for (const cut of [...cuts, bytes.length]) {
    fix.write(bytes.subarray(at, cut));
    at = cut;
  }
  fix.end();
  await finished;
  return out;
}
const filled = stream([message("one"), message("two")]);

test("completeOutput fills the last event's empty output from the items that went by", async () => {
  const seen = [];
  const out = await through(stream(), [], (whole) => seen.push(whole));
  assert.equal(out, filled, "the last event now has the items; every other event is as it was");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "resp_1");
  assert.deepEqual(seen[0].output, [message("one"), message("two")], "told the finished response");
});

test("completeOutput fills an output the last event does not have at all", async () => {
  const body = stream(undefined).replace('"output":[],"usage"', '"usage"').replace(/"output":\[\]\}\}\n\n$/, "}}\n\n");
  assert.ok(!/response\.completed[^]*"output"/.test(body), "the stand-in event has no output");
  const out = await through(body);
  const last = JSON.parse(out.split("\n\n").filter(Boolean).at(-1).split("\ndata: ")[1]);
  assert.deepEqual(last.response.output, [message("one"), message("two")]);
});

test("completeOutput gives the same result wherever the chunks are cut (line endings of \\n)", async () => {
  const bytes = Buffer.byteLength(stream());
  // One cut at every byte: mid-line, mid-event, and between the two newlines that end an event.
  for (let cut = 1; cut < bytes; cut++) assert.equal(await through(stream(), [cut]), filled, "cut at " + cut);
  // And a byte at a time.
  assert.equal(await through(stream(), Array.from({ length: bytes - 1 }, (_, i) => i + 1)), filled);
});

test("completeOutput reads \\r\\n line endings wherever the chunks are cut, and passes every one on as \\n", async () => {
  const text = stream().replace(/\n/g, "\r\n");
  const bytes = Buffer.byteLength(text);
  // Every cut, also between the two halves of a line ending and inside the blank line that ends an event.
  for (let cut = 1; cut < bytes; cut++) assert.equal(await through(text, [cut]), filled, "cut at " + cut);
  assert.equal(await through(text, Array.from({ length: bytes - 1 }, (_, i) => i + 1)), filled, "a byte at a time");
  assert.equal(await through(text), filled, "in one piece");
});

test("completeOutput keeps a character whole when a chunk ends in the middle of it", async () => {
  // Replies are rarely plain ASCII, and the stream is cut wherever the network cuts it.
  const say = (output) =>
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message("héllo 😀 日本") }) +
    sse("response.completed", { type: "response.completed", response: { id: "resp_2", status: "completed", output } });
  const whole = say([message("héllo 😀 日本")]);
  const bytes = Buffer.byteLength(say([]));
  for (let cut = 1; cut < bytes; cut++) assert.equal(await through(say([]), [cut]), whole, "cut at byte " + cut);
  assert.equal(await through(say([]), Array.from({ length: bytes - 1 }, (_, i) => i + 1)), whole, "a byte at a time");
  assert.ok(!(await through(say([]), [40, 41, 42, 43])).includes("\ufffd"), "no character is replaced by a mark for a broken one");
});

test("completeOutput leaves a last event that already has its output as it is", async () => {
  const given = stream([message("final")]);
  const seen = [];
  assert.equal(await through(given, [], (whole) => seen.push(whole)), given);
  assert.deepEqual(seen.map((whole) => whole.output), [[message("final")]], "the caller still gets the response");
});

test("completeOutput passes on a last event that has no items to put in, and one that is not JSON", async () => {
  const bare = sse("response.created", { type: "response.created", response: { id: "r", output: [] } }) + sse("response.completed", { type: "response.completed", response: { id: "r", output: [] } });
  assert.equal(await through(bare), bare);
  const odd = "event: response.completed\ndata: not json\n\nevent: response.failed\ndata: {\"type\":\"response.failed\"}\n\n";
  assert.equal(await through(odd), odd);
});

test("completeOutput does not hold back an event that ends the stream without a blank line", async () => {
  const text = stream().slice(0, -2);
  assert.equal(await through(text), filled.slice(0, -2));
});

// ---- ChatGPT: one request ----

const ok = () => new Response("data", { status: 200 });

test("chatgptTurn posts the request to the plan's endpoint as Botkins", async () => {
  const calls = [];
  const answer = await chatgptTurn(
    { model: "gpt-6-astra", input: [{ type: "message", role: "system", content: "Sys" }, { role: "user", content: "hi" }], stream: false },
    { signIn: () => ({ token: "tok-1", account: "acct_9", expiresAt: Date.now() + 3_600_000 }), fetch: async (url, init) => (calls.push({ url, init }), ok()), version: "1.2.3" },
  );
  assert.equal(answer.status, 200);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, CHATGPT_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer tok-1");
  assert.equal(init.headers["chatgpt-account-id"], "acct_9");
  assert.equal(init.headers.originator, "botkins");
  assert.match(init.headers["user-agent"], /^Botkins/);
  assert.equal(init.headers["user-agent"], "Botkins/1.2.3");
  assert.equal(init.headers.accept, "text/event-stream");
  const sent = JSON.parse(init.body);
  assert.equal(sent.stream, true);
  assert.equal(sent.store, false);
  assert.equal(sent.instructions, "Sys");
  assert.deepEqual(sent.input, [{ role: "user", content: "hi" }]);
});

test("chatgptTurn sends no account header without an account, and no version without one", async () => {
  const calls = [];
  await chatgptTurn({ input: "hi", instructions: "Sys" }, { signIn: () => ({ token: "t", account: "", expiresAt: 0 }), fetch: async (url, init) => (calls.push({ url, init }), ok()), url: "http://stand-in.invalid/responses" });
  assert.equal(calls[0].url, "http://stand-in.invalid/responses");
  assert.ok(!("chatgpt-account-id" in calls[0].init.headers));
  assert.equal(calls[0].init.headers["user-agent"], "Botkins");
});

test("chatgptTurn renews a token that ends within five minutes before it sends anything", async () => {
  const state = { token: "old", expiresAt: Date.now() + 2 * 60_000 };
  const steps = [];
  const answer = await chatgptTurn(
    { input: "hi", instructions: "Sys" },
    {
      signIn: () => ({ token: state.token, account: "a", expiresAt: state.expiresAt }),
      renew: async () => {
        steps.push("renew");
        Object.assign(state, { token: "new", expiresAt: Date.now() + 3_600_000 });
      },
      fetch: async (_url, init) => (steps.push(init.headers.authorization), ok()),
    },
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(steps, ["renew", "Bearer new"]);
});

test("chatgptTurn leaves a token that lasts, or one that does not say, as it is", async () => {
  for (const expiresAt of [Date.now() + 10 * 60_000, 0]) {
    let renewed = 0;
    await chatgptTurn({ input: "hi", instructions: "Sys" }, { signIn: () => ({ token: "t", account: "a", expiresAt }), renew: async () => void renewed++, fetch: async () => ok() });
    assert.equal(renewed, 0, String(expiresAt));
  }
});

test("chatgptTurn renews once on a 401 and sends the request again with the new token", async () => {
  const state = { token: "old" };
  const seen = [];
  let renewed = 0;
  const answer = await chatgptTurn(
    { input: "hi", instructions: "Sys" },
    {
      signIn: () => ({ token: state.token, account: "a", expiresAt: 0 }),
      renew: async () => {
        renewed++;
        state.token = "new";
      },
      fetch: async (_url, init) => (seen.push(init.headers.authorization), seen.length === 1 ? new Response("expired", { status: 401 }) : ok()),
    },
  );
  assert.equal(answer.status, 200);
  assert.equal(renewed, 1);
  assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
});

test("chatgptTurn does not send again after a 401 when the token did not change", async () => {
  let sent = 0;
  const answer = await chatgptTurn({ input: "hi", instructions: "Sys" }, { signIn: () => ({ token: "same", account: "a", expiresAt: 0 }), renew: async () => { throw new Error("Codex is not running"); }, fetch: async () => (sent++, new Response("no", { status: 401 })) });
  assert.equal(sent, 1, "and a renewal that fails does not stop the answer being passed on");
  assert.equal(answer.status, 401);
});

// ---- The gateway, over real HTTP ----

/** One call to the gateway: { status, headers, text, json() }. */
const http = (base, path, { method = "POST", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = request(base + path, { method, headers: { ...(payload !== null && { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }), ...headers }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
/** An event stream's "event: <type>\ndata: <json>" blocks. */
const blocks = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [event, data] = block.split("\n");
      assert.match(event, /^event: /);
      assert.match(data, /^data: /);
      return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
    });

/**
 * A gateway on 127.0.0.1 with a stand-in plan behind each path.
 * @param options.answer  () => Response, what the ChatGPT plan says.
 * @param options.mode    what the Claude Code stand-in does (FAKE_CLAUDE).
 */
async function gateway(t, { answer = () => new Response(stream(), { status: 200, headers: { "content-type": "text/event-stream" } }), mode = "text", ...rest } = {}) {
  const dir = mkdtempSync(join(root, "gateway-"));
  const bridge = new ToolBridge();
  const upstream = [];
  const log = join(dir, "log.json");
  const server = new Gateway({
    chatgpt: { signIn: () => ({ token: "plan-token", account: "acct_1", expiresAt: 0 }), renew: async () => {} },
    claude: async () => ({ file: "claude", env: { PATH: process.env.PATH, FAKE_CLAUDE: mode, FAKE_CLAUDE_LOG: log }, cwd: join(dir, "cwd"), bridge }),
    version: "9.9",
    fetch: async (url, init) => (upstream.push({ url, init: { ...init, body: JSON.parse(init.body) } }), answer()),
    launch,
    // The stand-in has no startup to wait out.
    settleMs: 0,
    ...rest,
  });
  const base = await server.start();
  t.after(async () => {
    await server.stop();
    await bridge.stop();
  });
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  return { server, base, upstream, bearer: { authorization: "Bearer " + server.secret }, log: () => JSON.parse(readFileSync(log, "utf8")) };
}
const RESPONSES = { model: "gpt-6-astra", input: [{ type: "message", role: "system", content: "Sys" }, { role: "user", content: "hi" }] };
const MESSAGES = { model: "claude-test", system: "Be brief.", messages: [{ role: "user", content: "hi" }], tools: BODY.tools };

test("the gateway turns away a request without the secret, with an origin, or with the wrong method or path", async (t) => {
  const { base, bearer, upstream } = await gateway(t);
  assert.equal((await http(base, "/chatgpt/responses", { body: RESPONSES })).status, 401);
  assert.equal((await http(base, "/chatgpt/responses", { headers: { authorization: "Bearer not-it" }, body: RESPONSES })).status, 401);
  assert.equal((await http(base, "/chatgpt/responses", { headers: { authorization: "Bearer x" }, body: RESPONSES })).status, 401, "a secret of another length");
  assert.equal((await http(base, "/chatgpt/responses", { headers: { ...bearer, origin: "https://example.com" }, body: RESPONSES })).status, 403, "a web page, even with the secret");
  assert.equal((await http(base, "/chatgpt/responses", { method: "GET", headers: bearer })).status, 405);
  assert.equal((await http(base, "/chatgpt/responses", { method: "PUT", headers: bearer, body: RESPONSES })).status, 405);
  assert.equal((await http(base, "/nowhere", { headers: bearer, body: {} })).status, 404);
  assert.equal((await http(base, "/chatgpt/other", { headers: bearer, body: {} })).status, 404);
  assert.equal((await http(base, "/chatgpt/responses", { headers: bearer, body: "not json" })).status, 400);
  assert.deepEqual(upstream, [], "none of them reached the plan");
});

test("the gateway's refusals are OpenAI-shaped on /chatgpt and Anthropic-shaped on /claude", async (t) => {
  const { base } = await gateway(t);
  const openai = await http(base, "/chatgpt/responses", { body: RESPONSES });
  assert.equal(openai.status, 401);
  assert.deepEqual(openai.json(), { error: { message: "Unauthorized", type: "authentication_error", code: "authentication_error" } });
  const anthropic = await http(base, "/claude/v1/messages", { body: MESSAGES });
  assert.equal(anthropic.status, 401);
  assert.deepEqual(anthropic.json(), { type: "error", error: { type: "authentication_error", message: "Unauthorized" } });
  assert.match(anthropic.headers["content-type"], /^application\/json/);
});

test("the gateway answers 503 for a plan that is not set up", async (t) => {
  const { base, bearer } = await gateway(t, { chatgpt: null, claude: null });
  const openai = await http(base, "/chatgpt/responses", { headers: bearer, body: RESPONSES });
  assert.equal(openai.status, 503);
  assert.match(openai.json().error.message, /ChatGPT isn't set up/);
  const anthropic = await http(base, "/claude/v1/messages", { headers: bearer, body: MESSAGES });
  assert.equal(anthropic.status, 503);
  assert.equal(anthropic.json().type, "error");
  assert.match(anthropic.json().error.message, /Claude isn't set up/);
});

test("the gateway streams the ChatGPT plan's events with the last event filled in", async (t) => {
  const { base, bearer, upstream } = await gateway(t);
  const answer = await http(base, "/chatgpt/responses", { headers: bearer, body: RESPONSES });
  assert.equal(answer.status, 200);
  assert.match(answer.headers["content-type"], /^text\/event-stream/);
  assert.equal(answer.text, filled);
  // The plan was asked as Botkins, with the request evened out.
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].url, CHATGPT_URL);
  assert.equal(upstream[0].init.headers.authorization, "Bearer plan-token");
  assert.equal(upstream[0].init.headers.originator, "botkins");
  assert.equal(upstream[0].init.headers["user-agent"], "Botkins/9.9");
  assert.equal(upstream[0].init.body.instructions, "Sys");
  assert.equal(upstream[0].init.body.stream, true);
  assert.deepEqual(upstream[0].init.body.input, [{ role: "user", content: "hi" }]);
});

test("the gateway passes on an error from the ChatGPT plan with its status and its words", async (t) => {
  const words = JSON.stringify({ error: { message: "You've hit your usage limit.", type: "usage_limit_reached" } });
  const { base, bearer } = await gateway(t, { answer: () => new Response(words, { status: 429, headers: { "content-type": "application/json" } }) });
  const answer = await http(base, "/chatgpt/responses", { headers: bearer, body: RESPONSES });
  assert.equal(answer.status, 429);
  assert.match(answer.headers["content-type"], /^application\/json/);
  assert.equal(answer.text, words);
});

test("the gateway returns the finished response as JSON when the request says stream: false", async (t) => {
  const { base, bearer, upstream } = await gateway(t);
  const answer = await http(base, "/chatgpt/responses", { headers: bearer, body: { ...RESPONSES, stream: false } });
  assert.equal(answer.status, 200);
  assert.match(answer.headers["content-type"], /^application\/json/);
  const whole = answer.json();
  assert.equal(whole.id, "resp_1");
  assert.equal(whole.status, "completed");
  assert.deepEqual(whole.output, [message("one"), message("two")]);
  assert.equal(upstream[0].init.body.stream, true, "the plan always streams; the gateway reads it to the end");
});

test("the gateway says so when the ChatGPT plan's stream ends before its last event", async (t) => {
  const { base, bearer } = await gateway(t, { answer: () => new Response(stream().split("event: response.completed")[0], { status: 200 }) });
  const answer = await http(base, "/chatgpt/responses", { headers: bearer, body: { ...RESPONSES, stream: false } });
  assert.equal(answer.status, 502);
  assert.match(answer.json().error.message, /ended early/);
});

test("the gateway streams a Claude reply as Anthropic's event blocks", async (t) => {
  const { base, bearer, log } = await gateway(t);
  const answer = await http(base, "/claude/v1/messages", { headers: bearer, body: MESSAGES });
  assert.equal(answer.status, 200);
  assert.match(answer.headers["content-type"], /^text\/event-stream/);
  assert.match(answer.text, /^event: message_start\ndata: \{"type":"message_start"/);
  const parts = blocks(answer.text);
  assert.deepEqual(
    parts.map((part) => part.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  for (const part of parts) assert.equal(part.data.type, part.event, "the event's name is its type");
  assert.equal(parts[2].data.delta.text, "Hello");
  assert.equal(log().systemPrompt, "Be brief.", "a system prompt given as a plain string");
});

test("the gateway starts Claude Code waiting when asked, answers with a run that waits, and ends them when it stops", async (t) => {
  const { server, base, bearer, log } = await gateway(t);
  assert.equal(server.pool.waiting.length, 0, "nothing waits until a Claude chat opens");
  await server.warm("claude-test");
  assert.equal(server.pool.waiting.length, 2);
  const pids = server.pool.waiting.map((run) => run.child.pid);
  const answer = await http(base, "/claude/v1/messages", { headers: bearer, body: MESSAGES });
  assert.equal(answer.status, 200);
  assert.deepEqual(blocks(answer.text).map((part) => part.event), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(log().pid, pids[0], "the run that had waited longest answered");
  assert.deepEqual(log().controls.map((request) => request.subtype), ["initialize", "mcp_set_servers", "apply_flag_settings"]);
  assert.equal(log().systemPrompt, "Be brief.");
  assert.equal(server.pool.waiting.length, 2, "and another waits in its place");
  const waiting = server.pool.waiting.map((run) => run.child.pid);
  await server.stop();
  for (const pid of waiting) await until(() => !alive(pid));
});

test("a gateway told to keep no runs waiting starts one for each request, and one without a Claude plan keeps none", async (t) => {
  const { server, base, bearer, log } = await gateway(t, { waiting: 0 });
  assert.equal(server.pool, null);
  await server.warm("claude-test");
  assert.equal((await http(base, "/claude/v1/messages", { headers: bearer, body: MESSAGES })).status, 200);
  assert.ok(log().argv.includes("--system-prompt-file"));
  assert.equal(new Gateway({ chatgpt: { signIn: () => ({}) } }).pool, null);
});

test("the gateway names a Claude tool call without the prefix", async (t) => {
  const { base, bearer } = await gateway(t, { mode: "tool" });
  const parts = blocks((await http(base, "/claude/v1/messages", { headers: bearer, body: MESSAGES })).text);
  assert.equal(parts.find((part) => part.event === "content_block_start").data.content_block.name, "lookup");
});

test("a failure before the Claude reply began is an Anthropic-style error with the failure's own status", async (t) => {
  const auth = await gateway(t, { mode: "auth" });
  const signedOut = await http(auth.base, "/claude/v1/messages", { headers: auth.bearer, body: MESSAGES });
  assert.equal(signedOut.status, 401);
  assert.match(signedOut.headers["content-type"], /^application\/json/);
  const body = signedOut.json();
  assert.deepEqual(Object.keys(body), ["type", "error"]);
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "authentication_error");
  assert.match(body.error.message, /isn't signed in/);

  const failed = await gateway(t, { mode: "failed" });
  const other = await http(failed.base, "/claude/v1/messages", { headers: failed.bearer, body: MESSAGES });
  assert.equal(other.status, 500);
  assert.deepEqual(other.json(), { type: "error", error: { type: "api_error", message: "The model said no." } });

  // Out of extra usage is a billing error, which a harness doesn't retry.
  const extra = await gateway(t, { mode: "extra" });
  const billed = await http(extra.base, "/claude/v1/messages", { headers: extra.bearer, body: MESSAGES });
  assert.equal(billed.status, 402);
  assert.equal(billed.json().error.type, "billing_error");
  assert.match(billed.json().error.message, /out of extra usage/);

  const nothing = await http(failed.base, "/claude/v1/messages", { headers: failed.bearer, body: { ...MESSAGES, model: undefined } });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.json().error.type, "invalid_request_error");
});

test("a failure after the Claude reply began ends the stream with an error event", async (t) => {
  const { base, bearer } = await gateway(t, { mode: "cut" });
  const answer = await http(base, "/claude/v1/messages", { headers: bearer, body: MESSAGES });
  assert.equal(answer.status, 200, "the status was sent with the first event");
  const parts = blocks(answer.text);
  assert.deepEqual(parts.map((part) => part.event), ["message_start", "content_block_start", "content_block_delta", "error"]);
  assert.equal(parts.at(-1).data.type, "error");
  assert.equal(parts.at(-1).data.error.type, "api_error");
  assert.match(parts.at(-1).data.error.message, /in the middle of its reply/);
});

test("the gateway returns one assembled Claude message when the request says stream: false", async (t) => {
  const { base, bearer } = await gateway(t);
  const answer = await http(base, "/claude/v1/messages", { headers: bearer, body: { ...MESSAGES, stream: false } });
  assert.equal(answer.status, 200);
  assert.match(answer.headers["content-type"], /^application\/json/);
  assert.deepEqual(answer.json(), {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-fake",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  });
});

test("the gateway takes its secret as a bearer token and as x-api-key", async (t) => {
  const { server, base } = await gateway(t);
  const bearer = await http(base, "/claude/v1/messages", { headers: { authorization: "Bearer " + server.secret }, body: { ...MESSAGES, stream: false } });
  const key = await http(base, "/claude/v1/messages", { headers: { "x-api-key": server.secret }, body: { ...MESSAGES, stream: false } });
  assert.equal(bearer.status, 200);
  assert.equal(key.status, 200);
  assert.equal((await http(base, "/claude/v1/messages", { headers: { "x-api-key": server.secret + "x" }, body: MESSAGES })).status, 401);
  assert.equal((await http(base, "/claude/v1/messages", { headers: { "x-api-key": "" }, body: MESSAGES })).status, 401);
});

test("each gateway has a secret of its own, and stopping it closes the port", async (t) => {
  const one = await gateway(t);
  const two = await gateway(t);
  assert.notEqual(one.server.secret, two.server.secret);
  assert.notEqual(one.base, two.base);
  assert.equal(await one.server.start(), one.base, "starting again gives the same address");
  await one.server.stop();
  await assert.rejects(http(one.base, "/chatgpt/responses", { headers: one.bearer, body: RESPONSES }));
});

// ---- The Harness: which program runs a model selection ----

/** A registry of made-up providers, as desktop/providers/index.mjs offers it to the Harness. */
function registry({ ids = ["copilot", "codex", "claude", "opencode"], models = async () => [] } = {}) {
  const byId = new Map(ids.map((id) => [id, { id }]));
  return { byId, for: (selection) => byId.get(selection.provider), models };
}
const standIn = () => {
  const gate = { stopped: 0, started: 0, secret: "s", start: async () => (gate.started++, "http://127.0.0.1:1"), stop: () => void gate.stopped++ };
  return gate;
};
const harness = (providers, choice = () => "copilot", gate = standIn()) => new Harness({ providers, choice, dir: root, bridge: null, gateway: gate });

test("one harness is the usual choice, and a saved value that is not a harness is that choice", () => {
  assert.deepEqual(HARNESSES, ["copilot", "provider", "pi", "omp"]);
  assert.equal(harnessField("copilot"), "copilot");
  assert.equal(harnessField("provider"), "provider");
  assert.equal(harnessField("pi"), "pi");
  assert.equal(harnessField("omp"), "omp");
  for (const value of ["opencode", "", "COPILOT", undefined, null, 3, {}]) assert.equal(harnessField(value), "copilot", String(value));
});

test("the Copilot runtime hosts a ChatGPT or Claude selection when the choice is copilot", () => {
  const providers = registry();
  for (const choice of [() => "copilot", () => undefined, () => "something else"]) {
    const one = harness(providers, choice);
    assert.equal(one.hosts({ provider: "codex", model: "gpt-6-astra" }), true);
    assert.equal(one.hosts({ provider: "claude", model: "opus" }), true);
  }
});

test("the Copilot runtime does not host its own models, OpenCode, or anything when the choice is provider", () => {
  const providers = registry();
  const one = harness(providers);
  assert.equal(one.hosts({ provider: "copilot", model: "gpt-5" }), false, "its own models run themselves");
  assert.equal(one.hosts({ provider: "opencode", model: "x" }), false, "OpenCode is a whole agent");
  const own = harness(providers, () => "provider");
  assert.equal(own.hosts({ provider: "codex", model: "gpt-6-astra" }), false);
  assert.equal(own.hosts({ provider: "claude", model: "opus" }), false);
});

test("without a Copilot runtime nothing is hosted", () => {
  const providers = registry({ ids: ["codex", "claude", "opencode"] });
  const one = harness(providers);
  assert.equal(one.host, null);
  assert.equal(one.hosts({ provider: "codex", model: "gpt-6-astra" }), false);
  assert.equal(one.runner({ provider: "codex", model: "gpt-6-astra" }), providers.byId.get("codex"));
});

test("runner gives the Copilot runtime for a hosted selection and the model's own provider for the rest", () => {
  const providers = registry();
  const one = harness(providers);
  assert.equal(one.host, providers.byId.get("copilot"));
  assert.equal(one.runner({ provider: "codex", model: "gpt-6-astra" }), providers.byId.get("copilot"));
  assert.equal(one.runner({ provider: "claude", model: "opus" }), providers.byId.get("copilot"));
  assert.equal(one.runner({ provider: "copilot", model: "gpt-5" }), providers.byId.get("copilot"));
  assert.equal(one.runner({ provider: "opencode", model: "x" }), providers.byId.get("opencode"));
  assert.equal(harness(providers, () => "provider").runner({ provider: "claude", model: "opus" }), providers.byId.get("claude"));
});

test("with Pi chosen, Pi runs ChatGPT and Claude plan models, and every other model runs as before", () => {
  const providers = registry({ ids: ["copilot", "codex", "claude", "opencode", "pi"] });
  const pi = harness(providers, () => "pi");
  assert.equal(pi.via({ provider: "codex", model: "gpt-6-astra" }), "pi");
  assert.equal(pi.via({ provider: "claude", model: "opus" }), "pi");
  assert.equal(pi.runner({ provider: "codex", model: "gpt-6-astra" }), providers.byId.get("pi"));
  assert.equal(pi.runner({ provider: "claude", model: "opus" }), providers.byId.get("pi"));
  // GitHub Copilot's plan needs its own runtime; OpenCode is a whole agent.
  assert.equal(pi.runner({ provider: "copilot", model: "gpt-5" }), providers.byId.get("copilot"));
  assert.equal(pi.runner({ provider: "opencode", model: "x" }), providers.byId.get("opencode"));
  assert.equal(pi.hosts({ provider: "codex", model: "gpt-6-astra" }), false, "the Copilot runtime hosts nothing then");
  // A recovered turn names where it ran.
  assert.equal(harness(providers).runner({ provider: "claude", model: "opus" }, "pi"), providers.byId.get("pi"));
  // An app without Pi runs each provider's own.
  const without = harness(registry(), () => "pi");
  assert.equal(without.via({ provider: "codex", model: "gpt-6-astra" }), null);
  assert.equal(without.runner({ provider: "codex", model: "gpt-6-astra" }), without.providers.byId.get("codex"));
});

test("with OMP chosen, OMP runs ChatGPT and Claude plan models through the same gateway contract", async () => {
  const providers = registry({ ids: ["copilot", "codex", "claude", "opencode", "omp"], models: async () => CATALOG });
  const one = harness(providers, () => "omp");
  assert.equal(one.via({ provider: "codex", model: "gpt-6-astra" }), "omp");
  assert.equal(one.via({ provider: "claude", model: "opus" }), "omp");
  assert.equal(one.runner({ provider: "codex", model: "gpt-6-astra" }), providers.byId.get("omp"));
  assert.equal(one.runner({ provider: "claude", model: "opus" }), providers.byId.get("omp"));
  assert.equal(one.runner({ provider: "copilot", model: "gpt-5" }), providers.byId.get("copilot"));
  const out = await one.session({ provider: "claude", model: "opus" }, "omp");
  assert.deepEqual(out.model, { model: "opus", source: PI_PLANS.claude.name });
  assert.deepEqual(out.inference.providers.map((provider) => provider.name), ["botkins-chatgpt", "botkins-claude"]);
});

test("Pi's session has a connection to the gateway for each plan with models, in Pi's own format", async () => {
  const gate = standIn();
  const one = harness(registry({ ids: ["copilot", "codex", "claude", "pi"], models: async () => CATALOG }), () => "pi", gate);
  const out = await one.session({ provider: "claude", model: "opus", reasoningEffort: "high" }, "pi");
  assert.deepEqual(out.model, { model: "opus", source: PI_PLANS.claude.name, reasoningEffort: "high" });
  const [chatgpt, claude] = out.inference.providers;
  assert.equal(chatgpt.name, "botkins-chatgpt");
  assert.deepEqual({ ...chatgpt.config, models: undefined }, { name: "ChatGPT", baseUrl: "http://127.0.0.1:1/chatgpt", api: "openai-responses", apiKey: "s", authHeader: true, models: undefined });
  // The plan's endpoint takes the bot's instructions as a system message, which Pi sends only when the model says so.
  assert.ok(chatgpt.config.models.every((model) => model.compat?.supportsDeveloperRole === false));
  assert.deepEqual(chatgpt.config.models.map((model) => model.id), ["gpt-6-astra", "gpt-6-sol"], "an unavailable model isn't offered");
  assert.equal(claude.name, "botkins-claude");
  assert.deepEqual({ ...claude.config, models: undefined }, { name: "Claude", baseUrl: "http://127.0.0.1:1/claude", api: "anthropic-messages", apiKey: "s", models: undefined });
  assert.deepEqual(claude.config.models, [piModel({ id: "opus", name: "Claude Opus 5.5" })]);
  assert.equal(out.inference.models, undefined, "Pi's models are inside its connections");
  assert.equal(gate.started, 1);
});

test("a plan's model as Pi is told of it: the stated window and reply size, else Pi's defaults, and no cost", () => {
  assert.deepEqual(piModel({ id: "m", name: "M", efforts: ["low"], contextWindow: 400000, maxOutput: 128000 }), { id: "m", name: "M", reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const plain = piModel({ id: "x", vision: false });
  assert.deepEqual([plain.reasoning, plain.input, plain.contextWindow, plain.maxTokens], [false, ["text"], 128000, 16384]);
});

const CATALOG = [
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "codex" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "codex", available: false },
  { id: "gpt-6-sol", provider: "codex", available: true },
  { id: "opus", name: "Claude Opus 5.5", provider: "claude" },
  { id: "gpt-5", name: "GPT-5", provider: "copilot" },
];
/** The models offered, as id, plan and name. */
const offered = (out) => out.inference.models.map(({ id, provider, name }) => ({ id, provider, name }));
const CHATGPT = { name: "chatgpt", type: "openai", wireApi: "responses", baseUrl: "http://127.0.0.1:1/chatgpt", bearerToken: "s" };
const CLAUDE = { name: "claude", type: "anthropic", baseUrl: "http://127.0.0.1:1/claude", bearerToken: "s" };

test("session names a ChatGPT selection the runtime's way and offers every available model of both plans", async () => {
  const gate = standIn();
  const one = harness(registry({ models: async () => CATALOG }), () => "copilot", gate);
  const out = await one.session({ provider: "codex", model: "gpt-6-astra", reasoningEffort: "high" });
  assert.deepEqual(out.model, { model: "gpt-6-astra", source: "chatgpt", reasoningEffort: "high" });
  assert.deepEqual(out.inference.providers, [CHATGPT, CLAUDE]);
  assert.deepEqual(offered(out), [
    { id: "gpt-6-astra", provider: "chatgpt", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", provider: "chatgpt", name: "GPT-6 Sol" },
    { id: "opus", provider: "claude", name: "Claude Opus 5.5" },
  ]);
  assert.equal(gate.started, 1, "the gateway is started for it");
});

test("session names a Claude selection, and has no reasoning effort when none was chosen", async () => {
  const out = await harness(registry({ models: async () => CATALOG })).session({ provider: "claude", model: "opus" });
  assert.deepEqual(out.model, { model: "opus", source: "claude" });
  assert.ok(!("reasoningEffort" in out.model));
  assert.deepEqual(out.inference.providers, [CHATGPT, CLAUDE]);
});

test("session adds the chosen model when the catalog does not have it, named as people read it", async () => {
  const out = await harness(registry({ models: async () => CATALOG })).session({ provider: "claude", model: "claude-opus-5-5" });
  assert.deepEqual(offered(out).at(-1), { id: "claude-opus-5-5", provider: "claude", name: "Claude Opus 5.5" });
  assert.equal(out.inference.models.filter((model) => model.id === "claude-opus-5-5").length, 1);
  assert.equal(out.inference.models.filter((model) => model.id === "opus").length, 1, "the catalog's own entry stays");
});

test("session still works when the catalog cannot be read: the chosen model on its own plan's connection", async () => {
  for (const models of [async () => [], async () => { throw new Error("offline"); }]) {
    const out = await harness(registry({ models })).session({ provider: "codex", model: "gpt-6-sol" });
    assert.deepEqual(offered(out), [{ id: "gpt-6-sol", provider: "chatgpt", name: "GPT-6 Sol" }]);
    assert.deepEqual(out.inference.providers, [CHATGPT], "the other plan has no models to offer, so no connection");
  }
});

test("session tells the runtime what each model's provider states, since the runtime cannot look them up", async () => {
  const catalog = [
    { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "codex", efforts: ["low", "high"], contextWindow: 272000, maxPrompt: 258400, vision: true, tools: true },
    { id: "opus", name: "Claude Opus", provider: "claude", efforts: [], contextWindow: 1000000, maxOutput: 128000, vision: true, tools: true },
    { id: "new", name: "New", provider: "claude", efforts: [] },
  ];
  const out = await harness(registry({ models: async () => catalog })).session({ provider: "codex", model: "gpt-6-astra" });
  const told = Object.fromEntries(out.inference.models.map((model) => [model.id, model]));
  assert.deepEqual(told["gpt-6-astra"], { id: "gpt-6-astra", provider: "chatgpt", name: "GPT-6 Astra", maxPromptTokens: 258400, maxContextWindowTokens: 272000, capabilities: { supports: { vision: true, toolCalls: true, reasoningEffort: true } } });
  // A request's prompt and its reply room share the window, and the runtime asks for all the reply room.
  assert.deepEqual(told.opus, { id: "opus", provider: "claude", name: "Claude Opus", maxPromptTokens: 872000, maxContextWindowTokens: 1000000, maxOutputTokens: 128000, capabilities: { supports: { vision: true, toolCalls: true, reasoningEffort: false } } });
  assert.deepEqual(told.new, { id: "new", provider: "claude", name: "New", capabilities: { supports: { reasoningEffort: false } } }, "what nobody stated is left out, never made up");
});

test("a plan's model is given the provider's prompt limit, else the window less the reply room, else the window", () => {
  const limits = (model) => {
    const { maxPromptTokens, maxContextWindowTokens, maxOutputTokens } = planModel("claude", { id: "m", name: "M", ...model });
    return [maxPromptTokens, maxContextWindowTokens, maxOutputTokens];
  };
  assert.deepEqual(limits({ contextWindow: 1000000, maxPrompt: 936000, maxOutput: 128000 }), [936000, 1000000, 128000]);
  assert.deepEqual(limits({ contextWindow: 1000000, maxOutput: 128000 }), [872000, 1000000, 128000]);
  assert.deepEqual(limits({ contextWindow: 500000 }), [500000, 500000, undefined]);
  assert.deepEqual(limits({ maxOutput: 64000 }), [undefined, undefined, 64000]);
  assert.deepEqual(limits({}), [undefined, undefined, undefined]);
  assert.deepEqual(planModel("claude", { id: "m", vision: false, tools: true, efforts: ["low"] }).capabilities, { supports: { vision: false, toolCalls: true, reasoningEffort: true } });
});

test("session starts Claude Code waiting when a chat on a Claude plan's model opens, and not for ChatGPT", async () => {
  const gate = standIn();
  const warmed = [];
  gate.warm = async (model) => void warmed.push(model);
  const one = harness(registry({ models: async () => CATALOG }), () => "copilot", gate);
  await one.session({ provider: "codex", model: "gpt-6-astra" });
  assert.deepEqual(warmed, []);
  await one.session({ provider: "claude", model: "opus" });
  assert.deepEqual(warmed, ["opus"]);
});

test("stop stops the gateway", async () => {
  const gate = standIn();
  await harness(registry(), () => "copilot", gate).stop();
  assert.equal(gate.stopped, 1);
});

test("a Harness made without a gateway makes one that serves only the plans it has", () => {
  const both = new Harness({ providers: registry(), choice: () => "copilot", dir: root, bridge: null, version: "1" });
  assert.ok(both.gateway instanceof Gateway);
  assert.ok(both.gateway.chatgpt && both.gateway.claude);
  assert.equal(both.gateway.version, "1");
  const none = new Harness({ providers: registry({ ids: ["copilot"] }), choice: () => "copilot", dir: root, bridge: null });
  assert.equal(none.gateway.chatgpt, null);
  assert.equal(none.gateway.claude, null);
  assert.equal(none.gateway.server, null, "nothing is listening until a session asks");
});
