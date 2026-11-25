// Projects, to-dos, tasks and artifacts: the commands (cli/commands/index.mjs adds them).
// `projectsCommands` maps a top-level word to a group `{ summary, commands }`: `botkins projects`,
// `botkins todos`, `botkins tasks` and `botkins artifacts`.
//
// What these hold to (desktop/AGENTS.md):
//  - A project's folder is a path on the computer that runs Botkins. The app's own rule says which folders can be
//    chosen (the home folder of the service's user, or a plugged-in disk: `botkins folders`). There is no second check here.
//  - `projects commit` makes a git commit in the project's folder. It shows the files that go into it first and
//    needs a yes (`--yes` with no terminal). Git hooks do not run.
//  - `tasks start` and `projects chat` are about a turn of a model: the text says what starts, and what does not.
//  - A text that somebody else wrote (a name, a to-do, a task's details, a diff, a file's content) is made safe
//    before it is printed to a person. `--json` and a pipe get it as it is.
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ago, CliError, EXIT, table, usage } from "../output.mjs";
import { shellWord } from "./tools.mjs";
import { shownText } from "../../desktop/shown-text.mjs";
import { ask, confirm, readAll, withScriptYes } from "./input.mjs";

// No short form: the same as in the commands of tools.
const YES = { yes: { type: "boolean", about: "Do not ask first" } };
const safe = shownText;
/** Text of more than one line as a person can be shown it: the line ends and the tabs stay, every other control character is written as its number. */
const safeLines = (text) => String(text).split(/\r?\n/).map((line) => line.split("\t").map(safe).join("\t")).join("\n");
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person. */
const show = (context, text) => void context.stderr.write(text + "\n");
const COLORS = "coral, amber, green, teal, blue, violet, pink or gray";
const LANES = "later, ready, review, blocked, done or archived";
const PRIORITIES = "low, normal, high or urgent";
/** A word as a command that is printed for someone to run: the name, or a placeholder when it cannot be written as a word. */
const word = (name, placeholder) => shellWord(name, placeholder);
const count = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);

const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
/** A file's text, or standard input for "-". */
async function textFrom(context, path, what) {
  if (path === "-") return readAll(context.stdin);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The " + what + " " + path + " cannot be read: " + error.message);
  }
}
/** A long text: from its own option, or from a file (`--<name>-file`; "-" is standard input). Both is a mistake. */
async function longText(context, name, what) {
  const { options } = context;
  const inline = options[name];
  const file = options[name + "-file"];
  if (inline !== undefined && file !== undefined) throw usage("Give the " + what + " with --" + name + " or with --" + name + "-file, not both.");
  if (file !== undefined) return (await textFrom(context, file, what + " file")).replace(/\r\n/g, "\n").trimEnd();
  return inline;
}
/** The words after the leading arguments, as one text; or the text of --file. */
async function wordsOrFile(context, skip, what) {
  const words = context.args.slice(skip).join(" ").trim();
  const file = context.options.file;
  if (words && file !== undefined) throw usage("Give the " + what + " as words, or with --file, not both.");
  if (file !== undefined) return (await textFrom(context, file, what + " file")).replace(/\r\n/g, "\n").trimEnd();
  return words;
}

// ── How a project, a to-do and a task are shown ──
const todoCount = (todos) => todos.open + " open" + (todos.done ? ", " + todos.done + " done" : "");
const projectText = (p) =>
  [
    safe(p.name) + "   " + p.id,
    p.folder ? "Folder: " + JSON.stringify(safe(p.folder)) + (p.folderMissing ? " (missing)" : "") : "No folder.",
    ...(p.folders ?? []).slice(1).map((path) => "Folder: " + JSON.stringify(safe(path))),
    p.mode ? "Mode: " + p.mode : null,
    p.description ? "Description: " + safeLines(p.description) : null,
    p.color ? "Color: " + p.color : null,
    "To-dos: " + todoCount(p.todos) + ". Chats: " + p.chats + ". Attached artifacts: " + p.artifacts + ".",
    ...(p.todoItems?.length ? ["", ...p.todoItems.map((todo) => todo.position + ". " + (todo.done ? "[x] " : "[ ] ") + safe(todo.text))] : []),
  ]
    .filter((line) => line !== null)
    .join("\n");
const todoTable = (todos) => table(["#", "DONE", "TO-DO", "ID"], todos.map((todo) => [todo.position, todo.done ? "yes" : "no", safe(todo.text), todo.id]));
const taskText = (t) =>
  [
    safe(t.title) + "   " + t.id,
    "Status: " + t.status + ". Priority: " + t.priority + ". Bot: " + (t.bot ? safe(t.bot) : "none") + ". Added by: " + safe(t.createdBy) + ".",
    t.problem ? "Problem: " + safeLines(t.problem) : null,
    t.details ? "Details: " + safeLines(t.details) : null,
    t.result ? "Result: " + safeLines(t.result) : null,
    t.chatId ? "Chat: " + t.chatId : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
const artifactName = (item) => safe(item.name ?? item.id);
const size = (bytes) => (bytes === null || bytes === undefined ? "" : bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 102.4) / 10 + " KB" : Math.round(bytes / 104857.6) / 10 + " MB");
const artifactTable = (items) => table(["NAME", "KIND", "SIZE", "WHEN", "SOURCE", "ID"], items.map((item) => [artifactName(item), item.kind, size(item.size), ago(item.time), item.source, item.id]));

