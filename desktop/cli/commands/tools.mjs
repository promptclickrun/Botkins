// Tools (MCP servers), skills, and what one bot has of them: `botkins tools`, `botkins skills`,
// `botkins bots tools|skills|access|menu`, `botkins folders`.
//
// Two rules of the command line hold here more than anywhere (desktop/AGENTS.md):
//  - A secret is never a word on the command line. An environment value, a header's value and a
//    client secret come from a file (`--secrets <path>`, or `-` for standard input), or from a
//    hidden question at a terminal. No command prints one: a tool shows the names that have a
//    value, never the values.
//  - A tool that is a command starts a program on this computer. Adding one, turning one on,
//    changing what it starts and importing a file of them show the exact line that will run and
//    need the person's yes (`--yes` when there is no terminal to ask at).
import { pickedSkill } from "../../desktop/link/skill-import.mjs";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { LEGACY_NAME } from "../../desktop/home.mjs";
import { hasUnshown, shownText } from "../../desktop/shown-text.mjs";
import { ask, confirm, readAll, secret } from "./input.mjs";
import { followSignIn } from "./workspace.mjs";

// No short form: a program's own "-y" (`npx -y …`) must never be read as this yes.
const YES = { yes: { type: "boolean", about: "Don't ask first" } };
// A word as it can be shown: a character that would move or hide the text around it is written as its number (desktop/shown-text.mjs).
export const safe = shownText;
export const shown = (line) => line.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : JSON.stringify(safe(word)))).join(" ");
/**
 * One word of a command that Botkins prints for someone to run (the sentence "run this next"), written so that a shell
 * reads it as that one word: a word of plain characters is as it is, any other word is in single
 * quotes with each ' written as '\'' (a single quote is the one quoting that a shell does not
 * look inside: `;`, `$(` and a backtick do nothing there, which they do in double quotes and in JSON).
 * An empty word is ''.
 * A suggested command must be exactly what should be run. A word with a control character or a
 * character that turns or hides text (the characters of `safe`) cannot be shown as it is, and
 * writing it as its number would make a command that runs something else. So for such a word NO
 * runnable form is printed: `placeholder` is, such as <its id>, and the sentence around it says
 * where to take the real word from.
 */
export const shellWord = (word, placeholder = "<the word>") => {
  const text = String(word);
  if (hasUnshown(text)) return placeholder;
  return /^[A-Za-z0-9_@.+=:,/-]+$/.test(text) ? text : "'" + text.replaceAll("'", "'\\''") + "'";
};
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const SKILL_CONFIRM = {
  ...YES,
  replace: { type: "string", multiple: true, value: "name", about: "Confirm replacement of this existing skill with --yes. Repeat for each name." },
};
async function finishImport(context, send) {
  let result = await send([]);
  if (result.conflicts.length) {
    const names = result.conflicts.map(safe).join(", ");
    if (context.options.yes && !result.conflicts.every(name => context.options.replace?.includes(name)))
      throw usage("Existing skills: " + names + ". Confirm each with --replace <name>.");
    if (await confirm(context, "Replace " + names + "?")) result = await send(result.conflicts);
  }
  context.print(result, r => r.conflicts.length ? "Skills were not replaced." : "Added " + r.added.map(safe).join(", "));
}

/** An updated CLI can still be talking to an earlier running service. Normalize its skill
 * metadata before either the table or the JSON formatter sees it. */
async function skillResult(context, method, ...args) {
  const value = await context.client.call(method, ...args);
  const current = (skill) => skill?.origin === LEGACY_NAME.toLowerCase() ? { ...skill, origin: "botkins" } : skill;
  return Array.isArray(value?.skills) ? { ...value, skills: value.skills.map(current) } : current(value);
}
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person what will start. */
const show = (context, text) => void context.stderr.write(text + "\n");
// A name is a name. A word with a value in it ("API_KEY=sk-…", "Authorization: Bearer …") is refused
// before any question, any echo and any save, and is not repeated.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function namesOnly(list, pattern, flag, example) {
  for (const name of list ?? []) if (!pattern.test(name)) throw usage(flag + " takes a name only, such as " + example + ". The value is never a word on the command line: it comes from --secrets or the hidden question.");
  return list ?? [];
}
/** A file's text, or standard input for "-". */
async function textFrom(context, path, what) {
  if (path === "-") return readAll(context.stdin);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The " + what + " " + path + " can't be read: " + error.message);
  }
}
const SECRETS_FORM = "{ \"env\": { \"NAME\": \"value\" }, \"headers\": { \"NAME\": \"value\" }, \"clientSecret\": \"value\" }";
/**
 * The values for the names given with --env and --header, and the client secret when
 * --client-secret is there. From `--secrets` (a JSON file, or "-" for standard input). Without
 * it, each one is asked for at the terminal and not shown. With no terminal the command fails and
 * names the flag. A file must be that object and hold a value for each name, and for no other.
 */
