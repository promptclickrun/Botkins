// A Claude plan as the model behind the Copilot runtime.
//
// The Copilot runtime writes each model request in Anthropic's Messages format. A Claude plan
// can't be reached with such a request directly: Anthropic lets a subscription sign-in be used
// only through its own programs. So each request is answered by one run of the official Claude
// Code program, unmodified and with the sign-in it keeps itself (Botkins never reads it). This is
// the way NousResearch's claude-subscription-directsdk plugin does it for Hermes:
//
//   - Claude Code's own tools, skills, slash commands, settings, memory and compaction are off.
//   - The runtime's system prompt replaces Claude Code's, and the conversation so far is replayed.
//   - The runtime's tools are only listed to it, through a local tool server that refuses every
//     call, and it may take one model turn. So the model can ask for a tool, and nothing runs.
//   - What the model said goes back to the runtime as Anthropic's own stream events.
//
// The Copilot runtime then runs the tools itself, with Botkins' approvals, and sends the next
// request, which is another run. Usage counts against the person's Claude plan.
//
// A run that is started for a request is slow to begin and, worse, can stop in the middle: soon
// after it starts, Claude Code checks whether the system tells it of changed files, a busy Mac
// doesn't answer in time, Claude Code switches to looking by itself, and while it switches
// nothing it has read from the model gets out. A person saw the first few words of a reply, a
// pause of seconds, then the rest at once (measured, Claude Code 2.1.325: its own log reports its
// event loop blocked for 1 to 13 seconds, beginning 2 to 8 seconds after it starts). So runs are
// started ahead of time and wait (ClaudePool). A request is handed to one whose startup is over
// (its own log says when), over Claude Code's own control messages, and another is started in
// its place. When none is ready the request gets a run of its own, as before. Measured with a
// ready run: a reply begins about a second sooner and no piece waits more than a third of a second.
//
// Handing a request over still takes time, and more as a conversation grows: three control
// messages, each answered, and then every earlier turn replayed, each of the person's
// acknowledged before the next is sent (measured, Claude Code 2.1.325 on an idle computer: 55 ms
// and 4 ms a turn, so a quarter of a second forty tool calls in, at every one of them; several
// times that on a busy computer). A turn that calls many tools makes that many requests, and each
// is the one before with a reply and a tool's result added. So while one request is answered, the
// run for the next is told everything that is already known of it (ClaudePool.tellAhead): the
// same control messages and the same turns, in the same order, only sooner. When the next request
// comes it finds that run, sends the two turns that are new, and the model is asked at once. A
// run is still one request's, and what the model is asked is the same to the byte (measured
// against a model endpoint on this computer; only Claude Code's own session id differs, as it
// does between any two runs).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** The name Claude Code knows the runtime's tools under: "mcp__botkins__<tool>". */
export const TOOL_SERVER = "botkins";
const PREFIX = "mcp__" + TOOL_SERVER + "__";

// Claude Code's own extras, switched off for a run: the runtime owns tools, memory, instructions,
// compaction and retries.
const QUIET = {
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_MAX_RETRIES: "0",
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  DISABLE_AUTOUPDATER: "1",
  // No feedback uploads from a run, and no request of its own for a session title.
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
};
/**
 * Claude Code names its caller on every request, and a plan's five-hour window is metered by that
 * name. Run with -p it calls itself "sdk-cli", which draws the window about twice as fast per token
 * as the interactive program or a client's own name (anthropics/claude-code#97074). So a run is
 * named for what it is, "botkins", over any name inherited from whatever started Botkins. Off the
 * "sdk-" names Claude Code would also offer its artifact tool and add a scratchpad line to every
 * request; that is switched off, so the request is the same apart from the name.
 */
export const CALLER = { CLAUDE_CODE_ENTRYPOINT: "botkins", CLAUDE_CODE_DISABLE_ARTIFACT: "1" };
// Left over from a surrounding Claude Code or an earlier run, these would change the request.
const DROPPED = ["CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDECODE", "CLAUDE_CODE_SSE_PORT"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * The thinking level of a run, as Claude Code's environment. It is not given with --effort: with
 * that flag Claude Code (2.1.325) hands the whole reply over in one piece at the end, so a person
 * watching sees nothing and then everything. Set this way the reply streams as it is written.
 * (Measured: with --effort the first event came with the last, 12 s in; this way the text came
 * from 3.5 s to 7.5 s.) A level left over from whatever started Botkins is dropped first.
 */
export const thinkingLevel = (effort) => (EFFORTS.includes(effort) ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {});

/** A failure as the runtime should hear it: an HTTP status and Anthropic's kind of error. */
export class PlanError extends Error {
  constructor(status, type, message) {
    super(message);
    Object.assign(this, { status, type });
  }
}

const blocks = (content) => (typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : Array.isArray(content) ? content : []);

/**
 * The names the runtime's tools go by in Claude Code. A tool server's tools are called
 * "mcp__<server>__<tool>" and a tool's whole name has a limit, so a long name is shortened to its
 * start and a mark of its own. `native(name)` and `original(nativeName)` go each way.
 */
export function toolNames(tools) {
  const forward = new Map();
  const back = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.name;
    if (typeof name !== "string" || !name || forward.has(name)) continue;
    const native = name.length <= 50 ? name : name.slice(0, 41) + "_" + createHash("sha256").update(name).digest("hex").slice(0, 8);
    if (back.has(native)) throw new PlanError(400, "invalid_request_error", "Two tools would have the same name for Claude Code: " + name + " and " + back.get(native) + ".");
    forward.set(name, native);
    back.set(native, name);
  }
  return {
    // A tool the conversation mentions that isn't offered now (a turn from before a tool was removed) keeps its name.
    native: (name) => PREFIX + (forward.get(name) ?? name),
    original: (name) => (typeof name === "string" && name.startsWith(PREFIX) ? (back.get(name.slice(PREFIX.length)) ?? name.slice(PREFIX.length)) : name),
    of: (name) => forward.get(name) ?? name,
  };
}

