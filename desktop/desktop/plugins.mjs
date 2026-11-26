// The host owns installed plugin scope and configuration. Only list() is published to clients.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { PluginCatalog, snapshotStamp, verifySnapshot } from "./plugin-catalog.mjs";
import { describeStarts, folderReader, lineOf, pluginStarts, STARTS, startWarnings } from "./plugin-reading.mjs";
import { MIN_SECRET_LENGTH, newStops, pluginSession, pluginOAuthServers, secretField } from "./plugin-runtime.mjs";

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
 * two could say different things. Since 2 both come from desktop/plugin-reading.mjs. A row that was
 * marked 2 has a complete description, but nobody looked for a hook that runs now and did not run
 * before: 3 means that look was made (see reviewOld).
 */
const READING = 3;
/**
 * What Botkins says about a plugin where nobody was shown all that it starts (a row's `note`). It is a warning with the
 * plugin's other warnings, and the plugin stays as the person has it, on or off.
 *
 * The owner's rule of 2026-11-21: "warning a user as they enable a plugin is fine, but blocking them is not unless it truly
 * looks malicious with a high confidence (supply chain, prompt injection or credential stealing for example)." So Botkins
 * switches no plugin off by itself and refuses no switch-on. What it still refuses is a copy whose files are not the
 * reviewed ones (CHANGED_COPY: the supply-chain case), and an install or update that names no revision or another one.
 * Versions up to 0.17.2 switched a plugin off for these four reasons (`heldBack`): reviewOld switches those on again.
 */
const NOTES = {
  unseen: "An earlier version of Botkins did not show everything that this plugin starts on this computer. Look at what it starts.",
  unread: "The installed files of this plugin could not be read, so Botkins cannot show what it starts. Update the plugin to write its files again.",
  newhook: "A hook of this plugin did not run before this version of Botkins and runs now. Look at what it starts.",
  linked: "This plugin folder was linked for its skills. Botkins now keeps a copy of it and shows what it starts on this computer.",
};
/** A copy that cannot be read cannot be described or started. */
const UNREAD_COPY = "The installed files of this plugin could not be read, so Botkins cannot show what it starts. Update the plugin to write its files again, then switch it on.";
const CHANGED_COPY = "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings.";
/** The check of the copy could not be done (a read error). That says nothing about the files, so it is not "changed". */
const UNREADABLE_COPY = "Botkins could not read the installed files of this plugin to check them. Try again. If it stays so, update the plugin: Botkins writes its files again and keeps your settings.";
/** The catalog's refusal for a revision that is not the source's now. Here the right step is to look again, not to remove the plugin. */
const REVISION_CHANGED = /was reviewed; preview it again/;
/** How long a failed read (of the vault, or of a copy's files) waits before it is tried again. */
const RETRY_MS = 30_000;
/** Why a tool that the files describe as starting is not started. */
const SECRET_IN_LINE = "A word of this tool's command holds the value of a secret setting, so Botkins does not start it.";
/**
 * The mark `starts` is put on an answer only (public()). It is never kept: an older Botkins that is put
 * back over the same data would answer a kept mark as it is, for a description its own code made.
 * Returns the same preview when there is nothing to take off.
 */
