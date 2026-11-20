// Test fixture: the three bots most tests talk to. A new Botkins workspace has no bots (the
// first-run screen makes them), so tests that need bots start from this workspace instead.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";

export const starterBots = [
  ["pip", "Pip", "Everyday helper", "Help the user plan, write and think clearly.", "idle"],
  ["scout", "Scout", "Research partner", "Help investigate questions. Distinguish evidence from inference.", "searching"],
  ["patch", "Patch", "Coding companion", "Help write and explain maintainable software.", "coding"],
].map(([id, name, role, instructions, face]) => ({ id, name, role, instructions, face }));

/** Writes a workspace file with the starter bots into `dataDir`, unless the folder already has one. */
export function seedBots(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "workspace.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ bots: starterBots, chats: [], runs: [] }));
}

/** For smokes: seeds the data folder the app uses when BOTKINS_DATA_DIR is `userData`. */
export const seedApp = (userData) => seedBots(join(userData, "data"));

/** A Workspace that starts with the starter bots when its folder is new. */
export class Workspace extends RealWorkspace {
  constructor(dir, ...rest) {
    seedBots(dir);
    super(dir, ...rest);
  }
}
