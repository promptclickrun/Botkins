// Skills and MCP servers for the whole app (Settings › Skills and Settings › MCP servers).
// Every bot gets every enabled skill and server, so nothing has to be set up bot by bot.
// A bot can turn individual ones off on its own page (bot.skillsOff, bot.mcpOff).
//
// Trust: adding a local MCP server means choosing a program Botkins will run. The app's page
// is as trusted for that as it is for the approval setting, which also lets bots run commands.
// Secrets get more care: the page never receives them, they are kept in the credential vault
// (desktop/vault.mjs) and the workspace file holds only references to them, and a stored secret
// can't be kept while the place it is sent to changes.
//
// Signing in: a local server takes its keys as environment values. A remote server takes a key
// in a header, or signs the person in with OAuth (desktop/oauth.mjs): Botkins finds the
// server's sign-in, registers itself when the server allows it, and keeps the tokens in the vault.
//
// Skills are folders holding a SKILL.md. Botkins keeps its own in <data>/skills, and can also
// read folders that stay where they are (linked folders) and plugin folders.
// MCP servers are stored in the workspace file (mode 0600). Their environment values and headers
// often hold keys, so the app's page never receives them: it sees the names only.
export { parseSkill, slug } from "./link/skill-format.mjs";
import { parseSkill, slug } from "./link/skill-format.mjs";
import { templateBundle } from "./link/template-bundle.mjs";
import { McpOAuth, REDIRECT_PORT } from "./oauth.mjs";
import { MANIFESTS as PLUGIN_MANIFESTS } from "./plugin-reading.mjs";
import { isRef } from "./vault.mjs";
import { SCRIPT_FILE, SCRIPT_KIND, cleanScriptCommand, commandKind, hashScript, scriptSkillFile } from "./script-commands.mjs";
import { reachable } from "./terminal/reach.mjs";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundledSkills = fileURLToPath(new URL("./skills/", import.meta.url));
// The built-in skill that teaches a bot the `botkins` command. It is only offered where a bot's shell can run that command.
const COMMAND_SKILL = "use-botkins";
const MAX_SERVERS = 50;
const MAX_SKILL_TEXT = 60000;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const text = (value, max, name) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Enter a " + name + " of up to " + max + " characters.");
  return value.trim();
};
/** An environment variable's name, and a header's name (an HTTP token). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * A map of names to strings. `null` keeps the value already stored under that name, which is
 * refused when `moved` says the server's destination changed. New values go through `seal`.
 */
function pairs(value, existing = {}, name, { seal = (text) => text, moved = false } = {}) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid " + name);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const k = key.trim();
    // The word that was given is not repeated: it may be a value put where a name goes.
    if (!k || k.length > 200 || /[\0\n\r=]/.test(k)) throw new Error("Invalid " + name + " name.");
    // A name that is new must be a name: an environment variable's, or a header's (an HTTP token).
    // So "API_KEY=sk-…" and "Authorization: Bearer …" are never saved as a key, where they would be
    // shown. A name that is already stored is kept as it is.
    if (item !== null && !Object.hasOwn(existing, k) && !(name === "header" ? HEADER_NAME : ENV_NAME).test(k))
      throw new Error(name === "header" ? "A header is given by its name only, such as Authorization. Its value goes in the value." : "An environment value is given by its name only, such as API_KEY. Its value goes in the value.");
    if (item === null) {
      if (!Object.hasOwn(existing, k)) continue;
      // A saved key goes only where the person sent it. Otherwise an edit could point it somewhere else unseen.
      if (moved) throw new Error("Enter the value for " + k + " again. You changed where this server sends it.");
      out[k] = existing[k];
      continue;
    }
    if (typeof item !== "string" || item.length > 8000 || item.includes("\0")) throw new Error("Invalid value for " + k);
    out[k] = seal(item, k, name);
  }
  if (Object.keys(out).length > 100) throw new Error("Too many " + name + " entries.");
  return out;
}

/**
 * A remote server's OAuth settings. `undefined` keeps what is stored, `null` or `false` turns
 * sign-in off. A client ID and secret are only needed for a server that doesn't let apps
 * register themselves; `clientSecret: null` keeps the stored one.
 */
function oauthField(value, existing, { seal, moved }) {
  if (value === undefined) {
    if (!existing) return undefined;
    if (moved && existing.clientSecret) throw new Error("Enter the client secret again. You changed where this server sends it.");
    return { ...existing };
  }
  if (value === null || value === false) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sign-in settings");
  const short = (v, max, name) => {
    if (v == null || v === "") return undefined;
    if (typeof v !== "string" || v.length > max || /[\0\n\r]/.test(v)) throw new Error("Invalid " + name);
    return v.trim() || undefined;
  };
  const clientId = short(value.clientId, 300, "client ID");
  const scope = short(value.scope, 1000, "scopes");
  let clientSecret;
  // Where the kept secret was first used. A newly entered secret starts without one.
  let boundTo;
  if (value.clientSecret === null) {
    if (existing?.clientSecret) {
      if (moved || (existing.clientId ?? "") !== (clientId ?? "")) throw new Error("Enter the client secret again. You changed the server or the client it belongs to.");
      clientSecret = existing.clientSecret;
      boundTo = existing.boundTo;
    }
  } else if (value.clientSecret != null && value.clientSecret !== "") {
    if (typeof value.clientSecret !== "string" || value.clientSecret.length > 4000 || value.clientSecret.includes("\0")) throw new Error("Invalid client secret");
    if (!clientId) throw new Error("A client secret needs its client ID.");
    clientSecret = seal(value.clientSecret, "client secret", "sign-in");
  }
  return { ...(clientId && { clientId }), ...(scope && { scope }), ...(clientSecret && { clientSecret }), ...(boundTo && { boundTo }) };
}

/**
 * Checks one server as typed in the form or read from a JSON file. `existing` supplies kept
 * secrets, and `seal(value, name, kind)` stores new ones and returns what the workspace keeps.
 */
