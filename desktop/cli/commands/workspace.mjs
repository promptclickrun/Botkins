// The workspace from a terminal: bots, model providers, models, a chat, routines and plugins.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CliError, EXIT, table, usage } from "../output.mjs";
import { shownText } from "../../desktop/shown-text.mjs";
import { ask, confirm, edit, secret } from "./input.mjs";
// (A word of a command that is printed for someone to run is quoted for a shell.)
import { shellWord } from "./tools.mjs";

const modelOf = (bot) => (bot.model ? (bot.model.provider ? bot.model.provider + "/" : "") + bot.model.model : "default");
const fileText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The file " + path + " can't be read: " + error.message);
  }
};
/** A bot's fields from --name, --role, --instructions, --instructions-file and --model. */
function botFields(options) {
  if (options.instructions !== undefined && options["instructions-file"] !== undefined) throw usage("Give --instructions or --instructions-file, not both.");
  return {
    ...(options.name !== undefined && { name: options.name }),
    ...(options.role !== undefined && { role: options.role }),
    ...(options.instructions !== undefined && { instructions: options.instructions }),
    ...(options["instructions-file"] !== undefined && { instructions: fileText(options["instructions-file"]) }),
    ...(options.model !== undefined && { model: options.model }),
  };
}
const BOT_OPTIONS = {
  role: { type: "string", value: "text", about: "What the bot is, in a few words (\"Research partner\")" },
  instructions: { type: "string", value: "text", about: "How the bot should work" },
  "instructions-file": { type: "string", value: "path", about: "The same, from a file" },
  model: { type: "string", value: "provider/model", about: "Its model, as `botkins models` names it (\"\" for the default)" },
};

/**
 * Sends one message and shows the reply as it comes. Returns { reply, status }.
 * A bot that asks for an approval or an answer is answered at the terminal, or refused when there is none.
 */
async function turn(context, chatId, message, { live }) {
  const { client, stdout, color } = context;
  const sent = await client.call("chat.send", chatId, message);
  let printed = "";
  let seen;
  let answered = new Set();
  const show = (text) => {
    if (!live) return;
    // A reply can hold several messages (a line before a tool call, another after): the live text starts over.
    if (!text.startsWith(printed)) {
      if (printed && !printed.endsWith("\n")) stdout.write("\n");
      printed = "";
    }
    stdout.write(text.slice(printed.length));
    printed = text;
  };
  for (;;) {
    const view = await client.call("chat.read", chatId, { after: sent.after + 1, wait: seen !== undefined, seen });
    seen = view.seen;
    if (view.working && view.stream) show(view.stream);
    if (view.request && !answered.has(view.request.id)) {
      answered.add(view.request.id);
      const { request } = view;
      if (live && printed && !printed.endsWith("\n")) stdout.write("\n");
      printed = "";
      let answer;
      if (!context.stdin.isTTY || context.json) {
        // Nobody to ask: an approval is refused, a question is left unanswered.
        answer = { action: request.kind === "permission" ? "deny" : "cancel" };
        context.note("The bot asked: " + request.title + " (" + (request.kind === "permission" ? "refused" : "left unanswered") + ": there is no terminal to ask at).");
      } else if (request.kind === "permission") {
        answer = { action: /^y(es)?$/i.test((await ask(context, color.yellow("Approve? ") + request.title + " [y/N] ")).trim()) ? "approve" : "deny" };
      } else {
        const value = (await ask(context, color.yellow(request.title) + "\n> ")).trim();
        answer = value ? { action: "answer", value } : { action: "cancel" };
      }
      await client.call("chat.respond", request.id, answer).catch((error) => context.note(error.message));
      continue;
    }
    if (!view.working) {
      const replies = view.messages.filter((entry) => entry.role === "assistant" && entry.text);
      const reply = replies.map((entry) => entry.text).join("\n\n");
      const status = view.run?.status ?? "Completed";
      if (live) {
        const last = replies.at(-1)?.text ?? "";
        // What streamed is the reply already; anything else (a reply that never streamed) is shown now.
        if (last && last.trim() !== printed.trim()) stdout.write((printed && !printed.endsWith("\n") ? "\n" : "") + last);
        stdout.write("\n");
        if (status !== "Completed") context.note(color.red(status + (view.run?.detail ? ": " + view.run.detail : "")));
      }
      return { reply, status, ...(view.run?.detail && status !== "Completed" && { detail: view.run.detail }) };
    }
  }
}