/**
 * A tool's input schema as Anthropic's API takes it: no oneOf, allOf or anyOf at the top (it
 * refuses the whole request for those), and an object always says what its properties are.
 */
export function toolSchema(schema) {
  let out = schema && typeof schema === "object" && !Array.isArray(schema) ? { ...schema } : { type: "object" };
  if (["oneOf", "allOf", "anyOf"].some((key) => key in out)) {
    out = Object.fromEntries(Object.entries(out).filter(([key]) => !["oneOf", "allOf", "anyOf"].includes(key)));
    out.type ??= "object";
  }
  if (out.type === "object" && (!out.properties || typeof out.properties !== "object")) out.properties = {};
  return out;
}

/**
 * The conversation as the frames Claude Code reads on its input: every turn in order, with tool
 * names as Claude Code lists them. Turns of the same speaker in a row become one, as the API wants.
 */
export function frames(messages, names = toolNames([])) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = blocks(message?.content).map((block) => {
      // Where the cache breaks is Claude Code's to decide for its own request.
      const { cache_control: _cache, ...rest } = block ?? {};
      return rest.type === "tool_use" && typeof rest.name === "string" ? { ...rest, name: names.native(rest.name) } : rest;
    });
    if (!content.length) continue;
    if (out.at(-1)?.type === role) out.at(-1).message.content.push(...content);
    else out.push({ type: role, message: { role, content } });
  }
  if (out.at(-1)?.type !== "user") throw new PlanError(400, "invalid_request_error", "A request to a Claude plan has to end with the person's turn or a tool's result.");
  return out;
}

/** The runtime's tools as the tool server lists them. A tool without a name or a schema isn't one Claude Code can be told about. */
export const listedTools = (tools, names = toolNames(tools)) =>
  (Array.isArray(tools) ? tools : [])
    .filter((tool) => typeof tool?.name === "string" && tool.name && tool.input_schema && typeof tool.input_schema === "object")
    .map((tool) => ({
      name: names.of(tool.name),
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: toolSchema(tool.input_schema),
      handler: async () => {
        throw new Error("Denied: only Botkins runs tools.");
      },
    }));

/**
 * What the request asks of the model besides the conversation, as extra fields for the request
 * Claude Code writes (its CLAUDE_CODE_EXTRA_BODY). Nothing the runtime asked for is dropped quietly:
 *   thinking       as asked. Claude Code leaves thinking text out unless it is asked for
 *                  ("summarized"), and then a person watching sees a pause instead of thinking.
 *   output_config  the thinking level and a wanted output format.
 *   max_tokens, stop_sequences
 *   tools          each tool with its whole description and schema, under the name Claude Code
 *                  knows it by. Claude Code shortens a long description it reads from a tool
 *                  server; the runtime's own tools have long ones that say how to use them.
 * Sampling controls (temperature, top_p) are left out: a plan's models refuse them.
 */
export function extraBody(body, listed) {
  const out = {};
  const thinking = body?.thinking;
  if (thinking && typeof thinking === "object" && typeof thinking.type === "string") {
    out.thinking = { type: thinking.type };
    if (typeof thinking.display === "string") out.thinking.display = thinking.display;
    if (Number.isInteger(thinking.budget_tokens)) out.thinking.budget_tokens = thinking.budget_tokens;
  }
  const config = body?.output_config;
  if (config && typeof config === "object") {
    const kept = {};
    if (EFFORTS.includes(config.effort)) kept.effort = config.effort;
    if (config.format && typeof config.format === "object") kept.format = config.format;
    if (Object.keys(kept).length) out.output_config = kept;
  }
  if (Number.isInteger(body?.max_tokens) && body.max_tokens > 0) out.max_tokens = body.max_tokens;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length && body.stop_sequences.every((stop) => typeof stop === "string" && stop)) out.stop_sequences = body.stop_sequences;
  if (listed.length) out.tools = listed.map((tool) => ({ name: PREFIX + tool.name, description: tool.description, input_schema: tool.parameters }));
  return out;
}

/**
 * One id per conversation, so Claude Code names the same scratch folder in every request of it
 * and the start of the request stays the same from run to run (which is what lets it be cached).
 */
export function sessionIdFor(system, first) {
  const hex = createHash("sha256").update(JSON.stringify([system, first ?? null])).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), "4" + hex.slice(13, 16), "8" + hex.slice(17, 20), hex.slice(20, 32)].join("-");
}

/**
 * A request as the runs that wait know it: one mark for each of its turns. A turn's mark is made
 * from the mark before it and the turn as it is replayed; the first is made from everything else
 * the request says (the system prompt, the model, the thinking level, the reply room and the
 * extra fields, which hold every tool with its description and schema). So two requests have the
 * same mark at a turn only when they are the same in all of that and in every turn up to it.
 * A mark is a digest: nothing of a conversation is kept to compare the next request with.
 *   lines  each turn as it is written to Claude Code when it is replayed
 *   kinds  who spoke each turn ("user" or "assistant")
 *   marks  the mark at each turn
 */
export function outline({ system, model, effort, maxTokens, extra, fastMode = false, turns }) {
  const lines = turns.map((frame) => JSON.stringify(frame.type === "user" ? { ...frame, shouldQuery: false } : frame));
  const marks = [];
  let mark = createHash("sha256").update(JSON.stringify([system, model, EFFORTS.includes(effort) ? effort : null, maxTokens, extra, !!fastMode])).digest("hex");
  for (const line of lines) marks.push((mark = createHash("sha256").update(mark).update(line).digest("hex")));
  return { lines, kinds: turns.map((frame) => frame.type), marks };
}