export function serverField(data, existing, seal) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid MCP server");
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!SERVER_NAME.test(name)) throw new Error("Name the server with letters, numbers, dashes or underscores (up to 48), starting with a letter or number.");
  const type = data.type === "local" ? "stdio" : (data.type ?? (data.url ? "http" : "stdio"));
  const base = { name, type, enabled: data.enabled !== false };
  if (type === "http" || type === "sse") {
    let url;
    try {
      url = new URL(String(data.url ?? "").trim());
    } catch {
      throw new Error("Enter the server's full web address, starting with https://");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP servers need an http:// or https:// address.");
    const moved = !!existing && existing.url !== url.href;
    const oauth = oauthField(data.oauth, existing?.oauth, { seal, moved });
    return { ...base, url: url.href, headers: pairs(data.headers, existing?.headers, "header", { seal, moved }), ...(oauth && { oauth }) };
  }
  if (type !== "stdio") throw new Error("Choose a local command or a web address for this server.");
  const command = text(data.command, 2000, "command");
  const args = data.args ?? [];
  if (!Array.isArray(args) || args.length > 200 || args.some((a) => typeof a !== "string" || a.length > 8000 || a.includes("\0")))
    throw new Error("Invalid arguments for " + name);
  const cwd = data.cwd ?? data.workingDirectory;
  if (cwd != null && cwd !== "" && (typeof cwd !== "string" || !isAbsolute(cwd))) throw new Error("The working folder needs a full path.");
  // (A path is shown to a person before the program starts: it must be one that can be shown as it is.)
  if (typeof cwd === "string" && NOT_IN_A_PATH.test(cwd)) throw new Error("The working folder's path has characters that can't be shown. Choose another folder.");
  const moved = !!existing && (existing.command !== command || JSON.stringify(existing.args ?? []) !== JSON.stringify(args));
  return { ...base, command, args: [...args], env: pairs(data.env, existing?.env, "environment", { seal, moved }), ...(cwd && { cwd }) };
}

/** Servers in an MCP JSON document: the "mcpServers" (or VS Code "servers") object. */
export function parseServers(json, baseDir, sealFor) {
  let data;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("That isn't valid JSON.");
  }
  const servers = data?.mcpServers ?? data?.servers ?? data;
  if (!servers || Array.isArray(servers) || typeof servers !== "object" || !Object.keys(servers).length)
    throw new Error('Use JSON with an "mcpServers" object, such as { "mcpServers": { "name": { "command": "npx", "args": ["…"] } } }.');
  return Object.entries(servers).map(([name, cfg]) => {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("Invalid MCP server entry: " + name);
    const cwd = cfg.workingDirectory ?? cfg.cwd;
    const clean = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 48);
    // Each server gets its id here, so its secrets are stored under it from the start.
    const id = randomUUID();
    return {
      id,
      ...serverField({ ...cfg, name: clean, oauth: undefined, ...(cwd && baseDir ? { cwd: resolve(baseDir, cwd) } : {}) }, null, sealFor?.(id, clean)),
    };
  });
}

/**
 * Writes a file as a new plain file: to a file of its own beside it, then moved over the name. A link at the name is
 * replaced and never followed, so what it pointed to is not written.
 */
function writeFilePlain(path, content, mode) {
  const temporary = path + "." + randomUUID().slice(0, 8) + ".tmp";
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

const skillFile = ({ name, description, instructions }) =>
  "---\nname: " + name + "\ndescription: " + JSON.stringify(description) + "\n---\n\n" + instructions.trim() + "\n";

/**
 * The skills under a folder: every folder holding a SKILL.md, up to four levels down, which is
 * how the Copilot runtime reads a skills folder too. Hidden folders and node_modules are skipped.
 */
export function skillsIn(folder, origin, standalone = []) {
  const found = [];
  const names = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 1000) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const file = join(path, "SKILL.md");
        if (statSync(file).isFile()) {
          const text = readFileSync(file, "utf8").slice(0, MAX_SKILL_TEXT);
          const skill = parseSkill(text, entry.name);
          if (skill.name && !names.has(skill.name)) {
            names.add(skill.name);
            // A skill that says it is a script command is never offered to a model (providers/skills.mjs). Whether it can run is skills() and scriptCommands().
            const command = commandKind(text);
            found.push({ name: skill.name, description: skill.description.slice(0, 600), path, origin, ...(command === SCRIPT_KIND && { command }) });
          }
          // Each imported skill has its own top-level folder. A manifest among its references is a companion file.
          if (standalone.includes(path)) continue;
        }
      } catch {
        // No SKILL.md here; it may be a folder of skills.
      }
      if (depth < 4) walk(path, depth + 1);
    }
  };
  walk(folder, 1);
  return found;
}
/**
 * What a working folder's path may not have: control characters, and the marks that turn text
 * around. This is narrower than the list for text that is shown for a decision
 * (desktop/shown-text.mjs): U+200C and U+200D are correct writing in Persian and several Indian
 * languages, and a person there has folders with them. Where a path is shown for a decision,
 * that list writes them as numbers, and that is enough.
 */
const NOT_IN_A_PATH = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const isPlugin = (path) => PLUGIN_MANIFESTS.some((file) => existsSync(join(path, file)));
// How secrets were stored before the vault: text in a development run, "enc:v1:" + keychain-encrypted otherwise.
const SEALED = "enc:v1:";
/** One stored server as the provider contract's MCP configuration. `open` reads its secrets from the vault. */
const serverConfig = (s, open) =>
  s.type === "stdio"
    ? { type: "stdio", command: s.command, args: [...(s.args ?? [])], env: open(s.env), tools: ["*"], ...(s.cwd && existsSync(s.cwd) && { workingDirectory: s.cwd }) }
    : { type: s.type, url: s.url, headers: open(s.headers), tools: ["*"] };

