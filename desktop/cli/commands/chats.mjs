// Chats: the commands (cli/commands/index.mjs adds them).
// `chatsCommands` maps a top-level word to a group `{ summary, commands }`. A group whose word is there
// already (`bots`, `routines`, `providers`, …) gets these commands added to its own.
//
// `botkins chats` keeps the chats that the Chats page of the window shows: rename, delete, fork, flags,
// the project, group chats, the waiting messages and the sections. To talk to a bot is `botkins chat`.
import { readFileSync } from "node:fs";
import { ago, CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, readAll } from "./input.mjs";
import { approvalAction } from "./workspace.mjs";
import { safe } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first" } };
const YOLO_YES = { yes: { type: "boolean", about: "Don't ask first. Needed for --mode yolo when there is no terminal" } };
const CHAT = "Name the chat (its id, or its title or the start of it).";
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
/** The chat's name as a sentence shows it: its title, and its id. */
const named = (chat) => JSON.stringify(safe(chat.title)) + " (" + chat.id + ")";
const state = (chat) => [chat.working && "working", chat.pinned && "pinned", chat.archived && "archived", chat.unread && "unread", chat.group && "group"].filter(Boolean).join(", ");
/**
 * What yolo mode gives, shown before the yes: the chat, the project and its folder, and what the mode does.
 * It goes to standard error whatever --yes and --json say, as the text of a plugin that runs commands does.
 */
const yoloText = (look) =>
  [
    "Yolo mode for this chat:",
    "  Chat: " + named(look),
    "  Project: " + (look.project ? JSON.stringify(safe(look.project)) + " (" + look.projectId + ")" : "none"),
    "  Folder: " + (look.folder ? JSON.stringify(safe(look.folder)) : "none" + (look.project ? ". A project with no folder takes no mode, so the chat stays in the mode default" : "")),
    "Each request of the bot in this chat gets a yes with no question, but for one that leaves the sandbox.",
  ].join("\n");
/** A chat as a few lines. */
const chatText = (chat) =>
  [
    safe(chat.title) + "   " + chat.id,
    "With: " + (chat.group ? chat.bots.map((name) => safe(name ?? "a bot that is gone")).join(", ") + " (a group chat)" : safe(chat.bot ?? "a bot that is gone")),
    "Messages: " + chat.messages + (state(chat) ? "   (" + state(chat) + ")" : ""),
    chat.project ? "Project: " + safe(chat.project) + " (" + chat.mode + ")" : chat.mode !== "default" ? "Mode: " + chat.mode : null,
    ...(chat.forks ?? []).map(f => (f.id === chat.activeFork ? "Active fork: " : "Fork: ") + f.name + " (" + f.id + ")"),
    chat.section ? "Section: " + safe(chat.section) : null,
    chat.time ? "Last used: " + ago(chat.time) : null,
    chat.latestTurn ? "Latest turn: " + chat.latestTurn.id + (chat.latestTurn.status ? " (" + safe(chat.latestTurn.status) + ")" : "") : null,
  ]
    .filter(Boolean)
    .join("\n");
/** The text of an argument, a file or standard input: a long text is never only a word of the command line. */
async function textFrom(context, words, { what, file }) {
  if (file !== undefined) {
    if (words.length) throw usage("Give the " + what + " as words, or with --file, not both.");
    if (file === "-") return readAll(context.stdin);
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new CliError("The file " + file + " can't be read: " + error.message);
    }
  }
  if (words.length === 1 && words[0] === "-") return readAll(context.stdin);
  return words.join(" ");
}
const sectionText = (list) => (list.sections.length ? table(["SECTION", "CHATS", "ID"], list.sections.map((section) => [safe(section.name), section.chats, section.id])) + "\n" + list.without + " chat" + (list.without === 1 ? " is" : "s are") + " in no section." : "No sections yet. Add one with `botkins chats sections add <name>`.");

