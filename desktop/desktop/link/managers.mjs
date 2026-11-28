// Password managers, read through their own command-line tools: 1Password (op), Bitwarden (bw)
// and Proton Pass (pass-cli). Each driver has the same small shape:
//   status()                      → PasswordManagerStatus
//   vaults()                      → [{ id, name, count? }]
//   items(vaultId, query)         → [{ id, title, subtitle? }]
//   item(vaultId, itemId)         → { id, title, subtitle?, fields: [{ id, label, secret }] }
//   read({ vaultId, itemId, fieldId }) → the value, as text
//   unlock?(password) / lock?()   → Bitwarden only
// Values are only returned by read(). Everything else returns labels. A tool's own error text is
// never passed on: a driver throws a Failure whose message is a short sentence.
import { Failure, findShim, findTool, inherit, parseJson, runTool, toolEnv } from "./tools.mjs";
import { protonVaults } from "./proton-setup.mjs";
import { generateTotp } from "./totp.mjs";

const IDLE_LOCK = 8 * 60 * 60_000;
const UNLOCK_TRIES = 5; // a minute's worth
const MAX_ITEMS = 200;

/** Extract up to 10 non-empty URL strings from a manager item's URL list. */
function cleanUrls(items) {
  const out = [];
  const seen = new Set();
  for (const raw of list(items)) {
    const url = typeof raw === "string" ? raw : typeof raw?.href === "string" ? raw.href : typeof raw?.uri === "string" ? raw.uri : "";
    const trimmed = url.trim().slice(0, 300);
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
    if (out.length >= 10) break;
  }
  return out;
}

/** An id from a phone, before it goes to a command. A leading "-" could be taken for an option. */
function cleanId(value, what) {
  const id = typeof value === "string" ? value : "";
  if (!/^[\w.:@=+~-]{1,200}$/.test(id) || id.startsWith("-")) throw new Failure("That " + what + " isn't valid.");
  return id;
}
const cleanQuery = (query) => String(query ?? "").replace(/^[\s-]+/, "").trim().slice(0, 100);
const matches = (query, ...texts) => {
  const q = query.toLowerCase();
  return !q || texts.some((text) => String(text ?? "").toLowerCase().includes(q));
};
const text = (value, limit = 200) => (typeof value === "string" ? value.slice(0, limit) : undefined);
const list = (value) => (Array.isArray(value) ? value : []);
const pick = (object, ...keys) => keys.map((key) => object?.[key]).find((value) => value != null);

/** What a driver needs from its surroundings: the folders to find tools in, the clock, and a runner. */
export function context({ dirs, now = Date.now, platform = process.platform }) {
  return {
    now,
    find: (name) => findTool(name, dirs, platform),
    shim: (name) => findShim(name, dirs, platform),
    /** Runs `name` with `args`. `env` holds the manager's own variables. */
    run: (label, name, args, env = {}) => runTool(label, findTool(name, dirs, platform), args, { env: toolEnv(dirs, env) }),
    dirs,
    /** The system the tools are looked for on (the app's own, or the one a caller named). */
    platform,
    protonLegacyEnv: () => inherit(["PROTON_PASS", "PASS_CLI"]),
  };
}

/** The status of a manager whose tool isn't there. A Windows .cmd script is said so: it can't be run safely from here. */
function missing(ctx, base, tool, install) {
  const script = ctx.shim(tool) && " The copy found here is a .cmd script, which can't be run safely from this app. Install its standalone program (.exe) instead.";
  return { ...base, state: "missing", message: "Install the " + base.name + " command-line tool (" + tool + ") on your computer." + (script || ""), install };
}
/** A tool that didn't answer in time or is too busy to start isn't "signed out". */
const stalled = (error) => error.kind === "timeout" || error.kind === "busy";

// ── 1Password ─────────────────────────────────────────────────────────────────────────────────

