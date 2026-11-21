// Credentials, the vault, password managers and the rest of a provider: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// The socket has no way to know that a person is there: whoever connects is the owner, and that is also a bot's shell. So a call that reaches a secret which the caller cannot read by itself, or that sends such a secret somewhere, is not for the socket. It stays where a person is known to be there: the window, or a phone with its owner check.
//
// The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone." Two things follow from that sentence and are its working-out, not his words: a saved credential gets no new label from the socket, and `voice set` takes no address without its key.
//
// What these calls hold to (desktop/AGENTS.md, and the rule for secrets above):
//  - A secret's value never leaves the service through a call here. Each answer is cut to what a list may show: an id, a name, a
//    kind, where it is read from or used, and when it was saved. A new value goes in, as text, and is dropped.
//  - A value is text. A reference to a saved credential, { "$credential": id }, is refused in every call here (the last lines of
//    this file; desktop/terminal/control.mjs, CREDENTIAL_REFERENCES_ON_THE_SOCKET): a caller on the socket cannot choose where a
//    saved secret goes.
//  - A saved credential that exists gets a new value from here, and nothing else: not another name, website, kind, user name or
//    note. A new label on a real secret makes a person pick it by mistake later. That stays with the window and the phone.
//  - A password manager's items, its fields and its master password are not here. Unlocking one gives every later caller of the
//    socket what is in it, and linking a field makes a saved credential that a caller named. Those stay with the window and the phone.
//  - What a call changes leaves one line in the log (coverage.mjs, CHANGES): the call and a name, never a value.
import { holdsReference } from "../savedcredentials.mjs";
import { ControlError } from "./socket.mjs";

const KINDS = ["api-key", "login", "note"];
const NOT_FROM_HERE = "A saved credential gets another name, website or kind in the app's window or on a paired phone. From here you can give it a new value, or remove it and save it again.";
// Each field that the app's save takes for a credential that exists, and that is not its value.
const SHOWN_AS = ["name", "kind", "username", "website", "notes"];
const REFUSED = "A saved credential is chosen in the app's window or on a paired phone. From the command line, give the value itself.";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const iso = (time) => (Number.isFinite(time) ? new Date(time).toISOString() : null);
/** One of a list by its id, or by its name when exactly one has it (copied from control-tools.mjs). */
function pick(list, ref, what, see, key = "name") {
  const wanted = text(ref, 200, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const named = list.filter((entry) => String(entry[key] ?? "").toLowerCase() === wanted.toLowerCase());
  if (named.length > 1) throw new ControlError("More than one " + what + " is called " + wanted + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  if (!named.length) throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
  return named[0];
}
/** What a field is, when a caller gives it: text, or left out. */
const optionalText = (value, max, what) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new ControlError("The " + what + " is text of up to " + max + " characters.", "BAD_ARGUMENT");
  return value;
};

/** A saved credential as the command line shows it: no value, no user name, no notes. */
const credentialView = (entry) => ({
  id: entry.id,
  name: entry.name,
  kind: entry.kind,
  // "vault" when Botkins keeps the value; a password manager's id when the value stays there and is read each time.
  source: entry.source ?? "vault",
  ...(entry.reference && { reference: entry.reference }),
  ...(entry.website && { website: entry.website }),
  createdAt: iso(entry.createdAt),
  updatedAt: iso(entry.updatedAt),
});
/** The mark `{ agreed: true }` as the last argument: the caller showed what goes and got a yes (on the command line, `--yes`). */
const agreedBy = (options) => options !== null && typeof options === "object" && !Array.isArray(options) && options.agreed === true;
const needsYes = (what, command) => new ControlError(what + " needs a yes, because it cannot be got back. Show it to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `" + command + " --yes`).", "NEEDS_YES");
/** A manager's state: its words and an install hint, nothing else. */
const managerView = (entry) => ({
  id: entry.id,
  name: entry.name,
  state: entry.state,
  ...(entry.version && { version: entry.version }),
  ...(entry.account && { account: entry.account }),
  ...(entry.message && { message: entry.message }),
  ...(entry.canUnlock && { canUnlock: true }),
  ...(entry.install && { install: entry.install }),
});
const LIMIT = ["id", "label", "percentRemaining", "percentUsed", "resetAt", "primary", "window", "model", "used", "limit", "unit", "unlimited"];
const keep = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));
/** One provider's plan and limits, each key named: nothing that a provider added is passed on. */
const usageView = (entry) => ({
  ...keep(entry, ["provider", "name", "plan", "account"]),
  limits: (Array.isArray(entry.limits) ? entry.limits : []).map((limit) => keep(limit, LIMIT)),
  ...keep(entry, ["credits", "note", "source", "updatedAt", "error"]),
});

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param signIns    The service's sign-in sessions (desktop/terminal/signin.mjs).
 */
