---
name: use-botkins
description: Change Botkins itself with the `botkins` command when your person asks: a bot, a tool, a skill, a plugin, a routine, a project, a chat, a space, the team or a preference. Also to say what is set up.
---

# Use the `botkins` command

`botkins` is a command line for this Botkins. It does what the app's window does. You run it in your shell, when your person asks you to change how Botkins is set up, or asks what is set up.

## When to use it

Use it when your person asks to change or to see: a bot (its name, model, instructions, memory, tools, skills, access), a tool or a skill, a plugin, a routine, a project, a chat, a space or the team, a preference, or the log.

Do not use it for your ordinary work. Do not change a setting that nobody asked you to change.

## Where the command is

`botkins` is on your PATH. `botkins status --json` says whether the service answers. If the shell says that `botkins` is not found, this skill is not for this host. Tell your person that, and stop.

## Find a command, never guess

- `botkins help` lists the areas (bots, chats, routines, projects, wiki, plugins, tools, skills, spaces, panels, sharing, team, preferences, credentials, voice and more). `botkins help bots` lists one area. `botkins help bots tools` explains one command.
- `botkins help --json` is the whole list as data: each command has its usage, its options and `asks`. Read it with `--json`.
- Add `--json` to any command to get one JSON document on standard output. A failure is `{"error": {"message", "code"}}` with a non-zero exit code.
- Name a thing by its name or its id. An id that starts with a dash goes after `--`: `botkins routines run -- <id>`.
- A long text comes from a file (`--file`, `--instructions-file`) or from standard input, not from a long word on the command line.

## The rule for a yes

A command that has `asks` in `help --json` changes something that is hard to undo, takes a question away, gives a bot more room, or shows something to more people. Follow these three steps, in this order.

1. Run the command with no `--yes`. You have no terminal, so it changes nothing. It prints on standard error what will start or change, and it names the flag that agrees.
2. Show your person that block as it is. Do not shorten it or put it in other words. Ask them if you may go on.
3. Only after they agree, run the same command again with `--yes`. Where the command asks for a revision (`asks` is `--yes --revision`), also give `--revision=<revision>`: the one that the block showed.

Never give `--yes` on your own. Your person must see the exact command and what it changes, and say yes, before you run it. You show it yourself, in the chat, and you wait there for their yes. Do not count on an approval card: with the approval level `all`, your person gets no card.

Never answer a request that waits in a chat: an approval, a question or a secure input. Your own above all. The person answers it, in the window, on their phone or in their own terminal. No flag of `botkins chat` approves a request, and you must not call the socket yourself to do it.

A command with no `asks` changes at once. That is fine when your person asked for it.

## Secrets

Never put a secret on the command line: a key, a token, a password. It would show in the list of processes and in the chat. Never print or repeat a secret.

A command that needs one (for example `botkins credentials save <name>`) reads it from a hidden question or from standard input. Tell your person to run that command in a terminal themselves. A link or a code that a command prints (`botkins sharing link`, `botkins team invite`) lets whoever has it in. Give it to your person only. The tool `request_secure_input` is for a listed HTTPS operation only. It cannot hand a value to a command, so do not use it for this.

For a website login, API call, or CLI secret, use the Botkins tools your harness offers in a private owner chat:

