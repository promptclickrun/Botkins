// The host owns installed plugin scope and configuration. Only list() is published to clients.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { PluginCatalog, snapshotStamp, verifySnapshot } from "./plugin-catalog.mjs";
import { describeStarts, folderReader, pluginStarts, startWarnings } from "./plugin-reading.mjs";
import { pluginSession, pluginOAuthServers } from "./plugin-runtime.mjs";

export const PLUGINS = "plugins-v1";
/**
 * Named by an app whose description of a plugin is what the plugin starts, and all of it (one
 * reading, desktop/plugin-reading.mjs). "plugins-v1" is named by apps from before that too, and
 * from one of those a plugin that shows no command can still run one. So a client that does not
 * see this name asks first for every plugin, and says to update the app on the computer.
 */
export const PLUGIN_STARTS = "plugin-starts-v1";
function limitsFor(preview) {
  const limits = [
    "Copilot loads skills, agents and commands and can run command hooks and MCP servers.",
    "Direct Claude, Codex, OpenCode and ACP sessions use plugin skills only.",
  ];
  if (preview.contents.lspServers?.length) limits.push("This version skips plugin language servers.");
  return limits.join(" ");
}
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 40);
/**
 * Which reading made the description that is kept with an installed plugin. Before 2, the
 * description came from other code than the code that starts a plugin's tools and hooks, and the
 * two could say different things. Since 2 both come from desktop/plugin-reading.mjs.
 */
const READING = 2;
/** Why Botkins itself switched a plugin off. The person switches it on again after a look. */
const HELD_BACK = {
  unseen: "Botkins switched this plugin off. An earlier version of Botkins did not show everything that this plugin starts on this computer. Look at what it starts, and switch it on again if you agree.",
  linked: "This plugin folder was linked for its skills. Botkins now keeps a copy of it and shows what it starts on this computer. It is off until you switch it on.",
};
const CHANGED_COPY = "The installed files of this plugin are not the files that were reviewed. Remove the plugin and install it again.";
const scoped = (r, id) => r.enabled && (r.bots === "all" || r.bots.includes(id));

// The paired-device router and desktop IPC share the same mutations and credential handling.
export function pluginHandlers(plugins, credentials) {
  const handlers = {};
  for (const name of ["marketplaces", "addMarketplace", "removeMarketplace"]) {
    handlers["plugins." + name] = (...args) => plugins.catalog[name](...args);
  }
  for (const name of ["browse", "preview", "install", "addFolder", "configure", "setBots", "setEnabled", "update", "uninstall"]) {
    const method = "plugins." + name;
    handlers[method] = async (...args) => plugins[name](...(await credentials.pluginArgs(method, args)));
  }
  return handlers;
}

