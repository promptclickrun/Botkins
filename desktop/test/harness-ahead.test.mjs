// A Claude plan behind a harness, when a turn calls tools: the run of Claude Code that answers
// the next request is told that request ahead of time, as far as it is known, so the request has
// only its new turns to send (desktop/harness/claude.mjs: outline, ClaudePool.tellAhead).
// Claude Code is stood in for by test/fixtures/fake-claude.mjs. Nothing here reaches the network
// or starts the real Claude Code.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { ClaudePool, PlanError, claudeTurn, extraBody, frames, listedTools, outline, toolNames } from "../desktop/harness/claude.mjs";
import { Gateway } from "../desktop/harness/gateway.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "botkins-harness-ahead-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const launch = (_file, args, options) => spawn(process.execPath, [FIXTURE, ...args], options);
const until = async (check, ms = 5000) => {
  const limit = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > limit) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const failsWith = (status) => (error) => error instanceof PlanError && error.status === status;

const BODY = {
  model: "claude-test",
  system: [{ type: "text", text: "Be brief." }],
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "lookup", description: "Looks something up.", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
};
const CALL = { role: "assistant", content: [{ type: "tool_use", id: "toolu_fake", name: "lookup", input: { query: "x" } }] };
const result = (text) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake", content: text }] });
/** A conversation `rounds` tool calls in: the person's turn, then a call and its result for each. */
const talk = (rounds, first = "hi") => {
  const messages = [{ role: "user", content: first }];
  for (let round = 0; round < rounds; round++) messages.push(CALL, result("result " + round));
  return messages;
};

/**
 * claudeTurn with a pool of stand-ins. The stand-in calls the tool while the conversation holds
 * fewer than `rounds` results, then answers in words. `started` lists every start; `log()` is
 * what the run that answered last was started with and sent.
 */
function pooled(t, { rounds = 9, env = {}, pool: poolOptions = {}, ...extra } = {}) {
  const bridge = new ToolBridge();
  const dir = mkdtempSync(join(root, "run-"));
  const logFile = join(dir, "log.json");
  const events = [];
  const started = [];
  const starts = (file, args, opts) => {
    const child = launch(file, args, opts);
    started.push({ args, child });
    return child;
  };
  // The stand-in has no startup to wait out.
  const pool = new ClaudePool({ settleMs: 0, launch: starts, ...poolOptions });
  t.after(async () => {
    pool.stop();
    await bridge.stop();
  });
  const options = {
    file: "claude",
    env: { PATH: process.env.PATH, FAKE_CLAUDE: "rounds:" + rounds, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_ACK_MS: "5", ...env },
    cwd: join(dir, "cwd"),
    bridge,
    emit: (event) => events.push(event),
    launch: starts,
    idleMs: 10_000,
    pool,
    ...extra,
  };
  const told = () => pool.waiting.filter((run) => run.ahead);
  return {
    bridge,
    pool,
    options,
    events,
    started,
    told,
    log: () => JSON.parse(readFileSync(logFile, "utf8")),
    turn: (body = BODY, more = {}) => claudeTurn(body, { ...options, ...more }),
    /** The run that was told a request ahead, once it has taken all of it in. */
    async ready() {
      const run = await until(() => told()[0]);
      assert.equal(await run.ahead.done, true, "it took in what it was told");
      return run;
    },
  };
}
const replied = (events) => events.find((event) => event.type === "content_block_start")?.content_block.type;

