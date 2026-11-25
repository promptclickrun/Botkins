import { associateHelper, helperId } from "./activity.mjs";
import { reasoningPreview } from "./link/reasoning-preview.mjs";
import { toolKind } from "./tool-kind.mjs";
// Chat canvas helpers: reasoning, usage, context, todos, background helpers,
// attachments, fork context and the plain-language work summary.
import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/** Reasoning kept per run, in characters. */
export const REASONING_CAP = 20000;
export const MAX_ATTACHMENTS = 10;

function reasoningSize(run) {
  return (run.reasoning ?? []).reduce((n, r) => n + r.text.length, 0);
}

/**
 * Records canvas events from a session into the run, the chat and the live task.
 * Returns true when it handled the event.
 */
export function recordCanvas(run, chat, task, { type, data, agentId }) {
  switch (type) {
    case "assistant.reasoning_delta":
    case "assistant.reasoning": {
      if (agentId || !data?.reasoningId) return false;
      run.reasoning ??= [];
      let entry = run.reasoning.find((r) => r.id === data.reasoningId);
      if (!entry) {
        // Close the previous block: a new reasoning id means the model moved on.
        for (const r of run.reasoning) r.finished ??= Date.now();
        entry = { id: data.reasoningId, text: "", started: Date.now() };
        run.reasoning.push(entry);
      }
      const room = REASONING_CAP - (reasoningSize(run) - entry.text.length);
      if (type === "assistant.reasoning_delta")
        entry.text = (entry.text + (data.deltaContent || "")).slice(0, Math.max(0, room));
      else {
        if (typeof data.content === "string" && data.content.trim())
          entry.text = data.content.slice(0, Math.max(0, room));
        entry.finished = Date.now();
      }
      if (task) task.thinking = reasoningPreview(run.reasoning);
      return true;
    }
    case "assistant.intent": {
      const helper = agentId && run.agents?.find(a => a.id === helperId(run, agentId));
      if (!helper || !data?.intent) return false;
      helper.intent = String(data.intent).slice(0, 4000);
      return true;
    }
    case "assistant.usage": {
      if (!data) return false;
      const u = (run.usage ??= { input: 0, output: 0 });
      // `input` is the uncached input (providers/provider.mjs usageData). Both cache counts are
      // kept, as 0 when none was used: a run that has `cacheWrite` was counted this way, so its
      // cache hit rate can be trusted (usage.mjs). Runs from before counted input differently.
      u.input += data.inputTokens || 0;
      u.output += data.outputTokens || 0;
      u.cacheRead = (u.cacheRead || 0) + (data.cacheReadTokens || 0);
      u.cacheWrite = (u.cacheWrite || 0) + (data.cacheWriteTokens || 0);
      if (typeof data.cost === "number") u.cost = (u.cost || 0) + data.cost;
      if (data.duration) u.durationMs = (u.durationMs || 0) + data.duration;
      if (!agentId && data.model) u.model = data.model;
      return true;
    }
    case "session.usage_info": {
      if (agentId || !chat || !data?.tokenLimit) return false;
      // The window's makeup, for the context details popup.
      const n = (v) => (Number.isFinite(v) && v >= 0 ? v : undefined);
      chat.context = {
        current: data.currentTokens || 0,
        limit: data.tokenLimit,
        ...(n(data.systemTokens) !== undefined && { system: data.systemTokens }),
        ...(n(data.toolDefinitionsTokens) !== undefined && { tools: data.toolDefinitionsTokens }),
        ...(n(data.conversationTokens) !== undefined && { conversation: data.conversationTokens }),
        ...(n(data.messagesLength) !== undefined && { messages: data.messagesLength }),
        updatedAt: Date.now(),
      };
      return true;
    }
    case "subagent.started": {
      if (!data?.toolCallId) return false;
      run.agents ??= [];
      associateHelper(run, data.instanceId ?? agentId, data.toolCallId);
      if (run.agents.some((a) => a.id === data.toolCallId)) return true;
      let prompt = data.prompt;
      if (!prompt) {
        const input = run.steps?.find(s => s.id === data.toolCallId)?.input;
        try { prompt = input && JSON.parse(input)?.prompt; } catch { /* Input can be clipped. */ }
      }
      run.agents.push({
        id: data.toolCallId,
        ...(typeof prompt === "string" && {prompt:prompt.slice(0,4000)}),
        name: data.agentDisplayName || data.agentName || "Helper",
        ...(data.agentDescription && { description: String(data.agentDescription).slice(0, 300) }),
        status: "Running",
        started: Date.now(),
      });
      return true;
    }
    case "subagent.completed":
    case "subagent.failed": {
      const agent = run.agents?.find((a) => a.id === data?.toolCallId);
      if (!agent) return false;
      agent.finished = Date.now();
      if (type === "subagent.failed") {
        agent.status = "Failed";
        agent.detail = String(data.error || "Failed").slice(0, 500);
      } else {
        agent.status = "Done";
        const result = data.result ?? run.steps?.find(s => s.id === agent.id)?.output;
        if (typeof result === "string" && result) agent.result = result.slice(0, 4000);
        if (data.cancelled) agent.detail = "Cancelled";
      }
      return true;
    }
  }
  return false;
}

