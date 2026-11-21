# Run Botkins from a terminal

The terminal host is Botkins as a service on a computer with no screen. It needs no desktop, no Electron and no display. You install it, configure it and operate it with one command, `botkins`. A phone pairs with it and uses your bots the same way it does with the desktop app.

It runs on Linux (x64 and ARM64, with systemd) and on macOS. A small virtual machine with 1 vCPU and 1 GB of memory is sufficient.

- [Install](#install)
- [Sign a model provider in](#sign-a-model-provider-in)
- [Make a bot and talk to it](#make-a-bot-and-talk-to-it)
- [Pair a phone](#pair-a-phone)
- [Configure the host](#configure-the-host)
- [Operate the service](#operate-the-service)
- [The dashboard](#the-dashboard)
- [Update](#update)
- [Docker](#docker)
- [Scripts and JSON](#scripts-and-json)
- [Security model](#security-model)
- [What stays in the desktop app](#what-stays-in-the-desktop-app)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Install

### Linux, for the whole computer

Run the installer as root:

```sh
curl -fsSL https://github.com/promptclickrun/Botkins/releases/latest/download/install.sh | sudo sh
```

The installer does these things:

1. It downloads the release for your system and its signed checksums.
2. It checks the signature against the Botkins release key. Then it checks the checksum of the download. If a check fails, it installs nothing.
3. It uses Node.js 24 from the computer. If the computer has no Node.js 24, it downloads one for Botkins only.
4. It puts the program in `/opt/botkins` and the command in `/usr/local/bin/botkins`.
5. It creates the user `botkins` and the data folder `/var/lib/botkins`.
6. It installs a systemd unit and starts the service.

The signature check uses GnuPG. If GnuPG is not installed, install it first (`apt-get install -y gnupg` on Debian and Ubuntu).

The folder `/opt/botkins` and each folder above it must belong to root. Only root can have permission to write to them. An update installs a new version only into such a folder, because root runs what is in it. The installer makes the same check before it installs. If a folder is not correct, the installer stops, names the folder and prints the commands that correct it. Some cloud images make `/opt` writable for all users.

To pass options to the installer, put them after `sh -s --`:

```sh
curl -fsSL https://github.com/promptclickrun/Botkins/releases/latest/download/install.sh | sudo sh -s -- --version 0.17.0
```

| Option | Effect |
|---|---|
| `--user` | Install for your user only, without root. |
| `--version <x.y.z>` | Install this release. |
| `--no-service` | Install the program only. |
| `--no-start` | Install the service, but do not start it. |
| `--bundle-node` | Download Node.js for Botkins although the computer has one. |
| `--checksum-only` | Skip the signature check. The checksum check stays. |

### Linux, for one user

Run the installer without root, or with `--user`:

```sh
curl -fsSL https://github.com/promptclickrun/Botkins/releases/latest/download/install.sh | sh -s -- --user
```

The program goes to `~/.local/share/botkins-terminal`, the command to `~/.local/bin/botkins` and the data to `~/.local/share/botkins`. The service is a `systemctl --user` unit. The installer turns lingering on, so the service runs while you are signed out. If your system refuses that, the installer prints the command to run as root.

### macOS

Run the same installer. Without `sudo`, it installs a LaunchAgent that runs in your session. With `sudo`, it installs a LaunchDaemon that starts with the Mac and runs as your user.

```sh
curl -fsSL https://github.com/promptclickrun/Botkins/releases/latest/download/install.sh | sh
```

The data folder is `~/Library/Application Support/Botkins Terminal`. It is not the folder of the desktop app, so the two can be on one Mac. Give the terminal host its own port if the desktop app also has phone access on (`botkins config set link.port 47611`).

### From a checkout

Use this to try the terminal host without an installation.

```sh
cd desktop
npm ci --omit=dev
node cli/botkins.mjs serve
```

`serve` runs the service in the foreground. Open a second terminal for the other commands. To keep this copy running as a service, run `node cli/botkins.mjs service install`.

### Check the installation

```sh
sudo botkins status
sudo botkins doctor
```

`doctor` checks Node.js, the permissions of the data folder, the configuration and the control socket. It also checks the port of the phone link, the relay and each model provider. It prints a fix for each problem.

For an installation for the whole computer, run `botkins` with `sudo`. The command then changes to the `botkins` user before it does anything. Only `botkins service` and `botkins update` stay root.

## Sign a model provider in

A bot uses a model from a provider: GitHub Copilot, Codex (ChatGPT), Claude Code, OpenCode, or an agent that speaks ACP. Each provider signs in to your own account. You do not need a browser on the host.

```sh
botkins providers list
botkins providers login <provider>
```

GitHub Copilot is part of Botkins. The other providers use their own command-line tool. Install that tool on the host so that the `botkins` user can run it, for example in `/usr/local/bin`. `botkins providers list` shows which tools are missing.

`login` runs the sign-in of the provider on the host and tells you what to do on another device:

| Provider | Sign-in without `--token` |
|---|---|
| `copilot` | A one-time code. Type it at `github.com/login/device` on any device. |
| `codex` | A one-time code (the device sign-in of Codex). |
| `claude` | The sign-in of Claude Code: a page to open, and a code to paste. |
| `opencode` | The page of the model service. Add `--service <id>`. |
| ACP agents | The sign-in command of the agent, passed through your terminal. |

If that sign-in does not work on your host, use a token that you made on another computer:

```sh
botkins providers login claude --token
```

| Provider | Token for `--token` |
|---|---|
| `copilot` | A GitHub token that can use Copilot, for example from `gh auth token`. |
| `codex` | An OpenAI API key, or a ChatGPT access token. |
| `claude` | The token from `claude setup-token`, or an Anthropic API key. |
| `opencode` | The API key of the model service. Add `--service <id>`. |

`--token` never takes the token from the command line, because other users can see a command line. Type the token at the prompt, where it does not show. In a script, pipe it in:

```sh
printenv CLAUDE_TOKEN | botkins providers login claude --token
```

Botkins keeps a pasted Claude or Copilot token in its credential vault and gives it to the tool when the tool starts. Codex and OpenCode keep their own.

To sign a provider out, run `botkins providers logout <provider>`. To see the models, run `botkins models`.

### From the Botkins phone app

A paired phone does all of this too, from the provider's page in Settings › Models. It shows the code with a button that copies it and opens the page on the phone, asks for a code when the tool waits for one, takes a pasted token, and signs a provider out. When a provider's tool is missing, **Install on your computer** runs the install command that the provider names (for example `npm install -g @openai/codex`, which goes to `~/.npm-global` of the `botkins` user, so it needs no root). Only the owner's phone can do this. A sign-in started on the phone and one started in a terminal are the same kind, so a second one for the same provider waits until the first ends.

## Make a bot and talk to it

```sh
botkins bots add "Nova" --role "Research partner" --instructions "Find sources. Say what is evidence and what is a guess."
botkins bots list
botkins chat Nova
```

`chat` opens a prompt. Type a message and press Enter. Press Ctrl-C to stop a reply. Press Ctrl-D, or type `/quit`, to leave. If the bot asks for an approval, the prompt asks you.

To send one message from a script, use `-m`:

```sh
botkins chat Nova -m "Summarize the notes in the wiki." --json
```

Other commands for bots:

- `botkins bots edit <bot>` opens the bot in your editor. With `--name`, `--role`, `--instructions`, `--instructions-file` or `--model`, it changes that field directly.
- `botkins bots remove <bot>` removes a bot and its chats.
- `botkins routines list`, `run`, `pause` and `resume` operate the routines of your bots.
- `botkins plugins` installs and manages plugins. See "Plugins" below.

A paired phone does everything else for now: tasks, the wiki, projects and credentials.

## Tools and skills

A **tool** is something a bot can call. One that you add is an MCP server: a program that this computer starts, or a web address. A **skill** is a set of instructions that a bot reads when a task needs them. Each bot has every tool and skill that is on, unless you take one from that bot.

```sh
botkins tools add files --command npx --env API_KEY -- -y @example/files-mcp
botkins tools add search --url https://mcp.example.com/v1 --header Authorization
botkins tools list
botkins tools test files
botkins skills add weekly-report --description "Use for the Friday report." --instructions-file report.md
botkins bots tools Nova --off search
botkins bots skills Nova --off weekly-report
```

- **A program's own arguments come last, after `--`.** Thus an argument can start with a dash, and no word of the program is taken as an option of Botkins. `--yes` has no short form in these commands: `-y` is `npx`'s own.
- **A value is never a word on the command line.** Name each environment value or header (`--env API_KEY`, `--header Authorization`). The command then asks for each value and does not show what you type. From a script, give the values in a JSON file: `--secrets values.json`, or `--secrets -` to read the file from standard input. The file is `{ "env": { "API_KEY": "…" }, "headers": { "Authorization": "…" }, "clientSecret": "…" }`. No command prints a value: `botkins tools show` gives the names that have one.
- **A tool that is a program is shown before it starts.** `tools add`, `tools enable`, `tools import`, `tools test` of a tool that is off, and a `tools edit` that changes the program, its arguments, its folder or its environment values print what will start: the exact line, the folder, and the names of the environment values. Then they ask. With no terminal they fail and name `--yes`. The block is printed on standard error with `--yes` and with `--json` too, and the JSON answer has the same (`runs`, `cwd`, `env`, and `starts` for an import).
- The line is what Botkins starts. The program is found on the `PATH` of the service, which may not be the `PATH` of your terminal, and a folder that does not exist is left out.
- A name is a name. `--env API_KEY=…` and `--header "Authorization: Bearer …"` are refused, and the word is not repeated.
- When you change the program, its arguments or the web address, give the stored values again. A value goes only where you sent it.
- `botkins tools import <file>` adds the tools of a JSON file, such as another app's MCP settings (`{ "mcpServers": { … } }`). It shows each tool of the file first, a web address too, and one yes adds what it showed. A tool whose name is taken is left out.
- `botkins tools test <tool>` ends with exit code 1 when the tool did not connect.
- A tool on the web that signs in cannot be signed in from this command line yet. Sign it in from a paired phone (Settings, Tools). `botkins tools sign-out <tool>` forgets a sign-in.
- `botkins skills edit`, `remove`, `enable` and `disable` change a skill. `botkins skills add-folder <path>` adds a skill from its folder, or links a folder of skills. The folder must be in the home folder of the user that runs Botkins, or on a plugged-in disk; `botkins folders` lists what you can choose, and on a server you copy the folder there first. A plugin folder is not taken as a folder of skills, because a plugin can run commands.
- **A skill's header and the question.** A skill is a folder with a `SKILL.md`, and that file has a header with the skill's `name` and `description`. A header can have more keys. In other tools, `allowed-tools` lets a skill use tools with no question, and `hooks` or `mcp-servers` start programs. In Botkins a skill's header does none of that: Botkins asks before a command runs, as it does with no skill, and the header starts nothing. A check that uses the real runtime holds this for each version of the runtime (`test/skill-allowed-tools-live.mjs`).
- `botkins bots access <bot> --all`, `--project <project>` or `--none` sets which projects a bot can use. `botkins bots menu <bot>` lists what the bot's chat offers; like each turn of the bot, it starts the bot's tools that are programs and are on.
- `botkins tools forget-approvals` forgets the approvals that were given to tools "for this chat".

## Plugins

A plugin adds skills, agents, commands, tools and hooks to bots. A hook, and a tool that is a local program, run commands on this computer. Thus a plugin is looked at before it is installed, updated or switched on.

```sh
botkins plugins browse memory
botkins plugins show memory@some-market
botkins plugins install memory@some-market --settings settings.json
botkins plugins install --yes --revision=<revision> -- memory@some-market
botkins plugins configure memory
botkins plugins bots memory --bot Nova
```

- **`botkins plugins show <id>` is the look.** It prints what the plugin holds and all that it runs on this computer: each hook's whole command, and each program with every word of its line, its folder and the names of its environment values. It prints a hook's time limit. It prints the web addresses that the plugin reaches, with each header as the plugin wrote it, the kind of the tool (`as a stream (sse)`) and the sign-in with its client id. It prints each setting with the place that its value goes to, and its default (never for a secret setting, because a default goes into the values that are sent). It prints what Botkins does not run, with the reason, and the other files of the plugin: how many, how large, and the names of the configuration files (twelve at most, then "and N more"). A command runs with these files, and Botkins cannot show all that they make it do: the look says so. It prints the revision, which names the plugin's source exactly as it is at that moment.
- **The bots are shown.** An installed plugin has a line `Bots:` with the names of the bots that have it, or `every bot`. `plugins install` gives a plugin to every bot unless `--bot` is given, and before the question (and in the block on standard error with `--yes`) it says `For: every bot` or `For: <the bots>`. `plugins bots` says `Now: … After: …` before it asks.
- **A plugin that runs commands needs your yes.** At a terminal, with no `--yes`, the command shows the plugin and asks. `--yes` is the word of a caller that looked, so it must name what was looked at: `--yes --revision=<revision>`. `--yes` alone is refused for such a plugin, also at a terminal. The computer refuses the plugin when it is another one than that revision, so what you looked at is what is installed.
- The same rule holds for `plugins install`, `plugins update`, `plugins enable`, and for `plugins bots` when more bots get a plugin that is on. A plugin that runs nothing needs no yes. Its revision still goes with the install.
- **The service keeps the rule too.** It takes no install and no update that names no revision, from any caller. It takes no switch-on of a plugin that runs commands on this computer that names no revision either, also from the app's window, a phone and a bot's tool. A switch-off and a switch-on of a plugin that runs nothing need none.
- **An installed plugin has two revisions.** `plugins show` prints the one of the installed copy and the one of the source as it is now. `plugins enable --revision` takes the first. `plugins update --revision` takes the second.
- **`botkins plugins update <id>` says what changes** before it asks: the commands and the web addresses that are new, changed or gone, and the settings. It compares the two whole descriptions: also a hook's time limit and the order of the hooks, a tool's type, a header as written, a client id, a setting's default, what is not run, and the other files. It asks also when nothing runs on this computer, if the plugin reaches a new address, a tool on the web has another type, header or client id, or a setting that you gave goes to another place or has another default. Your saved settings stay with the plugin.
- `botkins plugins disable <id>` asks nothing.
- **Settings**: `botkins plugins configure <id>` asks for each setting at a terminal, says where its value goes, and does not show a secret one. From a script, give `--settings <file>`, a JSON file of `{ "KEY": "value" }`, or `--settings -` for standard input. A saved credential is chosen in the app's window or on a paired phone, not by reference from the command line: give the value itself. `plugins install --settings` for a plugin that runs nothing says where the values go; a secret that goes to an address on the web needs the yes (`--yes --revision`) as a plugin that runs commands does. No command prints a setting's value. `plugins show` marks the settings that have one.
- `botkins plugins bots <id> --all`, or `--bot <bot>` for each bot, says which bots have the plugin. It does not switch a plugin on.
- `botkins plugins add-folder <path>` adds a plugin from a folder of this computer. Botkins copies the folder and adds the plugin switched off, so nothing of it runs, and what it would run is shown. Switch it on with `plugins enable`. It is the only way to add a plugin folder.
- `botkins plugins sign-out <id>` forgets the sign-ins of a plugin's tools.
- **For a caller that reads `--json`:** what must be seen is on standard error. Show it to your person before you give `--yes`. Use the form that works for every id: `botkins plugins install --yes --revision=<revision> -- <id>`.
- A change that the computer refuses is in the log too, as "Tried from the command line: … (it failed)".
- A plugin's own words (its name, a command, an address) are printed with each character that hides or turns text written as its number, as `\u{202e}`.
- **A value that goes into a header.** `plugins configure --settings` and `plugins install --settings` ask before a value goes into a header to an address, whatever the plugin calls the setting. `--yes` then needs `--revision`, as for a plugin that runs commands.
- **A command that Botkins prints for you to run** has each word quoted for a shell when it needs it. An id that has a character that cannot be shown is not printed as a command: take it from `botkins plugins list --json`.
- Only the text of a plugin gets this care. A name that you gave (a bot's name in an error, or in the log) is printed as it is, with its emoji and its joiners. Only a control character and a mark that turns text around are written as a number.

## Pair a phone

```sh
botkins pair
```

The command prints a QR code, a code and a link. Open Botkins on the phone, choose to add a computer, and scan the QR code. You can also type the address and the code. The command waits until the phone pairs.

The code works one time, for five minutes. It lets a phone in, so show it only to the owner of the phone.

If the owner of the phone gets the code later, keep it open for longer. `--ttl` takes minutes, from 1 to 1440. In a script, add `--no-wait --json` to get the code and the link as JSON without waiting for the phone:

```sh
botkins pair --ttl 60 --no-wait --json
```

A phone on another network needs an address that it can reach. Use one of these:

- Turn the relay on: `botkins relay on`. The host keeps one outgoing connection to `relay.botkins.app`, and the phone connects through it. The relay cannot read the messages, because the phone and the host seal them.
- Give the host a public name or a tailnet address: `botkins config set link.addresses server.example.com`. Then open port 47610 in your firewall. Restart the service. A phone uses the port of the link at each address, so do not map it to a different port.

Manage the paired devices with these commands:

```sh
botkins devices list
botkins devices rename <device> <name>
botkins devices set-person <device> <person>
botkins devices remove <device>
```

## Configure the host

The settings of the host are in `config.json` in the data folder. The service checks the whole file before it uses it. A file with a mistake does not start the service, and `botkins doctor` names each mistake.

```sh
botkins config get
botkins config set name "Studio server"
botkins config edit
```

`config edit` opens the file in `$VISUAL`, then `$EDITOR`, then `vi`. If the file that you save has a mistake, the command shows the mistake and opens the editor again. Nothing changes until the file is correct.

| Setting | Default | Meaning |
|---|---|---|
| `name` | the name of the computer | The name that phones show for this host. |
| `link.enabled` | `true` | Phone access. |
| `link.port` | `47610` | The port of the phone link. Needs a restart. |
| `link.announce` | `true` | Announce the host on the local network. Needs a restart. |
| `link.addresses` | `[]` | More names or addresses, without a port, to offer phones in a pairing code. Needs a restart. |
| `relay.enabled` | `false` | Away from home, through the relay. |
| `relay.url` | `https://relay.botkins.app` | The address of the relay. |
| `providers.only` | `[]` | Start only these providers. Empty means all. Needs a restart. |
| `secrets.source` | `auto` | Where the host key comes from: `auto`, `systemd`, `keychain` or `file`. |
| `secrets.keyFile` | none | The key file for the source `file`. |
| `updates.check` | `true` | Look for a new release at intervals, and tell the paired phones about it. |
| `updates.auto` | `false` | Install a new signed release without a request, when no bot is in a turn. |
| `logs.level` | `info` | `error`, `info` or `debug`. |
| `logs.lines` | `5000` | The number of log lines that the service keeps in memory. |

While the service runs, `botkins config` changes settings through the service. The command writes the file itself only when the service is stopped.

## Operate the service

```sh
botkins service status
botkins service start
botkins service stop
botkins service restart
botkins logs -n 100
botkins logs -f
```

`botkins service install` installs the service again. It is safe to run it more than one time. It writes the service file again and does not change the data folder, the paired phones or the host key. Give it the same options as the first time, because it writes the file from the options that you give.

`botkins service refresh` writes the service files as this version of Botkins writes them, and restarts the service if a file changed. It keeps what you chose at installation: the user, the data folder, the `--allow-path` folders and the source of the host key. It reads these from the installed file. An update does this step for you. `botkins doctor` tells you if the files are from an earlier version. The section "The service files after an update" tells you what the command keeps of your own changes.

On Linux the service is `botkins.service`. You can also use `systemctl` and `journalctl -u botkins`. To change the unit, use `systemctl edit botkins.service`, because the next install keeps that change.

The unit for the whole computer lets the service write only to its data folder. If a bot must work in a project folder in a different location, name the folder at installation:

```sh
sudo botkins service install --allow-path /srv/projects
```

To encrypt the host key to this machine, add `--encrypted-key`. systemd then uses the TPM of the machine. If there is no TPM, systemd uses its own secret.

## The dashboard

```sh
botkins tui
```

The dashboard shows the service, the paired devices, the bots, the recent chats and runs, the routines and the log. Use the keyboard for everything. Press `?` to see the keys and `q` to quit.

## Update

```sh
botkins update --check
sudo botkins update
```

`update` installs the latest release. It takes a release only from the releases of the project. It installs a release only if its checksums have a good signature from the Botkins release key. It never installs an unsigned release.

Botkins finds the latest release from the release page of the project on GitHub. This needs no account, and GitHub does not limit it for an address. If the page gives no answer, Botkins asks the GitHub API. GitHub answers the API only 60 times in one hour for one address, and many cloud machines share one address. If GitHub refuses the two questions, Botkins tells you to try again later.

The command unpacks the new version next to the old version. Then it restarts the service on the new version and monitors it for 30 seconds. If the new version does not stay in operation, the command puts the old version back. The old version stays on the disk.

### The service files after an update

A release can change the service files: the systemd units on Linux, or the launchd job on macOS. Before the restart, the update lets the new version write its own service files. If the new version does not stay in operation, the update puts the earlier files back together with the old version.

The update keeps these things from the installed file:

- What you chose at installation: the user, the data folder, the `--allow-path` folders and the source of the host key.
- Each environment variable that you added to the file, for example a proxy. On macOS, the job file is the only place for such a variable.
- Each folder that you added for the bots to write to, also on a line of its own.
- On Linux, the update keeps such a line only if it has one of these forms: `Environment=NAME=value` or `Environment="NAME=a value with spaces"`, and `ReadWritePaths=/a/folder`. A line in a different form is a setting that the update cannot keep (see below). Examples are a value in single quotes, `\n` in a value, a specifier such as `%h`, and a folder with `-` before it.
- A copy of each file that it replaces, as `<name>.bak` in the same folder. There is one copy. The next update replaces it.

The update does not change these things:

- The changes that you made with `systemctl edit botkins.service`. Use that command for all other settings, because each update keeps them.
- A unit that you masked, and a service that you disabled.
- A service file with a setting that Botkins did not write and that the update cannot keep. Examples are a changed `RestartSec=` and an added `MemoryMax=`. The update does not replace that file, because a new file would lose your setting. `botkins doctor` names the file and the setting. That file then stays as an earlier version wrote it.

The update cannot see a line that you removed from the file. The new file has that line again. To switch a setting off, put the change in a drop-in file with `systemctl edit botkins.service`. systemd reads the drop-in after the service file, and each update keeps it.

When the files are not up to date:

- The program that does an update is the old version. Botkins 0.16.5 and earlier do not have this step. After an update that such a version did, the service files stay as they were.
- If the new version cannot write its files, the update puts the earlier files back and continues. `botkins status` and the log tell you.
- In these two cases, `botkins doctor` shows the line `Service files` as a failure. Run `sudo botkins service refresh` for the service of the whole computer, or `botkins service refresh` for your own service.
- If the new version cannot write its files and the update cannot put the earlier files back, the update stops. It puts the old version back and tells you.

On macOS, launchd reads a job file only when it loads the job. A changed job file makes the update unload the job and load it again.

### Updates from a phone

The service looks for a new release at intervals. When it finds one, it tells the paired phones of the owner, one time for each version. Team members get no such message.

The owner can check for an update and start it from a paired phone. A bot can do the same if you ask it to. No call names a version or an address. The service installs only the latest signed release.

The service has no permission to replace its own program, so it only makes a request. A root job (`botkins-update.service`) sees the request and does the same signed update. The link to the phone drops while the service restarts. When the link is back, the phone shows the result: the new version, or the reason that the update failed and the old version came back. `botkins status --json` shows the same result as `update.last`. The result stays there while it describes the version that runs.

If the update job stops because of an error in the program itself, it writes that as the result before it stops. The phone then shows the reason immediately, and you can ask for the update again.

The root job writes this result next to the versions in `/opt/botkins`, which only root can change. It writes nothing into the data folder. The only thing it does there is remove the request, and it does that as the `botkins` user.

### Install updates automatically

```sh
botkins config set updates.auto true
```

This setting is off by default. You can also change it from a paired phone. When it is on, the service installs a new release without a request. It uses the same signed update and the same rollback.

- The service waits until no bot is in a turn. A turn that waits for your approval or your answer is a turn, so the service waits for it too.
- The service looks again immediately before it asks for the install. The download then takes some minutes. A turn that starts in that time stops at the restart and continues after it.
- If a release does not stay in operation and the old version comes back, the service does not try that release again by itself. It tries the next release. You can still install that release with `botkins update`.
- If an install fails before the new version starts, the service tries again at its next check. Examples are a download that stops and a signature check that has no GnuPG. Such a failure tells nothing about the release. The service reports the same cause for the same release only one time.

The setting applies only to an installation from a release that runs as a service. A checkout and a Docker container do not update themselves.

## Docker

```sh
cd desktop
docker compose up -d
docker compose exec botkins botkins pair
```

Compose uses the image that each release publishes, `ghcr.io/promptclickrun/botkins`. It is the terminal host: one small Node service, with no display. The data is in the volume `botkins-data`.

- To use one release, set `BOTKINS_VERSION` in `.env`, for example `BOTKINS_VERSION=0.17.0`. Without it, Compose uses the latest release.
- To build the image from this checkout, run `docker compose up -d --build`.
- To update, run `docker compose pull`, then `docker compose up -d`. A container does not update itself. `botkins update` in a container tells you this, and so does a paired phone.

A phone cannot reach the address of a container. Before you start Compose, put the address of the server in `.env`:

```dotenv
BOTKINS_BIND_ADDRESS=192.168.1.20
BOTKINS_BIND_PORT=47610
BOTKINS_PAIR_ADDRESS=192.168.1.20
```

To keep the host key out of the data volume, give it as a Compose secret. The comments in `docker-compose.yml` show the lines.

The earlier setup, with an Electron workspace on a virtual display, is still there for a phone that must see and control a screen. Start it with `docker compose --profile display up -d host workspace`. The command names the two services, because a `docker compose up` without them also starts the terminal host. See [the display setup](../desktop/README.md). The two setups keep separate data. Run only one of them.

## Scripts and JSON

Each command accepts `--json`. It then prints one JSON document, which is the value from the service. A command that follows a stream (`logs -f`, a sign-in) prints one JSON line for each item.

```sh
botkins status --json
botkins devices list --json
botkins bots list --json
```

If a command fails, it prints one sentence on standard error. With `--json`, it also prints `{"error": {"message": "…", "code": "…"}}` on standard output.

| Exit code | Meaning |
|---|---|
| 0 | The command worked. |
| 1 | The command failed. |
| 2 | The command line is not correct. |
| 3 | The service does not run. |
| 4 | This user has no permission to talk to the service. |

Each command talks to the service through a Unix socket, `run/botkins.sock` in the data folder. To use a different data folder, add `--data-dir <dir>` or set `BOTKINS_DATA_DIR`.

## For agents

The command line has two readers: a person, and an agent that changes Botkins because its person asked. An agent is a bot of this host with a shell, or a coding agent that runs on the server. This part is for the second reader.

**Find a command without the source.** `botkins help --json` prints each command as data. `botkins help bots --json` prints one area, and `botkins help bots edit --json` one command.

```json
{ "botkins": "0.16.6",
  "usage": "botkins <command> [options]",
  "everyCommand": [{ "name": "--json", "takes": null, "about": "…" }],
  "exit": [{ "code": 0, "means": "Done." }],
  "areas": [{ "name": "bots", "summary": "…", "commands": [
    { "command": "bots edit", "path": ["bots", "edit"], "summary": "…",
      "usage": "botkins bots edit <bot> [--name <text>] …",
      "arguments": [{ "name": "bot", "required": true }],
      "options": [{ "name": "--instructions-file", "takes": "path", "about": "…" }] }] }] }
```

- An option with `"takes": null` is a switch. An argument with `"many": true` can be given more than one time.
- A command with `asks` puts a question to a person at a terminal. With no terminal it does not ask: it fails with exit code 2 and one sentence that names the flag that answers the question (`--yes`). Where `asks` is `--yes --revision` (`plugins install`, `update`, `enable` and `bots`), `--yes` alone is refused: give the revision that you looked at too. The sentence prints the whole command that works, with the `--all` or `--bot` that you gave.
- The shape is kept. Fields are added to it; a field is not renamed or removed.

**Use each command with no terminal.** Add `--json`: the answer is one JSON document on standard output, and a failure is `{"error": {"message": "…", "code": "…"}}` with a non-zero exit code. A long value comes from a file (`--instructions-file <path>`). Name a thing by its id when you have one; a name works when only one thing has it.

**A plugin's settings.** A caller on the socket or the command line gives values that it has (`--settings` or the hidden question). It cannot use a saved credential by reference: that is chosen in the app's window or on a paired phone, and the service refuses a `$credential` value for `plugins.install` and `plugins.configure`.

**A form field named `$credential`.** On `botkins chat respond`, a form field that is itself named `$credential` cannot be answered from the command line. That name is the mark of a reference to a saved credential, and the command line does not take one. Answer that question in the app's window or on a paired phone.

**An id or a value that starts with a dash.** Some ids are random text, and about one in 64 starts with `-` (a device's id, for example). The command line reads a word that starts with a dash as an option. One rule covers each command:

- Give an option's value with `=`: `--chat=<id>`, `--bot=<id>`, `--project=<id>`.
- Put a word that is not an option after `--`: `botkins devices remove --yes -- <id>`, `botkins devices rename -- <id> "Kitchen phone"`. Each option of Botkins comes before the `--`.

A caller that takes an id from a `--json` answer does both always, and then no id can be misread. When the command line refuses such a word, its sentence says this rule.

**A secret is never a word on the command line.** A command line shows in the process list and in the shell's history. A command that takes a secret reads it from standard input or from a hidden prompt (`botkins providers login <provider> --token`). No command prints one.

**A change leaves a line in the log.** Each call that changes something writes one line when it is done: `Changed from the command line: bots.edit Nova`. The line names the call and the thing. It never has a value. Thus a person can see afterwards (`botkins logs`) what an agent changed.

**What an agent can do here.** A program that runs as the service's user is the owner already (see the security model below). These commands give it nothing that it could not do. They make it easy and they put it on record.

### The rule that keeps the command line complete

What a person can do in the app's window, a person or an agent can do from a terminal, unless it needs the window itself. One table holds this: `desktop/desktop/terminal/coverage.mjs`. Each call that the window can make, and each call of the phone link, has one entry there:

- the command that does it, or
- one reason from a fixed list: it needs a window (a file dialog, the clipboard, a microphone), it is the window's own (a pane, a preview), it is a phone's own (its notifications, the screen it is shown), or it needs a person at the app (a call that reaches a secret which the terminal cannot read by itself, or sends one somewhere), or
- the part of the work that still owes its command. This third kind goes away when the last part is done.

The same table decides what the hidden `botkins call <name>` may reach. A call that a command covers is refused there, with the command's name: the command shows what it changes and leaves a line in the log. A call with a reason is refused with a sentence that says where it is done. Only a call that is still owed runs through `call`, and a few of those are held until their command is written: a call that takes a secret as an argument, a call that removes saved secrets with no question, `setVoice` with a provider's web address, `setChatProject` and `startProjectChat` with the mode `yolo`, and `setPreferences` with an approval level (`HELD` in `desktop/desktop/terminal/control.mjs`). Each goes when its command is merged. A refused call leaves the line of a failed call in the log, with the call's name and none of its arguments. When nothing is owed any more, `call` goes.

`test/terminal-coverage.test.mjs` reads the calls from a service that runs and from the link. It fails when a call has no entry, when an entry names a call that is gone, and when a command in the table no longer exists. So a new call in the window cannot ship without its command or a stated reason. The test's output says how many calls each part still owes.

## Security model

**Who can operate the service.** The control socket has mode 0600 and is in a folder with mode 0700. The two belong to the user that the service runs as. Only that user and root can connect, and the kernel checks this for each connection. The socket has no password and no network port. A user who can connect is the owner and can do everything that the window of the desktop app can do.

**What the service can touch.** The systemd unit for the whole computer runs the service as the user `botkins`. The service can write only to its data folder (`ProtectSystem=strict`, `ReadWritePaths=`). It cannot get new privileges (`NoNewPrivileges=`, no capabilities). It cannot see `/home` or `/root`, and it has its own `/tmp`. Bots do real work on the host: they write files and run tools. With this unit, they do that work in the data folder, or in a folder that you named with `--allow-path`.

**Secrets at rest.** Botkins keeps each credential in a vault, sealed with AES-256-GCM. The key of the vault and the private key of the phone link are wrapped with one more key, the host key. The location of the host key decides how much a copy of the data folder is worth:

| Installation | Location of the host key |
|---|---|
| Linux, whole computer | `/etc/botkins/host.key`, which only root can read. systemd gives the service a copy in memory (`LoadCredential=`). With `--encrypted-key`, the file is encrypted to the machine. |
| Linux, whole computer, where systemd cannot give a credential (some containers) | `/etc/botkins/host.key`, which root and the group `botkins` can read. The installer tells you when it uses this. |
| Linux, one user | `~/.config/botkins/host.key`, which only you can read. |
| macOS, one user | The login keychain (the item `Botkins Terminal Host`). |
| macOS, whole computer | `/etc/botkins/host.key`, which only the user of the service can read. |
| `botkins serve` in a terminal, and Docker without a secret | `host.key` in the data folder. |

This protects the secrets in a copy of the data folder that leaves the computer without the host key. Examples are a backup, a disk image of the data volume, and a folder that someone synchronized by mistake. If the host key is in the data folder, the wrapping gives almost no protection.

This does not protect against a person who is root on the computer while it runs. It also does not protect against a person who runs code as the user of the service. The service must hold the keys in memory to use them. No key store can do more than the accounts and permissions of the system do.

**The log.** The service does not write a pairing code, a token or a key to the log. As a second defense, the log replaces text that looks like a credential with `[hidden]` before it keeps a line. A sign-in session (its page, its code and the text that you type) is never in the log.

**The network.** The phone link listens on one port (47610 unless you change it). The link seals each message itself, between the phone and the host. A phone gets in only with a pairing code. With the relay on, the host makes one outgoing connection, and the relay sees only sealed messages.

**Updates.** The source of an update is fixed in the program. A chat, a setting or an environment variable cannot change it. The signature check uses the release key that came with the installed copy.

## What stays in the desktop app

The terminal host has no window and no screen. These features report "… is not available on this host." A phone and the terminal get that sentence, and nothing else fails.

- Viewing and controlling the screen from a phone.
- Unlocking a password manager, choosing one of its items, and linking a saved credential to a field of it. These are done in the app's window or on a paired phone, because the terminal host's socket cannot know that a person is there.
- The window of the app: side panes drawn in the app, HTML apps in their own window, the website viewer, and typing a saved credential into a page. A phone still draws side panes itself.
- File and folder dialogs, opening a file or a link on the computer, and the clipboard. A phone uses the calls that need no dialog.
- Desktop notifications. A paired phone still gets its notifications.
- Dictation and live voice in the window of the app. Voice on a phone still works.
- The iMessage and Mail tools for bots.
- Exporting the wiki as a PDF. The zip and HTML exports work.
- Picture thumbnails of files.
- Using the Botkins of a different computer from this one.

## Troubleshooting

Start with `botkins doctor`. It names most problems and prints the fix.

**`botkins` says that Botkins does not run here.** Run `botkins service status`. If the service is not installed, run `botkins service install`. If it stopped, read `botkins logs -n 50`, or `journalctl -u botkins -n 50` on Linux.

**An update says that a folder does not belong to root alone.** The service for the whole computer gets a new version only into an install folder that belongs to root alone. Each folder above it must be the same. Run the commands that the message shows, for example `sudo chown root /opt && sudo chmod go-w /opt`. `botkins doctor` shows the same problem as the line `Install folder`, and a paired phone shows the same sentence.

**`botkins update --check` says that GitHub does not answer this address.** GitHub limits the questions from one address. Try again later. Botkins 0.16.6 and earlier ask only the GitHub API, so they get this answer more frequently on a cloud machine.

**`botkins` says that this user has no permission to talk to the service.** The service belongs to a different user. For an installation for the whole computer, run the command with `sudo`.

**The service does not start after you changed `config.json`.** The file has a mistake. Run `botkins config edit`, or `botkins doctor` to see the mistake.

**The phone link does not listen.** A different program holds the port. Run `botkins config set link.port <port>`, then `botkins service restart`.

**A phone cannot pair.** The phone must reach one of the addresses in the pairing code. On the same network, check the firewall of the host for port 47610. From a different network, run `botkins relay on`, or set `link.addresses`.

**The service says that the host key is not the key of this data folder.** The data folder came from a different computer, or the key file changed. Put the earlier key back. To start again with new secrets, move `data/keystore.json`, `data/vault.json` and `data/link/link.json` out of the data folder. Then sign each provider in again, and pair each phone again.

**A provider shows "not installed".** Install the command-line tool of that provider on the host. Put it in a folder on the `PATH` of the service, such as `/usr/local/bin`. Then run `botkins providers list --refresh`.

**The relay stays "not connected".** The host needs outgoing HTTPS to `relay.botkins.app`. `botkins doctor` tests it.

**Memory.** At idle the service uses approximately 105 MB of resident memory. This is the value on Linux ARM64 with Node.js 24, for a default installation, one minute after the start. `botkins status` shows the current value. If you use only some providers, set `providers.only` to them, so that the service does not start the others.

## Uninstall

1. Remove the service: `sudo botkins service uninstall`. The data stays.
2. Remove the program: `sudo rm -rf /opt/botkins /usr/local/bin/botkins`.

CAUTION: The next step deletes your bots, chats, credentials and paired phones.

3. Remove the data, the key and the user: `sudo rm -rf /var/lib/botkins /etc/botkins`, then `sudo userdel botkins`.

For an installation for one user, the folders are `~/.local/share/botkins-terminal` (the program), `~/.local/bin/botkins` (the command), `~/.local/share/botkins` (the data) and `~/.config/botkins` (the key). On macOS the data is in `~/Library/Application Support/Botkins Terminal`, and the key is the keychain item `Botkins Terminal Host`.