test("a request's marks are the same as another's only as far as the two requests are the same", () => {
  const shape = (body) => {
    const names = toolNames(body.tools);
    const tools = listedTools(body.tools, names);
    return outline({ system: body.system[0].text, model: body.model, effort: body.output_config?.effort, maxTokens: body.max_tokens ?? 0, extra: extraBody(body, tools), turns: frames(body.messages, names) });
  };
  const two = shape({ ...BODY, messages: talk(1) });
  const three = shape({ ...BODY, messages: talk(2) });
  assert.equal(two.marks.length, 3);
  assert.deepEqual(three.marks.slice(0, 3), two.marks, "the request that goes on from another has its marks, and more");
  assert.equal(new Set(three.marks).size, 5, "each turn has a mark of its own");
  assert.deepEqual(two.kinds, ["user", "assistant", "user"]);
  // A turn is kept as it is replayed: the person's turns say that no answer is wanted.
  assert.deepEqual(two.lines.map((line) => JSON.parse(line).shouldQuery), [false, undefined, false]);
  assert.deepEqual(JSON.parse(two.lines[1]), frames(talk(1), toolNames(BODY.tools))[1]);
  // Anything else the request says changes every mark: none of these may take a run told for `two`.
  const others = [
    { ...BODY, messages: talk(1), system: [{ type: "text", text: "Be long." }] },
    { ...BODY, messages: talk(1), model: "claude-other" },
    { ...BODY, messages: talk(1), max_tokens: 100 },
    { ...BODY, messages: talk(1), output_config: { effort: "high" } },
    { ...BODY, messages: talk(1), thinking: { type: "adaptive" } },
    { ...BODY, messages: talk(1), tools: [{ ...BODY.tools[0], description: "Looks something else up." }] },
    { ...BODY, messages: talk(1), tools: [...BODY.tools, { name: "more", input_schema: { type: "object" } }] },
    { ...BODY, messages: talk(1), tools: undefined },
  ];
  for (const [index, body] of others.entries()) assert.ok(!shape(body).marks.some((mark) => two.marks.includes(mark)), "request " + index);
  // A turn that differs changes its mark and every one after, and none before.
  const rewritten = shape({ ...BODY, messages: [talk(2)[0], talk(2)[1], result("another result"), ...talk(2).slice(3)] });
  assert.deepEqual(rewritten.marks.slice(0, 2), three.marks.slice(0, 2));
  for (const index of [2, 3, 4]) assert.notEqual(rewritten.marks[index], three.marks[index]);
  // Where the cache breaks is not part of a turn: a harness moves it from request to request.
  const cached = talk(1);
  cached[2] = { role: "user", content: [{ ...cached[2].content[0], cache_control: { type: "ephemeral" } }] };
  assert.deepEqual(shape({ ...BODY, messages: cached }).marks, two.marks);
});

test("while a turn calls tools, each request finds a run that was told it ahead of time and sends only the turns since", async (t) => {
  const run = pooled(t, { rounds: 3 });
  await run.turn({ ...BODY, messages: talk(0) });
  assert.equal(replied(run.events), "tool_use");
  assert.equal(run.told().length, 0, "nothing is known yet of how this harness goes on from a request");
  assert.equal(run.started.length, 3, "two waited, and one took the place of the one that answered");

  // The second request goes on from the first. It is handed over as it comes, and while it is
  // answered a waiting run is told the request that will follow it.
  await run.turn({ ...BODY, messages: talk(1) });
  assert.deepEqual(run.log().controls.map((control) => control.subtype), ["initialize", "mcp_set_servers", "apply_flag_settings"]);
  const ahead = await run.ready();
  assert.equal(ahead.ahead.count, 3);
  assert.equal(run.pool.waiting.length, 2, "it is one of the two that wait, not one more");
  assert.equal(run.started.length, 4);
  assert.equal(run.bridge.endpoints.size, 1, "it has a tool server address of its own");

  // The third request is that one with the reply and the tool's result added.
  run.events.length = 0;
  const began = Date.now();
  await run.turn({ ...BODY, messages: talk(2) });
  const log = run.log();
  assert.equal(log.pid, ahead.child.pid, "the run that was told ahead answered");
  assert.ok(!log.argv.includes("--system-prompt-file"));
  assert.deepEqual(log.controls.map((control) => control.subtype), ["initialize", "mcp_set_servers", "apply_flag_settings"]);
  assert.ok(log.controlTimes.every((time) => time < began), "it was told the system prompt, the tools and the rest before the request came");
  assert.equal(log.systemPrompt, "Be brief.");
  assert.deepEqual(log.tools, ["lookup"], "its tool server lists the runtime's tools");
  assert.match(log.toolCall.content[0].text, /Denied/, "and refuses to run one");
  // What it was sent in all is what a run handed the whole request is sent, in the same order.
  const sent = frames(talk(2), toolNames(BODY.tools));
  assert.deepEqual(log.frames, [{ ...sent[0], shouldQuery: false }, sent[1], { ...sent[2], shouldQuery: false }, sent[3], sent[4]]);
  assert.ok(log.frameTimes.slice(0, 3).every((time) => time < began), "the turns of the request before were replayed before this one came");
  assert.ok(log.frameTimes.slice(3).every((time) => time >= began), "only the reply and the tool's result were left to send");
  assert.equal(log.ackTimes.length, 2, "each replayed turn of the person's was acknowledged, as ever");
  assert.equal(replied(run.events), "tool_use");
  assert.deepEqual(run.events.map((event) => event.type).slice(-2), ["message_delta", "message_stop"]);
  assert.equal(run.started.length, 5, "each request still starts one run and no more");

  // The fourth is answered in words by the run that was told while the third was answered. No
  // request follows a reply that calls no tool, so the run told ahead for one is let go, and the
  // two that wait can be taken by any request.
  const last = await run.ready();
  assert.equal(last.ahead.count, 5);
  run.events.length = 0;
  await run.turn({ ...BODY, messages: talk(3) });
  assert.equal(run.log().pid, last.child.pid);
  assert.equal(replied(run.events), "text");
  assert.equal(run.told().length, 0);
  assert.equal(run.pool.waiting.length, 2);
  await until(() => run.started.filter((each) => !exited(each.child)).length === 2);
  assert.equal(run.bridge.endpoints.size, 0, "no tool server address is left open");
  assert.deepEqual(run.pool.counts, { ahead: 2, handed: 2, own: 0 }, "the pool keeps count of how each request was answered");
});