export function onePassword(ctx) {
  const id = "onepassword";
  const name = "1Password";
  const env = () => inherit(["OP_"]);
  const op = (args) => ctx.run(name, "op", args, env());
  const base = { id, name };
  return {
    ...base,
    async status() {
      if (!ctx.find("op")) return missing(ctx, base, "op", { url: "https://developer.1password.com/docs/cli/get-started/", command: ctx.platform === "darwin" ? "brew install --cask 1password-cli" : undefined });
      let version;
      try {
        version = text(String(await op(["--version"])).trim(), 40);
      } catch (error) {
        return { ...base, state: "error", message: error.message };
      }
      try {
        const who = parseJson(name, await op(["whoami", "--format", "json"]));
        return { ...base, state: "ready", version, ...(text(who?.email ?? who?.url) && { account: text(who?.email ?? who?.url) }) };
      } catch (error) {
        if (stalled(error)) return { ...base, state: "error", version, message: error.message };
        return { ...base, state: "signed-out", version, message: "Open 1Password and turn on its CLI integration, or sign in with `op signin`." };
      }
    },
    async vaults() {
      const vaults = parseJson(name, await op(["vault", "list", "--format", "json"]));
      return list(vaults).filter((v) => text(v?.id) && text(v?.name)).map((v) => ({ id: v.id, name: text(v.name) }));
    },
    async items(vaultId, query) {
      const vault = cleanId(vaultId, "vault");
      const q = cleanQuery(query);
      const items = parseJson(name, await op(["item", "list", "--vault", vault, "--format", "json"]));
      return list(items)
        .filter((i) => {
          const urls = cleanUrls(i?.urls);
          return text(i?.id) && matches(q, i.title, i.additional_information, ...urls);
        })
        .slice(0, MAX_ITEMS)
        .map((i) => {
          const urls = cleanUrls(i?.urls);
          return {
            id: i.id,
            title: text(i.title) || "Untitled",
            ...(text(i.additional_information) && { subtitle: text(i.additional_information) }),
            ...(urls.length > 0 && { urls }),
          };
        });
    },
    async item(vaultId, itemId) {
      const vault = cleanId(vaultId, "vault");
      const item = cleanId(itemId, "item");
      const found = parseJson(name, await op(["item", "get", item, "--vault", vault, "--format", "json"]));
      // The answer holds the values. Only each field's id, label and whether it is hidden are kept.
      const fields = list(found?.fields)
        .filter((f) => text(f?.id) && (text(f.label) || text(f.id)) && ((f.type === "OTP" && (f.value != null || f.totp != null)) || (f.type !== "OTP" && f.value != null && f.value !== "")))
        .map((f) => ({
          id: f.id,
          label: text(f.label) || (f.type === "OTP" ? "One-time password" : f.id),
          secret: f.type === "CONCEALED" || f.type === "OTP",
          ...(f.type === "OTP" && { totp: true }),
        }));
      const urls = cleanUrls(found?.urls);
      return { id: item, title: text(found?.title) || "Untitled", ...(urls.length > 0 && { urls }), fields };
    },
    async read({ vaultId, itemId, fieldId, totp = false }) {
      const vault = cleanId(vaultId, "vault");
      const item = cleanId(itemId, "item");
      const field = cleanId(fieldId, "field");
      if (totp) {
        try {
          const code = String(await op(["item", "get", item, "--vault", vault, "--otp"])).trim();
          if (/^\d{6,10}$/.test(code)) return code;
        } catch {
          // Fall back to reading the OTP field directly (e.g. otpauth:// URI or op read ?attribute=otp).
        }
        const raw = String(await op(["read", "--no-newline", "op://" + vault + "/" + item + "/" + field + "?attribute=otp"])).trim();
        return generateTotp(raw, { allowCodePassthrough: true }).code;
      }
      const uri = "op://" + vault + "/" + item + "/" + field;
      return String(await op(["read", "--no-newline", uri]));
    },
  };
}

// ── Bitwarden ─────────────────────────────────────────────────────────────────────────────────