/**
 * Claude Code's command line for one request. Everything that can hold a secret or grow long goes
 * in files. Without the files it is the command line of a run that waits to be told its request
 * (see ClaudePool): the system prompt, the tool server and the extra request fields then arrive as
 * control messages on its input.
 */
export function cliArgs({ model, systemFile, mcpFile, settingsFile, sessionId, logFile }) {
  return [
    "-p",
    ...["--model", model],
    ...["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    // None of its own tools, skills or settings; only the tool list it is handed; one model turn; no tool may run.
    ...["--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"],
    ...["--max-turns", "1", "--permission-mode", "dontAsk", "--no-session-persistence"],
    ...(systemFile ? ["--system-prompt-file", systemFile, "--mcp-config", mcpFile, "--session-id", sessionId] : []),
    // The extra request fields travel in a settings file: a whole tool list is too long for a process's environment.
    ...(settingsFile ? ["--settings", settingsFile] : []),
    // A waiting run keeps Claude Code's own log, which is how it is known to have finished starting (startedUp).
    ...(logFile ? ["--debug-file", logFile] : []),
  ];
}

/**
 * Whether a run of Claude Code has finished the part of its startup that blocks it, read from its
 * own log. Soon after it starts, Claude Code checks whether the system tells it of changed files
 * ("[fs.watch probe] verdict: …"). When the system doesn't in time ("silent", which is what a
 * busy Mac gives), it switches to looking by itself, and while it switches nothing it has read
 * from the model gets out: measured 1 to 13 seconds, beginning anywhere from 2 to 8 seconds after
 * the start. The switch is over when the log says it is looking by itself ("polling every …").
 * Any other verdict means there was no switch. No verdict yet means it isn't known.
 */
export function startedUp(log) {
  const verdict = /\[fs\.watch probe\] verdict: (\w+)/.exec(log)?.[1];
  if (!verdict) return false;
  return verdict !== "silent" || /\(polling every \d+ ?ms\)/.test(log.slice(log.indexOf("[fs.watch probe] verdict:")));
}

/** A run's environment: the person's own, with Claude Code's extras off and the run named for Botkins. */
function runEnvironment(env) {
  const environment = { ...env, ...QUIET, ...CALLER };
  for (const name of DROPPED) delete environment[name];
  return environment;
}

/**
 * Reads a run's output a line at a time: the next thing Claude Code says, or null when it is done
 * (its output closed because it exited). Without a `limit` it waits for as long as it takes: the
 * runtime hanging up (the person's Stop) ends the run, and so does the process exiting.
 */
function reader(child) {
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let timer;
  return {
    /** With a `limit`, silence past it throws a 504. */
    async next(limit) {
      const waited = limit > 0 ? new Promise((_, reject) => (timer = setTimeout(() => reject(new PlanError(504, "api_error", "Claude Code stopped answering.")), limit))) : null;
      try {
        for (;;) {
          const { value, done } = await (waited ? Promise.race([lines.next(), waited]) : lines.next());
          if (done) return null;
          try {
            return JSON.parse(value);
          } catch {
            // Not one of its events (a banner from a wrapper script): the events around it still count.
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
    stop: () => clearTimeout(timer),
  };
}

/**
 * Runs of Claude Code that were started ahead of time and wait for a request. Each serves one
 * request and is then ended; taking one starts another in its place.
 *
 * A waiting run costs nothing of the person's plan: it makes no model request until it is given
 * one. It does hold memory (about 165 MB each, measured), so there are at most `size` of them, and
 * they are ended when no Claude request has come for `idleMs`.
 *
 * One of them less than `size` may have been told a request ahead of time (tellAhead): the
 * request that follows the one being answered now, as far as it is known. Such a run is that
 * conversation's only: a request takes it when it is the same in everything and in every turn the
 * run was told (takeReady), and no other request is ever handed to it.
 */
export class ClaudePool {
  /**
   * @param options.size     How many runs wait. Two: after one is taken for a request, the other
   *                         has still finished starting when the next request follows at once
   *                         (the runtime's request after a tool call).
   * @param options.idleMs   How long without a Claude request before the waiting runs are ended.
   * @param options.settleMs How long after its start a run is taken to have finished starting
   *                         whatever its log says (startedUp reads it from the log; a version of
   *                         Claude Code that words its log differently says nothing readable).
   *                         A request handed to a run that is still starting would have its reply
   *                         stopped in the middle, which is the fault the waiting is for. 0 takes
   *                         every run as started (the tests' stand-in has no startup).
   * @param options.graceMs  How long a request waits for a run that has nearly finished starting
   *                         before it is given a run of its own (takeReady).
   * @param options.staleMs  How long a run told ahead for one conversation is left alone when
   *                         another conversation wants one told ahead (tellAhead).
   * @param options.launch   Starts the program (tests pass their own).
   */
  constructor({ size = 2, idleMs = 10 * 60_000, settleMs = 20_000, graceMs = 1500, staleMs = 15_000, launch = spawn, log = () => {} } = {}) {
    Object.assign(this, { size, idleMs, settleMs, graceMs, staleMs, launch, log });
    this.waiting = [];
    this.key = "";
    this.timer = null;
    // Where the waiting runs keep their logs: a folder only this person can read, emptied as runs end.
    this.logs = null;
    this.started = 0;
    // What the runs that wait were last started for, so one that is ended can be replaced at once.
    this.last = null;
    // The last mark of each request answered lately (follows).
    this.seen = new Set();
    // No run is told ahead before this time: one couldn't be, a moment ago.
    this.rest = 0;
    // How many requests were answered by a run told ahead, by a run handed the request as it came, and by a run of their own.
    this.counts = { ahead: 0, handed: 0, own: 0 };
    this.ticker = null;
    this.watcher = null;
    this.looking = null;
  }
  /** True once a run has finished starting, as its own log says, or has had the longest time allowed for it. */
  settled(run) {
    if (run.settled) return true;
    let over = Date.now() - run.born >= this.settleMs;
    if (!over) {
      try {
        over = !!run.logFile && startedUp(readFileSync(run.logFile, "utf8"));
      } catch {
        // No log yet.
      }
    }
    if (!over) return false;
    run.settled = true;
    clearTimeout(run.due);
    // A request that waits for this run goes on now.
    run.wake?.();
    return true;
  }
  /**
   * Looks at the logs of the runs that are still starting, so that a request waiting for one goes
   * on the moment its startup is over, and a request that comes later reads no log at all. The
   * system is asked to say when a log changes. On a busy Mac it may not say (the very thing Claude
   * Code's own startup stumbles on), so the logs are also read ten times a second until every run
   * has started.
   */
  watch() {
    if (this.ticker) return;
    const look = () => {
      this.looking = null;
      if (!this.waiting.filter((run) => !run.gone && !this.settled(run)).length) this.unwatch();
    };
    this.ticker = setInterval(look, 100);
    this.ticker.unref?.();
    try {
      // Claude Code writes its log a line at a time: many changes in a row are looked at once.
      this.watcher = watch(this.logs, () => {
        this.looking ??= setTimeout(look, 25);
        this.looking.unref?.();
      });
      this.watcher.on("error", () => {});
      this.watcher.unref?.();
    } catch {
      // The system can't say: the logs are read on the clock alone.
    }
  }
  unwatch() {
    clearInterval(this.ticker);
    clearTimeout(this.looking);
    this.ticker = null;
    this.looking = null;
    try {
      this.watcher?.close();
    } catch {
      // Already closed.
    }
    this.watcher = null;
  }
  /** The waiting runs that are still there to be taken. */
  alive() {
    return this.waiting.filter((each) => !each.gone && each.child.exitCode == null);
  }
  /** True when a run was told ahead exactly how this request begins, and the request goes on from there. */
  toldFor(run, shape) {
    return !!run.ahead && !!shape && run.ahead.count < shape.marks.length && shape.marks[run.ahead.count - 1] === run.ahead.mark;
  }
  /**
   * A run for a request with this program and environment, its startup over: the one that was told
   * this request ahead of time when there is one (`shape`, the request as outline() gives it),
   * else one that has been told nothing. When none has finished starting it waits a moment
   * (`graceMs`) for one that is nearly there, and is woken the moment one is. Then it gives null:
   * the request gets a run of its own, as it would without a pool. A request never waits out a
   * whole startup, which on a busy computer takes longer than starting one for it does: a turn
   * that calls many tools makes many requests in a row, and would wait that long for each.
   */
  async takeReady(where, signal, shape) {
    if (this.keyOf(where) !== this.key) return null;
    this.touch();
    const until = Date.now() + this.graceMs;
    for (;;) {
      if (signal?.aborted) throw new PlanError(499, "api_error", "The request was cancelled.");
      const alive = this.alive();
      // The run that was told the most of this request.
      const told = alive.filter((each) => this.toldFor(each, shape)).sort((a, b) => b.ahead.count - a.ahead.count)[0];
      const run = (told && this.settled(told) ? told : null) ?? alive.find((each) => !each.ahead && this.settled(each));
      if (run) {
        this.waiting = this.waiting.filter((each) => each !== run);
        if (run.ahead) run.ahead.taken = true;
        return run;
      }
      // A run told ahead for another conversation is not this request's to wait for.
      const starting = alive.filter((each) => !each.ahead || each === told);
      const left = until - Date.now();
      if (left <= 0 || !starting.length) return null;
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, left);
        signal?.addEventListener("abort", done, { once: true });
        for (const each of starting) each.ready.then(done);
      });
    }
  }
  /** What must be the same for a waiting run to serve a request: the program, its folder and its environment. */
  keyOf({ file, env, cwd }) {
    return createHash("sha256").update(JSON.stringify([file, cwd, Object.entries(env ?? {}).sort()])).digest("hex");
  }
  /** Starts runs until `size` wait, for `model` (the model the next request is most likely to name). */
  ensure({ file, env, cwd, model }) {
    if (!file || typeof model !== "string" || !model || this.size < 1) return;
    const key = this.keyOf({ file, env, cwd });
    // A different program or sign-in environment: the runs that wait were started for another.
    if (key !== this.key) this.stop();
    this.key = key;
    this.last = { file, env, cwd, model };
    this.touch();
    while (this.waiting.length < this.size) {
      let child;
      let logFile;
      try {
        mkdirSync(cwd, { recursive: true });
        this.logs ??= mkdtempSync(join(tmpdir(), "botkins-claude-logs-"));
        logFile = join(this.logs, ++this.started + ".log");
        child = this.launch(file, cliArgs({ model, logFile }), { cwd, env: runEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        this.log("harness: a waiting Claude Code run didn't start: " + (error?.message ?? error));
        return;
      }
      // `ahead` is what the run was told of a request before the request came (tellAhead), or null.
      const run = { child, model, born: Date.now(), read: reader(child), stderr: "", gone: false, logFile, settled: false, ahead: null, due: null };
      // Kept, and woken, when the run's startup is over or the run is gone: what a request waits on.
      run.ready = new Promise((resolve) => (run.wake = resolve));
      child.stderr?.on("data", (chunk) => (run.stderr = (run.stderr + chunk).slice(-2000)));
      child.stdin?.on("error", () => {});
      const drop = () => {
        run.gone = true;
        clearTimeout(run.due);
        run.wake();
        this.waiting = this.waiting.filter((each) => each !== run);
        // The tool server's address a run was told ahead is the run's own: it goes when the run does.
        run.ahead?.endpoint?.close();
        // Its log names the account and the folders it looked in: it goes when the run does.
        rmSync(logFile, { force: true });
      };
      child.once("error", drop);
      child.once("exit", drop);
      this.waiting.push(run);
      if (!this.settled(run)) {
        // The longest a startup is given, to the moment.
        run.due = setTimeout(() => this.settled(run), this.settleMs + 5);
        run.due.unref?.();
      }
    }
    if (this.logs && this.waiting.some((run) => !run.settled)) this.watch();
  }
  /**
   * A run for a request with this program and environment that has been told nothing yet: one that
   * has finished starting when there is one, else the one that has waited longest; null when none waits.
   */
  take(where) {
    if (this.keyOf(where) !== this.key) return null;
    this.touch();
    const free = this.alive().filter((each) => !each.ahead);
    const run = free.find((each) => this.settled(each)) ?? free[0] ?? null;
    if (run) this.waiting = this.waiting.filter((each) => each !== run);
    return run;
  }
  /**
   * Whether a request goes on from one this pool was asked before: the same in everything, with
   * turns added at its end, which is what a harness sends after a tool call. Only for such a
   * request is a run told ahead (tellAhead). A harness that rewrote its conversation from one
   * request to the next would never find the run that was told, and every one would be a run
   * started for nothing.
   */
  follows(shape) {
    const goesOn = shape.marks.slice(0, -1).some((mark) => this.seen.has(mark));
    const last = shape.marks.at(-1);
    this.seen.delete(last);
    this.seen.add(last);
    while (this.seen.size > 64) this.seen.delete(this.seen.values().next().value);
    return goesOn;
  }
  /**
   * Tells a waiting run, ahead of time, the request that will follow the one `shape` outlines: all
   * that this request says (the system prompt, the tool server, the extra fields, the model) and
   * every one of its turns, replayed. What follows is this request with the reply and the tools'
   * results added, so when it comes there are only those to send (takeReady finds the run).
   *
   * A run that was told an earlier state of this conversation and not taken (its startup wasn't
   * over when the request came) is told the turns since, and waits on. At most one run less than
   * `size` is told ahead, so a request of any other conversation still finds a run that was told
   * nothing. A run told for another conversation is left alone until nothing has taken it for
   * `staleMs`; until then this conversation's requests are handed over as they come.
   */
  tellAhead(where, shape, request) {
    if (this.size < 2 || this.keyOf(where) !== this.key || Date.now() < this.rest) return;
    const count = shape.lines.length;
    const mark = shape.marks[count - 1];
    // Runs that were told how this conversation began, the one that was told the most first.
    const [most, ...rest] = this.alive()
      .filter((each) => each.ahead && each.ahead.count <= count && shape.marks[each.ahead.count - 1] === each.ahead.mark)
      .sort((a, b) => b.ahead.count - a.ahead.count);
    // One was told exactly this already (the request was sent again).
    if (most?.ahead.count === count) return;
    for (const each of rest) this.end(each);
    if (most) {
      const from = most.ahead.count;
      Object.assign(most.ahead, { count, mark, at: Date.now() });
      most.ahead.done = most.ahead.done.then((told) => (told ? this.telling(most, this.tell(most, { ...request, shape }, from)) : false));
      return this.topUp();
    }
    const told = this.alive().filter((each) => each.ahead);
    if (told.length >= this.size - 1) {
      const stale = told.find((each) => Date.now() - each.ahead.at >= this.staleMs);
      if (!stale) return this.topUp();
      this.end(stale);
    }
    const free = this.alive().filter((each) => !each.ahead);
    // One that is still starting takes it in as its startup lets it, which is no later than it could be taken at all.
    const run = free.find((each) => this.settled(each)) ?? free[0];
    if (run) {
      run.ahead = { count, mark, at: Date.now(), endpoint: null, taken: false, done: null };
      run.ahead.done = this.telling(run, this.tell(run, { ...request, shape }));
    }
    this.topUp();
  }
  /** Whether a run took in what it was being told. One that didn't is ended, and none is told for a while. */
  telling(run, work) {
    return work.then(
      () => true,
      (error) => {
        // A run that was ended while it was told (the pool stopped, another conversation's turn
        // came), or taken for a request since, is its ender's or that request's to deal with.
        if (run.gone || run.ahead.taken) return false;
        // It refused or didn't answer: it is ended and another is started in its place.
        this.log("harness: a waiting Claude Code run couldn't be told a request ahead: " + (error?.message ?? error));
        this.end(run, true);
        this.topUp();
        return false;
      },
    );
  }
  /**
   * Tells a run a request's beginning: the control messages a hand-over sends, then each turn,
   * replayed and acknowledged. With `from`, the run has all of that up to that turn already.
   */
  async tell(run, { system, tools, extra, effort, maxTokens, model, fastMode, bridge, shape }, from = 0) {
    // A run that is still starting answers when its startup lets it.
    const within = this.settleMs + HANDOVER_MS;
    if (!from) {
      const endpoint = tools.length ? await bridge.open(tools) : null;
      run.ahead.endpoint = endpoint;
      if (run.gone) {
        endpoint?.close();
        throw new Error("The run ended.");
      }
      await handOver(run, { system, endpoint, extra, fastMode, effort, maxTokens, model, within });
    }
    for (const [index, line] of shape.lines.entries()) {
      if (index < from) continue;
      if (run.gone) throw new Error("The run ended.");
      run.child.stdin.write(line + "\n");
      if (shape.kinds[index] !== "user") continue;
      for (;;) {
        const ack = await run.read.next(within);
        if (!ack) throw new Error("The run ended.");
        if (ack.type !== "result") continue;
        if (ack.num_turns !== 0 || ack.is_error) throw new Error("It can't be given a conversation to continue.");
        break;
      }
    }
  }
  /**
   * The reply to the request `shape` outlines called no tool, so no request follows it at once.
   * The run that was told ahead for it is ended, and one that any request can take is started in
   * its place while there is time for it to finish starting.
   */
  release(shape) {
    const count = shape.lines.length;
    for (const each of this.alive()) if (each.ahead?.count === count && each.ahead.mark === shape.marks[count - 1]) this.end(each);
    this.topUp();
  }
  /** Ends one run, with the tool server's address it was told ahead. `failed`: it couldn't be told, so none is for a while. */
  end(run, failed = false) {
    if (failed) this.rest = Date.now() + REST_MS;
    run.gone = true;
    clearTimeout(run.due);
    run.wake?.();
    this.waiting = this.waiting.filter((each) => each !== run);
    run.read.stop();
    run.ahead?.endpoint?.close();
    try {
      run.child.kill();
    } catch {
      // Already gone.
    }
  }
  /** Starts runs in place of ones that were ended, for what the last request asked. */
  topUp() {
    if (this.last && this.key) this.ensure(this.last);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.idleMs);
    this.timer.unref?.();
  }
  /** Ends every run that waits. */
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.unwatch();
    // Nothing is started in place of a run that is ended from here on.
    this.last = null;
    for (const run of this.waiting) this.end(run);
    this.waiting = [];
    if (this.logs) removeLogs(this.logs);
    this.logs = null;
  }
}

/**
 * Removes the folder the waiting runs kept their logs in. A run that was ended a moment ago can
 * still be writing its log, and a folder something is written into can't be removed: it is tried
 * again a few times, shortly. This never fails the caller, which is stopping.
 */
function removeLogs(folder, tries = 5) {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
  } catch {
    if (tries > 0) setTimeout(removeLogs, 100, folder, tries - 1);
  }
}

// How long a waiting run may take to accept a request. One that is still starting answers when its
// startup lets it, which is the same wait a new run would have in the middle of its reply.
const HANDOVER_MS = 15_000;
// How long no run is told ahead after one couldn't be. Requests are handed over as they come meanwhile.
const REST_MS = 60_000;

/**
 * Tells a waiting run its request, with Claude Code's own control messages (the ones its SDK sends):
 * the system prompt, the tool server, the extra request fields and the model. Throws when the run
 * refuses one or doesn't answer in time.
 */
async function handOver(run, { system, endpoint, extra, effort, maxTokens, model, fastMode, within = HANDOVER_MS }) {
  const until = Date.now() + within;
  let sent = 0;
  const control = async (request) => {
    const id = "botkins_" + ++sent;
    run.child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
    for (;;) {
      const event = await run.read.next(Math.max(1, until - Date.now()));
      if (!event) throw new PlanError(500, "api_error", "Claude Code stopped before it took the request.");
      if (event.type !== "control_response" || event.response?.request_id !== id) continue;
      if (event.response.subtype !== "success") throw new PlanError(500, "api_error", "Claude Code refused a part of the request (" + request.subtype + ").");
      return event.response.response;
    }
  };
  await control({ subtype: "initialize", systemPrompt: [system] });
  if (endpoint) await control({ subtype: "mcp_set_servers", servers: { [TOOL_SERVER]: { type: "http", url: endpoint.url, headers: endpoint.headers } } });
  await control({
    subtype: "apply_flag_settings",
    settings: { ...(fastMode && { fastMode: true }), env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extra), ...thinkingLevel(effort), ...(maxTokens && { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) }) } },
  });
  if (run.model !== model) await control({ subtype: "set_model", model });
}