test("a run that was told one conversation ahead is never handed another request", async (t) => {
  const run = pooled(t);
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await run.ready();
  // Each of these differs from what the run was told: in the conversation, in an earlier turn of
  // it, or in what else the request says. Each is answered by a run that was told nothing before.
  const others = [
    { ...BODY, messages: talk(0, "another chat") },
    { ...BODY, messages: talk(2, "another chat") },
    { ...BODY, messages: [talk(2)[0], CALL, result("not what it was told"), CALL, result("result 1")] },
    { ...BODY, messages: talk(2), system: [{ type: "text", text: "Be long." }] },
    { ...BODY, messages: talk(2), tools: [{ ...BODY.tools[0], description: "Looks something else up." }] },
    { ...BODY, messages: talk(2), model: "claude-other" },
    { ...BODY, messages: talk(2), max_tokens: 100 },
    // The same request again is not the one that follows it.
    { ...BODY, messages: talk(1) },
  ];
  for (const [index, body] of others.entries()) {
    const began = Date.now();
    await run.turn(body);
    const log = run.log();
    assert.notEqual(log.pid, ahead.child.pid, "request " + index);
    assert.ok(log.controlTimes.every((time) => time >= began), "request " + index + ": the run was told its request when it came");
    const names = toolNames(body.tools);
    assert.deepEqual(
      log.frames.map(({ shouldQuery: _replayed, ...frame }) => frame),
      frames(body.messages, names),
      "request " + index + ": it was sent that request's turns and no others",
    );
    assert.equal(log.systemPrompt, body.system[0].text, "request " + index);
    assert.ok(run.pool.waiting.includes(ahead), "request " + index + ": the run told ahead still waits for its own");
  }
  // Its own conversation's next request takes it.
  await run.turn({ ...BODY, messages: talk(2) });
  assert.equal(run.log().pid, ahead.child.pid);
});

test("a harness that rewrites its conversation from request to request has no run told ahead", async (t) => {
  const run = pooled(t);
  for (const rounds of [0, 1, 2, 3]) {
    // The first turn says something else each time, as when a harness puts the time in it.
    await run.turn({ ...BODY, messages: talk(rounds, "hi at " + rounds) });
    assert.equal(run.told().length, 0);
    assert.equal(run.started.length, 3 + rounds, "one run for each request, as before");
  }
});

test("a request that brings no tool result has the next one told when its reply calls a tool, and not when it doesn't", async (t) => {
  const calls = pooled(t);
  await calls.turn({ ...BODY, messages: talk(0) });
  const more = [...talk(0), { role: "assistant", content: "Done." }, { role: "user", content: "and now?" }];
  calls.events.length = 0;
  await calls.turn({ ...BODY, messages: more });
  assert.equal(replied(calls.events), "tool_use");
  assert.equal((await calls.ready()).ahead.count, 3, "told once the reply began to call a tool");

  const words = pooled(t, { rounds: 0 });
  await words.turn({ ...BODY, messages: talk(0) });
  words.events.length = 0;
  await words.turn({ ...BODY, messages: more });
  assert.equal(replied(words.events), "text");
  assert.equal(words.told().length, 0);
  assert.equal(words.started.length, 4, "no run was started that nothing will take");
});

