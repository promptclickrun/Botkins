// Spaces and panels: the commands (cli/commands/index.mjs adds them).
// `spacesCommands` maps a top-level word to a group `{ summary, commands }`: `botkins spaces`, `botkins panels`
// and `botkins cards`.
//
// What these hold to (desktop/AGENTS.md):
//  - A space is a page of panels and cards. The command line is the computer's owner, who can open and change every
//    space on the computer, also one that a team member made. A name is looked for among the owner's own spaces first.
//  - `spaces remove` takes the space's panels, their routines, their views and its cards. It shows what goes and asks.
//    So do `panels remove`, `panels routine remove` and `cards act … delete`.
//  - A panel's routine runs a bot on a schedule, with nobody watching. `panels routine set` and `panels new --refresh`
//    show the routine as it will be (the bot, the schedule in words, the next two times, the prompt) and ask. A schedule
//    that runs more often than a bot's own routine may (every 15 minutes) has one more line, the cost, as `routines add`
//    has. What is shown goes to standard error, with --yes and with --json too.
//  - `panels new`, `spaces ask`, `panels ask` and `panels refresh` start a turn of a bot's model. Their help says so.
//  - A text that somebody else wrote (a name, a title, a panel's content, a note, a card) is made safe before it is
//    printed to a person. `--json` and a pipe get it as it is.
import { readFileSync } from "node:fs";
import { ago, CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, readAll } from "./input.mjs";
import { safe, shellWord } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Do not ask first" } };
/** Text of more than one line as a person can be shown it: the line ends and the tabs stay, every other control character is written as its number. */
const safeLines = (value) => String(value).split(/\r?\n/).map((line) => line.split("\t").map(safe).join("\t")).join("\n");
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person. */
const show = (context, text) => void context.stderr.write(text + "\n");
const word = (name, placeholder) => shellWord(name, placeholder);
const count = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);
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
    throw new CliError("The " + what + " " + path + " cannot be read: " + error.message);
  }
}
/** The words after the leading arguments, as one text; or the text of --file ("-" is standard input). Both is a mistake. */
async function wordsOrFile(context, skip, what) {
  const words = context.args.slice(skip).join(" ").trim();
  const file = context.options.file;
  if (words && file !== undefined) throw usage("Give the " + what + " as words, or with --file, not both.");
  const body = file !== undefined ? (await textFrom(context, file, what + " file")).replace(/\r\n/g, "\n").trimEnd() : words;
  if (!body.trim()) throw usage("Give the " + what + " as words, or with --file <path> (\"-\" reads standard input).");
  return body;
}
/** A time, written in the zone that it is in: "Sat, Nov 22, 2026, 9:00 AM UTC". */
const at = (time, zone) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(time));
  } catch {
    return String(time);
  }
};
const clip = (value, length) => {
  const line = String(value).replace(/\s+/g, " ").trim();
  return line.length > length ? line.slice(0, length - 1) + "…" : line;
};
/** At most `lines` lines of a text, indented, each made safe, with a note when there is more. */
const lines = (value, indent, limit = 12) => {
  const all = safeLines(value).split("\n");
  return [...all.slice(0, limit).map((line) => indent + line), ...(all.length > limit ? [indent + "… (" + (all.length - limit) + " more lines; --json has all of it)"] : [])];
};

// ── How a space, a panel, a card and a routine are shown ──
const spaceRow = (s) => [safe(s.name), s.mine ? "owner" : safe(s.maker), s.panels, s.cards.open, s.project ? safe(s.project.name) : "", s.id];
const panelState = (p) => (p.hidden ? "hidden" : "shown") + (p.refreshing ? ", refreshing" : "");
const refreshWhen = (p) => (p.routine ? (p.routine.enabled ? p.routine.meaning : "paused") + (p.routine.fastMinutes ? " (fast)" : "") : "");
const panelTable = (list) => table(["TITLE", "BOT", "SPACE", "SIZE", "STATE", "REFRESH", "ID"], list.map((p) => [safe(p.title), safe(p.bot ?? ""), safe(p.space.name), p.size, panelState(p), safe(refreshWhen(p)), p.id]));
const cardTable = (list, withSpace) => table(["KIND", "STATUS", "TITLE", "BOT", ...(withSpace ? ["SPACE"] : []), "ID"], list.map((c) => [c.kind, c.status + (c.notToday ? " (not today)" : ""), safe(c.title), safe(c.bot ?? ""), ...(withSpace ? [safe(c.space.name)] : []), c.id]));
const spaceText = (s) =>
  [
    safe(s.name) + "   " + s.id,
    (s.builtin ? "One of the four spaces that every person has (" + s.builtin + "). " : "") + "Made by: " + (s.mine ? "the owner" : safe(s.maker)) + ".",
    s.project ? "Project: " + safe(s.project.name) : null,
    "Panels: " + s.panels + ". Routines: " + s.routines + ". Views: " + s.views + ". Cards: " + s.cards.open + " open of " + s.cards.total + ".",
    ...(s.panelList.length ? ["", "Panels:", panelTable(s.panelList)] : ["", "No panels yet. Ask a bot for one with `botkins panels new --space " + word(s.name, "<the space>") + " --bot <bot> \"<what the panel is for>\"`."]),
    ...(s.cardList.length ? ["", "Cards:", cardTable(s.cardList)] : []),
  ]
    .filter((line) => line !== null)
    .join("\n");
