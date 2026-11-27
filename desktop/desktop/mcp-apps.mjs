// MCP Apps in chat: a tool of an MCP server that declares an interactive view (`_meta.ui.resourceUri`,
// the MCP Apps extension "io.modelcontextprotocol/ui") shows that view in the chat, with the tool's
// actual result, without an integration of Botkins' own for that server.
//
// Botkins owns the call. A server whose tools declare a view (or the computer's Composio tool) is not
// handed to the harness: Botkins connects to it itself (`Upstream`, the official MCP client over
// stdio, Streamable HTTP or SSE, with the server's own sign-in) and gives the bot that server's tools
// as Botkins tools. Every harness reaches Botkins tools (the Copilot SDK directly, the others through
// desktop/providers/toolbridge.mjs), so the original result is in hand here, before any adapter turns
// it into text. Every other server goes to the harness as before.
//
//   - Discovery: the first turn of a bot with a server not yet looked at goes on as before, while Botkins
//     connects to the server in the background and pages through its tools. A server with a view is
//     routed from the next turn; what was found is kept in <data>/mcp-apps.json, by the server's settings.
//   - A call: the model gets the result's text (its structuredContent as JSON when there is no text);
//     never `_meta`. When the tool declares a view, the view's HTML is read through the same connection
//     (MIME type text/html;profile=mcp-app, at most 2 MB), and the turn gets a card (`run.mcpApps`) with
//     a readable summary. The page, the tool's input and its full result are kept on this computer in
//     <data>/mcp-views/<card>/, outside the workspace file and everything a phone syncs. Showing the card
//     again reads them back: it never runs the tool again.
//   - The view's own calls ("mcpApps.callTool", "mcpApps.readResource") go to the server the card came
//     from and nowhere else, with the chat's access checked again each time, the tool's visibility
//     ("app"), and the chat's approvals: a tool that may change something asks the person first
//     unless the chat allows everything.
//   - Composio: COMPOSIO_MANAGE_CONNECTIONS from the computer's Composio tool, recognized by the server
//     and the tool's name, puts a Connect card in the chat for each app it started connecting
//     (desktop/connects.mjs) and tells the model so, without the sign-in page.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { defineTool } from "./providers/provider.mjs";
import { displayValue } from "./display.mjs";
import { searchPath } from "./providers/cli.mjs";
import { composioServer, connectionResults, payloadOf } from "./composio.mjs";

/** The capability a window or a phone checks before it asks for a view. */
export const MCP_APPS = "mcp-apps-v1";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const VIEW_MIME = "text/html;profile=mcp-app";
export const MAX_VIEW_HTML = 2_000_000;
const MAX_PAYLOAD = 1_000_000;
const MAX_ARGS = 200_000;
const MAX_CARDS = 6;
const MAX_DOMAINS = 16;
const CALL_MS = 120_000;
const OPEN_MS = 15_000;
/**
 * How long a turn waits for a routed server that is not connected yet before it falls back to the
 * harness. Launch and opening a chat connect them ahead of the turn (`warm`), so a turn normally
 * finds them ready and waits for nothing; this only bounds the wait for one that is still cold.
 */
const READY_MS = 1_200;
const IDLE_MS = 15 * 60_000;
/** How long a server that couldn't be reached is left alone: its turns go to the harness meanwhile. */
const RETRY_MS = 60_000;
const ID = /^[0-9a-f-]{36}$/;

const str = (value) => (typeof value === "string" ? value : "");
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

/** The view a tool declares: its ui:// address, or null. */
export function viewOf(tool) {
  const uri = tool?._meta?.ui?.resourceUri ?? tool?._meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") && uri.length <= 2048 ? uri : null;
}
/** Who may call a tool: "model", "app", or both (the default). */
export function visibilityOf(tool) {
  const list = tool?._meta?.ui?.visibility;
  const valid = Array.isArray(list) ? list.filter((item) => item === "model" || item === "app") : [];
  return new Set(valid.length ? valid : ["model", "app"]);
}

/**
 * Whether an origin names a host on the internet: not an address (IPv4), not a name that only means
 * something on this network (.local, .lan, .internal, .localhost, .home.arpa), and a wildcard only
 * under a name of at least two labels (`https://*.example.com`, never `https://*.co.uk` or `https://*.com`).
 */
