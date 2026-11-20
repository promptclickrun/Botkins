// Sign-in for remote MCP servers that use OAuth, following the MCP authorization rules:
// find the server's authorization server (RFC 9728, RFC 8414, OpenID discovery), register
// Botkins with it when it allows that (RFC 7591), send the person to their browser with PKCE,
// receive the answer on this computer (a loopback address), and keep the tokens in the vault.
// A model provider asks for a token through `token()`, which also renews it without the person.
//
// Nothing here is specific to one model provider. The app's page never sees a token: it asks to
// sign in or out and reads `status()`.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** Where the browser hands the sign-in back. A fixed port, so it can be registered by hand too. */
export const REDIRECT_PORT = 47823;
const redirectUri = (port) => "http://127.0.0.1:" + port + "/callback";
const TIMEOUT = 15000;
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;
const EARLY = 60 * 1000; // a token this close to its end is renewed first

const MAX_ANSWER = 1_000_000; // bytes read from any one answer of a sign-in server

const b64 = (buffer) => buffer.toString("base64url");
/**
 * How far inside the person's network a host is: 2 this computer, 1 the local network (private
 * and link-local addresses, names without a dot, .local and .internal), 0 anywhere else. Only
 * what the address itself says is used; names are not looked up.
 */
export function zone(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return 2;
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    // A name without a dot ("intranet") is a machine on the local network. An IPv6 address has colons instead.
    (!host.includes(".") && !host.includes(":"))
  )
    return 1;
  return 0;
}
/**
 * An address Botkins may contact during a sign-in. It carries tokens, so it is https (plain
 * http only on this computer, for a server that is itself on this computer). A server never
 * sends Botkins further inside the network than the server is itself (`limit` is its zone).
 */
