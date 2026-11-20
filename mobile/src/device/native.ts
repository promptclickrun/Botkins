// The native packages the device tools use, each loaded the first time it is needed, so a build
// without one still starts; the tool that needs it answers that the app needs an update.
import { DeviceError } from "./args";

type Calendar = typeof import("expo-calendar");
type Contacts = typeof import("expo-contacts");
type Location = typeof import("expo-location");
type Media = typeof import("expo-media-library");
type Manipulator = typeof import("expo-image-manipulator");
type Mail = typeof import("expo-mail-composer");
type Health = typeof import("@kingstinct/react-native-healthkit");

function load<T>(get: () => T): () => T | null {
  let cached: T | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = get();
    } catch {
      cached = null;
    }
    return cached;
  };
}

export const calendarModule = load<Calendar>(() => require("expo-calendar"));
export const contactsModule = load<Contacts>(() => require("expo-contacts"));
export const locationModule = load<Location>(() => require("expo-location"));
export const mediaModule = load<Media>(() => require("expo-media-library"));
export const manipulatorModule = load<Manipulator>(() => require("expo-image-manipulator"));
export const mailModule = load<Mail>(() => require("expo-mail-composer"));
// HealthKit's module throws as it loads when the build lacks its native half.
export const healthModule = load<Health>(() => {
  const module = require("@kingstinct/react-native-healthkit") as Health;
  module.isHealthDataAvailable();
  return module;
});

export const UPDATE_APP = "This needs the newest Botkins app on the phone.";

/** The module, or a failure a bot can read. */
export function need<T>(get: () => T | null): T {
  const module = get();
  if (!module) throw new DeviceError(UPDATE_APP);
  return module;
}
