// Host-level subagents: any bot on any harness (Pi, OMP, Copilot, Claude, Codex, OpenCode) can
// spawn focused child runs through Botkins' own provider/gateway pipeline.
//
// Why host-level:
// - Children open through `workspace.openSession` (so every Botkins provider, gateway connection,
//   MCP server, and permission rule works identically across harnesses).
// - Progress, tool steps, usage, and completion flow straight into `run.agents` and `run.steps`
//   (via `recordCanvas` / `recordActivity`), so Desktop and Mobile Activity Island show live
//   child status and drill-down steps without any harness-specific plugin.
// - Children run in ephemeral, isolated sessions (`temporary: true`, `helper: true`, `subagent: true`)
//   with no subagent recursion and automatic abort when the parent turn stops.
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { defineTool } from "./providers/provider.mjs";
import { recordActivity } from "./activity.mjs";
import { recordCanvas } from "./canvas.mjs";
import { validateSelection } from "./preferences.mjs";

export const MAX_SUBAGENTS = 16;
export const MAX_PARALLEL = 8;
const TASK_MAX = 16000;
const RESULT_MAX = 32000;
const LABEL_MAX = 80;
const STEP_WAIT_DEFAULT_MS = 300_000;
const STEP_WAIT_MAX_MS = 1_800_000;

const cleanLine = (value, max) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

const optionalText = (value, max = 2000) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** Resolves an optional model override string (e.g. "gemini-4-neon" or "copilot/gemini-4-neon") against Botkins' catalog. */
async function resolveSubagentModel(ws, spec) {
  if (spec === undefined || spec === null || spec === "") return undefined;
  const raw = typeof spec === "string" ? spec.trim() : "";
  if (!raw) return undefined;
  const catalog = await ws.models();
  const available = catalog.filter((m) => m.available !== false);
  const lower = raw.toLowerCase();
  const match =
    available.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
    available.find((m) => (m.source ? `${m.source}/${m.id}`.toLowerCase() === lower : false)) ??
    available.find((m) => m.id.toLowerCase() === lower) ??
    available.find((m) => m.name?.toLowerCase() === lower);
  if (!match) {
    const sample = available
      .slice(0, 12)
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new Error(`Unknown subagent model "${raw}". Available models include: ${sample || "none"}.`);
  }
  return validateSelection(catalog, { provider: match.provider, model: match.id });
}

/** Resolves an optional working folder override, ensuring it exists and is a directory. */
function resolveSubagentFolder(ws, chat, cwd) {
  if (cwd === undefined || cwd === null || cwd === "") return undefined;
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd must be a non-empty folder path.");
  const base = ws.projects.folderFor(chat) ?? chat.folder;
  const target = isAbsolute(cwd.trim()) ? cwd.trim() : base ? resolve(base, cwd.trim()) : resolve(cwd.trim());
  if (!existsSync(target)) throw new Error(`Subagent folder does not exist: ${target}`);
  if (!statSync(target).isDirectory()) throw new Error(`Subagent cwd is not a folder: ${target}`);
  return target;
}

export class Subagents {
  constructor(ws) {
    this.ws = ws;
    // Live subagent handles per parent run ID: Map<runId, Map<subagentId, Record>>
    this.runs = new Map();
  }

  /** Prompt guidance shown to top-level turns when host subagents are available. */
  brief(chat, run) {
    // A panel's chat never has the subagent tools; another chat has them on every turn (tools below).
    if (chat?.helper || chat?.subagent || chat?.panelId || run?.panelId) return "";
    return (
      "\n\n## Subagents\n" +
      "Use subagent_run to delegate focused tasks to isolated child workers (or pass a `tasks` array to fan out in parallel). " +
      "Subagents run through Botkins' own provider gateway, inherit your model (or accept an optional `model` override), and report live progress in Activity. " +
      "Set `async: true` to launch in the background, then check or collect results with subagent_status, subagent_wait, or stop with subagent_stop. " +
      "Prefer Botkins' subagent_* tools over harness-specific subagent plugins."
    );
  }

  /**
   * Instructions appended inside a child subagent session. They are the same for every child of a
   * bot, so children started side by side share the start of their requests, which a model caches
   * once for all of them. What differs between children is in the task they are sent (childTask).
   */
  childInstructions(parentBot) {
    return (
      `\n\nYou are an isolated Botkins subagent launched by ${parentBot.name} (${parentBot.role}). ` +
      "Complete the assigned task directly and return a concise, factual result for the parent agent. " +
      "Follow the mode, expected output and constraints given with your task. " +
      "You cannot ask the user questions directly or spawn further subagents; report any missing facts or blockers clearly in your reply."
    );
  }

