// Settings › Credentials, on this computer: the saved credentials and password managers the phone
// link already keeps (desktop/link/credentials.mjs, `link.credentials`), for this window's page.
//
// Every call goes straight to the link's Credentials and gives back plain data: labels, names and
// states, never a value. A value typed in here goes one way, into the encrypted store; a master
// password goes to its manager's tool and is dropped. Nothing here logs, keeps or returns either.
// What fails arrives as one plain sentence (the link's own Failure messages already are).
//
// The same store answers a bot's question: the page answers with { $credential: id } in place of
// text, and respondArgs() swaps the value in, on this computer, just before the answer reaches the
// workspace, exactly as the link does for a phone's answer.
import { delimiter, isAbsolute } from "node:path";
import { Failure } from "./link/tools.mjs";

export const NOT_READY = "Saved credentials aren't ready yet. Try again in a moment.";
export const LOCKED =
  "The saved credentials are locked on this computer, so they can't be changed right now. Quit and reopen Botkins, and allow it to use the keychain when it asks.";
const WENT_WRONG = "Something went wrong with the saved credentials. Try again.";

const MANAGERS = ["onepassword", "bitwarden", "protonpass"];
const KINDS = ["api-key", "login", "note"];
// What the page may see of each thing. Anything else a store or a tool hands back is left out.
const ENTRY = ["id", "name", "kind", "username", "website", "notes", "source", "reference", "createdAt", "updatedAt"];
const STATUS = ["id", "name", "state", "version", "account", "message", "canUnlock", "setup", "source", "expiresAt", "sharedVaults", "step", "code", "unsupported"];

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keep = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));
const short = (value, limit = 200) => (typeof value === "string" ? value.slice(0, limit) : undefined);

/** Whether a value holds a credential reference anywhere ({ "$credential": … }). */
export function holdsReference(value, depth = 0) {
  if (depth > 64 || value === null || typeof value !== "object") return false;
  if (isPlain(value) && Object.hasOwn(value, "$credential")) return true;
  return Object.values(value).some((inner) => holdsReference(inner, depth + 1));
}

/** A failure as the page shows it: the store's own sentence, or a plain one of ours. */
function plain(error) {
  if (error instanceof Failure) return error;
  return new Failure(WENT_WRONG);
}

function managerId(value) {
  if (!MANAGERS.includes(value)) throw new Failure("That password manager isn't supported.");
  return value;
}
const text = (value, what) => {
  if (typeof value !== "string" || !value || value.length > 200) throw new Failure("That " + what + " isn't valid.");
  return value;
};

/**
 * The page's calls. `get` returns the link's Credentials, or null before the link is made.
 * @param options.get  () => Credentials | null
 */
export class SavedCredentials {
  constructor({ get }) {
    this.get = get;
  }
  store() {
    const store = this.get();
    if (!store) throw new Failure(NOT_READY);
    return store;
  }
  /** Runs a call on the store; whatever fails becomes a sentence. */
  async run(task) {
    try {
      return await task(this.store());
    } catch (error) {
      throw plain(error);
    }
  }
  /** A store that can be changed. A locked one says why in words that fit this computer. */
  async change(task) {
    return this.run((store) => {
      if (store.locked) throw new Failure(LOCKED);
      return task(store);
    });
  }

  // ── Saved credentials ─────────────────────────────────────────────────────────────────────

  /** { locked, entries }: names, kinds and where each comes from. Never a value. */
  async list() {
    return this.run((store) => ({ locked: !!store.locked, entries: store.list().map((entry) => keep(entry, ENTRY)) }));
  }
  /** Adds one typed in here, or changes one (`id`). `value` null or left out keeps the saved value. Returns the id. */
  async save(input) {
    if (!isPlain(input)) throw new Failure("That credential can't be saved.");
    const clean = keep(input, ["id", "name", "kind", "username", "website", "notes", "value"]);
    if (clean.kind !== undefined && !KINDS.includes(clean.kind)) throw new Failure("That kind of credential isn't supported.");
    return this.change(async (store) => String(await store.save(clean)));
  }
  async remove(id) {
    text(id, "credential");
    await this.change((store) => store.remove(id));
  }
  /** Whether it can be read right now: { ok, message? }. The value is read and dropped on the computer. */
  async check(id) {
    text(id, "credential");
    return this.run(async (store) => {
      const result = await store.check(id);
      return result?.ok ? { ok: true } : { ok: false, message: short(result?.message, 300) ?? "It can't be read right now." };
    });
  }

