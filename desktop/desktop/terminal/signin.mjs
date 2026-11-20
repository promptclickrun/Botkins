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
//   { type: "open", url }           open the page on any device
//   { type: "output", text }        a line the tool printed
//   { type: "prompt", text }        the tool waits for a line (the command line asks for one)
// Nothing of a session is written to the log: a page's address and a code are for the person
// who asked, and are gone when the session ends.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { cliEnv, run } from "../providers/cli.mjs";

const MAX_EVENTS = 400;
const SESSION_MS = 15 * 60_000;
// A sign-in nobody reads any more (its command line was closed) is ended after this long. A phone
// is given longer: the person is on the provider's page, and the app may be in the background.
const ABANDONED_MS = 45_000;
export const PHONE_PATIENCE_MS = 10 * 60_000;
/** The providers whose sign-in a token can stand in for (useToken), and those with a sign-in of their own here (flow). */
const TOKEN_PROVIDERS = new Set(["codex", "claude", "copilot"]);
const GUIDED_PROVIDERS = new Set(["codex", "claude", "copilot"]);
const KEEP_MS = 60_000;
/** Where a pasted token is kept in the vault, by provider. */
const vaultId = (provider) => "terminal-provider-" + provider;

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
  constructor({ providers, vault, changed = async () => {}, env = process.env, launch = spawn, runTool = run, platform = process.platform, home = homedir() }) {
    Object.assign(this, { providers, vault, changed, env, launch, runTool, platform, home });
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
    const secret = String(token ?? "").trim();
    if (!secret || secret.length > 8000 || /\s/.test(secret)) throw new Error("That isn't a token or key: it is one word with no spaces.");
    if (provider.id === "codex") {
      const file = await provider.locate();
      if (!file) throw new Error("The Codex CLI isn't installed on this host.");
      // An OpenAI API key, or an access token: Codex keeps either itself, read from its input.
      const flag = /^sk-/.test(secret) ? "--with-api-key" : "--with-access-token";
      const result = await this.runTool(file, ["login", flag], { input: secret + "\n", env: await cliEnv(), timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error("Codex didn't take that " + (flag === "--with-api-key" ? "API key" : "access token") + ".");
    } else if (provider.id === "claude" || provider.id === "copilot") {
      this.vault().put(secret, { label: provider.name + " sign-in (terminal host)", kind: "provider-token", owner: "terminal:provider:" + provider.id }, vaultId(provider.id));
      this.restore();
      // The Copilot runtime reads its sign-in when it starts: it starts again with the new one.
      if (provider.id === "copilot") await provider.stop().catch(() => {});
    } else if (provider.id === "opencode") {
      if (!service) throw new Error("Name the model service the key is for, with --service (see `botkins providers services opencode`).");
      await provider.connectService(String(service), { key: secret });
    } else throw new Error(provider.name + " doesn't take a pasted token. Use its own sign-in instead.");
    await this.changed(provider.id);
    const status = await this.providers().status(provider.id);
    if (!status?.connected) {
      // A token the provider turned down is not kept.
      if (provider.id === "claude" || provider.id === "copilot") this.forget(provider.id);
      throw new Error(provider.name + " didn't accept that token." + (status?.message ? " " + status.message : ""));
    }
    return { connected: true, account: status.account ?? null, plan: status.plan ?? null };
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
  async start(id, { service, method, patience } = {}) {
    const provider = this.providers().require(id);
    return this.begin(provider, "sign-in", (session) => this.flow(provider, session, { service, method }), {
      patience,
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
  async install(id, { patience } = {}) {
    const provider = this.providers().require(id);
    const status = await this.providers().status(provider.id);
    if (status?.installed) throw new Error(provider.name + " is already installed.");
    const command = typeof status?.install?.command === "string" ? status.install.command : "";
    const guide = status?.install?.url ? " Its guide: " + status.install.url : "";
    if (!command) throw new Error(provider.name + " can't be installed from Botkins." + guide);
    if (this.platform === "win32") throw new Error("Installing from a phone works on macOS and Linux. Install " + provider.name + " on this computer." + guide);
    return this.begin(provider, "install", (session) => this.installFlow(session, command), {
      patience,
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
  async begin(provider, what, run, { patience = ABANDONED_MS, settle }) {
    for (const other of this.sessions.values()) {
      if (other.provider !== provider.id || other.done) continue;
      // One nobody follows any more is ended; one somebody is still following is theirs.
      if (other.waiting.size || Date.now() - other.read < 3000) throw new Error("A" + (what === "install" ? "n install of " : " sign-in to ") + provider.name + " is already in progress somewhere else (a terminal or a phone). Finish it there, or cancel it.");
      await this.cancel(other.id);
    }
    const session = { id: randomUUID(), provider: provider.id, kind: what, events: [], next: 0, done: false, error: null, waiting: new Set(), input: null, cancel: async () => {}, read: Date.now() };
    const watch = setInterval(() => {
      if (!session.waiting.size && Date.now() - session.read > patience) void this.cancel(session.id);
    }, 5000);
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
      .then(async () => {
        await this.changed(provider.id);
        session.result = await settle(await this.providers().status(provider.id));
      })
      .catch((error) => {
        session.error = String(error?.message ?? error);
      })
      .finally(() => {
        clearTimeout(limit);
        clearInterval(watch);
        session.done = true;
        for (const wake of [...session.waiting]) wake();
        setTimeout(() => this.sessions.delete(session.id), KEEP_MS).unref?.();
      });
    return { session: session.id };
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
    if (typeof text !== "string" || text.length > 4000) throw new Error("That is too long to be a code.");
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