test("with a run told ahead for one conversation, another has none until the first has left its own alone a while", async (t) => {
  const run = pooled(t);
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  const first = await run.ready();
  await run.turn({ ...BODY, messages: talk(0, "another chat") });
  await run.turn({ ...BODY, messages: talk(1, "another chat") });
  assert.deepEqual(run.told(), [first], "the one run that may be told ahead is the first conversation's still");
  assert.equal(run.pool.waiting.length, 2);
  assert.equal(run.pool.waiting.filter((each) => !each.ahead).length, 1, "and one waits for whichever request comes");
  // Nothing took it for as long as it is left alone: the other conversation's next request is told instead.
  run.pool.staleMs = 0;
  await run.turn({ ...BODY, messages: talk(2, "another chat") });
  const second = await run.ready();
  assert.notEqual(second, first);
  assert.equal(second.ahead.count, 5);
  await until(() => exited(first.child));
  assert.equal(run.bridge.endpoints.size, 1, "the first one's tool server address went with it");
  await run.turn({ ...BODY, messages: talk(3, "another chat") });
  assert.equal(run.log().pid, second.child.pid);
});

test("a pool of one keeps its run for whichever request comes", async (t) => {
  const run = pooled(t, { pool: { size: 1 } });
  for (const rounds of [0, 1, 2]) await run.turn({ ...BODY, messages: talk(rounds) });
  assert.equal(run.told().length, 0);
  assert.ok(run.log().controlTimes.length > 0, "each request was handed to the run that waited");
});

