// A stand-in for the Claude Code program, for the tests of desktop/harness/claude.mjs.
//
// Start it the way the real one is started, in place of it: `node fake-claude.mjs <args>`, with the
// arguments cliArgs() builds. It speaks Claude Code's stream-json on stdin and stdout:
//   - for each user frame that says `shouldQuery: false` it answers with a result that took no
//     model turn (after a short pause, so a test can tell that the caller waited for it);
//   - when stdin ends it asks the tool server in its MCP config what tools it lists (and tries
//     one), writes its log, then says the reply FAKE_CLAUDE names:
//       text    one text block, "Hello", ended with end_turn (the default)
//       tool    a tool_use block "mcp__botkins__lookup", its input streamed in pieces
//       auth    the error Claude Code gives when nobody is signed in
//       failed  a result that is an error, with no reply
//       cut     the start of a reply, then the program ends
//       silent  nothing at all, until it is killed (or 30 seconds have gone)
//       crash   a line on stderr and exit code 1
//       rounds:<n>  the tool call while the conversation holds fewer than <n> tool results, then the text
//
// FAKE_CLAUDE_LOG names a file that gets, as JSON, what the program was started with and what it
// was sent: { pid, argv, systemFile, systemPrompt, mcpFile, mcpConfig, settingsFile, settings,
// controls, controlTimes, cwd, env, frames, frameTimes, ackTimes, answeredAt, tools, toolCall }. For
// a run that was told its request by control message, systemPrompt, mcpConfig and settings are
// what those messages said. FAKE_CLAUDE_ACK_MS is how long an acknowledgement is held back (60).
//
// With FAKE_CLAUDE_HEARD set, the reply's message id is "msg_" and a digest of the system prompt
// and the turns this run was given, so a test can tell from a reply alone exactly what the run
// that wrote it was told.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const native = (event) => say({ type: "stream_event", event });

const asked = process.env.FAKE_CLAUDE || "text";
const ackMs = Number(process.env.FAKE_CLAUDE_ACK_MS ?? 60);

// A run that waits keeps a log, and its caller reads from it when the startup is over. With
// FAKE_CLAUDE_STARTUP=ok the log says at once that the system reports changed files; with
// =silent:<ms> it says it doesn't, and <ms> later that it now looks by itself; unset, it says nothing.
const logFile = after("--debug-file");
const startup = process.env.FAKE_CLAUDE_STARTUP;
if (logFile && startup) {
  const stamp = () => new Date().toISOString();
  const [kind, ms] = startup.split(":");
  writeFileSync(logFile, stamp() + " [DEBUG] [fs.watch probe] verdict: " + kind + "\n");
  if (kind === "silent")
    setTimeout(() => appendFileSync(logFile, stamp() + " [DEBUG] Watching for changes in setting files /x/settings.json... (polling every 2000ms)\n"), Number(ms) || 0);
}
const frames = [];
const frameTimes = [];
const ackTimes = [];
const acks = [];
const controls = [];
const controlTimes = [];
const told = (subtype) => controls.find((request) => request.subtype === subtype);

let heard = "fake";
const start = () => native({ type: "message_start", message: { id: "msg_" + heard, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } });
const end = (stop_reason) => {
  native({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 2 } });
  native({ type: "message_stop" });
  // As Claude Code does, the run ends with a result that names each model's limits, a moment
  // after the reply. FAKE_CLAUDE_RESULT=none leaves it out; =late holds it back for 3 seconds.
  const result = () => say({ type: "result", subtype: "success", is_error: false, num_turns: 1, modelUsage: { "claude-fake": { inputTokens: 3, outputTokens: 2, contextWindow: 1000000, maxOutputTokens: 128000 } } });
  const when = process.env.FAKE_CLAUDE_RESULT;
  if (when === "none") return;
  hold = new Promise((resolve) => setTimeout(() => (result(), resolve()), when === "late" ? 3000 : 40));
};
let hold = null;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  // A run that waits is told its request with control messages, each answered (see ClaudePool).
  // FAKE_CLAUDE_CONTROL=refuse answers them with an error; =silent doesn't answer.
  if (frame.type === "control_request") {
    controls.push(frame.request);
    controlTimes.push(Date.now());
    const how = process.env.FAKE_CLAUDE_CONTROL;
    if (how === "silent") return;
    say({ type: "control_response", response: how === "refuse" ? { subtype: "error", request_id: frame.request_id, error: "no" } : { subtype: "success", request_id: frame.request_id, response: {} } });
    return;
  }
  frames.push(frame);
  frameTimes.push(Date.now());
  if (frame.type === "user" && frame.shouldQuery === false) {
    acks.push(
      new Promise((resolve) =>
        setTimeout(() => {
          ackTimes.push(Date.now());
          say({ type: "result", subtype: "success", is_error: false, num_turns: 0 });
          resolve();
        }, ackMs),
      ),
    );
  }
});

