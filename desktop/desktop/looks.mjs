// How a bot looks: one of the Botkins characters, in one of the design kit's palettes or in four
// colors of the person's own, with one of the kit's eye styles.
//
//   bot.look = { head: "sprig", palette: "original" }
//   bot.look = { head: "sprig", palette: "fig", eyes: "wink" }
//   bot.look = { head: "sprig", palette: "custom", colors: ["#3e4f86", "#e0b354", "#e8ecf6", "#151a2e"] }
//
// `colors` is [shell, accent, faceplate, eyes]. "oval" eyes are every character's own and are
// not saved. The rules are the phone link's (link-host/store.mjs `cleanLook` in the phone repo),
// so a look saved on either side means the same on both.
//
// The look lives on the bot's own record, so this app and every paired phone show the same
// character (the phone link sends each bot's `look` and saves a change through `setLook`,
// desktop/main.mjs). The characters and palettes are the design kit's (design/botkins-kit); the
// app's page draws them (src/botkins.ts).
//
// Earlier versions drew a bot from `avatar` (a Bot Studio silhouette) and `face` (a Lottie face).
// Those fields are still read from files and left where they are, and nothing draws them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The 20 characters, by id (the names of design/botkins-kit/avatars/*.svg). */
export const HEADS = ["beacon", "crumb", "fathom", "goggle", "luna", "morel", "muse", "oakley", "pearl", "pip", "posy", "pounce", "ramble", "skiff", "spool", "sprig", "tinker", "toast", "wick", "wicket"];
/** The 7 palettes (design/botkins-kit/customize.js). Original keeps each character's own colors. */
export const PALETTES = ["original", "terracotta", "honey", "fern", "tidepool", "bluebell", "fig"];

/** The kit's eye styles (design/botkins-kit/customize.js), in its order. "oval" is each character's own. */
export const EYES = ["oval", "button", "smile", "sleepy", "wink", "curious"];
/** The palette of a look in four colors of its own. */
export const CUSTOM = "custom";
/** What a computer that keeps eyes and custom colors tells a phone it can do (sent among the link's capabilities, desktop/main.mjs). */
export const LOOKS_CAPABILITY = "looks-v2";

const HEX = /^#[0-9a-f]{6}$/i;

/** A look as it may be saved, or the reason it can't be. */
function checkLook(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Choose a character for this bot." };
  if (!HEADS.includes(value.head)) return { error: "Unknown character" };
  if (value.palette !== CUSTOM && !PALETTES.includes(value.palette)) return { error: "Unknown palette" };
  const look = { head: value.head, palette: value.palette };
  // Left out or null is the character's own eyes, as on the phone.
  if (value.eyes != null) {
    if (!EYES.includes(value.eyes)) return { error: "Unknown eyes" };
    if (value.eyes !== "oval") look.eyes = value.eyes;
  }
  // Colors belong to a custom look only. With a kit palette they are dropped, as the phone does.
  if (value.palette === CUSTOM) {
    const colors = value.colors;
    if (!Array.isArray(colors) || colors.length !== 4 || !colors.every((color) => typeof color === "string" && HEX.test(color))) return { error: "Custom colors need four colors such as #c75e35." };
    look.colors = colors.map((color) => color.toLowerCase());
  }
  return { look };
}

/** A look as given, or null when it isn't one this app can draw. */
export const cleanLook = (value) => checkLook(value).look ?? null;

/** A look to save. Throws for a character, palette, eyes or colors the app can't draw. */
export function lookField(value) {
  const { look, error } = checkLook(value);
  if (error) throw new Error(error);
  return look;
}

const hash = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

/**
 * The look for a bot that has none: a character few other bots have, in its own colors, so a
 * small team is all different. The same bot among the same others always gets the same one.
 * @param id     The bot's id.
 * @param looks  The looks already in use.
 */
export function nextLook(id, looks = []) {
  const used = new Map(HEADS.map((head) => [head, 0]));
  for (const look of looks) if (used.has(look?.head)) used.set(look.head, used.get(look.head) + 1);
  const fewest = Math.min(...used.values());
  const free = HEADS.filter((head) => used.get(head) === fewest);
  return { head: free[hash(String(id)) % free.length], palette: "original" };
}

/**
 * Gives every bot a look. A bot keeps the one it has; one without takes the look a phone saved
 * for it (`saved`, by bot id: the `looks` an earlier phone link kept in link.json), else a
 * character few other bots have. Returns true when a bot changed.
 */
export function migrateLooks(state, saved = {}) {
  let changed = false;
  const bots = state.bots ?? [];
  // Looks that are already settled count first, so new ones avoid them.
  for (const bot of bots) {
    const own = cleanLook(bot.look);
    const look = own ?? cleanLook(saved?.[bot.id]);
    if (look && !own) changed = true;
    if (look) bot.look = look;
    else delete bot.look;
  }
  for (const bot of bots) {
    if (bot.look) continue;
    bot.look = nextLook(bot.id, bots.map((b) => b.look));
    changed = true;
  }
  return changed;
}

/** The looks an earlier phone link kept in <data>/link/link.json, by bot id. Empty when there are none. */
export function linkLooks(dataDir) {
  try {
    const looks = JSON.parse(readFileSync(join(dataDir, "link", "link.json"), "utf8")).looks;
    return looks && typeof looks === "object" && !Array.isArray(looks) ? looks : {};
  } catch {
    return {};
  }
}

/** A template's look, when it has one this app can draw. */
export const templateLook = (data) => cleanLook(data?.look) ?? undefined;