  // ── Password managers ─────────────────────────────────────────────────────────────────────

  /** Each manager's state, and the one thing to do next. `refresh` looks again now. */
  async managers(refresh = false) {
    return this.run(async (store) => (await store.managers(refresh === true)).map(status));
  }
  protonPass(method, input) {
    return this.run((store) => store.protonPass(method, input));
  }
  /** Bitwarden: the master password goes to its tool and is dropped. Returns the new state. */
  async unlock(manager, password) {
    managerId(manager);
    if (typeof password !== "string" || !password) throw new Failure("Enter the master password.");
    const secret = { password };
    try {
      return status(await this.run((store) => store.unlock(manager, secret)));
    } finally {
      secret.password = "";
    }
  }
  async lock(manager) {
    managerId(manager);
    return status(await this.run((store) => store.lock(manager)));
  }
  async vaults(manager) {
    managerId(manager);
    const vaults = await this.run((store) => store.vaults(manager));
    return (Array.isArray(vaults) ? vaults : []).map((v) => keep({ id: short(v?.id), name: short(v?.name), ...(typeof v?.count === "number" && { count: v.count }) }, ["id", "name", "count"]));
  }
  async items(manager, vaultId, query) {
    managerId(manager);
    text(vaultId, "vault");
    const q = typeof query === "string" ? query.slice(0, 100) : undefined;
    const items = await this.run((store) => store.items(manager, vaultId, q || undefined));
    return (Array.isArray(items) ? items : []).map((i) => keep({ id: short(i?.id), title: short(i?.title), subtitle: short(i?.subtitle) }, ["id", "title", "subtitle"]));
  }
  /** One item and its fields, as labels only. */
  async item(manager, vaultId, itemId) {
    managerId(manager);
    text(vaultId, "vault");
    text(itemId, "item");
    const item = await this.run((store) => store.item(manager, vaultId, itemId));
    const fields = (Array.isArray(item?.fields) ? item.fields : []).map((f) => ({ id: short(f?.id), label: short(f?.label), secret: f?.secret === true })).filter((f) => f.id && f.label);
    return keep({ id: short(item?.id), title: short(item?.title), subtitle: short(item?.subtitle), fields }, ["id", "title", "subtitle", "fields"]);
  }
  /** Saves a field of a manager's item as a credential that is read from there each time. Returns the id. */
  async link(input) {
    if (!isPlain(input)) throw new Failure("That field can't be linked.");
    const { manager, vaultId, itemId, fieldId, name } = input;
    managerId(manager);
    return this.change(async (store) => String(await store.link({ manager, vaultId, itemId, fieldId, name })));
  }

  // ── Answering a bot ───────────────────────────────────────────────────────────────────────

  /**
   * The arguments of a `respond` call with every { $credential: id } in its answer replaced by the
   * value, read now on this computer. An answer without one is passed on as it is (a phone's answer
   * arrives with its values already in). A reference anywhere else in the answer is refused.
   */
  async pluginArgs(method, args) {
    if (!holdsReference(args)) return args;
    return this.run(async store => (await store.resolve(method, args)).args);
  }
  async respondArgs(args) {
    if (!holdsReference(args)) return args;
    return this.run(async (store) => (await store.resolve("respond", args)).args);
  }
}

/** A manager's state for the page: its words, an install hint as it is given, nothing else. */
function status(value) {
  const out = keep(value, STATUS);
  const install = value?.install;
  if (isPlain(install) && typeof install.url === "string" && /^https:\/\//.test(install.url))
    out.install = { url: install.url, ...(typeof install.command === "string" && install.command && { command: install.command }) };
  return out;
}

/**
 * Where a trial run (a data folder of its own: the tests, a development copy) looks for the password
 * managers' tools: only in the folders it names (BOTKINS_TOOL_PATH), and nowhere when it names none.
 * So a test never starts the person's real 1Password, Bitwarden or Proton Pass, or their keychain.
 * The link takes the folders as `managerSearchPath`; the installed app passes none and looks where
 * the link always does.
 */
export function trialToolDirs(toolPath) {
  return String(toolPath ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir));
}
