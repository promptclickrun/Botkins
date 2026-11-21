// The host owns installed plugin scope and configuration. Only list() is published to clients.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { PluginCatalog, snapshotStamp, verifySnapshot } from "./plugin-catalog.mjs";
import { describeStarts, folderReader, pluginStarts, STARTS, startWarnings } from "./plugin-reading.mjs";
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
  unread: "Botkins switched this plugin off. Its installed files could not be read, so Botkins cannot show what it starts. Update the plugin to write its files again, then switch it on.",
  linked: "This plugin folder was linked for its skills. Botkins now keeps a copy of it and shows what it starts on this computer. It is off until you switch it on.",
};
const CHANGED_COPY = "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings.";
/** The mark on a description that is the one reading of an intact copy (STARTS of plugin-reading.mjs). */
/** The id of a linked plugin folder that could not be copied, so a client can show it and remove it. */
const linkedId = (path) => "linked-" + createHash("sha256").update(path).digest("hex").slice(0, 12);
/** One short sentence, with no stack, for the person to read. */
function oneSentence(error) {
  const line = String(error?.message ?? error).split("\n")[0].trim().slice(0, 299) || "The folder could not be read";
  return /[.!?]$/.test(line) ? line : line + ".";
}
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
    this.unadopted = new Map(); // linked plugin folder → why Botkins could not copy it
    this.reviewOld();
    // Each copy is checked once at the start, and a plugin folder that an earlier version linked
    // live becomes an installed plugin. Neither holds up the start of the app.
    this.queue = this.queue.then(async () => {
      // (Every copy is checked, not only up to the first bad one.)
      if (this.records.map((row) => this.intact(row)).includes(false)) this.ws.notify?.();
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
    this.descriptions.delete(row.folder);
    this.oauthSchemas.delete(row.folder);
    if (ok === null) {
      // The check itself failed (a read error), which says nothing about the files. Nothing is kept, so the next look
      // tries again, and the app shows no "changed" sentence. The plugin is not used until a check says yes.
      this.checked.delete(row.folder);
      console.warn("Botkins could not check the installed files of the plugin " + row.preview.id + " this time, so it does not use it now. It tries again at the next look.");
      return false;
    }
    this.checked.set(row.folder, { stamp, ok });
    if (!ok) console.warn("Botkins does not use the plugin " + row.preview.id + ": its installed files are not the files that were reviewed.");
    return ok;
  }
  /**
   * The descriptions kept from before the one reading are made again from the copies. An old
   * description showed a local tool by its name and command only, a hook by its event and its
   * command cut at 300 characters, and a remote tool by its name and address. A plugin that is on
   * and starts anything beyond that is switched off, with the reason, until the person has
   * looked: nobody was shown the rest. A copy that cannot be read is not marked as read, so it
   * is looked at again at the next start.
   */
  reviewOld() {
    let changed = false;
    // (An item with settings of its own for a program or a command was never shown by an old description.)
    const extras = (item) => Boolean(item.env?.length || item.envNotSet?.length);
    const unseen = (fresh, before) => {
      const tools = before.mcpServers ?? [];
      const hooks = before.hooks ?? [];
      const toolUnseen = (tool) =>
        tool.kind === "local"
          ? !tools.some((old) => old?.name === tool.name && old.kind === "local" && old.command === tool.command) || Boolean(tool.args?.length || tool.cwd) || extras(tool)
          : !tools.some((old) => old?.name === tool.name && old.url === tool.url);
      const hookUnseen = (hook) => !hooks.some((old) => typeof old?.command === "string" && old.command === hook.command) || extras(hook);
      return fresh.mcpServers.some(toolUnseen) || fresh.hooks.some(hookUnseen);
    };
    for (const row of this.records) {
      if (row.reading === READING) continue;
      // The copy is checked before it is read: a description is never made from bytes that are not the reviewed ones.
      // Such a row is left as it is. It stays as it was kept, on or off, and the error it shows already keeps it from
      // being used. An update writes its files again and marks it as read. (A copy that is gone is not "changed":
      // it falls through to "could not be read" below.)
      if (existsSync(row.folder) && !this.intact(row)) continue;
      const fresh = this.described(row);
      if (!fresh) {
        if (row.enabled) {
          Object.assign(row, { enabled: false, heldBack: "unread" });
          changed = true;
        }
        continue;
      }
      const before = row.preview.contents ?? {};
      if (row.enabled && unseen(fresh, before)) Object.assign(row, { enabled: false, heldBack: "unseen" });
      row.preview = this.refreshed(row.preview, fresh);
      row.reading = READING;
      changed = true;
    }
    if (!changed) return;
    try {
      writeFileSync(this.file + ".tmp", JSON.stringify(this.records), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    } catch {}
  }
  /** A kept description with what the copy starts, as the one reading shows it: tools, hooks, what is not run, and the warnings made from them. */
  refreshed(preview, fresh) {
    const { warnings: _old, ...rest } = preview;
    const { notRun: _was, ...before } = preview.contents ?? {};
    const warnings = startWarnings(fresh.mcpServers, fresh.hooks, preview.warnings ?? [], fresh.notRun ?? []);
    return { ...rest, contents: { ...before, mcpServers: fresh.mcpServers, hooks: fresh.hooks, ...(fresh.notRun?.length && { notRun: fresh.notRun }) }, ...(warnings.length && { warnings }) };
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
        this.unadopted.delete(link.path);
      } catch (error) {
        // (The link stays, and list() shows it as a plugin in error, so the person can put the folder right or remove it.)
        this.unadopted.set(link.path, oneSentence(error));
        console.warn("Botkins does not use the linked plugin folder " + link.path + ": " + String(error?.message ?? error).split("\n")[0].slice(0, 300));
      }
    }
    if (this.unadopted.size) this.ws.notify?.();
  }
  /** The linked plugin folders that could not be copied. A reason is dropped when its link is gone. */
  linkedErrors() {
    const links = this.ws.integrations?.skillState?.plugins ?? [];
    for (const path of [...this.unadopted.keys()]) if (!links.some((link) => link.path === path)) this.unadopted.delete(path);
    return links.filter((link) => this.unadopted.has(link.path)).map((link) => ({ link, id: linkedId(link.path), reason: this.unadopted.get(link.path) }));
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
    // The runtime asks again before each hook starts. The app is told the first time the copy is found changed.
    const intact = () => {
      const was = this.checked.get(row.folder)?.ok;
      const ok = this.intact(row);
      if (!ok && was !== false) this.ws.notify?.();
      return ok;
    };
    return { id: row.preview.id, folder: row.folder, config: row.preview.config, values: this.values(row), intact };
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
    const warnings = fresh ? startWarnings(fresh.mcpServers, fresh.hooks, preview.warnings ?? [], fresh.notRun ?? []) : (preview.warnings ?? []);
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
    // (The mark comes from the fresh reading of an intact copy, never from what was kept.)
    const { warnings: _kept, starts: _stored, ...rest } = preview;
    const { notRun: _storedNotRun, ...storedContents } = preview.contents;
    return {
      ...rest,
      ...(fresh && { starts: STARTS }),
      ...(warnings.length && { warnings }),
      installed: true,
      enabled: row.enabled,
      bots: row.bots,
      installedAt: row.installedAt,
      status,
      // The way back for a copy that is changed, gone or not readable is an update: it writes the
      // reviewed files again and keeps the settings. A client offers Update from this mark, not
      // from the words of `detail`, also when the source did not change.
      ...((changedCopy || (row.heldBack === "unread" && !row.enabled)) && { repair: "update" }),
      ...(row.heldBack && !row.enabled && { detail: HELD_BACK[row.heldBack] }),
      ...(status === "error" && {
        detail: unavailable ? "This computer could not open a saved plugin setting." : changedCopy && existsSync(row.folder) ? CHANGED_COPY : row.heldBack === "unread" && !row.enabled ? HELD_BACK.unread : "The installed plugin files could not be opened.",
      }),
      ...(status === "needs-sign-in" && { detail: "Sign in to the plugin’s remote tools on this computer." }),
      limits: limitsFor(preview),
      config: config.map(({ sentTo: _old, ...field }) => ({ ...field, ...(fresh?.sentTo.has(field.key) && { sentTo: fresh.sentTo.get(field.key) }) })),
      ...(row.sourceFolder && { folder: row.sourceFolder }),
      contents: {
        ...(fresh ? storedContents : preview.contents),
        ...(fresh && { hooks: fresh.hooks }),
        ...(fresh?.notRun?.length && { notRun: fresh.notRun }),
        mcpServers: (fresh?.mcpServers ?? preview.contents.mcpServers).map((s) => {
          const auth = servers.find((a) => a.manifestName === s.name);
          return auth ? { ...s, serverId: auth.id } : s;
        }),
      },
    };
  }
  list() {
    return [
      ...this.records.map((r) => this.public(r)),
      ...this.linkedErrors().map(({ link, id, reason }) => ({
        id,
        name: basename(link.path),
        marketplace: "folder",
        installed: true,
        enabled: false,
        bots: "all",
        status: "error",
        detail: "This plugin folder was linked for its skills. Botkins could not copy it, so it is not used: " + reason + " Put the folder right and start Botkins again, or remove it.",
        folder: link.path,
        config: [],
        contents: { skills: [], agents: [], commands: [], mcpServers: [], hooks: [] },
        limits: "",
      })),
    ];
  }
  async browse(query) {
    const page = await this.catalog.browse(query);
    return { ...page, plugins: page.plugins.map((p) => (this.records.some((r) => r.preview.id === p.id) ? { ...p, installed: true } : p)) };
  }
  preview(id) {
    return this.catalog.preview(id);
  }
  /** An install and an update name the revision of the plugin as the person saw it; a source that is another one now is refused by the catalog. The app holds the rule itself: a call with no revision is refused, whoever makes it. */
  reviewed(options) {
    if (typeof options?.revision !== "string" || !/^[a-f0-9]{64}$/.test(options.revision)) throw new Error("Look at the plugin first. An install or an update names the revision that was looked at.");
  }
  install(id, options = {}, verify) {
    return this.serialize(async () => {
      verify?.();
      this.reviewed(options);
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
      if (enabled && row.reading !== READING) {
        // The copy is checked before it is read. (A copy that is gone is "could not be read", below.)
        if (existsSync(row.folder) && !this.intact(row)) throw new Error(CHANGED_COPY);
        // A copy that could not be read at the start is read again now, not from what was kept.
        this.descriptions.delete(row.folder);
        const fresh = this.described(row);
        if (!fresh) throw new Error(HELD_BACK.unread);
        // (The person looks at the fresh description before this yes, so the start does not ask again.)
        row.reading = READING;
        row.preview = this.refreshed(row.preview, fresh);
      }
      if (enabled && !this.intact(row)) throw new Error(CHANGED_COPY);
      this.save({ ...row, enabled });
    });
  }
  update(id, options = {}, verify) {
    return this.serialize(async () => {
      verify?.();
      this.reviewed(options);
      const before = this.get(id);
      // The way back that a client offers is an update. Where the update cannot work either, the person is told the next step.
      const repairing = this.checked.get(before.folder)?.ok === false || before.heldBack === "unread";
      let material;
      try {
        material = await this.catalog.materialize(id, options.revision);
      } catch (error) {
        if (repairing) throw new Error(String(error?.message ?? error) + " If the plugin cannot be updated, remove it.");
        throw error;
      }
      verify?.();
      const refs = Object.fromEntries(
        material.preview.config.flatMap((f) =>
          before.refs[f.key] && before.preview.config.some((old) => old.key === f.key && old.secret === f.secret)
            ? [[f.key, before.refs[f.key]]]
            : [],
        ),
      );
      // (A plugin that was off because its files could not be read has files that can be read now: that reason, and the
      // mark that an update is the way back, are done with. It stays off until the person switches it on.)
      const { heldBack, ...kept } = before;
      const row = { ...kept, ...(heldBack && heldBack !== "unread" && { heldBack }), folder: material.folder, revision: material.revision, preview: material.preview, refs, reading: READING };
      const previousServers = this.knownOAuthServers(before);
      // The folder is the same one when the source did not change. The files were written again,
      // so what was cached about the old files is dropped and the copy is checked again.
      for (const cache of [this.checked, this.descriptions, this.oauthSchemas]) cache.delete(row.folder);
      if (!this.intact(row)) throw new Error(CHANGED_COPY);
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
      const linked = this.linkedErrors().find((entry) => entry.id === id);
      if (linked) {
        this.ws.integrations.removeFolder(linked.link.id);
        this.unadopted.delete(linked.link.path);
        this.ws.notify?.();
        return;
      }
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