test("a run that can't be told ahead costs the request nothing, and none is told for a while", async (t) => {
  const lines = [];
  const run = pooled(t, { env: { FAKE_CLAUDE_CONTROL: "refuse" }, pool: { log: (line) => lines.push(line) } });
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  assert.ok(run.log().argv.includes("--system-prompt-file"), "a run that refuses a hand-over leaves the request a run of its own, as before");
  await until(() => run.pool.rest > Date.now());
  assert.match(lines.join("\n"), /couldn't be told a request ahead/);
  assert.equal(run.told().length, 0, "the run that refused was ended");
  assert.equal(run.bridge.endpoints.size, 0, "and its tool server address closed");
  const before = run.started.length;
  run.events.length = 0;
  await run.turn({ ...BODY, messages: talk(2) });
  assert.equal(run.events.at(-1).type, "message_stop");
  assert.equal(run.told().length, 0);
  assert.equal(run.started.length, before + 2, "the request's own run and the one that took the place of the run it tried: none to be told ahead");
});

test("a run still being told when its request comes is waited for no longer than a hand-over, then the request gets a run of its own", async (t) => {
  const run = pooled(t, { handoverMs: 300 });
  await run.turn({ ...BODY, messages: talk(0) });
  // The runs that wait from now on take a control message and never answer it.
  run.pool.stop();
  run.options.env.FAKE_CLAUDE_CONTROL = "silent";
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await until(() => run.told()[0]);
  run.events.length = 0;
  const began = Date.now();
  await run.turn({ ...BODY, messages: talk(2) });
  assert.ok(Date.now() - began >= 290, "it was waited for");
  assert.ok(Date.now() - began < 3000, "and not for long");
  assert.ok(run.log().argv.includes("--system-prompt-file"), "answered by a run started for the request");
  assert.deepEqual(run.log().frames.map(({ shouldQuery: _replayed, ...frame }) => frame), frames(talk(2), toolNames(BODY.tools)), "which was sent the whole conversation");
  assert.equal(run.events.at(-1).type, "message_stop");
  await until(() => exited(ahead.child));
  assert.ok(run.pool.rest > Date.now(), "no other run is told ahead for a while");
  await until(() => run.bridge.endpoints.size === 0);
});

test("a request cancelled while its run is still being told ends that run and closes its tool server address", async (t) => {
  const run = pooled(t, { handoverMs: 5000 });
  await run.turn({ ...BODY, messages: talk(0) });
  run.pool.stop();
  run.options.env.FAKE_CLAUDE_CONTROL = "silent";
  // This request is handed to a run that doesn't answer, and is given up for a run of its own.
  await run.turn({ ...BODY, messages: talk(1) }, { handoverMs: 200 });
  const ahead = await until(() => run.told()[0]);
  const gone = new AbortController();
  const turn = run.turn({ ...BODY, messages: talk(2) }, { signal: gone.signal });
  setTimeout(() => gone.abort(), 100);
  await assert.rejects(turn, failsWith(499));
  await until(() => exited(ahead.child));
  await until(() => run.bridge.endpoints.size === 0);
  assert.ok(run.pool.rest <= Date.now(), "a cancelled request is not a run that couldn't be told");
});

test("a request cancelled in the middle of a reply from a run told ahead ends the run", async (t) => {
  const run = pooled(t);
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await run.ready();
  const gone = new AbortController();
  // The request is given up at the reply's first event.
  const turn = run.turn({ ...BODY, messages: talk(2) }, { signal: gone.signal, emit: () => gone.abort() });
  await assert.rejects(turn, failsWith(499));
  await until(() => exited(ahead.child));
});

test("the runs told ahead end with the pool, and their tool server addresses with them", async (t) => {
  const run = pooled(t);
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await run.ready();
  assert.equal(run.bridge.endpoints.size, 1);
  run.pool.stop();
  await until(() => exited(ahead.child));
  assert.equal(run.bridge.endpoints.size, 0);
  assert.equal(run.pool.waiting.length, 0);
  // And when the program or the sign-in changes, as every waiting run is.
  await run.turn({ ...BODY, messages: talk(1) });
  await run.turn({ ...BODY, messages: talk(2) });
  const next = await run.ready();
  run.pool.ensure({ file: run.options.file, env: { ...run.options.env, ANTHROPIC_API_KEY: "other" }, cwd: run.options.cwd, model: BODY.model });
  await until(() => exited(next.child));
  assert.equal(run.told().length, 0);
  assert.equal(run.bridge.endpoints.size, 0);
});

test("a pool that is stopped while a run is being told ahead starts nothing in its place", async (t) => {
  const run = pooled(t, { handoverMs: 200 });
  await run.turn({ ...BODY, messages: talk(0) });
  run.pool.stop();
  run.options.env.FAKE_CLAUDE_CONTROL = "silent";
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await until(() => run.told()[0]);
  const before = run.started.length;
  run.pool.stop();
  await until(() => exited(ahead.child));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(run.started.length, before, "no run was started after the pool stopped");
  assert.equal(run.pool.waiting.length, 0);
  assert.equal(run.bridge.endpoints.size, 0);
  assert.ok(run.pool.rest <= Date.now(), "and a run that was ended is not one that couldn't be told");
  assert.ok(run.started.every((each) => exited(each.child)), "every run this pool started is over");
});

test("stopping the pool never fails, and the logs folder goes even when a run is still writing in it", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const run = pooled(t);
  run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
  const folder = run.pool.logs;
  // As when a run that was just started makes its log while the folder is removed: something in it can't be removed yet.
  const held = join(folder, "held");
  mkdirSync(held);
  writeFileSync(join(held, "1.log"), "x");
  chmodSync(held, 0o500);
  t.after(() => existsSync(held) && chmodSync(held, 0o700));
  assert.doesNotThrow(() => run.pool.stop());
  assert.equal(run.pool.waiting.length, 0);
  assert.equal(run.pool.logs, null);
  await until(() => run.started.every((each) => exited(each.child)));
  assert.ok(existsSync(folder));
  chmodSync(held, 0o700);
  await until(() => !existsSync(folder), 3000);
});

test("a run told ahead that ends by itself is not handed the request, and its tool server address is closed", async (t) => {
  const run = pooled(t);
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await run.ready();
  ahead.child.kill();
  await until(() => exited(ahead.child) && !run.pool.waiting.includes(ahead));
  assert.equal(run.bridge.endpoints.size, 0);
  run.events.length = 0;
  await run.turn({ ...BODY, messages: talk(2) });
  assert.notEqual(run.log().pid, ahead.child.pid);
  assert.equal(run.log().frames.length, 5, "the request was handed over whole");
  assert.equal(run.events.at(-1).type, "message_stop");
});

