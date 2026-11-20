# Plugins (`plugins-v1`)

Plugins add skills, tools (MCP servers), hooks, agents and commands to a person's bots. The format is
the one the GitHub Copilot CLI and app use (and Claude Code's, which the Copilot runtime also reads),
so a plugin from GitHub's catalogs, from Hindsight, or from the person's own folder works the same way.
This is the contract between the computer and its clients (the phone, other desktops). The phone
builds against it; the demo computer (`link-host/mock-backend.mjs`) does all of it with made-up data.

Status: agreed with the desktop thread on 2026-11-19, with the changes in "Agreed changes" below
(where they and a later section differ, the agreed changes hold). Target: desktop 0.15.7.

## Agreed changes (the desktop thread, 2026-11-19)

- **Catalogs.** Both read anonymously (235 and 18 plugins). `awesome-copilot` is GitHub's current
  default; `copilot-plugins` is an additional catalog Botkins adds.
- **IDs are opaque.** A client never parses a plugin id; it shows `name` and `marketplace`.
- **Reviewed bytes.** `plugins.preview(id)` returns `revision?: string`, which identifies the bytes
  that were reviewed. `plugins.install(id, { bots?, config?, revision? })` and
  `plugins.update(id, options?: { revision?: string })` send it. On a mismatch the computer refuses,
  and the client shows a fresh preview before the person can go on.
- **Saved credentials** (`{ $credential: id }`) are allowed ONLY in `install`'s `config` values and in
  `configure`'s values, filled in by the link (`credentials.resolve`). Anywhere else in a `plugins.*`
  call they are refused.
- **OAuth.** An installed plugin's `contents.mcpServers[]` item may carry `serverId?: string`. When it
  does, a client signs it in with the existing `signInMcpServer(serverId)`.
- **Folder installs are reviewed first.** `plugins.addFolder(path)` may leave the new plugin
  disabled; the client shows its contents and turns it on with `setEnabled` after the person's OK.
- **Hook words** (shared by both apps): "When a chat starts", "Each message you send", "Before a
  tool runs", "After a tool runs", "When a reply ends".
- **Hooks from files do run.** The desktop thread's isolated SDK 2.0.1 test (Botkins' session
  options, config discovery off, no account, a local fake model) showed a plugin's file
  `sessionStart` and `userPromptSubmitted` hooks each ran once and their output reached the model,
  with no SDK handler. So when the computer runs a plugin's hooks itself (to scope secrets), it
  must leave the plugin's own hooks file out of the session, or they run twice.
- **Other harnesses.** The direct Claude, Codex, OpenCode and ACP adapters load a plugin's skills
  today; other parts need explicit support in each adapter, and `limits` says so.
- **Hindsight.** Its CLI integration is retired upstream in favor of the Coding Agents plugin. v1
  proves a Hindsight-like fixture, not every upstream installer.

## What was found (2026-11-19)

- **Format.** A plugin is a folder with a manifest: `.plugin/plugin.json`, `plugin.json`,
  `.github/plugin/plugin.json` or `.claude-plugin/plugin.json` (legacy), or a root `plugin.json` with
  `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` (Agent Plugins 1.0).
  It may hold `skills/`, `agents/`, `commands/`, `hooks.json` or `hooks/hooks.json`, `.mcp.json` or
  `mcp.json`, `lsp.json`. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` (and the `CLAUDE_` spellings) are
  expanded for local MCP servers and hook `env`. Sources: the CLI plugin reference
  (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) and the
  plugins bundled with `@microsoft/copilot-sdk-darwin-arm64`.
- **Catalogs are public.** A marketplace is a GitHub repository (or URL, or folder) with a
  `marketplace.json` at `.github/plugin/`, `.plugin/` or `.claude-plugin/`. GitHub's two:
  `github/awesome-copilot` (235 plugins; the Copilot app's default) and `github/copilot-plugins`
  (18), both readable without a sign-in at
  `https://raw.githubusercontent.com/<repo>/main/.github/plugin/marketplace.json`. An entry has `name`
  and `source` (a path in the catalog's repository, or `{ source: "github", repo, ref?, sha?, path? }`)
  and optionally `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`.
  No icon or category. (GitHub's Agent Finder search, `POST https://agentfinder.github.com/api/v1/search`,
  adds categories and install counts, but it is unversioned and its terms are unknown: not used in v1.)
- **The SDK.** `@microsoft/copilot-sdk` 2.0.1 takes plugin folders per session
  (`plugins.directories`, which the desktop app already passes from Settings › Skills) and hook
  callbacks per session (`hooks.handlers`: `onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`,
  `onPostToolUse`, `onAgentStop`, `onSessionEnd` and more, with `additionalContext`, `modifiedPrompt`,
  `permissionDecision`). The runtime can install from marketplaces itself
  (`rpc.plugins.marketplaces.add`, `rpc.plugins.install`).
- **Hooks from files.** GitHub's hooks reference says a file hook's output on `userPromptSubmitted`
  is dropped ("honored only by SDK hooks"); the desktop thread's test found it does reach the model
  in SDK 2.0.1 (see "Agreed changes"). The computer runs hooks itself anyway, to scope secrets.
- **No settings form.** Neither the Copilot app nor the format has a plugin settings form. A plugin
  reads its settings from `${NAME}` placeholders in its MCP config and from environment variables;
  Claude Code plugins may also declare `userConfig` in the manifest.
- **Hindsight** (https://github.com/vectorize-io/hindsight) fits: an MCP server (`/mcp/{bank_id}/`,
  `Authorization: Bearer ${HINDSIGHT_API_KEY}`, `X-Bank-Id: ${HINDSIGHT_BANK_ID}`) plus hooks at session
  start, each prompt (recall into context) and the end of a turn (retain). Supermemory, Mem0 and
  claude-mem have the same shape.

## What the computer does (recommended; the desktop thread decides how)

1. **Catalogs.** The computer reads `marketplace.json` from GitHub's two catalogs by default and from
   any the person adds (`owner/repo`, `owner/repo#ref`, an https URL, or a folder on the computer).
   It caches them and refreshes at most once an hour. The phone never fetches GitHub itself.
2. **Install** fetches the plugin into the computer's own data folder (the runtime's
   `plugins.install`, or its own download), reads its manifest and files, and records it. A folder
   on the computer can be added as a plugin too (today's Settings › Skills "Add from folder", which
   should also accept `.plugin/plugin.json` and `.codex-plugin/plugin.json`).