function endpoint(value, what, limit) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("The server gave an invalid " + what + ".");
  }
  const where = zone(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && where === 2 && limit === 2))
    throw new Error("The " + what + " isn't a secure (https) address, so Botkins won't send a sign-in there.");
  if (where > limit) throw new Error("The " + what + " points inside your own network or computer, which this server isn't allowed to ask for.");
  if (url.username || url.password) throw new Error("The server gave an invalid " + what + ".");
  return url.href;
}
/** A response's text, up to a limit: a sign-in server never needs to say more. */
async function capped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return (await response.text()).slice(0, MAX_ANSWER);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER) {
      await reader.cancel().catch(() => {});
      throw new Error("The sign-in server's answer was too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
const sameAddress = (a, b) => String(a).replace(/\/+$/, "") === String(b).replace(/\/+$/, "");
/** The value of one parameter in a WWW-Authenticate header. */
export function challengeParam(header, name) {
  const match = new RegExp("(?:^|[\\s,])" + name + '\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))', "i").exec(header ?? "");
  return match ? (match[1] ?? match[2]) : undefined;
}
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = (title, body) =>
  "<!doctype html><meta charset=utf-8><title>" + escapeHtml(title) + "</title>" +
  "<body style=\"font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center;color:#1a1420\">" +
  "<h1 style=\"font-size:1.4rem\">" + escapeHtml(title) + "</h1><p>" + escapeHtml(body) + "</p></body>";

/**
 * The word in front of a token in the Authorization header. Sign-in servers name it in any case
 * ("bearer", "Bearer", "BEARER"), and the rules say case doesn't matter, but some MCP servers only
 * take "Bearer" exactly: Composio answers "no Authorization: Bearer header" to "bearer". So a
 * bearer token is always sent as "Bearer"; any other kind is left as the server named it.
 */
export const scheme = (type) => (typeof type !== "string" || !type.trim() || /^bearer$/i.test(type.trim()) ? "Bearer" : type.trim());

export class McpOAuth {
  /**
   * @param options.vault   The credential vault (desktop/vault.mjs).
   * @param options.open    (url) → opens the person's browser.
   * @param options.fetch   fetch to use (the app passes one that follows the system's proxy settings).
   * @param options.changed () → called when a server's sign-in state changes.
   */
  constructor({ vault, open, fetch: fetcher = globalThis.fetch, changed = () => {}, port = REDIRECT_PORT, clientName = "Botkins" }) {
    Object.assign(this, { vault, open, fetch: fetcher, changed, port, clientName });
    this.flows = new Map(); // server id → { cancel }
    this.renewals = new Map(); // server id → promise
  }
  entry(server) {
    return "mcp-oauth-" + server.id;
  }
  read(server) {
    const text = this.vault.get(this.entry(server));
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  write(server, data) {
    this.vault.put(JSON.stringify(data), { label: server.name + " sign-in", kind: "oauth", owner: server.vaultOwner ?? "mcp:" + server.id }, this.entry(server));
  }
  /** What the app's page shows about a server's sign-in. */
  status(server) {
    const saved = this.read(server);
    return {
      signedIn: !!saved?.accessToken && !saved.needsSignIn,
      ...(saved?.needsSignIn && { needsSignIn: true }),
      ...(saved?.expiresAt && { expiresAt: saved.expiresAt }),
      ...(saved?.scope && { scope: saved.scope }),
      ...(saved?.issuer && { issuer: saved.issuer }),
      canRenew: !!saved?.refreshToken,
      signingIn: this.flows.has(server.id),
    };
  }
  /**
   * One request to a sign-in address, answered as JSON. A redirect is followed only for a GET, at
   * most three times, and each new address is held to the same rules; a POST is never redirected,
   * so a code or a secret can't be passed on to another address.
   */
  async json(url, init, { limit, what = "sign-in address" } = {}) {
    let target = url;
    for (let hop = 0; ; hop++) {
      const response = await this.fetch(target, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
      const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (next && (!init?.method || init.method === "GET") && hop < 3 && limit !== undefined) {
        await response.body?.cancel?.().catch(() => {});
        target = endpoint(new URL(next, target).href, what, limit);
        continue;
      }
      const text = await capped(response);
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {}
      return { ok: response.ok, status: response.status, body, text, headers: response.headers };
    }
  }
  /**
   * Finds the authorization server for an MCP server: { issuer, meta, scope, resource }.
   * What the server says about its sign-in is checked before it is believed: its description must
   * be about this server, the sign-in server's own description must name the address it was
   * fetched from, and the page the person signs in on must be on that sign-in server.
   */
  async discover(server, hint = {}) {
    const url = new URL(server.url);
    const limit = zone(url.hostname);
    if (url.protocol !== "https:" && limit !== 2) throw new Error("Sign-in needs a secure (https) server address.");
    const own = url.origin + url.pathname.replace(/\/+$/, "");
    let metadataUrl = hint.resourceMetadataUrl;
    let scope = hint.scope;
    if (!metadataUrl) {
      // An unauthenticated request makes the server say where its sign-in lives.
      try {
        const probe = await this.fetch(server.url, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: this.clientName, version: "1" } },
          }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        const challenge = probe.headers.get("www-authenticate");
        metadataUrl = challengeParam(challenge, "resource_metadata");
        scope ??= challengeParam(challenge, "scope");
        await probe.body?.cancel?.().catch(() => {});
      } catch {
        // The well-known addresses below are tried next.
      }
    }
    const path = url.pathname.replace(/\/+$/, "");
    const places = [
      ...(metadataUrl ? [metadataUrl] : []),
      ...(path ? [url.origin + "/.well-known/oauth-protected-resource" + path] : []),
      url.origin + "/.well-known/oauth-protected-resource",
    ];
    /** The description is about this server: the same site, and this server's path or a parent of it (RFC 9728). */
    const aboutThis = (value) => {
      try {
        const named = new URL(String(value));
        const base = named.pathname.replace(/\/+$/, "");
        return named.origin === url.origin && (path === base || path.startsWith(base + "/") || base === "");
      } catch {
        return false;
      }
    };
    let resource = null;
    for (const place of places) {
      try {
        const found = await this.json(endpoint(place, "sign-in information address", limit), undefined, { limit });
        if (found.ok && Array.isArray(found.body?.authorization_servers) && found.body.authorization_servers.length && aboutThis(found.body.resource)) {
          resource = found.body;
          break;
        }
      } catch {}
    }
    const issuer = new URL(endpoint(resource?.authorization_servers?.[0] ?? url.origin, "sign-in server address", limit));
    const issuerPath = issuer.pathname.replace(/\/+$/, "");
    const tries = issuerPath
      ? [
          issuer.origin + "/.well-known/oauth-authorization-server" + issuerPath,
          issuer.origin + "/.well-known/openid-configuration" + issuerPath,
          issuer.origin + issuerPath + "/.well-known/openid-configuration",
        ]
      : [issuer.origin + "/.well-known/oauth-authorization-server", issuer.origin + "/.well-known/openid-configuration"];
    let meta = null;
    for (const place of tries) {
      try {
        const found = await this.json(place, undefined, { limit });
        // The description must be the sign-in server's own (RFC 8414): it names the address it was asked at.
        if (found.ok && found.body?.authorization_endpoint && found.body?.token_endpoint && sameAddress(found.body.issuer, issuer.href)) {
          meta = found.body;
          break;
        }
      } catch {}
    }
    // Servers from before these discovery rules keep their sign-in at fixed paths on the same host.
    if (!meta && !resource)
      meta = {
        issuer: url.origin,
        authorization_endpoint: url.origin + "/authorize",
        token_endpoint: url.origin + "/token",
        registration_endpoint: url.origin + "/register",
      };
    if (!meta) throw new Error("Botkins couldn't find how to sign in to " + server.name + ". Its sign-in information is missing or doesn't match its address.");
    const methods = meta.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256"))
      throw new Error(server.name + " doesn't support the secure sign-in Botkins uses (PKCE with S256).");
    const authorization = endpoint(meta.authorization_endpoint, "sign-in page address", limit);
    // The person signs in on the sign-in server itself. A description can't borrow another service's sign-in page.
    if (new URL(authorization).origin !== new URL(String(meta.issuer)).origin)
      throw new Error(server.name + "'s sign-in page is on a different site than its sign-in server, which Botkins doesn't accept.");
    return {
      issuer: String(meta.issuer).replace(/\/+$/, ""),
      meta: {
        ...meta,
        authorization_endpoint: authorization,
        token_endpoint: endpoint(meta.token_endpoint, "token address", limit),
        ...(meta.registration_endpoint && { registration_endpoint: endpoint(meta.registration_endpoint, "registration address", limit) }),
        ...(meta.revocation_endpoint && { revocation_endpoint: String(meta.revocation_endpoint) }),
      },
      limit,
      scope: scope ?? (Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.join(" ") : undefined),
      // The token is asked for this server and no other (RFC 8707). Anything after "?" stays out of it.
      resource: aboutThis(resource?.resource) ? String(resource.resource) : own,
    };
  }
  /** Listens on this computer for the browser's answer. Resolves { port, wait(state), close }. */
  listen(port) {
    return new Promise((resolve, reject) => {
      let settle;
      const answer = new Promise((done, fail) => (settle = { done, fail }));
      answer.catch(() => {});
      let expected = null;
      const server = createServer((request, response) => {
        const html = (status, title, body) => {
          response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
          response.end(page(title, body));
        };
        // Any page in the person's browser can reach this address, so nothing it sends may throw.
        let url;
        try {
          url = new URL(request.url, "http://127.0.0.1");
        } catch {
          return html(400, "Not found", "This address only finishes a Botkins sign-in.");
        }
        const host = String(request.headers.host ?? "");
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return html(400, "Not found", "This address only finishes a Botkins sign-in.");
        if (request.method !== "GET" || url.pathname !== "/callback") return html(404, "Not found", "This address only finishes a Botkins sign-in.");
        const params = url.searchParams;
        if (!expected || params.get("state") !== expected) return html(400, "Sign-in didn't match", "This answer doesn't belong to the sign-in Botkins started. Start again from Botkins.");
        if (params.get("error")) {
          html(200, "Sign-in wasn't completed", "You can close this tab and return to Botkins.");
          return settle.fail(new Error(params.get("error") === "access_denied" ? "Sign-in was cancelled." : "Sign-in failed: " + (params.get("error_description") || params.get("error")).slice(0, 300)));
        }
        if (!params.get("code")) return html(400, "Sign-in didn't finish", "The answer had no code. Start again from Botkins.");
        html(200, "Signed in", "You can close this tab and return to Botkins.");
        settle.done({ code: params.get("code"), iss: params.get("iss") });
      });
      server.once("error", reject);
      server.on("clientError", (_error, socket) => socket.destroy());
      server.listen(port, "127.0.0.1", () => {
        const timer = setTimeout(() => settle.fail(new Error("Sign-in timed out. Try again.")), SIGN_IN_TIMEOUT);
        resolve({
          port: server.address().port,
          wait: (state) => {
            expected = state;
            return answer;
          },
          cancel: () => settle.fail(new Error("Sign-in was cancelled.")),
          close: () => {
            clearTimeout(timer);
            server.close();
            server.closeAllConnections?.();
          },
        });
      });
    });
  }
  /** POSTs to a token endpoint as the given client. */
  async tokenRequest(meta, client, fields) {
    const body = new URLSearchParams(fields);
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const methods = meta.token_endpoint_auth_methods_supported;
    if (client.clientSecret && (!Array.isArray(methods) || methods.includes("client_secret_basic")))
      headers.authorization = "Basic " + Buffer.from(encodeURIComponent(client.clientId) + ":" + encodeURIComponent(client.clientSecret)).toString("base64");
    else {
      body.set("client_id", client.clientId);
      if (client.clientSecret) body.set("client_secret", client.clientSecret);
    }
    const reply = await this.json(meta.token_endpoint, { method: "POST", headers, body: body.toString() });
    if (!reply.ok || !reply.body?.access_token) {
      const error = new Error(reply.body?.error_description || reply.body?.error || "The sign-in server answered " + reply.status + ".");
      error.code = reply.body?.error;
      throw error;
    }
    return reply.body;
  }
  tokens(reply, previous = {}) {
    return {
      accessToken: String(reply.access_token),
      tokenType: scheme(reply.token_type),
      ...(Number.isFinite(Number(reply.expires_in)) && { expiresAt: Date.now() + Number(reply.expires_in) * 1000 }),
      // A server that rotates refresh tokens sends a new one; otherwise the old one stays good.
      ...((reply.refresh_token ?? previous.refreshToken) && { refreshToken: String(reply.refresh_token ?? previous.refreshToken) }),
      ...((reply.scope ?? previous.scope) && { scope: String(reply.scope ?? previous.scope) }),
    };
  }
  /**
   * Signs the person in through their browser. `client` is { clientId, clientSecret? } when the
   * person entered an app registration by hand, and `hint` what the server said it needs.
   */
  async signIn(server, { client, scope, hint } = {}) {
    if (this.flows.has(server.id)) throw new Error("A sign-in for " + server.name + " is already open in your browser.");
    const flow = { cancelled: false, cancel: () => {} };
    this.flows.set(server.id, flow);
    this.changed();
    let listener;
    try {
      const found = await this.discover(server, hint);
      const { meta } = found;
      const saved = this.read(server) ?? {};
      const wanted = scope || found.scope;
      // The answer comes back to a fixed port. When something else holds it, a registration made
      // for another port can be made again; one typed in by hand can't.
      try {
        listener = await this.listen(this.port);
      } catch (error) {
        if (client || !meta.registration_endpoint) throw new Error("Botkins couldn't listen for the sign-in on port " + this.port + ". Close what is using it and try again.");
        listener = await this.listen(0);
      }
      flow.cancel = listener.cancel;
      if (flow.cancelled) throw new Error("Sign-in was cancelled.");
      const redirect = redirectUri(listener.port);
      let app = client;
      // A secret the person entered was for one sign-in server. It is never sent to another one the
      // server names later; entering it again accepts the new one.
      if (client?.clientSecret && client.boundTo && new URL(meta.token_endpoint).origin !== client.boundTo)
        throw new Error(
          server.name + " now signs in at " + new URL(meta.token_endpoint).host + ", not where its client secret was first used. If that is right, enter the client secret again in this server's sign-in settings.",
        );
      // A registration Botkins made is reused only with the very sign-in server it was made at.
      if (!app && saved.registered && saved.clientId && saved.redirectUri === redirect && saved.issuer === found.issuer && saved.tokenEndpoint === meta.token_endpoint)
        app = { clientId: saved.clientId, clientSecret: saved.clientSecret, registered: true };
      if (!app) {
        if (!meta.registration_endpoint)
          throw new Error(server.name + " doesn't let apps register themselves. Ask whoever runs it for a client ID, and enter it in this server's sign-in settings.");
        const reply = await this.json(meta.registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            client_name: this.clientName,
            redirect_uris: [redirect],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            application_type: "native",
            ...(wanted && { scope: wanted }),
          }),
        });
        if (!reply.ok || !reply.body?.client_id)
          throw new Error(server.name + " didn't accept Botkins' registration" + (reply.body?.error_description ? ": " + String(reply.body.error_description).slice(0, 200) : "."));
        app = { clientId: String(reply.body.client_id), ...(reply.body.client_secret && { clientSecret: String(reply.body.client_secret) }), registered: true };
      }
      const verifier = b64(randomBytes(48));
      const state = b64(randomBytes(24));
      const authorize = new URL(meta.authorization_endpoint);
      for (const [key, value] of Object.entries({
        response_type: "code",
        client_id: app.clientId,
        redirect_uri: redirect,
        state,
        code_challenge: b64(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        resource: found.resource,
        ...(wanted && { scope: wanted }),
      }))
        authorize.searchParams.set(key, value);
      const answered = listener.wait(state);
      await this.open(authorize.href);
      const { code, iss } = await answered;
      // When the server names itself in the answer it must be the one that was asked (RFC 9207),
      // and a server that says it names itself must do so.
      if ((iss && !sameAddress(iss, found.issuer)) || (!iss && meta.authorization_response_iss_parameter_supported === true))
        throw new Error("The sign-in answer came from a different server than the one asked.");
      const reply = await this.tokenRequest(meta, app, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource: found.resource,
      });
      this.write(server, {
        issuer: found.issuer,
        tokenEndpoint: meta.token_endpoint,
        ...(meta.revocation_endpoint && { revocationEndpoint: meta.revocation_endpoint }),
        limit: found.limit,
        ...(Array.isArray(meta.token_endpoint_auth_methods_supported) && { authMethods: meta.token_endpoint_auth_methods_supported }),
        resource: found.resource,
        url: server.url,
        redirectUri: redirect,
        clientId: app.clientId,
        ...(app.registered && { registered: true, ...(app.clientSecret && { clientSecret: app.clientSecret }) }),
        ...this.tokens(reply, { scope: wanted }),
      });
      return this.status(server);
    } finally {
      listener?.close();
      this.flows.delete(server.id);
      this.changed();
    }
  }
  /**
   * Takes a sign-in a paired phone made, so the person doesn't sign in a second time here. The phone
   * hands over its own client and tokens: { clientId, accessToken, refreshToken?, expiresIn?, scope?,
   * redirectUri }. Nothing in the grant chooses an address: every endpoint comes from discovery,
   * exactly as in signIn, so a phone can't point Botkins' tokens anywhere.
   */
  async adopt(server, grant) {
    const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
    if (
      !grant ||
      typeof grant !== "object" ||
      !text(grant.clientId, 4096) ||
      !text(grant.accessToken, 4096) ||
      (grant.refreshToken != null && !text(grant.refreshToken, 4096)) ||
      (grant.expiresIn != null && !(Number.isFinite(grant.expiresIn) && grant.expiresIn > 0)) ||
      (grant.scope != null && !(typeof grant.scope === "string" && grant.scope.length <= 512)) ||
      !(typeof grant.redirectUri === "string" && grant.redirectUri.length <= 512)
    )
      throw new Error("The phone's sign-in for " + server.name + " is incomplete.");
    const found = await this.discover(server);
    const { meta } = found;
    // A browser sign-in that is still open would write over this one.
    this.cancel(server.id);
    this.write(server, {
      issuer: found.issuer,
      tokenEndpoint: meta.token_endpoint,
      ...(meta.revocation_endpoint && { revocationEndpoint: meta.revocation_endpoint }),
      limit: found.limit,
      ...(Array.isArray(meta.token_endpoint_auth_methods_supported) && { authMethods: meta.token_endpoint_auth_methods_supported }),
      resource: found.resource,
      url: server.url,
      redirectUri: grant.redirectUri,
      clientId: grant.clientId,
      registered: true,
      ...this.tokens({
        access_token: grant.accessToken,
        token_type: "Bearer",
        expires_in: grant.expiresIn ?? undefined,
        refresh_token: grant.refreshToken,
        scope: grant.scope,
      }),
    });
    this.changed();
    return this.status(server);
  }
  cancel(serverId) {
    const flow = this.flows.get(serverId);
    if (!flow) return false;
    flow.cancelled = true;
    flow.cancel();
    return true;
  }
  /** Forgets a server's tokens, telling the sign-in server when it offers a way to. */
  async signOut(server) {
    const saved = this.read(server);
    this.cancel(server.id);
    this.vault.remove(this.entry(server));
    this.changed();
    if (saved?.revocationEndpoint && (saved.refreshToken || saved.accessToken)) {
      try {
        await this.fetch(endpoint(saved.revocationEndpoint, "sign-out address", saved.limit ?? 0), {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: saved.refreshToken ?? saved.accessToken, client_id: saved.clientId }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // The tokens are gone from this computer either way.
      }
    }
  }
  /** Marks a server as needing the person to sign in again. */
  lapse(server, saved) {
    if (saved.needsSignIn) return;
    this.write(server, { ...saved, needsSignIn: true });
    this.changed();
  }
  /** Renews a server's access token with its refresh token. One renewal at a time per server. */
  renew(server, client) {
    const running = this.renewals.get(server.id);
    if (running) return running;
    const work = (async () => {
      const saved = this.read(server);
      if (!saved?.refreshToken) return null;
      try {
        const reply = await this.tokenRequest(
          { token_endpoint: endpoint(saved.tokenEndpoint, "token address", saved.limit ?? 0), token_endpoint_auth_methods_supported: saved.authMethods },
          { clientId: saved.clientId, clientSecret: saved.registered ? saved.clientSecret : client?.clientSecret },
          { grant_type: "refresh_token", refresh_token: saved.refreshToken, ...(saved.resource && { resource: saved.resource }) },
        );
        const { needsSignIn: _lapsed, ...rest } = saved;
        const next = { ...rest, ...this.tokens(reply, saved) };
        if (!Number.isFinite(Number(reply.expires_in))) delete next.expiresAt;
        this.write(server, next);
        this.changed();
        return next;
      } catch (error) {
        // The sign-in itself has ended (revoked or expired). Anything else may work next time.
        if (error.code === "invalid_grant" || error.code === "invalid_client") {
          const { accessToken: _a, refreshToken: _r, expiresAt: _e, ...rest } = saved;
          this.write(server, { ...rest, needsSignIn: true });
          this.changed();
        }
        return null;
      }
    })().finally(() => this.renewals.delete(server.id));
    this.renewals.set(server.id, work);
    return work;
  }
  /**
   * A token for a server's requests, without involving the person: the saved one while it is
   * good, a renewed one when it isn't or when the server turned it down. Returns
   * { accessToken, tokenType, expiresIn? } or null when the person has to sign in.
   * @param request.reason "initial" | "refresh" | "reauth" | "upscope"
   */
  async token(server, { reason = "initial", client } = {}) {
    let saved = this.read(server);
    if (!saved) return null;
    // A sign-in made for another address is never sent to this one.
    if (saved.url && saved.url !== server.url) return null;
    const usable = (s) => !!s?.accessToken && !s.needsSignIn;
    const live = (s) => usable(s) && (!s.expiresAt || s.expiresAt > Date.now());
    const good = (s) => usable(s) && (!s.expiresAt || s.expiresAt - Date.now() > EARLY);
    if (reason === "upscope") {
      this.lapse(server, saved);
      return null;
    }
    if (reason !== "initial" || !good(saved)) {
      const renewed = await this.renew(server, client);
      if (renewed) saved = renewed;
      else {
        saved = this.read(server);
        // The server turned the token down and there is nothing to renew it with: the person signs in again.
        if (saved && reason === "reauth" && !saved.refreshToken) this.lapse(server, saved);
        // A renewal that failed for now (the network, the sign-in server) doesn't end the sign-in:
        // the token is still handed out while it lasts, unless the server just turned it down.
        if (reason === "reauth" || !live(saved)) return null;
      }
    }
    if (!usable(saved)) return null;
    return {
      accessToken: saved.accessToken,
      // A sign-in saved before the spelling was settled is handed out spelled right too.
      tokenType: scheme(saved.tokenType),
      ...(saved.expiresAt && { expiresIn: Math.max(1, Math.round((saved.expiresAt - Date.now()) / 1000)) }),
    };
  }
}
