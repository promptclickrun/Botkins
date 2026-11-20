// Bots are Botkins: one of the design kit's 20 characters in one of its 7 palettes (or in four
// colors of the person's own), with one of its six eye styles, acting out what the bot is doing. The characters (design/botkins-kit/avatars) are drawn by the kit's own
// renderer (customize.js and motion/render.js), which returns an animated SVG string for a
// character, a palette and a state. The same looks and states as the phone app
// (botkins: src/data/botLook.ts, src/state/hooks.ts).
import { Botkins, BotkinsMotion, BotkinsMotionCatalog } from "virtual:botkins-kit";
import { CUSTOM, type FourColors, isCustom, isFourColors, kitOptions } from "./lookRender";
import type { BotLook, LookEyes, State } from "./types";

export { CUSTOM, isFourColors, type FourColors };

const sources = import.meta.glob<string>("../design/botkins-kit/avatars/*.svg", { eager: true, query: "?raw", import: "default" });

export type Head = { id: string; name: string; source: string; shell: string };
/** The characters, in the kit's order. */
export const HEADS: Head[] = Object.entries(sources)
  .map(([path, source]) => ({
    id: path.replace(/^.*\/([^/]+)\.svg$/, "$1"),
    name: /<title>([^<]+)<\/title>/.exec(source)?.[1] ?? "",
    source,
    shell: /<path data-role="shell" fill="(#[0-9a-fA-F]{6})"/.exec(source)?.[1] ?? "#B45432",
  }))
  .sort((a, b) => a.id.localeCompare(b.id));
const heads = new Map(HEADS.map((head) => [head.id, head]));

export type Palette = { id: string; name: string; swatch: string | null; colors: FourColors | null };
/** The palettes. Original keeps each character's own colors, so it has no swatch. */
export const PALETTES: Palette[] = Object.entries(Botkins.palettes).map(([name, colors]) => ({ id: name.toLowerCase(), name, swatch: colors?.[0] ?? null, colors: colors ? ([...colors] as FourColors) : null }));
const palettes = new Map(PALETTES.map((palette) => [palette.id, palette]));
/**
 * Color templates beyond the kit's palettes, saved as custom looks. The phone app's own
 * (src/data/lookTemplates.ts in the phone repo), so Surprise me picks the same on both.
 */
export const TEMPLATES: { id: string; name: string; colors: FourColors }[] = [
  { id: "midnight", name: "Midnight", colors: ["#3e4f86", "#e0b354", "#e8ecf6", "#151a2e"] },
  { id: "mint", name: "Mint", colors: ["#69bb9b", "#e98a6b", "#effaf1", "#21423a"] },
  { id: "rose", name: "Rose", colors: ["#d97a8c", "#7f9e6a", "#fdeaea", "#4a2430"] },
  { id: "slate", name: "Slate", colors: ["#6c7a89", "#d3a55c", "#eef0f2", "#252b32"] },
  { id: "sunset", name: "Sunset", colors: ["#e8743b", "#8e4f8f", "#ffe8cf", "#3d1f2e"] },
  { id: "lilac", name: "Lilac", colors: ["#a58bc9", "#e7b85a", "#f6eefb", "#352a46"] },
  { id: "ocean", name: "Ocean", colors: ["#2f7fa6", "#f0a64a", "#e6f3f7", "#132f3d"] },
  { id: "ink", name: "Ink", colors: ["#3b3b3b", "#9a9a9a", "#f4f4f4", "#111111"] },
];

/**
 * What Original is in four colors, by character: the custom colors that come closest to its own.
 * The phone measures these from the kit's renders (scripts/build-botkins.mjs in the phone repo,
 * `own` in its src/data/botkins.generated.ts); they are copied here so both apps start the
 * color slots in the same place.
 */