// What Claude Code says went wrong, as the kind of error and status the runtime understands.
const FAILURES = {
  authentication_failed: [401, "authentication_error", "Claude Code isn't signed in. Sign in to Claude under Settings › Model providers."],
  billing_error: [402, "billing_error", null],
  rate_limit: [429, "rate_limit_error", null],
  invalid_request: [400, "invalid_request_error", null],
  server_error: [529, "overloaded_error", null],
};
function failure(code, detail) {
  // Claude Code calls this one "unknown" (2.1.325). As a billing error it is final: a harness doesn't retry it.
  if (/out of extra usage/i.test(detail ?? "")) return new PlanError(402, "billing_error", detail);
  const [status, type, message] = FAILURES[code] ?? [500, "api_error", null];
  return new PlanError(status, type, message ?? (detail || "Claude Code couldn't answer."));
}

/**
 * Answers one Messages request with one run of Claude Code.
 * @param body     The request as the runtime wrote it: { model, system, messages, tools, output_config }.
 * @param options.file     The Claude Code program.
 * @param options.env      Its environment (the person's own, as the Claude provider prepares it).
 * @param options.cwd      A folder of Botkins' own for it to run in, the same every time.
 * @param options.bridge   The local tool server (desktop/providers/toolbridge.mjs), to list the tools.
 * @param options.emit     (event) => void: each stream event of the reply, tool names as the runtime knows them.
 * @param options.signal   Aborts the run (the runtime hung up).
 * @param options.ended    () => void: the reply is whole, so the caller can finish its answer. What
 *                         follows (below) never holds the answer back.
 * @param options.report   (modelUsage) => void: what Claude Code said about the models it used, at
 *                         the end of its run: each one's context window and the most it may write
 *                         on this plan. It is waited for a few seconds after the reply.
 * @param options.pool     A ClaudePool: the request goes to a run that waits, and another is
 *                         started in its place. A request that goes on from the one before finds
 *                         the run that was told it ahead of time, and has only its new turns to
 *                         send. Without a pool, or when the hand-over fails, a run is started for
 *                         the request.
 * Throws PlanError. A failure after the reply began is thrown too; the caller decides how to tell the runtime.
 */
