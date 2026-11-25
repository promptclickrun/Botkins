# Set Up as Node Host

A Node Host would let an owner's bots use a second computer while the owner is away. For example, a bot on a laptop could ask a bot on a studio Mac a question, or ask the Mac for a file from a project the owner shared during setup. These need two different permissions.

## What works with cross-host Teamwork

Two running desktop or terminal hosts bound to the same owner profile can discover each other's participating bots. Host B shows its owner the exact message from Host A. **Always allow** gives that source bot ongoing permission to message that target bot. A different source bot, target bot or host pair needs its own decision. A reply travels back over the encrypted Link. This is enough for unattended conversations after the first approval.

## Proposed setup

1. Choose **Set Up as Node Host** on the desktop welcome screen or in terminal setup. The new install displays a QR code and a short code. On an already trusted device, scan or enter the code, check the node name, and approve enrollment under the same owner profile. The pairing must bind the local Link public key to that profile. A headless node can complete this flow from its terminal.
2. Name the node, then choose what it offers. For a bot, select the local bot and its model provider. For a project tool, select the operation and folder on the node. A machine that only serves project tools can skip model sign-in and bot creation.
3. Show the node name, the named capabilities and the hosts that may use them. Let the owner authorize recurring use from a specific source host and bot. The node records and enforces that grant. A file or tool operation needs its own grant even if the same bot already has permanent permission to send messages.
4. Offer to start the host when the computer starts. Show **Online**, the last completed request, **Pause**, and **Disconnect** in Settings and the terminal dashboard. On other hosts, list the node and its advertised capabilities with its name. A sleeping node is unavailable. A retry uses the original request ID so waking or reconnecting cannot run a job twice.

## What to reuse

| Existing component | Change needed for Node Host mode |
| --- | --- |
| Desktop welcome screen in `desktop/src/SetupChoice.tsx` | Add the fourth setup choice and a route that can finish without creating a bot. Persist the selected role so an empty node does not return to first-run setup. |
| `ProfileManager.ensureLocalHost` in `desktop/desktop/profile.mjs` | Treat an explicitly configured node as a publishable host even when its workspace has no bots or chats. Keep the existing local disconnect and sign-out behavior. |
| `botkins serve` and `botkins service install` | Reuse the terminal runtime and its protected key storage. Linux already has systemd support and macOS has launchd support. The desktop app can use its existing background settings. |
| Link transport and the same-owner Teamwork protocol | Add versioned node capabilities and job operations on a restricted host interface. An agent should receive only the operations the node advertises. Keep conversation approvals scoped to conversations. |
| Workspace projects and host adapters | Resolve an advertised project ID to its directory on the node and enforce file boundaries there. Advertise desktop-dependent operations only when the local adapter and OS permissions support them. |
| Trusted-device cards, grant persistence and terminal controls | Show the requesting bot, source host, node, operation and resource before granting repeat access. Support revocation and record job status on both computers. |

I'd start with bot conversations and one read-only operation such as listing files in a selected project folder. A useful acceptance test is to pair a fresh terminal install, close its setup screen, restart the service, run that operation from another host, revoke the grant, then confirm the next request asks again. The **Set Up as Node Host** choice, project tools and node job controls described here are proposed work.
