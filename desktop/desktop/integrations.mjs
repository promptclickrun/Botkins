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
import { McpOAuth, REDIRECT_PORT } from "./oauth.mjs";
import { isRef } from "./vault.mjs";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundledSkills = fileURLToPath(new URL("./skills/", import.meta.url));
const MAX_SERVERS = 50;
const MAX_SKILL_TEXT = 60000;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLUGIN_MANIFESTS = [".plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json", ".github/plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json"];

const text = (value, max, name) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Enter a " + name + " of up to " + max + " characters.");
  return value.trim();
};
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
    if (!k || k.length > 200 || /[\0\n\r=]/.test(k)) throw new Error("Invalid " + name + " name: " + key.slice(0, 40));
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

/** name and description from a SKILL.md, and the instructions under its front matter. */
export function parseSkill(source, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const meta = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (!field) continue;
      let value = field[2].trim();
      if (/^[>|][+-]?$/.test(value)) {
        // A folded or literal block: the indented lines that follow.
        const block = [];
        while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) block.push(lines[++i].trim());
        value = block.join(value.startsWith(">") ? " " : "\n").trim();
      } else value = value.replace(/^(["'])(.*)\1$/, "$2");
      meta[field[1].toLowerCase()] = value;
    }
  }
  return {
    name: (meta.name || fallbackName || "").trim(),
    description: (meta.description || "").trim(),
    instructions: (match ? source.slice(match[0].length) : source).trim(),
  };
}
const skillFile = ({ name, description, instructions }) =>
  "---\nname: " + name + "\ndescription: " + JSON.stringify(description) + "\n---\n\n" + instructions.trim() + "\n";
export const slug = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/**
 * The skills under a folder: every folder holding a SKILL.md, up to four levels down, which is
 * how the Copilot runtime reads a skills folder too. Hidden folders and node_modules are skipped.
 */
export function skillsIn(folder, origin) {
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
          const skill = parseSkill(readFileSync(file, "utf8").slice(0, MAX_SKILL_TEXT), entry.name);
          if (skill.name && !names.has(skill.name)) {
            names.add(skill.name);
            found.push({ name: skill.name, description: skill.description.slice(0, 600), path, origin });
          }
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
    const state = ws.state;
    state.mcpServers ??= [];
    state.skills = {
      folders: Array.isArray(state.skills?.folders) ? state.skills.folders : [],
      plugins: Array.isArray(state.skills?.plugins) ? state.skills.plugins : [],
      disabled: Array.isArray(state.skills?.disabled) ? state.skills.disabled : [],
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
  async signIn(id) {
    const server = this.server(id);
    if (server.type === "stdio") throw new Error("A local server signs in with its environment values.");
    await this.oauth.signIn(server, { client: this.client(server), scope: server.oauth?.scope });
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
  /** Connects to one server in a short session and reports whether it works and which tools it offers. */
  async testServer(id) {
    const server = this.server(id);
    const found = await this.ws.probe({ mcpServers: { [server.name]: serverConfig(server, this.open) } });
    const status = found.servers.find((s) => s.name === server.name)?.status ?? "not started";
    // The runtime names a server's tools "<server>-<tool>"; the person sees the tool's own name.
    const prefix = server.name + "-";
    const tools = found.choices
      .filter((c) => c.kind === "Tool" && c.source === server.name)
      .map((c) => (c.name.startsWith(prefix) ? c.name.slice(prefix.length) : c.name));
    return { status, tools };
  }

  // Skills
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
    add(skillsIn(this.skillsDir, "commander"), { editable: true });
    for (const folder of this.skillState.folders) add(skillsIn(folder.path, "folder"), { folderId: folder.id });
    add(skillsIn(bundledSkills, "built-in"));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  folders() {
    const view = (f) => ({ id: f.id, path: f.path, missing: !existsSync(f.path) });
    return {
      folders: this.skillState.folders.map((f) => ({ ...view(f), skills: skillsIn(f.path, "folder").length })),
      plugins: this.skillState.plugins.map(view),
    };
  }
  /** One of Botkins' own skills, for editing. */
  readSkill(name) {
    const dir = this.ownSkillDir(name);
    return parseSkill(readFileSync(join(dir, "SKILL.md"), "utf8"), name);
  }
  ownSkillDir(name) {
    const skill = skillsIn(this.skillsDir, "commander").find((s) => s.name === name);
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
    if (id !== original && this.skills().some((s) => s.name === id)) throw new Error("A skill named " + id + " already exists.");
    mkdirSync(this.skillsDir, { recursive: true });
    const dir = join(this.skillsDir, id);
    if (current && current !== dir) renameSync(current, dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillFile(skill));
    if (original && original !== id) this.skillState.disabled = this.skillState.disabled.map((n) => (n === original ? id : n));
    this.changed();
    return id;
  }
  /**
   * Adds skills from a folder the person chose:
   * a skill folder (it holds SKILL.md) is copied into Botkins; a plugin folder or a folder of
   * skill folders stays where it is and is read from there.
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
      const skill = parseSkill(readFileSync(join(path, "SKILL.md"), "utf8").slice(0, MAX_SKILL_TEXT), basename(path));
      const id = slug(skill.name || basename(path));
      if (!SKILL_NAME.test(id)) throw new Error("This skill needs a name in its SKILL.md.");
      if (this.skills().some((s) => s.name === id || s.name === skill.name)) throw new Error("A skill named " + id + " already exists.");
      mkdirSync(this.skillsDir, { recursive: true });
      const dir = join(this.skillsDir, id);
      // Links inside the skill are not followed, so a skill can't pull in files from elsewhere.
      cpSync(path, dir, { recursive: true, filter: (source) => !lstatSync(source).isSymbolicLink() && basename(source) !== ".git" });
      this.changed();
      return { kind: "skill", name: skill.name || id };
    }
    if (isPlugin(path)) {
      this.addFolder(this.skillState.plugins, path);
      this.changed();
      return { kind: "plugin", name: basename(path) };
    }
    const count = skillsIn(path, "folder").length;
    if (!count) throw new Error("No skills found there. A skill is a folder with a SKILL.md file inside.");
    this.addFolder(this.skillState.folders, path);
    this.changed();
    return { kind: "folder", name: basename(path), count };
  }
  removeSkill(name) {
    rmSync(this.ownSkillDir(name), { recursive: true, force: true });
    this.skillState.disabled = this.skillState.disabled.filter((n) => n !== name);
    for (const bot of this.ws.state.bots) if (bot.skillsOff) bot.skillsOff = bot.skillsOff.filter((n) => n !== name);
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
  /** The skill folders and switched-off skills for a bot's sessions. */
  skillsFor(bot) {
    return {
      directories: [bundledSkills, ...(existsSync(this.skillsDir) ? [this.skillsDir] : []), ...this.skillState.folders.map((f) => f.path).filter((p) => existsSync(p))],
      disabled: [...new Set([...this.skillState.disabled, ...(bot?.skillsOff ?? [])])],
    };
  }
  pluginsFor() {
    return this.skillState.plugins.map((f) => f.path).filter((p) => existsSync(p) && isPlugin(p));
  }
}
