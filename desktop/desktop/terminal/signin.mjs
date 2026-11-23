// Signing a model provider in from a terminal, on a computer with no browser.
//
// The desktop app opens a sign-in page in the person's browser. A server has none, so
// `botkins providers login` uses what works from any other device:
//
//   a one-time code    The provider gives a short code and a page; the person opens the page on
//                      a phone or a laptop and types the code. GitHub Copilot does this itself;
//                      Codex does with `codex login --device-auth`.
//   the tool's own     Claude Code, and the agents that speak ACP, sign in with their own
//   sign-in            command. It is run here and what it prints (a page to open, a question)
//                      is passed to the terminal; what the person types back goes to the tool.
//   a pasted token     `--token`: a token or key made elsewhere. Codex stores it itself. For
//                      Claude Code and GitHub Copilot it is kept in Botkins' own credential
//                      vault, sealed under the host key (desktop/host/keystore.mjs), and handed
//                      to the tool in its environment when it starts.
//
// A phone does the same through the link ("provider-signin-v1", desktop/runtime.mjs): the page
// opens on the phone, and the code or a pasted token is typed there. A phone can also install a
// provider's command-line tool, with the command the provider names for it (`install`).
//
// A sign-in is a session with a numbered list of events the command line reads as they come:
//   { type: "code", url, code }     open the page, type the code
//   { type: "open", url }           open the page on any device ("back" and "host" too, for a tool on the web: where the browser ends up, and the page's host)
//   { type: "output", text }        a line the tool printed
//   { type: "prompt", text }        the tool waits for a line (the command line asks for one; with `secret` it does not show it)
// Nothing of a session is written to the log: a page's address and a code are for the person
// who asked, and are gone when the session ends.
//
// A tool on the web (a remote MCP server) signs in through a browser too (desktop/oauth.mjs), and
// the browser is sent back to an address on this computer. With the browser on another device
// that page cannot load, so the person copies its address and pastes it here (`startTool`). The
// pasted address is judged as the browser's own answer is: it must be the address this sign-in
// named, with this sign-in's `state`; the server's name in it (`iss`) is then checked, and the
// code is good only with the secret this computer made for this one sign-in (PKCE).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ENDED_FOR_PORT } from "../oauth.mjs";
import { cliEnv, run } from "../providers/cli.mjs";
import { KEYED, KEYED_IDS, keyVaultId } from "../providers/keyed/index.mjs";
import { shownText } from "../shown-text.mjs";

const MAX_EVENTS = 400;
const SESSION_MS = 15 * 60_000;
// A sign-in nobody reads any more (its command line was closed) is ended after this long: a provider's, and a
// tool's in its followed form. A phone is given longer: the person is on the provider's page, and the app may be in
// the background.
const ABANDONED_MS = 45_000;
export const PHONE_PATIENCE_MS = 10 * 60_000;
/**
 * How long a tool's sign-in waits for its address (it is the time the sign-in server's answer may take, `patience` of
 * desktop/oauth.mjs): the person signs in on another device and carries the address back. Not the same as the time
 * after which a sign-in that nobody reads is ended (ABANDONED_MS, HELD_ABANDONED_MS).
 */
export const TOOL_ANSWER_MS = 10 * 60_000;
/** A sign-in that `--start` left open is read by nobody on purpose: it is ended as a left one only after the whole wait. */
const HELD_ABANDONED_MS = TOOL_ANSWER_MS;
/** The providers whose sign-in a token can stand in for (useToken), and those with a sign-in of their own here (flow). */
const TOKEN_PROVIDERS = new Set(["codex", "claude", "copilot", ...KEYED_IDS]);
const GUIDED_PROVIDERS = new Set(["codex", "claude", "copilot"]);
const KEEP_MS = 60_000;
/** How long the second step waits for the sign-in server after it has the address. */
const ANSWER_WAIT_MS = 30_000;
/** A sign-in server's own words can be in a refusal. What would move or hide text on a terminal is written as its number (desktop/shown-text.mjs). */
const plain = (text) => shownText(String(text)).slice(0, 600);
/** The host of an address, as text that is safe to show. */
const hostOf = (address) => {
  try {
    return plain(new URL(String(address)).host);
  } catch {
    return "";
  }
};
/** An error with a code, for the command line to tell one refusal from another. */
const refusal = (message, code) => Object.assign(new Error(message), { code });
/** The codes of desktop/oauth.mjs for a refusal that is not "this address is turned away, and the sign-in is open". */
const REFUSALS = new Set(["ANSWERED", "NO_SIGN_IN"]);
/** Where a pasted token is kept in the vault, by provider. */
const vaultId = keyVaultId;

