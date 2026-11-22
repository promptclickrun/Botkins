#!/usr/bin/env node
// Writes desktop/themes.json: the app's themes, each a full set of colors for light and for dark,
// and the fonts a person can read the app in. The desktop process and the app's page both read
// that file (desktop/preferences.mjs, src/themes.ts).
//
// The themes are the phone app's, value for value (botkins: src/ui/themes.ts): the code between
// the two marks below is that file with its types taken out. "botkins" is the design kit's own
// look (design/botkins-kit/theme/tokens.json), "ink" is black on white and white on black, and the
// others come from a hue and an action color through makeTheme, built in OKLCH, which also keeps
// every text color readable. To follow a change on the phone, copy its file in again between the marks.
// test/rename.test.mjs compares the result with the phone's file when that repo is beside this one.
//
//   node scripts/build-themes.mjs          writes the file
//   node scripts/build-themes.mjs --check  fails when the file is out of date
import { readFileSync, writeFileSync } from "node:fs";

// ---- from botkins src/ui/themes.ts ----------------------------------------------------------
// The kit's semantic colors are canvas, surface, ink, muted, action/onAction, border, success,
// attention and error. The rest are steps between them.
const botkinsLight = {
  canvas: "#FBF1DE",
  surface: "#FFF8EA",
  sunken: "#F3E6CD",
  raised: "#FFFBF1",
  ink: "#42291F",
  ink2: "#5A3F31",
  muted: "#705746",
  faint: "#A8917B",
  line: "#E7D8BF",
  lineStrong: "#CFBCA3",
  accent: "#923F26",
  onAccent: "#FFF7E8",
  accentSoft: "#F3D8C3",
  accentText: "#923F26",
  primary: "#923F26",
  onPrimary: "#FFF7E8",
  success: "#41633D",
  successSoft: "#DDE6CB",
  warning: "#865514",
  warningSoft: "#F7E3B9",
  danger: "#9F3935",
  dangerSoft: "#F5D8D0",
  info: "#3B6A5D",
  infoSoft: "#D6E5DB",
  bubble: "#F5DDBD",
  onBubble: "#42291F",
  scrim: "rgba(66,41,31,0.42)",
  shadow: "#5A3A22",
};

const botkinsDark = {
  canvas: "#251E1A",
  surface: "#332820",
  sunken: "#1E1814",
  raised: "#3F3229",
  ink: "#FFF0D6",
  ink2: "#EBD9BF",
  muted: "#D3BDA3",
  faint: "#8F7A69",
  line: "#47382E",
  lineStrong: "#695447",
  accent: "#EF9E78",
  onAccent: "#392117",
  accentSoft: "#55342A",
  accentText: "#EF9E78",
  primary: "#EF9E78",
  onPrimary: "#392117",
  success: "#AEC99A",
  successSoft: "#2F3A28",
  warning: "#EDC16F",
  warningSoft: "#463721",
  danger: "#FFAB9D",
  dangerSoft: "#532B27",
  info: "#9CC5B8",
  infoSoft: "#26382F",
  bubble: "#4B3629",
  onBubble: "#FFF0D6",
  scrim: "rgba(0,0,0,0.55)",
  shadow: "#000000",
};

// Ink: black on white and white on black, with nothing between but grays. The action color is
// the ink itself, so the only color on a page is the Botkins and what a status has to say.
const inkLight = {
  canvas: "#FFFFFF",
  surface: "#F5F5F3",
  sunken: "#EDEDEA",
  raised: "#FFFFFF",
  ink: "#000000",
  ink2: "#1F1F1F",
  muted: "#595959",
  faint: "#9A9A98",
  line: "#E7E7E4",
  lineStrong: "#C8C8C4",
  accent: "#000000",
  onAccent: "#FFFFFF",
  accentSoft: "#E6E6E3",
  accentText: "#000000",
  primary: "#000000",
  onPrimary: "#FFFFFF",
  success: "#225C36",
  successSoft: "#E3EEE5",
  warning: "#7A5200",
  warningSoft: "#F5ECD6",
  danger: "#9B231C",
  dangerSoft: "#F7E1DE",
  info: "#27536F",
  infoSoft: "#E0EAF0",
  bubble: "#EDEDEA",
  onBubble: "#000000",
  scrim: "rgba(0,0,0,0.42)",
  shadow: "#000000",
};

