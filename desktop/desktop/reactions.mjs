import { defineTool } from "./providers/index.mjs";

export function reactionTool(ws, bot, chat, run, task) {
  if (!run || chat.helper || run.panelId || run.taskId || run.scheduleId) return [];
  return [defineTool("react", {
    description: "Acknowledge the most recent person message in this turn with one emoji. Repeating replaces your reaction. You may finish without a text reply.",
    parameters: { type: "object", properties: { emoji: { type: "string" } }, required: ["emoji"], additionalProperties: false },
    skipPermission: true,
    defer: "never",
    handler: async ({ emoji }) => {
      if (ws.closing || task.stopped || task.ended || ws.active.get(chat.id) !== task || (task.speaker && task.speaker !== bot.id))
        throw new Error("This turn is no longer active.");
      const index = chat.messages.findLastIndex(m => m.role === "user" && (m.runId === run.id || m.steeredRunId === run.id));
      if (index < 0) throw new Error("There is no person message to acknowledge in this turn.");
      ws.reactToMessage(chat.id, index, chat.messages[index].time ?? null, emoji, "bot:" + bot.id);
      task.reactedBy = bot.id;
      return "Reaction saved.";
    },
  })];
}
