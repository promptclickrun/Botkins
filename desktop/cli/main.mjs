// Reads the command line, finds the command and runs it. Everything a command needs comes in one
// `context`, so the tests run a command with their own output, input and service.
import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { plainText, shownText } from "../desktop/shown-text.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { controlClient, ControlError } from "../desktop/terminal/socket.mjs";
import { CliError, EXIT, paint, usage } from "./output.mjs";
import { COMMANDS, describe, find, help } from "./commands/index.mjs";

/**
 * Root becomes the user the data folder belongs to before it does anything there, so `sudo
 * botkins pair` talks to the service as the service's own user, and a file it writes while the
 * service is stopped is that user's. Only what changes the computer itself stays root: installing
 * the service, and installing an update.
 */
function asOwner(paths, path, options, env) {
  if (process.getuid?.() !== 0 || path[0] === "service" || (path[0] === "update" && !options.check)) return;
  let stat;
  try {
    stat = statSync(paths.root);
  } catch {
    return;
  }
  if (stat.uid === 0) return;
  process.setgroups?.([stat.gid]);
  process.setgid(stat.gid);
  process.setuid(stat.uid);
  const info = userInfo();
  Object.assign(env, { HOME: info.homedir, USER: info.username, LOGNAME: info.username });
}

export const version = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** The options every command takes. */
export const GLOBAL = {
  json: { type: "boolean", about: "Print one JSON document (a JSON line for each item of a stream)" },
  "data-dir": { type: "string", value: "dir", about: "The data folder of the service to talk to (or BOTKINS_DATA_DIR)" },
  socket: { type: "string", value: "path", about: "The control socket of the service to talk to" },
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
  // What follows "--" is a program's own words (`botkins tools add x --command node -- server.js --help`),
  // never Botkins' own: --json, --help and --version are looked for only before it.
  const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  const json = own.includes("--json");
  // Set once the command is known: an error under `plugins` can quote a plugin's own text.
  let pluginsCommand = false;
  const fail = (error) => {
    const exit = error instanceof CliError ? error.exit : error instanceof ControlError ? (error.code === "NOT_RUNNING" ? EXIT.notRunning : error.code === "DENIED" ? EXIT.denied : EXIT.failed) : EXIT.failed;
    const message = String(error?.message ?? error);
    if (json) stdout.write(JSON.stringify({ error: { message, ...(error?.code && { code: error.code }), ...(error?.problems && { problems: error.problems }) } }) + "\n");
    // An error under `plugins` can quote a plugin's own text (a snippet of its JSON, a file name), so it gets the wide list, as text shown for a decision. Any other error quotes the caller's own words (a bot's name), and the short list leaves an emoji or a script with joiners as it is. The --json document keeps the message as it is.
    stderr.write("botkins: " + (pluginsCommand ? shownText(message) : plainText(message)) + "\n");
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
    if (own.includes("--version") || own.includes("-V")) {
      stdout.write(json ? JSON.stringify({ version: version() }) + "\n" : version() + "\n");
      return EXIT.ok;
    }
    if (!words.length || words[0] === "help") {
      const about = find(words.slice(1));
      if (words.length > 1 && !about) throw usage("There is no command `botkins " + words[1] + "`.");
      // For a program: every command with its usage, its arguments and its options, as one document.
      // With a command or an area named, only that part of it.
      if (json) {
        const all = describe(version(), GLOBAL);
        const named = about && about.path.join(" ");
        const areas = about ? all.areas.filter((area) => area.name === about.path[0]).map((area) => ({ ...area, commands: area.commands.filter((command) => command.command === named || command.command.startsWith(named + " ")) })) : all.areas;
        stdout.write(JSON.stringify({ ...all, areas }) + "\n");
        return EXIT.ok;
      }
      stdout.write(help(about) + "\n");
      return EXIT.ok;
    }
    const found = find(words);
    if (!found) throw usage("There is no command `botkins " + words[0] + "`.");
    pluginsCommand = ["plugins", "pi"].includes(found.path[0]);
    if (!found.command.run) {
      // A group: with --help, or with nothing after it, what it holds; with a word it doesn't know, a mistake.
      if (own.includes("--help") || own.includes("-h") || words.length === found.path.length) {
        stdout.write(help(found) + "\n");
        return own.includes("--help") || own.includes("-h") ? EXIT.ok : EXIT.usage;
      }
      throw usage("`botkins " + found.path.join(" ") + "` has no command `" + words[found.path.length] + "`. It has: " + Object.keys(found.command.commands).join(", ") + ".");
    }
    const { command, path } = found;
    if (own.includes("--help") || own.includes("-h")) {
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
      // An id or a value can start with a dash (a device's id is random text). The parser then
      // takes it for an option. The one rule of this command line is said with the refusal, so a
      // caller that got the id from a --json answer knows what to do.
      const dash = /ambiguous|Unknown option|argument missing/i.test(error.message);
      throw usage(error.message.replace(/\.?\s*(Did you forget|To specify)[\s\S]*$/, ".") + (dash ? " If that word is an id or a value that starts with a dash: give an option's value as --option=value, and put a word that is not an option after `--` (botkins devices remove --yes -- <id>)." : ""));
    }
    const paths = terminalPaths({ root: parsed.values["data-dir"], socket: parsed.values.socket, env });
    if (!io.client) asOwner(paths, path, parsed.values, env);
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
      client: io.client ?? controlClient(paths.socket, path[0] === "pi" && path[1] === "install" ? { timeout: 150_000 } : undefined),
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