const inkDark = {
  canvas: "#000000",
  surface: "#131313",
  sunken: "#1A1A1A",
  raised: "#1E1E1E",
  ink: "#FFFFFF",
  ink2: "#E8E8E8",
  muted: "#A8A8A8",
  faint: "#6E6E6E",
  line: "#242424",
  lineStrong: "#3D3D3D",
  accent: "#FFFFFF",
  onAccent: "#000000",
  accentSoft: "#2B2B2B",
  accentText: "#FFFFFF",
  primary: "#FFFFFF",
  onPrimary: "#000000",
  success: "#93D6A8",
  successSoft: "#12281A",
  warning: "#E9C46A",
  warningSoft: "#2B2412",
  danger: "#FF9E94",
  dangerSoft: "#351715",
  info: "#9FCBE6",
  infoSoft: "#12232F",
  bubble: "#262626",
  onBubble: "#FFFFFF",
  scrim: "rgba(0,0,0,0.6)",
  shadow: "#000000",
};

/** `mono`: the theme has no color of its own, so icon tiles are drawn in ink instead of the kit's colors. */

// ---- Color math ------------------------------------------------------------------------------

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** WCAG relative luminance of a #RRGGBB color. */
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #RRGGBB colors, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear sRGB channels of an OKLCH color (lightness 0 to 1, chroma, hue in degrees); outside 0 to 1 when out of gamut. */
function oklchToLinear(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
}

