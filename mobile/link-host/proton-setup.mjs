import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROTON_GUIDE, ProtonInstaller } from "./proton-install.mjs";
import { browserLogin, PASS_OUTPUT, protonPage } from "./proton-login.mjs";
import { Failure, Gate, parseJson, runTool, toolEnv } from "./tools.mjs";

export { protonPage };
export const PROTON_SETUP = "proton-pass-setup-v1";
export const PROTON_CALLS = ["protonPassInstallPlan", "protonPassInstall", "protonPassSignInStart",
  "protonPassSignInRead", "protonPassSignInInput", "protonPassSignInCancel", "protonPassDisconnect"];
const NAME = "Proton Pass";
const BASE = { id: "protonpass", name: NAME, setup: true, install: { url: PROTON_GUIDE } };
const DAY = 86400_000;
const YEAR = 365 * DAY;
const LEASE = 2 * 3600_000;
const AUDIT_REASON = "Reading a Proton Pass field linked in Botkins";
const UNSHARED = "Not shared with Botkins. Share more vaults to use this credential.";
const EXPIRED = "Proton Pass access has expired. Sign in again.";
const SIGN_IN = "Sign in with Proton to link credentials.";
const CANCELED = "Proton Pass setup was canceled.";
const key = () => randomBytes(32).toString("base64");
const short = (value) => typeof value === "string" ? value.slice(0, 200) : undefined;
const id = (value) => typeof value === "string" && /^[\w.@=+~-]{1,200}$/.test(value) && !value.startsWith("-");
const timer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

class SetupError extends Failure {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function failure(error, passwordAttempts = 0) {
  if (error instanceof SetupError) return error;
  const detail = typeof error?.detail === "string" ? error.detail : "";
  if (/paid plan|subscription|not authorized to use (?:the )?cli|plan does not|upgrade (?:your|to)/i.test(detail)) {
    return new SetupError("plan", "Proton Pass CLI needs a paid Proton plan.");
  }
  if (/offline|network is unreachable|failed to connect|dns|connection (?:timed out|refused)|error sending request/i.test(detail)) {
    return new SetupError("offline", "Botkins couldn't reach Proton. Check the computer's connection and try again.");
  }
  if (/keyring|encryption key|key provider/i.test(detail)) return new SetupError("keyring", "Botkins couldn't open its Proton Pass session.");
  if (/unknown (?:subcommand|argument)|unrecognized subcommand/i.test(detail)) return new SetupError("needs-update", "This copy of Proton Pass CLI needs an update.");
  if (passwordAttempts && /extra password|attempts/i.test(detail)) return new SetupError("unknown", "Proton didn't accept the extra password. Sign in again.");
  return new SetupError("unknown", error instanceof Failure ? error.message : "Something went wrong with Proton Pass. Try again.");
}

export function protonVaults(result) {
  const rows = Array.isArray(result) ? result : result?.vaults;
  if (!Array.isArray(rows)) throw new Failure("Proton Pass sent back an unexpected vault list.");
  const vaults = rows.map((row) => ({
    id: row?.share_id ?? row?.shareId ?? row?.shareID ?? row?.id,
    name: short(row?.name ?? row?.vault_name ?? row?.vaultName),
  }));
  if (vaults.some((vault) => !id(vault.id) || !vault.name) || new Set(vaults.map((v) => v.id)).size !== rows.length) {
    throw new Failure("Proton Pass sent back an unexpected vault list.");
  }
  return vaults;
}

function agentToken(result) {
  const token = typeof result?.token === "string" ? result.token.replace(/^PROTON_PASS_PERSONAL_ACCESS_TOKEN=/, "") : "";
  if (!/^pst_[A-Za-z0-9._+/=-]+::[A-Za-z0-9._+/=-]+$/.test(token) || token.length > 4096) {
    throw new Failure("Proton Pass didn't return a usable agent token.");
  }
  return token;
}

export class ProtonSetup {
  constructor({ dir, ctx, record, update, writable, linked, changed, finished = () => {}, installer,
    timer: clock = timer }) {
    Object.assign(this, { dir, ctx, record, update, writable, linked, changed, finished, clock });
    this.installer = installer ?? new ProtonInstaller({ dir, platform: ctx.platform });
    this.gate = new Gate(1, 32);
    this.jobs = new Map();
    this.lease = 0;
    void this.installer.installed();
  }

