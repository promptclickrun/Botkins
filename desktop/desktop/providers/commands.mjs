// The "/" menu and typed slash commands for backends that have no command surface of their own
// (Codex, Claude Code, OpenCode, ACP agents). The Copilot adapter has its own in
// desktop/providers/copilot/commands.mjs, because Copilot's runtime answers most of its commands.
//
// `host` is the workspace: models(), applyModelCommand(), clearCatalogs(), clearApprovals() and state.

/** Commands the app's own page carries out (src/app.tsx) or that are answered here. */
const COMMANDS = [
  ["btw", ["ask"], "Ask a side question about this chat without adding it to the conversation.", "<question>"],
  ["help", [], "Show the commands and tools available in this chat."],
  ["model", [], "Choose the model and thinking level for this chat.", "[model] [thinking level]"],
  ["permissions", [], "Choose how tool requests are approved in this chat.", "[manual|read|assisted|allow-all|default]"],
  ["allow-all", [], "Approve every tool request in this chat."],
  ["reset-allowed-tools", [], "Forget the approvals remembered in this chat and ask again."],
  ["compact", [], "Summarize the conversation so far to free up room."],
  ["config", ["settings"], "Open Botkins settings and global defaults."],
  ["theme", [], "Customize appearance, chat bubbles and tool folding."],
  ["new", ["clear"], "Start a fresh conversation with this bot."],
  ["agent", ["agents"], "Choose a bot for a new conversation."],
  ["resume", [], "Browse your saved conversations."],
  ["login", ["user"], "Open the model providers and sign-in screen."],
  ["version", [], "Show the version of this chat's model provider."],
  ["search", [], "Search the messages in this conversation.", "<text>"],
  ["copy", [], "Copy the most recent assistant reply."],
];

const LEVELS = { manual: "ask", ask: "ask", read: "read", assisted: "assisted", "allow-all": "all", all: "all" };

/**
 * What the "/" menu lists for a session.
 * @param spec.name      The provider's name, shown as the source of its own commands.
 * @param spec.tools     Botkins' tools for the session (defineTool records).
 * @param spec.servers   [{ name, status, tools?: [{ name, description }] }] for the MCP servers.
 * @param spec.native    [{ name, description, hint?, kind? }] commands or skills the backend answers itself.
 * @param spec.compact   True when the backend can compact a conversation.
 */
export function buildInventory({ name, tools = [], servers = [], native = [], compact = false }) {
  const choices = [];
  const names = new Set();
  for (const item of native) {
    if (!item?.name || names.has(item.name)) continue;
    names.add(item.name);
    choices.push({
      name: item.name,
      command: item.name,
      aliases: [],
      kind: item.kind === "Skill" ? "Skill" : "Command",
      hint: item.hint || undefined,
      source: item.source || name,
      description: String(item.description ?? "").split("\n")[0].slice(0, 300),
      duringTurn: false,
      native: true,
    });
  }
  for (const [command, aliases, description, hint] of COMMANDS) {
    if (names.has(command) || (command === "compact" && !compact)) continue;
    names.add(command);
    choices.push({
      name: command,
      command,
      aliases: aliases.filter((a) => !names.has(a)),
      hint,
      kind: "Command",
      source: "Botkins",
      description,
      // The page carries these out itself, so they work while a reply is being written.
      duringTurn: !["model", "permissions", "allow-all", "reset-allowed-tools", "compact", "help", "version", "search"].includes(command),
    });
  }
  for (const tool of tools)
    choices.push({ name: tool.name, kind: "Tool", command: "tool:" + tool.name, source: "Botkins", description: String(tool.description ?? "").split("\n")[0].slice(0, 300) });
  for (const server of servers)
    for (const tool of server.tools ?? [])
      choices.push({ name: tool.name, kind: "Tool", command: "tool:" + tool.name, source: server.name, description: String(tool.description ?? "").split("\n")[0].slice(0, 300) });
  choices.sort(
    (a, b) => Number(b.name.startsWith("today")) - Number(a.name.startsWith("today")) || a.kind.localeCompare(b.kind) || a.command.localeCompare(b.command),
  );
  return { choices, servers: servers.map(({ name, status }) => ({ name, status })), plugins: [] };
}

/**
 * What a typed message does, for a session without a command surface of its own.
 * `session` is the ProviderSession: inventory(), provider, and the optional compact().
 */
