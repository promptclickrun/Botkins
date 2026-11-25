// Tools a bot runs on a paired Chromium browser extension (Chrome or Edge).
//
// The extension connects over Botkins Link as a device of kind `"browser"` (desktop/link/browser.mjs).
// Tools are exposed while at least one paired browser extension is enabled. Because the user
// explicitly installed and enabled the extension so bots can drive their browser unattended
// (including from a phone while away from the desk), browser tools run directly without extra
// per-click approval friction and remain available across turns.
import { defineTool } from "./providers/index.mjs";

const NAME = /^browser_[a-z_]{1,42}$/;
const WATCH_MS = 500;

export function listedBrowserTools(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((tool) => {
    if (!tool || typeof tool.name !== "string" || !NAME.test(tool.name) || seen.has(tool.name)) return false;
    if (typeof tool.description !== "string" || !tool.description.trim()) return false;
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object") return false;
    seen.add(tool.name);
    return true;
  });
}

export class BrowserExtensionTools {
  /**
   * @param ws      The workspace.
   * @param source  () => { tools(), call(name, args, { signal, botId, chatId }) } | null
   */
  constructor(ws, source = () => null) {
    this.ws = ws;
    this.source = typeof source === "function" ? source : () => source;
  }

  listed() {
    try {
      return listedBrowserTools(this.source()?.tools?.());
    } catch {
      return [];
    }
  }

  summary() {
    const list = this.listed();
    return { tools: list.length, readOnly: list.filter((tool) => tool.readOnly === true).length };
  }

  tools(bot, chat, run, task) {
    return this.listed().map((tool) =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.parameters,
        skipPermission: true,
        handler: async (args) => {
          const active = () => !(task?.stopped || this.ws.closing || !run || this.ws.active?.get(chat.id) !== task);
          if (!active()) throw new Error("This turn is no longer active");
          const link = this.source();
          if (!link?.call) throw new Error("The browser extension link isn't running.");
          const gone = new AbortController();
          const watch = setInterval(() => !active() && gone.abort(), WATCH_MS);
          try {
            const result = await link.call(tool.name, args && typeof args === "object" ? args : {}, { signal: gone.signal, botId: bot?.id, chatId: chat.id });
            return typeof result === "string" ? result : JSON.stringify(result ?? null);
          } finally {
            clearInterval(watch);
          }
        },
      }),
    );
  }
}
