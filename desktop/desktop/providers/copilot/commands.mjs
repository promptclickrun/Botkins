// Copilot's command surface: the "/" menu (commands, skills and tools) and what a typed
// slash command does. Everything here talks to the Copilot SDK session, so it lives in the adapter.
// `host` is the workspace: models(), applyModelCommand(), clearCatalogs(), clearApprovals() and state.
import { friendlyModel } from "../../modelnames.mjs";
import { nextTime } from "../../panels.mjs";

// These are desktop surfaces for Copilot operations that are normally owned by its terminal UI.
export const desktopCommands = [
  [
    "btw",
    ["ask"],
    "Ask a side question about this chat without adding it to the conversation.",
    "<question>",
  ],
  ["help", [], "Show the commands, skills and tools available in this chat."],
  ["config", ["settings"], "Open Botkins settings and global defaults."],
  ["theme", [], "Customize appearance, chat bubbles and tool folding."],
  ["new", ["clear"], "Start a fresh conversation with this bot."],
  ["agent", ["agents"], "Choose a bot for a new conversation."],
  ["resume", [], "Browse your saved conversations."],
  ["login", ["user"], "Open the Copilot account and sign-in screen."],
  ["tasks", [], "List Copilot's shell tasks and subagents for this session."],
  [
    "instructions",
    [],
    "Inspect or reload the instruction sources Copilot loaded.",
    "[reload]",
  ],
  [
    "lsp",
    [],
    "List, start, stop or diagnose language servers in this workspace.",
    "[list|start|stop|diagnose]",
  ],
  ["version", [], "Show the running Copilot harness version."],
  ["search", [], "Search the messages in this conversation.", "<text>"],
  ["copy", [], "Copy the most recent assistant reply."],
];

async function commandChoices(session) {
  await session.rpc.skills.ensureLoaded();
  const [{ commands }, { skills }] = await Promise.all([
    session.rpc.commands.list({
      includeBuiltins: true,
      includeSkills: true,
      includeClientCommands: true,
    }),
    session.rpc.skills.list(),
  ]);
  const enabled = new Map(
    skills
      .filter((s) => s.enabled && s.userInvocable)
      .map((s) => [s.commandName || s.name, s]),
  );
  const choices = commands.map((c) => {
    const skill = enabled.get(c.name);
    return {
      name: c.name,
      command: c.name,
      kind: c.kind === "skill" ? "Skill" : "Command",
      aliases: c.aliases ?? [],
      hint: c.input?.hint,
      options: c.input?.choices ?? [],
      source:
        skill?.pluginName ||
        skill?.source ||
        (c.kind === "client" ? "Extension" : "Copilot"),
      description: c.description || skill?.description || "",
      schedulable: c.schedulable,
      duringTurn: !!c.allowDuringAgentExecution,
    };
  });
  const names = new Set(choices.flatMap((c) => [c.command, ...c.aliases]));
  for (const [name, s] of enabled)
    if (!names.has(name)) {
      choices.push({
        name,
        command: name,
        aliases: [],
        kind: "Skill",
        source: s.pluginName || s.source,
        description: s.description,
        duringTurn: false,
      });
      names.add(name);
    }
  for (const [name, aliases, description, hint] of desktopCommands) {
    if (!names.has(name))
      choices.push({
        name,
        command: name,
        aliases: aliases.filter((a) => !names.has(a)),
        hint,
        kind: "Command",
        source: "Botkins",
        description,
        duringTurn: true,
      });
  }
  return choices;
}

