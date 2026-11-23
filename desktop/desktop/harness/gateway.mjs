// The gateway: where the Copilot runtime sends model requests that a ChatGPT plan or a Claude
// plan answers. It is a small server on this computer only (127.0.0.1, a port of its own) that
// answers only to the secret the runtime was given for this run of the app.
//
//   POST /chatgpt/responses    OpenAI Responses format    → the person's ChatGPT plan (chatgpt.mjs)
//   POST /claude/v1/messages   Anthropic Messages format  → the person's Claude plan, through
//                                                           Claude Code (claude.mjs)
//
// Neither plan's sign-in passes through the Copilot runtime: it is added here, for the one
// request that needs it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assemble, ClaudePool, claudeTurn, PlanError } from "./claude.mjs";
import { chatgptTurn, completeOutput } from "./chatgpt.mjs";

const MAX_BODY = 64 * 1024 * 1024;

export class Gateway {
  /**
   * @param options.chatgpt  { signIn(), renew() } for the ChatGPT plan, or null when there is none.
   * @param options.claude   async () => ({ file, env, cwd, bridge, report? }) for the Claude plan, or null.
   * @param options.version  Botkins' version.
   * @param options.waiting  How many runs of Claude Code wait for a request (claude.mjs, ClaudePool). 0 for none.
   * @param options.settleMs How long such a run must have waited before it takes a request (tests pass 0).
   * @param options.fetch, options.launch  For tests.
   */
  constructor({ chatgpt = null, claude = null, speedTier = async () => undefined, version = "", fetch: fetcher = globalThis.fetch, launch, waiting = 2, settleMs, log = () => {} } = {}) {
    Object.assign(this, { chatgpt, claude, speedTier, version, fetch: fetcher, launch, log });
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
    const anthropic = path.startsWith("/claude");
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
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new PlanError(400, "invalid_request_error", "The request isn't JSON.");
      }
      // The runtime hanging up ends the work behind the request.
      const gone = new AbortController();
      response.on("close", () => !response.writableFinished && gone.abort());
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
