/**
 * Built-in Channel Hooks adapter registry.
 * Additional adapters (Telegram, Discord, iMessage) are added here commit by commit.
 */

import { createSlackAdapter } from "./slack.mjs";
import { createTelegramAdapter } from "./telegram.mjs";
import { createDiscordAdapter } from "./discord.mjs";

export function registerBuiltInAdapters(manager) {
  manager.registerAdapter("slack", () => createSlackAdapter());
  manager.registerAdapter("telegram", () => createTelegramAdapter());
  manager.registerAdapter("discord", () => createDiscordAdapter());
}
