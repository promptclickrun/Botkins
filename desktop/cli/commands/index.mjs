// Every command, as a tree: `botkins devices rename` is COMMANDS.devices.commands.rename.
// A command is { summary, usage, options?, details?, run(context) }; a group has `commands`.
import { service } from "./service.mjs";
import { link } from "./link.mjs";
import { workspace } from "./workspace.mjs";
import { settings } from "./settings.mjs";
import { install } from "./install.mjs";
import { tui } from "./tui.mjs";
import { botTools, tools } from "./tools.mjs";
import { pluginCommands } from "./plugins.mjs";

export const COMMANDS = { ...service, ...tui, ...install, ...link, ...workspace, ...tools, ...settings };
// What one bot has of the tools and skills is said under the bot: `botkins bots tools <bot>`.
Object.assign(COMMANDS.bots.commands, botTools);
// Plugins: to install, update and switch one on is to look at it first (cli/commands/plugins.mjs).
Object.assign(COMMANDS.plugins.commands, pluginCommands);

/** The command the leading words name, and those words: { command, path }, or null. */
export function find(words) {
  let command = { commands: COMMANDS };
  const path = [];
  for (const word of words) {
    const next = command.commands?.[word];
    if (!next) break;
    command = next;
    path.push(word);
  }
  return path.length ? { command, path } : null;
}

const GLOBAL_HELP = ["  --json             Print one JSON document (a JSON line for each item of a stream)", "  --data-dir <dir>   The data folder of the service to talk to (or BOTKINS_DATA_DIR)", "  --socket <path>    Its control socket, when it is not in the data folder", "  -h, --help         Explain a command"];

/** The help for one command or group, or for everything. */
export function help(found) {
  if (!found) {
    const lines = ["Botkins on this computer, from a terminal.", "", "Usage: botkins <command> [options]", ""];
    const names = Object.keys(COMMANDS).filter((name) => !COMMANDS[name].hidden);
    const pad = Math.max(...names.map((name) => name.length)) + 2;
    for (const name of names) lines.push("  " + name.padEnd(pad) + COMMANDS[name].summary);
    lines.push("", "Every command:", ...GLOBAL_HELP, "", "`botkins help <command>` explains one. The guide is desktop/docs/terminal.md.");
    return lines.join("\n");
  }
  const { command, path } = found;
  const name = "botkins " + path.join(" ");
  const lines = [command.summary, ""];
  if (command.commands) {
    lines.push("Usage: " + name + " <command>", "");
    const names = Object.keys(command.commands);
    const pad = Math.max(...names.map((sub) => sub.length)) + 2;
    for (const sub of names) lines.push("  " + sub.padEnd(pad) + command.commands[sub].summary);
  } else {
    lines.push("Usage: " + (command.usage ?? name));
    const options = Object.entries(command.options ?? {});
    if (options.length) {
      lines.push("", "Options:");
      const shown = options.map(([option, spec]) => [(spec.short ? "-" + spec.short + ", " : "") + "--" + option + (spec.type === "string" ? " <" + (spec.value ?? "value") + ">" : ""), spec.about ?? ""]);
      const pad = Math.max(...shown.map(([flag]) => flag.length)) + 2;
      for (const [flag, about] of shown) lines.push("  " + flag.padEnd(pad) + about);
    }
  }
  if (command.details) lines.push("", command.details);
  lines.push("", "Every command:", ...GLOBAL_HELP);
  return lines.join("\n");
}

/** The words a command takes after its name, read from its usage line: `<bot>` is needed, `[<search>]` may be left out, `…` means more than one. */
export function argumentsOf(usage, path) {
  const after = String(usage ?? "").replace("botkins " + path.join(" "), "");
  // Options are in brackets that start with a dash ("[--role <text>]", "[-m <message>]", "[--system | --user]"); what they take is not a word of its own.
  // So is a value that stands straight after its option, in a choice between two ("(--command <program> | --url <address>)").
  const words = after.replace(/\[-[^\]]*\]…?/g, " ").replace(/-{1,2}[A-Za-z][A-Za-z0-9-]* <[^>]+>…?/g, " ");
  return [...words.matchAll(/(\[)?<([^>]+)>(…)?\]?(…)?/g)].map(([, optional, name, many, more]) => ({ name, required: !optional, ...((many || more) && { many: true }) }));
}

const EXITS = [
  { code: 0, means: "Done." },
  { code: 1, means: "It failed. With --json the reason is { error: { message, code? } } on standard output; otherwise a sentence on standard error." },
  { code: 2, means: "The command was not understood: an unknown word, a missing value, or a question that needs a flag because there is no terminal to ask at." },
  { code: 3, means: "The service is not running." },
  { code: 4, means: "This user may not talk to the service." },
];

/**
 * Every command as data, for a program that has to find one without reading the source
 * (`botkins help --json`). The shape is kept: fields are added, never renamed or removed.
 *
 *   { botkins, usage, everyCommand: [option…], exit: [{ code, means }…],
 *     areas: [{ name, summary, commands: [{ command, path, summary, usage, arguments, options, details? }…] }…] }
 *
 * An option is { name: "--role", short?: "-r", takes: "text" | null, about }. `takes: null` is a
 * switch. An argument is { name, required, many? }. A command with `asks` puts a question to the
 * person at a terminal; with no terminal it fails and names the flag that answers it.
 */
export function describe(version, global = {}) {
  const option = ([name, spec]) => ({ name: "--" + name, ...(spec.short && { short: "-" + spec.short }), takes: spec.type === "string" ? (spec.value ?? "value") : null, about: spec.about ?? "", ...(spec.multiple && { many: true }), ...(spec.secret && { secret: true }) });
  const leaf = (command, path) => ({
    command: path.join(" "),
    path,
    summary: command.summary,
    usage: command.usage ?? "botkins " + path.join(" "),
    arguments: command.arguments ?? argumentsOf(command.usage, path),
    options: Object.entries(command.options ?? {}).map(option),
    // A command with --yes asks a person first. With no terminal it fails and names that flag.
    ...((command.asks || command.options?.yes) && { asks: command.asks ?? "--yes" }),
    ...(command.details && { details: command.details }),
  });
  const walk = (command, path) => (command.commands ? Object.entries(command.commands).filter(([, sub]) => !sub.hidden).flatMap(([name, sub]) => walk(sub, [...path, name])) : [leaf(command, path)]);
  return {
    botkins: version,
    usage: "botkins <command> [options]",
    everyCommand: Object.entries(global).filter(([name]) => name !== "help" && name !== "version").map(option),
    exit: EXITS,
    areas: Object.entries(COMMANDS).filter(([, command]) => !command.hidden).map(([name, command]) => ({ name, summary: command.summary, commands: walk(command, [name]) })),
  };
}
