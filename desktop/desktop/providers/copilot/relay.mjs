// GitHub Copilot's models as model endpoints, for a harness that isn't the Copilot runtime (Pi, OMP).
//
// Copilot's model API (api.*.githubcopilot.com) answers requests signed with the person's GitHub
// sign-in. On a Mac that sign-in is in the keychain's "copilot-cli" entries, which only GitHub's
// own signed program may read without asking (see the top of index.mjs). So Botkins never reads
// it. Instead a runtime of its own (the same signed program, in a child process) lends one
// request's headers:
//
//   - The runtime is started with the SDK's request handler (models.requestHandler), through which
//     it hands every model request it makes to Botkins before sending it.
//   - To borrow, a session of that runtime is sent "." on the model asked for. The runtime signs
//     the model request as it would any other; the handler keeps the request's URL and headers and
//     answers the runtime with a 400 of its own. Nothing is sent to GitHub, nothing is billed, and
//     the session's turn ends with that error (measured, SDK 2.0.1: one request, no retry).
//   - The gateway (desktop/harness/gateway.mjs, /copilot) then sends the harness's request to the
//     same address with those headers. They are kept in memory for a few minutes, never written
//     down, never given to a harness, and borrowed again when they are older or GitHub refuses them.
//
// This runtime keeps its state in a folder of its own beside Botkins' Copilot folder, with a copy
// of which account is signed in (config.json), so it never opens a conversation among the
// person's. It is started on the first request of a Copilot model through another harness.

/** The headers of a borrowed request that say who asks. Everything else is the harness's own. */
export const LENT_HEADERS = ["authorization", "copilot-integration-id", "copilot-harness-id", "editor-version", "user-agent", "x-github-api-version", "x-client-machine-id"];
/** How long borrowed headers are used before they are borrowed again. */
export const LENT_FOR_MS = 10 * 60 * 1000;
/** How long the list of which API each model speaks is kept. */
const ENDPOINTS_FOR_MS = 30 * 60 * 1000;
/** How many borrows one session of the runtime serves before it is replaced. */
const BORROWS_PER_SESSION = 40;
const BORROW_LIMIT_MS = 60_000;
/** The runtime's answer to a request it lent: a refusal of Botkins' own, never sent to GitHub. */
const LENT_REPLY = JSON.stringify({ error: { message: "Botkins borrowed this request's sign-in; it was not sent.", type: "invalid_request_error", code: "botkins_relay" } });

/** The APIs a Copilot model can be reached on, as the gateway names them, in the order they're preferred. */
export const COPILOT_APIS = ["messages", "responses", "completions"];
const ENDPOINT_API = { "/v1/messages": "messages", "/responses": "responses", "/chat/completions": "completions" };

/**
 * The API a Copilot model is best reached on, from what GitHub lists for it (`/models`,
 * `supported_endpoints`). Anthropic's Messages API for a Claude model, the Responses API for one
 * that has it, else Chat Completions. Without a listing, from the model's name.
 */
export function copilotApi(id, endpoints) {
  const listed = (endpoints ?? []).map((endpoint) => ENDPOINT_API[endpoint]).filter(Boolean);
  const best = COPILOT_APIS.find((api) => listed.includes(api));
  if (best) return best;
  const name = String(id ?? "").toLowerCase();
  if (name.startsWith("claude")) return "messages";
  if (/^(gemini|gemma)/.test(name)) return "completions";
  return "responses";
}

const first = (value) => (Array.isArray(value) ? value[0] : value);

