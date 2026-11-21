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
import { readFileSync } from "node:fs";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { ask, confirm, readAll } from "./input.mjs";

const YES = { yes: { type: "boolean", short: "y", about: "Don't ask first" } };
const shown = (line) => line.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word))).join(" ");
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
    throw new CliError("The " + what + " " + path + " can't be read: " + error.message);
  }
}
/**
 * The values for the names given with --env and --header, and the client secret when
 * --client-secret is there. From `--secrets` (a JSON file, or "-" for standard input):
 * { "env": { NAME: value }, "headers": { NAME: value }, "clientSecret": value }. Without it, each
 * one is asked for at the terminal and not shown. With no terminal the command fails and names the flag.
 */
async function secrets(context, { env = [], headers = [], clientSecret = false }) {
  const wanted = env.length + headers.length + (clientSecret ? 1 : 0);
  if (!wanted) return { env: {}, headers: {} };
  let given = null;
  if (context.options.secrets !== undefined) {
    try {
      given = JSON.parse(await textFrom(context, context.options.secrets, "secrets file"));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("The secrets are not JSON. Give { \"env\": { \"NAME\": \"value\" }, \"headers\": { … }, \"clientSecret\": \"…\" }.");
    }
  } else if (!context.stdin.isTTY || context.json) throw usage("A value is needed for " + [...env, ...headers, ...(clientSecret ? ["the client secret"] : [])].join(", ") + ". Give them in a JSON file with --secrets <path>, or --secrets - to read it from standard input. A value is never a word on the command line.");
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
/** Shows what a tool will start and asks. The line is printed even with --yes, so it is in the terminal's record. */
async function mayRun(context, name, line, cwd) {
  context.note(name + " starts this program on this computer, as the user that runs Botkins:");
  context.note("  " + shown(line) + (cwd ? "   (in " + cwd + ")" : ""));
  return confirm(context, "Let Botkins start it?");
}
const TOOL_OPTIONS = {
  command: { type: "string", value: "program", about: "A program this computer starts (a local tool), such as npx" },
  cwd: { type: "string", value: "dir", about: "The folder the program starts in (a full path)" },
  env: { type: "string", multiple: true, value: "NAME", about: "An environment value the program gets. Only its name: the value comes from --secrets or a hidden question" },
  url: { type: "string", value: "address", about: "A web address (a remote tool), starting with https://" },
  sse: { type: "boolean", about: "The web address speaks the older SSE form" },
  header: { type: "string", multiple: true, value: "NAME", about: "A header sent to the web address. Only its name: the value comes from --secrets or a hidden question" },
  "client-id": { type: "string", value: "id", about: "For a web address that signs in and does not let apps register themselves: the client ID" },
  scope: { type: "string", value: "text", about: "The sign-in's scopes, when the server needs them named" },
  "client-secret": { type: "boolean", about: "The client has a secret. Its value comes from --secrets or a hidden question" },
  secrets: { type: "string", value: "path", about: "A JSON file with the values: { \"env\": { NAME: value }, \"headers\": { NAME: value }, \"clientSecret\": value }. \"-\" reads standard input" },
  ...YES,
};
const toolLine = (tool) => (tool.kind === "command" ? shown(tool.runs) : tool.url);
const toolText = (tool) =>
  [
    tool.name + (tool.enabled ? "" : " (off)") + "   " + tool.id,
    (tool.kind === "command" ? "Starts: " : "Reaches: ") + toolLine(tool) + (tool.cwd ? "   (in " + tool.cwd + ")" : ""),
    tool.env.length ? "Environment values: " + tool.env.join(", ") : null,
    tool.headers.length ? "Headers: " + tool.headers.join(", ") : null,
    tool.needs?.length ? "Needs its value again: " + tool.needs.join(", ") : null,
    tool.auth?.type === "oauth" ? "Sign-in: " + (tool.auth.signedIn ? "signed in" : "not signed in. A tool signs in through a browser: do it from a paired phone or from the app's window.") : null,
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
          if (o.command !== undefined) {
            if (o.header?.length || o.sse || o["client-id"] !== undefined || o.scope !== undefined || o["client-secret"]) throw usage("--header, --sse, --client-id, --scope and --client-secret are for a web address.");
            const line = [o.command, ...args];
            if (!(await mayRun(context, name, line, o.cwd))) return EXIT.failed;
            const values = await secrets(context, { env: o.env ?? [] });
            data = { name, type: "stdio", command: o.command, args, ...(o.cwd !== undefined && { cwd: o.cwd }), env: values.env };
          } else {
            if (args.length || o.cwd !== undefined || o.env?.length) throw usage("--cwd, --env and the arguments after -- are for a program.");
            if (o["client-secret"] && o["client-id"] === undefined) throw usage("A client secret needs its client ID (--client-id).");
            const values = await secrets(context, { headers: o.header ?? [], clientSecret: o["client-secret"] === true });
            const signIn = o["client-id"] !== undefined || o.scope !== undefined;
            data = { name, type: o.sse ? "sse" : "http", url: o.url, headers: values.headers, ...(signIn && { oauth: { clientId: o["client-id"], scope: o.scope, ...(values.clientSecret && { clientSecret: values.clientSecret }) } }) };
          }
          context.print(await context.client.call("tools.add", data), (tool) => "Added " + tool.name + ". Every bot has it now; `botkins bots tools <bot> --off " + tool.name + "` takes it from one. Try it with `botkins tools test " + tool.name + "`.");
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
          const patch = {};
          if (o.name !== undefined) patch.name = o.name;
          if (local) {
            const line = [o.command ?? before.command, ...(newArgs ?? before.args)];
            // Shown again, and asked again, whenever what will run is not what was shown before.
            if (JSON.stringify(line) !== JSON.stringify(before.runs) || (o.cwd !== undefined && o.cwd !== (before.cwd ?? ""))) {
              if (!(await mayRun(context, o.name ?? before.name, line, o.cwd ?? before.cwd))) return EXIT.failed;
            }
            if (o.command !== undefined) patch.command = o.command;
            if (newArgs !== undefined) patch.args = newArgs;
            if (o.cwd !== undefined) patch.cwd = o.cwd;
            const values = await secrets(context, { env: o.env ?? [] });
            if (o.env?.length || o["remove-env"]?.length) patch.env = { ...values.env, ...Object.fromEntries((o["remove-env"] ?? []).map((name) => [name, false])) };
          } else {
            if (o.url !== undefined) patch.url = o.url;
            const values = await secrets(context, { headers: o.header ?? [], clientSecret: o["client-secret"] === true });
            if (o.header?.length || o["remove-header"]?.length) patch.headers = { ...values.headers, ...Object.fromEntries((o["remove-header"] ?? []).map((name) => [name, false])) };
            if (o["no-sign-in"]) patch.oauth = null;
            else if (o["client-id"] !== undefined || o.scope !== undefined || values.clientSecret) patch.oauth = { ...(o["client-id"] !== undefined && { clientId: o["client-id"] }), ...(o.scope !== undefined && { scope: o.scope }), ...(values.clientSecret && { clientSecret: values.clientSecret }) };
          }
          if (!Object.keys(patch).length) throw usage("Say what to change. `botkins help tools edit` lists the options.");
          context.print(await context.client.call("tools.edit", before.id, patch), (tool) => "Saved " + tool.name + ".");
        },
      },
      remove: {
        summary: "Remove a tool, with its stored values and its sign-in",
        usage: "botkins tools remove <tool> [--yes]",
        options: YES,
        async run(context) {
          const ref = one(context, "Name the tool (its name or id).");
          if (!(await confirm(context, "Remove " + ref + " with its stored values?"))) return EXIT.failed;
          context.print(await context.client.call("tools.remove", ref), (gone) => "Removed " + gone.name + ".");
        },
      },
      enable: {
        summary: "Turn a tool on for every bot that has it",
        usage: "botkins tools enable <tool> [--yes]",
        options: YES,
        details: "A tool that is a program is shown before it is turned on, and needs your yes.",
        async run(context) {
          const tool = await context.client.call("tools.get", one(context, "Name the tool (its name or id)."));
          if (tool.kind === "command" && !tool.enabled && !(await mayRun(context, tool.name, tool.runs, tool.cwd))) return EXIT.failed;
          context.print(await context.client.call("tools.enable", tool.id, true), (now) => now.name + " is on.");
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
        usage: "botkins tools test <tool>",
        details: "A tool that is a program is started for this, as it is for a bot.",
        async run(context) {
          const tool = await context.client.call("tools.get", one(context, "Name the tool (its name or id)."));
          if (tool.kind === "command") context.note("Starting: " + shown(tool.runs));
          context.print(await context.client.call("tools.test", tool.id), (result) => result.name + ": " + result.status + (result.tools?.length ? "\n" + result.tools.map((name) => "  " + name).join("\n") : ""));
        },
      },
      import: {
        summary: "Add the tools of a JSON file, such as another app's MCP settings",
        usage: "botkins tools import <file> [--yes]",
        options: YES,
        details: "The file is { \"mcpServers\": { \"name\": { \"command\": \"npx\", \"args\": [\"…\"] } } }, or the same under \"servers\". \"-\" reads standard input. Each tool that is a program is shown before anything is added, and all of them need one yes. A tool whose name is taken is left out.",
        async run(context) {
          const json = await textFrom(context, one(context, "Name the JSON file, or - for standard input."), "file");
          const found = await context.client.call("tools.import.preview", json);
          const fresh = found.filter((tool) => !tool.exists);
          const programs = fresh.filter((tool) => tool.kind === "command");
          if (programs.length) {
            context.note("These start a program on this computer, as the user that runs Botkins:");
            for (const tool of programs) context.note("  " + tool.name + ": " + shown(tool.runs) + (tool.cwd ? "   (in " + tool.cwd + ")" : ""));
            if (!(await confirm(context, "Add " + (fresh.length === 1 ? "it" : "all " + fresh.length + " tools") + " and let Botkins start " + (programs.length === 1 ? "it" : "them") + "?"))) return EXIT.failed;
          }
          context.print(await context.client.call("tools.import", json), (result) => (result.added.length ? "Added " + result.added.join(", ") + "." : "Nothing was added.") + (result.skipped.length ? " Left out, because the name is taken: " + result.skipped.join(", ") + "." : ""));
        },
      },
      "sign-out": {
        summary: "Forget a tool's sign-in",
        usage: "botkins tools sign-out <tool>",
        details: "A tool on the web signs in through a browser, which this command line does not have. Sign it in from a paired phone (Settings, Tools) or from the app's window.",
        async run(context) {
          context.print(await context.client.call("tools.signOut", one(context, "Name the tool (its name or id).")), (tool) => tool.name + " is signed out.");
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
      list: {
        summary: "List the skills",
        usage: "botkins skills list",
        async run(context) {
          context.print(await context.client.call("skills.list"), (all) => (all.skills.length ? table(["NAME", "STATE", "FROM", "DESCRIPTION"], all.skills.map((skill) => [skill.name, skill.enabled ? "on" : "off", skill.origin === "commander" ? "Botkins" : skill.origin, skill.description.length > 70 ? skill.description.slice(0, 69) + "…" : skill.description])) : "No skills yet. Add one with `botkins skills add`."));
        },
      },
      show: {
        summary: "Show one skill, with its instructions when Botkins keeps it",
        usage: "botkins skills show <skill>",
        async run(context) {
          context.print(await context.client.call("skills.get", one(context, "Name the skill.")), (skill) => [skill.name + (skill.enabled ? "" : " (off)"), skill.description, skill.instructions !== undefined ? "\n" + skill.instructions : "\nIts instructions are in " + skill.path + "."].join("\n"));
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
          context.print(await context.client.call("skills.save", { name, description: o.description, instructions }), (skill) => "Added " + skill.name + ". Every bot has it now; `botkins bots skills <bot> --off " + skill.name + "` takes it from one.");
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
          const before = await context.client.call("skills.get", ref);
          if (before.instructions === undefined) throw new CliError(before.name + " is not a skill that Botkins keeps. Change it in its folder: " + before.path);
          const instructions = o.instructions ?? (o["instructions-file"] !== undefined ? await textFrom(context, o["instructions-file"], "file") : before.instructions);
          context.print(await context.client.call("skills.save", { original: before.name, name: o.name ?? before.name, description: o.description ?? before.description, instructions }), (skill) => "Saved " + skill.name + ".");
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
          context.print(await context.client.call("skills.enable", one(context, "Name the skill."), true), (skill) => skill.name + " is on.");
        },
      },
      disable: {
        summary: "Turn a skill off for every bot, and keep it",
        usage: "botkins skills disable <skill>",
        async run(context) {
          context.print(await context.client.call("skills.enable", one(context, "Name the skill."), false), (skill) => skill.name + " is off.");
        },
      },
      folders: {
        summary: "List the linked folders of skills",
        usage: "botkins skills folders",
        async run(context) {
          context.print(await context.client.call("skills.list"), (all) => {
            const rows = [...all.folders.map((folder) => [folder.id, "skills", folder.missing ? "missing" : String(folder.skills), folder.path]), ...all.plugins.map((folder) => [folder.id, "plugin", folder.missing ? "missing" : "", folder.path])];
            return rows.length ? table(["ID", "KIND", "SKILLS", "PATH"], rows) : "No folders are linked. Link one with `botkins skills add-folder <path>`.";
          });
        },
      },
      "add-folder": {
        summary: "Add a skill from its folder, or link a folder of skills",
        usage: "botkins skills add-folder <path>",
        details: "Give a full path in your home folder or on a plugged-in disk. A folder with a SKILL.md is copied into Botkins. A folder of such folders is linked and read where it is.",
        async run(context) {
          context.print(await context.client.call("skills.addFolder", one(context, "Give the folder's full path.")), (added) => (added.kind === "skill" ? "Added the skill " + added.name + "." : added.kind === "folder" ? "Linked " + added.name + " (" + added.count + " skill" + (added.count === 1 ? "" : "s") + ")." : "Linked the plugin folder " + added.name + "."));
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
    details: "What a person gets when they type \"/\" in a chat with this bot. It opens a session with the bot's model, so the provider must be signed in.",
    async run(context) {
      context.print(await context.client.call("bots.menu", one(context, "Name the bot (its name or id)."), context.options.refresh === true), (menu) => {
        const rows = (menu.choices ?? []).map((choice) => ["/" + choice.command, choice.kind ?? "", choice.source ?? "", (choice.description ?? "").slice(0, 60)]);
        const servers = (menu.servers ?? []).map((server) => "  " + server.name + ": " + (server.status ?? ""));
        return [rows.length ? table(["COMMAND", "KIND", "FROM", "WHAT"], rows) : "Nothing is offered.", ...(servers.length ? ["", "Tools:", ...servers] : [])].join("\n");
      });
    },
  },
};
