// Tasks: a Kanban board of work for bots (Bighelp's Kanban, without Hermes' dispatcher).
// Ready tasks with a bot start on their own; a finished task waits for review (by the person,
// or by the creating bot when a bot orchestrated it), or auto-accepts to done.
import { randomUUID } from "node:crypto";
import { defineTool } from "./providers/provider.mjs";
import { textField } from "./panels.mjs";
import { askToSchedule, scriptInvocation } from "./script-commands.mjs";
import { shownText } from "./shown-text.mjs";
import { taskLimits } from "./task-limits.mjs";

export const LANES = ["later", "ready", "working", "review", "blocked", "done"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const REVIEW_MODES = ["person", "creator", "auto"];
const PER_TURN = 10; // tasks a bot may create in one turn
const MAX_OPEN = 200; // unfinished tasks on the board
const MAX_HISTORY = 50;

function body(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > 8000) throw new Error("Use up to 8,000 characters for details.");
  return value.trim();
}

function noteField(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > 4000) throw new Error("Use up to 4,000 characters for a note.");
  return value.trim();
}

/** Whether a task is waiting for a person (rather than an orchestrating creator bot). */
export function taskNeedsPerson(task) {
  if (!task) return false;
  if (task.status === "blocked") return true;
  if (task.status !== "review") return false;
  return !task.reviewerBotId;
}

/** Whether a transition between lanes is allowed by `move()`. Only Botkins puts a task in working. */
export function allowedTransition(from, to) {
  if (to === "working" || from === "working") return false;
  if (from === to) return true;
  if (to === "archived") return true;
  // Moving forward or back between non-working lanes is allowed except jumping to review/blocked from done/archived/later/ready?
  // Existing behavior allowed later/ready/blocked/done/review freely when not working; keep explicit disallowed rules clear:
  // - Cannot move into or out of working (handled above).
  // - From archived: only reopen to ready or later.
  if (from === "archived") return to === "ready" || to === "later";
  return LANES.includes(to);
}

