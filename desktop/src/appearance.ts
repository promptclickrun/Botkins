// Puts the chosen appearance on the page: the colors of the theme the mode wears (at the chosen
// contrast) as CSS custom properties on <html>, `data-mode` (light or dark), `data-theme` (the
// theme's id), the font and the text size.
// The last appearance is remembered in this window's storage, so the next launch draws in the
// right colors before the workspace has answered.
import { DEFAULT_FONT, DEFAULT_THEME, fontFamilyOf, fontShown, inkOn, type Mode, textScale, themeFor, themeVars, withContrast } from "./themes";
import type { Appearance } from "./types";

const KEY = "botkins.appearance";
/** Fired on `window` when light or dark changes, for anything drawn outside CSS. */
export const APPEARANCE_EVENT = "botkins-appearance";
const system = matchMedia("(prefers-color-scheme: dark)");

type Chosen = Pick<Appearance, "theme" | "colorTheme" | "darkColorTheme" | "contrast" | "textSize" | "font" | "bubble">;
const usual: Chosen = { theme: "system", colorTheme: DEFAULT_THEME, darkColorTheme: null, contrast: 0, textSize: "default", font: DEFAULT_FONT, bubble: "theme" };
let current: Chosen = usual;

export const modeOf = (choice: Appearance["theme"]): Mode => (choice === "system" ? (system.matches ? "dark" : "light") : choice);

function draw() {
  const root = document.documentElement;
  const mode = modeOf(current.theme);
  const theme = themeFor(current, mode);
  for (const [name, value] of Object.entries(themeVars(withContrast(theme[mode], current.contrast)))) root.style.setProperty(name, value);
  root.style.setProperty("--text-scale", String(textScale(current.textSize)));
  // One face for everything, headlines too; or, with no family, the design kit's own pairing from the styles.
  const family = fontFamilyOf(current.font);
  for (const name of ["--font-body", "--font-display"]) family ? root.style.setProperty(name, family) : root.style.removeProperty(name);
  root.dataset.font = fontShown(current.font);
  if (current.bubble === "theme") {
    root.style.removeProperty("--bubble-color");
    root.style.removeProperty("--bubble-ink");
  } else {
    root.style.setProperty("--bubble-color", current.bubble);
    root.style.setProperty("--bubble-ink", inkOn(current.bubble));
  }
  root.dataset.theme = theme.id;
  if (root.dataset.mode !== mode) {
    root.dataset.mode = mode;
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
  }
}

/** Applies an appearance and remembers it for the next launch. */
export function applyAppearance(appearance: Chosen) {
  const { theme, colorTheme, darkColorTheme = null, contrast = 0, textSize, font, bubble } = appearance;
  current = { theme, colorTheme, darkColorTheme, contrast, textSize, font, bubble };
  draw();
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage can be full or off; the appearance still applies.
  }
}

/** Draws a contrast while its slider moves, without saving it; the saved appearance comes back with the next apply. */
export function previewContrast(contrast: number) {
  current = { ...current, contrast };
  draw();
}

/** Draws the remembered appearance at once, and follows the system between light and dark. */
export function startAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") current = { ...usual, ...saved };
  } catch {
    // Unreadable: the usual look.
  }
  draw();
  system.addEventListener("change", draw);
}
