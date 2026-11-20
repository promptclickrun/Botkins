// Color templates for a Botkin and the color math behind the studio's picker.
// No React Native imports, so the tests can run it (tests/looks.test.ts).
//
// A template is four colors: [shell, accent, faceplate, eyes]. The kit's palettes are saved by
// their id; these are saved as a custom look ({ palette: "custom", colors }). Each follows the
// kit's own pattern: a mid-tone shell, an accent that stands apart from it, a pale faceplate and
// dark eyes that read on it.

export type FourColors = [string, string, string, string];
export type LookTemplate = { id: string; name: string; colors: FourColors };

/** The slots a person can change one by one, in the order of `FourColors`. */
export const COLOR_SLOTS = [
  { key: "shell", name: "Shell" },
  { key: "accent", name: "Accent" },
  { key: "face", name: "Face" },
  { key: "eyes", name: "Eyes" },
] as const;

export const TEMPLATES: LookTemplate[] = [
  { id: "midnight", name: "Midnight", colors: ["#3e4f86", "#e0b354", "#e8ecf6", "#151a2e"] },
  { id: "mint", name: "Mint", colors: ["#69bb9b", "#e98a6b", "#effaf1", "#21423a"] },
  { id: "rose", name: "Rose", colors: ["#d97a8c", "#7f9e6a", "#fdeaea", "#4a2430"] },
  { id: "slate", name: "Slate", colors: ["#6c7a89", "#d3a55c", "#eef0f2", "#252b32"] },
  { id: "sunset", name: "Sunset", colors: ["#e8743b", "#8e4f8f", "#ffe8cf", "#3d1f2e"] },
  { id: "lilac", name: "Lilac", colors: ["#a58bc9", "#e7b85a", "#f6eefb", "#352a46"] },
  { id: "ocean", name: "Ocean", colors: ["#2f7fa6", "#f0a64a", "#e6f3f7", "#132f3d"] },
  { id: "ink", name: "Ink", colors: ["#3b3b3b", "#9a9a9a", "#f4f4f4", "#111111"] },
];

/** Swatches the picker offers before a person has picked any colors of their own. */
export const SUGGESTED = ["#c75e35", "#dfa12e", "#748848", "#518477", "#738da4", "#946079", "#3e4f86", "#d97a8c", "#f4f4f4", "#111111"];

const HEX = /^#[0-9a-f]{6}$/;

/** A color as the computer saves it: "#rrggbb", lower case. */
export const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

/** Reads what a person typed ("C75E35", "#c75e35", "#c5e" or "c5e") as "#rrggbb", or null. */
export function parseHex(text: string): string | null {
  const raw = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) return "#" + [...raw].map((char) => char + char).join("");
  if (/^[0-9a-f]{6}$/.test(raw)) return "#" + raw;
  return null;
}

export const isFourColors = (value: unknown): value is FourColors => Array.isArray(value) && value.length === 4 && value.every(isHex);

export type Rgb = [number, number, number];
/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export type Hsv = { h: number; s: number; v: number };

const clamp = (value: number, min: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min);

export function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as Rgb;
}

export function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("");
}

/** HSV to "#rrggbb". Any input gives a valid color: values are clamped and the hue wraps. */
export function hsvToHex({ h, s, v }: Hsv): string {
  "worklet";
  const hue = ((((Number.isFinite(h) ? h : 0) % 360) + 360) % 360) / 60;
  const sat = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
  const val = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = val - chroma;
  const sector = Math.floor(hue) % 6;
  const [r, g, b] = sector === 0 ? [chroma, x, 0] : sector === 1 ? [x, chroma, 0] : sector === 2 ? [0, chroma, x] : sector === 3 ? [0, x, chroma] : sector === 4 ? [x, 0, chroma] : [chroma, 0, x];
  const byte = (unit: number) => {
    const value = Math.round((unit + m) * 255);
    const safe = value < 0 ? 0 : value > 255 ? 255 : value;
    return (safe < 16 ? "0" : "") + safe.toString(16);
  };
  return "#" + byte(r) + byte(g) + byte(b);
}

/**
 * "#rrggbb" to HSV. A gray has no hue of its own and black no saturation, so `keep` (the hue
 * and saturation the picker had) stays where the color can't say.
 */
export function hexToHsv(hex: string, keep?: Partial<Hsv>): Hsv {
  const [r, g, b] = hexToRgb(hex).map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max;
  const s = max === 0 ? (keep?.s ?? 0) : delta / max;
  let h = keep?.h ?? 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h, s, v };
}

/** WCAG relative luminance and contrast, for checking that eyes read on a faceplate. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastOf(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The template these four colors are, if any. */
export function templateOf(colors: readonly string[] | undefined): LookTemplate | undefined {
  if (!colors) return undefined;
  return TEMPLATES.find((template) => template.colors.every((color, index) => color === colors[index]?.toLowerCase()));
}

/** The most recent colors first, without repeats, at most `limit`. */
export function remember(recent: readonly string[], color: string, limit = 8): string[] {
  if (!isHex(color)) return [...recent];
  return [color, ...recent.filter((item) => item !== color)].slice(0, limit);
}