const sections = {
  summary: "Group your chats in sections, as on the Chats page",
  details: "A section is your own way to group chats. It changes nothing about a chat, and nobody else sees it. The phone link keeps the sections, and a paired phone shows the same ones. Deleting a section keeps its chats: they are in no section then.",
  commands: {
    list: {
      summary: "List the sections in their order",
      usage: "botkins chats sections list",
      async run(context) {
        context.print(await context.client.call("chats.sections"), sectionText);
      },
    },
    add: {
      summary: "Add a section at the end of the list",
      usage: "botkins chats sections add <name>…",
      async run(context) {
        if (!context.args.length) throw usage("Give the section a name.");
        context.print(await context.client.call("chats.sections.add", context.args.join(" ")), (section) => "Added the section " + JSON.stringify(safe(section.name)) + ".");
      },
    },
    rename: {
      summary: "Give a section another name",
      usage: "botkins chats sections rename <section> <name>…",
      async run(context) {
        const [ref, ...name] = context.args;
        if (!ref || !name.length) throw usage("Name the section (its name or id), then give it the new name.");
        context.print(await context.client.call("chats.sections.rename", ref, name.join(" ")), (section) => "The section is called " + JSON.stringify(safe(section.name)) + " now.");
      },
    },
    delete: {
      summary: "Delete a section and keep its chats",
      usage: "botkins chats sections delete <section> [--yes]",
      options: YES,
      async run(context) {
        const ref = one(context, "Name the section (its name or id).");
        if (!(await confirm(context, "Delete the section " + JSON.stringify(safe(ref)) + "? Its chats stay, in no section."))) return EXIT.failed;
        context.print(await context.client.call("chats.sections.delete", ref), (gone) => "Deleted the section " + JSON.stringify(safe(gone.name)) + ".");
      },
    },
    order: {
      summary: "Put the sections in an order",
      usage: "botkins chats sections order <section>…",
      details: "Name the sections in the order you want. A section that you do not name keeps its place after the named ones.",
      async run(context) {
        if (!context.args.length) throw usage("Name the sections in the order you want.");
        context.print(await context.client.call("chats.sections.order", context.args), (list) => list.map((section, index) => index + 1 + ". " + safe(section.name)).join("\n"));
      },
    },
    set: {
      summary: "Put a chat in a section, or in none",
      usage: "botkins chats sections set <chat> [<section>] [--none]",
      options: { none: { type: "boolean", about: "Take the chat out of its section" } },
      async run(context) {
        const [ref, to, ...more] = context.args;
        if (!ref) throw usage(CHAT);
        if (more.length || (to === undefined) === (context.options.none !== true)) throw usage("Name one section, or give --none.");
        context.print(await context.client.call("chats.sections.set", ref, context.options.none ? null : to), (done) => (done.section ? "Put " + named(done) + " in the section " + JSON.stringify(safe(done.section)) + "." : named(done) + " is in no section."));
      },
    },
  },
};

