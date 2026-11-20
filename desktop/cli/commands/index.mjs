// Every command, as a tree: `botkins devices rename` is COMMANDS.devices.commands.rename.
// A command is { summary, usage, options?, details?, run(context) }; a group has `commands`.
import { service } from "./service.mjs";
import { link } from "./link.mjs";
import { workspace } from "./workspace.mjs";
import { settings } from "./settings.mjs";

export const COMMANDS = { ...service, ...link, ...workspace, ...settings };

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
