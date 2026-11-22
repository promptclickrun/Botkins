// Connect cards: a bot asks the person to connect a Composio app from inside a chat. The bot calls
// request_app_connection; the host checks that this bot's turn may use the computer's Composio tool
// and whether the app already has an active account, and otherwise puts a card on the turn
// (`run.connects`). The card holds only what anyone in the chat may see: the app, its name and
// logo from the public catalog, and where the connection stands. The page to sign in on and the
// account an attempt made stay here, in memory, and go only to the owner who pressed Connect.
//
// One attempt per app at a time: a second press, or a press on another device, joins it. The host
// looks at Composio every few seconds while an attempt is open, and whenever a window or a phone
// asks again (coming back from the browser). When the app's account is active, the cards that were
// pressed say Connected and their chat continues once (`resumed` is saved before the message goes).
import { randomUUID } from "node:crypto";
import { defineTool } from "./providers/provider.mjs";
import { ComposioError, composioServer } from "./composio.mjs";

const SLUG = /^[a-z0-9_]{1,64}$/;
const MAX_CARDS = 4;
/** How long an attempt's page is offered before the card asks to start again. */
export const ATTEMPT_MS = 10 * 60_000;
const FAST_MS = 2 * 60_000;
const SIGN_IN_FIRST = "Sign in with Composio first.";
/** Card states that no later look changes by itself. */
const SETTLED = new Set(["connected", "unavailable"]);

const isActive = (account) => account.status === "active";

/** What the bot and the caller are told about a card: never its page or an account. */
const stateOf = (card) => ({ card: card.id, app: card.toolkit, status: card.status, ...(card.note && { note: card.note }) });

export class Connects {
  /**
   * `ws` is the workspace: its `composio` client (desktop/composio.mjs), its servers, runs and
   * chats. `timing` is for tests: { now, delay(ms) => ms } shortens the waits between looks.
   */
  constructor(ws, { now = Date.now, delay = (ms) => ms } = {}) {
    this.ws = ws;
    this.now = now;
    this.delay = delay;
    /** slug → { started, ready, url?, pendingId?, cards: Set<cardId>, timer?, done? } */
    this.attempts = new Map();
  }
  get composio() {
    return this.ws.composio;
  }

  /** The Composio tool, when a turn of this bot in this chat may use it; otherwise null. */
  serverFor(bot, chat, task) {
    if (!bot || !chat || chat.helper) return null;
    if (!this.ws.accessForTurn(chat, task).mcp) return null;
    const server = composioServer(this.ws.integrations?.servers);
    if (!server?.enabled || (bot.mcpOff ?? []).includes(server.id)) return null;
    return server;
  }

  /** The card and its turn and chat, or a sentence for a card that is gone. */
  find(chatId, cardId) {
    if (typeof chatId !== "string" || typeof cardId !== "string") throw new Error("That card can't be found.");
    const chat = this.ws.state.chats.find((item) => item.id === chatId);
    if (chat)
      for (const run of this.ws.state.runs) {
        if (run.chatId !== chatId) continue;
        const card = run.connects?.find((item) => item.id === cardId);
        if (card) return { chat, run, card };
      }
    throw new Error("That card can't be found.");
  }

  /** Changes a card and tells the window and phones. */
  set(card, status, note) {
    card.status = status;
    if (note) card.note = note;
    else delete card.note;
    card.updatedAt = this.now();
    this.ws.save();
    this.ws.notify?.();
  }

  /** The bot's tool, in a turn that may use the computer's Composio tool. */
  tools(bot, chat, run, task) {
    if (!run || run.panelId || !this.serverFor(bot, chat, task)) return [];
    return [
      defineTool("request_app_connection", {
        description:
          "Ask the person to connect an app through Composio before you use its tools, when a Composio tool says the app isn't connected or needs authorization. Name the app by its Composio toolkit slug (github, gmail, slack, …). The app shows a Connect card in this chat: never share a connection link yourself. When the status is \"connected\" or \"ready\", use the app's tools now. When it is \"needed\", end your reply by telling the person to press Connect; the chat continues by itself once the app is connected. When it is \"sign_in\", tell the person to sign in with Composio in Marketplace › Apps first.",
        parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"], additionalProperties: false },
        skipPermission: true,
        defer: "never",
        handler: async ({ app } = {}) => {
          if (task.stopped || this.ws.closing || this.ws.active.get(chat.id) !== task) throw new Error("This turn is no longer active");
          return JSON.stringify(await this.request(bot, chat, run, app));
        },
      }),
    ];
  }