export function bitwarden(ctx) {
  const id = "bitwarden";
  const name = "Bitwarden";
  const base = { id, name, canUnlock: false };
  // The session lives in memory only. It is forgotten after 8 idle hours, and by lock().
  let session = null;
  let used = 0;
  const forget = () => {
    session = null;
  };
  const token = () => {
    if (session && ctx.now() - used > IDLE_LOCK) forget();
    return session;
  };
  const locked = () => new Failure("Bitwarden is locked. Unlock it first.");
  /** Every call is non-interactive, and carries the session in its environment (a command line can be read by other users). */
  const bw = (args, env = {}) => ctx.run(name, "bw", [...args, "--nointeraction"], { ...inherit(["BITWARDENCLI_"]), ...(token() && { BW_SESSION: token() }), ...env });
  /** A command that needs the unlocked vault. */
  const authed = async (args) => {
    if (!token()) throw locked();
    const out = await bw(args);
    used = ctx.now();
    return out;
  };
  const tries = []; // when each unlock was tried, in the last minute
  const fieldsOf = (item) => {
    const fields = [];
    const login = item?.login;
    if (text(login?.username)) fields.push({ id: "username", label: "Username", secret: false });
    if (text(login?.password)) fields.push({ id: "password", label: "Password", secret: true });
    if (text(login?.totp)) fields.push({ id: "totp", label: "One-time password", secret: true });
    for (const f of list(item?.fields)) if (text(f?.name) && f.type !== 3 && f.value != null && f.value !== "") fields.push({ id: "field:" + f.name.slice(0, 100), label: f.name.slice(0, 100), secret: f.type === 1 });
    return fields;
  };
  const getItem = async (itemId) => parseJson(name, await authed(["get", "item", cleanId(itemId, "item")]));
  return {
    ...base,
    async status() {
      if (!ctx.find("bw")) return missing(ctx, base, "bw", { url: "https://bitwarden.com/help/cli/", command: ctx.platform === "darwin" ? "brew install bitwarden-cli" : undefined });
      let version;
      try {
        version = text(String(await bw(["--version"])).trim(), 40);
      } catch (error) {
        return { ...base, state: "error", message: error.message };
      }
      let now;
      try {
        now = parseJson(name, await bw(["status"]));
      } catch (error) {
        return { ...base, state: "error", version, message: error.message };
      }
      const account = text(now?.userEmail);
      const more = { version, ...(account && { account }) };
      if (now?.status === "unauthenticated") return { ...base, state: "signed-out", ...more, message: "Log in with `bw login` on your computer first." };
      if (now?.status === "unlocked" && token()) return { ...base, state: "ready", ...more };
      forget();
      return { ...base, state: "locked", canUnlock: true, ...more, message: "Enter your master password to unlock Bitwarden." };
    },
    /** The master password goes to the tool in its environment only, never on its command line. */
    async unlock(password) {
      const t = ctx.now();
      while (tries.length && t - tries[0] >= 60_000) tries.shift();
      if (tries.length >= UNLOCK_TRIES) throw new Failure("Too many tries. Wait a minute.");
      tries.push(t);
      try {
        const out = String(await bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { BW_PASSWORD: password })).trim();
        if (!out) throw new Failure("");
        session = out;
        used = ctx.now();
      } catch (error) {
        if (error.kind === "missing") throw error;
        throw new Failure("Bitwarden didn't unlock. Check the master password.");
      }
    },
    async lock() {
      forget();
      await bw(["lock"]).catch(() => {});
    },
    async vaults() {
      const folders = parseJson(name, await authed(["list", "folders"]));
      const found = list(folders).filter((f) => text(f?.id) && text(f?.name)).map((f) => ({ id: f.id, name: text(f.name) }));
      return [...found, { id: "none", name: "No folder" }];
    },
    async items(vaultId, query) {
      const folder = vaultId === "none" ? "null" : cleanId(vaultId, "folder");
      const q = cleanQuery(query);
      const items = parseJson(name, await authed(["list", "items", "--folderid", folder, ...(q ? ["--search", q] : [])]));
      return list(items)
        .filter((i) => text(i?.id))
        .slice(0, MAX_ITEMS)
        .map((i) => {
          const urls = cleanUrls(i.login?.uris);
          return {
            id: i.id,
            title: text(i.name) || "Untitled",
            ...(text(i.login?.username) && { subtitle: text(i.login.username) }),
            ...(urls.length > 0 && { urls }),
          };
        });
    },
    async item(_vaultId, itemId) {
      const item = await getItem(itemId);
      const urls = cleanUrls(item?.login?.uris);
      return { id: itemId, title: text(item?.name) || "Untitled", ...(urls.length > 0 && { urls }), fields: fieldsOf(item) };
    },
    async read({ itemId, fieldId, totp = false }) {
      // A one-time password is read as the code that is valid now, not as its seed.
      if (totp || fieldId === "totp") return String(await authed(["get", "totp", cleanId(itemId, "item")])).trim();
      const item = await getItem(itemId);
      const value = fieldId === "username" ? item?.login?.username : fieldId === "password" ? item?.login?.password : list(item?.fields).find((f) => typeof f?.name === "string" && "field:" + f.name.slice(0, 100) === fieldId)?.value;
      if (typeof value !== "string" || !value) throw new Failure("That field is empty or gone.");
      return value;
    },
  };
}

// ── Proton Pass ───────────────────────────────────────────────────────────────────────────────
// The parser accepts the documented shapes and the spellings previously accepted by Botkins.