  async tool() {
    const managed = await this.installer.installed();
    if (managed) return { cli: managed, source: "managed", version: this.installer.plan().version };
    if (this.installer.unsupported || this.installer.tampered) return null;
    const found = this.ctx.find("pass-cli");
    if (!found) return null;
    const cli = resolve(found);
    if (!this.pathProbe || this.pathProbe.cli !== cli || this.ctx.now() - this.pathProbe.at > 10_000) {
      const probing = async () => {
        try {
          const env = this.env();
          await runTool(NAME, cli, ["agent", "--help"], { env });
          const version = /\d+\.\d+\.\d+/.exec(await runTool(NAME, cli, ["--version"], { env }))?.[0];
          return { cli, source: "path", version };
        } catch {
          return null;
        }
      };
      this.pathProbe = { cli, at: this.ctx.now(), answer: probing() };
    }
    return this.pathProbe.answer;
  }

  async status(ignoreJob = false) {
    const job = !ignoreJob && this.active;
    if (job) return { ...BASE, state: job.kind === "install" ? "installing" : "signing-in", step: job.step };
    const record = this.record();
    if (record?.expiresAt && (record.expiresAt <= this.ctx.now() || this.revoked === record.agent)) {
      return { ...BASE, ...this.metadata(record), state: "expired", message: EXPIRED };
    }
    const tool = await this.tool();
    const fields = { ...BASE, ...(tool && { source: tool.source, version: tool.version }), ...this.metadata(record) };
    if (record?.agent) {
      try {
        this.writable();
      } catch (error) {
        return { ...fields, state: "error", code: "keyring", message: failure(error).message };
      }
    }
    if (this.lastError) return { ...fields, state: "error", code: this.lastError.code, message: this.lastError.message };
    if (!tool) {
      const found = this.ctx.find("pass-cli");
      const message = this.installer.unsupported ?? (this.installer.tampered ? "Botkins couldn't verify its copy of Proton Pass. Install it again."
        : this.ctx.shim("pass-cli") ? "The Proton Pass .cmd script can't be run safely. Install the standalone app."
        : found ? "This copy of Proton Pass CLI needs an update." : undefined);
      return { ...fields, state: "missing", ...(message && { message }), ...(this.installer.unsupported && { unsupported: true }),
        ...(found && { code: "needs-update" }) };
    }
    if (record?.agent) return { ...fields, state: record.expiresAt - this.ctx.now() <= 14 * DAY ? "expiring" : "ready" };
    return { ...fields, state: "signed-out" };
  }

  metadata(record) {
    return record?.agent ? { account: record.account, expiresAt: record.expiresAt, sharedVaults: record.vaults.map((v) => v.name) } : {};
  }

  env(dir, secret, extra = {}) {
    return toolEnv(this.ctx.dirs, {
      ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
      NO_COLOR: "1", PROTON_PASS_NO_UPDATE_CHECK: "1", PROTON_PASS_DISABLE_TELEMETRY: "1",
      ...(dir && { PROTON_PASS_SESSION_DIR: dir, PROTON_PASS_KEY_PROVIDER: "env", PROTON_PASS_ENCRYPTION_KEY: secret }),
      ...extra,
    });
  }

  execute(cli, args, env) {
    return runTool(NAME, cli, args, { env, keepError: true, cap: PASS_OUTPUT, windowHide: true });
  }

  async logout(cli, env) {
    try {
      await this.execute(cli, ["logout"], env);
    } catch {
      await this.execute(cli, ["logout", "--force"], env);
    }
  }

  plan() { return this.installer.plan(); }