export class CopilotRelay {
  /**
   * @param options.start  async (requestHandler) => client: starts the runtime that lends its
   *                       requests (CopilotProvider.startRelay), with this handler.
   * @param options.Handler, options.WebSocketHandler, options.CloseStatus  The SDK's classes.
   * @param options.fetch  For tests.
   */
  constructor({ start, Handler, WebSocketHandler, CloseStatus, fetch: fetcher = globalThis.fetch, now = Date.now, log = () => {} }) {
    Object.assign(this, { startClient: start, fetch: fetcher, now, log });
    // Sessions of the runtime waiting for the request they will lend: session id → { resolve }.
    this.waiting = new Map();
    this.lent = null;
    this.borrowing = null;
    this.endpointList = null;
    this.session = null;
    this.client = null;
    const relay = this;
    const take = (ctx) => {
      const wait = ctx.sessionId && relay.waiting.get(ctx.sessionId);
      if (!wait) return null;
      relay.waiting.delete(ctx.sessionId);
      const headers = {};
      for (const name of LENT_HEADERS) {
        const value = first(ctx.headers?.[name]);
        if (value) headers[name] = value;
      }
      wait.resolve({ url: String(ctx.url).replace(/^ws(s?):/i, "http$1:"), headers });
      return true;
    };
    // The request handler: a request of a session that borrows is answered here, all others go on.
    this.handler = new (class extends Handler {
      async sendRequest(request, ctx) {
        if (!take(ctx)) return super.sendRequest(request, ctx);
        return new Response(LENT_REPLY, { status: 400, headers: { "content-type": "application/json" } });
      }
      async openWebSocket(ctx) {
        if (!take(ctx) || !WebSocketHandler) return super.openWebSocket(ctx);
        const closed = new (class extends WebSocketHandler {
          constructor() {
            super(ctx);
          }
          sendRequestMessage() {}
        })();
        queueMicrotask(() => void closed.close(new CloseStatus("Botkins borrowed this request's sign-in; it was not sent.", "botkins_relay", new Error("not sent"))).catch(() => {}));
        return closed;
      }
    })();
  }
  /** The runtime, started on first use. */
  runtime() {
    this.client ??= this.startClient(this.handler).catch((error) => {
      this.client = null;
      throw error;
    });
    return this.client;
  }
  /**
   * Headers that sign a request to Copilot's model API, and the address of the request they were
   * borrowed from: { url, headers, at }. Borrowed again when older than LENT_FOR_MS or `fresh`.
   * `model` is the model the request is for: the runtime signs only a request for a model the
   * account may use, and says why not when it can't.
   */
  async credentials(model, { fresh = false } = {}) {
    if (!fresh && this.lent && this.now() - this.lent.at < LENT_FOR_MS) return this.lent;
    if (fresh) this.lent = null;
    this.borrowing ??= this.borrow(model).finally(() => (this.borrowing = null));
    return this.borrowing;
  }
  async borrow(model) {
    const client = await this.runtime();
    // One session lends every request: headers don't depend on the model, and a session started
    // soon after another closed is slow to begin (index.mjs, "Speed"). It is replaced after a while.
    if (!this.session || this.session.uses >= BORROWS_PER_SESSION) {
      const old = this.session;
      this.session = null;
      if (old) void old.sdk.disconnect().then(() => client.deleteSession?.(old.sdk.sessionId)).catch(() => {});
      const sdk = await client.createSession({ ...(model && { model }), tools: { availableTools: [] }, permissions: { onRequest: () => ({ kind: "reject" }) } });
      this.session = { sdk, uses: 0 };
    }
    const { sdk } = this.session;
    this.session.uses++;
    let off = () => {};
    let timer;
    try {
      const lent = await new Promise((resolve, reject) => {
        this.waiting.set(sdk.sessionId, { resolve });
        // A turn that fails before any request (not signed in, a model the plan doesn't have) says why.
        off = sdk.on((event) => {
          if (event?.type !== "session.error" || !this.waiting.has(sdk.sessionId)) return;
          reject(Object.assign(new Error(event.data?.message || "GitHub Copilot couldn't use this model."), { status: event.data?.statusCode }));
        });
        timer = setTimeout(() => reject(new Error("GitHub Copilot didn't start the request in time.")), BORROW_LIMIT_MS);
        sdk.send({ prompt: "." }).catch(reject);
      });
      this.lent = { ...lent, at: this.now() };
      return this.lent;
    } catch (error) {
      // A session that failed is not used again.
      if (this.session?.sdk === sdk) this.session = null;
      void sdk.disconnect?.().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      off();
      this.waiting.delete(sdk.sessionId);
    }
  }
  /**
   * Which API each model is best reached on: Map(model id → "messages" | "responses" |
   * "completions"), from GitHub's own list of the models and the endpoints each has. An empty map
   * when the list can't be read (copilotApi then goes by the model's name).
   */
  async endpoints(model) {
    if (this.endpointList && this.now() - this.endpointList.at < ENDPOINTS_FOR_MS) return this.endpointList.map;
    try {
      const lent = await this.credentials(model);
      const answer = await this.fetch(new URL(lent.url).origin + "/models", { headers: lent.headers, redirect: "error" });
      if (!answer.ok) throw new Error("GitHub Copilot answered " + answer.status + ".");
      const list = (await answer.json())?.data ?? [];
      const map = new Map(list.filter((m) => m?.id).map((m) => [m.id, copilotApi(m.id, m.supported_endpoints)]));
      this.endpointList = { map, at: this.now() };
      return map;
    } catch (error) {
      this.log("copilot relay: " + (error?.message ?? error));
      return new Map();
    }
  }
  /** Forgets the borrowed headers (GitHub refused them, or the sign-in changed). */
  forget() {
    this.lent = null;
  }
  async stop() {
    const client = this.client;
    this.client = null;
    this.session = null;
    this.lent = null;
    this.endpointList = null;
    if (client) await client.then((c) => c.stop(), () => {});
  }
}