test("a run told ahead is handed its request only once its startup is over", async (t) => {
  // Each run's log says 400 ms after it starts that its startup is over.
  const run = pooled(t, { env: { FAKE_CLAUDE_STARTUP: "silent:400" }, pool: { settleMs: 10_000 } });
  await run.turn({ ...BODY, messages: talk(0) });
  await run.turn({ ...BODY, messages: talk(1) });
  const ahead = await run.ready();
  await run.turn({ ...BODY, messages: talk(2) });
  const log = run.log();
  assert.equal(log.pid, ahead.child.pid);
  assert.ok(log.frameTimes[3] - ahead.born >= 350, "not before its log said so: " + (log.frameTimes[3] - ahead.born));
});

test("a run told ahead that hasn't finished starting is passed over, told the turns since, and taken once it has", async (t) => {
  const run = pooled(t, { env: { FAKE_CLAUDE_STARTUP: "silent:20000" }, pool: { settleMs: 60_000, graceMs: 100 } });
  for (const rounds of [0, 1]) await run.turn({ ...BODY, messages: talk(rounds) });
  const ahead = await until(() => run.told()[0]);
  assert.equal(ahead.ahead.count, 3);
  await run.turn({ ...BODY, messages: talk(2) });
  assert.ok(run.log().argv.includes("--system-prompt-file"), "the request got a run of its own after a short wait, as before");
  // The run is not ended for having been passed over: it is told how the conversation stands now.
  assert.deepEqual(run.told(), [ahead]);
  assert.equal(ahead.ahead.count, 5);
  assert.equal(await ahead.ahead.done, true);
  assert.ok(!exited(ahead.child));
  assert.equal(run.pool.waiting.length, 2);
  assert.equal(run.bridge.endpoints.size, 1, "with the tool server address it was given at first");
  // Its startup is over by the next request, which it answers with only the newest turns to be sent.
  run.pool.settleMs = 0;
  const began = Date.now();
  await run.turn({ ...BODY, messages: talk(3) });
  const log = run.log();
  assert.equal(log.pid, ahead.child.pid);
  const sent = frames(talk(3), toolNames(BODY.tools));
  assert.deepEqual(log.frames.map(({ shouldQuery: _replayed, ...frame }) => frame), sent, "every turn, once, in order");
  assert.deepEqual(log.frames.map((frame) => frame.shouldQuery), [false, undefined, false, undefined, false, undefined, undefined]);
  assert.equal(log.controls.length, 3, "and it was told the system prompt and the tools once");
  assert.ok(log.frameTimes.slice(0, 5).every((time) => time < began));
  assert.ok(log.frameTimes.slice(5).every((time) => time >= began));
});

test("a request that waits for a run to finish starting goes on the moment the run's log says so", async (t) => {
  const run = pooled(t, { env: { FAKE_CLAUDE_STARTUP: "silent:300" }, pool: { settleMs: 10_000 } });
  run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
  const [first] = run.pool.waiting;
  assert.equal(first.settled, false);
  assert.ok(run.pool.ticker, "the logs of runs that are starting are looked at");
  const began = Date.now();
  await first.ready;
  assert.equal(first.settled, true, "the run itself says when it is ready: nothing asks it over and over");
  assert.ok(Date.now() - began >= 250 && Date.now() - began < 3000, String(Date.now() - began));
  await Promise.all(run.pool.waiting.map((each) => each.ready));
  await until(() => !run.pool.ticker);
  assert.equal(run.pool.watcher, null, "and nothing is looked at once every run has started");
  // A run that ends before it has started wakes whoever waits for it, too.
  run.pool.stop();
  run.options.env.FAKE_CLAUDE_STARTUP = "silent:20000";
  run.pool.graceMs = 5000;
  run.pool.ensure({ file: run.options.file, env: run.options.env, cwd: run.options.cwd, model: BODY.model });
  const taking = run.pool.takeReady({ file: run.options.file, env: run.options.env, cwd: run.options.cwd });
  const again = Date.now();
  for (const each of [...run.pool.waiting]) each.child.kill();
  assert.equal(await taking, null);
  assert.ok(Date.now() - again < 2000, "it didn't wait out the whole grace");
});

