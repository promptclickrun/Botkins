// GitHub Copilot's models behind the gateway, for Pi and OMP (gateway.mjs, /copilot).
//
// The harness writes its request in the API the model speaks (Copilot lists which: Anthropic's
// Messages API for Claude, OpenAI's Responses API for GPT, Chat Completions for the rest). The
// gateway sends it on to Copilot's model API as it is (less tool-schema formats Copilot refuses:
// copilotBody), signed with headers the Copilot runtime lent (desktop/providers/copilot/relay.mjs),
// and streams the answer back untouched.
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

// The string formats Copilot's schema compiler knows. It refuses the whole request for any other,
// even on a tool that isn't strict, and MCP servers send others: Home Assistant writes voluptuous's
// vol.Lower and vol.Strip as "format": "lower" and "strip". The server still applies those itself.
const KNOWN_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
// Keywords whose values are data, not schemas: an object there is never cleaned.
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "example"]);

/** A schema without the formats Copilot doesn't know, or the same object when it has none. */
function cleanSchema(schema) {
  if (Array.isArray(schema)) {
    let changed = false;
    const out = schema.map((item) => {
      const next = cleanSchema(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : schema;
  }
  if (!schema || typeof schema !== "object") return schema;
  let out = schema;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "format" && typeof value === "string" && !KNOWN_FORMATS.has(value)) {
      if (out === schema) out = { ...schema };
      delete out.format;
    } else if (!DATA_KEYWORDS.has(key) && value && typeof value === "object") {
      const next = cleanSchema(value);
      if (next !== value) {
        if (out === schema) out = { ...schema };
        out[key] = next;
      }
    }
  }
  return out;
}

/**
 * The request's text with its tools' schemas cleaned (cleanSchema), for each API's tool shape, or
 * the text as it came when no schema needed it.
 */
export function copilotBody(api, body, text) {
  if (!Array.isArray(body?.tools)) return text;
  let changed = false;
  const tools = body.tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    if (api === "messages" && tool.input_schema) {
      const next = cleanSchema(tool.input_schema);
      return next === tool.input_schema ? tool : ((changed = true), { ...tool, input_schema: next });
    }
    if (api === "completions" && tool.function?.parameters) {
      const next = cleanSchema(tool.function.parameters);
      return next === tool.function.parameters ? tool : ((changed = true), { ...tool, function: { ...tool.function, parameters: next } });
    }
    if (api === "responses" && tool.parameters) {
      const next = cleanSchema(tool.parameters);
      return next === tool.parameters ? tool : ((changed = true), { ...tool, parameters: next });
    }
    return tool;
  });
  return changed ? JSON.stringify({ ...body, tools }) : text;
}

/** The address of a Copilot API endpoint, on the host the lent request was for. */
export const copilotUrl = (lent, endpoint) => new URL(lent.url).origin + "/" + endpoint;
