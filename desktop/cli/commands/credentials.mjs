// Credentials, the vault, password managers and the rest of a provider: the commands (cli/commands/index.mjs adds them).
// `credentialsCommands` maps a top-level word to a group `{ summary, commands }`. A group whose word is there
// already (`bots`, `routines`, `providers`, …) gets these commands added to its own.
//
// What these commands hold to, more than most (desktop/AGENTS.md):
//  - No command prints a secret. A list has names, kinds and where each is read from. A new value comes from a hidden
//    question at a terminal, or from standard input. It is never a word of the command line, an environment variable or
//    an option. It is never in `--json` output, in the log or in an error.
//  - What cannot be undone asks first, and with no terminal it needs `--yes`. What goes is shown first, on standard error, also
//    with `--yes` and with `--json`. The reset of the vault needs one more flag that names what is lost.
//  - The socket cannot know that a person is there, so a saved credential that exists gets a new value from here and nothing
//    else. Another name, website or kind is for the app's window or a paired phone.
//  - The master password of a password manager, its items and its fields are not here: see desktop/terminal/control-credentials.mjs.
import { CliError, EXIT, ago, table, usage } from "../output.mjs";
import { shownText } from "../../desktop/shown-text.mjs";
import { ask, confirm, secret } from "./input.mjs";
import { protonCommands } from "./proton-pass.mjs";

const safe = shownText;
const YES = { yes: { type: "boolean", about: "Do not ask first" } };
const KINDS = ["api-key", "login", "note"];
const NO_VALUE_ON_THE_LINE = "A value is never a word of the command line: it comes from the hidden question, or from standard input.";

const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const kindOf = (value) => {
  if (value !== undefined && !KINDS.includes(value)) throw usage("A credential's kind is one of: " + KINDS.join(", ") + ".");
  return value;
};
/** A new value: typed without showing at a terminal, or read from standard input. Asked for after everything else is checked. */
const value = (context, what) =>
  secret(context, what + " (not shown): ").catch((error) => {
    if (error.code === "USAGE") throw usage("No value was given. Type it at the question, or give it on standard input. " + NO_VALUE_ON_THE_LINE);
    throw error;
  });
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person what is asked. */
const show = (context, line) => void context.stderr.write(line + "\n");

/** One of a list by its id, or by its name when exactly one has it: what the service would pick, found before anything is asked. */
const find = (list, ref, what, see) => {
  const byId = list.find((entry) => entry.id === ref);
  if (byId) return byId;
  const named = list.filter((entry) => String(entry.name).toLowerCase() === ref.toLowerCase());
  if (named.length > 1) throw new CliError("More than one " + what + " is called " + safe(ref) + ". Use its id (see `" + see + "`).");
  if (!named.length) throw new CliError("There is no " + what + " called " + safe(ref) + ". See `" + see + "`.");
  return named[0];
};
/** "2 secret, 1 oauth": how many of each kind. */
const byKind = (entries) => {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.kind || "other", (counts.get(entry.kind || "other") ?? 0) + 1);
  return [...counts].map(([kind, count]) => count + " " + safe(kind)).join(", ");
};

