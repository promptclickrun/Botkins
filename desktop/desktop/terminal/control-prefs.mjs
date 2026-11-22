// Preferences, usage, the cache and the Mac tools: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// (Voice is its own area: desktop/terminal/control-voice.mjs.)
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// Each call wraps the app's own call, which checks what it is given. Two rules hold here:
//  - A preference is one of a fixed list (`PREFERENCES`). A key that is not in it is refused.
//  - A change that takes a question away or gives bots more room needs the mark `{ agreed: true }` from the
//    caller: a looser approval level, `access.allBots` switched on and `teamwork` switched on (`preferences.set`),
//    and a Mac tool given more (`macTools.set`). The mark says that the caller showed the person what it gives
//    and got a yes. The command line does that (`--yes`, or the question at a terminal). A caller that is the
//    person gives the mark itself.
import { backgroundField } from "../startup.mjs";
import { appearanceField, clarificationPrompts, defaultSettings, FONT_IDS, sidebarField, SIDEBAR, TEXT_SIZES, THEME_IDS } from "../preferences.mjs";
import { HARNESSES } from "../harness/index.mjs";
import { MAC_LEVELS, MAC_TOOLS } from "../mactools.mjs";
import { usageCsv } from "../usage.mjs";
import { ControlError } from "./socket.mjs";

const bad = (message, code = "BAD_ARGUMENT") => new ControlError(message, code);
/** The places a Mac tool is named by: its id, and the name a person says. */
export const MAC_TOOL_NAMES = { imessage: "iMessage", mail: "Mail" };
/** The days a usage report can cover. */
export const USAGE_DAYS = [7, 30, 90];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const ON = ["on", "true", "yes", "1"];
const OFF = ["off", "false", "no", "0"];
const switches = (about) => ({ type: "boolean", about });
const choice = (values, about) => ({ type: "choice", values, about });

/**
 * Every preference that `setPreferences` takes, by the name the command line uses (a dot goes one
 * level down). `type` says what a value is: "boolean" (on or off), "choice" (one of `values`),
 * "list" (some of `values`, or none), "color", "clock" (HH:MM) or "text" (up to `max` characters).
 * "macTools" is not here: the app changes it only through its own call (`macTools.set`).
 */
export const PREFERENCES = {
  "appearance.theme": choice(["system", "light", "dark"], "Light, dark, or the computer's own"),
  "appearance.colorTheme": choice(THEME_IDS, "The color theme"),
  "appearance.textSize": choice(TEXT_SIZES, "The size of the text"),
  "appearance.font": choice(FONT_IDS, "The font"),
  "appearance.bubble": { type: "color", about: "The color of your messages: theme, or a color such as #3366cc" },
  foldTools: switches("Fold the steps of a finished reply into one line"),
  showThinking: switches("Show the bot's thinking"),
  onboarded: switches("The welcome is done"),
  linkPreviews: switches("Show a preview of a linked page (this computer fetches the page)"),
  readAloud: switches("Read replies aloud"),
  teamwork: switches("Bots may ask each other for help from a chat"),
  approval: choice(["ask", "read", "assisted", "all"], "How tool requests are approved: ask for each, read-only tools without asking, the provider decides, or all without asking"),
  clarify: { type: "list", values: Object.keys(clarificationPrompts), about: "When a bot asks a clarifying question: any of " + Object.keys(clarificationPrompts).join(", ") + ", or none" },
  clarificationInstructions: { type: "text", max: 4000, about: "Your own words for when a bot asks a clarifying question" },
  "notifications.replies": switches("Tell me when a bot replies"),
  "notifications.routines": switches("Tell me when a routine finishes"),
  "notifications.requests": switches("Tell me when a bot asks for something"),
  "notifications.quietHours.enabled": switches("Keep quiet during the quiet hours"),
  "notifications.quietHours.from": { type: "clock", about: "The quiet hours start, as HH:MM" },
  "notifications.quietHours.to": { type: "clock", about: "The quiet hours end, as HH:MM" },
  "access.allBots": switches("Every bot can use every project"),
  harness: choice(HARNESSES, "What runs a bot's turn: copilot (one for every plan), provider (each provider's own tool), pi (Pi) or omp (OMP)"),
  "background.keepRunning": switches("The desktop app keeps running when its window closes (for the app's window; this host runs as a service)"),
  "background.runAtStartup": switches("The desktop app starts with the computer (for the app's window; this host starts with `botkins service install`)"),
  "sidebar.order": { type: "list", values: SIDEBAR, about: "The order of the places in the side menu: " + SIDEBAR.join(", ") },
  "sidebar.collapsed": switches("The side menu shows icons only"),
};
/** What each choice of the preference `harness` is, in a sentence. */
export const HARNESS_ABOUT = {
  copilot: "One harness runs every chat, and each plan answers its own model requests (the usual choice)",
  provider: "Each provider's own tool runs its chats",
  pi: "The Pi program runs the chats of ChatGPT and Claude plan models",
  omp: "The OMP program runs the chats of ChatGPT and Claude plan models with Pi-compatible tools and OMP improvements",
};
/** The levels of "approval", from the one that asks the most to the one that asks nothing: a later one is looser. */
export const APPROVAL_ORDER = ["ask", "read", "assisted", "all"];
/**
 * What a switch gives bots, for each preference that gives them more room. `gives(now, next)` says what the new value gives
 * (a sentence), or null when it gives nothing more (a tighter level, the same value, or a switch turned off).
 * The command line shows the sentence first and asks (cli/commands/prefs.mjs), and the call refuses without the mark.
 */