test("conversations that go on at the same time, some of their requests cancelled, are each answered from their own turns alone", async (t) => {
  for (const size of [2, 3]) {
    const run = pooled(t, { rounds: 99, env: { FAKE_CLAUDE_HEARD: "1", FAKE_CLAUDE_ACK_MS: "2" }, pool: { size, staleMs: 40 } });
    const heard = (body) => "msg_" + createHash("sha256").update(JSON.stringify([body.system[0].text, frames(body.messages, toolNames(body.tools))])).digest("hex").slice(0, 24);
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Three chats: two with the same bot (the same system prompt and tools), one with another.
    const chats = [
      { ...BODY, first: "the first chat" },
      { ...BODY, first: "the second chat" },
      { ...BODY, first: "the first chat", system: [{ type: "text", text: "Be long." }] },
    ];
    let answered = 0;
    let cancelled = 0;
    await Promise.all(
      chats.map(async ({ first, ...chat }, which) => {
        for (let rounds = 0; rounds < 7; rounds++) {
          const body = { ...chat, messages: talk(rounds, first) };
          for (let attempt = 0; ; attempt++) {
            const events = [];
            // Every third request is given up once, at a moment of its own, and sent again.
            const gone = new AbortController();
            const giveUp = attempt === 0 && (rounds + which) % 3 === 2;
            if (giveUp) setTimeout(() => gone.abort(), 3 * (rounds + which));
            try {
              await run.turn(body, { emit: (event) => events.push(event), signal: gone.signal });
            } catch (error) {
              assert.ok(giveUp && failsWith(499)(error), "chat " + which + ", request " + rounds + ": " + error?.message);
              cancelled++;
              continue;
            }
            assert.equal(events[0].message.id, heard(body), "chat " + which + ", request " + rounds + ": the run that answered was told this request and nothing else");
            assert.equal(events.at(-1).type, "message_stop");
            answered++;
            break;
          }
          // The tool runs for a moment, a different one for each chat.
          await pause(5 + 7 * which);
        }
      }),
    );
    assert.equal(answered, 21);
    assert.ok(run.pool.counts.ahead > 0, "some were answered by runs told ahead: " + JSON.stringify(run.pool.counts));
    assert.ok(run.pool.waiting.length <= size, "never more wait than the pool's size");
    assert.ok(run.told().length <= size - 1, "and one of them at least was told nothing");
    run.pool.stop();
    await until(() => run.started.every((each) => exited(each.child)));
    assert.equal(run.bridge.endpoints.size, 0, "every tool server address is closed");
    assert.ok(cancelled > 0, "some requests were given up on the way");
    t.diagnostic("a pool of " + size + ": " + JSON.stringify(run.pool.counts) + ", " + cancelled + " cancelled, " + run.started.length + " runs started");
  }
});

// ---- through the gateway ----

const http = (base, path, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const call = request(base + path, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    call.on("error", reject);
    call.end(text);
  });

test("through the gateway, a turn's later requests are answered by runs that were told them ahead", async (t) => {
  const dir = mkdtempSync(join(root, "gateway-"));
  const bridge = new ToolBridge();
  const log = join(dir, "log.json");
  const server = new Gateway({
    claude: async () => ({ file: "claude", env: { PATH: process.env.PATH, FAKE_CLAUDE: "rounds:2", FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACK_MS: "5" }, cwd: join(dir, "cwd"), bridge }),
    launch,
    settleMs: 0,
  });
  const base = await server.start();
  t.after(async () => {
    await server.stop();
    await bridge.stop();
  });
  const ask = (rounds) => http(base, "/claude/v1/messages", { headers: { authorization: "Bearer " + server.secret }, body: { ...BODY, system: "Be brief.", messages: talk(rounds) } });
  await server.warm(BODY.model);
  for (const rounds of [0, 1]) assert.match((await ask(rounds)).text, /"type":"tool_use"/);
  const ahead = await until(() => server.pool.waiting.find((run) => run.ahead));
  assert.equal(await ahead.ahead.done, true);
  const began = Date.now();
  const answer = await ask(2);
  assert.equal(answer.status, 200);
  assert.match(answer.text, /^event: message_start\n/);
  assert.match(answer.text, /"text":"Hello"/, "the stand-in answers in words after two results");
  const said = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(said.pid, ahead.child.pid);
  assert.ok(said.controlTimes.every((time) => time < began));
  assert.equal(said.frames.length, 5);
  assert.equal(server.pool.waiting.filter((run) => run.ahead).length, 0, "the reply called no tool: nothing is kept told ahead");
  const waiting = server.pool.waiting.map((run) => run.child);
  await server.stop();
  await until(() => waiting.every(exited) && exited(ahead.child));
  assert.equal(bridge.endpoints.size, 0);
});