/**
 * Follows a sign-in the service runs, passing what it says to the terminal and what is typed back.
 * `calls` names the service's calls for it: a provider's, or a tool's (`tools.signIn`). What it
 * says can be a sign-in server's own words, so each is written as `shownText` writes it. A line
 * that holds a code (a prompt with `secret`) is asked for without showing it.
 * `intro` is a line that says what the sign-in is for, before the page is shown (safe text), or a function of the
 * page's event that gives it (a tool's line names the page's host).
 * A line that the service turns away is explained and the same question is asked again.
 * Ctrl-C, a hang-up and the close of the terminal's input end the sign-in.
 *
 * While a question is open the session is still read. The sign-in can end another way (the
 * browser was on this computer and answered by itself, or it was ended from elsewhere): the
 * question is then closed, what was typed so far is dropped, and the command ends with the
 * session's own result.
 */
export async function followSignIn(context, session, calls = "providers.login", { intro } = {}) {
  const { client, color } = context;
  const cancel = () => void client.call(calls + ".cancel", session).catch(() => {});
  process.once("SIGINT", cancel);
  // A hang-up of the terminal ends the sign-in as Ctrl-C does: it is not left to wait for nobody. So does the
  // close of the terminal's own input.
  process.once("SIGHUP", cancel);
  const closed = context.stdin.isTTY && typeof context.stdin.once === "function";
  if (closed) context.stdin.once("close", cancel);
  // Standard input, a line at a time, for a run with no terminal.
  let lines = null;
  let reader = null;
  const piped = async () => {
    if (!lines) {
      reader = createInterface({ input: context.stdin });
      lines = reader[Symbol.asyncIterator]();
    }
    const next = await lines.next();
    return next.done ? null : next.value;
  };
  // One read of the session is out at a time: what it brings is never lost, whoever waits for it.
  let after = 0;
  let reading = null;
  const poll = () =>
    (reading ??= client.call(calls + ".read", session, after).then(
      (view) => {
        reading = null;
        // (An event is shown once, whatever the service sends.)
        const events = view.events.filter((event) => !(event.n <= after));
        after = Math.max(after, view.next ?? 0);
        return { ...view, events };
      },
      (error) => {
        reading = null;
        throw error;
      },
    ));
  const show = (event) => {
    if (context.json) context.stdout.write(JSON.stringify(event) + "\n");
    else if (event.type === "code") context.stdout.write("\nOpen this page on any device:\n\n    " + color.bold(shownText(event.url)) + "\n\nand enter the code:\n\n    " + color.bold(shownText(event.code)) + "\n\nWaiting for you to finish there…\n");
    else if (event.type === "open") context.stdout.write("\n" + (intro ? (typeof intro === "function" ? intro(event) : intro) + "\n" : "") + "Open this page on any device to sign in:\n\n    " + color.bold(shownText(event.url)) + "\n\n");
    else if (event.type === "output") context.stdout.write(color.dim("  " + shownText(event.text)) + "\n");
  };
  try {
    let view = await poll();
    for (;;) {
      const queue = [...view.events];
      let ended = view.done ? view : null;
      while (queue.length) {
        const event = queue.shift();
        show(event);
        // (A question of a sign-in that is over is not asked.)
        if (event.type !== "prompt" || ended) continue;
        // At a terminal the person is asked. In a script the next line of standard input is the
        // answer, and a script with no more lines can't finish this sign-in.
        const closing = new AbortController();
        const typed = (context.stdin.isTTY && !context.json ? ask(context, (event.text ? shownText(event.text) + "\n" : "") + "> ", { hidden: event.secret === true, signal: closing.signal }) : piped()).then((line) => ({ line }));
        let line;
        let answered = false;
        // The question is open, and the session is read at the same time.
        while (!answered && !ended) {
          const got = await Promise.race([typed, poll().then((now) => ({ now }))]);
          if (!got.now) {
            answered = true;
            line = got.line;
            continue;
          }
          for (const more of got.now.events) {
            if (more.type === "prompt") queue.push(more);
            else show(more);
          }
          // Nothing new, and not over: the service waits for the next event, and so does this (the question gets its turn).
          if (!got.now.events.length && !got.now.done) await new Promise((resolve) => setImmediate(resolve));
          if (got.now.done) {
            ended = got.now;
            closing.abort();
          }
        }
        if (ended) continue;
        if (line === null) {
          cancel();
          throw new CliError("This sign-in asks for something to be typed, and there is nothing more on standard input. Run it at a terminal, or sign in with --token.", EXIT.failed, "NEEDS_INPUT");
        }
        // A line that is turned away is explained, and the same question is asked again: nothing else would ask it.
        const refused = await client.call(calls + ".input", session, line).then(() => false, (error) => (context.note(shownText(error.message)), true));
        if (refused) queue.unshift(event);
      }
      if (ended) {
        if (ended.error) throw new CliError(shownText(ended.error), EXIT.failed, "SIGN_IN_FAILED");
        return ended.result;
      }
      view = await poll();
    }
  } catch (error) {
    // A person who stops at a question (Ctrl-C) ends the sign-in too: it is not left open with nobody to answer it.
    if (error?.code === "CANCELLED") cancel();
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGHUP", cancel);
    if (closed) context.stdin.off("close", cancel);
    reader?.close();
  }
}

