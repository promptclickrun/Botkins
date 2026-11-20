// Botkins computers on this network (Bonjour), for pairing without typing an address and for
// finding a paired computer again when its address changed.
import { useEffect, useState } from "react";
import { normalizeHost } from "@/link/pairing";
import { Nearby, type NearbyComputer, type NearbyState, watchNearby } from "../../modules/botkins-nearby";

export type { NearbyComputer };
/** Whether this build can look for computers by itself. Without it the person types an address. */
export const canLookNearby = !!Nearby;

const usable = (computer: NearbyComputer) => ({ ...computer, host: (computer.host && normalizeHost(computer.host)) || undefined });

/** The computers found while `on` holds. `blocked` means the phone won't let the app see the local network. */
export function useNearby(on: boolean): { computers: NearbyComputer[]; looking: boolean; blocked: boolean } {
  const [state, setState] = useState<NearbyState>({ computers: [], looking: false });
  useEffect(() => {
    if (!on || !canLookNearby) return;
    setState({ computers: [], looking: true });
    return watchNearby((next) => setState(next));
  }, [on]);
  const computers = on ? state.computers.map(usable) : [];
  // The system refuses with a policy error until the person allows the local network.
  const blocked = on && !computers.length && /polic|denied|NoAuth|-65570/i.test(state.problem ?? "");
  return { computers, looking: on && canLookNearby && !blocked, blocked };
}

/** Looks for the computer with this id for a few seconds. Its "address:port", or null. */
export function findNearby(serverId: string, ms = 8000): Promise<string | null> {
  if (!canLookNearby) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (host: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolve(host);
    };
    const stop = watchNearby((state) => {
      const match = state.computers.map(usable).find((computer) => computer.id === serverId && computer.host);
      if (match?.host) finish(match.host);
    });
    const timer = setTimeout(() => finish(null), ms);
  });
}