export async function claudeTurn(body, { file, fastMode, env, cwd, bridge, emit, signal, launch = spawn, ended, report, reportMs = 4000, pool, handoverMs = HANDOVER_MS }) {
  if (!file) throw new PlanError(503, "api_error", "Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup, then sign in under Settings › Model providers.");
  if (typeof body?.model !== "string" || !body.model) throw new PlanError(400, "invalid_request_error", "No model was named.");
  const names = toolNames(body.tools);
  const turns = frames(body.messages, names);
  const system = (Array.isArray(body.system) ? body.system.map((block) => block?.text ?? "") : [typeof body.system === "string" ? body.system : ""]).filter(Boolean).join("\n\n");
  const tools = listedTools(body.tools, names);
  mkdirSync(cwd, { recursive: true });
  const extra = extraBody(body, tools);
  const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : 0;
  const effort = body.output_config?.effort;
  const where = { file, env, cwd };
  const shape = pool ? outline({ system, model: body.model, effort, maxTokens, extra, fastMode, turns }) : null;
  // The tool server's address for this request, opened when a run has to be told of it. A run
  // that was told the request ahead of time was given its own.
  let endpoint = null;
  const listing = async () => (endpoint ??= tools.length ? await bridge.open(tools) : null);
  let dir = null;
  let child;
  let read;
  let stopOn = null;
  // How many of the turns the run has been told already.
  let fed = 0;
  // Tells a waiting run the request that follows this one, as far as it is known. Never the request's failure.
  let tellNext = null;
  try {
    let stderr = () => "";
    // The request goes to a run that has finished starting, and another is started in its place.
    // When none is ready the request gets a run of its own, as before:
    // its reply begins as soon as it can, and may be stopped in the middle by that run's startup.
    pool?.ensure({ ...where, model: body.model });
    if (pool?.follows(shape))
      tellNext = () => {
        tellNext = null;
        try {
          pool.tellAhead(where, shape, { system, tools, extra, fastMode, effort, maxTokens, model: body.model, bridge });
        } catch (error) {
          pool.log("harness: " + (error?.message ?? error));
        }
      };
    const waiting = pool ? await pool.takeReady(where, signal, shape) : null;
    if (waiting) {
      child = waiting.child;
      const stop = () => child.kill();
      signal?.addEventListener("abort", stop, { once: true });
      stopOn = stop;
      if (signal?.aborted) stop();
      try {
        if (waiting.ahead) {
          // It was told this request ahead of time, all but the turns since. When it is still
          // being told, that is waited for: it began before the request came.
          let timer;
          const told = await Promise.race([waiting.ahead.done, new Promise((resolve) => (timer = setTimeout(resolve, handoverMs, false)))]);
          clearTimeout(timer);
          if (!told) throw new PlanError(500, "api_error", "Claude Code didn't take the request.");
          endpoint = waiting.ahead.endpoint;
          fed = waiting.ahead.count;
        } else {
          // The run that takes its place starts now, so it has the length of this reply to get ready:
          // the runtime's next request (after a tool call) often follows within seconds.
          pool.ensure({ ...where, model: body.model });
          await handOver(waiting, { system, endpoint: await listing(), extra, fastMode, effort, maxTokens, model: body.model, within: handoverMs });
        }
        read = waiting.read;
        stderr = () => waiting.stderr;
      } catch (error) {
        // It couldn't take the request: it is ended, and a run is started for the request as before.
        if (signal?.aborted) throw new PlanError(499, "api_error", "The request was cancelled.");
        pool.end(waiting, !!waiting.ahead);
        signal?.removeEventListener("abort", stop);
        stopOn = null;
        child = undefined;
      }
    }
    if (!read) {
      await listing();
      dir = mkdtempSync(join(tmpdir(), "botkins-claude-"));
      writeFileSync(join(dir, "system.md"), system, { mode: 0o600 });
      // The tool server's address and its one-time secret travel in a file, not on the command line.
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: endpoint ? { [TOOL_SERVER]: { type: "http", url: endpoint.url, headers: endpoint.headers } } : {} }), { mode: 0o600 });
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...(fastMode && { fastMode: true }), env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extra) } }), { mode: 0o600 });
      const args = cliArgs({ model: body.model, systemFile: join(dir, "system.md"), mcpFile: join(dir, "mcp.json"), settingsFile: join(dir, "settings.json"), sessionId: sessionIdFor(system, turns[0]) });
      const environment = runEnvironment(env);
      Object.assign(environment, thinkingLevel(effort));
      // The most the model may write, as the runtime set it.
      if (maxTokens) environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
      child = launch(file, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let said = "";
      child.stderr?.on("data", (chunk) => (said = (said + chunk).slice(-2000)));
      stderr = () => said;
      child.stdin.on("error", () => {});
      const started = new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => reject(new PlanError(503, "api_error", error.code === "ENOENT" ? "Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup." : "Claude Code didn't start: " + error.message)));
      });
      await started;
      const stop = () => child.kill();
      signal?.addEventListener("abort", stop, { once: true });
      stopOn = stop;
      if (signal?.aborted) stop();
      read = reader(child);
    }
    if (pool) pool.counts[dir ? "own" : fed ? "ahead" : "handed"]++;
    // The next thing Claude Code says, or null when it is done. A run has no silence limit: Claude
    // Code may think or run a tool for as long as it takes, and the person's Stop (the signal) or its exit ends the run.
    const next = (limit) => read.next(limit);
    const said = (ended) => new PlanError(500, "api_error", "Claude Code stopped " + ended + "." + (stderr().trim() ? " " + stderr().trim().split("\n").at(-1).slice(0, 300) : ""));

    for (const [index, frame] of turns.entries()) {
      // A run that was told the request ahead of time has these already.
      if (index < fed) continue;
      const last = index === turns.length - 1;
      const replayed = frame.type === "user" && !last;
      // Every turn but the last goes as it is replayed, which the outline has written out already.
      child.stdin.write((shape && !last ? shape.lines[index] : JSON.stringify(replayed ? { ...frame, shouldQuery: false } : frame)) + "\n");
      if (!replayed) continue;
      // A turn that is only replayed is answered with a result that took no model turn.
      for (;;) {
        const ack = await next();
        if (signal?.aborted) throw new PlanError(499, "api_error", "The request was cancelled.");
        if (!ack) throw said("while it was reading the conversation");
        if (ack.type !== "result") continue;
        if (ack.num_turns !== 0 || ack.is_error) throw new PlanError(500, "api_error", "This Claude Code can't be given a conversation to continue. Update Claude Code and try again.");
        break;
      }
    }
    child.stdin.end();
    if (pool) {
      // The request is on its way. A run takes the place of the one that answers it; and when the
      // request brought a tool's result, the turn is calling tools and another request is likely
      // to follow, so a waiting run is told now all that is known of that one. It has the length
      // of this reply to take it in.
      pool.ensure({ ...where, model: body.model });
      if (turns.at(-1).message.content.some((block) => block?.type === "tool_result")) tellNext?.();
    }

    let began = false;
    let called = false;
    let stopped = false;
    let wrong = null;
    for (;;) {
      const event = await next();
      if (signal?.aborted) throw new PlanError(499, "api_error", "The request was cancelled.");
      if (!event) break;
      if (event.type === "stream_event" && event.event) {
        const native = event.event;
        // Only the first model turn is the reply. Nothing after it is passed on.
        if (stopped) continue;
        if (native.type === "content_block_start" && native.content_block?.type === "tool_use" && native.content_block.name?.startsWith(PREFIX))
          native.content_block = { ...native.content_block, name: names.original(native.content_block.name) };
        began = true;
        emit(native);
        if (native.type === "content_block_start" && native.content_block?.type === "tool_use") {
          // The reply calls a tool, so a request with its result follows.
          called = true;
          tellNext?.();
        }
        if (native.type === "message_stop") {
          stopped = true;
          break;
        }
      } else if (event.type === "assistant" && (event.error || event.message?.error)) {
        const detail = (event.message?.content ?? []).map((block) => block?.text ?? "").join("\n").trim();
        wrong = failure(event.error ?? event.message?.error, detail);
      } else if (event.type === "result" && event.is_error && !began) {
        wrong ??= failure(null, typeof event.result === "string" ? event.result : "");
      }
    }
    if (!stopped) throw wrong ?? said(began ? "in the middle of its reply" : "before it answered");
    ended?.();
    // No tool was called: no request follows at once, and the run that was told one is let go.
    if (pool && !called) {
      try {
        pool.release(shape);
      } catch (error) {
        pool.log("harness: " + (error?.message ?? error));
      }
    }
    if (report) {
      // Claude Code ends its run with a result that names each model's limits. The answer has
      // gone out already; this only listens for a moment, and nothing here can fail the request.
      try {
        const until = Date.now() + reportMs;
        for (let left = reportMs; left > 0 && !signal?.aborted; left = until - Date.now()) {
          const event = await next(left);
          if (!event) break;
          if (event.type !== "result") continue;
          if (event.modelUsage && typeof event.modelUsage === "object") report(event.modelUsage);
          break;
        }
      } catch {
        // It said nothing in time: the limits stay as they were known.
      }
    }
  } finally {
    read?.stop();
    if (stopOn) signal?.removeEventListener("abort", stopOn);
    child?.kill();
    endpoint?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    // However the request was answered, the runs that wait are topped up for the next one.
    pool?.ensure({ file, env, cwd, model: body.model });
  }
}