export function credentialsApi({ workspace, handlers, signIns }) {
  const saved = async () => (await handlers.savedCredentials()).entries;
  const providers = () => workspace.providers;
  /** A model provider by its id, or by its name when exactly one has it. An install also reaches a harness that is a program of its own (Pi). */
  const provider = (ref, { harnesses = false } = {}) => {
    const wanted = text(ref, 200, "a provider's name or id");
    const list = harnesses ? [...providers().list, ...providers().harnesses] : providers().list;
    const found = list.find((entry) => entry.id === wanted) ?? (() => {
      const named = list.filter((entry) => String(entry.name ?? "").toLowerCase() === wanted.toLowerCase());
      if (named.length > 1) throw new ControlError("More than one provider is called " + wanted + ". Use its id (see `botkins providers list`).", "AMBIGUOUS");
      return named[0];
    })();
    if (!found) throw new ControlError("There is no model provider called " + wanted + ". See `botkins providers list`.", "NOT_FOUND");
    return found;
  };
  /** What an install would run, for the caller to look at first. Throws when there is nothing to install. */
  const installPlan = async (ref) => {
    const found = provider(ref, { harnesses: true });
    const status = await providers().status(found.id);
    if (status?.installed) throw new ControlError(found.name + " is already installed.", "INSTALLED");
    const guide = status?.install?.url ? " Its guide: " + status.install.url : "";
    const command = typeof status?.install?.command === "string" ? status.install.command : "";
    if (!command) throw new ControlError(found.name + " can't be installed from Botkins." + guide, "NO_INSTALL");
    if (signIns.platform === "win32") throw new ControlError("Installing from Botkins works on macOS and Linux. Install " + found.name + " on this computer." + guide, "UNSUPPORTED");
    return { id: found.id, name: found.name, command, ...(status.install.url && { url: status.install.url }) };
  };

  const api = {
    // ── Saved credentials ──
    /** { locked, entries }: names and where each is read from. Never a value, a user name or a note. */
    async "credentials.list"() {
      const { locked, entries } = await handlers.savedCredentials();
      return { locked: locked === true, entries: entries.map(credentialView) };
    },
    /** A new credential. `value` is its text, and it is dropped once it is stored. Answers the credential without it. */
    async "credentials.save"([input = {}]) {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ControlError("Give the credential as an object: { name, value, kind?, username?, website?, notes? }.", "BAD_ARGUMENT");
      const name = text(input.name, 80, "the credential a name");
      const kind = input.kind === undefined ? "api-key" : input.kind;
      if (!KINDS.includes(kind)) throw new ControlError("A credential's kind is one of: " + KINDS.join(", ") + ".", "BAD_ARGUMENT");
      if (typeof input.value !== "string" || !input.value.trim()) throw new ControlError("Give the value to save, as text.", "BAD_ARGUMENT");
      const fields = { username: optionalText(input.username, 200, "user name"), website: optionalText(input.website, 300, "website"), notes: optionalText(input.notes, 2000, "notes") };
      // Two with one name could not be told apart by name.
      if ((await saved()).some((entry) => String(entry.name).toLowerCase() === name.toLowerCase())) throw new ControlError("A saved credential is called " + name + " already. Give it a new value with `botkins credentials edit`, or use another name.", "EXISTS");
      const id = await handlers.saveSavedCredential({ name, kind, value: input.value, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });
      return credentialView((await saved()).find((entry) => entry.id === id) ?? { id, name, kind });
    },
    /** Gives one a new value. `patch` is `{ value }` and nothing else: the name, kind, user name, website and notes of a credential that exists are not for the socket. */
    async "credentials.edit"([ref, patch = {}, options]) {
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give the new value as an object: { value }.", "BAD_ARGUMENT");
      const found = pick(await saved(), ref, "saved credential", "botkins credentials list");
      const given = Object.keys(patch).filter((key) => patch[key] !== undefined);
      if (given.some((key) => SHOWN_AS.includes(key))) throw new ControlError(NOT_FROM_HERE, "NOT_FROM_HERE");
      if (given.some((key) => key !== "value")) throw new ControlError("Give the new value as { value }.", "BAD_ARGUMENT");
      if (typeof patch.value !== "string" || !patch.value.trim()) throw new ControlError("Give the new value as text.", "BAD_ARGUMENT");
      if (!agreedBy(options)) throw needsYes("Replacing the value of " + found.name + ", which overwrites the old one,", "botkins credentials edit");
      // The app's save needs the name each time; it is the name that the credential has. The user name, website and notes stay as they are.
      await handlers.saveSavedCredential({ id: found.id, name: found.name, value: patch.value });
      return credentialView((await saved()).find((entry) => entry.id === found.id) ?? found);
    },
    /** Whether the value can be read now. It is read on this computer and dropped. */
    async "credentials.check"([ref]) {
      const found = pick(await saved(), ref, "saved credential", "botkins credentials list");
      const result = await handlers.checkSavedCredential(found.id);
      return { id: found.id, name: found.name, ok: result?.ok === true, ...(result?.ok !== true && result?.message && { message: String(result.message).slice(0, 300) }) };
    },
    async "credentials.remove"([ref, options]) {
      const found = pick(await saved(), ref, "saved credential", "botkins credentials list");
      if (!agreedBy(options)) throw needsYes("Removing the saved credential " + found.name, "botkins credentials remove");
      await handlers.removeSavedCredential(found.id);
      return { removed: found.id, name: found.name };
    },

    // ── The vault: the keys and sign-ins of tools and providers ──
    /** What the vault holds, without a value, and whether this computer can open it. */
    "credentials.vault"() {
      const vault = handlers.credentials();
      return {
        protection: vault.protection,
        locked: "locked" in vault,
        ...("locked" in vault && vault.locked && { reason: String(vault.locked) }),
        entries: vault.entries.map((entry) => ({ id: entry.id, name: entry.label, kind: entry.kind, usedBy: entry.usedBy ?? entry.owner ?? "", createdAt: iso(entry.createdAt), updatedAt: iso(entry.updatedAt) })),
      };
    },
    /** Takes one entry out of the vault (a sign-in is signed out; a key's name stays on its tool, to be entered again). */
    async "credentials.vaultRemove"([ref, options]) {
      const found = pick(handlers.credentials().entries.map((entry) => ({ id: entry.id, name: entry.label })), ref, "vault entry", "botkins vault list");
      if (!agreedBy(options)) throw needsYes("Removing " + found.name + " from the vault", "botkins vault remove");
      await handlers.removeCredential(found.id);
      return { removed: found.id, name: found.name };
    },
    /** Sets a vault that this computer cannot open aside, and starts an empty one. Every key and sign-in in it has to be entered again. */
    async "credentials.vaultReset"([options]) {
      if (!agreedBy(options)) throw needsYes("Resetting the vault, which loses every key and sign-in in it,", "botkins vault reset");
      await handlers.resetVault();
      return { reset: true };
    },

    // ── Password managers: their state, and locking one ──
    async "credentials.managers"([refresh]) {
      return (await handlers.passwordManagers(refresh === true)).map(managerView);
    },
    async "credentials.managerLock"([ref]) {
      const found = pick(await handlers.passwordManagers(false), ref, "password manager", "botkins password-managers list");
      return managerView(await handlers.lockPasswordManager(found.id));
    },

    // ── The rest of a provider: its plan and limits, installing its tool, and a model service ──
    /** Each connected provider's plan and what is left of its limits. Holds no token, email or account id. */
    async "providers.usage"([options = {}]) {
      const only = options?.provider === undefined ? null : provider(options.provider).id;
      return (await handlers.providerUsage({ refresh: options?.refresh === true })).filter((entry) => !only || entry.provider === only).map(usageView);
    },
    /** The command that an install would run on this computer, for a person to look at first. Nothing runs. */
    "providers.installPlan": ([ref]) => installPlan(ref),
    /**
     * Installs a provider's command-line tool, in a shell on this computer, as the user that runs Botkins. The command is the
     * provider's own (signin.mjs); the caller says which command it looked at, and a different one is refused.
     */
    async "providers.install"([ref, options = {}]) {
      const plan = await installPlan(ref);
      if (typeof options?.command !== "string" || options.command !== plan.command) throw new ControlError("Say which command you looked at: it is `" + plan.command + "`. Run `botkins providers install " + plan.id + "` to see it first.", "BAD_ARGUMENT");
      return signIns.install(plan.id, {});
    },
    "providers.install.read": ([session, after], { signal }) => signIns.read(String(session), { after: Number(after) || 0, signal }),
    "providers.install.input": ([session, line]) => void signIns.input(String(session), line),
    "providers.install.cancel": ([session]) => signIns.cancel(String(session)),
    /** Takes a model service (OpenCode's) away: its key or sign-in is removed. By the service's id, or by its name. */
    async "providers.disconnectService"([ref, serviceRef, options]) {
      const found = provider(ref);
      const wanted = text(serviceRef, 200, "a model service's name or id");
      const service = pick(await found.services(wanted), wanted, "model service", "botkins providers services " + found.id);
      if (!service.connected) throw new ControlError(service.name + " is not connected.", "NOT_CONNECTED");
      if (!agreedBy(options)) throw needsYes("Disconnecting " + service.name + ", which removes its key or sign-in,", "botkins providers disconnect");
      await handlers.disconnectProviderService(found.id, service.id);
      return { provider: found.id, service: service.id, name: service.name };
    },
  };
  // A reference to a saved credential is refused by every call here (see the top of this file).
  return Object.fromEntries(
    Object.entries(api).map(([name, call]) => [
      name,
      (args, context) => {
        if (holdsReference(args)) throw new ControlError(REFUSED, "BAD_ARGUMENT");
        return call(args, context);
      },
    ]),
  );
}
