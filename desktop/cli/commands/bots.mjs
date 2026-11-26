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

/** A bot's Proactive agent as `bots proactive` shows it. */
const proactiveText = (view) =>
  [
    named(view.name) + ": the Proactive agent is " + (view.enabled ? "on" : "off") + (view.enabled && !view.computerOn ? " but paused (the computer's switch is off: `botkins preferences set proactive.enabled on`)" : view.enabled && !view.setUp ? " but not set up yet (`botkins bots proactive " + shellWord(view.name) + " on` finishes its setup)" : "") + ".",
    "Looks out for: " + (view.people?.length ? view.people.map((person) => named(person.name) + (person.on ? "" : " (off)") + (person.notify ? "" : " (not notified)")).join(", ") : "nobody yet") + ".",
    "Checks for changes every " + view.every + " minutes. " + (view.sweepHours ? "Looks around its own sources every " + view.sweepHours + " hours." : "Never looks around its own sources.") + " At most " + view.maxPerDay + " alerts a day.",
    "Alerts go to " + (view.deliver === "feed" ? "each person's Feed" : "its chat with each person") + ". Watches: " + (view.watch.length ? view.watch.join(", ") : "nothing") + ".",
    ...(view.nextReviewAt ? ["Planned follow-up: " + new Date(view.nextReviewAt).toLocaleString()] : []),
    ...(view.learning?.rated ? ["Rated suggestions: " + view.learning.rated,
      ...view.learning.preferred.map((r) => "Preferred approach: " + safe(r)), ...view.learning.retired.map((r) => "Set aside: " + safe(r))] : []),
    ...(view.instructions ? ["Rules: " + safe(view.instructions).replace(/\s+/g, " ").slice(0, 200)] : []),
    ...(view.pings !== undefined && view.enabled ? ["Alerts today: " + view.pings + " of " + view.maxPerDay + "."] : []),
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

function bundleLines(bundle) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const lines = [];
  for (const skill of bundle?.skills ?? []) {
    lines.push("", "Skill for this bot: " + named(skill.name), "  " + named(skill.description), indent(skill.instructions, "  "));
  }
  for (const routine of bundle?.routines ?? []) {
    const { kind, time, days: selected } = routine.cadence;
    const when = kind === "weekly" ? selected.map(day => days[day]).join(", ") : kind === "weekdays" ? "Weekdays" : "Daily";
    lines.push("", "Paused routine: " + named(routine.name), "  " + when + " at " + safe(time) + " (host time)", indent(routine.instructions, "  "));
  }
  return lines;
}

async function readTemplate(context, ref) {
  try {
    return await call(context, "templates.get", ref);
  } catch (error) {
    if (!ref.includes("@")) throw error;
    return call(context, "templates.market", ref, 2);
  }
}

const templateText = (template) =>
  [
    named(template.name) + "   " + template.id,
    "Role: " + named(template.role),
    ...(template.summary ? ["About: " + named(template.summary)] : []),
    "From: " + (template.source === "imported" ? "a file that was imported" + (template.from ? " (" + named(template.from) + ")" : "") : "a bot of this computer"),
    ...(template.instructions !== undefined ? ["", "Instructions:", indent(template.instructions, "  ")] : []),
    ...bundleLines(template.bundle),
  ].join("\n");

