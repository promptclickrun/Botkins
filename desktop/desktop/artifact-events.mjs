import { lstatSync, opendirSync, watch } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileDetails, absoluteFilePath } from "./artifact-files.mjs";
import { toolKind } from "./canvas.mjs";
import { memberSessionId } from "./groups.mjs";
import { helperSessionId } from "./teamwork.mjs";
import { findPathSpans } from "./path-detector.mjs";

const contained = (root, path) => {
  const r = relative(root, path);
  return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};

// Some hosts coalesce or omit watcher notifications. Check recent writes in
// the working tree when a shell command ends. Bound work on large checkouts;
// the live watcher continues to supply paths beyond this scan.
function recentWrites(job) {
  const root = fileDetails(job.folder);
  if (root?.kind !== "folder") return;
  const queue = [root.path];
  let remaining = 5000;
  for (let i = 0; i < queue.length && remaining > 0; i++) {
    let directory;
    try {
      directory = opendirSync(queue[i]);
      for (let entry; remaining > 0 && (entry = directory.readSync()); ) {
        remaining--;
        const path = join(queue[i], entry.name);
        if (entry.isDirectory()) {
          if (![".git", "node_modules"].includes(entry.name)) queue.push(path);
        } else if (entry.isFile()) {
          const stat = lstatSync(path, { throwIfNoEntry: false });
          if (stat && stat.ctimeMs >= job.started && Math.floor(stat.ctimeMs) <= job.finished) job.outputs.add(path);
        }
      }
    } catch { /* A tool can remove or rename a folder during the scan. */ }
    finally { directory?.closeSync(); }
  }
}

// Native write/edit tools identify their outputs. Never trust a read tool's
// arguments or arbitrary prose in stdout as evidence that a file was created.
function destinations(name, args) {
  const kind = toolKind(name);
  if (!["write", "edit"].includes(kind) && !/^(multiedit|edit_file|writefile|create_directory|mkdir|notebookedit)$/i.test(name)) return [];
  if (["view", "undo_edit"].includes(args?.command)) return [];
  const paths = [args?.path, args?.file_path, args?.filePath, args?.filename, args?.destination, args?.notebook_path];
  for (const change of Array.isArray(args?.changes) ? args.changes : []) if (change?.kind !== "delete") paths.push(change?.path);
  const patch = typeof args === "string" ? args : args?.patchText ?? args?.patch ?? args?.input;
  if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) paths.push(match[1].trimEnd());
  return [...new Set(paths.filter((p) => typeof p === "string" && !!p))];
}

/**
 * The file a written attachment names, or null: a full path, or a name in the bot's own folder
 * ("chart.png", where its tools write by default). Only a file that is there counts.
 */
function mediaFile(raw, folder) {
  const name = raw.replace(/[.,;:!?)\]}>]+$/, "");
  if (!name || name.includes("://")) return null;
  const relative = !isAbsolute(name) && !name.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(name);
  const path = relative ? resolve(folder, name) : name;
  if (relative && !contained(folder, path)) return null;
  const found = fileDetails(path);
  return found && found.kind !== "folder" ? { path: relative ? path : name, rest: raw.slice(name.length) } : null;
}

/**
 * The ways a model writes an attachment that the apps would not show, written the one way they do
 * ("MEDIA: /full/path"), only where the file is there:
 * - a relative path: "MEDIA: chart.png" (a name in the bot's own folder),
 * - the whole line in backticks: "`MEDIA: /a/chart.png`",
 * - a bold or lowercase label: "**MEDIA:** /a/chart.png", "media: /a/chart.png",
 * - a Markdown image of a file here: "![chart](/a/chart.png)" (a web address stays as it is).
 * Code blocks are left alone. Which files may then be shown is still decided by `messages`.
 */
export function normalizeMedia(text, folder) {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      let out = line.replace(/`\s*MEDIA:\s?([^`\s]+)\s*`/gi, (whole, raw) => {
        const file = mediaFile(raw, folder);
        return file ? "MEDIA: " + file.path + file.rest : whole;
      });
      // "MEDIA:" anywhere in a line; a bold or lowercase label only where a line starts (after a list or quote mark), so prose ("social media: …") stays prose.
      out = out.replace(/(^|[\s([{<"'“‘])MEDIA:([ ]?)([`"']?)([^\s`"']+)\3/g, (whole, before, space, quote, raw) => {
        const file = mediaFile(raw, folder);
        return file ? before + "MEDIA:" + (space || " ") + quote + file.path + quote + file.rest : whole;
      });
      out = out.replace(/^(\s*(?:[-*+]|\d+[.)]|>)?\s*)(\*\*|__)?media:(\*\*|__)?[ ]?([`"']?)([^\s`"']+)\4/i, (whole, lead, open, close, quote, raw) => {
        if ((open || "") !== (close || "") || (!open && whole.slice(lead.length, lead.length + 6) === "MEDIA:")) return whole;
        const file = mediaFile(raw, folder);
        return file ? lead + "MEDIA: " + quote + file.path + quote + file.rest : whole;
      });
      out = out.replace(/!\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (whole, raw) => {
        const file = mediaFile(raw, folder);
        return file ? "MEDIA: " + file.path : whole;
      });
      return out;
    })
    .join("\n");
}

