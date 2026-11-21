import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { absoluteFilePath, chunk, fileDetails, publicFile, thumbnail } from "./artifact-files.mjs";
import { safeName } from "./link/uploads.mjs";

const pageSize = 50;
const unavailable = () => new Error("This artifact is unavailable.");
const asKey = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fromKey = (token) => JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
const belongs = (chat, botId) => chat.botId === botId || chat.botIds?.includes(botId);
const media = (item) => ["image", "video", "audio"].includes(item.kind);
const byTime = (a, b) => b.time - a.time || a.id.localeCompare(b.id);
const beneath = (base, path) => {
  const rel = relative(base, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};

export class Artifacts {
  constructor(workspace) {
    this.ws = workspace;
    this.file = join(workspace.dir, "artifacts.json");
    this.revision = 0;
    this.rows = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
  }

  save() {
    if (this.collecting) { this.changed = true; return; }
    writeFileSync(this.file + ".tmp", JSON.stringify(this.rows), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
    this.revision++;
  }

  batch(fn) {
    if (this.collecting) return fn();
    this.collecting = true;
    try { return fn(); }
    finally {
      this.collecting = false;
      if (this.changed) { this.save(); this.changed = false; }
    }
  }

  chat(id) { return this.ws.state.chats.find((chat) => chat.id === id); }

  // A phone export returns bytes rather than a host file. Keep the generated
  // document by content so that repeated exports can reuse the same copy.
  exported(file, botId = this.ws.state.bots[0]?.id) {
    if (!botId) return file;
    const bytes = typeof file.text === "string" ? Buffer.from(file.text) : Buffer.from(file.base64, "base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const base = join(fileDetails(this.ws.dir).path, "artifact-exports");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (fileDetails(base)?.path !== base) throw unavailable();
    const folder = join(base, digest);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (fileDetails(folder)?.path !== folder) throw unavailable();
    const path = join(folder, safeName(file.name));
    try { writeFileSync(path, bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = fileDetails(path);
      if (!previous || previous.path !== path || previous.size !== bytes.length || !readFileSync(path).equals(bytes)) throw new Error("The saved export changed.");
    }
    this.record(path, { botId, source: "export" });
    this.ws.notify();
    return file;
  }

  record(path, { botId, chatId, messageIndex, source, time = Date.now() }) {
    const info = fileDetails(path);
    if (!info || !this.ws.state.bots.some((bot) => bot.id === botId)) return null;
    const chat = chatId && this.chat(chatId);
    if (chatId && (!chat || !belongs(chat, botId))) return null;
    let row = this.rows.find((r) => r.path === info.path && r.botId === botId && r.chatId === chatId && r.source === source && r.messageIndex === messageIndex);
    if (row && row.identity === info.identity && row.time === time) return this.describe(row, info);
    if (!row) {
      row = { id: randomUUID(), botId, ...(chatId && { chatId }), ...(Number.isInteger(messageIndex) && { messageIndex }), source };
      this.rows.push(row);
    }
    Object.assign(row, { ...publicFile(info), identity: info.identity, time });
    this.save();
    return this.describe(row, info);
  }

  describe(row, info) {
    const chat = row.chatId && this.chat(row.chatId);
    const { identity, ...meta } = row;
    return { ...meta, ...(chat && { chatTitle: chat.title }), ...publicFile(info) };
  }

  root(row) {
    if (!row || !this.ws.state.bots.some((bot) => bot.id === row.botId) || (row.chatId && !this.chat(row.chatId))) return null;
    const info = fileDetails(row.path);
    if (!info || info.path !== row.path) return null;
    if (info.identity !== row.identity) {
      // Editors often replace a document with a temporary file on save. A new
      // directory or a hard link to another file needs separate provenance.
      if (!row.kind || row.kind === "folder" || info.kind === "folder" || info.links !== 1) return null;
    }
    return { info, artifact: this.describe(row, info) };
  }

  child(row, path) {
    const root = this.root(row);
    if (root?.info.kind !== "folder" || !beneath(row.path, path)) return null;
    const info = fileDetails(path);
    // A symlink in any directory component cannot extend a shared folder.
    if (!info || info.path !== path) return null;
    const relativePath = relative(row.path, path);
    const artifact = { ...this.describe(row, info), id: "child:" + asKey([row.id, relativePath]) };
    return { info, artifact };
  }

  entry(id, allowed = this.rows, chatId) {
    if (typeof id !== "string" || id.length > 4096) return null;
    if (id.startsWith("child:")) {
      try {
        const [base, child] = fromKey(id.slice(6));
        const row = allowed.find((r) => r.id === base);
        if (row && typeof child === "string" && !isAbsolute(child) && !child.split(/[\\/]/).includes("..")) return this.child(row, join(row.path, child));
      } catch { /* Invalid or stale id. */ }
      return null;
    }
    const path = absoluteFilePath(id);
    const exact = allowed.filter((r) => r.id === id || (path && r.path === path)).sort((a, b) =>
      (chatId ? Number(b.chatId === chatId) - Number(a.chatId === chatId) : 0) || byTime(a, b));
    for (const row of exact) {
      const found = this.root(row);
      if (found) return found;
    }
    if (path) {
      // macOS exposes /var and /tmp through system aliases. Match the canonical
      // spelling only after checking existence and the shared folder's bounds.
      const canonical = fileDetails(path)?.path;
      if (canonical && canonical !== path) {
        const row = allowed.find((r) => r.path === canonical);
        if (row) return this.root(row);
      }
      for (const row of allowed) {
        if (beneath(row.path, path)) {
          const entry = this.child(row, path);
          if (entry) return entry;
        }
      }
    }
    return null;
  }

  /**
   * A test for whether an id still names something in the index: (id) => boolean. It reads no
   * file, so it is cheap enough for every snapshot; `entry` is the check that looks at the disk.
   */
  known() {
    const ids = new Set(this.rows.map((row) => row.id));
    return (id) => {
      if (typeof id !== "string") return false;
      if (!id.startsWith("child:")) return ids.has(id);
      try { return ids.has(fromKey(id.slice(6))[0]); }
      catch { return false; }
    };
  }

  list({ botId, chatId, kind, folder, cursor } = {}) {
    if (typeof botId !== "string" || (kind !== undefined && !["files", "media"].includes(kind))) throw new Error("Choose a bot and a valid filter.");
    const allowed = this.rows.filter((r) => r.botId === botId && (!chatId || r.chatId === chatId));
    const items = [];
    if (folder) {
      const parent = this.entry(folder, allowed);
      if (parent?.info.kind !== "folder") throw unavailable();
      const id = parent.artifact.id;
      const rootId = id.startsWith("child:") ? fromKey(id.slice(6))[0] : id;
      const row = allowed.find((r) => r.id === rootId);
      for (const dirent of readdirSync(parent.info.path, { withFileTypes: true })) {
        if (!dirent.isFile() && !dirent.isDirectory()) continue;
        const item = this.child(row, join(parent.info.path, dirent.name));
        if (item) items.push(item.artifact);
      }
    } else {
      const gone = new Set();
      for (const row of allowed) {
        const found = this.root(row);
        if (found) items.push(found.artifact);
        else gone.add(row.id);
      }
      if (gone.size) {
        this.rows = this.rows.filter((r) => !gone.has(r.id));
        this.save();
      }
    }
    let after;
    const scope = [botId, chatId || "", kind || "", folder || ""];
    if (cursor) {
      try {
        const [key, time, id] = fromKey(cursor);
        if (JSON.stringify(key) !== JSON.stringify(scope) || !Number.isFinite(time) || typeof id !== "string") throw new Error();
        after = { time, id };
      } catch { throw new Error("Invalid artifact cursor."); }
    }
    const sorted = items.filter((item) => (!kind || media(item) === (kind === "media")) && (!after || byTime(item, after) > 0)).sort(byTime);
    const page = sorted.slice(0, pageSize);
    const last = page.at(-1);
    return { items: page, nextCursor: sorted.length > pageSize ? asKey([scope, last.time, last.id]) : null };
  }

  read(id, options) {
    const entry = this.entry(id);
    if (!entry) throw unavailable();
    return chunk(entry.info, entry.artifact, options);
  }

  thumbnail(id, options, nativeImage) {
    const entry = this.entry(id);
    return entry ? thumbnail(entry.info, options?.size ?? 160, nativeImage) : null;
  }

  resolve({ chatId, paths }) {
    const chat = this.chat(chatId);
    if (!chat || !Array.isArray(paths) || paths.length < 1 || paths.length > 20) throw new Error("Choose a chat and up to 20 paths.");
    const allowed = this.rows.filter((r) => belongs(chat, r.botId)).sort((a, b) => Number(b.chatId === chatId) - Number(a.chatId === chatId) || byTime(a, b));
    return { items: paths.map((path) => this.entry(path, allowed, chatId)?.artifact ?? null) };
  }
}
