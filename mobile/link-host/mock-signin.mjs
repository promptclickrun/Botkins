// The demo computer's stand-in for signing a model provider in, and installing one, from a phone
// ("provider-signin-v1"). It acts out what the desktop app's sign-in sessions do with the real
// tools (desktop/desktop/terminal/signin.mjs): a page and a code to open on any device (GitHub
// Copilot), a tool that prints a page and a code (Codex), a tool that asks for the code its page
// showed (Claude Code), an ACP agent's own login (Grok), and an install that prints as it goes.
// Nothing here opens a page, runs a command or reaches the network.
import { randomUUID } from "node:crypto";

/** The ways each demo provider signs in from a phone. */
const WAYS = {
  copilot: { guided: true, token: true },
  codex: { guided: true, token: true },
  claude: { guided: true, token: true },
  opencode: { guided: false, token: false },
  grok: { guided: true, token: false },
};
/** A typed code that the demo turns down, to show a failed sign-in. */
export const DEMO_BAD_CODE = "0000";
/** A pasted token that the demo turns down. */
export const DEMO_BAD_TOKEN = "bad-token";

export class DemoSignIns {
  /** @param backend  the MockBackend: its `sleep`, `changed` and provider state. */
  constructor(backend) {
    this.backend = backend;
    this.sessions = new Map();
    /** What changed about each provider since the demo started: { connected, installed, account, plan, version }. */
    this.state = {};
  }
  /** A provider's status as the demo shows it now. */
  status(provider, capable) {
    const now = { ...provider, ...this.state[provider.id] };
    // Installed since the demo started: it is signed out until the person signs in.
    if (now.installed && provider.installed === false) {
      delete now.install;
      now.message = now.connected ? undefined : "Sign in to use " + provider.name + " here.";
    }
    if (!now.connected && provider.id !== "opencode") {
      delete now.account;
      delete now.plan;
    }
    return capable && WAYS[provider.id] && now.installed ? { ...now, signInWays: WAYS[provider.id] } : now;
  }
  set(id, patch) {
    this.state[id] = { ...this.state[id], ...patch };
    this.backend.state.providers.revision++;
    this.backend.changed();
  }
  open(id, kind) {
    for (const other of this.sessions.values()) if (other.provider === id && !other.done) this.finish(other, { error: "Sign-in cancelled." });
    const session = { id: randomUUID(), provider: id, kind, events: [], next: 0, done: false, waiting: new Set(), input: null };
    this.sessions.set(session.id, session);
    return session;
  }
  emit(session, event) {
    if (session.done) return;
    session.events.push({ n: ++session.next, ...event });
    for (const wake of [...session.waiting]) wake();
  }
  finish(session, { error, result } = {}) {
    if (session.done) return;
    Object.assign(session, { done: true, input: null, ...(error && { error }), ...(result && { result }) });
    for (const wake of [...session.waiting]) wake();
  }
  /** Waits, unless the session was cancelled meanwhile. */
  async pause(session, ms) {
    await this.backend.sleep(ms);
    return !session.done;
  }
  ask(session, text) {
    this.emit(session, { type: "prompt", text });
    return new Promise((resolve) => (session.input = resolve));
  }
  signedIn(session, account, plan) {
    this.set(session.provider, { connected: true, account, plan });
    this.finish(session, { result: { connected: true, account, plan } });
  }

