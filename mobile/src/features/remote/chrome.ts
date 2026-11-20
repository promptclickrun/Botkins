// The Screen's fixed look. The picture of the computer sits on black whatever the app's theme,
// so the controls over it use one dark, translucent style of their own.

export const chrome = {
  stage: "#000000",
  glass: "rgba(24,20,18,0.78)",
  glassLine: "rgba(255,255,255,0.12)",
  key: "rgba(255,255,255,0.12)",
  keyOn: "rgba(255,255,255,0.92)",
  ink: "#FFFFFF",
  inkOn: "#1A1412",
  muted: "rgba(255,255,255,0.7)",
  warn: "rgba(232,169,69,0.95)",
} as const;

export type QualityId = "sharp" | "balanced" | "saver";
export const QUALITY: Record<QualityId, { title: string; maxWidth: number; quality: number }> = {
  sharp: { title: "Sharp", maxWidth: 1600, quality: 70 },
  balanced: { title: "Balanced", maxWidth: 1280, quality: 60 },
  saver: { title: "Data saver", maxWidth: 800, quality: 45 },
};

/** How long the floating bar stays after the last touch. */
export const BAR_HIDE_MS = 3000;
