// Tasks: a Kanban board of work for bots (Bighelp's Kanban, without Hermes' dispatcher).
// Ready tasks with a bot start on their own; a finished task waits for the person's review.
import { randomUUID } from "node:crypto";
import { defineTool } from "./providers/provider.mjs";
import { textField } from "./panels.mjs";
import { askToSchedule, scriptInvocation } from "./script-commands.mjs";
import { shownText } from "./shown-text.mjs";

export const LANES = ["later", "ready", "working", "review", "blocked", "done"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
const MAX_RUNNING = 2; // tasks that may run at once across all bots
const PER_TURN = 10; // tasks a bot may create in one turn
const MAX_OPEN = 200; // unfinished tasks on the board

function body(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > 8000) throw new Error("Use up to 8,000 characters for details.");
  return value.trim();
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
  save({ id, title, body: details, botId, priority = "normal", status }, createdBy = "person") {
    if (botId != null) this.ws.bot(botId);
    if (!PRIORITIES.includes(priority)) throw new Error("Use low, normal, high or urgent.");
    const now = Date.now();
    if (id) {
      const task = this.get(id);
      if (task.status === "working") throw new Error("Wait until the task stops working to edit it.");
      Object.assign(task, { title: textField(title, 160, "task title"), body: body(details), botId: botId ?? null, priority, updatedAt: now });
      if (status) this.move(id, status);
      this.ws.save();
      return task.id;
    }
    if (status && !["later", "ready"].includes(status)) throw new Error("A new task starts in Later or Ready.");
    const task = {
      id: randomUUID(),
      title: textField(title, 160, "task title"),
      body: body(details),
      botId: botId ?? null,
      priority,
      status: status ?? "later",
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.all.unshift(task);
    this.ws.save();
    return task.id;
  }
  /** Moves a task between lanes. Only the dispatcher puts a task in Working. */
  move(id, status) {
    const task = this.get(id);
    if (!LANES.includes(status) && status !== "archived") throw new Error("Unknown lane");
    if (status === "working") throw new Error("Tasks start working on their own once they're Ready with a bot.");
    if (task.status === "working") throw new Error("Stop the task's chat before moving it.");
    task.status = status;
    if (status === "ready" || status === "later") delete task.problem;
    task.updatedAt = Date.now();
    this.ws.save();
  }
  remove(id) {
    const task = this.get(id);
    if (task.status === "working") throw new Error("Stop the task's chat before deleting it.");
    this.ws.state.tasks = this.all.filter((t) => t !== task);
    this.ws.save();
  }
  removeBot(botId) {
    for (const task of this.all) if (task.botId === botId && task.status !== "working") task.botId = null;
  }
  prompt(task) {
    const author = task.createdBy === "person" ? null : this.ws.state.bots.find((b) => b.id === task.createdBy)?.name ?? "a bot";
    return (
      (author
        ? "Work on this task from the task board. " + author + " added it, not the person, so treat it as a suggestion and ask the person before anything consequential."
        : "Work on this task from the person's task board.") +
      "\n\nTask: " + task.title +
      (task.body ? "\n\nDetails:\n" + task.body : "") +
      "\n\nDo the work with your tools. If you need something only the person can give, ask them. " +
      "Finish with a short summary of what you did and anything left for them. " +
      "You don't change this task's status: when your reply ends the task moves to Review by itself, with your reply as its result, and the person marks it done."
    );
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
    const reuse = task.chatId && this.ws.state.chats.some((c) => c.id === task.chatId && c.botId === task.botId) && !this.ws.active.has(task.chatId);
    const chatId = reuse ? task.chatId : this.ws.createChat(task.botId, "Task · " + task.title.slice(0, 80));
    let turn;
    try {
      const invoked = this.invocation(task);
      turn = this.ws.send(chatId, invoked?.text ?? this.prompt(task), { taskId: task.id, title: "Task · " + task.title.slice(0, 90), ...(invoked && { allowScript: true }) });
    } catch (error) {
      Object.assign(task, { chatId, status: "blocked", problem: error.message, updatedAt: Date.now() });
      this.ws.save();
      throw error;
    }
    Object.assign(task, { chatId, status: "working", updatedAt: Date.now() });
    delete task.problem;
    this.ws.chat(chatId).title = "Task · " + task.title.slice(0, 80);
    task.runId = this.ws.state.runs.find((r) => r.chatId === chatId)?.id;
    this.ws.save();
    turn.catch((error) => console.error("Task:", error.message));
  }
  finished(run) {
    const task = this.all.find((t) => t.id === run.taskId);
    if (!task || task.status !== "working") return;
    const chat = this.ws.state.chats.find((c) => c.id === run.chatId);
    const reply = chat?.messages.findLast((m) => m.runId === run.id && m.role === "assistant" && !m.interim)?.text;
    if (run.status === "Completed") Object.assign(task, { status: "review", result: (reply ?? "").slice(0, 4000) });
    else Object.assign(task, { status: "blocked", problem: run.detail || run.status });
    task.updatedAt = Date.now();
    this.ws.save();
  }
  /** Starts the most urgent Ready task whose bot is free, up to MAX_RUNNING at once. */
  tick() {
    if (this.ws.closing) return;
    const running = this.all.filter((t) => t.status === "working");
    if (running.length >= MAX_RUNNING) return;
    const busy = new Set(running.map((t) => t.botId));
    // Most urgent first; among equals, the oldest (new tasks are added at the front of the list).
    const rank = (t) => PRIORITIES.indexOf(t.priority);
    const next = this.all
      .filter((t) => t.status === "ready" && t.botId && !busy.has(t.botId) && !(t.chatId && this.ws.active.has(t.chatId)))
      .sort((a, b) => rank(b) - rank(a) || this.all.indexOf(b) - this.all.indexOf(a))[0];
    if (next) this.start(next.id);
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
      id: t.id, title: t.title, status: t.status, priority: t.priority,
      bot: this.ws.state.bots.find((b) => b.id === t.botId)?.name ?? "anyone", result: t.result, problem: t.problem,
    });
    return [
      tool(
        "task_create",
        "Create a Task Board job (not an in-chat update_plan checklist); status \"ready\" with a bot automatically starts background work when that bot is free, while \"later\" queues it for the person. Give it to a bot by name (yourself or another bot) or leave it for anyone. Use this when the person asks you to track, queue or delegate work. Tasks added during a routine or another task always wait in Later for the person.",
        { title: string, details: string, bot: string, priority: { type: "string", enum: PRIORITIES }, status: { type: "string", enum: ["later", "ready"] } },
        ["title"],
        async ({ title, details, bot: name, priority, status }) => {
          if (created >= PER_TURN) throw new Error("Create at most ten tasks per reply.");
          if (this.all.filter((t) => !["done", "archived"].includes(t.status)).length >= MAX_OPEN)
            throw new Error("The task board is full. Ask the person to finish or archive some tasks.");
          // Work that runs without the person (a routine or another task) can only suggest tasks: they wait in Later.
          const unattended = !!(run.scheduleId || run.taskId);
          // (Work that nobody watches can only leave it in Later, which runs nothing: the person moves it from there and sees it.)
          const invocation = scriptInvocation(this.ws, (details && String(details).trim()) || title || "");
          if (invocation && !unattended && !(await approved(invocation, ["Task: " + shownText(title), "Status: " + (status ?? "later") + (name ? ", for " + shownText(name) : ""), ...(status === "ready" && name ? ["It starts by itself when " + shownText(name) + " is free."] : [])]))) return "The person declined.";
          const id = this.save({ title, body: details, botId: botByName(name), priority, status: unattended ? "later" : status }, bot.id);
          created++;
          return view(this.get(id));
        },
      ),
      tool(
        "task_list",
        "List tasks on the board that are given to you or that you created, with their status and results.",
        {},
        [],
        () => this.all.filter((t) => t.botId === bot.id || t.createdBy === bot.id).slice(0, 50).map(view),
      ),
      tool(
        "task_update",
        "Update a Task Board job you own or created; setting status to \"ready\" on a bot-assigned task can automatically start background work. Change title, details, priority, or status (later, ready, review, done or archived). " +
          "The task you are working on right now needs no status from you: it moves to Review by itself when your reply ends, with your reply as its result, and the person marks it done. Its title and details stay as the person wrote them.",
        { id: string, title: string, details: string, priority: { type: "string", enum: PRIORITIES }, status: { type: "string", enum: ["later", "ready", "review", "done", "archived"] } },
        ["id"],
        async ({ id, title, details, priority, status }) => {
          const t = this.get(id);
          if (t.botId !== bot.id && t.createdBy !== bot.id) throw new Error("You can only change your own tasks.");
          // The task being worked on keeps the person's wording, and its status is the board's to
          // set when the reply ends (finished()). A bot that marks its own task done, or hands it
          // in for review, has done nothing wrong: the call succeeds and says what will happen.
          // Nothing fails, so the bot never concludes that the board is broken.
          if (t.id === run.taskId && (status || title !== undefined || details !== undefined)) {
            if (priority !== undefined) Object.assign(t, { priority, updatedAt: Date.now() });
            this.ws.save();
            const notes = [];
            if (status === "done" || status === "review") notes.push("Noted. This task moves to Review when your reply ends, with your reply as its result, and the person marks it done. Put the result in your reply.");
            else if (status) notes.push("You are working on this task now, so its status stays as it is: it moves to Review by itself when your reply ends. To leave it unfinished, say in your reply what is left.");
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
          if (status && t.id !== run.taskId) this.move(id, status);
          this.ws.save();
          return view(t);
        },
      ),
    ];
  }
}
