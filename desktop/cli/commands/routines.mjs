// Routines: the commands (cli/commands/index.mjs adds them).
// `routinesCommands` maps a top-level word to a group `{ summary, commands }`. A group whose word is there
// already (`bots`, `routines`, `providers`, …) gets these commands added to its own.
//
// A routine runs a bot on a schedule, with nobody watching. So `routines add` and `routines edit` show the
// whole routine as it will be (the bot, the schedule in words with the next two times, the prompt) before
// they save, and ask. With no terminal they need --yes. What is shown goes to standard error, with --yes and
// with --json too, so a caller that reads JSON still shows its person what will run.
// A schedule that runs more often than a bot's own routine tool allows has one more line in that text: how
// often it runs, and that each run uses the model and can cost money. The socket refuses such a schedule
// unless the call carries { fastSchedule: true }; the command sends that only after the yes.
import { readFileSync } from "node:fs";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, readAll } from "./input.mjs";
import { safe, shellWord } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first" } };
const show = (context, text) => void context.stderr.write(text + "\n");
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
/** A time, written in the zone that it is in: "Sat, Nov 22, 2026, 9:00 AM UTC". */
const at = (time, zone) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(time));
  } catch {
    return String(time);
  }
};
const zoneLine = (zone) => "Time zone: " + safe(zone);
/** A routine as a word for a command: its id when its name cannot be written as one. */
const word = (name) => shellWord(name, "<its id>");

const CADENCE_OPTIONS = {
  cadence: { type: "string", value: "kind", about: "How often: once, daily, weekdays, weekly or custom" },
  at: { type: "string", value: "HH:MM", about: "The time of day, as 24-hour time such as 09:00" },
  days: { type: "string", value: "list", about: "For weekly: the days, such as mon,wed,fri" },
  date: { type: "string", value: "YYYY-MM-DD", about: "For once: the day" },
  cron: { type: "string", value: "five fields", about: "A cron line: minute, hour, day of the month, month, day of the week. It means --cadence custom" },
  timezone: { type: "string", value: "zone", about: "The time zone of the times, such as Europe/London. Without it: the zone of the computer that runs Botkins" },
};
const CADENCE_DETAILS = "The schedule is a kind with its fields: once (--date and --at), daily or weekdays (--at), weekly (--at and --days), or a cron line (--cron). Every time is in the routine's time zone: --timezone, else the zone of the computer that runs Botkins. The command prints the zone.";
const PROMPT_OPTIONS = {
  prompt: { type: "string", value: "text", about: "What the bot does at each time (up to 4,000 characters)" },
  file: { type: "string", value: "path", about: "Read the prompt from a file. \"-\" reads standard input" },
};
const RESULT_OPTIONS = {
  deliver: { type: "string", value: "where", about: "Where the result goes: routine (its own chat, the usual way), none, chat, feed, idea or goal" },
  chat: { type: "string", value: "chat", about: "With --deliver chat: which chat (its id or title). Without it: the bot's latest chat" },
  category: { type: "string", value: "name", about: "With --deliver goal: the category (health, relationships, finance, career, interests, productivity or other)" },
};

