// A stand-in for `omp` (desktop/providers/omp): its current RPC-UI protocol, generated session
// ids, and enough of its events for the adapter's tests. It writes what it saw to FAKE_OMP_LOG.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("omp/19.1.0");
  process.exit(0);
}
const log = (entry) => process.env.FAKE_OMP_LOG && appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify(entry) + "\n");
const described = JSON.parse(readFileSync(process.env.BOTKINS_OMP_SESSION, "utf8"));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
const overlay = args.includes("--config") ? readFileSync(args[args.indexOf("--config") + 1], "utf8") : "";
log({
  started: {
    args,
    cwd: process.cwd(),
    agentDir,
    configDir: process.env.PI_CONFIG_DIR,
    profile: process.env.OMP_PROFILE,
    configFiles: process.env.PI_CONFIG_FILES,
    described,
    config,
    overlay,
  },
});

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
let model = (args[args.indexOf("--model") + 1] ?? "").split("/");
let thinking = args.includes("--thinking") ? args[args.indexOf("--thinking") + 1] : "high";
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "";
const sessionId = resumed || "omp-session-1";
const dialogs = new Map();
let next = 1;
// As Botkins' extension asks (desktop/providers/pi/extension-shared.mjs): "more" is followed by an input for the detail.
const ask = (title, method = "select") =>
  new Promise((resolve) => {
    const id = "ui-" + next++;
    dialogs.set(id, resolve);
    send({ type: "extension_ui_request", id, method, title, ...(method === "select" && { options: ["allow", "deny", "more"] }) });
  });
let aborted = false;
// OMP's own subagents (its `task` tool), as the real OMP 19.1.0 reports them (test/omp-subagent-probe-live.mjs):
// "kids:<name>:<outcome>,…" in a prompt spawns one background child per entry (outcome ok|bad|cancel).
let subagentLevel = "off";
const kidReplies = new Map();
const lifecycle = (payload) => subagentLevel !== "off" && send({ type: "subagent_lifecycle", payload: { agent: "task", agentSource: "bundled", detached: true, ...payload } });
let taskCalls = 0;
// As OMP does: the `task` call is asked about first (Botkins' extension), then its children start as
// background jobs naming it ("<call id>|<item id>"). "kids:a:ok@300" ends child a 300 ms later, after the turn.
async function spawnKids(spec) {
  const toolCallId = "task-" + ++taskCalls;
  const answer = await ask("botkins:permission " + JSON.stringify({ toolCallId, toolName: "task", input: { tasks: spec } }));
  log({ taskCall: { toolCallId, answer: answer.value } });
  if (answer.value !== "allow" && answer.value !== "more") return;
  spec.split(",").forEach((entry, index) => {
    const [name, rest = "ok"] = entry.split(":");
    const [outcome, delay] = rest.split("@");
    const id = "kid-" + name;
    const parentToolCallId = toolCallId + "|fc_" + taskCalls;
    lifecycle({ id, index, parentToolCallId, status: "started" });
    setTimeout(() => {
      if (outcome === "ok") kidReplies.set(id, "kid " + name);
      // A duplicate frame, as a reconnecting bus can send: Botkins must not run a hook twice for it.
      lifecycle({ id, index, parentToolCallId, status: outcome === "ok" ? "completed" : outcome === "cancel" ? "aborted" : "failed" });
      if (outcome === "ok") lifecycle({ id, index, parentToolCallId, status: "completed" });
    }, delay ? Number(delay) : 20 + index * 20);
  });
}