/** What a pasted Claude token is, by its shape: an API key is billed by use, anything else is the plan's own token. */
const claudeEnv = (token) => (/^sk-ant-api/.test(token) ? { ANTHROPIC_API_KEY: token } : { CLAUDE_CODE_OAUTH_TOKEN: token });
const CLAUDE_VARIABLES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

export class SignIns {
  /**
   * @param options.providers  () → the Providers registry.
   * @param options.vault      () → the credential vault.
   * @param options.changed    (providerId) → a provider was signed in or out: its status and models are read again.
   * @param options.env        The service's own environment, which the tools it starts inherit.
   * @param options.launch     For tests: replaces spawn.
   */
  constructor({ providers, vault, changed = async () => {}, enable = async () => {}, env = process.env, launch = spawn, runTool = run, platform = process.platform, home = homedir() }) {
    Object.assign(this, { providers, vault, changed, enable, env, launch, runTool, platform, home });
    this.sessions = new Map();
  }

  /**
   * How this provider can be signed in from here without a browser on this computer: `guided`,
   * its own sign-in followed step by step (start); `token`, a pasted token or key (useToken).
   * OpenCode signs in one model service at a time (its services), so it has neither here.
   */
  ways(provider) {
    return { guided: GUIDED_PROVIDERS.has(provider.id) || !!provider.signInCommand, token: TOKEN_PROVIDERS.has(provider.id) };
  }

  // ── Pasted tokens ───────────────────────────────────────────────────────────────────────────

