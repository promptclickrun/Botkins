# Plugins

Open **Settings → Marketplace → Plugins**. Search a marketplace or choose **Installed**. Three marketplaces are built in: **Botkins** ([promptclickrun/botkins-marketplace](https://github.com/promptclickrun/botkins-marketplace), first-party plugins such as Hevy), **GitHub** (`github/awesome-copilot`) and **Copilot plugins** (`github/copilot-plugins`). Select a plugin to see its skills, agents, commands, hooks and MCP servers. A hook can run local code every time you send a message. Check the source and the commands before enabling it for your bots.

Choose **Add a marketplace** for a GitHub repository, a repository with a `#ref`, an HTTPS marketplace URL or a local marketplace folder. **Add from your computer** imports a plugin folder and leaves it switched off. It is the only way to add a plugin folder: a plugin folder is not linked as a folder of skills. Updating a plugin reviews a fresh copy. Removing the plugin leaves your original source folder intact.

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

## What a plugin starts, and what you are shown

A plugin can start two kinds of things on the computer: a tool that is a program (a local MCP server), and a hook (a shell command that runs at an event of a chat). Before you install or switch on a plugin, Botkins shows each of them. The rule is: **what is shown is what starts, and all of it.**

- **One reading.** One piece of code reads a plugin's manifest, its tool files and its hook files (`desktop/plugin-reading.mjs`). The description that you see and the code that starts things both use its answer. A file, a key or a spelling that the description does not read is not read to start something.
- **Nothing is cut.** A hook's command is shown whole, up to 4,000 characters. A tool is shown with its command, each word of its arguments, its folder when it names one, and each environment name with its value. Botkins does not install a plugin that has a longer command, argument or value.
- **Environment values are shown as the plugin wrote them.** A value can be a command: `GIT_SSH_COMMAND` is one example, and no list of names can be complete. So you see each name with its written value. A secret is never in that text. A secret comes only from a setting, and the text then has `${NAME}`.
- **A header is shown by its name.** For each setting of the plugin, you see where its value goes: which environment name of which tool or hook, or which header at which address.
- **Names a plugin cannot set.** A plugin cannot set a name that makes a program load more than its command says. These are: `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PROMPT_COMMAND`, `PS4`, `IFS`, `CDPATH`, `GLOBIGNORE`, `ZDOTDIR`, `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONINSPECT`, `PERL5OPT`, `PERL5LIB`, `PERLLIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `LUA_INIT`, `LUA_PATH`, `LUA_CPATH`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`, `GIT_EXEC_PATH`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_PROXY_COMMAND`, `PAGER`, `EDITOR`, `VISUAL`, `LESSOPEN`, `LESSCLOSE`, `DOTNET_STARTUP_HOOKS`, `CLASSPATH`, `BUNDLE_GEMFILE`, `XDG_CONFIG_HOME`, and each name that starts with `LD_`, `DYLD_`, `BASH_FUNC_`, `GIT_CONFIG` or `NPM_CONFIG_` (in capitals or not). The list is a second defense. The first is that you see each value. A plugin also cannot set the names that Botkins or the system set: `PATH`, `HOME`, `NODE_PATH`, `PWD`, `OLDPWD`, `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `TEMP`, `TMP`, `TMPDIR`, `ELECTRON_RUN_AS_NODE`, `PYTHONDONTWRITEBYTECODE` and the Windows system names. Botkins does not set such a name, for a hook and for a tool. The description names each one that the plugin asked for (`envNotSet`), so that you know why a tool does not work.
- **Which files count.** The manifest is the first of these that exists: `.plugin/plugin.json`, `plugin.json`, `.github/plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`. If the manifest does not name the tools, Botkins reads all of `.mcp.json`, `mcp.json`, `.claude-plugin/.mcp.json` and `.claude-plugin/mcp.json`; a later tool with the same name replaces an earlier one. If the manifest does not name the hooks, Botkins uses the first of `hooks.json`, `hooks/hooks.json`, `.claude-plugin/hooks.json` and `.claude-plugin/hooks/hooks.json` that has a `hooks` object. A file name must match to the letter. A path with `..` is not a path of the plugin.
- **How a hook entry is read.** The command is the entry itself when it is text. Otherwise it is the first of `command`, `bash`, `cmd`, `shell`, `powershell`, `windows`, `darwin`, `macos`, `linux` that has text. The `type` of an entry is not read. A hook for an event that Botkins does not know, and a hook with a `matcher` at any level, do not run and are not shown.
- **A tool's arguments and folder.** An argument that is a number or true/false is taken as its text. A folder that is not a full path is a folder in the plugin's own copy, and a path that leaves the copy is refused.
- **Agent, skill and command files.** The runtime reads the header of these files, and a header can name tools and hooks of its own, or tools that need no question (`allowed-tools`). Botkins writes each header again before the runtime gets the file. An agent keeps `name`, `description`, `model` and `tools`. A skill (`SKILL.md`) keeps `name` and `description`. A command keeps `name`, `description` and `argument-hint`. The keys that only hold a thing back stay, with a value of true or false: `disable-model-invocation`, `user-invocable`, and `infer` for an agent. A value that Botkins cannot read becomes the one that holds back most. No such file can start a tool or a hook, or take away a question.
- **Which files go to the runtime.** Only the files below `skills/`, `agents/` and `commands/`. Not a file or folder whose name starts with a dot, not `node_modules`, not a file of more than 1,000,000 bytes, not a path of more than ten parts, and below `agents/` only Markdown files. The description lists exactly these files.
- **Language servers.** Botkins lists the names in `lsp.json` and starts nothing from it.
- **The installed copy.** Botkins keeps a copy of the plugin's files, and its revision is the hash of those files. When you switch a plugin on, and each time a chat session opens, Botkins checks that the copy is still those files. Botkins looks again before each hook starts. If a file was changed, added or removed, or the copy has a `.git`, Botkins does not use the plugin and shows this: "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings."
- **A folder for a plugin's own data.** A plugin must not write into its own folder: a cache, a log or a database there makes the check fail. Each plugin has a data folder outside the copy, and an update keeps it. A hook and a tool that is a program both get its path in the environment, as `PLUGIN_DATA` and as `CLAUDE_PLUGIN_DATA`, with no need to name it. Botkins does not put `${PLUGIN_DATA}` or `${PLUGIN_ROOT}` into a tool's `command`, `args` or `cwd`. Those stay as written.
- **One way in for a folder.** A plugin folder from your computer is always copied, shown, and added switched off. It cannot be linked as a folder of skills.

After an update from a version before this rule, Botkins reads each installed plugin again. An old description showed a program by its name only, and a hook's command up to 300 characters. If a plugin that is on starts anything more than that (an argument, a folder, an environment value, the rest of a long command), Botkins switches the plugin off and says why. That is nearly every plugin with a program. Look at what it starts one time, and switch it on again if you agree. A plugin whose copy cannot be read is switched off too, until an update writes its files again. A plugin folder that was linked as a folder of skills becomes an installed plugin that is switched off.

### The description (`plugins-v1`)

These are the fields of a plugin's description that say what it starts. A client shows all of them.

```ts
contents.mcpServers: (
  | { name: string; kind: "local"; command: string; args: string[]; env: { name: string; value: string }[]; envNotSet?: string[]; cwd?: string }
  | { name: string; kind: "remote"; url: string; headers: string[]; oauth?: true; serverId?: string }
)[];
contents.hooks: { event: string; command: string; env: { name: string; value: string }[]; envNotSet?: string[]; timeoutSec: number }[];
config[].sentTo?: ({ tool: string; env: string } | { tool: string; header: string; url: string } | { hook: string; env: string })[];
```

- `kind` is what Botkins does with the tool: `local` starts `command` with `args`, in `cwd`, with the environment in `env`. Without `cwd`, it starts in the plugin's own folder. A `cwd` that is not a full path is a folder in the plugin's own copy. `remote` connects to `url` and sends the headers named in `headers`.
- `env` is each environment name with its value as the plugin wrote it. The value can have `${NAME}` for a setting. `envNotSet` is each name that the plugin asked for and that Botkins does not set. Each program also gets `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` from Botkins, and each hook gets those, `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` and a short `PATH`. They are the same for every plugin, so the description does not list them.
- `contents.skills`, `contents.agents` and `contents.commands` are the files that go to the runtime, and no others.
- `event` is one of `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`, `sessionEnd`, `errorOccurred`. `command` is the whole command. `timeoutSec` is how long it may run.
- `sentTo` is each place that gets the value of the setting.
- For an installed plugin, these fields come from the installed copy each time, not from what was kept at install.
- An installed plugin that Botkins switched off has `enabled: false` and a `detail` sentence with the reason.
- An app that holds to this rule names the capability `plugin-starts-v1`. An app from before it names `plugins-v1` only, and its description can leave out a command that runs. A client that does not see `plugin-starts-v1` asks first for every plugin, and tells the person to update the app on the computer.

## Runtime support

Copilot SDK sessions receive a per-bot plugin directory for supported content. Botkins configures the plugin’s MCP servers and runs supported hook events through SDK handlers. Direct Claude, Codex, OpenCode and ACP sessions use plugin skills. Hook handlers and plugin MCP servers require the Copilot harness. This release skips plugin language servers and hook entries that specify a matcher. Local MCP processes receive the environment keys configured for that plugin and the system variables required to start the process.

The public plugin contract is `plugins-v1`. Its installed list includes per-bot scope, component descriptions and whether each field has been set. On a paired client, OAuth servers use `signInMcpServer(serverId)`. A preview’s revision identifies the source the person reviewed.

Run `node --test test/*plugin*.test.mjs` for focused tests. Run `node test/plugins-public-live.mjs` to install the public Project Planning plugin in temporary directories and inspect the skill inventory of two signed-out SDK sessions. This check needs GitHub access. Run `node test/plugin-memory-live.mjs` for the isolated model, memory hook and MCP credential check.
