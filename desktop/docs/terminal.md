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

A bot uses a model from a provider: GitHub Copilot, Codex (ChatGPT), Claude Code, OpenCode, an agent that speaks ACP, or an endpoint that takes a key (OpenRouter, Azure Foundry, an OpenAI endpoint). Each provider signs in to your own account or key. You do not need a browser on the host.

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

Botkins keeps a pasted Claude or Copilot token in its credential vault and gives it to the tool when the tool starts. Codex and OpenCode keep their own. A new token replaces the one that Botkins keeps, and the old one is lost, so that asks first; with no terminal it needs `--yes`.

### OpenRouter, Azure Foundry and an OpenAI endpoint

These three answer on a key and have no program or sign-in page. They are off until a key and settings are complete, and then they switch on by themselves. A bot's turn on one of their models runs in a harness (Pi or OMP, or the Copilot runtime; `botkins preferences harnesses`), which sends its requests to a gateway on this computer. The gateway adds your key. The key stays in the vault and never reaches the harness, the log or a `--json` answer.

| Provider | Key | Settings (`botkins providers set`) |
|---|---|---|
| `openrouter` | An OpenRouter key (`sk-or-…`), made at openrouter.ai/keys. | None. Its models are those on OpenRouter that can call tools. |
| `foundry` | The key of your Azure resource. | `--endpoint` (the resource's address, for example `https://NAME.services.ai.azure.com`, `https://NAME.openai.azure.com` or `https://NAME.cognitiveservices.azure.com`; kept as `<address>/openai/v1`), `--api-version` (only for an older route; not sent when empty) and `--model` for each deployment. |
| `openai-api` | An API key. A server on this computer or your own network needs none. | `--base-url` (https; http only for `localhost`, a private address or a `.local` name), `--api responses` or `completions` (the usual is `responses`), and `--model` for models that the server's own list (`GET /models`) does not show. |

```sh
botkins providers set foundry --endpoint https://NAME.cognitiveservices.azure.com --model DeepSeek-V4-Pro --model o-x=responses
printenv AZURE_KEY | botkins providers login foundry
botkins providers set openai-api --base-url http://localhost:11434/v1 --model llama3.3
```

- **`providers set` changes only what you give.** `--model <id>[=<api>]` can be given again for each model and replaces the whole list; `--model-name <id>=<name>` names one of them; `--clear-models` empties the list. A model speaks Chat Completions unless you give `=responses` (or the provider's `--api`, for an OpenAI endpoint). At most 50 models; an id has letters, digits and `. _ : / @ + -` (a deployment's name is allowed as it is).
- **A key goes to the address that is set.** So changing the address while a key is kept shows where the key will go and asks first (`--yes` with no terminal). Set the address first and the key after, and nothing is asked.
- **`providers login <provider>` takes the key** from a hidden question or standard input (it is `--token` for these without saying so). `providers logout` removes the key and keeps the settings. `providers list` says what is still missing. `providers list --json` has `keyed` with the settings, whether a key is kept and what is missing; never the key.
- **A scratch copy** (a data folder of its own, `botkins --data-dir <folder>` or `BOTKINS_DATA_DIR`) keeps the settings in `<folder>/data/keyed/<provider>.json` and the key in that folder's own vault, apart from any other Botkins.

To sign a provider out, run `botkins providers logout <provider>`. It removes the token that Botkins keeps and the provider's own sign-in, so it asks first; with no terminal it needs `--yes`. If the system keychain refuses to remove a shared Copilot login, Botkins disconnects from it locally. That choice survives a host restart. Other apps can still use the shared login. To see the models, run `botkins models`.

`botkins models --speed fast` sets the global speed. Add `--bot <bot>` or `--chat <id>` to override it. Choose `off`, `fast`, or `ultrafast`, or use `inherit` to clear a bot or chat override. A chat’s explicit choice wins over its bot’s choice, including Off. Fast and Ultrafast use your plan allowance much faster. Models that cannot use the requested speed run at standard speed.

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

- `botkins bots edit <bot>` opens the bot in your editor. With `--name`, `--role`, `--instructions`, `--instructions-file` or `--model`, it changes that field directly. `--reading-provider`, `--reading-model`, `--reading-voice`, `--reading-speed`, `--live-provider`, `--live-model` and `--live-voice` give the bot a voice of its own over Settings › Voice (only what you name changes; an empty value goes back to Settings), and `--same-voice` takes it away. Keys stay in Settings › Voice.
- `botkins bots remove <bot>` removes a bot and its chats.
- `botkins routines list`, `run`, `pause` and `resume` operate the routines of your bots.
- `botkins plugins` installs and manages plugins. See "Plugins" below.

Every other part of the workspace has commands too: chats, routines, projects, tasks, the wiki, preferences, credentials, voice, spaces, sharing and the team. See "The rest of the workspace" below. A paired phone does the same things. Only a few steps need a person at the app: see "What stays in the desktop app".

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
- **A tool on the web that signs in is signed in from a terminal too.** `botkins tools sign-in <tool>` prints a page, and says what the sign-in is for and where the page is: `Sign in to <tool>, on login.example.com.` The host is the host of the first page only, as the service made it. Many sign-in pages send the browser on to another host. So the host is something to check, not a promise. Open the page on any device and sign in there. Then the browser goes to an address that starts with `http://127.0.0.1`. On another device than the host that page does not load. This is expected. Copy the whole address from the browser's address bar and paste it into the terminal. It is not shown when you paste it, because it holds a code. Paste only the address that your own browser was sent to, from a page that you opened from this output. The command then says which account the sign-in server names, if it names one, and that the tool is signed in. `botkins tools sign-in <tool> --cancel` ends a sign-in that is open. `botkins tools sign-out <tool>` forgets a sign-in. A tool that is a program has no sign-in: it gets its environment values (`botkins tools edit`).
- **With no terminal, the sign-in has two steps.** `botkins tools sign-in <tool> --start` prints the page (`open`), the host of the page (`host`), the start of the address to look for (`back`), the minutes that the sign-in waits (`minutes`) and the command for the next step (`next`). It leaves the sign-in open. `botkins tools sign-in <tool> --finish` reads the pasted address from standard input and waits for the end. The address is read from standard input, and never given as a word of the command line, because it holds a code. The plain form with no terminal and no flag is refused, and the sentence names `--start` and `--finish`.
- **How the pasted address is checked.** It must be the address that this sign-in named (the same place and the same path), with the `state` of this sign-in. The name of the sign-in server in it (`iss`) is checked when the server gives one, and a server that says it gives one must give it. The code works one time, and only with a secret that this computer made for this sign-in (PKCE). The sign-in waits for 10 minutes.
- **What is refused, and what ends the sign-in.** The command turns away an address of another place or path, an address with another `state` or none, an address with no code, text that is no address, and more than 8000 characters. It says why, and the sentence never repeats the address. The sign-in stays open: run `--finish` again with the right address (the error has the code `BAD_ADDRESS`). Three answers end the sign-in. An address with `error=access_denied` ends it as cancelled. An address with another error from the server ends it with that error. An answer in which the server names itself wrongly (`iss`) ends it too, and the code in it is never sent. The sentence then says that the sign-in is over and to start again. With no sign-in open, `--finish` is refused (the code `NO_SIGN_IN`) and says to start one. A sign-in that has its answer already refuses a second address (the code `ANSWERED`) and says to look at the result with `botkins tools show <tool>`.
- **The page is the key to the sign-in.** Anyone who opens the page can sign in at the provider with an account of their own. The provider then sends that browser to the return address with a code that fits the page. Whoever gives that address to `--finish` signs the tool in as that account. A bot with a browser tool and an account of its own can do all of this alone, and a person can be talked into pasting an address that "did not load". So open only a page from your own command's output. Paste only the address that your own browser was sent to. Read which account the last lines name.
- **Which account.** When the sign-in server's answer has an `id_token`, the command reads its `email` (the first 120 characters, without checking the signature) and prints `The sign-in server says that the account is "<email>".` The email is in quotes, and the words are the server's own. No other word is used. A name or a user name is chosen by whoever owns the account, so it can say anything, even the name of somebody else. When the answer has no `email`, the command prints `Botkins cannot tell which account this is. Check it at <host>.` The host there is the host of the first page only, so check the account at the sign-in server itself. Botkins asks no other server for it and does not keep the id token. The `--json` result has `account` only when there is an email, and `host`, and `again`.
- **A sign-in that replaces another.** When a sign-in was there before, the last line is `Signed in to <tool> again. This replaces the sign-in that was there.` and the log has `signed in again`.
- **Cancel.** `--cancel`, Ctrl-C and a hang-up of the terminal end the sign-in in any state: while it waits for the address, and also after the address was taken, while the token request is out. Nothing is written then, and an earlier sign-in stays. When the sign-in was done before the cancel came, `--cancel` says so (`finished: true` in `--json`) and does not say that it ended the sign-in.
- **`--no-input`.** With `--no-input` the command never asks a question, even at a terminal. The plain form fails at once and names the two steps. `--finish` reads the address from standard input when that is not a terminal. When it is a terminal, `--finish` fails at once and gives the example `botkins tools sign-in <tool> --finish < address.txt`. A pipe that is never closed makes `--finish` wait.
- **One port.** A sign-in that waits holds one port on this computer for up to 10 minutes. A tool that can use another port does so when its port is held: the port of a client that Botkins kept for this tool, or else one that the system gives. A tool that cannot (it has an approved client with a fixed return address, or a client ID that a person entered) takes the port in one of two ways. If the sign-in that holds the port is one that nobody follows (a `--start` that waits for its address, or a command that went away), the new sign-in ends it and takes the port. The ended sign-in says `This sign-in was ended: a sign-in to another tool needed its port. Start it again.` If a person follows the holder at that moment (a terminal reads it, the address is being given, or it is a sign-in in the window), the new sign-in is refused: `Another sign-in (to <tool>) is open on this computer and holds the port. Finish it or cancel it, then try again.` When another program holds the port, and the tool cannot use another one, the sentence says `Close what is using it and try again.` A client that Botkins registered for a sign-in that was then cancelled or timed out is kept, with no token, and the next sign-in to the same tool with the same return address uses it again.
- **One sign-in at a time for a tool.** The plain form (at a terminal) follows its sign-in. A second `tools sign-in` for a tool whose sign-in somebody follows is refused. One that nobody follows any more (the command went away, and nobody has read its sign-in for 45 seconds) is ended, and the new one takes its place. `--start` is different. It leaves the sign-in open for `--finish`, and nobody follows it on purpose, so nothing takes it over. A second `--start` for the same tool does not start a new sign-in. It gives the same page and the same `back` again, with `already: true` in `--json`. In text, its first line says that the sign-in is already open and how many minutes it stays open. The plain form is refused while such a sign-in is open, and the sentence names `--finish` and `--cancel`. `--cancel` ends the sign-in, and a new `--start` then makes a new page. While a terminal's sign-in for a tool is open (up to ten minutes), the window and the phone cannot start a sign-in for that same tool, and `--cancel` ends it. A sign-in for another tool is not held back by it (see "One port").
- **When the browser is on the host itself.** The sign-in can end with no pasted address, because the browser reaches the address on the computer by itself. The plain form then closes its question, drops what you typed, says that the tool is signed in, and ends with exit code 0.
- **The log has one line for a sign-in that is done.** It names the tool and says `signed in`, or `signed in again` when the sign-in replaces one: `Changed from the command line: tools.signIn words (signed in)`. A sign-in that is started, cancelled, turned away or timed out leaves no line. The name is the service's own record of the tool, never a word that the caller typed. Neither the page nor the pasted address nor its code is in the log or in the workspace's file.
- `botkins skills upload <file>` imports Markdown or a zip and enables each skill. To use the skills.sh catalog, run `botkins skills search <query>`, read `botkins skills preview <id>`, then use its ten-minute token with `botkins skills install <preview-token>`.
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
- **The service keeps the rule too.** It takes no install and no update that names no revision, from any caller. Its socket takes no switch-on of a plugin that runs commands on this computer that names no revision either. A switch-off and a switch-on of a plugin that runs nothing need none. The app's window and a phone switch a plugin on with no revision: they warn the person first.
- **This yes is a warning, not a block.** Botkins warns a person who switches a plugin on, and does not refuse them. The socket cannot know that a person is there, so the yes with the revision is how the warning reaches one. It refuses nobody who looked: `--yes --revision` always works. For the same reason `plugins add-folder` with no terminal adds a plugin that runs commands switched off.
- **An installed plugin has two revisions.** `plugins show` prints the one of the installed copy and the one of the source as it is now. `plugins enable --revision` takes the first. `plugins update --revision` takes the second.
- **`botkins plugins update <id>` says what changes** before it asks: the commands and the web addresses that are new, changed or gone, and the settings. It compares the two whole descriptions: also a hook's time limit and the order of the hooks, a tool's type, a header as written, a client id, a setting's default, what is not run, and the other files. It asks also when nothing runs on this computer, if the plugin reaches a new address, a tool on the web has another type, header or client id, or a setting that you gave goes to another place or has another default. Your saved settings stay with the plugin.
- `botkins plugins disable <id>` asks nothing.
- **Settings**: `botkins plugins configure <id>` asks for each setting at a terminal, says where its value goes, and does not show a secret one. From a script, give `--settings <file>`, a JSON file of `{ "KEY": "value" }`, or `--settings -` for standard input. A saved credential is chosen in the app's window or on a paired phone, not by reference from the command line: give the value itself. `plugins install --settings` for a plugin that runs nothing says where the values go; a secret that goes to an address on the web needs the yes (`--yes --revision`) as a plugin that runs commands does. No command prints a setting's value. `plugins show` marks the settings that have one.
- `botkins plugins bots <id> --all`, or `--bot <bot>` for each bot, says which bots have the plugin. It does not switch a plugin on.
- `botkins plugins add-folder <path>` adds a plugin from a folder of this computer. Botkins copies the folder and shows what it would run. A plugin that runs nothing on this computer is on at once. One that runs commands asks at a terminal if it goes on; with no terminal it is added switched off, and `plugins enable` switches it on with the revision. It is the only way to add a plugin folder.
- **`botkins plugins sign-in <id>` signs in a tool of a plugin that signs in.** It works as `botkins tools sign-in` does (the page, the address that the browser goes to, the two steps with no terminal, `--cancel`, `--no-input`), and the pasted address is checked in the same way. With one tool that signs in, that tool is signed in. With several, give `--tool <name>` (the tool's name in `plugins show`): the command refuses and lists the names. A plugin does not have to be switched on to be signed in. The installed copy is checked first, as a switch-on checks it: a copy that is not the one that was reviewed is refused, with the same sentence, from the command line and from the app. The log has `plugins.signIn` with the plugin's name and the tool's when the sign-in is done, and never the address.
- `botkins plugins sign-out <id>` forgets the sign-ins of a plugin's tools.
- **For a caller that reads `--json`:** what must be seen is on standard error. Show it to your person before you give `--yes`. Use the form that works for every id: `botkins plugins install --yes --revision=<revision> -- <id>`.
- A change that the computer refuses is in the log too, as "Tried from the command line: … (it failed)".
- A plugin's own words (its name, a command, an address) are printed with each character that hides or turns text written as its number, as `\u{202e}`.
- **A value that goes into a header.** `plugins configure --settings` and `plugins install --settings` ask before a value goes into a header to an address, whatever the plugin calls the setting. `--yes` then needs `--revision`, as for a plugin that runs commands.
- **A command that Botkins prints for you to run** has each word quoted for a shell when it needs it. An id that has a character that cannot be shown is not printed as a command: take it from `botkins plugins list --json`.
- Only the text of a plugin gets this care. A name that you gave (a bot's name in an error, or in the log) is printed as it is, with its emoji and its joiners. Only a control character and a mark that turns text around are written as a number.

## Apps (Composio)

Marketplace › Apps: the apps of your own Composio account. The computer's Composio tool (the tool at `https://connect.composio.dev/mcp`) does the work with its own sign-in, so the apps you connect are the ones your bots can use. Sign it in once: Sign in with Composio in the app's window, or `botkins tools add composio --url https://connect.composio.dev/mcp` and then `botkins tools sign-in composio`.

```sh
botkins apps list gmail
botkins apps connected
botkins apps connect gmail --wait
botkins apps accounts gmail
botkins apps remove gmail <account> --yes
```

- **`apps list [<search>]`** is Composio's public list, kept on this computer and checked again at most once an hour. `--category <id>` narrows it, `--categories` lists the categories, `--limit <n>` shows more. It needs no sign-in.
- **`apps connect <app>`** prints the page to sign in to the app on. Open it in any browser. With `--wait` the command ends when the new account is connected (ten minutes at most; Ctrl-C stops), and an account that was never finished is taken away again.
- **`apps connect <app> --chat <chat>`** presses Connect on the card a bot showed in that chat when it needed the app (`botkins chat list` gives the chat's id). The window, a phone and this command share one page for the app; with `--wait` the command follows the card until it is connected, and the chat goes on by itself.
- `apps accounts <app>…` shows each account with its id and whether it is connected. `apps remove <app> <account>` removes one from your Composio account, after a yes (`--yes` with no terminal).
- The log has `apps.connect` and `apps.remove` with the app's slug (and the chat's id for a card), never the page, an account or its email. Without the tool's sign-in, each command but `apps list` says "Sign in with Composio first."

## The rest of the workspace

Each thing that the app's window manages has commands too. Each command has `--help`, works with `--json`, and asks no question when there is no terminal.

### More of a bot, and templates

A bot has a place in the list, flags, a memory and, if you like, a section. A **template** is a bot's setup without its history: its name, role, about text, instructions and look. An **agent** is a helper that a model provider already has (for Copilot, a file in `~/.copilot/agents`) and that can become a bot.

```sh
botkins bots duplicate Nova
botkins bots order Orbit Nova
botkins bots primary Orbit
botkins bots flags Nova --pin --no-teamwork --section Work
botkins bots sections add Work
botkins bots memory Nova
botkins bots memory Nova --file memory.md --yes
botkins bots import
botkins bots import Reviewer
botkins templates save Nova --name "Research starter"
botkins templates export "Research starter" --file starter.json
botkins templates import starter.json
botkins templates browse inbox
botkins templates show inbox-sorter@botkins
botkins templates use inbox-sorter@botkins --name Sorter
```

- **`bots duplicate <bot>`** makes a copy named `<name> copy`. It has the same role, instructions and model. It has no chats and no memory yet.
- **`bots order`** lists the bots in their order. `bots order <bot>…` puts the bots that you name first, in the order that you give them. The other bots follow in the order they have. The first bot is the primary bot. `bots primary <bot>` makes one bot the first. The primary bot is never hidden.
- **`bots flags <bot>`** shows the flags. `--pin` and `--unpin`, `--hide` and `--show`, `--teamwork` and `--no-teamwork` (whether other bots may ask this bot for help), `--section <section>` and `--no-section` change them. Only what you name changes. `bots sections list`, `add`, `rename` and `remove` keep the sections. `sections remove` asks first. Its bots stay, in no section.
- **`bots proactive <bot>`** shows or changes a bot's Proactive agent (experimental): `on` or `off`, how often it checks, looks around and may alert, where alerts go, what it watches and your rules. It is its own bullet under Preferences below. The log says `bots.proactive.set <bot>` and never the rules.
- **A long text comes from a file or standard input.** `bots memory <bot>` prints a bot's memory. `--json` gives the text as it is. `--file <path>` replaces the memory with the text of a file, and `--file -` reads standard input. `--clear` clears it. A memory that has text is gone after a replace, so the command asks first. With no terminal, and when the text comes from standard input, it needs `--yes`. The log names the bot and never the text.
- **`bots import` lists the agents** of the providers that are on, and whether each one is a bot already. `bots import <agent>…` makes a bot of each agent that you name, by name, by the start of a name or by its key (`copilot:Reviewer`). An agent that is a bot already is left out. The bot is a copy: later changes to the agent do not reach it.
- **Words from elsewhere are shown first.** An agent's instructions, and a template file, steer a bot. So `bots import <agent>` and `templates import <file>` print the whole text first: the name, the role, the model, the file the agent comes from, and the instructions. Then they ask. With no terminal they fail and name `--yes`. The text is printed on standard error with `--yes` and with `--json` too. A template that is imported is saved as a template only. No bot is made.
- **A text that is shown has each character that hides or turns text written as its number**, as `\u{202e}`. This holds for memory, instructions and templates in the text form. `--json` has them as they are, and so has a file that `templates export --file` writes.
- **`templates`** keeps the templates. `save <bot>` saves a bot's setup (`--name` gives another name). `list`, `show`, `rename` and `remove` work as their names say. `export <template>` or `export --bot <bot>` prints the file, or writes it with `--file <path>`. An existing file is replaced only after a yes. The file holds the name, role, about text, instructions and look, and nothing of the bot's folders, chats or credentials. The app keeps a copy of an export among the bot's files, as it does for a phone.
- **Agent templates in the marketplaces.** `templates browse [<search>] [--category <id>] [--marketplace <id>]` lists what Marketplace › Agents shows, with each template's id (`name@marketplace`). `templates show <id>` shows one with its instructions. `templates use <id>` makes a bot from it, as Install and then Create a bot do in the window: it shows the whole template first and asks (with no terminal it needs `--yes`); `--name` gives the bot another name.
- **A removal needs the whole name or the id.** `sections remove` and `templates remove` ask first, and with no terminal they need `--yes`. They do not take the start of a name, so a short word does not remove something else. The other commands take the start of a name when only one thing has it, and name the matches when more than one does.
- The log has one line for each change, by the name of the bot, the section or the template (`bots.order` has no name): `bots.duplicate`, `bots.order`, `bots.primary`, `bots.flags.set`, `bots.memory.set`, `bots.sections.add`, `bots.sections.rename`, `bots.sections.remove`, `bots.import`, `templates.save`, `templates.rename`, `templates.remove`, `templates.export`, `templates.import` and `templates.use`.

### Chats

`botkins chat <bot>` talks to a bot. `botkins chats` keeps the chats that the Chats page of the window shows.

When the bot asks for an approval in `botkins chat`, the command shows the request on standard error and asks at a terminal. With no terminal it refuses the request: no flag approves one. A person approves a request at a terminal, in the app's window or on a phone. The service's call `chat.respond` refuses a yes (`approve`, `remember`) without the mark `{ "agreed": true }`. A no, a cancel and an answer to a question need none. A bot must never answer a request that waits in a chat: the person does.

```sh
botkins chats list
botkins chats rename "Quarterly plan" "Plan for the third quarter"
botkins chats flags "Plan for" --pin
botkins chats regenerate-title "Plan for"
botkins chats fork "Plan for" --at 4
botkins chats react "Plan for" 4 👍
botkins chats group Nova Orbit --title "Launch team"
botkins chats project "Launch team" Website --mode plan
botkins chats queue "Plan for"
botkins chats send-now "Plan for" 1
botkins chats aside "Plan for" "What did we decide about the budget?"
botkins chats sections add Work
botkins chats sections set "Plan for" Work
botkins chats delete "Fork of Plan" --yes
```

- **A chat is named by its id or by its title.** The title can be all of it or the start of it, when only one chat starts so. When more than one chat matches, the command lists them with their ids. `botkins chats list` shows ids and titles, and `--json` gives each chat's flags, project, mode and section too. A title is text that someone wrote, so in text form it is made safe before it is printed.
- **`chats regenerate-title <chat>`** uses the same summarizer as **Regenerate title** in the chat menu. It works even with auto-summarize off and doesn't add a turn or change the automatic naming setting.
- **Delete cannot be undone, so it asks first.** `botkins chats delete <chat>` shows the chat and asks. With no terminal it fails and names `--yes`. A chat that is working is refused: stop it first. Deleting a section is asked the same way, but it keeps its chats.
- **Three commands start a turn of a model.** `chats retry` sends the message of a stopped or failed turn again, `chats compact` asks the model to summarize the conversation, and `chats aside` asks a side question, as `/btw` does on the phone. Each uses the chat's provider and counts against its plan. `chats aside` does not add the question or the answer to the chat. `chats send-now` can start one too, when the chat is free. `chats retry <chat>` sends the chat's latest turn again (`botkins chats show <chat> --json` names it in `latestTurn`), and refuses a chat that is working.
- **A long question comes from `--file <path>` or from standard input.** `botkins chats aside <chat> -` reads the question from standard input.
- **`--mode yolo` gives a chat a yes to each request, so it asks.** `botkins chats project <chat> <project> --mode yolo` makes each request of the bot in that chat get a yes with no question, but for a request that leaves the sandbox. The command first shows the chat (title and id), the project and its folder, and that sentence, on standard error. Then it asks. With no terminal it fails and names `--yes`. The text is shown with `--yes` and with `--json` too. A chat that asks the person first shows this very command on its card before it runs. The same holds for a chat that is in `yolo` and moves to another project. `--mode default` and `--mode plan` ask nothing, and so does taking a chat out of `yolo`. Without a project and without `--none`, only the mode changes. A project with no folder takes no mode.
- **Pin, archive and unread give no yes.** `chats flags` sets only those three flags, and none of them removes a question from a chat.
- **`chats fork --at <number>` counts messages from 0.** Without it, the new chat holds the whole conversation. A group chat cannot be forked.
- **A group chat has 2 to 6 bots**, each named once. Talk in it with `botkins chat <bot> --chat <id>`.
- **A waiting message is named by its number or its id.** `botkins chats queue <chat>` lists the messages that wait for the chat to be free. `chats unqueue` takes one out of the line. `chats send-now` moves one to the front and sends it.
- **The sections are yours.** They are kept by the phone link, and a paired phone shows the same ones. They change nothing about a chat. `chats sections order` puts the named sections first, in that order. If the link is not ready (it is still opening), the commands say so: try again in a moment.
- **The log names a chat by its id**, never by its title. A new section is in the log by its name. The line of `chats.project` has the mode that the chat has now after the id, for example `chats.project <id> (yolo)`.

### Routines

A **routine** is work that a bot does on a schedule, with nobody watching. Each routine has its own chat, where its runs are kept.

```sh
botkins routines when "0 9 * * 1-5" --timezone Europe/London
botkins routines add "Morning brief" --bot Nova --cadence weekdays --at 07:30 --timezone Europe/London --file brief.md
botkins routines show "Morning brief"
botkins routines edit "Morning brief" --at 08:00
botkins routines duplicate "Morning brief" --bot Orbit --name "Orbit's brief"
botkins routines remove "Morning brief"
botkins routines schedules
botkins routines schedule "Daily standup" 1 pause
botkins routines add "Disk check" --bot Nova --cadence daily --at 03:00 --script-file check.sh --follow-up --prompt "Warn me when the disk is over 90% full."
botkins models --routines claude/claude-sonnet-5-5 --effort low
```

- **A routine is named by its id or its name.** When two routines have a name, the command says which ones (their ids) and you use an id. `routines duplicate` gives the copy the same name unless you give `--name`.
- **`routines add` and `routines edit` show the whole routine before they save, and ask.** The bot will run it with nobody watching. The text has the bot, the schedule in words, the time zone, the next two times and the whole prompt. It goes to standard error with `--yes` and with `--json` too. With no terminal the command fails and names `--yes`.
- **A time says its zone.** `--timezone` takes a zone such as `Europe/London`. Without it the zone of the computer that runs Botkins is used, and the commands print it. `--json` gives each time in UTC (`next`) with the zone beside it (`timezone`).
- **A schedule is a kind with its fields:** `--cadence once` (`--date` and `--at`), `daily` or `weekdays` (`--at`), `weekly` (`--at` and `--days mon,wed`), or a cron line (`--cron "0 9 * * 1-5"`, which means `--cadence custom`). `routines edit` changes only the part you name: `--at 10:00` moves a daily routine and keeps the rest. A new `--cadence` replaces the schedule, so give its fields. A field that the kind does not have is refused.
- **`routines when` says what a schedule means.** It takes the same options, or a cron line as its one word, and prints the meaning, the zone and the next five times. It saves nothing.
- **A prompt is a long text.** Give it with `--prompt <text>`, with `--file <path>`, or on standard input with the word `-`. The prompt shown on a screen is made safe: a control character is written as its number. `--json` has the text as it is (`instructions`).
- **Where the result goes** is `--deliver routine` (the routine's own chat, the usual way), `none`, `chat` (with `--chat <chat>`, else the bot's latest chat), `feed`, `idea` or `goal` (with `--category`). `--quiet` stops the notification when a run ends, and `--notify` turns it back on.
- **A run can stay silent.** When a routine's reply is only `[SILENT]`, the run completes with no message, no delivery and no notification (the run keeps `silent: true`). A failed run still notifies. Ask for it in the prompt, such as "If nothing changed, reply with only [SILENT]." In direct and group chats, a bot that replies with only `[SILENT]` also leaves no message.
- **A routine can run a script in place of a prompt:** `--script <text>` or `--script-file <path>` (`-` reads standard input). The script runs on the computer that runs Botkins with no model, in your shell, in the bot's folder, for up to 10 minutes (Stop on the routine ends it sooner). With `--follow-up` the bot then follows the prompt, with the script's output and exit code; without it the script's output is the run's result. When the script exits 0 and its last line is `{"wakeAgent": false}`, the run ends there, silent: no model turn, no message and no notification. A watcher's script can check for news and only wake the bot when there is some. `routines edit` takes `--no-script` and `--no-follow-up`. The whole script is shown before it is saved. Only the computer's owner adds or changes a script: a bot's routine tools and a team member can't.
- **A routine can have its own model:** `--model <provider/model>` with `--effort <level>` (see `botkins models`); `routines edit --model default` goes back to the Default routines model. `botkins models --routines <provider/model>` sets the Default routines model, and `--routines none` clears it. A routine uses its own model, else the Default routines model, else its bot's, else the default model.
- `botkins routines show <routine>` shows one routine whole: the bot, the schedule, its next three times and its prompt. `routines pause`, `resume` and `run` are as before.
- **`routines remove` asks first.** It removes the routine, its chat and every run it kept. With no terminal it needs `--yes`. `routines pause` stops a routine and keeps it.
- **A chat can schedule a prompt for itself** (`/every` and `/after`). These are not routines. `routines schedules` lists them with a number for each. `routines schedule <chat> <number> pause|resume|delete` changes one, by the chat's id or title. Deleting asks first.
- The log has one line for each change, by the routine's name (`routines.add Morning brief`). It has no prompt. A change to a chat's schedule names the chat.
- A bot's own routine tool makes none that runs more often than every 15 minutes (and at most 25 for a bot). These commands do not stop such a schedule: `routines add`, `edit` and `duplicate` show a cost line for it (how often it runs, and that each run uses the model and can cost money) and need `--yes` with no terminal, and the socket calls refuse it unless the call carries `{ fastSchedule: true }`, which the commands send after the yes.

### Projects, to-dos, tasks and artifacts

A **project** keeps folders, a to-do list, chats and artifacts together. A **task** is work for a bot on the task board; the board belongs to the whole app, not to a project. An **artifact** is a file that a bot made or showed.

```sh
botkins folders
botkins projects add ~/code/site --name Site
botkins projects changes Site
botkins projects commit Site --message "Fix the header"
botkins projects chat Site --bot Nova
botkins todos add Site "Check the mobile menu"
botkins todos done Site 1
botkins tasks add "Write the release notes" --bot Nova --status ready
botkins tasks list --status review
botkins artifacts list --bot Nova
botkins artifacts read <artifact> --output ./notes.pdf
```

- Use `botkins projects folder <project> <add|remove|default> <path>` to manage the ordered list. `botkins projects clone <owner/repo> [--parent <path>] [--project <project>]` clones on this host, creating a project when none is given. The default parent is the host user's home directory.
- Save a project's mode with `projects edit <project> --mode plan` (or `default` or `yolo`). `projects chat` and `chats project` accept `--folder <path>`. A moved chat carries its transcript to the next session. `projects changes`, `diff` and `commit` also accept `--folder`.
- **A project's folder is a path on this computer.** It must be one that the window's folder chooser can show a paired phone: in the home folder of the user that runs Botkins, or on a plugged-in disk (`botkins folders` lists what you can choose). `projects add <folder>`, `projects edit --folder` use the app's own check and its own refusal; there is no second rule. A folder that has a project is not added twice. `projects edit --no-folder` takes the folder away.
- **`projects remove` asks first.** The question says what goes with the project (its to-do list, its list of attached artifacts) and that its chats stay, with no project. The folder and its files are not touched. With no terminal it needs `--yes`.
- **`projects commit` shows the files first and asks.** It prints the folder, the branch and each file that goes into the commit, then asks (`--yes` with no terminal). It stages every change in the project's folder (`git add -A`), so a project in a folder of a larger repository commits only that folder's files, and the files that were staged before. `projects changes` marks each file with whether a commit takes it. Git hooks do not run. The message comes from `--message <text>`, from `--file <path>` or `--message -` or `--file -` (standard input), or, at a terminal, from a question. If the changes are not the files that were shown, nothing is committed. The log has the project's name, never the message or the files.
- **`projects changes` and `projects diff` read the folder** with git, with the repository's hooks, filters and external programs switched off. A diff is made safe to show at a terminal; in a pipe and with `--json` it is as git wrote it.
- **`projects chat` opens a chat and sends nothing.** No turn of a model starts. The answer gives the command that sends the first message (`botkins chat <bot> --chat <id> -m <message>`); that starts a turn. `--mode yolo` gives more: each request of the bot in that chat gets a yes with no question, but for one that leaves the sandbox. So it asks. The command prints the project and its folder, the bot, and that sentence, then asks (`--yes` with no terminal, and with `--json`; the refusal names the flag). The block goes to standard error also with `--yes` and `--json`, so a caller's own record has it. The modes `default` and `plan` ask nothing. A project with no folder has no modes, so its chat opens in `default`. The log line has the project's name and `(yolo)`: `projects.chat Site (yolo)`. A project with a folder takes one bot, and a project with no folder can take a group of up to 6 (`--bot` more than once).
- **To-dos are a project's own.** Name a to-do by its id, its words, the start of its words, or its number in `botkins todos list <project>` (1 is the first). `todos remove` asks first. The log has the project's name, never a to-do's words.
- **A task has a lane.** The lanes are later, ready, working, review, blocked, done and archived. Only Botkins puts a task in working. **A task that is Ready and has a bot starts by itself** when the bot is free: a turn of the bot's model, in a chat of its own. `tasks start` does the same now. It says what starts, and a tool that needs an approval waits for a person. `tasks remove` asks first. The log names a task by its title (a title that is longer than 80 characters or has a line break is left out), never by its details.
- **`artifacts read` prints text and saves anything.** A text artifact (a text type, JSON, XML and the like) goes to standard output: exact in a pipe, made safe to show at a terminal, and the `text` field with `--json`. An artifact that is not text (an image, a PDF, a program) is never printed: give `--output <path>`. The file is written whole or not at all, and a file that is there already is replaced only after a yes (`--yes` with no terminal). An artifact is named by its id or its full path; `artifacts list --bot <bot>` shows both. `projects add-artifact` and `projects remove-artifact` change only the list on the project, not the file.
- **A name is found as in the other commands:** its id, then its exact name, then the start of a name when only one has it. When more than one matches, the error says which.

### The wiki

The wiki is a set of Markdown pages in sections (folders). You and your bots keep it. The app keeps earlier versions of each page.

```sh
botkins wiki tree
botkins wiki add "Launch plan" --folder projects --file plan.md
botkins wiki show projects/launch-plan > plan.md
botkins wiki save projects/launch-plan --file plan.md --base 3f9c1a2b7d4e5f60
botkins wiki search launch friday
botkins wiki history projects/launch-plan
botkins wiki restore projects/launch-plan 1732190000000-You --yes
botkins wiki move projects/launch-plan archive/launch-plan.md
botkins wiki export --format zip --output ~/Documents
```

- **A page is named by its path**, as `wiki tree` prints it: `projects/launch-plan.md`. The `.md` and the letter case may be left off. A title works when only one page has it. If two pages have it, the command lists their paths. A section is named by its path too (`wiki move`, `wiki remove`, `wiki add --folder`).
- **`wiki show` prints the page as it is.** The text goes to standard output and nothing else does, so a pipe or a file gets the page. A note with the revision goes to standard error. A page is a person's or a bot's text, so a terminal that shows it can be moved or changed by what it holds. `wiki version` prints an earlier version the same way. The titles in `wiki tree`, `wiki search` and `wiki history` are made safe: a control character is written as its number. `--json` has every value as it is.
- **The text of a page comes from a file or from standard input.** `wiki add` and `wiki save` take `--file <path>`, and `--file -` reads standard input. Without `--file`, `wiki add` makes the page from the section's template, and `wiki save` at a terminal opens your editor with the page. With no terminal, `wiki save` with no `--file` is refused and names `--file`. `wiki add --for <project>` makes a page from a project's record (its name or id).
- **A save can check that nobody changed the page.** `wiki show --json` has the page's revision as `base`, and the plain `wiki show` prints it on standard error. Give it back with `wiki save --base <revision>`. If the page changed since, nothing is saved, and the refusal says to read the page again for its current revision. Without `--base`, the save replaces the text. The old text is kept as a version, so a save can be undone with `wiki restore`. The editor form always checks.
- **`wiki history <page>` lists the versions**, newest first, each with an id. `wiki version` and `wiki restore` take the whole id or the start of it. The app keeps 20 versions of a page. A restore keeps the text the page had before it.
- **A removal and a restore ask first.** `wiki remove` (a page, or a section with its pages) and `wiki restore` ask at a terminal. With no terminal they print what they would do on standard error, fail, and name `--yes`. A removed page is kept in the `.trash` folder inside the wiki's folder, with its versions. No command brings it back: copy it out of that folder.
- **`wiki move <page or section> <new path>`** takes the whole new path (`archive/launch-plan.md`). The links to the page in other pages follow it.
- **`wiki export` writes the file itself.** The window's save dialog has no place on a command line. Give `--output <path>`: a file, or a folder that exists (the file then has the name that the app makes, such as `Wiki wiki export.zip`). A file that is there already is replaced only with `--yes`, or when you say yes at a terminal. `--scope all` is the whole wiki, the default with no page. With a page the default scope is `page`: the page and the pages that link with it. `--scope project` goes two steps of links out. `--list` shows the pages that an export would hold and why, and writes nothing. The formats are `zip` (Markdown files) and `html` (one web page). A PDF is laid out by the app's window and is not offered: export `html` and print it to PDF in a browser. The export is also kept among the artifacts of the first bot, as it is for a phone.
- Every command works with `--json` and with no terminal. A change leaves a line in the log with the page's path and never its words: `wiki.add`, `wiki.addFolder`, `wiki.save`, `wiki.move`, `wiki.remove`, `wiki.restore` and `wiki.export`.
- The wiki's own log (`log.md`) and the list of versions say "You" for a change made from here, as they do for the window. They do not tell a person from a bot. `botkins logs` shows which commands ran, and on which page.

### Preferences, usage, the cache and the Mac tools

```sh
botkins preferences show
botkins preferences set appearance.theme dark
botkins preferences set clarificationInstructions --file ask-first.txt
botkins preferences set teamwork on --yes
botkins usage show --days 7
botkins usage export --days 90 --output usage.csv
botkins cache clear --yes
botkins mac-tools status
botkins mac-tools set mail read --yes
```

- **`preferences` is the app's Preferences page. `config` is the host.** `botkins preferences` changes what the app's window changes: the theme, the approval level, the notifications, the side menu. `botkins config` changes the settings of this host, the service: its link port, its relay and its updates.
- **A preference is one of a fixed list.** `botkins help preferences set` lists each key, what it takes, and what it is. A key that is not in the list is refused, and the refusal lists the keys. A switch takes `on` or `off`. `autoSummarize` takes `off` or a number of turns from 5 to 30. A longer text (`clarificationInstructions`) comes from `--file <path>`, or from standard input with `-` as the value. The `background.*` keys are for the desktop app's window: this host stores them and does nothing with them.
- **A switch that gives bots more room is shown first.** Three keys do this: `approval` to a looser level (`ask`, then `read`, then `assisted`, then `all`), `access.allBots` switched on (every bot can use every project, and the grant of each bot no longer limits it), and `teamwork` switched on (a bot can bring other bots into a chat). `preferences set` shows what the new value gives, and needs your yes. With no terminal it fails and names `--yes`. What the value gives is printed on standard error also with `--yes` and with `--json`, so a person who reads the output sees it. A change that gives nothing more needs no yes: a tighter level, or one of these switches turned off. The iMessage and Mail tools are not a preference: they have their own command, `mac-tools`.
- **The call of the service has the same rule.** `preferences.set` refuses each of those changes unless the call carries `{ "agreed": true }` after the value, the mark of a caller that showed the person what it gives and got a yes. The command line gives it after your yes. A caller that is not the command line gives it only for the person.
- **`usage show` has the totals and the rows by model and by bot.** `--days` is 7, 30 or 90, and 30 is the usual. With `--json` it also has the numbers for each day. `usage export` writes one CSV row for each turn to standard output, or to the file of `--output`. A new file can be read by you only. A file that is there already is replaced only after your yes (`--yes` with no terminal). The plans and limits of the model providers are `botkins providers`.
- **`cache show` and `cache clear`.** The cache holds the bot menus that a chat offers when you type `/`, and the window's cache. This host has no window, so its cache is 0 bytes. `cache clear` asks first, and needs `--yes` with no terminal. The menus are built again at their next use.
- **`mac-tools` lets bots use iMessage and Mail, on a Mac only.** `botkins mac-tools status` shows the level of each tool (`off`, `read` or `interact`), whether the `imsg` program is installed, and which permissions macOS has given. `botkins mac-tools set <tool> <level>` changes one level. `on` is the same as `read`. A level that gives bots more than the one now shows what it gives first, on standard error also with `--yes` and with `--json` (the tools that bots get, and the program that Botkins runs: `imsg` for iMessage, `/usr/bin/osascript` for Mail), and needs your yes. With no terminal it fails and names `--yes`. The call `macTools.set` refuses such a level unless it carries `{ "agreed": true }` after the level, as `preferences.set` does. Off, and a lower level, need no yes. On a computer that is not a Mac the app's own answer is passed on as it is: `status` says that the tools work on a Mac only, and a level above `off` is refused with that sentence, with no question first.
- **`preferences harnesses` shows what can run a bot's turn.** The choice is the preference `harness`: `copilot` (one harness for every plan, the usual choice), `provider` (each provider's own tool), `pi` (the Pi program) or `omp` (the OMP program). The command shows each choice and which one is set, and for each program that is a harness of its own (Pi and OMP) whether it is installed. Change the choice with `botkins preferences set harness <choice>`; `botkins providers install pi` and `botkins providers install omp` install the programs.
- **The Proactive agent** is experimental. Enable the computer switch with `botkins preferences set proactive.enabled on`, then use `botkins bots proactive <bot> on`. Both commands show what enabling background checks allows and accept `--yes` for unattended use. The computer switch pauses all bots. Each bot also has its own switch in its profile.
- **Choose when it checks.** `botkins bots proactive <bot> --every <minutes>` accepts 15, 30, 60 or 120. `--watch runs,tasks,requests,context` selects wake triggers. Runs that need help, waiting tasks and unanswered requests are operational triggers. Personal context wakes the bot when its open goals, memories or recent conversations with the recipient change. It also allows the bot to plan one later check against specific facts. Quiet hours and `--max-alerts <n>` (3, 6, 10 or 20) limit automatic alerts. Existing watch selections are preserved on upgrade. `--watch none` disables change triggers. `--look-around <hours>` selects how often the owner's agent can check connected sources (0, 1, 2, 3, 6 or 12). Zero disables those reads. `botkins routines run <routine-chat-id>` checks now.
- **Choose what helps.** Set `--rules <text>` or `--rules-file <path>` (`-` reads standard input) and `--deliver chat|feed`. On a wake, the bot considers preparation, connections, guidance, opportunities and alerts. Each suggestion needs current evidence, a reason and a concrete next step. Private conversations and goals are scoped to the bot and recipient. Bot-wide memory and connected accounts are owner sources. A shared Feed falls back to private chat. Team members whose role manages the bot can set up their own agent from their phone or window.
- **Give feedback where the suggestion arrived.** Use 👍 or 👎 in chat, or the Feed card's up or down action. The command line offers `chats react` and `cards act`. Ratings teach the agent which interests and procedures to favor. A background check can finish quietly. Opening a message or leaving it unanswered supplies no training label.
- **Inspect the result.** `botkins bots proactive <bot>` shows the rated count, preferred and retired approaches, and a planned follow-up when one exists. `--json` also includes recent decisions, their scores and the latest held-out evaluation. The model proposes up to four ideas per wake. Botkins ranks them and delivers at most one. Two more positive than negative ratings promote a reusable combination of method, sources and steps. A two-vote deficit retires it. With at least six ratings, coordinate hill climbing fits the ranking weights to the older two thirds. A challenger must improve mean squared prediction error on the newest third to replace the ranking in use. The bounded history holds the last 80 delivered suggestions. `--reset` forgets the proactive settings, learned policy, skill history and scheduled follow-up for that bot.
- The log has `preferences.set` with the key, `cache.clear`, and `macTools.set` with the tool. Some lines also say the new value, because it says how many questions bots ask or how much room they have: `preferences.set approval to all`, `preferences.set access.allBots to on`, `preferences.set teamwork to on`, `preferences.set proactive.enabled to on`, and `macTools.set mail to read`. No other line has a value.

### Credentials, the vault, password managers and the rest of a provider

Botkins keeps three kinds of secret on this computer. These commands show that each exists, and never its value.

- **Saved credentials** (`botkins credentials`): a key, a login or a note that you saved. A phone keeps the same list.
- **The vault** (`botkins vault`): the keys, header values and sign-ins of your tools, and the token that `providers login --token` kept.
- **Password managers** (`botkins password-managers`): 1Password, Bitwarden and Proton Pass, which a saved credential can be read from.

```sh
printf '%s' "$GITHUB_TOKEN" | botkins credentials save "GitHub token" --website github.com
botkins credentials list
printf '%s' "$NEW_TOKEN" | botkins credentials edit "GitHub token" --yes
botkins credentials remove "GitHub token" --yes
botkins vault list
botkins vault remove "files · API_KEY" --yes
botkins password-managers list
botkins providers usage
botkins providers install codex
botkins providers disconnect opencode anthropic --yes
```

- **A value is never a word on the command line.** `credentials save` and `credentials edit` read the value from a hidden question at a terminal, or from standard input. A command line shows in the process list and in the shell's history. A value as a word, as an option, or in an environment variable is not taken. The command refuses it and does not repeat it.
- **No command, and no call of the service, gives a value back.** A list has the name, the kind, where it is read from, the website and the time. It does not have the value, the user name or the notes. `--json` has the same. The log does not have a value either: it has the call and the name (`credentials.save GitHub token`).
- **The socket cannot know that a person is there.** Whoever connects is the owner, and that is also a bot's shell. So a call that reaches a secret which the caller cannot read by itself, or that sends such a secret somewhere, is not for the socket. It stays where a person is known to be there: the window, or a phone with its owner check.
- **A saved credential gets a new value from here, and nothing else.** `credentials edit <credential>` asks first (`--yes` with no terminal), then takes the new value from a hidden question or from standard input. It has no option for a name, a website, a kind, a user name or a note, and the service refuses each of those fields for a credential that exists. A new label on a real secret could make a person pick it by mistake later. Another name, website or kind is set in the app's window or on a paired phone. From here, remove the credential and save it again. `credentials save` of a new credential, with a name that is not taken, keeps its fields.
- **A reference is refused.** A caller on the socket gives a value that it has. It cannot send a saved credential to a place that it chooses, so a `{ "$credential": … }` anywhere in these calls is refused. You choose a saved credential in the window or on a phone.
- **A name or an id.** A saved credential, a vault entry, a password manager and a model service are named by id, or by name when only one has it. When more than one has the name, the command lists the ids. A name is a name: `credentials save` refuses a name that is taken, so that a name always means one credential.
- **A saved credential is checked in the app's window or on a paired phone, not from here.** The check can read the value through a password manager's tool, so it reaches a saved secret, and it is not for the socket.
- **Removing shows what goes, and asks first.** `credentials remove` and `vault remove` write to standard error, also with `--yes` and with `--json`, the name of what goes, its kind and where it is used (never a value). `credentials remove`, `vault remove` and `providers disconnect` ask, and with no terminal they need `--yes`. Each leaves a line in the log with its name. `credentials remove` of a credential that is read from a password manager takes away the link only. The value stays in the manager.
- **The socket's own calls need the mark.** `credentials.edit`, `credentials.remove`, `credentials.vaultRemove`, `credentials.vaultReset` and `providers.disconnectService` refuse unless they carry `{ "agreed": true }` as the last argument. The commands give it after the yes. `credentials.vaultReset` needs a second word, as the command does: `{ "agreed": true, "eraseAllSavedSecrets": true }`. It refuses with a sentence that names both when one is missing. A caller that is not the command line gives it only for the person. `voice.key` needs it to replace or remove a key that is saved.
- **The reset of the vault needs one more flag.** Only a vault that this computer cannot open can be reset (for example, its key is on another computer, or the file is damaged). Every key and sign-in in it is then lost to Botkins and has to be entered again. The command first shows that, with how many there are of each kind. Saved credentials are kept apart and stay. The old file is set aside, renamed `vault.unreadable-<time>.json`, and not deleted. `botkins vault reset` says this and asks at a terminal. With no terminal it needs `--yes --erase-all-saved-secrets`, and `--yes` alone is refused. A vault that opens needs no reset, and the command says so. The log line says that the vault was reset.
- **A provider's tool is installed with its own command.** `botkins providers install <provider>` shows the exact command (`npm install -g @openai/codex`, for example) and asks. It runs in a shell on this computer, as the user that runs Botkins. With no terminal it needs `--yes`. The command comes from the provider: a caller cannot give another, and the service refuses a command other than the one it showed. What the command prints is shown as it runs, and `--json` gives it in `output`. It is for macOS and Linux.
- **What is covered by other commands.** `botkins providers login` signs a provider in with its own sign-in, with a pasted token (`--token`, from a hidden question or standard input), or, for OpenCode, with a model service's key or sign-in (`--service`, `--method`). `botkins providers logout` signs it out. `botkins providers usage [<provider>]` shows each connected provider's plan and what is left of its limits. It has no token, email or account id.
- **Not in the command line: unlocking a password manager, and what is in one.** The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone." So the master password of a manager, its vaults, its items and its fields, and the linking of a field to a saved credential stay in the window and on a paired phone. After an unlock, every caller of the socket (a bot's shell too) would be able to list what is in the manager, and a caller could save a field of it as a credential with a name that it chose. `botkins password-managers list` shows each manager's state, and `lock` locks one. Two more rules follow from that sentence. They are its working-out, not his words: a saved credential gets no new label from the socket, and `voice set` takes no address without its key.

### Voice

```sh
botkins voice show
botkins voice options tts elevenlabs
botkins voice set --tts openai --tts-voice alloy
botkins voice set custom --address https://speech.example.com/v1
echo "$OPENAI_KEY" | botkins voice key openai
```

- **A voice key is a secret.** `botkins voice key <provider>` takes the key from a hidden question at a terminal, or from standard input. It is never a word on the command line, never printed, and never in the log: the log names the provider only. `botkins voice show` says which providers have a key, never the key. Replacing or removing a saved key needs your yes (`--yes` with no terminal). The providers are `openai`, `azure`, `elevenlabs`, `gemini` and `custom`.
- **`voice set` changes the choices.** It sets the provider, model, voice, language and speed of speech to text (`--stt`), text to speech (`--tts`) and live voice (`--live`).
- **`voice set <provider> --address <url>` sets the address of a provider, and takes its key with it.** The providers that have an address are `openai`, `azure` (its endpoint) and `custom`. A key is for the address that it was given for, so the app removes the key that is saved for a provider whenever its address is set, changed or taken away (`--address ""`). The command shows that first, on standard error also with `--yes` and with `--json`: "The key that is saved for <provider> is removed. A key is for the address that it was given for. The command asks for the key for the new address next." It asks (`--yes` with no terminal). It sets the address, and then takes the key for it from a hidden question at a terminal, or from standard input. With no terminal and no key on standard input, the address is set, the provider has no key, and the command says so and names `botkins voice key <provider>`. An address is set on its own, not with the other options.
- **The call of the service has the same rule.** `voice.set` takes `providers` (the address of a provider) only when the call carries `{ "agreed": true }` after the choices, the mark of a caller that showed the person that the key goes and got a yes. Any other field that is, or could be, an address (`baseUrl`, `endpoint`, `host`, `region`) is refused. A caller with no mark could choose where the next key goes.
- **`voice options <kind> <provider>` can start a request with the saved key.** The kind is `stt`, `tts` or `live`. The lists of `openai`, `gemini`, `device` and (for speech to text) `elevenlabs` are built in, and no request is made. For the others this computer asks the provider, with the key that is saved for it: `elevenlabs` at `api.elevenlabs.io` (its voices, and for `tts` its models), `azure` with Speech at the endpoint or region that the app saved (its models and voices; `live` is built in), and `custom` at the server address that the app saved. For `live codex` the Codex program on this computer lists its voices. The caller gives no address: it is always the one that the app saved.
- The log has `voice.set` with the names of the sections that changed (`stt`, `tts`, `live`) and the provider of an address that changed (`openai address`), and `voice.key` with the provider. It never has a choice, an address or a key. `voice options` and `voice show` leave no line.

### Spaces and panels

A **space** is a named page of panels and cards on this computer. Every person has four: Today, Feed, Ideas and Goals. A **panel** is a page that a bot publishes in a space and refreshes: text, numbers, lists, tables, bars, or a custom view. An app panel also keeps a saved state and notes that people write. A **card** is a post of a bot in Feed, Ideas or Goals. From a terminal you are the owner: you see and change every space on this computer, also one that a team member made.

```sh
botkins spaces list
botkins spaces add "Reading"
botkins spaces show Reading
botkins panels new --space Reading --bot Nova --start checklist --refresh weekdays --at 07:30 "Books I want to read this month"
botkins panels list --space Reading
botkins panels show "Books I want to read"
botkins panels routine set "Books I want to read" --cadence weekly --days mon --at 09:00 --file refresh.md
botkins panels refresh "Books I want to read"
botkins panels move "Books I want to read" Today --before "Weather"
botkins panels set-state "Books I want to read" done '["Dune"]' --label "finished a book"
botkins panels note "Books I want to read" "Ask Sam for the next one"
botkins spaces ask Reading --bot Nova --panel "Books I want to read" "What is new in this panel?"
botkins cards list --kind idea
botkins cards act "Learn to bake" yes
botkins spaces remove Reading
```

- **A space is named by its name or its id.** A name is looked for among your own spaces first (every person has a Today), and another person's space is found by its id (`spaces list` shows it). A panel is named by its title or its id, and `--space` narrows a title that two spaces share. A card is named by its title or its id. When more than one matches, the error says which.
- **`spaces remove` shows what goes, and asks.** It deletes the space, each panel in it with its routine, its custom views and its notes, the chat of updates of each panel, and its cards. With no terminal it needs `--yes`. `panels remove`, `panels routine remove`, `panels remove-note` and `cards act <card> delete` ask in the same way. Today, Feed, Ideas and Goals cannot be renamed or deleted.
- **Four commands start a turn of a bot's model, which can cost money:** `panels new`, `spaces ask`, `panels ask` and `panels refresh`. None of them waits. Each prints the chat's id, and the work goes on in that chat (`botkins chats show <chat>`). A panel appears in the space when its bot publishes it.
- **A panel's routine runs its bot on a schedule, with nobody watching.** `panels routine set` and `panels new --refresh` show the routine as it will be (the bot, the schedule in words, the time zone, the next two times, and the prompt) and ask. The text goes to standard error with `--yes` and with `--json` too. With no terminal the command fails and names `--yes`. A schedule that runs more often than every 15 minutes (the limit of a bot's own routine tool) has one more line, the cost: each run uses one model turn. The socket refuses such a schedule unless the call carries `{ fastSchedule: true }`. `panels routine resume` asks in the same way for a schedule like that. `panels routine pause` stops a routine and keeps it. `panels routine remove` removes the prompt too, so it asks.
- **A schedule is a kind with its fields:** `daily` or `weekdays` (`--at`), `weekly` (`--at` and `--days mon,wed`), or a cron line. `panels routine set` takes `--cadence` or `--cron`; `panels new` takes `--refresh daily` or `--refresh "0 9 * * 1-5"`. A panel's routine repeats, so there is no one-time kind. `--timezone` is as for routines. The prompt of `panels routine set` is a long text: `--prompt`, `--file`, or `-`.
- **`panels set-state` is your own change to an app panel's saved state:** a key and a value (JSON when it is JSON, text when it is not, and `null` or `--remove` takes the key away), or a JSON object of keys with `--file`. It shows as the panel's last line, with `--label` if you give one. The host allows ten changes at once, then one a second. **`panels note`** writes a note (2,000 characters at most, 50 on a panel; five at once, then one every five seconds). `panels remove-note` takes a note by its id or its number in `panels show`; the owner can remove any note. It cannot be got back, so it shows the note and asks (`--yes` with no terminal).
- **A card answer is what the card's buttons do:** `cards act <card> read`, `done`, `clear`, `yes` (an idea: Let's do it), `goal <category>` (an idea becomes a goal), `notToday` (a goal), `up`, `down <reason>`, `delete`. The bot reads the answers to learn what helps.
- **What others wrote is made safe on a screen:** a space's or a panel's name, a panel's content, a note, a card. A control character is written as its number. `--json` has the text as it is, with each panel's blocks as the bot published them.
- The log has one line for each change: the space's name for a space, and the id for a panel or a card, never a title (a title is the bot's text). It never has a note, a value of a state, a routine's prompt or a message. A fast routine says so (`<id> (each 5 minutes)`). Sharing a space and the team have their own parts below.

