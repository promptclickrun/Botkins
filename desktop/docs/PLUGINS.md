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
- **Nothing is cut.** A hook's command is shown whole, up to 4,000 characters. A tool is shown with its command, each word of its arguments, its folder when it names one, and the names of its environment values. Botkins does not install a plugin that has a longer command or argument.
- **Names, not values.** For an environment value and for a header, you see the name. For each setting of the plugin, you see where its value goes: which environment name of which tool or hook, or which header at which address.
- **Names a plugin cannot set.** A plugin cannot set a name that makes a program load more than its command says. These are: `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PROMPT_COMMAND`, `PS4`, `IFS`, `CDPATH`, `GLOBIGNORE`, `ZDOTDIR`, `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONINSPECT`, `PERL5OPT`, `PERL5LIB`, `PERLLIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `LUA_INIT`, `LUA_PATH`, `LUA_CPATH`, and each name that starts with `LD_`, `DYLD_` or `BASH_FUNC_`. A plugin also cannot set the names that Botkins or the system set: `PATH`, `HOME`, `NODE_PATH`, `PWD`, `OLDPWD`, `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `TEMP`, `TMP`, `TMPDIR`, `ELECTRON_RUN_AS_NODE`, `PYTHONDONTWRITEBYTECODE` and the Windows system names. Botkins ignores such a name, for a hook and for a tool.
- **Which files count.** The manifest is the first of these that exists: `.plugin/plugin.json`, `plugin.json`, `.github/plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`. If the manifest does not name the tools, Botkins reads all of `.mcp.json`, `mcp.json`, `.claude-plugin/.mcp.json` and `.claude-plugin/mcp.json`; a later tool with the same name replaces an earlier one. If the manifest does not name the hooks, Botkins uses the first of `hooks.json`, `hooks/hooks.json`, `.claude-plugin/hooks.json` and `.claude-plugin/hooks/hooks.json` that has a `hooks` object. A file name must match to the letter. A path with `..` is not a path of the plugin.
- **How a hook entry is read.** The command is the entry itself when it is text. Otherwise it is the first of `command`, `bash`, `cmd`, `shell`, `powershell`, `windows`, `darwin`, `macos`, `linux` that has text. The `type` of an entry is not read. A hook for an event that Botkins does not know, and a hook with a `matcher`, do not run and are not shown.
- **Agent files.** The runtime reads the header of an agent file, and a header can name tools and hooks of its own. Botkins writes each agent file's header again before the runtime gets it, with only `name`, `description`, `model` and `tools`. An agent file cannot start a tool or a hook.
- **The installed copy.** Botkins keeps a copy of the plugin's files, and its revision is the hash of those files. When you switch a plugin on, and each time a chat session opens, Botkins checks that the copy is still those files. If a file was changed, added or removed, Botkins does not use the plugin and shows this: "The installed files of this plugin are not the files that were reviewed. Remove the plugin and install it again." A plugin must write its data to `PLUGIN_DATA`, not into its own folder.
- **One way in for a folder.** A plugin folder from your computer is always copied, shown, and added switched off. It cannot be linked as a folder of skills.

After an update from a version before this rule, Botkins reads each installed plugin again. If a plugin starts a command that its old description did not have, Botkins switches the plugin off and says why. Look at what it starts, and switch it on again if you agree. A plugin folder that was linked as a folder of skills becomes an installed plugin that is switched off.

### The description (`plugins-v1`)

These are the fields of a plugin's description that say what it starts. A client shows all of them.

```ts
contents.mcpServers: (
  | { name: string; kind: "local"; command: string; args: string[]; env: string[]; cwd?: string }
  | { name: string; kind: "remote"; url: string; headers: string[]; oauth?: true; serverId?: string }
)[];
contents.hooks: { event: string; command: string; env: string[]; timeoutSec: number }[];
config[].sentTo?: ({ tool: string; env: string } | { tool: string; header: string; url: string } | { hook: string; env: string })[];
```

- `kind` is what Botkins does with the tool: `local` starts `command` with `args`, in `cwd` (without `cwd`, in the plugin's own folder), with the environment names in `env`. `remote` connects to `url` and sends the headers named in `headers`.
- `event` is one of `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`, `sessionEnd`, `errorOccurred`. `command` is the whole command. `timeoutSec` is how long it may run.
- `sentTo` is each place that gets the value of the setting.
- For an installed plugin, these fields come from the installed copy each time, not from what was kept at install.
- An installed plugin that Botkins switched off has `enabled: false` and a `detail` sentence with the reason.
- An app that holds to this rule names the capability `plugin-starts-v1`. An app from before it names `plugins-v1` only, and its description can leave out a command that runs. A client that does not see `plugin-starts-v1` asks first for every plugin, and tells the person to update the app on the computer.

## Runtime support

Copilot SDK sessions receive a per-bot plugin directory for supported content. Botkins configures the plugin’s MCP servers and runs supported hook events through SDK handlers. Direct Claude, Codex, OpenCode and ACP sessions use plugin skills. Hook handlers and plugin MCP servers require the Copilot harness. This release skips plugin language servers and hook entries that specify a matcher. Local MCP processes receive the environment keys configured for that plugin and the system variables required to start the process.

The public plugin contract is `plugins-v1`. Its installed list includes per-bot scope, component descriptions and whether each field has been set. On a paired client, OAuth servers use `signInMcpServer(serverId)`. A preview’s revision identifies the source the person reviewed.

Run `node --test test/*plugin*.test.mjs` for focused tests. Run `node test/plugins-public-live.mjs` to install the public Project Planning plugin in temporary directories and inspect the skill inventory of two signed-out SDK sessions. This check needs GitHub access. Run `node test/plugin-memory-live.mjs` for the isolated model, memory hook and MCP credential check.