/** Raised when the rule for which `MEDIA:` files are a bot's own widens, so old messages are read once more. */
// 2: loosely written attachments in the bot's own folder count (normalizeMedia).
const MEDIA_PASS = 2;

export class ArtifactEvents {
  constructor(ws) {
    this.ws = ws;
    this.counts = new WeakMap();
    this.pending = new Map();
    this.watchers = new Map();
  }
  folder(chat, botId) { return this.ws.projects.folderFor(chat) || join(this.ws.dir, "files", botId); }
  /**
   * The folders that are a bot's own in one chat: the chat's project folder (or the bot's files
   * folder), and the folder that the model's runtime gives that chat's own session for its files.
   * A bot that names no place writes its pictures into the second one. It is one chat's folder:
   * another chat's session, or anything else on the computer, is not in it.
   */
  roots(chat, botId) {
    const sessions = [chat.sessionId ?? chat.id, memberSessionId(chat, botId), helperSessionId(chat, botId)];
    const folders = [this.folder(chat, botId), ...sessions.flatMap((id) => this.ws.providers.sessionFolders(id))];
    return folders.map((folder) => fileDetails(folder)).filter((found) => found?.kind === "folder").map((found) => found.path);
  }

  restore(indexed) {
    if (indexed) {
      // Once more over what was already said, the first time after a rule for `MEDIA:` lines
      // widened: a picture that an earlier version did not take as the bot's own (it was in the
      // session's own folder) is found now. Recording is safe to repeat.
      const again = this.ws.state.mediaPass !== MEDIA_PASS;
      for (const chat of this.ws.state.chats) this.counts.set(chat.messages, again ? 0 : chat.messages.length);
      if (again) this.ws.artifacts.batch(() => void this.ws.state.chats.forEach((chat) => this.messages(chat)));
      this.ws.state.mediaPass = MEDIA_PASS;
      return;
    }
    this.ws.state.mediaPass = MEDIA_PASS;
    this.ws.artifacts.batch(() => {
      this.history();
      for (const chat of this.ws.state.chats) this.messages(chat);
    });
  }

