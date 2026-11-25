# Set Up as Node Host

A Node Host lets an owner's bots use a second computer while the owner is away. For example, a bot on a laptop can ask a bot on a studio Mac a question, or list files in a project folder the studio Mac shared. Conversations and project file operations use separate permissions.

## What works now

### Node role and setup

- Choose **Set Up as Node Host** on the desktop welcome screen (`desktop/src/SetupChoice.tsx`), name the node, and finish setup without signing in to a model provider or creating a bot.
- From a terminal, run `botkins node setup --name <name>` (or configure an existing host in **Settings › Node host**).
- The node role (`enabled`, `name`, `paused`, shared project IDs) persists in the workspace (`workspace.json`) so an empty node host does not fall back to first-run setup after a restart.
- `ProfileManager.ensureLocalHost` publishes an explicitly configured node host to the owner's profile even when it has no bots or chats.

### Advertised capabilities and discovery

- A Node Host advertises a versioned capability snapshot (`version: 1`) over the existing Link / same-owner `teamwork-peers` transport:
  - Its node name, online/paused state, and shared bots (reusing cross-host Teamwork for conversations).
  - Read-only project file listing (`project.list_files`, version `1`) for each project folder explicitly shared on the node (`botkins node share <project>` or **Settings › Node host**).
- Other same-owner hosts discover the node, its name, and its advertised capabilities. A sleeping, disconnected, or paused node shows as unavailable for new jobs.

### Cross-host list-files operation and grants

- Bots on another same-owner host receive the `list_node_hosts` tool (to discover nodes, their online status, and their advertised shared project folders) and `list_node_files` (to list files in a shared project folder on a node).
- On the node (`desktop/desktop/node-host.mjs`), the advertised project ID resolves to its local directory. The node enforces the folder boundary (`..` traversal and symlink escapes outside the project root are rejected) and caps the listing size (500 entries and 64 KiB).
- Job grants live on the node and are keyed by `(source host, source bot, operation, resource)`. They are separate from cross-host conversation grants: a bot with **Always allow** for messages still needs its own grant for listing files.
- The first request shows a trusted-device approval card with the requesting bot, source host, node, operation, and folder, with the four choices: **Allow this time**, **Allow for today**, **Always allow**, and **Deny**.
- Retries reuse the original request ID (`job.submit` with `requestId`), so waking or reconnecting never runs the same job twice. Job records persist across restarts (any interrupted `working` job becomes `failed` on startup).

### Controls

- **Desktop Settings › Node host** (`desktop/src/NodeHostSettings.tsx`), **`botkins node`**, **`botkins status`**, and the terminal dashboard **Overview** show **Online** / **Paused**, the last completed request, and shared folders, along with **Pause** / **Resume**, **Disconnect**, folder sharing toggles, and grant **Revoke**.
- Every control call has a CLI command (`botkins node status|setup|rename|pause|resume|share|unshare|revoke|disconnect`, all supporting `--json`), an entry in `desktop/terminal/coverage.mjs`, and a `CHANGES` log line.

## Components reused

| Existing component | Role in Node Host mode |
| --- | --- |
| Desktop welcome screen (`desktop/src/SetupChoice.tsx`, `desktop/src/app.tsx`) | Adds the fourth setup choice (**Set Up as Node Host**) and finishes without creating a bot. Persists the role so an empty node does not return to first-run setup. |
| `ProfileManager.ensureLocalHost` (`desktop/desktop/profile.mjs`) | Publishes a configured node host even when its workspace has no bots or chats, while keeping existing disconnect and sign-out behavior. |
| `botkins serve` and `botkins service install` | Runs the terminal runtime and protected key storage with systemd (Linux) or launchd (macOS). |
| Link transport and same-owner Teamwork (`desktop/desktop/teamwork-peers.mjs`, `desktop/desktop/remote-teamwork.mjs`, `desktop/desktop/teamwork.mjs`) | Carries versioned node capabilities and `job.submit` / `job.status` / `job.cancel` alongside cross-host conversations. Keeps conversation approvals scoped to conversations. |
| Workspace projects (`desktop/desktop/node-host.mjs`, `desktop/desktop/workspace.mjs`) | Resolves an advertised project ID to its local directory on the node and enforces folder boundaries and output caps there. |
| Trusted-device cards, grant persistence, and terminal controls (`desktop/desktop/interactions.mjs`, `desktop/desktop/terminal/control-node.mjs`, `desktop/cli/commands/node.mjs`, `desktop/src/NodeHostSettings.tsx`) | Shows requesting bot, source host, node, operation, and folder before granting repeat access, supports revocation, and records job status on both computers. |

## Still future work

- Dedicated QR/short-code node enrollment flow directly inside the **Set Up as Node Host** wizard (today a node enrolls through the existing profile / phone-link pairing flow).
- Additional node operations beyond read-only folder listing (reading/writing files, running project commands, or desktop-adapter actions gated on OS permissions).
- Offering OS startup / background service installation directly inside the desktop Node Host setup step.

