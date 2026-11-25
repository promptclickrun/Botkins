// The gateway: where a harness (the Copilot runtime, Pi, OMP) sends the model requests of a
// provider it doesn't own. It is a small server on this computer only (127.0.0.1, a port of its
// own) that answers only to the secret the harness was given for this run of the app, and turns
// away any request that names a browser origin.
//
//   POST /chatgpt/responses    OpenAI Responses format    → the person's ChatGPT plan (chatgpt.mjs)
//   POST /claude/v1/messages   Anthropic Messages format  → the person's Claude plan, through
//                                                           Claude Code (claude.mjs)
//   POST /copilot/v1/messages | /responses | /chat/completions
//                                                         → GitHub Copilot's models, signed with
//                                                           headers the Copilot runtime lends
//                                                           (copilot.mjs, providers/copilot/relay.mjs)
//   POST /opencode/chat/completions                       → a model the person connected in
//                                                           OpenCode, one step of an OpenCode
//                                                           session (opencode.mjs)
//   POST /key/<provider>/chat/completions | /responses     → OpenRouter, Azure Foundry or an
//                                                           OpenAI endpoint, with the key the
//                                                           person gave (providers/keyed)
//
// No plan's sign-in, and no key, passes through a harness: it is added here (or stays in the
// program that holds it), for the one request that needs it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assemble, ClaudePool, claudeTurn, PlanError } from "./claude.mjs";
import { chatgptTurn, completeOutput } from "./chatgpt.mjs";
import { COPILOT_ENDPOINTS, copilotHeaders, copilotUrl } from "./copilot.mjs";
import { completion } from "./opencode.mjs";
import { KEYED, KEY_PATHS } from "../providers/keyed/config.mjs";

const MAX_BODY = 64 * 1024 * 1024;

