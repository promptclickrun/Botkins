import { router } from "expo-router";
import { useState } from "react";
import { LinkError } from "@/link/client";
import type { PairTarget } from "@/link/pairing";
import { pairWith } from "@/state/link";
import { askPersonName } from "./askName";
import { showToast } from "@/state/store";
import { haptic } from "@/ui";

/**
 * Asks "Your name", then pairs with a computer and lands on Home. `error` is what to tell the person
 * when it fails. Closing "Your name" sends nothing.
 */
export function usePairing() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  async function start(target: PairTarget) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      const person = await askPersonName();
      if (!person) return false;
      const pairing = await pairWith(target, person);
      haptic.success();
      showToast("Paired with " + pairing.name, "success");
      router.dismissTo("/");
      return true;
    } catch (reason) {
      haptic.warn();
      setError(reason instanceof LinkError ? reason.message : "Pairing didn't work. Try again.");
      setErrorCode(reason instanceof LinkError ? reason.code : null);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, errorCode, start, clear: () => setError(null) };
}
