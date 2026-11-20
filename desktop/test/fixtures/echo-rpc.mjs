// A stand-in for a command-line backend that talks JSON-RPC over its standard input and output,
// for test/providers-shared.test.mjs. It answers "echo", asks the client a question on "ask",
// sends a notification on "notify", and prints one plain line first, as real tools sometimes do.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const waiting = new Map();
console.log("starting up (not JSON)");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "echo") send({ id: message.id, result: { echoed: message.params, jsonrpc: message.jsonrpc ?? null } });
  else if (message.method === "fail") send({ id: message.id, error: { code: -32000, message: "No, thank you." } });
  else if (message.method === "notify") {
    send({ method: "hello", params: { from: "child" } });
    send({ id: message.id, result: {} });
  } else if (message.method === "ask") {
    // The child asks the client something and passes the answer back.
    waiting.set("q1", message.id);
    send({ id: "q1", method: "question", params: { text: message.params.text } });
  } else if (message.method === "quit") process.exit(3);
  else if (message.id != null && waiting.has(message.id)) {
    send({ id: waiting.get(message.id), result: { answered: message.result ?? null, refused: message.error?.message ?? null } });
    waiting.delete(message.id);
  }
});