export const WIDENS = {
  approval: (now, next) => (APPROVAL_ORDER.indexOf(next) > APPROVAL_ORDER.indexOf(now) ? "The approval level " + next + " is looser than " + now + ": bots get more room, and some of their requests get a yes with no question to the person." : null),
  "access.allBots": (now, next) => (next === true && now !== true ? "Turning on access for all bots lets every bot use every project: the grant that each bot has no longer limits it, so bots get more room." : null),
  teamwork: (now, next) => (next === true && now !== true ? "Turning teamwork on lets a bot bring other bots into a chat to work for it: bots get more room." : null),
  // It makes a login item on this computer (desktop/runtime.mjs, setPreferences): a program that starts at each login.
  "background.runAtStartup": (now, next) => (next === true && now !== true ? "Turning on run at startup makes Botkins start when the person logs in to this computer: it adds a login item to this computer." : null),
};

/** The settings made whole, as the app shows them. */
function wholeSettings(settings = {}) {
  const notifications = { ...defaultSettings.notifications, ...settings.notifications };
  return {
    ...defaultSettings,
    ...settings,
    appearance: appearanceField(settings.appearance),
    notifications: { ...notifications, quietHours: { ...defaultSettings.notifications.quietHours, ...settings.notifications?.quietHours } },
    access: { ...defaultSettings.access, ...settings.access },
    background: backgroundField(settings.background),
    sidebar: sidebarField(settings.sidebar),
  };
}
const lookup = (settings, key) => key.split(".").reduce((value, part) => value?.[part], settings);
/** A preference's own key: exactly one of the list. */
function preference(key) {
  if (typeof key !== "string" || !Object.hasOwn(PREFERENCES, key)) throw bad("There is no preference called " + (typeof key === "string" && key.length <= 60 && /^[\w.-]+$/.test(key) ? key : "that") + ". The keys are: " + Object.keys(PREFERENCES).join(", ") + ".", "NOT_FOUND");
  return PREFERENCES[key];
}
/** A value as the app takes it, or a refusal that says what the key takes. */
function parsePreference(key, spec, value) {
  const refuse = (what) => bad(key + " takes " + what + ".");
  switch (spec.type) {
    case "boolean": {
      if (typeof value === "boolean") return value;
      const word = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (ON.includes(word)) return true;
      if (OFF.includes(word)) return false;
      throw refuse("on or off");
    }
    case "choice": {
      const word = typeof value === "string" ? value.trim().toLowerCase() : "";
      const found = spec.values.find((item) => item.toLowerCase() === word);
      if (!found) throw refuse("one of " + spec.values.join(", "));
      return found;
    }
    case "list": {
      const words = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
      if (!words || words.some((item) => typeof item !== "string")) throw refuse("some of " + spec.values.join(", ") + ", or none");
      const items = words.map((item) => item.trim()).filter(Boolean);
      if (items.length === 1 && items[0].toLowerCase() === "none") return [];
      const found = items.map((item) => spec.values.find((entry) => entry.toLowerCase() === item.toLowerCase()));
      if (found.some((item) => !item)) throw refuse("some of " + spec.values.join(", ") + ", or none");
      return [...new Set(found)];
    }
    case "color": {
      const word = typeof value === "string" ? value.trim() : "";
      if (word.toLowerCase() === "theme") return "theme";
      if (/^#[0-9a-f]{6}$/i.test(word)) return word;
      throw refuse("theme, or a color such as #3366cc");
    }
    case "clock": {
      const word = typeof value === "string" ? value.trim() : "";
      if (!CLOCK.test(word)) throw refuse("a time of day as HH:MM, such as 22:30");
      return word;
    }
    case "text":
      if (typeof value !== "string" || value.length > spec.max) throw refuse("text of up to " + spec.max + " characters");
      return value;
    default:
      throw refuse("a different value");
  }
}
/** The app's own patch for one key: "notifications.quietHours.from" is { notifications: { quietHours: { from } } }. */
const patchOf = (key, value) => key.split(".").reduceRight((inner, part) => ({ [part]: inner }), value);

/** A name from a short list: exact (any capitals), then the one that starts with it. */
function named(list, ref, what, see) {
  const wanted = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (!wanted || wanted.length > 60) throw bad("Give " + what + ". " + see);
  const exact = list.filter((entry) => entry.id === wanted || entry.name.toLowerCase() === wanted);
  const found = exact.length ? exact : list.filter((entry) => entry.id.startsWith(wanted) || entry.name.toLowerCase().startsWith(wanted));
  if (found.length > 1) throw bad("More than one " + what + " starts with " + wanted + ": " + found.map((entry) => entry.id).join(", ") + ".", "AMBIGUOUS");
  if (!found.length) throw bad("There is no " + what + " called " + wanted + ". " + see, "NOT_FOUND");
  return found[0];
}
const macTools = () => MAC_TOOLS.map((id) => ({ id, name: MAC_TOOL_NAMES[id] ?? id }));

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 */
export function prefsApi({ workspace, handlers }) {
  const settings = () => wholeSettings(workspace.state.settings);
  const view = (only) => Object.fromEntries(Object.keys(PREFERENCES).filter((key) => !only || key === only).map((key) => [key, lookup(settings(), key)]));
  const days = (value) => {
    const count = value === undefined || value === null ? 30 : Number(value);
    if (!USAGE_DAYS.includes(count)) throw bad("Choose " + USAGE_DAYS.slice(0, -1).join(", ") + " or " + USAGE_DAYS.at(-1) + " days.");
    return count;
  };
  return {
    // ── Preferences ──
    /** The preferences by their keys: all of them, or the one named. */
    "preferences.get": ([key]) => {
      if (key !== undefined && key !== null) preference(key);
      return view(key ?? undefined);
    },
    /**
     * Sets one preference. The answer is { key, value }, the value as it is now.
     * `options`: { agreed?: true }. A switch that gives bots more room (`WIDENS`: a looser approval level, access for all bots
     * switched on, teamwork switched on, run at startup switched on) needs `agreed: true`: the caller showed the person what it gives and got a yes.
     * The command line does that (`--yes`, or the question at a terminal). A change that gives nothing more needs no mark.
     */
    async "preferences.set"([key, value, options]) {
      const spec = preference(key);
      const parsed = parsePreference(key, spec, value);
      const gives = Object.hasOwn(WIDENS, key) ? WIDENS[key](lookup(settings(), key), parsed) : null;
      if (gives && options?.agreed !== true) throw bad(gives + " Show that to the person, and give `{ \"agreed\": true }` after the value (on the command line, `--yes`).", "NEEDS_YES");
      await handlers.setPreferences(patchOf(key, parsed));
      return { key, value: lookup(settings(), key) };
    },

    /**
     * What can run a bot's turn: { chosen, choices: [{ id, about }], programs: [...] }. `programs` are the harnesses that are a
     * program of their own (Pi or OMP), each with whether it is installed. The choice is the preference `harness`.
     */
    async "preferences.harnesses"() {
      const programs = await handlers.harnesses();
      return {
        chosen: lookup(settings(), "harness"),
        choices: HARNESSES.map((id) => ({ id, about: HARNESS_ABOUT[id] ?? "" })),
        programs: (Array.isArray(programs) ? programs : []).map((entry) => ({
          id: entry.id,
          name: entry.name,
          installed: entry.installed !== false,
          ...(entry.version && { version: entry.version }),
          ...(entry.message && { message: entry.message }),
          ...(entry.error && { error: entry.error }),
          ...(entry.install && { install: entry.install }),
        })),
      };
    },

    // ── Usage ──
    /** Turns, tokens and cost over 7, 30 or 90 days, by day, model and bot. */
    "usage.report": ([period]) => handlers.usage(days(period)),
    /**
     * The same period as a CSV file: { name, days, text }. It is made from the recorded runs and
     * kept nowhere (the phone's export is kept as a file of the first bot; this one is not).
     */
    "usage.export": ([period]) => {
      const range = days(period);
      return { name: "botkins-usage-" + range + "d.csv", days: range, text: usageCsv(workspace.state, { days: range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) };
    },

    // ── The cache ──
    /** { bytes, catalogs }: the window's cache (none on this host), and the bot menus kept. */
    "cache.info": () => handlers.cacheInfo(),
    /** Forgets the bot menus (they are built again at their next use) and the window's cache. */
    async "cache.clear"() {
      await handlers.clearCache();
      return { cleared: true, ...(await handlers.cacheInfo()) };
    },

    // ── The Mac tools ──
    /** The level of each tool, whether imsg is installed, and which permissions macOS has allowed. Off a Mac, the app's own answer: not available. */
    "macTools.status": () => handlers.macToolsStatus(),
    /**
     * Sets one tool to off, read or interact. Off a Mac the app's own refusal is the answer.
     * `options`: { agreed?: true }. A level that gives bots more than the one now (read the mail, send as the person)
     * needs `agreed: true`: the caller showed the person what it gives and got a yes. The command line does that.
     */
    async "macTools.set"([ref, level, options]) {
      const found = named(macTools(), ref, "Mac tool", "They are: " + MAC_TOOLS.join(", ") + ".");
      if (!MAC_LEVELS.includes(level)) throw bad("A level is one of " + MAC_LEVELS.join(", ") + ".");
      // (A computer that is not a Mac gets no question: the app refuses any level above off, and that is the answer.)
      const now = workspace.mac.levels()[found.id];
      if (workspace.mac.available() && MAC_LEVELS.indexOf(level) > MAC_LEVELS.indexOf(now) && options?.agreed !== true) {
        throw bad("The level " + level + " gives bots more of " + found.name + " than " + now + ": they read or send as the person on this Mac. Show that to the person, and give `{ \"agreed\": true }` after the level (on the command line, `--yes`).", "NEEDS_YES");
      }
      return { tool: found.id, name: found.name, ...(await handlers.setMacTool(found.id, level)) };
    },
  };
}
