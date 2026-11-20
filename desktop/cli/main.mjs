// Reads the command line, finds the command and runs it. Everything a command needs comes in one
// `context`, so the tests run a command with their own output, input and service.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { controlClient, ControlError } from "../desktop/terminal/socket.mjs";
import { CliError, EXIT, paint, usage } from "./output.mjs";
import { COMMANDS, find, help } from "./commands/index.mjs";

export const version = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** The options every command takes. */
export const GLOBAL = {
  json: { type: "boolean" },
  "data-dir": { type: "string" },
  socket: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
};

/**
 * @param argv  The words after `botkins`.
 * @param io    For tests: { stdout, stderr, stdin, env, client, cwd }.
 * @returns the exit code.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const env = io.env ?? process.env;
  const json = argv.includes("--json");
  const fail = (error) => {
    const exit = error instanceof CliError ? error.exit : error instanceof ControlError ? (error.code === "NOT_RUNNING" ? EXIT.notRunning : error.code === "DENIED" ? EXIT.denied : EXIT.failed) : EXIT.failed;
    const message = String(error?.message ?? error);
    if (json) stdout.write(JSON.stringify({ error: { message, ...(error?.code && { code: error.code }), ...(error?.problems && { problems: error.problems }) } }) + "\n");
    stderr.write("botkins: " + message + "\n");
    if (exit === EXIT.usage && !json) stderr.write("Run `botkins help` to see every command.\n");
    return exit;
  };
  try {
    // The command is the leading words that name one ("devices", "rename"); the rest is its own.
    // An option's value is not a word: `--data-dir /srv/botkins status` is the command "status".
    const takesValue = new Set(Object.entries(GLOBAL).filter(([, option]) => option.type === "string").map(([name]) => "--" + name));
    const words = [];
    const places = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === "--") break;
      if (argv[index].startsWith("-")) {
        if (takesValue.has(argv[index])) index++;
        continue;
      }
      words.push(argv[index]);
      places.push(index);
    }
    if (argv.includes("--version") || argv.includes("-V")) {
      stdout.write(json ? JSON.stringify({ version: version() }) + "\n" : version() + "\n");
      return EXIT.ok;
    }
    if (!words.length || words[0] === "help") {
      const about = find(words.slice(1));
      if (words.length > 1 && !about) throw usage("There is no command `botkins " + words[1] + "`.");
      stdout.write(help(about) + "\n");
      return EXIT.ok;
    }
    const found = find(words);
    if (!found) throw usage("There is no command `botkins " + words[0] + "`.");
    if (!found.command.run) {
      // A group: with --help, or with nothing after it, what it holds; with a word it doesn't know, a mistake.
      if (argv.includes("--help") || argv.includes("-h") || words.length === found.path.length) {
        stdout.write(help(found) + "\n");
        return argv.includes("--help") || argv.includes("-h") ? EXIT.ok : EXIT.usage;
      }
      throw usage("`botkins " + found.path.join(" ") + "` has no command `" + words[found.path.length] + "`. It has: " + Object.keys(found.command.commands).join(", ") + ".");
    }
    const { command, path } = found;
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout.write(help(found) + "\n");
      return EXIT.ok;
    }
    // Drop the words that named the command, wherever options stood between them.
    const named = new Set(places.slice(0, path.length));
    const rest = argv.filter((_, index) => !named.has(index));
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...command.options }, allowPositionals: true, strict: true });
    } catch (error) {
      throw usage(error.message.replace(/\. To specify.*$/s, "."));
    }
    const paths = terminalPaths({ root: parsed.values["data-dir"], socket: parsed.values.socket, env });
    const context = {
      args: parsed.positionals,
      options: parsed.values,
      json: parsed.values.json === true,
      paths,
      env,
      stdin,
      stdout,
      stderr,
      version: version(),
      color: paint(stdout, env),
      client: io.client ?? controlClient(paths.socket),
      /** Prints the value as JSON with --json; otherwise what `text` makes of it (a string, or nothing). */
      print(value, text) {
        if (context.json) stdout.write(JSON.stringify(value === undefined ? null : value) + "\n");
        else {
          const shown = typeof text === "function" ? text(value) : text;
          if (shown !== undefined && shown !== null && shown !== "") stdout.write(String(shown) + "\n");
        }
      },
      /** One line of a stream: a JSON line with --json, the text otherwise. */
      line(value, text) {
        stdout.write((context.json ? JSON.stringify(value) : text) + "\n");
      },
      note(text) {
        if (!context.json) stderr.write(text + "\n");
      },
    };
    const exit = await command.run(context);
    return Number.isInteger(exit) ? exit : EXIT.ok;
  } catch (error) {
    return fail(error);
  }
}

export { COMMANDS };