export const chatsCommands = {
  chats: {
    summary: "Manage chats: rename, fork, delete, group chats, waiting messages and sections",
    details: "To talk to a bot, use `botkins chat`. A chat is named by its id, or by its title: all of it, or the start of it when only one chat starts so. `botkins chats list` shows both.",
    commands: {
      list: {
        summary: "List the chats, newest first",
        usage: "botkins chats list [--bot <bot>]",
        options: { bot: { type: "string", value: "bot", about: "Only this bot's chats" } },
        async run(context) {
          context.print(await context.client.call("chats.list", { ...(context.options.bot !== undefined && { bot: context.options.bot }) }), (list) =>
            list.length ? table(["TITLE", "WITH", "STATE", "SECTION", "ID"], list.map((chat) => [safe(chat.title), chat.group ? chat.bots.map((name) => safe(name ?? "?")).join(", ") : safe(chat.bot ?? "?"), state(chat), safe(chat.section ?? ""), chat.id])) : "There are no chats.",
          );
        },
      },
      search: {
        summary: "Search the messages of every chat, on every harness",
        usage: "botkins chats search <words>… [--bot <bot>] [--chat <chat>] [--since <date>] [--before <date>] [--role user|assistant] [--limit <n>]",
        details: "Every word must appear in a message; put a phrase in quotes to keep it whole. Results are best and newest first, with the chat, the message's index and a snippet.",
        options: {
          bot: { type: "string", value: "bot", about: "Only this bot's chats" },
          chat: { type: "string", value: "chat", about: "Only this chat" },
          since: { type: "string", value: "date", about: "Only messages from this ISO 8601 date on" },
          before: { type: "string", value: "date", about: "Only messages before this ISO 8601 date" },
          role: { type: "string", value: "user|assistant", about: "Only the person's messages, or only the bots'" },
          limit: { type: "string", value: "n", about: "How many results (1 to 30, default 10)" },
        },
        async run(context) {
          if (!context.args.length) throw usage("Give some words to search for.");
          const o = context.options;
          const limit = o.limit === undefined ? undefined : Number(o.limit);
          if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 30)) throw usage("--limit is a number from 1 to 30.");
          const found = await context.client.call("chats.search", context.args.join(" "), {
            ...(o.bot !== undefined && { bot: o.bot }),
            ...(o.chat !== undefined && { chat: o.chat }),
            ...(o.since !== undefined && { since: o.since }),
            ...(o.before !== undefined && { before: o.before }),
            ...(o.role !== undefined && { role: o.role }),
            ...(limit !== undefined && { limit }),
          });
          context.print(found, (r) =>
            r.results.length
              ? r.results.map((hit) => safe(hit.title) + "  (" + hit.chatId + " #" + hit.index + ", " + hit.role + (hit.time ? ", " + ago(Date.parse(hit.time)) : "") + ")\n  " + safe(hit.snippet)).join("\n\n") + "\n\n" + r.matches + " matching message" + (r.matches === 1 ? "" : "s") + " in " + r.chats + " chat" + (r.chats === 1 ? "" : "s") + "."
              : "No messages match.",
          );
        },
      },
      approve: {
        summary: "Review and answer a pending permission on this computer",
        usage: "botkins chats approve <chat-id>",
        async run(context) {
          const { request } = await context.client.call("chat.read", one(context, "Give the chat id from botkins chats list."));
          if (request?.kind !== "permission") throw usage("This chat has no pending approval.");
          const action = await approvalAction(context, request);
          const result = await context.client.call("chat.respond", request.id, { action }, ...(action === "deny" ? [] : [{ agreed: true, ...(request.review && { reviewed: true }) }]));
          context.print(result, "Decision recorded.");
        },
      },
      show: {
        summary: "Show one chat",
        usage: "botkins chats show <chat>",
        async run(context) {
          context.print(await context.client.call("chats.get", one(context, CHAT)), chatText);
        },
      },
      rename: {
        summary: "Give a chat another title",
        usage: "botkins chats rename <chat> <title>…",
        details: "A title starts with a dash only after `--`. A title is up to 120 characters.",
        async run(context) {
          const [ref, ...title] = context.args;
          if (!ref || !title.length) throw usage(CHAT + " Then give the new title.");
          context.print(await context.client.call("chats.rename", ref, title.join(" ")), (chat) => "The chat is called " + JSON.stringify(safe(chat.title)) + " now.");
        },
      },
      "regenerate-title": {
        summary: "Summarize a chat into a new title",
        usage: "botkins chats regenerate-title <chat>",
        details: "Uses the same summarizer as Regenerate title in the app, even when automatic naming is off. It doesn't add a turn to the chat.",
        async run(context) {
          context.print(await context.client.call("chats.regenerateTitle", one(context, CHAT)), (chat) => "The chat is called " + JSON.stringify(safe(chat.title)) + " now.");
        },
      },
      delete: {
        summary: "Delete a chat, with its messages and its runs",
        usage: "botkins chats delete <chat> [--yes]",
        options: YES,
        details: "This cannot be undone. A chat that is working is refused: stop it first.",
        async run(context) {
          const chat = await context.client.call("chats.get", one(context, CHAT));
          if (!(await confirm(context, "Delete the chat " + named(chat) + " with its " + chat.messages + " messages? This cannot be undone."))) return EXIT.failed;
          // (By the id that was shown, so that a title that matches another chat later is not the one that goes.)
          context.print(await context.client.call("chats.delete", chat.id), (gone) => "Deleted the chat " + JSON.stringify(safe(gone.title)) + ".");
        },
      },
      react: {
        summary: "React to a message with one emoji",
        usage: "botkins chats react <chat> <message-index> <emoji>",
        async run(context) {
          const [chat, at, emoji] = context.args;
          if (context.args.length !== 3 || !/^\d+$/.test(at)) throw usage("Give the chat, zero-based message index and one emoji.");
          context.print(await context.client.call("chats.react", chat, Number(at), emoji), (result) => "Reacted " + result.emoji);
        },
      },
      fork: {
        summary: "Make a new chat that holds this one up to a message",
        usage: "botkins chats fork <chat> [--at <number>] [--in-main]",
        options: { "in-main": { type: "boolean", about: "Make this the active fork in the same Main chat" }, at: { type: "string", value: "number", about: "The message to fork from, counted from 0 as `botkins chat` read counts them. Without it, the last message" } },
        details: "The new chat is of the same bot and starts with the conversation up to that message. A group chat cannot be forked, and a chat that is working must finish first.",
        async run(context) {
          const at = context.options.at;
          if (at !== undefined && !/^\d+$/.test(at)) throw usage("--at is a message's number, from 0.");
          context.print(await context.client.call("chats.fork", one(context, CHAT), at === undefined ? null : Number(at), context.options["in-main"] === true), (chat) => chat.main ? "Switched Main chat to fork " + chat.activeFork + "." : "Made the chat " + named(chat) + " from message " + chat.at + " of " + safe(chat.from) + ".");
        },
      },
      reset: {
        summary: "Start Main chat with fresh context and keep the previous fork",
        usage: "botkins chats reset <chat>",
        async run(context) {
          context.print(await context.client.call("chats.reset", one(context, CHAT)), c => "Reset Main chat context (" + c.id + ").");
        },
      },
      "switch-fork": {
        summary: "Resume a saved fork in the same Main chat (chats show lists its forks)",
        usage: "botkins chats switch-fork <chat> <fork-id>",
        async run(context) {
          if (context.args.length !== 2) throw usage("Give a Main chat and a fork id.");
          context.print(await context.client.call("chats.switchFork", ...context.args), c => "Switched Main chat to fork " + c.activeFork + ".");
        },
      },
      compact: {
        summary: "Summarize a chat's conversation to make room (the runtime's /compact)",
        usage: "botkins chats compact <chat>",
        details: "This starts a turn of the chat's model, as the window's compact button does. The command ends when the turn has started; `botkins chat <bot> --chat <id>` shows how it goes.",
        async run(context) {
          context.print(await context.client.call("chats.compact", one(context, CHAT)), (chat) => "Started a turn that compacts " + named(chat) + ".");
        },
      },
      flags: {
        summary: "Pin, archive or mark a chat as read or unread",
        usage: "botkins chats flags <chat> [--pin | --unpin] [--archive | --unarchive] [--read | --unread]",
        options: {
          pin: { type: "boolean", about: "Pin the chat" },
          unpin: { type: "boolean", about: "Take the pin away" },
          archive: { type: "boolean", about: "Archive the chat" },
          unarchive: { type: "boolean", about: "Bring the chat back from the archive" },
          read: { type: "boolean", about: "Mark the chat as read" },
          unread: { type: "boolean", about: "Mark the chat as unread" },
        },
        async run(context) {
          const o = context.options;
          const patch = {};
          for (const [key, yes, no] of [["pinned", "pin", "unpin"], ["archived", "archive", "unarchive"], ["unread", "unread", "read"]]) {
            if (o[yes] && o[no]) throw usage("Give --" + yes + " or --" + no + ", not both.");
            if (o[yes]) patch[key] = true;
            if (o[no]) patch[key] = false;
          }
          if (!Object.keys(patch).length) throw usage("Say what to set: --pin, --unpin, --archive, --unarchive, --read or --unread.");
          context.print(await context.client.call("chats.flags", one(context, CHAT), patch), (chat) => named(chat) + ": " + (state(chat) || "no flags") + ".");
        },
      },
      read: {
        summary: "Mark one or more chats as read",
        usage: "botkins chats read [<chat>…] [--bot <bot>] [--all]",
        options: {
          bot: { type: "string", value: "bot", about: "Mark every unread chat of this bot as read" },
          all: { type: "boolean", about: "Mark every unread chat as read" },
        },
        async run(context) {
          const { bot, all } = context.options;
          const modes = Number(context.args.length > 0) + Number(bot !== undefined) + Number(!!all);
          if (modes !== 1) throw usage("Give one or more chats, --bot <bot>, or --all.");
          const done = await context.client.call("chats.read", context.args, { ...(bot !== undefined && { bot }), ...(all && { all: true }) });
          context.print(done, (result) => (result.count === 0 ? "No unread chats." : "Marked " + result.count + " chat" + (result.count === 1 ? "" : "s") + " as read."));
        },
      },
      project: {
        summary: "Put a chat in a project, or take it out, and set how it works there",
        usage: "botkins chats project <chat> [<project> | --none] [--folder <path>] [--mode <mode>] [--yes]",
        options: {
          folder: { type: "string", value: "path", about: "A folder in the project" },
          none: { type: "boolean", about: "Take the chat out of its project" },
          mode: { type: "string", value: "mode", about: "default, plan or yolo" },
          ...YOLO_YES,
        },
        details: "A mode applies in a project that has a folder. `plan` makes a plan first. `yolo` gives each request of the bot in this chat a yes with no question, but for a request that leaves the sandbox. So `--mode yolo` shows the chat, the project and its folder first, on standard error, and asks. With no terminal it needs --yes. A chat that is in the mode yolo and stays so (a new project, or the mode given again) asks the same. `default` and `plan` ask nothing. A moved conversation carries its transcript to the new folder. Without a project and without --none, the chat keeps its project and only the mode changes.",
        async run(context) {
          const [ref, to, ...more] = context.args;
          const { none, mode, folder } = context.options;
          if (!ref) throw usage(CHAT);
          if (more.length || (to !== undefined && none)) throw usage("Name one project, or give --none.");
          if (to === undefined && !none && mode === undefined && folder === undefined) throw usage("Name a project, or give --none or --mode.");
          if (mode !== undefined && !["default", "plan", "yolo"].includes(mode)) throw usage("A mode is default, plan or yolo.");
          const chat = await context.client.call("chats.get", ref);
          const asked = { ...(folder && { folder }), ...(to !== undefined && { project: to }), ...(none && { none: true }), ...(mode !== undefined && { mode }) };
          // The mode that results decides (a chat in yolo that moves to another project stays in yolo).
          const look = await context.client.call("chats.projectLook", chat.id, asked);
          let agreed = false;
          if (look.mode === "yolo") {
            context.stderr.write(yoloText(look) + "\n");
            if (!(await confirm(context, "Give this chat the mode yolo?"))) return EXIT.failed;
            agreed = true;
          }
          // (By the ids that were shown, so that a name that matches another project later is not the one that is used.)
          const target = none ? { none: true } : to !== undefined ? { project: look.projectId } : {};
          context.print(await context.client.call("chats.project", chat.id, { ...target, ...(folder && { folder }), ...(mode !== undefined && { mode }), ...(agreed && { agreed: true }) }), (done) => named(done) + (done.project ? " is in the project " + JSON.stringify(safe(done.project)) + " (" + done.mode + ")." : " is in no project (" + done.mode + ")."));
        },
      },
      group: {
        summary: "Start a group chat of 2 to 6 bots",
        usage: "botkins chats group <bot> <bot> [<bot>…] [--title <text>]",
        options: { title: { type: "string", value: "text", about: "The chat's title. Without it, the bots' names" } },
        details: "Each bot is named once, by its name or id. Everyone answers in turn, or only the bots that a message names with @. A group chat takes text only. Then talk in it with `botkins chat <bot> --chat <id>`.",
        async run(context) {
          if (context.args.length < 2 || context.args.length > 6) throw usage("Name 2 to 6 bots.");
          context.print(await context.client.call("chats.group", context.args, ...(context.options.title !== undefined ? [context.options.title] : [])), (chat) => "Made the group chat " + named(chat) + ".");
        },
      },
      retry: {
        summary: "Send the message of a stopped or failed turn again",
        usage: "botkins chats retry <chat>",
        details: "This starts a turn of the chat's model, with the same message as before: the chat's latest turn. `botkins chats show <chat> --json` names that turn (`latestTurn`). A chat that is working is refused.",
        async run(context) {
          context.print(await context.client.call("chats.retry", one(context, CHAT)), (done) => "Sent the message of " + named(done) + " again.");
        },
      },
      queue: {
        summary: "List the messages that wait for a chat to be free",
        usage: "botkins chats queue <chat>",
        async run(context) {
          context.print(await context.client.call("chats.queue", one(context, CHAT)), (list) => (list.length ? table(["#", "MESSAGE", "ID"], list.map((item) => [item.position, safe(item.text.replace(/\s+/g, " ").slice(0, 70)), item.id])) : "No message waits in this chat."));
        },
      },
      unqueue: {
        summary: "Take a waiting message out of the line",
        usage: "botkins chats unqueue <chat> <message>",
        details: "Name the message by its number or its id (`botkins chats queue`).",
        async run(context) {
          if (context.args.length !== 2) throw usage(CHAT + " Then name the message by its number or id.");
          context.print(await context.client.call("chats.unqueue", ...context.args), (done) => "Took the message out of the line of " + named(done) + ".");
        },
      },
      "stop-helper": {
        summary: "Stop one helper or background command of a turn that works",
        usage: "botkins chats stop-helper <chat> [<id>]",
        details: "The turn goes on: only that helper or command stops. With no id, this lists the helpers and background commands of the chat's turn that work now, and which of them the chat's model can stop on its own (Claude Code and GitHub Copilot can, the others stop only with the whole turn: Ctrl-C in `botkins chat`). A helper's id is the id of the step that started it.",
        async run(context) {
          const [ref, id, ...more] = context.args;
          if (!ref || more.length) throw usage(CHAT + " Then name the helper or command by its id, or leave it out to list them.");
          if (id === undefined) {
            context.print(await context.client.call("chats.helpers", ref), (list) => (list.length ? table(["ID", "KIND", "STOPPABLE", "NAME"], list.map((item) => [item.id, item.kind, item.stoppable ? "yes" : "no", safe(item.name)])) : "No helper or background command works in this chat."));
            return;
          }
          context.print(await context.client.call("chats.stopHelper", ref, id), (done) => "Stopped " + safe(String(done.item).slice(0, 80)) + " in " + named(done) + ".");
        },
      },
      "send-now": {
        summary: "Send a waiting message now",
        usage: "botkins chats send-now <chat> <message>",
        details: "This moves the message to the front. When the chat works, the message goes into the turn that runs, if the model takes it, and otherwise it is the next turn: a turn of the chat's model. Name the message by its number or its id (`botkins chats queue`).",
        async run(context) {
          if (context.args.length !== 2) throw usage(CHAT + " Then name the message by its number or id.");
          context.print(await context.client.call("chats.sendNow", ...context.args), (done) => "Sent the message of " + named(done) + " now.");
        },
      },
      mentions: {
        summary: "List what a message in a chat can mention with @ and #",
        usage: "botkins chats mentions [<chat>] [--bot <bot>]",
        options: { bot: { type: "string", value: "bot", about: "For a chat not made yet: the bot it will be with" } },
        details: "Projects, wiki pages and files that the chat's bots may use, and the bots of a group chat. A file is shown by its full path.",
        async run(context) {
          const [ref, ...more] = context.args;
          const { bot } = context.options;
          if (more.length || (ref === undefined) === (bot === undefined)) throw usage("Name a chat, or give --bot <bot>, not both.");
          const found = await context.client.call("chats.mentions", ref ?? null, bot ?? null);
          context.print(found, (list) =>
            [
              list.projects.length ? "Projects:\n" + list.projects.map((item) => "  " + safe(item.name) + (item.hint ? " (" + safe(item.hint) + ")" : "") + (item.current ? " (this chat's)" : "")).join("\n") : null,
              list.wiki.length ? "Wiki pages:\n" + list.wiki.map((item) => "  " + safe(item.title) + "   " + safe(item.path)).join("\n") : null,
              list.files.length ? "Files:\n" + list.files.map((item) => "  " + safe(item.path)).join("\n") : null,
              list.bots.length ? "Bots:\n" + list.bots.map((item) => "  @" + safe(item.name)).join("\n") : null,
            ]
              .filter(Boolean)
              .join("\n\n") || "Nothing can be mentioned.",
          );
        },
      },
      aside: {
        summary: "Ask a side question: the chat's model answers it, and the chat does not keep it",
        usage: "botkins chats aside <chat> [<question>…] [--file <path>]",
        options: { file: { type: "string", value: "path", about: "Read the question from this file (\"-\" reads standard input)" } },
        details: "This starts a turn of the chat's model that reads the conversation, as /btw does on the phone. The question and the answer are not added to the chat. A long question comes from --file, or from standard input: give `-` as the question.",
        async run(context) {
          const [ref, ...words] = context.args;
          if (!ref) throw usage(CHAT + " Then give the question.");
          const question = (await textFrom(context, words, { what: "question", file: context.options.file })).trim();
          if (!question) throw usage("Give the question as words, with `-` for standard input, or with --file <path>.");
          context.print(await context.client.call("chats.aside", ref, question), (done) => safe(done.answer));
        },
      },
      sections,
    },
  },
};
