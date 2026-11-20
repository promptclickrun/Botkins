import { readFileSync } from "node:fs";

const kit = (file) => readFileSync(new URL("./design/botkins-kit/" + file, import.meta.url), "utf8");

/**
 * The design kit's renderers (design/botkins-kit) are plain browser scripts that find each other
 * as globals. This serves the three of them, unchanged, as one module: `virtual:botkins-kit`
 * (typed in src/botkins-kit.d.ts).
 */
const botkinsKit = {
  name: "botkins-kit",
  resolveId: (id) => (id === "virtual:botkins-kit" ? "\0virtual:botkins-kit" : null),
  load: (id) =>
    id === "\0virtual:botkins-kit"
      ? [kit("customize.js"), kit("motion/catalog.js"), kit("motion/render.js"), "export { Botkins, BotkinsMotion, BotkinsMotionCatalog };"].join("\n")
      : null,
};

export default { base: "./", plugins: [botkinsKit] };
