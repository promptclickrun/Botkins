// Teamwork: in a chat with one bot, that bot can bring in other bots for the parts they do best.
// The asking bot calls ask_teammate; the teammate works in its own session (its own instructions,
// model, skills and memory) and its reply comes back as the tool's result. The asking bot still
// writes the person's answer. Each ask is recorded on the turn (run.teamwork) so the chat can
// show who was asked, what they are doing and what they answered.
//
// Rules:
// - Settings › Teamwork turns it on or off for the whole app; a bot can be kept out of it.
// - A teammate needs access to the chat's project to be asked there.
// - A teammate gets only the message written for it, never the chat, and one line saying whose request it is.
// - A teammate can't ask further teammates, so requests never loop.
// - Up to 8 asks per reply, and the same message is never sent to the same teammate twice.
// - Anything a teammate needs approved is asked in the chat it was called from.
import { randomUUID } from "node:crypto";
import { defineTool } from "./providers/provider.mjs";
import { isGroup } from "./groups.mjs";
import { OutgoingDispatches, peerCapabilities, peerRoster, remoteJob, remoteReply, remoteTeamworkAllowed, requireRemoteTurn } from "./remote-teamwork.mjs";
import { LIST_FILES_OPERATION } from "./node-host.mjs";
import { canUseProject } from "./access.mjs";
import { bindRailStep, recordActivity } from "./activity.mjs";
import { recordCanvas } from "./canvas.mjs";

export const MAX_TEAM = 16;
export const MAX_ASKS = 8;
const MESSAGE_MAX = 16000;
const REPLY_MAX = 32000;

/** The session a teammate keeps for one chat, so follow-up asks there build on earlier ones. */
export const helperSessionId = (chat, botId) => (chat.sessionId ?? chat.id) + "-team-" + botId;

const line = (bot) => "- " + bot.name + ": " + bot.role + "." + (bot.summary ? " " + bot.summary.trim().slice(0, 200) : "");