/** Collects a reply's stream events into the one message a request without streaming expects. */
export function assemble() {
  let message = null;
  const parts = [];
  const text = [];
  return {
    take(event) {
      if (event.type === "message_start") message = { ...event.message, content: [] };
      else if (event.type === "content_block_start") {
        parts[event.index] = { ...event.content_block };
        text[event.index] = "";
      } else if (event.type === "content_block_delta") {
        const part = parts[event.index];
        const delta = event.delta ?? {};
        if (!part) return;
        if (delta.type === "text_delta") part.text = (part.text ?? "") + delta.text;
        else if (delta.type === "thinking_delta") part.thinking = (part.thinking ?? "") + delta.thinking;
        else if (delta.type === "signature_delta") part.signature = (part.signature ?? "") + delta.signature;
        else if (delta.type === "input_json_delta") text[event.index] += delta.partial_json ?? "";
      } else if (event.type === "content_block_stop") {
        const part = parts[event.index];
        if (part?.type === "tool_use") {
          try {
            part.input = text[event.index] ? JSON.parse(text[event.index]) : (part.input ?? {});
          } catch {
            part.input = {};
          }
        }
      } else if (event.type === "message_delta" && message) Object.assign(message, event.delta ?? {}, event.usage && { usage: { ...message.usage, ...event.usage } });
    },
    message: () => (message ? { ...message, content: parts.filter(Boolean) } : null),
  };
}