const OWN: Record<string, FourColors> = {
  beacon: ["#6e926c", "#a68447", "#ffeba8", "#593515"],
  crumb: ["#e78c13", "#788449", "#ffebab", "#593515"],
  fathom: ["#7b8d68", "#c09235", "#ffeda4", "#593515"],
  goggle: ["#da5f21", "#c78733", "#ffeba9", "#593515"],
  luna: ["#6a9173", "#d2a126", "#ffeaa7", "#593515"],
  morel: ["#db5920", "#dd8c1d", "#ffeaa8", "#593515"],
  muse: ["#72926b", "#b96c3a", "#ffeba8", "#593515"],
  oakley: ["#ba9a3f", "#d07b29", "#ffeca5", "#593515"],
  pearl: ["#de5e1c", "#ef7d0b", "#ffeca3", "#593515"],
  pip: ["#d75623", "#e88d13", "#ffe9ac", "#593515"],
  posy: ["#70926a", "#cea528", "#ffeba8", "#593515"],
  pounce: ["#e88012", "#9a9a67", "#ffeea3", "#593515"],
  ramble: ["#6b936d", "#b1a243", "#ffeba6", "#593515"],
  skiff: ["#be9c3c", "#788449", "#ffeaa9", "#593515"],
  spool: ["#b69744", "#c98331", "#ffeca5", "#593515"],
  sprig: ["#d55d25", "#d5b925", "#ffeba5", "#593515"],
  tinker: ["#ec910e", "#788449", "#ffefa1", "#593515"],
  toast: ["#e88f12", "#d96d21", "#ffeda3", "#593515"],
  wick: ["#ec8b0f", "#788449", "#ffeda3", "#593515"],
  wicket: ["#c19a39", "#788449", "#ffeda5", "#593515"],
};

/** The eye styles, in the kit's order. Oval is each character's own. */
export const EYES: { id: LookEyes; name: string }[] = Botkins.eyeStyles.map((name) => ({ id: name.toLowerCase() as LookEyes, name }));
const eyeNames = new Map(EYES.map((eyes) => [eyes.id as string, eyes.name]));

const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
/** The look a bot shows until it has one of its own: always the same character for the same bot. */
export const defaultLook = (botId: string): BotLook => ({ head: HEADS[hash(botId) % HEADS.length].id, palette: "original" });
/**
 * A look at random, the way the phone picks one: Original comes up most (most characters look best
 * in their own colors), then a kit palette, then one of the templates; half the time with eyes.
 */
export function randomLook(): BotLook {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
  const head = pick(HEADS).id;
  const eyes = Math.random() < 0.5 ? undefined : pick(EYES.slice(1)).id;
  const roll = Math.random();
  if (roll < 0.4) return { head, palette: "original", ...(eyes && { eyes }) };
  if (roll < 0.7) return { head, palette: pick(PALETTES.slice(1)).id, ...(eyes && { eyes }) };
  return { head, palette: CUSTOM, colors: [...pick(TEMPLATES).colors], ...(eyes && { eyes }) };
}

/** A look for a bot that is being made: a character few of the others have, in its own colors. */
export function freshLook(others: (BotLook | undefined)[] = []): BotLook {
  const used = new Map(HEADS.map((head) => [head.id, 0]));
  for (const look of others) if (look && used.has(look.head)) used.set(look.head, used.get(look.head)! + 1);
  const fewest = Math.min(...used.values());
  const free = HEADS.filter((head) => used.get(head.id) === fewest);
  return { head: free[Math.floor(Math.random() * free.length)].id, palette: "original" };
}

