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
//   - Only the computer's owner creates or runs one. A turn that runs for nobody (a routine, a
//     reaction, a panel refresh, a task) and a team member's turn do not run one.
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
  "btw", "ask", "help", "model", "models", "permissions", "allow-all", "reset-allowed-tools", "compact", "config", "settings", "theme",
  "new", "clear", "agent", "agents", "resume", "login", "user", "version", "search", "copy", "tasks", "instructions", "lsp",
  "init", "review", "plan", "diff", "context", "usage", "mcp", "skills", "plugin", "plugins", "exit", "quit", "fleet", "delegate",
  "share", "session", "sessions", "rename", "rewind", "undo", "cwd", "add-dir", "env", "feedback", "experimental", "ide", "yolo",
  "tool", "tools", "memory", "status", "cost", "logout", "terminal-setup", "keybindings", "list-dirs", "streamer-mode",
]);

export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The SHA-256 of a script, as hex. */
export const hashScript = (script) => createHash("sha256").update(String(script)).digest("hex");

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
    env: { ...process.env, BOTKINS_COMMAND: command.name, BOTKINS_ARGS: args, BOTKINS_CHAT_ID: chat.id },
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
  chat.messages.push({ role: "command", plain: true, time: Date.now(), runId: run.id, text: scriptReply(command.name, result).slice(0, 128000) });
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
        "Give a name that is not a command already (lowercase letters, numbers and dashes). Using the name of an existing script command proposes a change to it. Never put a secret in the script.",
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
        const decision = await ws.interactions.request(chat, task, {
          botId: bot.id,
          kind: "permission",
          title: (existing ? "Change the script command /" : "Add the script command /") + fields.name + "?",
          detail:
            "This script runs on this computer, with your account's access, each time you type /" + fields.name + " in a chat. No model reads it or runs it. It has no time limit; Stop ends it.\n\n" +
            "Command: /" + fields.name + "\nFor: " + shownText(fields.description) + "\nRuns in: the chat's project folder, or the bot's own folder\n\nScript:\n" + shownScript(fields.script),
        });
        active();
        if (decision.action !== "approve") return REFUSED;
        ws.integrations.saveScriptCommand({ ...fields, ...(existing && { original: existing.name }) });
        return "Saved. The person can now type /" + fields.name + " in any chat.";
      },
    }),
  ];
}