export const workspace = {
  bots: {
    summary: "List, add, change and remove bots",
    commands: {
      list: {
        summary: "List the bots",
        usage: "botkins bots list",
        async run(context) {
          context.print(await context.client.call("bots.list"), (bots) => (bots.length ? table(["NAME", "ROLE", "MODEL", "CHATS", "ID"], bots.map((bot) => [bot.name + (bot.working ? " (working)" : ""), bot.role, modelOf(bot), bot.chats, bot.id])) : "There are no bots yet. Add one with `botkins bots add <name>`."));
        },
      },
      add: {
        summary: "Add a bot",
        usage: "botkins bots add <name> [--role <text>] [--instructions <text> | --instructions-file <path>] [--model <provider/model>]",
        options: BOT_OPTIONS,
        async run(context) {
          if (context.args.length !== 1) throw usage("Give the bot a name.");
          context.print(await context.client.call("bots.add", { name: context.args[0], ...botFields(context.options) }), (bot) => "Added " + bot.name + " (" + bot.role + "). Talk to it with `botkins chat " + shellWord(bot.name, "<the bot>") + "`.");
        },
      },
      edit: {
        summary: "Change a bot",
        usage: "botkins bots edit <bot> [--name <text>] [--role <text>] [--instructions <text> | --instructions-file <path>] [--model <provider/model>]",
        options: { name: { type: "string", value: "text", about: "A new name" }, ...BOT_OPTIONS },
        details: "With no option, the bot opens in your editor ($VISUAL, $EDITOR, else vi) as JSON: change its name, role, instructions or model and save.",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the bot (its name or id).");
          let fields = botFields(context.options);
          if (!Object.keys(fields).length) {
            if (!context.stdin.isTTY || context.json) throw usage("Say what to change: --name, --role, --instructions, --instructions-file or --model.");
            const bot = await context.client.call("bots.get", context.args[0]);
            const before = { name: bot.name, role: bot.role, instructions: bot.instructions, model: bot.model ? modelOf(bot) : "" };
            let after;
            try {
              after = JSON.parse(edit(context, JSON.stringify(before, null, 2) + "\n", "bot.json"));
            } catch (error) {
              throw new CliError("What was saved is not JSON (" + error.message + "), so the bot was not changed.");
            }
            fields = Object.fromEntries(Object.keys(before).filter((key) => after?.[key] !== undefined && after[key] !== before[key]).map((key) => [key, after[key]]));
            if (!Object.keys(fields).length) return void context.note("Nothing changed.");
          }
          context.print(await context.client.call("bots.edit", context.args[0], fields), (bot) => "Saved " + bot.name + ".");
        },
      },
      remove: {
        summary: "Remove a bot and its chats",
        usage: "botkins bots remove <bot> [--yes]",
        options: { yes: { type: "boolean", short: "y", about: "Don't ask first" } },
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the bot (its name or id).");
          if (!(await confirm(context, "Remove " + context.args[0] + " with its chats, routines and memory?"))) return EXIT.failed;
          context.print(await context.client.call("bots.remove", context.args[0]), (gone) => "Removed " + gone.name + ".");
        },
      },
    },
  },
  providers: {
    summary: "List model providers, and sign them in and out",
    details: "A provider is where a bot's model runs: GitHub Copilot, Codex (ChatGPT), Claude Code, OpenCode, or an agent that speaks ACP. Each signs in to your own account; no browser is needed on this host.",
    commands: {
      list: {
        summary: "List the providers and whether each is signed in",
        usage: "botkins providers list [--refresh]",
        options: { refresh: { type: "boolean", about: "Ask each provider again instead of using what was learned a moment ago" } },
        async run(context) {
          context.print(await context.client.call("providers.list", context.options.refresh === true), (list) =>
            table(["ID", "NAME", "STATE", "ACCOUNT", "NOTE"], list.map((entry) => [entry.id, entry.name, !entry.enabled ? "off" : !entry.installed ? "not installed" : entry.connected ? "signed in" : entry.error ? "error" : "signed out", [entry.account, entry.plan].filter(Boolean).join(", "), entry.error ?? (entry.connected ? (entry.token ?? "") : entry.message ?? "")])),
          );
        },
      },
      login: {
        summary: "Sign a provider in",
        usage: "botkins providers login <provider> [--token] [--service <id>] [--method <id>]",
        options: {
          token: { type: "boolean", about: "Paste a token or key instead: typed without showing, or read from standard input" },
          service: { type: "string", value: "id", about: "OpenCode: the model service to connect (see `botkins providers services opencode`)" },
          method: { type: "string", value: "id", about: "OpenCode: which of the service's sign-ins to use" },
        },
        details: [
          "Without --token, the provider's own sign-in runs on this host and tells you what to do on another device:",
          "  copilot   a one-time code to type at github.com/login/device",
          "  codex     a one-time code (Codex's device sign-in)",
          "  claude    Claude Code's own sign-in: a page to open, and a code to paste back",
          "  opencode  the service's page, and a code to paste back when it gives one",
          "",
          "With --token, a token or key made elsewhere is used:",
          "  copilot   a GitHub token that may use Copilot (for example from `gh auth token`)",
          "  codex     an OpenAI API key (sk-…) or a ChatGPT access token",
          "  claude    the token `claude setup-token` prints on any computer with a browser, or an Anthropic API key",
          "  opencode  the service's API key (with --service)",
          "The token is never taken from the command line, where other users could see it: pipe it in, or type it at the prompt.",
        ].join("\n"),
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the provider (see `botkins providers list`).");
          const [id] = context.args;
          const { service, method } = context.options;
          if (context.options.token) {
            const token = await secret(context, "Token or key for " + id + " (not shown): ");
            const result = await context.client.call("providers.login", id, { token, service });
            return void context.print(result, "Signed in" + (result.account ? " as " + result.account : "") + (result.plan ? " (" + result.plan + ")" : "") + ".");
          }
          const started = await context.client.call("providers.login", id, { service, method });
          const result = await followSignIn(context, started.session);
          context.print({ done: true, ...result }, "Signed in" + (result?.account ? " as " + result.account : "") + (result?.plan ? " (" + result.plan + ")" : "") + ".");
        },
      },
      logout: {
        summary: "Sign a provider out",
        usage: "botkins providers logout <provider>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the provider (see `botkins providers list`).");
          context.print(await context.client.call("providers.logout", context.args[0]), (result) => (result.connected ? "The token Botkins kept is removed, and the provider is still signed in another way (its own sign-in, or this host's environment)." : "Signed out."));
        },
      },
      enable: {
        summary: "Switch a provider on",
        usage: "botkins providers enable <provider>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the provider.");
          context.print(await context.client.call("providers.enable", context.args[0], true), context.args[0] + " is on.");
        },
      },
      disable: {
        summary: "Switch a provider off",
        usage: "botkins providers disable <provider>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the provider.");
          context.print(await context.client.call("providers.enable", context.args[0], false), context.args[0] + " is off.");
        },
      },
      services: {
        summary: "List the model services of a provider that holds several (OpenCode)",
        usage: "botkins providers services <provider> [<search>]",
        async run(context) {
          if (context.args.length < 1) throw usage("Name the provider.");
          context.print(await context.client.call("providers.services", context.args[0], context.args[1] ?? ""), (list) => (list.length ? table(["ID", "NAME", "STATE", "SIGNS IN WITH"], list.map((entry) => [entry.id, entry.name, entry.connected ? "connected" : "", (entry.methods ?? []).map((way) => (way.type === "key" ? "key" : way.id ?? way.label)).join(", ")])) : "No model service matches."));
        },
      },
    },
  },
  models: {
    summary: "List the models the signed-in providers offer",
    usage: "botkins models [--default <provider/model>]",
    options: { default: { type: "string", value: "provider/model", about: "Make this the model a bot uses unless it has its own" } },
    async run(context) {
      if (context.options.default !== undefined) return void context.print(await context.client.call("models.default", context.options.default), (model) => "The default model is " + (model.provider ? model.provider + "/" : "") + model.model + ".");
      context.print(await context.client.call("models"), (models) => (models.length ? table(["MODEL", "NAME", "PROVIDER", ""], models.map((model) => [model.ref, model.name, model.providerName + (model.group ? " › " + model.group : ""), [model.recommended && "recommended", !model.available && "unavailable"].filter(Boolean).join(", ")])) : "No provider is signed in, so there are no models. See `botkins providers list`."));
    },
  },
  chat: {
    summary: "Talk to a bot",
    usage: "botkins chat <bot> [-m <message>] [--chat <id>]",
    options: {
      message: { type: "string", short: "m", value: "text", about: "Send one message, print the reply and return (\"-\" reads it from standard input)" },
      chat: { type: "string", value: "id", about: "Continue this chat instead of starting a new one" },
    },
    details: "Without -m, a prompt opens: type a message and Enter. Ctrl-C stops a reply; Ctrl-D, or /quit, leaves. The chat is an ordinary one: a paired phone shows it too.",
    async run(context) {
      if (context.args.length !== 1) throw usage("Name the bot (its name or id).");
      const { client, color } = context;
      const opened = context.options.chat ? { chatId: context.options.chat, bot: { name: context.args[0] } } : await client.call("chat.open", context.args[0]);
      if (context.options.message !== undefined) {
        const message = context.options.message === "-" ? await new Promise((resolve) => { let text = ""; context.stdin.on("data", (chunk) => (text += chunk)).on("end", () => resolve(text)); }) : context.options.message;
        const result = await turn(context, opened.chatId, message, { live: !context.json });
        if (context.json) context.print({ chatId: opened.chatId, ...result });
        return result.status === "Completed" ? EXIT.ok : EXIT.failed;
      }
      if (!context.stdin.isTTY || context.json) throw usage("A chat needs a terminal. To send one message, use -m.");
      context.note(color.dim("Chat with " + opened.bot.name + " (" + opened.chatId + "). Ctrl-D or /quit leaves."));
      const rl = createInterface({ input: context.stdin, output: context.stdout, terminal: true });
      let working = false;
      rl.on("SIGINT", () => {
        if (working) void client.call("chat.stop", opened.chatId).catch(() => {});
        else rl.close();
      });
      try {
        for (;;) {
          const line = await new Promise((resolve) => {
            rl.question(color.cyan("you> "), resolve);
            rl.once("close", () => resolve(null));
          });
          if (line === null || /^\/(quit|exit)$/i.test(line.trim())) break;
          if (!line.trim()) continue;
          context.stdout.write(color.green(opened.bot.name + "> "));
          working = true;
          rl.pause();
          try {
            await turn(context, opened.chatId, line, { live: true });
          } catch (error) {
            context.note(color.red(error.message));
          } finally {
            working = false;
            rl.resume();
          }
        }
      } finally {
        rl.close();
      }
    },
  },
  routines: {
    summary: "List routines, run one now, and pause or resume one",
    details: "A routine is work a bot does on a schedule. They are made from a paired phone, or by asking a bot in a chat.",
    commands: {
      list: {
        summary: "List the routines",
        usage: "botkins routines list [--bot <bot>]",
        options: { bot: { type: "string", value: "bot", about: "Only this bot's" } },
        async run(context) {
          context.print(await context.client.call("routines.list", context.options.bot), (list) => (list.length ? table(["NAME", "BOT", "WHEN", "STATE", "NEXT RUN", "ID"], list.map((entry) => [entry.name, entry.bot, entry.cadence, entry.running ? "running" : entry.finished ? "finished" : entry.enabled ? "on" : "paused", entry.nextRun ? new Date(entry.nextRun).toLocaleString() : "", entry.id])) : "There are no routines."));
        },
      },
      run: {
        summary: "Run a routine now",
        usage: "botkins routines run <routine>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the routine (its name or id).");
          context.print(await context.client.call("routines.run", context.args[0]), (entry) => entry.name + " is running.");
        },
      },
      pause: {
        summary: "Pause a routine",
        usage: "botkins routines pause <routine>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the routine (its name or id).");
          context.print(await context.client.call("routines.pause", context.args[0]), (entry) => entry.name + " is paused.");
        },
      },
      resume: {
        summary: "Resume a paused routine",
        usage: "botkins routines resume <routine>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the routine (its name or id).");
          context.print(await context.client.call("routines.resume", context.args[0]), (entry) => entry.name + " is on" + (entry.nextRun ? ", next at " + new Date(entry.nextRun).toLocaleString() : "") + ".");
        },
      },
    },
  },
  plugins: {
    summary: "List, install and remove plugins",
    details: "Plugins add skills, agents and tools to bots (desktop/docs/PLUGINS.md). They come from marketplaces: a GitHub repository or a folder.",
    commands: {
      list: {
        summary: "List the installed plugins",
        usage: "botkins plugins list",
        async run(context) {
          context.print(await context.client.call("plugins.list"), (list) => (list.length ? table(["NAME", "VERSION", "STATE", "BOTS", "ID"], list.map((entry) => [shownText(entry.name ?? entry.id), shownText(entry.version ?? ""), entry.enabled === false ? "off" : "on", entry.bots === "all" ? "all" : (entry.bots ?? []).length, shownText(entry.id)])) : "No plugin is installed. See `botkins plugins browse`."));
        },
      },
      marketplaces: {
        summary: "List the marketplaces plugins come from",
        usage: "botkins plugins marketplaces",
        async run(context) {
          context.print(await context.client.call("plugins.marketplaces"), (list) => (list.length ? table(["NAME", "SOURCE", "ID"], list.map((entry) => [shownText(entry.name ?? entry.id), shownText(entry.source ?? entry.url ?? ""), shownText(entry.id)])) : "There are no marketplaces. Add one with `botkins plugins add-marketplace <owner/repo>`."));
        },
      },
      "add-marketplace": {
        summary: "Add a marketplace (owner/repo, a git address or a folder)",
        usage: "botkins plugins add-marketplace <source>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the marketplace: owner/repo, a git address or a folder.");
          context.print(await context.client.call("plugins.addMarketplace", context.args[0]), "Added.");
        },
      },
      "remove-marketplace": {
        summary: "Remove a marketplace",
        usage: "botkins plugins remove-marketplace <id>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the marketplace by its id (see `botkins plugins marketplaces`).");
          context.print(await context.client.call("plugins.removeMarketplace", context.args[0]), "Removed.");
        },
      },
      browse: {
        summary: "Show the plugins the marketplaces offer",
        usage: "botkins plugins browse [<search>]",
        async run(context) {
          const found = await context.client.call("plugins.browse", context.args[0] ? { query: context.args[0] } : {});
          const list = Array.isArray(found) ? found : found?.plugins ?? [];
          context.print(found, list.length ? table(["NAME", "ABOUT", "ID"], // (A marketplace's words are from outside, as a plugin's are.)
          list.map((entry) => [shownText(entry.name ?? entry.id), shownText(String(entry.description ?? "").slice(0, 70)), shownText(entry.id)])) : "Nothing matches.");
        },
      },
      install: {
        summary: "Install a plugin for every bot",
        usage: "botkins plugins install <id>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the plugin by its id (see `botkins plugins browse`).");
          context.print(await context.client.call("plugins.install", context.args[0]), "Installed.");
        },
      },
      update: {
        summary: "Update an installed plugin",
        usage: "botkins plugins update <id>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the plugin by its id (see `botkins plugins list`).");
          context.print(await context.client.call("plugins.update", context.args[0]), "Updated.");
        },
      },
      enable: {
        summary: "Switch an installed plugin on",
        usage: "botkins plugins enable <id>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the plugin by its id.");
          context.print(await context.client.call("plugins.setEnabled", context.args[0], true), "On.");
        },
      },
      disable: {
        summary: "Switch an installed plugin off",
        usage: "botkins plugins disable <id>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the plugin by its id.");
          context.print(await context.client.call("plugins.setEnabled", context.args[0], false), "Off.");
        },
      },
      uninstall: {
        summary: "Remove an installed plugin",
        usage: "botkins plugins uninstall <id> [--yes]",
        options: { yes: { type: "boolean", short: "y", about: "Don't ask first" } },
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the plugin by its id.");
          if (!(await confirm(context, "Remove the plugin " + context.args[0] + "?"))) return EXIT.failed;
          context.print(await context.client.call("plugins.uninstall", context.args[0]), "Removed.");
        },
      },
    },
  },
};
