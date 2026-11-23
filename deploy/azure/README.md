# Botkins on Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

This button makes one Azure VM that runs Botkins with its own relay. You can do all of it from your phone.

1. Tap **Deploy to Azure** and fill in the form. Only the VM name and the region are required.
2. Wait for the deployment to finish.
3. Open **Outputs** and tap **pairingLink**. The Botkins app opens and pairs with the new server. On a computer, open the link and scan the QR code with your phone.

You don't need an SSH key, and nothing has to download to your phone.

## Screen access

Without Screen access, the server has no screen. Your phone still does everything else: bots, chats, tasks, tools, the wiki and settings.

With **Screen access**, the server also gets a virtual screen with Google Chrome. Your phone can see that screen and control it. Use it when a bot opens a sign-in page that you must finish, or when you want to watch a bot work in the browser.

To use it after you pair:

1. On the phone, open **Settings › Screen**.
2. Choose **View only** or **View and control**. The phone asks for Face ID, Touch ID or your passcode first.

The level starts at **Off**. Every paired phone can see the screen while the level is on, so turn it off when you are done.

To change Screen access later, run `botkins-server screen on` or `botkins-server screen off` (see [Manage the server](#manage-the-server)). Paired phones stay paired, and your bots and chats stay.

From the command line, the choice is the parameter `screenAccess`:

```sh
az deployment group create -g <group> --template-file azuredeploy.json --parameters screenAccess=true
```

## What it makes

- An Ubuntu 24.04 VM with Trusted Launch and automatic OS patching. The default size is `Standard_D2als_v6` (2 vCPUs, 4 GB), with or without Screen access.
- A static public IP with an Azure DNS name: `<label>.<region>.cloudapp.azure.com`.
- A network security group that allows only ports 443 and 80. Port 80 is for the certificate check. SSH is closed unless you give a key and an address to allow it from.

On the VM, without Docker:

| Service | What it is |
| --- | --- |
| `botkins` | Botkins itself, from its signed release. It is the [terminal host](../../desktop/docs/terminal.md), so the `botkins` command works on the VM. |
| `botkins-relay` | The relay that phones connect through. It listens only on the VM itself. |
| `caddy` | HTTPS for the relay. It gets a certificate from Let's Encrypt, or from ZeroSSL if you gave a certificate email. |
| `botkins-display` | With Screen access only: the virtual screen (Xvfb, 1440×900). |

The port of the phone link is not open to the internet. Phones reach the server only through its relay.

## The relay

Messages between the phone and the server are sealed end to end, as with `relay.botkins.app`. The relay on the VM shares its code with the Botkins relay (`mobile/relay/src/shared.ts`), so it makes the same checks. It speaks the same host protocols (`botkins.host.v3`, and `botkins.host.v2` for an older host), and it passes the same protocol tests (`npm run test:node` in `mobile/relay`).

Botkins starts only after the relay answers over HTTPS (`wait-for-relay.sh`). Botkins offers the newest relay protocol on its first try, and uses the older one if that try fails. Without the wait, the first try on a new server would come before Caddy has its certificate.

Only iPhone notifications use Botkins' infrastructure. Only `relay.botkins.app` has the Apple push key, so the VM forwards each notification there, signed and sealed, without changes. Clear **Send iPhone notifications** in the form to turn this off. Then nothing leaves the server for Botkins.

### Why a phone can turn on the screen through this relay

A Botkins server normally lets a phone change the screen level only from its own network, never through a relay. This VM has no network that a phone can join, and its relay is its own. So the setup sets `relay.own` in Botkins' settings, and Botkins then accepts the same signed change through that relay. The relay can't make the change itself, because it only carries sealed messages. See "How consent works" in [the display setup](../../desktop/desktop/README.md).

The phone app must be a build that knows this rule: it reads `screen-grant-relay-v1` from the server. An older build says that the level can't be changed through the relay.

## Model providers

Both are optional. You can also sign in after you pair, from **Settings › Models** in the Botkins app.

- **Claude Code token**: run `claude setup-token` on a computer that is signed in to your Claude plan. The setup also installs Claude Code on the VM.
- **GitHub Copilot token**: a token for an account that has Copilot, for example from `gh auth token`.

The tokens go to the VM in the extension's encrypted settings, and the setup log doesn't show them. The setup gives each token to `botkins providers login <provider> --token` on standard input. Botkins keeps it sealed in its credential vault. If the provider refuses a token, Botkins doesn't keep it, and the setup log says so.

## Manage the server

The VM has two commands. Run them as root: with Azure Run Command, or over SSH if you allowed it.

```sh
az vm run-command invoke -g <group> -n <vm> --command-id RunShellScript --scripts "botkins-server pair" --query "value[0].message" -o tsv
```

In the portal, open the VM, then **Run command › RunShellScript**.

`botkins-server` manages this server:

| Command | What it does |
| --- | --- |
| `botkins-server pair` | Opens a new pairing code and prints its link. A code works once and lasts an hour. |
| `botkins-server link` | Prints the link of the open code, if there is one. |
| `botkins-server status` | Shows the services and the status of Botkins. |
| `botkins-server logs [service]` | Follows a log: `botkins` (the default), `relay`, `caddy` or `display`. |
| `botkins-server screen on` / `off` | Turns Screen access on or off. |
| `botkins-server update [ref]` | Updates this setup, the relay, Node.js and Botkins, then restarts them. |

`botkins` is Botkins' own command, the same as on any Linux server. For example: `botkins providers login copilot`, `botkins bots list`, `botkins devices list` and `botkins doctor`. See [Run Botkins from a terminal](../../desktop/docs/terminal.md). Botkins also tells your phone when a new release is out, and the phone can install it.

The settings of this setup are in `/etc/botkins-server/server.env`. The setup log is `/var/log/botkins-install.log`. Botkins' data is in `/var/lib/botkins`.

## Check a deployment

`verify.mjs` does what a phone on another network does, with only the pairing link. It reads `/v1/health` over HTTPS, pairs through the relay, opens a session and makes calls. With `--screen`, it also turns on the screen with a signed ticket and reads one picture of the display.

```sh
node deploy/azure/verify.mjs "<pairing link>"            # needs Node.js 24, and no npm install
node deploy/azure/verify.mjs "<pairing link>" --screen
```

A pairing code works once, so each run needs a new link from `botkins-server pair`.

## Costs and limits

- You pay for the VM, its disk and the public IP. To stop paying, stop the VM or delete the resource group.
- The form offers the sizes that passed validation in `eastus2` when this was written: D-series v6 and v7. B-series and v5 sizes were refused there. If a size isn't available in your region, pick another region or size.
- `cloudapp.azure.com` names share Let's Encrypt's limits per domain with every other Azure user. Give a certificate email, so the server can use ZeroSSL instead.
- Use `botkins-server` to change a running server. Running the deployment again also works, but it replaces the setup's settings with the ones in the form.

## A server from the earlier deployment

Earlier versions of this deployment ran Botkins in Docker. If you run the new setup on such a VM, it stops the Docker containers and keeps their volumes on disk. Phones must pair again. An earlier VM whose administrator is named `botkins` can't move to the new setup, because the Botkins service needs that name: make a new deployment.

## Build the template

`azuredeploy.json` is built from `main.bicep`, and it contains `install.sh`. After you change either file, build it again:

```sh
az bicep build -f main.bicep --outfile azuredeploy.json
```