type Looked = { id?: string; look?: BotLook };
/** A bot's look: the one saved for it, else its stable default. Custom without its four colors is Original. */
export function lookOf(bot: Looked): BotLook {
  const look = bot.look;
  if (!look || !heads.has(look.head)) return defaultLook(bot.id ?? "");
  if (palettes.has(look.palette) || isCustom(look)) return look;
  if (look.palette === CUSTOM) return { head: look.head, palette: "original", ...(look.eyes && { eyes: look.eyes }) };
  return defaultLook(bot.id ?? "");
}
/** A character's name, such as "Sprig". */
export const headName = (id: string) => heads.get(id)?.name ?? id;
export const paletteName = (id: string) => (id === CUSTOM ? "your own colors" : (palettes.get(id)?.name ?? id));
/** The eyes a look has at rest: one of the kit's, else the character's own. */
export const eyesOf = (look: BotLook): LookEyes => (look.eyes && eyeNames.has(look.eyes) ? look.eyes : "oval");
/** The four colors a look shows, as Bot Studio's slots: its own, a palette's, or the character's for Original. */
export function colorsOf(look: BotLook): FourColors {
  if (isCustom(look)) return look.colors!.map((color) => color.toLowerCase()) as FourColors;
  const colors = palettes.get(look.palette)?.colors;
  return [...(colors ?? OWN[look.head] ?? OWN[HEADS[0].id])];
}
/** The same look? Eyes left out are "oval", and colors count only for a custom look. */
export function sameLook(a: BotLook, b: BotLook): boolean {
  if (a.head !== b.head || a.palette !== b.palette || eyesOf(a) !== eyesOf(b)) return false;
  if (a.palette !== CUSTOM) return true;
  return !!a.colors && !!b.colors && a.colors.every((color, index) => color.toLowerCase() === b.colors![index]?.toLowerCase());
}
/** A bot's own color, for a tint on what belongs to it. For a custom look it is the shell color. */
export const colorOf = (bot: Looked) => {
  const look = lookOf(bot);
  if (isCustom(look)) return look.colors![0].toLowerCase();
  return palettes.get(look.palette)?.swatch ?? heads.get(look.head)!.shell;
};

/**
 * What a bot is doing, as its avatar acts it out. Most are the kit's own states. Three are the
 * app's words: "waiting" is a bot waiting for the person (the kit's Needs input), "talking" is a
 * reply being written, and "pending" is the kit's Waiting (something outside is pending).
 */
export type AvatarState =
  | "idle" | "listening" | "thinking" | "planning" | "browsing" | "coding" | "working" | "needs-input" | "retrying"
  | "completed" | "error" | "like" | "love" | "laugh" | "sad"
  | "waiting" | "pending" | "talking" | "happy" | "sleeping";

/** The kit's state for each. */
const CLIP: Record<AvatarState, string> = {
  idle: "Idle", listening: "Listening", thinking: "Thinking", planning: "Planning", browsing: "Browsing", coding: "Coding", working: "Working",
  "needs-input": "Needs input", retrying: "Retrying", completed: "Completed", error: "Error", like: "Like", love: "Love", laugh: "Laugh", sad: "Sad",
  waiting: "Needs input", pending: "Waiting", talking: "Listening", happy: "Completed", sleeping: "Waiting",
};
/** True for a state that plays once and holds (an outcome or a reaction). */
export const playsOnce = (state: AvatarState) => !BotkinsMotionCatalog.states[CLIP[state]].loop;
export const clipDuration = (state: AvatarState) => BotkinsMotionCatalog.states[CLIP[state]].durationMs;

/** A key for everything that changes how a look is drawn. */
export const lookKey = (look: BotLook) => [look.head, look.palette, eyesOf(look), isCustom(look) ? look.colors!.join(",").toLowerCase() : ""].join("|");

// Kit palettes are few, so their drawings are kept for the life of the window. Custom colors
// change with every drag of the color picker, so only the ones used most recently are kept.
const RECENT = 80;
const drawn = new Map<string, string>();
const drawnCustom = new Map<string, string>();
/** A kept drawing, moved to the newest end so the ones on screen stay. */
function recall<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}
function remember<T>(map: Map<string, T>, key: string, value: T, drop?: (value: T) => void) {
  map.set(key, value);
  if (map.size <= RECENT) return;
  const [oldest, gone] = map.entries().next().value!;
  map.delete(oldest);
  drop?.(gone);
}

/**
 * A look acting out a state, as an SVG string from the kit's renderer.
 * `still` holds the pose and stops the blinking; `badge: false` leaves the state's badge out.
 */
