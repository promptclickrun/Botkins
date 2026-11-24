// Desktop and phone use the design kit's characters, palettes, eye styles and activity clips.
// The kit draws the colored shell and expression. Avatar.tsx plays the catalog's poses.
import { Botkins, BotkinsMotion, BotkinsMotionCatalog } from "virtual:botkins-kit";
import { makeHeadPicker, originalHeadIds } from "../desktop/link/botkin-heads.mjs";
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
const remoteHeads = makeHeadPicker(HEADS);
export const availableHeads = (remote?: State["remote"]) => remote?.using ? remoteHeads(remote.using.capabilities) : HEADS;

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
  brim: ["#ac4d52", "#b58045", "#f9e5be", "#593515"],
  clover: ["#659579", "#c49a35", "#f7e9c0", "#593515"],
  crumb: ["#e78c13", "#788449", "#ffebab", "#593515"],
  drip: ["#c15b39", "#d37c27", "#fde5b9", "#593515"],
  dune: ["#c08d3a", "#ad6f4d", "#fde6ba", "#593515"],
  fathom: ["#7b8d68", "#c09235", "#ffeda4", "#593515"],
  gloop: ["#9e5c76", "#c66935", "#f5dcc1", "#593515"],
  goggle: ["#da5f21", "#c78733", "#ffeba9", "#593515"],
  luna: ["#6a9173", "#d2a126", "#ffeaa7", "#593515"],
  mallow: ["#b05a4a", "#a9515c", "#f6dec1", "#593515"],
  morel: ["#db5920", "#dd8c1d", "#ffeaa8", "#593515"],
  muse: ["#72926b", "#b96c3a", "#ffeba8", "#593515"],
  oakley: ["#ba9a3f", "#d07b29", "#ffeca5", "#593515"],
  orbit: ["#5f809c", "#c17f39", "#f4e1c2", "#593515"],
  pearl: ["#de5e1c", "#ef7d0b", "#ffeca3", "#593515"],
  pebble: ["#8b9c5e", "#c08a3a", "#f8ebbf", "#593515"],
  pip: ["#d75623", "#e88d13", "#ffe9ac", "#593515"],
  posy: ["#70926a", "#cea528", "#ffeba8", "#593515"],
  pounce: ["#e88012", "#9a9a67", "#ffeea3", "#593515"],
  ramble: ["#6b936d", "#b1a243", "#ffeba6", "#593515"],
  ripple: ["#5f999b", "#b39347", "#f2e4c5", "#593515"],
  skiff: ["#be9c3c", "#788449", "#ffeaa9", "#593515"],
  spool: ["#b69744", "#c98331", "#ffeca5", "#593515"],
  sprig: ["#d55d25", "#d5b925", "#ffeba5", "#593515"],
  tinker: ["#ec910e", "#788449", "#ffefa1", "#593515"],
  toast: ["#e88f12", "#d96d21", "#ffeda3", "#593515"],
  wick: ["#ec8b0f", "#788449", "#ffeda3", "#593515"],
  wicket: ["#c19a39", "#788449", "#ffeda5", "#593515"],
  wisp: ["#7a6a91", "#ae844c", "#f3dec4", "#593515"],
};

/** The eye styles, in the kit's order. Oval is each character's own. */
export const EYES: { id: LookEyes; name: string }[] = Botkins.eyeStyles.map((name) => ({ id: name.toLowerCase() as LookEyes, name }));
const eyeNames = new Map(EYES.map((eyes) => [eyes.id as string, eyes.name]));

const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
/** A bot without a saved look keeps its original character when new heads join the kit. */
export const defaultLook = (botId: string): BotLook => ({ head: originalHeadIds[hash(botId) % originalHeadIds.length], palette: "original" });
/**
 * A look at random, the way the phone picks one: Original comes up most (most characters look best
 * in their own colors), then a kit palette, then one of the templates; half the time with eyes.
 */
export function randomLook(choices: Head[] = HEADS): BotLook {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
  const head = pick(choices).id;
  const eyes = Math.random() < 0.5 ? undefined : pick(EYES.slice(1)).id;
  const roll = Math.random();
  if (roll < 0.4) return { head, palette: "original", ...(eyes && { eyes }) };
  if (roll < 0.7) return { head, palette: pick(PALETTES.slice(1)).id, ...(eyes && { eyes }) };
  return { head, palette: CUSTOM, colors: [...pick(TEMPLATES).colors], ...(eyes && { eyes }) };
}

