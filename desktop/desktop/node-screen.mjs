// Computer-control operations (`screen.info`, `screen.capture`, `screen.input`) for a Botkins node host.
// Reuses the desktop's existing screen capture adapter and platform input injector shipped in 0.17.16.
import { cleanEvents, injectorFor } from "./link/input.mjs";

export const MAX_SCREENSHOT_BYTES = 512 * 1024;
const clamp = (value, low, high, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback;

/** Returns display metadata and OS permission status for this node. */
export async function nodeScreenInfo(adapter) {
  if (!adapter || typeof adapter.displays !== "function") {
    return { available: false, displays: [], permissions: null };
  }
  const displays = await adapter.displays();
  const permissions = typeof adapter.permissions === "function" ? await adapter.permissions() : null;
  return {
    available: true,
    displays: Array.isArray(displays) ? displays : [],
    permissions,
  };
}

/** Captures a screenshot of one display on this node, returned as a size-bounded base64 JPEG. */
export async function nodeScreenCapture(adapter, payload = {}) {
  if (!adapter || typeof adapter.capture !== "function") {
    throw new Error("Screen capture is not available on this node.");
  }
  const displays = typeof adapter.displays === "function" ? await adapter.displays() : [];
  const requested = typeof payload.display === "string" && payload.display.trim() ? payload.display.trim() : null;
  const chosen =
    (requested && displays.find((d) => String(d.id) === requested)) ||
    displays.find((d) => d.primary) ||
    displays[0];
  const displayId = requested ?? (chosen ? String(chosen.id) : "1");
  let maxWidth = clamp(payload.maxWidth, 320, 1920, 1280);
  let quality = clamp(payload.quality, 25, 85, 65);

  let frame = await adapter.capture({ display: displayId, maxWidth, quality });
  if (!frame?.jpeg || !Buffer.isBuffer(frame.jpeg)) {
    throw new Error("Screen capture returned no image data.");
  }
  // If the first capture exceeds our transport ceiling, retry once at a tighter size/quality.
  if (frame.jpeg.length > MAX_SCREENSHOT_BYTES) {
    maxWidth = Math.min(maxWidth, 960);
    quality = Math.min(quality, 45);
    frame = await adapter.capture({ display: displayId, maxWidth, quality });
  }
  if (!frame?.jpeg || frame.jpeg.length > MAX_SCREENSHOT_BYTES) {
    throw new Error(`Screenshot exceeds the ${MAX_SCREENSHOT_BYTES}-byte limit.`);
  }
  return {
    displayId,
    width: frame.width ?? chosen?.width ?? 0,
    height: frame.height ?? chosen?.height ?? 0,
    mime: "image/jpeg",
    bytes: frame.jpeg.length,
    dataBase64: frame.jpeg.toString("base64"),
  };
}

/** Validates and injects pointer/keyboard/scroll events on a display of this node. */
export async function nodeScreenInput({ adapter, injector, dirs } = {}, payload = {}) {
  const cleaned = cleanEvents(payload.events);
  if (cleaned.events.length === 0) {
    return { ok: true, count: 0 };
  }
  const displays = adapter && typeof adapter.displays === "function" ? await adapter.displays() : [];
  const requested = typeof payload.display === "string" && payload.display.trim() ? payload.display.trim() : null;
  const chosen =
    (requested && displays.find((d) => String(d.id) === requested)) ||
    displays.find((d) => d.primary) ||
    displays[0];
  const displayId = requested ?? (chosen ? String(chosen.id) : "1");

  const runInject = typeof injector === "function" ? injector : injectorFor(process.platform, dirs);
  if (typeof runInject !== "function") {
    throw new Error("Screen input injection is not available on this platform.");
  }
  await runInject(displayId, cleaned.events);
  return {
    ok: true,
    displayId,
    count: cleaned.events.length,
  };
}
