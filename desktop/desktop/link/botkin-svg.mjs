// A bot's Botkin as a gadget draws it: one SVG for each pose, made by the design kit's own renderer
// (design/botkins-kit: customize.js and motion/render.js) from the bot's look, with nothing that
// moves. A gadget rasterizes it itself (gadget/firmware/core, nanosvg), so the computer sends text
// and draws nothing.
//
// The kit is found beside the link: the phone repo keeps it at design/botkins-kit next to
// link-host/, the desktop app at design/botkins-kit two folders up from desktop/link/. Without it
// there are no faces, and a gadget shows its own default Botkin.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const PLACES = [join(here, "../design/botkins-kit"), join(here, "../../design/botkins-kit")];

/** Each pose a gadget shows, as the kit's state and, where it differs, eyes. */
export const POSES = {
  ready: ["Idle"],
  listening: ["Listening"],
  working: ["Thinking"],
  // The kit has no talking pose: the app shows talking as listening too. Smiling eyes tell them apart.
  speaking: ["Listening", "Smile"],
  needs: ["Needs input"],
  waiting: ["Waiting"],
  sleepy: ["Idle", "Sleepy"],
};
const KEPT = 64;
const title = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The renderer for the kit in `dir` (found beside the link when not given), or null when there is
 * no kit there. `svg(look, pose)` answers the SVG text; `lookId(look)` names a look's set of faces.
 */
export function botkinRenderer(dir = PLACES.find((place) => existsSync(join(place, "motion/render.js")))) {
  if (!dir || !existsSync(join(dir, "motion/render.js"))) return null;
  // The kit's scripts are written for a page (each one a global the next one uses) and for CommonJS. A
  // package of ES modules can't require them, so they run as a page runs them, in a context of their own.
  const page = createContext({});
  for (const file of ["customize.js", "motion/catalog.js", "motion/render.js"]) runInContext(readFileSync(join(dir, file), "utf8"), page, { filename: file });
  const kit = runInContext("Botkins", page);
  const motion = runInContext("BotkinsMotion", page);
  const heads = new Map();
  const made = new Map();
  // The kit's own files go into the id, so a new kit gives every gadget its faces again.
  const version = createHash("sha256").update(readFileSync(join(dir, "motion/render.js"))).update(readFileSync(join(dir, "customize.js"))).digest("base64url").slice(0, 8);
  const head = (id) => {
    if (!heads.has(id)) {
      const file = join(dir, "avatars", id + ".svg");
      heads.set(id, /^[a-z]+$/.test(id) && existsSync(file) ? readFileSync(file, "utf8") : null);
    }
    return heads.get(id);
  };
  /** The parts of a look that change how it is drawn, with the kit's defaults filled in. */
  const parts = (look) => {
    const id = typeof look?.head === "string" && head(look.head) ? look.head : "beacon";
    const custom = look?.palette === "custom" && Array.isArray(look.colors) && look.colors.length === 4;
    const palette = custom ? look.colors.map(String) : typeof look?.palette === "string" && kit.palettes && Object.hasOwn(kit.palettes, title(look.palette)) ? title(look.palette) : "Original";
    const eyes = typeof look?.eyes === "string" && kit.eyeStyles?.includes(title(look.eyes)) ? title(look.eyes) : undefined;
    return { id, palette, eyes };
  };
  return {
    lookId(look) {
      const { id, palette, eyes } = parts(look);
      return createHash("sha256").update(JSON.stringify([version, id, palette, eyes ?? null])).digest("base64url").slice(0, 16);
    },
    svg(look, pose) {
      const [state, poseEyes] = POSES[pose] ?? [];
      if (!state) return null;
      const { id, palette, eyes } = parts(look);
      // The look's own eyes stand for the bot at rest; the other poses have the kit's expressions.
      const chosen = poseEyes ?? (pose === "ready" ? eyes : undefined);
      const key = JSON.stringify([id, palette, chosen ?? null, state]);
      if (!made.has(key)) {
        const svg = motion.render(head(id), state, { palette, reducedMotion: true, ...(chosen && { eyes: chosen }) });
        // A title and the blink's stylesheet mean nothing to a gadget.
        made.set(key, svg.replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<style[\s\S]*?<\/style>/g, ""));
        while (made.size > KEPT) made.delete(made.keys().next().value);
      }
      return made.get(key);
    },
  };
}
