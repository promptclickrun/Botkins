// Script commands: a slash command that runs a script on this computer, with no model.
//
// A script command is a skill that Botkins keeps in <data>/skills/<name>/ (desktop/integrations.mjs):
//   SKILL.md   with the header `command: script` and `disable-model-invocation: true`, so that a
//              model is never offered it as a skill
//   run        the script itself (a shell script in the person's login shell; PowerShell on Windows)
// Typing `/<name> some words` in a chat runs the script, in the chat's project folder or else the
// bot's own folder. The words after the name are never part of the command: the script gets them
// whole as $BOTKINS_ARGS and on standard input, with $BOTKINS_COMMAND and $BOTKINS_CHAT_ID. What
// it prints (the last 12,000 characters) and its exit code come back as the chat's reply. Nothing
// is sent to a model, and no session is opened.
//
// Trust. A script command runs code, so the person has to have seen the code:
//   - Only a skill in Botkins' own folder can be one, and only if Botkins saved it as one. The
//     workspace file holds each one's name and the SHA-256 of its script (state.skills.scripts).
//     A folder that was linked or imported, or a script that was changed on disk by anything but
//     Botkins, is not run: it shows in Settings as "changed outside Botkins".
//   - A person saves one in Settings or on the phone, or with `botkins skills add-script`, which
//     shows the whole script first and needs a yes. A bot proposes one with `script_command_create`:
//     a card shows the whole script and nothing is written until the person approves.
//   - Only the computer's owner creates, changes or removes one. Running one needs the right to use
//     skills (a team role's "use" of skills; the owner has it): a team member's chat runs it as the
//     computer's user, as the owner's does. A routine run or a task whose prompt is `/<name> words`
//     runs it too, with the same checks; a reaction, a panel refresh and a proactive check do not.
//     A bot that makes or changes a routine or a task that invokes one asks the person first (below).
// A script command has no time limit: the person can press Stop (desktop/AGENTS.md).
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { defineTool } from "./providers/provider.mjs";
import { SCRIPT_LENGTH, SCRIPT_OUTPUT, runScript } from "./routine-script.mjs";
import { shownText } from "./shown-text.mjs";

/** The script's file in the command's folder. */
export const SCRIPT_FILE = "run";
/** The header value that makes a skill a script command. */
export const SCRIPT_KIND = "script";
export const SCRIPT_COMMANDS_CAPABILITY = "script-commands-v1";
export { SCRIPT_LENGTH };

/**
 * Names that a script command can't take: Botkins' own commands, and the ones that model providers
 * have. A command that a provider answers is in the "/" menu already and wins on a clash. The list
 * can't know every command of every provider, so the menu also leaves out a script command whose
 * name a session's own menu has (workspace.catalog), and typing it then does the provider's.
 * test/script-commands.test.mjs holds the list to Botkins' own command tables.
 */
export const RESERVED_COMMANDS = new Set([
  "btw", "ask", "help", "model", "models", "permissions", "allow-all", "reset-allowed-tools", "reload-tools", "compact", "config", "settings", "theme",
  "new", "clear", "agent", "agents", "resume", "login", "user", "version", "search", "copy", "tasks", "instructions", "lsp",
  "init", "review", "plan", "diff", "context", "usage", "mcp", "skills", "plugin", "plugins", "exit", "quit", "fleet", "delegate",
  "share", "session", "sessions", "rename", "rewind", "undo", "cwd", "add-dir", "env", "feedback", "experimental", "ide", "yolo",
  "tool", "tools", "memory", "status", "cost", "logout", "terminal-setup", "keybindings", "list-dirs", "streamer-mode",
]);

export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The SHA-256 of a script, as hex. */
export const hashScript = (script) => createHash("sha256").update(String(script)).digest("hex");

/**
 * The revision that a yes is for: a hash of the command's cleaned name, description and script. The command line
 * prints it with the script, and the socket saves nothing unless the caller names this exact one
 * (`botkins skills add-script --yes --revision <it>`), so a yes is for the script that was shown.
 */
export const scriptRevision = (fields) => {
  const { name, description, script } = cleanScriptCommand(fields);
  // `original` (the command that this one replaces, when it replaces one) is part of what the yes is for: a yes for a new /deploy
  // can't be used to overwrite another command, and a yes for a change of one can't be used for another.
  const original = typeof fields.original === "string" && fields.original.trim() ? fields.original.trim() : null;
  return createHash("sha256").update(JSON.stringify(["script-command-v1", name, description, script, original])).digest("hex");
};