export function protonPass(ctx, setup) {
  const id = "protonpass";
  const name = "Proton Pass";
  const base = { id, name };
  const legacy = (args) => ctx.run(name, "pass-cli", args, ctx.protonLegacyEnv());
  const pass = (makeArgs, vault) => setup ? setup.run(makeArgs, vault) : legacy(makeArgs(vault));
  const array = (value, key) => (Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : []);
  const loginOf = (item) => item?.content?.content?.Login ?? item?.content?.login ?? item?.login ?? item?.content ?? item ?? {};
  const fieldsOf = (item) => {
    const login = loginOf(item);
    const fields = [];
    if (text(login.username)) fields.push({ id: "username", label: "Username", secret: false });
    if (text(login.email)) fields.push({ id: "email", label: "Email", secret: false });
    if (text(login.password)) fields.push({ id: "password", label: "Password", secret: true });
    if (text(login.totp_uri ?? login.totp)) fields.push({ id: "totp", label: "One-time password", secret: true });
    for (const f of list(item?.content?.extra_fields ?? item?.extra_fields)) {
      const label = text(f?.title ?? f?.name ?? f?.label, 100);
      if (label) fields.push({ id: "extra:" + label, label, secret: /hidden|secret|password|totp/i.test(String(f?.kind ?? f?.type ?? f?.field_type ?? "")) });
    }
    return fields;
  };
  return {
    ...base,
    async status() {
      if (setup) return setup.status();
      if (!ctx.find("pass-cli")) return missing(ctx, base, "pass-cli", { url: "https://proton.me/pass" });
      let version;
      try {
        version = /\d+\.\d+\.\d+/.exec(String(await legacy(["--version"])))?.[0];
      } catch (error) {
        return { ...base, state: "error", message: error.message };
      }
      try {
        const who = parseJson(name, await legacy(["info", "--output", "json"]));
        const account = text(pick(who, "email", "user_email", "username") ?? pick(who?.user, "email", "username"));
        return { ...base, state: "ready", ...(version && { version }), ...(account && { account }) };
      } catch (error) {
        if (stalled(error)) return { ...base, state: "error", ...(version && { version }), message: error.message };
        return { ...base, state: "signed-out", ...(version && { version }), message: "Sign in with `pass-cli login` on your computer." };
      }
    },
    async vaults() {
      return protonVaults(parseJson(name, await pass(() => ["vault", "list", "--output", "json"])));
    },
    async items(vaultId, query) {
      const share = cleanId(vaultId, "vault");
      const q = cleanQuery(query);
      // No --show-secrets: the list holds titles, not values.
      const items = array(parseJson(name, await pass((shareId) => ["item", "list", "--share-id=" + shareId, "--output", "json"], share)), "items");
      return items
        .map((i) => {
          const login = loginOf(i);
          const urls = cleanUrls(login.urls ?? i?.content?.urls ?? i?.urls);
          return {
            id: pick(i, "id", "item_id", "itemId"),
            title: text(pick(i, "title", "name") ?? i?.content?.title ?? i?.content?.name),
            subtitle: text(login.username ?? login.email),
            urls,
          };
        })
        .filter((i) => text(i.id) && matches(q, i.title, i.subtitle, ...i.urls))
        .slice(0, MAX_ITEMS)
        .map((i) => ({
          id: i.id,
          title: i.title || "Untitled",
          ...(i.subtitle && { subtitle: i.subtitle }),
          ...(i.urls.length > 0 && { urls: i.urls }),
        }));
    },
    async item(vaultId, itemId) {
      const share = cleanId(vaultId, "vault");
      const item = cleanId(itemId, "item");
      const found = parseJson(name, await pass((shareId) => ["item", "view", "--share-id=" + shareId, "--item-id=" + item, "--output", "json"], share));
      const body = found?.item ?? found;
      const login = loginOf(body);
      const urls = cleanUrls(login.urls ?? body?.content?.urls ?? body?.urls);
      return {
        id: item,
        title: text(pick(body, "title", "name") ?? body?.content?.title ?? body?.content?.name) || "Untitled",
        ...(urls.length > 0 && { urls }),
        fields: fieldsOf(body),
      };
    },
    async read({ vaultId, itemId, fieldId, totp = false }) {
      const share = cleanId(vaultId, "vault");
      const item = cleanId(itemId, "item");
      const field = String(fieldId ?? "").replace(/^extra:/, "");
      if (!field || /^[\s-]/.test(field) || field.length > 120 || /[\x00-\x1f]/.test(field)) throw new Failure("That field isn't valid.");
      if (setup?.record()?.agent && (totp || fieldId === "totp")) {
        const code = String(await pass((shareId) => ["item", "view", "pass://" + shareId + "/" + item + "/totp?totp=code"], share)).trim();
        if (!/^\d{6,10}$/.test(code)) throw new Failure("Proton Pass didn't return a one-time code.");
        return code;
      }
      const raw = String(await pass((shareId) => ["item", "view", "--share-id=" + shareId, "--item-id=" + item, "--field=" + field], share)).replace(/\r?\n$/, "");
      if (totp || fieldId === "totp") {
        try {
          return generateTotp(raw, { allowCodePassthrough: true }).code;
        } catch {
          return raw;
        }
      }
      return raw;
    },
  };
}

/** All three drivers, in the order the phone lists them. */
export function drivers(options) {
  const ctx = context(options);
  return [onePassword(ctx), bitwarden(ctx), protonPass(ctx, options.proton?.(ctx))];
}