  start(provider, options = {}) {
    if (!provider) throw new Error("There is no such provider.");
    if (provider.id === "opencode") {
      if (!options.service) throw new Error("Choose the model service to sign in to.");
      return { session: this.run(this.open(provider.id, "signin"), (session) => this.service(session, options.service)) };
    }
    if (!WAYS[provider.id]?.guided) throw new Error(provider.name + " has no sign-in to run from here.");
    if (!this.status(provider).installed) throw new Error(provider.name + "'s command-line tool isn't installed on this computer.");
    const flows = { copilot: this.copilot, codex: this.codex, claude: this.claude, grok: this.grok };
    return { session: this.run(this.open(provider.id, "signin"), (session) => flows[provider.id].call(this, session)) };
  }
  run(session, flow) {
    flow(session).catch((error) => this.finish(session, { error: String(error?.message ?? error) }));
    return session.id;
  }
  // GitHub's device sign-in: a page and a code, then GitHub says yes.
  async copilot(session) {
    if (!(await this.pause(session, 500))) return;
    this.emit(session, { type: "code", url: "https://github.com/login/device", code: "WDJB-MJHT" });
    if (!(await this.pause(session, 9000))) return;
    this.signedIn(session, "octocat", "Copilot Pro");
  }
  // `codex login --device-auth`: the tool prints the page and the code.
  async codex(session) {
    for (const text of ["Welcome to Codex.", "Follow these steps to sign in with ChatGPT:", "1. Open this link in your browser and sign in to your account"]) {
      if (!(await this.pause(session, 250))) return;
      this.emit(session, { type: "output", text });
    }
    this.emit(session, { type: "output", text: "   https://auth.openai.com/codex/device" });
    this.emit(session, { type: "open", url: "https://auth.openai.com/codex/device" });
    this.emit(session, { type: "output", text: "2. Enter this one-time code: 4F7K-LQ2P" });
    if (!(await this.pause(session, 9000))) return;
    this.emit(session, { type: "output", text: "Successfully logged in." });
    this.signedIn(session, "you@example.com", "Plus");
  }
  // `claude auth login --claudeai`: a page to open, then the code it shows typed back here.
  async claude(session) {
    if (!(await this.pause(session, 400))) return;
    this.emit(session, { type: "output", text: "Opening the sign-in page. If it doesn't open, visit:" });
    const url = "https://claude.ai/oauth/authorize?code=true&client_id=demo";
    this.emit(session, { type: "output", text: url });
    this.emit(session, { type: "open", url });
    this.emit(session, { type: "output", text: "Paste code here if prompted >" });
    const code = await this.ask(session, "");
    if (session.done) return;
    this.emit(session, { type: "output", text: "Checking the code…" });
    if (!(await this.pause(session, 700))) return;
    if (code === DEMO_BAD_CODE) return this.finish(session, { error: "The sign-in didn't finish. Invalid code." });
    this.signedIn(session, "you@example.com", "Max");
  }
  // An ACP agent's own login (`grok login`).
  async grok(session) {
    if (!(await this.pause(session, 400))) return;
    this.emit(session, { type: "output", text: "Sign in to xAI at https://accounts.x.ai/device" });
    this.emit(session, { type: "open", url: "https://accounts.x.ai/device" });
    this.emit(session, { type: "output", text: "Code: GRK-7731" });
    if (!(await this.pause(session, 8000))) return;
    this.emit(session, { type: "output", text: "Logged in." });
    this.signedIn(session, "you@example.com", undefined);
  }
  // One of OpenCode's model services, by its own sign-in: a page, then the code it shows.
  async service(session, service) {
    if (!(await this.pause(session, 400))) return;
    this.emit(session, { type: "open", url: "https://accounts.google.com/o/oauth2/auth?client_id=demo" });
    const code = await this.ask(session, "Sign in with Google, then type the code it shows.");
    if (session.done) return;
    if (code === DEMO_BAD_CODE) return this.finish(session, { error: "That code didn't work. Check it and try again." });
    (this.backend.servicesOn ??= new Set(["opencode-zen"])).add(service);
    this.backend.state.providers.revision++;
    this.finish(session, { result: { connected: true } });
  }

  install(provider) {
    if (!provider) throw new Error("There is no such provider.");
    const now = this.status(provider);
    if (now.installed) throw new Error(provider.name + " is already installed.");
    if (!provider.install?.command) throw new Error(provider.name + " can't be installed from Botkins. Its guide: " + provider.install?.url);
    const session = this.open(provider.id, "install");
    const lines = ["$ " + provider.install.command, "Downloading " + provider.name + " CLI 1.4.0 for macOS (arm64)…", "Verifying checksum…", "Installed to ~/.local/bin/grok"];
    this.run(session, async () => {
      for (const text of lines) {
        if (!(await this.pause(session, 700))) return;
        this.emit(session, { type: "output", text });
      }
      this.set(provider.id, { installed: true, version: "1.4.0", connected: false });
      this.finish(session, { result: { installed: true, version: "1.4.0" } });
    });
    return { session: session.id };
  }

  /** The events after `after`: at once when there are some or it is over, else within `ms`. */
  read(id, after = 0, ms = 10_000) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("That sign-in is over.");
    const view = () => ({
      events: session.events.filter((event) => event.n > after),
      next: session.next,
      done: session.done,
      ...(session.error && { error: session.error }),
      ...(session.result && { result: session.result }),
      wantsInput: !!session.input && !session.done,
    });
    const ready = view();
    if (ready.events.length || ready.done) return ready;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        session.waiting.delete(done);
        resolve(view());
      };
      const timer = setTimeout(done, ms);
      session.waiting.add(done);
    });
  }
  input(id, text) {
    const session = this.sessions.get(id);
    if (!session || session.done) throw new Error("That sign-in is over.");
    if (!session.input) throw new Error("This sign-in isn't waiting for anything to be typed.");
    const answer = session.input;
    session.input = null;
    answer(String(text).trim());
  }
  cancel(id) {
    const session = this.sessions.get(id);
    if (!session || session.done) return false;
    this.finish(session, { error: "Sign-in cancelled." });
    return true;
  }
  useToken(provider, token, { service } = {}) {
    if (!provider) throw new Error("There is no such provider.");
    if (provider.id === "opencode") {
      if (!service) throw new Error("Choose the model service the key is for.");
      (this.backend.servicesOn ??= new Set(["opencode-zen"])).add(service);
      this.set(provider.id, {});
      return { connected: true };
    }
    if (!WAYS[provider.id]?.token) throw new Error(provider.name + " doesn't take a pasted token; use its own sign-in.");
    if (typeof token !== "string" || token.trim() === DEMO_BAD_TOKEN) throw new Error(provider.name + " didn't accept that token.");
    // A token says nothing about whose it is: the provider reads its account later, if at all.
    this.set(provider.id, { connected: true, account: undefined, plan: undefined });
    return { connected: true, account: null, plan: null };
  }
  signOut(provider) {
    if (provider) this.set(provider.id, { connected: false });
  }
}