export async function resolvePrompt(session, prompt, run, chat, host) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return { kind: "agent-prompt", prompt };
  const [, typed, args = ""] = match;
  const { choices } = await session.inventory();
  if (typed.startsWith("tool:")) {
    const item = choices.find((c) => c.command === typed);
    if (!item) throw new Error("This tool is unavailable. Type / to refresh the list.");
    return {
      kind: "agent-prompt",
      // The person picked this tool by name, so it is called even when another tool looks similar.
      prompt:
        "The person chose the tool `" + item.name + "` from the menu. Call that exact tool for this request, not a different tool. Ask for any missing required input.\n\n" + args,
    };
  }
  const name = typed.toLowerCase();
  const item = choices.find((c) => c.kind !== "Tool" && (c.command.toLowerCase() === name || c.aliases?.some((a) => a.toLowerCase() === name)));
  if (!item) throw new Error("Unknown command /" + typed + ". Type / to see this chat’s capabilities.");
  run.command = item.command;
  // The backend's own commands and skills go to it as typed.
  if (item.native) {
    if (item.kind === "Skill") run.skill = item.command;
    return { kind: "agent-prompt", prompt };
  }
  const text = (value) => ({ kind: "text", text: value });
  switch (item.command) {
    case "model": {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return { kind: "show-dialog", dialog: { kind: "model-picker" } };
      if (parts[0] === "default") {
        delete chat.model;
        host.clearCatalogs();
        return text("This chat follows its bot’s model and thinking default.");
      }
      if (parts.length > 2) throw new Error("Use /model <id> [thinking level].");
      const catalog = await host.models();
      // Typed names match a model's id or its display name; a model of this chat's provider wins a tie.
      const wanted = parts[0].toLowerCase();
      const found = catalog.filter((m) => m.id.toLowerCase() === wanted || m.name.toLowerCase().replace(/\s+/g, "-") === wanted);
      const model = found.find((m) => m.provider === session.provider?.id) ?? found[0];
      if (!model) throw new Error("Unknown model. Type /model to choose one.");
      await host.applyModelCommand(session, chat, { model: model.id, provider: model.provider, ...(model.source && { source: model.source }), reasoningEffort: parts[1] });
      return text("Chat model set to " + [model.name, parts[1]].filter(Boolean).join(" · ") + ".");
    }
    case "allow-all":
      chat.approval = "all";
      return text("Tools are approved automatically in this chat. Use /permissions default to follow the global setting.");
    case "permissions": {
      const level = args.trim();
      if (!level)
        return {
          kind: "select-subcommand",
          command: "permissions",
          title: "Tool approvals · " + (chat.approval ?? "global (" + host.state.settings.approval + ")"),
          options: [
            { name: "manual", description: "Ask for each request" },
            { name: "read", description: "Allow read-only tools" },
            { name: "assisted", description: "Let the provider review requests and ask when unsure" },
            { name: "allow-all", description: "Approve all tools" },
            { name: "default", description: "Follow the global setting" },
          ],
        };
      if (level === "default") {
        delete chat.approval;
        return text("This chat follows the global approval setting.");
      }
      if (!Object.hasOwn(LEVELS, level)) throw new Error("Use /permissions manual, read, assisted, allow-all or default.");
      chat.approval = LEVELS[level];
      return text("Chat approval level set to " + level + ".");
    }
    case "reset-allowed-tools":
      host.clearApprovals(chat.id);
      chat.approval = "ask";
      return text("Approvals for this chat were forgotten. Tool requests ask again.");
    case "compact":
      if (!session.compact) throw new Error("This model provider can't compact a conversation.");
      await session.compact();
      return text("The conversation so far was summarized.");
    case "version":
      return text(await session.provider.version());
    case "search": {
      const query = args.trim().toLowerCase();
      if (!query) throw new Error("Use /search followed by text.");
      const hits = chat.messages
        .slice(0, -1)
        .filter((m) => m.text.toLowerCase().includes(query))
        .slice(-30)
        .map((m) => m.role + " · " + m.text.slice(0, 600))
        .join("\n\n");
      return text(hits || "No matching messages.");
    }
    case "help":
      return text(
        choices
          .map((c) => "/" + c.command + (c.aliases?.length ? " (" + c.aliases.map((a) => "/" + a).join(", ") + ")" : "") + " — " + c.description)
          .join("\n"),
      );
    default:
      // The rest (/new, /config, /btw …) are carried out by the app's page before a message is sent.
      return text("/" + item.command + " is handled by Botkins' window.");
  }
}