async function secrets(context, { env = [], headers = [], clientSecret = false }) {
  const wanted = env.length + headers.length + (clientSecret ? 1 : 0);
  let given = null;
  if (context.options.secrets !== undefined) {
    try {
      given = JSON.parse(await textFrom(context, context.options.secrets, "secrets file"));
    } catch (error) {
      if (error instanceof CliError) throw error;
      given = undefined;
    }
    const map = (value) => value === undefined || (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string"));
    if (!given || typeof given !== "object" || Array.isArray(given) || !map(given.env) || !map(given.headers) || (given.clientSecret !== undefined && typeof given.clientSecret !== "string") || Object.keys(given).some((key) => !["env", "headers", "clientSecret"].includes(key)))
      throw usage("The secrets are not in the form " + SECRETS_FORM + ".");
    // A value that no option named would be dropped without a word. (Names are not secret; values are never said.)
    const extra = [...Object.keys(given.env ?? {}).filter((name) => !env.includes(name)), ...Object.keys(given.headers ?? {}).filter((name) => !headers.includes(name)), ...(given.clientSecret !== undefined && !clientSecret ? ["clientSecret"] : [])];
    if (extra.length) throw usage("The secrets hold " + extra.length + " value" + (extra.length === 1 ? "" : "s") + " that this command did not name. Name each one with --env or --header" + (given.clientSecret !== undefined && !clientSecret ? ", and give --client-secret" : "") + ", or take it out of the file.");
  } else if (wanted && (!context.stdin.isTTY || context.json)) throw usage("A value is needed for " + [...env, ...headers, ...(clientSecret ? ["the client secret"] : [])].join(", ") + ". Give them in a JSON file with --secrets <path>, or --secrets - to read it from standard input. A value is never a word on the command line.");
  const value = async (kind, name, label) => {
    const found = kind === "clientSecret" ? given?.clientSecret : given?.[kind]?.[name];
    if (given) {
      if (typeof found !== "string" || !found) throw new CliError("The secrets have no value for " + label + ".");
      return found;
    }
    const typed = await ask(context, "Value for " + label + " (not shown): ", { hidden: true });
    if (!typed) throw usage("Nothing was entered for " + label + ".");
    return typed;
  };
  const out = { env: {}, headers: {} };
  for (const name of env) out.env[name] = await value("env", name, name);
  for (const name of headers) out.headers[name] = await value("headers", name, "the header " + name);
  if (clientSecret) out.clientSecret = await value("clientSecret", null, "the client secret");
  return out;
}
/** A program as a person must see it before it starts: its line, its folder, and the names of the environment values it gets. */
const programLines = ({ name, runs: line, cwd, env = [] }) => ["  " + safe(name) + ": " + shown(line), ...(cwd ? ["      in the folder " + JSON.stringify(safe(cwd))] : []), ...(env.length ? ["      with the environment values " + env.map(safe).join(", ")] : [])];
const WHERE = "The program is found on the PATH of the service, which may not be this terminal's. A folder that does not exist is left out.";
/** How an entry of the apps catalog signs in, in a word. */
const CATALOG_AUTH = { none: "none", oauth: "browser", key: "key" };
/** Where an entry of the apps catalog stands on this computer. */
const catalogState = (entry) => (!entry.added ? "-" : !entry.enabled ? "off" : entry.signedIn === false ? "needs sign-in" : entry.keysSet === false ? "needs a key" : "on");
/**
 * The keys an entry of the apps catalog takes, by the id of each: from --secrets (a JSON file, or "-"
 * for standard input, holding { "key": "value" }), or a hidden question for each at a terminal.
 */
async function catalogKeys(context, entry) {
  if (context.options.secrets !== undefined) {
    let given;
    try {
      given = JSON.parse(await textFrom(context, context.options.secrets, "secrets file"));
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
    if (!given || typeof given !== "object" || Array.isArray(given) || Object.values(given).some((value) => typeof value !== "string"))
      throw usage("The secrets are not in the form { " + entry.keys.map((key) => JSON.stringify(key.id) + ": \"value\"").join(", ") + " }.");
    return given;
  }
  if (!context.stdin.isTTY || context.json) throw usage(entry.name + " needs its " + entry.keys.map((key) => key.label).join(" and ") + ". Give them in a JSON file with --secrets <path>, or --secrets - to read it from standard input. A key is never a word on the command line.");
  const out = {};
  for (const key of entry.keys) {
    const typed = await ask(context, key.label + " for " + safe(entry.name) + (key.hint ? " (" + safe(key.hint) + ")" : "") + " (not shown): ", { hidden: true });
    if (!typed) throw usage("Nothing was entered for the " + key.label + ".");
    out[key.id] = typed;
  }
  return out;
}
/** Shows what a tool will start and asks. It is shown even with --yes and with --json, so it is in the caller's own record. */
async function mayRun(context, tool) {
  show(context, "This starts a program on this computer, as the user that runs Botkins:\n" + programLines(tool).join("\n") + "\n" + WHERE);
  return confirm(context, "Let Botkins start it?");
}
const TOOL_OPTIONS = {
  command: { type: "string", value: "program", about: "A program this computer starts (a local tool), such as npx" },
  cwd: { type: "string", value: "dir", about: "The folder the program starts in (a full path)" },
  env: { type: "string", multiple: true, value: "NAME", about: "An environment value the program gets. Only its name, such as API_KEY: the value comes from --secrets or a hidden question" },
  url: { type: "string", value: "address", about: "A web address (a remote tool), starting with https://" },
  sse: { type: "boolean", about: "The web address speaks the older SSE form" },
  header: { type: "string", multiple: true, value: "NAME", about: "A header sent to the web address. Only its name, such as Authorization: the value comes from --secrets or a hidden question" },
  "client-id": { type: "string", value: "id", about: "For a web address that signs in and does not let apps register themselves: the client ID" },
  scope: { type: "string", value: "text", about: "The sign-in's scopes, when the server needs them named" },
  "client-secret": { type: "boolean", about: "The client has a secret. Its value comes from --secrets or a hidden question" },
  secrets: { type: "string", value: "path", about: "A JSON file with the values: { \"env\": { NAME: value }, \"headers\": { NAME: value }, \"clientSecret\": value }. \"-\" reads standard input" },
  ...YES,
};
/** The forms of a sign-in from a terminal, for `tools sign-in` and `plugins sign-in`. */
export const SIGN_IN_OPTIONS = {
  start: { type: "boolean", about: "With no terminal, step 1: print the page to open, and leave the sign-in open" },
  finish: { type: "boolean", about: "With no terminal, step 2: read the address the browser was sent back to from standard input, and wait for the end" },
  cancel: { type: "boolean", about: "End a sign-in that is open" },
  "no-input": { type: "boolean", about: "Never ask a question, even at a terminal. The plain form fails at once and names the two steps. --finish reads standard input only when it is not a terminal" },
};
/** What a sign-in from a terminal is, for the details of both commands. */
export const SIGN_IN_DETAILS = [
  "A tool on the web signs in through a browser, and this computer may have none. So the command prints a page. Open it on any device and sign in there.",
  "The browser then goes to an address on this computer (it starts with http://127.0.0.1). On another device that page does not load, which is expected. Copy the whole address from the browser's address bar and paste it here. It is not shown when you paste it: it holds a code.",
  "",
  "With no terminal (an agent, a script) the same has two steps:",
  "  --start     prints the page, and the start of the address to look for, and leaves the sign-in open (a second --start gives the same page again)",
  "  --finish    reads the pasted address from standard input, and waits for the end",
  "The pasted address is never a word on the command line: it holds a code.",
  "--no-input is for an agent, or a script, that has a terminal it cannot type at: the command then never asks. The plain form fails at once and names the two steps. --finish reads the address from standard input when that is not a terminal, and fails at once when it is. A pipe that is never closed makes --finish wait.",
  "",
  "The page that the command prints is the key to the sign-in: whoever opens it can sign in with their own account, and whoever gives the address that follows to --finish signs the tool in as that account. So open only a page from your own command's output. Paste only the address that your own browser was sent to. The host that the command names is the host of the first page only. Many sign-in pages send the browser on to another host, so the host is something to check, not a promise. Read which account the last lines name.",
  "",
  "What is accepted: only the address this sign-in named, with the mark (`state`) of this sign-in. The tool's sign-in server is checked by its name in the address (`iss`) when it gives one. The code in the address works one time, and only with a secret this computer made for this sign-in. A wrong `state`, another address or no code is turned away, and the sign-in stays open for the right one. An answer in which the server names itself wrongly (`iss`) ends the sign-in: start it again. The address and the code are never in the log.",
].join("\n");
/**
 * A tool's sign-in from a terminal, in its three forms (`--start`/`--finish`, the plain form at
 * a terminal, `--cancel`). The service's calls are `calls` ("tools.signIn" or "plugins.signIn")
 * with `target` after the call's own words (the tool, or the plugin and its tool); the session
 * itself is read and typed to with the `tools.signIn` calls. `next(started)` is the command for step 2,
 * every word of it written for a shell. The pasted address is never a word on the command line.
 */
export async function signInCommand(context, { calls, target, next }) {
  const { start, finish, cancel } = context.options;
  const noInput = context.options["no-input"] === true;
  if ([start, finish, cancel].filter(Boolean).length > 1) throw usage("Use one of --start, --finish and --cancel.");
  const { client } = context;
  const word = calls.startsWith("plugins") ? "plugin" : "tool";
  if (cancel) {
    const done = await client.call(calls + ".end", ...target);
    return void context.print(done, (done) => (done.cancelled ? "The sign-in to " + safe(done.name) + " is ended." : done.finished ? "The sign-in to " + safe(done.name) + " was done already, so it is not ended. The tool is signed in." : safe(done.name) + " has no open sign-in."));
  }
  if (finish) {
    // With --no-input a question is never asked: the address comes from standard input, which is not a terminal.
    if (noInput && context.stdin.isTTY)
      throw usage("With --no-input this step reads the address from standard input, and standard input is a terminal. Give the address on standard input, for example: botkins " + (word === "plugin" ? "plugins" : "tools") + " sign-in <" + word + "> --finish < address.txt");
    // Ctrl-C and a hang-up end the sign-in: the command is not left to write a sign-in that its person stopped.
    const stop = () => void client.call(calls + ".end", ...target).catch(() => {});
    process.once("SIGINT", stop);
    process.once("SIGHUP", stop);
    try {
      // From standard input, or typed without being shown: never from the command line.
      const address = await secret(context, "The address that your own browser was sent to, from a page that you opened from this output (not shown): ").catch((error) => {
        if (error.code === "USAGE") throw usage("No address was given. Give the address the browser was sent back to on standard input.");
        throw error;
      });
      let done;
      try {
        done = await client.call(calls + ".answer", ...target, address);
      } catch (error) {
        // The reason is the service's own sentence and never has the address.
        // BAD_ADDRESS: this address was turned away, and the sign-in is open still.
        if (error.code === "BAD_ADDRESS") throw new CliError(error.message + " The sign-in is still open: run --finish again with the right address.", EXIT.failed, "BAD_ADDRESS");
        // ANSWERED: the sign-in has its answer, and nothing more is asked of the person.
        if (error.code === "ANSWERED") throw new CliError(error.message + " Look at the result with `botkins " + (calls.startsWith("plugins") ? "plugins show " + shellWord(target[0], "<the plugin>") : "tools show " + shellWord(target[0], "<the tool>")) + "`.", EXIT.failed, "ANSWERED");
        throw error;
      }
      return void context.print({ done: true, ...done }, () => signedIn(done));
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGHUP", stop);
    }
  }
  if (!start && (noInput || !context.stdin.isTTY || context.json))
    throw usage("With no terminal this sign-in has two steps. Run it with --start: it prints the page to open, and leaves the sign-in open. Then run it with --finish: it reads the address the browser was sent back to from standard input.");
  // `hold`: with --start nobody follows the sign-in. It stays open for --finish, and a second --start gets it again.
  const started = await client.call(calls, ...target, ...(start ? [{ hold: true }] : []));
  if (!start) {
    const done = await followSignIn(context, started.session, "tools.signIn", { intro: (page) => "Sign in to " + safe(started.name) + onHost(page.host) + "." });
    return void context.print({ done: true, ...done }, () => signedIn({ name: started.name, ...done }));
  }
  // Step 1 only: wait for the page, say it, and leave the sign-in open for step 2.
  for (let after = 0; ; ) {
    const view = await client.call("tools.signIn.read", started.session, after);
    after = view.next;
    const page = view.events.find((event) => event.type === "open");
    if (page) {
      const command = next(started);
      const { session: _session, ...about } = started;
      const left = started.minutes + (started.minutes === 1 ? " minute" : " minutes");
      return void context.print({ ...about, open: page.url, back: page.back, host: page.host, next: command }, () =>
        [
          ...(started.already ? ["This sign-in is already open. It stays open for " + (started.minutes === 1 ? "1 more minute" : started.minutes + " more minutes") + ".", ""] : []),
          "Sign in to " + safe(started.name) + onHost(page.host) + ".",
          "",
          "Open this page on any device and sign in:",
          "",
          "    " + safe(page.url),
          "",
          "The browser then goes to an address that starts with " + safe(page.back) + ". On another device than this computer that page does not load, which is expected.",
          "Copy the whole address from the browser's address bar, and give it to the second step in the next " + left + ". Give only the address that your own browser was sent to, from a page that you opened from this output:",
          "",
          "    " + command,
          "",
          "That step reads the address from standard input, or asks for it and does not show it.",
          ...(["<its id>", "<the tool>"].some((word) => command.includes(word)) ? ["A word of the second step has a character that cannot be written in a command, so it is a placeholder in angle brackets. Take the real word from `botkins " + (calls.startsWith("plugins") ? "plugins" : "tools") + " list --json`."] : []),
        ].join("\n"),
      );
    }
    if (view.done) throw new CliError(view.error ?? "The sign-in ended before it gave a page.", EXIT.failed, "SIGN_IN_FAILED");
  }
}
/** ", on login.example.com" for a page's host, as safe text. */
const onHost = (host) => (host ? ", on " + safe(host) : "");
/**
 * The last lines of a sign-in that is done: the email that the sign-in server says the account has (in quotes, as it came: a
 * name or a user name is chosen by whoever owns the account, so it is never shown as the account), and whether it replaced one.
 */
const signedIn = (done) =>
  [
    done.account ? 'The sign-in server says that the account is "' + safe(done.account) + '".' : "Botkins cannot tell which account this is. Check it at " + (done.host ? safe(done.host) : "the sign-in server") + ".",
    done.again ? "Signed in to " + safe(done.name) + " again. This replaces the sign-in that was there." : safe(done.name) + " is signed in.",
  ].join("\n");
const toolLine = (tool) => (tool.kind === "command" ? shown(tool.runs) : safe(tool.url));
const toolText = (tool) =>
  [
    safe(tool.name) + (tool.enabled ? "" : " (off)") + "   " + tool.id,
    (tool.kind === "command" ? "Starts: " : "Reaches: ") + toolLine(tool) + (tool.cwd ? "   (in " + JSON.stringify(safe(tool.cwd)) + ")" : ""),
    tool.env.length ? "Environment values: " + tool.env.map(safe).join(", ") : null,
    tool.headers.length ? "Headers: " + tool.headers.map(safe).join(", ") : null,
    tool.needs?.length ? "Needs its value again: " + tool.needs.map(safe).join(", ") : null,
    tool.auth?.type === "oauth" ? "Sign-in: " + (tool.auth.signedIn ? "signed in" : "not signed in. Sign it in with `botkins tools sign-in " + shellWord(tool.name, "<the tool>") + "`." + (hasUnshown(tool.name) ? " Take the tool's id from `botkins tools list --json`: its name has a character that cannot be written in a command." : "")) : null,
  ]
    .filter(Boolean)
    .join("\n");

export const tools = {
  tools: {
    summary: "Add, change and remove the tools (MCP servers) that bots can call",
    details: "A tool is something a bot can call. One that you add is an MCP server: a program this computer starts, or a web address. Each bot gets every tool that is on, unless it is turned off for that bot (`botkins bots tools`).",
    commands: {
      list: {
        summary: "List the tools",
        usage: "botkins tools list",
        async run(context) {
          context.print(await context.client.call("tools.list"), (list) => (list.length ? table(["NAME", "KIND", "STATE", "STARTS OR REACHES", "ID"], list.map((tool) => [tool.name, tool.kind, tool.enabled ? (tool.needs?.length ? "needs a value" : "on") : "off", toolLine(tool), tool.id])) : "No tools yet. Add one with `botkins tools add`."));
        },
      },
      catalog: {
        summary: "List the apps you can add without typing an address: sign in, a key, or one tap",
        usage: "botkins tools catalog [--category <id>]",
        options: { category: { type: "string", value: "id", about: "Only this category (research, notes, work, mail, money, code, data, design)" } },
        async run(context) {
          if (context.args.length) throw usage("This command takes no words, only --category <id>.");
          const { entries } = await context.client.call("mcpCatalog.list");
          const rows = context.options.category ? entries.filter((entry) => entry.category === context.options.category) : entries;
          context.print(rows, (list) => table(["ID", "NAME", "SIGN-IN", "RUNS", "STATE"], list.map((entry) => [entry.id, safe(entry.name), CATALOG_AUTH[entry.auth], entry.transport === "stdio" ? entry.command : entry.local ? "on this computer" : "web", catalogState(entry)])) + "\nAdd one with `botkins tools connect <id>`.");
        },
      },
      connect: {
        summary: "Add an app from the catalog, or give it a new key",
        usage: "botkins tools connect <id> [--secrets <path>] [--yes]",
        options: { ...YES, secrets: { type: "string", value: "path", about: "The keys as JSON, { \"key\": \"value\" }, from a file or - for standard input" } },
        details: "An app that signs in with a browser is added, then signed in with `botkins tools sign-in`. A key is asked for without showing it, or read with --secrets; it goes to the vault and is never printed. An app that is a program shows the exact line that will run and needs your yes (--yes with no terminal).",
        async run(context) {
          const id = one(context, "Name the app by its id from `botkins tools catalog`.");
          const { entries } = await context.client.call("mcpCatalog.list");
          const entry = entries.find((item) => item.id === id);
          if (!entry) throw usage("No app in the catalog has the id " + safe(id) + ". See `botkins tools catalog`.");
          const options = {};
          if (entry.transport === "stdio") {
            if (!(await mayRun(context, { name: entry.name, runs: entry.command.split(" "), env: entry.env }))) {
              context.note("Not added.");
              return EXIT.failed;
            }
            options.confirm = entry.command;
          }
          if (entry.commandChanged) context.note(safe(entry.name) + " is moving to a newer version. A saved key only goes to the command it was saved for, so it needs its key again.");
          if (entry.keys.length && (!entry.added || entry.keysSet === false || entry.commandChanged || context.options.secrets !== undefined)) options.keys = await catalogKeys(context, entry);
          const result = await context.client.call("mcpCatalog.add", id, options);
          context.print(result, (done) => (done.next === "sign-in" ? safe(entry.name) + " is added. Sign it in next: botkins tools sign-in " + shellWord(done.serverId, "<its id>") : safe(entry.name) + " is added and on."));
        },
      },
      show: {
        summary: "Show one tool: what it starts or reaches, and the names of its values",
        usage: "botkins tools show <tool>",
        async run(context) {
          context.print(await context.client.call("tools.get", one(context, "Name the tool (its name or id).")), toolText);
        },
      },
      add: {
        summary: "Add a tool: a program this computer starts, or a web address",
        usage: "botkins tools add <name> (--command <program> [--cwd <dir>] [--env <NAME>]… | --url <address> [--sse] [--header <NAME>]… [--client-id <id>] [--scope <text>] [--client-secret]) [--secrets <path>] [--yes] [-- <argument>…]",
        options: TOOL_OPTIONS,
        arguments: [{ name: "name", required: true }, { name: "argument", required: false, many: true }],
        details: "The program's own arguments come last, after `--`, so that one may start with a dash: `botkins tools add files --command npx -- -y @example/files`. A value is never a word on the command line. Name each environment value or header (`--env API_KEY`), and give the values in a JSON file (`--secrets values.json`, or `--secrets -` for standard input), or type them when asked. A tool that is a program is shown before it is added, and needs your yes.",
        async run(context) {
          const [name, ...args] = context.args;
          if (!name) throw usage("Give the tool a name (letters, numbers, dashes or underscores).");
          const o = context.options;
          if ((o.command === undefined) === (o.url === undefined)) throw usage("Give --command <program> for a tool this computer starts, or --url <address> for one on the web.");
          let data;
          const env = namesOnly(o.env, ENV_NAME, "--env", "API_KEY");
          const headers = namesOnly(o.header, HEADER_NAME, "--header", "Authorization");
          if (o.command !== undefined) {
            if (headers.length || o.sse || o["client-id"] !== undefined || o.scope !== undefined || o["client-secret"]) throw usage("--header, --sse, --client-id, --scope and --client-secret are for a web address.");
            const line = [o.command, ...args];
            if (!(await mayRun(context, { name, runs: line, cwd: o.cwd, env }))) return EXIT.failed;
            const values = await secrets(context, { env });
            data = { name, type: "stdio", command: o.command, args, ...(o.cwd !== undefined && { cwd: o.cwd }), env: values.env };
          } else {
            if (args.length || o.cwd !== undefined || env.length) throw usage("--cwd, --env and the arguments after -- are for a program.");
            if (o["client-secret"] && o["client-id"] === undefined) throw usage("A client secret needs its client ID (--client-id).");
            const values = await secrets(context, { headers, clientSecret: o["client-secret"] === true });
            const signIn = o["client-id"] !== undefined || o.scope !== undefined;
            data = { name, type: o.sse ? "sse" : "http", url: o.url, headers: values.headers, ...(signIn && { oauth: { clientId: o["client-id"], scope: o.scope, ...(values.clientSecret && { clientSecret: values.clientSecret }) } }) };
          }
          context.print(await context.client.call("tools.add", data, { agreed: o.command !== undefined }), (tool) => "Added " + safe(tool.name) + ". Every bot has it now; `botkins bots tools <bot> --off " + shellWord(tool.name, "<the tool>") + "` takes it from one. Try it with `botkins tools test " + shellWord(tool.name, "<the tool>") + "`." + (hasUnshown(tool.name) ? " Take the tool's name from `botkins tools list --json`: it has a character that cannot be written in a command." : ""));
        },
      },
      edit: {
        summary: "Change a tool",
        usage: "botkins tools edit <tool> [--name <text>] [--command <program>] [--no-arguments] [--cwd <dir>] [--env <NAME>]… [--remove-env <NAME>]… [--url <address>] [--header <NAME>]… [--remove-header <NAME>]… [--client-id <id>] [--scope <text>] [--client-secret] [--no-sign-in] [--secrets <path>] [--yes] [-- <argument>…]",
        arguments: [{ name: "tool", required: true }, { name: "argument", required: false, many: true }],
        options: {
          name: { type: "string", value: "text", about: "A new name" },
          ...Object.fromEntries(Object.entries(TOOL_OPTIONS).filter(([name]) => name !== "sse")),
          "remove-env": { type: "string", multiple: true, value: "NAME", about: "Take an environment value away" },
          "remove-header": { type: "string", multiple: true, value: "NAME", about: "Take a header away" },
          "no-sign-in": { type: "boolean", about: "The web address no longer signs in" },
          "no-arguments": { type: "boolean", about: "The program gets no arguments" },
        },
        details: "Only what you name changes; every other value stays as it is stored. Words after `--` replace all the program's arguments. When the program, its arguments or the web address change, the stored values must be given again: a value goes only where you sent it.",
        async run(context) {
          const [ref, ...args] = context.args;
          if (!ref) throw usage("Name the tool (its name or id).");
          const o = context.options;
          if (args.length && o["no-arguments"]) throw usage("Give the arguments after --, or --no-arguments, not both.");
          const newArgs = o["no-arguments"] ? [] : args.length ? args : undefined;
          const before = await context.client.call("tools.get", ref);
          const local = before.kind === "command";
          if (local && (o.url !== undefined || o.header?.length || o["remove-header"]?.length || o["client-id"] !== undefined || o.scope !== undefined || o["client-secret"] || o["no-sign-in"])) throw usage(before.name + " is a program: --url, --header, --client-id, --scope and --client-secret are for a web address.");
          if (!local && (o.command !== undefined || newArgs !== undefined || o.cwd !== undefined || o.env?.length || o["remove-env"]?.length)) throw usage(before.name + " is a web address: --command, --cwd, --env and the arguments after -- are for a program.");
          const env = namesOnly(o.env, ENV_NAME, "--env", "API_KEY");
          const headers = namesOnly(o.header, HEADER_NAME, "--header", "Authorization");
          const patch = {};
          // The mark that the person said yes: it is set only after the question above (the service refuses without it).
          let agreed = false;
          if (o.name !== undefined) patch.name = o.name;
          if (local) {
            const line = [o.command ?? before.command, ...(newArgs ?? before.args)];
            const gone = o["remove-env"] ?? [];
            // Shown again, and asked again, whenever what will run is not what was shown before: another
            // line, another folder, or an environment value that is new, changed or taken away
            // (NODE_OPTIONS, LD_PRELOAD and PATH change what a program does as much as its line).
            if (JSON.stringify(line) !== JSON.stringify(before.runs) || (o.cwd !== undefined && o.cwd !== (before.cwd ?? "")) || env.length || gone.length) {
              agreed = true;
              const names = [...new Set([...before.env.filter((name) => !gone.includes(name)), ...env])];
              if (!(await mayRun(context, { name: o.name ?? before.name, runs: line, cwd: o.cwd ?? before.cwd, env: names }))) return EXIT.failed;
            }
            if (o.command !== undefined) patch.command = o.command;
            if (newArgs !== undefined) patch.args = newArgs;
            if (o.cwd !== undefined) patch.cwd = o.cwd;
            const values = await secrets(context, { env });
            if (env.length || gone.length) patch.env = { ...values.env, ...Object.fromEntries(gone.map((name) => [name, false])) };
          } else {
            if (o.url !== undefined) patch.url = o.url;
            const values = await secrets(context, { headers, clientSecret: o["client-secret"] === true });
            if (headers.length || o["remove-header"]?.length) patch.headers = { ...values.headers, ...Object.fromEntries((o["remove-header"] ?? []).map((name) => [name, false])) };
            if (o["no-sign-in"]) patch.oauth = null;
            else if (o["client-id"] !== undefined || o.scope !== undefined || values.clientSecret) patch.oauth = { ...(o["client-id"] !== undefined && { clientId: o["client-id"] }), ...(o.scope !== undefined && { scope: o.scope }), ...(values.clientSecret && { clientSecret: values.clientSecret }) };
          }
          if (!Object.keys(patch).length) throw usage("Say what to change. `botkins help tools edit` lists the options.");
          context.print(await context.client.call("tools.edit", before.id, patch, { agreed }), (tool) => "Saved " + tool.name + ".");
        },
      },
      remove: {
        summary: "Remove a tool, with its stored values and its sign-in",
        usage: "botkins tools remove <tool> [--yes]",
        options: YES,
        async run(context) {
          const ref = one(context, "Name the tool (its name or id).");
          const tool = await context.client.call("tools.get", ref);
          // What goes is shown even with --yes and with --json. Never a value.
          show(context, "This removes the tool " + safe(tool.name) + ".\n" + [tool.env.length ? "  Its stored environment values go: " + tool.env.map(safe).join(", ") : null, tool.headers.length ? "  Its stored headers go: " + tool.headers.map(safe).join(", ") : null, tool.auth?.type === "oauth" ? "  Its sign-in goes." : null, "  Every bot that has it loses it."].filter(Boolean).join("\n") + "\nThese cannot be got back.");
          if (!(await confirm(context, "Remove " + safe(tool.name) + " with its stored values?"))) {
            context.note("Not removed.");
            return EXIT.failed;
          }
          context.print(await context.client.call("tools.remove", tool.id, { agreed: true }), (gone) => "Removed " + safe(gone.name) + ".");
        },
      },
      enable: {
        summary: "Turn a tool on for every bot that has it",
        usage: "botkins tools enable <tool> [--yes]",
        options: YES,
        details: "A tool that is a program is shown before it is turned on, and needs your yes.",
        async run(context) {
          const tool = await context.client.call("tools.get", one(context, "Name the tool (its name or id)."));
          const asked = tool.kind === "command" && !tool.enabled;
          if (asked && !(await mayRun(context, tool))) return EXIT.failed;
          context.print(await context.client.call("tools.enable", tool.id, true, { agreed: asked }), (now) => now.name + " is on.");
        },
      },
      disable: {
        summary: "Turn a tool off for every bot, and keep it",
        usage: "botkins tools disable <tool>",
        async run(context) {
          context.print(await context.client.call("tools.enable", one(context, "Name the tool (its name or id)."), false), (now) => now.name + " is off.");
        },
      },
      test: {
        summary: "Connect a tool once and list what it offers",
        usage: "botkins tools test <tool> [--yes]",
        options: YES,
        details: "A tool that is a program is started for this, as it is for a bot. One that is switched off is shown first and needs your yes, as `tools enable` does. The command ends with 1 when the tool did not connect.",
        async run(context) {
          const tool = await context.client.call("tools.get", one(context, "Name the tool (its name or id)."));
          let agreed = false;
          if (tool.kind === "command") {
            // One that is on was approved when it was added or switched on. One that is off was not, or not as it is now.
            if (!tool.enabled) {
              if (!(await mayRun(context, tool))) return EXIT.failed;
              agreed = true;
            } else show(context, "Starting: " + shown(tool.runs));
          }
          const result = await context.client.call("tools.test", tool.id, { agreed });
          context.print(result, (done) => safe(done.name) + ": " + done.status + (done.tools?.length ? "\n" + done.tools.map((name) => "  " + safe(name)).join("\n") : ""));
          return result.status === "connected" ? EXIT.ok : EXIT.failed;
        },
      },
      import: {
        summary: "Add the tools of a JSON file, such as another app's MCP settings",
        usage: "botkins tools import <file> [--yes]",
        options: YES,
        details: "The file is { \"mcpServers\": { \"name\": { \"command\": \"npx\", \"args\": [\"…\"] } } }, or the same under \"servers\". \"-\" reads standard input. Every tool of the file is shown before anything is added: a program with its line, its folder and the names of its environment values, a web address with the names of its headers. One yes adds what was shown. A tool whose name is taken is left out.",
        async run(context) {
          const file = one(context, "Name the JSON file, or - for standard input.");
          let json = await textFrom(context, file, "file");
          // A folder that the file gives beside itself ("cwd": "./server") is that folder, as in the app's window.
          if (file !== "-") {
            try {
              const data = JSON.parse(json);
              const list = data?.mcpServers ?? data?.servers ?? data;
              for (const entry of Object.values(list && typeof list === "object" ? list : {})) {
                const key = entry && typeof entry === "object" ? ["workingDirectory", "cwd"].find((name) => typeof entry[name] === "string" && entry[name] && !isAbsolute(entry[name])) : null;
                if (key) entry[key] = resolve(dirname(resolve(file)), entry[key]);
              }
              json = JSON.stringify(data);
            } catch {
              // Not JSON: the service says so, in the app's own words.
            }
          }
          const found = await context.client.call("tools.import.preview", json);
          const fresh = found.filter((tool) => !tool.exists);
          const taken = found.filter((tool) => tool.exists).map((tool) => tool.name);
          if (!fresh.length) return void context.print({ added: [], skipped: taken, starts: [] }, () => "Nothing to add: each name in the file is taken (" + taken.map(safe).join(", ") + ").");
          const programs = fresh.filter((tool) => tool.kind === "command");
          show(context, ["This file adds " + (fresh.length === 1 ? "this tool" : "these " + fresh.length + " tools") + ":", ...fresh.flatMap((tool) => (tool.kind === "command" ? programLines(tool) : ["  " + safe(tool.name) + ": reaches " + safe(tool.url), ...(tool.headers.length ? ["      with the headers " + tool.headers.map(safe).join(", ")] : [])])), ...(programs.length ? [(programs.length === 1 ? "One of them starts a program" : programs.length + " of them start programs") + " on this computer, as the user that runs Botkins. " + WHERE] : []), ...(taken.length ? ["Left out, because the name is taken: " + taken.map(safe).join(", ") + "."] : [])].join("\n"));
          if (!(await confirm(context, "Add " + (fresh.length === 1 ? "it" : "these " + fresh.length + " tools") + (programs.length ? " and let Botkins start " + (programs.length === 1 ? "the program" : "the " + programs.length + " programs") : "") + "?"))) return EXIT.failed;
          context.print(await context.client.call("tools.import", json, { agreed: programs.length > 0 }), (result) => (result.added.length ? "Added " + result.added.map(safe).join(", ") + "." : "Nothing was added.") + (result.skipped.length ? " Left out: " + result.skipped.map(safe).join(", ") + " (the name is taken, or the limit of 50 tools is reached)." : ""));
        },
      },
      "sign-in": {
        summary: "Sign a tool on the web in, with a browser on any device",
        usage: "botkins tools sign-in <tool> [--start | --finish | --cancel] [--no-input]",
        options: SIGN_IN_OPTIONS,
        details: SIGN_IN_DETAILS,
        async run(context) {
          const ref = one(context, "Name the tool (its name or id).");
          return signInCommand(context, { calls: "tools.signIn", target: [ref], next: (started) => "botkins tools sign-in --finish -- " + shellWord(started.id, "<its id>") });
        },
      },
      "sign-out": {
        summary: "Forget a tool's sign-in",
        usage: "botkins tools sign-out <tool> [--yes]",
        options: YES,
        details: "The sign-in is forgotten and cannot be got back: you sign in again with `botkins tools sign-in`. That asks first, and with no terminal it needs --yes.",
        async run(context) {
          const tool = await context.client.call("tools.get", one(context, "Name the tool (its name or id)."));
          show(context, "This forgets the sign-in of the tool " + safe(tool.name) + ". It cannot be got back: sign in again with `botkins tools sign-in`.");
          if (!(await confirm(context, "Sign out of " + safe(tool.name) + "?"))) {
            context.note("Not signed out.");
            return EXIT.failed;
          }
          context.print(await context.client.call("tools.signOut", tool.id, { agreed: true }), (done) => safe(done.name) + " is signed out.");
        },
      },
      "forget-approvals": {
        summary: "Forget the approvals given to tools \"for this chat\"",
        usage: "botkins tools forget-approvals [--chat <id>]",
        options: { chat: { type: "string", value: "id", about: "Only this chat's (every chat's without it)" } },
        async run(context) {
          if (context.args.length) throw usage("This command takes no words, only --chat <id>.");
          context.print(await context.client.call("tools.forgetApprovals", context.options.chat), () => "Forgotten. A bot asks again before it uses such a tool.");
        },
      },
    },
  },
  skills: {
    summary: "Add, change and remove skills: instructions a bot reads when a task needs them",
    details: "A skill is a folder with a SKILL.md: a name, one line that says when to use it, and instructions. Botkins keeps the ones you add here. A linked folder of skills stays where it is and is read from there.",
    commands: {
      featured: {
        summary: "List the featured skills: upstream skills pinned to a commit, with their license",
        usage: "botkins skills featured",
        async run(context) {
          if (context.args.length) throw usage("This command takes no words.");
          const rows = await context.client.call("skillsCatalog.featured");
          context.print(rows, (list) => table(["ID", "LICENSE", "AUTHOR", "STATE"], list.map((row) => [safe(row.id), row.license, safe(row.author), row.installed ? "installed" : "-"])) + "\nRead one with `botkins skills preview <id>`, then install it with `botkins skills install <token>`.");
        },
      },
      search: {
        summary: "Search skills.sh", usage: "botkins skills search <query>",
        async run(context) {
          const rows = await context.client.call("skillsCatalog.search", one(context, "Enter a search in quotes."));
          context.print(rows, () => table(["ID", "INSTALLS"], rows.map(r => [safe(r.id), r.installs])));
        },
      },
      preview: {
        summary: "Read a skill before installation", usage: "botkins skills preview <id>",
        async run(context) {
          const result = await context.client.call("skillsCatalog.preview", one(context, "Choose a catalog id."));
          context.print(result, r => r.text.split("\n").map(safe).join("\n") + "\nPreview token: " + r.token);
        },
      },
      install: {
        summary: "Install the previously previewed files", usage: "botkins skills install <preview-token> [--yes] [--replace <name>]…", options: SKILL_CONFIRM,
        async run(context) {
          const token = one(context, "Give the token from skills preview.");
          if (await confirm(context, "Install and enable the reviewed skill?")) await finishImport(context, replace => context.client.call("skillsCatalog.install", token, replace));
        },
      },
      upload: {
        summary: "Upload Markdown or a skill archive", usage: "botkins skills upload <file> [--yes] [--replace <name>]…", options: SKILL_CONFIRM,
        async run(context) {
          const file = pickedSkill(one(context, "Choose a .md or .zip file."));
          await finishImport(context, replace => context.client.call("skills.upload", {...file, replace}));
        },
      },
      list: {
        summary: "List the skills",
        usage: "botkins skills list",
        async run(context) {
          context.print(await skillResult(context, "skills.list"), (all) => (all.skills.length ? table(["NAME", "STATE", "FROM", "DESCRIPTION"], all.skills.map((skill) => [skill.name, skill.enabled ? "on" : "off", skill.origin === "botkins" ? "Botkins" : skill.origin, skill.description.length > 70 ? skill.description.slice(0, 69) + "…" : skill.description])) : "No skills yet. Add one with `botkins skills add`."));
        },
      },
      show: {
        summary: "Show one skill, with its instructions when Botkins keeps it",
        usage: "botkins skills show <skill>",
        async run(context) {
          context.print(await skillResult(context, "skills.get", one(context, "Name the skill.")), (skill) => [skill.name + (skill.enabled ? "" : " (off)"), skill.description, skill.instructions !== undefined ? "\n" + skill.instructions : "\nIts instructions are in " + skill.path + "."].join("\n"));
        },
      },
      add: {
        summary: "Add a skill that Botkins keeps",
        usage: "botkins skills add <name> --description <text> (--instructions <text> | --instructions-file <path>)",
        options: {
          description: { type: "string", value: "text", about: "One line that says when a bot should use it" },
          instructions: { type: "string", value: "text", about: "What the bot should do" },
          "instructions-file": { type: "string", value: "path", about: "Read the instructions from a file (\"-\" reads standard input)" },
        },
        async run(context) {
          const name = one(context, "Give the skill a name (lowercase letters, numbers and dashes).");
          const o = context.options;
          if (o.description === undefined) throw usage("Give --description: one line that says when a bot should use the skill.");
          if ((o.instructions === undefined) === (o["instructions-file"] === undefined)) throw usage("Give --instructions or --instructions-file, one of them.");
          const instructions = o.instructions ?? (await textFrom(context, o["instructions-file"], "file"));
          context.print(await skillResult(context, "skills.save", { name, description: o.description, instructions }), (skill) => "Added " + safe(skill.name) + ". Every bot has it now; `botkins bots skills <bot> --off " + shellWord(skill.name, "<the skill>") + "` takes it from one." + (hasUnshown(skill.name) ? " Take the skill's name from `botkins skills list --json`: it has a character that cannot be written in a command." : ""));
        },
      },
      edit: {
        summary: "Change a skill that Botkins keeps",
        usage: "botkins skills edit <skill> [--name <text>] [--description <text>] [--instructions <text> | --instructions-file <path>]",
        options: {
          name: { type: "string", value: "text", about: "A new name" },
          description: { type: "string", value: "text", about: "One line that says when a bot should use it" },
          instructions: { type: "string", value: "text", about: "What the bot should do" },
          "instructions-file": { type: "string", value: "path", about: "Read the instructions from a file (\"-\" reads standard input)" },
        },
        async run(context) {
          const ref = one(context, "Name the skill.");
          const o = context.options;
          if (o.instructions !== undefined && o["instructions-file"] !== undefined) throw usage("Give --instructions or --instructions-file, not both.");
          if (o.name === undefined && o.description === undefined && o.instructions === undefined && o["instructions-file"] === undefined) throw usage("Say what to change: --name, --description, --instructions or --instructions-file.");
          const before = await skillResult(context, "skills.get", ref);
          if (before.instructions === undefined) throw new CliError(before.name + " is not a skill that Botkins keeps. Change it in its folder: " + before.path);
          const instructions = o.instructions ?? (o["instructions-file"] !== undefined ? await textFrom(context, o["instructions-file"], "file") : before.instructions);
          context.print(await skillResult(context, "skills.save", { original: before.name, name: o.name ?? before.name, description: o.description ?? before.description, instructions }), (skill) => "Saved " + skill.name + ".");
        },
      },
      remove: {
        summary: "Remove a skill that Botkins keeps",
        usage: "botkins skills remove <skill> [--yes]",
        options: YES,
        async run(context) {
          const ref = one(context, "Name the skill.");
          if (!(await confirm(context, "Remove the skill " + ref + "?"))) return EXIT.failed;
          context.print(await context.client.call("skills.remove", ref), (gone) => "Removed " + gone.removed + ".");
        },
      },
      enable: {
        summary: "Turn a skill on for every bot that has it",
        usage: "botkins skills enable <skill>",
        async run(context) {
          context.print(await skillResult(context, "skills.enable", one(context, "Name the skill."), true), (skill) => skill.name + " is on.");
        },
      },
      disable: {
        summary: "Turn a skill off for every bot, and keep it",
        usage: "botkins skills disable <skill>",
        async run(context) {
          context.print(await skillResult(context, "skills.enable", one(context, "Name the skill."), false), (skill) => skill.name + " is off.");
        },
      },
      folders: {
        summary: "List the linked folders of skills",
        usage: "botkins skills folders",
        async run(context) {
          context.print(await skillResult(context, "skills.list"), (all) => {
            const rows = [...all.folders.map((folder) => [folder.id, "skills", folder.missing ? "missing" : String(folder.skills), folder.path]), ...all.plugins.map((folder) => [folder.id, "plugin", folder.missing ? "missing" : "", folder.path])];
            return rows.length ? table(["ID", "KIND", "SKILLS", "PATH"], rows) : "No folders are linked. Link one with `botkins skills add-folder <path>`.";
          });
        },
      },
      "add-folder": {
        summary: "Add a skill from its folder, or link a folder of skills",
        usage: "botkins skills add-folder <path>",
        details: "The folder must be in the home folder of the user that runs Botkins, or on a plugged-in disk (`botkins folders` lists what can be chosen); on a server, copy it there first. A folder with a SKILL.md is copied into Botkins. A folder of such folders is linked and read where it is. A plugin folder is not taken here: it can run commands.",
        async run(context) {
          context.print(await context.client.call("skills.addFolder", resolve(one(context, "Give the folder's path."))), (added) => (added.kind === "skill" ? "Added the skill " + added.name + "." : added.kind === "folder" ? "Linked " + added.name + " (" + added.count + " skill" + (added.count === 1 ? "" : "s") + ")." : "Linked the plugin folder " + added.name + "."));
        },
      },
      "remove-folder": {
        summary: "Stop reading a linked folder (the folder itself stays)",
        usage: "botkins skills remove-folder <id>",
        async run(context) {
          context.print(await context.client.call("skills.removeFolder", one(context, "Give the folder's id or its path (see `botkins skills folders`).")), (gone) => "No longer linked: " + gone.path);
        },
      },
    },
  },
  folders: {
    summary: "List the folders of this computer that can be chosen",
    usage: "botkins folders [<path>]",
    details: "The home folder and plugged-in disks, without hidden folders. Use a path from here for `botkins skills add-folder`.",
    async run(context) {
      if (context.args.length > 1) throw usage("Give one folder's full path, or none for the home folder.");
      context.print(await context.client.call("folders.list", context.args[0]), (found) => [found.path, ...found.folders.map((folder) => "  " + folder.name), ...(found.more ? ["  …"] : [])].join("\n"));
    },
  },
};

const MANY = (about) => ({ type: "string", multiple: true, value: "name", about });
/** `botkins bots tools|skills|access|menu`: what one bot has of the tools and skills, and which projects it may use. */
export const botTools = {
  tools: {
    summary: "Show or change which tools one bot has",
    usage: "botkins bots tools <bot> [--on <tool>]… [--off <tool>]…",
    options: { on: MANY("Give this bot the tool again"), off: MANY("Take the tool from this bot") },
    details: "Every bot has each tool that is on (`botkins tools list`). --off takes one from this bot only.",
    async run(context) {
      const ref = one(context, "Name the bot (its name or id).");
      const { on, off } = context.options;
      const now = on?.length || off?.length ? await context.client.call("bots.tools.set", ref, { ...(on && { toolsOn: on }), ...(off && { toolsOff: off }) }) : await context.client.call("bots.tools", ref);
      context.print(now, (bot) => (bot.tools.length ? table(["TOOL", "FOR " + bot.name.toUpperCase(), "FOR EVERY BOT"], bot.tools.map((tool) => [tool.name, tool.on ? "on" : "off", tool.enabled ? "on" : "off"])) : "No tools yet. Add one with `botkins tools add`."));
    },
  },
  skills: {
    summary: "Show or change which skills one bot has",
    usage: "botkins bots skills <bot> [--on <skill>]… [--off <skill>]…",
    options: { on: MANY("Give this bot the skill again"), off: MANY("Take the skill from this bot") },
    async run(context) {
      const ref = one(context, "Name the bot (its name or id).");
      const { on, off } = context.options;
      const now = on?.length || off?.length ? await context.client.call("bots.tools.set", ref, { ...(on && { skillsOn: on }), ...(off && { skillsOff: off }) }) : await context.client.call("bots.tools", ref);
      context.print(now, (bot) => (bot.skills.length ? table(["SKILL", "FOR " + bot.name.toUpperCase(), "FOR EVERY BOT"], bot.skills.map((skill) => [skill.name, skill.on ? "on" : "off", skill.enabled ? "on" : "off"])) : "No skills yet. Add one with `botkins skills add`."));
    },
  },
  access: {
    summary: "Show or change which projects one bot may use",
    usage: "botkins bots access <bot> [--all | --project <project>…| --none]",
    options: {
      all: { type: "boolean", about: "Every project, and each new one" },
      project: MANY("A project this bot may use, by its name or id. Give it again for each one; these replace the bot's list"),
      none: { type: "boolean", about: "No project" },
    },
    async run(context) {
      const ref = one(context, "Name the bot (its name or id).");
      const o = context.options;
      const ways = [o.all === true, o.project?.length > 0, o.none === true].filter(Boolean).length;
      if (ways > 1) throw usage("Give --all, or --project for each project, or --none: one of them.");
      const now = ways ? await context.client.call("bots.access.set", ref, o.all ? { all: true } : { projects: o.project ?? [] }) : await context.client.call("bots.access", ref);
      context.print(now, (bot) => bot.name + " may use " + (bot.all ? "every project" : bot.projects.length ? bot.projects.map((project) => project.name).join(", ") : "no project") + "." + (bot.everyBot && !bot.all ? " (Preferences give every bot every project now, so this list waits until that is turned off.)" : ""));
    },
  },
  menu: {
    summary: "List what a bot's chat offers: its commands, skills and tools",
    usage: "botkins bots menu <bot> [--refresh]",
    options: { refresh: { type: "boolean", about: "Ask the model's runtime again" } },
    details: "What a person gets when they type \"/\" in a chat with this bot. It opens a session with the bot's model, so the provider must be signed in. Like each turn of the bot, that session starts the bot's tools that are programs and are on.",
    async run(context) {
      context.print(await context.client.call("bots.menu", one(context, "Name the bot (its name or id)."), context.options.refresh === true), (menu) => {
        const rows = (menu.choices ?? []).map((choice) => ["/" + choice.command, choice.kind ?? "", choice.source ?? "", (choice.description ?? "").slice(0, 60)]);
        const servers = (menu.servers ?? []).map((server) => "  " + server.name + ": " + (server.status ?? ""));
        return [rows.length ? table(["COMMAND", "KIND", "FROM", "WHAT"], rows) : "Nothing is offered.", ...(servers.length ? ["", "Tools:", ...servers] : [])].join("\n");
      });
    },
  },
};