/** Closes open reasoning and helpers when a turn ends. */
export function finishCanvas(run) {
  const now = Date.now();
  for (const r of run.reasoning ?? []) r.finished ??= now;
  if (run.reasoning) run.reasoning = run.reasoning.filter((r) => r.text.trim());
  if (!run.reasoning?.length) delete run.reasoning;
  // A helper still running here was cut off by the end of the reply. Nothing says it failed.
  for (const a of run.agents ?? [])
    if (a.status === "Running") {
      a.status = "Stopped";
      a.detail = "Stopped with the reply";
      a.finished = now;
    }
  if (run.steps?.length) run.summary = workSummary(run.steps);
}

const statusMap = {
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  running: "in_progress",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  skipped: "cancelled",
};

/** Maps session.plan.readSqlTodosWithDependencies() to Botkins todos. */
export function mapTodos(result) {
  const deps = result?.dependencies ?? [];
  return (result?.rows ?? [])
    .filter((r) => r.id || r.title)
    .slice(0, 100)
    .map((r, i) => {
      const id = String(r.id ?? i);
      const dependsOn = deps.filter((d) => d.todoId === id).map((d) => d.dependsOn);
      return {
        id,
        title: String(r.title || r.description || id).slice(0, 300),
        status: statusMap[String(r.status || "").toLowerCase()] ?? "pending",
        ...(dependsOn.length && { dependsOn }),
      };
    });
}

/** Checks attachments in the main process: absolute paths to files or folders that exist. */
export function validateAttachments(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("Attachments must be a list.");
  if (list.length > MAX_ATTACHMENTS)
    throw new Error("Attach up to " + MAX_ATTACHMENTS + " files at a time.");
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const path = typeof item === "string" ? item : item?.path;
    if (typeof path !== "string" || !path || path.length > 4096 || !isAbsolute(path))
      throw new Error("Attachments need a full file path.");
    let info;
    try {
      info = statSync(path);
    } catch {
      throw new Error("Attachment not found: " + basename(path));
    }
    if (!info.isFile() && !info.isDirectory())
      throw new Error("Attach a regular file or folder: " + basename(path));
    if (seen.has(path)) continue;
    seen.add(path);
    const name =
      typeof item?.name === "string" && item.name.trim() ? item.name.trim().slice(0, 200) : basename(path);
    out.push({ name, path, kind: info.isDirectory() ? "directory" : "file" });
  }
  return out;
}

/** SDK attachment records for MessageOptions.attachments. */
export function sdkAttachments(list) {
  return (list ?? []).map((a) => ({
    type: a.kind === "directory" ? "directory" : "file",
    path: a.path,
    displayName: a.name,
  }));
}