  /** request_app_connection: says the app is ready, or puts a card on the turn. */
  async request(bot, chat, run, ref) {
    const slug = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (!SLUG.test(slug)) throw new Error("Name the app by its Composio toolkit slug, such as github or gmail.");
    const kit = (await this.composio.catalog()).toolkits.find((entry) => entry.slug === slug);
    if (!kit) throw new Error("Composio has no app called " + slug + ".");
    if (kit.noAuth) return { app: slug, status: "ready", message: kit.name + " needs no sign-in. Use its tools." };
    const held = run.connects?.find((card) => card.toolkit === slug);
    if (held) return { ...stateOf(held), message: "This reply already shows a Connect " + kit.name + " card." };
    let status = "needed";
    try {
      const { status: own, accounts } = await this.composio.connection(slug);
      if (own === "active" || accounts.some(isActive)) return { app: slug, status: "connected", message: kit.name + " is connected. Use its tools." };
    } catch (error) {
      if (!(error instanceof ComposioError) || error.message !== SIGN_IN_FIRST) throw error;
      status = "sign_in";
    }
    if ((run.connects?.length ?? 0) >= MAX_CARDS) throw new Error("Ask for at most four apps in one reply.");
    const card = { id: randomUUID(), toolkit: slug, name: kit.name, ...(kit.logo && { logo: kit.logo }), status, updatedAt: this.now() };
    (run.connects ??= []).push(card);
    this.ws.save();
    this.ws.notify?.();
    return {
      ...stateOf(card),
      message:
        status === "sign_in"
          ? "Botkins isn't signed in to Composio on this computer. The card tells the person to sign in under Marketplace › Apps; ask them to tell you when they have."
          : "A Connect " + kit.name + " card is in the chat. End your reply here and tell the person to press Connect. The chat continues by itself when " + kit.name + " is connected.",
    };
  }

  /**
   * The owner pressed Connect (in the window, on a paired phone, or `botkins apps connect --chat`).
   * Checks again that the bot may use Composio and whether the app is connected by now, then
   * starts or joins the app's attempt. Answers the card's state, and the page to open (https,
   * unchanged) while the attempt waits for the person.
   */
  async open(chatId, cardId) {
    const { chat, card } = this.find(chatId, cardId);
    if (!this.allowed(chat, card)) return stateOf(card);
    if (card.status === "connected") return stateOf(card);
    const slug = card.toolkit;
    let started;
    try {
      started = await this.start(slug);
    } catch (error) {
      if (error instanceof ComposioError && error.message === SIGN_IN_FIRST) this.set(card, "sign_in");
      else this.set(card, "failed", error?.message?.slice(0, 160) || "Composio couldn't start connecting " + card.name + ".");
      return stateOf(card);
    }
    if (started.connected) {
      this.finish(slug, [card.id]);
      return stateOf(card);
    }
    if (card.status !== "waiting") this.set(card, "waiting");
    const attempt = this.attempts.get(slug);
    // The attempt ended while this press waited for it: a look settles the pressed card.
    if (!attempt || attempt.done) return this.check(chatId, cardId);
    attempt.cards.add(card.id);
    return { ...stateOf(card), url: started.url };
  }

  /**
   * A window or a phone looks again (it came back from the browser, or shows the card): the card
   * is brought up to date from Composio, and a pressed card whose app is now active continues its chat.
   */
  async check(chatId, cardId) {
    const { chat, card } = this.find(chatId, cardId);
    if (!this.allowed(chat, card) || SETTLED.has(card.status)) return stateOf(card);
    const slug = card.toolkit;
    if (this.attempts.has(slug)) {
      this.attempts.get(slug).cards.add(card.id);
      await this.look(slug);
      return stateOf(card);
    }
    // No attempt is open (none was started, or Botkins restarted): an active account settles the
    // card, and a card that was waiting asks to be pressed again, since its page is gone.
    try {
      const { status, accounts } = await this.composio.connection(slug);
      if (status === "active" || accounts.some(isActive)) {
        if (card.status === "waiting") this.finish(slug, [card.id]);
        else this.set(card, "connected");
      } else if (card.status === "waiting" || card.status === "sign_in") this.set(card, "needed");
    } catch (error) {
      if (error instanceof ComposioError && error.message === SIGN_IN_FIRST) {
        if (card.status !== "sign_in") this.set(card, "sign_in");
      } else throw error;
    }
    return stateOf(card);
  }

  /** Whether the chat's bot may still use Composio; a card whose access went away says so. */
  allowed(chat, card) {
    const bot = this.ws.state.bots.find((item) => item.id === chat.botId);
    if (this.serverFor(bot, chat)) {
      if (card.status === "unavailable") this.set(card, "needed");
      return true;
    }
    if (card.status !== "unavailable") this.set(card, "unavailable", "This bot can't use Composio in this chat any more.");
    return false;
  }

