// The native MCP clients keep their HTTP connections and configuration warm. Give them a
// process-private loopback address instead of a snapshot of the upstream Authorization header.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { challengeParam } from "../../oauth.mjs";

const MCP_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const MAX_BODY = 8_000_000;
const PASSIVE_REQUESTS = new Set(["initialize", "ping", "tools/list", "resources/list", "resources/templates/list", "prompts/list"]);
const signIn = "This MCP tool needs sign-in. Use the tool's sign-in controls, not the chat.";
const rejected = "The MCP server rejected this call's sign-in. The call was not replayed. Check whether it took effect before trying again.";
const failed = "The MCP request failed. The call was not replayed. Check whether it took effect before trying again.";

/** Hold the tool POST response until a complete result arrives, not a partial response a client may retry. */
async function toolReply(response, id) {
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.body || !["application/json", "text/event-stream"].includes(mime)) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data = [], bytes = 0;
  const result = (text) => {
    const reply = JSON.parse(text);
    return reply?.jsonrpc === "2.0" && reply.id === id && reply.result && typeof reply.result === "object" && !Array.isArray(reply.result)
      ? { jsonrpc: "2.0", id, result: reply.result } : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value && (bytes += value.byteLength) > MAX_BODY) return null;
      buffer += decoder.decode(value, { stream: !done });
      if (mime === "application/json") {
        if (done) return result(buffer);
        continue;
      }
      for (let at; (at = buffer.search(/[\r\n]/)) !== -1;) {
        if (!done && buffer[at] === "\r" && at === buffer.length - 1) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + (buffer.startsWith("\r\n", at) ? 2 : 1));
        if (line === "" && data.length) {
          const reply = result(data.join("\n"));
          if (reply) return reply;
          data = [];
        } else if (line === "data") data.push("");
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class DirectMcpOAuth {
  static async listen() {
    const relay = new DirectMcpOAuth();
    await new Promise((resolve, reject) => {
      relay.server.once("error", reject);
      relay.server.listen(0, "127.0.0.1", resolve);
    });
    relay.server.unref();
    return relay;
  }

  constructor() {
    this.entries = new Map();
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  project(servers, { auth, takeGrant }) {
    const old = new Map([...this.entries.values()].map((entry) => [entry.key, entry]));
    this.entries.clear();
    return Object.fromEntries(servers.map(([name, config]) => {
      const { oauthId, url, headers, ...native } = config;
      if (!oauthId) return [name, config];
      const key = JSON.stringify([name, oauthId, url, headers]);
      const entry = old.get(key) ?? { key, path: "/mcp/" + randomBytes(32).toString("hex"), url, headers };
      entry.auth = (reason, rejectedAccessToken) => auth({ server: name, serverId: oauthId, url, reason, rejectedAccessToken });
      entry.takeGrant = (params, id) => takeGrant(name, params, id);
      this.entries.set(entry.path, entry);
      return [name, { ...native, url: "http://127.0.0.1:" + this.server.address().port + entry.path }];
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.entries.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  async handle(request, response) {
    const send = (status, body = "") => {
      if (response.destroyed) return;
      response.writeHead(status, { "cache-control": "no-store", ...(body && { "content-type": "application/json" }) });
      response.end(body);
    };
    const entry = this.entries.get(request.url);
    if (!entry || request.headers.origin || request.headers.host !== "127.0.0.1:" + this.server.address()?.port) return send(403);
    const method = request.method;
    if (!["POST", "GET"].includes(method)) return send(405);
    let body, rpc;
    const abort = new AbortController();
    let signal = abort.signal;
    response.once("close", () => abort.abort());
    const refused = (status, text) => {
      // A valid tool result, rather than an HTTP 401 or a disconnected socket, keeps the native
      // client from doing its own OAuth/reconnect retry of a potentially side-effecting call.
      if (rpc?.method === "tools/call" && rpc.id != null)
        return send(200, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text }] } }));
      return send(status);
    };
    try {
      if (method === "POST") {
        request.setEncoding("utf8");
        body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > MAX_BODY) return send(413);
        }
        rpc = JSON.parse(body);
        if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") return send(400);
        const hasId = typeof rpc.id === "string" || Number.isSafeInteger(rpc.id);
        // OMP tries its optional discovery RPC before MCP initialize. Decline it at the relay
        // without touching the upstream or vault; OMP falls back to standard MCP discovery.
        if (hasId && rpc.method === "server/discover")
          return send(200, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }));
        if (rpc.method === "tools/call") {
          const { id, params } = rpc;
          const valid = hasId &&
            typeof params?.name === "string" && (params.arguments === undefined || (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)));
          if (!valid) return send(400);
          const grant = entry.takeGrant(params, id);
          if (!grant) return refused(403, "This MCP tool call was not approved for this turn.");
          signal = AbortSignal.any([abort.signal, grant]);
          // Forward only what was approved, not extra parameters or another interpretation of the wire JSON.
          body = JSON.stringify({ jsonrpc: "2.0", id, method: rpc.method, params: { name: params.name, arguments: params.arguments ?? {} } });
        } else {
          const initialized = rpc.method === "notifications/initialized" && !Object.hasOwn(rpc, "id");
          if (!initialized && !(hasId && PASSIVE_REQUESTS.has(rpc.method))) return send(403);
          body = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, method: rpc.method, params: rpc.params });
        }
      }
      let token = await entry.auth("initial");
      if (token?.accessToken && token.accessToken === entry.rejected) token = await entry.auth("reauth", entry.rejected);
      if (signal.aborted || this.entries.get(request.url) !== entry) return refused(403, failed);
      if (!token?.accessToken || token.accessToken === entry.rejected) return refused(403, signIn);
      const headers = new Headers(entry.headers);
      for (const name of MCP_HEADERS) if (request.headers[name]) headers.set(name, request.headers[name]);
      headers.set("Authorization", (token.tokenType || "Bearer") + " " + token.accessToken);
      const upstream = await fetch(entry.url, { method, headers, body, redirect: "error", signal });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        const challenge = upstream.headers.get("www-authenticate");
        if (upstream.status === 403 && /^Bearer\s/i.test(challenge ?? "") && challengeParam(challenge, "error") === "insufficient_scope") {
          await entry.auth("upscope", token.accessToken);
          return refused(403, signIn);
        }
        if (upstream.status === 401) {
          entry.rejected = token.accessToken;
          return refused(403, rejected);
        }
        return refused(upstream.status, failed);
      }
      if (rpc?.method === "tools/call") {
        const reply = await toolReply(upstream, rpc.id);
        return reply ? send(200, JSON.stringify(reply)) : refused(502, failed);
      }
      const out = { "cache-control": "no-store" };
      for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      response.writeHead(upstream.status, out);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch {
      if (!response.headersSent && !response.destroyed) refused(502, failed);
      else if (!response.destroyed) response.destroy();
    }
  }
}