  /** A child's first message: its name, mode, expected output and constraints, then the task. */
  childTask({ label, readonly, expecting, constraints, body }) {
    const lines = [
      `Subagent: ${label || "Subagent"}.`,
      readonly ? "Read-only mode: inspect and report only; do not modify files, run mutating commands, or perform external writes." : "",
      expecting ? `Expected output: ${expecting}.` : "",
      constraints ? `Constraints: ${constraints}.` : "",
    ].filter(Boolean);
    return lines.join("\n") + "\n\nTask:\n" + body;
  }

  /** Tool definitions exposed to a parent turn via Botkins' MCP bridge. */
  tools(bot, chat, run, task) {
    if (chat?.helper || chat?.subagent || run?.panelId) return [];
    return [
      defineTool("subagent_run", {
        description:
          "Run one or more isolated Botkins subagents using Botkins' configured providers and models. " +
          "Pass `task` for a single child, or `tasks` (up to 8) to run independent children in parallel. " +
          "By default waits for completion and returns results; pass `async: true` to return immediately with IDs for subagent_status/subagent_wait.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task prompt for a single subagent." },
            label: { type: "string", description: "Short label shown in Activity (2-5 words)." },
            model: { type: "string", description: "Optional Botkins model override (e.g. 'gemini-4-neon' or 'copilot/gemini-4-neon'). Defaults to the current chat model." },
            cwd: { type: "string", description: "Optional working directory for the subagent." },
            readonly: { type: "boolean", description: "When true, instructs the subagent to only inspect/read and make no modifications." },
            expecting: { type: "string", description: "Expected output shape (e.g. 'one-line summary', 'JSON list')." },
            constraints: { type: "string", description: "Constraints the subagent must respect." },
            async: { type: "boolean", description: "When true, start in the background and return subagent IDs immediately." },
            tasks: {
              type: "array",
              description: "Run multiple independent subagents in parallel (max 8).",
              items: {
                type: "object",
                properties: {
                  task: { type: "string", description: "Task prompt for this subagent." },
                  label: { type: "string", description: "Short label shown in Activity." },
                  model: { type: "string", description: "Optional model override for this subagent." },
                  cwd: { type: "string", description: "Optional working directory for this subagent." },
                  readonly: { type: "boolean", description: "Read-only mode for this subagent." },
                  expecting: { type: "string", description: "Expected output shape." },
                  constraints: { type: "string", description: "Constraints for this subagent." },
                },
                required: ["task"],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        handler: (args) => this.runTool(chat, bot, run, task, args ?? {}),
      }),
      defineTool("subagent_status", {
        description: "Check the status and latest output of one or all Botkins subagents spawned in this turn.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Optional subagent ID to inspect; omit to list all subagents in this turn." },
          },
          additionalProperties: false,
        },
        handler: (args) => this.statusTool(run, args ?? {}),
      }),
      defineTool("subagent_wait", {
        description: "Wait for one or all running Botkins subagents in this turn to finish and return their results.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Optional subagent ID to wait for; omit to wait for all active subagents in this turn." },
            timeoutMs: { type: "number", description: "Maximum wait time in milliseconds (default 300000, max 1800000)." },
          },
          additionalProperties: false,
        },
        handler: (args) => this.waitTool(run, task, args ?? {}),
      }),
      defineTool("subagent_stop", {
        description: "Abort a running Botkins subagent in this turn.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Subagent ID to stop." },
          },
          required: ["id"],
          additionalProperties: false,
        },
        handler: (args) => this.stopTool(run, args ?? {}),
      }),
    ];
  }

  /** Cleans up live handles after a parent turn finishes. */
  releaseRun(runId) {
    if (!runId) return;
    const map = this.runs.get(runId);
    if (!map) return;
    for (const rec of map.values()) {
      if (rec.status === "Running") rec.abort().catch(() => {});
    }
    this.runs.delete(runId);
  }

  _bucket(run) {
    let map = this.runs.get(run.id);
    if (!map) {
      map = new Map();
      this.runs.set(run.id, map);
    }
    return map;
  }

  _assertActive(chat, run, task) {
    if (!run || task.stopped || task.ended || this.ws.closing || this.ws.active.get(chat.id) !== task) {
      throw new Error("This turn is no longer active.");
    }
  }

  async runTool(chat, bot, run, task, args) {
    this._assertActive(chat, run, task);
    const isBatch = Array.isArray(args.tasks) && args.tasks.length > 0;
    const specs = isBatch
      ? args.tasks
      : typeof args.task === "string" && args.task.trim()
        ? [{ task: args.task, label: args.label, model: args.model, cwd: args.cwd, readonly: args.readonly, expecting: args.expecting, constraints: args.constraints }]
        : null;
    if (!specs) throw new Error("Provide `task` (for one subagent) or a non-empty `tasks` array (for parallel subagents).");
    if (specs.length > MAX_PARALLEL) throw new Error(`You can launch at most ${MAX_PARALLEL} parallel subagents in one call.`);

    const bucket = this._bucket(run);
    if (bucket.size + specs.length > MAX_SUBAGENTS) {
      throw new Error(`You can launch at most ${MAX_SUBAGENTS} subagents in one reply (already launched ${bucket.size}).`);
    }

    // Validate all specs up front before spawning anything.
    const prepared = [];
    for (let i = 0; i < specs.length; i++) {
      const item = specs[i] ?? {};
      const body = typeof item.task === "string" ? item.task.trim() : "";
      if (!body) throw new Error(`Subagent #${i + 1} is missing a non-empty task.`);
      if (body.length > TASK_MAX) throw new Error(`Keep each subagent task under ${TASK_MAX.toLocaleString("en-US")} characters.`);
      const label = cleanLine(item.label, LABEL_MAX) || (isBatch ? `Subagent ${i + 1}` : "Subagent");
      const modelOverride = await resolveSubagentModel(this.ws, item.model);
      const folderOverride = resolveSubagentFolder(this.ws, chat, item.cwd);
      prepared.push({
        body,
        label,
        modelOverride,
        folderOverride,
        readonly: item.readonly === true,
        expecting: optionalText(item.expecting),
        constraints: optionalText(item.constraints),
      });
    }

    this._assertActive(chat, run, task);

    const handles = prepared.map((spec) => this._spawn(chat, bot, run, task, bucket, spec));

    if (args.async === true) {
      const launched = handles.map((h) => ({ id: h.id, label: h.label, status: h.status, ...(h.model && { model: h.model }) }));
      return JSON.stringify(isBatch ? { async: true, subagents: launched } : { async: true, ...launched[0] });
    }

    const results = await Promise.all(handles.map((h) => h.promise));
    return JSON.stringify(isBatch ? { results } : results[0]);
  }

  _spawn(chat, bot, run, task, bucket, spec) {
    const id = "sub-" + randomUUID().slice(0, 12);
    const started = Date.now();
    const record = {
      id,
      label: spec.label,
      prompt: spec.body,
      status: "Running",
      started,
      finished: undefined,
      reply: undefined,
      error: undefined,
      model: spec.modelOverride ? `${spec.modelOverride.provider}/${spec.modelOverride.model}` : undefined,
      session: null,
      stoppedByTool: false,
      abort: async () => {
        record.stoppedByTool = true;
        if (record.session) await record.session.abort().catch(() => {});
      },
      promise: null,
    };
    bucket.set(id, record);

    // Emit subagent.started into the parent run so Desktop + Mobile Activity Island renders it immediately.
    recordCanvas(run, chat, task, {
      type: "subagent.started",
      data: {
        toolCallId: id,
        instanceId: id,
        agentName: spec.label,
        agentDisplayName: spec.label,
        agentDescription: spec.readonly ? "Read-only subagent" : "Botkins subagent",
        prompt: spec.body,
      },
    });
    this.ws.notify();

    const execute = async () => {
      const over = () => task.stopped || task.ended || record.stoppedByTool;
      const view = {
        id: chat.id,
        sessionId: `${chat.sessionId ?? chat.id}-sub-${id}`,
        botId: bot.id,
        title: `${chat.title || "Chat"} · ${spec.label}`,
        approval: chat.approval,
        ...(chat.channel && { channel: chat.channel }),
        messages: [],
        projectId: chat.projectId,
        folder: spec.folderOverride ?? chat.folder,
        ...(spec.modelOverride && { model: spec.modelOverride }),
        helper: true,
        subagent: true,
        temporary: true,
        established: false,
        extraInstructions: this.childInstructions(bot),
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
        if (over()) throw new Error("Subagent stopped before starting.");
        session = await this.ws.openSession(view, bot, run, task);
        record.session = session;
        (task.helpers ??= new Set()).add(session);
        if (over()) throw new Error("Subagent stopped.");

        off = session.on((event) => {
          this.ws.artifactEvents.tool(chat, bot.id, run, event);
          if (event.type === "user.message" && !event.agentId && rootEventId == null) rootEventId = event.id;
          if (event.type === "assistant.intent" && !event.agentId) {
            if (recordCanvas(run, chat, task, { ...event, agentId: id })) this.ws.notify();
          } else if (event.type === "assistant.usage") {
            recordCanvas(run, null, null, { ...event, agentId: id });
          } else if (event.type?.startsWith("tool.")) {
            recordActivity(run, { ...event, agentId: id }, this.ws.notify);
          }
        });

        const whose = this.ws.speakerLine(chat, run, task, { helping: true });
        const prompt = (whose ? whose + "\n" : "") + this.childTask(spec);
        const { text } = await session.send({ prompt });
        if (over()) throw new Error(record.stoppedByTool ? "Subagent stopped." : "Parent turn stopped.");
        if (!text) throw new Error("Subagent returned an empty reply.");

        record.reply = text.slice(0, RESULT_MAX);
        record.status = "Done";
        record.finished = Date.now();
        recordCanvas(run, chat, task, {
          type: "subagent.completed",
          data: { toolCallId: id, result: record.reply },
        });
        this.ws.notify();
        return this._summary(record);
      } catch (error) {
        if (error?.code === "BOTKINS_SESSION_LOST") {
          let recovered;
          try {
            recovered = await session?.completedReply?.(rootEventId);
          } catch {
            // Preserve original error if recovery fails.
          }
          if (typeof recovered === "string" && recovered.trim()) {
            record.reply = recovered.trim().slice(0, RESULT_MAX);
            record.status = "Done";
            record.finished = Date.now();
            recordCanvas(run, chat, task, {
              type: "subagent.completed",
              data: { toolCallId: id, result: record.reply },
            });
            this.ws.notify();
            return this._summary(record);
          }
        }
        failed = true;
        if (session) await session.abort().catch(() => {});
        const cancelled = record.stoppedByTool || task.stopped || task.ended;
        record.status = cancelled ? "Stopped" : "Failed";
        record.error = String(error?.message || error || "Failed").slice(0, 600);
        record.finished = Date.now();
        if (cancelled) {
          recordCanvas(run, chat, task, {
            type: "subagent.completed",
            data: { toolCallId: id, cancelled: true },
          });
        } else {
          recordCanvas(run, chat, task, {
            type: "subagent.failed",
            data: { toolCallId: id, error: record.error },
          });
        }
        this.ws.notify();
        return this._summary(record);
      } finally {
        off?.();
        record.session = null;
        if (session) {
          task.helpers?.delete(session);
          await session.close({ discard: true }).catch(() => {});
        }
      }
    };

    record.promise = execute();
    return record;
  }

  _summary(rec) {
    return {
      id: rec.id,
      label: rec.label,
      status: rec.status,
      ...(rec.model && { model: rec.model }),
      durationMs: (rec.finished ?? Date.now()) - rec.started,
      ...(rec.reply !== undefined && { reply: rec.reply }),
      ...(rec.error !== undefined && { error: rec.error }),
    };
  }

  statusTool(run, { id } = {}) {
    const bucket = run ? this.runs.get(run.id) : null;
    if (!bucket || bucket.size === 0) return JSON.stringify(id ? { error: `Unknown subagent "${id}".` } : { subagents: [] });
    if (id) {
      const rec = bucket.get(id);
      if (!rec) throw new Error(`Unknown subagent "${id}".`);
      return JSON.stringify(this._summary(rec));
    }
    return JSON.stringify({ subagents: [...bucket.values()].map((r) => this._summary(r)) });
  }

  async waitTool(run, task, { id, timeoutMs } = {}) {
    const bucket = run ? this.runs.get(run.id) : null;
    if (!bucket || bucket.size === 0) return JSON.stringify({ subagents: [] });
    const targets = id ? [bucket.get(id)].filter(Boolean) : [...bucket.values()];
    if (id && !targets.length) throw new Error(`Unknown subagent "${id}".`);
    const pending = targets.filter((r) => r.status === "Running");
    if (pending.length) {
      const ms = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(timeoutMs, STEP_WAIT_MAX_MS)) : STEP_WAIT_DEFAULT_MS;
      let timer;
      try {
        await Promise.race([
          Promise.all(pending.map((r) => r.promise)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    const summaries = targets.map((r) => this._summary(r));
    return JSON.stringify(id ? summaries[0] : { subagents: summaries, timedOut: targets.some((r) => r.status === "Running") });
  }

  async stopTool(run, { id } = {}) {
    const bucket = run ? this.runs.get(run.id) : null;
    const rec = bucket?.get(id);
    if (!rec) throw new Error(`Unknown subagent "${id}".`);
    if (rec.status !== "Running") return JSON.stringify(this._summary(rec));
    await rec.abort();
    await rec.promise.catch(() => {});
    return JSON.stringify(this._summary(rec));
  }
}