/** The schedule that the options give, as { kind?, time?, days?, date?, cron? }; undefined when none is named. `needed`: it must name a kind. */
function cadenceFrom(o, needed) {
  const named = ["cadence", "at", "days", "date", "cron"].some((name) => o[name] !== undefined);
  if (!named) {
    if (needed) throw usage("Say when it runs: --cadence once, daily, weekdays or weekly with --at <HH:MM> (weekly also --days, once also --date), or --cron <five fields>.");
    return undefined;
  }
  if (o.cron !== undefined && o.cadence !== undefined && o.cadence !== "custom") throw usage("--cron is for --cadence custom.");
  const kind = o.cadence ?? (o.cron !== undefined ? "custom" : undefined);
  if (needed && !kind) throw usage("Say which kind of schedule: --cadence once, daily, weekdays or weekly, or --cron <five fields>.");
  return {
    ...(kind && { kind }),
    ...(o.at !== undefined && { time: o.at }),
    ...(o.days !== undefined && { days: o.days.split(/[\s,]+/).filter(Boolean) }),
    ...(o.date !== undefined && { date: o.date }),
    ...(o.cron !== undefined && { cron: o.cron }),
  };
}
/** Where the result goes, from the options: { to, chat?, category? }, or undefined. */
function deliverFrom(o) {
  if (o.deliver === undefined) {
    if (o.chat !== undefined || o.category !== undefined) throw usage("--chat and --category go with --deliver: --deliver chat --chat <chat>, or --deliver goal --category <name>.");
    return undefined;
  }
  return { to: o.deliver, ...(o.chat !== undefined && { chat: o.chat }), ...(o.category !== undefined && { category: o.category }) };
}
/** The prompt, from --prompt, --file or standard input (the word "-"); undefined when none is given and none is needed. */
async function promptFrom(context, needed) {
  const o = context.options;
  const stdin = context.args.includes("-");
  if ([o.prompt !== undefined, o.file !== undefined, stdin].filter(Boolean).length > 1) throw usage("Give the prompt one way: --prompt <text>, --file <path>, or - for standard input.");
  if (o.prompt === undefined && o.file === undefined && !stdin) {
    if (needed) throw usage("Give the prompt: --prompt <text>, --file <path>, or - to read standard input. The prompt is what the bot does at each time.");
    return undefined;
  }
  const prompt = o.prompt ?? (await textFrom(context, stdin ? "-" : o.file, "prompt file"));
  if (!prompt.trim()) throw usage("The prompt is empty.");
  return prompt;
}
/** The one name of `routines add` and the one routine of the others, without the "-" that means standard input. */
function words(context, what) {
  const given = context.args.filter((arg) => arg !== "-");
  if (given.length !== 1) throw usage(what);
  return given[0];
}

const WHERE = {
  routine: "in the routine's own chat",
  none: "nowhere: the bot does the work and gives no reply",
  chat: "as a message in a chat with the bot",
  feed: "in the Feed",
  idea: "in Ideas",
  goal: "in Goals",
};
const resultLine = (routine) => {
  const to = routine.deliver?.to ?? "routine";
  const chat = to === "chat" ? (routine.deliverChat ? " (" + JSON.stringify(safe(routine.deliverChat)) + ")" : " (the bot's latest chat)") : "";
  return (WHERE[to] ?? to) + chat + (routine.deliver?.category ? ", category " + safe(routine.deliver.category) : "");
};
const timesLines = (routine, label) => {
  if (!routine.next.length) return [label + ": none (its time has passed)"];
  return routine.next.map((time, index) => (index === 0 ? label + ": " : " ".repeat(label.length + 2)) + at(time, routine.timezone));
};
/** A prompt for a screen: each line shown safely, indented. */
const promptLines = (prompt) => String(prompt).split(/\r?\n/).map((line) => "    " + safe(line.replaceAll("\t", "    ")));
const whenLine = (routine) => safe(routine.meaning) + (routine.meaning !== routine.cadence && routine.schedule?.kind === "custom" ? "   (" + safe(routine.cadence) + ")" : "");

/** A routine as it is, for `routines show`. */
const routineText = (routine) =>
  [
    safe(routine.name) + "   " + routine.id,
    "Bot: " + safe(routine.bot ?? "none"),
    "When: " + whenLine(routine),
    zoneLine(routine.timezone),
    "State: " + (routine.running ? "running" : routine.finished ? "finished" : routine.enabled ? "on" : "paused"),
    ...timesLines(routine, routine.enabled ? "Next" : "Next, when it is on"),
    routine.lastRun ? "Last run: " + safe(routine.lastRun) : null,
    "Result goes: " + resultLine(routine),
    "Notifies: " + (routine.notify === false ? "no, it runs quietly" : "yes"),
    "Prompt:",
    ...promptLines(routine.instructions),
  ]
    .filter((line) => line !== null)
    .join("\n");

/** The cost of a schedule that runs often: how often, and what each run is. Null for a slower one. */
const costLine = (routine) => {
  const minutes = routine.fastMinutes;
  return minutes ? "Cost: this runs as often as every " + (minutes === 1 ? "minute" : minutes + " minutes") + ". Each run uses one model turn, and a model turn can cost money." : null;
};
/** The mark that the person agreed to a fast schedule, for the call that follows the yes. */
const agreedFast = (routine) => (routine.fastMinutes ? [{ fastSchedule: true }] : []);