export class Tasks {
  constructor(ws) {
    this.ws = ws;
    ws.state.tasks ??= [];
    // A working task follows its recovered run through the normal completion listener.
    for (const task of ws.state.tasks) {
      if (task.status !== "working") continue;
      if (ws.state.runs?.some((run) => run.taskId === task.id && run.status === "Working")) continue;
      Object.assign(task, { status: "blocked", problem: "Botkins closed before this task finished." });
    }
    ws.events?.on("turn", ({ run }) => run.taskId && this.finished(run));
  }
  get all() {
    return this.ws.state.tasks;
  }
  get(id) {
    const task = this.all.find((t) => t.id === id);
    if (!task) throw new Error("This task no longer exists.");
    return task;
  }
  botName(botId) {
    return this.ws.state.bots.find((b) => b.id === botId)?.name ?? null;
  }
  isBotCreator(createdBy) {
    return Boolean(createdBy && createdBy !== "person" && this.ws.state.bots.some((b) => b.id === createdBy));
  }
  actorInfo(by) {
    if (!by || by === "person" || by === "owner") return { by: "person", byName: "Person" };
    if (by === "system") return { by: "system", byName: "Botkins" };
    const name = this.botName(by);
    return { by, byName: name ?? String(by) };
  }
  recordHistory(task, from, to, { by = "person", note = "", at = Date.now() } = {}) {
    const entry = {
      at,
      ...this.actorInfo(by),
      from,
      to,
      ...(note ? { note } : {}),
    };
    task.history ??= [];
    task.history.push(entry);
    if (task.history.length > MAX_HISTORY) task.history = task.history.slice(-MAX_HISTORY);
    this.syncHandoffs(task);
    return entry;
  }
  /** Keeps the rail card on the run that created this task in step with the task's status and chat. */
  syncHandoffs(task) {
    for (const r of this.ws.state.runs) {
      const handoff = r.taskHandoffs?.find((h) => h.taskId === task.id);
      if (handoff) Object.assign(handoff, { status: task.status, ...(task.chatId && { chatId: task.chatId }) });
    }
  }
  save({ id, title, body: details, botId, priority = "normal", status, review, createdChatId }, createdBy = "person") {
    if (botId != null) this.ws.bot(botId);
    if (!PRIORITIES.includes(priority)) throw new Error("Use low, normal, high or urgent.");
    if (review !== undefined && !REVIEW_MODES.includes(review)) throw new Error("Use person, creator or auto for review.");
    const now = Date.now();
    if (id) {
      const task = this.get(id);
      if (task.status === "working") throw new Error("Wait until the task stops working to edit it.");
      Object.assign(task, {
        title: textField(title, 160, "task title"),
        body: body(details),
        botId: botId ?? null,
        priority,
        ...(review !== undefined && { review }),
        updatedAt: now,
      });
      if (status) this.move(id, status, { by: createdBy });
      this.ws.save();
      return task.id;
    }
    if (status && !["later", "ready"].includes(status)) throw new Error("A new task starts in Later or Ready.");
    const botCreated = this.isBotCreator(createdBy);
    const effectiveReview = review ?? (botCreated ? "creator" : "person");
    const task = {
      id: randomUUID(),
      title: textField(title, 160, "task title"),
      body: body(details),
      botId: botId ?? null,
      priority,
      status: status ?? "later",
      createdBy,
      ...(createdChatId && { createdChatId }),
      ...(botCreated || review ? { review: effectiveReview } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.all.unshift(task);
    this.ws.save();
    this.ws.events?.emit("task.created", { task, from: null, to: task.status });
    return task.id;
  }
  /**
   * Moves a task between lanes. Only the dispatcher puts a task in Working.
   * options: { by?: "person" | botId, note?: string }
   */
  move(id, status, options = {}) {
    const task = this.get(id);
    if (!LANES.includes(status) && status !== "archived") throw new Error("Unknown lane");
    if (status === "working") throw new Error("Tasks start working on their own once they're Ready with a bot.");
    if (task.status === "working") throw new Error("Stop the task's chat before moving it.");
    const from = task.status;
    if (!allowedTransition(from, status)) throw new Error("Cannot move a task from " + from + " to " + status + ".");
    const note = noteField(options?.note);
    const by = options?.by ?? "person";
    const now = Date.now();
    task.status = status;
    if (status === "ready" || status === "later") {
      delete task.problem;
      delete task.reviewerBotId;
    } else if (status === "done" || status === "archived") {
      delete task.reviewerBotId;
      delete task.pendingNote;
    } else if (status === "review") {
      // Explicit move to review waits for the person unless a bot reviewer was already assigned on review.
      if (from !== "review") delete task.reviewerBotId;
    }
    if (status === "ready" && (from === "review" || from === "done" || from === "blocked" || from === "archived")) {
      if (note) {
        task.pendingNote = { text: note, ...this.actorInfo(by), from, at: now };
      } else if (from === "done") {
        task.pendingNote = { text: "Reopened for another pass.", ...this.actorInfo(by), from, at: now };
      }
    }
    if (from !== status || note) {
      this.recordHistory(task, from, status, { by, note, at: now });
    }
    task.updatedAt = now;
    this.ws.save();
    if (from !== status) this.ws.events?.emit("task.status", { task, from, to: status, note, by });
  }
  /**
   * Migration helper (opt-in via settings.tasksCreatorReviewExisting):
   * When enabled, existing bot-created tasks currently sitting in Review without a reviewerBotId
   * are handed to their creator bot for review. Existing tasks are untouched unless opted in.
   */
  applyCreatorReviewMigration(enabled) {
    if (!enabled) return 0;
    let changed = 0;
    const now = Date.now();
    for (const task of this.all) {
      if (task.status !== "review" || task.reviewerBotId) continue;
      if (!this.isBotCreator(task.createdBy)) continue;
      if (task.review === "person") continue;
      task.review ??= "creator";
      task.reviewerBotId = task.createdBy;
      task.updatedAt = now;
      this.recordHistory(task, "review", "review", { by: "system", note: "Handed to creator bot for review.", at: now });
      changed++;
    }
    if (changed) this.ws.save();
    return changed;
  }
  remove(id) {
    const task = this.get(id);
    if (task.status === "working") throw new Error("Stop the task's chat before deleting it.");
    this.ws.state.tasks = this.all.filter((t) => t !== task);
    this.ws.save();
  }
  removeBot(botId) {
    for (const task of this.all) {
      if (task.botId === botId && task.status !== "working") task.botId = null;
      if (task.reviewerBotId === botId) delete task.reviewerBotId;
    }
  }
  /** Builds the prompt for a fresh start or a follow-up resume after request-changes / reopen. */
  prompt(task, { resuming = false } = {}) {
    const author = task.createdBy === "person" ? null : this.botName(task.createdBy) ?? "a bot";
    const reviewerText = this.reviewMode(task) === "auto"
      ? "when your reply ends the task is marked Done automatically, with your reply as its result."
      : this.reviewMode(task) === "creator" && author
        ? "when your reply ends the task goes to " + author + " for review, with your reply as its result."
        : "when your reply ends the task moves to Review by itself, with your reply as its result, and the person marks it done.";
    if (resuming && (task.pendingNote || task.result)) {
      const note = task.pendingNote;
      const who = note?.byName && note.by !== "person" ? note.byName : "The reviewer";
      const heading = note?.from === "done"
        ? who + " reopened this task for another pass."
        : note?.from === "blocked"
          ? "Retrying this task."
          : who + " sent this task back for changes.";
      return (
        heading +
        (note?.text ? "\n\nFeedback:\n" + note.text : "") +
        (task.result ? "\n\nPrevious result:\n" + task.result : "") +
        "\n\nContinue in this chat, address the feedback, and finish with a short summary of what changed. " +
        "You don't change this task's status: " + reviewerText
      );
    }
    return (
      (author
        ? "Work on this task from the task board. " + author + " added it, not the person, so treat it as a suggestion and ask the person before anything consequential."
        : "Work on this task from the person's task board.") +
      "\n\nTask: " + task.title +
      (task.body ? "\n\nDetails:\n" + task.body : "") +
      (task.pendingNote?.text ? "\n\nFeedback:\n" + task.pendingNote.text : "") +
      (task.result ? "\n\nPrevious result:\n" + task.result : "") +
      "\n\nDo the work with your tools. If you need something only the person can give, ask them. " +
      "Finish with a short summary of what you did and anything left for them. " +
      "You don't change this task's status: " + reviewerText
    );
  }
  reviewMode(task) {
    if (task.review && REVIEW_MODES.includes(task.review)) return task.review;
    // Legacy tasks without `review` keep person-review behavior unless migrated.
    return "person";
  }
  /**
   * The script command that a task is: its details (else its title) are `/<name> words` of a command that Botkins keeps. It then runs
   * that script with no model, and its output is the task's result (desktop/script-commands.mjs). { name, args, text } or null.
   */
  invocation(task) {
    const text = (task.body?.trim() || task.title || "").trim();
    const found = scriptInvocation(this.ws, text);
    return found && { ...found, text };
  }
  /** Starts a task in its own chat. Called by the dispatcher or by Start now. */
  start(id) {
    const task = this.get(id);
    if (!task.botId) throw new Error("Give the task to a bot first.");
    if (task.status === "working") return;
    if (this.ws.closing) throw new Error("Botkins is closing");
    // Reuse the task's chat unless it is gone or busy with something else; then start a fresh one.
    const reuse = Boolean(task.chatId && this.ws.state.chats.some((c) => c.id === task.chatId && c.botId === task.botId) && !this.ws.active.has(task.chatId));
    const chatId = reuse ? task.chatId : this.ws.createChat(task.botId, "Task · " + task.title.slice(0, 80));
    let turn;
    const from = task.status;
    const messageText = this.invocation(task)?.text ?? this.prompt(task, { resuming: reuse });
    const invoked = this.invocation(task);
    try {
      // A task another bot created arrives as a message from that bot, shown as a rail card.
      const sender = this.isBotCreator(task.createdBy)
        ? { kind: "bot", botId: task.createdBy, name: this.botName(task.createdBy) ?? "a bot", ...(task.createdChatId && { chatId: task.createdChatId }), via: "task" }
        : undefined;
      turn = this.ws.send(chatId, messageText, { taskId: task.id, title: "Task · " + task.title.slice(0, 90), ...(sender && { from: sender }), ...(invoked && { allowScript: true }) });
    } catch (error) {
      Object.assign(task, { chatId, status: "blocked", problem: error.message, updatedAt: Date.now() });
      this.recordHistory(task, from, "blocked", { by: "system", note: error.message });
      this.ws.save();
      if (from !== "blocked") this.ws.events?.emit("task.status", { task, from, to: "blocked" });
      throw error;
    }
    Object.assign(task, { chatId, status: "working", updatedAt: Date.now() });
    delete task.problem;
    delete task.pendingNote;
    delete task.reviewerBotId;
    this.ws.chat(chatId).title = "Task · " + task.title.slice(0, 80);
    task.runId = this.ws.state.runs.find((r) => r.chatId === chatId)?.id;
    this.recordHistory(task, from, "working", { by: "system" });
    this.ws.save();
    if (from !== "working") this.ws.events?.emit("task.status", { task, from, to: "working" });
    turn.catch((error) => console.error("Task:", error.message));
  }
  /**
   * Delivers a task completion notice into the creator bot's originating chat (or its main chat if gone)
   * so the orchestrating bot can review and accept/send back the work without asking the person.
   */
  notifyCreator(task, { autoAccepted = false, reply = "" } = {}) {
    if (!this.isBotCreator(task.createdBy)) return null;
    const creator = this.ws.state.bots.find((b) => b.id === task.createdBy);
    if (!creator) return null;
    const workerName = this.botName(task.botId) ?? "Unassigned";
    const targetChat =
      (task.createdChatId && this.ws.state.chats.find((c) => c.id === task.createdChatId && c.botId === creator.id)) ||
      this.ws.state.chats.find((c) => c.botId === creator.id && c.main) ||
      this.ws.state.chats.find((c) => c.botId === creator.id);
    const chatId = targetChat?.id ?? this.ws.createChat(creator.id, "Task review · " + task.title.slice(0, 70));
    const chat = this.ws.chat(chatId);
    const summary = (reply || task.result || "(no summary)").slice(0, 3000);
    const prompt = autoAccepted
      ? `[Task completed and auto-accepted]\nTask: ${task.title} (id: ${task.id})\nCompleted by: ${workerName}\nStatus: done (auto-accepted)\n\nResult:\n${summary}`
      : `[Task ready for your review]\nTask: ${task.title} (id: ${task.id})\nCompleted by: ${workerName}\nStatus: review (assigned to you as creator)\n\nResult:\n${summary}\n\nReview the work and call task_update with id "${task.id}": set status "done" to accept it, or status "ready" with a "note" to send it back to ${workerName} in the same chat.`;
    const now = Date.now();
    // Record a structured rail card/context entry on the chat so both UI and next turn see the result.
    const notice = {
      id: randomUUID(),
      role: "assistant",
      text: prompt,
      time: now,
      taskResult: {
        taskId: task.id,
        title: task.title,
        workerBotId: task.botId ?? null,
        workerName,
        status: task.status,
        autoAccepted,
        result: summary,
      },
    };
    if (autoAccepted) {
      chat.messages.push(notice);
      chat.posted = [...(chat.posted ?? []), { from: "Task · " + task.title.slice(0, 60), text: prompt, time: now }].slice(-20);
      chat.time = now;
      this.ws.save();
      this.ws.events?.emit("task.creatorNotified", { task, chatId, autoAccepted: true });
      return { chatId, mode: "posted" };
    }
    // Trigger a review turn in the creator's chat if free; otherwise queue via chat.posted & record the notice.
    if (!this.ws.closing && !this.ws.active.has(chatId) && !chat.hostDispatch) {
      try {
        const turn = this.ws.send(chatId, prompt, {
          title: "Review · " + task.title.slice(0, 80),
          taskReviewId: task.id,
          notify: false,
        });
        turn.catch((error) => console.error("Task review notify:", error.message));
        this.ws.events?.emit("task.creatorNotified", { task, chatId, autoAccepted: false, mode: "turn" });
        return { chatId, mode: "turn" };
      } catch (error) {
        console.error("Task review notify:", error.message);
      }
    }
    // Chat is busy or unavailable for immediate send: record card and inject into the creator's next turn.
    chat.messages.push(notice);
    chat.posted = [...(chat.posted ?? []), { from: "Task · " + task.title.slice(0, 60), text: prompt, time: now }].slice(-20);
    chat.time = now;
    this.ws.save();
    this.ws.events?.emit("task.creatorNotified", { task, chatId, autoAccepted: false, mode: "posted" });
    return { chatId, mode: "posted" };
  }
  finished(run) {
    const task = this.all.find((t) => t.id === run.taskId);
    if (!task || task.status !== "working") return;
    const from = task.status;
    const chat = this.ws.state.chats.find((c) => c.id === run.chatId);
    const reply = chat?.messages.findLast((m) => m.runId === run.id && m.role === "assistant" && !m.interim)?.text;
    const mode = this.reviewMode(task);
    const botCreator = this.isBotCreator(task.createdBy);
    const now = Date.now();
    let nextStatus;
    let notifyOpts = null;
    if (run.status === "Completed") {
      const resultText = (reply ?? "").slice(0, 4000);
      if (mode === "auto" && botCreator) {
        nextStatus = "done";
        Object.assign(task, { status: "done", result: resultText });
        delete task.reviewerBotId;
        this.recordHistory(task, from, "done", { by: "system", note: "Auto-accepted.", at: now });
        notifyOpts = { autoAccepted: true, reply: resultText };
      } else if (mode === "creator" && botCreator) {
        nextStatus = "review";
        Object.assign(task, { status: "review", result: resultText, reviewerBotId: task.createdBy });
        this.recordHistory(task, from, "review", { by: "system", note: "Waiting for " + (this.botName(task.createdBy) ?? "creator") + " to review.", at: now });
        notifyOpts = { autoAccepted: false, reply: resultText };
      } else {
        nextStatus = "review";
        Object.assign(task, { status: "review", result: resultText });
        delete task.reviewerBotId;
        this.recordHistory(task, from, "review", { by: "system", at: now });
      }
    } else {
      nextStatus = "blocked";
      Object.assign(task, { status: "blocked", problem: run.detail || run.status });
      delete task.reviewerBotId;
      this.recordHistory(task, from, "blocked", { by: "system", note: run.detail || run.status, at: now });
    }
    task.updatedAt = now;
    this.ws.save();
    if (from !== nextStatus) this.ws.events?.emit("task.status", { task, from, to: nextStatus });
    if (notifyOpts) this.notifyCreator(task, notifyOpts);
  }
  /**
   * Starts the most urgent Ready tasks, as many as the limits allow (desktop/task-limits.mjs): Tasks at once on the
   * whole computer, and Tasks at once per bot. Each task runs in its own chat, so one bot's tasks run side by side.
   */
  tick() {
    if (this.ws.closing) return;
    const { tasksMax, tasksPerBot } = taskLimits(this.ws.state.settings);
    const running = this.all.filter((t) => t.status === "working");
    const perBot = new Map();
    for (const t of running) perBot.set(t.botId, (perBot.get(t.botId) ?? 0) + 1);
    // Most urgent first; among equals, the oldest (new tasks are added at the front of the list).
    const rank = (t) => PRIORITIES.indexOf(t.priority);
    const ready = this.all
      .filter((t) => t.status === "ready" && t.botId && !(t.chatId && this.ws.active.has(t.chatId)))
      .sort((a, b) => rank(b) - rank(a) || this.all.indexOf(b) - this.all.indexOf(a));
    let count = running.length;
    for (const next of ready) {
      if (count >= tasksMax || this.ws.closing) break;
      if ((perBot.get(next.botId) ?? 0) >= tasksPerBot) continue;
      try {
        this.start(next.id);
      } catch (error) {
        console.error("Task:", error.message);
        continue;
      }
      if (next.status !== "working") continue;
      perBot.set(next.botId, (perBot.get(next.botId) ?? 0) + 1);
      count++;
    }
  }
  /** Whether a routine run has owner opt-in to create a ready task for a bot. */
  routineAllowsReady(chat, run) {
    if (run?.scheduleId == null) return false;
    const entry = chat?.schedules?.find((s) => s.id === run.scheduleId && s.routine);
    return entry?.allowReadyTasks === true;
  }
  tools(bot, chat, run, task) {
    const string = { type: "string" };
    let created = 0;
    const tool = (name, description, properties, required, handler) =>
      defineTool(name, {
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        skipPermission: true,
        defer: "never",
        handler: async (args) => {
          if (task.stopped || this.ws.closing || !run || this.ws.active.get(chat.id) !== task)
            throw new Error("This turn is no longer active");
          const result = await handler(args);
          // A plain sentence (the person declined) goes as it is.
          return typeof result === "string" ? result : JSON.stringify(result);
        },
      });
    const stillActive = () => {
      if (task.stopped || task.ended || this.ws.closing || this.ws.active.get(chat.id) !== task) throw new Error("This turn has ended.");
    };
    /** A task that invokes a script command is not saved on a bot's word: the person sees the command, its words and the task, and decides. */
    const approved = async (invocation, about) => {
      const yes = await askToSchedule(this.ws, { bot, chat, task, invocation, what: "Let a task run the script command /" + invocation.name + "?", about });
      stillActive();
      return yes;
    };
    const botByName = (name) => {
      if (!name) return null;
      const match = this.ws.state.bots.find((b) => b.name.toLowerCase() === String(name).toLowerCase());
      if (!match) throw new Error("No bot is named " + name + ". Bots: " + this.ws.state.bots.map((b) => b.name).join(", "));
      return match.id;
    };
    const view = (t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      bot: this.botName(t.botId) ?? "anyone",
      createdBy: t.createdBy === "person" ? "person" : (this.botName(t.createdBy) ?? t.createdBy),
      ...(t.review && { review: t.review }),
      ...(t.reviewerBotId && { reviewer: this.botName(t.reviewerBotId) ?? t.reviewerBotId }),
      result: t.result,
      problem: t.problem,
      ...(t.history?.length && { history: t.history.slice(-10) }),
    });
    return [
      tool(
        "task_create",
        "Create a Task Board job (not an in-chat update_plan checklist); status \"ready\" with a bot automatically starts background work in its own chat once that bot has room, while \"later\" queues it for the person. " +
          "Bot-created tasks default to review \"creator\" (results return to you in this chat to accept or send back) or set review \"auto\" to auto-accept to done while notifying you, or \"person\" for the person to review. " +
          "Tasks added during a routine or another task wait in Later by default; an owner-approved routine with ready-task opt-in may create a \"ready\" task assigned to a bot.",
        {
          title: string,
          details: string,
          bot: string,
          priority: { type: "string", enum: PRIORITIES },
          status: { type: "string", enum: ["later", "ready"] },
          review: { type: "string", enum: REVIEW_MODES, description: "Who reviews when done: \"creator\" (default for bots), \"auto\" (mark done and notify you), or \"person\"." },
        },
        ["title"],
        async ({ title, details, bot: name, priority, status, review }) => {
          if (created >= PER_TURN) throw new Error("Create at most ten tasks per reply.");
          if (this.all.filter((t) => !["done", "archived"].includes(t.status)).length >= MAX_OPEN)
            throw new Error("The task board is full. Ask the person to finish or archive some tasks.");
          const assignedBotId = botByName(name);
          // Work that runs without the person (a routine or another task) waits in Later by default.
          // An owner-approved routine (allowReadyTasks: true) may create a ready task when assigned to a bot.
          const unattended = !!(run.scheduleId || run.taskId);
          const canRoutineReady = Boolean(run.scheduleId && !run.taskId && assignedBotId && this.routineAllowsReady(chat, run));
          const effectiveStatus = unattended && !canRoutineReady ? "later" : status;
          const invocation = scriptInvocation(this.ws, (details && String(details).trim()) || title || "");
          // A task that runs a script command waits for the person's yes, so work nobody watches can't make one, even in Later.
          if (invocation && unattended) throw new Error("A task that runs a script command can only be made with the person there. Ask them to.");
          if (invocation && !(await approved(invocation, ["Task: " + shownText(title), "Status: " + (effectiveStatus ?? "later") + (name ? ", for " + shownText(name) : ""), ...(effectiveStatus === "ready" && name ? ["It starts by itself when " + shownText(name) + " is free."] : [])]))) return "The person declined.";
          const id = this.save(
            {
              title,
              body: details,
              botId: assignedBotId,
              priority,
              status: effectiveStatus,
              ...(review !== undefined && { review }),
              createdChatId: chat.id,
            },
            bot.id,
          );
          const createdTask = this.get(id);
          // Record bot-to-bot task handoffs on the creating run so the chat shows a rail card with live task status.
          if (assignedBotId && assignedBotId !== bot.id) {
            const handoffs = (run.taskHandoffs ??= []);
            handoffs.push({
              id: createdTask.id,
              taskId: createdTask.id,
              botId: assignedBotId,
              fromBotId: bot.id,
              from: { kind: "bot", botId: bot.id, name: bot.name, chatId: chat.id, via: "task" },
              title: createdTask.title,
              ...(createdTask.body && { details: createdTask.body }),
              priority: createdTask.priority,
              status: createdTask.status,
              started: createdTask.createdAt,
            });
            this.ws.notify();
          }
          created++;
          return view(createdTask);
        },
      ),
      tool(
        "task_list",
        "List tasks on the board that are given to you or that you created, with their status, priority, bot, reviewer, result and problem. To watch a task on a schedule, don't poll with this from an instructions routine: use routine_create with a script that reads `botkins tasks list --json` and wakes you (followUp) only when a status changes.",
        {},
        [],
        () => this.all.filter((t) => t.botId === bot.id || t.createdBy === bot.id).slice(0, 50).map(view),
      ),
      tool(
        "task_update",
        "Update a Task Board job you own or created; setting status to \"ready\" on a bot-assigned task can automatically start background work. To send work back, set status \"ready\" with a note; the same bot continues in the same chat. " +
          "Change title, details, priority, status (later, ready, review, done or archived), or note. Only the creating bot may accept (done) or send back (ready/later) a task it created that is waiting in Review. " +
          "The task you are working on right now needs no status from you: it moves to Review by itself when your reply ends, with your reply as its result, and the person (or creating bot) marks it done. Its title and details stay as the person wrote them.",
        {
          id: string,
          title: string,
          details: string,
          priority: { type: "string", enum: PRIORITIES },
          status: { type: "string", enum: ["later", "ready", "review", "done", "archived"] },
          note: { type: "string", description: "Feedback or reason for moving the task (used when sending work back to ready or reopening)." },
        },
        ["id"],
        async ({ id, title, details, priority, status, note }) => {
          const t = this.get(id);
          if (t.botId !== bot.id && t.createdBy !== bot.id) throw new Error("You can only change your own tasks.");
          // A bot-created task in review can only be accepted or sent back by the bot that created it (not the assignee or another bot).
          if (
            t.id !== run.taskId &&
            status &&
            t.status === "review" &&
            status !== "review" &&
            this.isBotCreator(t.createdBy) &&
            t.createdBy !== bot.id
          ) {
            throw new Error("Only the bot that created this task can accept or send it back from Review.");
          }
          // The task being worked on keeps the person's wording, and its status is the board's to
          // set when the reply ends (finished()). A bot that marks its own task done, or hands it
          // in for review, has done nothing wrong: the call succeeds and says what will happen.
          // Nothing fails, so the bot never concludes that the board is broken.
          if (t.id === run.taskId && (status || title !== undefined || details !== undefined)) {
            if (priority !== undefined) Object.assign(t, { priority, updatedAt: Date.now() });
            this.ws.save();
            const notes = [];
            const reviewDest = this.reviewMode(t) === "auto" && this.isBotCreator(t.createdBy)
              ? "Done (auto-accepted)"
              : this.reviewMode(t) === "creator" && this.isBotCreator(t.createdBy)
                ? (this.botName(t.createdBy) ?? "its creator") + " for review"
                : "Review";
            if (status === "done" || status === "review") notes.push("Noted. This task moves to " + reviewDest + " when your reply ends, with your reply as its result, and the person marks it done. Put the result in your reply.");
            else if (status) notes.push("You are working on this task now, so its status stays as it is: it moves to " + reviewDest + " by itself when your reply ends. To leave it unfinished, say in your reply what is left.");
            if (title !== undefined || details !== undefined) notes.push("Its title and details stay as the person wrote them while you work on it. Put what you found in your reply: that is recorded as the task's result.");
            // The note comes first, and what happens next is said beside the status, so a bot that
            // reads only `status: "working"` doesn't take its request for ignored.
            return { note: notes.join(" "), ...view(t), next: "review, when your reply ends" };
          }
          // A task whose text is a script command, as it would be after this change: a bot changes it, or readies it, only with the person's yes.
          const after = { title: title !== undefined ? title : t.title, body: details !== undefined ? body(details) : t.body };
          const invocation = (title !== undefined || details !== undefined || status === "ready") && scriptInvocation(this.ws, (after.body && after.body.trim()) || after.title || "");
          if (invocation) {
            if (run.scheduleId || run.taskId) throw new Error("A task that runs a script command can only be changed with the person there. Ask them to.");
            if (!(await approved(invocation, ["Task: " + shownText(after.title), "Change: " + [title !== undefined && "title", details !== undefined && "details", status && "status " + status].filter(Boolean).join(", ")]))) return "The person declined.";
          }
          if (title !== undefined || details !== undefined || priority !== undefined) {
            if (t.status === "working" && t.id !== run.taskId) throw new Error("That task is running.");
            Object.assign(t, {
              ...(title !== undefined && { title: textField(title, 160, "task title") }),
              ...(details !== undefined && { body: body(details) }),
              ...(priority !== undefined && { priority }),
              updatedAt: Date.now(),
            });
          }
          if (status && t.id !== run.taskId) this.move(id, status, { by: bot.id, note });
          this.ws.save();
          return view(t);
        },
      ),
    ];
  }
}