export class Gateway {
  /**
   * @param options.chatgpt  { signIn(), renew() } for the ChatGPT plan, or null when there is none.
   * @param options.claude   async () => ({ file, env, cwd, bridge, report? }) for the Claude plan, or null.
   * @param options.keyed    (providerId) => { baseUrl, query?, headers, secrets } | null: where a key provider's
   *                         requests go, with its key in the headers (providers/keyed). Null for none.
   * @param options.copilot  () => the Copilot relay (providers/copilot/relay.mjs) | null.
   * @param options.opencode () => the OpenCode relay (opencode.mjs) | null.
   * @param options.version  Botkins' version.
   * @param options.waiting  How many runs of Claude Code wait for a request (claude.mjs, ClaudePool). 0 for none.
   * @param options.settleMs How long such a run must have waited before it takes a request (tests pass 0).
   * @param options.fetch, options.launch  For tests.
   */
  constructor({ chatgpt = null, claude = null, keyed = () => null, copilot = () => null, opencode = () => null, speedTier = async () => undefined, version = "", fetch: fetcher = globalThis.fetch, launch, waiting = 2, settleMs, log = () => {} } = {}) {
    Object.assign(this, { chatgpt, claude, keyed, copilot, opencode, speedTier, version, fetch: fetcher, launch, log });
    // Runs of Claude Code that have finished starting, so a reply begins at once and doesn't stop in its middle.
    this.pool = claude && waiting > 0 ? new ClaudePool({ size: waiting, log, ...(settleMs !== undefined && { settleMs }), ...(launch && { launch }) }) : null;
    this.secret = randomBytes(24).toString("base64url");
    this.server = null;
    this.listening = null;
  }
  /** Starts listening on first use. Resolves with the address ("http://127.0.0.1:<port>"). */
  start() {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => void this.handle(request, response));
      server.on("error", reject);
      server.on("close", () => {
        if (this.server !== server) return;
        this.server = null;
        this.listening = null;
      });
      // A model can think for minutes before its first word.
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.keepAliveTimeout = 0;
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        server.unref();
        resolve("http://127.0.0.1:" + server.address().port);
      });
    }).catch((error) => {
      this.listening = null;
      throw error;
    });
    return this.listening;
  }
  /**
   * Starts the waiting runs of Claude Code for a model, so the first request for it is answered by
   * one that has finished starting. Called when a chat on a Claude plan's model is opened.
   */
  async warm(model) {
    if (!this.pool || !this.claude) return;
    try {
      const run = await this.claude();
      this.pool.ensure({ file: run.file, env: run.env, cwd: run.cwd, model });
    } catch (error) {
      this.log("gateway: " + (error?.message ?? error));
    }
  }
  async stop() {
    this.pool?.stop();
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  allowed(request) {
    // The OpenAI client sends "Authorization: Bearer"; the Anthropic one may send "x-api-key".
    const given = Buffer.from(/^Bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? String(request.headers["x-api-key"] ?? ""));
    const wanted = Buffer.from(this.secret);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }
  async handle(request, response) {
    const fail = (error, anthropic) => {
      const status = error instanceof PlanError ? error.status : 500;
      const message = error instanceof PlanError ? error.message : "The request couldn't be sent: " + (error?.message ?? error);
      const type = error instanceof PlanError ? error.type : "api_error";
      if (!(error instanceof PlanError)) this.log("gateway: " + (error?.message ?? error));
      if (response.headersSent) return response.destroy();
      const body = JSON.stringify(anthropic ? { type: "error", error: { type, message } } : { error: { message, type, code: type } });
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
    };
    const path = new URL(request.url, "http://127.0.0.1").pathname.replace(/\/+$/, "");
    const anthropic = path.startsWith("/claude") || path === "/copilot/v1/messages";
    try {
      // A page in a browser must never reach a plan: one that names an origin is turned away unread.
      if (request.headers.origin) throw new PlanError(403, "permission_error", "Forbidden");
      if (!this.allowed(request)) throw new PlanError(401, "authentication_error", "Unauthorized");
      if (request.method !== "POST") throw new PlanError(405, "invalid_request_error", "Method not allowed");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw new PlanError(413, "request_too_large", "The request is too large.");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new PlanError(400, "invalid_request_error", "The request isn't JSON.");
      }
      // The runtime hanging up ends the work behind the request.
      const gone = new AbortController();
      response.on("close", () => !response.writableFinished && gone.abort());
      // A key provider's request goes on as it is, with the person's key in place of this run's secret.
      const keyRoute = path.match(/^\/key\/([^/]+)\/(.+)$/);
      if (keyRoute) {
        const [, id, endpoint] = keyRoute;
        if (!Object.hasOwn(KEYED, id) || !KEY_PATHS.includes(endpoint)) throw new PlanError(404, "not_found_error", "Not found");
        return await this.keyedRequest(id, endpoint, raw, request, response, gone.signal);
      }
      const copilotRoute = path.match(/^\/copilot\/(.+)$/);
      if (copilotRoute) {
        if (!Object.hasOwn(COPILOT_ENDPOINTS, copilotRoute[1])) throw new PlanError(404, "not_found_error", "Not found");
        return await this.copilotRequest(copilotRoute[1], body, raw, request, response, gone.signal);
      }
      if (path === "/opencode/chat/completions") return await this.opencodeRequest(body, response, gone.signal);
      const route = path.match(/^\/(chatgpt|claude)(?:\/(fast|ultrafast))?(\/.*)$/);
      if (route) {
        const [, plan, speed, endpoint] = route;
        const tier = speed ? await this.speedTier(plan === "chatgpt" ? "codex" : "claude", body.model, speed).catch(() => undefined) : undefined;
        if (plan === "chatgpt" && endpoint === "/responses") return await this.chatgptRequest(body, response, gone.signal, tier);
        if (plan === "claude" && endpoint === "/v1/messages") return await this.claudeRequest(body, response, gone.signal, tier === "fast");
      }
      throw new PlanError(404, "not_found_error", "Not found");
    } catch (error) {
      fail(error, anthropic);
    }
  }

  /**
   * Sends one request to a key provider and streams the answer back as it comes: the status, the
   * content type and the body (an event stream is not touched). The key is in the headers only;
   * where it appears in an error from upstream it is hidden.
   */
  async keyedRequest(id, endpoint, text, request, response, signal) {
    const name = KEYED[id].name;
    const connection = this.keyed(id);
    if (!connection) throw new PlanError(503, "api_error", name + " isn't set up on this computer. Add its key and settings in Settings › Model providers.");
    const url = new URL(connection.baseUrl + "/" + endpoint);
    for (const [key, value] of Object.entries(connection.query ?? {})) url.searchParams.set(key, value);
    let answer;
    try {
      answer = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: String(request.headers.accept ?? "application/json"), ...connection.headers },
        body: text,
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) return response.destroy();
      throw new PlanError(502, "api_error", "Couldn't reach " + name + " (" + (error?.cause?.code ?? "no answer") + ").");
    }
    await this.passOn(answer, response, signal, name, connection.secrets);
  }

  /**
   * Streams an upstream answer back as it comes: the status, the content type and the body (an
   * event stream is not touched). An error's body is read whole, with each of `secrets` hidden.
   */
  async passOn(answer, response, signal, name, secrets = []) {
    const type = answer.headers.get("content-type") ?? "application/json";
    const retry = answer.headers.get("retry-after");
    const head = { "content-type": type, ...(retry && { "retry-after": retry }) };
    if (!answer.ok || !answer.body) {
      let reply = answer.body ? await answer.text() : "";
      for (const secret of secrets ?? []) if (secret) reply = reply.split(secret).join("[key]");
      response.writeHead(answer.status, { ...head, "content-length": Buffer.byteLength(reply) }).end(reply);
      return;
    }
    response.writeHead(answer.status, { ...head, ...(/event-stream/i.test(type) && { "cache-control": "no-cache" }) });
    await pipeline(Readable.fromWeb(answer.body), response).catch((error) => {
      if (!signal.aborted) this.log("gateway: " + name + "'s stream ended early: " + (error?.cause?.code ?? error?.code ?? "no reason given"));
      response.destroy();
    });
  }

  /**
   * Sends one request to GitHub Copilot's model API, signed with headers the Copilot runtime lent
   * (providers/copilot/relay.mjs), and streams the answer back as it comes. Headers GitHub
   * refuses are borrowed again once. The sign-in is in the headers only, and hidden in an error.
   */
  async copilotRequest(endpoint, body, text, request, response, signal) {
    const relay = this.copilot();
    if (!relay) throw new PlanError(503, "api_error", "GitHub Copilot isn't set up on this computer. Sign in to it in Settings › Model providers.");
    const api = COPILOT_ENDPOINTS[endpoint];
    const borrow = async (fresh) => {
      try {
        return await relay.credentials(body?.model, { fresh });
      } catch (error) {
        const status = error?.status === 401 || error?.status === 403 ? error.status : 503;
        throw new PlanError(status, status === 503 ? "api_error" : "authentication_error", "GitHub Copilot couldn't sign the request: " + (error?.message ?? error));
      }
    };
    const send = async (lent) => {
      try {
        return await this.fetch(copilotUrl(lent, endpoint), { method: "POST", headers: copilotHeaders(lent, api, body, request.headers), body: text, signal, redirect: "error" });
      } catch (error) {
        if (signal.aborted) return null;
        throw new PlanError(502, "api_error", "Couldn't reach GitHub Copilot (" + (error?.cause?.code ?? "no answer") + ").");
      }
    };
    let lent = await borrow(false);
    let answer = await send(lent);
    if (answer && (answer.status === 401 || answer.status === 403) && Date.now() - lent.at > 1000) {
      await answer.body?.cancel().catch(() => {});
      relay.forget();
      lent = await borrow(true);
      answer = await send(lent);
    }
    if (!answer) return response.destroy();
    const token = /^Bearer (.+)$/i.exec(lent.headers.authorization ?? "")?.[1];
    await this.passOn(answer, response, signal, "GitHub Copilot", [token]);
  }

  /**
   * Answers a Chat Completions request with one step of an OpenCode model (opencode.mjs): as an
   * event stream of chunks, or with stream: false as one completion.
   */
  async opencodeRequest(body, response, signal) {
    const relay = this.opencode();
    if (!relay) throw new PlanError(503, "api_error", "OpenCode isn't set up on this computer. Install it and connect a model service in Settings › Model providers.");
    const streaming = body?.stream !== false;
    const whole = completion();
    let began = false;
    const emit = (chunk) => {
      if (!streaming) return whole.take(chunk);
      if (!began) {
        began = true;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      }
      response.write("data: " + JSON.stringify(chunk) + "\n\n");
    };
    try {
      await relay.turn(body, { emit, signal });
    } catch (error) {
      // Before the reply began the failure is the answer; after, it ends the stream as OpenAI's own would.
      if (!began) throw error;
      if (!signal.aborted) response.write("data: " + JSON.stringify({ error: { message: error?.message ?? "OpenCode stopped.", type: error instanceof PlanError ? error.type : "api_error", code: error?.status ?? null } }) + "\n\n");
      return void response.end();
    }
    if (!streaming) {
      const reply = JSON.stringify(whole.message());
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(reply) }).end(reply);
      return;
    }
    response.end("data: [DONE]\n\n");
  }

  async chatgptRequest(body, response, signal, serviceTier) {
    if (!this.chatgpt) throw new PlanError(503, "api_error", "ChatGPT isn't set up on this computer.");
    const answer = await chatgptTurn(body, { ...this.chatgpt, serviceTier, fetch: this.fetch, version: this.version, signal });
    if (!answer.ok) {
      // The endpoint's own words go back as they are: the runtime shows them.
      const text = await answer.text();
      response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" }).end(text);
      return;
    }
    if (body.stream === false) {
      // Asked for one answer, not a stream: the stream is read to its end and the finished response returned.
      let finished = null;
      const fixed = Readable.fromWeb(answer.body).pipe(completeOutput((whole) => (finished = whole)));
      for await (const _chunk of fixed);
      if (!finished) throw new PlanError(502, "api_error", "ChatGPT's answer ended early.");
      const text = JSON.stringify(finished);
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    await pipeline(Readable.fromWeb(answer.body), completeOutput(), response).catch((error) => {
      if (!signal.aborted) this.log("gateway: ChatGPT's stream ended early: " + (error?.message ?? error));
      response.destroy();
    });
  }

  async claudeRequest(body, response, signal, fastMode) {
    if (!this.claude) throw new PlanError(503, "api_error", "Claude isn't set up on this computer.");
    const run = await this.claude();
    const streaming = body.stream !== false;
    const whole = assemble();
    let began = false;
    const emit = (event) => {
      if (!streaming) return whole.take(event);
      if (!began) {
        began = true;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      }
      response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
    };
    // The answer is finished as soon as the reply is whole, not when Claude Code's run has ended.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (streaming) return void response.end();
      const text = JSON.stringify(whole.message());
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
    };
    try {
      await claudeTurn(body, { ...run, fastMode, emit, signal, ended: finish, ...(this.pool && { pool: this.pool }), ...(this.launch && { launch: this.launch }) });
    } catch (error) {
      if (finished) return;
      // Before the reply began the failure is the answer; after, it ends the stream as Anthropic's own would.
      if (!began) throw error;
      if (!signal.aborted)
        response.write("event: error\ndata: " + JSON.stringify({ type: "error", error: { type: error instanceof PlanError ? error.type : "api_error", message: error?.message ?? "Claude Code stopped." } }) + "\n\n");
      return void response.end();
    }
    finish();
  }
}
