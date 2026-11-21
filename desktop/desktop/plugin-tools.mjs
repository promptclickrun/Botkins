// Bots may suggest a change. Only the person can authorize its reviewed revision, even in
// approve-all chats. Values from a secure settings prompt go from Interactions to the vault.
import { defineTool } from "./providers/provider.mjs";
import { pluginCard, shownCut } from "./plugin-card.mjs";

// A plugin that the card cannot show whole is not asked about in a chat: a yes must be for all of
// it. One sentence works for every action.
const TOO_LARGE =
  "This plugin is too large to look at in a chat. Make this change in Settings, Marketplace, Plugins, or with `botkins plugins` on the command line, where all of it is shown.";

export function pluginTools(ws, bot, chat, run, task) {
  if (!task || !run || chat.helper || run.scheduleId != null || run.panelId || run.taskId) return [];
  const active = () => {
    if (task.ended || task.stopped || ws.closing || ws.active.get(chat.id) !== task) throw new Error("This turn has ended.");
  };
  const string = { type: "string" };
  return [
    defineTool("search_plugins", {
      description: "Search the computer's plugin marketplaces by name or purpose. Use propose_plugin for a change.",
      parameters: { type: "object", properties: { query: string }, required: ["query"], additionalProperties: false },
      handler: async ({ query }) => {
        active();
        const { plugins } = await ws.plugins.browse({ query });
        return JSON.stringify(plugins.slice(0, 20).map(({ id, name, description, installed }) => ({ id, name, description, installed })));
      },
    }),
    defineTool("propose_plugin", {
      description:
        "Propose a marketplace plugin change for the person to review. An install applies to this bot. Configure opens private fields for the person. Never include credentials in tool arguments.",
      parameters: {
        type: "object",
        properties: { id: string, action: { type: "string", enum: ["install", "configure", "enable", "disable", "update", "uninstall"] } },
        required: ["id", "action"],
        additionalProperties: false,
      },
      handler: async ({ id, action }) => {
        active();
        if (!["install", "configure", "enable", "disable", "update", "uninstall"].includes(action))
          throw new Error("Choose a plugin action.");
        const plugins = ws.plugins;
        const existing = plugins.list().find((p) => p.id === id);
        if (action !== "install" && !existing) throw new Error("This plugin is not installed.");
        const card = action === "install" || action === "update" ? await plugins.preview(id) : existing;
        const generation = plugins.generation;
        const stillCurrent = () => {
          active();
          if (generation !== plugins.generation)
            throw new Error("The plugins changed while this request was open. Review the change again.");
        };
        const bots =
          action === "install"
            ? bot.name
            : existing.bots === "all"
              ? "All bots"
              : existing.bots.map((x) => ws.state.bots.find((b) => b.id === x)?.name ?? x).join(", ");
        const { lines, whole } = pluginCard(card, { bots, action, id });
        if (!whole) {
          ws.pluginNote?.(chat.id, TOO_LARGE);
          return TOO_LARGE;
        }
        const detail = lines.join("\n");
        // Text from the plugin that goes outside the card is made safe and bounded. A key that
        // sends a value back stays exact; only what is shown is changed.
        const name = shownCut(card.name || id, 80, false);
        const decision = await ws.interactions.request(chat, task, {
          botId: bot.id,
          kind: "permission",
          title: "Allow plugin change?",
          preview: action + " · " + name,
          detail,
        });
        stillCurrent();
        if (decision.action !== "approve") return "The person declined.";
        const values = Object.create(null);
        if (action === "configure" || action === "install") {
          const fields = card.config.filter((f) => action === "configure" || (f.required && f.default == null));
          for (let i = 0; i < fields.length; i += 8) {
            const batch = fields.slice(i, i + 8);
            const answer = await ws.interactions.request(
              chat,
              task,
              {
                kind: "secure",
                botId: bot.id,
                title: "Configure " + name,
                detail: "Save these settings for " + name + " on this computer. The plugin can use them when it runs.",
                fields: batch.map((f) => ({
                  key: f.key,
                  label: shownCut(f.label ?? f.key, 120),
                  kind: f.secret ? "secret" : "text",
                  optional: action === "configure" || !f.required,
                })),
              },
              300000,
            );
            stillCurrent();
            if (answer.action !== "accept") return "The person dismissed plugin configuration.";
            Object.assign(values, answer.content);
          }
        }
        stillCurrent();
        if (action === "install") await plugins.install(id, { bots: [bot.id], config: values, revision: card.revision }, stillCurrent);
        else if (action === "configure") await plugins.configure(id, values, stillCurrent);
        else if (action === "update") await plugins.update(id, { revision: card.revision }, stillCurrent);
        else if (action === "uninstall") await plugins.uninstall(id, stillCurrent);
        // A yes to switch on is for the revision that the card showed: a plugin that changed since is refused by the app.
        else await plugins.setEnabled(id, action === "enable", action === "enable" ? { revision: card.revision } : undefined, stillCurrent);
        return "Plugin change saved.";
      },
    }),
  ];
}
