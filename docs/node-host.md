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
- Every control call has a CLI command (`botkins node status|setup|rename|pause|resume|share|unshare|revoke|disconnect|convert|remote`, all supporting `--json`), an entry in `desktop/terminal/coverage.mjs`, and a `CHANGES` log line.

### Convert an existing full host to a Node Host

People who previously configured a second Mac or Linux computer as a full Botkins host can convert it in one guided flow without losing data or duplicating scheduled routines:

- **Entry points**:
  - **Settings › Node host** shows **Convert this computer to a Node host** whenever local bots or chats exist, **Resume conversion** if a previous run was interrupted, and **Undo conversion** while a local backup snapshot is available.
  - CLI: `botkins node convert` (interactive by default, plus non-interactive flags `--name`, `--all move|keep|delete`, `--target <host>`, `--bot <id=move[:host]|keep|delete>`, `--share <project>`, `--confirm-delete DELETE`, `--dry-run`, `--resume`, `--undo`, `--yes`, and `--json`).
- **Six-step wizard** (`desktop/src/ConvertToNodeWizard.tsx`):
  1. **Overview**: explains what changes, what stays untouched (phone link & pairings, encrypted vault), and how the automatic local backup snapshot works.
  2. **Inventory**: groups everything local — each bot with its chats, routines, memory/profile files (`AGENTS.md`, `USER.md`, `IDENTITY.md`), skills, plugin enablement, Today panels, and project references, plus shared workspace items (wiki, vault metadata, projects).
  3. **Choose bots**: for each bot, choose **Move** (to any online same-owner host), **Keep locally** (stays on this node as a shared bot reachable via cross-host Teamwork), or **Delete**, with a **Same for all** shortcut.
  4. **Review**: shows exact counts, where each bot will live, what stays local (vault, wiki, phone pairings), optional shared project folders, and requires typing `DELETE` whenever any bot is being deleted.
  5. **Run with progress**: creates a local snapshot first, moves/keeps/deletes each bot with live stage indicators, and pauses cleanly if a destination host goes offline mid-move (leaving unmoved items untouched on the source).
  6. **Finish**: shows the node as **Online**, where every bot now lives, the backup snapshot folder path, and a one-click **Undo conversion** option.
- **Safe transfer & routine de-duplication** (`desktop/desktop/node-convert.mjs`):
  - **Snapshot first**: before moving or deleting anything, Botkins saves a local snapshot under `<data-dir>/node-convert-snapshots/<id>/` (preserving `link/` and `vault.json` outside the snapshot restore path).
  - **Verify before delete**: each moved bot bundle is sent over same-owner encrypted Teamwork in chunked packets (`migrate.begin`/`chunk`/`commit`/`verify`) under the 160 KiB transport cap with per-chunk and whole-bundle SHA-256 verification and item-count read-back. Nothing is removed from the source unless target verification succeeds.
  - **Routines never run twice**: schedules and timezones are disabled on the source *before* transfer, imported disabled on the target, and activated on the target (`migrate.activate`) only *after* source cleanup finishes. If a transfer fails or is interrupted before source removal, source routines are restored automatically.
  - **Idempotent & resumable**: conversion jobs persist in `workspace.json` (`nodeHost.conversionJobs`) and target imports are keyed by deterministic `transferId`, so re-running after an offline interruption skips completed bots and never creates duplicates.
  - **Vault secrets stay local**: encrypted vault files (`vault.json` / `vault.key`) are never read in plaintext, transmitted over the wire, or logged. Only metadata counts are shown, with a note explaining what stayed behind.
  - **One-click Undo**: restores the local backup snapshot, turns off Node Host mode, keeps phone pairings and vault untouched, calls `migrate.rollback` on reachable targets to disable moved routines, and safely pauses restored source routines for any unreachable targets so routines still cannot double-fire.

### Owner-only remote node management control

Another computer signed in to the **same owner profile** can inspect and manage a Node Host remotely without opening node controls to phones or team members:

- **Operations**: `status` (read-only), `pause`, `resume`, `share`, `unshare`, `revoke`, `rename`, and `disconnect` via `botkins node remote <host> <action>` or `window.botkins.nodeRemoteControl`.
- **Authorization & safety**:
  - Carried exclusively over same-owner `teamwork-peers` (`control.status`, `control.submit`, `control.poll`, `control.cancel`). Never added to `REMOTE_METHODS`, so paired phones and team members cannot invoke node or conversion controls directly.
  - Mutating controls use the same trusted-device approval flow as node jobs (**Allow this time**, **Allow for today**, **Always allow**, **Deny**) with an isolated `"node-control"` grant scope separate from file-listing and conversation grants.
  - `control.status` and control actions (such as `resume`, `revoke`, `rename`, and `disconnect`) remain reachable even while the node is **Paused**, while regular `node-job` work stays blocked.

## Components reused

| Existing component | Role in Node Host mode |
| --- | --- |
| Desktop welcome screen (`desktop/src/SetupChoice.tsx`, `desktop/src/app.tsx`) | Adds the fourth setup choice (**Set Up as Node Host**) and finishes without creating a bot. Persists the role so an empty node does not return to first-run setup. |
| `ProfileManager.ensureLocalHost` (`desktop/desktop/profile.mjs`) | Publishes a configured node host even when its workspace has no bots or chats, while keeping existing disconnect and sign-out behavior. |
| `botkins serve` and `botkins service install` | Runs the terminal runtime and protected key storage with systemd (Linux) or launchd (macOS). |
| Link transport and same-owner Teamwork (`desktop/desktop/teamwork-peers.mjs`, `desktop/desktop/remote-teamwork.mjs`, `desktop/desktop/teamwork.mjs`) | Carries versioned node capabilities, `job.*`, owner-only `control.*`, and chunked `migrate.*` alongside cross-host conversations. Keeps conversation, job, and control approvals strictly isolated. |
| Workspace projects (`desktop/desktop/node-host.mjs`, `desktop/desktop/workspace.mjs`) | Resolves an advertised project ID to its local directory on the node and enforces folder boundaries and output caps there. |
| Trusted-device cards, grant persistence, and terminal controls (`desktop/desktop/interactions.mjs`, `desktop/desktop/terminal/control-node.mjs`, `desktop/cli/commands/node.mjs`, `desktop/src/NodeHostSettings.tsx`, `desktop/src/ConvertToNodeWizard.tsx`, `desktop/desktop/node-convert.mjs`) | Shows requesting bot, source host, node, operation, and folder before granting repeat access, supports revocation, drives one-step full-to-node conversion with backup snapshots and undo, and records job status on both computers. |

## Still future work

- Dedicated QR/short-code node enrollment flow directly inside the **Set Up as Node Host** wizard (today a node enrolls through the existing profile / phone-link pairing flow).
- Additional node operations beyond read-only folder listing (reading/writing files, running project commands, or desktop-adapter actions gated on OS permissions).
- Offering OS startup / background service installation directly inside the desktop Node Host setup step.
- Encrypted cross-host vault secret migration (currently vault entries stay encrypted on the original computer with a clear note).

