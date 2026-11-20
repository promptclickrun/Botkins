# Botkins on Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

One deployment creates a VM that runs Botkins with its own relay. When it finishes, open **Outputs** and open **pairingLink** on your phone, or open it on a computer and scan the QR code. Your phone pairs with the new server, and setup is done.

## What it creates

- An Ubuntu 24.04 VM (default `Standard_D2as_v6`) with Trusted Launch and automatic OS patching.
- A static public IP with an Azure DNS name: `<label>.<region>.cloudapp.azure.com`.
- A network security group that allows only 443 and 80 (80 is for the certificate check). SSH is closed unless you name an address to allow it from.
- On the VM: the Botkins host and workspace containers, the self-hosted relay (`mobile/relay/node`), and Caddy for HTTPS. Caddy gets a certificate from Let's Encrypt, and from ZeroSSL if you gave an email.

## The relay

Phones reach the server only through the relay on the VM itself. Messages are sealed end to end between the phone and the server, as with `relay.botkins.app`. The relay runs the same checks as the Botkins relay, because it shares their code (`mobile/relay/src/shared.ts`), and it passes the same protocol test suite (`npm run test:node` in `mobile/relay`).

One thing still uses Botkins' infrastructure: iPhone notifications. Only `relay.botkins.app` holds the Apple push key, so the VM forwards each signed, sealed notification there unchanged. Clear **Send iPhone notifications** to turn this off. Then nothing leaves the server for Botkins.

## Model providers

Both are optional:

- **Claude Code token**: run `claude setup-token` on a computer signed in to your Claude plan.
- **GitHub Copilot token**: a token for an account with Copilot access, for example from `gh auth token`.

The tokens travel in the VM extension's encrypted settings and are stored only in `/etc/botkins/providers.env` on the VM. That file is readable by root and the workspace container only.

## Managing the server

The VM has a `botkins` command. Run it with Azure Run Command, or over SSH if you allowed it:

```sh
az vm run-command invoke -g <group> -n <vm> --command-id RunShellScript --scripts "botkins pair" --query "value[0].message" -o tsv
```

| Command | What it does |
| --- | --- |
| `botkins pair` | Opens a new pairing code and prints its link. A code works once and lasts an hour. |
| `botkins status` | Shows the containers. |
| `botkins logs [service]` | Follows the logs (`host`, `workspace`, `relay`, `caddy`). |
| `botkins update [ref]` | Fetches the sources, rebuilds and restarts. |

Setup logs are in `/var/log/botkins-install.log`. The first build takes 10 to 15 minutes, because the VM builds the images itself.

## Costs and limits

- You pay for the VM, its disk and the public IP. Stop or delete the resource group to stop paying.
- Older VM sizes are often capacity-restricted in busy regions. If a size isn't available, pick another region or a v6 size.
- `cloudapp.azure.com` names share Let's Encrypt's per-domain limits with every other Azure user. Give a certificate email so the server can fall back to ZeroSSL.

## Building the template

`azuredeploy.json` is built from `main.bicep`. After editing the Bicep file or `install.sh`, rebuild it:

```sh
az bicep build -f main.bicep --outfile azuredeploy.json
```