/** The routine as it will be, shown before it is saved. */
const reviewText = (routine, adding) =>
  [
    (adding ? "This routine runs a bot on a schedule, with nobody watching. It will be saved as:" : "This changes a routine that runs a bot on a schedule, with nobody watching. After the change it is:"),
    "  Name: " + safe(routine.name),
    "  Bot: " + safe(routine.bot),
    "  When: " + whenLine(routine),
    "  " + zoneLine(routine.timezone),
    ...timesLines(routine, "Next").map((line) => "  " + line),
    ...(costLine(routine) ? ["  " + costLine(routine)] : []),
    "  Result goes: " + resultLine(routine),
    "  Notifies: " + (routine.notify ? "yes" : "no, it runs quietly"),
    ...(adding ? [] : ["  Changes: " + routine.changes.join(", "), ...(routine.enabled ? [] : ["  It is paused. Turn it on with `botkins routines resume " + word(routine.name) + "`."])]),
    "  Prompt:",
    ...promptLines(routine.instructions).map((line) => "  " + line),
  ].join("\n");

const clip = (text, length) => {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length > length ? line.slice(0, length - 1) + "…" : line;
};
const stateOf = (entry) => (entry.enabled ? "on" : "paused");

export const routinesCommands = {
  routines: {
    summary: "List routines, run one now, and pause or resume one",
    details: "A routine is work a bot does on a schedule, with nobody watching. Make one with `routines add`; `routines when` says what a schedule means before you use it.",
    commands: {
      show: {
        summary: "Show one routine whole: its bot, its schedule, its next times and its prompt",
        usage: "botkins routines show <routine>",
        details: "The times are in the routine's time zone, and the zone is printed.",
        async run(context) {
          context.print(await context.client.call("routines.get", one(context, "Name the routine (its name or id).")), routineText);
        },
      },
      when: {
        summary: "Say what a schedule or a cron line means, and when it would run next",
        usage: "botkins routines when [<cron line>] [--cadence <kind>] [--at <HH:MM>] [--days <list>] [--date <YYYY-MM-DD>] [--cron <five fields>] [--timezone <zone>]",
        arguments: [{ name: "cron line", required: false }],
        options: CADENCE_OPTIONS,
        details: CADENCE_DETAILS + " A cron line may be given as the one word of the command: `botkins routines when \"0 9 * * 1-5\"`. It prints the next five times. Nothing is saved.",
        async run(context) {
          if (context.args.length > 1) throw usage("Give the cron line as one word, in quotes.");
          const o = { ...context.options };
          if (context.args.length) {
            if (o.cron !== undefined) throw usage("Give the cron line once: as the word or with --cron.");
            o.cron = context.args[0];
          }
          const cadence = cadenceFrom(o, true);
          const result = await context.client.call("routines.when", cadence, o.timezone);
          context.print(result, (when) =>
            [
              safe(when.meaning),
              zoneLine(when.timezone) + (o.timezone === undefined ? " (the zone of the computer that runs Botkins)" : ""),
              when.repeats ? "It repeats." : "It runs one time.",
              ...timesLines(when, "Next times"),
            ].join("\n"),
          );
        },
      },
      add: {
        summary: "Make a routine: a bot does a prompt on a schedule",
        usage: "botkins routines add <name> --bot <bot> (--prompt <text> | --file <path> | -) (--cadence <kind> [--at <HH:MM>] [--days <list>] [--date <YYYY-MM-DD>] | --cron <five fields>) [--timezone <zone>] [--deliver <where>] [--chat <chat>] [--category <name>] [--quiet] [--yes]",
        arguments: [{ name: "name", required: true }],
        options: {
          bot: { type: "string", value: "bot", about: "The bot that does the work (its name or id)" },
          ...PROMPT_OPTIONS,
          ...CADENCE_OPTIONS,
          ...RESULT_OPTIONS,
          quiet: { type: "boolean", about: "No notification when a run ends" },
          ...YES,
        },
        details: CADENCE_DETAILS + " The prompt is a long text: give it with --prompt, with --file, or on standard input with the word -. The command shows the whole routine first (the bot, the schedule in words, the next two times and the prompt), because the bot then runs with nobody watching, and asks. With no terminal it needs --yes. A schedule that runs more often than a bot's own routine tool allows has one more line: how often it runs, and that each run uses the model and can cost money.",
        async run(context) {
          const name = words(context, "Give the routine a name, as one word in quotes.");
          const o = context.options;
          if (o.bot === undefined) throw usage("Name the bot that does the work: --bot <bot>.");
          const prompt = await promptFrom(context, true);
          const data = { bot: o.bot, name, prompt, cadence: cadenceFrom(o, true), ...(o.timezone !== undefined && { timezone: o.timezone }), ...(deliverFrom(o) && { deliver: deliverFrom(o) }), ...(o.quiet && { notify: false }) };
          const review = await context.client.call("routines.review", null, data);
          show(context, reviewText(review, true));
          if (!(await confirm(context, "Save this routine?"))) {
            context.note("Nothing was saved.");
            return EXIT.failed;
          }
          context.print(await context.client.call("routines.add", data, ...agreedFast(review)), (routine) => "Added " + safe(routine.name) + " (" + routine.id + "). It is on" + (routine.next[0] ? ", and runs next at " + at(routine.next[0], routine.timezone) : "") + ".");
        },
      },
      edit: {
        summary: "Change a routine",
        usage: "botkins routines edit <routine> [-] [--name <text>] [--prompt <text>] [--file <path>] [--cadence <kind>] [--at <HH:MM>] [--days <list>] [--date <YYYY-MM-DD>] [--cron <five fields>] [--timezone <zone>] [--deliver <where>] [--chat <chat>] [--category <name>] [--quiet] [--notify] [--yes]",
        arguments: [{ name: "routine", required: true }],
        options: {
          name: { type: "string", value: "text", about: "A new name" },
          ...PROMPT_OPTIONS,
          ...CADENCE_OPTIONS,
          ...RESULT_OPTIONS,
          quiet: { type: "boolean", about: "No notification when a run ends" },
          notify: { type: "boolean", about: "Notify when a run ends (the usual way)" },
          ...YES,
        },
        details: "Only what you name changes. A schedule option changes that part of the schedule: `--at 10:00` moves a daily routine to ten o'clock, and a new --cadence replaces the schedule, so give its fields too. " + CADENCE_DETAILS + " The prompt can come from --prompt, --file, or standard input with the word -. The command shows the whole routine as it will be, and asks. With no terminal it needs --yes. A routine that is paused stays paused (`botkins routines resume`). A schedule that runs more often than a bot's own routine tool allows has one more line in what it shows: how often it runs, and that each run uses the model and can cost money.",
        async run(context) {
          const ref = words(context, "Name the routine (its name or id).");
          const o = context.options;
          if (o.quiet && o.notify) throw usage("Give --quiet or --notify, not both.");
          const prompt = await promptFrom(context, false);
          const patch = {
            ...(o.name !== undefined && { name: o.name }),
            ...(prompt !== undefined && { prompt }),
            ...(cadenceFrom(o, false) && { cadence: cadenceFrom(o, false) }),
            ...(o.timezone !== undefined && { timezone: o.timezone }),
            ...(deliverFrom(o) && { deliver: deliverFrom(o) }),
            ...((o.quiet || o.notify) && { notify: o.notify === true }),
          };
          if (!Object.keys(patch).length) throw usage("Say what to change. `botkins help routines edit` lists the options.");
          const review = await context.client.call("routines.review", ref, patch);
          if (!review.changes.length) return void context.print({ ...review, saved: false }, () => "Nothing changes: the routine is already so.");
          show(context, reviewText(review, false));
          if (!(await confirm(context, "Save this change?"))) {
            context.note("Nothing was saved.");
            return EXIT.failed;
          }
          context.print(await context.client.call("routines.edit", review.id, patch, ...agreedFast(review)), (routine) => "Saved " + safe(routine.name) + ".");
        },
      },
      remove: {
        summary: "Remove a routine with its chat and every run it kept",
        usage: "botkins routines remove <routine> [--yes]",
        options: YES,
        details: "This cannot be undone. A routine you only want to stop is paused: `botkins routines pause`.",
        async run(context) {
          const routine = await context.client.call("routines.get", one(context, "Name the routine (its name or id)."));
          show(context, "This removes the routine " + JSON.stringify(safe(routine.name)) + " of " + safe(routine.bot ?? "no bot") + " with its own chat and every run it kept.");
          if (!(await confirm(context, "Remove it?"))) return EXIT.failed;
          context.print(await context.client.call("routines.remove", routine.id), (gone) => "Removed " + safe(gone.name) + ".");
        },
      },
      duplicate: {
        summary: "Make a copy of a routine, for the same bot or for another",
        usage: "botkins routines duplicate <routine> [--bot <bot>] [--name <text>] [--yes]",
        arguments: [{ name: "routine", required: true }],
        options: {
          ...YES,
          bot: { type: "string", value: "bot", about: "The bot of the copy (its name or id). Without it: the same bot" },
          name: { type: "string", value: "text", about: "A name for the copy. Without it the copy has the same name, and you name it by its id" },
        },
        details: "The copy has the same prompt, schedule, time zone and result, and its own id. A chat that was chosen for the result is kept only for the same bot. The copy runs on its own schedule, with nobody watching: the command prints it. When the schedule runs more often than a bot's own routine tool allows, the command shows how often and that each run can cost money, and asks first; with no terminal it needs --yes.",
        async run(context) {
          const source = await context.client.call("routines.get", one(context, "Name the routine (its name or id)."));
          if (source.fastMinutes) {
            show(context, ["This copies the routine " + JSON.stringify(safe(source.name)) + ", which runs a bot on a schedule with nobody watching. The copy has the same schedule:", "  When: " + whenLine(source), "  " + zoneLine(source.timezone), "  " + costLine(source)].join("\n"));
            if (!(await confirm(context, "Make the copy?"))) {
              context.note("Nothing was copied.");
              return EXIT.failed;
            }
          }
          const copy = await context.client.call("routines.duplicate", source.id, context.options.bot, context.options.name, ...agreedFast(source));
          context.print(copy, (routine) => "Copied to " + safe(routine.name) + " (" + routine.id + ") for " + safe(routine.bot) + (routine.next[0] ? ". It runs next at " + at(routine.next[0], routine.timezone) : "") + ".");
        },
      },
      schedules: {
        summary: "List the prompts that chats scheduled for themselves (with /every or /after)",
        usage: "botkins routines schedules [--bot <bot>]",
        options: { bot: { type: "string", value: "bot", about: "Only this bot's" } },
        details: "These are not routines. Change one with `botkins routines schedule`.",
        async run(context) {
          context.print(await context.client.call("routines.schedules", context.options.bot), (list) =>
            list.length
              ? table(["CHAT", "NUMBER", "BOT", "WHEN", "STATE", "NEXT", "PROMPT", "CHAT ID"], list.map((entry) => [safe(clip(entry.chat, 30)), entry.id, safe(entry.bot ?? ""), safe(entry.when), stateOf(entry), entry.nextRun ? at(entry.nextRun, entry.timezone ?? undefined) : "", safe(clip(entry.prompt, 40)), entry.chatId]))
              : "No chat has a schedule.",
          );
        },
      },
      schedule: {
        summary: "Pause, resume or delete one schedule of a chat",
        usage: "botkins routines schedule <chat> <number> <pause|resume|delete> [--yes]",
        arguments: [{ name: "chat", required: true }, { name: "number", required: true }, { name: "action", required: true }],
        options: YES,
        details: "The chat is its id or its title, and the number is the one that `botkins routines schedules` shows. Deleting asks first. A routine's own schedule is changed with `routines pause`, `resume` and `remove`.",
        async run(context) {
          if (context.args.length !== 3) throw usage("Give the chat, the number of its schedule, and pause, resume or delete.");
          const [chat, number, action] = context.args;
          if (!["pause", "resume", "delete"].includes(action)) throw usage("Say pause, resume or delete.");
          if (action === "delete") {
            const entry = (await context.client.call("routines.schedules")).find((item) => (item.chatId === chat || item.chat.toLowerCase() === chat.toLowerCase()) && String(item.id) === String(number));
            if (entry) show(context, "This deletes the schedule " + entry.id + " of the chat " + JSON.stringify(safe(entry.chat)) + ": " + safe(entry.when) + ", " + JSON.stringify(safe(clip(entry.prompt, 80))) + ".");
            if (!(await confirm(context, "Delete it?"))) return EXIT.failed;
          }
          context.print(await context.client.call("routines.schedule", chat, number, action), (done) => (done.removed ? "Deleted" : done.enabled ? "Resumed" : "Paused") + " schedule " + done.id + " of " + safe(done.chat) + ".");
        },
      },
    },
  },
};