// What the tool server in the MCP config says, as Claude Code would ask it.
async function askTools(config) {
  const server = config?.mcpServers?.botkins;
  if (!server) return { tools: null, toolCall: null };
  const call = async (body) => (await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...server.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) })).json();
  try {
    const listed = await call({ method: "tools/list" });
    const first = listed.result.tools[0]?.name;
    const tried = first ? await call({ method: "tools/call", params: { name: first, arguments: {} } }) : null;
    return { tools: listed.result.tools.map((tool) => tool.name), toolCall: tried?.result ?? null };
  } catch (error) {
    return { tools: "error: " + error.message, toolCall: null };
  }
}

lines.on("close", async () => {
  await Promise.all(acks);
  const results = frames.flatMap((frame) => frame.message?.content ?? []).filter((block) => block?.type === "tool_result").length;
  const mode = asked.startsWith("rounds:") ? (results < Number(asked.slice(7)) ? "tool" : "text") : asked;
  const systemFile = after("--system-prompt-file");
  const mcpFile = after("--mcp-config");
  const mcpText = mcpFile && read(mcpFile);
  // A run that waited was told these by control message instead of by file.
  const mcpConfig = mcpText ? JSON.parse(mcpText) : controls.length ? { mcpServers: told("mcp_set_servers")?.servers ?? {} } : null;
  const probe = await askTools(mcpConfig);
  const systemPrompt = systemFile ? read(systemFile) : (told("initialize")?.systemPrompt?.join("\n\n") ?? null);
  if (process.env.FAKE_CLAUDE_HEARD) heard = createHash("sha256").update(JSON.stringify([systemPrompt, frames.map(({ shouldQuery: _replayed, ...frame }) => frame)])).digest("hex").slice(0, 24);
  if (process.env.FAKE_CLAUDE_LOG) {
    const names = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_DISABLE_ARTIFACT", "CLAUDE_CODE_MAX_RETRIES", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"];
    const settingsFile = after("--settings");
    const settingsText = settingsFile && read(settingsFile);
    // The harness treats the log appearing as the signal that this process is ready.
    const pendingLog = process.env.FAKE_CLAUDE_LOG + "." + process.pid + ".tmp";
    writeFileSync(
      pendingLog,
      JSON.stringify({
        pid: process.pid,
        argv,
        systemFile,
        systemPrompt,
        mcpFile,
        mcpConfig,
        settingsFile,
        settings: settingsText ? JSON.parse(settingsText) : (told("apply_flag_settings")?.settings ?? null),
        controls,
        controlTimes,
        answeredAt: Date.now(),
        cwd: process.cwd(),
        env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])),
        frames,
        frameTimes,
        ackTimes,
        ...probe,
      }),
    );
    renameSync(pendingLog, process.env.FAKE_CLAUDE_LOG);
  }

  if (mode === "text") {
    start();
    native({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    native({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    native({ type: "content_block_stop", index: 0 });
    end("end_turn");
  } else if (mode === "tool") {
    start();
    native({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fake", name: "mcp__botkins__lookup", input: {} } });
    for (const piece of ['{"que', 'ry":"x', '"}']) native({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: piece } });
    native({ type: "content_block_stop", index: 0 });
    end("tool_use");
  } else if (mode === "auth") {
    say({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Please run /login" }] } });
    say({ type: "result", subtype: "success", is_error: true, result: "Please run /login" });
  } else if (mode === "extra") {
    // Claude Code 2.1.325's words when a request is billed as extra usage and none is left.
    say({ type: "assistant", error: "unknown", message: { content: [{ type: "text", text: "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going." }] } });
    say({ type: "result", subtype: "success", is_error: true, result: "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going." });
  } else if (mode === "failed") {
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: "The model said no." });
  } else if (mode === "cut") {
    start();
    native({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    native({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } });
  } else if (mode === "silent") {
    // Holds the process open; a limit so that a test that forgot to kill it leaves nothing behind.
    setTimeout(() => {}, 30_000);
  } else if (mode === "crash") {
    process.stderr.write("fake claude: something broke\n");
    process.exitCode = 1;
  }
});