export class Integrations {
  constructor(ws) {
    this.ws = ws;
    this.skillsDir = join(ws.dir, "skills");
    // Can a bot's shell of this process run `botkins`? A test replaces this with its own answer.
    this.reachable = () => reachable();
    const state = ws.state;
    state.mcpServers ??= [];
    const kept = Object.fromEntries(Object.entries(state.skills?.scripts && typeof state.skills.scripts === "object" ? state.skills.scripts : {}).filter(([name, hash]) => SKILL_NAME.test(name) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)));
    state.skills = {
      ...(Array.isArray(state.skills?.standalone) && {standalone: state.skills.standalone}),
      ...(state.skills?.catalog && {catalog: state.skills.catalog}),
      // Shared skills installed from a marketplace listing: name → { catalog, name, version, commit, files } (desktop/catalog-v2.mjs).
      ...(state.skills?.listings && typeof state.skills.listings === "object" && {listings: state.skills.listings}),
      folders: Array.isArray(state.skills?.folders) ? state.skills.folders : [],
      plugins: Array.isArray(state.skills?.plugins) ? state.skills.plugins : [],
      disabled: Array.isArray(state.skills?.disabled) ? state.skills.disabled : [],
      // The script commands Botkins saved: name -> the SHA-256 of the script that the person saw (desktop/script-commands.mjs).
      ...(Object.keys(kept).length && { scripts: kept }),
    };
    this.vault = ws.vault;
    // Sign-in for remote servers. Its tokens live in the vault; a change shows in Settings at once.
    this.oauth = new McpOAuth({
      vault: this.vault,
      open: (url) => ws.openExternal(url),
      fetch: ws.fetch,
      changed: () => ws.notify(),
      ...(ws.oauthPort !== undefined && { port: ws.oauthPort }),
    });
    this.adoptBotSources();
    this.moveToVault();
  }
  /**
   * Servers saved by an earlier version kept their secrets in the workspace file, as text or
   * encrypted with the keychain. They move into the vault once. One that this run can't read (a
   * development run has no keychain) or can't store (the vault is locked) is left exactly as it
   * is, to move on a later start.
   */
  moveToVault() {
    let moved = false;
    for (const server of this.servers) {
      server.id ??= randomUUID();
      for (const [map, kind] of [[server.env, "environment"], [server.headers, "header"]])
        for (const [key, value] of Object.entries(map ?? {})) {
          // Something that isn't text was never a usable value.
          if (typeof value !== "string") {
            delete map[key];
            moved = true;
            continue;
          }
          if (isRef(value) || this.vault.locked) continue;
          const text = value.startsWith(SEALED) ? (this.ws.secrets?.open?.(value.slice(SEALED.length)) ?? null) : value;
          if (!text) continue;
          map[key] = this.sealFor(server.id, server.name)(text, key, kind);
          moved = true;
        }
    }
    if (moved) this.ws.save();
    this.sweep();
  }
  /** Stores a new secret of one server in the vault and returns the reference the workspace keeps. */
  sealFor = (id, name) => (text, key, kind) =>
    this.vault.put(text, {
      owner: "mcp:" + id,
      label: name + " · " + key,
      kind: kind === "header" ? "header" : kind === "sign-in" ? "client-secret" : "environment",
    });
  /** A stored map of secrets with its values readable. One the vault can't give is left out. */
  open = (map) => {
    const out = {};
    for (const [key, value] of Object.entries(map ?? {})) {
      // A value still in the earlier format is read the earlier way, and never sent in its stored form.
      const text = isRef(value)
        ? this.vault.get(value)
        : typeof value === "string" && value.startsWith(SEALED)
          ? (this.ws.secrets?.open?.(value.slice(SEALED.length)) ?? null)
          : typeof value === "string"
            ? value
            : null;
      if (text === null) console.error("MCP secret " + key + " can't be read on this computer. Enter it again in Settings › MCP servers.");
      else out[key] = text;
    }
    return out;
  };
  /** Vault references a server still uses. */
  refs(server) {
    return new Set([
      ...Object.values(server.env ?? {}),
      ...Object.values(server.headers ?? {}),
      ...(server.oauth?.clientSecret ? [server.oauth.clientSecret] : []),
      ...(server.oauth ? [this.vault.ref(this.oauth.entry(server))] : []),
    ]);
  }
  /** Removes vault entries of servers that are gone, and ones a server no longer uses. */
  sweep() {
    const servers = new Map(this.servers.map((s) => ["mcp:" + s.id, s]));
    for (const entry of this.vault.list()) {
      if (!entry.owner.startsWith("mcp:")) continue;
      const server = servers.get(entry.owner);
      if (!server || !this.refs(server).has(this.vault.ref(entry.id))) this.vault.remove(entry.id);
    }
  }
  get servers() {
    return this.ws.state.mcpServers;
  }
  get standaloneSkills() {
    return (this.skillState.standalone ?? []).map(name => join(this.skillsDir, name));
  }
  get skillState() {
    return this.ws.state.skills;
  }
  changed() {
    // Menus are built per session, and a warm session keeps the old servers and skills.
    this.ws.clearCatalogs();
    this.ws.save();
  }
  /**
   * Before this page existed each bot listed its own skill folders, plugins and MCP files.
   * They become app-wide so every bot has them. Runs once per bot.
   */
  adoptBotSources() {
    for (const bot of this.ws.state.bots) {
      if (!Array.isArray(bot.sources)) continue;
      for (const { kind, path } of bot.sources) {
        try {
          if (typeof path !== "string" || !isAbsolute(path)) continue;
          if (kind === "skills") this.addFolder(this.skillState.folders, path);
          // (No session reads this list any more. Plugins.adoptLinked makes each one an installed plugin, switched off.)
          else if (kind === "plugin") this.addFolder(this.skillState.plugins, path);
          else if (kind === "mcp")
            for (const server of parseServers(readFileSync(path, "utf8"), dirname(path), this.sealFor))
              if (!this.servers.some((s) => s.name === server.name) && this.servers.length < MAX_SERVERS) this.servers.push(server);
        } catch (error) {
          console.error("Bot source " + basename(String(path)) + ":", error.message);
        }
      }
      delete bot.sources;
    }
  }
  addFolder(list, path) {
    if (list.some((f) => f.path === path)) return list.find((f) => f.path === path).id;
    if (list.length >= 50) throw new Error("Up to 50 folders can be added.");
    const entry = { id: randomUUID(), path };
    list.push(entry);
    return entry.id;
  }

  // MCP servers
  server(id) {
    const server = this.servers.find((s) => s.id === id);
    if (!server) throw new Error("This MCP server no longer exists.");
    return server;
  }
  /**
   * What the app's page may see: everything except secrets. Environment entries and headers show
   * their names, and a remote server shows how it signs in: `auth.oauth` with the state of the
   * sign-in, never a token.
   */
  publicServers() {
    // Names whose stored value is gone from the vault (removed there, or not readable on this computer).
    const lost = (map) =>
      Object.entries(map ?? {})
        .filter(([, value]) =>
          isRef(value)
            ? this.vault.locked || !this.vault.has(value)
            : typeof value === "string" && value.startsWith(SEALED) && (this.ws.secrets?.open?.(value.slice(SEALED.length)) ?? null) === null,
        )
        .map(([key]) => key);
    return this.servers.map(({ env, headers, oauth, ...rest }) => ({
      ...rest,
      ...(env && { env: Object.keys(env) }),
      ...(headers && { headers: Object.keys(headers) }),
      ...([...lost(env), ...lost(headers)].length && { needs: [...lost(env), ...lost(headers)] }),
      ...(rest.type !== "stdio" && {
        auth: oauth
          ? {
              type: "oauth",
              ...this.oauth.status({ id: rest.id, name: rest.name, url: rest.url }),
              ...(oauth.clientId && { clientId: oauth.clientId }),
              ...(oauth.scope && { scope: oauth.scope }),
              clientSecret: !!oauth.clientSecret,
            }
          : { type: Object.keys(headers ?? {}).length ? "header" : "none" },
      }),
    }));
  }
  /** The vault as Settings shows it: how it is protected and what it holds, without any secret. */
  credentials() {
    const servers = new Map(this.servers.map((s) => ["mcp:" + s.id, s]));
    return {
      protection: this.vault.protection,
      // The vault is there but this copy of Botkins can't open it: nothing can be read or saved until it opens or is reset.
      ...(this.vault.locked && { locked: this.vault.reason }),
      redirectUrl: this.redirectUrl,
      entries: this.vault.list().map((entry) => {
        const server = servers.get(entry.owner);
        return { ...entry, ...(server && { serverId: server.id, usedBy: server.name }) };
      }),
    };
  }
  /**
   * Sets a vault this computer can't open aside and starts an empty one. Every key and sign-in
   * then has to be entered again; servers keep the names of what they need.
   */
  resetVault() {
    if (!this.vault.reset()) throw new Error("The vault doesn't need resetting.");
    this.changed();
    this.ws.releaseServerSessions?.();
  }
  /** Removes one credential. A sign-in is signed out; a key's name stays on its server so it can be entered again. */
  async removeCredential(id) {
    if (this.vault.locked) throw new Error("The vault can't be opened on this computer, so nothing in it can be removed. Reset it instead.");
    const entry = this.vault.list().find((e) => e.id === id);
    if (!entry) throw new Error("This credential no longer exists.");
    const server = this.servers.find((s) => "mcp:" + s.id === entry.owner);
    if (server && entry.kind === "oauth") return this.signOut(server.id);
    this.vault.remove(id);
    if (server?.oauth?.clientSecret === this.vault.ref(id)) delete server.oauth.clientSecret;
    this.changed();
    this.ws.releaseServerSessions?.();
  }
  /** Where the person's browser hands a sign-in back: the address to register for a client ID entered by hand. */
  get redirectUrl() {
    return "http://127.0.0.1:" + REDIRECT_PORT + "/callback";
  }
  saveServer(data) {
    const existing = data?.id ? this.server(data.id) : null;
    const id = existing?.id ?? randomUUID();
    let next;
    try {
      next = serverField(data, existing, this.sealFor(id, typeof data?.name === "string" ? data.name.trim().slice(0, 48) : "MCP server"));
      if (this.servers.some((s) => s !== existing && s.name.toLowerCase() === next.name.toLowerCase()))
        throw new Error("Another MCP server is already named " + next.name + ".");
      if (!existing && this.servers.length >= MAX_SERVERS) throw new Error("Up to " + MAX_SERVERS + " MCP servers can be added.");
    } catch (error) {
      // Secrets stored for a save that didn't happen are removed again.
      this.sweep();
      throw error;
    }
    // A sign-in belongs to the address it was made for.
    const moved = !!existing && (existing.url !== next.url || !next.oauth);
    if (existing && moved && this.vault.has(this.oauth.entry(existing))) {
      this.oauth.cancel(existing.id);
      this.vault.remove(this.oauth.entry(existing));
    }
    if (existing) {
      for (const key of Object.keys(existing)) delete existing[key];
      Object.assign(existing, { id, ...next });
    } else this.servers.push({ id, ...next });
    this.sweep();
    this.changed();
    return id;
  }
  /** The stored client a server's sign-in uses when the person entered one by hand. */
  client(server) {
    if (!server.oauth?.clientId) return undefined;
    const clientSecret = server.oauth.clientSecret ? this.vault.get(server.oauth.clientSecret) : undefined;
    // `boundTo` is the sign-in server the secret was first used with; it goes nowhere else.
    return { clientId: server.oauth.clientId, ...(clientSecret && { clientSecret, ...(server.oauth.boundTo && { boundTo: server.oauth.boundTo }) }) };
  }
  /**
   * Signs the person in to a remote server through their browser and keeps the tokens in the
   * vault. Also turns sign-in on for a server that turned out to need it.
   */
  async signIn(id, { open, patience, finished, followed } = {}) {
    const server = this.server(id);
    if (server.type === "stdio") throw new Error("A local server signs in with its environment values.");
    // (`open`, `patience`, `finished` and `followed` are a terminal host's: desktop/terminal/signin.mjs. The window and a phone pass none.)
    await this.oauth.signIn(server, { client: this.client(server), scope: server.oauth?.scope, ...(open && { open }), ...(patience && { patience }), ...(finished && { finished }), ...(followed && { followed }) });
    // The server was removed while the browser was open: its sign-in goes with it.
    if (!this.servers.includes(server)) {
      this.sweep();
      throw new Error("This MCP server no longer exists.");
    }
    if (!server.oauth) server.oauth = {};
    if (server.oauth.clientSecret && !server.oauth.boundTo) {
      try {
        server.oauth.boundTo = new URL(this.oauth.read(server).tokenEndpoint).origin;
      } catch {}
    }
    // Open sessions connect to the server again with the new sign-in.
    this.changed();
    this.ws.releaseServerSessions?.();
    return this.publicServers().find((s) => s.id === id)?.auth;
  }
  /**
   * Takes the sign-in a paired phone made to a remote server that signs in with OAuth, then checks
   * the server like Test does. Returns { status, tools }.
   */
  async adoptSignIn(id, grant) {
    const server = this.server(id);
    if (server.type === "stdio") throw new Error("A local server signs in with its environment values.");
    if (!server.oauth) throw new Error(server.name + " isn't set to sign in with your browser (OAuth).");
    await this.oauth.adopt(server, grant);
    // The server was removed while its sign-in was being looked up: the sign-in goes with it.
    if (!this.servers.includes(server)) {
      this.sweep();
      throw new Error("This MCP server no longer exists.");
    }
    // Open sessions connect to the server again with the new sign-in. (A client secret the person
    // entered isn't bound here: the phone's client is a public one and never uses it.)
    this.changed();
    this.ws.releaseServerSessions?.();
    return this.testServer(id);
  }
  cancelSignIn(id) {
    return this.oauth.cancel(this.server(id).id);
  }
  /** The address the browser was sent back to, for a sign-in a terminal host started (oauth.answer). */
  answerSignIn(id, address) {
    this.oauth.answer(this.server(id).id, address);
  }
  async signOut(id) {
    const server = this.server(id);
    await this.oauth.signOut(server);
    this.changed();
    this.ws.releaseServerSessions?.();
  }
  /**
   * A model provider asks for a server's token when the server wants one (see the provider
   * contract). Answers from the vault, renewing the token when needed; null means the person
   * has to sign in, which Settings › MCP servers then shows.
   */
  async mcpAuth(request) {
    const server = this.servers.find((s) => s.enabled && s.type !== "stdio" && s.name === request?.server);
    if (!server?.oauth) return null;
    // The token goes only to the address the person signed in to.
    try {
      if (request.url && new URL(request.url).origin !== new URL(server.url).origin) return null;
    } catch {
      return null;
    }
    return this.oauth.token(server, { reason: request.reason, client: this.client(server) });
  }
  setServerEnabled(id, enabled) {
    this.server(id).enabled = enabled === true;
    this.changed();
  }
  removeServer(id) {
    const server = this.server(id);
    this.oauth.cancel(server.id);
    this.ws.state.mcpServers = this.servers.filter((s) => s.id !== id);
    this.sweep();
    for (const bot of this.ws.state.bots) if (bot.mcpOff) bot.mcpOff = bot.mcpOff.filter((x) => x !== id);
    this.changed();
  }
  /** Adds the servers in MCP JSON (pasted, or from a file such as Claude's or VS Code's). Returns their names. */
  importServers(json, baseDir) {
    const added = [];
    const skipped = [];
    let parsed;
    try {
      parsed = parseServers(json, baseDir, this.sealFor);
    } catch (error) {
      // Nothing is left in the vault for servers that didn't get added.
      this.sweep();
      throw error;
    }
    for (const server of parsed) {
      if (this.servers.some((s) => s.name.toLowerCase() === server.name.toLowerCase())) skipped.push(server.name);
      else if (this.servers.length >= MAX_SERVERS) skipped.push(server.name);
      else {
        this.servers.push(server);
        added.push(server.name);
      }
    }
    this.sweep();
    if (added.length) this.changed();
    return { added, skipped };
  }
  importServerFile(path) {
    let source;
    try {
      if (statSync(path).size > 1_000_000) throw new Error("too large");
      source = readFileSync(path, "utf8");
    } catch {
      throw new Error("Botkins couldn't read " + basename(path) + ".");
    }
    return this.importServers(source, dirname(path));
  }
  /** The servers a bot's sessions connect to, in the shape of the provider contract. */
  serversFor(bot) {
    const off = new Set(bot?.mcpOff ?? []);
    return Object.fromEntries(this.servers.filter((s) => s.enabled && !off.has(s.id)).map((s) => [s.name, serverConfig(s, this.open)]));
  }
  /**
   * Connects to one server once and reports whether it works and which tools it offers. Botkins
   * connects itself, with the client MCP Apps use (desktop/mcp-apps.mjs), not through a bot's
   * harness: some harnesses don't connect until a turn, so the answer would depend on the bot.
   * `status` is "connected", "needs-auth" (the server refused without a sign-in) or "failed".
   */
  async testServer(id) {
    const server = this.server(id);
    const upstream = this.ws.mcpApps.connect(server);
    try {
      const tools = await upstream.tools();
      return { status: "connected", tools: tools.map((tool) => tool.name) };
    } catch (error) {
      return { status: error?.status === 401 ? "needs-auth" : "failed", tools: [] };
    } finally {
      // The answer doesn't wait for a program the test started to stop.
      void upstream.close();
    }
  }

  // Skills
  /** Each bot's portable skill definitions are projected outside every shared skills directory. */
  botSkillDirectory(bot) {
    const root = join(this.ws.dir, ".agent-skills");
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("The agent skills folder cannot be a symbolic link.");
    return join(root, createHash("sha256").update(bot.id).digest("hex"));
  }
  installBotSkills(bot) {
    const { skills } = templateBundle({ skills: bot.bundle.skills });
    for (const { name } of skills) {
      if (name === COMMAND_SKILL || Object.hasOwn(this.skillState.scripts ?? {}, name))
        throw new Error("A command on this computer already uses the skill name " + name + ".");
    }
    const dir = this.botSkillDirectory(bot);
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    // Only remove a directory created by this installation. Never overwrite an existing skill.
    mkdirSync(dir, { mode: 0o700 });
    try {
      for (const skill of skills) {
        const folder = join(dir, skill.name);
        mkdirSync(folder, { mode: 0o700 });
        writeFileSync(join(folder, "SKILL.md"), skillFile(skill), { flag: "wx", mode: 0o600 });
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return dir;
  }
  removeBotSkills(bot) {
    rmSync(this.botSkillDirectory(bot), { recursive: true, force: true });
  }
  /** Where one bot's own marketplace skills are (desktop/catalog-v2.mjs): beside its private skills, apart from the shared ones. */
  botCatalogDirectory(bot) {
    const root = join(this.ws.dir, ".agent-catalog-skills");
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("The agent skills folder cannot be a symbolic link.");
    return join(root, createHash("sha256").update(bot.id).digest("hex"));
  }
  /**
   * Installs a marketplace skill's pinned files for one bot only. The same listing installed again
   * (an update) replaces that bot's copy. `meta` is { catalog, name, version, commit, files } and is
   * kept on the bot as `catalogSkills`.
   */
  installBotCatalogSkill(bot, files, executable, meta) {
    if (!SKILL_NAME.test(meta.name) || meta.name === COMMAND_SKILL || Object.hasOwn(this.skillState.scripts ?? {}, meta.name) || bot.bundle?.skills?.some((s) => s.name === meta.name))
      throw new Error("This bot already has a skill or command named " + meta.name + ".");
    const other = bot.catalogSkills?.find((s) => s.name === meta.name && s.catalog !== meta.catalog);
    if (other) throw new Error("This bot already has " + meta.name + " from " + other.catalog + ".");
    const root = this.botCatalogDirectory(bot);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(root, ".install-"));
    try {
      let size = 0;
      if (files.size > 512) throw new Error("Too many files in this skill.");
      for (const [path, data] of files) {
        size += data.length;
        if (size > 12 * 1024 * 1024) throw new Error("This skill is larger than 12 MiB.");
        // The same portable paths as every skill import; a path that leaves the folder is refused.
        if (path.split("/").some((part) => !part || part === "." || part === ".." || /[\\:<>"|?*\x00-\x1f]/.test(part))) throw new Error("Unsafe skill file path.");
        const target = join(stage, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data, { flag: "wx", mode: executable.has(path) ? 0o755 : 0o644 });
      }
      const dest = join(root, meta.name);
      const old = join(stage, ".old");
      if (existsSync(dest)) renameSync(dest, old);
      renameSync(stage, dest);
      rmSync(join(dest, ".old"), { recursive: true, force: true });
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    bot.catalogSkills = [...(bot.catalogSkills ?? []).filter((s) => s.name !== meta.name), meta];
    if (bot.skillsOff) bot.skillsOff = bot.skillsOff.filter((n) => n !== meta.name);
    this.changed();
  }
  removeBotCatalogSkill(bot, name) {
    if (!bot.catalogSkills?.some((s) => s.name === name)) throw new Error("This bot has no marketplace skill named " + name + ".");
    rmSync(join(this.botCatalogDirectory(bot), name), { recursive: true, force: true });
    bot.catalogSkills = bot.catalogSkills.filter((s) => s.name !== name);
    if (!bot.catalogSkills.length) delete bot.catalogSkills;
    this.changed();
  }
  removeBotCatalogSkills(bot) {
    rmSync(this.botCatalogDirectory(bot), { recursive: true, force: true });
  }
  /** Every skill Botkins can see, with where it comes from and whether it is on. */
  skills() {
    const disabled = new Set(this.skillState.disabled);
    const seen = new Set();
    const out = [];
    const add = (list, extra) => {
      for (const s of list) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({ ...s, ...extra, enabled: !disabled.has(s.name) });
      }
    };
    add(skillsIn(this.skillsDir, "botkins", this.standaloneSkills), { editable: true });
    for (const folder of this.skillState.folders) add(skillsIn(folder.path, "folder"), { folderId: folder.id });
    add(skillsIn(bundledSkills, "built-in"));
    // The command-line skill stays in the list on a host with no command, with the reason. Its switch is still the person's own.
    const noCommand = this.reachable() ? null : "Needs the botkins command line on this host.";
    return out
      .map(({ command, ...s }) => {
        // Only a skill that Botkins saved as a script command is one. The header alone, in a linked or imported folder, is not.
        const script = s.origin === "botkins" ? this.scriptState(s) : null;
        if (script) return { ...s, command: SCRIPT_KIND, ...(script.problem && { unavailable: script.problem }) };
        return noCommand && s.name === COMMAND_SKILL && s.origin === "built-in" ? { ...s, unavailable: noCommand } : s;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  folders() {
    const view = (f) => ({ id: f.id, path: f.path, missing: !existsSync(f.path) });
    return {
      folders: this.skillState.folders.map((f) => ({ ...view(f), skills: skillsIn(f.path, "folder").length })),
      plugins: this.skillState.plugins.map(view),
    };
  }
  // Script commands (desktop/script-commands.mjs)
  /**
   * Whether a skill of Botkins' own folder is a script command that Botkins saved, and whether it can run.
   * Null when it is not one. `problem` is the reason it can't run now (the script changed outside Botkins).
   */
  scriptState(skill) {
    const saved = this.skillState.scripts?.[skill.name];
    if (!saved || skill.path !== join(this.skillsDir, skill.name)) return null;
    const read = this.scriptText(skill.path);
    if (read === null) return { problem: "The script is missing. Save the command again." };
    if (hashScript(read) !== saved) return { problem: "The script was changed outside Botkins. Open the command and save it again to use it." };
    return {};
  }
  /** The script in a command's folder; null when there is no plain file there (a link is never followed). */
  scriptText(dir) {
    const file = join(dir, SCRIPT_FILE);
    try {
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(file).isFile()) return null;
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  /** Every script command: { name, description, enabled, path, unavailable? }. */
  scriptCommands() {
    return this.skills().filter((s) => s.command === SCRIPT_KIND).map(({ name, description, enabled, path, unavailable }) => ({ name, description, enabled, path, ...(unavailable && { unavailable }) }));
  }
  /** A script command's fields for its editor, whole: the name, what it is for and the script. */
  readScriptCommand(name) {
    const item = this.scriptCommands().find((s) => s.name === name);
    if (!item) throw new Error("This isn't a script command that Botkins keeps.");
    const script = this.scriptText(item.path);
    if (script === null) throw new Error("This command's script is missing. Save the command again.");
    return { name: item.name, description: item.description, script, ...(item.unavailable && { unavailable: item.unavailable }) };
  }
  /**
   * The script to run for a typed command: { name, script } for one that is on and whole, else null.
   * The script is read now and checked against the one that was saved, so a file that was changed
   * since is never run.
   */
  runnableScript(name) {
    const item = this.scriptCommands().find((s) => s.name === name);
    if (!item || !item.enabled || item.unavailable) return null;
    const script = this.scriptText(item.path);
    if (script === null || hashScript(script) !== this.skillState.scripts?.[name]) return null;
    return { name, script };
  }
  /**
   * Saves a script command, or rewrites one (`original` is its current name). The caller has shown
   * the person the script (a card, the review of `botkins skills add-script`, or the editor itself).
   */
  saveScriptCommand({ name, description, script, original }) {
    const fields = cleanScriptCommand({ name, description, script });
    const id = fields.name;
    if (this.ws.state.bots.some(bot => bot.bundle?.skills?.some(skill => skill.name === id)))
      throw new Error("/" + id + " is a skill of a bot on this computer. Choose another name.");
    const current = original ? this.ownSkillDir(original) : null;
    if (original && !this.scriptCommands().some((s) => s.name === original)) throw new Error("This isn't a script command. Change it as a skill.");
    if (id !== original && this.skills().some((s) => s.name === id)) throw new Error("A skill named " + id + " already exists.");
    mkdirSync(this.skillsDir, { recursive: true });
    if (lstatSync(this.skillsDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("The Botkins skills folder cannot be a symbolic link.");
    const dir = join(this.skillsDir, id);
    // Nothing is followed or changed until every place that is written to is known to be a plain folder and plain files:
    // a bot with a shell could have made `run` a link to a file of the person's, and a write would follow it.
    for (const place of [current, dir]) if (place && lstatSync(place, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("This command's folder is a link. Botkins does not write through links.");
    if (current && current !== dir) renameSync(current, dir);
    mkdirSync(dir, { recursive: true });
    for (const file of ["SKILL.md", SCRIPT_FILE]) if (lstatSync(join(dir, file), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("This command's " + file + " is a link. Botkins does not write through links. Remove the link and save again.");
    writeFilePlain(join(dir, "SKILL.md"), scriptSkillFile(fields), 0o644);
    writeFilePlain(join(dir, SCRIPT_FILE), fields.script, 0o600);
    const scripts = (this.skillState.scripts ??= {});
    if (original && original !== id) {
      delete scripts[original];
      this.skillState.disabled = this.skillState.disabled.map((n) => (n === original ? id : n));
      for (const bot of this.ws.state.bots) if (bot.skillsOff) bot.skillsOff = bot.skillsOff.map((n) => (n === original ? id : n));
    }
    // The hash is of the script that was approved (the string), not of what a read of the disk gives back.
    scripts[id] = hashScript(fields.script);
    this.changed();
    return id;
  }
  /** One of Botkins' own skills, for editing. */
  readSkill(name) {
    const dir = this.ownSkillDir(name);
    return parseSkill(readFileSync(join(dir, "SKILL.md"), "utf8"), name);
  }
  ownSkillDir(name) {
    const skill = skillsIn(this.skillsDir, "botkins", this.standaloneSkills).find((s) => s.name === name);
    if (!skill) throw new Error("This skill isn't one Botkins keeps. Skills from linked folders are edited in their folder.");
    return skill.path;
  }
  /** Creates a skill, or rewrites one of Botkins' own (`original` is its current name). */
  saveSkill({ name, description, instructions, original }) {
    const id = slug(name);
    if (!SKILL_NAME.test(id)) throw new Error("Name the skill with letters, numbers and dashes.");
    const skill = {
      name: id,
      description: text(description, 600, "description").replace(/\s+/g, " "),
      instructions: text(instructions, MAX_SKILL_TEXT, "set of instructions"),
    };
    const current = original ? this.ownSkillDir(original) : null;
    if (original && this.skillState.scripts?.[original]) throw new Error("This is a script command. Change it as one: its script is shown for a decision.");
    if (id !== original && this.skills().some((s) => s.name === id)) throw new Error("A skill named " + id + " already exists.");
    mkdirSync(this.skillsDir, { recursive: true });
    const dir = join(this.skillsDir, id);
    if (current && current !== dir) renameSync(current, dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillFile(skill));
    if (original && original !== id) {
      if (this.skillState.standalone) this.skillState.standalone = this.skillState.standalone.map(entry => entry === basename(current) ? id : entry);
      for (const [entry, old] of Object.entries(this.skillState.catalog ?? {})) if (old === original) this.skillState.catalog[entry] = id;
    }
    if (original && original !== id) this.skillState.disabled = this.skillState.disabled.map((n) => (n === original ? id : n));
    this.changed();
    return id;
  }
  /**
   * Adds skills from a folder the person chose:
   * a skill folder (it holds SKILL.md) is copied into Botkins; a folder of skill folders stays
   * where it is and is read from there.
   * A plugin folder is not added here. A plugin can start commands, so it has one way in, the one
   * that copies it and shows what it starts (Plugins.addFolder). The
   * refusal has `code: "PLUGIN_FOLDER"` and the `folder`, so that a caller can send it there.
   */
  addFromFolder(path) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Choose a folder.");
    let info;
    try {
      info = statSync(path);
    } catch {
      throw new Error("That folder no longer exists.");
    }
    if (info.isFile() && basename(path).toLowerCase() === "skill.md") path = dirname(path);
    else if (!info.isDirectory()) throw new Error("Choose a skill folder, a folder of skills, or a SKILL.md file.");
    // A chosen link means the folder it points to. Links inside a skill are still not followed when copying.
    path = realpathSync(path);
    if (existsSync(join(path, "SKILL.md"))) {
      const result = this.importSkillFolders([path], [], false);
      if (result.conflicts.length) throw new Error("A skill named " + result.conflicts[0] + " already exists.");
      return { kind: "skill", name: result.added[0] };
    }
    if (isPlugin(path)) throw Object.assign(new Error("This folder is a plugin, which can run commands on this computer. It is not added as a folder of skills."), { code: "PLUGIN_FOLDER", folder: path });
    const count = skillsIn(path, "folder").length;
    if (!count) throw new Error("No skills found there. A skill is a folder with a SKILL.md file inside.");
    this.addFolder(this.skillState.folders, path);
    this.changed();
    return { kind: "folder", name: basename(path), count };
  }
  /** Prepare the whole batch before publishing. Keep old directories until every rename succeeds. */
  importSkillFolders(paths, replace, enable = true, standalone = new Set()) {
    if (lstatSync(this.skillsDir, {throwIfNoEntry:false})?.isSymbolicLink()) throw new Error("The Botkins skills folder cannot be a symbolic link.");
    const installed = this.skills();
    const names = new Set();
    const conflicts = [];
    const plans = paths.map((path) => {
      const parsed = parseSkill(readFileSync(join(path, "SKILL.md"), "utf8").slice(0, MAX_SKILL_TEXT), basename(path));
      const id = slug(parsed.name);
      const name = parsed.name || id;
      if (!SKILL_NAME.test(id) || name.length > 200) throw new Error("This skill needs a valid name.");
      if (names.has(id)) throw new Error("Duplicate skill name: " + name);
      names.add(id);
      const existing = installed.find((s) => s.name === name || slug(s.name) === id);
      const dest = join(this.skillsDir, id);
      if (existing && !replace.includes(existing.name)) conflicts.push(existing.name);
      if (existing?.editable && replace.includes(existing.name)) {
        const parent = dirname(existing.path);
        const expected = join(realpathSync(this.skillsDir), relative(this.skillsDir, parent));
        if (realpathSync(parent) !== expected) throw new Error("Cannot replace a skill reached through a symbolic link.");
      }
      if (lstatSync(dest, {throwIfNoEntry: false}) && existing?.path !== dest) throw new Error("The skill folder already exists: " + id);
      return { path, name, dest, existing };
    });
    if (conflicts.length) return { added: [], conflicts };
    mkdirSync(this.skillsDir, { recursive: true });
    const staging = mkdtempSync(join(this.skillsDir, ".import-"));
    const undo = [];
    try {
      for (const [i, plan] of plans.entries()) {
        cpSync(plan.path, join(staging, String(i)), { recursive: true, filter: (source) => !lstatSync(source).isSymbolicLink() && basename(source) !== ".git" });
      }
      // Legacy imports can be nested. Move children first so rollback restores their parents first.
      const replaced = plans.filter(plan => plan.existing?.editable).sort((a, b) => b.existing.path.length - a.existing.path.length);
      for (const [i, plan] of replaced.entries()) {
        const backup = join(staging, "old-" + i);
        renameSync(plan.existing.path, backup);
        undo.push(() => renameSync(backup, plan.existing.path));
      }
      for (const [i, plan] of plans.entries()) {
        renameSync(join(staging, String(i)), plan.dest);
        undo.push(() => rmSync(plan.dest, { recursive: true }));
      }
    } catch (error) {
      for (const rollback of undo.reverse()) rollback();
      throw error;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const boundaries = new Set(this.skillState.standalone);
    for (const plan of plans) {
      const dir = basename(plan.dest);
      if (standalone.has(plan.path)) boundaries.add(dir);
      else boundaries.delete(dir);
    }
    if (boundaries.size) this.skillState.standalone = [...boundaries];
    else delete this.skillState.standalone;
    const added = plans.map((plan) => plan.name);
    // A folder that was imported over a script command, or under its name, is not that command (desktop/script-commands.mjs).
    if (this.skillState.scripts) {
      // (By the name of the command that was there, which the imported skill may spell another way, and by the imported one's own.)
      for (const plan of plans) for (const name of [plan.existing?.name, plan.name]) if (name) delete this.skillState.scripts[name];
      if (!Object.keys(this.skillState.scripts).length) delete this.skillState.scripts;
    }
    for (const [id, name] of Object.entries(this.skillState.catalog ?? {})) if (added.includes(name) || plans.some(plan => plan.existing?.name === name)) delete this.skillState.catalog[id];
    // A skill imported over a marketplace one is no longer that listing; the listing's own install sets it again.
    for (const name of [...added, ...plans.map((plan) => plan.existing?.name)]) if (name && this.skillState.listings) delete this.skillState.listings[name];
    if (enable) this.skillState.disabled = this.skillState.disabled.filter((name) => !added.includes(name));
    this.changed();
    return { added, conflicts: [] };
  }
  removeSkill(name) {
    const dir = this.ownSkillDir(name);
    rmSync(dir, { recursive: true, force: true });
    if (this.skillState.scripts) {
      delete this.skillState.scripts[name];
      if (!Object.keys(this.skillState.scripts).length) delete this.skillState.scripts;
    }
    if (this.skillState.standalone) this.skillState.standalone = this.skillState.standalone.filter(entry => entry !== basename(dir));
    for (const [id, skill] of Object.entries(this.skillState.catalog ?? {})) if (skill === name) delete this.skillState.catalog[id];
    if (this.skillState.listings) delete this.skillState.listings[name];
    this.skillState.disabled = this.skillState.disabled.filter((n) => n !== name);
    for (const bot of this.ws.state.bots) {
      if (bot.skillsOff && !bot.bundle?.skills?.some((skill) => skill.name === name))
        bot.skillsOff = bot.skillsOff.filter((n) => n !== name);
    }
    this.changed();
  }
  removeFolder(id) {
    const s = this.skillState;
    if (!s.folders.some((f) => f.id === id) && !s.plugins.some((f) => f.id === id)) throw new Error("This folder is no longer linked.");
    s.folders = s.folders.filter((f) => f.id !== id);
    s.plugins = s.plugins.filter((f) => f.id !== id);
    this.changed();
  }
  setSkillEnabled(name, enabled) {
    if (typeof name !== "string" || !name || name.length > 200) throw new Error("Unknown skill");
    const set = new Set(this.skillState.disabled);
    if (enabled) set.delete(name);
    else set.add(name);
    this.skillState.disabled = [...set];
    this.changed();
  }
  /** Which skills and servers one bot leaves out. Unknown ids and names are dropped. */
  setBotIntegrations(botId, { skillsOff, mcpOff } = {}) {
    const bot = this.ws.bot(botId);
    const strings = (list) => (Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === "string" && x && x.length <= 200))].slice(0, 500) : []);
    if (skillsOff !== undefined) bot.skillsOff = strings(skillsOff);
    if (mcpOff !== undefined) bot.mcpOff = strings(mcpOff).filter((id) => this.servers.some((s) => s.id === id));
    this.changed();
  }
  /**
   * The skill folders and switched-off skills for a bot's sessions.
   * @param turn.member  True when a team member wrote the message or the chat is a member's (accessForTurn).
   */
  skillsFor(bot, { member = false } = {}) {
    const base = [bundledSkills];
    const privateNames = new Set(bot?.bundle?.skills?.map(({ name }) => name));
    if (existsSync(this.skillsDir)) {
      // Only change precedence when the person installed a replacement for a built-in skill.
      const overrides = skillsIn(bundledSkills).some(s => existsSync(join(this.skillsDir, slug(s.name), "SKILL.md")));
      if (overrides) base.unshift(this.skillsDir);
      else base.push(this.skillsDir);
    }
    // A bot's own marketplace skills (desktop/catalog-v2.mjs) come before the shared ones, in this bot's sessions only.
    if (bot?.catalogSkills?.length) {
      const dir = this.botCatalogDirectory(bot);
      if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) base.unshift(dir);
    }
    if (privateNames.size) {
      const dir = this.botSkillDirectory(bot);
      const info = lstatSync(dir, { throwIfNoEntry: false });
      if (!info) this.installBotSkills(bot); // A restored workspace file carries its skill definitions.
      else if (!info.isDirectory()) throw new Error("The agent skills folder must be a plain directory.");
      // A private skill wins a shared name only in this bot's sessions.
      base.unshift(dir);
    }
    return {
      // A linked folder that has become a plugin since it was linked is not handed on, as a plugin can start commands. It stays linked, and is looked at again at each call.
      directories: [...base, ...this.skillState.folders.map((f) => f.path).filter((p) => existsSync(p) && !isPlugin(p))],
      ...(this.skillState.standalone?.length && {standalone: this.standaloneSkills}),
      // The command-line skill goes last, and only a host where a bot's shell finds the command offers it.
      // Never in a member's turn: the socket knows no member, so a member's bot must not be taught to act as the owner at the socket.
      // A script command is the person's to type; no model is offered it as a skill (desktop/script-commands.mjs).
      disabled: [...new Set([...this.skillState.disabled.filter(name => !privateNames.has(name)), ...(bot?.skillsOff ?? []), ...Object.keys(this.skillState.scripts ?? {}), ...(this.reachable() && !member ? [] : [COMMAND_SKILL])])],
    };
  }
}
