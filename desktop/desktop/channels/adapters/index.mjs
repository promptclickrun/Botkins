/**
 * Built-in Channel Hooks adapter registry.
 * Additional adapters (Telegram, Discord, iMessage) are added here commit by commit.
 */

import { createSlackAdapter } from "./slack.mjs";

export function registerBuiltInAdapters(manager) {
  manager.registerAdapter("slack", () => createSlackAdapter());
}
