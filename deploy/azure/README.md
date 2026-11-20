# Botkins on Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

One deployment creates a VM that runs Botkins with its own relay. When it finishes, open **Outputs** and open **pairingLink** on your phone, or open it on a computer and scan the QR code. Your phone pairs with the new server, and setup is done.

## Two setups

The form has one choice that changes what runs on the VM.

| | Without Screen access (default) | With **Screen access** |
| --- | --- | --- |
| What runs | The [terminal host](../../desktop/docs/terminal.md): Botkins as one small service, with no display. | Botkins on a virtual display: the `host` and `workspace` containers of the [display setup](../../desktop/desktop/README.md). |
| From the phone | Bots, chats, tasks, tools, the wiki and settings. | The same, and the phone can see and control the server's screen. |
| Default VM | `Standard_D2als_v6` (2 vCPUs, 4 GB) | `Standard_D2as_v6` (2 vCPUs, 8 GB) |
| First build | A few minutes. | 10 to 15 minutes on 2 vCPUs, and a 5 GB image. |
| Memory when idle | About 120 MB for all containers. | About 320 MB for all containers. |
| Sign a provider in later | `botkins host providers login <provider>` on the VM. | On the server's screen, from the phone. |

Use the default unless a bot must use a desktop program, or you must see a sign-in page on the server. From the command line, the choice is the parameter `screenAccess`:

```sh
az deployment group create -g <group> --template-file azuredeploy.json \
  --parameters sshPublicKey="$(cat ~/.ssh/id_ed25519.pub)" screenAccess=true
```

The two setups keep separate data on the VM. If you run the deployment again with the other choice, the server changes to the other setup, and phones pair again.

## What it creates

- An Ubuntu 24.04 VM with Trusted Launch and automatic OS patching.
- A static public IP with an Azure DNS name: `<label>.<region>.cloudapp.azure.com`.
- A network security group that allows only 443 and 80 (80 is for the certificate check). SSH is closed unless you name an address to allow it from.
- On the VM: Botkins in one of the two setups, the self-hosted relay (`mobile/relay/node`), and Caddy for HTTPS. Caddy gets a certificate from Let's Encrypt, and from ZeroSSL if you gave an email.

The port of the phone link is not open to the internet in either setup.

## The relay

Phones reach the server only through the relay on the VM itself. Messages are sealed end to end between the phone and the server, as with `relay.botkins.app`. The relay runs the same checks as the Botkins relay, because it shares their code (`mobile/relay/src/shared.ts`). It speaks the same host protocols (`botkins.host.v3`, and `botkins.host.v2` for an older host), and it passes the same protocol test suite (`npm run test:node` in `mobile/relay`).

The Botkins host starts only when the relay answers over HTTPS (`wait-for-relay.sh`). A host offers the newest relay protocol on its first try, and falls back to the older one if that try fails. Without the wait, the first try on a new server comes before Caddy has its certificate.

One thing still uses Botkins' infrastructure: iPhone notifications. Only `relay.botkins.app` holds the Apple push key, so the VM forwards each signed, sealed notification there unchanged. Clear **Send iPhone notifications** to turn this off. Then nothing leaves the server for Botkins.

## Screen access

With Screen access, a paired phone sets what phones may do with the server's screen: **Off**, **View only**, or **View and control**. The level starts at Off. To change it, the phone asks for Face ID, Touch ID or the passcode, and the server checks a signature that the phone can make only after that.

A Botkins server normally accepts that change only from a phone on its own network, never through a relay. This VM has no such network, and its relay is its own. So this deployment tells the server that the relay is its own (`BOTKINS_RELAY_OWN=1`), and the server then accepts the same signed change through it. The relay cannot make the change itself, because it carries only sealed messages. See "How consent works" in [the display setup](../../desktop/desktop/README.md).

The phone app must be a build that knows this rule (it reads `screen-grant-relay-v1` from the server). An older build says that the level cannot be changed through the relay.

## Model providers

Both are optional:

- **Claude Code token**: run `claude setup-token` on a computer signed in to your Claude plan.
- **GitHub Copilot token**: a token for an account with Copilot access, for example from `gh auth token`.

The tokens travel in the VM extension's encrypted settings. They are not written to the setup log.

- Without Screen access, the setup gives each token to `botkins providers login <provider> --token` on standard input. The terminal host keeps it sealed in its credential vault. A token that the provider refuses is not kept, and the setup log says so. The image of the terminal host has no Claude Code, so the setup installs it into the data volume when you give a Claude token. To add it later, run `botkins install-claude`.
- With Screen access, the tokens are stored in `/etc/botkins/providers.env` on the VM. Only root and the workspace container can read that file.

## Managing the server

The VM has a `botkins` command. Run it as root, with Azure Run Command, or over SSH if you allowed it:

```sh
az vm run-command invoke -g <group> -n <vm> --command-id RunShellScript --scripts "botkins pair" --query "value[0].message" -o tsv
```

| Command | What it does |
| --- | --- |
| `botkins pair` | Waits until the server has reached its relay, opens a new pairing code and prints its link. A code works once and lasts an hour. |
| `botkins link` | Prints the link of the code that is open, if there is one. |
| `botkins status` | Shows the containers. Without Screen access it also shows the status of the terminal host. |
| `botkins logs [service]` | Follows the logs (`botkins` or `host` and `workspace`, `relay`, `caddy`). |
| `botkins update [ref]` | Fetches the sources, rebuilds and restarts. |
| `botkins compose …` | Runs `docker compose` on this deployment. |

Without Screen access, these also work:

| Command | What it does |
| --- | --- |
| `botkins host …` | Runs a command of the terminal host, for example `botkins host providers login copilot` or `botkins host doctor`. See [Run Botkins from a terminal](../../desktop/docs/terminal.md). |
| `botkins install-claude` | Installs Claude Code for the server. |
| any other command | Goes to the terminal host as it is: `botkins devices list`, `botkins bots list`. |

The setup the VM runs is in `/etc/botkins/botkins.env` (`BOTKINS_MODE=terminal` or `screen`). Setup logs are in `/var/log/botkins-install.log`. If `/etc/botkins/docker-compose.override.yml` exists, `botkins` adds it to its Compose files, so your own changes stay when the server updates.

## Check a deployment

`verify.mjs` does what a phone on another network does, with only the pairing link. It reads `/v1/health` over HTTPS, pairs through the relay, opens a session and makes calls. With `--screen` it also sets the screen level with a signed ticket and reads one picture of the display.

```sh
node deploy/azure/verify.mjs "<pairing link>"            # needs Node.js 24, and no npm install
node deploy/azure/verify.mjs "<pairing link>" --screen
```

A pairing code works once, so each run needs a new link from `botkins pair`.

## Costs and limits

- You pay for the VM, its disk and the public IP. Stop or delete the resource group to stop paying.
- The form offers the sizes that passed validation in `eastus2` when this was written: D-series v6 and v7. B-series and v5 sizes were refused there. If a size isn't available in your region, pick another region or size.
- `cloudapp.azure.com` names share Let's Encrypt's per-domain limits with every other Azure user. Give a certificate email so the server can fall back to ZeroSSL.

## Building the template

`azuredeploy.json` is built from `main.bicep`. After editing the Bicep file or `install.sh`, rebuild it:

```sh
az bicep build -f main.bicep --outfile azuredeploy.json
```
