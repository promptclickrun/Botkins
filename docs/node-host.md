# Node Hosts

A Node Host lets an owner's bots on one computer control another computer in the same Botkins profile — working with files, running shell commands, driving the desktop screen, showing notifications, or talking to bots on that machine — while keeping policy, approvals, grants, and audit logs strictly on the node.

## Operations and requesting-host tools

A Node Host advertises a versioned capability document (`version: 2`) over the existing Link / same-owner `teamwork-peers` transport (Tailscale direct with relay fallback). Every operation is gated by grants and policy on the node:

| Category | Node operation | Requesting-host bot tool | Notes |
| --- | --- | --- | --- |
| Discovery | `capabilities` | `list_node_hosts` | Lists online/paused nodes, shared folders, `wholeComputer`, `execPolicy.mode`, and declared operations. |
| Files | `project.list_files` | `list_node_files` | Lists files in a shared project folder (capped at 500 entries / 64 KiB). |
| Files | `fs.read` | `node_read_file` | Reads a UTF-8 or base64 file (size-capped) inside a shared folder or opt-in whole-computer scope. |
| Files | `fs.write` | `node_write_file` | Creates a file, or overwrites when `overwrite: true` (overwrites use a separate `fs.write.overwrite` grant). |
| Files | `fs.mkdir` | `node_mkdir` | Creates a directory inside the allowed scope. |
| Files | `fs.move` | `node_move_file` | Moves or renames a file/folder inside the allowed scope (with optional `overwrite: true`). |
| Files | `fs.delete` | `node_delete_file` | Deletes a file or directory (destructive grant; `recursive: true` for non-empty directories). |
| Files | `fs.stat` | `node_stat_file` | Returns file metadata (existence, type, size, mtime). |
| Files | `fs.search` | `node_search_files` | Searches filenames and text content within the allowed scope (bounded entries/bytes). |
| Shell | `system.run` | `node_exec` | Runs an argv or shell command with cwd, env, timeout, live streamed stdout/stderr, and exit code. |
| Shell | `system.which` | `node_which` | Resolves executable paths on the node's `PATH`. |
| Computer control | `screen.info` | `node_screen_info` | Lists displays and OS screen/accessibility permission state on the node (advertised when screen adapter is present). |
| Computer control | `screen.capture` | `node_screen_capture` | Captures a size-bounded JPEG screenshot of a node display. |
| Computer control | `screen.input` | `node_screen_input` | Injects validated pointer, keyboard, or scroll input events on the node's display. |
| Notifications | `node.notify` | `node_notify` | Displays a local notification on the node. |

## Approvals across every trusted owner surface

Approval decisions always stay on the node host, and pending node-job requests are reachable from every trusted surface of the owner's profile:

- **In the chat that asked** (the default): the source host sends `relayApproval: true` with `job.submit`, and the node hands its approval back in the pending `job.status` reply as `ask` (title, exact command or path, scope label) instead of raising it on its own screen. The source shows it as a dispatch permission card in the bot's chat, so the owner answers it where they are: that chat in the desktop window, or the phone paired to the source host (its normal request push and request panel, with **Allow this time**, **Allow for today**, **Always allow** and **Deny**). The answer goes back with `job.answer { id, askId, action }`. The node accepts it only for its current `ask.id` and a known action, then applies it exactly as a local answer: grants, exec policy and the exact `system.run` binding stay on the node and are checked there. Stopping the turn withdraws the card and cancels the job; a node restart drops the old ask and the job asks again with a new id. A source on an older version sends no `relayApproval`, and the node asks on its own surfaces below.
- **Desktop window** on the node host: shows the permission card with the requesting bot, source host, operation, and exact command/path details (for requests from an older source host, and for remote node control).
- **Paired phones** (even when currently viewing a different host): node-job pushes carry `nodeJob` (`nj: true`), bypass chat presence / Live Activity holds, and open the dedicated **Node Approval Sheet** (`/node-approval`) directly — never routing to a nonexistent `/chat/node-job-*` screen — with **Allow once**, **Allow for today**, **Always allow**, and **Deny** choices.
- **CLI** on the node host:
  - `botkins node approvals` lists all pending node-job requests (via `node.approvals` / `interactions.list`).
  - `botkins node approve <request-id>` prompts at an interactive TTY with the four dispatch choices, refuses without a TTY, and preserves the `{ agreed: true }` (`NEEDS_YES`) gate on `chat.respond`.
  - `botkins chats approve <id>` also resolves a request ID or `node-job-<id>` directly via `interactions.list`.