function publicHost(origin) {
  const host = origin.split("://")[1].replace(/:\d+$/, "");
  const name = host.replace(/^\*\./, "");
  if (/^[\d.]+$/.test(name) || /\.(local|lan|internal|localhost|home\.arpa|test|invalid)$/.test(name) || name === "localhost") return false;
  const labels = name.split(".");
  if (host.startsWith("*.") && (labels.length < 2 || (labels.length === 2 && labels[0].length <= 3 && labels[1].length <= 3))) return false;
  return labels.length >= 2;
}

/**
 * The view's content security policy: what the server declared, cut to what Botkins allows. Origins
 * are https (and wss for connections), one host each, a leading "*." at most; nothing else is kept.
 * Scripts and styles may be inline. There are no nested frames, no forms sent anywhere and no base URL.
 */
export function viewCsp(csp) {
  const origins = (list, schemes) =>
    (Array.isArray(list) ? list : [])
      .filter((item) => typeof item === "string" && item.length <= 200)
      .map((item) => item.trim().replace(/\/+$/, "").toLowerCase())
      .filter((item) => new RegExp("^(" + schemes.join("|") + ")://(\\*\\.)?[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d{1,5})?$").test(item) && publicHost(item))
      .map((item) => item.replace(/^(https:\/\/[^/]+):443$|^(wss:\/\/[^/]+):443$/, "$1$2"))
      .slice(0, MAX_DOMAINS);
  const resources = [...new Set(origins(csp?.resourceDomains, ["https"]))];
  const connect = [...new Set(origins(csp?.connectDomains, ["https", "wss"]))];
  const from = (base) => [base, ...resources].join(" ");
  return {
    resourceDomains: resources,
    connectDomains: connect,
    header: [
      "default-src 'none'",
      "script-src " + from("'unsafe-inline'"),
      "style-src " + from("'unsafe-inline'"),
      "img-src " + from("data: blob:"),
      "font-src " + from("data:"),
      "media-src " + from("data: blob:"),
      "connect-src " + (connect.length ? connect.join(" ") : "'none'"),
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "sandbox allow-scripts",
    ].join("; "),
  };
}

/** What a result says, as text for the model and for the card's summary: never `_meta`. */
export function resultText(result) {
  const parts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item?.type === "image" || item?.type === "audio") parts.push("[" + item.type + "]");
    else if (item?.type === "resource" && typeof item.resource?.text === "string") parts.push(item.resource.text);
    else if (item?.type === "resource_link" && typeof item.uri === "string") parts.push(item.uri);
  }
  if (!parts.length && result?.structuredContent && typeof result.structuredContent === "object") parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

const slug = (text) => String(text).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
/** How the Botkins names of a server's tools begin (a long one may be cut short within it). */
export const proxyPrefix = (server) => slug(server) + "__";
/** A Botkins tool's name for a server's tool: letters, digits, _ and -, 64 at most, the same each time. */
export function proxyName(server, tool) {
  const name = proxyPrefix(server) + slug(tool);
  if (name.length <= 64) return name;
  return name.slice(0, 55) + "_" + createHash("sha256").update(server + "\0" + tool).digest("hex").slice(0, 8);
}

/** What makes a server the same server: its kind, its address or program, and which secrets it uses. */
export function serverKey(server) {
  // The secrets are kept as references to the vault: a new value is a new reference, so the key changes with it.
  const shape = { type: server.type, url: server.url, command: server.command, args: server.args, cwd: server.cwd, env: server.env ?? {}, headers: server.headers ?? {}, oauth: !!server.oauth };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 24);
}

/**
 * One connection to a server, made by Botkins with the official MCP client. It says it can show
 * views (the UI extension), pages through the server's tools and hears when they change.
 */
