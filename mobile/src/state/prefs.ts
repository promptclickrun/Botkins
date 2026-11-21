// Choices that belong to this phone, not to the computer: how the app looks and feels.
import { keep, readKept } from "@/state/keep";
import { create } from "zustand";
import { DEFAULT_FONT, FONT_IDS, type FontId } from "@/ui/fonts";
import { DEFAULT_THEME, THEMES } from "@/ui/themes";

const KEY = "botkins.prefs.v1";

export type Prefs = {
  /** Follow the phone, or always light or dark. */
  mode: "system" | "light" | "dark";
  /** The theme used in light mode, and the one used in dark mode (ids from @/ui/themes). */
  lightTheme: string;
  darkTheme: string;
  /** The person picked a theme themselves. Until then the app wears the default one, whatever was saved. */
  themePicked: boolean;
  /** The body text size, 13 to 20. The whole type scale follows it. */
  textSize: number;
  /** The font the app is read in (ids from @/ui/fonts). */
  font: FontId;
  /** The person picked a font themselves. Until then the app wears the default one (the phone's own), whatever was saved. */
  fontPicked: boolean;
  /** The height of buttons, fields, chips and rows. */
  controlSize: "compact" | "regular" | "large";
  haptics: boolean;
  /** Whether Today is open on Home. */
  todayOpen: boolean;
  /** The model providers folded shut in the model picker. */
  foldedProviders: string[];
  /** What the Marketplace tab showed last: apps (Composio) or plugins. */
  marketView: "apps" | "plugins";
  /** Notices shown one time and closed (a plugin the computer switched off): one key for each computer, plugin and place. */
  toldNotices: string[];
};
const defaults: Prefs = { mode: "system", lightTheme: DEFAULT_THEME, darkTheme: DEFAULT_THEME, themePicked: false, textSize: 16, font: DEFAULT_FONT, fontPicked: false, controlSize: "regular", haptics: true, todayOpen: true, foldedProviders: [], marketView: "apps", toldNotices: [] };

export const usePrefs = create<Prefs>(() => defaults);

const MODES: Prefs["mode"][] = ["system", "light", "dark"];
const OLD_DEFAULT = "botkins";
const OLD_DEFAULT_FONT = "botkins";
const CONTROL_SIZES: Prefs["controlSize"][] = ["compact", "regular", "large"];
const isTheme = (id: unknown): id is string => typeof id === "string" && THEMES.some((theme) => theme.id === id);

/** Saved choices, checked one by one; anything unknown falls back to its default. Reads the old `appearance` too. */
function read(saved: Record<string, unknown>): Prefs {
  const mode = saved.mode ?? saved.appearance;
  const size = typeof saved.textSize === "number" && Number.isFinite(saved.textSize) ? Math.round(saved.textSize) : defaults.textSize;
  // A saved theme counts when the person picked it. Before that was recorded, the old default
  // ("botkins") was saved for everyone, so only another theme shows a choice was made.
  const picked = saved.themePicked === true;
  const theme = (id: unknown) => (isTheme(id) && (picked || id !== OLD_DEFAULT) ? id : DEFAULT_THEME);
  return {
    mode: MODES.includes(mode as Prefs["mode"]) ? (mode as Prefs["mode"]) : defaults.mode,
    lightTheme: theme(saved.lightTheme),
    darkTheme: theme(saved.darkTheme),
    themePicked: picked || (isTheme(saved.lightTheme) && saved.lightTheme !== OLD_DEFAULT) || (isTheme(saved.darkTheme) && saved.darkTheme !== OLD_DEFAULT),
    textSize: Math.max(13, Math.min(20, size)),
    // A saved font counts when the person picked it. Before that was recorded, the old default
    // (the kit's pairing) was saved for everyone, so only another font shows a choice was made.
    font: FONT_IDS.includes(saved.font as FontId) && (saved.fontPicked === true || saved.font !== OLD_DEFAULT_FONT) ? (saved.font as FontId) : defaults.font,
    fontPicked: saved.fontPicked === true || (FONT_IDS.includes(saved.font as FontId) && saved.font !== OLD_DEFAULT_FONT),
    controlSize: CONTROL_SIZES.includes(saved.controlSize as Prefs["controlSize"]) ? (saved.controlSize as Prefs["controlSize"]) : defaults.controlSize,
    haptics: typeof saved.haptics === "boolean" ? saved.haptics : defaults.haptics,
    todayOpen: typeof saved.todayOpen === "boolean" ? saved.todayOpen : defaults.todayOpen,
    marketView: saved.marketView === "plugins" ? "plugins" : "apps",
    toldNotices: Array.isArray(saved.toldNotices) ? saved.toldNotices.filter((key): key is string => typeof key === "string" && key.length <= 700).slice(-400) : defaults.toldNotices,
    foldedProviders: Array.isArray(saved.foldedProviders) ? saved.foldedProviders.filter((id): id is string => typeof id === "string" && id.length <= 100).slice(0, 100) : defaults.foldedProviders,
  };
}

export async function loadPrefs() {
  try {
    const saved = await readKept(KEY);
    if (saved) usePrefs.setState(read(JSON.parse(saved) as Record<string, unknown>), true);
  } catch {
    // Unreadable choices fall back to the defaults.
  }
}

export function setPrefs(patch: Partial<Prefs>) {
  usePrefs.setState(patch);
  void keep(KEY, JSON.stringify(usePrefs.getState())).catch(() => {});
}