  /**
   * The app's attempt: the one open, or a new one. Resolves { connected: true } when the app was
   * connected already, else { url }. Attempts for one app never overlap: a second caller gets the first one's.
   */
  start(slug) {
    const open = this.attempts.get(slug);
    if (open && !open.done && this.now() - open.started < ATTEMPT_MS) return open.ready;
    if (open) this.end(slug);
    const attempt = { started: this.now(), cards: new Set() };
    attempt.ready = (async () => {
      const before = await this.composio.connection(slug);
      if (before.status === "active" || before.accounts.some(isActive)) return { connected: true };
      const made = await this.composio.connect(slug);
      if (made.status === "active" || (!made.redirectUrl && made.accounts.some(isActive))) return { connected: true };
      if (made.status === "failed") throw new ComposioError(made.error || "Composio couldn't start connecting this app.");
      if (!made.redirectUrl) throw new ComposioError("Composio couldn't start connecting this app.");
      attempt.url = made.redirectUrl;
      if (made.pendingId) attempt.pendingId = made.pendingId;
      this.schedule(slug, attempt);
      return { url: made.redirectUrl };
    })();
    this.attempts.set(slug, attempt);
    attempt.ready.then(
      (result) => {
        if (result.connected && this.attempts.get(slug) === attempt) this.attempts.delete(slug);
      },
      () => {
        if (this.attempts.get(slug) === attempt) this.attempts.delete(slug);
      },
    );
    return attempt.ready;
  }

  /** The next look at an open attempt: every 3 s for two minutes, then every 10 s. */
  schedule(slug, attempt) {
    const elapsed = this.now() - attempt.started;
    attempt.timer = setTimeout(() => void this.look(slug).catch(() => {}), this.delay(elapsed < FAST_MS ? 3000 : 10_000));
    attempt.timer.unref?.();
  }

  /**
   * Looks at Composio for an open attempt. The account this attempt made decides when Composio
   * named one; otherwise the app's own active state or an active account does. A failed or
   * vanished account, or an attempt past its time, ends it.
   */
  async look(slug) {
    const attempt = this.attempts.get(slug);
    if (!attempt || attempt.done || !attempt.url) return;
    if (attempt.looking) return attempt.looking;
    clearTimeout(attempt.timer);
    attempt.looking = (async () => {
      let found;
      try {
        found = await this.composio.connection(slug);
      } catch {
        // A look that failed is tried again at the next beat.
      }
      if (attempt.done) return;
      const mine = attempt.pendingId ? found?.accounts.find((account) => account.id === attempt.pendingId) : undefined;
      if (found && (mine ? isActive(mine) : found.status === "active" || found.accounts.some(isActive))) return this.finish(slug);
      if (mine?.status === "failed") return this.fail(slug, "Connecting " + this.nameOf(slug) + " didn't finish. Try again.");
      if (this.now() - attempt.started >= ATTEMPT_MS) return this.fail(slug, "The sign-in page expired. Try again.", "expired");
      this.schedule(slug, attempt);
    })().finally(() => {
      attempt.looking = null;
    });
    return attempt.looking;
  }

  nameOf(slug) {
    for (const run of this.ws.state.runs) for (const card of run.connects ?? []) if (card.toolkit === slug) return card.name;
    return slug;
  }

  /** Every card of the attempt (or `extra`) by id, wherever it is. */
  cards(slug, ids) {
    const want = new Set(ids);
    const out = [];
    for (const run of this.ws.state.runs) for (const card of run.connects ?? []) if (card.toolkit === slug && want.has(card.id)) out.push({ run, card });
    return out;
  }

  /** The app is connected: the attempt's cards say so, and each one's chat continues once. */
  finish(slug, extra = []) {
    const attempt = this.attempts.get(slug);
    const ids = [...(attempt?.cards ?? []), ...extra];
    this.end(slug);
    for (const { run, card } of this.cards(slug, ids)) {
      this.set(card, "connected");
      if (card.resumed) continue;
      card.resumed = true;
      this.ws.save();
      this.resume(run, card);
    }
  }

  /** The attempt ended without an account: its cards ask to try again, and the account it left waiting is removed. */
  fail(slug, note, status = "failed") {
    const attempt = this.attempts.get(slug);
    const ids = [...(attempt?.cards ?? [])];
    const pendingId = attempt?.pendingId;
    this.end(slug);
    for (const { card } of this.cards(slug, ids)) this.set(card, status, note);
    if (pendingId) this.composio.removeAccount(slug, pendingId).catch(() => {});
  }

  end(slug) {
    const attempt = this.attempts.get(slug);
    if (!attempt) return;
    attempt.done = true;
    clearTimeout(attempt.timer);
    this.attempts.delete(slug);
  }

  /** The chat goes on with the request the card was for, as the person who wrote it. */
  resume(run, card) {
    const chat = this.ws.state.chats.find((item) => item.id === run.chatId);
    if (!chat) return;
    const author = chat.messages.find((message) => message.role === "user" && message.runId === run.id)?.author;
    try {
      this.ws.submit(chat.id, "I connected " + card.name + ". Go on with what I asked.", { ...(author && { author }) });
    } catch (error) {
      this.set(card, "connected", "Connected. Send a message to go on (" + (error?.message ?? "the chat couldn't continue") + ").");
    }
  }

  /** Stops every open attempt's looks (the app is closing, or a test ends). */
  close() {
    for (const slug of [...this.attempts.keys()]) this.end(slug);
  }
}