/** The names (lower case) that a menu's choices take: commands and skills, with their aliases. A tool takes none: it is called as `tool:<name>`. */
export const commandNames = (choices) =>
  new Set((choices ?? []).filter((c) => c?.kind !== "Tool" && c?.source !== "Script").flatMap((c) => [c.name, c.command, ...(c.aliases ?? [])]).filter((word) => typeof word === "string").map((word) => word.replace(/^\//, "").toLowerCase()));

// What a script is not handed from Botkins' own environment: anything that looks like a secret, and every BOTKINS_ value
// but the two that say where Botkins is (a script may run `botkins`). The person's login shell still reads their own profile.
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|COOKIE|BEARER|AUTH(ORIZATION)?|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|SECRET_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|SESSION_?KEY|KEYCHAIN)S?($|_)|^NPM_CONFIG__AUTH$|_KEY$/i;
const KEEP_BOTKINS = new Set(["BOTKINS_SOCKET", "BOTKINS_DATA_DIR"]);
// A path to the person's ssh agent is not a key (a script that runs git over ssh needs it).
const KEEP_NAMES = new Set(["SSH_AUTH_SOCK"]);
export function scrubbedEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => typeof value === "string" && (name.startsWith("BOTKINS_") ? KEEP_BOTKINS.has(name) : KEEP_NAMES.has(name) || !SECRET_NAME.test(name))),
  );
}

/** The value of `command:` in a SKILL.md header, lower case; "" when there is none. */
export function commandKind(source) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(source));
  const line = header && /^command:[ \t]*(.*)$/im.exec(header[1]);
  return line ? line[1].trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase() : "";
}

/** The SKILL.md of a script command. Its words say what it is, for a person who opens the folder. */
export const scriptSkillFile = ({ name, description }) =>
  "---\nname: " + name + "\ndescription: " + JSON.stringify(description) + "\ncommand: " + SCRIPT_KIND + "\ndisable-model-invocation: true\n---\n\n" +
  "A script command. Typing /" + name + " in a chat runs the file `" + SCRIPT_FILE + "` in this folder on this computer, with no model.\n" +
  "The words typed after the name are in $BOTKINS_ARGS and on standard input. Change it in Botkins: Settings, Skills.\n";

/** A script as a person is shown it: each line safe to read (shown-text.mjs), a tab as four spaces, never cut. */
export const shownScript = (script) =>
  String(script)
    .split(/\r?\n/)
    .map((line) => shownText(line.replaceAll("\t", "    ")))
    .join("\n");

/** The name and the words of a typed `/name words`, or null when the text isn't one. */
export function matchScriptCommand(prompt) {
  const match = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/i.exec(String(prompt ?? "").trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() } : null;
}

/**
 * The script command that a text invokes (`/name words`), if Botkins keeps one of that name: { name, args }, else null. A name
 * that is reserved is a provider's command, not this. Used for what is scheduled (a routine's prompt, a task's text).
 */
export function scriptInvocation(ws, text) {
  const typed = matchScriptCommand(text);
  if (!typed || RESERVED_COMMANDS.has(typed.name)) return null;
  return ws.integrations.scriptCommands().some((command) => command.name === typed.name) ? typed : null;
}

/**
 * What already invokes the script command `name`: each routine and chat schedule whose prompt is `/name …`, and each task that is, as
 * lines for a person to read. A command that is made (or changed) arms all of these, so the card that asks says so.
 */
export function whatRuns(ws, name) {
  const invokes = (text) => matchScriptCommand(text)?.name === name;
  const lines = [];
  for (const { chat, entry } of ws.panels.routines.list()) {
    if (!entry.script && invokes(entry.prompt)) lines.push("Routine " + shownText(entry.name) + ", " + shownText(ws.panels.routines.view(chat, entry).cadence) + (entry.enabled === false ? " (paused)" : "") + ": " + shownText(String(entry.prompt).slice(0, 200)));
  }
  for (const chat of ws.state.chats) {
    for (const entry of chat.schedules ?? []) {
      if (!entry.routine && invokes(entry.prompt)) lines.push("A schedule in the chat " + shownText(chat.title ?? "") + ": " + shownText(String(entry.prompt).slice(0, 200)) + (entry.recurring ? ", repeating" : ", once"));
    }
  }
  for (const task of ws.tasks?.all ?? []) {
    if (!["done", "archived"].includes(task.status) && invokes(task.body?.trim() || task.title)) lines.push("Task " + shownText(task.title) + " (" + task.status + ")");
  }
  return lines;
}

/** What a person is told of an invocation before it may be scheduled: the command, its words, and its whole script. */
export function invocationLines(ws, { name, args }) {
  let script;
  try {
    script = ws.integrations.readScriptCommand(name).script;
  } catch (error) {
    script = null;
  }
  return [
    "This runs the script command /" + name + " on this computer, with your account's access, and no model. No model reads it or runs it.",
    "The words it gets (in $BOTKINS_ARGS and on standard input): " + (args ? JSON.stringify(shownText(args)) : "none"),
    ...(script === null ? ["Its script can't be read now."] : ["", "Its script:", shownScript(script)]),
  ];
}

