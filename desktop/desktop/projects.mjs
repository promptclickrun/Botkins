// Projects: workspaces with chats, Today panels and a to-do list.
// A project with a folder is a coding project too: its git changes are Bighelp's Project Changes.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { textField } from "./panels.mjs";
import { isGroup } from "./groups.mjs";
import { defineTool } from "./providers/provider.mjs";
import { assertProject, canUseProject } from "./access.mjs";

import { changedFolders, folderFor, MAX_PROJECT_FOLDERS } from "./link/project-folders.mjs";

const run = promisify(execFile);
export const MODES = ["default", "plan", "yolo"];
/** A project keeps a list of artifacts a person attached to it (`addProjectArtifact`, `removeProjectArtifact`, `projectArtifacts`). */
export const PROJECT_ARTIFACTS = "project-artifacts-v1";
export const MAX_PROJECT_ARTIFACTS = 200;
/** The calls a paired device needs before the capability means anything to it. */
export const PROJECT_ARTIFACT_CALLS = ["addProjectArtifact", "removeProjectArtifact", "projectArtifacts"];
const MAX_DIFF = 400_000;

// A repository's own config could otherwise run programs when Botkins reads it: fsmonitor, hooks,
// external diff and textconv drivers, filter drivers and signing. Botkins turns all of them off.
const SAFE = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=" + devNull,
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "commit.gpgSign=false",
  "-c", "credential.helper=",
];
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };

