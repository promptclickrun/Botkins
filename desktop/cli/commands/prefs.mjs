// Preferences, usage, the cache and the Mac tools: the commands (cli/commands/index.mjs adds them).
// (Voice is its own area: cli/commands/voice.mjs.)
// `prefsCommands` maps a top-level word to a group `{ summary, commands }`.
//
// `botkins preferences` is the app's Preferences page. `botkins config` is something else: the
// settings of this host, the service (its link port, its relay, its updates).
//
// Two rules of the command line hold here (desktop/AGENTS.md):
//  - A change that takes a question away or gives bots more room shows what it gives first, and needs
//    a yes (`--yes` when there is no terminal): a looser approval level, `access.allBots` and
//    `teamwork` switched on, and a Mac tool switched on. What it gives is shown on standard error
//    whatever `--yes` and `--json` say, so a person who reads it sees it. The call to the service
//    then carries the mark `{ agreed: true }`: the service refuses these changes without it.
//  - A change that is hard to undo asks first: clearing the cache, overwriting a file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, readAll } from "./input.mjs";
import { safe } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Do not ask first" } };
const THEMES = JSON.parse(readFileSync(new URL("../../desktop/themes.json", import.meta.url), "utf8"));
const list = (words) => words.join(", ");
/** What is said to a person who must see it, whatever --json is: on standard error. */
const show = (context, text) => void context.stderr.write(text + "\n");
const count = (value, one_, many) => value + " " + (value === 1 ? one_ : many);
const number = (value) => Number(value).toLocaleString("en-US");

