// The design kit's own renderers (design/botkins-kit/customize.js and motion/render.js), served
// as one module by vite.config.mjs.
declare module "virtual:botkins-kit" {
  /** shell, accent, faceplate and eye colors. */
  type Palette = [string, string, string, string];
  type RenderOptions = { palette?: string | Palette; eyes?: string; reducedMotion?: boolean; blink?: boolean };
  type MotionState = {
    kind: "activity" | "outcome" | "reaction";
    durationMs: number;
    loop: boolean;
    eyes: string;
    badge: string;
    color: string;
    poses: [number, number, number][];
    mouth: string;
  };
  export const Botkins: {
    /** A head in an eye style and a palette, as an SVG string. `source` is an original SVG from the kit's avatars. */
    render(source: string, eyes?: string, palette?: string | Palette, options?: RenderOptions): string;
    /** By name. Original is null: each character's own colors. */
    palettes: Record<string, Palette | null>;
    eyeStyles: string[];
  };
  export const BotkinsMotion: {
    /** A head acting out a state ("Thinking", "Needs input"…), as an animated SVG string. */
    render(source: string, state: string, options?: RenderOptions): string;
    states: string[];
  };
  export const BotkinsMotionCatalog: {
    states: Record<string, MotionState>;
    icons: Record<string, string>;
    colors: Record<string, string>;
  };
}