export class Upstream {
  /** `config` is the server as the harness would get it (secrets read); `auth` gives a bearer token for a remote one. */
  constructor(server, config, { version = "0.0.0", auth, fetch = globalThis.fetch } = {}) {
    this.server = server;
    this.key = serverKey(server);
    this.config = config;
    this.version = version;
    this.auth = auth;
    this.fetch = fetch;
    this.client = null;
    this.opening = null;
    this.list = null;
    this.used = Date.now();
  }
  /** `path` is the folders a program is looked for in: the login shell's too, as for the harness's tools (an app opened from Finder has a short PATH). */
  transport(path) {
    const config = this.config;
    if (config.type === "stdio")
      return new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...getDefaultEnvironment(), ...(path && { PATH: path }), ...(config.env ?? {}) }, ...(config.workingDirectory && { cwd: config.workingDirectory }), stderr: "ignore" });
    const origin = new URL(config.url).origin;
    // The server's headers, and its sign-in's token for its own address only. A refused token is renewed once.
    const fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(config.headers ?? {})) if (!headers.has(name)) headers.set(name, value);
      const same = new URL(String(url)).origin === origin;
      if (same && this.auth) {
        const token = await this.auth("initial");
        if (token) headers.set("Authorization", token);
      }
      let response = await this.fetch(url, { ...init, headers, redirect: same ? "error" : init.redirect });
      if (response.status === 401 && same && this.auth) {
        const token = await this.auth("reauth");
        if (token) {
          headers.set("Authorization", token);
          response = await this.fetch(url, { ...init, headers, redirect: "error" });
        }
      }
      return response;
    };
    return config.type === "sse" ? new SSEClientTransport(new URL(config.url), { fetch }) : new StreamableHTTPClientTransport(new URL(config.url), { fetch });
  }
  /** Connects once; a second caller waits for the first. A closed connection never opens again. */
  open() {
    this.used = Date.now();
    if (this.closed) return Promise.reject(new Error(this.server.name + " was disconnected. Try again."));
    if (this.client) return Promise.resolve(this.client);
    this.opening ??= (async () => {
      const client = new Client(
        { name: "Botkins", version: String(this.version) },
        {
          capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEW_MIME] } } },
          // The server's tools changed: the next turn and the next view call list them again.
          listChanged: { tools: { onChanged: () => (this.list = null) } },
        },
      );
      client.onclose = () => {
        if (this.client === client) this.client = null;
        this.list = null;
      };
      await client.connect(this.transport(this.config.type === "stdio" ? await searchPath() : undefined), { timeout: OPEN_MS });
      // Closed while it was connecting: what just started is stopped too (a stdio server's program).
      if (this.closed) {
        await client.close().catch(() => {});
        throw new Error(this.server.name + " was disconnected. Try again.");
      }
      this.client = client;
      return client;
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
  /** The server's tools, every page of them (at most 20 pages). */
  async tools() {
    if (this.list) return this.list;
    const client = await this.open();
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const answer = await client.listTools(cursor ? { cursor } : {}, { timeout: OPEN_MS });
      for (const tool of answer?.tools ?? []) if (tool && typeof tool.name === "string" && tool.name.length <= 128) out.push(tool);
      cursor = answer?.nextCursor;
      if (!cursor) break;
    }
    this.list = out;
    return out;
  }
  async call(name, args) {
    const client = await this.open();
    return client.callTool({ name, arguments: args ?? {} }, { timeout: CALL_MS });
  }
  async read(uri) {
    const client = await this.open();
    return client.readResource({ uri }, { timeout: OPEN_MS });
  }
  async close() {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.list = null;
    await client?.close().catch(() => {});
  }
}