/** A look for a bot that is being made: a character few of the others have, in its own colors. */
export function freshLook(others: (BotLook | undefined)[] = [], choices: Head[] = HEADS): BotLook {
  const used = new Map(choices.map((head) => [head.id, 0]));
  for (const look of others) if (look && used.has(look.head)) used.set(look.head, used.get(look.head)! + 1);
  const fewest = Math.min(...used.values());
  const free = choices.filter((head) => used.get(head.id) === fewest);
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
// The catalog uses a 256-unit artboard. Percent translations scale with the picture even when
// a responsive layout resizes it. The kit eases each segment separately.
const clips = Object.fromEntries(Object.entries(BotkinsMotionCatalog.states).map(([name, clip]) => [name, {
  frames: clip.poses.map(([x, y, angle]) => ({
    transform: `translate(${x / 256 * 100}%, ${y / 256 * 100}%) rotate(${angle}deg)`,
    easing: "ease-in-out",
  })),
  timing: { duration: clip.durationMs, iterations: clip.loop ? Infinity : 1, fill: "forwards" as const },
}]));
export const motionOf = (state: AvatarState) => clips[CLIP[state]];
export const clipDuration = (state: AvatarState) => BotkinsMotionCatalog.states[CLIP[state]].durationMs;

/** A key for everything that changes how a look is drawn. */
export const lookKey = (look: BotLook) => [look.head, look.palette, eyesOf(look), isCustom(look) ? look.colors!.join(",").toLowerCase() : ""].join("|");

const eyeGroup = /<g data-layer="eyes"[^>]*>[\s\S]*?<\/g>/;
type ImageRef = (image: HTMLImageElement | null) => void | (() => void);
const kitArt = new Map<string, ImageRef>();
const customArt = new Map<string, ImageRef>();

/** Share just the colored shell, grain and shading across every expression and activity. */
export function botkinArt(look: BotLook): ImageRef {
  const head = heads.get(look.head) ?? HEADS[0];
  const custom = isCustom(look);
  const key = head.id + "|" + (custom ? look.colors!.slice(0, 3).join(",").toLowerCase() : look.palette);
  const cache = custom ? customArt : kitArt;
  let attach = cache.get(key);
  if (attach) {
    if (custom) {
      cache.delete(key);
      cache.set(key, attach);
    }
    return attach;
  }
  const { palette } = kitOptions(look, "Oval", Botkins.palettes);
  const svg = Botkins.render(head.source.replace(eyeGroup, ""), "Oval", palette, { reducedMotion: true });
  const blob = new Blob([svg], { type: "image/svg+xml" });
  let url: string | undefined;
  let users = 0;
  attach = (image) => {
    if (!image) return;
    image.src = url ??= URL.createObjectURL(blob);
    if (custom) {
      users++;
      return () => {
        if (--users === 0) {
          URL.revokeObjectURL(url!);
          url = undefined;
        }
      };
    }
  };
  cache.set(key, attach);
  // The color picker can create many shells. A mounted image keeps its URL even after eviction.
  if (custom && cache.size > 80) cache.delete(cache.keys().next().value!);
  return attach;
}

// Let the kit draw only the small expression and badge when a state changes. Keep the same
// placement and eye anchors that it reads from the original character.
const faceTemplates = new Map<string, string>();
function drawFace(look: BotLook, state: AvatarState) {
  const head = heads.get(look.head) ?? HEADS[0];
  let template = faceTemplates.get(head.id);
  if (!template) {
    const placement = /<g transform="[^"]+">/.exec(head.source)![0];
    const anchors = /<g data-layer="eyes"[^>]*>/.exec(head.source)![0];
    template = `<svg><title>${head.name}</title>${placement}${anchors}</g></g></svg>`;
    faceTemplates.set(head.id, template);
  }
  const clip = CLIP[state];
  const options = kitOptions(look, BotkinsMotionCatalog.states[clip].eyes, Botkins.palettes);
  const svg = BotkinsMotion.render(template, clip, { ...options, reducedMotion: true });
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const headLayer = root.querySelector("g")!;
  const seed = [...head.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  return {
    expression: headLayer.innerHTML,
    badge: headLayer.nextElementSibling?.outerHTML,
    blinkDuration: 3800 + seed % 1201,
    blinkDelay: -(seed % 2200),
  };
}

// Chat rows and the picker often show the same expression. Parse its small SVG once. Keep the
// cache bounded for custom looks while mounted avatars continue to hold their own drawing.
const faces = new Map<string, ReturnType<typeof drawFace>>();
export function botkinFace(look: BotLook, state: AvatarState) {
  const key = lookKey(look) + "|" + CLIP[state];
  const drawn = faces.get(key);
  if (drawn) return drawn;
  const face = drawFace(look, state);
  faces.set(key, face);
  if (faces.size > 256) faces.delete(faces.keys().next().value!);
  return face;
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