/** The prompt the model sees for a reply that quotes earlier text. */
export function quotedPrompt(prompt, quote) {
  if (!quote) return prompt;
  const lines = quote.trim().split("\n").map((l) => "> " + l).join("\n");
  return "Replying to this earlier text:\n" + lines + "\n\n" + prompt;
}

/** A plain transcript of messages for a forked chat's system message. */
export function forkTranscript(messages, botName, cap = 30000) {
  const lines = [];
  for (const m of messages) {
    if (!m.text?.trim()) continue;
    const who = m.role === "user" ? "User" : m.role === "command" ? "Command" : botName;
    let text = m.text.trim();
    if (m.quote) text = "(replying to: " + m.quote.trim().slice(0, 400) + ")\n" + text;
    if (m.attachments?.length) text += "\n[attached: " + m.attachments.map((a) => a.name).join(", ") + "]";
    lines.push(who + ": " + text);
  }
  let transcript = lines.join("\n\n");
  // Keep the end of a long conversation: it's what the person forked from.
  if (transcript.length > cap) transcript = "…" + transcript.slice(-cap);
  return transcript;
}

/** Context carried into a fresh main-chat session. A fork made before compaction still uses that earlier history. */
export function mainTranscript(chat, botName, end = chat.messages.length) {
  const summary = chat.compacted && chat.compacted.through <= end ? chat.compacted : null;
  const tail = forkTranscript(chat.messages.slice(summary?.through ?? 0, end), botName);
  return [summary?.text, tail].filter(Boolean).join("\n\n");
}

/**
 * The conversation so far, for the first message of a session that begins from Botkins' own
 * transcript (a fork, a moved or restarted session, a harness that lost its copy). It goes in a
 * message, never in the system prompt: there it would be sent again with every request of the
 * session, ahead of everything a model caches, and compaction couldn't shrink it.
 */
export function earlierConversation(transcript) {
  return transcript
    ? "[Botkins: this conversation continues from earlier. Treat the transcript below as the conversation so far and continue from it. The message to answer follows it.]\n<earlier-conversation>\n" +
        transcript +
        "\n</earlier-conversation>"
    : "";
}

export function forkSystemMessage(transcript) {
  return transcript
    ? "\n\nThis chat was forked from an earlier conversation. Treat the transcript below as the conversation so far and continue from it.\n<earlier-conversation>\n" +
        transcript +
        "\n</earlier-conversation>"
    : "";
}

// How each kind of work counts in a summary. The kinds themselves are tool-kind.mjs.
const words = {
  command: ["Ran a command", "Ran %d commands"],
  read: ["Read a file", "Read %d files"],
  write: ["Wrote a file", "Wrote %d files"],
  edit: ["Edited a file", "Edited %d files"],
  "search-files": ["Searched files", "Searched files %d times"],
  web: ["Searched the web", "Searched the web %d times"],
  "web-page": ["Read a web page", "Read %d web pages"],
  ask: ["Asked you a question", "Asked you %d questions"],
  helper: ["Started a helper", "Started %d helpers"],
  plan: ["Updated the plan", "Updated the plan"],
  skill: ["Used a skill", "Used %d skills"],
  card: ["Made a card", "Made %d cards"],
  panel: ["Updated a panel", "Updated panels %d times"],
  tool: ["Used a tool", "Used %d tools"],
};
export { toolKind };

/** "Ran 3 commands, read 2 files, searched the web": from tool names and kinds only. */
export function workSummary(steps) {
  const counts = new Map();
  for (const s of steps ?? []) {
    // MCP tools count as tools; their names can be anything.
    const kind = s.source ? "tool" : toolKind(s.name);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => {
    const [one, many] = words[kind];
    return n === 1 ? one : many.replace("%d", String(n));
  });
  if (!parts.length) return "";
  const text = parts.slice(0, 4).join(", ").toLowerCase();
  return text[0].toUpperCase() + text.slice(1);
}