3. **Per bot.** Each installed plugin is on for all bots or for chosen bots. A bot's Copilot session
   gets the plugin's folder in `plugins.directories`. Other harnesses get what they can load (skills
   at least); what a bot's harness can't load is said in `limits`.
4. **Hooks run through the SDK.** The computer reads each plugin's hooks file and runs its command
   hooks itself from `hooks.handlers`, with the plugin's settings in their environment, and maps the
   output (`additionalContext`, `permissionDecision`, `modifiedArgs`, a block) to the callback's
   answer. That lets a memory plugin add context on every prompt, and keeps secrets out of files.
5. **Settings.** The computer works out a plugin's fields: the manifest's `userConfig` when present,
   then every `${NAME}` in its MCP and hook files that is not a built-in (`PLUGIN_ROOT`,
   `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `HOME`, `PATH`). A field is secret when
   `userConfig` says `sensitive`, or its name has KEY, TOKEN, SECRET, PASSWORD or AUTH. Secret values
   are kept in the credential vault and never sent to any client; they reach only the plugin's MCP
   server environment and headers and its hook processes, never a prompt.
6. **Sign-in.** An MCP server with OAuth (`oauthClientId`) is signed in on the computer, as other
   sign-ins are; the plugin's status says so until it is done.
7. **Bots.** A bot may search the catalogs and propose a plugin. Installing, turning on, changing
   settings or removing one always asks the person (a permission request), and a bot that needs a
   secret for it asks with a secure input (`secure-input-v1`), so the value goes to the vault.
8. **Trust.** A plugin runs code on the computer (hook commands, local MCP servers). Before install
   the person is shown what it runs; nothing is installed or turned on without their action.

## The link (`plugins-v1`, named by the app in `backend.capabilities`)

### Types

```ts
type PluginMarketplace = {
  id: string;              // its name from marketplace.json, e.g. "awesome-copilot"
  name: string;            // shown: "GitHub", "Copilot plugins", or the catalog's own name
  source: string;          // "github/awesome-copilot", a URL, or "Folder on your computer"
  builtIn: boolean;        // GitHub's two; can't be removed
  count?: number;          // plugins in it
  updatedAt?: number;      // when it was last read
  error?: string;          // a sentence when it couldn't be read
};

type PluginListing = {
  id: string;              // "name@marketplace"; for a folder plugin "name@folder"
  name: string;
  marketplace: string;     // PluginMarketplace.id, or "folder"
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;       // https only
  repository?: string;     // https only
  license?: string;
  keywords?: string[];
  installed?: true;
};

type PluginHookEvent = "sessionStart" | "userPromptSubmitted" | "preToolUse" | "postToolUse"
  | "postToolUseFailure" | "agentStop" | "subagentStart" | "subagentStop" | "sessionEnd"
  | "errorOccurred" | "preCompact" | "notification" | "permissionRequest";

type PluginContents = {
  skills: string[];
  agents: string[];
  commands: string[];
  mcpServers: { name: string; kind: "local" | "remote"; command?: string; url?: string; oauth?: true; serverId?: string }[];   // serverId on installed entries: sign in with signInMcpServer
  hooks: { event: PluginHookEvent | string; command: string }[];   // command as written, at most 300 chars
  lspServers?: string[];
};

type PluginField = {
  key: string;             // the placeholder or userConfig name, e.g. "HINDSIGHT_API_KEY"
  label: string;           // userConfig's title, or the key made readable: "Hindsight API key"
  description?: string;
  secret: boolean;
  required: boolean;       // userConfig's `required`; a placeholder is required
  default?: string;        // never for a secret
};

type PluginPreview = PluginListing & {
  contents: PluginContents;
  config: PluginField[];
  postInstallMessage?: string;
  revision?: string;       // the reviewed bytes; sent back with install and update
  warnings?: string[];     // sentences: "Runs a command on your computer at each prompt."
};

type InstalledPlugin = PluginListing & {
  installed: true;
  enabled: boolean;                  // on at all
  bots: "all" | string[];            // which bots use it
  contents: PluginContents;
  config: (PluginField & { set: boolean; value?: string })[];   // `value` only for non-secret fields
  status: "ready" | "needs-config" | "needs-sign-in" | "error";
  detail?: string;                   // a sentence for needs-sign-in and error
  limits?: string;                   // "Hooks run only for bots on the Copilot SDK."
  updateAvailable?: true;
  folder?: string;                   // for a folder plugin: its path on the computer, to show
  installedAt: number;
};
```

`InstalledPlugin[]` is the part `plugins`, sent after every change like the other parts.

### Calls

| Call | Returns | Notes |
| --- | --- | --- |
| `plugins.marketplaces()` | `PluginMarketplace[]` | |
| `plugins.addMarketplace(source)` | `PluginMarketplace` | `owner/repo`, `owner/repo#ref`, an https URL, or a folder path. |
| `plugins.removeMarketplace(id)` | `void` | Not a built-in one. Installed plugins stay. |
| `plugins.browse({ marketplace?, query?, cursor? })` | `{ plugins: PluginListing[]; cursor?: string }` | 50 a page, by name. `query` matches name, description and keywords. |
| `plugins.preview(id)` | `PluginPreview` | Reads the plugin's manifest and files before install. |
| `plugins.install(id, { bots?, config?, revision? })` | `InstalledPlugin` | `bots` is `"all"` (the default) or bot ids. `config` as in `configure`. `revision` from the preview. |
| `plugins.addFolder(path)` | `InstalledPlugin` | A folder on the computer (`folders-v1` for choosing it). May be left disabled until reviewed. |
| `plugins.configure(id, values)` | `void` | `values`: `{ [key]: string \| { $credential: id } \| null }`; `null` clears. A secret is stored in the vault. |
| `plugins.setBots(id, bots)` | `void` | `"all"` or bot ids. |
| `plugins.setEnabled(id, on)` | `void` | |
| `plugins.update(id, { revision? }?)` | `InstalledPlugin` | `revision` from a preview of the new version. |
| `plugins.uninstall(id)` | `void` | |

Limits checked by the link (`link-host/methods.mjs`): ids and sources at most 300 characters, a
query at most 200, at most 32 config values of at most 4,000 characters each, at most 200 bot ids.

### What a phone shows

The Marketplace tab has Apps and Plugins. Plugins lists the catalogs' plugins with search and a chip
per marketplace, and Installed. A plugin's page says what it adds and what runs on the computer
(hooks by event, local commands, remote tools), then Install. Installing asks once more when the
plugin runs commands on the computer. An installed plugin's page has its status, its settings (secret
fields are typed once and then show only that they are set; a saved credential can be picked), the
bots that use it, on and off, Update and Remove. Without `plugins-v1`: "Update the app on your
computer".

## Making your own

The smallest plugin with a tool and a hook (legacy layout, as the Copilot runtime's own bundled
plugins use):

```
my-memory/
  plugin.json          { "name": "my-memory", "version": "0.1.0", "description": "Memory", "mcpServers": ".mcp.json" }
  .mcp.json            { "mcpServers": { "memory": { "type": "http", "url": "http://localhost:8888/mcp/default/",
                           "headers": { "Authorization": "Bearer ${MEMORY_API_KEY}" } } } }
  hooks/hooks.json     { "version": 1, "hooks": { "userPromptSubmitted": [ { "type": "command",
                           "bash": "node \"$ROOT/recall.mjs\"", "env": { "ROOT": "${PLUGIN_ROOT}" }, "timeoutSec": 10 } ] } }
  recall.mjs           reads the event as JSON on stdin, prints { "additionalContext": "…" }
```

Botkins shows `MEMORY_API_KEY` as a secret field, keeps it in the vault, and runs the hook on every
prompt through the SDK, so the recalled text reaches the bot. Add the folder from the Plugins page
("Add from your computer"), or let a bot write it and add it (it asks first).
