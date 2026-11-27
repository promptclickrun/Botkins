// A stand-in for a remote MCP server that signs people in with OAuth, for tests and smokes.
// One local HTTP server plays three parts: the MCP endpoint (/mcp, which wants a Bearer token),
// its protected-resource information, and the authorization server (discovery, registration,
// /authorize, /token, /revoke). /authorize approves at once and redirects, as if the person had
// clicked Allow. `server.log` records what was asked, and the knobs change how it behaves.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const sha = (text) => createHash("sha256").update(text).digest("base64url");
const allowedRedirect = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || host === "::1" || /^127\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host);
  }
  return false;
};
const body = (request) =>
  new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });

export async function oauthMcpServer(options = {}) {
  const state = {
    log: [],
    clients: new Map(),
    codes: new Map(),
    access: new Map(), // token → { scope, expiresAt, client }
    refresh: new Map(), // token → { scope, client }
    /** Seconds an access token lasts. */
    expiresIn: options.expiresIn ?? 3600,
    /** false removes the registration endpoint, as on a server that wants a client ID entered by hand. */
    registration: options.registration ?? true,
    /** A client that exists without registering: { id, secret }. */
    staticClient: options.staticClient ?? null,
    /** "deny" makes /authorize answer access_denied. */
    authorize: "allow",
    scope: options.scope ?? "tools.read",
    /** Changes what the server says about itself: { resource(doc), server(doc), callback(url) }. */
    tweak: options.tweak ?? {},
    /** Makes /token fail with this status (a sign-in server that is down). */
    tokenStatus: null,
    /** The `token_type` the token endpoint answers with. Some servers say "bearer" in lower case. */
    tokenType: options.tokenType ?? "Bearer",
    /** Claims of an `id_token` that the token answer has (a JWT with no signature check): { email, … }, or a whole string. */
    idToken: options.idToken ?? null,
    /** A promise that /token waits for before it answers: the answer is held until it settles. */
    tokenGate: null,
    /** The word the server's one tool returns. */
    word: options.word ?? "heron-7",
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const origin = "http://127.0.0.1:" + server.address().port;
    const json = (status, data, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(data));
    };
    const text = request.method === "POST" ? await body(request) : "";
    // Direct-harness fixtures can count requests without recording credentials or OAuth inputs.
    state.log.push(options.recordSecrets === false
      ? { method: request.method, path: url.pathname, ...(url.pathname === "/mcp" && { body: text }) }
      : { method: request.method, path: url.pathname, authorization: request.headers.authorization, body: text });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource")
      return json(200, (state.tweak.resource ?? ((doc) => doc))({ resource: origin + "/mcp", authorization_servers: [origin], scopes_supported: [state.scope] }));
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, (state.tweak.server ?? ((doc) => doc))({
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        revocation_endpoint: origin + "/revoke",
        ...(state.registration && { registration_endpoint: origin + "/register" }),
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
      }));
    if (url.pathname === "/register" && request.method === "POST") {
      if (!state.registration) return json(404, { error: "not_found" });
      const data = JSON.parse(text);
      if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.length || !data.redirect_uris.every((u) => typeof u === "string" && allowedRedirect(u)))
        return json(400, { error: "invalid_client_metadata", error_description: "Redirect URI must use https, or http on a loopback host" });
      const id = "client-" + randomBytes(6).toString("hex");
      state.clients.set(id, { redirects: data.redirect_uris, name: data.client_name });
      return json(201, { client_id: id, redirect_uris: data.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const client = state.clients.get(q.get("client_id")) ?? (state.staticClient?.id === q.get("client_id") ? { redirects: null } : null);
      const redirect = q.get("redirect_uri");
      if (!client || !redirect || !allowedRedirect(redirect) || (client.redirects && !client.redirects.includes(redirect)) || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
        return json(400, { error: "invalid_request" });
      const back = new URL(redirect);
      back.searchParams.set("state", q.get("state"));
      if (state.authorize === "deny") back.searchParams.set("error", "access_denied");
      else {
        const code = "code-" + randomBytes(8).toString("hex");
        state.codes.set(code, { client: q.get("client_id"), redirect, challenge: q.get("code_challenge"), scope: q.get("scope") ?? state.scope, resource: q.get("resource") });
        back.searchParams.set("code", code);
      }
      response.writeHead(302, { location: (state.tweak.callback ?? ((u) => u))(back).href });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      if (state.tokenGate) await state.tokenGate;
      if (state.tokenStatus) return json(state.tokenStatus, { error: "temporarily_unavailable" });
      const form = new URLSearchParams(text);
      let clientId = form.get("client_id");
      let secret = form.get("client_secret");
      const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? "");
      if (basic) [clientId, secret] = Buffer.from(basic[1], "base64").toString().split(":").map(decodeURIComponent);
      if (state.staticClient?.id === clientId && state.staticClient.secret && secret !== state.staticClient.secret) return json(401, { error: "invalid_client" });
      const issue = (scope) => {
        const access = "access-" + randomBytes(8).toString("hex");
        const refresh = "refresh-" + randomBytes(8).toString("hex");
        state.access.set(access, { scope, client: clientId, expiresAt: Date.now() + state.expiresIn * 1000 });
        state.refresh.set(refresh, { scope, client: clientId });
        const id = state.idToken && (typeof state.idToken === "string" ? state.idToken : "e30." + Buffer.from(JSON.stringify(state.idToken)).toString("base64url") + ".c2ln");
        return json(200, { access_token: access, token_type: state.tokenType, expires_in: state.expiresIn, refresh_token: refresh, scope, ...(id && { id_token: id }) });
      };
      if (form.get("grant_type") === "authorization_code") {
        const code = state.codes.get(form.get("code"));
        state.codes.delete(form.get("code"));
        if (!code || code.client !== clientId || code.redirect !== form.get("redirect_uri") || sha(form.get("code_verifier") ?? "") !== code.challenge)
          return json(400, { error: "invalid_grant", error_description: "The code or its verifier is wrong." });
        return issue(code.scope);
      }
      if (form.get("grant_type") === "refresh_token") {
        const old = state.refresh.get(form.get("refresh_token"));
        if (!old || old.client !== clientId) return json(400, { error: "invalid_grant", error_description: "The refresh token is no longer valid." });
        // Refresh tokens rotate: the old one stops working.
        state.refresh.delete(form.get("refresh_token"));
        return issue(old.scope);
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke" && request.method === "POST") {
      const token = new URLSearchParams(text).get("token");
      state.refresh.delete(token);
      state.access.delete(token);
      return json(200, {});
    }
    if (url.pathname === "/mcp") {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const grant = token && state.access.get(token);
      if (!grant || grant.expiresAt < Date.now())
        return json(401, { error: "invalid_token" }, {
          "www-authenticate": 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource/mcp", scope="' + state.scope + '"' + (grant ? ', error="invalid_token"' : ""),
        });
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        return response.end();
      }
      const message = JSON.parse(text);
      if (message.method === "tools/call" && state.requiredScope && !grant.scope.split(" ").includes(state.requiredScope))
        return json(403, { error: "insufficient_scope", ignored: token }, { "www-authenticate": 'Bearer error="insufficient_scope"' });
      if (message.method === "tools/call" && state.rejectNextCall) {
        // The call took effect, but the response says to sign in. It must never be replayed.
        state.rejectedEffects = (state.rejectedEffects ?? 0) + 1;
        state.rejectNextCall = false;
        return json(401, { error: "invalid_token", ignored: token }, { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      if (message.method === "tools/call" && state.interruptNextCall) {
        state.interruptNextCall = false;
        state.interruptedEffects = (state.interruptedEffects ?? 0) + 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('event: message\ndata: {"jsonrpc":"2.0"', () => response.destroy());
        return;
      }
      if (message.method === "tools/call" && state.streamNextCall) {
        state.streamNextCall = false;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const reply = { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: state.word }] } };
        response.write(": keepalive\r\n\r\nevent: message\r\ndata: " + JSON.stringify(reply) + "\r\n\r\n");
        return; // The relay can return when the result arrives; it need not wait for stream EOF.
      }
      if (message.id === undefined) {
        response.writeHead(202);
        return response.end();
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "signed-in-words", version: "1.0.0" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "secret_word", description: "Returns the secret word. Only works when signed in.", inputSchema: { type: "object", properties: {} } }] }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: state.word }] }
              : message.method === "ping"
                ? {}
                : null;
      return json(200, result === null ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id: message.id, result });
    }
    json(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  return {
    ...state,
    state,
    origin,
    url: origin + "/mcp",
    /** Plays the person's browser: follows the sign-in page to the app's loopback address. */
    browser: async (url) => {
      const first = await fetch(url, { redirect: "manual" });
      const next = first.headers.get("location");
      if (!next) throw new Error("The sign-in page didn't redirect: " + first.status);
      if (options.recordSecrets !== false) state.lastCallback = next;
      await fetch(next);
    },
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}
