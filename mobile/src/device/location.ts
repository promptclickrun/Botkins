// Where the phone is, through expo-location: when in use only, never in the background.
import { AppState } from "react-native";
import { type Access, accessOf, requireAccess } from "./access";
import { checkArgs, DeviceError, isoLocal } from "./args";
import { locationModule, need } from "./native";
import { argsOf } from "./tools";
import { compact, round } from "./shape";

type LocationModule = NonNullable<ReturnType<typeof locationModule>>;
type Permission = Awaited<ReturnType<LocationModule["getForegroundPermissionsAsync"]>>;

function locationAccessOf(response: Permission): Access {
  const access = accessOf(response);
  return response.ios?.accuracy === "reduced" && access.state === "granted" ? { ...access, approximate: true } : access;
}

export async function locationAccess(): Promise<Access> {
  const Location = locationModule();
  if (!Location) return { state: "unavailable" };
  return locationAccessOf(await Location.getForegroundPermissionsAsync());
}
export async function askLocation(): Promise<Access> {
  const Location = locationModule();
  if (!Location) return { state: "unavailable" };
  return locationAccessOf(await Location.requestForegroundPermissionsAsync());
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function here(raw: unknown) {
  checkArgs(raw, argsOf("phone_location"));
  const Location = need(locationModule);
  const access = locationAccessOf(await Location.getForegroundPermissionsAsync());
  requireAccess("location", access);
  if (!(await Location.hasServicesEnabledAsync().catch(() => true))) throw new DeviceError("Location Services are off on the phone.");
  // A fresh fix needs the app in front ("when in use"); behind, the last one from the past 10 minutes will do.
  const front = AppState.currentState === "active";
  const fix =
    (front ? await within(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null), 15_000) : null) ??
    (await Location.getLastKnownPositionAsync({ maxAge: front ? 5 * 60_000 : 10 * 60_000 }).catch(() => null));
  if (!fix) throw new DeviceError(front ? "The phone couldn't find where it is just now." : "The phone needs Botkins open to find where it is.");
  const { latitude, longitude, accuracy, altitude } = fix.coords;
  let address: Record<string, unknown> | undefined;
  let line: string | undefined;
  const places = await within(Location.reverseGeocodeAsync({ latitude, longitude }).catch(() => null), 6_000);
  const place = places?.[0];
  if (place) {
    const street = [place.streetNumber, place.street].filter(Boolean).join(" ");
    address = compact({ name: place.name, street: street || undefined, district: place.district, city: place.city, region: place.region, postalCode: place.postalCode, country: place.country, countryCode: place.isoCountryCode });
    line = [street || place.name, place.city, place.region, place.postalCode, place.country].filter(Boolean).join(", ") || undefined;
  }
  return compact({
    latitude: round(latitude, 6),
    longitude: round(longitude, 6),
    accuracyMeters: accuracy !== null ? Math.round(accuracy) : undefined,
    altitudeMeters: altitude !== null ? Math.round(altitude) : undefined,
    approximate: access.approximate,
    at: isoLocal(fix.timestamp),
    address,
    addressLine: line,
  });
}

export const locationTools = { phone_location: here };