### Sharing a space

A **space** is a page of panels. It is private until its maker shares it: with people the maker picks, with all members, or with anyone who has a **link**. These commands are the owner's own view, so `sharing list` shows every space of this computer, the spaces of members too. A space is named by its name or its id.

```sh
botkins sharing list
botkins sharing show Launch
botkins sharing set Launch --view Avery --edit Blake
botkins sharing set Launch --all-members --can view
botkins sharing link Launch
botkins sharing link Launch --off
botkins sharing links on
botkins sharing order Goals Launch
botkins sharing notify Launch daily
```

- **A link is a secret that is made to be handed on.** Anyone who has it can see everything on the space, with no sign-in. They can't change it. `sharing link` makes it and prints it on standard output, once, when it makes it, and nothing else does: `sharing list`, `sharing show` and `--json` say that a space has a link, and not what it is. The log names the space and `(link)`, never the link. `botkins sharing link <space> | pbcopy` keeps it off the screen. A space that has a link already gets no link from `sharing link`: the command says that a link is shown only when it is made. `--new` makes another and prints it, and the old one stops working. To copy a link that exists, use the app's window. `--off` makes the space private, and the link stops working. A link needs the relay to be on (`botkins relay on`).
- **Four changes make a space visible to more people, and each asks first:** a link (and `--new`), a space shared with all members (`sharing set --all-members`), picked people that add a person who cannot open the space now or give a person more to do (view to edit), and the team's switch that lets members make links (`sharing links on`). Each prints what it opens, and to whom, then asks. For picked people, the block says who is added and who gets more, compared with the space as it is now. With no terminal it needs `--yes`, and the refusal names the flag. The block goes to standard error also with `--yes` and `--json`. The service's own call refuses these four unless the caller says that it agreed, so a program on the socket cannot go round the question. Narrower changes (private, a list that only takes people away or gives them less, `links off`) ask nothing.
- **`sharing set --view` and `--edit` name every person who can open the space.** The list replaces the one the space had. The maker needs no mention. The app refuses a member whose role cannot open spaces. A space that was shared by link and gets another level loses its link.
- **`sharing links off` leaves the links that exist.** Members can not make new ones. Take one away with `sharing link <space> --off`. `botkins sharing links` with no word shows the switch, when the phone link says what it is. A phone link that does not say gets the answer that the switch is not known.
- **The order, the pins and Notify me are the owner's own.** `sharing order` puts the spaces you name first, in your order. `sharing pin` and `sharing unpin` change the pins. `sharing notify` is off, daily or all.
- **No command says that you opened a space or look at it now.** Those are what the window and the phone send as a space comes into view. A terminal is no device.