async function raw(cwd, args) {
  return run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 20000, env: ENV });
}
/** Overrides every filter driver the repository's config names, so reading status runs none of them. */
async function filterOverrides(cwd) {
  let out = "";
  try {
    out = (await raw(cwd, ["config", "--null", "--get-regexp", "^filter\\."])).stdout;
  } catch {}
  const names = new Set();
  for (const entry of out.split("\0")) {
    const m = /^filter\.(.+)\.[^.\n]+\n/s.exec(entry);
    if (m) names.add(m[1]);
  }
  return [...names].flatMap((n) => ["-c", `filter.${n}.clean=cat`, "-c", `filter.${n}.smudge=cat`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`]);
}
async function git(cwd, args, { allowFail = false, differences = false } = {}) {
  try {
    const { stdout } = await raw(cwd, [...SAFE, ...(await filterOverrides(cwd)), ...args]);
    return stdout;
  } catch (error) {
    // `git diff --no-index` exits 1 when the files differ; that is its normal answer.
    if (differences && error.code === 1 && typeof error.stdout === "string") return error.stdout;
    // A diff longer than the buffer still shows its beginning.
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && typeof error.stdout === "string") return error.stdout;
    if (allowFail) return null;
    throw new Error((error.stderr || error.message || "git failed").toString().trim().split("\n").at(-1));
  }
}

/** Parses `git status --porcelain=v1 -b -z` output. */
export function parseStatus(text) {
  const parts = text.split("\0").filter(Boolean);
  const head = { branch: "", upstream: "", ahead: 0, behind: 0 };
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.startsWith("## ")) {
      const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?(?:gone)?\])?$/.exec(entry);
      if (m) Object.assign(head, { branch: m[1], upstream: m[2] ?? "", ahead: Number(m[3] ?? 0), behind: Number(m[4] ?? 0) });
      continue;
    }
    const x = entry[0], y = entry[1], path = entry.slice(3);
    const file = { path, staged: x !== " " && x !== "?", kind: "modified" };
    if (x === "?" && y === "?") file.kind = "untracked";
    else if (x === "A" || y === "A") file.kind = "added";
    else if (x === "D" || y === "D") file.kind = "deleted";
    else if (x === "R" || y === "R") {
      file.kind = "renamed";
      file.from = parts[++i];
    }
    files.push(file);
  }
  return { ...head, files };
}

const MAX_TODOS = 500;
function restart(chat) {
  for (const fork of Object.values(chat.savedForks ?? {})) restart(fork);
  if (chat.established || chat.messages?.length) chat.restartSession = true;
  for (const session of [...Object.values(chat.members ?? {}), ...Object.values(chat.helpers ?? {})])
    if (session.established) session.restartSession = true;
}

export const PROJECT_COLORS = ["coral", "amber", "green", "teal", "blue", "violet", "pink", "gray"];

function todoText(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500)
    throw new Error("Use 1 to 500 characters for a to-do.");
  return value.trim();
}
function descriptionField(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > 2000) throw new Error("Use up to 2,000 characters for the description.");
  return value.trim();
}
function folderField(value) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory())
    throw new Error("Choose a folder for the project.");
  return resolve(value);
}

/** Brings a project saved before workspaces (`{id, name, path, lastUsed}`) up to the current shape. */
export function migrateProject(p) {
  if (p.path && !p.folder) p.folder = p.path;
  delete p.path;
  p.description ??= "";
  if (!Array.isArray(p.todos)) p.todos = [];
  p.lastUsed ??= Date.now();
  p.createdAt ??= p.lastUsed;
  const paths = Array.isArray(p.folders) ? p.folders : [p.folder];
  p.folders = [...new Set(paths.filter((f) => typeof f === "string" && isAbsolute(f)).map((f) => resolve(f)))].slice(0, MAX_PROJECT_FOLDERS);
  if (p.mode !== "plan" && p.mode !== "yolo") delete p.mode;
  p.folder = p.folders[0];
  if (!p.folder) delete p.folder;
  if (Array.isArray(p.artifacts)) p.artifacts = [...new Set(p.artifacts.filter((id) => typeof id === "string"))].slice(0, MAX_PROJECT_ARTIFACTS);
  if (!p.artifacts?.length) delete p.artifacts;
  return p;
}

/**
 * Projects are workspaces with chats, Today panels and a to-do list. A project with a folder is
 * also a coding project: its chats run in the folder with Default, Plan and YOLO modes, and
 * Project Changes reads its git repository.
 */
export class Projects {
  constructor(ws) {
    this.ws = ws;
    ws.state.projects ??= [];
    for (const p of ws.state.projects) migrateProject(p);
  }
  get all() {
    return this.ws.state.projects;
  }
  get(id) {
    const project = this.all.find((p) => p.id === id);
    if (!project) throw new Error("Unknown project");
    return project;
  }
  /** A project's folder, which must still exist. For Project Changes and Reveal. */
  folderOf(id, folder) {
    const project = this.get(id);
    if (!project.folder) throw new Error("“" + project.name + "” has no folder. Choose one in its Overview.");
    folder ??= project.folder;
    if (!project.folders.includes(folder)) throw new Error("Choose a folder in this project.");
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error("This project's folder is missing: " + folder);
    return folder;
  }
  /** Creates a project. Returns its id. */
  create(data = {}) {
    const now = Date.now();
    const folder = folderField(data.folder);
    const project = {
      id: randomUUID(),
      name: textField(data.name ?? (folder ? basename(folder) : ""), 60, "project name"),
      description: descriptionField(data.description),
      ...(PROJECT_COLORS.includes(data.color) && { color: data.color }),
      folders: folder ? [folder] : [],
      ...(folder && { folder }),
      todos: [],
      lastUsed: now,
      createdAt: now,
    };
    this.all.unshift(project);
    this.ws.save();
    return project.id;
  }
  /** "Add folder…": a coding project for a folder, reusing the one already made for it. */
  add(path, name) {
    const folder = folderField(path);
    if (!folder) throw new Error("Choose a folder for the project.");
    const existing = this.all.find((p) => p.folder === folder);
    if (existing) return existing.id;
    return this.create({ name: name ?? basename(folder), folder });
  }
  editFolder(id, action, path) {
    const p = this.get(id);
    if (action === "add") path = folderField(path);
    if (!path) throw new Error("Choose a folder for the project.");
    const folders = changedFolders(p.folders, action, path);
    this.applyFolders(p, folders);
    this.ws.save();
    return p.folders;
  }
  applyFolders(p, folders) {
    const chats = this.chats(p.id);
    if (chats.some((c) => this.ws.active.has(c.id))) throw new Error("Wait for this project's chats to finish before changing its folder.");
    if (folders.length && chats.some(isGroup)) throw new Error("Group chats take text only. Move them before adding a folder.");
    for (const c of chats) {
      const before = c.folder ?? p.folder;
      if (!folders.includes(c.folder) || c.folder === folders[0]) delete c.folder;
      if (before !== (c.folder ?? folders[0])) restart(c);
      if (!folders.length) c.mode = "default";
    }
    p.folders = folders;
    if (folders.length) p.folder = folders[0];
    else delete p.folder;
  }
  /** A legacy folder edit replaces (or removes) the first folder and preserves its siblings. */
  update(id, patch = {}) {
    const p = this.get(id);
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "name") next.name = textField(value, 60, "project name");
      else if (key === "description") next.description = descriptionField(value);
      else if (key === "color") {
        if (value != null && !PROJECT_COLORS.includes(value)) throw new Error("Unknown project color");
        next.color = value ?? undefined;
      } else if (key === "mode") {
        if (!MODES.includes(value)) throw new Error("Use default, plan or yolo.");
        next.mode = value === "default" ? undefined : value;
      } else if (key === "folder") next.folder = folderField(value);
      else throw new Error("Unknown project field");
    }
    if ("folder" in next) {
      const rest = p.folders.slice(1).filter((f) => f !== next.folder);
      this.applyFolders(p, next.folder ? [next.folder, ...rest] : rest);
      delete next.folder;
    }
    Object.assign(p, next);
    for (const key of Object.keys(next)) if (next[key] === undefined) delete p[key];
    this.ws.save();
  }
  rename(id, name) {
    this.update(id, { name });
  }
  remove(id) {
    this.get(id);
    if (this.chats(id).some((c) => this.ws.active.has(c.id))) throw new Error("Wait for this project's chats to finish.");
    this.ws.state.projects = this.all.filter((p) => p.id !== id);
    for (const chat of this.ws.state.chats)
      if (chat.projectId === id) {
        restart(chat);
        delete chat.folder;
        delete chat.projectId;
        chat.mode = "default";
      }
    for (const panel of this.ws.state.panels ?? []) if (panel.projectId === id) delete panel.projectId;
    for (const bot of this.ws.state.bots)
      if (bot.access?.projects) bot.access.projects = bot.access.projects.filter((p) => p !== id);
    this.ws.save();
  }
  /**
   * Attaches an artifact to a project: a list on the project, newest first. It changes nothing
   * about the artifact and gives a bot nothing new. One that is already there moves to the
   * front. Returns the project's list as it is afterwards.
   */
  addArtifact(projectId, artifactId) {
    const p = this.get(projectId);
    const found = typeof artifactId === "string" ? this.ws.artifacts.entry(artifactId) : null;
    if (!found) throw new Error("This artifact no longer exists.");
    const id = found.artifact.id;
    const rest = this.attached(p).filter((other) => other !== id);
    if (rest.length >= MAX_PROJECT_ARTIFACTS) throw new Error("A project holds up to " + MAX_PROJECT_ARTIFACTS + " artifacts. Remove one first.");
    p.artifacts = [id, ...rest];
    this.ws.save();
    return [...p.artifacts];
  }
  /** Takes an artifact off a project. One that is not attached is no error. Returns the list afterwards. */
  removeArtifact(projectId, artifactId) {
    const p = this.get(projectId);
    const before = p.artifacts ?? [];
    const rest = this.attached(p).filter((id) => id !== artifactId);
    if (rest.length !== before.length) {
      if (rest.length) p.artifacts = rest;
      else delete p.artifacts;
      this.ws.save();
    }
    return rest;
  }
  /**
   * A project's artifacts as they are now, newest attached first: { items: Artifact[] }. One whose
   * file or bot is gone drops out, and the stored list is cleaned of it.
   */
  artifacts(projectId) {
    const p = this.get(projectId);
    const before = p.artifacts ?? [];
    const items = before.map((id) => this.ws.artifacts.entry(id)?.artifact).filter(Boolean);
    if (items.length !== before.length) {
      if (items.length) p.artifacts = items.map((item) => item.id);
      else delete p.artifacts;
      this.ws.save();
    }
    return { items };
  }
  /** The ids on a project's list whose artifact is still in the index. Reads no file. */
  attached(p, known = this.ws.artifacts.known()) {
    return (p.artifacts ?? []).filter((id) => known(id));
  }
  /** The projects as a window sees them: an artifact that is gone is not on a project's list. */
  listed() {
    if (!this.all.some((p) => p.artifacts)) return this.all;
    const known = this.ws.artifacts.known();
    return this.all.map((p) => {
      if (!p.artifacts) return p;
      const { artifacts, ...rest } = p;
      const still = artifacts.filter((id) => known(id));
      return still.length ? { ...rest, artifacts: still } : rest;
    });
  }
  /** The chats in a project, newest first. */
  chats(id) {
    return this.ws.state.chats.filter((c) => c.projectId === id);
  }
  /** The project a chat works for: its own, or for a panel refresh, the panel's. */
  projectOf(chat) {
    const id = chat?.projectId ?? (chat?.panelId && this.ws.state.panels?.find((p) => p.id === chat.panelId)?.projectId);
    return (id && this.all.find((p) => p.id === id)) || null;
  }
  /** The bots that answer in a chat. */
  botsOf(chat) {
    return (isGroup(chat) ? chat.botIds : [chat.botId]).map((id) => this.ws.bot(id));
  }
  /** Points a chat at a project (or none) and sets how freely its bot may act there. */
  setChatProject(chatId, projectId, mode, folder) {
    const chat = this.ws.chat(chatId);
    if (this.ws.active.has(chatId)) throw new Error("Wait for the reply to finish before changing the project.");
    mode ??= (projectId && this.get(projectId).mode) || "default";
    if (!MODES.includes(mode)) throw new Error("Use default, plan or yolo.");
    const previousId = chat.projectId;
    const before = this.folderFor(chat);
    if (projectId) {
      const project = this.get(projectId);
      if (isGroup(chat) && project.folder)
        throw new Error("Group chats take text only and can't work in a project folder. Choose a project without a folder.");
      // Every bot that answers here needs access to the project.
      for (const bot of this.botsOf(chat)) assertProject(this.ws.state, bot, project);
      if (folder === undefined && projectId === chat.projectId) folder = chat.folder;
      if (folder && !project.folders.includes(folder)) throw new Error("Choose a folder in this project.");
      if (project.folder && projectId !== previousId && !folderFor(project, { folder })) throw new Error("This project's folder is missing: " + (folder || project.folder));
      if (folder && folder !== project.folder) chat.folder = folder;
      else delete chat.folder;
      project.lastUsed = Date.now();
      chat.projectId = projectId;
      // Modes only apply in a folder.
      chat.mode = project.folder ? mode : "default";
    } else {
      delete chat.folder;
      delete chat.projectId;
      chat.mode = mode;
    }
    if (previousId !== chat.projectId || before !== this.folderFor(chat)) restart(chat);
    this.ws.save();
  }
  /** New chat in a project: one bot, or 2 to 6 for a group. Every bot needs access. Returns the chat id. */
  startChat(botIds, projectId, mode, folder) {
    if (!Array.isArray(botIds) || !botIds.length) throw new Error("Choose a bot.");
    const project = this.get(projectId);
    for (const id of botIds) assertProject(this.ws.state, this.ws.bot(id), project);
    const chatId = botIds.length > 1 ? this.ws.createGroupChat(botIds) : this.ws.createChat(botIds[0]);
    try {
      this.setChatProject(chatId, projectId, mode, folder);
    } catch (error) {
      this.ws.state.chats = this.ws.state.chats.filter((c) => c.id !== chatId);
      this.ws.save();
      throw error;
    }
    return chatId;
  }
  /** The folder a chat's Copilot session works in, or null for the bot's own folder. */
  folderFor(chat) {
    if (isGroup(chat) || chat.group) return null;
    const project = chat.projectId && this.all.find((p) => p.id === chat.projectId);
    return folderFor(project, chat);
  }

  // To-do list
  todo(projectId, todoId) {
    const t = this.get(projectId).todos.find((t) => t.id === todoId);
    if (!t) throw new Error("This to-do no longer exists.");
    return t;
  }
  addTodo(projectId, text) {
    const p = this.get(projectId);
    if (p.todos.length >= MAX_TODOS) throw new Error("A project holds up to " + MAX_TODOS + " to-dos.");
    const todo = { id: randomUUID(), text: todoText(text), done: false, createdAt: Date.now() };
    p.todos.push(todo);
    this.ws.save();
    return todo;
  }
  updateTodo(projectId, todoId, patch = {}) {
    const t = this.todo(projectId, todoId);
    if (patch.text !== undefined) t.text = todoText(patch.text);
    if (patch.done !== undefined) {
      if (typeof patch.done !== "boolean") throw new Error("Invalid to-do state");
      if (patch.done && !t.done) t.doneAt = Date.now();
      if (!patch.done) delete t.doneAt;
      t.done = patch.done;
    }
    this.ws.save();
    return t;
  }
  deleteTodo(projectId, todoId) {
    const p = this.get(projectId);
    this.todo(projectId, todoId);
    p.todos = p.todos.filter((t) => t.id !== todoId);
    this.ws.save();
  }
  /** Moves a to-do one place up (-1) or down (1). */
  moveTodo(projectId, todoId, delta) {
    const p = this.get(projectId);
    const i = p.todos.findIndex((t) => t.id === todoId);
    if (i < 0) throw new Error("This to-do no longer exists.");
    if (delta !== -1 && delta !== 1) throw new Error("Move a to-do up or down by one.");
    const j = i + delta;
    if (j < 0 || j >= p.todos.length) return;
    [p.todos[i], p.todos[j]] = [p.todos[j], p.todos[i]];
    this.ws.save();
  }

  /** What a bot in this chat knows about its project, for the system message. "" outside a project. */
  context(chat, bot) {
    const p = this.projectOf(chat);
    if (!p || !canUseProject(this.ws.state, bot, p)) return "";
    const working = this.folderFor(chat);
    return (
      "\n\nThis chat belongs to the project “" + p.name + "”." +
      (p.description ? "\nProject description: " + p.description : "") +
      // No counts here: this text opens the session, and the to-do list changes during it.
      "\nThe project keeps a to-do list. Use todo_list, todo_add and todo_update to read and keep it, and project_info for its details." +
      (working ? "\nIts folder is " + working + "." : "") +
      p.folders.filter((f) => f !== working).map((f) => "\nOther project folder: " + basename(f) + " (" + f + ")").join("")
    );
  }
  info(p, chat) {
    return {
      id: p.id,
      name: p.name,
      description: p.description || "",
      folder: chat ? this.folderFor(chat) : p.folder ?? null,
      ...(p.folders.length > 1 && { folders: p.folders }),
      todos: { open: p.todos.filter((t) => !t.done).length, done: p.todos.filter((t) => t.done).length },
    };
  }
  /** todo_list, todo_add, todo_update and project_info, for a chat in a project the bot may use. */
  tools(bot, chat, run, task) {
    if (!this.projectOf(chat)) return [];
    const current = () => {
      const p = this.projectOf(chat);
      if (!p) throw new Error("This chat is no longer in a project.");
      assertProject(this.ws.state, bot, p);
      return p;
    };
    const tool = (name, description, properties, required, handler) =>
      defineTool(name, {
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        skipPermission: true,
        defer: "never",
        handler: (args) => {
          if (task.stopped || this.ws.closing || !run || this.ws.active.get(chat.id) !== task)
            throw new Error("This turn is no longer active");
          return JSON.stringify(handler(current(), args));
        },
      });
    const view = (t) => ({ id: t.id, text: t.text, done: t.done });
    let added = 0;
    return [
      tool("project_info", "Read this chat's project: name, description, folder and to-do counts.", {}, [], (p) => this.info(p, chat)),
      tool(
        "todo_list",
        "List this project's to-do items in order. Done items are included unless open_only is true.",
        { open_only: { type: "boolean" } },
        [],
        (p, { open_only }) => p.todos.filter((t) => !open_only || !t.done).map(view),
      ),
      tool("todo_add", "Add an item to this project's to-do list.", { text: { type: "string" } }, ["text"], (p, { text }) => {
        if (++added > 20) throw new Error("Add at most 20 to-dos per reply.");
        return view(this.addTodo(p.id, text));
      }),
      tool(
        "todo_update",
        "Check off, reopen or rename one of this project's to-dos. Use the id from todo_list.",
        { id: { type: "string" }, done: { type: "boolean" }, text: { type: "string" } },
        ["id"],
        (p, { id, ...patch }) => view(this.updateTodo(p.id, id, patch)),
      ),
    ];
  }
  async changes(id, folder) {
    const path = this.folderOf(id, folder);
    const root = (await git(path, ["rev-parse", "--show-toplevel"], { allowFail: true }))?.trim();
    if (!root) return { repo: false, files: [] };
    const status = parseStatus(await git(root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]));
    const counts = new Map();
    for (const args of [["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"], ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z"]]) {
      const parts = ((await git(root, args, { allowFail: true })) ?? "").split("\0");
      for (let i = 0; i < parts.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
        if (!m) continue;
        // A rename's line has an empty path, then the old and new paths as the next two fields.
        let file = m[3];
        if (!file) {
          file = parts[i + 2] ?? "";
          i += 2;
        }
        const c = counts.get(file) ?? { added: 0, removed: 0 };
        c.added += m[1] === "-" ? 0 : Number(m[1]);
        c.removed += m[2] === "-" ? 0 : Number(m[2]);
        counts.set(file, c);
      }
    }
    // New files aren't in `git diff`; count their lines against an empty file (the first 200).
    for (const f of status.files.filter((f) => f.kind === "untracked" && !counts.has(f.path)).slice(0, 200)) {
      const out = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--numstat", "--", devNull, f.path], { allowFail: true, differences: true });
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(out ?? "");
      if (m) counts.set(f.path, { added: m[1] === "-" ? 0 : Number(m[1]), removed: 0 });
    }
    const files = status.files.map((f) => ({ ...f, ...(counts.get(f.path) ?? { added: 0, removed: 0 }) }));
    return {
      repo: true,
      root,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      files,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    };
  }
  async diff(id, file, folder) {
    const path = this.folderOf(id, folder);
    const root = (await git(path, ["rev-parse", "--show-toplevel"]))?.trim();
    if (typeof file !== "string" || !file || isAbsolute(file) || file.split(/[\\/]/).includes(".."))
      throw new Error("Invalid file");
    // Paths come from git status, relative to the repository. Symbolic links may not lead outside it.
    const base = realpathSync(root);
    const target = resolve(base, file);
    const real = existsSync(target) ? realpathSync(target) : resolve(realpathSync(existsSync(dirname(target)) ? dirname(target) : base), basename(target));
    if (!target.startsWith(base + sep) || !real.startsWith(base + sep)) throw new Error("Invalid file");
    const plain = ["--no-ext-diff", "--no-textconv"];
    let text = (await git(root, ["diff", ...plain, "HEAD", "--", file], { allowFail: true })) || "";
    if (!text && existsSync(target) && statSync(real).isFile())
      text = (await git(root, ["diff", ...plain, "--no-index", "--", devNull, file], { allowFail: true, differences: true })) || "";
    return text.length > MAX_DIFF ? { text: text.slice(0, MAX_DIFF), truncated: true } : { text, truncated: false };
  }
  /** Stages everything and commits it. The person confirms this in the app. */
  async commit(id, message, folder) {
    const path = this.folderOf(id, folder);
    const text = textField(message, 2000, "commit message");
    // Only the project's folder is staged. Hooks don't run (see SAFE).
    await git(path, ["add", "-A", "--", "."]);
    await git(path, ["commit", "--no-verify", "-m", text]);
    return (await git(path, ["rev-parse", "--short", "HEAD"])).trim();
  }
}
