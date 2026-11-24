// The app's look: its themes, each in light and dark, the fonts a person can read it in, and the
// text sizes. The themes and fonts are in desktop/themes.json (written by scripts/build-themes.mjs),
// the file the desktop process reads too. They are the phone app's, value for value: "botkins" is
// the design kit's own palette, "ink" (what the app wears until a person picks a theme) is black on
// white and white on black, and the others are named after the kit's bot palettes.
import catalog from "../desktop/themes.json";
import type { Appearance, BackdropId } from "./types";

export type { BackdropId };
export type ThemeColors = (typeof catalog.themes)[number]["light"];
export type Theme = { id: string; name: string; light: ThemeColors; dark: ThemeColors; mono?: boolean };
export type Mode = "light" | "dark";

export const DEFAULT_BACKDROP: BackdropId = "clean";
export const BACKDROPS: { id: BackdropId; name: string; description: string }[] = [
  { id: "clean", name: "Clean", description: "Solid theme surface" },
  { id: "mesh", name: "Mesh", description: "Vibrant radial blobs with soft sheen" },
  { id: "botkins", name: "Botkins", description: "Ambient indigo, pink and teal orbs" },
  { id: "grid", name: "Grid", description: "Subtle 28px hairline grid" },
];
export const backdropOf = (id: string | undefined): BackdropId =>
  BACKDROPS.some((b) => b.id === id) ? (id as BackdropId) : DEFAULT_BACKDROP;

export const THEMES: Theme[] = catalog.themes;
export const DEFAULT_THEME = catalog.default;
export const themeOf = (id: string | undefined) => THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME) ?? THEMES[0];

/** Text sizes, as how much larger or smaller every text in the app is drawn. */
export const TEXT_SIZES: { id: Appearance["textSize"]; name: string; scale: number }[] = [
  { id: "small", name: "Small", scale: 0.92 },
  { id: "default", name: "Default", scale: 1 },
  { id: "large", name: "Large", scale: 1.1 },
  { id: "larger", name: "Larger", scale: 1.2 },
];
export const textScale = (id: string | undefined) => TEXT_SIZES.find((size) => size.id === id)?.scale ?? 1;

type FontDef = { id: string; name: string; windowsName?: string; mac?: string; windows?: string };
const FONTS: FontDef[] = catalog.fonts;
/** The system's own face: what the app reads in until the person picks a font. */
export const DEFAULT_FONT = catalog.defaultFont;
/** The design kit's pairing. It ships with the app, so every computer has it. */
export const KIT_FONT = "botkins";
const windows = () => /Windows/i.test(navigator.userAgent);
const familyHere = (font: FontDef | undefined) => font && (windows() ? font.windows : font.mac);
/** The fonts this computer can show, in menu order, with the name to show for each. A face the system lacks isn't offered. */
export function fontsHere(): { id: string; name: string }[] {
  const win = windows();
  return FONTS.filter((font) => font.id === KIT_FONT || familyHere(font)).map((font) => ({ id: font.id, name: (win && font.windowsName) || font.name }));
}
/** The font drawn for a choice: the choice itself, or the system's face when this computer lacks it. */
export function fontShown(id: string | undefined): string {
  return id === KIT_FONT || familyHere(FONTS.find((f) => f.id === id)) ? id! : DEFAULT_FONT;
}
/**
 * The CSS font family for a choice, or null for the design kit's own pairing (serif names and
 * headlines, sans for the rest). Every other choice is one face for everything, headlines too.
 */
export function fontFamilyOf(id: string | undefined): string | null {
  const shown = fontShown(id);
  return shown === KIT_FONT ? null : (familyHere(FONTS.find((f) => f.id === shown)) ?? null);
}

/** The theme light or dark mode wears: dark mode's own theme when the person chose one. */
export const themeFor = (appearance: Pick<Appearance, "colorTheme" | "darkColorTheme">, mode: Mode) => themeOf((mode === "dark" && appearance.darkColorTheme) || appearance.colorTheme);

/** `a` moved toward `b` by `amount` (0 to 1), as #RRGGBB. */
function mix(a: string, b: string, amount: number) {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * amount).toString(16).padStart(2, "0")).join("");
}

/**
 * A theme's colors at a contrast from 0 to 100: lines and quiet text move toward the ink, so
 * borders read more clearly and muted text gets darker (lighter in dark mode). 0 is the theme as drawn.
 */
export function withContrast(colors: ThemeColors, contrast: number): ThemeColors {
  const amount = Math.max(0, Math.min(100, contrast)) / 100;
  if (!amount) return colors;
  const toward = (color: string, most: number) => mix(color, colors.ink, most * amount);
  return { ...colors, line: toward(colors.line, 0.3), lineStrong: toward(colors.lineStrong, 0.35), muted: toward(colors.muted, 0.45), faint: toward(colors.faint, 0.45) };
}

/** Colors that are not custom properties of their own: `shadow` is a color here, and `--shadow` is a whole shadow in the styles. */
const RENAMED: Record<string, string> = { shadow: "--shadow-color" };
const cssName = (key: string) => RENAMED[key] ?? "--" + key.replace(/[A-Z0-9]+/g, (upper) => "-" + upper.toLowerCase());
/** A theme's colors as CSS custom properties: canvas → --canvas, lineStrong → --line-strong, ink2 → --ink-2, accentText → --accent-text. */
export function themeVars(colors: ThemeColors): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([key, value]) => [cssName(key), value]));
}

/** Black or white, whichever reads better on a color the person picked. */
export function inkOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#000" : "#fff";
}