/**
 * A bot asks for a routine or a task that invokes a script command: the person is shown what runs and when, in a card that is
 * read in the app (`review`: never answered from a notification, a card or a gadget), and nothing is saved until they approve.
 * Resolves true on a yes. `what` is the title, `about` the lines that say which routine or task and when.
 */
export async function askToSchedule(ws, { bot, chat, task, invocation, what, about }) {
  const decision = await ws.interactions.request(chat, task, {
    botId: bot.id,
    kind: "permission",
    review: true,
    title: what,
    detail: [...about, "", ...invocationLines(ws, invocation)].join("\n"),
  });
  return decision.action === "approve";
}

/** What a script command adds to the "/" menu: one choice, as the menu's own choices are. */
export const scriptChoice = ({ name, description }) => ({
  name,
  command: name,
  aliases: [],
  kind: "Command",
  hint: "[arguments]",
  source: "Script",
  description: String(description ?? "").split("\n")[0].slice(0, 300) || "Runs a script on this computer.",
  duringTurn: false,
});

/** The reply that a script's end becomes: its output, then one line when it did not end well. */
export function scriptReply(name, result) {
  const output = stripVTControlCharacters(result.output ?? "").replace(/\s+$/, "");
  const lines = [];
  if (output) lines.push((output.length >= SCRIPT_OUTPUT ? "(The last " + SCRIPT_OUTPUT.toLocaleString("en-US") + " characters.)\n" : "") + output);
  if (result.error) lines.push("/" + name + " could not start: " + result.error);
  else if (result.stopped) lines.push("Stopped.");
  else if (result.exitCode === null) lines.push("/" + name + " was ended" + (result.signal ? " (" + result.signal + ")." : "."));
  else if (result.exitCode !== 0) lines.push("Exit code " + result.exitCode + ".");
  if (!lines.length) lines.push("(no output)");
  return lines.join("\n\n");
}

/**
 * Runs a typed script command in a turn. The chat is busy while it runs (the window and the phone
 * show it working), Stop ends it, and the reply is a plain command message. The caller has
 * checked who may run it and has the command from `integrations.runnableScript`.
 */
export async function runScriptCommand(ws, { chat, bot, run, task, command, args }) {
  const folder = ws.projects.folderFor(chat) || join(ws.dir, "files", bot.id);
  mkdirSync(folder, { recursive: true });
  run.command = command.name;
  if (task.stopped) return;
  const script = runScript(command.script, {
    cwd: folder,
    // The person can press Stop: no time limit (desktop/AGENTS.md, "A turn is never failed for being quiet").
    timeoutMs: null,
    routine: false,
    input: args,
    env: { ...scrubbedEnvironment(process.env), BOTKINS_COMMAND: command.name, BOTKINS_ARGS: args, BOTKINS_CHAT_ID: chat.id },
  });
  // Quitting Botkins ends it, as it ends a routine's script.
  ws.panels.routines.scripts.add(script);
  task.session = { abort: async () => script.stop() };
  task.intent = "Running /" + command.name;
  ws.notify();
  const result = await script.done;
  ws.panels.routines.scripts.delete(script);
  task.session = undefined;
  // Botkins is quitting: the run is picked up again when it opens (and says it can't be run again).
  if (ws.closing) return;
  run.script = { exitCode: result.exitCode };
  const reply = scriptReply(command.name, result).slice(0, 128000);
  if (run.scheduleId == null && run.taskId == null) {
    chat.messages.push({ role: "command", plain: true, time: Date.now(), runId: run.id, text: reply });
    return;
  }
  // A routine's run or a task: its output is the run's reply, and goes where a routine's or a task's result goes (desktop/routines.mjs
  // `deliver`, desktop/tasks.mjs `finished`). A script that fails ends the run as failed, as a routine's script does. There is no
  // [SILENT] and no wakeAgent here: the output is the result.
  if (!run.noOutput) chat.messages.push({ role: "assistant", text: reply, runId: run.id, time: Date.now() });
  if (!task.stopped && (result.exitCode !== 0 || result.error)) run.scriptFailure = "/" + command.name + (result.error ? " could not start: " + result.error : result.exitCode === null ? " was ended." : " failed (exit code " + result.exitCode + ").");
}

const REFUSED = "The person declined.";