### The team

A **team** is the people who use this computer's Botkins with you. A person joins with an **invite** and you approve them. A **member** is in one **group**, and a group has one **role**. A role says which rights its members have (`agents`, `today`, `skills`, `mcp`, `plugins`, `settings`, each with actions such as `view`, `chat`, `manage`) and which bots they see. The phone link keeps the team; the window's Team page and these commands change the same thing.

```sh
botkins team show
botkins team roles save --name Reviewer --from Guest --allow today.use --all-bots
botkins team groups save --name Reviewers --role Reviewer
botkins team invite --group Reviewers --days 7 --uses 1
botkins team requests list
botkins team requests approve Sam
botkins team members move Sam Admins
botkins team members rename Sam "Sam Lee"
botkins team members remove Sam
botkins team chat invite "Launch plan" Sam
```

- **A member's bot runs on this computer.** A member's bot runs commands on this computer as the user that runs Botkins, so invite people you trust with it.
- **`team invite` prints the code and the link once, and nothing else does.** An invite's code is like a secret that is made to be handed on: whoever has it can ask to join. The command prints it in its answer (`--json` has `code` and `link`). `team show`, `team invites list` and the other lists give the invite's id, group, status, uses and end time, never the code or the link. The log names the invite by its id. To end an invite, `team invites revoke`. With the relay off, a typed code cannot find this computer: the answer says so, and the link works only where this computer can be reached.
- **An approval is always needed.** A code only lets a person ask. `team requests list` shows who waits, and `team requests approve` lets them in, in the group of the invite or the group named with `--group`. It shows who asks, the group, the role's rights and the bots they see, and asks (`--yes` with no terminal). `team requests deny` asks too.
- **A role that gives more room asks.** `team roles save` shows the role as it will be, and what changes against the role as it is, on standard error. A role that gets more rights or more bots, and a new role that has any, asks (`--yes` with no terminal). A change that only takes away asks nothing. Name a right as `<scope>.<action>`, such as `agents.chat`; `<scope>.all` and `all` give more; `--deny` of the first right of a scope (`view`, `read`) takes the whole scope, because the other rights need it. `--file` takes the same as JSON: `{ "name": …, "perms": { "agents": ["view", "chat"] }, "allow": […], "deny": […], "bots": "all" }`. `help team roles save` lists the rights.
- **A group or a member that moves to more room asks too.** `team groups save --role`, `team members move` and `team groups remove --move-to` show what is added when the new role has more than the old one. A move to less asks nothing.
- **A rename asks nothing.** `team members rename <member> <name>` gives a member another name of up to 60 characters (the words after the member make the name). It changes what the member may do in no way. The member and all of their devices take the name: it is the one in the team's people, in the window's chats and on the phone. The call is `team.renameMember`, and the log has the member's id, never the name.
- **Removes ask, and a remove takes a whole name or an id.** `team members remove` says what the member loses: their devices and their sessions at once, their place in chats, and that they need a new invite and an approval to come back. `team roles remove`, `team groups remove` and `team invites revoke` ask too. A role that a group has cannot be removed. The group Everyone cannot be removed. Other names are found as in the other commands: id, exact name, then the start of a name when only one has it.
- **The socket's own call needs the mark.** `team.saveRole`, `team.saveGroup`, `team.moveMember`, `team.removeGroup` (when the move gives more), `team.approve`, `team.deny`, `team.revokeInvite`, `team.removeRole`, `team.removeMember` and `team.inviteToChat` refuse unless they carry `agreed: true`, which the commands give after the yes.
- **The people in a chat.** `team chat list <chat>` shows who started a chat and who was invited. `team chat invite` and `team chat remove` change it. An invite makes the whole chat visible to one more person, so it shows who and which chat and asks (`--yes` with no terminal), and `team.inviteToChat` needs `agreed: true`. A person whose role cannot use the chat's bot cannot be invited: the link says so. The log names the chat's id and the person's id.
- **The log has ids, never names.** A member's name is what a person typed when they asked to join, so a log line has the member's, role's, group's, invite's or request's id.

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