const CREDENTIAL = "Name the saved credential (see `botkins credentials list`).";
const credentials = {
  summary: "Saved credentials: keys, logins and notes that a bot or a tool can use (no value is ever shown)",
  details: "A saved credential is a value that Botkins keeps sealed on this computer. A list shows its name, its kind and where it is read from, never its value. A new value comes from a hidden question or from standard input, never from the command line. The vault (`botkins vault`) holds the keys and sign-ins of tools and providers. A password manager's items and its master password stay in the app's window and on a paired phone.",
  commands: {
    list: {
      summary: "List the saved credentials (names only)",
      usage: "botkins credentials list",
      async run(context) {
        context.print(await context.client.call("credentials.list"), (answer) => {
          const lines = [];
          if (answer.locked) lines.push("The saved credentials are locked on this computer. They are listed, but they cannot be read or changed.", "");
          lines.push(
            answer.entries.length
              ? table(["NAME", "KIND", "KEPT IN", "WEBSITE", "UPDATED", "ID"], answer.entries.map((entry) => [safe(entry.name), entry.kind, entry.source === "vault" ? "Botkins" : safe(entry.reference ?? entry.source), entry.website ? safe(entry.website) : "", ago(entry.updatedAt), entry.id]))
              : "No credential is saved. Add one with `botkins credentials save <name>`.",
          );
          return lines.join("\n");
        });
      },
    },
    save: {
      summary: "Save a new credential: its value comes from a hidden question or standard input",
      usage: "botkins credentials save <name> [--kind <kind>] [--username <text>] [--website <address>] [--notes <text>]",
      options: {
        kind: { type: "string", value: "kind", about: "api-key (the default), login or note" },
        username: { type: "string", value: "text", about: "The user name that goes with it (a login)" },
        website: { type: "string", value: "address", about: "Where it is used" },
        notes: { type: "string", value: "text", about: "A note for you" },
      },
      details: ["The value is typed at a question that does not show it, or read from standard input:", "  printf '%s' \"$TOKEN\" | botkins credentials save \"GitHub token\"", NO_VALUE_ON_THE_LINE].join("\n"),
      async run(context) {
        if (context.args.length !== 1) throw usage("Give the credential a name, as one word or in quotes. " + NO_VALUE_ON_THE_LINE);
        const [name] = context.args;
        const { username, website, notes } = context.options;
        const kind = kindOf(context.options.kind);
        // A name that is taken is found before the value is typed, so that nobody types a value for nothing.
        if ((await context.client.call("credentials.list")).entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) throw usage("A saved credential is called " + safe(name) + " already. Give it a new value with `botkins credentials edit`, or use another name.");
        const text = await value(context, "Value for " + safe(name));
        const saved = await context.client.call("credentials.save", { name, ...(kind && { kind }), ...(username !== undefined && { username }), ...(website !== undefined && { website }), ...(notes !== undefined && { notes }), value: text });
        context.print(saved, "Saved " + safe(saved.name) + " (" + saved.id + "). Its value is kept sealed and is never shown.");
      },
    },
    edit: {
      summary: "Give a saved credential a new value (from a hidden question or standard input)",
      usage: "botkins credentials edit <credential> [--yes]",
      options: YES,
      details: "The new value overwrites the old one, which cannot be got back. That asks first, and with no terminal it needs --yes. The value comes from a hidden question or from standard input, never from the command line. A credential gets another name, website or kind in the app's window or on a paired phone. From here, remove it and save it again.",
      async run(context) {
        const ref = one(context, CREDENTIAL + " " + NO_VALUE_ON_THE_LINE);
        // Asked before the value is typed, so that nobody types a value that is then not used.
        if (!(await confirm(context, "Replace the value of " + safe(ref) + "? The old value is lost and cannot be got back."))) {
          context.note("Not changed.");
          return EXIT.failed;
        }
        const saved = await context.client.call("credentials.edit", ref, { value: await value(context, "New value for " + safe(ref)) }, { agreed: true });
        context.print(saved, "Saved " + safe(saved.name) + ".");
      },
    },
    remove: {
      summary: "Remove a saved credential",
      usage: "botkins credentials remove <credential> [--yes]",
      options: YES,
      async run(context) {
        const ref = one(context, CREDENTIAL);
        const entry = find((await context.client.call("credentials.list")).entries, ref, "saved credential", "botkins credentials list");
        // What goes is shown even with --yes and with --json: it is in the caller's own record. Never a value.
        show(context, "This removes the saved credential " + safe(entry.name) + " (" + safe(entry.kind) + ").\n  Kept in: " + (entry.source === "vault" ? "Botkins, sealed on this computer" : safe(entry.reference ?? entry.source) + " (the value stays there; only the link is removed)") + (entry.website ? "\n  Used at: " + safe(entry.website) : "") + "\nWhat uses it can no longer read it.");
        if (!(await confirm(context, "Remove the saved credential " + safe(entry.name) + "?"))) {
          context.note("Not removed.");
          return EXIT.failed;
        }
        context.print(await context.client.call("credentials.remove", entry.id, { agreed: true }), (gone) => "Removed " + safe(gone.name) + ".");
      },
    },
    grants: {
      summary: "List standing bot credential grants (no values)",
      usage: "botkins credentials grants",
      async run(context) {
        const list = await context.client.call("credentials.grants");
        context.print(list, (grants) =>
          grants.length
            ? table(
                ["BOT", "CREDENTIAL", "DESTINATION", "OPERATION", "LEVEL", "LAST USED", "ID"],
                grants.map((g) => [
                  safe(g.botName || g.botId),
                  safe(g.credentialName || g.credentialId),
                  safe(g.destination),
                  safe(g.operation),
                  safe(g.level),
                  g.lastUsedAt ? ago(g.lastUsedAt) : "never",
                  g.id,
                ]),
              )
            : "No standing credential grants.",
        );
      },
    },
    revoke: {
      summary: "Revoke a standing bot credential grant",
      usage: "botkins credentials revoke <grant-id> [--yes]",
      options: YES,
      async run(context) {
        const id = one(context, "Give the grant id (see `botkins credentials grants`).");
        if (!(await confirm(context, "Revoke credential grant " + safe(id) + "?"))) {
          context.note("Not revoked.");
          return EXIT.failed;
        }
        context.print(await context.client.call("credentials.revokeGrant", id, { agreed: true }), (res) => "Revoked " + safe(res.revoked) + ".");
      },
    },
    audit: {
      summary: "Show recent credential use audit entries (never values)",
      usage: "botkins credentials audit [--limit <n>]",
      options: { limit: { type: "string", value: "n", about: "Maximum entries to show (default 50)" } },
      async run(context) {
        const limit = context.options.limit ? Number(context.options.limit) : 50;
        const rows = await context.client.call("credentials.audit", { limit });
        context.print(rows, (entries) =>
          entries.length
            ? table(
                ["WHEN", "BOT", "CREDENTIAL", "DESTINATION", "OP", "OUTCOME"],
                entries.map((e) => [
                  ago(e.at),
                  safe(e.botName || e.botId),
                  safe(e.credentialName || e.credentialId),
                  safe(e.destination),
                  safe(e.operation),
                  safe(e.outcome),
                ]),
              )
            : "No credential audit entries yet.",
        );
      },
    },
  },
};