function unmarked(preview) {
  if (!preview || typeof preview !== "object") return preview;
  const inContents = preview.contents && typeof preview.contents === "object" && "starts" in preview.contents;
  if (!("starts" in preview) && !inContents) return preview;
  const { starts: _mark, ...rest } = preview;
  if (!inContents) return rest;
  const { starts: _inner, ...contents } = preview.contents;
  return { ...rest, contents };
}
/** A row with no mark in its description. The same row when it has none. */
function unmarkedRow(row) {
  const preview = unmarked(row?.preview);
  return preview === row?.preview ? row : { ...row, preview };
}
/** What a description says is not run: a list (earlier shape) or { count, items }. */
const notRunItems = (notRun) => (Array.isArray(notRun) ? notRun : (notRun?.items ?? []));
const notRunCount = (notRun) => (Array.isArray(notRun) ? notRun.length : (notRun?.count ?? 0));
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
  for (const name of ["marketplaces", "addMarketplace", "removeMarketplace", "refresh"]) {
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
    // The clock. A test replaces it, to move the time of the waits below.
    this.now = () => Date.now();
    this.vault = ws.vault;
    this.catalog = new PluginCatalog(join(ws.dir, "plugin-marketplace"));
    this.file = join(ws.dir, "plugins.json");
    let marked = false;
    // (A row that an earlier build wrote with the mark in its description loses it here, and the file is written again.)
    this.records = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : []).map((row) => {
      const bare = unmarkedRow(row);
      if (bare !== row) marked = true;
      return bare;
    });
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
    this.unreadable = new Map(); // folder → { since, times }: the last check could not be done (a read error), and how often in a row
    this.stopped = new Map(); // folder + refs → names of the tools that a secret's value keeps from starting
    this.stoppedFailed = new Map(); // the same key → the time until which a read of the vault that threw is not tried again
    this.stops = new Map(); // chat id → the count of blocks of the turn that runs there (see turnStarted)
    this.unadopted = new Map(); // linked plugin folder → why Botkins could not copy it
    // The one-time look at rows from an older version is made here, before the first answer: nothing of a copy that was
    // not checked may be shown or stored. It hashes the copy of each such row. A row that is already at READING is passed
    // by with no file opened. Its copy is checked in the queue below, which is also where an adopted folder is copied.
    this.reviewOld(marked);
    // These do not hold up the start of the app.
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
    this.forgetStopped(row.folder);
    if (ok === null) {
      // The check itself failed (a read error), which says nothing about the files. No answer is kept, so the next look
      // tries again, and the app shows no "changed" sentence. The plugin is not used until a check says yes. That the
      // check could not be done is kept, so a copy that can never be read is shown as an error, not as ready.
      this.checked.delete(row.folder);
      const was = this.unreadable.get(row.folder);
      this.unreadable.set(row.folder, { since: was?.since ?? this.now(), times: (was?.times ?? 0) + 1, last: this.now() });
      console.warn("Botkins could not check the installed files of the plugin " + row.preview.id + " this time, so it does not use it now. It tries again at the next look.");
      return false;
    }
    this.unreadable.delete(row.folder);
    this.checked.set(row.folder, { stamp, ok });
    if (!ok) console.warn("Botkins does not use the plugin " + row.preview.id + ": its installed files are not the files that were reviewed.");
    return ok;
  }
  /** Says why a copy is not sound: a check that could not be done is not a change of the files. */
  assertIntact(row) {
    if (this.intact(row)) return;
    throw new Error(this.unreadable.has(row.folder) ? UNREADABLE_COPY : CHANGED_COPY);
  }
  /** The names of the tools of the copy that the runtime does not start, because a secret setting's value is in their line. */
  stoppedTools(row, fresh) {
    const key = row.folder + "\0" + JSON.stringify(row.refs);
    if (!this.stopped.has(key)) {
      // (Public answers are made for every state message: the vault is not opened for each one. A locked vault is asked again later.)
      if (this.vault.locked) return [];
      // A read that threw is not tried again for 30 seconds, so a broken vault is not opened for each state message.
      if (this.now() < (this.stoppedFailed.get(key) ?? 0)) return [];
      const secrets = [];
      try {
        for (const field of row.preview.config) {
          if (!secretField(field) || !row.refs[field.key]) continue;
          const value = this.vault.get(row.refs[field.key]);
          if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) secrets.push(value);
        }
      } catch {
        this.stoppedFailed.set(key, this.now() + RETRY_MS);
        return [];
      }
      this.stoppedFailed.delete(key);
      // (`lineOf` is the line the runtime checks: the command and each argument.)
      const names = secrets.length ? fresh.mcpServers.filter((server) => server.kind === "local" && lineOf(server).some((word) => secrets.some((secret) => String(word).includes(secret)))).map((server) => server.name) : [];
      this.stopped.set(key, names);
    }
    return this.stopped.get(key);
  }
  forgetStopped(folder) {
    for (const map of [this.stopped, this.stoppedFailed]) for (const key of [...map.keys()]) if (key.startsWith(folder + "\0")) map.delete(key);
  }
  /** Writes the rows to the file, with no mark `starts` in any description. Returns the rows as written. */
  persist(rows) {
    const clean = rows.map(unmarkedRow);
    writeFileSync(this.file + ".tmp", JSON.stringify(clean), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
    return clean;
  }
  /**
   * The descriptions kept from before the one reading are made again from the copies. An old
   * description showed a local tool by its name and command only, a hook by its event and its
   * command cut at 300 characters, and a remote tool by its name and address. A plugin that is on
   * and starts anything beyond that gets a note, which is shown as a warning: nobody was shown
   * the rest. It stays on (see NOTES for the rule). A copy that cannot be read is not marked as
   * read, so it is looked at again at the next start.
   *
   * A row that is marked 2 was described by the one reading already, so its description is
   * complete: only the second rule below applies to it, and then it is marked 3.
   * `changed` says that the file is to be written again, for a reason found before this look.
   */
  reviewOld(changed = false) {
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
      // A version up to 0.17.2 switched this plugin off by itself, and the person never chose off (a switch by the person
      // drops the reason). It goes on again, and the reason stays as a warning.
      if (row.heldBack) {
        if (NOTES[row.heldBack]) row.note = row.heldBack;
        if (!row.enabled) row.enabled = true;
        delete row.heldBack;
        changed = true;
      }
      if (row.reading === READING) continue;
      // The copy is checked before it is read: a description is never made from bytes that are not the reviewed ones.
      // Such a row is left as it is. It stays as it was kept, on or off, and the error it shows already keeps it from
      // being used. An update writes its files again and marks it as read. (A copy that is gone is not "changed":
      // it falls through to "could not be read" below.)
      if (existsSync(row.folder) && !this.intact(row)) continue;
      const fresh = this.described(row);
      const complete = row.reading === 2;
      if (!fresh) {
        if (row.note !== "unread") {
          row.note = "unread";
          changed = true;
        }
        continue;
      }
      const before = row.preview.contents ?? {};
      if (!complete && row.enabled && unseen(fresh, before)) row.note = "unseen";
      // A hook that earlier versions never ran (a matcher that means every case, an event under its other spelling) runs
      // now. The person agreed to a plugin whose hook, in fact, never ran: a note tells them. What such a hook gets: the
      // person's prompt, which it can change or block; with a matcher of "*" on a tool event, the arguments and the result
      // of each tool call; and an agentStop hook can make the bot go on.
      else if (row.enabled && fresh.newlyRun) row.note = "newhook";
      row.preview = this.refreshed(row.preview, fresh);
      row.reading = READING;
      changed = true;
    }
    if (!changed) return;
    try {
      this.records = this.persist(this.records);
    } catch {
      // (The rows keep what the look found for this run. The file is not changed, so the next start looks again.)
      console.warn("Botkins could not write the plugins file " + basename(this.file) + ", so it looks at the older plugins again at the next start.");
    }
  }
  /** A kept description with what the copy starts, as the one reading shows it: tools, hooks, what is not run, and the warnings made from them. */
  refreshed(preview, fresh) {
    // (The mark `starts` is not kept: public() puts it on the answer.)
    const { warnings: _old, starts: _mark, ...rest } = preview;
    const { notRun: _was, starts: _inner, ...before } = preview.contents ?? {};
    const warnings = startWarnings(fresh.mcpServers, fresh.hooks, preview.warnings ?? [], fresh.notRun ?? []);
    return { ...rest, contents: { ...before, mcpServers: fresh.mcpServers, hooks: fresh.hooks, ...(notRunCount(fresh.notRun) > 0 && { notRun: fresh.notRun }) }, ...(warnings.length && { warnings }) };
  }
  /**
   * A plugin folder that an earlier version linked live (Settings, Skills) was read by the
   * runtime itself, with its hooks and tools, on for every bot, and nobody was shown what it
   * starts. Each one becomes an installed plugin: copied, described, and on as it was, with a
   * note that is shown as a warning. One that
   * cannot be copied stays in the list, where the person can remove it, and is not used.
   */
  async adoptLinked() {
    const state = this.ws.integrations?.skillState;
    for (const link of [...(state?.plugins ?? [])]) {
      try {
        const { folder, preview, revision } = await this.catalog.addFolder(link.path);
        if (!this.records.some((row) => row.preview.id === preview.id))
          this.save({ folder, preview, revision, sourceFolder: link.path, enabled: true, bots: "all", installedAt: Date.now(), refs: {}, reading: READING, note: "linked" });
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
    let written;
    try {
      // (The rows kept in memory are the rows written: neither has the mark `starts`.)
      written = this.persist(next);
    } catch (error) {
      for (const ref of created) this.vault.remove(ref);
      throw error;
    }
    this.records = written;
    this.stopped.clear();
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
    // (The last check could not be done: the files are not known to be changed, but nothing of them is shown as checked.)
    const unreadable = this.unreadable.has(row.folder);
    let status = unavailable || changedCopy || unreadable ? "error" : config.some((f) => f.required && !f.set) ? "needs-config" : "ready";
    // What the plugin starts is read from the copy, not taken from what was kept at install.
    const fresh = changedCopy || unreadable ? null : this.described(row);
    // A tool that the files describe as starting, and that is not started because a secret's value is in its line, is said as not run.
    const held = fresh ? this.stoppedTools(row, fresh) : [];
    let notRun = fresh?.notRun;
    if (held.length) {
      const items = [...notRunItems(notRun), ...held.map((name) => ({ what: "tool", name, why: SECRET_IN_LINE }))];
      notRun = Array.isArray(notRun) ? items : { count: notRunCount(notRun) + held.length, items };
    }
    // (What nobody was shown comes first. Files that could not be read are said in `detail`, with the way back, not here.)
    const note = row.note === "unread" ? null : NOTES[row.note];
    const warnings = [...(note ? [note] : []), ...(fresh ? startWarnings(fresh.mcpServers, fresh.hooks, preview.warnings ?? [], notRun ?? []) : (preview.warnings ?? []))];
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
      // (The revision of the installed copy: the one that a switch-on and a choice of bots are compared with.)
      revision: row.revision ?? basename(row.folder),
      status,
      // The way back for a copy that is changed, gone or not readable is an update: it writes the
      // reviewed files again and keeps the settings. A client offers Update from this mark, not
      // from the words of `detail`, also when the source did not change.
      ...((changedCopy || unreadable || (row.note === "unread" && !fresh)) && { repair: "update" }),
      ...(status === "error" && {
        detail: unavailable ? "This computer could not open a saved plugin setting." : unreadable ? UNREADABLE_COPY : changedCopy && existsSync(row.folder) ? CHANGED_COPY : row.note === "unread" ? NOTES.unread : "The installed plugin files could not be opened.",
      }),
      ...(status === "needs-sign-in" && { detail: "Sign in to the plugin’s remote tools on this computer." }),
      limits: limitsFor(preview),
      config: config.map(({ sentTo: _old, ...field }) => ({ ...field, ...(fresh?.sentTo.has(field.key) && { sentTo: fresh.sentTo.get(field.key) }) })),
      ...(row.sourceFolder && { folder: row.sourceFolder }),
      contents: {
        ...(fresh ? storedContents : preview.contents),
        ...(fresh && { hooks: fresh.hooks }),
        ...(notRunCount(notRun) > 0 && { notRun }),
        mcpServers: (fresh?.mcpServers ?? preview.contents.mcpServers).map((s) => {
          const auth = servers.find((a) => a.manifestName === s.name);
          return auth ? { ...s, serverId: auth.id } : s;
        }),
      },
    };
  }
  /** A copy whose last check could not be done is checked again here, not more than once in 30 seconds for a folder, and the error goes when the check works. */
  recheck(row) {
    const was = this.unreadable.get(row.folder);
    if (was && this.now() - (was.last ?? was.since) >= RETRY_MS) this.intact(row);
  }
  list() {
    for (const row of this.records) this.recheck(row);
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
  /**
   * Adds a plugin from a folder on this computer. It arrives switched on, as an installed plugin does: the window and the
   * phone warn the person before they add it. `options.enabled: false` adds it switched off (the control socket, which
   * cannot know that a person saw the warning: desktop/terminal/control-plugins.mjs).
   */
  addFolder(path, options) {
    return this.serialize(async () => {
      const { folder, preview, revision } = await this.catalog.addFolder(path);
      if (this.records.some((r) => r.preview.id === preview.id)) throw new Error("This folder is already installed.");
      const row = { folder, preview, revision, sourceFolder: path, enabled: options?.enabled !== false, bots: "all", installedAt: Date.now(), refs: {}, reading: READING };
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
  /**
   * A yes that names the revision it was given for. The compare is made inside the queue, so an
   * update that is under way finishes first, and the old yes is not used for the new version.
   * `options` is nothing, or { revision } with a revision as a 64-character hash.
   */
  lookedAt(row, options) {
    if (options === undefined || options === null) return;
    const plain = typeof options === "object" && !Array.isArray(options) && [Object.prototype, null].includes(Object.getPrototypeOf(options));
    if (!plain || (options.revision !== undefined && (typeof options.revision !== "string" || !/^[a-f0-9]{64}$/.test(options.revision)))) throw new Error("Check the plugin request.");
    if (options.revision !== undefined && options.revision !== (row.revision ?? basename(row.folder)))
      throw new Error("This plugin is not the one that was looked at: its revision is another one now. Look at it again.");
  }
  setBots(id, bots, options) {
    return this.serialize(() => {
      const row = this.get(id);
      this.lookedAt(row, options);
      this.save({ ...row, bots: this.scope(bots) });
    });
  }
  setEnabled(id, enabled, options, verify) {
    return this.serialize(() => {
      verify?.();
      if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
      const before = this.get(id);
      this.lookedAt(before, options);
      // (A switch by the person, on or off, is their own choice: the note about what nobody was shown is done with.)
      const { heldBack: _old, note: _reason, ...row } = before;
      let fresh;
      if (enabled && row.reading !== READING) {
        // The copy is checked before it is read. (A copy that is gone is "could not be read", below.)
        if (existsSync(row.folder)) this.assertIntact(row);
        // A copy that could not be read at the start is read again now, not from what was kept.
        this.descriptions.delete(row.folder);
        fresh = this.described(row);
        if (!fresh) throw new Error(UNREAD_COPY);
        // (The description is fresh now, so the start does not look at this row again.)
        row.reading = READING;
        row.preview = this.refreshed(row.preview, fresh);
      }
      // The one refusal of a switch-on: the installed files are not the reviewed ones. A switch-on with no revision is not
      // refused (see NOTES for the rule): the window, the phone and the command line warn before it, each in its own way,
      // and a revision that is named is compared (lookedAt, above).
      if (enabled) this.assertIntact(row);
      this.save({ ...row, enabled });
    });
  }
  update(id, options = {}, verify) {
    return this.serialize(async () => {
      verify?.();
      this.reviewed(options);
      const before = this.get(id);
      // The way back that a client offers is an update. Where the update cannot work either, the person is told the next step.
      const repairing = this.checked.get(before.folder)?.ok === false || this.unreadable.has(before.folder) || before.note === "unread";
      let material;
      try {
        material = await this.catalog.materialize(id, options.revision);
      } catch (error) {
        // (Not for the catalog's refusal of a revision that is another one now: there the step is to look again.
        // That error is told by a stable part of its text.)
        if (repairing && !REVISION_CHANGED.test(String(error?.message ?? error))) throw new Error(String(error?.message ?? error) + " If the plugin cannot be updated, remove it.");
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
      // (A plugin whose files could not be read has files that can be read now: that note, and the mark that an update is
      // the way back, are done with. It stays on or off as the person has it.)
      const { heldBack: _old, note, ...kept } = before;
      const row = { ...kept, ...(note && note !== "unread" && { note }), folder: material.folder, revision: material.revision, preview: material.preview, refs, reading: READING };
      const previousServers = this.knownOAuthServers(before);
      // The folder is the same one when the source did not change. The files were written again,
      // so what was cached about the old files is dropped and the copy is checked again.
      for (const cache of [this.checked, this.descriptions, this.oauthSchemas]) cache.delete(row.folder);
      this.assertIntact(row);
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
      this.unreadable.delete(row.folder);
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
  /** The address the browser was sent back to, for a sign-in a terminal host started (oauth.answer). */
  answerSignIn(id, address) {
    this.oauth.answer(id, address);
  }
  /**
   * The tool of a plugin that signs in, for a sign-in to start: the tool's address and client id are read from the
   * copy's files, so the copy is checked first, as a switch-on and a session check it (assertIntact). Every way in
   * to a plugin's sign-in (the window, a phone, the command line) goes through this.
   */
  signInServer(id) {
    for (const row of this.records) {
      const server = this.knownOAuthServers(row).find((entry) => entry.id === id);
      if (!server) continue;
      this.assertIntact(row);
      return server;
    }
    throw new Error("This plugin sign-in is unavailable.");
  }
  async signIn(id, { open, patience, finished, followed, redirect } = {}) {
    const server = this.signInServer(id);
    await this.oauth.signIn(server, { client: server.clientId ? { clientId: server.clientId } : undefined, ...(open && { open }), ...(patience && { patience }), ...(finished && { finished }), ...(followed && { followed }), ...(redirect && { redirect }) });
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
  /** The count of blocks of the chat's turn, made when there is none. At most 500 chats are kept: the one used longest ago is dropped. */
  stopsFor(chatId) {
    const stops = this.stops.get(chatId) ?? newStops();
    this.stops.delete(chatId);
    this.stops.set(chatId, stops);
    if (this.stops.size > 500) this.stops.delete(this.stops.keys().next().value);
    return stops;
  }
  /** A new turn starts in this chat (not a retry of one that runs): the plugins' blocks are counted again from none. */
  turnStarted(chatId) {
    const stops = this.stops.get(chatId);
    if (!stops) return;
    stops.plugins.clear();
    Object.assign(stops, { total: 0, toldTotal: false });
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
    return pluginSession(plugins, { dir: this.ws.dir, botId: bot.id, chatId: chat.id, skillsOnly, note: (line) => this.ws.pluginNote?.(chat.id, line), stops: this.stopsFor(chat.id) });
  }
}
