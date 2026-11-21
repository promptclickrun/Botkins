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

Never give `--yes` on your own. Your person also sees the command itself on an approval card before it runs.

A command with no `asks` changes at once. That is fine when your person asked for it.

## Secrets

Never put a secret on the command line: a key, a token, a password. It would show in the list of processes and in the chat. Never print or repeat a secret.

A command that needs one (for example `botkins credentials save <name>`) reads it from a hidden question or from standard input. Tell your person to run that command in a terminal themselves. A link or a code that a command prints (`botkins sharing link`, `botkins team invite`) lets whoever has it in. Give it to your person only. The tool `request_secure_input` is for a listed HTTPS operation only. It cannot hand a value to a command, so do not use it for this.

## What you cannot do here

Unlocking a password manager, what is inside one, linking a field of one, and using a saved credential by reference are done in the app's window or on a paired phone, where a person is known to be there. No command does them, and the service has no call for them. Tell your person where to do it. Do not look for a way round.

## After a change

Each change leaves a line in the log (`botkins logs`). When you are done, say in one line what you changed.

## Example: look

Your person asks what bots there are and what tools Nova has.

```
botkins bots list --json
botkins bots tools Nova --json
```

Tell them what you found in a few plain words. Nothing changed, so you ask nothing.

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