const REASONS = {
  "installed-app": "It belongs to the installed app, and this copy of Botkins cannot open it.",
  key: "Its key is not available on this computer.",
  damaged: "The file is damaged.",
};
const VAULT = "Name the vault entry (see `botkins vault list`).";
const vault = {
  summary: "The vault: the keys and sign-ins that tools and providers use (no value is ever shown)",
  details: "Every key, header value and sign-in of a tool, and a token that `botkins providers login --token` kept, lives in the vault, sealed. A list shows what each entry is and what uses it. A value is never shown.",
  commands: {
    list: {
      summary: "List what the vault holds (names only), and whether this computer can open it",
      usage: "botkins vault list",
      async run(context) {
        context.print(await context.client.call("credentials.vault"), (answer) => {
          const lines = ["Protection: " + (answer.protection === "keychain" ? "the key is in the computer's keychain." : "the key is in a file in the data folder."), ""];
          if (answer.locked) lines.push("This computer cannot open the vault. " + (REASONS[answer.reason] ?? "") + " Nothing in it can be read or removed. `botkins vault reset` starts an empty one.", "");
          lines.push(answer.entries.length ? table(["NAME", "KIND", "USED BY", "UPDATED", "ID"], answer.entries.map((entry) => [safe(entry.name), safe(entry.kind), safe(entry.usedBy), ago(entry.updatedAt), entry.id])) : "The vault is empty.");
          return lines.join("\n");
        });
      },
    },
    remove: {
      summary: "Remove one entry from the vault",
      usage: "botkins vault remove <entry> [--yes]",
      options: YES,
      details: "A sign-in is signed out. A key's name stays on its tool, so that you can enter the key again.",
      async run(context) {
        const ref = one(context, VAULT);
        const state = await context.client.call("credentials.vault");
        if (state.locked) throw new CliError("This computer cannot open the vault, so nothing in it can be removed. `botkins vault reset` starts an empty one.");
        const entry = find(state.entries, ref, "vault entry", "botkins vault list");
        // What goes is shown even with --yes and with --json. Never a value.
        show(context, "This removes " + safe(entry.name) + " (" + safe(entry.kind) + ") from the vault" + (entry.usedBy ? ", where " + safe(entry.usedBy) + " uses it" : "") + ".\nWhat uses it stops working until you enter it again. A sign-in is signed out. A key's name stays on its tool.");
        if (!(await confirm(context, "Remove " + safe(entry.name) + " from the vault?"))) {
          context.note("Not removed.");
          return EXIT.failed;
        }
        context.print(await context.client.call("credentials.vaultRemove", entry.id, { agreed: true }), (gone) => "Removed " + safe(gone.name) + " from the vault.");
      },
    },
    reset: {
      summary: "Start an empty vault, when this computer cannot open the one it has",
      usage: "botkins vault reset [--yes] [--erase-all-saved-secrets]",
      options: { ...YES, "erase-all-saved-secrets": { type: "boolean", about: "Says that you know what is lost: with --yes, this is needed to reset the vault" } },
      asks: "--yes --erase-all-saved-secrets",
      details: "Only a vault that this computer cannot open can be reset. The old file is set aside, renamed vault.unreadable-<time>.json in the data folder, and not deleted. Botkins cannot read it, so every key and sign-in that it holds is lost to Botkins and has to be entered again. Saved credentials (`botkins credentials`) are not part of the vault.",
      async run(context) {
        if (context.args.length) throw usage("`botkins vault reset` takes no word.");
        const { yes, "erase-all-saved-secrets": erase } = context.options;
        const state = await context.client.call("credentials.vault");
        if (!state.locked) throw new CliError("The vault opens on this computer, so it does not need a reset. Nothing was changed.");
        const lost = "This computer cannot open the vault. " + (REASONS[state.reason] ?? "") + " If you reset it, every key and sign-in that it holds (" + state.entries.length + " now" + (state.entries.length ? ": " + byKind(state.entries) : "") + ") is lost to Botkins, and each one has to be entered again. The old file is set aside and not deleted. Saved credentials (`botkins credentials`) are kept apart and stay.";
        show(context, lost);
        if (yes && !erase) throw usage("--yes is not enough to reset the vault. It loses every key and sign-in in it. Run it again with --yes --erase-all-saved-secrets.");
        if (!yes) {
          if (!context.stdin.isTTY || context.json) throw usage("This needs a yes, and a flag that names what is lost. Run it again with --yes --erase-all-saved-secrets.");
          if (!/^y(es)?$/i.test((await ask(context, "Reset the vault and lose every key and sign-in in it? [y/N] ")).trim())) {
            context.note("The vault is not reset.");
            return EXIT.failed;
          }
        }
        context.print(await context.client.call("credentials.vaultReset", { agreed: true, eraseAllSavedSecrets: true }), "The vault is reset. It is empty. Enter each key and sign-in again.");
      },
    },
  },
};

