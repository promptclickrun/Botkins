// More of a bot, and templates: the commands (cli/commands/index.mjs adds them).
// `botsCommands` maps a top-level word to a group `{ summary, commands }`. A group whose word is there
// already (`bots`, `routines`, `providers`, …) gets these commands added to its own.
//
// Here: `botkins bots duplicate|order|primary|flags|memory|sections|import` and `botkins templates`.
//
// Three rules hold in this file:
//  - A long text (a bot's memory, a template) comes from `--file <path>`, or `-` for standard
//    input. It is never only typed into an editor.
//  - Words from elsewhere that then steer a bot (an agent's instructions, a template file) are
//    shown before they are brought in, and a person says yes (`--yes` when there is no terminal).
//  - A text that is shown has each character that hides or turns text written as its number
//    (`safe`). `--json` gives the text as it is.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, readAll } from "./input.mjs";
import { safe, shellWord } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first" } };
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const call = (context, method, ...args) => context.client.call(method, ...args);
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person what it brings in. */
const show = (context, text) => void context.stderr.write(text + "\n");
/** A long text as it can be shown: each line safe, a tab as spaces. */
const safeLines = (text) => String(text).replace(/\r\n?/g, "\n").split("\n").map((line) => safe(line.replaceAll("\t", "    "))).join("\n");
const indent = (text, by) => safeLines(text).split("\n").map((line) => (line ? by + line : line)).join("\n");
/** A file's text, or standard input for "-". */
async function textFrom(context, path, what) {
  if (path === "-") return readAll(context.stdin);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The " + what + " " + path + " can't be read: " + error.message);
  }
}
/** The text comes from standard input, so a question cannot be asked of the person: the yes must be in the command. */
const stdinMeansYes = (context, path) => {
  if (path === "-" && !context.options.yes) throw usage("The text comes from standard input, so there is no way to ask first. Run it again with --yes.");
};
const count = (number, word) => number + " " + word + (number === 1 ? "" : "s");
/** A name written for a person: its words are safe, and one that is not plain gets quotes. */
const named = (name) => safe(name);
/** A command that Botkins prints for someone to run names a bot by a word that a shell reads as one word. */
const botWord = (name) => shellWord(name, "<the bot>");

const placeText = (bot) =>
  [
    named(bot.name) + (bot.primary ? " (the primary bot)" : "") + "   " + bot.id,
    "Pinned: " + (bot.pinned ? "yes" : "no"),
    "Hidden: " + (bot.hidden ? "yes" : "no"),
    "Teamwork: " + (bot.teamwork ? "on (other bots may ask it for help)" : "off (it is left out when bots ask each other for help)"),
    "Section: " + (bot.section ? named(bot.section.name) : "none"),
  ].join("\n");

const agentLine = (agent) => agent.added ? "a bot already" : agent.problem ? "can't be added" : "new";

/** What bringing in the agents shows: each one's own words, as they will steer the bot. */
function agentBlock(agents) {
  return agents.flatMap((agent) => [
    "  " + named(agent.name) + " (" + named(agent.role) + ")",
    "      from " + named(agent.providerName) + (agent.file ? ", the file " + JSON.stringify(safe(agent.file)) : ""),
    ...(agent.model ? ["      model: " + named(agent.model)] : []),
    ...(agent.missingModel ? ["      The agent names the model " + named(agent.missingModel) + ", which this account does not offer. The bot gets the default model."] : []),
    ...(agent.ownTools ? ["      The agent has its own tool settings. The bot does not take them over."] : []),
    "      Instructions (" + count(agent.instructions.length, "character") + "):",
    indent(agent.instructions, "        "),
  ]);
}

const templateText = (template) =>
  [
    named(template.name) + "   " + template.id,
    "Role: " + named(template.role),
    ...(template.summary ? ["About: " + named(template.summary)] : []),
    "From: " + (template.source === "imported" ? "a file that was imported" + (template.from ? " (" + named(template.from) + ")" : "") : "a bot of this computer"),
    ...(template.instructions !== undefined ? ["", "Instructions:", indent(template.instructions, "  ")] : []),
  ].join("\n");