/** A file's text is text when its type says so. */
const isText = (mime) => /^text\//.test(mime ?? "") || /^application\/(json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|toml|sql|x-sh|x-ndjson|x-httpd-php)$/.test(mime ?? "") || /\+(json|xml)$/.test(mime ?? "");
const MAX_JSON_TEXT = 8 * 1024 * 1024;

/** The commit's message: --message, --file, or a line typed at a terminal. */
async function commitMessage(context) {
  const { message, file } = context.options;
  if (message !== undefined && file !== undefined) throw usage("Give the commit message with --message or with --file, not both.");
  let text;
  if (message !== undefined) text = message === "-" ? await readAll(context.stdin) : message;
  else if (file !== undefined) text = await textFrom(context, file, "message file");
  else if (context.stdin.isTTY && !context.json) text = (await ask(context, "Commit message: ")) ?? "";
  else throw usage("Give the commit message with --message <text>, or --file <path> (\"-\" reads standard input).");
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) throw usage("The commit message is empty.");
  return text;
}

const projectOptions = {
  name: { type: "string", value: "text", about: "The project's name (60 characters at most)" },
  description: { type: "string", value: "text", about: "A short description (2000 characters at most)" },
  "description-file": { type: "string", value: "path", about: "The description from a file (\"-\" reads standard input)" },
  color: { type: "string", value: "color", about: "The project's color: " + COLORS },
};