const STATES = { ready: "ready", locked: "locked", "signed-out": "signed out", missing: "not installed", error: "error" };
const MANAGER = "Name the password manager (see `botkins password-managers list`).";
const passwordManagers = {
  summary: "Password managers: their state, locking Bitwarden, and setting up Proton Pass",
  details: "A saved credential can be read from a password manager each time it is used. A manager's items and fields, its master password and the linking of a field to a credential stay in the app's window and on a paired phone.",
  commands: {
    ...protonCommands,
    list: {
      summary: "List the password managers and whether each is ready",
      usage: "botkins password-managers list [--refresh]",
      options: { refresh: { type: "boolean", about: "Ask each manager's tool again instead of using what was learned a moment ago" } },
      details: "This runs each manager's own command-line tool (op, bw, pass-cli) to ask its state, as the user that runs Botkins. It starts nothing else.",
      async run(context) {
        context.print(await context.client.call("credentials.managers", context.options.refresh === true), (list) => {
          const note = (entry) => entry.id !== "protonpass" && entry.state === "missing" ? "Its command-line tool is not installed."
            : entry.message ?? (entry.state === "locked" ? "Unlock it in the app's window or on a paired phone."
            : entry.expiresAt ? "Access ends " + new Date(entry.expiresAt).toISOString().slice(0, 10) + ". Shared vaults: " + (entry.sharedVaults ?? []).join(", ")
            : entry.state === "missing" ? "Its command-line tool is not installed." : "");
          const lines = [table(["MANAGER", "STATE", "VERSION", "ACCOUNT", "NOTE"], list.map((entry) => [safe(entry.name), STATES[entry.state] ?? safe(entry.state), safe(entry.version ?? ""), safe(entry.account ?? ""), safe(note(entry))]))];
          for (const entry of list.filter((one) => one.state === "missing" && one.install)) lines.push(safe(entry.name) + ": install its tool from " + safe(entry.install.url) + (entry.install.command ? " (" + safe(entry.install.command) + ")" : "") + ".");
          return lines.join("\n");
        });
      },
    },
    lock: {
      summary: "Lock a password manager again",
      usage: "botkins password-managers lock <manager>",
      async run(context) {
        context.print(await context.client.call("credentials.managerLock", one(context, MANAGER)), (answer) => safe(answer.name) + " is " + (STATES[answer.state] ?? safe(answer.state)) + ".");
      },
    },
  },
};