/** A marketplace template, as `templates show` and `templates use` show it. */
const marketText = (template) =>
  [
    named(template.name) + "   " + template.id,
    "Role: " + named(template.role),
    ...(template.summary ? ["About: " + named(template.summary)] : []),
    "From: " + named(template.marketplaceName) + (template.categoryName ? " · " + template.categoryName : "") + (template.version ? " · v" + named(template.version) : "") + (template.builtIn ? "" : " (someone else wrote these instructions: read them first)"),
    "",
    "Instructions:",
    indent(template.instructions, "  "),
    ...bundleLines(template.bundle),
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
      proactive: {
        summary: "Show or change a bot's Proactive agent (experimental)",
        usage: "botkins bots proactive <bot> [on | off] [--add <person>] [--remove <person>] [--person <person>] [--alerts <on|off>] [--notify <on|off>] [--every <minutes>] [--look-around <hours>] [--max-alerts <n>] [--deliver <chat|feed>] [--watch <runs,tasks,requests,context|none>] [--rules <text> | --rules-file <path>] [--reset] [--yes]",
        arguments: [{ name: "bot", required: true }, { name: "state", required: false }],
        options: {
          add: { type: "string", value: "person", about: "Look out for this person too: owner, or a team member's name or id (their role must see the bot)" },
          remove: { type: "string", value: "person", about: "Stop looking out for this person" },
          person: { type: "string", value: "person", about: "The person --alerts and --notify are for. Without it they are for the owner" },
          alerts: { type: "string", value: "on|off", about: "Turn that person's own check on or off" },
          notify: { type: "string", value: "on|off", about: "Whether that person is notified of an alert. Off still delivers it, quietly" },
          every: { type: "string", value: "minutes", about: "Minutes between its checks for changes: 15, 30, 60 or 120 (a check with nothing new uses no model)" },
          "look-around": { type: "string", value: "hours", about: "Hours between its looks around its own sources: 0 (never), 1, 2, 3, 6 or 12 (each look uses the model)" },
          "max-alerts": { type: "string", value: "n", about: "The most alerts it gives in a day: 3, 6, 10 or 20" },
          deliver: { type: "string", value: "chat|feed", about: "Where alerts go: the bot's chat with the person, or their Feed" },
          watch: { type: "string", value: "list", about: "What Botkins watches for it: runs, tasks, requests, context, or none" },
          rules: { type: "string", value: "text", about: "Your own rules for what is worth telling you (up to 2000 characters)" },
          "rules-file": { type: "string", value: "path", about: "Read the rules from a file. \"-\" reads standard input" },
          reset: { type: "boolean", about: "Forget this bot's Proactive settings and routine" },
          ...YES,
        },
        details: "Each bot has its own Proactive agent: with no option this shows it. `on` finishes its setup and turns it on (for the owner, when it looks out for nobody yet); `off` turns the bot's agent off for everyone. The computer's switch is the preference `proactive.enabled` and pauses every bot's agent without forgetting its settings. Turning an agent on is shown first and needs your yes (--yes with no terminal), because the bot then wakes with nobody watching, reads what its tools reach and messages you. A bot looks out for several people: --add and --remove say who, and --alerts and --notify set one person's own check and whether they are notified (an alert goes only to the person it is about). Botkins keeps one routine for each person, named \"<bot> looks out for <person>\" in `botkins routines list`; `botkins routines run` on it checks now. `botkins bots alert` acts on an alert. Only what you name changes.",
        async run(context) {
          const [ref, word, ...extra] = context.args;
          if (ref === undefined || extra.length) throw usage("Name the bot (its name or id), and on or off to turn its agent on or off.");
          const o = context.options;
          if (word !== undefined && !["on", "off"].includes(word.toLowerCase())) throw usage("Say on or off, or leave it out.");
          if (o.rules !== undefined && o["rules-file"] !== undefined) throw usage("Give --rules or --rules-file, not both.");
          const number = (flag, what) => {
            if (o[flag] === undefined) return {};
            if (!/^\d{1,4}$/.test(o[flag].trim())) throw usage("--" + flag + " takes a number of " + what + ".");
            return { [flag]: Number(o[flag]) };
          };
          const given = { ...number("every", "minutes"), ...number("look-around", "hours"), ...number("max-alerts", "alerts") };
          const onOff = (flag) => {
            if (o[flag] === undefined) return undefined;
            const said = o[flag].trim().toLowerCase();
            if (!["on", "off"].includes(said)) throw usage("--" + flag + " takes on or off.");
            return said === "on";
          };
          const alerts = onOff("alerts");
          const notify = onOff("notify");
          if (o.person !== undefined && alerts === undefined && notify === undefined) throw usage("Give --alerts or --notify with --person.");
          const people = {
            ...(o.add !== undefined && { [o.add]: { on: true } }),
            ...(o.remove !== undefined && { [o.remove]: null }),
            ...((alerts !== undefined || notify !== undefined) && { [o.person ?? "owner"]: { ...(alerts !== undefined && { on: alerts }), ...(notify !== undefined && { notify }) } }),
          };
          const before = await call(context, "bots.proactive", ref);
          const turningOn = word !== undefined && word.toLowerCase() === "on";
          // `on` stands for the setup steps of the app: the bot is set up, and looks out for the owner when it looks out for nobody.
          if (turningOn && !before.people.length && !Object.keys(people).length) people.owner = { on: true };
          const patch = {
            ...(word !== undefined && { enabled: turningOn }),
            ...(turningOn && !before.setUp && { setUp: true }),
            ...(Object.keys(people).length && { people }),
            ...(given.every !== undefined && { every: given.every }),
            ...(given["look-around"] !== undefined && { sweepHours: given["look-around"] }),
            ...(given["max-alerts"] !== undefined && { maxPerDay: given["max-alerts"] }),
            ...(o.deliver !== undefined && { deliver: o.deliver.trim().toLowerCase() }),
            ...(o.watch !== undefined && { watch: o.watch.trim().toLowerCase() === "none" ? [] : o.watch.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) }),
            ...(o.rules !== undefined && { instructions: o.rules }),
            ...(o["rules-file"] !== undefined && { instructions: (await textFrom(context, o["rules-file"], "file")).replace(/\r?\n$/, "") }),
          };
          stdinMeansYes(context, o["rules-file"]);
          if (o.reset && Object.keys(patch).length) throw usage("Give --reset alone, or the settings to change.");
          let agreed = false;
          if ((patch.enabled === true && !before.enabled) || patch.setUp === true) {
            show(context, "Turning on a bot's Proactive agent lets " + named(before.name) + " wake on its own, read what its tools reach (such as your inbox and calendar) and message you, with nobody watching. Each wake uses the model.");
            if (!(await confirm(context, "Turn on the Proactive agent for " + named(before.name) + "?"))) return EXIT.failed;
            agreed = true;
          }
          const shown = o.reset ? await call(context, "bots.proactive.set", ref, null) : Object.keys(patch).length ? await call(context, "bots.proactive.set", ref, patch, ...(agreed ? [{ agreed: true }] : [])) : before;
          context.print(shown, (view) => proactiveText(view));
        },
      },
      alert: {
        summary: "List the alerts a bot sent you, or act on one: take its offer, or hear of it again later",
        usage: "botkins bots alert <bot> [<alert> <take | later>]",
        arguments: [{ name: "bot", required: true }, { name: "alert", required: false }, { name: "action", required: false }],
        details: "A bot that looks out for you sends alerts, and an alert may offer one thing the bot can do. With only the bot, this lists the alerts you were sent lately with their ids. `take` starts a normal turn in your chat with the bot, with what it offered as your message: its tools still ask for approval as usual, so an alert never approves anything ahead of time. `later` holds what the alert was about back for a day. Each alert is acted on once. These are the owner's alerts: a team member acts on theirs in the app.",
        async run(context) {
          const [ref, alert, action, ...extra] = context.args;
          if (ref === undefined || extra.length || (alert !== undefined && action === undefined)) throw usage("Name the bot. To act on an alert, give its id and take or later.");
          if (alert === undefined) {
            const view = await call(context, "bots.proactive", ref);
            return void context.print(view.alerts, (list) => (list.length ? table(["ALERT", "SENT", "OFFERS", "CHOSEN"], list.map((entry) => [entry.runId, new Date(entry.at).toLocaleString(), entry.offer ? safe(entry.offer) : "—", entry.chosen === "take" ? "taken" : entry.chosen === "later" ? "later" : "—"])) : named(view.name) + " has sent you no alert lately."));
          }
          const chosen = action.toLowerCase();
          if (!["take", "later"].includes(chosen)) throw usage("Say take or later.");
          context.print(await call(context, "bots.proactive.act", ref, alert, chosen), (done) => (chosen === "take" ? named(done.name) + " is taking care of it in chat " + done.chatId + ". Its tools ask for approval as usual." : named(done.name) + " will bring it up again after a day."));
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
    details: "A template holds a bot's name, role, about text, instructions, look, and any bundled skills and routines. Save one from a bot, export it as a file, or import one that someone shared.",
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
        details: "A template of your own by its name or id, or one from a marketplace by its id from `botkins templates browse` (name@marketplace).",
        async run(context) {
          const ref = one(context, "Name the template (its name or id, or name@marketplace from `botkins templates browse`).");
          const found = await readTemplate(context, ref);
          context.print(found, found.marketplace ? marketText : templateText);
        },
      },
      browse: {
        summary: "List the agent templates the marketplaces offer",
        usage: "botkins templates browse [<search>] [--category <id>] [--marketplace <id>]",
        options: {
          category: { type: "string", value: "id", about: "Only this category (writing, productivity, …)" },
          marketplace: { type: "string", value: "id", about: "Only this marketplace" },
        },
        details: "The same templates as Marketplace › Agents. Show one with `botkins templates show <id>`, and make a bot from it with `botkins templates use <id>`.",
        async run(context) {
          if (context.args.length > 1) throw usage("Give at most one search.");
          const o = context.options;
          const found = await call(context, "templates.browse", { ...(context.args[0] && { query: context.args[0] }), ...(o.category && { category: o.category }), ...(o.marketplace && { marketplace: o.marketplace }) });
          context.print(found, (result) => (result.agents.length ? table(["NAME", "ROLE", "CATEGORY", "FROM", "ID"], result.agents.map((agent) => [named(agent.name), named(agent.role), agent.categoryName ?? "", named(agent.marketplaceName), agent.id])) : "No agent templates match."));
        },
      },
      use: {
        summary: "Make a bot from a saved or marketplace template",
        usage: "botkins templates use <template> [--name <text>] [--yes]",
        options: { name: { type: "string", value: "text", about: "The bot's name (the template's without it)" }, ...YES },
        details: "Shows the template, including any skills and paused routines, before asking to create the bot. With no terminal it needs --yes. Change the bot afterwards with `botkins bots edit`.",
        async run(context) {
          const ref = one(context, "Name a template from `botkins templates list` or `botkins templates browse`.");
          const found = await readTemplate(context, ref);
          show(context, ["This template's words steer the bot that is made from it:", "", found.marketplace ? marketText(found) : templateText(found)].join("\n"));
          if (!(await confirm(context, "Make a bot from it?"))) return EXIT.failed;
          context.print(await call(context, "templates.use", found.id, context.options.name, { version: 2, saved: !found.marketplace, template: found }), (made) => "Added " + named(made.name) + " (" + named(made.role) + "). Talk to it with `botkins chat " + shellWord(made.name, "<the bot>") + "`.");
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
        details: "Give a template, or --bot. The file is JSON. It holds the name, role, about text, instructions, look, and any bundled skills and routines. Printed as text, it has each character that hides or turns text written as its number; --file and --json give it as it is. An existing file is replaced only after a yes. The app also keeps a copy among the bot's files.",
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
          show(context, ["This file holds a template. Its words steer a bot that is made from it:", "", "  " + named(found.name), "      Role: " + named(found.role), ...(found.summary ? ["      About: " + named(found.summary)] : []), "      Instructions (" + count(found.instructions.length, "character") + "):", indent(found.instructions, "        "), ...bundleLines(found.bundle), ...(found.exists ? ["", "A template with this name is saved already. This one is saved beside it."] : [])].join("\n"));
          if (!(await confirm(context, "Save this template?"))) return EXIT.failed;
          context.print(await call(context, "templates.import", file), (template) => "Saved the template " + named(template.name) + ".");
        },
      },
    },
  },
};
