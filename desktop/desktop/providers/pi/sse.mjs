import { Client, SSEClientTransport } from "@modelcontextprotocol/client";
import { ToolBridge } from "../toolbridge.mjs";

const OPEN_MS = 10000;
const errorResult = (text) => ({ isError: true, content: [{ type: "text", text }] });

class Upstream {
  constructor(config) {
    this.config = config;
  }
  open() {
    if (this.pending) return this.pending;
    const url = new URL(this.config.url);
    const client = new Client({ name: "Botkins Pi SSE adapter", version: "1" });
    const transport = new SSEClientTransport(url, {
      requestInit: { headers: this.config.headers },
      fetch: (address, init) => {
        if (new URL(address).origin !== url.origin) throw new Error("Invalid SSE origin");
        return fetch(address, { ...init, redirect: "error" });
      },
    });
    const failed = Promise.withResolvers();
    const timer = setTimeout(() => failed.reject(new Error("SSE connection timed out")), OPEN_MS);
    this.connection = { client, failed };
    client.onerror = () => this.disconnect();
    this.pending = Promise.race([client.connect(transport, { timeout: OPEN_MS }), failed.promise]).then(() => client)
      .catch((error) => {
        if (this.connection?.client === client) this.disconnect();
        throw error;
      }).finally(() => clearTimeout(timer));
    return this.pending;
  }
  disconnect() {
    const connection = this.connection;
    this.connection = this.pending = null;
    if (!connection) return;
    connection.failed.reject(new Error("SSE connection closed"));
    return connection.client.close();
  }
}

/** One Pi process owns its adapter addresses and upstream connections. Pi still sees the original
 * server name. A call also needs the single-use authorization produced by Pi's permission hook. */
export class PiSse {
  bridge = new ToolBridge({ name: "Pi SSE adapter" });
  entries = new Map();

  async records(servers, session) {
    const records = { ...servers };
    for (const [name, entry] of this.entries) {
      if (servers[name]?.type === "sse" && JSON.stringify(servers[name]) === entry.key) continue;
      if (!Object.hasOwn(servers, name)) {
        await entry.upstream.disconnect();
        continue;
      }
      await entry.upstream.disconnect();
      entry.endpoint.close();
      this.entries.delete(name);
    }
    for (const [name, config] of Object.entries(servers)) {
      if (config.type !== "sse") continue;
      let entry = this.entries.get(name);
      if (!entry) {
        const upstream = new Upstream(config);
        const endpoint = await this.bridge.open([], { dispatch: async (method, params) => {
          const current = session();
          const admitted = current && current.spec.mcpServers?.[current.realServerName?.(name) ?? name]?.type === "sse";
          const allowed = method === "tools/call" && admitted && current.takeSseGrant(name, params);
          const unavailable = `${name}: legacy SSE connection failed. Check the server and its sign-in.`;
          if (!admitted || (method === "tools/call" && !allowed)) {
            if (method === "tools/list") return { tools: [] };
            return errorResult("This MCP tool is not approved for the active turn.");
          }
          try {
            const client = await upstream.open();
            if (method === "tools/list") return await client.listTools(params, { timeout: OPEN_MS });
            if (allowed.aborted) return errorResult("The call was stopped.");
            // The convenience callTool helper may retry on header mismatch. A transport failure
            // must never replay an approved call whose side effects may already have happened.
            return await client.request({ method: "tools/call", params }, { signal: allowed });
          } catch {
            if (method === "tools/list") throw new Error(unavailable);
            return errorResult(allowed.aborted ? "The call was stopped." : unavailable);
          }
        } });
        entry = { upstream, endpoint, key: JSON.stringify(config) };
        this.entries.set(name, entry);
      }
      records[name] = { url: entry.endpoint.url, headers: entry.endpoint.headers, exposure: "direct" };
    }
    return records;
  }

  async stop() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all([this.bridge.stop(), ...entries.map(entry => entry.upstream.disconnect())]);
  }
}
