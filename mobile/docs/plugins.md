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
- **Reviewed bytes.** `plugins.preview(id)` returns `revision`, which identifies the bytes that were
  reviewed. `plugins.install(id, { bots?, config?, revision })` and `plugins.update(id, { revision })`
  send it, and since `plugin-starts-v1` the computer refuses either without it. On a mismatch the
  computer refuses, and the client shows a fresh preview before the person can go on.
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

## What a plugin starts, shown whole (`plugin-starts-v1`, 2026-11-21)

A fault was found in the app, in a released version too: a plugin's description and the code that
starts its tools and hooks read its files in two ways, so a plugin could show "runs nothing",
install with no question, and run code. The app now has one reading for both
(`desktop/docs/PLUGINS.md` has its rules). This section is the client's half; where it and an
earlier section differ, this one holds.

- **The mark.** A description made by the one reading carries `starts: 1`, on a preview and on an
  installed plugin. Every command the computer starts is in it, whole. **A client decides about one
  description from that description's own mark**: with it, it asks first when the plugin runs
  something on the computer; without it, it asks first always, also for a plugin that shows nothing
  to run. The capability `plugin-starts-v1` (the app's) is only for the sentence that says the app
  on the computer is older.
- **What a client shows, in full**, as text made safe to read (below):
  1. A local tool: the whole line (`command` and each word of `args`), the folder when `cwd` is
     there, each `env` name with its value, and each `envNotSet` name with the computer's reason.
  2. A hook: its event, the whole `command` (up to 4,000 characters, never cut without saying so),
     its time limit, each `env` name with its value, and each `envNotSet` name with its reason.
  3. A remote tool: the address, that it is a stream when `type` is `"sse"`, each header's name with
     its written value, and that it signs in, with the client id when there is one.
  4. A setting: where its value goes (`sentTo`), and its `default` when it is not a secret.
  5. What is not run: each row of `notRun` with its reason, and "and N more".
  6. The other files: how many and how large, and the rows with `config: true`.
- **No secret is in a description.** A value is the text as the plugin wrote it. A secret comes only
  from a setting, and the text then has `${NAME}`. A setting's value goes only into an environment
  value (a local tool's, a hook's) and a header's value, never into a command, an argument, an
  address or a folder, so `sentTo` names every place.
- **Text shown for a decision** goes through one rule (the computer's `desktop/desktop/shown-text.mjs`,
  the phone's `src/ui/shownText.ts`): each control character, format character (the marks that turn
  text around, the ones with no width), line and paragraph separator, variation selector, Hangul
  filler and tag character is written as its number (`\u{202e}`). It is for a command, an argument,
  a folder, an address, a header, an environment value, and a name beside a question. It is not for
  a chat's or a bot's name.
- **A revision with every decision.** An install and an update without `revision` are refused
  ("Look at the plugin first. An install or an update names the revision that was looked at.").
  `plugins.setEnabled(id, on, { revision })` and `plugins.setBots(id, bots, { revision })` send the
  installed plugin's `revision` as it was on the screen when the person chose; the computer refuses
  when it is another one by then ("This plugin is not the one that was looked at: its revision is
  another one now. Look at it again."). The link passes that third argument only as nothing or
  `{ revision }` with 64 hex characters.
- **A plugin the computer switched off** has `enabled: false` and a `detail` sentence, with any
  `status`. It does so one time after the app's update for a plugin whose description has anything
  the old one did not show, for a hook that did not run before and runs now, for a folder that was
  linked for its skills, and when the installed files could not be read. The client shows the
  sentence whole, then everything the plugin runs, then "Turn on".
- **`repair: "update"`** on an installed plugin: its copy is not the reviewed files, or could not be
  read. A client offers Update also when the source did not change, reads the preview and sends its
  revision as for any update; the update writes the files again and keeps the settings.
- **A plugin folder is never linked as a folder of skills.** `addSkillFolderAt` with a plugin folder
  installs it as a plugin, switched off, and answers `{ kind: "plugin", name, id, enabled: false }`.
  An old link that could not be copied is an installed entry in error whose `id` starts with
  `linked-`; only `plugins.uninstall` works on it.
- **An approval card** for a bot's own plugin request holds the plugin's whole description in its
  `detail`. A member is never sent an approval and never answers one (`filterParts` and `authorize`
  in `link-host/team.mjs`; the app's `desktop/test/plugin-card-member.test.mjs` holds those lines).

**The phone's words** (final for the phone, 2026-11-21; the window says "this computer" or the
computer's name where the phone says "your computer"):

- A plugin the computer switched off: **Off · Needs review**. One notice on Marketplace › Plugins,
  shown one time and closed with **OK**: **Botkins switched off 3 plugins** / "Botkins now shows
  everything a plugin runs on your computer. Review each one, then turn it on."
- One notice in Settings › Skills for each such plugin that has skills: **Skills from <name> are
  off** / "They are part of a plugin that is switched off. Review it, then turn it on." / **Open
  plugin**, **OK**.
- What a plugin runs: **Runs**, **In folder**, **Environment** (`NAME = value`), **Not set by
  Botkins**, **Connects to** (with "(stream)"), **Sends headers** (`Name = value`), **Signs in on
  your computer**, **Client id**, **Time limit** ("10 seconds"), sections **Not run** ("and 12
  more") and **Other files** ("214 files · 3.2 MB", **Files that tools read by themselves**).
- A setting: "Sent to the tool <tool> as <NAME>", "Sent to the tool <tool> at <url> in the header
  <Header>", "Sent to the hook (<event in words>) as <NAME>", **Default**.
- Without the mark: "Update the app on your computer to see everything a plugin runs." (an older
  app) or "Your computer could not show everything this plugin runs.", and the question **This
  plugin may run commands on your computer** with **Cancel** and **Install anyway**, **Update
  anyway** or **Turn on anyway**.

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

// With "plugin-starts-v1". `kind` is what the computer does with the tool. An older app sends only
// `name`, `kind`, `command` or `url`, `oauth` and `serverId`, and a hook's command cut at 300 characters.
type PluginContents = {
  skills: string[];        // exactly the files that go to the runtime, as `agents` and `commands` are
  agents: string[];
  commands: string[];
  mcpServers: (
    | { name: string; kind: "local"; command: string; args: string[]; env: { name: string; value: string }[]; envNotSet?: { name: string; why: string }[]; cwd?: string }
    | { name: string; kind: "remote"; type: "http" | "sse"; url: string; headers: { name: string; value: string }[]; oauth?: true; oauthClientId?: string; serverId?: string }   // serverId on installed entries: sign in with signInMcpServer
  )[];
  hooks: { event: PluginHookEvent | string; command: string; env: { name: string; value: string }[]; envNotSet?: { name: string; why: string }[]; timeoutSec: number }[];   // the whole command, up to 4,000 characters
  lspServers?: string[];
  notRun?: { count: number; items: { what: "hook" | "tool"; name: string; why: string }[] };   // there only when count > 0; the first 40
  otherFiles: { count: number; bytes: number; files: { path: string; bytes: number; config?: true; files?: number }[] };   // at most 40 rows
};

type PluginField = {
  key: string;             // the placeholder or userConfig name, e.g. "HINDSIGHT_API_KEY"
  label: string;           // userConfig's title, or the key made readable: "Hindsight API key"
  description?: string;
  secret: boolean;
  required: boolean;       // userConfig's `required`; a placeholder is required
  default?: string;        // never for a secret
  sentTo?: ({ tool: string; env: string } | { tool: string; header: string; url: string } | { hook: string; env: string })[];   // each place that gets the value; `hook` is its event
};

type PluginPreview = PluginListing & {
  contents: PluginContents;
  config: PluginField[];
  postInstallMessage?: string;
  revision?: string;       // the reviewed bytes (64 hex characters); sent back with install and update, which are refused without it
  warnings?: string[];     // the computer's sentences: "Runs a command on your computer through plugin hooks."
  starts?: 1;              // the mark to trust: this description says everything the plugin starts
};

type InstalledPlugin = PluginListing & {
  installed: true;
  enabled: boolean;                  // on at all
  bots: "all" | string[];            // which bots use it
  contents: PluginContents;
  config: (PluginField & { set: boolean; value?: string })[];   // `value` only for non-secret fields
  status: "ready" | "needs-config" | "needs-sign-in" | "error";
  detail?: string;                   // a sentence for needs-sign-in and error, and for a plugin the computer switched off (enabled: false)
  limits?: string;                   // "Hooks run only for bots on the Copilot SDK."
  updateAvailable?: true;
  folder?: string;                   // for a folder plugin: its path on the computer, to show
  installedAt: number;
  revision?: string;                 // the installed copy's; sent with setEnabled and setBots
  starts?: 1;                        // as on a preview; read from the installed copy each time
  repair?: "update";                 // an update is the repair
  warnings?: string[];
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
| `plugins.install(id, { bots?, config?, revision })` | `InstalledPlugin` | `bots` is `"all"` (the default) or bot ids. `config` as in `configure`. `revision` from the preview; refused without it. |
| `plugins.addFolder(path)` | `InstalledPlugin` | A folder on the computer (`folders-v1` for choosing it). May be left disabled until reviewed. |
| `plugins.configure(id, values)` | `void` | `values`: `{ [key]: string \| { $credential: id } \| null }`; `null` clears. A secret is stored in the vault. |
| `plugins.setBots(id, bots, { revision }?)` | `void` | `"all"` or bot ids. `revision`: the installed plugin's, as the person saw it. |
| `plugins.setEnabled(id, on, { revision }?)` | `void` | `revision` as for `setBots`. |
| `plugins.update(id, { revision })` | `InstalledPlugin` | `revision` from a preview of the new version; refused without it. Also the repair for `repair: "update"`. |
| `plugins.uninstall(id)` | `void` | |
| `plugins.refresh()` | `PluginMarketplace[]` | `market-refresh-v1` (2026-11-21). Reads every marketplace again now, without waiting for the hour; one read in the last 15 seconds is not read again. One that can't be read keeps its last list and has `error`. Agent templates are read again at their next browse. |

Limits checked by the link (`link-host/methods.mjs`): ids and sources at most 300 characters, a
query at most 200, at most 32 config values of at most 4,000 characters each, at most 200 bot ids.

### What a phone shows

The Marketplace tab has Apps and Plugins. Plugins lists the catalogs' plugins with search and a chip
per marketplace, and Installed. A plugin's page says what it adds and what runs on the computer
(hooks by event, local commands, remote tools, each whole: see "What a plugin starts, shown whole"),
then Install. Installing asks once more when the plugin runs commands on the computer, and always
when its description does not carry the computer's mark. An installed plugin's page has its status, its settings (secret
fields are typed once and then show only that they are set; a saved credential can be picked), the
bots that use it, on and off, Update and Remove. Without `plugins-v1`: "Update the app on your
computer".

A pull down on each Marketplace view (on the computer, the refresh button at the end of the
Marketplace tabs) reads the catalogs again: `plugins.refresh` where the computer names
`market-refresh-v1`, otherwise only `plugins.marketplaces`, then the skills and the list on screen
(as many pages as were shown). The list shown stays until the new one comes, and stays when a read
fails. A marketplace that newly can't be read is said once ("Couldn't refresh GitHub"); nothing is
said when the refresh works. Apps asks the app list's server again with its ETag.

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
