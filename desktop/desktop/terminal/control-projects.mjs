// Projects, to-dos, tasks and artifacts: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// Each call is thin: it finds a project, a to-do, a task or a bot by the name a person typed, and hands the
// work to the app's own call, which checks what it is given (names, lengths, the folder rule, the lanes).
// Three of them have a rule of their own:
//  - A project's folder is chosen with the app's own folder check (`handlers.listFolders`, the one a paired phone
//    meets): the home folder of the service's user, or a plugged-in disk. There is no second check here.
//  - `projects.commit` makes a git commit in the project's folder, so it takes the list of files that the caller
//    was shown and refuses when the changes are not those files any more.
//  - `projects.chat` opens a chat in YOLO mode only when the caller marks that it agreed (see the call).
import { existsSync, realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { LANES, PRIORITIES } from "../tasks.mjs";
import { PROJECT_COLORS } from "../projects.mjs";
import { ControlError } from "./socket.mjs";
import { needsScriptYes } from "./script-yes.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const iso = (time) => (time ? new Date(time).toISOString() : null);
const shortList = (entries, label) => entries.slice(0, 5).map((entry) => label(entry) + " (" + entry.id + ")").join(", ") + (entries.length > 5 ? " and " + (entries.length - 5) + " more" : "");
/**
 * One of a list by its id, or by its label: the exact label first, then the start of a label, then the start of an id (6
 * characters at least). When more than one matches, the answer says which ones.
 */
function pick(list, ref, what, see, label = (entry) => entry.name) {
  const wanted = text(ref, 200, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  for (const match of [(entry) => String(label(entry) ?? "").toLowerCase() === lower, (entry) => String(label(entry) ?? "").toLowerCase().startsWith(lower), (entry) => wanted.length >= 6 && entry.id.startsWith(wanted)]) {
    const found = list.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new ControlError("More than one " + what + " matches " + wanted + ": " + shortList(found, label) + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  }
  throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
}

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function projectsApi({ workspace, handlers, bot }) {
  const state = () => workspace.state;
  const projects = () => state().projects ?? [];
  const project = (ref) => pick(projects(), ref, "project", "botkins projects list");
  const projectView = (p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    color: p.color ?? null,
    folder: p.folder ?? null,
    folders: p.folders,
    ...(p.mode && { mode: p.mode }),
    ...(p.folder && !existsSync(p.folder) && { folderMissing: true }),
    todos: { open: p.todos.filter((todo) => !todo.done).length, done: p.todos.filter((todo) => todo.done).length },
    artifacts: workspace.projects.attached(p).length,
    chats: workspace.projects.chats(p.id).length,
    createdAt: iso(p.createdAt),
    lastUsed: iso(p.lastUsed),
  });
  const named = (p) => ({ id: p.id, name: p.name });
  const todoView = (todo, index) => ({ id: todo.id, position: index + 1, text: todo.text, done: todo.done, createdAt: iso(todo.createdAt), ...(todo.doneAt && { doneAt: iso(todo.doneAt) }) });
  /** A to-do by its id, its words, the start of its id or words, or its place in the list (1 is the first). */
  const todo = (p, ref) => {
    const todos = p.todos.map(todoView);
    const number = typeof ref === "number" ? String(ref) : typeof ref === "string" && /^[1-9][0-9]{0,3}$/.test(ref.trim()) ? ref.trim() : null;
    if (number) {
      // A to-do whose words are that number is that one: words come before places.
      const sameWords = todos.filter((entry) => entry.text === number);
      if (sameWords.length === 1) return sameWords[0];
      if (!sameWords.length) {
        if (todos[Number(number) - 1]) return todos[Number(number) - 1];
        throw new ControlError("The project " + p.name + " has no to-do number " + number + ".", "NOT_FOUND");
      }
    }
    return pick(todos, ref, "to-do", "botkins todos list <project>", (entry) => entry.text);
  };
  const todosOf = (p) => ({ project: named(p), todos: p.todos.map(todoView) });

  // ── Changes in a project's folder ──
  const needFolder = (p) => {
    if (!p.folder) throw new ControlError("The project " + p.name + " has no folder. Give it one with `botkins projects edit` (--folder).", "NO_FOLDER");
  };
  /**
   * What `git status` says of the project's folder, with which files a commit would take. The commit stages the project's
   * folder (`git add -A -- .`), and `git commit` takes what is staged: so a file of the folder, and a file that is staged already.
   */
  const changesOf = async (p, folder = p.folder) => {
    needFolder(p);
    const changes = await handlers.projectChanges(p.id, folder);
    if (!changes.repo) return { project: named(p), folder, repo: false, files: [] };
    const inside = relative(realpathSync(changes.root), realpathSync(folder)).split(sep).join("/");
    return { project: named(p), folder, ...changes, files: changes.files.map((file) => ({ ...file, commit: file.staged || inside === "" || file.path.startsWith(inside + "/") })) };
  };

  // ── Tasks ──
  const tasks = () => state().tasks ?? [];
  const task = (ref) => pick(tasks(), ref, "task", "botkins tasks list", (entry) => entry.title);
  const botName = (id) => state().bots.find((entry) => entry.id === id)?.name ?? null;
  const taskView = (t) => ({
    id: t.id,
    title: t.title,
    details: t.body ?? "",
    status: t.status,
    priority: t.priority,
    bot: botName(t.botId),
    botId: t.botId ?? null,
    createdBy: t.createdBy === "person" ? "person" : (botName(t.createdBy) ?? "a bot"),
    ...(t.review && { review: t.review }),
    ...(t.reviewerBotId && { reviewerBotId: t.reviewerBotId, reviewer: botName(t.reviewerBotId) ?? "a bot" }),
    ...(t.problem && { problem: t.problem }),
    ...(t.result && { result: t.result }),
    ...(t.chatId && { chatId: t.chatId }),
    ...(t.history?.length && { history: t.history }),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  });
  const oneOf = (list, value, what) => {
    if (!list.includes(value)) throw new ControlError(what + " is one of " + list.join(", ") + ".", "BAD_ARGUMENT");
    return value;
  };

  return {
    // ── Projects ──
    "projects.list": () => projects().map(projectView),
    /** One project, with its to-do list. */
    "projects.get": ([ref]) => {
      const found = project(ref);
      return { ...projectView(found), todoItems: found.todos.map(todoView) };
    },
    /**
     * A new project: { name?, description?, color?, folder? }. With a folder it is the app's "add folder": a project
     * that has this folder already is not made twice (`created: false`), and then nothing else may be given.
     */
    async "projects.add"([data = {}]) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ControlError("Give the project's name or folder.", "BAD_ARGUMENT");
      const extra = {};
      for (const key of ["name", "description", "color"]) if (data[key] !== undefined) extra[key] = data[key];
      // (The app's own create leaves an unknown color out without a word; here it is said.)
      if (extra.color !== undefined && !PROJECT_COLORS.includes(extra.color)) throw new ControlError("A color is one of " + PROJECT_COLORS.join(", ") + ".", "BAD_ARGUMENT");
      if (data.folder === undefined || data.folder === null) {
        if (extra.name === undefined) throw new ControlError("Give the project a name, or a folder.", "BAD_ARGUMENT");
        const id = await handlers.createProject(extra);
        return { ...projectView(project(id)), created: true };
      }
      const before = new Set(projects().map((p) => p.id));
      // The app's own call checks the folder (its home folder rule) and reuses the project that has it.
      const id = await handlers.addProjectFolder(text(data.folder, 4000, "a folder's full path"));
      const created = !before.has(id);
      if (Object.keys(extra).length) {
        if (!created) throw new ControlError("The project " + project(id).name + " has this folder already. Change it with `botkins projects edit`.", "EXISTS");
        try {
          await handlers.updateProject(id, extra);
        } catch (error) {
          // A project that was made for this call and is not as it was asked for is not kept.
          await handlers.removeProject(id);
          throw error;
        }
      }
      return { ...projectView(project(id)), created };
    },
    async "projects.rename"([ref, name]) {
      const found = project(ref);
      await handlers.renameProject(found.id, name);
      return projectView(project(found.id));
    },
    async "projects.folder"([ref, action, path]) {
      const id = project(ref).id;
      if (action === "add") path = (await handlers.listFolders(path)).path;
      await handlers.editProjectFolder(id, action, path);
      return projectView(project(id));
    },
    async "projects.clone"([repo, parent, ref]) {
      const path = parent && (await handlers.listFolders(parent)).path;
      const id = await handlers.cloneProjectRepository(repo, path, ref && project(ref).id);
      return projectView(project(id));
    },
    async "projects.edit"([ref, patch = {}]) {
      const found = project(ref);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      const update = {};
      for (const key of ["name", "description", "color", "mode"]) if (patch[key] !== undefined) update[key] = patch[key];
      // The folder is chosen by the app's own rule, as a phone chooses one; what comes back is the real path.
      if (patch.folder !== undefined) update.folder = patch.folder === null ? null : (await handlers.listFolders(text(patch.folder, 4000, "a folder's full path"))).path;
      if (!Object.keys(update).length) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      await handlers.updateProject(found.id, update);
      return projectView(project(found.id));
    },
    /** Takes the project out of Botkins. Its folder's files are not touched. The answer says what went with it. */
    async "projects.remove"([ref]) {
      const found = project(ref);
      const view = projectView(found);
      await handlers.removeProject(found.id);
      return { removed: found.id, name: found.name, folder: view.folder, todos: found.todos.length, chats: view.chats };
    },
    /** The artifacts attached to a project, newest first. */
    "projects.artifacts": async ([ref]) => {
      const found = project(ref);
      return { project: named(found), items: (await handlers.projectArtifacts(found.id)).items };
    },
    async "projects.addArtifact"([ref, artifact]) {
      const found = project(ref);
      await handlers.addProjectArtifact(found.id, text(artifact, 4096, "an artifact's id or path"));
      return { project: named(found), items: (await handlers.projectArtifacts(found.id)).items };
    },
    async "projects.removeArtifact"([ref, artifact]) {
      const found = project(ref);
      await handlers.removeProjectArtifact(found.id, text(artifact, 4096, "an artifact's id"));
      return { project: named(found), items: (await handlers.projectArtifacts(found.id)).items };
    },
    /** What changed in the project's folder (git), and which files a commit would take: each file has `commit: true` or `false`. */
    "projects.changes": ([ref, folder]) => changesOf(project(ref), folder ?? undefined),
    async "projects.diff"([ref, file, folder]) {
      const found = project(ref);
      needFolder(found);
      return { project: named(found), file: text(file, 4096, "a file's path in the repository"), ...(await handlers.projectDiff(found.id, file, folder)) };
    },
    /**
     * Commits the changes of the project's folder with the message. `expected` is the list of paths that the caller was shown
     * (`projects.changes`, the files with `commit: true`): when the changes are others now, nothing is committed.
     */
    async "projects.commit"([ref, message, expected, folder]) {
      const found = project(ref);
      const words = text(message, 2000, "a commit message (up to 2000 characters)");
      const view = await changesOf(found, folder ?? undefined);
      if (!view.repo) throw new ControlError("The folder of " + found.name + " is not a git repository, so there is nothing to commit.", "NO_REPOSITORY");
      const files = view.files.filter((file) => file.commit);
      if (!files.length) throw new ControlError("There is nothing to commit in " + found.name + ".", "NOTHING_TO_COMMIT");
      if (expected !== undefined) {
        if (!Array.isArray(expected) || expected.some((path) => typeof path !== "string")) throw new ControlError("The files that were shown are a list of paths.", "BAD_ARGUMENT");
        const now = files.map((file) => file.path);
        if (now.length !== expected.length || now.some((path) => !expected.includes(path))) throw new ControlError("The changes are not the files that were shown. Look at them again with `botkins projects changes`.", "CHANGED");
      }
      const commit = await handlers.projectCommit(found.id, words, view.folder);
      return { project: named(found), name: found.name, commit, files: files.length };
    },
    /**
     * Opens a chat in the project for one bot, or for 2 to 6 (a group). It sends no message: no turn of a model starts.
     * `options`: { bots: [name or id…], mode?: "default" | "plan" | "yolo", agreed?: true }.
     * In YOLO mode each request of the bot in the chat gets a yes with no question, but a request that leaves the sandbox
     * (the app's own rule: desktop/interactions.mjs). This takes the caller's word: `agreed: true` says that the caller showed
     * the person what the mode gives and got a yes. The command line does that (`--yes`, or the question at a terminal).
     * The other modes need no word.
     */
    async "projects.chat"([ref, options = {}]) {
      const found = project(ref);
      const refs = Array.isArray(options?.bots) ? options.bots : [];
      if (!refs.length) throw new ControlError("Give at least one bot.", "BAD_ARGUMENT");
      const bots = [...new Map(refs.map((entry) => bot(entry)).map((entry) => [entry.id, entry])).values()];
      const mode = oneOf(["default", "plan", "yolo"], options.mode ?? found.mode ?? "default", "A mode");
      if (mode === "yolo" && options.agreed !== true) throw new ControlError("A chat in the mode yolo needs a yes: each request of the bot in it gets a yes with no question. Show that to the person, and give `agreed: true` (on the command line, `--yes`).", "NEEDS_YES");
      const chatId = await handlers.startProjectChat(bots.map((entry) => entry.id), found.id, mode, options.folder);
      return { chatId, project: named(found), bots: bots.map((entry) => ({ id: entry.id, name: entry.name })), mode: workspace.chat(chatId).mode, ...(found.folder && { folder: workspace.chat(chatId).folder ?? found.folder }) };
    },

    // ── To-dos (each is a project's own) ──
    "todos.list": ([ref]) => todosOf(project(ref)),
    /** One to-do, by its id, its words or its number. */
    "todos.get": ([ref, which]) => {
      const found = project(ref);
      return { project: named(found), todo: todo(found, which) };
    },
    async "todos.add"([ref, words]) {
      const found = project(ref);
      const id = await handlers.addTodo(found.id, words);
      return { project: named(found), todo: todoView(found.todos.find((entry) => entry.id === id), found.todos.findIndex((entry) => entry.id === id)) };
    },
    /** Changes { text?, done? } of one to-do. */
    async "todos.edit"([ref, which, patch = {}]) {
      const found = project(ref);
      const target = todo(found, which);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      const update = {};
      for (const key of ["text", "done"]) if (patch[key] !== undefined) update[key] = patch[key];
      if (!Object.keys(update).length) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      await handlers.updateTodo(found.id, target.id, update);
      return { project: named(found), todo: todo(found, target.id) };
    },
    /** Moves a to-do one place up (-1) or down (1). */
    async "todos.move"([ref, which, delta]) {
      const found = project(ref);
      const target = todo(found, which);
      await handlers.moveTodo(found.id, target.id, delta);
      return { ...todosOf(found), moved: target.id };
    },
    async "todos.remove"([ref, which]) {
      const found = project(ref);
      const target = todo(found, which);
      await handlers.deleteTodo(found.id, target.id);
      return { project: named(found), removed: target.id, text: target.text };
    },

    // ── Tasks (the board is the whole app's, not a project's) ──
    /** The board, newest first. `options`: { status?, bot? }. */
    "tasks.list"([options = {}]) {
      const only = options?.bot ? bot(options.bot).id : null;
      const lane = options?.status === undefined ? null : oneOf([...LANES, "archived"], options.status, "A status");
      return tasks()
        .filter((entry) => (!only || entry.botId === only) && (!lane || entry.status === lane))
        .map(taskView);
    },
    "tasks.get": ([ref]) => taskView(task(ref)),
    /** A new task: { title, details?, bot?, priority?, status? }. A task that is Ready and has a bot starts by itself. */
    async "tasks.add"([data = {}, mark]) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ControlError("Give the task a title.", "BAD_ARGUMENT");
      // A task that is a script command runs that script with no model (desktop/script-commands.mjs): the person agrees first.
      needsScriptYes(workspace, (typeof data.details === "string" && data.details.trim()) || data.title, mark, "This task");
      const id = await handlers.saveTask({
        title: data.title,
        body: data.details,
        botId: data.bot ? bot(data.bot).id : null,
        ...(data.priority !== undefined && { priority: oneOf(PRIORITIES, data.priority, "A priority") }),
        ...(data.status !== undefined && { status: oneOf(LANES, data.status, "A status") }),
      });
      return taskView(task(id));
    },
    /** Changes { title?, details?, bot? (null for no bot), priority? }. The app's save takes the whole task, so what is not given is as it was. */
    async "tasks.edit"([ref, patch = {}, mark]) {
      const found = task(ref);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      if (!["title", "details", "bot", "priority"].some((key) => patch[key] !== undefined)) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      const after = { title: patch.title ?? found.title, body: patch.details ?? found.body };
      needsScriptYes(workspace, (typeof after.body === "string" && after.body.trim()) || after.title, mark, "This task");
      await handlers.saveTask({
        id: found.id,
        title: patch.title ?? found.title,
        body: patch.details ?? found.body,
        botId: patch.bot === undefined ? found.botId : patch.bot === null ? null : bot(patch.bot).id,
        priority: patch.priority === undefined ? found.priority : oneOf(PRIORITIES, patch.priority, "A priority"),
      });
      return taskView(task(found.id));
    },
    async "tasks.move"([ref, status, markOrOpts, maybeMark]) {
      const found = task(ref);
      const hasNote = markOrOpts && typeof markOrOpts === "object" && Object.hasOwn(markOrOpts, "note");
      const opts = hasNote ? { note: markOrOpts.note } : {};
      const mark = hasNote ? (maybeMark ?? markOrOpts) : markOrOpts;
      if (status === "ready") needsScriptYes(workspace, found.body?.trim() || found.title, mark, "This task");
      await handlers.moveTask(found.id, oneOf([...LANES, "archived"], status, "A status"), opts);
      return taskView(task(found.id));
    },
    /** Starts the task now, in its own chat: a turn of its bot's model. A task that is working already is left as it is (`already: true`). */
    async "tasks.start"([ref, mark]) {
      const found = task(ref);
      const already = found.status === "working";
      if (!already) needsScriptYes(workspace, found.body?.trim() || found.title, mark, "This task");
      await handlers.startTask(found.id);
      return { ...taskView(task(found.id)), ...(already && { already: true }) };
    },
    async "tasks.remove"([ref]) {
      const found = task(ref);
      await handlers.deleteTask(found.id);
      return { removed: found.id, title: found.title };
    },

    // ── Artifacts: the files that a bot made or showed, kept for each bot ──
    /** One page of a bot's artifacts. `options`: { bot, chat?, kind?: "files" | "media", folder?, cursor? }. */
    "artifacts.list"([options = {}]) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new ControlError("Give the bot.", "BAD_ARGUMENT");
      return handlers["artifacts.list"]({ botId: bot(options.bot).id, chatId: options.chat, kind: options.kind, folder: options.folder, cursor: options.cursor });
    },
    /** One piece of an artifact (the app's read): { artifact, encoding: "base64", data, offset, nextOffset }. Up to 512 KB each time. */
    "artifacts.read": ([id, range]) => handlers["artifacts.read"](text(id, 4096, "an artifact's id or path"), range && typeof range === "object" ? { offset: range.offset, length: range.length } : undefined),
    /** The artifacts of a chat's bots that these paths name, in the order given (null for a path that is none). */
    "artifacts.resolve": ([chat, paths]) => handlers["artifacts.resolve"]({ chatId: text(chat, 200, "a chat's id"), paths }),
  };
}