- Call `find_saved_credentials` with a URL, host, or search query. It matches across registrable domains (eTLD+1), saved URL aliases, and linked 1Password / Bitwarden / Proton Pass items, and returns only names, IDs, kinds, sites, and sources (never values).
- Call `use_credential` with the returned `credentialId`, an operation (`extension_fill` for the person's Chrome/Edge extension, `page_fill` or `page_fill_submit` for the host sign-in browser / side pane web viewer, `https_form` / `bearer_get` / `https_header` for HTTPS APIs, `env_exec` for an approved CLI command with the secret passed only in the child's environment, or `totp: true` for a 2FA code), and the pinned `destination`. Under a standing grant (`Allow for today` or `Always allow for this site`) it runs directly; otherwise Botkins raises an owner approval card showing bot, credential name, source vault, destination, and operation (never the value). Destination origins are strictly pinned at fill time.
- Keep using `request_secure_input` + `use_secure_input` when the secret is not yet saved in the vault or a linked password manager.
- Use `botkins credentials grants --json` and `botkins credentials audit --json` to inspect standing bot grants and credential audit logs, and `botkins credentials revoke <grantId>` (after showing the confirmation block and getting the person's yes for `--yes`) to revoke a grant. Creating standing grants and copying values out of password managers are owner-only in the desktop or phone UI — never via the CLI socket.
- Use the built-in tools directly through your harness, including when it prefixes their names with its MCP server name.

## What you cannot do here

Unlocking a password manager, what is inside one, linking or copying a field of one, creating standing credential grants, and using a saved credential by reference are done in the app's window or on a paired phone, where a person is known to be there. No CLI command does them, and the service refuses them on the control socket. Tell your person where to do it. Do not look for a way round.

## After a change

Each change leaves a line in the log (`botkins logs`). When you are done, say in one line what you changed.

## Example: look

Your person asks what bots there are and what tools Nova has.

```
botkins bots list --json
botkins bots tools Nova --json
```

Tell them what you found in a few plain words. Nothing changed, so you ask nothing.

## Script commands: a slash command that runs a script, with no model

When your person has a workflow that repeats (build and preview, rotate the logs, sync a folder), a script command saves them the tokens: they type `/name some words` in any chat and Botkins runs a script on this computer. No model reads it or runs it, and no session is opened. No bot is offered it as a skill. A routine whose prompt is `/name words`, or a task whose details are, runs it too, with no model: its output is the result. Team members whose role may use skills can type it.

- Your tools `script_command_list` and `script_command_create` are there for it. `script_command_create` takes a name (lowercase letters, numbers and dashes, not a command that exists), one line that says what it does, and the whole script. The person is shown the name and the whole script and decides. Nothing is saved until they say yes; if they decline, say so and stop.
- From a terminal: `botkins skills add-script <name> --description <text> --script-file <path>` shows the whole script and its revision (a hash) on standard error, and exits with code 2. Show that block to your person as it is and ask. Only after they agree, run the same command again with `--yes --revision <the revision>`: a yes is for that script only, and a changed script has another revision. `botkins skills show <name>` prints one.
- A routine or a task that invokes a script command is shown to your person before it is saved: `routine_create`, `routine_update`, `task_create` and `task_update` ask them (a card with the command, its words and its script), and if they decline, say so and stop. From a terminal, `botkins routines add` (and `edit`, `duplicate`) and `botkins tasks add` (and `edit`, `move`, `start`) show the same and ask; with no terminal they need `--yes`, which you give only after they agreed. Work that nobody watches cannot make or change one.
- Never type a script command for your person. `botkins chat <bot> -m "/name words"` runs its script on this computer with words that you chose, so it is shown to your person and needs their yes (`--yes` only after they agreed). Your own messages are never script commands, and a script command never gets your environment's secrets.
- Write the script for the person's login shell (PowerShell on Windows). The words typed after the name are in `$BOTKINS_ARGS` and on standard input, and `$BOTKINS_COMMAND` and `$BOTKINS_CHAT_ID` name the command and the chat. Treat the words as data: quote them, never put them into a command. The script runs in the chat's project folder, or in your own folder; what it prints (the last 12,000 characters) and its exit code come back as the reply. It has no time limit and the person's Stop ends it. Never put a secret in a script.

## Example: a change that asks

Your person asks: "Have Nova write me a summary every weekday at 8."

1. Run it with no `--yes`:

```
botkins routines add "Weekday summary" --bot Nova --prompt "Write my summary of yesterday." --cadence weekdays --at 08:00
```

   It exits with code 2. Standard error shows the bot, the schedule in words, the next two times and the prompt, and says that `--yes` agrees.
2. Show that block as it is. Ask: "Shall I make this routine?"
3. They say yes. Run the same command again with `--yes` at the end. Then say: "Made the routine Weekday summary: Nova, weekdays at 08:00."

For `botkins plugins install <id>` the steps are the same, with one more word: first `botkins plugins show <id>` for the revision, and then `--yes --revision=<revision>`.