  messages(chat) {
    const start = this.counts.get(chat.messages) ?? 0;
    // A piece of a reply whose turn still runs is read again once the turn ends: finishReply compares
    // those pieces with the final text, so they are not rewritten before then. Recording is safe to repeat.
    let done = chat.messages.length;
    for (let index = start; index < chat.messages.length; index++) {
      const message = chat.messages[index];
      const writing = message.interim && message.role === "assistant" && this.ws.state.runs.some((run) => run.id === message.runId && run.status === "Working");
      if (writing) done = Math.min(done, index);
      const botIds = message.botId ? [message.botId] : message.role === "user" ? chat.botIds ?? [chat.botId] : [chat.botId];
      if (!writing && message.role === "assistant" && message.text && /media:|!\[/i.test(message.text)) message.text = normalizeMedia(message.text, this.folder(chat, botIds[0]));
      for (const botId of botIds) {
        const context = { botId, chatId: chat.id, messageIndex: index, time: message.time ?? this.ws.state.runs.find((r) => r.id === message.runId)?.time ?? chat.time ?? 0 };
        for (const file of message.attachments ?? []) this.ws.artifacts.record(file.path, { ...context, source: message.role === "user" ? "upload" : "media" });
        if (message.role !== "assistant" || !message.text?.includes("MEDIA:")) continue;
        const roots = this.roots(chat, botId);
        for (const { path, media } of findPathSpans(message.text)) {
          if (!media) continue;
          const file = fileDetails(path);
          // Prose cannot grant remote access to an unrelated host path. Files outside
          // the bot's own folders for this chat (its project or files folder, and the chat's
          // session folder) need independent provenance from an upload or write.
          if (file && file.kind !== "folder" && (roots.some((root) => contained(root, file.path)) || this.ws.artifacts.rows.some((r) => r.botId === botId && r.path === file.path && r.identity === file.identity))) {
            this.ws.artifacts.record(file.path, { ...context, source: "media" });
          }
        }
      }
    }
    this.counts.set(chat.messages, done);
  }

  // Recover observable outputs of successful structured writes in pre-index workspaces.
  history() {
    for (const run of this.ws.state.runs) {
      const chat = this.ws.state.chats.find((c) => c.id === run.chatId);
      if (!chat) continue;
      for (const step of run.steps ?? []) {
        if (step.status !== "Done" || !step.input) continue;
        let args;
        try { args = JSON.parse(step.input); } catch { continue; }
        const botId = step.botId || chat.botId;
        const root = this.folder(chat, botId);
        for (const path of destinations(step.name, args)) this.record(chat, botId, run, root, path, step.finished ?? run.time, true);
      }
    }
  }

  record(chat, botId, run, folder, raw, time, scoped = false) {
    const path = absoluteFilePath(raw) ?? (!isAbsolute(raw) && resolve(folder, raw));
    if (!path) return;
    const target = fileDetails(path);
    if (!target) return;
    if (scoped || target.kind === "folder") {
      const root = fileDetails(folder)?.path;
      if (!root || !contained(root, target.path) || (target.kind === "folder" && root === target.path)) return;
    }
    const messageIndex = chat.messages.findIndex((m) => m.role === "user" && m.runId === run.id);
    this.ws.artifacts.record(path, { botId, chatId: chat.id, source: "tool", ...(messageIndex >= 0 && { messageIndex }), time });
  }

  // Shell tools don't supply a written-file list. Observe their working directory
  // during execution. Overlapping commands in the same folder aren't attributable.
  watchShell(job) {
    const root = fileDetails(job.folder)?.path;
    if (!root) return;
    let group = this.watchers.get(root);
    if (!group) {
      const jobs = new Set();
      const changed = (_event, name) => {
        if (typeof name !== "string" || name.split(/[\\/]/).some((part) => part === ".git" || part === "node_modules")) return;
        const path = resolve(root, name);
        if (!contained(root, path)) return;
        let stat;
        try { stat = lstatSync(path); } catch { return; }
        if (!stat.isFile()) return;
        const modified = Math.floor(stat.mtimeMs);
        const candidates = [...jobs].filter((j) => j.started <= modified && (!j.finished || modified <= j.finished));
        if (candidates.length !== 1) return;
        const job = candidates[0];
        if (job.finished) job.publish(path);
        else job.outputs.add(path);
      };
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, changed);
        watcher.on("error", () => watcher.close());
        group = { jobs, watcher };
        this.watchers.set(root, group);
      } catch { return; }
    }
    for (const active of group.jobs) if (!active.finished) active.overlap = job.overlap = true;
    group.jobs.add(job);
    job.unwatch = () => {
      group.jobs.delete(job);
      if (!group.jobs.size) { group.watcher.close(); this.watchers.delete(root); }
    };
  }

  tool(chat, botId, run, event, helper) {
    if (!["tool.execution_start", "tool.execution_complete"].includes(event.type) || !event.data?.toolCallId) return;
    const data = event.data;
    const key = JSON.stringify([run.id, botId, helper?.id, data.toolCallId]);
    if (event.type === "tool.execution_start") {
      if (this.pending.has(key)) return;
      const name = data.mcpToolName || data.toolName;
      const shell = !data.mcpServerName && toolKind(name) === "command";
      const paths = destinations(name, data.arguments);
      if (!paths.length && !shell) return;
      const job = { folder: this.folder(chat, helper?.botId ?? botId), runId: run.id, started: Date.now(), shell, paths, outputs: new Set(), scoped: !!data.mcpServerName };
      this.pending.set(key, job);
      if (shell) this.watchShell(job);
    } else {
      const job = this.pending.get(key);
      if (!job) return;
      this.pending.delete(key);
      if (!data.success) { job.unwatch?.(); return; }
      const at = Date.now();
      job.finished = at;
      if (job.shell && !job.overlap) recentWrites(job);
      if (job.unwatch) {
        // Filesystem notifications can arrive after the provider reports completion.
        // Accept late deliveries only for writes within this command's lifetime.
        job.publish = (path) => {
          if (fileDetails(path)?.path !== path) return;
          try {
            const before = this.ws.artifacts.revision;
            this.record(chat, botId, run, job.folder, path, at, true);
            if (this.ws.artifacts.revision !== before) this.ws.notify();
          } catch (error) { console.error("Could not index a tool output:", error.message); }
        };
        setTimeout(job.unwatch, 1500).unref();
      }
      this.ws.artifacts.batch(() => {
        for (const path of job.paths) this.record(chat, botId, run, job.folder, path, at, job.scoped);
        for (const path of job.outputs) {
          const info = fileDetails(path);
          if (info && info.kind !== "folder" && info.path === path) this.record(chat, botId, run, job.folder, path, at);
        }
      });
    }
  }

  end(runId) {
    for (const [key, job] of this.pending) if (job.runId === runId) {
      job.unwatch?.();
      this.pending.delete(key);
    }
  }
}