async function turn(text) {
  aborted = false;
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "user" } });
  const kids = /kids:(\S+)/.exec(text);
  if (kids) await spawnKids(kids[1]);
  const bash = /bash:(\S+)/.exec(text);
  const mcp = /mcp:([a-z0-9_-]+):([a-z0-9_-]+)/.exec(text);
  const own = /own:([a-z0-9_-]+)/.exec(text);
  if (bash || mcp || own) {
    const toolCallId = "call-1";
    const toolName = bash ? "bash" : mcp ? `mcp__${mcp[1]}_${mcp[2]}` : `mcp__botkins_${own[1]}`;
    const input = bash ? { command: bash[1] } : mcp ? { id: "x" } : { id: "bot" };
    const server = bash ? undefined : mcp?.[1] ?? "botkins";
    const remoteName = mcp?.[2] ?? own?.[1];
    const call = { toolCallId, toolName, input, ...(server && { mcpServerName: server, mcpToolName: remoteName }) };
    send({ type: "tool_call_pending", toolCallId, toolName });
    const answer = await ask("botkins:permission " + JSON.stringify(call));
    log({ answer });
    let allowed = answer.value === "allow";
    let ran = input;
    let refused = "The person didn't allow this.";
    if (answer.value === "more") {
      const detail = await ask("botkins:detail " + JSON.stringify(toolCallId), "input");
      log({ detail });
      const parsed = detail.cancelled ? null : JSON.parse(detail.value);
      if (parsed?.input) [allowed, ran] = [true, parsed.input];
      else if (parsed?.deny) refused = parsed.reason;
    }
    log({ ran: allowed ? { toolName, input: ran } : null });
    send({ type: "tool_execution_start", toolCallId, toolName, args: ran });
    if (text.includes("slowtool")) await new Promise((resolve) => setTimeout(resolve, 300));
    const failed = allowed && text.includes("badtool");
    let result = { text: !allowed ? refused : failed ? "tool broke" : "ran", isError: !allowed || failed };
    // As the extension does after a tool runs (extension-shared.mjs, tool_result), when a plugin has a result hook.
    const now = JSON.parse(readFileSync(process.env.BOTKINS_OMP_SESSION, "utf8"));
    if (now.postToolUse && !aborted) {
      const answer = await ask("botkins:result " + JSON.stringify({ toolCallId, toolName, input: ran, isError: result.isError, text: result.text, ...(server && { mcpServerName: server, mcpToolName: remoteName }) }), "input");
      if (!answer.cancelled) result = { ...result, ...JSON.parse(answer.value) };
    }
    log({ result });
    send({ type: "tool_execution_end", toolCallId, toolName, isError: result.isError, result: { content: [{ type: "text", text: result.text }] } });
  }
  if (aborted) {
    send({ type: "agent_end", messages: [], isTerminal: true });
    send({ type: "session_settled" });
    return;
  }
  const reply = (text.includes("fail") && !text.includes("failonce")) || text.includes("extra") ? "" : "echo: " + text;
  // A model request that fails once, then works (as Pi's own retry does).
  if (text.includes("failonce")) send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "502 {\"error\":{\"message\":\"flaky\"}}" } });
  const error = text.includes("extra")
    ? '402 {"type":"error","error":{"type":"billing_error","message":"API Error: 400 You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}'
    : "The plan said no.";
  const parts = reply ? [reply.slice(0, 4), reply.slice(4)] : [];
  if (text === "chunked") {
    const frame = Buffer.from(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } }));
    const at = Math.ceil(frame.length / 2);
    [frame.subarray(0, at), frame.subarray(at)].forEach((part, index) =>
      send({ type: "rpc_chunk", chunkId: "chunk-1", index, count: 2, byteLength: frame.length, data: part.toString("base64") }),
    );
  } else {
    for (const part of parts) send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part } });
  }
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      stopReason: reply ? "stop" : "error",
      ...(!reply && { errorMessage: error }),
      usage: { input: 100, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: 127, contextTokens: 126 },
    },
  });
  send({ type: "agent_end", messages: [], isTerminal: true });
  send({ type: "session_settled" });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const command = JSON.parse(line);
    log({ command });
    const ok = (data) => send({ type: "response", id: command.id, command: command.type, success: true, ...(data && { data }) });
    switch (command.type) {
      case "extension_ui_response":
        dialogs.get(command.id)?.(command);
        dialogs.delete(command.id);
        break;
      case "set_subagent_subscription":
        subagentLevel = command.level;
        ok({ level: command.level });
        break;
      case "get_subagent_messages": {
        const reply = kidReplies.get(command.subagentId);
        ok({ sessionFile: "", fromByte: 0, nextByte: 0, reset: false, entries: [], messages: [{ role: "user", content: [{ type: "text", text: "task" }] }, { role: "assistant", content: reply ? [{ type: "text", text: reply }] : [] }] });
        break;
      }
      case "negotiate_protocol":
        ok({ protocolVersion: command.protocolVersion });
        break;
      case "get_state":
        ok({ sessionId, model: { provider: model[0], id: model[1] }, thinkingLevel: thinking, isSettled: true });
        break;
      case "set_model":
        model = [command.provider, command.modelId];
        ok({ provider: command.provider, id: command.modelId });
        break;
      case "set_thinking_level":
        thinking = command.level;
        ok();
        break;
      case "prompt":
        ok({ agentInvoked: true });
        void turn(command.message);
        break;
      case "abort":
        aborted = true;
        ok();
        break;
      case "compact":
        ok({ summary: "short" });
        break;
      default:
        send({ type: "response", id: command.id, command: command.type, success: false, error: "Unknown command" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
