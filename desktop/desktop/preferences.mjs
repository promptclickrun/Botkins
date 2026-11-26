import { readFileSync } from "node:fs";
import { backgroundField } from "./startup.mjs";
import { DEFAULT_HARNESS, HARNESSES } from "./harness/index.mjs";
import { AUTO_SUMMARIZE_DEFAULT, autoSummarizeField } from "./summaries.mjs";
import { defaultProactive, proactiveField } from "./proactive-settings.mjs";
import { taskLimitField } from "./task-limits.mjs";

// The app's themes, each in light and dark, and the fonts a person can read it in
// (desktop/themes.json, written by scripts/build-themes.mjs; the same as the phone app's). The
// app's page reads the same file (src/themes.ts).
export const THEMES = JSON.parse(readFileSync(new URL("./themes.json", import.meta.url), "utf8"));
export const THEME_IDS = THEMES.themes.map((theme) => theme.id);
/** What the app wears until the person picks a theme of their own: Ink. */
export const DEFAULT_THEME = THEMES.default;
export const FONT_IDS = THEMES.fonts.map((font) => font.id);
export const DEFAULT_FONT = THEMES.defaultFont;
export const TEXT_SIZES = ["small", "default", "large", "larger"];
export const BACKDROPS = ["clean", "mesh", "botkins", "grid"];
export const DEFAULT_BACKDROP = "clean";
// The theme everyone had before Ink became the usual one. It was saved for everyone, picked or
// not, so by itself it doesn't show that a person chose it.
const OLD_DEFAULT = "botkins";
// The font everyone had before the system's own face became the usual one. It was saved for
// everyone too, so without `fontPicked` it doesn't show that a person chose it.
const OLD_DEFAULT_FONT = "botkins";
// Background presets from before themes, by the theme nearest to each. The usual ones (cream,
// charcoal) were nobody's choice, so they name no theme.
const LIGHT_BACKGROUNDS = { cream: null, paper: "paper", sage: "fern" };
const DARK_BACKGROUNDS = { charcoal: null, midnight: "bluebell", forest: "fern" };

/**
 * A saved appearance made whole.
 *
 * The theme is the one the person picked, and Ink until they pick one, as on the phone. A pick is
 * recorded in `themePicked`. An appearance saved before that was recorded counts as a pick when
 * it names a theme other than the old usual one, or (before themes) a background preset other
 * than the usual: the light preset decides, else the dark one. The old preset names stay in the
 * file, where an earlier version still reads them.
 */