### Add a gadget

A gadget is a small device with a microphone and a speaker that talks with a bot. It is paired over its USB cable, with no code:

```sh
botkins gadgets add /dev/ttyACM0 --wifi "Home network"
```

The command asks for the network's password and does not show it. It reads the gadget's key, pairs it, hands it the network and waits until the gadget reaches this host over Wi-Fi. Leave `--wifi` out for a gadget that already has its network. `--name` gives it a name and `--bot` the bot it talks with first.

- The gadget and the host must be on the same network. Phone access must be on (`botkins config set link.enabled true`).
- A gadget is one of your own devices: a bot may do in its chats what it may do in any of yours. Whoever holds the gadget can talk to your bots until you unpair it with `botkins devices remove`.
- `botkins devices list` shows a gadget with the kind `gadget`.

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
| `relay.own` | `false` | The relay at `relay.url` runs on this server, and phones can reach the server only through it. A phone can then turn on screen access through the relay. Use it only for a server like that. Needs a restart. |
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

The dashboard shows the service, the paired devices, the bots, the recent chats and runs, the routines and the log. Use the keyboard for everything. Press `?` to see the keys and `q` to quit. It needs a terminal of 80 columns and 24 lines or more. It uses no mouse, and it draws no color when `NO_COLOR` is set (a `>` marks the selected row, and `[ ]` marks the open list). With no terminal, or with `--json`, `botkins tui` refuses and says to use the other commands.

