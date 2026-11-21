#!/usr/bin/env node
// A stand-in for a model provider's command-line tool: a small agent that speaks the Agent Client
// Protocol on its standard input and output, as Grok's, Kiro's and the other ACP agents do
// (desktop/providers/acp). It lets the terminal host's tests and its end-to-end check run a whole
// chat (a real process, a signed-in state, a reply that arrives in pieces) on a computer where
// nobody is signed in to anything.
//
//   standin-agent.mjs agent stdio     the agent. Each prompt is answered in pieces, a few words
//                                     at a time, with "Stand-in reply to: <the message>".
//   standin-agent.mjs login           its sign-in: prints a page to open and a one-time code,
//                                     asks for a line, and then counts as signed in.
//   standin-agent.mjs logout          signs out again.
//
// Signed in or not is a file, $STANDIN_AGENT_HOME/auth (else ~/.standin-agent/auth).
// STANDIN_AGENT_PIECE_MS sets the pause between the pieces of a reply (120). A reply is about
// ten pieces, so it lasts over a second: the phone link sends a phone a reply's text at most
// every 200 ms, and a reply that is over sooner reaches the phone whole, in one piece.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.STANDIN_AGENT_HOME || join(homedir(), ".standin-agent");
const auth = join(home, "auth");
const [mode] = process.argv.slice(2);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "login") {
  process.stdout.write("Sign in to the stand-in agent.\nOpen https://example.com/device and enter the code STAND-1234\n");
  process.stdout.write("Paste the confirmation code here > ");
  const line = await new Promise((resolve) => createInterface({ input: process.stdin }).once("line", resolve).once("close", () => resolve("")));
  if (!line.trim()) {
    process.stderr.write("No confirmation code was entered.\n");
    process.exit(1);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(auth, "signed in with " + line.trim().length + " characters\n", { mode: 0o600 });
  process.stdout.write("\nSigned in.\n");
  process.exit(0);
}
if (mode === "logout") {
  rmSync(auth, { force: true });
  process.exit(0);
}
if (mode !== "agent") {
  process.stderr.write("Usage: standin-agent.mjs agent stdio | login | logout\n");
  process.exit(64);
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const pieceMs = Number(process.env.STANDIN_AGENT_PIECE_MS ?? 120);
const cancelled = new Set();
let sessions = 0;
const opened = () => ({ models: { currentModelId: "standin-1", availableModels: [{ modelId: "standin-1", name: "Stand-in 1", description: "Answers with what it was told." }] } });

async function answer(method, params) {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false } }, agentInfo: { name: "standin", title: "Stand-in agent", version: "1.0.0" } };
    case "session/new":
      if (!existsSync(auth)) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      return { sessionId: "standin-" + process.pid + "-" + ++sessions, ...opened() };
    case "session/prompt": {
      const { sessionId, prompt } = params;
      cancelled.delete(sessionId);
      // The person's own words are the last line of what the app sent (its instructions come first).
      const said = String(prompt?.find((part) => part.type === "text")?.text ?? "").trim().split("\n").filter((line) => line.trim()).at(-1) ?? "";
      const reply = "Stand-in reply to: " + said.trim().slice(0, 200) + " — this answer arrives in pieces, a few words at a time, the way a model's does.";
      for (const piece of reply.match(/\S+\s*\S*\s*\S*\s*/g) ?? []) {
        if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
        send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } } } });
        await pause(pieceMs);
      }
      return { stopReason: "end_turn", usage: { inputTokens: said.length, outputTokens: reply.length } };
    }
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "session/cancel") cancelled.add(message.params?.sessionId);
  if (message.id === undefined || !message.method) return;
  try {
    send({ id: message.id, result: await answer(message.method, message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
}).on("close", () => process.exit(0));
