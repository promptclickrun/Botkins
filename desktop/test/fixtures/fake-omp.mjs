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
const ask = (title) =>
  new Promise((resolve) => {
    const id = "ui-" + next++;
    dialogs.set(id, resolve);
    send({ type: "extension_ui_request", id, method: "select", title, options: ["allow", "deny"] });
  });
let aborted = false;

async function turn(text) {
  aborted = false;
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "user" } });
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
    const allowed = answer.value === "allow";
    send({ type: "tool_execution_start", toolCallId, toolName, args: input });
    send({ type: "tool_execution_end", toolCallId, toolName, isError: !allowed, result: { content: [{ type: "text", text: allowed ? "ran" : "The person didn't allow this." }] } });
  }
  if (aborted) {
    send({ type: "agent_end", messages: [], isTerminal: true });
    send({ type: "session_settled" });
    return;
  }
  const reply = text.includes("fail") || text.includes("extra") ? "" : "echo: " + text;
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