/** An OKLCH color as #RRGGBB, its chroma lowered until the screen can show it. */
function oklch(l, c, h) {
  let chroma = c;
  let channels = oklchToLinear(l, chroma, h);
  while (chroma > 0 && channels.some((v) => v < -0.0005 || v > 1.0005)) {
    chroma = Math.max(0, chroma - 0.002);
    channels = oklchToLinear(l, chroma, h);
  }
  const encode = (v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return "#" + channels.map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** The OKLCH color made darker (step < 0) or lighter (step > 0) until it reads on every background. */
function readable(l, c, h, backgrounds, min, step) {
  let lightness = l;
  let out = oklch(lightness, c, h);
  while (backgrounds.some((bg) => contrast(out, bg) < min) && lightness > 0.02 && lightness < 0.99) {
    lightness += step;
    out = oklch(lightness, c, h);
  }
  return out;
}

const rgba = (hex, alpha) => `rgba(${rgb(hex).join(",")},${alpha})`;

// Status hues, shared by every generated theme: clear, and never louder than the action color.
const STATUS = { success: 150, warning: 70, danger: 27, info: 235 };

// ---- The generator ---------------------------------------------------------------------------

/**
 * A full theme, light and dark, from a hue and an action color, built in OKLCH: every neutral
 * leans toward the hue, the side menu is a step deeper than the page, and the dark mode is its
 * own tinted night. Text colors are moved until they read (4.6:1, the tests ask 4.5).
 */
export function makeTheme({ id, name, hue, action, tint = 0.011, night = 0.026, bubble = 0.26, dusk = 0.225 }) {
  const { hue: aH, chroma: aC } = action;
  const ink = 0.016; // the text's own share of the hue

  // Light: a near-white page with the hue in it, and the menu a step deeper.
  const canvas = oklch(0.975, tint, hue);
  const sunken = oklch(0.945, tint * 1.5, hue);
  const surface = oklch(0.995, tint * 0.45, hue);
  const lightInk = oklch(0.235, ink, hue);
  const onLight = (l, c, h, extra = []) => readable(l, c, h, [canvas, sunken, surface, ...extra], 4.6, -0.005);
  const accentSoft = oklch(0.935, aC * 0.24, aH);
  const whiteReads = contrast(oklch(action.light, aC, aH), "#FFFFFF") >= 4.5;
  const onPrimary = whiteReads ? "#FFFFFF" : oklch(0.22, aC * 0.35, aH);
  const primary = readable(action.light, aC, aH, [onPrimary], 4.6, whiteReads ? -0.005 : 0.005);
  const status = (make) =>
    Object.fromEntries(Object.keys(STATUS).flatMap((key) => {
      const [text, soft] = make(STATUS[key]);
      return [[key, text], [key + "Soft", soft]];
    }));
  const light = {
    canvas,
    surface,
    sunken,
    raised: oklch(1, tint * 0.15, hue),
    ink: lightInk,
    ink2: oklch(0.335, ink * 0.9, hue),
    muted: onLight(0.53, Math.max(tint * 2.2, ink * 0.8), hue),
    faint: oklch(0.7, tint * 1.6, hue),
    line: oklch(0.912, tint * 1.6, hue),
    lineStrong: oklch(0.84, tint * 1.8, hue),
    accent: primary,
    onAccent: onPrimary,
    accentSoft,
    accentText: onLight(action.light, aC, aH, [accentSoft]),
    primary,
    onPrimary,
    ...status((h) => {
      const soft = oklch(0.945, 0.035, h);
      return [onLight(0.5, 0.13, h, [soft]), soft];
    }),
    bubble: oklch(0.93, aC * bubble, aH),
    onBubble: lightInk,
    scrim: rgba(lightInk, 0.42),
    shadow: lightInk,
  };

  // Dark: a night in the theme's own hue, with a brighter action color on deep text.
  const dCanvas = oklch(dusk, night, hue);
  const dSunken = oklch(dusk - 0.028, night * 1.05, hue);
  const dSurface = oklch(dusk + 0.036, night * 0.95, hue);
  const darkInk = oklch(0.955, Math.min(0.014, ink * 0.35 + tint * 0.5), hue);
  const onDark = (l, c, h, extra = []) => readable(l, c, h, [dCanvas, dSunken, dSurface, ...extra], 4.6, 0.005);
  const dOnPrimary = oklch(0.19, aC * 0.3, aH);
  const dPrimary = readable(action.dark, aC * 0.92, aH, [dOnPrimary], 4.8, 0.005);
  const dAccentSoft = oklch(0.3, aC * 0.32, aH);
  const dark = {
    canvas: dCanvas,
    surface: dSurface,
    sunken: dSunken,
    raised: oklch(dusk + 0.072, night * 0.9, hue),
    ink: darkInk,
    ink2: oklch(0.87, Math.min(0.016, ink * 0.4 + night * 0.4), hue),
    muted: onDark(0.71, Math.max(night * 1.1, ink * 0.4), hue),
    faint: oklch(0.53, night * 1.1, hue),
    line: oklch(dusk + 0.1, night * 1.05, hue),
    lineStrong: oklch(dusk + 0.19, night * 1.1, hue),
    accent: dPrimary,
    onAccent: dOnPrimary,
    accentSoft: dAccentSoft,
    accentText: onDark(action.dark, aC * 0.92, aH, [dAccentSoft]),
    primary: dPrimary,
    onPrimary: dOnPrimary,
    ...status((h) => {
      const soft = oklch(0.28, 0.045, h);
      return [onDark(0.78, 0.11, h, [soft]), soft];
    }),
    bubble: oklch(dusk + 0.13, aC * (bubble + 0.08), aH),
    onBubble: darkInk,
    scrim: "rgba(0,0,0,0.55)",
    shadow: "#000000",
  };
  return { id, name, light, dark };
}

// ---- The themes ------------------------------------------------------------------------------

/** Every theme, in the order the Appearance page shows them. Names come from the kit's palettes (customize.js). */
export const THEMES = [
  { id: "botkins", name: "Botkins", light: botkinsLight, dark: botkinsDark },
  makeTheme({ id: "honey", name: "Honey", hue: 80, action: { hue: 70, chroma: 0.15, light: 0.62, dark: 0.8 } }),
  makeTheme({ id: "fern", name: "Fern", hue: 135, action: { hue: 138, chroma: 0.14, light: 0.52, dark: 0.78 } }),
  makeTheme({ id: "tidepool", name: "Tidepool", hue: 190, action: { hue: 188, chroma: 0.1, light: 0.52, dark: 0.78 } }),
  makeTheme({ id: "bluebell", name: "Bluebell", hue: 255, action: { hue: 255, chroma: 0.15, light: 0.52, dark: 0.76 } }),
  makeTheme({ id: "fig", name: "Fig", hue: 340, action: { hue: 345, chroma: 0.15, light: 0.5, dark: 0.74 } }),
  // Paper: hardly any hue, a cool white by day and a blue-black at night.
  makeTheme({ id: "paper", name: "Paper", hue: 250, action: { hue: 258, chroma: 0.17, light: 0.5, dark: 0.74 }, tint: 0.004, night: 0.01, bubble: 0.14, dusk: 0.19 }),
  { id: "ink", name: "Ink", light: inkLight, dark: inkDark, mono: true },
];

/** What the app wears until the person picks a theme of their own. */
export const DEFAULT_THEME = "ink";

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME) ?? THEMES[0];
}

