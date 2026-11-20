// A small MCP client (JSON-RPC 2.0 over streamable HTTP) for Composio's endpoint, signed in as the person.
import { accessToken, composioFetch, MCP_URL, renewAfterRefusal } from "./auth";

const PROTOCOL = "2025-06-18";
const VERSION = "0.1.0";
const TIMEOUT = 30_000;

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

type RpcMessage = { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code?: number; message?: string } };

let sessionId: string | null = null;
let opening: Promise<void> | null = null;
let nextId = 1;

/** Forgets the MCP session (after signing out, or when the server forgot it). */
export function resetMcp() {
  sessionId = null;
  opening = null;
}

/** Reads a server-sent-event body until the message with `id` arrives. */
async function readEvents(body: ReadableStream<Uint8Array>, id: number): Promise<RpcMessage | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return data ? match(data, id) : undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let end = /\r?\n\r?\n/.exec(buffer);
      while (end) {
        const found = take(buffer.slice(0, end.index));
        buffer = buffer.slice(end.index + end[0].length);
        if (found) return found;
        end = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) return buffer.trim() ? take(buffer) : undefined;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function match(text: string, id: number): RpcMessage | undefined {
  try {
    const value = JSON.parse(text) as RpcMessage | RpcMessage[];
    const list = Array.isArray(value) ? value : [value];
    return list.find((message) => message && message.id === id);
  } catch {
    return undefined;
  }
}

async function post(payload: object, id: number | null): Promise<{ status: number; message?: RpcMessage }> {
  const token = await accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const send = async (bearer: string) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + bearer,
      "MCP-Protocol-Version": PROTOCOL,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    return composioFetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
  };
  try {
    let response = await send(token);
    if (response.status === 401) response = await send(await renewAfterRefusal(token));
    const session = response.headers.get("mcp-session-id");
    if (session) sessionId = session;
    if (id === null || !response.ok || response.status === 202) {
      await response.text().catch(() => "");
      return { status: response.status };
    }
    const type = response.headers.get("content-type") ?? "";
    const message = type.includes("text/event-stream") && response.body ? await readEvents(response.body, id) : match(await response.text(), id);
    return { status: response.status, message };
  } catch (error) {
    if (controller.signal.aborted) throw new McpError("Composio took too long to answer.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function failure(status: number) {
  if (status === 401 || status === 403) return new McpError("Composio refused the request.", status);
  if (status >= 500) return new McpError("Composio is having trouble. Try again soon.", status);
  return new McpError("Composio didn't take that request.", status);
}

function open(): Promise<void> {
  opening ??= (async () => {
    sessionId = null;
    const id = nextId++;
    const { status, message } = await post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Botkins", version: VERSION } } }, id);
    if (status >= 300 || !message || message.error) throw message?.error?.message ? new McpError(message.error.message) : failure(status || 502);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, null);
  })().catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** Calls a method and returns its result. Opens the session first, and again once if the server forgot it. */
export async function rpc<T = unknown>(method: string, params?: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await open();
    const id = nextId++;
    const { status, message } = await post({ jsonrpc: "2.0", id, method, ...(params && { params }) }, id);
    if (status === 404 && attempt === 0) {
      resetMcp();
      continue;
    }
    if (status >= 300) throw failure(status);
    if (!message) throw new McpError("Composio didn't answer.");
    if (message.error) throw new McpError(message.error.message || "Composio couldn't do that.");
    return message.result as T;
  }
}

export type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };

/** Runs one of Composio's tools. */
export const callTool = (name: string, args: object) => rpc<ToolResult>("tools/call", { name, arguments: args });
