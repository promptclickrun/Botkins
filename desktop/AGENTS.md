# Botkins on the computer: rules for agents that change this code

## The command line covers what the window can do

A standing rule from the owner (2026-11-20): the terminal host's command line and dashboard manage everything, so that a person, or an agent whose person asked, can change Botkins from a terminal.

- When a call is added to `runtime.handlers` (`desktop/runtime.mjs`) or to the phone link, give it an entry in `desktop/terminal/coverage.mjs` in the same piece of work: the command that does it, or one reason from the fixed list there (it needs a window, it is the window's own, it is a phone's own, it needs a person at the app). Nothing is owed and there is no `botkins call`: a call with no command and no reason is a failing test. "Hard", "rare" and "not built yet" are not reasons.
- `test/terminal-coverage.test.mjs` fails when a call has no entry, and when a named command no longer exists. `npm test` runs it.
- A new command is in the tree of `cli/commands/`, with a `usage` line that names each option, so that `botkins help --json` describes it. It works with `--json` and with no terminal. It takes a secret from standard input or a hidden prompt, never as a word on the command line. It prints no secret.
- A control call that changes something is in `CHANGES` in `coverage.mjs`, so that it leaves a line in the log: which call, which thing, never a value.
- A command that puts something on the host that runs commands (a plugin with hooks, a tool that starts a program) shows what will run first and needs the person's yes.
- The guide for people and agents is `docs/terminal.md`. The phone has the same kind of rule in `mobile/AGENTS.md`, "Parity with the computer".

## A turn is never failed for being quiet

A standing rule from the owner: "We shouldn't be enforcing time outs if it's controllable." The person can stop any turn (Stop in the chat and on the phone, Stop on Work and Routines), so a turn, a routine or a task has no idle or wall-clock limit. The one exception, by the owner's choice: a routine's script (`desktop/routine-script.mjs`) still stops after 10 minutes.

- A turn ends by itself only when its harness is really gone (its process exited, its connection closed, its session no longer exists, or it reported an error), or when the person stops it. After a quiet spell the provider asks the harness whether it is still there (`desktop/providers/liveness.mjs`), and a live harness is waited for with no failure. A harness whose process ending already ends the turn (Claude Code, Pi, OMP, ACP agents) needs no check.
- `send(message, timeoutMs)` takes a time limit only from a caller with nobody to stop it, such as the background chat summary. The workspace passes none for a person's turn.
- Deadlines for a startup or connection handshake, a one-shot probe or a model list stay: the person can't see or stop those. A routine's own max-runtime setting, if one is ever added, is the person's choice and is honored.