export const projectsCommands = {
  projects: {
    summary: "Projects: a folder, a to-do list, chats and artifacts that belong together",
    details: "A project can have a folder on this computer. A chat in a project works in that folder, and `botkins projects changes` reads its git changes. To-dos are kept by project (`botkins todos`). The folder must be one that can be chosen: in the home folder of the user that runs Botkins, or on a plugged-in disk (`botkins folders`).",
    commands: {
      list: {
        summary: "List the projects",
        usage: "botkins projects list",
        async run(context) {
          context.print(await context.client.call("projects.list"), (list) => (list.length ? table(["NAME", "FOLDER", "TO-DOS", "CHATS", "ID"], list.map((p) => [safe(p.name), p.folder ? safe(p.folder) + (p.folderMissing ? " (missing)" : "") : "", todoCount(p.todos), p.chats, p.id])) : "No projects yet. Add one with `botkins projects add`."));
        },
      },
      show: {
        summary: "Show one project: its folder, its to-do list and its counts",
        usage: "botkins projects show <project>",
        async run(context) {
          context.print(await context.client.call("projects.get", one(context, "Name the project (its name or id).")), projectText);
        },
      },
      add: {
        summary: "Add a project: for a folder, or by a name alone",
        usage: "botkins projects add [<folder>] [--name <text>] [--description <text>] [--description-file <path>] [--color <color>]",
        options: projectOptions,
        arguments: [{ name: "folder", required: false }],
        details: "With a folder (a full path on this computer) the name is the folder's name unless you give one. A folder that already has a project is not added twice: the command says so. Without a folder, give --name. The folder rule: in the home folder of the user that runs Botkins, or on a plugged-in disk (`botkins folders`).",
        async run(context) {
          if (context.args.length > 1) throw usage("Give one folder, or none.");
          const o = context.options;
          const description = await longText(context, "description", "description");
          const data = { ...(context.args[0] !== undefined && { folder: context.args[0] }), ...(o.name !== undefined && { name: o.name }), ...(description !== undefined && { description }), ...(o.color !== undefined && { color: o.color }) };
          if (data.folder === undefined && data.name === undefined) throw usage("Give a folder, or --name for a project with no folder.");
          context.print(await context.client.call("projects.add", data), (p) =>
            p.created
              ? "Added the project " + safe(p.name) + (p.folder ? " for the folder " + JSON.stringify(safe(p.folder)) : "") + ". Open a chat in it with `botkins projects chat " + word(p.name, "<the project>") + " --bot <bot>`."
              : "The project " + safe(p.name) + " has this folder already. Nothing was added.",
          );
        },
      },
      rename: {
        summary: "Give a project another name",
        usage: "botkins projects rename <project> <name>",
        arguments: [{ name: "project", required: true }, { name: "name", required: true }],
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project (its name or id), then give the new name.");
          context.print(await context.client.call("projects.rename", context.args[0], context.args[1]), (p) => "The project is now called " + safe(p.name) + ".");
        },
      },
      edit: {
        summary: "Change a project's name, description, color or folder",
        usage: "botkins projects edit <project> [--name <text>] [--description <text>] [--description-file <path>] [--color <color>] [--no-color] [--folder <path>] [--no-folder] [--mode <mode>]",
        options: { ...projectOptions, mode: { type: "string", value: "mode", about: "Default, plan or yolo" }, "no-color": { type: "boolean", about: "Take the color away" }, folder: { type: "string", value: "path", about: "The project's folder (a full path that can be chosen: `botkins folders`)" }, "no-folder": { type: "boolean", about: "Take the folder away. The files stay where they are" } },
        details: "Only what you name changes. A folder cannot change while a chat of the project works. Chats that began keep their history; without a folder they lose the coding modes.",
        async run(context) {
          const ref = one(context, "Name the project (its name or id).");
          const o = context.options;
          if (o.color !== undefined && o["no-color"]) throw usage("Give --color or --no-color, not both.");
          if (o.folder !== undefined && o["no-folder"]) throw usage("Give --folder or --no-folder, not both.");
          const description = await longText(context, "description", "description");
          const patch = { ...(o.mode && { mode: o.mode }), ...(o.name !== undefined && { name: o.name }), ...(description !== undefined && { description }), ...(o.color !== undefined && { color: o.color }), ...(o["no-color"] && { color: null }), ...(o.folder !== undefined && { folder: o.folder }), ...(o["no-folder"] && { folder: null }) };
          if (!Object.keys(patch).length) throw usage("Give what to change: --name, --description, --color, --folder, or --no-color or --no-folder.");
          context.print(await context.client.call("projects.edit", ref, patch), (p) => "Changed the project " + safe(p.name) + ".");
        },
      },
      remove: {
        summary: "Remove a project from Botkins. Its folder and its files stay",
        usage: "botkins projects remove <project> [--yes]",
        options: YES,
        details: "This removes the project and its to-do list, and the list of artifacts attached to it. The artifacts stay. Its chats stay, with no project. The folder and its files are not touched. It asks first; with no terminal it needs --yes.",
        async run(context) {
          const ref = one(context, "Name the project (its name or id).");
          const found = await context.client.call("projects.get", ref);
          show(context, "This removes the project " + safe(found.name) + " from Botkins, with its " + count(found.todos.open + found.todos.done, "to-do") + " and its list of attached artifacts." + (found.chats ? " Its " + count(found.chats, "chat") + " stay, with no project." : "") + (found.folder ? " The folder " + JSON.stringify(safe(found.folder)) + " and its files are not touched." : ""));
          if (!(await confirm(context, "Remove the project?"))) return EXIT.failed;
          context.print(await context.client.call("projects.remove", found.id), (gone) => "Removed the project " + safe(gone.name) + ".");
        },
      },
      folder: {
        summary: "Add or remove a folder, or make it the default",
        usage: "botkins projects folder <project> <add|remove|default> <path>",
        async run(context) {
          if (context.args.length !== 3) throw usage("Give a project, action and folder.");
          context.print(await context.client.call("projects.folder", ...context.args), projectText);
        },
      },
      clone: {
        summary: "Add a folder from GitHub, creating a project if needed",
        usage: "botkins projects clone <owner/repo> [--parent <path>] [--project <project>]",
        options: { parent: { type: "string", value: "path", about: "Parent folder on the host" }, project: { type: "string", value: "project", about: "Existing project" } },
        async run(context) {
          const repo = one(context, "Give a GitHub repository.");
          context.print(await context.client.call("projects.clone", repo, context.options.parent, context.options.project), projectText);
        },
      },
      folders: {
        summary: "List the folders of this computer that can be chosen for a project",
        usage: "botkins projects folders [<path>]",
        details: "The same list as `botkins folders`: the home folder and plugged-in disks, without hidden folders.",
        async run(context) {
          context.print(await context.client.call("folders.list", context.args[0]), (found) => [found.path, ...found.folders.map((folder) => "  " + safe(folder.name)), ...(found.more ? ["  …"] : [])].join("\n"));
        },
      },
      artifacts: {
        summary: "List the artifacts attached to a project",
        usage: "botkins projects artifacts <project>",
        details: "An artifact is a file that a bot made or showed (`botkins artifacts list`). An attached artifact is a link on the project. It changes nothing about the file and gives a bot nothing new.",
        async run(context) {
          context.print(await context.client.call("projects.artifacts", one(context, "Name the project (its name or id).")), (found) => (found.items.length ? artifactTable(found.items) : "No artifacts are attached to " + safe(found.project.name) + ". Attach one with `botkins projects add-artifact`."));
        },
      },
      "add-artifact": {
        summary: "Attach an artifact to a project",
        usage: "botkins projects add-artifact <project> <artifact>",
        arguments: [{ name: "project", required: true }, { name: "artifact", required: true }],
        details: "The artifact is its id, or its full path (`botkins artifacts list --bot <bot>`). An artifact that is attached already moves to the front.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the artifact (its id or full path).");
          context.print(await context.client.call("projects.addArtifact", context.args[0], context.args[1]), (found) => "Attached. " + safe(found.project.name) + " has " + count(found.items.length, "artifact") + ".");
        },
      },
      "remove-artifact": {
        summary: "Take an artifact off a project. The artifact stays",
        usage: "botkins projects remove-artifact <project> <artifact>",
        arguments: [{ name: "project", required: true }, { name: "artifact", required: true }],
        details: "Only the link on the project goes. The file stays, and you can attach it again. It asks nothing for that reason.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the artifact (its id).");
          context.print(await context.client.call("projects.removeArtifact", context.args[0], context.args[1]), (found) => "Taken off. " + safe(found.project.name) + " has " + count(found.items.length, "artifact") + ".");
        },
      },
      changes: {
        summary: "Show what changed in the project's folder (git), and which files a commit would take",
        usage: "botkins projects changes <project> [--folder <path>]",
        options: { folder: { type: "string", value: "path", about: "A folder in the project" } },
        details: "This runs git in the project's folder, read-only, with the repository's own hooks, filters and programs switched off. A file is in a commit when it is in the project's folder, or already staged.",
        async run(context) {
          context.print(await context.client.call("projects.changes", one(context, "Name the project (its name or id)."), context.options.folder), changesText);
        },
      },
      diff: {
        summary: "Show the changes of one file of the project's folder",
        usage: "botkins projects diff <project> <file> [--folder <path>]",
        options: { folder: { type: "string", value: "path", about: "A folder in the project" } },
        arguments: [{ name: "project", required: true }, { name: "file", required: true }],
        details: "The file is its path in the repository, as `botkins projects changes` shows it. The text is cut at 400,000 characters. At a terminal it is made safe to show; in a pipe and with --json it is as git wrote it.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the file (its path in the repository).");
          const found = await context.client.call("projects.diff", context.args[0], context.args[1], context.options.folder);
          context.print(found, (done) => {
            const text = (context.stdout.isTTY ? safeLines(done.text) : done.text).replace(/\n$/, "");
            return (text || "No changes in " + safe(done.file) + ".") + (done.truncated ? "\n(The diff is longer. This is its beginning.)" : "");
          });
        },
      },
      commit: {
        summary: "Commit the changes of the project's folder (git)",
        usage: "botkins projects commit <project> [--folder <path>] [--message <text>] [--file <path>] [--yes]",
        options: { folder: { type: "string", value: "path", about: "A folder in the project" }, message: { type: "string", short: "m", value: "text", about: "The commit message (\"-\" reads standard input)" }, file: { type: "string", value: "path", about: "The commit message from a file (\"-\" reads standard input)" }, ...YES },
        details: "This stages every change in the project's folder (git add -A) and makes a commit. Git hooks do not run. The command shows the files that go into the commit first and asks; with no terminal it needs --yes. Without --message and --file, a terminal asks for the message. The commit is made as the user that runs Botkins, with that user's git name and email.",
        async run(context) {
          const ref = one(context, "Name the project (its name or id).");
          const message = await commitMessage(context);
          const changes = await context.client.call("projects.changes", ref, context.options.folder);
          if (!changes.repo) throw new CliError("The folder of " + safe(changes.project.name) + " is not a git repository, so there is nothing to commit.");
          const files = changes.files.filter((file) => file.commit);
          if (!files.length) throw new CliError("There is nothing to commit in " + safe(changes.project.name) + ".");
          show(context, ["This makes a git commit in the folder of " + safe(changes.project.name) + ", " + JSON.stringify(safe(changes.folder)) + ", on the branch " + safe(changes.branch) + ".", "Git hooks do not run. The files that go into it (" + files.length + "):", ...files.map((file) => "  " + file.kind.padEnd(9) + " " + safe(file.path) + (file.staged ? "  (staged)" : "")), "Message: " + safe(message.split("\n")[0]) + (message.includes("\n") ? " …" : "")].join("\n"));
          if (!(await confirm(context, "Commit these files?"))) return EXIT.failed;
          const done = await context.client.call("projects.commit", changes.project.id, message, files.map((file) => file.path), changes.folder);
          context.print(done, (result) => "Committed " + result.commit + " in " + safe(result.name) + ": " + count(result.files, "file") + ".");
        },
      },
      chat: {
        summary: "Open a chat in a project for one bot, or for a group of bots",
        usage: "botkins projects chat <project> --bot <bot>… [--folder <path>] [--mode <mode>] [--yes]",
        options: { folder: { type: "string", value: "path", about: "A folder in the project" }, bot: { type: "string", multiple: true, value: "bot", about: "A bot to chat with (name or id). Give it 2 to 6 times for a group chat" }, mode: { type: "string", value: "mode", about: "default (the default), plan or yolo. Yolo asks first" }, ...YES },
        details: "This opens the chat and sends nothing: no turn of a model starts. A turn starts when a message is sent: `botkins chat <bot> --chat <id> -m <message>`. The bot's tools then work in the project's folder, and each tool asks for an approval as it does in any chat. A group chat takes text only, so a project with a folder cannot have one. --mode yolo changes that: each request of the bot in the chat gets a yes with no question, but for one that leaves the sandbox. The command shows the project, its folder and the bot first, and asks; with no terminal it needs --yes. The block is printed on standard error with --yes and with --json too. The modes default and plan ask nothing.",
        async run(context) {
          const ref = one(context, "Name the project (its name or id).");
          if (!context.options.bot?.length) throw usage("Name a bot with --bot <bot>.");
          const options = { bots: context.options.bot, ...(context.options.folder && { folder: context.options.folder }), ...(context.options.mode !== undefined && { mode: context.options.mode }) };
          if ((context.options.mode ?? (await context.client.call("projects.get", ref)).mode) === "yolo") {
            // What the mode gives is shown first, with --yes and with --json too: the caller's own record has it.
            const found = await context.client.call("projects.get", ref);
            const bots = [];
            for (const name of context.options.bot) bots.push(await context.client.call("bots.get", name));
            const names = [...new Map(bots.map((entry) => [entry.id, entry])).values()].map((entry) => safe(entry.name));
            show(context, ["This opens a chat in the mode yolo.", "Project: " + safe(found.name) + (found.folder ? ", folder " + JSON.stringify(safe(options.folder ?? found.folder)) : ", with no folder (a project with no folder opens its chats in the mode default)") + ".", (names.length === 1 ? "Bot: " : "Bots: ") + names.join(", ") + ".", "Each request of the bot in this chat gets a yes with no question, but for one that leaves the sandbox."].join("\n"));
            if (!(await confirm(context, "Open the chat in the mode yolo?"))) return EXIT.failed;
            options.agreed = true;
          }
          const opened = await context.client.call("projects.chat", ref, options);
          context.print(opened, (chat) => {
            const first = chat.bots[0].name;
            return ["Opened the chat " + chat.chatId + " in " + safe(chat.project.name) + " with " + chat.bots.map((entry) => safe(entry.name)).join(", ") + ". Mode: " + chat.mode + (chat.folder ? ". Its tools work in the folder " + JSON.stringify(safe(chat.folder)) : "") + ".", "Nothing is sent yet. To send the first message, which starts a turn of the model, run:", "  botkins chat " + word(first, "<the bot>") + " --chat " + chat.chatId + " -m <message>"].join("\n");
          });
        },
      },
    },
  },

  todos: {
    summary: "The to-do list of a project",
    details: "Each project keeps its own list. A to-do is its id, its words, or its number in `botkins todos list <project>` (1 is the first).",
    commands: {
      list: {
        summary: "List a project's to-dos, in order",
        usage: "botkins todos list <project>",
        async run(context) {
          context.print(await context.client.call("todos.list", one(context, "Name the project (its name or id).")), (found) => (found.todos.length ? todoTable(found.todos) : "No to-dos in " + safe(found.project.name) + ". Add one with `botkins todos add`."));
        },
      },
      add: {
        summary: "Add a to-do to a project",
        usage: "botkins todos add <project> [<text>…] [--file <path>]",
        options: { file: { type: "string", value: "path", about: "The to-do's words from a file (\"-\" reads standard input)" } },
        arguments: [{ name: "project", required: true }, { name: "text", required: false, many: true }],
        details: "The words are one text of 1 to 500 characters. A word that starts with a dash goes after `--`.",
        async run(context) {
          if (!context.args.length) throw usage("Name the project (its name or id), then give the to-do.");
          const words = await wordsOrFile(context, 1, "to-do");
          if (!words) throw usage("Give the to-do's words, or --file <path>.");
          context.print(await context.client.call("todos.add", context.args[0], words), (done) => "Added to-do " + done.todo.position + " to " + safe(done.project.name) + ".");
        },
      },
      edit: {
        summary: "Change a to-do's words, or mark it done or open",
        usage: "botkins todos edit <project> <todo> [<text>…] [--file <path>] [--done] [--open]",
        options: { file: { type: "string", value: "path", about: "The new words from a file (\"-\" reads standard input)" }, done: { type: "boolean", about: "Mark the to-do done" }, open: { type: "boolean", about: "Mark the to-do open again" } },
        arguments: [{ name: "project", required: true }, { name: "todo", required: true }, { name: "text", required: false, many: true }],
        async run(context) {
          if (context.args.length < 2) throw usage("Name the project, then the to-do (its id, its words or its number).");
          if (context.options.done && context.options.open) throw usage("Give --done or --open, not both.");
          const words = await wordsOrFile(context, 2, "to-do");
          const patch = { ...(words && { text: words }), ...(context.options.done && { done: true }), ...(context.options.open && { done: false }) };
          if (!Object.keys(patch).length) throw usage("Give the new words, --done or --open.");
          context.print(await context.client.call("todos.edit", context.args[0], context.args[1], patch), (done) => "Changed to-do " + done.todo.position + " of " + safe(done.project.name) + ".");
        },
      },
      done: {
        summary: "Mark a to-do done",
        usage: "botkins todos done <project> <todo>",
        arguments: [{ name: "project", required: true }, { name: "todo", required: true }],
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the to-do (its id, its words or its number).");
          context.print(await context.client.call("todos.edit", context.args[0], context.args[1], { done: true }), (done) => "To-do " + done.todo.position + " of " + safe(done.project.name) + " is done.");
        },
      },
      reopen: {
        summary: "Mark a to-do open again",
        usage: "botkins todos reopen <project> <todo>",
        arguments: [{ name: "project", required: true }, { name: "todo", required: true }],
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the to-do (its id, its words or its number).");
          context.print(await context.client.call("todos.edit", context.args[0], context.args[1], { done: false }), (done) => "To-do " + done.todo.position + " of " + safe(done.project.name) + " is open again.");
        },
      },
      move: {
        summary: "Move a to-do one place up or down",
        usage: "botkins todos move <project> <todo> (--up | --down)",
        options: { up: { type: "boolean", about: "One place up" }, down: { type: "boolean", about: "One place down" } },
        arguments: [{ name: "project", required: true }, { name: "todo", required: true }],
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the to-do (its id, its words or its number).");
          if (!!context.options.up === !!context.options.down) throw usage("Give --up or --down.");
          context.print(await context.client.call("todos.move", context.args[0], context.args[1], context.options.up ? -1 : 1), (done) => todoTable(done.todos));
        },
      },
      remove: {
        summary: "Delete a to-do",
        usage: "botkins todos remove <project> <todo> [--yes]",
        options: YES,
        arguments: [{ name: "project", required: true }, { name: "todo", required: true }],
        details: "A deleted to-do is gone. It asks first; with no terminal it needs --yes.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the project, then the to-do (its id, its words or its number).");
          const found = await context.client.call("todos.get", context.args[0], context.args[1]);
          show(context, "This deletes the to-do " + JSON.stringify(safe(found.todo.text)) + " from " + safe(found.project.name) + ".");
          if (!(await confirm(context, "Delete it?"))) return EXIT.failed;
          context.print(await context.client.call("todos.remove", found.project.id, found.todo.id), (done) => "Deleted the to-do from " + safe(done.project.name) + ".");
        },
      },
    },
  },

  tasks: {
    summary: "The task board: work that a bot does, and that you review",
    details: "A task has a title, details, a bot and a priority. It moves between lanes: later, ready, working, review, blocked and done (archived is out of sight). Only Botkins puts a task in working. A task that is Ready and has a bot starts by itself when the bot is free, and a task that finishes waits in review for you.",
    commands: {
      list: {
        summary: "List the tasks",
        usage: "botkins tasks list [--status <lane>] [--bot <bot>]",
        options: { status: { type: "string", value: "lane", about: "Only the tasks in this lane" }, bot: { type: "string", value: "bot", about: "Only the tasks of this bot" } },
        async run(context) {
          const options = { ...(context.options.status !== undefined && { status: context.options.status }), ...(context.options.bot !== undefined && { bot: context.options.bot }) };
          context.print(await context.client.call("tasks.list", options), (list) => (list.length ? table(["TITLE", "STATUS", "PRIORITY", "BOT", "ID"], list.map((t) => [safe(t.title), t.status, t.priority, t.bot ? safe(t.bot) : "", t.id])) : "No tasks. Add one with `botkins tasks add`."));
        },
      },
      show: {
        summary: "Show one task, with its result or its problem",
        usage: "botkins tasks show <task>",
        async run(context) {
          context.print(await context.client.call("tasks.get", one(context, "Name the task (its title or id).")), taskText);
        },
      },
      add: {
        summary: "Add a task",
        usage: "botkins tasks add <title>… [--details <text>] [--details-file <path>] [--bot <bot>] [--priority <priority>] [--status <lane>] [--yes]",
        options: { ...YES, details: { type: "string", value: "text", about: "What the task is, in more words (8000 characters at most)" }, "details-file": { type: "string", value: "path", about: "The details from a file (\"-\" reads standard input)" }, bot: { type: "string", value: "bot", about: "The bot that does it" }, priority: { type: "string", value: "priority", about: "low, normal (the default), high or urgent" }, status: { type: "string", value: "lane", about: "later (the default) or ready" } },
        arguments: [{ name: "title", required: true, many: true }],
        details: "A task with --status ready and a bot starts by itself when the bot is free: a turn of the bot's model, in a chat of its own. Without --status, it waits in Later. A task whose details (else its title) are `/name words` of a script command runs that script with no model: the command, its words and its script are shown and you are asked first (with no terminal it needs --yes).",
        async run(context) {
          const title = context.args.join(" ");
          if (!title) throw usage("Give the task a title.");
          const o = context.options;
          const details = await longText(context, "details", "details");
          const data = { title, ...(details !== undefined && { details }), ...(o.bot !== undefined && { bot: o.bot }), ...(o.priority !== undefined && { priority: o.priority }), ...(o.status !== undefined && { status: o.status }) };
          const added = await withScriptYes(context, (marks) => context.client.call("tasks.add", data, ...marks));
          if (added === undefined) return EXIT.failed;
          context.print(added, (t) => "Added the task " + safe(t.title) + " (" + t.status + (t.bot ? ", for " + safe(t.bot) : "") + ")." + (t.status === "ready" && t.bot ? " It starts by itself when " + safe(t.bot) + " is free: a turn of the bot's model." : ""));
        },
      },
      edit: {
        summary: "Change a task's title, details, bot or priority",
        usage: "botkins tasks edit <task> [--title <text>] [--details <text>] [--details-file <path>] [--bot <bot>] [--no-bot] [--priority <priority>] [--yes]",
        options: { ...YES, title: { type: "string", value: "text", about: "A new title" }, details: { type: "string", value: "text", about: "New details" }, "details-file": { type: "string", value: "path", about: "New details from a file (\"-\" reads standard input)" }, bot: { type: "string", value: "bot", about: "The bot that does it" }, "no-bot": { type: "boolean", about: "Give the task to no bot" }, priority: { type: "string", value: "priority", about: PRIORITIES.replaceAll(" or ", ", ") } },
        details: "Only what you name changes. A task that is working cannot be changed: wait until it stops. Giving a Ready task a bot makes it start by itself when the bot is free. A task that is a script command (`/name words`) asks first, as `tasks add` does.",
        async run(context) {
          const ref = one(context, "Name the task (its title or id).");
          const o = context.options;
          if (o.bot !== undefined && o["no-bot"]) throw usage("Give --bot or --no-bot, not both.");
          const details = await longText(context, "details", "details");
          const patch = { ...(o.title !== undefined && { title: o.title }), ...(details !== undefined && { details }), ...(o.bot !== undefined && { bot: o.bot }), ...(o["no-bot"] && { bot: null }), ...(o.priority !== undefined && { priority: o.priority }) };
          if (!Object.keys(patch).length) throw usage("Give what to change: --title, --details, --bot, --no-bot or --priority.");
          const changed = await withScriptYes(context, (marks) => context.client.call("tasks.edit", ref, patch, ...marks));
          if (changed === undefined) return EXIT.failed;
          context.print(changed, (t) => "Changed the task " + safe(t.title) + "." + (t.status === "ready" && t.bot ? " It is Ready, so it starts by itself when " + safe(t.bot) + " is free." : ""));
        },
      },
      move: {
        summary: "Move a task to a lane",
        usage: "botkins tasks move <task> <lane> [--yes]",
        options: YES,
        arguments: [{ name: "task", required: true }, { name: "lane", required: true }],
        details: "The lanes are " + LANES + ". A task is never moved to working: it gets there by itself when it is Ready, has a bot, and the bot is free (or with `botkins tasks start`). A task that is working cannot be moved. Moving a task that is a script command (`/name words`) to ready asks first.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the task, then the lane: " + LANES + ".");
          const moved = await withScriptYes(context, (marks) => context.client.call("tasks.move", context.args[0], context.args[1], ...marks));
          if (moved === undefined) return EXIT.failed;
          context.print(moved, (t) => "The task " + safe(t.title) + " is now " + t.status + "." + (t.status === "ready" && t.bot ? " It starts by itself when " + safe(t.bot) + " is free: a turn of the bot's model." : t.status === "ready" ? " It has no bot yet. Give it one with `botkins tasks edit " + word(t.title, "<the task>") + " --bot <bot>`." : ""));
        },
      },
      start: {
        summary: "Start a task now: a turn of its bot's model",
        usage: "botkins tasks start <task> [--yes]",
        options: YES,
        details: "This starts a turn of the model of the task's bot now, in a chat of its own. A model turn can cost money. The bot reads the task and works on it with its tools. A tool that needs an approval waits for a person. When the reply ends, the task moves to review. The task needs a bot. A task that is working already is left as it is.",
        async run(context) {
          const ref = one(context, "Name the task (its title or id).");
          const before = await context.client.call("tasks.get", ref);
          if (!before.bot) throw new CliError("The task " + safe(before.title) + " has no bot. Give it one with `botkins tasks edit " + word(before.title, "<the task>") + " --bot <bot>`.");
          if (before.status !== "working") show(context, "This starts a turn of the model of " + safe(before.bot) + " on the task " + safe(before.title) + ", now. The bot works on it with its tools.");
          const started = await withScriptYes(context, (marks) => context.client.call("tasks.start", before.id, ...marks));
          if (started === undefined) return EXIT.failed;
          context.print(started, (t) => (t.already ? "The task " + safe(t.title) + " is working already." : "Started the task " + safe(t.title) + ". Follow it with `botkins tasks show " + word(t.title, "<the task>") + "`."));
        },
      },
      remove: {
        summary: "Delete a task",
        usage: "botkins tasks remove <task> [--yes]",
        options: YES,
        details: "A deleted task is gone, with its result. Its chat stays. A task that is working cannot be deleted. It asks first; with no terminal it needs --yes.",
        async run(context) {
          const found = await context.client.call("tasks.get", one(context, "Name the task (its title or id)."));
          show(context, "This deletes the task " + safe(found.title) + " (" + found.status + ").");
          if (!(await confirm(context, "Delete the task?"))) return EXIT.failed;
          context.print(await context.client.call("tasks.remove", found.id), (gone) => "Deleted the task " + safe(gone.title) + ".");
        },
      },
    },
  },

  artifacts: {
    summary: "Artifacts: the files that bots made or showed",
    details: "Each bot keeps a list of the files it made or showed in its chats. `list` shows them, `read` prints a text one or saves any one, and `resolve` finds the artifacts that some paths of a chat name.",
    commands: {
      list: {
        summary: "List the artifacts of a bot",
        usage: "botkins artifacts list --bot <bot> [--chat <id>] [--kind <kind>] [--folder <artifact>] [--cursor <text>]",
        options: { bot: { type: "string", value: "bot", about: "The bot (name or id)" }, chat: { type: "string", value: "id", about: "Only the artifacts of this chat" }, kind: { type: "string", value: "kind", about: "files or media" }, folder: { type: "string", value: "artifact", about: "The contents of this folder artifact (its id)" }, cursor: { type: "string", value: "text", about: "The cursor that the last page gave, for the next page" } },
        details: "A page holds 50, newest first. When there is more, the text says the command for the next page, and --json has `nextCursor`.",
        async run(context) {
          const o = context.options;
          if (o.bot === undefined) throw usage("Name the bot with --bot <bot> (see `botkins bots list`).");
          const page = await context.client.call("artifacts.list", { bot: o.bot, ...(o.chat !== undefined && { chat: o.chat }), ...(o.kind !== undefined && { kind: o.kind }), ...(o.folder !== undefined && { folder: o.folder }), ...(o.cursor !== undefined && { cursor: o.cursor }) });
          context.print(page, (found) => [found.items.length ? artifactTable(found.items) : "No artifacts.", ...(found.nextCursor ? ["More: run this again with --cursor " + shellWord(found.nextCursor, "<the cursor>")] : [])].join("\n"));
        },
      },
      read: {
        summary: "Print a text artifact, or save any artifact to a file",
        usage: "botkins artifacts read <artifact> [--output <path>] [--yes]",
        options: { output: { type: "string", short: "o", value: "path", about: "Save the content to this file. It is needed for an artifact that is not text" }, ...YES },
        details: "The artifact is its id, or its full path. A text artifact (a type of text, JSON, XML and the like) is printed to standard output. At a terminal it is made safe to show; in a pipe it is exact. With --json the text is the `text` field. An artifact that is not text (an image, a PDF, a program) is never printed: it is saved with --output <path>. A file that is there already is replaced only after a yes (--yes with no terminal). The file is written whole, or not at all.",
        async run(context) {
          const id = one(context, "Name the artifact (its id or full path).");
          const { client } = context;
          const out = context.options.output === undefined ? null : resolve(context.options.output);
          let offset = 0;
          let artifact;
          let decoder;
          let temp;
          let fd;
          let bytes = 0;
          const chunks = [];
          try {
            for (;;) {
              const part = await client.call("artifacts.read", id, { offset });
              if (!artifact) {
                artifact = part.artifact;
                if (artifact.kind === "folder") throw new CliError("The artifact " + artifactName(artifact) + " is a folder. List what is in it with `botkins artifacts list --bot " + word(artifact.botId, "<the bot>") + " --folder " + word(artifact.id, "<its id>") + "`.");
                if (out) {
                  if (existsSync(out) && !(await confirm(context, "The file " + out + " is there already. Replace it?"))) return EXIT.failed;
                  const partial = join(dirname(out), "." + String(artifact.name ?? "artifact").replace(/[^\w.-]/g, "_").slice(0, 40) + "." + process.pid + ".part");
                  fd = openSync(partial, "wx", 0o644);
                  temp = partial;
                } else {
                  if (!isText(artifact.mime)) throw usage("The artifact " + artifactName(artifact) + " is " + artifact.mime + ", not text, so it is not printed. Save it with --output <path>.");
                  decoder = new StringDecoder("utf8");
                }
              }
              const data = Buffer.from(part.data, "base64");
              bytes += data.length;
              if (fd !== undefined) writeSync(fd, data);
              else if (context.json) {
                if (bytes > MAX_JSON_TEXT) throw new CliError("The artifact is longer than 8 MB, which is too long for --json. Save it with --output <path>.");
                chunks.push(decoder.write(data));
              } else {
                const piece = decoder.write(data);
                context.stdout.write(context.stdout.isTTY ? safeLines(piece) : piece);
              }
              if (part.nextOffset === null || part.nextOffset === undefined) break;
              offset = part.nextOffset;
            }
            if (fd !== undefined) {
              closeSync(fd);
              fd = undefined;
              renameSync(temp, out);
              temp = undefined;
              return void context.print({ artifact, output: out, bytes }, () => "Saved " + artifactName(artifact) + " (" + size(bytes) + ") to " + out + ".");
            }
            const rest = decoder.end();
            if (context.json) context.print({ artifact, text: chunks.join("") + rest });
            else if (rest) context.stdout.write(context.stdout.isTTY ? safeLines(rest) : rest);
          } finally {
            if (fd !== undefined) closeSync(fd);
            if (temp) unlinkSync(temp);
          }
        },
      },
      resolve: {
        summary: "Find the artifacts that some paths of a chat name",
        usage: "botkins artifacts resolve <chat> <path>…",
        arguments: [{ name: "chat", required: true }, { name: "path", required: true, many: true }],
        details: "Up to 20 full paths. A path that is not an artifact of the chat's bots is shown as none. The answer is in the order given.",
        async run(context) {
          const [chat, ...paths] = context.args;
          if (!chat || !paths.length) throw usage("Give the chat's id, then one or more full paths.");
          const found = await context.client.call("artifacts.resolve", chat, paths);
          context.print(found, (answer) => table(["PATH", "ARTIFACT", "ID"], answer.items.map((item, index) => [safe(paths[index]), item ? artifactName(item) : "none", item?.id ?? ""])));
        },
      },
    },
  },
};

/** The text of `projects changes`. */
function changesText(found) {
  if (!found.repo) return "The folder of " + safe(found.project.name) + " is not a git repository.";
  const lines = [safe(found.project.name) + ": " + JSON.stringify(safe(found.folder)), "Branch " + safe(found.branch) + (found.upstream ? " (" + safe(found.upstream) + (found.ahead ? ", " + found.ahead + " ahead" : "") + (found.behind ? ", " + found.behind + " behind" : "") + ")" : "")];
  if (!found.files.length) return [...lines, "No changes."].join("\n");
  const taken = found.files.filter((file) => file.commit).length;
  return [...lines, count(found.files.length, "changed file") + ", +" + found.added + " -" + found.removed + ". A commit takes " + taken + ".", "", table(["FILE", "KIND", "STAGED", "LINES", "IN A COMMIT"], found.files.map((file) => [safe(file.path), file.kind, file.staged ? "yes" : "", "+" + file.added + " -" + file.removed, file.commit ? "yes" : "no (outside the project's folder)"]))].join("\n");
}
