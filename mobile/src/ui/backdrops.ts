// Selectable canvas backdrops that sit behind screens so Liquid Glass surfaces visibly refract them.

export type BackdropId = "clean" | "mesh" | "botkins" | "grid";

export const DEFAULT_BACKDROP: BackdropId = "clean";

export const BACKDROP_IDS: BackdropId[] = ["clean", "mesh", "botkins", "grid"];

export type BackdropDef = {
  id: BackdropId;
  name: string;
  subtitle: string;
};

export const BACKDROPS: BackdropDef[] = [
  { id: "clean", name: "Clean", subtitle: "Solid theme surface" },
  { id: "mesh", name: "Mesh", subtitle: "Vibrant color blobs & diagonal sheen" },
  { id: "botkins", name: "Botkins", subtitle: "Ambient indigo, pink & teal orbs" },
  { id: "grid", name: "Grid", subtitle: "Subtle 28px hairline grid" },
];

/** Type guard for persisted or remote backdrop ids. */
export function isBackdrop(id: unknown): id is BackdropId {
  return typeof id === "string" && (BACKDROP_IDS as readonly string[]).includes(id);
}

/** Look up a backdrop definition, falling back to Clean for unknown or missing ids. */
export function backdropById(id: unknown): BackdropDef {
  return BACKDROPS.find((item) => item.id === id) ?? BACKDROPS[0];
}

/** Base fill behind each backdrop so navigation containers and fades match without seams. */
export function backdropBaseColor(id: BackdropId, dark: boolean, canvas: string): string {
  if (id === "clean") return canvas;
  if (id === "grid") return dark ? "#10131a" : "#f4f6fa";
  return dark ? "#0b0d12" : "#eef1f6";
}
