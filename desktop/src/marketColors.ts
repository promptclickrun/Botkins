// The colors of the Market's pictures, as plain math (no React Native imports; the same file is in
// desktop/src, and desktop/test/app-icons.test.mjs fails when the two differ): the tile an app's
// brand mark sits on, the letter tile of an app with no mark, and the soft wash behind a bot or a
// featured app. Every color here is worked out from data (a brand's hex, a bot's look, the page's
// own color), never chosen by a screen.

type Rgb = [number, number, number];

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

export function parseHex(hex: string): Rgb {
  const text = hex.replace(/^#/, "");
  const full = text.length === 3 ? [...text].map((digit) => digit + digit).join("") : text;
  const number = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(number)) return [128, 128, 128];
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

export const toHex = ([r, g, b]: Rgb) => "#" + [r, g, b].map((value) => clamp(value).toString(16).padStart(2, "0")).join("");

/** `amount` of `over` on top of `base`, as "#rrggbb". */
export function mix(base: string, over: string, amount: number) {
  const a = parseHex(base);
  const b = parseHex(over);
  return toHex([0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * amount) as Rgb);
}

/** WCAG relative luminance, 0 to 1. */
export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colors, 1 to 21. */
export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

export function hsl(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** A stable number from a name. */
export const hashOf = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

// ---- A brand mark's tile ----

/** At least 3:1 (WCAG 1.4.11, graphics): a mark must read against its tile. */
export const MARK_CONTRAST = 3;
const LIGHT_TILE = "#FFFFFF";
const DARK_TILE = "#17171A";

export type MarkStyle = { tile: string; glyph: string };

/**
 * The tile and glyph color for a brand's mark, the same in light and dark themes: the brand color on
 * a light tile with a breath of the brand in it, or, for a brand too light to read on white (a yellow),
 * the brand color on a dark tile. Whichever side the brand reads on by 3:1 or better.
 */
export function markStyle(hex: string): MarkStyle {
  const brand = "#" + hex.replace(/^#/, "");
  const light = mix(LIGHT_TILE, brand, 0.1);
  if (contrast(brand, light) >= MARK_CONTRAST) return { tile: light, glyph: brand };
  return { tile: mix(DARK_TILE, brand, 0.14), glyph: brand };
}

// ---- A letter tile, for an app with no mark ----

export type LetterStyle = { hue: number; from: string; to: string; letter: string };

/** A rounded gradient tile tinted from a hue hashed from the name, with a letter that reads on it. */
export function letterStyle(name: string, dark: boolean): LetterStyle {
  const hue = hashOf(name.trim().toLowerCase()) % 360;
  return {
    hue,
    from: hsl(hue, dark ? 42 : 80, dark ? 30 : 93),
    to: hsl((hue + 24) % 360, dark ? 46 : 84, dark ? 22 : 84),
    letter: hsl(hue, dark ? 70 : 62, dark ? 84 : 30),
  };
}

/** A brand color for a card's wash: the official one, or the hue hashed from the name. */
export const brandOf = (name: string, official?: string) => (official ? "#" + official.replace(/^#/, "") : hsl(hashOf(name.trim().toLowerCase()) % 360, 62, 52));

// ---- A wash behind a bot or an app ----

/** How much of the color shows in a wash: more at night, when the page is dark and a pale tint would not show. */
const WASH = { light: 0.26, dark: 0.34 } as const;

/** The two stops of a soft diagonal wash over `base`, tinted from one or two colors; reads in light and dark. */
export function wash(colors: [string, string?], base: string, dark: boolean): [string, string] {
  const amount = dark ? WASH.dark : WASH.light;
  return [mix(base, colors[0], amount), mix(base, colors[1] ?? colors[0], amount * 0.7)];
}

/** A flat tint of a brand color over `base`, for a card at low opacity. */
export const tint = (color: string, base: string, dark: boolean) => mix(base, color, dark ? 0.2 : 0.12);