/** The text of one limit: how much is left, and when it starts again. */
const limitText = (limit) => (limit.unlimited ? "unlimited" : limit.percentRemaining !== undefined ? limit.percentRemaining + "% left" : "not available") + (limit.resetAt ? ", starts again " + ago(limit.resetAt) : "");
/**
 * Follows an install through the events the service reads from it: what it prints is shown as it comes. A question that
 * the install asks is put to the person at a terminal. With no terminal nobody can answer it, and the install goes on.
 * Returns { result, output }.
 */
async function followInstall(context, session) {
  const { client, color } = context;
  const output = [];
  const cancel = () => void client.call("providers.install.cancel", session).catch(() => {});
  process.once("SIGINT", cancel);
  try {
    for (let after = 0; ; ) {
      const view = await client.call("providers.install.read", session, after);
      after = Math.max(after, view.next ?? 0);
      for (const event of view.events) {
        if (event.type === "output" || event.type === "open") {
          const line = event.type === "output" ? event.text : "page: " + event.url;
          output.push(line);
          if (!context.json) context.stdout.write(color.dim("  " + safe(line)) + "\n");
        } else if (event.type === "prompt" && !view.done && context.stdin.isTTY && !context.json) {
          const line = await ask(context, (event.text ? safe(event.text) + "\n" : "") + "> ", { hidden: event.secret === true });
          if (line !== null) await client.call("providers.install.input", session, line).catch((error) => context.note(error.message));
        }
      }
      if (view.done) {
        if (view.error) throw new CliError(safe(view.error), EXIT.failed, "INSTALL_FAILED");
        return { result: view.result, output };
      }
    }
  } catch (error) {
    // A person who stops at a question (Ctrl-C) ends the install too: it is not left running with nobody to see it.
    if (error?.code === "CANCELLED") cancel();
    throw error;
  } finally {
    process.off("SIGINT", cancel);
  }
}

