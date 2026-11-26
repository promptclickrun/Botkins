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

- **Desktop window** on the node host: shows the permission card with the requesting bot, source host, operation, and exact command/path details.
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

- **Desktop Settings › Node host** (`desktop/src/NodeHostSettings.tsx`): online/paused toggle (kill switch), exec policy mode selector, per-bot allowlist editor, whole-computer opt-in toggle, shared project folder toggles, saved grants with **Revoke**, and the recent audit log.
- **CLI** (`desktop/cli/commands/node.mjs`): `botkins node status|approvals|approve|policy|allowlist|whole-computer|audit|setup|rename|pause|resume|share|unshare|revoke|disconnect` (all supporting `--json`, covered by `desktop/desktop/terminal/coverage.mjs` and audited in the control log).

## Still future work

- Dedicated QR/short-code node enrollment flow directly inside the **Set Up as Node Host** wizard (today a node enrolls through the existing profile / phone-link pairing flow).
- Offering OS startup / background service installation directly inside the desktop Node Host setup step.