export async function inventory(session) {
  // A server that is still starting ("pending") has no tools to list yet. In a session that just
  // opened, look again for up to 5 seconds so the menu isn't built without them.
  let servers, plugins;
  for (let tries = 0; ; tries++) {
    [{ servers }, { plugins }] = await Promise.all([
      session.rpc.mcp.list(),
      session.rpc.plugins.list(),
    ]);
    if (tries >= 10 || !servers.some((s) => s.status === "pending")) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await session.rpc.tools.initializeAndValidate();
  const [{ tools }, choices] = await Promise.all([
    session.rpc.tools.getCurrentMetadata(),
    commandChoices(session),
  ]);
  if (!tools) throw new Error("Copilot has not initialized this bot’s tools.");
  for (const t of tools) {
    if (
      t.mcpServerName &&
      !servers.some(
        (s) => s.name === t.mcpServerName && s.status === "connected",
      )
    )
      continue;
    choices.push({
      name: t.name,
      kind: "Tool",
      command: "tool:" + t.name,
      source: t.mcpServerName || "Copilot",
      description: t.description.split("\n")[0].slice(0, 300),
    });
  }
  choices.sort(
    (a, b) =>
      Number(b.name.startsWith("today")) - Number(a.name.startsWith("today")) ||
      a.kind.localeCompare(b.kind) ||
      a.command.localeCompare(b.command),
  );
  return {
    choices,
    // The runtime's own GitHub server is always switched off here (see sessionOptions), so it isn't listed.
    servers: servers.filter((s) => !(s.name === "github-mcp-server" && s.status === "disabled")).map(({ name, status }) => ({ name, status })),
    plugins: plugins.map(({ name, enabled }) => ({ name, enabled })),
  };
}

/**
 * What a typed message does. `wrapper` is the provider session Botkins holds; its `sdk` is the
 * Copilot SDK session.
 */
export async function resolvePrompt(wrapper, prompt, run, chat, ws) {
  const session = wrapper.sdk;
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return { kind: "agent-prompt", prompt };
  const [, typed, args = ""] = match;
  if (typed.startsWith("tool:")) {
    // A resumed session reconnects its MCP servers, and a server can report "connected" a moment before
    // its tools are listed. Look again for up to 3 seconds, or up to 10 while a server is still starting.
    let found = await inventory(session);
    for (let tries = 0; tries < 20 && !found.choices.some((c) => c.command === typed); tries++) {
      const starting = found.servers.some((s) => s.status === "pending");
      if (!starting && tries >= 6) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      found = await inventory(session);
    }
    const item = found.choices.find((c) => c.command === typed);
    if (!item)
      throw new Error("This tool is unavailable. Type / to refresh the list.");
    return {
      kind: "agent-prompt",
      // The person picked this tool by name, so it is called even when a skill or another tool looks similar.
      prompt:
        "The person chose the tool `" +
        item.name +
        "` from the menu. Call that exact tool for this request, not a skill or a different tool. Ask for any missing required input.\n\n" +
        args,
    };
  }
  const catalog = await commandChoices(session);
  const name = typed.toLowerCase();
  const item = catalog.find(
    (c) =>
      c.command.toLowerCase() === name ||
      c.aliases.some((a) => a.toLowerCase() === name),
  );
  if (!item)
    throw new Error(
      "Unknown command /" + typed + ". Type / to see this chat’s capabilities.",
    );
  if (run.trigger === "scheduled" && item.schedulable === false)
    throw new Error("This Copilot command cannot be scheduled.");
  run.command = item.command;
  if (chat && ["every", "after"].includes(item.command))
    return scheduledCommand(session, chat, item.command, args.trim());
  if (item.command === "model") {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (!parts.length)
      return { kind: "show-dialog", dialog: { kind: "model-picker" } };
    if (["plan", "--plan"].includes(parts[0])) {
      if (parts.length === 1) {
        const models = (await ws.models()).filter((m) => m.available);
        return {
          kind: "select-subcommand",
          command: "model plan",
          title: "Plan mode model · " + (chat.planModel || "chat default"),
          options: [
            { name: "default", description: "Use the chat model" },
            ...models.map((m) => ({ name: m.id, description: m.name })),
          ],
        };
      }
      if (parts[1] === "default") delete chat.planModel;
      else if (
        (await ws.models()).some((m) => m.available && m.id === parts[1])
      )
        chat.planModel = parts[1];
      else
        throw new Error(
          "Unknown plan model. Use /model plan to choose a model.",
        );
      return {
        kind: "text",
        text:
          "Plan mode model set to " + (chat.planModel || "chat default") + ".",
      };
    }
    if (parts[0] === "default") {
      delete chat.model;
      ws.clearCatalogs();
      return {
        kind: "text",
        text: "This chat follows its bot’s model and thinking default.",
      };
    }
    if (parts[0].startsWith("--"))
      return {
        kind: "text",
        text: "For a Botkins default, open Settings → General or Bot. Use /model <id> [thinking level] to set this chat, or /model plan to choose a plan model.",
      };
    const named = (await ws.models()).find((m) => m.id === parts[0]);
    if (named) {
      if (parts.length > 2)
        throw new Error("Use /model <id> [thinking level].");
      await ws.applyModelCommand(wrapper, chat, {
        model: parts[0],
        reasoningEffort: parts[1],
      });
      // Said by the model's name, not its id.
      return {
        kind: "text",
        text: "Chat model set to " + [named.name ?? friendlyModel(parts[0]), parts[1]].filter(Boolean).join(" · ") + ".",
      };
    }
  }
  if (item.command === "allow-all" && !args) {
    chat.approval = "all";
    return {
      kind: "text",
      text: "Copilot will auto-approve tools in this chat. Use /permissions default to follow the global setting.",
    };
  }
  if (item.command === "permissions") {
    const levels = {
      manual: "ask",
      ask: "ask",
      read: "read",
      assisted: "assisted",
      "allow-all": "all",
      all: "all",
    };
    if (!args)
      return {
        kind: "select-subcommand",
        command: "permissions",
        title:
          "Tool approvals · " +
          (chat.approval ?? "global (" + ws.state.settings.approval + ")"),
        options: [
          { name: "manual", description: "Ask for each request" },
          { name: "read", description: "Allow read-only tools" },
          { name: "assisted", description: "Copilot assisted approvals" },
          { name: "allow-all", description: "Approve all tools" },
          { name: "default", description: "Follow the global setting" },
        ],
      };
    if (args.trim() === "default") {
      delete chat.approval;
      return {
        kind: "text",
        text: "This chat follows the global approval setting.",
      };
    }
    if (Object.hasOwn(levels, args.trim())) {
      chat.approval = levels[args.trim()];
      return {
        kind: "text",
        text: "Chat approval level set to " + args.trim() + ".",
      };
    }
  }
  if (item.command === "reset-allowed-tools") {
    ws.clearApprovals(chat.id);
    chat.approval = "ask";
  }
  if (item.source === "Botkins") {
    const output = (value, empty) => ({
      kind: "text",
      text: value?.length ? value : empty,
    });
    switch (item.command) {
      case "tasks": {
        const { tasks } = await session.rpc.tasks.list();
        return output(
          tasks
            .map((t) =>
              [t.id, t.name || t.description || t.type, t.status]
                .filter(Boolean)
                .join(" · "),
            )
            .join("\n"),
          "No background tasks in this session.",
        );
      }
      case "instructions": {
        if (args && args.trim() !== "reload")
          throw new Error("Use /instructions or /instructions reload.");
        const { sources } =
          await session.rpc.instructions[args ? "reload" : "getSources"]();
        return output(
          sources.map((s) => s.label + " · " + s.sourcePath).join("\n"),
          "No external instruction files were loaded.",
        );
      }
      case "lsp": {
        const [action = "list", serverId] = args
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (
          !["list", "start", "stop", "diagnose"].includes(action) ||
          (action === "diagnose" && !serverId)
        )
          throw new Error(
            "Use /lsp list, start, stop, or diagnose <server id>.",
          );
        const data = await session.rpc.lsp[action](
          action === "diagnose" ? { serverId } : {},
        );
        return {
          kind: "text",
          text: data
            ? JSON.stringify(data, null, 2)
            : "Language servers stopped.",
        };
      }
      case "version":
        return { kind: "text", text: await wrapper.provider.version() };
      case "search": {
        const query = args.trim().toLowerCase();
        if (!query) throw new Error("Use /search followed by text.");
        return output(
          chat.messages
            .slice(0, -1)
            .filter((m) => m.text.toLowerCase().includes(query))
            .slice(-30)
            .map((m) => m.role + " · " + m.text.slice(0, 600))
            .join("\n\n"),
          "No matching messages.",
        );
      }
    }
  }
  // Fleet mode starts helpers that outlive the command call. Run it as a turn so the reply waits for
  // them and their results land in this chat.
  if (item.command === "fleet" && session.rpc?.fleet?.start)
    return { kind: "agent-prompt", prompt: args, fleet: true };
  if (item.kind === "Skill") run.skill = item.command;
  if (item.command === "help") {
    const { choices } = await inventory(session);
    return {
      kind: "text",
      text: choices
        .map(
          (c) =>
            "/" +
            c.command +
            (c.aliases?.length
              ? " (" + c.aliases.map((a) => "/" + a).join(", ") + ")"
              : "") +
            " — " +
            c.description,
        )
        .join("\n"),
    };
  }
  return session.rpc.commands.invoke({ name: item.command, input: args });
}

// Copilot parses the CLI time expressions. Botkins owns the clock while individual SDK sessions disconnect between turns.
async function scheduledCommand(session, chat, name, input) {
  const schedules = chat.schedules ?? [];
  if (!input || /^(list|status)$/i.test(input)) {
    return {
      kind: "text",
      text: schedules.length
        ? schedules
            .map(
              (s) =>
                "#" +
                s.id +
                " · " +
                (s.routine ? s.name + " · " : "") +
                (s.recurring ? "Recurring" : "Once") +
                " · " +
                (s.enabled === false
                  ? "Paused"
                  : s.nextAt == null
                    ? "Finished"
                    : new Date(s.nextAt).toLocaleString()) +
                "\n" +
                s.prompt,
            )
            .join("\n\n") + "\n\nUse /every stop <number> to cancel."
        : "No scheduled prompts in this chat.",
    };
  }
  const stop = /^(?:stop|cancel|remove)\s+#?(\d+)$/i.exec(input);
  if (stop) {
    if (!schedules.some((s) => s.id === Number(stop[1])))
      throw new Error("Unknown schedule #" + stop[1]);
    chat.schedules = schedules.filter((s) => s.id !== Number(stop[1]));
    return { kind: "text", text: "Stopped schedule #" + stop[1] + "." };
  }
  const before = new Set(
    (await session.rpc.schedule.list()).entries.map((s) => s.id),
  );
  const effect = await session.rpc.commands.invoke({ name, input });
  const added = (await session.rpc.schedule.list()).entries.filter(
    (s) => !before.has(s.id),
  );
  if (!added.length) return effect;
  const receipts = [];
  for (const entry of added) {
    const nextAt = entry.nextRunAt
      ? Date.parse(entry.nextRunAt)
      : (entry.at ?? (entry.cron ? nextTime(entry.cron, entry.tz) : NaN));
    if (
      !Number.isFinite(nextAt) ||
      !entry.prompt ||
      (entry.recurring && !entry.cron && !(entry.intervalMs > 0))
    )
      throw new Error("Copilot returned an invalid schedule.");
    // Transfer the timer before disconnecting so there is only one dispatcher.
    const stopped = await session.rpc.schedule.stop({ id: entry.id });
    if (!stopped.entry)
      throw new Error(
        "The schedule changed before Botkins could take ownership.",
      );
    const id = (chat.lastScheduleId ?? 0) + 1;
    chat.lastScheduleId = id;
    (chat.schedules ??= []).push({
      id,
      prompt: entry.prompt,
      nextAt,
      intervalMs: entry.intervalMs,
      cron: entry.cron,
      timezone: entry.tz,
      recurring: entry.recurring,
    });
    receipts.push(
      "#" +
        id +
        " · " +
        new Date(nextAt).toLocaleString() +
        " · " +
        entry.prompt,
    );
  }
  return {
    kind: "text",
    text:
      "Scheduled in this chat\n" +
      receipts.join("\n") +
      "\n\nUse /every to manage scheduled prompts.",
  };
}