const PROVIDER = "Name the provider (see `botkins providers list`).";
const providersCommands = {
  summary: "List model providers, and sign them in and out",
  commands: {
    usage: {
      summary: "Show each connected provider's plan and what is left of its limits",
      usage: "botkins providers usage [<provider>] [--refresh]",
      options: { refresh: { type: "boolean", about: "Read each provider again instead of using what was read a moment ago" } },
      details: "Only a provider that is switched on and signed in has an entry. Every number is the provider's own. No token, email or account id is shown.",
      async run(context) {
        if (context.args.length > 1) throw usage(PROVIDER);
        context.print(await context.client.call("providers.usage", { refresh: context.options.refresh === true, ...(context.args.length && { provider: context.args[0] }) }), (list) => {
          if (!list.length) return "No provider is switched on and signed in, so there is no plan to show. See `botkins providers list`.";
          return list
            .map((entry) => {
              const lines = [safe(entry.name) + (entry.plan ? ": " + safe(entry.plan) : "") + (entry.account === "api-key" ? " (an API key: billed by use, with no plan limits)" : "")];
              if (entry.limits.length) {
                const pad = Math.max(...entry.limits.map((limit) => safe(limit.label).length)) + 2;
                for (const limit of entry.limits) lines.push("  " + safe(limit.label).padEnd(pad) + limitText(limit));
              }
              if (entry.credits) lines.push("  " + safe(entry.credits.label) + ": " + entry.credits.amount + " " + safe(entry.credits.unit));
              if (entry.note) lines.push("  " + safe(entry.note));
              if (entry.error) lines.push("  The last read failed: " + safe(entry.error) + (entry.updatedAt ? " These numbers are from " + ago(entry.updatedAt) + "." : ""));
              return lines.join("\n");
            })
            .join("\n\n");
        });
      },
    },
    install: {
      summary: "Install a provider's command-line tool, with the command that the provider names",
      usage: "botkins providers install <provider> [--yes]",
      options: YES,
      details: "This runs a command in a shell on this computer, as the user that runs Botkins. The command is shown first, and it needs your yes (--yes when there is no terminal). The command is the provider's own: you cannot give another. What it prints is shown as it runs. An npm install goes to ~/.npm-global. It is for macOS and Linux.",
      async run(context) {
        const plan = await context.client.call("providers.installPlan", one(context, PROVIDER));
        // Shown even with --yes and with --json: what runs on this computer is in the caller's own record.
        show(context, "This runs a command in a shell on this computer, as the user that runs Botkins, to install " + safe(plan.name) + ":\n  " + safe(plan.command) + (plan.url ? "\nThe provider's guide: " + safe(plan.url) : ""));
        if (!(await confirm(context, "Let Botkins run it?"))) {
          context.note("Not installed.");
          return EXIT.failed;
        }
        const started = await context.client.call("providers.install", plan.id, { command: plan.command });
        const { result, output } = await followInstall(context, started.session);
        context.print({ done: true, id: plan.id, ...result, output }, "Installed " + safe(plan.name) + (result?.version ? " (" + safe(result.version) + ")" : "") + ". Sign it in with `botkins providers login " + plan.id + "`.");
      },
    },
    disconnect: {
      summary: "Disconnect a model service of a provider that holds several (OpenCode)",
      usage: "botkins providers disconnect <provider> <service> [--yes]",
      options: YES,
      details: "The service's key or sign-in is removed, and its models are no longer offered. The services are listed by `botkins providers services <provider>`.",
      async run(context) {
        if (context.args.length !== 2) throw usage("Name the provider and the model service (see `botkins providers services <provider>`).");
        const [provider, service] = context.args;
        if (!(await confirm(context, "Disconnect " + safe(service) + " from " + safe(provider) + "? Its key or sign-in is removed, and its models are no longer offered."))) {
          context.note("Not disconnected.");
          return EXIT.failed;
        }
        context.print(await context.client.call("providers.disconnectService", provider, service, { agreed: true }), (done) => "Disconnected " + safe(done.name) + " from " + safe(done.provider) + ".");
      },
    },
  },
};

export const credentialsCommands = { credentials, vault, "password-managers": passwordManagers, providers: providersCommands };