// ---- end of botkins src/ui/themes.ts ---------------------------------------------------------

// The fonts, as on the phone (botkins: src/ui/fonts.ts). "botkins" is the design kit's pairing:
// DejaVu Serif Bold for names and headlines, Open Sans for the rest. Every other choice is one
// face used for everything, headlines too; code is always set in a fixed-width face. Lora ships
// with the app. The others belong to the computer, so a choice is offered only where the system
// has the face: `mac` and `windows` are the CSS font families to ask each for. The app reads in
// the system's own face (San Francisco on a Mac, Segoe UI on Windows) until the person picks one.
export const DEFAULT_FONT = "system";
export const FONTS = [
  { id: "system", name: "San Francisco", windowsName: "Segoe UI", mac: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif', windows: '"Segoe UI", system-ui, sans-serif' },
  { id: "botkins", name: "Botkins" },
  { id: "rounded", name: "SF Rounded", mac: 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif' },
  { id: "avenir", name: "Avenir Next", mac: '"Avenir Next", -apple-system, sans-serif' },
  // "Botkins Georgia" is Georgia with its medium weights drawn regular (src/tokens.css): the face has no medium of its own.
  { id: "georgia", name: "Georgia", mac: '"Botkins Georgia", Georgia, serif', windows: '"Botkins Georgia", Georgia, serif' },
  { id: "lora", name: "Lora", mac: 'Lora, Georgia, serif', windows: 'Lora, Georgia, serif' },
  { id: "mono", name: "SF Mono", windowsName: "Cascadia Mono", mac: 'ui-monospace, "SF Mono", Menlo, monospace', windows: '"Cascadia Mono", Consolas, monospace' },
];

const file = new URL("../desktop/themes.json", import.meta.url);
const text = JSON.stringify({ default: DEFAULT_THEME, themes: THEMES, defaultFont: DEFAULT_FONT, fonts: FONTS }, null, 2) + "\n";
// Only when run as a script: a test imports this file for its lists.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]scripts[\\/]/, "scripts/"))) {
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== text) {
      console.error("desktop/themes.json is out of date. Run: node scripts/build-themes.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(file, text);
    console.log(THEMES.length + " themes and " + FONTS.length + " fonts written to desktop/themes.json");
  }
}
