// How a bot looks: one of the Botkins characters, in one of the kit's palettes or in four colors
// of the person's own, with one of the kit's eye styles.
// The characters and palettes come from the design kit (design/botkins-kit) by way of
// scripts/build-botkins.mjs. A bot's look is kept on the computer, beside the bot, so every
// paired phone shows the same character.
import type { BotkinEyes, BotkinLook } from "@/link/types";
import { makeHeadPicker, originalHeadIds } from "../../link-host/botkin-heads.mjs";
import { type BotkinHead, type BotkinLayers, HEAD_IMAGES, HEAD_LAYERS, HEAD_LIST, PALETTE_LIST } from "./botkins.generated";
import { type FourColors, isFourColors, TEMPLATES } from "./lookTemplates";

/** A character and its palette, by id: { head: "sprig", palette: "original" }. */
export type { BotkinEyes, BotkinLook };

export const HEADS: { id: string; name: string }[] = HEAD_LIST.map(({ id, name }) => ({ id, name }));
export const availableHeads = makeHeadPicker(HEADS);
export type LookOptions = { advanced?: boolean; capabilities?: readonly string[] };
/** The palettes on offer. `swatch` is the color to show for it; Original (the character's own colors) has none. */
export const PALETTES: { id: string; name: string; swatch: string | null }[] = PALETTE_LIST.map(({ id, name, colors }) => ({ id, name, swatch: colors?.[0] ?? null }));
/** The kit's palettes with their four colors (null for Original). */
export const KIT_PALETTES = PALETTE_LIST;
/** The eye styles, in the kit's order. "oval" is each character's own. */
export const EYES: { id: BotkinEyes; name: string }[] = [
  { id: "oval", name: "Oval" },
  { id: "button", name: "Button" },
  { id: "smile", name: "Smile" },
  { id: "sleepy", name: "Sleepy" },
  { id: "wink", name: "Wink" },
  { id: "curious", name: "Curious" },
];
/** The palette id of a look in four colors of its own. */
export const CUSTOM = "custom";

const heads = new Map(HEAD_LIST.map((head) => [head.id, head]));
const palettes = new Map(PALETTE_LIST.map((palette) => [palette.id, palette]));
const eyeStyles = new Set<string>(EYES.map((eyes) => eyes.id));

export type ResolvedLook = {
  head: BotkinHead;
  /** The picture to draw for a kit palette (for a custom look, the character in its own colors). */
  image: number;
  /** For a custom look: the layers and the four colors to tint them with. */
  custom: { layers: BotkinLayers; colors: FourColors } | null;
  eyes: BotkinEyes;
  ink: string;
  shell: string;
};

/** Everything the renderer needs to draw a look. Unknown ids fall back to the first of each. */
export function resolveLook(look: BotkinLook): ResolvedLook {
  const head = heads.get(look.head) ?? HEAD_LIST[0];
  const eyes = look.eyes && eyeStyles.has(look.eyes) ? look.eyes : "oval";
  const colors = Array.isArray(look.colors) ? look.colors.map((color) => (typeof color === "string" ? color.toLowerCase() : color)) : undefined;
  if (look.palette === CUSTOM && isFourColors(colors)) {
    return { head, image: HEAD_IMAGES[head.id][PALETTE_LIST[0].id], custom: { layers: HEAD_LAYERS[head.id], colors }, eyes, ink: colors[3], shell: colors[0] };
  }
  const palette = palettes.get(look.palette) ?? PALETTE_LIST[0];
  return {
    head,
    image: HEAD_IMAGES[head.id][palette.id],
    custom: null,
    eyes,
    ink: palette.colors?.[3] ?? head.ink,
    shell: palette.colors?.[0] ?? head.shell,
  };
}

/** The four colors a look shows, as the studio's slots: a kit palette's, or the character's own for Original. */
export function colorsOf(look: BotkinLook): FourColors {
  const resolved = resolveLook(look);
  if (resolved.custom) return resolved.custom.colors;
  const palette = palettes.get(look.palette) ?? PALETTE_LIST[0];
  return palette.colors ? [...palette.colors] : [...resolved.head.own];
}

/** The same look? Eyes left out are "oval", and colors only count for a custom look. */
export function sameLook(a: BotkinLook, b: BotkinLook): boolean {
  if (a.head !== b.head || a.palette !== b.palette || (a.eyes ?? "oval") !== (b.eyes ?? "oval")) return false;
  if (a.palette !== CUSTOM) return true;
  return !!a.colors && !!b.colors && a.colors.every((color, index) => color.toLowerCase() === b.colors![index]?.toLowerCase());
}

/** A look as the computer saves it: no "oval" eyes, and colors only with "custom". */
export function cleanLook(look: BotkinLook): BotkinLook {
  const clean: BotkinLook = { head: look.head, palette: look.palette };
  if (look.eyes && look.eyes !== "oval") clean.eyes = look.eyes;
  if (look.palette === CUSTOM && look.colors) clean.colors = look.colors.map((color) => color.toLowerCase()) as FourColors;
  return clean;
}

/** Does this look need a computer with "looks-v2" (eyes or its own colors)? */
export const needsLooksV2 = (look: BotkinLook) => (!!look.eyes && look.eyes !== "oval") || look.palette === CUSTOM;

const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
/** A bot without a saved look keeps its original character when new heads join the kit. */
export function defaultLook(botId: string): BotkinLook {
  return { head: originalHeadIds[hash(botId) % originalHeadIds.length], palette: "original" };
}
/** Preserve the supported parts of a look when a template travels to an older computer. */
export function lookForHost(look: BotkinLook, id: string, options: LookOptions): BotkinLook {
  const head = availableHeads(options.capabilities).some((head) => head.id === look.head) ? look.head : defaultLook(id).head;
  if (!options.advanced && needsLooksV2(look)) return { head, palette: look.palette === CUSTOM ? "original" : look.palette };
  return head === look.head ? look : { ...look, head };
}
/**
 * A look at random. Most characters look best in their own colors, so Original comes up half the
 * time. With `advanced` (a computer with "looks-v2") it may also pick eyes and one of the templates.
 */
export function randomLook(options: LookOptions = {}): BotkinLook {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
  const head = pick(availableHeads(options.capabilities)).id;
  if (!options.advanced) return { head, palette: Math.random() < 0.5 ? "original" : pick(PALETTE_LIST).id };
  const eyes = Math.random() < 0.5 ? undefined : pick(EYES.slice(1)).id;
  const roll = Math.random();
  if (roll < 0.4) return { head, palette: "original", ...(eyes && { eyes }) };
  if (roll < 0.7) return { head, palette: pick(PALETTE_LIST.slice(1)).id, ...(eyes && { eyes }) };
  return { head, palette: CUSTOM, colors: [...pick(TEMPLATES).colors], ...(eyes && { eyes }) };
}

type Looked = { id?: string; look?: BotkinLook };
/** A bot's look: the one saved for it, else its stable default. */
export const lookOf = (bot: Looked): BotkinLook => (bot.look && heads.has(bot.look.head) ? bot.look : defaultLook(bot.id ?? ""));
/** A bot's own color, for tinting what belongs to it. For a custom look it is the shell color. */
export const colorOf = (bot: Looked) => resolveLook(lookOf(bot)).shell;
/** Does this character have accent parts? Some have only a shell and a faceplate. */
export const hasAccent = (headId: string) => HEAD_LAYERS[headId]?.accent != null;
/** A character's name, such as "Sprig". */
export const headName = (id: string) => heads.get(id)?.name ?? id;
