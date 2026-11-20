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
- `botkins plugins list`, `browse`, `install` and `uninstall` operate plugins.

A paired phone does everything else: tasks, the wiki, tools (MCP servers), skills, projects and credentials.

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

`botkins service install` installs the service again. It is safe to run it more than one time. It writes the service file again and does not change the data folder, the paired phones or the host key.

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

The command unpacks the new version next to the old version. Then it restarts the service on the new version and monitors it for 30 seconds. If the new version does not stay in operation, the command puts the old version back. The old version stays on the disk.

### Updates from a phone

The service looks for a new release at intervals. When it finds one, it tells the paired phones of the owner, one time for each version. Team members get no such message.

The owner can check for an update and start it from a paired phone. A bot can do the same if you ask it to. No call names a version or an address. The service installs only the latest signed release.

The service has no permission to replace its own program, so it only makes a request. A root job (`botkins-update.service`) sees the request and does the same signed update. The link to the phone drops while the service restarts. When the link is back, the phone shows the result: the new version, or the reason that the update failed and the old version came back. `botkins status --json` shows the same result as `update.last`. The result stays there while it describes the version that runs.

The root job writes this result next to the versions in `/opt/botkins`, which only root can change. It writes nothing into the data folder. The only thing it does there is remove the request, and it does that as the `botkins` user.

### Install updates automatically

```sh
botkins config set updates.auto true
```

This setting is off by default. You can also change it from a paired phone. When it is on, the service installs a new release without a request. It uses the same signed update and the same rollback.

- The service waits until no bot is in a turn. A turn that waits for your approval or your answer is a turn, so the service waits for it too.
- The service looks again immediately before it asks for the install. The download then takes some minutes. A turn that starts in that time stops at the restart and continues after it.
- If a release does not stay in operation and the old version comes back, the service does not try that release again by itself. It tries the next release. You can still install that release with `botkins update`.

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

The earlier setup, with an Electron workspace on a virtual display, is still there for a phone that must see and control a screen. Start it with `docker compose --profile display up -d`. See [the display setup](../desktop/README.md). The two setups keep separate data. Run only one of them.

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
