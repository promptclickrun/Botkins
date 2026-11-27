/**
 * Built-in Channel Hooks adapter registry.
 */

import { createSlackAdapter } from "./slack.mjs";
import { createTelegramAdapter } from "./telegram.mjs";
import { createDiscordAdapter } from "./discord.mjs";
import { createIMessageAdapter } from "./imessage.mjs";

export function registerBuiltInAdapters(manager) {
  manager.registerAdapter("slack", () => createSlackAdapter());
  manager.registerAdapter("telegram", () => createTelegramAdapter());
  manager.registerAdapter("discord", () => createDiscordAdapter());
  manager.registerAdapter("imessage", ({ nodeBridge } = {}) => createIMessageAdapter({ nodeBridge }));
}
