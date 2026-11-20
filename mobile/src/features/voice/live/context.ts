// What the phone tells the computer about itself when a live call starts: roughly where the person
// is, and only while Location is on in Tools › Device access (the switch is the consent). A slow
// fix never holds the call up: whatever hasn't arrived in time is left out. Pure (no React Native),
// so the tests run it. The location is never logged, kept or shown.
import type { DeviceSources, LiveContext } from "@/link/types";

export type LiveLocation = NonNullable<LiveContext["location"]>;
/** The most the call waits for the location. */
export const LOCATION_WAIT_MS = 1500;
const PLACE_MAX = 120;

/** Whether this phone lets live voice say where the person is. */
export const locationOn = (sources: DeviceSources | undefined) => sources?.location === "read" || sources?.location === "interact";

/** About a kilometre: two decimals. */
const rough = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

type Address = { city?: string | null; district?: string | null; subregion?: string | null; region?: string | null; country?: string | null };

/** A fix as the voice is told it: rounded coordinates and the town, region and country, never a street. */
export function locationFor(latitude: number, longitude: number, address?: Address | null): LiveLocation | null {
  const location: LiveLocation = {};
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    location.latitude = rough(latitude);
    location.longitude = rough(longitude);
  }
  const parts = [address?.city || address?.district || address?.subregion, address?.region, address?.country].map((part) => (part ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const place = [...new Set(parts)].join(", ").slice(0, PLACE_MAX).trim();
  if (place) location.place = place;
  return Object.keys(location).length ? location : null;
}

/**
 * The context for a call. `read` finds the location; it is asked only when the switch is on, and
 * only what it gives within `wait` is used. Never throws.
 */
export async function liveContext(sources: DeviceSources | undefined, read: () => Promise<LiveLocation | null>, wait = LOCATION_WAIT_MS): Promise<LiveContext | undefined> {
  if (!locationOn(sources)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const location = await Promise.race([read().catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), wait)))]);
    return location ? { location } : undefined;
  } finally {
    clearTimeout(timer);
  }
}
