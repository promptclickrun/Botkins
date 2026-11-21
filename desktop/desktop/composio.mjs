// Marketplace › Apps on the computer: the apps of the person's own Composio account, read and
// connected through the computer's Composio tool (the MCP server at https://connect.composio.dev/mcp)
// and its sign-in. The window and a phone ask; this file does the work. It matches the phone's
// src/composio/ (catalog.ts, mcp.ts, connections.ts): the same catalog checks, the same calls of
// COMPOSIO_MANAGE_CONNECTIONS, the same reading of the connected apps.
//
// Requests go only to https://connect.composio.dev (with the computer's own fetch, which follows the
// system's proxy) and to the public catalog. The token comes from the tool's sign-in in the vault
// (desktop/oauth.mjs) and is never logged, returned or kept here.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSIO_METHODS } from "./link/methods.mjs";

/** The app capability a window checks before it shows Apps for a computer it uses from afar. */
export const COMPOSIO_APPS = "composio-apps-v1";

export const MCP_URL = "https://connect.composio.dev/mcp";
export const CATALOG_URL = "https://catalog.bighelp.app/v1/composio/catalog.json";
const CATALOG_MAX_AGE = 60 * 60 * 1000;
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const PROTOCOL = "2025-06-18";
const TIMEOUT = 30_000;
const SLUG = /^[a-z0-9_]{1,64}$/;
const BATCH = 25;
const MAX_SLUGS = 50;
const SIGN_IN_FIRST = "Sign in with Composio first.";

export class ComposioError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ComposioError";
    if (status) this.status = status;
  }
}

const str = (value) => (typeof value === "string" ? value.trim() : "");
const sameUrl = (url) => typeof url === "string" && url.replace(/\/+$/, "").toLowerCase() === MCP_URL;
/** The computer's Composio tool: the remote server at Composio's address. */
export const composioServer = (servers) => (Array.isArray(servers) ? servers.find((server) => server && server.type !== "stdio" && sameUrl(server.url)) : undefined);

// ── The catalog ──────────────────────────────────────────────────────────────────────────────