export class Teamwork {
  constructor(ws) {
    this.ws = ws;
    this.outgoing = new OutgoingDispatches(ws, ws.state.outgoingDispatches);
    delete ws.state.outgoingDispatches;
  }
  get enabled() {
    return this.ws.state.settings.teamwork !== false;
  }
  /** The bots this one may ask from this chat. Empty when Teamwork doesn't apply. */
  roster(bot, chat) {
    if (!this.enabled || bot.teamwork === false || isGroup(chat) || chat.group || chat.helper) return [];
    const project = this.ws.projects.projectOf(chat);
    return this.ws.state.bots
      .filter((b) => b.id !== bot.id && b.teamwork !== false && !b.hidden && (!project || canUseProject(this.ws.state, b, project)))
      .slice(0, MAX_TEAM);
  }
  /** What a bot is told about its team. "" when it has none here. */
  brief(bot, chat) {
    const team = this.roster(bot, chat);
    const remote = remoteTeamworkAllowed(this.ws, bot, chat, this.ws.active.get(chat.id)?.run, this.ws.active.get(chat.id))
      ? "\nUse list_host_teammates to find teammates on the owner’s other computers, and use list_node_hosts with node_* tools (list_node_files, node_read_file, node_write_file, node_mkdir, node_move_file, node_delete_file, node_stat_file, node_search_files, node_exec, node_which, node_screen_info, node_screen_capture, node_screen_input, node_notify) to work on the owner’s node hosts. The node enforces its own policy and approval." : "";
    if (!team.length) return remote;
    return (
      "\n\n## Your team\nYou're " + bot.name + ". Your teammates:\n" + team.map(line).join("\n") +
      "\nUse ask_teammate when a teammate fits a substantial part of the request. Split independent work across roles. Handle quick requests yourself or when the person asks for you. Say whom you're asking and why, share only the context they need, and combine their results into your reply." + remote
    );
  }
  /**
   * What a teammate is told while it works on an ask. It is the same whoever asks, so the
   * teammate's session keeps one system prompt (desktop/session-prompts.mjs); each message names
   * the teammate it is from ("Message from …", in ask).
   */
  helperNote() {
    return (
      "\n\nA teammate is asking for your help on the person's behalf; each message says which one. " +
      "Do the work and reply to that teammate with the result; they will pass it on. " +
      "You can't ask the person anything from here, and you can't bring in other teammates. If something is missing, or another teammate fits better, say so in your reply."
    );
  }
  tools(bot, chat, run, task) {
    if (run?.panelId) return [];
    const team = this.roster(bot, chat);
    const remote = remoteTeamworkAllowed(this.ws, bot, chat, run, task);
    if (!team.length && !remote) return [];
    const localNames = team.map((b) => b.name).join(", ");
    return [
      ...(remote ? [defineTool("list_host_teammates", {
        description: "List the owner's other Botkins hosts. Pass a returned host ID to list its available bots.",
        parameters: { type: "object", properties: { host: { type: "string", description: "A Botkins host ID." } }, additionalProperties: false },
        handler: async ({ host } = {}) => {
          requireRemoteTurn(this.ws, bot, chat, run, task);
          const roster = await peerRoster(this.ws.teamworkPeers, host);
          requireRemoteTurn(this.ws, bot, chat, run, task);
          return JSON.stringify(host === undefined ? roster : { host: roster.host, bots: roster.bots });
        },
      }),
      defineTool("list_node_hosts", {
        description: "List the owner's other Botkins hosts and their advertised node capabilities (availability, bots and shared project folders). Pass a host ID to inspect one host.",
        parameters: { type: "object", properties: { host: { type: "string", description: "Optional Botkins host ID." } }, additionalProperties: false },
        handler: async ({ host } = {}) => {
          requireRemoteTurn(this.ws, bot, chat, run, task);
          const discovered = await peerCapabilities(this.ws.teamworkPeers, host);
          requireRemoteTurn(this.ws, bot, chat, run, task);
          if (host === undefined) return JSON.stringify(discovered);
          return JSON.stringify({
            host: discovered.host,
            online: discovered.online,
            unavailable: discovered.unavailable,
            capabilities: discovered.capabilities,
          });
        },
      }),
      defineTool("list_node_files", {
        description: "List files in a project folder shared by one of the owner's node hosts. Use host and project IDs from list_node_hosts.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "The node host ID from list_node_hosts." },
            project: { type: "string", description: "A shared project ID advertised by that node host." },
            path: { type: "string", description: "Optional relative subfolder inside the shared project." },
          },
          required: ["host", "project"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.listNodeFiles(chat, bot, run, task, args ?? {}, invocation),
      }),
      defineTool("node_read_file", {
        description: "Read a file on a node host (inside a shared project folder, or anywhere when whole-computer scope is enabled on that node with project='@computer').",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            path: { type: "string", description: "Relative path inside the project, or absolute path for '@computer'." },
            encoding: { type: "string", enum: ["utf8", "base64"], description: "Output encoding (default utf8)." },
            offset: { type: "number", description: "Optional byte offset." },
            maxBytes: { type: "number", description: "Optional maximum bytes to read (up to 262144)." },
            truncate: { type: "boolean", description: "Allow reading a prefix of a larger file." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.read", args ?? {}, invocation, "node_read_file"),
      }),
      defineTool("node_write_file", {
        description: "Create or overwrite a file on a node host (max 256 KiB). Overwriting an existing file requires overwrite: true and a separate destructive grant.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            path: { type: "string", description: "Target file path." },
            content: { type: "string", description: "File contents (utf8 or base64)." },
            encoding: { type: "string", enum: ["utf8", "base64"], description: "Content encoding (default utf8)." },
            overwrite: { type: "boolean", description: "Must be true to overwrite an existing file." },
            createParents: { type: "boolean", description: "Create missing parent folders inside scope." },
          },
          required: ["host", "path", "content"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.write", args ?? {}, invocation, "node_write_file"),
      }),
      defineTool("node_mkdir", {
        description: "Create a directory on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            path: { type: "string", description: "Directory path to create." },
            recursive: { type: "boolean", description: "Create parent directories as needed (default true)." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.mkdir", args ?? {}, invocation, "node_mkdir"),
      }),
      defineTool("node_move_file", {
        description: "Move or rename a file or folder on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            from: { type: "string", description: "Source path." },
            to: { type: "string", description: "Destination path." },
            overwrite: { type: "boolean", description: "Must be true to overwrite an existing destination." },
          },
          required: ["host", "from", "to"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.move", args ?? {}, invocation, "node_move_file"),
      }),
      defineTool("node_delete_file", {
        description: "Delete a file or directory on a node host (always requires its own destructive grant).",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            path: { type: "string", description: "Path to delete." },
            recursive: { type: "boolean", description: "Required to delete a non-empty directory." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.delete", args ?? {}, invocation, "node_delete_file"),
      }),
      defineTool("node_stat_file", {
        description: "Inspect metadata (exists, type, size, mtime, mode) of a path on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            path: { type: "string", description: "Path to inspect." },
          },
          required: ["host", "path"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.stat", args ?? {}, invocation, "node_stat_file"),
      }),
      defineTool("node_search_files", {
        description: "Search for files by filename pattern or text query on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            project: { type: "string", description: "Shared project ID, or '@computer' if whole-computer scope is enabled." },
            path: { type: "string", description: "Optional subfolder or root directory to search." },
            pattern: { type: "string", description: "Optional filename glob pattern (e.g. '*.ts')." },
            query: { type: "string", description: "Optional case-insensitive text query inside files." },
            limit: { type: "number", description: "Maximum results (up to 200)." },
            maxDepth: { type: "number", description: "Maximum directory depth (up to 12)." },
          },
          required: ["host"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "fs.search", args ?? {}, invocation, "node_search_files"),
      }),
      defineTool("node_exec", {
        description: "Run a command on a node host (gated by the node's exec policy and exact-request approval binding). Prefer argv array over a shell string.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            argv: { type: "array", items: { type: "string" }, description: "Command and arguments as an array (e.g. ['uname', '-a'])." },
            command: { type: "string", description: "Command string (simple commands run without a shell; shell metacharacters require full mode)." },
            project: { type: "string", description: "Optional shared project ID to run inside." },
            cwd: { type: "string", description: "Optional working directory (relative to project if project is given, otherwise absolute)." },
            env: { type: "object", additionalProperties: { type: "string" }, description: "Optional safe environment variable overrides." },
            timeoutMs: { type: "number", description: "Optional timeout in milliseconds (default 30000, max 300000)." },
          },
          required: ["host"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "system.run", args ?? {}, invocation, "node_exec"),
      }),
      defineTool("node_which", {
        description: "Locate executable paths on a node host's PATH.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            names: { type: "array", items: { type: "string" }, description: "Executable names to look up (e.g. ['git', 'node'])." },
          },
          required: ["host", "names"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "system.which", args ?? {}, invocation, "node_which"),
      }),
      defineTool("node_screen_info", {
        description: "Inspect available displays and screen/accessibility permission status on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
          },
          required: ["host"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "screen.info", args ?? {}, invocation, "node_screen_info"),
      }),
      defineTool("node_screen_capture", {
        description: "Capture a JPEG screenshot of a display on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            display: { type: "string", description: "Optional display ID from node_screen_info." },
            maxWidth: { type: "number", description: "Optional max width in pixels (320-1920, default 1280)." },
            quality: { type: "number", description: "Optional JPEG quality (25-85, default 65)." },
          },
          required: ["host"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "screen.capture", args ?? {}, invocation, "node_screen_capture"),
      }),
      defineTool("node_screen_input", {
        description: "Send mouse, scroll, or keyboard input events to a display on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            display: { type: "string", description: "Optional display ID from node_screen_info." },
            events: { type: "array", items: { type: "object" }, description: "Array of screen input events (move, click, doubleClick, rightClick, down, up, scroll, text, key)." },
          },
          required: ["host", "events"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "screen.input", args ?? {}, invocation, "node_screen_input"),
      }),
      defineTool("node_notify", {
        description: "Show a desktop notification on a node host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Node host ID from list_node_hosts." },
            title: { type: "string", description: "Notification title." },
            body: { type: "string", description: "Optional notification message body." },
          },
          required: ["host", "title"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.runNodeOperation(chat, bot, run, task, "node.notify", args ?? {}, invocation, "node_notify"),
      })] : []),
      defineTool("ask_teammate", {
        description:
          "Ask a teammate to do part of the work and wait for their reply. " + (localNames ? "Local teammates: " + localNames + ". " : "") +
          (remote ? "For a bot on another computer, use the host ID and bot ID from list_host_teammates. " : "") +
          "They see only your message, so include the goal, the facts they need and what to send back. To ask several teammates at once, call this tool once for each in the same step.",
        parameters: {
          type: "object",
          properties: {
            teammate: { type: "string", description: remote ? "The local teammate’s name, or a remote bot ID when host is given." : "The teammate's name." },
            ...(remote && { host: { type: "string", description: "The remote teammate’s host ID." } }),
            message: { type: "string", description: "What you need them to do, with the facts they need." },
            expecting: { type: "string", description: "What you need back, such as a short summary, a list or a decision." },
            constraints: { type: "string", description: "Limits their answer must respect." },
          },
          required: ["teammate", "message"],
          additionalProperties: false,
        },
        handler: (args, invocation) => this.ask(chat, bot, run, task, args ?? {}, invocation),
      }),
    ];
  }
  async ask(chat, bot, run, task, rawArgs, invocation) {
    const { host, teammate, message, expecting, constraints } = rawArgs;
    if (!run || task.stopped || this.ws.closing || this.ws.active.get(chat.id) !== task)
      throw new Error("This turn is no longer active");
    const team = this.roster(bot, chat);
    const wanted = String(teammate ?? "").trim().replace(/^@/, "").toLowerCase();
    let remote, helper, pin;
    if (host !== undefined) {
      requireRemoteTurn(this.ws, bot, chat, run, task);
      const roster = await peerRoster(this.ws.teamworkPeers, host);
      requireRemoteTurn(this.ws, bot, chat, run, task);
      helper = roster.bots.find((b) => b.id === teammate);
      if (!helper) throw new Error("Choose an available bot ID on " + roster.host.name + " from list_host_teammates.");
      pin = roster.pin;
      remote = { hostId: host, hostName: roster.host.name, botName: helper.name };
    } else {
      helper = team.find((b) => b.name.toLowerCase() === wanted) ?? team.find((b) => b.id === wanted);
    }
    if (!helper)
      throw new Error("No teammate is named “" + String(teammate ?? "").slice(0, 60) + "”. Your teammates: " + (team.map((b) => b.name).join(", ") || "none") + ".");
    if (typeof message !== "string" || !message.trim()) throw new Error("Write the message for " + helper.name + ".");
    if (message.length > MESSAGE_MAX) throw new Error("Keep the message under " + MESSAGE_MAX.toLocaleString("en-US") + " characters.");
    const body = message.trim();
    const asks = (run.teamwork ??= []);
    // Node calls have no per-reply limit; only teammate asks, which each start a model turn, count here.
    if (asks.filter((a) => !String(a.botId).startsWith("node:")).length >= MAX_ASKS) throw new Error("You can ask teammates up to " + MAX_ASKS + " times in one reply. Answer with what you have.");
    if (asks.some((a) => a.botId === helper.id && a.remote?.hostId === remote?.hostId && a.message === body))
      throw new Error("You already sent " + helper.name + " this exact message in this reply. Use the answer you got.");
    const optional = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : undefined);
    const from = {
      kind: "bot",
      botId: bot.id,
      name: bot.name,
      chatId: chat.id,
      via: remote ? "remote" : "teamwork",
    };
    const entry = {
      id: randomUUID(),
      botId: helper.id,
      fromBotId: bot.id,
      from,
      ...(remote && { remote }),
      message: body,
      ...(optional(expecting) && { expecting: optional(expecting) }),
      status: "waiting",
      started: Date.now(),
    };
    const content = body +
      (entry.expecting ? "\n\nWhat they need back: " + entry.expecting : "") +
      (optional(constraints) ? "\n\nConstraints: " + optional(constraints) : "");
    if (remote && content.length > MESSAGE_MAX) throw new Error("Keep the whole remote request within 16,000 characters.");
    bindRailStep(run, entry, { toolName: "ask_teammate", toolCallId: invocation?.toolCallId, args: rawArgs });
    asks.push(entry);
    this.ws.notify();
    // The teammate is told whose request this is, as the asker was (desktop/team-turn.mjs).
    const whose = this.ws.speakerLine(chat, run, task, { helping: true });
    const prompt = (whose ? whose + "\n" : "") + "Message from " + bot.name + " (" + bot.role + "):\n" + content;
    try {
      // One teammate works on one ask at a time; a second ask to it waits its turn.
      const reply = remote
        ? await remoteReply(this.ws, bot, chat, run, task, entry, content, pin)
        : await this.ws.locked(helperSessionId(chat, helper.id), () => this.helperTurn(chat, bot, helper, run, task, entry, prompt));
      entry.reply = reply.slice(0, REPLY_MAX);
      entry.status = "answered";
      return JSON.stringify({ teammate: helper.name, reply });
    } catch (error) {
      entry.status = task.stopped || task.ended ? "stopped" : "failed";
      entry.error = String(error.message).slice(0, 600);
      throw new Error(helper.name + " couldn't answer: " + entry.error);
    } finally {
      entry.finished = Date.now();
      delete entry.intent;
      for (const step of entry.steps ?? []) if (step.status === "Running") step.status = "Interrupted";
      this.ws.notify();
    }
  }
  async listNodeFiles(chat, bot, run, task, rawArgs, invocation) {
    const { host, project, path: relPath = "" } = rawArgs;
    if (!run || task.stopped || this.ws.closing || this.ws.active.get(chat.id) !== task)
      throw new Error("This turn is no longer active");
    requireRemoteTurn(this.ws, bot, chat, run, task);
    const hostId = typeof host === "string" ? host.trim() : "";
    const projectId = typeof project === "string" ? project.trim() : "";
    if (!hostId) throw new Error("Choose a node host ID from list_node_hosts.");
    if (!projectId) throw new Error("Choose a shared project ID from list_node_hosts.");
    if (relPath !== undefined && typeof relPath !== "string") throw new Error("Subfolder path must be text.");
    const discovered = await peerCapabilities(this.ws.teamworkPeers, hostId);
    requireRemoteTurn(this.ws, bot, chat, run, task);
    if (discovered.unavailable || !discovered.online) {
      throw new Error(discovered.host.name + " is currently unavailable.");
    }
    const caps = discovered.capabilities;
    const ops = Array.isArray(caps?.operations) ? caps.operations : [];
    if (!ops.some((op) => op === LIST_FILES_OPERATION || op?.id === LIST_FILES_OPERATION)) {
      throw new Error(discovered.host.name + " does not offer file listing.");
    }
    const targetProject = (Array.isArray(caps?.projects) ? caps.projects : []).find((item) => item.id === projectId);
    if (!targetProject) {
      throw new Error("Choose a shared project ID on " + discovered.host.name + " from list_node_hosts.");
    }
    const asks = (run.teamwork ??= []);
    const folderLabel = targetProject.name + (relPath ? "/" + relPath : "");
    const entry = {
      id: randomUUID(),
      botId: "node:" + targetProject.id,
      fromBotId: bot.id,
      from: { kind: "bot", botId: bot.id, name: bot.name, chatId: chat.id, via: "remote" },
      remote: { hostId, hostName: discovered.host.name, botName: targetProject.name },
      message: "List files in " + folderLabel,
      status: "waiting",
      started: Date.now(),
    };
    bindRailStep(run, entry, { toolName: "list_node_files", toolCallId: invocation?.toolCallId, args: rawArgs });
    asks.push(entry);
    this.ws.notify();
    try {
      const result = await remoteJob(
        this.ws,
        bot,
        chat,
        run,
        task,
        entry,
        { operation: LIST_FILES_OPERATION, resourceId: targetProject.id, path: relPath || "" },
        discovered.pin,
      );
      entry.reply = `${result.entries?.length ?? 0} ${result.entries?.length === 1 ? "entry" : "entries"} in ${folderLabel}`.slice(0, REPLY_MAX);
      entry.status = "answered";
      return JSON.stringify({ host: discovered.host, ...result });
    } catch (error) {
      entry.status = task.stopped || task.ended ? "stopped" : "failed";
      entry.error = String(error.message).slice(0, 600);
      throw new Error(discovered.host.name + " couldn't list files: " + entry.error);
    } finally {
      entry.finished = Date.now();
      delete entry.intent;
      this.ws.notify();
    }
  }
  async runNodeOperation(chat, bot, run, task, operation, args = {}, invocation, toolName) {
    if (!run || task.stopped || this.ws.closing || this.ws.active.get(chat.id) !== task)
      throw new Error("This turn is no longer active");
    requireRemoteTurn(this.ws, bot, chat, run, task);
    const { host, ...rest } = args;
    const hostId = typeof host === "string" ? host.trim() : "";
    if (!hostId) throw new Error("Choose a node host ID from list_node_hosts.");
    const discovered = await peerCapabilities(this.ws.teamworkPeers, hostId);
    requireRemoteTurn(this.ws, bot, chat, run, task);
    if (discovered.unavailable || !discovered.online) {
      throw new Error(discovered.host.name + " is currently unavailable.");
    }
    const caps = discovered.capabilities;
    const ops = Array.isArray(caps?.operations) ? caps.operations : [];
    if (!ops.some((op) => op === operation || op?.id === operation)) {
      throw new Error(`${discovered.host.name} does not advertise ${operation}.`);
    }
    const asks = (run.teamwork ??= []);
    const resourceId = typeof rest.project === "string" && rest.project.trim() ? rest.project.trim() : "";
    const label =
      operation === "system.run"
        ? (Array.isArray(rest.argv) ? rest.argv.join(" ") : String(rest.command ?? "")).slice(0, 80)
        : rest.path || rest.from || rest.title || operation;
    const entry = {
      id: randomUUID(),
      botId: "node:" + operation,
      fromBotId: bot.id,
      from: { kind: "bot", botId: bot.id, name: bot.name, chatId: chat.id, via: "remote" },
      remote: { hostId, hostName: discovered.host.name, botName: operation },
      message: `${operation}: ${label}`.slice(0, 200),
      status: "waiting",
      started: Date.now(),
    };
    bindRailStep(run, entry, { toolName, toolCallId: invocation?.toolCallId, args });
    asks.push(entry);
    this.ws.notify();
    try {
      const result = await remoteJob(
        this.ws,
        bot,
        chat,
        run,
        task,
        entry,
        { operation, resourceId, params: rest },
        discovered.pin,
      );
      entry.reply = JSON.stringify(result).slice(0, REPLY_MAX);
      entry.status = "answered";
      return JSON.stringify({ host: discovered.host, operation, ...result });
    } catch (error) {
      entry.status = task.stopped || task.ended ? "stopped" : "failed";
      entry.error = String(error.message).slice(0, 600);
      throw new Error(`${discovered.host.name} couldn't run ${operation}: ${entry.error}`);
    } finally {
      entry.finished = Date.now();
      delete entry.intent;
      this.ws.notify();
    }
  }
  /** One teammate's work on one ask. Returns its reply. */
  async helperTurn(chat, asker, helper, run, task, entry, prompt) {
    const stopped = () => new Error("the reply was stopped");
    const over = () => task.stopped || task.ended;
    if (over()) throw stopped();
    entry.status = "working";
    this.ws.notify();
    chat.helpers ??= {};
    const record = (chat.helpers[helper.id] ??= { established: false });
    // The teammate's view of the chat: the chat's id for approvals, its own session and instructions,
    // and the chat's project so it has that context. Writes reach the real records.
    const view = {
      id: chat.id,
      sessionId: helperSessionId(chat, helper.id),
      botId: helper.id,
      title: chat.title,
      approval: chat.approval,
      messages: [],
      get helperMessages() { return record.messages; },
      projectId: chat.projectId,
      folder: chat.folder,
      helper: true,
      extraInstructions: this.helperNote(),
      get restartSession() { return record.restartSession; },
      set restartSession(value) { record.restartSession = value; },
      get sessionFolder() { return record.sessionFolder; },
      set sessionFolder(value) { record.sessionFolder = value; },
      get sessions() { return record.sessions; },
      set sessions(value) { record.sessions = value; },
      get forkContext() { return record.forkContext; },
      set forkContext(value) {
        if (value === undefined) delete record.forkContext;
        else record.forkContext = value;
      },
      get established() {
        return record.established;
      },
      set established(value) {
        record.established = value;
      },
      get sessionProvider() {
        return record.sessionProvider;
      },
      set sessionProvider(value) {
        record.sessionProvider = value;
      },
      get approvals() {
        return chat.approvals;
      },
      set approvals(value) {
        chat.approvals = value;
      },
    };
    let session, off, rootEventId;
    let failed = false;
    try {
      session = await this.ws.openSession(view, helper, run, task);
      (task.helpers ??= new Set()).add(session);
      if (over()) throw stopped();
      off = session.on((event) => {
        this.ws.artifactEvents.tool(chat, asker.id, run, event, entry);
        if (event.type === "user.message" && !event.agentId && rootEventId == null) rootEventId = event.id;
        this.ws.compacted(session, event);
        if (event.type === "assistant.intent" && !event.agentId) {
          entry.intent = String(event.data?.intent ?? "").slice(0, 200);
          this.ws.notify();
        } else if (event.type === "assistant.usage")
          // The teammate's tokens count toward the turn, without renaming the turn's model.
          recordCanvas(run, null, null, { ...event, agentId: event.agentId ?? "teammate" });
        else recordActivity(entry, event, this.ws.notify);
      });
      const { text } = await session.send({ prompt });
      if (over()) throw stopped();
      if (!text) throw new Error("no reply came back");
      // Record the teammate's exchange so switching harnesses hands off what this helper already discussed.
      record.messages ??= [];
      const from = entry.from ?? { kind: "bot", botId: asker.id, name: asker.name, chatId: chat.id, via: "teamwork" };
      record.messages.push({ role: "user", text: prompt, time: entry.started, from }, { role: "assistant", text, time: Date.now() });
      if (record.messages.length > 40) record.messages.splice(0, record.messages.length - 40);
      const helperProviderId = session.providerId ?? record.sessionProvider;
      if (helperProviderId && record.sessions?.[helperProviderId]) {
        record.sessions[helperProviderId].through = record.messages.length;
      }
      this.ws.save();
      return text;
    } catch (error) {
      if (error?.code === "BOTKINS_SESSION_LOST") {
        let recovered;
        try {
          recovered = await session?.completedReply?.(rootEventId);
        } catch {
          // A disconnected journal cannot be recovered here; preserve the original error.
        }
        if (typeof recovered === "string" && recovered.trim()) return recovered.trim();
      }
      failed = true;
      if (session) await session.abort().catch(() => {});
      throw error;
    } finally {
      off?.();
      if (session) {
        task.helpers.delete(session);
        await session.close({ discard: failed && !task.stopped && !task.ended });
      }
    }
  }
}
