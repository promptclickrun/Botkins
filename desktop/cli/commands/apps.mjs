// Marketplace › Apps: the commands (cli/commands/index.mjs adds them).
// The apps of the person's own Composio account, through this computer's Composio tool and its sign-in
// (desktop/composio.mjs, desktop/terminal/control-apps.mjs). Signing in to Composio is the tool's own
// sign-in: Sign in with Composio in the app's window, or from a terminal SIGN_IN below.
import { CliError, EXIT, table, usage } from "../output.mjs";
import { safe } from "./tools.mjs";
import { confirm } from "./input.mjs";

const SIGN_IN = "Add the Composio tool and sign it in: `botkins tools add composio --url https://connect.composio.dev/mcp`, then `botkins tools sign-in composio`. Or Sign in with Composio in Marketplace › Apps of the app's window.";
const STATUS = { active: "connected", pending: "waiting", failed: "needs sign-in", other: "other" };
const accountLine = (account) => "  " + safe(account.id) + "   " + STATUS[account.status] + (account.label ? "   " + safe(account.label) : "");
const isActive = (account) => account.status === "active";
const sleep = (ms, wake) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  wake.then(() => {
    clearTimeout(timer);
    resolve();
  });
});

/** Waits until the app has an active account it did not have before: every 3 s for two minutes, then every 10 s, for ten minutes at most. */
async function waitForAccount(context, started, known) {
  let stop = () => {};
  const stopped = new Promise((resolve) => (stop = resolve));
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    stop();
  };
  process.once("SIGINT", cancel);
  const since = Date.now();
  try {
    while (!cancelled && Date.now() - since < 10 * 60_000) {
      await sleep(Date.now() - since < 120_000 ? 3000 : 10_000, stopped);
      if (cancelled) break;
      let accounts;
      try {
        accounts = (await context.client.call("apps.accounts", [started.slug]))[started.slug]?.accounts;
      } catch (error) {
        context.note(safe(error.message));
        continue;
      }
      const fresh = accounts?.find((account) => isActive(account) && !known.has(account.id));
      if (fresh) return fresh;
    }
  } finally {
    process.off("SIGINT", cancel);
  }
  // Abandoned: the waiting account is taken away, so tries don't pile up in Composio.
  if (started.pendingId) await context.client.call("apps.remove", started.slug, started.pendingId).catch(() => {});
  return null;
}

const CARD_WORDS = { connected: "is connected. The chat goes on.", needed: "isn't connected yet.", failed: "wasn't connected.", expired: "wasn't connected: the page expired.", sign_in: "can't be connected until Composio is signed in.", unavailable: "can't be connected: this chat's bot can't use Composio." };

/** `apps connect <app> --chat <chat>`: presses Connect on the chat's card, and with --wait follows it until it settles. */
async function connectCard(context) {
  const chat = context.options.chat;
  const started = await context.client.call("apps.connect", context.args[0], { chat });
  const name = safe(started.name);
  if (!started.page || !context.options.wait) {
    return void context.print(started, (view) => (view.page ? "Open this page to connect " + name + ":\n  " + safe(view.page) + "\n\n`botkins apps connect " + view.slug + " --chat " + view.chat + " --wait` waits for it." : name + " " + (CARD_WORDS[view.status] ?? "is waiting.") + (view.note ? " " + safe(view.note) : "")));
  }
  if (context.json) context.line({ slug: started.slug, name: started.name, chat: started.chat, card: started.card, page: started.page }, "");
  else context.stdout.write("Open this page to connect " + name + ":\n  " + safe(started.page) + "\n\nWaiting for " + name + "…\n");
  let stop = () => {};
  const stopped = new Promise((resolve) => (stop = resolve));
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    stop();
  };
  process.once("SIGINT", cancel);
  let view = started;
  try {
    const since = Date.now();
    while (view.status === "waiting" && Date.now() - since < 10 * 60_000) {
      await sleep(Date.now() - since < 120_000 ? 3000 : 10_000, stopped);
      if (cancelled) break;
      try {
        view = await context.client.call("apps.card", started.slug, chat);
      } catch (error) {
        context.note(safe(error.message));
      }
    }
  } finally {
    process.off("SIGINT", cancel);
  }
  if (view.status !== "connected") throw new CliError(name + " " + (CARD_WORDS[view.status] ?? "wasn't connected.") + (view.note ? " " + safe(view.note) : ""), EXIT.failed, "NOT_CONNECTED");
  if (context.json) context.line({ slug: view.slug, chat: view.chat, card: view.card, status: view.status }, "");
  else context.stdout.write(name + " " + CARD_WORDS.connected + "\n");
}