// ── Preferences ─────────────────────────────────────────────────────────────────────────────────
// Each key as `botkins preferences set` takes it: [key, what it takes, what it is].
// (desktop/terminal/control-prefs.mjs holds the list that is checked; a test keeps the two the same.)
const KEYS = [
  ["appearance.theme", "system | light | dark", "Light, dark, or the computer's own"],
  ["appearance.colorTheme", list(THEMES.themes.map((theme) => theme.id)), "The color theme"],
  ["appearance.backdrop", "clean | mesh | botkins | grid", "The backdrop behind the glass"],
  ["appearance.textSize", "small | default | large | larger", "The size of the text"],
  ["appearance.font", list(THEMES.fonts.map((font) => font.id)), "The font"],
  ["appearance.bubble", "theme | #rrggbb", "The color of your messages"],
  ["appearance.avatarAnimations", "on | off", "Animate bot avatars while they work"],
  ["foldTools", "on | off", "Fold the steps of a finished reply into one line"],
  ["showThinking", "on | off", "Show the bot's thinking"],
  ["onboarded", "on | off", "The welcome is done"],
  ["linkPreviews", "on | off", "Show a preview of a linked page (this computer fetches the page)"],
  ["readAloud", "on | off", "Read replies aloud"],
  ["showRoutineChats", "on | off", "Show routine-owned chats in the chat list"],
  ["teamwork", "on | off", "Bots may ask each other for help from a chat"],
  ["longPromptCache", "on | off", "Keep a chat's prompt cache for about an hour where the provider supports it"],
  ["autoSummarize", "off | 5 to 30", "Turns between a chat's summaries into a new title, on the Default routines model"],
  ["tasksMax", "1 to 16 | default", "Task Board tasks that run at once on this computer (default: $BOTKINS_TASKS_MAX, else 2)"],
  ["tasksPerBot", "1 to 8 | default", "Task Board tasks that one bot runs at once, each in its own chat (default: $BOTKINS_TASKS_PER_BOT, else 1)"],
  ["tasksCreatorReviewExisting", "on | off", "Hand existing bot-created tasks currently in Review to their creator bot"],
  ["approval", "ask | read | assisted | all", "How tool requests are approved (see below)"],
  ["clarify", "missing, choices, changes, or none", "When a bot asks a clarifying question"],
  ["clarificationInstructions", "text (up to 4000 characters)", "Your own words for when a bot asks a clarifying question"],
  ["notifications.replies", "on | off", "Tell me when a bot replies"],
  ["notifications.routines", "on | off", "Tell me when a routine finishes"],
  ["notifications.requests", "on | off", "Tell me when a bot asks for something"],
  ["notifications.reminders", "on | off", "Remind me once when something is left waiting on me"],
  ["notifications.quietHours.enabled", "on | off", "Keep quiet during the quiet hours"],
  ["notifications.quietHours.from", "HH:MM", "The quiet hours start"],
  ["notifications.quietHours.to", "HH:MM", "The quiet hours end"],
  ["notifications.bots.mode", "all | only", "Notify for all bots or only selected bots"],
  ["notifications.bots.ids", "id,id | none", "Bot IDs to notify for when notifications.bots.mode is only"],
  ["notifications.mutedBots", "id,id | none", "Bot IDs muted from reply and routine notifications"],
  ["access.allBots", "on | off", "Every bot can use every project"],
  ["harness", "copilot | provider | pi | omp", "What runs a bot's turn (`botkins preferences harnesses` lists the choices)"],
  ["background.keepRunning", "on | off", "For the desktop app's window (this host runs as a service)"],
  ["background.runAtStartup", "on | off", "For the desktop app's window (this host starts with `botkins service install`)"],
  ["sidebar.order", "Home, Today, Chats, Work, Wiki, Market", "The order of the places in the side menu"],
  ["sidebar.collapsed", "on | off", "The side menu shows icons only"],
  ["proactive.chatMode", "main | new", "Proactive signals: Main chat or New chat every time, for you on this computer"],
  ["proactive.enabled", "on | off", "Experimental: the computer's switch for the Proactive agent (each bot's own is `botkins bots proactive`)"],
  ["workspacePrune.auto", "on | off", "Automatically prune old workspace runs at startup and once a day"],
  ["workspacePrune.keepDays", "1 to 3650", "Days of run history to keep before auto-pruning"],
  ["workspacePrune.mode", "trim | delete", "How auto-pruning compacts old runs: trim or delete"],
];
/** The keys, for the help of `preferences set`. */
export const PREFERENCE_KEYS = KEYS.map(([key]) => key);
const keyWidth = Math.max(...KEYS.map(([key]) => key.length));
const keyHelp = KEYS.map(([key, takes, about]) => "  " + key.padEnd(keyWidth) + "  " + about + "\n  " + " ".repeat(keyWidth) + "  takes: " + takes).join("\n");
const APPROVAL = ["ask", "read", "assisted", "all"];
const APPROVAL_GIVES = {
  read: "Bots then use file reads and read-only tools without asking you. They ask for everything else.",
  assisted: "The model provider then decides which requests to ask you about. Bots may run requests without asking you.",
  all: "Bots then run commands and change files on this computer, and use every tool, without asking you first.",
};
const ON = ["on", "true", "yes", "1"];
/** What a switch gives bots, for each preference that gives them more room. `(now, word)` is null when the new value gives nothing more. */
const WIDENS = {
  approval: (now, word) => (APPROVAL.indexOf(word) > APPROVAL.indexOf(now) ? { gives: APPROVAL_GIVES[word], question: "Change the approval level from " + now + " to " + word + "?" } : null),
  "access.allBots": (now, word) => (ON.includes(word) && now !== true ? { gives: "Every bot can then use every project. The grant that each bot has in its own Access settings no longer limits it.", question: "Let every bot use every project?" } : null),
  teamwork: (now, word) => (ON.includes(word) && now !== true ? { gives: "A bot can then bring other bots into a chat to work for it. A teammate works with its own tools, memory and model. What it needs approved is asked in the chat.", question: "Let bots ask each other for help from a chat?" } : null),
  "proactive.enabled": (now, word) => (ON.includes(word) && now !== true ? { gives: "Every bot that has its own Proactive agent switched on then wakes on its own, reads what its tools reach (such as your inbox and calendar) and messages you, with nobody watching. Each wake uses the model.", question: "Turn on the Proactive agent for this computer?" } : null),
  "background.runAtStartup": (now, word) => (ON.includes(word) && now !== true ? { lead: "This changes this computer.", gives: "Botkins then starts when you log in to this computer. This adds a login item to this computer.", question: "Make Botkins start when you log in to this computer?" } : null),
};
const asText = (value) => (Array.isArray(value) ? (value.length ? value.join(", ") : "none") : typeof value === "boolean" ? (value ? "on" : "off") : String(value));
const cell = (value) => {
  if (typeof value !== "string") return asText(value);
  const plain = safe(value);
  if (/^[\w#.:-]+$/.test(plain)) return plain;
  const text = JSON.stringify(plain);
  return text.length > 62 ? text.slice(0, 60) + "…\"" : text;
};
/** A text from a file, or from standard input for "-". */
async function textFrom(context, path, what) {
  if (path === "-") return readAll(context.stdin);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The " + what + " " + path + " cannot be read: " + error.message);
  }
}

const preferences = {
  summary: "Read and change the app's preferences: theme, approvals, notifications, and the rest of the Preferences page",
  details: "These are the preferences of the app, the ones its Preferences page shows. The settings of this host (its port, relay and updates) are `botkins config`.",
  commands: {
    show: {
      summary: "Show the preferences, or one",
      usage: "botkins preferences show [<key>]",
      arguments: [{ name: "key", required: false }],
      details: "`botkins help preferences set` lists the keys. The iMessage and Mail tools are `botkins mac-tools`.",
      async run(context) {
        if (context.args.length > 1) throw usage("Name one preference, or none.");
        const [key] = context.args;
        const values = await context.client.call("preferences.get", ...(key === undefined ? [] : [key]));
        context.print(values, (found) => {
          if (key !== undefined) return typeof found[key] === "string" ? safe(found[key]) : asText(found[key]);
          return table(["KEY", "VALUE"], Object.entries(found).map(([name, value]) => [name, cell(value)]));
        });
      },
    },
    set: {
      summary: "Change one preference",
      usage: "botkins preferences set <key> <value> [--file <path>] [--yes]",
      arguments: [{ name: "key", required: true }, { name: "value", required: false }],
      options: {
        file: { type: "string", value: "path", about: "Read the value from a file (for a text, such as clarificationInstructions). \"-\" as the value reads standard input" },
        ...YES,
      },
      details: [
        "The keys, what each takes, and what it is:",
        keyHelp,
        "",
        "A key that is not in this list is refused. A switch takes on or off (true, false, yes, no and 1, 0 work too).",
        "A longer text (clarificationInstructions) comes from --file <path>, or from standard input with `-` as the value. An empty value (\"\") clears it.",
        "",
        "approval, access.allBots, teamwork: a switch that takes a question away or gives bots more room is shown first, with what it gives, and needs your yes (--yes when there is no terminal). That is a looser approval level, and access.allBots or teamwork switched on. What it gives is printed on standard error with --yes and --json too. A change that gives nothing more (a tighter level, a switch turned off) needs no yes.",
        "background.*: these two are for the desktop app's window. This host stores them and does nothing with them.",
        "proactive.enabled: Settings › Experimental › Proactive agent, the computer's switch. Off pauses every bot's agent without forgetting its settings; turning it on is shown first and needs your yes. Which bots are proactive, and how, is `botkins bots proactive <bot>`.",
      ].join("\n"),
      async run(context) {
        const [key, given, ...extra] = context.args;
        if (key === undefined) throw usage("Name the preference. `botkins help preferences set` lists them.");
        if (extra.length) throw usage("Give one value. A text with spaces goes in quotes.");
        const known = KEYS.find(([name]) => name === key);
        if (context.options.file !== undefined && given !== undefined) throw usage("Give the value as a word, or with --file, not both.");
        if (context.options.file !== undefined && known && known[1].startsWith("text") === false) throw usage("--file is for a text, such as clarificationInstructions.");
        let value = given;
        if (context.options.file !== undefined) value = (await textFrom(context, context.options.file, "file")).replace(/\r?\n$/, "");
        else if (given === "-") value = (await readAll(context.stdin)).replace(/\r?\n$/, "");
        if (value === undefined) throw usage("Give the value. `botkins help preferences set` says what each key takes.");
        // A switch that gives bots more room is shown (on standard error, with --yes and --json too) and asked for. The call carries the mark of that.
        let agreed = false;
        if (Object.hasOwn(WIDENS, key)) {
          const word = String(value).trim().toLowerCase();
          const more = WIDENS[key]((await context.client.call("preferences.get", key))[key], word);
          if (more) {
            show(context, (more.lead ?? "This gives bots more room.") + " " + more.gives);
            if (!(await confirm(context, more.question))) return EXIT.failed;
            agreed = true;
          }
        }
        const done = await context.client.call("preferences.set", key, value, ...(agreed ? [{ agreed: true }] : []));
        context.print(done, (now) => "Set " + now.key + (typeof now.value === "string" && now.value.length > 60 ? "." : " to " + (typeof now.value === "string" ? safe(now.value) || "(empty)" : asText(now.value)) + "."));
      },
    },
    harnesses: {
      summary: "Show what can run a bot's turn, and which one is chosen",
      usage: "botkins preferences harnesses",
      details: "The choice is the preference `harness`: `botkins preferences set harness <choice>`. The programs are the harnesses that are a program of their own (Pi and OMP): each says whether it is installed on this computer.",
      async run(context) {
        if (context.args.length) throw usage("This command takes no words.");
        context.print(await context.client.call("preferences.harnesses"), (found) =>
          [
            table(["CHOICE", "CHOSEN", "WHAT IT IS"], found.choices.map((entry) => [entry.id, entry.id === found.chosen ? "yes" : "", safe(entry.about)])),
            "",
            found.programs.length
              ? table(["PROGRAM", "INSTALLED", "VERSION", "NOTE"], found.programs.map((entry) => [safe(entry.id), entry.installed ? "yes" : "no", entry.version ? safe(entry.version) : "", safe(entry.error ?? (entry.installed ? "" : entry.message ?? ""))]))
              : "No program runs a turn on its own on this computer.",
          ].join("\n"),
        );
      },
    },
  },
};

// ── Usage ───────────────────────────────────────────────────────────────────────────────────────
const DAYS = { days: { type: "string", value: "7|30|90", about: "How many days to cover: 7, 30 or 90 (the default is 30)" } };
const daysOf = (context) => {
  if (context.options.days === undefined) return undefined;
  const days = Number(context.options.days);
  if (![7, 30, 90].includes(days)) throw usage("--days is 7, 30 or 90.");
  return days;
};
const money = (value) => "$" + (value >= 100 ? value.toFixed(0) : value.toFixed(2));
const cost = (row) => (row.priced ? money(row.cost) : "-");
/** A cache hit rate as a whole percent, "-" when no turn counted one (or the computer is older). */
const cached = (row) => (typeof row.cacheHitRate !== "number" ? "-" : row.cacheHitRate > 0 && row.cacheHitRate < 0.01 ? "<1%" : Math.round(row.cacheHitRate * 100) + "%");
const usageText = (report) =>
  [
    "The last " + report.days + " days: " + count(report.totals.turns, "turn", "turns") + ".",
    "Tokens in " + number(report.totals.input) + ", out " + number(report.totals.output) + ", read from the cache " + number(report.totals.cacheRead) + (report.totals.cacheWrite ? ", written to the cache " + number(report.totals.cacheWrite) : "") + ". Cache hit rate " + cached(report.totals) + ". Cost " + cost(report.totals) + (report.totals.priced && report.totals.priced < report.totals.turns ? " (priced for " + report.totals.priced + " of the " + report.totals.turns + " turns)" : "") + ".",
    ...(report.byModel.length ? ["", "By model:", table(["MODEL", "PROVIDER", "TURNS", "IN", "OUT", "CACHED", "COST"], report.byModel.map((row) => [safe(row.model), safe(row.provider ?? ""), row.turns, number(row.input), number(row.output), cached(row), cost(row)]))] : []),
    ...(report.byBot.length ? ["", "By bot:", table(["BOT", "TURNS", "IN", "OUT", "CACHED", "COST"], report.byBot.map((row) => [safe(row.name), row.turns, number(row.input), number(row.output), cached(row), cost(row)]))] : []),
  ].join("\n");

const usageGroup = {
  summary: "Show what the bots used, and export it as a CSV file",
  commands: {
    show: {
      summary: "Turns, tokens and cost over 7, 30 or 90 days, by model and by bot",
      usage: "botkins usage show [--days <7|30|90>]",
      options: DAYS,
      details: "`--json` adds the numbers for each day. The plans and limits of the model providers are `botkins providers`.",
      async run(context) {
        const days = daysOf(context);
        context.print(await context.client.call("usage.report", ...(days === undefined ? [] : [days])), usageText);
      },
    },
    export: {
      summary: "Export one row for each turn as CSV, to standard output or to a file",
      usage: "botkins usage export [--days <7|30|90>] [--output <path>] [--yes]",
      options: { ...DAYS, output: { type: "string", value: "path", about: "Write the CSV to this file. Without it the CSV goes to standard output" }, ...YES },
      details: "The rows hold the time, bot, chat, title, model, tokens and cost of each turn. With --json and no --output the answer is { name, days, text }. A file that is there already is overwritten only after a yes (--yes when there is no terminal). A new file can be read by you only.",
      async run(context) {
        const days = daysOf(context);
        const file = await context.client.call("usage.export", ...(days === undefined ? [] : [days]));
        const path = context.options.output;
        if (path === undefined) {
          if (context.json) return void context.print(file);
          return void context.stdout.write(file.text);
        }
        if (existsSync(path) && !(await confirm(context, "Replace " + path + "?"))) return EXIT.failed;
        try {
          writeFileSync(path, file.text, { mode: 0o600 });
        } catch (error) {
          throw new CliError("The file " + path + " cannot be written: " + error.message);
        }
        context.print({ name: file.name, days: file.days, saved: path, bytes: Buffer.byteLength(file.text) }, (done) => "Saved " + done.name + " (" + number(done.bytes) + " bytes) to " + safe(path) + ".");
      },
    },
  },
};

// ── The cache ───────────────────────────────────────────────────────────────────────────────────
const cacheText = (info) => "The window's cache: " + number(info.bytes) + " bytes" + (info.bytes === 0 ? " (this host has none)" : "") + ". Bot menus kept: " + info.catalogs + ".";
const cacheGroup = {
  summary: "Show and clear what Botkins keeps to be quick",
  commands: {
    show: {
      summary: "Show the size of the cache and how many bot menus are kept",
      usage: "botkins cache show",
      async run(context) {
        context.print(await context.client.call("cache.info"), cacheText);
      },
    },
    clear: {
      summary: "Clear the cache",
      usage: "botkins cache clear [--yes]",
      options: YES,
      details: "The bot menus (what a chat offers when you type \"/\") are built again the next time they are used, so the first look is slower. Open chats stay open. No chat, bot or setting is touched.",
      async run(context) {
        if (!(await confirm(context, "Clear the cache?"))) return EXIT.failed;
        context.print(await context.client.call("cache.clear"), (info) => "The cache is clear. " + cacheText(info));
      },
    },
  },
};

// ── The Mac tools ───────────────────────────────────────────────────────────────────────────────
const MAC_NAMES = { imessage: "iMessage", mail: "Mail" };
const LEVELS = ["off", "read", "interact"];
const LEVEL_WORDS = { on: "read", off: "off", read: "read", interact: "interact" };
const GRANTS = {
  imessage: {
    read: "list your recent chats, read the messages of any chat, and search all of your message history (imessage_chats, imessage_history, imessage_search). They do not ask you first.",
    interact: "send an iMessage or SMS as you (imessage_send), and the same reading. A send asks you in the chat first, and a bot can send only a few in one reply.",
  },
  mail: {
    read: "list your mailboxes, search your mail, and read the text of any email (mail_mailboxes, mail_search, mail_read). They do not ask you first.",
    interact: "send email from your default account and mark email read or unread (mail_send, mail_mark_read), and the same reading. Each of these asks you in the chat first, and a bot can send only a few in one reply.",
  },
};
const RUNS = { imessage: "Botkins runs the imsg program on this Mac to do this.", mail: "Botkins runs /usr/bin/osascript with its own fixed scripts on this Mac to do this." };
const PERMISSIONS = { fullDisk: "Full Disk Access (to read Messages)", messagesAutomation: "Automation of Messages", mailAutomation: "Automation of Mail" };
const macText = (status) => {
  if (!status.available) return "iMessage and Mail tools work only in Botkins on a Mac. This computer is not one.";
  const missing = Object.entries(status.permissions ?? {}).filter(([, allowed]) => !allowed).map(([name]) => PERMISSIONS[name] ?? name);
  return [
    ...Object.keys(MAC_NAMES).map((tool) => MAC_NAMES[tool].padEnd(9) + (status.levels?.[tool] ?? "off")),
    "",
    status.imsg?.found ? "The imsg program is installed." : "The imsg program is not installed. iMessage needs it: " + safe(status.imsg?.install?.command ?? "brew install steipete/tap/imsg") + ".",
    ...(missing.length ? ["macOS has not allowed Botkins: " + missing.join(", ") + ". Allow it in System Settings › Privacy & Security."] : []),
  ].join("\n");
};
const macGroup = {
  summary: "Let bots use iMessage and Mail on this Mac",
  commands: {
    status: {
      summary: "Show the level of each tool, whether imsg is installed, and which permissions macOS has given",
      usage: "botkins mac-tools status",
      details: "The two tools work on a Mac only. On another computer the answer says so. For a tool that is on, the permission is checked by asking the app a harmless question with /usr/bin/osascript.",
      async run(context) {
        context.print(await context.client.call("macTools.status"), macText);
      },
    },
    set: {
      summary: "Set a tool to off, read, or interact",
      usage: "botkins mac-tools set <tool> <off|on|read|interact> [--yes]",
      arguments: [{ name: "tool", required: true }, { name: "level", required: true }],
      options: YES,
      details: [
        "The tools are imessage and mail. A name that starts the same way works when only one tool starts so.",
        "  off        bots have no tool of it",
        "  read       bots can read",
        "  interact   bots can read, and can send and change (each send asks you first)",
        "  on         the same as read",
        "A level that gives bots more than the one now shows what it gives (on standard error, with --yes and --json too), and needs your yes (--yes when there is no terminal). Off, or a lower level, needs none. On another computer than a Mac the app refuses a level above off, and that is the answer.",
      ].join("\n"),
      async run(context) {
        if (context.args.length !== 2) throw usage("Give the tool (imessage or mail) and the level (off, on, read or interact).");
        const [ref, word] = context.args;
        const level = LEVEL_WORDS[word.trim().toLowerCase()];
        if (!level) throw usage("A level is off, on, read or interact.");
        const status = await context.client.call("macTools.status");
        // Which tool: the service finds it by name. Here only to show what it would give, so the same rule is used.
        const wanted = ref.trim().toLowerCase();
        const matches = Object.keys(MAC_NAMES).filter((tool) => tool === wanted || MAC_NAMES[tool].toLowerCase() === wanted);
        const tool = matches[0] ?? (Object.keys(MAC_NAMES).filter((id) => id.startsWith(wanted)).length === 1 ? Object.keys(MAC_NAMES).find((id) => id.startsWith(wanted)) : undefined);
        // A computer that is not a Mac gets no question: the app's own refusal is the answer.
        // What it gives is shown on standard error with --yes and --json too. The call carries the mark of the yes.
        let agreed = false;
        if (tool && status.available && LEVELS.indexOf(level) > LEVELS.indexOf(status.levels?.[tool] ?? "off")) {
          show(context, "This lets bots use " + MAC_NAMES[tool] + " on this Mac. At the level " + level + ", bots can " + GRANTS[tool][level] + "\n" + RUNS[tool]);
          if (!(await confirm(context, "Let bots use " + MAC_NAMES[tool] + " at the level " + level + "?"))) return EXIT.failed;
          agreed = true;
        }
        const done = await context.client.call("macTools.set", ref, level, ...(agreed ? [{ agreed: true }] : []));
        context.print(done, (now) => now.name + " is " + (now.levels?.[now.tool] ?? level) + ".\n\n" + macText(now));
      },
    },
  },
};

// ── Workspace storage & pruning ─────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return Math.max(0, Math.round(bytes || 0)) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
function parseWhole(raw, name, min, max) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw usage(`--${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
const workspaceStatsText = (stats) => {
  const lines = [
    `Workspace file: ${formatBytes(stats.bytes)} (${formatBytes(stats.runsBytes)} in runs)`,
    `Runs: ${number(stats.runCount)} across ${number(stats.chatCount)} chats${stats.trimmedRuns ? ` (${number(stats.trimmedRuns)} already trimmed)` : ""}`,
  ];
  if (stats.oldestRunAt) lines.push(`Oldest run: ${new Date(stats.oldestRunAt).toISOString().slice(0, 10)}`);
  if (stats.archiveDir) lines.push(`Archive folder: ${safe(stats.archiveDir)}`);
  return lines.join("\n");
};
const workspacePruneText = (result) => {
  const verb = result.mode === "delete" ? "delete" : "trim";
  const past = result.mode === "delete" ? "Deleted" : "Trimmed";
  const affected = result.affectedCount;
  if (result.dryRun) {
    if (!affected) return `Nothing to ${verb} (keep ${result.keepDays} days, newest ${result.keepRuns} runs; workspace is ${formatBytes(result.beforeBytes)}).`;
    return [
      `Dry run (${result.mode}, keep ${result.keepDays} days, newest ${result.keepRuns} runs):`,
      `  Would ${verb}: ${number(affected)} run${affected === 1 ? "" : "s"}`,
      `  Size: ${formatBytes(result.beforeBytes)} -> ${formatBytes(result.afterBytes)} (saves ${formatBytes(result.savedBytes)})`,
      ...(result.archivePath ? [`  Archive would be written to: ${safe(result.archivePath)}`] : []),
    ].join("\n");
  }
  if (!affected) return `Nothing to ${verb}. Workspace stays ${formatBytes(result.beforeBytes)}.`;
  return [
    `${past} ${number(affected)} run${affected === 1 ? "" : "s"} (mode: ${result.mode}, keep ${result.keepDays} days, newest ${result.keepRuns} runs).`,
    `Size: ${formatBytes(result.beforeBytes)} -> ${formatBytes(result.afterBytes)} (saved ${formatBytes(result.savedBytes)}).`,
    ...(result.archivePath ? [`Archive: ${safe(result.archivePath)}`] : []),
  ].join("\n");
};
const workspaceGroup = {
  summary: "Inspect workspace storage size and prune old run payloads",
  commands: {
    stats: {
      summary: "Show workspace.json size, run count, and archive location",
      usage: "botkins workspace stats",
      async run(context) {
        if (context.args.length) throw usage("This command takes no arguments.");
        context.print(await context.client.call("workspace.stats"), workspaceStatsText);
      },
    },
    prune: {
      summary: "Trim tool payloads from old runs or delete old runs (writes a gzip archive first)",
      usage: "botkins workspace prune --keep-days <N> [--keep-runs <N>] [--mode <trim|delete>] [--dry-run] [--yes]",
      options: {
        "keep-days": { type: "string", value: "days", about: "Keep runs from the last N days (1 to 3650, default 30)" },
        "keep-runs": { type: "string", value: "count", about: "Also always keep the newest N runs overall (0 to 100000, default 200)" },
        mode: { type: "string", value: "trim|delete", about: "trim (drop step inputs/outputs, default) or delete (remove old runs)" },
        "dry-run": { type: "boolean", about: "Preview what would be pruned without changing workspace.json" },
        ...YES,
      },
      details: [
        "Never touches working/queued runs, the newest run of each chat, or runs referenced by pending approvals, tasks, or workflow runs.",
        "Before mutating workspace.json, writes a gzip archive under data/archive/workspace-runs-<timestamp>.json.gz.",
      ].join("\n"),
      async run(context) {
        if (context.args.length) throw usage("Use options (--keep-days, --keep-runs, --mode, --dry-run, --yes) instead of positional arguments.");
        const opts = {};
        if (context.options["keep-days"] !== undefined) opts.keepDays = parseWhole(context.options["keep-days"], "keep-days", 1, 3650);
        if (context.options["keep-runs"] !== undefined) opts.keepRuns = parseWhole(context.options["keep-runs"], "keep-runs", 0, 100_000);
        if (context.options.mode !== undefined) {
          const m = String(context.options.mode).trim().toLowerCase();
          if (m !== "trim" && m !== "delete") throw usage("--mode must be trim or delete.");
          opts.mode = m;
        }
        const dryRun = context.options["dry-run"] === true;
        if (dryRun) {
          const preview = await context.client.call("workspace.prune", { ...opts, dryRun: true });
          context.print(preview, workspacePruneText);
          return;
        }
        // Preview first so the confirmation names the exact counts, bytes saved and archive path.
        const preview = await context.client.call("workspace.prune", { ...opts, dryRun: true });
        if (!preview.affectedCount) {
          context.print({ ...preview, dryRun: false, archivePath: null }, workspacePruneText);
          return;
        }
        const verb = preview.mode === "delete" ? "Delete" : "Trim";
        const msg = `${verb} ${number(preview.affectedCount)} run${preview.affectedCount === 1 ? "" : "s"} to save ~${formatBytes(preview.savedBytes)}?${preview.archivePath ? " Archive: " + safe(preview.archivePath) : ""}`;
        if (!(await confirm(context, msg))) return EXIT.failed;
        const result = await context.client.call("workspace.prune", { ...opts, dryRun: false });
        context.print(result, workspacePruneText);
      },
    },
  },
};

export const prefsCommands = {
  preferences,
  usage: usageGroup,
  cache: cacheGroup,
  workspace: workspaceGroup,
  "mac-tools": macGroup,
};
