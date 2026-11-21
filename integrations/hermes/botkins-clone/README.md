# Botkins Clone

A Hermes plugin that clones a Hermes profile as a [Botkins](https://botkins.app) bot.

## Install

```bash
hermes plugins install promptclickrun/Botkins/integrations/hermes/botkins-clone --enable
```

Hermes downloads only this folder. To pin a version, add `--ref <full commit SHA>`.

## Light or full

| Hermes profile | Light | Full |
|---|---|---|
| Name in `SOUL.md` ("You are Ralph, …") | Bot name | Bot name |
| "…, a pragmatic engineer …" | About and role | About and role |
| `model.default` in `config.yaml` | Model, when the Copilot account has it | Same |
| `SOUL.md` | Instructions (up to 30,000 characters) | Instructions, and condensed into `AGENTS.md` |
| `USER.md` (profile home or `memories/`) | | `USER.md` |
| `IDENTITY.md` | | `IDENTITY.md` |
| `memories/MEMORY.md` | | The bot's Memory, one fact per line |

Botkins puts only the first 4,000 characters of each profile file into a turn. A full clone keeps
the whole SOUL as the bot's instructions and has the profile's active Hermes model condense it to
fit `AGENTS.md`. A SOUL that already fits is copied as it is.

Credentials, `.env`, skills, cron jobs, sessions, tools and MCP servers stay in Hermes. Botkins bots
get their tools from Botkins. Memory must fit Botkins' 24,000-character limit; the plugin refuses
rather than drop facts. Hermes profiles are only read, never changed.

## Clone into Botkins on this machine

```bash
hermes botkins-clone light ralph
hermes botkins-clone full ralph
```

Both write `hermes-ralph.agent.md` to `~/.copilot/agents/` (or `$COPILOT_HOME/agents`). In Botkins,
open **Create a bot → Import agents** and choose Ralph.

A full clone takes two runs, because a bot's files live under its Botkins id, which exists only
after you import the agent:

1. `hermes botkins-clone full ralph` writes the agent and keeps the other files waiting in
   `~/.copilot/agents/hermes-ralph.clone/`.
2. Import the agent in Botkins.
3. Run `hermes botkins-clone full ralph` again. The plugin finds the new bot and writes its
   `AGENTS.md`, `USER.md` and `IDENTITY.md` (`<Botkins data>/files/<bot id>/`) and its memory
   (`<Botkins data>/memory/<bot id>/MEMORY.md`). It won't replace files the bot already has unless
   you add `--force`.

## Export for download

```bash
hermes botkins-clone export light ralph   # hermes-ralph.agent.md
hermes botkins-clone export full ralph    # hermes-ralph.botkins-clone.zip
```

Export writes the files to a Hermes scratch folder (or `--out DIR`) and installs nothing. A full
export is a zip of the agent file, `AGENTS.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md` and a README
that says where each one goes. Use it when Botkins runs on a different machine from Hermes.

In a chat, `/botkins-clone export full ralph` attaches the file to the reply.

## Commands

```bash
hermes botkins-clone list                 # list the profiles
hermes botkins-clone light [profile]      # omit the profile to pick one
hermes botkins-clone full [profile]
hermes botkins-clone export [light|full] [profile]
```

| Option | What it does |
|---|---|
| `--force` | Replace an earlier clone, or files the bot already has |
| `--name`, `--description` | Override the bot's name or its About text |
| `--out DIR` | Write somewhere else |
| `--dry-run` | Print what would be cloned (light and full only) |

In a chat, `/botkins-clone` asks which profile and whether to clone light or full.
`/botkins-clone full ralph` skips the questions.

The bot is a copy, so later changes to the profile don't reach it. To update it, run the clone again
with `--force`, delete the bot in Botkins and import the agent again.

## Tests

```bash
cd integrations/hermes/botkins-clone
python3 -m pytest tests
# also check the agent file with Botkins' own reader:
BOTKINS_AGENTS_MJS=../../../desktop/desktop/providers/copilot/agents.mjs python3 -m pytest tests
```