The six tabs (`1` to `6`) are the first screens of the dashboard. Each has a few one-key edits, listed at the bottom of the screen. The tabs show the service, devices, bots, chats, routines and log as they are now.

### Every command, from the dashboard

Press `:` on any tab to open the commands screen. This screen is a way in to the commands. It is not a second copy of them: the commands keep every rule.

```text
:            open the commands screen
enter        open the area, then the commands of the area, then one command
tab          in an area: switch between its state and its commands
r            in an area: read its state again
esc          back one step
```

- **The areas.** The first screen lists the words of the command line, each with its summary. The dashboard reads them from the command tree, the same tree that `botkins help --json` prints. A new command shows here with no change in the dashboard. The screen leaves out `tui` (this screen) and `serve` (it runs the service in the foreground and never ends).
- **The state of an area.** For an area with a list command (`bots list`, `chats list`, `routines list`, `projects list`, `plugins list`, `tools list`, `skills list`, `devices list`, `providers list`, `templates list`, `wiki tree`, and the same command of each other area that has one), the dashboard runs that command with `--json` and draws the rows. The text is made safe before it is drawn. The dashboard has no second reading of the workspace: what the list command says is what you see. The list reloads when something changes.
- **A change runs the named command.** Pick a command in an area. The screen shows its usage and options, and a line with the command written out, ready to change. If you picked a row in the state list first, the line has its name in the place of the first word (`bots remove Scout`). You write the options yourself. Press `enter` to run the line.
- **What happens when it runs.** The dashboard leaves its screen. The command runs in the same terminal, as if you had typed it in the shell, and it has the terminal as its terminal: a command that asks, asks; a hidden question stays hidden; what a command shows before a yes is shown. The dashboard shows the exit code when the command ends, and a key brings the dashboard back with the state read again.
- **The dashboard never answers for you.** It never adds `--yes` or any other flag, and it never answers a question of a command. If a command asks, you answer at the terminal, and a "no" changes nothing. If you write `--yes` in the line, that is your own yes.
- **Words in the line.** The line is split into words like a shell does for quotes: single quotes keep everything, double quotes keep everything but `\"` and `\\`, and a backslash makes the next character plain. Nothing is expanded: there is no `$VARIABLE`, no `~` and no wildcard. A leading `botkins` is dropped.

