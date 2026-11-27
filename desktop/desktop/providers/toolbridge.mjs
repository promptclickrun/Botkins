// The tool bridge: Botkins' own tools, offered to a model backend as an MCP server.
//
// The Copilot runtime takes tool definitions directly. The command-line backends (Codex, Claude
// Code, OpenCode, ACP agents) only take MCP servers, so each of their sessions gets an address
// on this small local server. The address answers on 127.0.0.1 only, and only to the secret the
// session was given; a turn's tools are swapped in when it starts and taken out when it ends.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 8_000_000;

/** What a backend lists: each tool's name, description and schema. */
const signature = (tools) => JSON.stringify([...tools.values()].map((tool) => [tool.name, tool.description ?? "", tool.parameters ?? null]));
/** Tells the backends listening on an address that its tools changed. */
function notify(endpoint) {
  const event = "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n\n";
  for (const stream of endpoint.streams) stream.write(event);
}
/** A tool's result as MCP content. Handlers return text (usually JSON) or throw. */
function content(value) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return [{ type: "text", text }];
}

export class ToolBridge {
  constructor({ name = "botkins", version = "1" } = {}) {
    this.info = { name, version };
    this.endpoints = new Map();
    // Addresses that stay with a conversation: key → endpoint id.
    this.kept = new Map();
    this.server = null;
    this.listening = null;
  }
  /** Starts listening on first use. Resolves with the port. */
  start() {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.handle(request, response));
      server.on("error", reject);
      // Tool calls can run for minutes (a teammate's whole turn), so the socket never times out.
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.keepAliveTimeout = 0;
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        server.unref();
        resolve(server.address().port);
      });
    }).catch((error) => {
      this.listening = null;
      throw error;
    });
    return this.listening;
  }
  async stop() {
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.endpoints.clear();
    this.kept.clear();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  /**
   * Opens an address for one session. Returns { url, headers, authorization, set(tools), close() }.
   * `set` replaces the tools (a session kept between turns gets each turn's own).
   *
   * With `key`, the address belongs to that conversation and stays the same each time it is
   * opened: a backend that keeps a conversation loaded goes on using the address it was first
   * given. Closing it keeps the tools listed but refuses their calls until the next turn's `set`;
   * `forget(key)` removes the address. A change to the list is pushed on the address's event stream.
   *
   * A transport adapter can supply `dispatch(method, params)` for tools/list and tools/call
   * instead of local definitions. The adapter must authorize each upstream invocation.
   */
  async open(tools = [], { key, dispatch } = {}) {
    const port = await this.start();
    let id = key && this.kept.get(key);
    let endpoint = id && this.endpoints.get(id);
    if (!endpoint) {
      id = randomBytes(12).toString("hex");
      endpoint = { secret: Buffer.from(randomBytes(24).toString("base64url")), tools: new Map(), streams: new Set(), idle: false, dispatch };
      this.endpoints.set(id, endpoint);
      if (key) this.kept.set(key, id);
    }
    const set = (list) => {
      const next = new Map((list ?? []).map((tool) => [tool.name, tool]));
      const changed = signature(next) !== signature(endpoint.tools);
      endpoint.tools = next;
      endpoint.idle = false;
      // A backend that keeps its connection (Pi, OMP) lists the tools once; it is told when they change.
      if (changed) notify(endpoint);
    };
    set(tools);
    const authorization = "Bearer " + endpoint.secret.toString();
    return {
      url: "http://127.0.0.1:" + port + "/mcp/" + id,
      authorization,
      headers: { Authorization: authorization },
      set,
      // A kept address keeps listing its tools between turns, so a backend that connects late (a chat warmed
      // ahead of its message) never caches an empty list; a call then says no turn is running.
      close: () => void (key ? (endpoint.idle = true) : this.drop(id)),
    };
  }
  drop(id) {
    const endpoint = this.endpoints.get(id);
    for (const stream of endpoint?.streams ?? []) stream.end();
    this.endpoints.delete(id);
  }
  /** Removes a conversation's kept address, when the conversation is deleted or let go. */
  forget(key) {
    const id = this.kept.get(key);
    if (!id) return;
    this.kept.delete(key);
    this.drop(id);
  }
  endpointFor(request) {
    const id = /^\/mcp\/([0-9a-f]{24})\/?$/.exec(new URL(request.url, "http://127.0.0.1").pathname)?.[1];
    const endpoint = id && this.endpoints.get(id);
    if (!endpoint) return null;
    const given = Buffer.from(/^Bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "");
    return given.length === endpoint.secret.length && timingSafeEqual(given, endpoint.secret) ? endpoint : null;
  }
  async handle(request, response) {
    const send = (status, body) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      response.writeHead(status, { ...(text && { "content-type": "application/json" }), "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
      response.end(text);
    };
    try {
      // A page in a browser must never reach the tools: no browser request carries the secret,
      // and one that names an origin is turned away before anything is read.
      if (request.headers.origin) return send(403, { error: "Forbidden" });
      const endpoint = this.endpointFor(request);
      if (!endpoint) return send(401, { error: "Unauthorized" });
      if (request.method === "DELETE") return send(200, {});
      // The event stream: the only thing it carries is that the tools changed (notifications/tools/list_changed).
      if (request.method === "GET") {
        if (!/text\/event-stream/.test(request.headers.accept ?? "")) return send(405, { error: "Method not allowed" });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.write(": open\n\n");
        endpoint.streams.add(response);
        response.on("close", () => endpoint.streams.delete(response));
        return;
      }
      if (request.method !== "POST") return send(405, { error: "Method not allowed" });
      // Decoded as one stream, so a character split across two chunks arrives whole.
      request.setEncoding("utf8");
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > MAX_BODY) return send(413, { error: "Too large" });
      }
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const batch = Array.isArray(message);
      const replies = (await Promise.all((batch ? message : [message]).map((m) => this.dispatch(endpoint, m)))).filter(Boolean);
      // Notifications and responses get no reply.
      if (!replies.length) return send(202);
      send(200, batch ? replies : replies[0]);
    } catch (error) {
      if (!response.headersSent) send(500, { error: error.message });
      else response.destroy();
    }
  }
  async dispatch(endpoint, message) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") return null;
    const { id, method, params } = message;
    if (id === undefined || id === null) return null;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    if (endpoint.dispatch && (method === "tools/list" || method === "tools/call")) {
      try {
        return ok(await endpoint.dispatch(method, params));
      } catch (error) {
        return { jsonrpc: "2.0", id, error: { code: -32603, message: error.message } };
      }
    }
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: this.info,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: [...endpoint.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.parameters ?? { type: "object", properties: {} },
          })),
        });
      case "tools/call": {
        const tool = endpoint.tools.get(params?.name);
        // A tool that is gone, or called between turns, fails as a tool error, so the model reads why.
        if (!tool) return ok({ content: content("This tool is not available right now."), isError: true });
        if (endpoint.idle) return ok({ content: content("No turn is running in this chat right now. Try again in a moment."), isError: true });
        try {
          return ok({ content: content(await tool.handler(params.arguments ?? {})) });
        } catch (error) {
          return ok({ content: content(error?.message || "The tool failed."), isError: true });
        }
      }
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
    }
  }
}
