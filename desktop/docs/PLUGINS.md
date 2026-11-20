# Plugins

Open **Settings → Marketplace → Plugins**. Search a marketplace or choose **Installed**. Select a plugin to see its skills, agents, commands, hooks and MCP servers. A hook can run local code every time you send a message. Check the source and the commands before enabling it for your bots.

Choose **Add a marketplace** for a GitHub repository, a repository with a `#ref`, an HTTPS marketplace URL or a local marketplace folder. **Add from your computer** imports a plugin folder and leaves it switched off. Updating a plugin reviews a fresh copy. Removing the plugin leaves your original source folder intact.

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

## Runtime support

Copilot SDK sessions receive a per-bot plugin directory for supported content. Botkins configures the plugin’s MCP servers and runs supported hook events through SDK handlers. Direct Claude, Codex, OpenCode and ACP sessions use plugin skills. Hook handlers and plugin MCP servers require the Copilot harness. This release skips plugin language servers and hook entries that specify a matcher. Local MCP processes receive the environment keys configured for that plugin and the system variables required to start the process.

The public plugin contract is `plugins-v1`. Its installed list includes per-bot scope, component descriptions and whether each field has been set. On a paired client, OAuth servers use `signInMcpServer(serverId)`. A preview’s revision identifies the source the person reviewed.

Run `node --test test/*plugin*.test.mjs` for focused tests. Run `node test/plugins-public-live.mjs` to install the public Project Planning plugin in temporary directories and inspect the skill inventory of two signed-out SDK sessions. This check needs GitHub access. Run `node test/plugin-memory-live.mjs` for the isolated model, memory hook and MCP credential check.