Left out on purpose:

- **Editors for long texts** (a bot's memory, a wiki page, a prompt, instructions). Use the command with `--file <path>` or standard input, or use the app window.
- **Screens of its own for a plugin's review.** `botkins plugins install`, `update` and `enable` show what a plugin will run, and ask. They do this the same way when the dashboard runs them.
- **Charts of usage.**

The one-key edits of the tabs (rename a device, add a bot, run a routine and the others) are older than the commands screen. They ask the service directly and ask their own yes. The commands screen is the way to every other change.

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

### A screen without Docker

On Linux, the terminal host shows a phone an X11 display that is already running: Xvnc, Xvfb, or Xorg with the dummy driver. Give the service `DISPLAY` and, when the X server needs one, `XAUTHORITY`. In a systemd unit, add `Environment=DISPLAY=:20` and `Environment=XAUTHORITY=/path/to/Xauthority`. The computer needs `xdotool` and either `ffmpeg` or ImageMagick (`import`). Then the phone's screen settings offer **View only** and **View and control**. A phone sets the level only on the server's own network, unless `relay.own` is on. The [Azure deployment](../../deploy/azure/README.md) sets all of this up. X11 asks for no permission. Anyone who can open the display can read it and type into it, so keep its authority file private.

For a fresh Debian VM, install the screen tools and a browser, then start Botkins on a private virtual display as the service user:

```sh
sudo apt-get install chromium xvfb xauth xdotool ffmpeg
xvfb-run -a -s "-screen 0 1440x900x24 -nolisten tcp" botkins serve
```

For an existing systemd service, put the same wrapper in a service override (`systemctl edit botkins.service`, or `systemctl --user edit botkins.service` for a user service). Under `[Service]`, clear `ExecStart=` and set it again to `/usr/bin/xvfb-run -a -s "-screen 0 1440x900x24 -nolisten tcp"` followed by the **existing service command and arguments** from `systemctl cat botkins.service`. Restart the service. Xvfb and Chromium then run under the service’s account and share its private temporary directory. The Compose display workspace already includes Chromium.

In a private owner chat, ask the bot to open the login page and use a saved credential. Its `browser_form` tool opens or inspects the page on the host screen and returns the site, path and visible field keys. The secure request lets you pick the saved password and approve the destination. Botkins fills the fields in that browser. You can finish the login on the screen and close the browser from the same chat. The browser uses a temporary profile and a private pipe. The bot needs no Python environment, pip package or WebSocket script.


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

**Sign a tool in with no terminal.** A tool on the web (and a plugin's tool) signs in through a browser, in two steps. Use `--start`, then `--finish` with the address on standard input and `--no-input`. `botkins tools sign-in <tool> --start --json` gives `open`, `host`, `back`, `minutes` and `next`. The page is the key to the sign-in: whoever opens it can sign in with their own account. So give `open` and `host` to your person, and let them open it and copy the address that their browser goes to (it starts with `back`, and the page does not load on another device: that is expected). If you open the page yourself, the tool is signed in as the account that you use, not as your person. Then run `next` with that address on standard input: `printf '%s\n' "$ADDRESS" | botkins tools sign-in --finish --no-input -- <id>`. Read the address from standard input, never from the command line: it holds a code, and a command line shows in the process list. With `--no-input` the command never asks a question and does not wait at a terminal. A pipe that is never closed makes `--finish` wait, so close it. The result has `account` (an email) only when the sign-in server names one, and `host` (the host of the first page only, to check, not a promise): say them to your person. With no `account`, Botkins cannot tell which account it is. A refusal with the `code` `BAD_ADDRESS` leaves the sign-in open, so run it again with the right address. The codes `ANSWERED` and `NO_SIGN_IN` do not: the sign-in has its answer already, or none is open. A second `--start --json` for an open sign-in gives the same `open`, `back` and `next` with `already: true`. For a plugin's tool use `botkins plugins sign-in <id> --tool <name>`. Neither the address nor its code is in the log.

**A secret is never a word on the command line.** A command line shows in the process list and in the shell's history. A command that takes a secret reads it from standard input or from a hidden prompt (`botkins providers login <provider> --token`). No command prints one.

**A change leaves a line in the log.** Each call that changes something writes one line when it is done: `Changed from the command line: bots.edit Nova`. The line names the call and the thing. It never has a value. Thus a person can see afterwards (`botkins logs`) what an agent changed. The desktop app keeps the same lines in a file, `<the app's data folder>/logs/botkins.log` (this user only, 5 MB, and 3 older files), so they stay after the app quits. `botkins logs` reads that file when the app is not running.

**A bot of this host has a skill for this.** The built-in skill `use-botkins` (`desktop/desktop/skills/use-botkins/SKILL.md`) teaches a bot this part of the guide: how to find a command, the rule for a yes, the rule for secrets, and what is done in the app's window. A bot is offered it only where its shell can run `botkins` (`reachable()` in `desktop/desktop/terminal/reach.mjs`). Where it cannot, the skill is off for every bot, and the list of skills (`botkins skills list --json`) gives it an `unavailable` field that says it needs the command line on this host. The rule for a yes, in one sentence: the bot runs the command with no `--yes`, shows its person the block as it is, and gives `--yes` (and the revision that was shown) only after they agree.

**Where a bot finds the command.** A bot's shell gets the environment of the process that runs it, and nothing else. When the host starts its control socket, it also makes a launcher, `<data folder>/run/bin/botkins`, and puts that folder at the front of `PATH` for every shell it starts. It sets `BOTKINS_SOCKET` to its own socket, so that the command talks to this host and no other. The launcher runs this installation's own command line with its own Node.js, and works whatever `PATH` the service's unit or job gave. The terminal host (`botkins serve`) does this, and so does the desktop app: its socket is `<the app's data folder>/run/botkins.sock`, mode 0600, with the same calls and the same refusals. It leaves out what only a service has: `stop`, the `config` calls, `relay on` and `relay off`, and `update` (an install). A trial run of the app has no socket, except the workspace container of the two-container host. If the socket cannot start, the app starts without it and writes one line to its log; a bot then has no `botkins` command. The app's launcher also sets `BOTKINS_LAUNCHED_BY=app` for its one command, so that `botkins status` and `botkins doctor` say "The Botkins app is not running. Open it." when the app is not there, not "Start it with `botkins service start`". `botkins doctor` runs `command -v botkins && botkins status --json` in a shell of its own, as a bot's shell would, and says "A bot's shell: Finds `botkins` at …, and it reaches this service". When a shell lacks the command, or reaches another Botkins, that line fails and says what is missing.

**What an agent can do here.** A program that runs as the service's user is the owner already (see the security model below). These commands give it nothing that it could not do. They make it easy and they put it on record.

### The rule that keeps the command line complete

What a person can do in the app's window, a person or an agent can do from a terminal, unless it needs the window itself. One table holds this: `desktop/desktop/terminal/coverage.mjs`. Each call that the window can make, and each call of the phone link, has one entry there:

- the command that does it, or
- one reason from a fixed list: it needs a window (a file dialog, the clipboard, a microphone), it is the window's own (a pane, a preview), it is a phone's own (its notifications, the screen it is shown), or it needs a person at the app (a call that reaches a secret which the terminal cannot read by itself, or sends one somewhere).

Nothing is owed. A new call of the app comes with its command, or with one of these reasons, in the same piece of work. There is no hidden `botkins call <name>`: it went when the last command was written, because nothing was left that a command did not reach. A call that a command covers is done by that command, which shows what it changes and leaves a line in the log. The service has no method `call`, and a request for one gets "The service has no call named call."

`test/terminal-coverage.test.mjs` reads the calls from a service that runs and from the link. It fails when a call has no entry, when an entry names a call that is gone, and when a command in the table no longer exists. So a new call in the window cannot ship without its command or a stated reason.

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

**The log.** The service does not write a pairing code, a token or a key to the log. As a second defense, the log replaces text that looks like a credential with `[hidden]` before it keeps a line. A sign-in session (its page, its code, the address that you paste for a tool, and the text that you type) is never in the log.

**The network.** The phone link listens on one port (47610 unless you change it). The link seals each message itself, between the phone and the host. A phone gets in only with a pairing code. With the relay on, the host makes one outgoing connection, and the relay sees only sealed messages.

**Updates.** The source of an update is fixed in the program. A chat, a setting or an environment variable cannot change it. The signature check uses the release key that came with the installed copy.

## What stays in the desktop app

The terminal host has no window and no screen. These features report "… is not available on this host." A phone and the terminal get that sentence, and nothing else fails.

- Viewing and controlling the screen from a phone, unless the service has an X11 display. See [A screen without Docker](#a-screen-without-docker).
- Unlocking a password manager, choosing one of its items, linking a saved credential to a field of it, and using a saved credential by reference. The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone." These need a person at the app, because the terminal host's socket cannot know that a person is there.
- The app window draws side panes, HTML apps and the website viewer. A phone draws its own side panes. On a Linux host with Chromium and an X11 display, the bot can fill an approved credential into the browser on that screen.
- File and folder dialogs, opening a file or a link on the computer, and the clipboard. A phone uses the calls that need no dialog.
- Desktop notifications. A paired phone still gets its notifications.
- Dictation and live voice in the window of the app. Voice on a phone still works.
- The iMessage and Mail tools work on a Mac only. `botkins mac-tools status` on another computer says so.
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

### Pi packages

Use `botkins pi browse [<search>]` to search the Pi marketplace. Use
`botkins pi show <package>` to see its exact version, then
`botkins pi install <package>` to install it and turn it on. A noninteractive
install takes `--yes --revision <version>`. The package can run code on this
computer. Botkins keeps it in its own Pi profile and loads it on the next
turn in every chat using the Pi or OMP harness.

`botkins pi list` shows installed versions and whether they are on.
`botkins pi disable <package>` turns one off and `botkins pi enable <package>`
turns it back on. Desktop and paired phones offer the same controls in
**Marketplace › Pi**.