export function appearanceField(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const appearance = { ...defaultSettings.appearance, ...value };
  if (!["system", "light", "dark"].includes(appearance.theme)) appearance.theme = "system";
  if (!Object.hasOwn(LIGHT_BACKGROUNDS, appearance.lightBackground)) appearance.lightBackground = "cream";
  if (!Object.hasOwn(DARK_BACKGROUNDS, appearance.darkBackground)) appearance.darkBackground = "charcoal";
  const named = THEME_IDS.includes(value.colorTheme) ? value.colorTheme : null;
  const preset = LIGHT_BACKGROUNDS[appearance.lightBackground] ?? DARK_BACKGROUNDS[appearance.darkBackground] ?? null;
  // Said outright (true or false), `themePicked` decides. Only a file from before it was kept is read for signs of a pick.
  const picked = value.themePicked === true ? (named ?? preset) : value.themePicked === false ? null : named ? (named !== OLD_DEFAULT ? named : null) : preset;
  appearance.colorTheme = picked ?? DEFAULT_THEME;
  appearance.themePicked = picked != null;
  // A theme for dark mode only, or null for the one theme in both.
  appearance.darkColorTheme = THEME_IDS.includes(value.darkColorTheme) ? value.darkColorTheme : null;
  if (!isContrast(appearance.contrast)) appearance.contrast = 0;
  if (!TEXT_SIZES.includes(appearance.textSize)) appearance.textSize = "default";
  if (!BACKDROPS.includes(appearance.backdrop)) appearance.backdrop = DEFAULT_BACKDROP;
  // The font works the same way, in `fontPicked`: the system's face until the person picks one.
  // Before that was kept, any saved font but the old usual one counts as a pick.
  const font = FONT_IDS.includes(value.font) ? value.font : null;
  const fontPick = font && (value.fontPicked === true || (font !== OLD_DEFAULT_FONT && !(value.fontPicked === false && font === DEFAULT_FONT))) ? font : null;
  appearance.font = fontPick ?? DEFAULT_FONT;
  appearance.fontPicked = fontPick != null;
  if (!(appearance.bubble === "theme" || /^#[0-9a-f]{6}$/i.test(appearance.bubble))) appearance.bubble = "theme";
  if (typeof appearance.avatarAnimations !== "boolean") appearance.avatarAnimations = true;
  return appearance;
}

/** How much stronger lines and quiet text are drawn: a whole number from 0 (as the theme draws them) to 100. */
const isContrast = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

/** The window's color before its page has drawn: the canvas of the theme light or dark mode wears. */
export function canvasColor(appearance, dark) {
  const id = (dark && appearance?.darkColorTheme) || appearance?.colorTheme;
  const theme = THEMES.themes.find((t) => t.id === id) ?? THEMES.themes.find((t) => t.id === DEFAULT_THEME);
  return theme[dark ? "dark" : "light"].canvas;
}

/** The places in the side menu, in their usual order. The person can rearrange them (Settings › Side menu). Projects are a tab of Work, so an order saved with them loses that name. The Market (apps, bots and skills to add) is last. */
export const SIDEBAR = ["Home", "Today", "Chats", "Work", "Wiki", "Market"];
/** The usual side menu shows icons only; a person opens it with its button, the shortcut or Settings › Side menu. */
const ICONS_ONLY = true;
/**
 * A side menu setting made whole: every known place once, in the given order (places it doesn't
 * name keep their usual position after the named ones), and whether the menu is collapsed to icons.
 * `picked` says the person chose open or collapsed themselves. Without it the menu is the usual
 * one: a menu saved open before the choice was recorded was only the usual menu of its day.
 */
export function sidebarField(value, current = { order: SIDEBAR, collapsed: ICONS_ONLY }) {
  value ??= {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid side menu setting");
  let order = current.order;
  if (value.order !== undefined) {
    if (!Array.isArray(value.order) || value.order.length > 50 || value.order.some((item) => typeof item !== "string")) throw new Error("Invalid side menu order");
    order = value.order;
  }
  if (value.collapsed !== undefined && typeof value.collapsed !== "boolean") throw new Error("Choose whether the side menu is collapsed");
  if (value.picked !== undefined && typeof value.picked !== "boolean") throw new Error("Invalid side menu setting");
  const picked = value.picked ?? current.picked === true;
  const named = [...new Set(order.filter((item) => SIDEBAR.includes(item)))];
  return {
    order: [...named, ...SIDEBAR.filter((item) => !named.includes(item))],
    collapsed: picked ? (value.collapsed ?? !!current.collapsed) : ICONS_ONLY,
    ...(picked ? { picked: true } : {}),
  };
}

/** The saved model provider switches made whole: { [id]: { enabled } }, and nothing else. */
export function providersField(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, entry] of Object.entries(value))
    if (/^[\w.-]{1,60}$/.test(id) && typeof entry?.enabled === "boolean") out[id] = { enabled: entry.enabled };
  return out;
}

export const defaultSettings = {
  model: { model: "auto" },
  appearance: {
    // System, light or dark.
    theme: "system",
    // One of the themes in desktop/themes.json: Ink until the person picks one (themePicked).
    colorTheme: "ink",
    themePicked: false,
    // A theme dark mode wears instead of colorTheme, or null for one theme in both.
    darkColorTheme: null,
    // Stronger lines and quiet text, 0 to 100 (src/themes.ts withContrast).
    contrast: 0,
    textSize: "default",
    // Selectable backdrop behind the glass UI: "clean" keeps the solid theme surface.
    backdrop: "clean",
    // One of the fonts in desktop/themes.json: the system's face until the person picks one
    // (fontPicked). "botkins" is the design kit's pairing.
    font: "system",
    fontPicked: false,
    bubble: "theme",
    // Large avatars draw a still pose while idle; active and outcome states can move.
    avatarAnimations: true,
    // Background presets from before themes. Kept as saved, for an earlier version to read.
    lightBackground: "cream",
    darkBackground: "charcoal",
  },
  foldTools: true,
  showThinking: true,
  foldThinking: true,
  showUpdates: true,
  // Off until the person turns it on: a preview fetches the linked page from this computer.
  linkPreviews: false,
  readAloud: false,
  // Off by default: routine-owned chats stay out of the chat list unless shown.
  showRoutineChats: false,
  // Set once the person finishes the welcome screen (desktop/main.mjs never sets it on its own).
  onboarded: false,
  approval: "ask",
  // Agent access to projects (desktop/access.mjs). On by default so existing setups keep working.
  access: { allBots: true },
  // Bots may ask each other for help from a chat (desktop/teamwork.mjs).
  teamwork: true,
  // Ask providers that support it to keep a chat's prompt cache for about an hour, not five minutes (Pi and OMP: PI_CACHE_RETENTION=long).
  longPromptCache: true,
  // Turns between a chat's summaries into a new title: 5 to 30, or 0 for off (desktop/summaries.mjs).
  autoSummarize: AUTO_SUMMARIZE_DEFAULT,
  sidebar: { order: [...SIDEBAR], collapsed: ICONS_ONLY },
  // iMessage and Mail as bot tools, on a Mac only: "off", "read" or "interact" each (desktop/mactools.mjs).
  // Changed only by the app's own window (setMacTool), never by a phone.
  macTools: { imessage: "off", mail: "off" },
  // What runs a turn around the model (desktop/harness): "pi" (the default), "provider" (each
  // provider's own tool), "copilot" (one harness for every plan) or "omp".
  harness: DEFAULT_HARNESS,
  // Staying on (desktop/startup.mjs): keep running when the window is closed, and start with the computer.
  background: backgroundField(),
  // Model providers the person switched on or off: { [id]: { enabled } }. A provider that isn't
  // named here is on or off as it comes (desktop/providers). Changed with Workspace.setProviderEnabled.
  providers: {},
  // The Proactive agent: the computer's switch, and each proactive bot's own settings (desktop/proactive.mjs). Off until the owner turns it on.
  proactive: defaultProactive,
  clarify: ["missing"],
  clarificationInstructions: "",
  notifications: {
    replies: true,
    routines: true,
    requests: true,
    // One plain nudge when something is left waiting on a person (desktop/reminders.mjs). No model.
    reminders: true,
    quietHours: { enabled: false, from: "22:00", to: "07:00" },
  },
};

export const clarificationPrompts = {
  missing:
    "When a required detail is missing or a request has multiple materially different interpretations, ask the user to clarify.",
  choices:
    "Ask the user to choose when a significant design or implementation tradeoff depends on their preference.",
  changes: "Ask before making a consequential or difficult-to-reverse change.",
};

export function clarificationMessage(settings) {
  const lines = settings.clarify
    .map((key) => clarificationPrompts[key])
    .filter(Boolean);
  if (settings.clarificationInstructions)
    lines.push(settings.clarificationInstructions);
  return lines.length
    ? // Said without naming one program's tool: the Copilot runtime has ask_user, Claude Code and Codex have their own.
      "\nAsk the person a question, with your tool for asking them (ask_user where you have it), in these situations:\n" +
        lines.join("\n")
    : "";
}

export function changeSettings(settings, patch) {
  const next = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "appearance": {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid appearance choice");
        const appearance = { ...appearanceField(settings.appearance), ...value };
        if (
          !["system", "light", "dark"].includes(appearance.theme) ||
          !THEME_IDS.includes(appearance.colorTheme) ||
          !(appearance.darkColorTheme === null || THEME_IDS.includes(appearance.darkColorTheme)) ||
          !isContrast(appearance.contrast) ||
          !TEXT_SIZES.includes(appearance.textSize) ||
          !BACKDROPS.includes(appearance.backdrop) ||
          !FONT_IDS.includes(appearance.font) ||
          typeof appearance.avatarAnimations !== "boolean" ||
          !Object.hasOwn(LIGHT_BACKGROUNDS, appearance.lightBackground) ||
          !Object.hasOwn(DARK_BACKGROUNDS, appearance.darkBackground) ||
          !(
            appearance.bubble === "theme" ||
            /^#[0-9a-f]{6}$/i.test(appearance.bubble)
          )
        )
          throw new Error("Invalid appearance choice");
        // A background preset chosen by an earlier version, or by a phone that still offers them,
        // picks its theme, unless this change names a theme itself.
        const before = appearanceField(settings.appearance);
        const presetChanged = (value.lightBackground !== undefined && value.lightBackground !== before.lightBackground) || (value.darkBackground !== undefined && value.darkBackground !== before.darkBackground);
        if (value.colorTheme !== undefined) appearance.themePicked = true;
        else if (presetChanged) Object.assign(appearance, { colorTheme: undefined, themePicked: undefined });
        else appearance.themePicked = before.themePicked;
        // Choosing a font picks it. The font sent again unchanged (a client that sends the whole appearance) is not a pick.
        appearance.fontPicked = before.fontPicked || (value.font !== undefined && value.font !== before.font);
        next.appearance = appearanceField(appearance);
        break;
      }
      case "foldTools":
        if (typeof value !== "boolean")
          throw new Error("Choose a folding preference");
        next[key] = value;
        break;
      case "showThinking":
        if (typeof value !== "boolean")
          throw new Error("Choose whether to show thinking");
        next[key] = value;
        break;
      case "foldThinking":
        if (typeof value !== "boolean")
          throw new Error("Choose a thinking display preference");
        next[key] = value;
        break;
      case "showUpdates":
        if (typeof value !== "boolean")
          throw new Error("Choose whether to show updates");
        next[key] = value;
        break;
      case "onboarded":
        if (typeof value !== "boolean") throw new Error("Choose whether the welcome is done");
        next[key] = value;
        break;
      case "linkPreviews":
      case "readAloud":
      case "showRoutineChats":
      case "teamwork":
      case "longPromptCache":
        if (typeof value !== "boolean") throw new Error("Choose on or off");
        next[key] = value;
        break;
      case "approval":
        if (!["ask", "read", "assisted", "all"].includes(value))
          throw new Error("Unknown approval level");
        next[key] = value;
        break;
      case "clarify":
        if (
          !Array.isArray(value) ||
          value.some((k) => !Object.hasOwn(clarificationPrompts, k))
        )
          throw new Error("Unknown clarification scenario");
        next[key] = [...new Set(value)];
        break;
      case "clarificationInstructions":
        if (typeof value !== "string" || value.length > 4000)
          throw new Error(
            "Use up to 4,000 characters for clarification instructions.",
          );
        next[key] = value.trim();
        break;
      case "notifications": {
        const current = settings.notifications ?? defaultSettings.notifications;
        const n = {
          ...current,
          ...value,
          quietHours: { ...current.quietHours, ...value?.quietHours },
        };
        const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (
          !value ||
          typeof value !== "object" ||
          Object.keys(n).some(
            (k) => !["replies", "routines", "requests", "reminders", "quietHours"].includes(k),
          ) ||
          ["replies", "routines", "requests"].some((k) => typeof n[k] !== "boolean") ||
          (n.reminders !== undefined && typeof n.reminders !== "boolean") ||
          typeof n.quietHours.enabled !== "boolean" ||
          !clock.test(n.quietHours.from) ||
          !clock.test(n.quietHours.to)
        )
          throw new Error("Invalid notification setting");
        next.notifications = {
          replies: n.replies,
          routines: n.routines,
          requests: n.requests,
          // Saved before reminders, it is on.
          reminders: n.reminders !== false,
          quietHours: {
            enabled: n.quietHours.enabled,
            from: n.quietHours.from,
            to: n.quietHours.to,
          },
        };
        break;
      }
      case "access":
        if (!value || typeof value !== "object" || typeof value.allBots !== "boolean" || Object.keys(value).some((k) => k !== "allBots"))
          throw new Error("Choose whether all bots can use every project");
        next.access = { allBots: value.allBots };
        break;
      case "autoSummarize":
        next.autoSummarize = autoSummarizeField(value);
        break;
      case "tasksMax":
      case "tasksPerBot":
        // null clears the setting: the limit is then the environment's, else the default (desktop/task-limits.mjs).
        if (taskLimitField(key, value) === null) delete next[key];
        else next[key] = value;
        break;
      case "harness":
        if (!HARNESSES.includes(value)) throw new Error("Choose a harness");
        next.harness = value;
        // From now on it is the person's own choice, kept when the default changes (desktop/harness).
        next.harnessPicked = true;
        break;
      case "background":
        next.background = backgroundField(value, backgroundField(settings.background));
        break;
      case "proactive":
        next.proactive = proactiveField(value, settings.proactive);
        break;
      case "sidebar":
        // Opening or collapsing the menu is the person's own choice from then on.
        next.sidebar = sidebarField(value?.collapsed === undefined ? value : { ...value, picked: true }, sidebarField(settings.sidebar));
        break;
      case "macTools":
        // A phone can ask for setPreferences, so this one is refused here: only the app's own window may change it.
        throw new Error("iMessage and Mail tools can be changed only in Botkins on the computer, under Settings › MCP servers.");
      default:
        throw new Error("Unknown setting");
    }
  }
  return next;
}

/**
 * Checks a model choice against the catalog (every provider's models, desktop/providers).
 * `provider` names the Botkins provider; `source` is that provider's own reference for the model.
 */
export function validateSelection(catalog, selection) {
  const m = catalog.find(
    (m) =>
      m.id === selection?.model &&
      (!selection.provider || m.provider === selection.provider) &&
      (!selection.source || m.source === selection.source),
  );
  if (!m?.available)
    throw new Error("That model is unavailable in your account.");
  if (
    selection.reasoningEffort != null &&
    !m.efforts.includes(selection.reasoningEffort)
  )
    throw new Error("That thinking level is unavailable for " + m.name + ".");
  return {
    model: m.id,
    ...(m.provider && { provider: m.provider }),
    ...(m.source && { source: m.source }),
    ...(selection.reasoningEffort && {
      reasoningEffort: selection.reasoningEffort,
    }),
  };
}