export const botsCommands = {
  bots: {
    summary: "List, add, change and remove bots",
    commands: {
      duplicate: {
        summary: "Make a copy of a bot",
        usage: "botkins bots duplicate <bot>",
        details: "The copy has the same role, instructions and model, and the name \"<name> copy\". It has no chats and no memory of its own yet.",
        async run(context) {
          context.print(await call(context, "bots.duplicate", one(context, "Name the bot (its name or id).")), (copy) => "Copied " + named(copy.from.name) + " as " + named(copy.name) + ". Change its name with `botkins bots edit " + botWord(copy.name) + " --name <text>`.");
        },
      },
      order: {
        summary: "Show the order of the bots, or put some first",
        usage: "botkins bots order [<bot>…]",
        arguments: [{ name: "bot", required: false, many: true }],
        details: "With no bot, this lists the bots in their order. The bots that you name go first, in the order that you give them. The other bots follow in the order they have now. The first bot is the primary bot.",
        async run(context) {
          const list = context.args.length ? await call(context, "bots.order", context.args) : await call(context, "bots.list");
          context.print(list, (bots) => table(["#", "NAME", "ID"], bots.map((bot, index) => [index + 1, named(bot.name) + (index === 0 ? " (primary)" : ""), bot.id])));
        },
      },
      primary: {
        summary: "Make a bot the primary bot",
        usage: "botkins bots primary <bot>",
        details: "The primary bot is the first one. It is never hidden, and it cannot be hidden while it is the first.",
        async run(context) {
          context.print(await call(context, "bots.primary", one(context, "Name the bot (its name or id).")), (bot) => named(bot.name) + " is the primary bot now.");
        },
      },
      flags: {
        summary: "Show or change whether a bot is pinned, hidden, open to teamwork, and its section",
        usage: "botkins bots flags <bot> [--pin | --unpin] [--hide | --show] [--teamwork | --no-teamwork] [--section <section> | --no-section]",
        options: {
          pin: { type: "boolean", about: "Pin the bot in the list" },
          unpin: { type: "boolean", about: "Take the pin away" },
          hide: { type: "boolean", about: "Hide the bot from the list (the primary bot cannot be hidden)" },
          show: { type: "boolean", about: "Show a hidden bot again" },
          teamwork: { type: "boolean", about: "Other bots may ask this bot for help" },
          "no-teamwork": { type: "boolean", about: "Leave this bot out when bots ask each other for help" },
          section: { type: "string", value: "section", about: "Put the bot in this section, by its name or id (see `botkins bots sections list`)" },
          "no-section": { type: "boolean", about: "Take the bot out of its section" },
        },
        details: "With no option, this shows the flags. Only what you name changes.",
        async run(context) {
          const ref = one(context, "Name the bot (its name or id).");
          const o = context.options;
          const pair = (on, off, flags) => {
            if (o[on] && o[off]) throw usage("Give " + flags + ", not both.");
            return o[on] ? true : o[off] ? false : undefined;
          };
          const pinned = pair("pin", "unpin", "--pin or --unpin");
          const hidden = pair("hide", "show", "--hide or --show");
          const teamwork = pair("teamwork", "no-teamwork", "--teamwork or --no-teamwork");
          if (o.section !== undefined && o["no-section"]) throw usage("Give --section or --no-section, not both.");
          const patch = { ...(pinned !== undefined && { pinned }), ...(hidden !== undefined && { hidden }), ...(teamwork !== undefined && { teamwork }), ...(o.section !== undefined && { section: o.section }), ...(o["no-section"] && { section: null }) };
          context.print(Object.keys(patch).length ? await call(context, "bots.flags.set", ref, patch) : await call(context, "bots.flags", ref), placeText);
        },
      },
      memory: {
        summary: "Show a bot's memory, or replace it from a file",
        usage: "botkins bots memory <bot> [--file <path> | --clear] [--yes]",
        options: {
          file: { type: "string", value: "path", about: "Replace the memory with the text of this file. \"-\" reads standard input" },
          clear: { type: "boolean", about: "Clear the memory" },
          ...YES,
        },
        details: "The memory is the text that a bot reads at the start of each chat: lines that start with \"- \". With no option, this prints it (--json gives the text as it is). Replacing or clearing a memory that has text asks first, because the old text is gone. With no terminal, or with the text on standard input, it needs --yes.",
        async run(context) {
          const ref = one(context, "Name the bot (its name or id).");
          const o = context.options;
          if (o.file !== undefined && o.clear) throw usage("Give --file or --clear, not both.");
          const before = await call(context, "bots.memory", ref);
          if (o.file === undefined && !o.clear) return void context.print(before, (memory) => (memory.text.trim() ? safeLines(memory.text.replace(/\n+$/, "")) : named(memory.name) + " has no memory yet."));
          stdinMeansYes(context, o.file);
          const text = o.clear ? "" : await textFrom(context, o.file, "file");
          // A memory with nothing in it loses nothing; one with text is replaced for good.
          if (before.characters && !(await confirm(context, "Replace the memory of " + named(before.name) + " (" + count(before.characters, "character") + ") with " + (text.trim() ? count(text.trim().length, "character") : "nothing") + "?"))) return EXIT.failed;
          context.print(await call(context, "bots.memory.set", ref, text), (done) => (done.characters ? "Saved the memory of " + named(done.name) + " (" + count(done.characters, "character") + ")." : "The memory of " + named(done.name) + " is clear."));
        },
      },
      sections: {
        summary: "List, add, rename and remove the sections that group the bots",
        commands: {
          list: {
            summary: "List the sections and the bots in each",
            usage: "botkins bots sections list",
            async run(context) {
              context.print(await call(context, "bots.sections"), (list) => (list.length ? table(["NAME", "BOTS", "ID"], list.map((entry) => [named(entry.name), entry.bots.map((bot) => named(bot.name)).join(", "), entry.id])) : "No sections yet. Add one with `botkins bots sections add <name>`."));
            },
          },
          add: {
            summary: "Add a section",
            usage: "botkins bots sections add <name>",
            async run(context) {
              context.print(await call(context, "bots.sections.add", one(context, "Give the section a name.")), (made) => "Added the section " + named(made.name) + ". Put a bot in it with `botkins bots flags <bot> --section " + shellWord(made.name, "<the section>") + "`.");
            },
          },
          rename: {
            summary: "Rename a section",
            usage: "botkins bots sections rename <section> <name>",
            async run(context) {
              if (context.args.length !== 2) throw usage("Name the section (its name or id), then its new name.");
              context.print(await call(context, "bots.sections.rename", context.args[0], context.args[1]), (done) => "Renamed it to " + named(done.name) + ".");
            },
          },
          remove: {
            summary: "Remove a section. Its bots stay, in no section",
            usage: "botkins bots sections remove <section> [--yes]",
            details: "Give the whole name, or the id. The start of a name is not enough for a removal.",
            options: YES,
            async run(context) {
              const found = await call(context, "bots.sections.get", one(context, "Name the section (its name or id)."), { exact: true });
              if (!(await confirm(context, "Remove the section " + named(found.name) + "? " + (found.bots.length ? "Its " + count(found.bots.length, "bot") + " stay, in no section." : "It has no bots.")))) return EXIT.failed;
              context.print(await call(context, "bots.sections.remove", found.id), (gone) => "Removed the section " + named(gone.name) + ".");
            },
          },
        },
      },
      import: {
        summary: "List the agents that a provider has, and bring some in as bots",
        usage: "botkins bots import [<agent>…] [--yes]",
        arguments: [{ name: "agent", required: false, many: true }],
        options: YES,
        details: [
          "With no agent, this lists the agents of the providers that are on (for Copilot, the files in ~/.copilot/agents), and whether each is a bot already.",
          "With one or more agents, by name, this makes a bot of each. The bot is a copy: later changes to the agent do not reach it. An agent that is a bot already is left out.",
          "An agent's instructions are someone else's words, and they steer the bot. So the command shows each agent first: its role, its model and its whole instructions. It then asks. With no terminal it needs --yes. The text is printed on standard error with --yes and with --json too.",
        ].join("\n"),
        async run(context) {
          if (!context.args.length) {
            return void context.print(await call(context, "bots.importable"), (list) =>
              list.length
                ? table(["NAME", "ROLE", "FROM", "STATE", "KEY"], list.map((agent) => [named(agent.name), named(agent.role), named(agent.providerName), agentLine(agent), safe(agent.key)])) + "\nBring one in with `botkins bots import <agent>`."
                : "No provider that is on has an agent to bring in. For Copilot, the agents are the files in ~/.copilot/agents.",
            );
          }
          const found = await call(context, "bots.import.preview", context.args);
          const broken = found.find((agent) => agent.problem);
          if (broken) throw new CliError(safe(broken.name) + " can't be added. " + safe(broken.problem));
          const fresh = found.filter((agent) => agent.willAdd);
          const skipped = found.filter((agent) => agent.added).map((agent) => agent.name);
          if (!fresh.length) return void context.print({ added: [], skipped }, () => "Nothing to add: " + skipped.map(named).join(", ") + (skipped.length === 1 ? " is a bot already." : " are bots already."));
          show(context, ["This makes " + (fresh.length === 1 ? "a bot" : count(fresh.length, "bot")) + " from " + (fresh.length === 1 ? "this agent" : "these agents") + ". Their instructions are words from elsewhere, and they steer the bot:", "", ...agentBlock(fresh), ...(skipped.length ? ["", "Left out, because it is a bot already: " + skipped.map(named).join(", ") + "."] : [])].join("\n"));
          if (!(await confirm(context, "Make " + (fresh.length === 1 ? "this bot" : "these " + count(fresh.length, "bot")) + "?"))) return EXIT.failed;
          context.print(await call(context, "bots.import", context.args), (done) => (done.added.length ? "Added " + done.added.map((bot) => named(bot.name)).join(", ") + "." : "Nothing was added.") + (done.skipped.length ? " Left out: " + done.skipped.map(named).join(", ") + " (a bot already)." : ""));
        },
      },
    },
  },
  templates: {
    summary: "Save, share and remove bot templates",
    details: "A template is a bot's setup without its history: its name, role, about text, instructions and look. Save one from a bot, export it as a file, or import one that someone shared.",
    commands: {
      list: {
        summary: "List the templates",
        usage: "botkins templates list",
        async run(context) {
          context.print(await call(context, "templates.list"), (list) => (list.length ? table(["NAME", "ROLE", "FROM", "ID"], list.map((entry) => [named(entry.name), named(entry.role), entry.source === "imported" ? "imported" + (entry.from ? " (" + named(entry.from) + ")" : "") : "saved", entry.id])) : "No templates yet. Save one from a bot with `botkins templates save <bot>`."));
        },
      },
      show: {
        summary: "Show one template, with its instructions",
        usage: "botkins templates show <template>",
        async run(context) {
          context.print(await call(context, "templates.get", one(context, "Name the template (its name or id).")), templateText);
        },
      },
      save: {
        summary: "Save a bot's setup as a template",
        usage: "botkins templates save <bot> [--name <text>]",
        options: { name: { type: "string", value: "text", about: "The template's name (the bot's name without it)" } },
        async run(context) {
          const ref = one(context, "Name the bot (its name or id).");
          context.print(await call(context, "templates.save", ref, context.options.name), (template) => "Saved the template " + named(template.name) + ". Share it with `botkins templates export " + shellWord(template.name, "<the template>") + " --file <path>`.");
        },
      },
      rename: {
        summary: "Rename a template",
        usage: "botkins templates rename <template> <name>",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the template (its name or id), then its new name.");
          context.print(await call(context, "templates.rename", context.args[0], context.args[1]), (template) => "Renamed it to " + named(template.name) + ".");
        },
      },
      remove: {
        summary: "Remove a template",
        usage: "botkins templates remove <template> [--yes]",
        details: "Give the whole name, or the id. The start of a name is not enough for a removal.",
        options: YES,
        async run(context) {
          const found = await call(context, "templates.get", one(context, "Name the template (its name or id)."), { exact: true });
          if (!(await confirm(context, "Remove the template " + named(found.name) + "?"))) return EXIT.failed;
          context.print(await call(context, "templates.remove", found.id), (gone) => "Removed the template " + named(gone.name) + ".");
        },
      },
      export: {
        summary: "Write a template, or a bot as a template, as a file that can be shared",
        usage: "botkins templates export [<template>] [--bot <bot>] [--file <path>] [--yes]",
        arguments: [{ name: "template", required: false }],
        options: {
          bot: { type: "string", value: "bot", about: "Export this bot's setup, not a saved template" },
          file: { type: "string", value: "path", about: "Write the file here. \"-\", or no --file, prints it" },
          ...YES,
        },
        details: "Give a template, or --bot. The file is JSON. It holds the name, role, about text, instructions and look, and nothing of the bot's folders, chats or credentials. Printed as text, it has each character that hides or turns text written as its number; --file and --json give it as it is. An existing file is replaced only after a yes. The app also keeps a copy among the bot's files.",
        async run(context) {
          const o = context.options;
          if (context.args.length > 1 || (context.args.length === 1) === (o.bot !== undefined)) throw usage("Name one template, or give --bot <bot>, one of them.");
          const toFile = o.file !== undefined && o.file !== "-";
          // The question comes first: a refused replace makes no export.
          if (toFile && existsSync(o.file) && !(await confirm(context, "Replace the file " + JSON.stringify(safe(o.file)) + "?"))) return EXIT.failed;
          const file = await call(context, "templates.export", context.args.length ? { template: context.args[0] } : { bot: o.bot });
          if (!toFile) return void context.print(file, (made) => safeLines(made.text.replace(/\n+$/, "")));
          try {
            writeFileSync(o.file, file.text);
          } catch (error) {
            throw new CliError("The file " + o.file + " can't be written: " + error.message);
          }
          context.print({ name: file.name, path: o.file }, () => "Wrote " + safe(o.file) + ".");
        },
      },
      import: {
        summary: "Save the template of a file that someone shared",
        usage: "botkins templates import <file> [--yes]",
        options: YES,
        details: "\"-\" reads standard input. A template file holds someone else's words, and they steer a bot made from it. So the command shows the name, role, about text and whole instructions first, and asks. With no terminal, or with the file on standard input, it needs --yes. The text is printed on standard error with --yes and with --json too. This saves a template only; no bot is made.",
        async run(context) {
          const path = one(context, "Name the template file, or - for standard input.");
          stdinMeansYes(context, path);
          const text = await textFrom(context, path, "file");
          const file = { ...(path !== "-" && { name: basename(path) }), text };
          const found = await call(context, "templates.import.preview", file);
          show(context, ["This file holds a template. Its words steer a bot that is made from it:", "", "  " + named(found.name), "      Role: " + named(found.role), ...(found.summary ? ["      About: " + named(found.summary)] : []), "      Instructions (" + count(found.instructions.length, "character") + "):", indent(found.instructions, "        "), ...(found.exists ? ["", "A template with this name is saved already. This one is saved beside it."] : [])].join("\n"));
          if (!(await confirm(context, "Save this template?"))) return EXIT.failed;
          context.print(await call(context, "templates.import", file), (template) => "Saved the template " + named(template.name) + ".");
        },
      },
    },
  },
};