const routineLines = (routine) => [
  "Routine: " + safe(routine.meaning) + (routine.enabled ? "" : " (paused)"),
  "Time zone: " + safe(routine.timezone),
  ...(routine.enabled && routine.nextAt ? ["Next refresh: " + at(routine.nextAt, routine.timezone)] : []),
  ...(routine.fastMinutes ? ["Cost: " + costSentence(routine.fastMinutes)] : []),
  ...(routine.setBy ? ["Set by: " + safe(routine.setBy)] : []),
  ...(routine.prompt ? ["Routine's prompt:", ...lines(routine.prompt, "    ")] : []),
];
const costSentence = (minutes) => "this runs as often as every " + (minutes === 1 ? "minute" : minutes + " minutes") + ". Each run uses one model turn, and a model turn can cost money.";

/** One block of a panel as plain text: what a person sees in the panel. */
function blockLines(block) {
  const item = (entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" ? [entry.label, entry.value].filter((part) => part !== undefined).join(": ") : String(entry));
  switch (block?.type) {
    case "markdown":
      return lines(block.text, "  ");
    case "metric":
      return ["  " + safe(block.label) + ": " + safe(block.value) + (block.note ? " (" + safe(block.note) + ")" : "")];
    case "progress":
      return ["  " + safe(block.label) + ": " + safe(block.value) + " of " + safe(block.max) + (block.note ? " (" + safe(block.note) + ")" : "")];
    case "list":
    case "badges":
      return (block.items ?? []).slice(0, 40).map((entry) => "  - " + safe(clip(item(entry), 200)));
    case "bars":
      return ["  " + safe(block.label), ...(block.items ?? []).slice(0, 40).map((entry) => "  - " + safe(clip(item(entry), 200)))];
    case "table":
      return (Array.isArray(block.rows) ? [block.columns, ...block.rows.slice(0, 40)] : [block.columns]).map((row) => "  " + (Array.isArray(row) ? row.map((cell) => safe(clip(cell, 60))).join(" | ") : safe(String(row))));
    case "html":
      return ["  A custom view (a page of its own). --json has its place; the window and the phone draw it."];
    default:
      return ["  " + safe(clip(JSON.stringify(block ?? null), 200))];
  }
}
const panelText = (p) =>
  [
    safe(p.title) + "   " + p.id,
    "Space: " + safe(p.space.name) + ". Bot: " + safe(p.bot ?? "none") + ". Size: " + p.size + ". " + (p.hidden ? "Hidden." : "Shown.") + (p.project ? " Project: " + safe(p.project.name) + "." : ""),
    "Revision " + p.revision + (p.updatedAt ? ", updated " + ago(p.updatedAt) : "") + "." + (p.refreshing ? " It is refreshing now." : "") + (p.createdBy ? " Made for " + safe(p.createdBy) + "." : ""),
    ...(p.routine ? routineLines(p.routine) : ["No routine: the bot refreshes it only when it is asked."]),
    "",
    "Content (" + count(p.blocks.length, "block") + "):",
    ...(p.blocks.length ? p.blocks.flatMap((block) => [block?.type ? "[" + block.type + "]" : "[block]", ...blockLines(block)]) : ["  (empty)"]),
    ...(p.state ? ["", "Saved state of an app panel (revision " + p.stateRev + "):", ...lines(JSON.stringify(p.state, null, 2), "  ", 30)] : []),
    ...(p.notes.length ? ["", "Notes (" + p.notes.length + "):", ...p.notes.map((note) => "  " + note.position + ". " + safe(note.by) + ": " + safe(clip(note.text, 300)) + "   (" + note.id + ")")] : []),
    ...(p.last ? ["", "Last change: " + safe(p.last.by) + (p.last.label ? " " + safe(p.last.label) : "") + ", " + ago(p.last.at) + "."] : []),
    ...(p.asks.length ? ["", "Asks under the panel: " + p.asks.map((ask) => JSON.stringify(safe(ask))).join(", ")] : []),
  ].join("\n");
const cardText = (c) =>
  [
    safe(c.title) + "   " + c.id,
    "Kind: " + c.kind + (c.category ? " (" + safe(c.category) + ")" : "") + ". Status: " + c.status + (c.notToday ? ", put away for today" : "") + ". " + (c.read ? "Read." : "Not read.") + " Bot: " + safe(c.bot ?? "none") + (c.source ? " (from the routine " + safe(c.source) + ")" : "") + ". Space: " + safe(c.space.name) + ".",
    ...(c.answer || c.rating ? ["Your answer: " + [c.answer && "said " + c.answer, c.rating && "thumbs " + c.rating + (c.reason ? " (" + safe(c.reason) + ")" : "")].filter(Boolean).join(", ") + "."] : []),
    ...(c.body ? ["", ...lines(c.body, "", 30)] : []),
    ...(c.links.length ? ["", "Links:", ...c.links.map((link) => "  " + safe(link.title) + "  " + safe(link.url))] : []),
  ].join("\n");

/** The routine as it will be, shown before it is saved. `heading` says what saves it. */
const reviewText = (review, heading, where) =>
  [
    heading,
    ...(where ? ["  " + where] : []),
    "  Bot: " + safe(review.bot),
    "  When: " + safe(review.meaning),
    "  Time zone: " + safe(review.timezone),
    ...review.next.map((time, index) => (index === 0 ? "  Next: " : "        ") + at(time, review.timezone)),
    ...(review.fastMinutes ? ["  Cost: " + costSentence(review.fastMinutes)] : []),
    ...(review.replaces ? ["  It replaces the routine that the panel has now: " + safe(review.replaces.meaning) + (review.replaces.enabled ? "" : " (paused)") + "."] : []),
    "  Prompt:",
    ...lines(review.prompt, "      "),
  ].join("\n");
/** The mark that the person agreed to a fast schedule, for the call that follows the yes. */
const agreedFast = (review) => (review.fastMinutes ? [{ fastSchedule: true }] : []);

// ── What the options say ──
const SCHEDULE_OPTIONS = {
  at: { type: "string", value: "HH:MM", about: "The time of day, as 24-hour time such as 09:00" },
  days: { type: "string", value: "list", about: "For weekly: the days, such as mon,wed,fri" },
  timezone: { type: "string", value: "zone", about: "The time zone of the times, such as Europe/London. Without it: the zone of the computer that runs Botkins" },
};
const SCHEDULE_DETAILS = "The schedule is a kind with its fields: daily or weekdays (--at), weekly (--at and --days), or a cron line of five fields (minute, hour, day of the month, month, day of the week). A panel's routine repeats. Every time is in --timezone, else the zone of the computer that runs Botkins; the command prints the zone. A schedule that runs more often than every 15 minutes shows its cost and needs the yes too: each run uses one model turn.";
const daysList = (value) => (value === undefined ? undefined : value.split(/[\s,]+/).filter(Boolean));
/** `--refresh daily|weekdays|weekly|<cron line>` with `--at`, `--days` and `--timezone`, as a schedule for the socket. */
function refreshFrom(o) {
  const when = o.refresh.trim();
  const shape = /\s/.test(when) ? { cron: when } : { cadence: when, ...(o.at !== undefined && { at: o.at }), ...(daysList(o.days) && { days: daysList(o.days) }) };
  if (/\s/.test(when) && (o.at !== undefined || o.days !== undefined)) throw usage("--at and --days go with daily, weekdays or weekly, not with a cron line.");
  return { ...shape, ...(o.timezone !== undefined && { timezone: o.timezone }) };
}
/** The schedule of `panels routine set` from its options: --cadence with --at and --days, or --cron. */
function scheduleFrom(o) {
  if (o.cadence === undefined && o.cron === undefined) throw usage("Say when it refreshes: --cadence daily, weekdays or weekly with --at <HH:MM> (weekly also --days), or --cron <five fields>.");
  if (o.cron !== undefined && (o.at !== undefined || o.days !== undefined)) throw usage("--at and --days go with --cadence, not with a cron line.");
  return { ...(o.cadence !== undefined && { cadence: o.cadence }), ...(o.cron !== undefined && { cron: o.cron }), ...(o.at !== undefined && { at: o.at }), ...(daysList(o.days) && { days: daysList(o.days) }), ...(o.timezone !== undefined && { timezone: o.timezone }) };
}
const PANEL_SPACE = { space: { type: "string", value: "space", about: "Look for the panel in this space (its name or id). Use it when two panels have one title" } };
/** The panel the first word names, whole, by its id or title (`--space` narrows a title). */
const findPanel = (context, ref) => context.client.call("panel.get", ref, context.options.space !== undefined ? { space: context.options.space } : {});
const PANEL = "Name the panel (its title or id: `botkins panels list`).";
const startsList = "checklist, tracker, chart, table, notes or app";

export const spacesCommands = {
  spaces: {
    summary: "Spaces: pages of panels and cards. List them, make one, change one, ask a bot about one",
    details: "A space is a named page of panels and cards on this computer. Every person has four: Today, Feed, Ideas and Goals; they cannot be renamed or deleted. A bot publishes panels (`botkins panels`) and posts cards (`botkins cards`). From a terminal you are the owner, so you see every space on this computer, also one that a team member made. A space is named by its name or its id; a name is looked for among your own spaces first.",
    commands: {
      list: {
        summary: "List the spaces on this computer",
        usage: "botkins spaces list",
        async run(context) {
          context.print(await context.client.call("space.list"), (list) => table(["NAME", "MADE BY", "PANELS", "OPEN CARDS", "PROJECT", "ID"], list.map(spaceRow)));
        },
      },
      show: {
        summary: "Show one space with its panels and its cards",
        usage: "botkins spaces show <space>",
        async run(context) {
          context.print(await context.client.call("space.get", one(context, "Name the space (its name or id: `botkins spaces list`).")), spaceText);
        },
      },
      add: {
        summary: "Make a new space (private to you until it is shared)",
        usage: "botkins spaces add <name>…",
        details: "The name is up to 40 characters. A new space is private. (A space is shared from the phone and the window.)",
        async run(context) {
          if (!context.args.length) throw usage("Give the space a name.");
          context.print(await context.client.call("space.add", context.args.join(" ")), (s) => "Added the space " + safe(s.name) + " (" + s.id + "). Ask a bot for a panel in it with `botkins panels new --space " + word(s.name, s.id) + " --bot <bot> \"<what the panel is for>\"`.");
        },
      },
      rename: {
        summary: "Give a space another name",
        usage: "botkins spaces rename <space> <name>",
        arguments: [{ name: "space", required: true }, { name: "name", required: true }],
        details: "Today, Feed, Ideas and Goals cannot be renamed.",
        async run(context) {
          if (context.args.length < 2) throw usage("Name the space (its name or id), then give the new name.");
          context.print(await context.client.call("space.rename", context.args[0], context.args.slice(1).join(" ")), (s) => "The space is now called " + safe(s.name) + ".");
        },
      },
      remove: {
        summary: "Delete a space with its panels, their routines, their views and its cards",
        usage: "botkins spaces remove <space> [--yes]",
        options: YES,
        details: "This deletes the space, every panel in it with its routine, its views and its notes, every card in it, and the chat of updates of each panel. It cannot be undone. A chat that was started from the space stays, with no space. The command shows what goes and asks; with no terminal it needs --yes. Today, Feed, Ideas and Goals cannot be deleted.",
        async run(context) {
          const found = await context.client.call("space.get", one(context, "Name the space (its name or id)."));
          const titles = found.panelList.slice(0, 10).map((p) => "  " + safe(p.title) + (p.routine ? " (has a routine)" : "")).join("\n");
          show(
            context,
            ["This deletes the space " + safe(found.name) + " (" + found.id + "), and with it:", "  " + count(found.panels, "panel") + (found.panels ? ", with " + count(found.routines, "routine") + ", " + count(found.views, "custom view") + " and the chat of updates of each" : "") + ".", ...(found.panels ? [titles + (found.panels > 10 ? "\n  and " + (found.panels - 10) + " more" : "")] : []), "  " + count(found.cards.total, "card") + ".", "It cannot be undone."].join("\n"),
          );
          if (!(await confirm(context, "Delete the space?"))) return EXIT.failed;
          context.print(await context.client.call("space.remove", found.id, { agreed: true }), (gone) => "Deleted the space " + safe(gone.name) + " with " + count(gone.panels, "panel") + " and " + count(gone.cards, "card") + ".");
        },
      },
      project: {
        summary: "Attach a space to a project, or take it off",
        usage: "botkins spaces project <space> [<project>] [--none]",
        options: { none: { type: "boolean", about: "Take the space off its project" } },
        details: "Only your own spaces go with a project. A space with a project gives its bots that project's folder to work in, as the app's own rule says.",
        async run(context) {
          const [ref, to, ...more] = context.args;
          if (!ref) throw usage("Name the space (its name or id).");
          if (more.length || (to === undefined) === (context.options.none !== true)) throw usage("Name one project, or give --none.");
          context.print(await context.client.call("space.project", ref, context.options.none ? null : to), (s) => (s.project ? "The space " + safe(s.name) + " is in the project " + safe(s.project.name) + "." : "The space " + safe(s.name) + " is in no project."));
        },
      },
      ask: {
        summary: "Ask a bot about a space, or about one of its panels (a turn of the bot's model)",
        usage: "botkins spaces ask <space> --bot <bot> [--panel <panel>] [<message>…] [--file <path>]",
        arguments: [{ name: "space", required: true }, { name: "message", required: false, many: true }],
        options: { bot: { type: "string", value: "bot", about: "The bot to ask (name or id)" }, panel: { type: "string", value: "panel", about: "Ask about this panel of the space (its title or id)" }, file: { type: "string", value: "path", about: "Read the message from a file (\"-\" reads standard input)" } },
        details: "This opens a chat with the bot that is about the space, and sends the message. That starts a turn of the bot's model, which can cost money. The command does not wait: it prints the chat's id, and the answer comes in that chat (`botkins chats show <chat>`). The message is a long text: give it as words, or with --file.",
        async run(context) {
          if (!context.args.length) throw usage("Name the space (its name or id).");
          if (context.options.bot === undefined) throw usage("Name the bot to ask with --bot <bot>.");
          const message = await wordsOrFile(context, 1, "message");
          const asked = await context.client.call("space.ask", context.args[0], { bot: context.options.bot, text: message, ...(context.options.panel !== undefined && { panel: context.options.panel }) });
          context.print(asked, (done) => "Asked " + safe(done.bot.name) + " about " + (done.panel ? "the panel " + safe(done.panel.title) + " in " : "") + "the space " + safe(done.space.name) + ". That started a turn of its model. Follow the chat with `botkins chats show " + done.chatId + "`.");
        },
      },
    },
  },

  panels: {
    summary: "Panels: what a bot publishes in a space. Show, hide, order, move, refresh, schedule and ask",
    details: "A panel is a page that a bot publishes in a space and refreshes: text, numbers, lists, tables, bars, or a custom view. An app panel also keeps a saved state and notes that people write. A panel is named by its title or its id (`botkins panels list`); `--space` narrows a title that two spaces share. A panel's routine runs its bot on a schedule (`botkins panels routine`).",
    commands: {
      list: {
        summary: "List the panels, with their space, size and refresh",
        usage: "botkins panels list [--space <space>] [--bot <bot>]",
        options: { space: { type: "string", value: "space", about: "Only the panels of this space" }, bot: { type: "string", value: "bot", about: "Only the panels of this bot" } },
        async run(context) {
          const o = context.options;
          context.print(await context.client.call("panel.list", { ...(o.space !== undefined && { space: o.space }), ...(o.bot !== undefined && { bot: o.bot }) }), (list) => (list.length ? panelTable(list) : "No panels. Ask a bot for one with `botkins panels new`."));
        },
      },
      show: {
        summary: "Show one panel whole: its content, its routine, its saved state and its notes",
        usage: "botkins panels show <panel> [--space <space>]",
        options: PANEL_SPACE,
        details: "The content is the bot's text, shown safely: a custom view is not drawn in a terminal. `--json` has everything as the bot published it.",
        async run(context) {
          context.print(await findPanel(context, one(context, PANEL)), panelText);
        },
      },
      hide: {
        summary: "Hide a panel from the space's page. The panel and its routine stay",
        usage: "botkins panels hide <panel> [--space <space>]",
        options: PANEL_SPACE,
        async run(context) {
          const found = await findPanel(context, one(context, PANEL));
          context.print(await context.client.call("panel.change", found.id, "hide"), (p) => "Hid the panel " + safe(p.title) + ". Bring it back with `botkins panels unhide " + word(p.title, p.id) + "`.");
        },
      },
      unhide: {
        summary: "Show a hidden panel on the space's page again",
        usage: "botkins panels unhide <panel> [--space <space>]",
        options: PANEL_SPACE,
        async run(context) {
          const found = await findPanel(context, one(context, PANEL));
          context.print(await context.client.call("panel.change", found.id, "show"), (p) => "The panel " + safe(p.title) + " is shown.");
        },
      },
      size: {
        summary: "Set a panel's size: small, wide or tall",
        usage: "botkins panels size <panel> <size> [--space <space>]",
        arguments: [{ name: "panel", required: true }, { name: "size", required: true }],
        options: PANEL_SPACE,
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the panel, then the size: small, wide or tall.");
          const found = await findPanel(context, context.args[0]);
          context.print(await context.client.call("panel.change", found.id, context.args[1]), (p) => "The panel " + safe(p.title) + " is " + p.size + ".");
        },
      },
      order: {
        summary: "Move a panel one place earlier or later among the panels of its space",
        usage: "botkins panels order <panel> <direction> [--space <space>]",
        arguments: [{ name: "panel", required: true }, { name: "direction", required: true }],
        options: PANEL_SPACE,
        details: "The direction is earlier or later. To put a panel before a certain panel, or in another space, use `botkins panels move`.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the panel, then earlier or later.");
          const found = await findPanel(context, context.args[0]);
          context.print(await context.client.call("panel.change", found.id, context.args[1]), (p) => "Moved the panel " + safe(p.title) + " " + p.action + " in " + safe(p.space.name) + ".");
        },
      },
      move: {
        summary: "Put a panel in a space, at its end or before another panel",
        usage: "botkins panels move <panel> <space> [--before <panel>] [--space <space>]",
        arguments: [{ name: "panel", required: true }, { name: "space", required: true }],
        options: { ...PANEL_SPACE, before: { type: "string", value: "panel", about: "Put it before this panel of the target space (its title or id). Without it: at the end" } },
        details: "A bot has one panel for each key in a space, and a space holds up to 40 panels. The same space puts the panel in order there. (--space here names where the panel is now.)",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the panel, then the space to put it in.");
          const found = await findPanel(context, context.args[0]);
          context.print(await context.client.call("panel.move", found.id, context.args[1], context.options.before !== undefined ? { before: context.options.before } : {}), (p) => "The panel " + safe(p.title) + " is in " + safe(p.space.name) + ".");
        },
      },
      project: {
        summary: "Attach a panel to a project, or take it off",
        usage: "botkins panels project <panel> [<project>] [--none] [--space <space>]",
        options: { ...PANEL_SPACE, none: { type: "boolean", about: "Take the panel off its project" } },
        details: "The panel's bot then works in that project when it refreshes the panel.",
        async run(context) {
          const [ref, to, ...more] = context.args;
          if (!ref) throw usage(PANEL);
          if (more.length || (to === undefined) === (context.options.none !== true)) throw usage("Name one project, or give --none.");
          const found = await findPanel(context, ref);
          context.print(await context.client.call("panel.project", found.id, context.options.none ? null : to), (p) => (p.project ? "The panel " + safe(p.title) + " is in the project " + safe(p.project.name) + "." : "The panel " + safe(p.title) + " is in no project."));
        },
      },
      refresh: {
        summary: "Have a panel's bot refresh it now (a turn of the bot's model)",
        usage: "botkins panels refresh <panel> [--space <space>]",
        options: PANEL_SPACE,
        details: "This starts a turn of the bot's model, in the panel's own chat of updates, and can cost money. The command does not wait for the turn: the panel changes when the bot publishes. A panel that is refreshing already is left as it is.",
        async run(context) {
          const found = await findPanel(context, one(context, PANEL));
          context.print(await context.client.call("panel.refresh", found.id), (p) => "Started a refresh of the panel " + safe(p.title) + ": a turn of " + safe(p.bot ?? "its bot") + "'s model. Follow it with `botkins chats show " + (p.chatId ?? "<chat>") + "`, or `botkins panels show " + word(p.title, p.id) + "` later.");
        },
      },
      new: {
        summary: "Ask a bot to make a new panel from a sentence (a turn of the bot's model)",
        usage: "botkins panels new --space <space> --bot <bot> [--start <kind>] [--refresh <when>] [--at <HH:MM>] [--days <list>] [--timezone <zone>] [--project <project>] [<sentence>…] [--file <path>] [--yes]",
        arguments: [{ name: "sentence", required: false, many: true }],
        options: {
          space: { type: "string", value: "space", about: "The space the panel goes in (its name or id)" },
          bot: { type: "string", value: "bot", about: "The bot that makes and refreshes the panel (name or id)" },
          start: { type: "string", value: "kind", about: "How it starts: " + startsList },
          refresh: { type: "string", value: "when", about: "Refresh it on a schedule: daily, weekdays, weekly, or a cron line of five fields in quotes" },
          ...SCHEDULE_OPTIONS,
          project: { type: "string", value: "project", about: "Attach the panel to this project (name or id)" },
          file: { type: "string", value: "path", about: "Read the sentence from a file (\"-\" reads standard input)" },
          ...YES,
        },
        details:
          "This opens a chat with the bot and sends your sentence, which starts a turn of the bot's model and can cost money. The command does not wait: it prints the chat's id, and the panel appears in the space when the bot publishes it (`botkins chats show <chat>`). --start gives the bot one more line: " +
          startsList +
          ". With --refresh the panel also gets a routine that runs your sentence on that schedule, with nobody watching, once the bot has published the panel. The command then shows the routine as it will be (the bot, the schedule in words, the next two times, your sentence) and asks; with no terminal it needs --yes. " +
          SCHEDULE_DETAILS,
        async run(context) {
          const o = context.options;
          if (o.space === undefined || o.bot === undefined) throw usage("Name the space with --space <space> and the bot with --bot <bot>.");
          if (o.refresh === undefined && (o.at !== undefined || o.days !== undefined || o.timezone !== undefined)) throw usage("--at, --days and --timezone go with --refresh.");
          const sentence = await wordsOrFile(context, 0, "sentence");
          const data = { space: o.space, bot: o.bot, text: sentence, ...(o.start !== undefined && { start: o.start }), ...(o.project !== undefined && { project: o.project }) };
          let review;
          if (o.refresh !== undefined) {
            data.refresh = refreshFrom(o);
            review = await context.client.call("panel.routine.review", null, { ...data.refresh, bot: o.bot, prompt: sentence });
            show(context, reviewText(review, "This starts a turn of a bot's model that makes a new panel, and then refreshes it on a schedule with nobody watching. The routine will be saved as:", "Panel: new, in the space " + safe(o.space) + ", from your sentence"));
            if (!(await confirm(context, "Make the panel and its routine?"))) return EXIT.failed;
          }
          const made = await context.client.call("panel.new", data, ...(review ? agreedFast(review) : []));
          context.print(made, (done) => ["Started a chat " + done.chatId + " with " + safe(done.bot.name) + " to make a new panel in " + safe(done.space.name) + ". That started a turn of its model." + (done.routine ? " Once the bot has published the panel, it gets the routine." : ""), "Follow it with `botkins chats show " + done.chatId + "`. The panel is in `botkins panels list` when the bot has published it."].join("\n"));
        },
      },
      ask: {
        summary: "Ask a bot about a panel (a turn of the bot's model)",
        usage: "botkins panels ask <panel> --bot <bot> [<message>…] [--file <path>] [--space <space>]",
        arguments: [{ name: "panel", required: true }, { name: "message", required: false, many: true }],
        options: { ...PANEL_SPACE, bot: { type: "string", value: "bot", about: "The bot to ask (name or id)" }, file: { type: "string", value: "path", about: "Read the message from a file (\"-\" reads standard input)" } },
        details: "This opens a chat with the bot that is about the panel, and sends the message. That starts a turn of the bot's model, which can cost money. The command does not wait: it prints the chat's id (`botkins chats show <chat>`). It is the same as `botkins spaces ask <space> --panel <panel>`.",
        async run(context) {
          if (!context.args.length) throw usage(PANEL);
          if (context.options.bot === undefined) throw usage("Name the bot to ask with --bot <bot>.");
          const message = await wordsOrFile(context, 1, "message");
          const found = await findPanel(context, context.args[0]);
          const asked = await context.client.call("panel.ask", found.id, { bot: context.options.bot, text: message });
          context.print(asked, (done) => "Asked " + safe(done.bot.name) + " about the panel " + safe(done.panel.title) + ". That started a turn of its model. Follow the chat with `botkins chats show " + done.chatId + "`.");
        },
      },
      remove: {
        summary: "Delete a panel with its routine, its views, its saved state and its notes",
        usage: "botkins panels remove <panel> [--space <space>] [--yes]",
        options: { ...PANEL_SPACE, ...YES },
        details: "This cannot be undone. The command shows what goes and asks; with no terminal it needs --yes. The panel's bot can publish a new one with the same key later. To keep a panel and only take it off the page, use `botkins panels hide`.",
        async run(context) {
          const found = await findPanel(context, one(context, PANEL));
          show(context, ["This deletes the panel " + safe(found.title) + " (" + found.id + ") from the space " + safe(found.space.name) + ", with:", "  its content (" + count(found.blocks.length, "block") + ", " + count(found.views, "custom view") + ")" + (found.state ? " and its saved state" : "") + ".", ...(found.notes.length ? ["  its " + count(found.notes.length, "note") + "."] : []), ...(found.routine ? ["  its routine: " + safe(found.routine.meaning) + ", with its prompt."] : []), "It cannot be undone."].join("\n"));
          if (!(await confirm(context, "Delete the panel?"))) return EXIT.failed;
          context.print(await context.client.call("panel.remove", found.id, { agreed: true }), (gone) => "Deleted the panel " + safe(gone.title) + ".");
        },
      },
      routine: {
        summary: "A panel's routine: its bot refreshes the panel on a schedule",
        details: "A routine runs the panel's bot on a schedule, with nobody watching: each run is a turn of the bot's model, which can cost money. `set` shows the routine as it will be and asks first.",
        commands: {
          set: {
            summary: "Set a panel's routine: when its bot refreshes it, and what the bot does",
            usage: "botkins panels routine set <panel> [--cadence <kind>] [--at <HH:MM>] [--days <list>] [--cron <five fields>] [--timezone <zone>] [--prompt <text>] [--file <path>] [--space <space>] [--yes]",
            options: {
              ...PANEL_SPACE,
              cadence: { type: "string", value: "kind", about: "How often: daily, weekdays or weekly" },
              ...SCHEDULE_OPTIONS,
              cron: { type: "string", value: "five fields", about: "A cron line: minute, hour, day of the month, month, day of the week" },
              prompt: { type: "string", value: "text", about: "What the bot does at each refresh (up to 4,000 characters)" },
              file: { type: "string", value: "path", about: "Read the prompt from a file (\"-\" reads standard input)" },
              ...YES,
            },
            details: "This sets the routine, or replaces the one the panel has. The command shows the whole routine first (the bot, the schedule in words, the next two times and the prompt) and asks; with no terminal it needs --yes. What is shown goes to standard error, with --yes and --json too. " + SCHEDULE_DETAILS,
            async run(context) {
              const o = context.options;
              const ref = one(context, PANEL);
              if (o.prompt !== undefined && o.file !== undefined) throw usage("Give the prompt with --prompt or with --file, not both.");
              const prompt = o.prompt ?? (o.file !== undefined ? (await textFrom(context, o.file, "prompt file")).replace(/\r\n/g, "\n").trimEnd() : undefined);
              if (prompt === undefined || !prompt.trim()) throw usage("Give the prompt: --prompt <text>, or --file <path> (\"-\" reads standard input). The prompt is what the bot does at each refresh.");
              const found = await findPanel(context, ref);
              const spec = { ...scheduleFrom(o), prompt };
              const review = await context.client.call("panel.routine.review", found.id, spec);
              show(context, reviewText(review, "This runs the panel's bot on a schedule, with nobody watching. The routine will be saved as:", "Panel: " + safe(found.title) + " (" + safe(found.space.name) + ")"));
              if (!(await confirm(context, "Save the routine?"))) return EXIT.failed;
              context.print(await context.client.call("panel.routine.set", found.id, spec, ...agreedFast(review)), (p) => "Saved the routine of the panel " + safe(p.title) + ": " + safe(p.routine.meaning) + ". It runs next at " + at(p.routine.nextAt, p.routine.timezone) + ".");
            },
          },
          pause: {
            summary: "Pause a panel's routine. The routine and its prompt are kept",
            usage: "botkins panels routine pause <panel> [--space <space>]",
            options: PANEL_SPACE,
            async run(context) {
              const found = await findPanel(context, one(context, PANEL));
              context.print(await context.client.call("panel.routine.pause", found.id), (p) => "Paused the routine of the panel " + safe(p.title) + ". Turn it on with `botkins panels routine resume " + word(p.title, p.id) + "`.");
            },
          },
          resume: {
            summary: "Turn a paused routine on again",
            usage: "botkins panels routine resume <panel> [--space <space>] [--yes]",
            options: { ...PANEL_SPACE, ...YES },
            details: "A routine that runs more often than every 15 minutes shows its cost and asks first; with no terminal it needs --yes. Any other routine is turned on with no question.",
            async run(context) {
              const found = await findPanel(context, one(context, PANEL));
              const fast = found.routine?.fastMinutes;
              if (fast) {
                show(context, "This turns on the routine of the panel " + safe(found.title) + ", which runs a bot on a schedule with nobody watching:\n  When: " + safe(found.routine.meaning) + "\n  Cost: " + costSentence(fast));
                if (!(await confirm(context, "Turn the routine on?"))) return EXIT.failed;
              }
              context.print(await context.client.call("panel.routine.resume", found.id, ...(fast ? [{ fastSchedule: true }] : [])), (p) => "The routine of the panel " + safe(p.title) + " is on. It runs next at " + at(p.routine.nextAt, p.routine.timezone) + ".");
            },
          },
          remove: {
            summary: "Take a panel's routine away, with its prompt",
            usage: "botkins panels routine remove <panel> [--space <space>] [--yes]",
            options: { ...PANEL_SPACE, ...YES },
            details: "The panel stays and its bot can still refresh it when asked (`botkins panels refresh`). The routine's prompt is gone: to keep the routine and stop it, use `botkins panels routine pause`. The command shows the routine and asks; with no terminal it needs --yes.",
            async run(context) {
              const found = await findPanel(context, one(context, PANEL));
              if (!found.routine) throw new CliError("The panel " + safe(found.title) + " has no routine.");
              show(context, ["This takes away the routine of the panel " + safe(found.title) + ", with its prompt:", ...routineLines(found.routine).map((line) => "  " + line)].join("\n"));
              if (!(await confirm(context, "Remove the routine?"))) return EXIT.failed;
              context.print(await context.client.call("panel.routine.remove", found.id, { agreed: true }), (p) => "Removed the routine of the panel " + safe(p.title) + ".");
            },
          },
        },
      },
      "set-state": {
        summary: "Set a value in an app panel's saved state, as your own change",
        usage: "botkins panels set-state <panel> [<key>] [<value>] [--remove] [--file <path>] [--label <text>] [--space <space>]",
        arguments: [{ name: "panel", required: true }, { name: "key", required: false }, { name: "value", required: false }],
        options: { ...PANEL_SPACE, remove: { type: "boolean", about: "Take the key away (give no value)" }, file: { type: "string", value: "path", about: "Set the keys of a JSON object from a file (\"-\" reads standard input)" }, label: { type: "string", value: "text", about: "A few words for the panel's last line, such as \"ticked an item\"" } },
        details: "An app panel keeps a state that people change in it: a checklist's ticks, a tracker's counts. This changes keys of it, as you, the owner. The value is JSON when it is JSON (5, true, [1,2], {\"a\":1}) and text when it is not; a null value takes the key away, as --remove does. Several keys at once: --file with a JSON object. The host allows ten changes at once, then one a second.",
        async run(context) {
          const [ref, key, value, ...more] = context.args;
          const o = context.options;
          if (!ref || more.length) throw usage(PANEL);
          let patch;
          if (o.file !== undefined) {
            if (key !== undefined || o.remove) throw usage("--file takes a JSON object of keys: give no key and no value with it.");
            try {
              patch = JSON.parse(await textFrom(context, o.file, "state file"));
            } catch (error) {
              throw usage("The state file is not JSON: " + error.message);
            }
            if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw usage("The state file holds a JSON object of the keys to set.");
          } else {
            if (key === undefined) throw usage("Name the key to set, or give --file.");
            if (o.remove) {
              if (value !== undefined) throw usage("--remove takes no value.");
              patch = { [key]: null };
            } else {
              if (value === undefined) throw usage("Give the value for " + JSON.stringify(safe(key)) + ", or --remove to take the key away.");
              let parsed = value;
              try {
                parsed = JSON.parse(value);
              } catch {}
              patch = { [key]: parsed };
            }
          }
          const found = await findPanel(context, ref);
          context.print(await context.client.call("panel.state", found.id, patch, o.label), (done) => "Changed the state of the panel " + safe(done.panel.title) + " (revision " + done.rev + "). Its keys: " + (done.keys.length ? done.keys.map(safe).join(", ") : "none") + ".");
        },
      },
      note: {
        summary: "Write a note on a panel, as you",
        usage: "botkins panels note <panel> [<text>…] [--file <path>] [--space <space>]",
        arguments: [{ name: "panel", required: true }, { name: "text", required: false, many: true }],
        options: { ...PANEL_SPACE, file: { type: "string", value: "path", about: "Read the note from a file (\"-\" reads standard input)" } },
        details: "A note is up to 2,000 characters, and a panel holds 50. Everyone who can open the space sees it. A note is the people's, not an instruction to the bot. The host allows five notes at once, then one every five seconds.",
        async run(context) {
          if (!context.args.length) throw usage(PANEL);
          const words = await wordsOrFile(context, 1, "note");
          const found = await findPanel(context, context.args[0]);
          context.print(await context.client.call("panel.note", found.id, words), (done) => "Wrote a note on the panel " + safe(done.panel.title) + " (" + done.note.id + ").");
        },
      },
      "remove-note": {
        summary: "Remove a note from a panel",
        usage: "botkins panels remove-note <panel> <note> [--space <space>] [--yes]",
        arguments: [{ name: "panel", required: true }, { name: "note", required: true }],
        options: { ...PANEL_SPACE, ...YES },
        details: "The note is its id, its number in `botkins panels show` (1 is the first), or the start of its id. The owner can remove any note. A removed note cannot be got back, so the command shows it and asks; with no terminal it needs --yes.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the panel, then the note (its id or number).");
          const found = await findPanel(context, context.args[0]);
          const number = Number(context.args[1]);
          const target = found.notes.find((item) => item.id === context.args[1]) ?? (Number.isInteger(number) ? found.notes[number - 1] : undefined) ?? found.notes.find((item) => item.id.startsWith(context.args[1]));
          show(context, "This removes " + (target ? "the note " + target.id + " by " + safe(target.by ?? "someone") + ": " + JSON.stringify(safe(String(target.text ?? "").slice(0, 200))) : "a note") + " from the panel " + safe(found.title) + ". It cannot be got back.");
          if (!(await confirm(context, "Remove the note?"))) return EXIT.failed;
          context.print(await context.client.call("panel.noteRemove", found.id, context.args[1], { agreed: true }), (done) => "Removed the note " + done.removed + " from the panel " + safe(done.panel.title) + ".");
        },
      },
    },
  },

  cards: {
    summary: "Cards of Feed, Ideas and Goals: list them and answer them",
    details: "A bot posts cards to your Feed (something to read), Ideas (a suggestion you can say yes to) and Goals (something to track). A card is named by its title or its id (`botkins cards list`). `botkins cards act` does what the buttons on a card do.",
    commands: {
      list: {
        summary: "List cards, newest first",
        usage: "botkins cards list [--space <space>] [--kind <kind>] [--status <status>] [--bot <bot>]",
        options: {
          space: { type: "string", value: "space", about: "Only the cards of this space (a Feed, Ideas or Goals)" },
          kind: { type: "string", value: "kind", about: "feed, idea or goal" },
          status: { type: "string", value: "status", about: "open (the default), done, cleared, or all" },
          bot: { type: "string", value: "bot", about: "Only the cards of this bot" },
        },
        async run(context) {
          const o = context.options;
          const status = o.status ?? "open";
          const list = await context.client.call("card.list", { ...(o.space !== undefined && { space: o.space }), ...(o.kind !== undefined && { kind: o.kind }), ...(status !== "all" && { status }), ...(o.bot !== undefined && { bot: o.bot }) });
          context.print(list, (cards) => (cards.length ? cardTable(cards, true) : "No " + (status === "all" ? "" : status + " ") + "cards."));
        },
      },
      show: {
        summary: "Show one card",
        usage: "botkins cards show <card>",
        async run(context) {
          context.print(await context.client.call("card.get", one(context, "Name the card (its title or id: `botkins cards list`).")), cardText);
        },
      },
      act: {
        summary: "Answer a card: read, done, yes, goal, a thumb, and so on",
        usage: "botkins cards act <card> <action> [<value>] [--yes]",
        arguments: [{ name: "card", required: true }, { name: "action", required: true }, { name: "value", required: false }],
        options: YES,
        details:
          "The actions: read and unread; clear (put it away); done; reopen (an open card again); yes (an idea: Let's do it, which marks it done and tells the bot); goal (an idea becomes a goal in the Goals of the person whose idea it was; the value is the category: health, relationships, finance, career, interests, productivity or other); notToday (a goal: put it away until midnight); up (a thumb up, again to take it back); down (a thumb down; the value is a reason: Not relevant, Too frequent, Already knew or Wrong timing; a Feed card is cleared); delete. A delete cannot be undone: it asks first, and with no terminal it needs --yes. The bot reads these answers to learn what helps.",
        async run(context) {
          const [ref, action, value, ...more] = context.args;
          if (!ref || !action || more.length) throw usage("Name the card, then the action.");
          let marks = [];
          if (action === "delete") {
            const found = await context.client.call("card.get", ref);
            show(context, "This deletes the " + found.kind + " card " + safe(found.title) + " (" + found.id + "). It cannot be undone.");
            if (!(await confirm(context, "Delete the card?"))) return EXIT.failed;
            marks = [{ agreed: true }];
          }
          const done = await context.client.call("card.act", ref, action, value ?? null, ...marks);
          context.print(done, (result) => (result.deleted ? "Deleted the card " + safe(result.card.title) + "." : "Done: " + action + " on the card " + safe(result.card.title) + " (now " + result.card.status + ")." + (result.created ? " The new goal is " + safe(result.created.title) + " (" + result.created.id + ")." : "")));
        },
      },
    },
  },
};