/** The checks of a script command's text, shared by every way of saving one. Returns the cleaned fields. */
export function cleanScriptCommand({ name, description, script }) {
  const id = String(name ?? "").trim().replace(/^\//, "").toLowerCase();
  if (!SCRIPT_NAME.test(id)) throw new Error("Name the command with lowercase letters, numbers and dashes.");
  if (RESERVED_COMMANDS.has(id)) throw new Error("/" + id + " is a command that Botkins or a model provider already has. Choose another name.");
  const about = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
  if (!about || about.length > 600) throw new Error("Enter a description of up to 600 characters.");
  if (typeof script !== "string" || !script.trim()) throw new Error("Enter the script.");
  if (script.length > SCRIPT_LENGTH) throw new Error("A script can have up to " + SCRIPT_LENGTH.toLocaleString("en-US") + " characters.");
  if (script.includes("\0")) throw new Error("A script can't have a null character.");
  if (typeof script.isWellFormed === "function" && !script.isWellFormed()) throw new Error("A script can't have a broken character (an unpaired surrogate).");
  return { name: id, description: about, script };
}

/**
 * The tools that let a bot see and propose script commands. A bot never writes one itself: the
 * card shows the command's name, what it is for and the whole script, and a yes writes it.
 * Only in a turn that the owner is there for.
 */
export function scriptCommandTools(ws, bot, chat, run, task) {
  if (!task || !run || chat.helper || run.scheduleId != null || run.panelId || run.taskId || run.reaction || run.recovery?.proactiveCheck) return [];
  const active = () => {
    if (task.ended || task.stopped || ws.closing || ws.active.get(chat.id) !== task) throw new Error("This turn has ended.");
  };
  const string = { type: "string" };
  return [
    defineTool("script_command_list", {
      description: "List the script commands on this computer: slash commands that run a script with no model. Each has its name, what it is for, whether it is on, and its script.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: () => {
        active();
        return JSON.stringify(
          ws.integrations.scriptCommands().slice(0, 40).map((item) => ({ name: item.name, description: item.description, enabled: item.enabled, ...(item.unavailable ? { unavailable: item.unavailable } : { script: ws.integrations.readScriptCommand(item.name).script }) })),
        );
      },
    }),
    defineTool("script_command_create", {
      description:
        "Propose a script command: a slash command that runs a script on this computer with no model, for a workflow that repeats. The person is shown the command's name and the whole script and decides; nothing is saved until they approve. " +
        "The script is a shell script (PowerShell on Windows) that runs in the chat's project folder, or in your own folder. The words typed after the command's name are in $BOTKINS_ARGS and on standard input. Print what the person should see. " +
        "Give a name that is not a command already (lowercase letters, numbers and dashes). Using the name of an existing script command proposes a change to it. Never put a secret in the script. " +
        "For a script that runs on a schedule, use routine_create with `script` (and followUp when you should write the result) instead; a routine or task whose instructions are /name words also runs this command with no model.",
      parameters: {
        type: "object",
        properties: {
          name: { ...string, description: "The command's name, such as deploy-preview (typed as /deploy-preview)." },
          description: { ...string, description: "One line that says what the command does, shown in the / menu." },
          script: { ...string, description: "The whole script (up to 20,000 characters)." },
        },
        required: ["name", "description", "script"],
        additionalProperties: false,
      },
      handler: async (args) => {
        active();
        const fields = cleanScriptCommand(args ?? {});
        const existing = ws.integrations.scriptCommands().find((item) => item.name === fields.name);
        // A name that another skill has is not taken over.
        if (!existing && ws.integrations.skills().some((skill) => skill.name === fields.name)) throw new Error("A skill named " + fields.name + " already exists. Choose another name.");
        // A name that a model provider's own command has is refused before the person is asked.
        await ws.assertScriptName(fields.name, existing?.name);
        active();
        const decision = await ws.interactions.request(chat, task, {
          botId: bot.id,
          kind: "permission",
          // The script is only in the detail: it is read in the app, never answered from a notification, a card or a gadget (desktop/link/cards.mjs).
          review: true,
          title: (existing ? "Change the script command /" : "Add the script command /") + fields.name + "?",
          detail:
            "This script runs on this computer, with your account's access, each time you type /" + fields.name + " in a chat. No model reads it or runs it. It has no time limit; Stop ends it.\n\n" +
            "Command: /" + fields.name + "\nFor: " + shownText(fields.description) + "\nRuns in: the chat's project folder, or the bot's own folder" +
            // What is already set up to type it: saving the command arms each of these.
            (whatRuns(ws, fields.name).length ? "\n\nAlso runs on (saving this makes each of these run the script):\n" + whatRuns(ws, fields.name).map((line) => "- " + line).join("\n") : "") +
            "\n\nScript:\n" + shownScript(fields.script),
        });
        active();
        if (decision.action !== "approve") return REFUSED;
        ws.integrations.saveScriptCommand({ ...fields, ...(existing && { original: existing.name }) });
        return "Saved. The person can now type /" + fields.name + " in any chat.";
      },
    }),
  ];
}
