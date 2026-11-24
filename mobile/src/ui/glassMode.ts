// Pure decision logic for Glass surface rendering: Liquid Glass, BlurView, or opaque fallback.

export type GlassSurfaceMode = "liquid" | "blur" | "opaque";

export function resolveGlassMode({
  liquidAvailable,
  reduceTransparency,
  opaque,
}: {
  liquidAvailable: boolean;
  reduceTransparency: boolean;
  opaque?: boolean;
}): GlassSurfaceMode {
  if (opaque || reduceTransparency) return "opaque";
  return liquidAvailable ? "liquid" : "blur";
}
