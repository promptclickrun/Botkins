#!/usr/bin/env node
// Writes desktop/themes.json: the app's themes, each a full set of colors for light and for dark,
// and the fonts a person can read the app in. The desktop process and the app's page both read
// that file (desktop/preferences.mjs, src/themes.ts).
//
// The themes are the phone app's, value for value (botkins: src/ui/themes.ts): the code between
// the two marks below is that file with its types taken out. "botkins" is the design kit's own
// look (design/botkins-kit/theme/tokens.json), "ink" is black on white and white on black, and the
// others come from a few seed colors through makeTheme, which also keeps every text color
// readable. To follow a change on the phone, copy its file in again between the marks.
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
const toHex = (channels) => "#" + channels.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** `a` moved toward `b` by `amount` (0 to 1). */
export function mix(a, b, amount) {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((c, i) => c + (y[i] - c) * amount));
}

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

/** `color`, darkened or lightened (away from the first background) until it reads on every background. */
function readable(color, backgrounds, min = 4.6) {
  const toward = luminance(backgrounds[0]) > 0.4 ? "#000000" : "#FFFFFF";
  let out = color;
  for (let step = 1; step <= 50 && backgrounds.some((bg) => contrast(out, bg) < min); step++) out = mix(color, toward, step / 50);
  return out;
}

const WHITE = "#FFFFFF";
const BLACK = "#000000";
const rgba = (hex, alpha) => `rgba(${rgb(hex).join(",")},${alpha})`;

// The kit's status hues, shared by every generated theme.
const STATUS = { success: "#41633D", warning: "#865514", danger: "#9F3935", info: "#3B6A5D" };

// ---- The generator ---------------------------------------------------------------------------

/** A full theme, light and dark, from a few seed colors. */
export function makeTheme({ id, name, action, paper, ink: seedInk, tint = 0.05 }) {
  // Light: near-white paper, warmed by the seed, with the seed's darkest color as the ink.
  const canvas = mix(mix(WHITE, paper, 0.5), action, tint);
  const surface = mix(mix(WHITE, paper, 0.15), action, tint * 0.4);
  const ink = mix(seedInk, BLACK, 0.2);
  const primary = readable(mix(action, seedInk, 0.15), [WHITE], 4.8);
  const statusLight = (hue) => {
    const soft = mix(surface, hue, 0.16);
    return { text: readable(hue, [soft, canvas, surface]), soft };
  };
  const [ok, warn, bad, info] = [STATUS.success, STATUS.warning, STATUS.danger, STATUS.info].map(statusLight);
  const accentSoft = mix(surface, action, 0.2);
  const light = {
    canvas,
    surface,
    sunken: mix(canvas, ink, 0.05),
    raised: mix(surface, WHITE, 0.5),
    ink,
    ink2: mix(ink, canvas, 0.15),
    muted: readable(mix(ink, canvas, 0.42), [mix(canvas, ink, 0.05), canvas, surface]),
    faint: mix(ink, canvas, 0.55),
    line: mix(canvas, ink, 0.08),
    lineStrong: mix(canvas, ink, 0.2),
    accent: primary,
    onAccent: WHITE,
    accentSoft,
    accentText: readable(primary, [canvas, surface, accentSoft]),
    primary,
    onPrimary: WHITE,
    success: ok.text,
    successSoft: ok.soft,
    warning: warn.text,
    warningSoft: warn.soft,
    danger: bad.text,
    dangerSoft: bad.soft,
    info: info.text,
    infoSoft: info.soft,
    bubble: mix(canvas, action, 0.14),
    onBubble: ink,
    scrim: rgba(ink, 0.42),
    shadow: ink,
  };

  // Dark: the seed's darkest color as the night, the paper as the ink, a lighter action color.
  const night = mix(mix("#121212", seedInk, 0.45), action, tint);
  const nightSurface = mix(night, mix(WHITE, action, 0.5), 0.06);
  const dInk = mix(WHITE, paper, 0.55);
  const onPrimary = mix(seedInk, BLACK, 0.45);
  const dPrimary = readable(mix(action, WHITE, 0.32), [onPrimary], 4.8);
  const statusDark = (hue) => {
    const soft = mix(nightSurface, hue, 0.22);
    return { text: readable(mix(hue, WHITE, 0.55), [soft, night, nightSurface]), soft };
  };
  const [dOk, dWarn, dBad, dInfo] = [STATUS.success, "#B07A2A", "#C0504A", STATUS.info].map(statusDark);
  const dAccentSoft = mix(nightSurface, action, 0.28);
  const dark = {
    canvas: night,
    surface: nightSurface,
    sunken: mix(night, BLACK, 0.25),
    raised: mix(nightSurface, WHITE, 0.05),
    ink: dInk,
    ink2: mix(dInk, night, 0.1),
    muted: readable(mix(dInk, night, 0.3), [nightSurface, night]),
    faint: mix(dInk, night, 0.55),
    line: mix(night, dInk, 0.1),
    lineStrong: mix(night, dInk, 0.22),
    accent: dPrimary,
    onAccent: onPrimary,
    accentSoft: dAccentSoft,
    accentText: readable(dPrimary, [night, nightSurface, dAccentSoft]),
    primary: dPrimary,
    onPrimary,
    success: dOk.text,
    successSoft: dOk.soft,
    warning: dWarn.text,
    warningSoft: dWarn.soft,
    danger: dBad.text,
    dangerSoft: dBad.soft,
    info: dInfo.text,
    infoSoft: dInfo.soft,
    bubble: mix(nightSurface, action, 0.2),
    onBubble: dInk,
    scrim: "rgba(0,0,0,0.55)",
    shadow: BLACK,
  };
  return { id, name, light, dark };
}

// ---- The themes ------------------------------------------------------------------------------

/** Every theme, in the order the Appearance page shows them. Seeds come from the kit's palettes (customize.js). */
export const THEMES = [
  { id: "botkins", name: "Botkins", light: botkinsLight, dark: botkinsDark },
  makeTheme({ id: "honey", name: "Honey", action: "#DFA12E", paper: "#FFEBC5", ink: "#553819" }),
  makeTheme({ id: "fern", name: "Fern", action: "#748848", paper: "#F4E8C4", ink: "#373722" }),
  makeTheme({ id: "tidepool", name: "Tidepool", action: "#518477", paper: "#F6E7C7", ink: "#303B30" }),
  makeTheme({ id: "bluebell", name: "Bluebell", action: "#738DA4", paper: "#F8E5CF", ink: "#32303C" }),
  makeTheme({ id: "fig", name: "Fig", action: "#946079", paper: "#F7E1CF", ink: "#482D39" }),
  makeTheme({ id: "paper", name: "Paper", action: "#3F5F8F", paper: "#E6E8EC", ink: "#1C1E22", tint: 0 }),
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