export class McpApps {
  /** `ws` is the workspace. `connect` makes an Upstream (tests give a stand-in). */
  constructor(ws, { connect } = {}) {
    this.ws = ws;
    this.dir = join(ws.dir, "mcp-views");
    this.file = join(ws.dir, "mcp-apps.json");
    this.connect = connect ?? ((server) => this.upstreamFor(server));
    /** server id → Upstream */
    this.upstreams = new Map();
    /** server id → { key, views: boolean } */
    this.known = this.read();
    this.looking = new Map();
    /** server id → when it last couldn't be reached: it is tried again after RETRY_MS. */
    this.failed = new Map();
    /** run → how many views its calls started reading, kept here rather than in the synced run. */
    this.started = new WeakMap();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }
  read() {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  remember(server, views) {
    this.known[server.id] = { key: serverKey(server), views };
    try {
      mkdirSync(this.ws.dir, { recursive: true });
      writeFileSync(this.file + ".tmp", JSON.stringify(this.known), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    } catch {
      // Discovery runs again on the next start.
    }
  }
  upstreamFor(server) {
    const integrations = this.ws.integrations;
    const config = { ...(server.type === "stdio" ? { type: "stdio", command: server.command, args: [...(server.args ?? [])], env: integrations.open(server.env), ...(server.cwd && existsSync(server.cwd) && { workingDirectory: server.cwd }) } : { type: server.type, url: server.url, headers: integrations.open(server.headers) }) };
    const auth = server.oauth
      ? async (reason) => {
          const token = await integrations.oauth.token(server, { reason, client: integrations.client?.(server) });
          return token?.accessToken ? (token.tokenType || "Bearer") + " " + token.accessToken : null;
        }
      : undefined;
    return new Upstream(server, config, { version: this.ws.version, auth, fetch: (url, init) => this.ws.fetch(url, init) });
  }
  /** The connection to a server, made again when its settings changed. */
  upstream(server) {
    const held = this.upstreams.get(server.id);
    if (held && held.key === serverKey(server)) return held;
    held?.close();
    const made = this.connect(server);
    this.upstreams.set(server.id, made);
    return made;
  }
  /** Closes connections nobody used for a while, and those of servers that are gone or off. */
  sweep(now = Date.now()) {
    const servers = new Map((this.ws.integrations?.servers ?? []).map((server) => [server.id, server]));
    for (const [id, upstream] of this.upstreams) {
      const server = servers.get(id);
      if (!server?.enabled || upstream.key !== serverKey(server) || now - upstream.used > IDLE_MS) {
        this.upstreams.delete(id);
        void upstream.close();
      }
    }
  }
  close() {
    clearInterval(this.timer);
    for (const upstream of this.upstreams.values()) void upstream.close();
    this.upstreams.clear();
  }

  /** Whether Botkins should own a server's calls: the Composio tool, or a server found to have views. */
  wanted(server) {
    if (server === composioServer(this.ws.integrations?.servers)) return true;
    const known = this.known[server.id];
    return !!known && known.key === serverKey(server) && known.views;
  }
  /** Looks at a server's tools in the background, once per settings, and keeps whether it has views. */
  discover(server) {
    const key = server.id + " " + serverKey(server);
    if (this.known[server.id]?.key === serverKey(server) || this.looking.has(key) || Date.now() - (this.failed.get(server.id) ?? -Infinity) < RETRY_MS) return;
    const work = (async () => {
      const upstream = this.upstream(server);
      try {
        const tools = await upstream.tools();
        const views = tools.some((tool) => viewOf(tool));
        this.remember(server, views);
        if (!views && !upstream.usedForReads) {
          if (this.upstreams.get(server.id) === upstream) this.upstreams.delete(server.id);
          await upstream.close();
        }
      } catch {
        // A server that can't be reached is looked at again a while later, not at every turn.
        this.failed.set(server.id, Date.now());
        if (this.upstreams.get(server.id) === upstream) this.upstreams.delete(server.id);
        await upstream.close();
      }
    })().finally(() => this.looking.delete(key));
    this.looking.set(key, work);
  }

  /**
   * The servers Botkins runs for this bot's turn instead of the harness: { name → { server, upstream, tools } }.
   * Only servers that answered within a few seconds are taken; any other goes to the harness as before.
   */
  async prepare(bot, { readOnly = false } = {}) {
    const off = new Set(bot?.mcpOff ?? []);
    const servers = (this.ws.integrations?.servers ?? []).filter((server) => server.enabled && !off.has(server.id));
    const routed = new Map();
    const waits = [];
    for (const server of servers) {
      const ready = this.ready(server, readOnly);
      if (!ready) continue;
      const { upstream, tools } = ready;
      const add = (list) => {
        if (!list) return;
        const tools = readOnly ? list.filter((t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true) : list;
        routed.set(server.name, { server, upstream, tools });
      };
      // Connected and listed already (the usual case once warm): taken at once, with no wait.
      if (upstream.list) add(upstream.list);
      else waits.push(tools.then(add));
    }
    if (waits.length) await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, READY_MS).unref?.())]);
    return routed;
  }
  /**
   * Connects the servers Botkins runs, in the background, so a turn finds them ready: at launch
   * (Workspace.warmUp) and when a chat opens (Workspace.warmRoute, through `prepare`).
   */
  warm() {
    for (const server of this.ws.integrations?.servers ?? []) if (server.enabled) this.ready(server);
  }
  /**
   * Starts connecting to a server Botkins runs: { upstream, tools } where `tools` settles to its
   * tools, or to null when it couldn't be reached (it then goes to the harness for a while). Null
   * for a server Botkins doesn't run (it is looked at in the background instead) or one that
   * failed a moment ago (it goes to the harness, without a wait each turn).
   */
  ready(server, readOnly = false) {
    if (!readOnly && !this.wanted(server)) {
      this.discover(server);
      return null;
    }
    if (Date.now() - (this.failed.get(server.id) ?? -Infinity) < RETRY_MS) return null;
    const upstream = this.upstream(server);
    if (readOnly) upstream.usedForReads = true; // A concurrent view-discovery pass must leave this connection open.
    const tools = upstream.tools().catch(() => {
      this.failed.set(server.id, Date.now());
      if (this.upstreams.get(server.id) === upstream) this.upstreams.delete(server.id);
      void upstream.close();
      return null;
    });
    return { upstream, tools };
  }

  /** The routed servers' tools for the model, as Botkins tools. */
  tools(bot, chat, run, task, routed) {
    const out = [];
    const names = new Set();
    for (const { server, upstream, tools } of routed?.values() ?? []) {
      for (const tool of tools) {
        if (!visibilityOf(tool).has("model")) continue;
        const name = proxyName(server.name, tool.name);
        if (names.has(name)) continue;
        names.add(name);
        out.push(
          defineTool(name, {
            description: clip(str(tool.description) || str(tool.title) || tool.name, 2000) + " (" + server.name + ")",
            parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
            // Botkins asks itself (in `invoke`), the same way on every harness: some never ask for a Botkins tool.
            skipPermission: true,
            handler: async (args = {}) => {
              if (task?.stopped || this.ws.closing || (chat && task && this.ws.active.get(chat.id) !== task)) throw new Error("This turn is no longer active");
              if (run?.proactive && (!server.enabled || bot.mcpOff?.includes(server.id) || !this.ws.integrations.servers.includes(server))) throw new Error("This proactive source is no longer enabled.");
              return this.invoke({ bot, chat, run, task }, server, upstream, tool, args);
            },
          }),
        );
      }
    }
    return out;
  }

  /**
   * A call the model made: the text it reads, and a card when the tool has a view. A tool that may
   * change something asks first, as the harness asked for the server's tools before: by the chat's
   * approvals, with the same "Always allow" (desktop/interactions.mjs).
   */
  async invoke({ bot, chat, run, task }, server, upstream, tool, args) {
    if (tool.annotations?.readOnlyHint !== true) {
      const label = server.name + " / " + tool.name;
      const decision = chat && task ? await this.ws.interactions.permission(chat, task, { kind: "mcp", toolName: tool.name, title: "Use " + label + "?", label, preview: displayValue(args, Infinity), remember: ["MCP tool " + server.name + "/" + tool.name, server.name, tool.name], readOnly: false }) : { allow: false };
      if (!decision.allow) throw new Error("The person didn't allow " + label + ".");
    }
    const result = await upstream.call(tool.name, args);
    if (server === composioServer(this.ws.integrations?.servers) && tool.name === "COMPOSIO_MANAGE_CONNECTIONS" && chat && run && !run.proactive) {
      const told = await this.connectCards(bot, chat, run, result);
      if (told) return told;
    }
    const text = resultText(result);
    const uri = viewOf(tool);
    if (uri && run && !run.proactive && chat && !result?.isError) await this.card({ chat, run, server, upstream, tool, uri, args, result, text }).catch(() => {});
    if (result?.isError) throw new Error(text || "The tool failed.");
    return text || "Done.";
  }

  /**
   * Composio started connecting apps: a Connect card for each one, and the model is told so without
   * the page. Answers null when the reply had nothing to connect (the model reads it as it is).
   */
  async connectCards(bot, chat, run, result) {
    let results;
    try {
      results = connectionResults(payloadOf(result));
    } catch {
      return null;
    }
    const waiting = Object.entries(results).filter(([, entry]) => entry.status === "pending" || (entry.status === null && entry.redirectUrl));
    if (!waiting.length || !this.ws.connects) return null;
    const told = {};
    for (const [slug, entry] of Object.entries(results)) {
      if (!waiting.some(([name]) => name === slug)) {
        told[slug] = { status: entry.status ?? "other", ...(entry.error && { error: entry.error }) };
        continue;
      }
      try {
        const state = await this.ws.connects.request(bot, chat, run, slug);
        told[slug] = { status: state.status, ...(state.card && { card: state.card }) };
      } catch (error) {
        told[slug] = { status: "not_shown", error: String(error?.message ?? error).slice(0, 160) };
      }
    }
    return JSON.stringify({
      results: told,
      message: "Botkins shows a Connect card in the chat for each app that needs it. Don't share a connection link. End your reply by telling the person to press Connect; the chat continues by itself once the app is connected.",
    });
  }

  folder(id) {
    if (!ID.test(id)) throw new Error("That view can't be found.");
    return join(this.dir, id);
  }

  /** Reads the tool's view through the same connection and puts its card on the turn. */
  async card({ chat, run, server, upstream, tool, uri, args, result, text }) {
    // Counted before the view is read, so calls side by side can't pass the limit together.
    const started = (this.started.get(run) ?? run.mcpApps?.length ?? 0) + 1;
    this.started.set(run, started);
    if (started > MAX_CARDS) return;
    const read = await upstream.read(uri);
    const item = (read?.contents ?? []).find((entry) => entry?.uri === uri) ?? read?.contents?.[0];
    if (!item || str(item.mimeType).toLowerCase().replace(/\s+/g, "") !== VIEW_MIME) throw new Error("That isn't an MCP App view.");
    const html = typeof item.text === "string" ? item.text : typeof item.blob === "string" ? Buffer.from(item.blob, "base64").toString("utf8") : "";
    if (!html.trim() || html.length > MAX_VIEW_HTML) throw new Error("The view is empty or too big.");
    const ui = item._meta?.ui ?? {};
    const payload = {
      server: server.id,
      key: serverKey(server),
      uri,
      tool: { name: tool.name, ...(tool.title && { title: tool.title }), ...(tool.description && { description: clip(str(tool.description), 2000) }), inputSchema: tool.inputSchema ?? { type: "object" }, ...(tool._meta && { _meta: tool._meta }) },
      input: args ?? {},
      result: { content: Array.isArray(result.content) ? result.content : [], ...(result.structuredContent && { structuredContent: result.structuredContent }), ...(result._meta && { _meta: result._meta }), ...(result.isError && { isError: true }) },
      csp: viewCsp(ui.csp),
      ...(typeof ui.prefersBorder === "boolean" && { prefersBorder: ui.prefersBorder }),
    };
    const json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD) throw new Error("The result is too big for a view.");
    const id = randomUUID();
    mkdirSync(this.folder(id), { recursive: true });
    writeFileSync(join(this.folder(id), "view.html"), html, { mode: 0o600 });
    writeFileSync(join(this.folder(id), "payload.json"), json, { mode: 0o600 });
    (run.mcpApps ??= []).push({ id, server: server.name, tool: tool.name, title: clip(str(tool.title) || tool.name, 80), summary: clip(text.replace(/\s+/g, " ").trim(), 300), at: Date.now() });
    this.ws.save();
    this.ws.notify?.();
  }

  /** A card and its chat, for a call from its view. */
  find(chatId, cardId) {
    const chat = typeof chatId === "string" ? this.ws.state.chats.find((item) => item.id === chatId) : undefined;
    if (chat && typeof cardId === "string")
      for (const run of this.ws.state.runs) {
        if (run.chatId !== chat.id) continue;
        const card = run.mcpApps?.find((item) => item.id === cardId);
        if (card) return { chat, run, card };
      }
    throw new Error("That view can't be found.");
  }
  payload(cardId) {
    try {
      return JSON.parse(readFileSync(join(this.folder(cardId), "payload.json"), "utf8"));
    } catch {
      throw new Error("This view is no longer kept.");
    }
  }
  /** The page of a card's view as the window serves it (desktop/main.mjs), with its policy. */
  page(cardId) {
    const payload = this.payload(cardId);
    return { html: readFileSync(join(this.folder(cardId), "view.html"), "utf8"), csp: payload.csp.header };
  }

  /** Whether a card's view may load or reach an address: one of the https or wss origins its server declared. */
  reaches(cardId, address) {
    let payload;
    let url;
    try {
      payload = this.payload(cardId);
      url = new URL(address);
    } catch {
      return false;
    }
    const allowed = [...payload.csp.resourceDomains, ...payload.csp.connectDomains];
    return allowed.some((origin) => {
      const [scheme, host] = origin.split("://");
      if (url.protocol !== scheme + ":") return false;
      const [name, port = ""] = host.split(/:(?=\d+$)/);
      if (port !== url.port) return false;
      return name.startsWith("*.") ? url.hostname.endsWith(name.slice(1)) && url.hostname.length > name.length - 1 : url.hostname === name.toLowerCase();
    });
  }

  /**
   * What a window or a phone needs to show a card's view: the tool, its input and its result as they
   * were, the policy, and (`html`) the page itself for a host that has no address to load it from.
   */
  view(chatId, cardId, { html = false } = {}) {
    const { card } = this.find(chatId, cardId);
    const payload = this.payload(card.id);
    return {
      id: card.id,
      server: card.server,
      tool: payload.tool,
      input: payload.input,
      result: payload.result,
      csp: { resourceDomains: payload.csp.resourceDomains, connectDomains: payload.csp.connectDomains },
      ...(payload.prefersBorder !== undefined && { prefersBorder: payload.prefersBorder }),
      ...(html && { html: readFileSync(join(this.folder(card.id), "view.html"), "utf8") }),
    };
  }

  /** The server a card came from, if this chat's bot may still use it. */
  async origin(chat, card) {
    const payload = this.payload(card.id);
    const bot = this.ws.state.bots.find((item) => item.id === chat.botId);
    const server = (this.ws.integrations?.servers ?? []).find((item) => item.id === payload.server);
    if (!bot || !server?.enabled || (bot.mcpOff ?? []).includes(server.id) || !this.ws.accessForTurn(chat).mcp) throw new Error("This chat's bot can't use " + card.server + " any more.");
    // The server was changed since (another address or program): the view's calls don't follow it there.
    if (payload.key && payload.key !== serverKey(server)) throw new Error(card.server + " has changed since this view was made.");
    return { server, upstream: this.upstream(server), payload };
  }

  /**
   * A call from a card's view. It goes only to that card's server, only to a tool the view may call,
   * and a tool that may change something needs the person's yes (`approved`) unless the chat allows all.
   * Answers { result } (the tool's whole result, for the view), or { needsApproval } for the window or phone to ask first.
   */
  async callTool(chatId, cardId, name, args = {}, { approved = false } = {}) {
    const { chat, card } = this.find(chatId, cardId);
    const { upstream } = await this.origin(chat, card);
    if (typeof name !== "string" || !name) throw new Error("Name the tool.");
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args) || JSON.stringify(args).length > MAX_ARGS)) throw new Error("Those arguments can't be sent.");
    const tool = (await upstream.tools()).find((item) => item.name === name);
    if (!tool || !visibilityOf(tool).has("app")) throw new Error("This view can't use that tool.");
    const mode = this.ws.effectiveApproval ? this.ws.effectiveApproval(chat) : (chat.approval ?? this.ws.state.settings?.approval);
    if (tool.annotations?.readOnlyHint !== true && mode !== "all" && approved !== true) return { needsApproval: { tool: tool.name, title: clip(str(tool.title) || tool.name, 80), server: card.server } };
    const result = await upstream.call(name, args);
    return { result: { content: Array.isArray(result?.content) ? result.content : [], ...(result?.structuredContent && { structuredContent: result.structuredContent }), ...(result?._meta && { _meta: result._meta }), ...(result?.isError && { isError: true }) } };
  }

  /** A resource a card's view reads from its own server. */
  async readResource(chatId, cardId, uri) {
    const { chat, card } = this.find(chatId, cardId);
    const { upstream } = await this.origin(chat, card);
    if (typeof uri !== "string" || !uri || uri.length > 2048) throw new Error("That resource can't be read.");
    const read = await upstream.read(uri);
    if (JSON.stringify(read ?? {}).length > MAX_VIEW_HTML) throw new Error("That resource is too big.");
    return { contents: read?.contents ?? [] };
  }

  /** A chat is gone: its views go with it. */
  removeChats(chatIds) {
    const ids = new Set(chatIds);
    for (const run of this.ws.state.runs) if (ids.has(run.chatId)) for (const card of run.mcpApps ?? []) rmSync(this.folder(card.id), { recursive: true, force: true });
  }
}

/** The window's and the link's calls ("mcpApps.*"). */
export function mcpAppHandlers(workspace) {
  return {
    "mcpApps.view": (chatId, cardId, options) => workspace.mcpApps.view(chatId, cardId, { html: options?.html === true }),
    "mcpApps.callTool": (chatId, cardId, name, args, options) => workspace.mcpApps.callTool(chatId, cardId, name, args, { approved: options?.approved === true }),
    "mcpApps.readResource": (chatId, cardId, uri) => workspace.mcpApps.readResource(chatId, cardId, uri),
  };
}