const appsGroup = {
  summary: "The apps of your Composio account: list them, see their accounts, connect and remove one",
  commands: {
    list: {
      summary: "List the apps that Composio connects, most used first",
      usage: "botkins apps list [<search>] [--category <id>] [--limit <n>] [--categories]",
      arguments: [{ name: "search", required: false }],
      options: {
        category: { type: "string", value: "id", about: "Only the apps of one category (`--categories` lists them)" },
        limit: { type: "string", value: "n", about: "How many apps to show (40 without it)" },
        categories: { type: "boolean", about: "List the categories with how many apps each has, instead of the apps" },
      },
      details: "The list is Composio's public one, kept on this computer and checked again at most once an hour. It needs no sign-in.",
      async run(context) {
        if (context.args.length > 1) throw usage("Give one search at most. Put a search of several words in quotes.");
        const found = await context.client.call("apps.list", { query: context.args[0], category: context.options.category, limit: context.options.limit });
        if (context.options.categories) return void context.print(found.categories, (list) => table(["CATEGORY", "NAME", "APPS"], list.map((entry) => [safe(entry.id), safe(entry.name), String(entry.count)])));
        context.print(found, (view) =>
          view.apps.length
            ? table(["APP", "NAME", "ABOUT"], view.apps.map((kit) => [kit.slug, safe(kit.name), safe(kit.noAuth ? "No sign-in needed. " + kit.description : kit.description).slice(0, 70)])) + (view.total > view.apps.length ? "\n" + view.apps.length + " of " + view.total + ". --limit shows more." : "")
            : "No apps match.",
        );
      },
    },
    connected: {
      summary: "List the apps that have a connected account",
      usage: "botkins apps connected",
      details: "Needs the computer's Composio tool, signed in. " + SIGN_IN,
      async run(context) {
        const found = await context.client.call("apps.connected");
        context.print(found, (view) =>
          !view.known ? "Composio didn't say which apps are connected. Ask about one with `botkins apps accounts <app>`." : view.apps.length ? table(["APP", "NAME", "ACCOUNTS"], view.apps.map((kit) => [kit.slug, safe(kit.name), String(kit.accounts.filter(isActive).length || "?")])) : "Nothing connected yet.",
        );
      },
    },
    accounts: {
      summary: "Show the accounts of one app or more",
      usage: "botkins apps accounts <app>…",
      arguments: [{ name: "app", required: true, many: true }],
      details: "An app is named by its slug or its name (`botkins apps list`). The id of an account is what `botkins apps remove` takes.",
      async run(context) {
        if (!context.args.length) throw usage("Give one app or more (see `botkins apps list`).");
        const found = await context.client.call("apps.accounts", context.args);
        context.print(found, (view) =>
          Object.entries(view)
            .map(([slug, entry]) => safe(entry.name) + " (" + slug + ")\n" + (entry.accounts.length ? entry.accounts.map(accountLine).join("\n") : "  No accounts."))
            .join("\n\n"),
        );
      },
    },
    connect: {
      summary: "Start connecting an app: print the page to sign in on",
      usage: "botkins apps connect <app> [--wait] [--chat <chat>]",
      arguments: [{ name: "app", required: true }],
      options: {
        wait: { type: "boolean", about: "Wait until the new account is connected (ten minutes at most; Ctrl-C stops)" },
        chat: { type: "string", value: "chat", about: "Press Connect on the card a bot showed in this chat (`botkins chat list` gives its id); the chat goes on once the app is connected" },
      },
      details: SIGN_IN + "\n\nOpen the page in a browser, on any computer, and sign in to the app there. With --wait the command ends when the new account is connected, and an account that was never finished is taken away again.\n\nWith --chat it is the chat's Connect card: the window, a phone and this command share one page, and the card shows how it stands.",
      async run(context) {
        if (context.args.length !== 1) throw usage("Give the app to connect (see `botkins apps list`).");
        if (context.options.chat !== undefined) return connectCard(context);
        const before = context.options.wait ? Object.values(await context.client.call("apps.accounts", [context.args[0]]))[0]?.accounts ?? [] : [];
        const known = new Set(before.filter(isActive).map((account) => account.id));
        const started = await context.client.call("apps.connect", context.args[0]);
        const name = safe(started.name);
        if (!started.page) {
          const fresh = started.accounts.find((account) => isActive(account) && !known.has(account.id));
          if (!fresh) throw new CliError("Composio couldn't start connecting " + name + ".", EXIT.failed, "NOT_STARTED");
          return void context.print({ ...started, connected: fresh }, () => name + " is connected.");
        }
        if (!context.options.wait) return void context.print(started, () => "Open this page to connect " + name + ":\n  " + safe(started.page) + "\n\n`botkins apps accounts " + started.slug + "` shows the account once it is connected.");
        if (context.json) context.line({ slug: started.slug, name: started.name, page: started.page, ...(started.pendingId && { pendingId: started.pendingId }) }, "");
        else context.stdout.write("Open this page to connect " + name + ":\n  " + safe(started.page) + "\n\nWaiting for " + name + "…\n");
        const fresh = await waitForAccount(context, started, known);
        if (!fresh) throw new CliError(name + " wasn't connected.", EXIT.failed, "NOT_CONNECTED");
        if (context.json) context.line({ slug: started.slug, connected: fresh }, "");
        else context.stdout.write(name + " is connected" + (fresh.label ? " as " + safe(fresh.label) : "") + ".\n");
      },
    },
    remove: {
      summary: "Remove an account of an app from your Composio account",
      usage: "botkins apps remove <app> <account> [--yes]",
      arguments: [{ name: "app", required: true }, { name: "account", required: true }],
      options: { yes: { type: "boolean", about: "Don't ask first" } },
      details: "`botkins apps accounts <app>` lists the accounts with their ids. Bots stop using that account. It asks first; with no terminal it needs --yes.",
      async run(context) {
        if (context.args.length !== 2) throw usage("Give the app and the account's id (`botkins apps accounts <app>` lists them).");
        if (!(await confirm(context, "Remove this account of " + safe(context.args[0]) + " from your Composio account?"))) return EXIT.failed;
        const done = await context.client.call("apps.remove", context.args[0], context.args[1]);
        context.print(done, () => "Removed the " + safe(done.name) + " account.");
      },
    },
  },
};

export const appsCommands = { apps: appsGroup };