  install({ sha256 } = {}) {
    if (sha256 !== this.plan().sha256) throw new Failure("Review the install plan before installing Proton Pass.");
    return this.launch("install", async ({ signal }) => {
      try {
        await this.installer.install(sha256, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new SetupError("install-failed", error instanceof Failure ? error.message : "Botkins couldn't install Proton Pass. Try again.");
      }
    });
  }

  launch(kind, work) {
    if (this.active) throw new Failure("Proton Pass setup is already in progress.");
    const controller = new AbortController();
    const job = { kind, controller, signal: controller.signal, events: [], session: randomBytes(18).toString("hex"), done: false };
    this.active = job;
    this.jobs.set(job.session, job);
    this.lastError = null;
    while (this.jobs.size > 8) this.jobs.delete(this.jobs.keys().next().value);
    this.changed();
    job.task = (async () => {
      try {
        await this.gate.run(NAME, async () => {
          job.signal.throwIfAborted();
          await work(job);
        });
      } catch (error) {
        const safe = failure(error, job.attempts);
        job.error = safe.message;
        job.code = safe.code;
        if (safe.message !== CANCELED) this.lastError = safe;
      }
      try {
        job.result = await this.status(true);
      } catch (error) {
        const safe = failure(error);
        job.error ??= safe.message;
        job.code ??= safe.code;
      } finally {
        job.done = true;
        this.active = null;
        this.changed();
        this.finished(kind, job.error ? (job.error === CANCELED ? "canceled" : "failed") : "succeeded");
      }
    })();
    return { session: job.session };
  }

  job(input) {
    const job = this.jobs.get(input?.session);
    if (!job) throw new Failure("That Proton Pass setup session no longer exists.");
    return job;
  }

  read(input) {
    const job = this.job(input);
    const after = Number.isSafeInteger(input.after) && input.after > 0 ? input.after : 0;
    return { events: job.events.slice(after), next: job.events.length, done: job.done,
      ...(job.error && { error: job.error, code: job.code }), ...(job.result && { result: job.result }) };
  }

  async cancel(input) {
    const job = this.job(input);
    if (!job.done) job.controller.abort(new SetupError("unknown", CANCELED));
    await job.task;
    return {};
  }

  async stop() {
    if (this.active) await this.cancel(this.active);
  }

  step(job, name) {
    job.step = name;
    job.events.push({ type: "step", name });
    this.changed();
  }

  ask(job, type, signal, fields = {}) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        job.answer = undefined;
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      job.answer = { type, send: (value) => {
        signal.removeEventListener("abort", abort);
        job.answer = undefined;
        resolve(value);
      } };
      this.step(job, type);
      job.events.push({ type, ...fields });
    });
  }

  input(input) {
    const job = this.job(input);
    if (job.answer?.type === "extra-password") {
      if (typeof input.extraPassword !== "string" || !input.extraPassword.length || Buffer.byteLength(input.extraPassword) > 1024 ||
          /[\x00\r\n]/.test(input.extraPassword)) throw new Failure("Enter your Proton Pass extra password.");
      job.answer.send(input.extraPassword);
      return {};
    }
    if (job.answer?.type === "choose-vaults") {
      const ids = input.vaultIds ?? [];
      const offered = job.events.find((event) => event.type === "choose-vaults").vaults;
      if (!Array.isArray(ids) || ids.length > offered.length || ids.some((v) => !id(v) || !offered.some((vault) => vault.id === v))) {
        throw new Failure("Choose vaults from the list Proton Pass returned.");
      }
      if (!ids.length && input.createDedicated !== true) throw new Failure("Choose at least one vault to share.");
      job.answer.send({ vaultIds: new Set(ids), createDedicated: input.createDedicated === true });
      return {};
    }
    throw new Failure("Proton Pass isn't waiting for an answer.");
  }

  start({ renew } = {}) {
    this.writable();
    if (renew === true && !this.record()?.agent) throw new Failure("Sign in with Proton before renewing access.");
    return this.launch("sign-in", (job) => this.withAccount(job, (cli, env) => this.connect(job, cli, env)));
  }

  async withAccount(job, complete) {
    const tool = await this.tool();
    if (!tool) throw new SetupError("needs-update", this.installer.unsupported ?? "Install Proton Pass before signing in.");
    const { cli } = tool;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.dir, ".login-"));
    const env = this.env(dir, key());
    const stopTimer = this.clock(() => job.controller.abort(new SetupError("unknown", "Proton Pass sign-in timed out. Try again.")), 11 * 60_000);
    let problem;
    try {
      this.step(job, "page");
      await browserLogin({
        cli, env, dir, signal: job.signal,
        onOpen: (url) => job.events.push({ type: "open", url }),
        receive: (signal = job.signal) => {
          const attempt = (job.attempts ?? 0) + 1;
          if (attempt > 3) throw new Failure("Proton didn't accept the extra password. Sign in again.");
          job.attempts = attempt;
          return this.ask(job, "extra-password", signal, { attempt });
        },
      });
      job.signal.throwIfAborted();
      await complete(cli, env);
    } catch (error) {
      problem = error;
      throw error;
    } finally {
      stopTimer();
      try {
        await this.logout(cli, env);
      } catch {
        if (!problem) job.cleanupFailed = true;
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
    if (job.cleanupFailed) throw new Failure("Botkins cleared its temporary Proton Pass session, but Proton didn't confirm sign-out.");
  }

  async account(cli, env) {
    const info = await this.execute(cli, ["info"], env);
    const field = (name) => new RegExp(`^[\\t ]*-?[\\t ]*${name}:[\\t ]*([^\\r\\n]+)`, "im").exec(info)?.[1]?.trim();
    const account = field("Email") || field("Username");
    const accountId = field("ID");
    if (!account || /[\x00-\x1f]/.test(account) || account.length > 200) {
      throw new Failure("Botkins couldn't identify the Proton account that signed in.");
    }
    return { account, ...(id(accountId) && { accountId }) };
  }

  async connect(job, cli, env) {
    const json = async (args) => parseJson(NAME, await this.execute(cli, args, env));
    const identity = await this.account(cli, env);
    const before = this.record();
    this.sameAccount(before, identity);
    const offered = protonVaults(await json(["vault", "list", "--output", "json"]));
    const suggestions = new Set([...this.linked(), ...(before?.vaults ?? []).map((v) => v.id)]);
    const choice = await this.ask(job, "choose-vaults", job.signal, {
      vaults: offered.map((v) => ({ ...v, suggested: suggestions.has(v.id) })),
    });
    this.step(job, "setting-up");
    let selected = offered.filter((v) => choice.vaultIds.has(v.id));
    if (choice.createDedicated) {
      const names = new Set(offered.map((v) => v.name));
      let name = "Botkins";
      if (names.has(name)) name += " " + randomBytes(4).toString("hex");
      await this.execute(cli, ["vault", "create", "--name", name], env);
      const updated = protonVaults(await json(["vault", "list", "--output", "json"]));
      const newVaults = updated.filter((v) => v.name === name && !offered.some((old) => old.id === v.id));
      if (newVaults.length !== 1) throw new Failure("Botkins couldn't confirm the new Proton Pass vault.");
      selected = [...selected, newVaults[0]];
    }
    job.signal.throwIfAborted();
    const agent = "Botkins-" + randomBytes(12).toString("hex");
    const sessionKey = key();
    const agentDir = join(this.dir, agent);
    let issued = false, saved = false;
    try {
      const created = await this.execute(cli, ["agent", "create", agent, "--expiration", "1y"], env);
      issued = true;
      const token = agentToken(parseJson(NAME, created));
      const expiresAt = this.ctx.now() + YEAR;
      for (const v of selected) {
        job.signal.throwIfAborted();
        await this.execute(cli, ["agent", "access", "grant", agent, "--share-id", v.id, "--role", "viewer"], env);
      }
      await mkdir(agentDir, { mode: 0o700 });
      const auth = this.env(agentDir, sessionKey, { PROTON_PASS_AGENT_REASON: AUDIT_REASON });
      await this.loginAgent(cli, auth, token);
      const checked = protonVaults(parseJson(NAME, await this.execute(cli, ["vault", "list", "--output", "json"], auth)));
      if (checked.length !== selected.length || selected.some((vault) => !checked.some((v) => v.id === vault.id))) {
        throw new Failure("Proton Pass didn't confirm access to exactly the selected vaults. Nothing was connected.");
      }
      job.signal.throwIfAborted();
      if (before?.agent) await this.deleteAgent(cli, env, before.agent);
      this.update({ agent, ...identity, expiresAt, vaults: selected }, { token, key: sessionKey });
      saved = true;
      this.lease = this.ctx.now() + LEASE;
      this.revoked = undefined;
      if (before?.agent) await this.removeSession(before.agent);
    } finally {
      if (!saved) {
        try {
          if (issued) await this.deleteAgent(cli, env, agent);
        } finally {
          await rm(agentDir, { recursive: true, force: true });
        }
      }
    }
  }

  sameAccount(record, { account, accountId }) {
    if (record?.agent && (record.accountId && accountId ? record.accountId !== accountId : record.account?.toLowerCase() !== account.toLowerCase())) {
      throw new Failure("Sign in to the same Proton account Botkins is connected to.");
    }
  }

  async deleteAgent(cli, env, agent) {
    try {
      await this.execute(cli, ["agent", "delete", agent], env);
    } catch (error) {
      if (!/(?:agent|token).{0,40}(?:not found|does not exist)/i.test(error.detail ?? "")) throw error;
    }
  }

  async disconnect() {
    const record = this.record();
    if (!record?.agent) return this.status();
    this.writable();
    const { session } = this.launch("disconnect", (job) => this.withAccount(job, async (cli, env) => {
      this.sameAccount(record, await this.account(cli, env));
      this.step(job, "setting-up");
      job.signal.throwIfAborted();
      await this.deleteAgent(cli, env, record.agent);
      this.update({ disconnected: true });
      this.lease = 0;
      await this.removeSession(record.agent);
    }));
    return { ...await this.status(), session };
  }

  agentDir(agent) {
    if (!/^Botkins-[a-f0-9]{24}$/.test(agent)) throw new Failure("Botkins couldn't read its Proton Pass connection.");
    return join(this.dir, agent);
  }
  removeSession(agent) {
    return rm(this.agentDir(agent), { recursive: true, force: true });
  }

  async loginAgent(cli, env, token) {
    try {
      await this.execute(cli, ["login"], { ...env, PROTON_PASS_PERSONAL_ACCESS_TOKEN: token });
    } catch (error) {
      if (/(?:invalid|expired|revoked|deleted).{0,35}token|token.{0,35}(?:invalid|expired|revoked|deleted)/i.test(error.detail ?? "")) {
        throw new SetupError("expired", EXPIRED);
      }
      throw error;
    }
  }

  run(args, vaultId) {
    return this.gate.run(NAME, async () => {
      const record = this.record();
      if (!record) {
        // TODO(2026-11-24): Remove the legacy session fallback after one Botkins release.
        return this.ctx.run(NAME, "pass-cli", args, this.ctx.protonLegacyEnv());
      }
      if (!record.agent) throw new Failure(SIGN_IN);
      if (this.ctx.now() >= record.expiresAt || this.revoked === record.agent) throw new Failure(EXPIRED);
      if (vaultId && !record.vaults.some((v) => v.id === vaultId)) throw new Failure(UNSHARED);
      if (args[0] === "vault" && args[1] === "list") return JSON.stringify(record.vaults);
      const tool = await this.tool();
      if (!tool) throw new Failure("Install Proton Pass before reading linked credentials.");
      const dir = this.agentDir(record.agent);
      const { token, key: sessionKey } = this.record(true);
      const env = this.env(dir, sessionKey, { PROTON_PASS_AGENT_REASON: AUDIT_REASON });
      const logIn = async () => {
        this.lease = 0;
        await this.removeSession(record.agent);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await this.loginAgent(tool.cli, env, token);
        this.lease = this.ctx.now() + LEASE;
      };
      try {
        if (this.ctx.now() >= this.lease) await logIn();
        try {
          return await this.execute(tool.cli, args, env);
        } catch {
          await logIn();
          return await this.execute(tool.cli, args, env);
        }
      } catch (error) {
        if (error.code === "expired") {
          this.revoked = record.agent;
          this.changed();
        }
        throw failure(error);
      }
    });
  }
}
