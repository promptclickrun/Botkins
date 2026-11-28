// Plain logic for Settings › Storage (no React Native imports, so mobile tests run it directly).

export type DayPreset = "7" | "14" | "30" | "90" | "custom";

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return Math.max(0, Math.round(bytes || 0)) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function presetForDays(days: number): DayPreset {
  if (days === 7) return "7";
  if (days === 14) return "14";
  if (days === 30) return "30";
  if (days === 90) return "90";
  return "custom";
}

export function parseCustomDays(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
}

export const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + " MB";
