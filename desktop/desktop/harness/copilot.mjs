// GitHub Copilot's models behind the gateway, for Pi and OMP (gateway.mjs, /copilot).
//
// The harness writes its request in the API the model speaks (Copilot lists which: Anthropic's
// Messages API for Claude, OpenAI's Responses API for GPT, Chat Completions for the rest). The
// gateway sends it on to Copilot's model API as it is, signed with headers the Copilot runtime
// lent (desktop/providers/copilot/relay.mjs), and streams the answer back untouched.
//
// Copilot counts a request against the plan's premium requests when the person started it and not
// when the model asks again after a tool (the request's X-Initiator header, which the runtime
// sets the same way). So a request whose last turn is a tool's result is the agent's.
import { randomUUID } from "node:crypto";

/** The gateway's paths under /copilot, and the API each is. */
export const COPILOT_ENDPOINTS = { "chat/completions": "completions", responses: "responses", "v1/messages": "messages" };
/** The header each API's own client sends that the gateway passes on. */
const PASSED = { messages: ["anthropic-version", "anthropic-beta"], responses: [], completions: [] };

/** "agent" when the request goes on from a tool's result, else "user" (the person's turn). */
export function initiator(api, body) {
  if (api === "responses") {
    const input = Array.isArray(body?.input) ? body.input : [];
    return input.at(-1)?.type === "function_call_output" ? "agent" : "user";
  }
  const last = Array.isArray(body?.messages) ? body.messages.at(-1) : null;
  if (api === "completions") return last?.role === "tool" ? "agent" : "user";
  return last?.role === "user" && Array.isArray(last.content) && last.content.some((block) => block?.type === "tool_result") ? "agent" : "user";
}

/**
 * The headers of a request to Copilot's model API: the lent ones that say who asks, the harness's
 * own that its API needs, and who started the request. Nothing the harness sent to the gateway to
 * sign in (its secret) goes on.
 */
export function copilotHeaders(lent, api, body, given = {}) {
  const who = initiator(api, body);
  const headers = {
    ...lent.headers,
    "content-type": "application/json",
    accept: String(given.accept ?? "application/json"),
    "x-initiator": who,
    "x-interaction-type": who === "agent" ? "conversation-agent" : "conversation-user",
    "openai-intent": "conversation-agent",
    "x-request-id": randomUUID(),
  };
  for (const name of PASSED[api] ?? []) if (given[name]) headers[name] = String(given[name]);
  if (api === "messages") headers["anthropic-version"] ??= "2023-06-01";
  return headers;
}

/** The address of a Copilot API endpoint, on the host the lent request was for. */
export const copilotUrl = (lent, endpoint) => new URL(lent.url).origin + "/" + endpoint;
