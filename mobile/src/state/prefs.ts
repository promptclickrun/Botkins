// Choices that belong to this phone, not to the computer: how the app looks and feels.
import { keep, readKept } from "@/state/keep";
import { create } from "zustand";
import { type BackdropId, DEFAULT_BACKDROP, isBackdrop } from "@/ui/backdrops";
import { DEFAULT_FONT, FONT_IDS, type FontId } from "@/ui/fonts";
import { DEFAULT_THEME, THEMES } from "@/ui/themes";
import { DEFAULT_AVATAR_ANIMATIONS, readAvatarAnimations } from "./avatarPrefs";
import { barFromOrder, barOf, type PinId, USUAL_BAR } from "./tabs";

const KEY = "botkins.prefs.v1";

export type Prefs = {
  /** Follow the phone, or always light or dark. */
  mode: "system" | "light" | "dark";
  /** The theme used in light mode, and the one used in dark mode (ids from @/ui/themes). */
  lightTheme: string;
  darkTheme: string;
  /** The person picked a theme themselves. Until then the app wears the default one, whatever was saved. */
  themePicked: boolean;
  /** The backdrop behind screens so Liquid Glass surfaces refract color or texture. */
  backdrop: BackdropId;
  /** The body text size, 13 to 20. The whole type scale follows it. */
  textSize: number;
  /** The font the app is read in (ids from @/ui/fonts). */
  font: FontId;
  /** The person picked a font themselves. Until then the app wears the default one (the phone's own), whatever was saved. */
  fontPicked: boolean;
  /** The height of buttons, fields, chips and rows. */
  controlSize: "compact" | "regular" | "large";
  haptics: boolean;
  /** Motion for bot avatars on this phone. Missing in older saved choices means off. */
  avatarAnimations: boolean;
  /** Whether Today is open on Home. */
  todayOpen: boolean;
  /** The model providers folded shut in the model picker. */
  foldedProviders: string[];
  /** What the Marketplace tab showed last: apps (Composio) or plugins. */
  /** Notices shown one time and closed (a plugin the computer switched off): one key for each computer, plugin and place. */
  toldNotices: string[];
  /** The tabs a person keeps on the bar between their bot and All, in order (All, and Settings › Tabs). Three at most. */
  bar: PinId[];
  /** The order of All's tiles, by a place's id. A place it doesn't name follows in the usual order. */
  allOrder: string[];
  /** The tiles a person put under Hidden in All. */
  allHidden: string[];
  /** The bot the first tab shows: the one the person was last with there. None, or one that is gone: the primary bot. */
  homeBot: string | null;
  /** The spaces whose panels show open on the space's page. Every other space shows them as cards. */
  openSpaces: string[];
  /** The panels pinned to Home, in the order they were pinned. A panel of another computer is kept and not shown. */
  homePanels: PanelPin[];
  computerOrder: string[];
  primaryHost: string | null;
  /** The order of the chips over the Chats list ("all", "unread", "running", "section:<id>"). The first opens when Chats does. Empty: the usual order. */
  chatChipOrder: string[];
  /** Operate bots from all connected computers together in one unified view. */
  unifiedHosts: boolean;
  /** Paired computer serverIds opted out of unified mode. */
  excludedUnifiedHosts: string[];
  /** Target computer for host-scoped settings while unified mode is active. */
  settingsHost: string | null;
};
export type PanelPin = { spaceId: string; panelId: string };
const defaults: Prefs = { mode: "system", lightTheme: DEFAULT_THEME, darkTheme: DEFAULT_THEME, themePicked: false, backdrop: DEFAULT_BACKDROP, textSize: 16, font: DEFAULT_FONT, fontPicked: false, controlSize: "regular", haptics: true, avatarAnimations: DEFAULT_AVATAR_ANIMATIONS, todayOpen: true, foldedProviders: [], toldNotices: [], bar: USUAL_BAR, allOrder: [], allHidden: [], homeBot: null, openSpaces: [], homePanels: [], computerOrder: [], primaryHost: null, chatChipOrder: [], unifiedHosts: false, excludedUnifiedHosts: [], settingsHost: null };

export const usePrefs = create<Prefs>(() => defaults);

const MODES: Prefs["mode"][] = ["system", "light", "dark"];
const OLD_DEFAULT = "botkins";
const OLD_DEFAULT_FONT = "botkins";
const CONTROL_SIZES: Prefs["controlSize"][] = ["compact", "regular", "large"];
const isId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100;
const ids = (saved: unknown) => (Array.isArray(saved) ? saved.filter(isId).slice(0, 200) : []);
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
    backdrop: isBackdrop(saved.backdrop) ? saved.backdrop : defaults.backdrop,
    textSize: Math.max(13, Math.min(20, size)),
    // A saved font counts when the person picked it. Before that was recorded, the old default
    // (the kit's pairing) was saved for everyone, so only another font shows a choice was made.
    font: FONT_IDS.includes(saved.font as FontId) && (saved.fontPicked === true || saved.font !== OLD_DEFAULT_FONT) ? (saved.font as FontId) : defaults.font,
    fontPicked: saved.fontPicked === true || (FONT_IDS.includes(saved.font as FontId) && saved.font !== OLD_DEFAULT_FONT),
    controlSize: CONTROL_SIZES.includes(saved.controlSize as Prefs["controlSize"]) ? (saved.controlSize as Prefs["controlSize"]) : defaults.controlSize,
    haptics: typeof saved.haptics === "boolean" ? saved.haptics : defaults.haptics,
    avatarAnimations: readAvatarAnimations(saved.avatarAnimations),
    todayOpen: typeof saved.todayOpen === "boolean" ? saved.todayOpen : defaults.todayOpen,
    toldNotices: Array.isArray(saved.toldNotices) ? saved.toldNotices.filter((key): key is string => typeof key === "string" && key.length <= 700).slice(-400) : defaults.toldNotices,
    // A phone from before the bar could be changed saved the order of its five tabs.
    bar: Array.isArray(saved.bar) ? barOf(saved.bar) : barFromOrder(saved.tabOrder),
    allOrder: ids(saved.allOrder).slice(0, 60),
    allHidden: ids(saved.allHidden).slice(0, 60),
    homeBot: isId(saved.homeBot) ? saved.homeBot : null,
    openSpaces: ids(saved.openSpaces),
    computerOrder: ids(saved.computerOrder),
    chatChipOrder: ids(saved.chatChipOrder),
    primaryHost: isId(saved.primaryHost) ? saved.primaryHost : null,
    unifiedHosts: saved.unifiedHosts === true,
    excludedUnifiedHosts: ids(saved.excludedUnifiedHosts),
    settingsHost: isId(saved.settingsHost) ? saved.settingsHost : null,
    homePanels: Array.isArray(saved.homePanels) ? saved.homePanels.filter((pin): pin is PanelPin => !!pin && isId((pin as PanelPin).spaceId) && isId((pin as PanelPin).panelId)).map(({ spaceId, panelId }) => ({ spaceId, panelId })).slice(0, 24) : defaults.homePanels,
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

let pendingWrite = Promise.resolve();
export function setPrefs(patch: Partial<Prefs>) {
  usePrefs.setState(patch);
  const snapshot = JSON.stringify(usePrefs.getState());
  pendingWrite = pendingWrite.then(() => keep(KEY, snapshot)).catch(() => {});
}