export class Plugins {
  constructor(ws) {
    this.ws = ws;
    this.vault = ws.vault;
    this.catalog = new PluginCatalog(join(ws.dir, "plugin-marketplace"));
    this.file = join(ws.dir, "plugins.json");
    this.records = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
    // Once the host has restarted, no earlier session can still be reading an old revision.
    // File cleanup is best effort and precedes the first mutation in this process.
    this.queue = existsSync(this.catalog.pluginDir)
      ? this.catalog.pruneSnapshots(this.records.map((row) => row.folder)).catch(() => {})
      : Promise.resolve();
    this.oauth = ws.integrations.oauth;
    this.generation = 0;
    this.oauthSchemas = new Map();
    this.descriptions = new Map(); // folder → what the copy starts, as a person is shown it
    this.checked = new Map(); // folder → { stamp, ok }: the last check of the copy against its revision
    this.reviewOld();
    // Each copy is checked once at the start, and a plugin folder that an earlier version linked
    // live becomes an installed plugin. Neither holds up the start of the app.
    this.queue = this.queue.then(async () => {
      if (this.records.some((row) => !this.intact(row))) this.ws.notify?.();
      await this.adoptLinked();
    }).catch(() => {});
  }
  /** What an installed copy starts, as a person is shown it: read from the copy, by the reading the runtime starts things from. */
  described(row) {
    if (!this.descriptions.has(row.folder)) {
      let value = null;
      try {
        const starts = pluginStarts(folderReader(row.folder));
        if (starts.manifest) value = describeStarts(starts);
      } catch {}
      this.descriptions.set(row.folder, value);
    }
    return this.descriptions.get(row.folder);
  }
  /**
   * True while the installed copy is the bytes that were reviewed (its hash is its revision).
   * Called when a plugin is switched on and when a session opens. The files are hashed again
   * only when something below the folder changed since the last hash.
   */
  intact(row) {
    const stamp = snapshotStamp(row.folder);
    const known = this.checked.get(row.folder);
    if (known && known.stamp === stamp) return known.ok;
    const ok = stamp !== null && verifySnapshot(row.folder, row.revision ?? basename(row.folder));
    this.checked.set(row.folder, { stamp, ok });
    this.descriptions.delete(row.folder);
    this.oauthSchemas.delete(row.folder);
    if (!ok) console.warn("Botkins does not use the plugin " + row.preview.id + ": its installed files are not the files that were reviewed.");
    return ok;
  }
  /**
   * The descriptions kept from before the one reading are made again from the copies. A plugin
   * that starts a command its old description did not have at all is switched off, with the
   * reason, until the person has looked: nobody was shown that command.
   */
  reviewOld() {
    let changed = false;
    for (const row of this.records) {
      if (row.reading === READING) continue;
      const fresh = this.described(row);
      if (fresh) {
        const before = row.preview.contents ?? {};
        // (An old description cut a hook's command at 300 characters.)
        const shown = (hook) => (before.hooks ?? []).some((old) => typeof old?.command === "string" && (old.command === hook.command || (old.command.length === 300 && hook.command.startsWith(old.command))));
        const known = (server) => server.kind !== "local" || (before.mcpServers ?? []).some((old) => old?.name === server.name && old.kind === "local" && old.command === server.command);
        if (row.enabled && !(fresh.hooks.every(shown) && fresh.mcpServers.every(known))) Object.assign(row, { enabled: false, heldBack: "unseen" });
        const warnings = startWarnings(fresh.mcpServers, fresh.hooks, row.preview.warnings ?? []);
        const { warnings: _old, ...preview } = row.preview;
        row.preview = { ...preview, contents: { ...before, mcpServers: fresh.mcpServers, hooks: fresh.hooks }, ...(warnings.length && { warnings }) };
      }
      row.reading = READING;
      changed = true;
    }
    if (!changed) return;
    try {
      writeFileSync(this.file + ".tmp", JSON.stringify(this.records), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    } catch {}
  }
  /**
   * A plugin folder that an earlier version linked live (Settings, Skills) was read by the
   * runtime itself, with its hooks and tools, on for every bot, and nobody was shown what it
   * starts. Each one becomes an installed plugin: copied, described, switched off. One that
   * cannot be copied stays in the list, where the person can remove it, and is not used.
   */
  async adoptLinked() {
    const state = this.ws.integrations?.skillState;
    for (const link of [...(state?.plugins ?? [])]) {
      try {
        const { folder, preview, revision } = await this.catalog.addFolder(link.path);
        if (!this.records.some((row) => row.preview.id === preview.id))
          this.save({ folder, preview, revision, sourceFolder: link.path, enabled: false, bots: "all", installedAt: Date.now(), refs: {}, reading: READING, heldBack: "linked" });
        this.ws.integrations.removeFolder(link.id);
      } catch (error) {
        console.warn("Botkins does not use the linked plugin folder " + link.path + ": " + String(error?.message ?? error));
      }
    }
  }
  serialize(fn) {
    const pending = this.queue.then(fn);
    this.queue = pending.catch(() => {});
    return pending;
  }
  get(id) {
    const row = this.records.find((r) => r.preview.id === id);
    if (!row) throw new Error("This plugin is no longer installed.");
    return row;
  }
  scope(value) {
    if (value === "all") return value;
    if (!Array.isArray(value) || !value.length || value.length > 200 || value.some((id) => !this.ws.state.bots.some((b) => b.id === id)))
      throw new Error("Choose existing bots for this plugin.");
    return [...new Set(value)];
  }
  // New vault entries are written before the atomic index swap. Earlier values remain usable
  // until commit. A failed edit can only leave an unreferenced encrypted entry.
  save(row, removeId, created = []) {
    const id = removeId ?? row.preview.id;
    const next = this.records.filter((r) => r.preview.id !== id);
    if (row) next.push(row);
    try {
      writeFileSync(this.file + ".tmp", JSON.stringify(next), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    } catch (error) {
      for (const ref of created) this.vault.remove(ref);
      throw error;
    }
    this.records = next;
    this.generation++;
    this.vault.prune("plugin:" + digest(id), new Set(Object.values(row?.refs ?? {})));
    this.ws.releaseServerSessions();
    this.ws.notify();
  }
  settings(row, values) {
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 32)
      throw new Error("Check the plugin settings.");
    const fields = new Map(row.preview.config.map((f) => [f.key, f]));
    const entries = Object.entries(values);
    for (const [key, value] of entries) {
      if (!fields.has(key) || key in Object.prototype || (value !== null && (typeof value !== "string" || value.length > 4000)))
        throw new Error("A plugin setting is unknown or invalid.");
    }
    const created = [];
    try {
      row.refs = { ...row.refs };
      for (const [key, value] of entries) {
        if (value === null || value === "") delete row.refs[key];
        else {
          const ref = this.vault.put(value, {
            label: row.preview.name + " · " + fields.get(key).label,
            kind: "plugin",
            owner: "plugin:" + digest(row.preview.id),
          });
          row.refs[key] = ref;
          created.push(ref);
        }
      }
      return created;
    } catch (error) {
      for (const ref of created) this.vault.remove(ref);
      throw error;
    }
  }
  values(row) {
    return Object.fromEntries(
      row.preview.config.flatMap((f) => {
        const value = row.refs[f.key] ? this.vault.get(row.refs[f.key]) : f.default;
        return value == null ? [] : [[f.key, value]];
      }),
    );
  }
  runtimeRecord(row) {
    return { id: row.preview.id, folder: row.folder, config: row.preview.config, values: this.values(row) };
  }
  oauthServers(row) {
    // Manifests are immutable per revision. Snapshotting a streaming chat must not
    // reread a plugin from disk or decrypt its settings on every text delta.
    if (!this.oauthSchemas.has(row.folder)) {
      const servers = pluginOAuthServers({ id: row.preview.id, folder: row.folder }).map((server) => ({
        ...server,
        id: "plugin-" + digest(JSON.stringify([row.preview.id, server.manifestName, server.url, server.clientId])),
        vaultOwner: "plugin-oauth:" + digest(row.preview.id),
      }));
      this.oauthSchemas.set(row.folder, servers);
    }
    return this.oauthSchemas.get(row.folder);
  }
  public(row) {
    const { preview } = row;
    const config = preview.config.map((f) => {
      const ref = row.refs[f.key];
      // The link resolves a saved credential before the host sees it. Even a field named
      // "account" can therefore contain a credential. Keep every supplied value write-only.
      return { ...f, set: ref ? !this.vault.locked && this.vault.has(ref) : f.default != null && f.default !== "" };
    });
    const unavailable = config.some((field) => row.refs[field.key] && !field.set);
    // (The last check of the copy. This is called for every look at the app's state, so it reads no file.)
    const changedCopy = this.checked.get(row.folder)?.ok === false;
    let status = unavailable || changedCopy ? "error" : config.some((f) => f.required && !f.set) ? "needs-config" : "ready";
    // What the plugin starts is read from the copy, not taken from what was kept at install.
    const fresh = changedCopy ? null : this.described(row);
    const warnings = fresh ? startWarnings(fresh.mcpServers, fresh.hooks, preview.warnings ?? []) : (preview.warnings ?? []);
    let servers = [];
    if (status === "ready") {
      try {
        servers = this.oauthServers(row);
        if (servers.some((s) => !this.oauth.status(s).signedIn)) status = "needs-sign-in";
        if (!existsSync(row.folder)) status = "error";
      } catch {
        status = "error";
      }
    }
    const { warnings: _kept, ...rest } = preview;
    return {
      ...rest,
      ...(warnings.length && { warnings }),
      installed: true,
      enabled: row.enabled,
      bots: row.bots,
      installedAt: row.installedAt,
      status,
      ...(row.heldBack && !row.enabled && { detail: HELD_BACK[row.heldBack] }),
      ...(status === "error" && {
        detail: unavailable ? "This computer could not open a saved plugin setting." : changedCopy && existsSync(row.folder) ? CHANGED_COPY : "The installed plugin files could not be opened.",
      }),
      ...(status === "needs-sign-in" && { detail: "Sign in to the plugin’s remote tools on this computer." }),
      limits: limitsFor(preview),
      config: config.map(({ sentTo: _old, ...field }) => ({ ...field, ...(fresh?.sentTo.has(field.key) && { sentTo: fresh.sentTo.get(field.key) }) })),
      ...(row.sourceFolder && { folder: row.sourceFolder }),
      contents: {
        ...preview.contents,
        ...(fresh && { hooks: fresh.hooks }),
        mcpServers: (fresh?.mcpServers ?? preview.contents.mcpServers).map((s) => {
          const auth = servers.find((a) => a.manifestName === s.name);
          return auth ? { ...s, serverId: auth.id } : s;
        }),
      },
    };
  }
  list() {
    return this.records.map((r) => this.public(r));
  }
  async browse(query) {
    const page = await this.catalog.browse(query);
    return { ...page, plugins: page.plugins.map((p) => (this.records.some((r) => r.preview.id === p.id) ? { ...p, installed: true } : p)) };
  }
  preview(id) {
    return this.catalog.preview(id);
  }
  install(id, options = {}, verify) {
    return this.serialize(async () => {
      verify?.();
      if (this.records.some((r) => r.preview.id === id)) throw new Error("This plugin is already installed.");
      const bots = this.scope(options.bots ?? "all");
      const { folder, preview, revision } = await this.catalog.materialize(id, options.revision);
      verify?.();
      const row = { folder, preview, revision, enabled: true, bots, installedAt: Date.now(), refs: {}, reading: READING };
      const created = this.settings(row, options.config ?? {});
      this.save(row, undefined, created);
      return this.public(row);
    });
  }
  addFolder(path) {
    return this.serialize(async () => {
      const { folder, preview, revision } = await this.catalog.addFolder(path);
      if (this.records.some((r) => r.preview.id === preview.id)) throw new Error("This folder is already installed.");
      const row = { folder, preview, revision, sourceFolder: path, enabled: false, bots: "all", installedAt: Date.now(), refs: {}, reading: READING };
      this.save(row);
      return this.public(row);
    });
  }
  configure(id, values, verify) {
    return this.serialize(() => {
      verify?.();
      const row = { ...this.get(id) };
      const created = this.settings(row, values);
      this.save(row, undefined, created);
    });
  }
  setBots(id, bots) {
    return this.serialize(() => this.save({ ...this.get(id), bots: this.scope(bots) }));
  }
  setEnabled(id, enabled, verify) {
    return this.serialize(() => {
      verify?.();
      if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
      // (Switching on is the person's yes after a look: a reason Botkins switched it off for is done with.)
      const { heldBack: _reason, ...row } = this.get(id);
      if (enabled && !this.intact(row)) throw new Error(CHANGED_COPY);
      this.save({ ...row, enabled });
    });
  }
  update(id, options = {}, verify) {
    return this.serialize(async () => {
      verify?.();
      const before = this.get(id);
      const material = await this.catalog.materialize(id, options.revision);
      verify?.();
      const refs = Object.fromEntries(
        material.preview.config.flatMap((f) =>
          before.refs[f.key] && before.preview.config.some((old) => old.key === f.key && old.secret === f.secret)
            ? [[f.key, before.refs[f.key]]]
            : [],
        ),
      );
      const row = { ...before, folder: material.folder, revision: material.revision, preview: material.preview, refs, reading: READING };
      const previousServers = this.knownOAuthServers(before);
      const currentServers = new Set(this.knownOAuthServers(row).map((server) => server.id));
      this.save(row);
      for (const server of previousServers) {
        if (currentServers.has(server.id)) continue;
        this.oauth.cancel(server.id);
        this.vault.remove(this.oauth.entry(server));
      }
      if (before.folder !== row.folder) this.oauthSchemas.delete(before.folder);
      return this.public(row);
    });
  }
  uninstall(id, verify) {
    return this.serialize(async () => {
      verify?.();
      const row = this.get(id);
      // A missing source or damaged manifest must still be removable.
      for (const server of this.knownOAuthServers(row)) this.oauth.cancel(server.id);
      this.save(null, id);
      this.vault.prune("plugin-oauth:" + digest(id));
      this.oauthSchemas.delete(row.folder);
      if (row.sourceFolder) await this.catalog.forgetFolder(id);
    });
  }
  knownOAuthServers(row) {
    try {
      return this.oauthServers(row);
    } catch {
      return [];
    }
  }
  authServer(id) {
    return this.records.flatMap((row) => this.knownOAuthServers(row)).find((server) => server.id === id);
  }
  cancelSignIn(id) {
    return this.oauth.cancel(id);
  }
  async signOut(id) {
    const server = this.authServer(id);
    if (!server) throw new Error("This plugin sign-in is unavailable.");
    await this.oauth.signOut(server);
    this.ws.releaseServerSessions();
    this.ws.notify();
  }
  async signIn(id) {
    const server = this.authServer(id);
    if (!server) throw new Error("This plugin sign-in is unavailable.");
    await this.oauth.signIn(server, { client: server.clientId ? { clientId: server.clientId } : undefined });
    if (!this.authServer(id)) {
      this.vault.remove(this.oauth.entry(server));
      throw new Error("The plugin changed during sign-in.");
    }
    this.ws.releaseServerSessions();
    this.ws.notify();
    return { type: "oauth", ...this.oauth.status(server), clientSecret: false };
  }
  async token(botId, request) {
    for (const row of this.records.filter((r) => scoped(r, botId))) {
      const server = this.knownOAuthServers(row).find((s) => s.name === request.server && s.url === request.url);
      if (server)
        return this.oauth.token(server, { reason: request.reason, client: server.clientId ? { clientId: server.clientId } : undefined });
    }
    return null;
  }
  async session(bot, chat, { skillsOnly = false } = {}) {
    // A copy that is no longer the reviewed bytes is not used, and the app shows why.
    const scopedRows = this.records.filter((r) => scoped(r, bot.id));
    const before = scopedRows.map((r) => this.checked.get(r.folder)?.ok);
    const sound = scopedRows.filter((r) => this.intact(r));
    if (scopedRows.some((r, index) => before[index] !== false && this.checked.get(r.folder)?.ok === false)) this.ws.notify();
    const rows = sound.filter((r) => this.public(r).status === "ready");
    if (!rows.length) return { directories: [], mcpServers: {}, hooks: undefined };
    const plugins = rows.map((row) => (skillsOnly ? { id: row.preview.id, folder: row.folder } : this.runtimeRecord(row)));
    return pluginSession(plugins, { dir: this.ws.dir, botId: bot.id, chatId: chat.id, skillsOnly });
  }
}
