// Botkins computers on the local network, found by Bonjour. The native piece is iPhone only; where
// it is missing (Android, or a build made before it existed) `Nearby` is null and nothing is found.
import { type EventSubscription, requireOptionalNativeModule } from "expo";

export type NearbyComputer = {
  /** The computer's name, as its own settings show it. */
  name: string;
  /** The computer's id: what its hello answers as `serverId`. */
  id?: string;
  /** The link protocol's version, as text. */
  version?: string;
  /** "address:port", once the phone has learned it. */
  host?: string;
};
export type NearbyState = { computers: NearbyComputer[]; looking: boolean; problem?: string };

type NearbyModule = { addListener(event: "onChange", listener: (state: NearbyState) => void): EventSubscription };

export const Nearby = requireOptionalNativeModule<NearbyModule>("BotkinsNearby");

/** Looks for computers until the returned function is called. Each change gives the whole list. */
export function watchNearby(listener: (state: NearbyState) => void): () => void {
  if (!Nearby) return () => {};
  const subscription = Nearby.addListener("onChange", listener);
  return () => subscription.remove();
}