/** Checks and shapes the catalog, as the phone's parseCatalog. Entries that don't fit are dropped. Throws when the whole thing is wrong. */
export function parseCatalog(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.toolkits) || !Array.isArray(raw.categories)) throw new ComposioError("The app list has a shape this app doesn't know.");
  const names = new Map();
  for (const item of raw.categories) {
    const id = str(item?.id);
    const name = str(item?.name);
    if (id && id.length <= 64 && name && name.length <= 80) names.set(id, name);
  }
  const toolkits = [];
  const seen = new Set();
  const counts = new Map();
  for (const item of raw.toolkits) {
    if (!item || typeof item !== "object") continue;
    const slug = str(item.slug);
    const name = str(item.name);
    if (!SLUG.test(slug) || !name || name.length > 80 || seen.has(slug)) continue;
    const logo = str(item.logo);
    const categories = Array.isArray(item.categories) ? [...new Set(item.categories.map(str).filter((id) => names.has(id)))] : [];
    toolkits.push({ slug, name, description: str(item.description).slice(0, 280), logo: /^https:\/\//i.test(logo) ? logo : null, categories, noAuth: item.noAuth === true });
    seen.add(slug);
    for (const id of categories) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (toolkits.length === 0) throw new ComposioError("The app list is empty.");
  const categories = [...names]
    .map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
    .filter((category) => category.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { revision: str(raw.revision), categories, toolkits };
}

// ── Accounts, as COMPOSIO_MANAGE_CONNECTIONS answers ─────────────────────────────────────────

function statusOf(value) {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (status === "active") return "active";
  if (status === "initiated" || status === "initializing" || status === "pending") return "pending";
  if (status === "failed" || status === "expired") return "failed";
  return "other";
}

function accountsOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : typeof item.account_id === "string" ? item.account_id : "";
    if (!id || id.length > 200) continue;
    const email = typeof item.user_info?.email === "string" ? item.user_info.email : undefined;
    const alias = typeof item.alias === "string" ? item.alias : undefined;
    const label = (email || alias)?.slice(0, 120) || undefined;
    out.push({ id, status: statusOf(item.status), ...(label && { label }) });
  }
  return out;
}

/** The JSON a tool answered with: { successful, data, error }. */
function payloadOf(result) {
  const text = result?.content?.find?.((part) => part?.type === "text" && typeof part.text === "string")?.text;
  let body;
  try {
    body = text ? JSON.parse(text) : result?.structuredContent;
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object") throw new ComposioError("Composio answered in a way the app doesn't know.");
  if (result.isError || body.successful === false) throw new ComposioError(typeof body.error === "string" && body.error.length < 160 ? body.error : "Composio couldn't do that.");
  return body.data && typeof body.data === "object" ? body.data : {};
}

/** One app's entry in data.results (an object by slug; an array is accepted too). */
function resultFor(data, slug) {
  const results = data.results;
  if (Array.isArray(results)) return results.find((entry) => entry && (entry.toolkit === slug || entry.name === slug));
  if (results && typeof results === "object") return results[slug];
  return undefined;
}

// ── Server-sent events ───────────────────────────────────────────────────────────────────────

function match(text, id) {
  try {
    const value = JSON.parse(text);
    return (Array.isArray(value) ? value : [value]).find((message) => message && message.id === id);
  } catch {
    return undefined;
  }
}

/** Reads a server-sent-event body until the message with `id` arrives. */
async function readEvents(body, id) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (block) => {
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

function failure(status) {
  if (status === 401 || status === 403) return new ComposioError("Composio refused the request.", status);
  if (status >= 500) return new ComposioError("Composio is having trouble. Try again soon.", status);
  return new ComposioError("Composio didn't take that request.", status);
}

/**
 * The apps calls of one computer. `workspace` gives `fetch`, `dir` (where the catalog is kept) and
 * `integrations` (the servers, and the sign-in's tokens). `now` and `catalogUrl` are for tests.
 */
export function createComposio(workspace, { now = Date.now, catalogUrl = CATALOG_URL } = {}) {
  const doFetch = (url, init) => (workspace.fetch ?? globalThis.fetch)(url, init);

  // ── The MCP client (JSON-RPC 2.0 over streamable HTTP) ──
  let session = null; // { key, id } — the server it belongs to, and Composio's session id
  let opening = null;
  let nextId = 1;

  /** The Composio tool, or the sentence that says to sign in. */
  const server = () => {
    const found = composioServer(workspace.integrations?.servers);
    if (!found?.oauth) throw new ComposioError(SIGN_IN_FIRST);
    return found;
  };
  const bearer = async (found, reason) => {
    const integrations = workspace.integrations;
    const token = await integrations.oauth.token(found, { reason, client: integrations.client?.(found) });
    if (!token?.accessToken) throw new ComposioError(SIGN_IN_FIRST);
    return (token.tokenType || "Bearer") + " " + token.accessToken;
  };
  const reset = () => {
    session = null;
    opening = null;
  };

  async function post(found, payload, id) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const key = found.id + " " + found.url;
    const send = (authorization) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: authorization, "MCP-Protocol-Version": PROTOCOL };
      if (session?.key === key && session.id) headers["Mcp-Session-Id"] = session.id;
      // Only ever Composio's own address, and no redirect: the token goes nowhere else.
      return doFetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" });
    };
    try {
      let response = await send(await bearer(found, "initial"));
      if (response.status === 401) {
        await response.text().catch(() => "");
        response = await send(await bearer(found, "reauth"));
      }
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId && sessionId.length <= 200) session = { key, id: sessionId };
      if (id === null || !response.ok || response.status === 202) {
        await response.text().catch(() => "");
        return { status: response.status };
      }
      const type = response.headers.get("content-type") ?? "";
      const message = type.includes("text/event-stream") && response.body ? await readEvents(response.body, id) : match(await response.text(), id);
      return { status: response.status, message };
    } catch (error) {
      if (controller.signal.aborted) throw new ComposioError("Composio took too long to answer.");
      if (error instanceof ComposioError) throw error;
      throw new ComposioError("Couldn't reach Composio. Check the connection and try again.");
    } finally {
      clearTimeout(timer);
    }
  }

  function open(found) {
    const key = found.id + " " + found.url;
    opening ??= (async () => {
      session = null;
      const id = nextId++;
      const { status, message } = await post(found, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Botkins", version: String(workspace.version ?? "0.0.0") } } }, id);
      if (status >= 300 || !message || message.error) throw message?.error?.message ? new ComposioError(String(message.error.message).slice(0, 160)) : failure(status || 502);
      await post(found, { jsonrpc: "2.0", method: "notifications/initialized" }, null);
      if (!session) session = { key, id: null };
    })().catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  }

  /** Calls a method and returns its result. Opens the session first, and again once if Composio forgot it. */
  async function rpc(method, params) {
    const found = server();
    if (session && session.key !== found.id + " " + found.url) reset();
    for (let attempt = 0; ; attempt++) {
      await open(found);
      const id = nextId++;
      const { status, message } = await post(found, { jsonrpc: "2.0", id, method, ...(params && { params }) }, id);
      if (status === 404 && attempt === 0) {
        reset();
        continue;
      }
      if (status >= 300) throw failure(status);
      if (!message) throw new ComposioError("Composio didn't answer.");
      if (message.error) throw new ComposioError(String(message.error.message || "Composio couldn't do that.").slice(0, 160));
      return message.result;
    }
  }
  const manage = (toolkits) => rpc("tools/call", { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits } }).then(payloadOf);

  // ── The catalog, kept on disk with its ETag ──
  const bodyFile = workspace.dir ? join(workspace.dir, "composio-catalog.json") : null;
  const metaFile = workspace.dir ? join(workspace.dir, "composio-catalog.meta.json") : null;
  let held = null; // { catalog, etag?, checkedAt }
  let readDisk = false;
  let checking = null;

  const write = (file, text) => {
    try {
      mkdirSync(workspace.dir, { recursive: true });
      const temp = file + ".tmp";
      writeFileSync(temp, text, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // The copy on disk is a convenience; the list still works from memory.
    }
  };
  const fromDisk = () => {
    if (readDisk || held || !bodyFile) return;
    readDisk = true;
    try {
      const catalog = parseCatalog(JSON.parse(readFileSync(bodyFile, "utf8")));
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(metaFile, "utf8"));
      } catch {}
      held = { catalog, etag: typeof meta.etag === "string" ? meta.etag : undefined, checkedAt: typeof meta.checkedAt === "number" ? meta.checkedAt : 0 };
    } catch {
      held = null;
    }
  };
  /** Asks the catalog's server, with the held copy's ETag. */
  const check = () => {
    checking ??= (async () => {
      const headers = { Accept: "application/json" };
      if (held?.etag) headers["If-None-Match"] = held.etag;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      try {
        let response;
        try {
          response = await doFetch(catalogUrl, { headers, signal: controller.signal });
        } catch {
          throw new ComposioError("The app list didn't load.");
        }
        if (response.status === 304 && held) {
          held = { ...held, checkedAt: now() };
          if (metaFile) write(metaFile, JSON.stringify({ etag: held.etag, checkedAt: held.checkedAt }));
          return held.catalog;
        }
        if (!response.ok) throw new ComposioError("The app list didn't load.");
        const text = await response.text();
        if (text.length > CATALOG_MAX_BYTES) throw new ComposioError("The app list is too big.");
        let raw;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new ComposioError("The app list didn't load.");
        }
        const catalog = parseCatalog(raw);
        const etag = response.headers.get("etag") ?? undefined;
        held = { catalog, etag, checkedAt: now() };
        if (bodyFile) {
          write(bodyFile, text);
          write(metaFile, JSON.stringify({ etag, checkedAt: held.checkedAt }));
        }
        return catalog;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      checking = null;
    });
    return checking;
  };

  return {
    /** The saved copy at once when there is one (checked again in the background once it is an hour old); otherwise the server's. */
    async catalog() {
      fromDisk();
      if (!held) return check();
      if (now() - held.checkedAt >= CATALOG_MAX_AGE) check().catch(() => {});
      return held.catalog;
    },
    /** Waits for a check of the catalog that is under way (tests). */
    settled: () => checking?.catch(() => {}) ?? Promise.resolve(),

    /**
     * The apps the person connected, read from the description of Composio's search tool
     * ("User has manually connected the apps: gmail, github."). null when the sentence isn't there.
     */
    async connected() {
      let cursor;
      for (let page = 0; page < 5; page++) {
        const result = await rpc("tools/list", cursor ? { cursor } : undefined);
        const tool = result?.tools?.find?.((entry) => entry?.name === "COMPOSIO_SEARCH_TOOLS");
        if (tool) {
          const found = /connected the apps:\s*([^.]*)\./i.exec(typeof tool.description === "string" ? tool.description : "");
          if (!found) return null;
          return [...new Set(found[1].split(",").map((slug) => slug.trim().toLowerCase()).filter((slug) => SLUG.test(slug)))];
        }
        if (typeof result?.nextCursor !== "string" || !result.nextCursor) return null;
        cursor = result.nextCursor;
      }
      return null;
    },

    /** The accounts of each app, by slug (at most 50). An app with none maps to []. */
    async accounts(slugs) {
      if (!Array.isArray(slugs)) throw new ComposioError("Those apps can't be found.");
      const valid = [...new Set(slugs.filter((slug) => typeof slug === "string" && SLUG.test(slug)))].slice(0, MAX_SLUGS);
      const out = {};
      for (let i = 0; i < valid.length; i += BATCH) {
        const batch = valid.slice(i, i + BATCH);
        const data = await manage(batch.map((name) => ({ name, action: "list" })));
        for (const slug of batch) out[slug] = accountsOf(resultFor(data, slug)?.accounts);
      }
      return out;
    },

    /** Starts connecting an app: the page the person signs in on, and the account it will become. */
    async connect(slug) {
      if (typeof slug !== "string" || !SLUG.test(slug)) throw new ComposioError("That app can't be found.");
      const data = await manage([{ name: slug, action: "add" }]);
      const entry = resultFor(data, slug) ?? {};
      const url = typeof entry.redirect_url === "string" ? entry.redirect_url : typeof entry.redirectUrl === "string" ? entry.redirectUrl : null;
      const accounts = accountsOf(entry.accounts);
      const pendingId = accounts.find((account) => account.status === "pending")?.id ?? (typeof entry.connected_account_id === "string" ? entry.connected_account_id : undefined);
      return { redirectUrl: url && /^https:\/\//i.test(url) ? url : null, ...(pendingId && { pendingId }), accounts };
    },

    async removeAccount(slug, accountId) {
      if (typeof slug !== "string" || !SLUG.test(slug) || typeof accountId !== "string" || !accountId || accountId.length > 200) throw new ComposioError("That account can't be found.");
      await manage([{ name: slug, action: "remove", account_id: accountId }]);
    },

    /** Forgets the MCP session (after the tool signed out, or for tests). */
    reset,
  };
}

/** The window's and the link's calls ("composio.*"). */
export function composioHandlers(workspace, options) {
  const apps = createComposio(workspace, options);
  const handlers = {
    "composio.catalog": () => apps.catalog(),
    "composio.connected": () => apps.connected(),
    "composio.accounts": (slugs) => apps.accounts(slugs),
    "composio.connect": (slug) => apps.connect(slug),
    "composio.removeAccount": (slug, accountId) => apps.removeAccount(slug, accountId).then(() => undefined),
  };
  for (const name of COMPOSIO_METHODS) if (!handlers[name]) throw new Error("composio.mjs has no handler for " + name + ".");
  return handlers;
}
