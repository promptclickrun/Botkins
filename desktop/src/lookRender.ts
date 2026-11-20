// How a bot's look is passed to the design kit's renderer (motion/render.js
// `render(source, state, { palette, eyes })`). Kept apart from src/botkins.ts, and with no imports
// that stay at run time, so test/looks.test.mjs can load it as it is.
import type { BotLook } from "./types";

/** Four colors: [shell, accent, faceplate, eyes], each "#rrggbb". */
export type FourColors = [string, string, string, string];

/** The palette of a look in four colors of its own. */
export const CUSTOM = "custom";

const HEX = /^#[0-9a-f]{6}$/i;
export const isFourColors = (value: unknown): value is FourColors => Array.isArray(value) && value.length === 4 && value.every((color) => typeof color === "string" && HEX.test(color));
/** A custom look with its four colors. Custom without them draws as Original. */
export const isCustom = (look: BotLook) => look.palette === CUSTOM && isFourColors(look.colors);

/** The kit's names for the eye styles (customize.js `eyeStyles`), by the id a look saves. */
const EYE_NAMES: Record<string, string> = { oval: "Oval", button: "Button", smile: "Smile", sleepy: "Sleepy", wink: "Wink", curious: "Curious" };

/**
 * The options for the kit's renderer: `palette` is a kit palette's name (such as "Fig") or, for a
 * custom look, its four colors; `eyes` is the kit's eye style name. A bot's own eyes replace only
 * the default open eyes, a clip whose eyes are Oval; a state with its own expression (Listening is
 * Curious, Completed smiles) keeps it. A look without eyes passes none, so it draws as before.
 * @param clipEyes  The eyes of the clip being drawn (the motion catalog's `eyes`).
 * @param palettes  The kit's palettes by name (customize.js `palettes`).
 */
export function kitOptions(look: BotLook, clipEyes: string, palettes: Record<string, unknown>): { palette: string | FourColors; eyes?: string } {
  const palette = isCustom(look) ? (look.colors!.map((color) => color.toLowerCase()) as FourColors) : (Object.keys(palettes).find((name) => name.toLowerCase() === look.palette) ?? "Original");
  const eyes = look.eyes ? EYE_NAMES[look.eyes] : undefined;
  return clipEyes === "Oval" && eyes && eyes !== "Oval" ? { palette, eyes } : { palette };
}
