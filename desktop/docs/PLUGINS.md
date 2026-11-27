# Plugins

Open **Settings → Marketplace → Plugins**. Search a marketplace or choose **Installed**. Three marketplaces are built in: **Botkins** ([promptclickrun/botkins-marketplace](https://github.com/promptclickrun/botkins-marketplace), first-party plugins such as Hevy), **GitHub** (`github/awesome-copilot`) and **Copilot plugins** (`github/copilot-plugins`). Select a plugin to see its skills, agents, commands, hooks and MCP servers. A hook can run local code every time you send a message. Check the source and the commands before enabling it for your bots.

Choose **Add a marketplace** for a GitHub repository, a repository with a `#ref`, an HTTPS marketplace URL or a local marketplace folder. **Add from your computer** imports a plugin folder and switches it on, as an install does. The window and the phone show what it starts before you add it. It is the only way to add a plugin folder: a plugin folder is not linked as a folder of skills. Updating a plugin reviews a fresh copy. Removing the plugin leaves your original source folder intact.

A bot can search available plugins and propose a change during a conversation. You approve the change in the chat, even if you normally let that bot run tools automatically. When a plugin needs a key, enter it in the secure fields or select a saved credential. The host stores settings in its credential vault. For an OAuth server, select **Sign in** and finish the browser flow on the host computer.

## Make a plugin

Put `plugin.json` at the root of a folder. Put each skill in `skills/<name>/SKILL.md`. For a plugin that uses a private memory service, declare the credential in the manifest.

```json
{
  "name": "team-memory",
  "version": "1.0.0",
  "userConfig": {
    "MEMORY_API_KEY": {
      "title": "Memory API key",
      "sensitive": true,
      "required": true
    }
  }
}
```

In `.mcp.json`, declare your service and the header it expects. Replace the example URL with your MCP server.

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://memory.example.org/mcp",
      "headers": { "Authorization": "Bearer ${MEMORY_API_KEY}" }
    }
  }
}
```

To add context when someone sends a message, add a command hook in `hooks/hooks.json`.

```json
{
  "hooks": {
    "userPromptSubmitted": [
      { "type": "command", "bash": "node \"$PLUGIN_ROOT/recall.mjs\"" }
    ]
  }
}
```

In `recall.mjs`, read the prompt event as JSON from standard input. Read `process.env.MEMORY_API_KEY` inside the process to call your service. Write one JSON object with an `additionalContext` string to standard output. Only return material you intend the model to read. A command hook runs with the OS permissions of the account running Botkins.

## Agent templates

A marketplace can also offer agent templates: a bot's name, role, about line, instructions and look. Open **Settings → Marketplace → Agents** (or the Marketplace button left of New chat), choose a template and select **Install**. Create a bot opens filled in from it. Review the instructions and any included skills and routines, edit the bot, and choose Create. Bundled skills belong to the new bot. Bundled routines start paused in their own chats for that bot and can be enabled in Routines.

List templates under `agents` in the marketplace's `marketplace.json`, beside `plugins`. Each entry names a template file in the same repository: the file **Export template…** writes.

```json
"agents": [
  { "name": "inbox-triage", "source": "./agents/inbox-triage.json", "category": "productivity", "version": "1.0.0", "keywords": ["email"], "author": { "name": "Botkins" } }
]
```

`name` is lowercase letters, digits and dashes; the id is `name@marketplace`. `category` is one of `writing`, `research`, `productivity`, `work`, `dev`, `learning`, `health`, `finance`, `home`, `media`, `life` or `other`. The host reads the files when someone browses templates, at most once an hour for each marketplace, checks them as an imported template is checked, and leaves out one it can't read. At most 200 templates are read from a marketplace, and a file is at most 256 KB. The phone's contract is `mobile/docs/agent-templates.md`. From a terminal: `botkins templates browse`, `botkins templates show <id>` and `botkins templates use <id>`.

Version 1 templates carry the bot profile. Version 2 adds an inline `bundle` for bot-specific skills, scheduled prompt routines, or both. Each installation makes independent copies. The template detail and create flow show what comes with the bot. See the [template bundle format](../../mobile/docs/agent-templates.md#template-bundles).

## What a plugin starts, and what you are shown

A plugin can start two kinds of things on the computer: a tool that is a program (a local MCP server), and a hook (a shell command that runs at an event of a chat). Before you install or switch on a plugin, Botkins shows each of them. The rule is: **what is shown is what starts, and all of it.**

- **One reading.** One piece of code reads a plugin's manifest, its tool files and its hook files (`desktop/plugin-reading.mjs`). The description that you see and the code that starts things both use its answer. A file, a key or a spelling that the description does not read is not read to start something.
- **Nothing is cut.** A hook's command is shown whole, up to 4,000 characters. A tool is shown with its command, each word of its arguments, its folder when it names one, and each environment name with its value. Botkins does not install a plugin that has a longer command, argument or value.
- **Environment values are shown as the plugin wrote them.** A value can be a command: `GIT_SSH_COMMAND` is one example, and no list of names can be complete. So you see each name with its written value. A secret is never in that text. A secret comes only from a setting, and the text then has `${NAME}`.
- **A header is shown with its written value, as an environment value is.** The same is true of the type of a tool on the web and of the client id that it names for the sign-in. For each setting of the plugin, you see where its value goes: which environment name of which tool or hook, or which header at which address.
- **Names a plugin cannot set.** A plugin cannot set a name that makes a program load or run more than its command says. A list of single names cannot be complete, so Botkins refuses by family. It does not set a name that starts with `PYTHON`, `RUBY`, `GEM_`, `NODE_`, `NPM_`, `GIT_`, `PHP_`, `PERL`, `JAVA_`, `_JAVA`, `JDK_`, `DOTNET_`, `OPENSSL_`, `LD_`, `DYLD_`, `BASH`, `XDG_`, `GIO_`, `LESS` or `LUA_`, in capitals or not. It does not set these single names: `ENV`, `SHELLOPTS`, `PROMPT_COMMAND`, `PS4`, `IFS`, `CDPATH`, `GLOBIGNORE`, `ZDOTDIR`, `PAGER`, `EDITOR`, `VISUAL`, `CLASSPATH`, `BUNDLE_GEMFILE`, `GCONV_PATH`, `SHELL`, `BROWSER`, `PHPRC`, `MAKEFLAGS`, `MAKEFILES`, `MAKELEVEL`, `AWS_CONFIG_FILE`, `KUBECONFIG`, `GOFLAGS`, `RUSTC_WRAPPER`, `PUPPETEER_EXECUTABLE_PATH`. The list can never be complete, and a plugin sets its own names freely: only these are held back. It does not set the names that Botkins or the system set: `PATH`, `HOME`, `NODE_PATH`, `PWD`, `OLDPWD`, `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `TEMP`, `TMP`, `TMPDIR`, `ELECTRON_RUN_AS_NODE`, `PYTHONDONTWRITEBYTECODE` and the Windows system names. These names are common and harmless, and a plugin can set them: `NODE_ENV`, `PYTHONUNBUFFERED`, `PYTHONIOENCODING`, `PYTHONUTF8`, `NO_COLOR`, `FORCE_COLOR`. The description names each name that the plugin asked for and that Botkins does not set, with the reason (`envNotSet`), so that an author knows why `NPM_TOKEN` or `JAVA_HOME` is not set. This is a second defense. The first is that you see each value.
- **The limit of what Botkins can show.** Botkins shows each command that it starts, and everything that it gives that command. A command runs with the plugin's own files, and Botkins cannot show all that those files make it do: `npx -y some-server` reads a `.npmrc` and a `node_modules` folder that are beside it, and `make` reads a `Makefile`. The description lists the plugin's other files (`otherFiles`) and marks the configuration files that tools read by themselves. Install a plugin only from a source that you trust.
- **Which files count.** The manifest is the first of these that exists: `.plugin/plugin.json`, `plugin.json`, `.github/plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`. If the manifest does not name the tools, Botkins reads all of `.mcp.json`, `mcp.json`, `.claude-plugin/.mcp.json` and `.claude-plugin/mcp.json`; a later tool with the same name replaces an earlier one. If the manifest does not name the hooks, Botkins uses the first of `hooks.json`, `hooks/hooks.json`, `.claude-plugin/hooks.json` and `.claude-plugin/hooks/hooks.json` that has a `hooks` object. A file name must match to the letter. A path with `..` is not a path of the plugin.
- **How a hook entry is read.** The command is the entry itself when it is text. Otherwise it is the first of `command`, `bash`, `cmd`, `shell`, `powershell`, `windows`, `darwin`, `macos`, `linux` that has text. The `type` of an entry is not read. A matcher of `*` or of nothing means every case, so such a hook runs. A hook with another `matcher`, at any level, does not run. The event names `UserPromptSubmit` and `Stop` are taken as `userPromptSubmitted` and `agentStop`. A hook for an event that Botkins does not have (`Notification`, `PreCompact`) does not run. The description says how many hooks and tools are not run, and lists the first of them with the reason (`notRun`). In that list are also: a tool of a type that Botkins does not have, a tool with no command or with an address that is not http or https, a hook with no command, the earlier of two spellings of one event, and, for an installed plugin, a tool that has the value of a secret setting in its line.
- **A tool's arguments and folder.** An argument that is a number or true/false is taken as its text. A folder that is not a full path is a folder in the plugin's own copy, and a path that leaves the copy is refused.
- **Agent, skill and command files.** The runtime reads the header of these files, and a header can name tools and hooks of its own, or tools that need no question (`allowed-tools`). Botkins writes each header again before the runtime gets the file. An agent keeps `name`, `description`, `model` and `tools`. A skill (`SKILL.md`) keeps `name` and `description`. A command keeps `name`, `description` and `argument-hint`. The keys that only hold a thing back stay, with a value of true or false: `disable-model-invocation`, `user-invocable`, and `infer` for an agent. A value that Botkins cannot read becomes the one that holds back most. No such file can start a tool or a hook, or take away a question.
- **Which files go to the runtime.** Only the files below `skills/`, `agents/` and `commands/`. Not a file or folder whose name starts with a dot, not `node_modules`, not a file of more than 1,000,000 bytes, not a path of more than ten parts, and below `agents/` only Markdown files. The description lists exactly these files.
- **Language servers.** Botkins lists the names in `lsp.json` and starts nothing from it.
- **The installed copy.** Botkins keeps a copy of the plugin's files, and its revision is the hash of those files. When you switch a plugin on, and each time a chat session opens, Botkins checks that the copy is still those files. Botkins looks again before each hook starts. If a file was changed, added or removed, or the copy has a `.git`, Botkins does not use the plugin and shows this: "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings."
- **A folder for a plugin's own data.** A plugin must not write into its own folder: a cache, a log or a database there makes the check fail. Each plugin has a data folder outside the copy, and an update keeps it. A hook and a tool that is a program both get its path in the environment, as `PLUGIN_DATA` and as `CLAUDE_PLUGIN_DATA`, with no need to name it. Botkins does not put `${PLUGIN_DATA}` or `${PLUGIN_ROOT}` into a tool's `command`, `args` or `cwd`. Those stay as written.
- **An install and an update name what you looked at.** Each one sends the revision of the description that you saw. Botkins refuses an install or an update that names no revision, from any caller, and refuses one whose source is another one by then.
- **A hook that keeps a turn going.** A hook for the end of a turn (`agentStop`, or `Stop` in Claude's form) can answer "block". The bot then does one more turn of the model, and you pay for each one. One plugin's hook can do that 3 times in a row. After that Botkins does not pass on a block from that plugin until your next message, and the turn's activity says so in one line. All plugins together can do it 6 times in one turn: two plugins that each use their three. That limit is for the turn of the chat, not for each bot: in a group chat all its bots share the six. More than that is a turn that does not end. The count belongs to your message: it goes on when the session is opened again in the middle of a turn, and it starts again with your next message. The number is 3 for this reason: a hook that checks the bot's work needs to send it back a few times, and a hook that sent it back three times and is still not content will not be content the fourth time. Claude's own tool tells a hook that it is in such a chain and lets the hook decide. Botkins does not leave that decision to a plugin. Two other ways for a hook to make a turn longer have no such limit today: a hook for an error that asks for a retry (Botkins passes on a count of two retries at most from it), and a hook that refuses each tool call, so that the bot tries again in another way.
- **What Botkins does not check.** A tool that is a running program is not looked at again in a session. A hook that runs already can write into the folder that Botkins made for the session. For both, code of a plugin that you approved runs already. A `.git` folder above the copy, in the data folder itself, is not looked for: a command such as `git status` in a hook reads the settings of the nearest one.
- **When the files cannot be read.** A check that could not be done is not taken for changed files. The plugin is not used at that moment, and Botkins tries again at the next look. While it stays so, the plugin shows: "Botkins could not read the installed files of this plugin to check them. Try again. If it stays so, update the plugin: Botkins writes its files again and keeps your settings."
- **A plugin that a bot asks for.** When a bot proposes a plugin in a chat, the card that you approve is made from the same description, whole: each command with its arguments, folder and environment values, each address with its headers, where each setting goes, what is not run, and the other files. No value in it is cut. The card also names the plugin's skills, agents and commands, and its language servers, of which Botkins starts none. A plugin that is too large for such a card is not asked about in the chat: the bot is told, the turn's activity has one line, and you make the change in Settings or on the command line, where all of it is shown. Only the owner gets this card. A team member's device does not get it, and a member cannot answer it.
- **A plugin's name is one word.** Letters, digits, dots, dashes and underscores, with a letter or a digit first, and 200 characters at most. The name is a part of the plugin's id, and the id is a word in commands that you run. Botkins does not install a plugin with another name, does not list such an entry of a marketplace, and does not add a marketplace with such a name.
- **One way in for a folder.** A plugin folder from your computer is always copied and shown. It cannot be linked as a folder of skills.
- **Botkins warns and does not block.** The owner's rule (2026-11-21): "warning a user as they enable a plugin is fine, but blocking them is not unless it truly looks malicious with a high confidence (supply chain, prompt injection or credential stealing for example)." So Botkins switches no plugin off by itself, and refuses no switch-on that you make. It refuses a copy whose files are not the reviewed ones, and an install or update that does not name the revision that you saw.

After an update from a version before this rule, Botkins reads each installed plugin again. An old description showed a program by its name only, and a hook's command up to 300 characters. If a plugin that is on starts anything more than that (an argument, a folder, an environment value, the rest of a long command), Botkins keeps it on and puts a note first in its warnings. It does the same when a hook of the plugin did not run in earlier versions and runs now: a hook with a matcher that means every case, and a hook for `UserPromptSubmit` or `Stop`. Such a hook gets what you write to the bot and can change it. Look at what it starts. The note goes when you switch the plugin on or off. A plugin whose copy cannot be read is not used, and shows the reason until an update writes its files again. A plugin folder that was linked as a folder of skills becomes an installed plugin, on as it was, with a note. Versions up to 0.17.2 switched such plugins off: they are on again, with the note. A linked folder that Botkins cannot copy shows as a plugin in error, with the reason. Put the folder right and start Botkins again, or remove it.

### The description (`plugins-v1`)

These are the fields of a plugin's description that say what it starts. A client shows all of them.

```ts
contents.mcpServers: (
  | { name: string; kind: "local"; command: string; args: string[]; env: { name: string; value: string }[]; envNotSet?: { name: string; why: string }[]; cwd?: string }
  | { name: string; kind: "remote"; type: "http" | "sse"; url: string; headers: { name: string; value: string }[]; oauth?: true; oauthClientId?: string; serverId?: string }
)[];
contents.hooks: { event: string; command: string; env: { name: string; value: string }[]; envNotSet?: { name: string; why: string }[]; timeoutSec: number }[];
contents.notRun?: { count: number; items: { what: "hook" | "tool"; name: string; why: string }[] };
contents.otherFiles: { count: number; bytes: number; files: { path: string; bytes: number; config?: true; files?: number }[] };
starts?: 1;
repair?: "update";
config[].sentTo?: ({ tool: string; env: string } | { tool: string; header: string; url: string } | { hook: string; env: string })[];
```

- `kind` is what Botkins does with the tool: `local` starts `command` with `args`, in `cwd`, with the environment in `env`. Without `cwd`, it starts in the plugin's own folder. A `cwd` that is not a full path is a folder in the plugin's own copy. `remote` connects to `url` and sends the headers in `headers`. `type` is how Botkins talks to the address. `headers` is each header's name with its value as the plugin wrote it, in the same way as `env`: a secret is never in that text, and the text then has `${NAME}`. `oauthClientId` is the client id that the plugin names for the sign-in. It is there only when the plugin names one.
- `env` is each environment name with its value as the plugin wrote it. The value can have `${NAME}` for a setting. `envNotSet` is each name that the plugin asked for and that Botkins does not set, with the reason as a sentence. Each program also gets `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` from Botkins, and each hook gets those, `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` and a short `PATH`. They are the same for every plugin, so the description does not list them.
- `contents.skills`, `contents.agents` and `contents.commands` are the files that go to the runtime, and no others.
- `notRun` is the hooks and tools of the plugin that Botkins does not run: `count` is how many, and `items` is the first 40, each with the reason as a sentence. `name` is the event as the plugin wrote it, or the tool's name.
- `otherFiles` is the plugin's files that are not a skill, an agent or a command: how many, their size, and up to 40 rows by path. `config: true` marks a file that tools read by themselves when a command runs in the plugin's folder. Such a file below `skills/`, `agents/` or `commands/` is in the rows too. A folder of dependencies (`node_modules/`, `.venv/`, `vendor/` and the like) is one row: its path ends with `/`, and `files` is how many files are in it.
- `starts: 1` is the mark of a description that the one reading made: every command that Botkins starts is in it, whole. An older app cannot make the mark, and Botkins never saves it: it is put on only in the answer. A preview has it. An installed plugin has it when its description was read from a copy that passed its last check. Between two checks Botkins reads no file for an answer, so the mark says who made the description, not that the copy was checked at that moment. A client trusts a description only when it has the mark.
- `event` is one of `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`, `sessionEnd`, `errorOccurred`. `command` is the whole command. `timeoutSec` is how long it may run.
- `sentTo` is each place that gets the value of the setting.
- For an installed plugin, these fields come from the installed copy each time, not from what was kept at install.
- A note about what nobody was shown is the first item of `warnings`. Botkins no longer switches a plugin off by itself, so `enabled: false` is always the person's own choice. A copy that cannot be read has `status: "error"`, a `detail` sentence and `repair: "update"`.
- An installed plugin has `repair: "update"` when an update is the way back: its copy is not the reviewed files, or its files cannot be read. A client offers Update from this mark, also when the source did not change. The update writes the files again and keeps the settings. When the update cannot be done (the source is gone), its refusal says to remove the plugin.
- An app that holds to this rule names the capability `plugin-starts-v1`. The promise is: every command that Botkins starts is shown, whole. It is not a promise about what those commands do. An app from before it names `plugins-v1` only, and its description can leave out a command that runs. A client that does not see `plugin-starts-v1` tells the person to update the app on the computer. A client decides about one description from its `starts` mark, because a list of names can be old for a moment and a description cannot.

## Runtime support

Copilot SDK sessions receive a per-bot plugin directory for supported content. Botkins configures the plugin’s MCP servers and runs supported hook events through SDK handlers. Pi and OMP sessions get the plugin's MCP servers too, and Botkins runs its `preToolUse` and `userPromptSubmitted` hooks itself, in its own approval step: a hook can change a call's arguments, ask the person or deny the call, and can change or block the person's message, with the same outcome as on Copilot. Each hook runs once for each call. On Pi and OMP a plugin's server has a short name of its own inside the harness, and Botkins shows it by the plugin's name in approvals and in the activity. The other hook events don't run on Pi and OMP yet. Direct Claude, Codex, OpenCode and ACP sessions use plugin skills only. This release skips plugin language servers and hook entries that specify a matcher. Local MCP processes receive the environment keys configured for that plugin and the system variables required to start the process. A plugin that is switched off or removed loses its tools at the next turn, also in a chat whose harness is still running.

The public plugin contract is `plugins-v1`. Its installed list includes per-bot scope, component descriptions and whether each field has been set. On a paired client, OAuth servers use `signInMcpServer(serverId)`. A preview’s revision identifies the source the person reviewed.

A switch-on can name `{ revision }`: `setPluginEnabled(id, true, { revision })`, with the `revision` of the installed plugin as the person saw it. A `revision` that is not the installed one gets the refusal "not the one that was looked at". A switch-on with no revision is not refused: the client warns the person before it. (The command line's control socket is the exception: it cannot know that a person is there, so its `plugins.setEnabled` needs the revision for a plugin that runs commands, and its `plugins.addFolder` adds such a plugin switched off.) A plugin runs commands when its description has a hook or a tool that is a local program.

Run `node --test test/*plugin*.test.mjs` for focused tests. Run `node test/plugins-public-live.mjs` to install the public Project Planning plugin in temporary directories and inspect the skill inventory of two signed-out SDK sessions. This check needs GitHub access. Run `node test/plugin-memory-live.mjs` for the isolated model, memory hook and MCP credential check.

Run `npm run test:runtime` for the two checks that use the real runtime with a model that is a script. They need no account, no token and no network, and they write only below the system's temporary folder. `test/hook-changed-args-live.mjs` holds that the command a person is asked about is the command that runs when a hook changes it, that a plugin's hook cannot take the question away, and that the limits on a hook that keeps a turn going hold. `test/skill-allowed-tools-live.mjs` holds that a skill's header does not take the question away and starts nothing. Each ends with `PASSED` or `FAILED` and the cases. Run them when the version of the SDK changes.
