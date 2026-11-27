// The native MCP clients keep their HTTP connections and configuration warm. Give them a
// process-private loopback address instead of a snapshot of the upstream Authorization header.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { challengeParam } from "../../oauth.mjs";

const MCP_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const MAX_BODY = 8_000_000;
const signIn = "This MCP tool needs sign-in. Use the tool's sign-in controls, not the chat.";
const rejected = "The MCP server rejected this call's sign-in. The call was not replayed. Check whether it took effect before trying again.";
const failed = "The MCP request failed. The call was not replayed.";

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

  project(servers, auth) {
    const old = new Map([...this.entries.values()].map((entry) => [entry.key, entry]));
    this.entries.clear();
    return Object.fromEntries(servers.map(([name, config]) => {
      const { oauthId, url, headers, ...native } = config;
      if (!oauthId) return [name, config];
      const key = JSON.stringify([name, oauthId, url, headers]);
      const entry = old.get(key) ?? { key, path: "/mcp/" + randomBytes(32).toString("hex"), url, headers };
      entry.auth = (reason, rejectedAccessToken) => auth({ server: name, serverId: oauthId, url, reason, rejectedAccessToken });
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
      response.writeHead(status, { "cache-control": "no-store", ...(body && { "content-type": "application/json" }) });
      response.end(body);
    };
    const entry = this.entries.get(request.url);
    if (!entry || request.headers.origin || request.headers.host !== "127.0.0.1:" + this.server.address()?.port) return send(403);
    const method = request.method;
    if (!["POST", "GET", "DELETE"].includes(method)) return send(405);
    let body, rpc;
    const abort = new AbortController();
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
        if (!rpc || Array.isArray(rpc) || typeof rpc !== "object") return send(400);
      }
      let token = await entry.auth("initial");
      if (token?.accessToken && token.accessToken === entry.rejected) token = await entry.auth("reauth", entry.rejected);
      if (abort.signal.aborted || this.entries.get(request.url) !== entry) return send(403);
      if (!token?.accessToken || token.accessToken === entry.rejected) return refused(403, signIn);
      const headers = new Headers(entry.headers);
      for (const name of MCP_HEADERS) if (request.headers[name]) headers.set(name, request.headers[name]);
      headers.set("Authorization", (token.tokenType || "Bearer") + " " + token.accessToken);
      const upstream = await fetch(entry.url, { method, headers, body, redirect: "error", signal: abort.signal });
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