## Security model

- **Same owner profile only**: only computers authenticated in the owner's own Botkins profile can query capabilities or submit jobs (`teamwork-peers` profile check).
- **Per-node exec policy** (`deny` / `allowlist` / `ask` / `full`, default `ask`): stored and enforced exclusively on the node. In `allowlist` mode, rules are scoped per node and per source bot (`botId` or `*`), and non-matching commands are denied without prompting.
- **Exact request binding & interpreter pinning**: every `system.run` approval binds a SHA-256 hash of `{ argv, cwd, env, resolvedExecutable, execHash, pinnedScript }`. Before spawning, the node re-validates `row.params`, re-hashes the resolved binary, and re-hashes any pinned script file on disk — rejecting any post-approval edit or script drift. Unpinned interpreter invocations (such as `node -e` or `sh -c`) and dangerous environment overrides (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, etc.) are denied unless the node's mode is `full`.
- **Scoped, non-escalating grants**: grants are keyed by `(source host, source bot, operation, resource)` with `once` / `today` / `always`. Destructive operations (`fs.delete`, `fs.write.overwrite`, `fs.move.overwrite`) and `system.run` (bound per exact command hash) require their own grants. Listing files never implies reading, writing, deleting, or running commands, and cross-host conversation grants remain completely separate.
- **File boundaries & opt-in whole-computer scope**: shared-folder operations enforce realpath boundary checks blocking `..` traversal and symlink escapes, plus read/write size caps. Whole-computer file scope (`__whole_computer__`) is off by default and must be explicitly turned on per node by the owner.
- **Audit log**: every submitted, denied, cancelled, failed, or completed node operation is persisted on the node with timestamp, caller host/bot, operation, args summary, status, and exit code, visible in `botkins node status`, `botkins node audit`, and **Settings › Node host**.
- **Kill switch**: `botkins node pause` or the **Pause** button in Settings immediately rejects new requests, cancels pending approvals, and kills the process group of any running `system.run` child process.
- **Idempotency & crash recovery**: retries reuse the original `requestId` so reconnects never double-run a job. Interrupted `working` jobs are marked `failed` on startup.

## Controls

- **Desktop Settings › Node host** (`desktop/src/NodeHostSettings.tsx`): online/paused toggle (kill switch), exec policy mode selector, per-bot allowlist editor, whole-computer opt-in toggle, shared project folder toggles, saved grants with **Revoke**, recent audit log, one-step conversion wizard, and snapshot undo.
- **CLI** (`desktop/cli/commands/node.mjs`): `botkins node status|approvals|approve|policy|allowlist|whole-computer|audit|setup|rename|pause|resume|share|unshare|revoke|disconnect|convert|remote` (all supporting `--json`, covered by `desktop/desktop/terminal/coverage.mjs` and audited in the control log).

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
- Offering OS startup / background service installation directly inside the desktop Node Host setup step.
- Encrypted cross-host vault secret migration (currently vault entries stay encrypted on the original computer with a clear note).
- Cross-host Task Board creation & creator-bot identity: today's `teamwork-peers` RPC supports `ask_teammate` conversations and `node_*` operations, not remote `task_create`. When a task is dispatched onto a remote host via local CLI/SSH, the local board records `createdBy: "person"` rather than the remote orchestrator bot ID; carrying cross-host creator bot identity (`{ hostId, botId }`) awaits a dedicated cross-host task RPC.

