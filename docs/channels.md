# Channel Hooks

Publish a Botkins bot to external messaging channels so direct messages, allowed group mentions, or allowed channels trigger bot turns and send replies back to the same thread.

Supported channels:

- **Slack** — Socket Mode (outbound WebSocket, no public URL)
- **Telegram** — Long polling via `getUpdates` (no public URL)
- **Discord** — Gateway WebSocket v10 with Message Content intent (no public URL)
- **iMessage** — `imsg` CLI locally on macOS or via a paired Mac node host

All four transports connect **outbound by default** — no inbound tunnel, reverse proxy, or public URL is required. The adapter interface (`desktop/desktop/channels/types.mjs`) also leaves room for future webhook transports through the link server's `webhooks/<routeId>` ingress.

---

## Setup guides

### Slack (Socket Mode)

1. Open [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**.
2. Open **Socket Mode**, turn it **On**, and generate an **App-Level Token** with the `connections:write` scope (`xapp-...`).
3. Open **OAuth & Permissions** and add these **Bot Token Scopes**:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`, `im:read`, `im:write`
   - `channels:history`, `groups:history` (if you plan to enable group channels)
4. Open **Event Subscriptions**, enable events, and subscribe to bot events:
   - `app_mention`
   - `message.im`
   - `message.channels`, `message.groups` (optional, for group channels)
5. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).
6. In Botkins, open **Settings › Channels** (or run `botkins channels add slack --bot <bot>`), paste both tokens into the vault-backed prompt, and click **Test**.

### Telegram (Long polling)

1. Message `@BotFather` on Telegram and run `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. Copy the Bot Token (`123456:ABC-...`).
4. Optional: if you later enable allowed group channels and want the bot to see all messages rather than only commands/mentions, adjust `/setprivacy` with `@BotFather`.
5. Add the connection in **Settings › Channels** or run `botkins channels add telegram --bot <bot>`.

### Discord (Gateway WebSocket)

1. Open the Discord Developer Portal and click **New Application**.
2. Go to **Bot**, copy or reset the **Bot Token**, and enable **Message Content Intent** under **Privileged Gateway Intents**.
3. Under **OAuth2 › URL Generator**, check `bot` and grant:
   - `View Channels`
   - `Send Messages`
   - `Send Messages in Threads`
   - `Read Message History`
4. Open the generated invite URL to add the bot to your server.
5. Add the connection in **Settings › Channels** or run `botkins channels add discord --bot <bot>`.

### iMessage (`imsg` CLI — local Mac or paired Mac node host)

Botkins runs `imsg` directly with an argument array (never a shell), reusing binary discovery from `desktop/desktop/mactools.mjs`.

#### Option 1: Local Mac

1. Install the `imsg` CLI on the Mac running Botkins (for example `brew install steipete/tap/imsg`).
2. Grant **Full Disk Access** to Botkins (or your terminal/service) so `imsg watch` can read Messages history.
3. Add the channel in **Settings › Channels** (choose **This computer (local Mac)**) or run `botkins channels add imessage --bot <bot>`.
4. On the first outbound reply, macOS prompts *"Botkins wants access to control Messages"*. Click **Allow**. While blocked, Botkins reports status **`waiting_permission`** (*"waiting for macOS permission on local Mac"*) instead of hanging.

#### Option 2: Via a paired Mac node host (for Linux / cloud Botkins hosts)

1. Pair your Mac as a node host (`docs/node-host.md`) with `imsg` installed and Full Disk Access granted on that Mac.
2. On the Mac node host, ensure the node exec policy is not set to `deny` — the node automatically advertises `channel.imessage.watch` and `channel.imessage.send` in its capability list, gated by its grants and exec policy.
3. On the bot's host, configure iMessage in **Settings › Channels** and select the paired Mac node host (or run `botkins channels add imessage --bot <bot> --node <host-id>`).
4. Approve the node grant for `channel.imessage.watch` / `channel.imessage.send`. Inbound events stream over the same-owner encrypted `teamwork-peers` transport and replies run `imsg send --chat-id` on the Mac node.
5. If macOS has not yet granted Messages Automation on that Mac, Botkins shows **`waiting_permission`** (*"waiting for macOS permission on <node>"*) until you click **Allow** on the Mac.

---

## Security model

External channels can be reached by strangers. Botkins applies strict defaults on every new connection:

| Control | Default | How it works |
|---|---|---|
| **DM policy** | `pairing` | Unknown senders receive a one-time pairing code and **no bot turn**. Once the owner approves the code (Desktop, Phone, or `botkins channels pair approve <code>`), the sender is added to the connection's allowlist. Other modes: `allowlist`, `open`, `off`. |
| **Groups** | Off | When turned on, the bot only answers in explicitly listed group/channel IDs, defaulting to `mention` mode (`@mention` or reply to the bot) or optional `all` mode. |
| **Tool profile** | `restricted` | Channel-triggered turns disable shell, file writes, node operations, browser automation, outbound email/messages, purchases, vault/secrets, and routine/task/plugin edits. Only read-only knowledge tools remain enabled. The owner can widen a connection to `standard` (with a warning). |
| **Approvals** | Never in-channel | Approval-gated tools never prompt inside Slack, Telegram, Discord, or iMessage — they route to the owner's Desktop/Phone approval surfaces or are refused. |
| **Prompt injection** | Untrusted framing | Inbound text is wrapped as untrusted external content with its channel and sender metadata and cannot override the bot's instructions or tool profile. |
| **Secrets** | Vault-only | Tokens live only in the encrypted vault (`vault:<id>`). They never appear in `workspace.json`, logs, tool results, or transcripts and are never echoed. |
| **Limits** | Enforced per connection | Per-sender and per-connection rate limits, maximum inbound length, attachment size/type caps (downloaded into a sandboxed temp folder), daily turn cap (notifies the owner when hit), and ignoring the bot's own and other bots' messages by default. |
| **Audit log** | Metadata only | Records timestamp, connection, sender ID, conversation ID, and decision (`allowed`, `paired`, `denied`, `rate_limited`, `reply_sent`) — never message bodies by default. |
| **Owner-only** | Strictly enforced | Only the owner creates, removes, binds, pauses, approves pairings for, or widens a channel (Desktop, owner's Phone, or CLI at a terminal). No bot tool can create, re-bind, approve, or widen a channel. |

---

## Workflows

Workflows support a **`channel`** trigger kind (`workflows.mjs`) that fires when an allowed inbound channel message arrives. It exposes these fields:

- `channel` (`slack`, `telegram`, `discord`, `imessage`)
- `connection` (connection label or ID)
- `conversation` (external conversation/channel ID)
- `sender` (external sender ID or display name)
- `text` (inbound message text)
- `isDirect` (boolean)
- `mentionsBot` (boolean)

---

## Managing channels from the CLI

See `desktop/docs/terminal.md` for full CLI flags. Every command supports `--json`, and secrets are read only from a hidden prompt or standard input:

```sh
botkins channels list --json
botkins channels add slack --bot Nova --label "Support Slack"
botkins channels bind <connection> <bot>
botkins channels policy <connection> --dm pairing --groups off --tool-profile restricted
botkins channels pair list --json
botkins channels pair approve <CODE>
botkins channels pause <connection>
botkins channels resume <connection>
botkins channels test <connection>
botkins channels logs <connection> --limit 25 --json
botkins channels remove <connection> --yes
```
