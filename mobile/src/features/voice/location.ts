// Where the phone is, for a live call (live/context.ts decides whether to ask and how long to wait).
// Uses the phone's own location code in src/device: the permission Device access asked for, and
// expo-location. It never asks for permission itself, and never logs what it finds.
import { locationAccess } from "@/device/location";
import { locationModule } from "@/device/native";
import { type LiveLocation, locationFor } from "./live/context";

/** The most a place name may take; the coordinates go without it. */
const GEOCODE_MS = 1000;

export async function readLocation(): Promise<LiveLocation | null> {
  const Location = locationModule();
  if (!Location) return null;
  const access = await locationAccess().catch(() => null);
  if (access?.state !== "granted") return null;
  // A recent fix is instant and close enough for "near"; a fresh one only when there is none.
  const fix =
    (await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 }).catch(() => null)) ??
    (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }).catch(() => null));
  if (!fix) return null;
  const { latitude, longitude } = fix.coords;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const places = await Promise.race([Location.reverseGeocodeAsync({ latitude, longitude }).catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), GEOCODE_MS)))]);
  clearTimeout(timer);
  return locationFor(latitude, longitude, places?.[0]);
}