export function botkinSvg(look: BotLook, state: AvatarState = "idle", { still = false, badge = true } = {}): string {
  const key = [lookKey(look), state, still, badge].join("|");
  const cache = isCustom(look) ? drawnCustom : drawn;
  let svg = cache === drawn ? drawn.get(key) : recall(drawnCustom, key);
  if (svg === undefined) {
    const head = heads.get(look.head) ?? HEADS[0];
    const clip = CLIP[state] ?? "Idle";
    // The renderer's options for the look (src/lookRender.ts): its palette or four colors, and its eyes.
    svg = BotkinsMotion.render(head.source, clip, { ...kitOptions(look, BotkinsMotionCatalog.states[clip].eyes, Botkins.palettes), reducedMotion: still });
    // The renderer draws the badge last, at a fixed place. Small avatars leave it out.
    if (!badge) svg = svg.replace(/<g transform="translate\(191 181\)"><circle[^]*?<\/g><\/svg>$/, "</svg>");
    if (cache === drawn) drawn.set(key, svg);
    else remember(drawnCustom, key, svg);
  }
  return svg;
}

const urls = new Map<string, string>();
const urlsCustom = new Map<string, string>();
/**
 * The same as a picture address for an <img>. One address per drawing, kept for the life of the
 * window; a custom look's address is let go once many newer ones have been made.
 */
export function botkinUrl(look: BotLook, state: AvatarState = "idle", options: { still?: boolean; badge?: boolean } = {}): string {
  const svg = botkinSvg(look, state, options);
  const cache = isCustom(look) ? urlsCustom : urls;
  let url = cache === urls ? urls.get(svg) : recall(urlsCustom, svg);
  if (!url) {
    url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    if (cache === urls) urls.set(svg, url);
    else remember(urlsCustom, svg, url, (gone) => URL.revokeObjectURL(gone));
  }
  return url;
}

type Live = Pick<State, "requests" | "streams" | "chats"> & Partial<Pick<State, "speakers" | "intents">>;

/** What a bot at work is busy with, read from its own one-line note about it ("Searching the wiki"). */
function busyWith(intent: string | undefined): AvatarState {
  const text = (intent ?? "").toLowerCase();
  if (/\b(search|brows|look(ing)? (up|for)|fetch|web|navigat|read(ing)? (the )?(page|site|docs?|wiki))/.test(text)) return "browsing";
  if (/\b(cod(e|ing)|edit|patch|run(ning)? |command|shell|test|build|debug|commit|refactor|install|writ\w* (the )?(file|code|script))/.test(text)) return "coding";
  if (/\b(plan|outlin|organi[sz]|to-?do|schedul|break(ing)? .* down)/.test(text)) return "planning";
  if (!text || /\b(think|consider|reason|ponder)/.test(text)) return "thinking";
  return "working";
}

/** What a bot is doing right now: waiting for the person, writing a reply, some kind of work, or nothing. */
export function botActivity(state: Live, botId: string): AvatarState {
  if (state.requests?.some((r) => r.botId === botId)) return "waiting";
  let busy: AvatarState = "idle";
  // Few chats stream at once, so walk the streams rather than every chat.
  for (const [chatId, text] of Object.entries(state.streams ?? {})) {
    // In a group chat the member replying now is busy, not the whole group.
    const who = state.speakers?.[chatId] ?? state.chats.find((c) => c.id === chatId)?.botId;
    if (who !== botId) continue;
    if (text) return "talking";
    busy = busyWith(state.intents?.[chatId]);
  }
  return busy;
}

/** The same, for one chat. Chat rows use this so a row only moves when its own chat is busy. */
export function chatActivity(state: Live, chatId: string): AvatarState {
  if (state.requests?.some((r) => r.chatId === chatId)) return "waiting";
  const text = state.streams?.[chatId];
  if (text === undefined) return "idle";
  return text ? "talking" : busyWith(state.intents?.[chatId]);
}

/** A few words for what a bot is doing, or "" when it is idle. */
export function activityLabel(state: AvatarState): string {
  switch (state) {
    case "waiting":
    case "needs-input":
      return "Needs you";
    case "talking":
      return "Replying…";
    case "thinking":
      return "Thinking…";
    case "planning":
      return "Planning…";
    case "browsing":
      return "Looking things up…";
    case "coding":
      return "Coding…";
    case "working":
      return "Working…";
    case "retrying":
      return "Trying again…";
    case "pending":
      return "Waiting…";
    default:
      return "";
  }
}
