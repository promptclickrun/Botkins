// A stand-in for `pi` (desktop/providers/pi): `--version`, and `--mode rpc` with just enough of
// Pi's protocol for the adapter's tests. It writes what it was started with to FAKE_PI_LOG.
//
// A prompt containing "bash:<command>" asks Botkins' question (as extension.mjs would) and then
// "runs" the command when allowed; "fail" ends with a model error; anything else is answered
// with "echo: <prompt>". The reply streams as two text deltas.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.6.0");
  process.exit(0);
}
const log = (entry) => process.env.FAKE_PI_LOG && appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(entry) + "\n");
const described = JSON.parse(readFileSync(process.env.BOTKINS_PI_SESSION, "utf8"));
log({ started: { args, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, described } });

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let model = (args[args.indexOf("--model") + 1] ?? "").split("/");
let thinking = args.includes("--thinking") ? args[args.indexOf("--thinking") + 1] : "medium";
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
  if (bash) {
    const call = { toolCallId: "call-1", toolName: "bash", input: { command: bash[1] } };
    send({ type: "tool_execution_start", toolCallId: call.toolCallId, toolName: "bash", args: call.input });
    const answer = await ask("botkins:permission " + JSON.stringify(call));
    log({ answer });
    const allowed = answer.value === "allow";
    send({ type: "tool_execution_end", toolCallId: call.toolCallId, toolName: "bash", isError: !allowed, result: { content: [{ type: "text", text: allowed ? "ran " + bash[1] : "The person didn't allow this." }] } });
  }
  if (aborted) {
    send({ type: "agent_settled", aborted: true });
    return;
  }
  const reply = text.includes("fail") || text.includes("extra") ? "" : "echo: " + text;
  // Pi's own words for a refused request: the status, then the provider's error as JSON.
  const error = text.includes("extra")
    ? '402 {"type":"error","error":{"type":"billing_error","message":"API Error: 400 You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}'
    : "The plan said no.";
  for (const part of reply ? [reply.slice(0, 4), reply.slice(4)] : []) send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part } });
  send({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: reply ? "stop" : "error", ...(!reply && { errorMessage: error }), usage: { input: 100, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: 127 } },
  });
  send({ type: "agent_end", messages: [] });
  send({ type: "agent_settled", aborted: false });
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
      case "get_state":
        ok({ model: { provider: model[0], id: model[1] }, thinkingLevel: thinking });
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
        ok({ disposition: "started" });
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