  /** The token kept for a provider, or null. */
  token(provider) {
    return this.vault().get(vaultId(provider));
  }
  /** How the Copilot runtime signs in to GitHub: with the kept token, else with its own sign-in. */
  copilotGitHub() {
    const token = this.token("copilot");
    return token ? { token } : undefined;
  }
  hasToken(id) {
    return this.vault().has(vaultId(id));
  }
  /** Puts the kept tokens where the tools read them. Called when the service starts and when one changes. */
  restore() {
    for (const name of CLAUDE_VARIABLES) if (this.held?.has(name)) delete this.env[name];
    this.held = new Set();
    const claude = this.token("claude");
    if (claude)
      for (const [name, value] of Object.entries(claudeEnv(claude))) {
        this.env[name] = value;
        this.held.add(name);
      }
  }
  /** Signs a provider in with a token or key the person pasted. */
  async useToken(id, token, { service } = {}) {
    const provider = this.providers().require(id);
    let previous = null;
    const secret = String(token ?? "").trim();
    if (!secret || secret.length > 8000 || /\s/.test(secret)) throw new Error("That isn't a token or key: it is one word with no spaces.");
    if (KEYED_IDS.includes(provider.id)) return this.useKey(provider, secret);
    if (provider.id === "codex") {
      const file = await provider.locate();
      if (!file) throw new Error("The Codex CLI isn't installed on this host.");
      // An OpenAI API key, or an access token: Codex keeps either itself, read from its input.
      const flag = /^sk-/.test(secret) ? "--with-api-key" : "--with-access-token";
      const result = await this.runTool(file, ["login", flag], { input: secret + "\n", env: await cliEnv(), timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error("Codex didn't take that " + (flag === "--with-api-key" ? "API key" : "access token") + ".");
    } else if (provider.id === "claude" || provider.id === "copilot") {
      // The old token is kept until the new one is accepted (below).
      previous = this.token(provider.id);
      this.keep(provider, secret);
      // The Copilot runtime reads its sign-in when it starts: it starts again with the new one.
      if (provider.id === "copilot") await provider.stop().catch(() => {});
    } else if (provider.id === "opencode") {
      if (!service) throw new Error("Name the model service the key is for, with --service (see `botkins providers services opencode`).");
      await provider.connectService(String(service), { key: secret });
    } else throw new Error(provider.name + " doesn't take a pasted token. Use its own sign-in instead.");
    await this.changed(provider.id);
    const status = await this.providers().status(provider.id);
    if (!status?.connected) {
      // A token the provider turned down is not kept, and the one it replaced comes back as it was.
      if (provider.id === "claude" || provider.id === "copilot") {
        if (previous) {
          this.keep(provider, previous);
          if (provider.id === "copilot") await provider.stop().catch(() => {});
          await this.changed(provider.id);
        } else this.forget(provider.id);
      }
      throw new Error(provider.name + " didn't accept that token." + (status?.message ? " " + status.message : ""));
    }
    return { connected: true, account: status.account ?? null, plan: status.plan ?? null };
  }
  /**
   * Keeps the key of a provider that answers on one (providers/keyed). The key alone may not make
   * it ready (Foundry also needs an endpoint and a model), so it is kept either way; what is still
   * missing is said in the answer. Once the provider has all it needs it is switched on.
   */
  async useKey(provider, secret) {
    if (provider.id === "openrouter" && !/^sk-or-/.test(secret)) throw new Error("That isn't an OpenRouter key: they start with sk-or- (make one at " + KEYED.openrouter.keyUrl + ").");
    this.keep(provider, secret);
    const status = await provider.status();
    if (status.connected) await this.enable(provider.id);
    await this.changed(provider.id);
    return { connected: !!status.connected, account: null, plan: status.plan ?? null, ...(status.keyed?.needs && { needs: status.keyed.needs }) };
  }
  /** Puts a token in the vault and where the tools read it. */
  keep(provider, secret) {
    this.vault().put(secret, { label: provider.name + " sign-in (terminal host)", kind: "provider-token", owner: "terminal:provider:" + provider.id }, vaultId(provider.id));
    this.restore();
  }
  forget(id) {
    const removed = this.vault().remove(vaultId(id));
    if (removed) this.restore();
    return removed;
  }
  /** Signs a provider out: the kept token goes, and the provider's own sign-in where it can remove one. */
  async signOut(id) {
    const provider = this.providers().require(id);
    const had = this.forget(provider.id);
    if (had && provider.id === "copilot") await provider.stop().catch(() => {});
    let own = null;
    try {
      await provider.signOut();
    } catch (error) {
      own = error;
    }
    await provider.releaseSessions?.({ busy: true }).catch(() => {});
    await this.changed(provider.id);
    // Nothing of ours to remove, and the provider couldn't remove its own: say why.
    if (!had && own) throw own;
    return { connected: !!(await this.providers().status(provider.id))?.connected };
  }

  // ── Sign-in sessions ────────────────────────────────────────────────────────────────────────

  /**
   * Starts a sign-in that needs the person: a one-time code, or the tool's own questions.
   * @returns { session }: the id to read events from.
   */
  async start(id, { service, method, abandonedMs } = {}) {
    const provider = this.providers().require(id);
    if (KEYED_IDS.includes(provider.id)) throw new Error(provider.name + " has no sign-in page: it takes a key. Paste it (`botkins providers login " + provider.id + " --token`, or the key field on a phone).");
    return this.begin(provider, "sign-in", (session) => this.flow(provider, session, { service, method }), {
      abandonedMs,
      settle: async (status) => {
        if (!status?.connected && !service) throw new Error("The sign-in ended, and " + provider.name + " is still signed out." + (status?.message ? " " + status.message : ""));
        return { connected: true, account: status?.account ?? null, plan: status?.plan ?? null };
      },
    });
  }

  /**
   * Installs a provider's command-line tool with the command the provider names for it
   * (status().install.command), in a shell, as this computer's own user. What it prints is
   * followed like a sign-in. An npm global install goes to ~/.npm-global (one of the folders
   * tools are looked for in, desktop/providers/cli.mjs), so it needs no administrator.
   * @returns { session }
   */
  async install(id, { abandonedMs } = {}) {
    const provider = this.providers().require(id);
    const status = await this.providers().status(provider.id);
    if (status?.installed) throw new Error(provider.name + " is already installed.");
    const command = typeof status?.install?.command === "string" ? status.install.command : "";
    const guide = status?.install?.url ? " Its guide: " + status.install.url : "";
    if (!command) throw new Error(provider.name + " can't be installed from Botkins." + guide);
    if (this.platform === "win32") throw new Error("Installing from a phone works on macOS and Linux. Install " + provider.name + " on this computer." + guide);
    return this.begin(provider, "install", (session) => this.installFlow(session, command), {
      abandonedMs,
      settle: async (now) => {
        if (!now?.installed) throw new Error("The install finished, but " + provider.name + " still isn't found on this computer." + (now?.message ? " " + now.message : ""));
        return { installed: true, version: now.version ?? null };
      },
    });
  }
  async installFlow(session, command) {
    session.emit({ type: "output", text: "$ " + command });
    const npm = /^\s*npm\s+(?:i|install)\s+(?:-g|--global)\b/.test(command);
    // Last on the path: the folder of the Node this runs on, whose npm a terminal host has even when the system has none.
    const env = { PATH: (await cliEnv({}, this.env)).PATH + delimiter + dirname(process.execPath), ...(npm && { NPM_CONFIG_PREFIX: join(this.home, ".npm-global") }) };
    return this.tool(session, "/bin/sh", ["-c", command], { env, failure: "The install didn't finish. " });
  }

  /**
   * A run that needs the person (a sign-in or an install), followed through its events. `settle`
   * turns the provider's status once the run is over into its result, or throws why it failed.
   */
  begin(provider, what, run, { abandonedMs = ABANDONED_MS, settle }) {
    return this.follow({
      key: provider.id,
      what,
      busy: "A" + (what === "install" ? "n install of " : " sign-in to ") + provider.name + " is already in progress somewhere else (a terminal or a phone). Finish it there, or cancel it.",
      run,
      abandonedMs,
      finish: async () => {
        await this.changed(provider.id);
        return settle(await this.providers().status(provider.id));
      },
    });
  }
  /**
   * One session: `run(session)` does the work and says what happens through `session.emit`;
   * `finish(what run answered)` gives the result. `key` names what is signed in: one session at a
   * time for each.
   */
  async follow({ key, what, busy, run, finish, abandonedMs = ABANDONED_MS, held = false }) {
    // (The sessions as they are now. One that another caller makes while this one waits is found by the look below.)
    for (const other of [...this.sessions.values()]) {
      if (other.key !== key || other.done) continue;
      // One that was started to be answered later (`held`) is nobody's to take over: only its end, or `--cancel`, frees it.
      // One nobody follows any more is ended; one somebody is still following is theirs.
      if (other.held || this.following(other)) throw new Error(busy);
      await this.cancel(other.id);
      // (Its own end is waited for: what it held, a port or a place in a list, is free then. Not for ever.)
      await Promise.race([other.over, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
      if (!other.done) throw new Error(busy);
    }
    // The waits above let another caller in: only one open session has a key.
    if (this.open(key)) throw new Error(busy);
    const session = { id: randomUUID(), key, kind: what, held, events: [], next: 0, done: false, error: null, waiting: new Set(), answering: 0, input: null, cancel: async () => {}, read: Date.now() };
    let ended;
    session.over = new Promise((resolve) => (ended = resolve));
    const watch = setInterval(() => {
      if (!session.waiting.size && Date.now() - session.read > abandonedMs) void this.cancel(session.id);
    }, Math.max(10, Math.min(5000, Math.floor(abandonedMs / 4))));
    watch.unref?.();
    session.emit = (event) => {
      session.events.push({ n: ++session.next, ...event });
      if (session.events.length > MAX_EVENTS) session.events.shift();
      for (const wake of [...session.waiting]) wake();
    };
    this.sessions.set(session.id, session);
    const limit = setTimeout(() => void this.cancel(session.id), SESSION_MS);
    limit.unref?.();
    run(session)
      .then(async (value) => {
        session.result = await finish(value);
      })
      .catch((error) => {
        session.error = String(error?.message ?? error);
      })
      .finally(() => {
        clearTimeout(limit);
        clearInterval(watch);
        session.done = true;
        session.ended = Date.now();
        ended();
        for (const wake of [...session.waiting]) wake();
        setTimeout(() => this.sessions.delete(session.id), KEEP_MS).unref?.();
      });
    return { session: session.id };
  }
  /** Somebody reads this session right now: a read waits for an event, or one came in the last 3 seconds. */
  following(session) {
    return session.waiting.size > 0 || Date.now() - session.read < 3000;
  }
  // ── A tool on the web ───────────────────────────────────────────────────────────────────────

  /**
   * Signs a tool in through a browser on another device. The session says the page to open
   * ({ type: "open", url, back }) and then asks for the address the browser was sent back to,
   * which starts with `back`.
   * @param tool  { id, name }
   * @param how   The tool's own sign-in: { signIn({ open, patience, finished, followed }), answer(address), cancel() }
   *              (Integrations or Plugins, over desktop/oauth.mjs).
   * @param hold  The sign-in is for a second step with no terminal (`--start`): nobody follows it. It is
   *              not taken over. Another `--start` for the same tool gets the same sign-in again
   *              (`already`), and the plain form, which follows, is refused (HELD).
   * @param done  ({ again, account }) → called once, when the sign-in is done (the tokens are written). Not for a
   *              sign-in that was started, cancelled, refused or timed out.
   * @param answerMs     How long the sign-in waits for its address (TOOL_ANSWER_MS).
   * @param abandonedMs  After how long a sign-in that nobody reads is ended: ABANDONED_MS for the followed form. For tests. A held
   *                     sign-in (`--start`) is read by nobody on purpose: it is ended as a left one only after its whole wait.
   * @returns { session, minutes, already? }  `minutes`: how long the sign-in waits for the address.
   */
  async startTool(tool, how, { answerMs = TOOL_ANSWER_MS, abandonedMs = ABANDONED_MS, hold = false, done } = {}) {
    const key = "tool:" + tool.id;
    const again = () => {
      const open = this.open(key);
      if (!open?.held) return null;
      // (What is left of the wait, not the whole wait.)
      return { session: open.id, minutes: Math.max(1, Math.ceil((open.expires - Date.now()) / 60_000)), already: true };
    };
    const first = hold ? again() : null;
    if (first) return first;
    const open = this.open(key);
    if (open?.held)
      throw refusal("A sign-in for " + tool.name + " is open and waits for its address. Give it the address with `--finish`, or end it with `--cancel`.", "HELD");
    let started;
    try {
      started = await this.follow({
        key,
        what: "sign-in",
        busy: "A sign-in to " + tool.name + " is already in progress, and somebody follows it. Finish it there, or end it with `--cancel` (botkins tools sign-in, botkins plugins sign-in).",
        abandonedMs: hold ? HELD_ABANDONED_MS : abandonedMs,
        held: hold,
        run: (session) => this.toolFlow(session, how, answerMs),
        finish: async (outcome) => {
          // (The account is the sign-in server's word: shown as text, and cut.)
          const account = outcome?.account ? plain(outcome.account).slice(0, 120) : undefined;
          const result = { id: tool.id, name: tool.name, signedIn: true, again: outcome?.again === true, host: outcome?.host, ...(account && { account }) };
          done?.(result);
          return result;
        },
      });
    } catch (error) {
      // Two `--start` at once: the one that lost gets the sign-in of the one that won.
      const won = hold && again();
      if (won) return won;
      throw error;
    }
    // (What the person is told is what the wait is: the sign-in's page is open for this long.)
    return { session: started.session, minutes: Math.max(1, Math.round(answerMs / 60_000)) };
  }
  async toolFlow(session, how, answerMs) {
    session.expires = Date.now() + answerMs;
    session.cancel = async () => void how.cancel();
    // An address can be long (the code in it may be a signed text), so a line may be longer than a typed code.
    session.limit = 8000;
    let over = false;
    let wake = null;
    let host = null;
    // An address that is turned away says why, with a code that tells the command line the sign-in is still open.
    // (The reason never holds the address: it is made in desktop/oauth.mjs from what this sign-in itself named.)
    session.take = (address) => {
      try {
        if (typeof address !== "string" || address.length > session.limit) throw new Error("That is too long to be the address.");
        how.answer(address);
      } catch (error) {
        // (A refusal of the sign-in itself has its own code: it is not an address that was turned away.)
        throw refusal(plain(error?.message ?? error), REFUSALS.has(error?.code) ? error.code : "BAD_ADDRESS");
      }
    };
    const paste = async (back) => {
      let text = "When you have signed in, the browser goes to an address that starts with " + back + ". On another device than this computer that page does not load, which is expected. Copy the whole address from the browser's address bar and paste it here. Paste only the address that your own browser was sent to, from a page that you opened from this output.";
      while (!over) {
        // `secret`: the command line asks for it without showing it. The address holds a code.
        session.emit({ type: "prompt", text, secret: true });
        const line = await new Promise((resolve) => {
          wake = resolve;
          session.input = (value) => {
            session.input = null;
            resolve(value);
          };
        });
        if (over || line === null) return;
        try {
          return session.take(line);
        } catch (error) {
          // The sign-in has its answer, or is gone: there is nothing more to ask for.
          if (error.code !== "BAD_ADDRESS") return;
          // The refusal says why, and never says the address again.
          text = error.message + " Paste the whole address again.";
        }
      }
    };
    let outcome = null;
    try {
      await how.signIn({
        open: async (url, { redirect } = {}) => {
          // The page's host, from the address the service made: it is the one thing in the page that the person can check.
          host = hostOf(url);
          session.emit({ type: "open", url: String(url), back: redirect, host });
          void paste(redirect);
        },
        finished: (value) => (outcome = value),
        patience: answerMs,
        // A sign-in to another tool that cannot use another port may end this one when nobody follows it. A sign-in that
        // `--start` left open is nobody's to follow, unless its address is being given right now (`--finish`).
        followed: () => session.answering > 0 || (!session.held && this.following(session)),
      });
      return { ...outcome, host };
    } catch (error) {
      throw new Error(plain(error?.message ?? error));
    } finally {
      over = true;
      session.input = null;
      session.take = null;
      wake?.(null);
    }
  }
  /** The session with this key that is not over, or null. */
  open(key) {
    for (const session of this.sessions.values()) if (session.key === key && !session.done) return session;
    return null;
  }
  /** The open sign-in of a tool, or null. */
  toolSession(toolId) {
    return this.open("tool:" + toolId);
  }
  /**
   * Gives a tool's open sign-in the address the browser was sent back to, and waits for its end
   * (the second step of a sign-in started with no terminal). An address that is turned away
   * throws (code BAD_ADDRESS), and the sign-in stays open for the right one. A sign-in that has its
   * answer already throws ANSWERED, and with no sign-in open it throws NO_SIGN_IN. It does not wait for ever: the sign-in's last step is one
   * request to the sign-in server.
   */
  async answerTool(toolId, address) {
    const session = this.toolSession(toolId);
    if (!session?.take) {
      // A sign-in that another one ended for its port says so, for as long as it is kept: that is the one the person means.
      if (this.last("tool:" + toolId)?.error === ENDED_FOR_PORT) throw refusal(ENDED_FOR_PORT, "NO_SIGN_IN");
      throw refusal("No sign-in of this tool waits for an address. Start one first (`--start`).", "NO_SIGN_IN");
    }
    session.read = Date.now();
    session.take(address);
    // While this waits for the end, somebody is giving the address: the sign-in is not ended for another one's port.
    session.answering++;
    let timer;
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("The sign-in server is slow to answer. Look again in a moment, or end the sign-in with `--cancel`.")), ANSWER_WAIT_MS)));
    try {
      await Promise.race([session.over, late]);
    } finally {
      clearTimeout(timer);
      session.answering--;
    }
    if (session.error) throw new Error(session.error);
    return session.result;
  }
  /**
   * Ends a tool's open sign-in, and waits until it is over. Says what is true: { cancelled: true } when it
   * was ended, { cancelled: false, finished: true } when it was done already (before the cancel, or while the
   * cancel waited: the tokens are written and stay), { cancelled: false } when none was open.
   */
  async cancelTool(toolId) {
    const session = this.toolSession(toolId);
    if (!session || !(await this.cancel(session.id))) {
      const last = this.last("tool:" + toolId);
      return last?.result && !last.error ? { cancelled: false, finished: true } : { cancelled: false };
    }
    await Promise.race([session.over, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
    return session.done && session.result && !session.error ? { cancelled: false, finished: true } : { cancelled: true };
  }
  /** The latest session with this key that is over and still kept, or null. */
  last(key) {
    let found = null;
    for (const session of this.sessions.values()) if (session.key === key && session.done && (!found || session.ended > found.ended)) found = session;
    return found;
  }

  /** One provider's way of signing in with the person's help. Resolves when it is done. */
  async flow(provider, session, { service, method }) {
    const open = async (url) => session.emit({ type: "open", url: String(url) });
    if (provider.id === "copilot") {
      session.cancel = () => provider.cancelSignIn();
      return provider.signIn({ device: async ({ userCode, verificationUri }) => session.emit({ type: "code", url: verificationUri, code: userCode }) });
    }
    if (provider.id === "codex") return this.tool(session, await this.located(provider), ["login", "--device-auth"]);
    if (provider.id === "claude") return this.tool(session, await this.located(provider), ["auth", "login", "--claudeai"]);
    if (provider.id === "opencode") {
      if (!service) throw new Error("OpenCode connects model services one at a time. Name one with --service (see `botkins providers services opencode`).");
      session.cancel = () => provider.cancelService(String(service));
      const services = await provider.services("");
      const found = services.find((entry) => entry.id === service);
      const oauth = (found?.methods ?? []).filter((entry) => entry.type === "oauth");
      const chosen = method ? oauth.find((entry) => entry.id === method) : oauth[0];
      if (!chosen) throw new Error(found ? "That service signs in with a key: `botkins providers login opencode --service " + service + " --token`." : "OpenCode has no model service called " + service + ".");
      const result = await provider.connectService(String(service), { method: chosen.id, open });
      if (result?.code) {
        const code = await this.ask(session, result.code.instructions);
        await provider.finishService(String(service), result.code.attempt, code);
      }
      return;
    }
    if (provider.signInCommand) {
      // An ACP agent signs in with its own command ("grok login"): the tool, then its arguments.
      const [, ...args] = provider.signInCommand.split(/\s+/);
      return this.tool(session, await this.located(provider), args);
    }
    session.cancel = () => provider.cancelSignIn();
    return provider.signIn({ open });
  }
  async located(provider) {
    const file = await provider.locate?.();
    if (!file) throw new Error(provider.name + "'s command-line tool isn't installed on this computer. Install it first (`botkins doctor` lists what is missing).");
    return file;
  }
  /** Waits for one line from the person. */
  ask(session, text) {
    session.emit({ type: "prompt", text: String(text) });
    return new Promise((resolve, reject) => {
      session.input = (line) => {
        session.input = null;
        resolve(line);
      };
      const cancel = session.cancel;
      session.cancel = async () => {
        await cancel();
        reject(new Error("Sign-in cancelled."));
      };
    });
  }
  /**
   * Runs a tool's own sign-in. What it prints goes to the person, line by line; a web address in
   * a line is also said on its own, so the command line can show it as the page to open. What the
   * person types goes to the tool's input.
   */
  async tool(session, file, args, { env: extra = {}, failure = "The sign-in didn't finish. " } = {}) {
    // No colors, no pager, and nothing that would look for a browser on this computer.
    const env = await cliEnv({ NO_COLOR: "1", TERM: "dumb", BROWSER: "/bin/false", CI: undefined, ...extra });
    const child = this.launch(file, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdin.on("error", () => {});
    session.input = (line) => void child.stdin.write(String(line) + "\n");
    session.cancel = async () => void child.kill();
    const seen = new Set();
    let rest = "";
    let last = "";
    const lines = (chunk) => {
      rest += stripVTControlCharacters(String(chunk)).replace(/\r/g, "\n");
      const parts = rest.split("\n");
      rest = parts.pop();
      // A question usually ends without a new line ("Paste code here > "): it is said once it stands still.
      for (const line of parts) say(line);
    };
    const say = (line) => {
      const text = line.trimEnd();
      if (!text.trim()) return;
      last = text.trim();
      session.emit({ type: "output", text: text.slice(0, 2000) });
      for (const [url] of text.matchAll(/https:\/\/[^\s"'<>)\]]+/g))
        if (!seen.has(url)) {
          seen.add(url);
          session.emit({ type: "open", url });
        }
    };
    const idle = setInterval(() => {
      if (!rest.trim()) return;
      const text = rest;
      rest = "";
      say(text);
      if (/[:>?]\s*$/.test(text)) session.emit({ type: "prompt", text: "" });
    }, 400);
    child.stdout.on("data", lines);
    child.stderr.on("data", lines);
    try {
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      if (rest.trim()) say(rest);
      if (code !== 0) throw new Error(session.cancelled ? (session.kind === "install" ? "Install cancelled." : "Sign-in cancelled.") : failure + last.replace(/https:\/\/\S+/g, "").slice(0, 300));
    } finally {
      clearInterval(idle);
      session.input = null;
    }
  }
  /** The events after `after`: at once when there are some or the sign-in is over, else when one comes or `ms` have passed. */
  read(id, { after = 0, ms = 25_000, signal } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("That sign-in is over.");
    const view = () => ({
      events: session.events.filter((event) => event.n > after),
      next: session.next,
      done: session.done,
      ...(session.done && session.error && { error: session.error }),
      ...(session.done && session.result && { result: session.result }),
      wantsInput: !!session.input && !session.done,
    });
    session.read = Date.now();
    const ready = view();
    if (ready.events.length || ready.done || signal?.aborted) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        session.read = Date.now();
        session.waiting.delete(done);
        signal?.removeEventListener("abort", done);
        resolve(view());
      };
      const timer = setTimeout(done, ms);
      session.waiting.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  /** A line the person typed, for a sign-in that asked for one. */
  input(id, text) {
    const session = this.sessions.get(id);
    if (!session || session.done) throw new Error("That sign-in is over.");
    if (!session.input) throw new Error("This sign-in isn't waiting for anything to be typed.");
    if (typeof text !== "string" || text.length > (session.limit ?? 4000)) throw new Error("That is too long to be " + (session.limit ? "the address" : "a code") + ".");
    session.input(text.trim());
  }
  async cancel(id) {
    const session = this.sessions.get(id);
    if (!session || session.done) return false;
    session.cancelled = true;
    await Promise.resolve(session.cancel()).catch(() => {});
    return true;
  }
  /** Ends every sign-in (the service is stopping). */
  async close() {
    for (const id of [...this.sessions.keys()]) await this.cancel(id);
  }
}
