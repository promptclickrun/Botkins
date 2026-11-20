// What iOS lets the app reach for a source. No React Native imports.
import type { DeviceSource } from "@/link/types";
import { DeviceError } from "./args";
import { SOURCE_NAMES } from "./tools";

export type Access = {
  /**
   * granted: everything the level needs. limited: some of it (some photos, some contacts).
   * asked: iOS was asked, and it never says what the person chose (Health's reading).
   * denied: refused; only Settings can change it. undetermined: not asked yet.
   * unavailable: this phone or build can't do it.
   */
  state: "granted" | "limited" | "asked" | "denied" | "undetermined" | "unavailable";
  /** Only approximate (Location). */
  approximate?: boolean;
  /** A plain sentence when it is unavailable. */
  reason?: string;
};

/** The usual permission answer from an Expo module, as an Access. */
export function accessOf(response: { granted: boolean; canAskAgain?: boolean; status?: string; accessPrivileges?: string }): Access {
  if (response.granted) return { state: response.accessPrivileges === "limited" ? "limited" : "granted" };
  if (response.status === "undetermined" && response.canAskAgain !== false) return { state: "undetermined" };
  return { state: "denied" };
}

/** Fails with a sentence a bot can read unless the source can be used now. */
export function requireAccess(source: DeviceSource, access: Access): void {
  if (access.state === "granted" || access.state === "limited" || access.state === "asked") return;
  if (access.state === "unavailable") throw new DeviceError(access.reason ?? SOURCE_NAMES[source] + " isn't available on this phone.");
  if (access.state === "undetermined") throw new DeviceError(SOURCE_NAMES[source] + " access isn't set up yet. The person can turn " + SOURCE_NAMES[source] + " on again in Botkins on their phone.");
  throw new DeviceError(SOURCE_NAMES[source] + " access is off in iOS Settings.");
}
