// The one place the phone asks the computer for each provider's plan and limits ("provider-usage-v1").
// The computer reads them from the providers with the sign-ins it already has; the phone never asks
// a provider itself and never sees a token. Screens read `useProviderUsage()`.
import { useEffect } from "react";
import { create } from "zustand";
import { onComputerChange } from "./store";
import { cleanUsage } from "@/features/models/limits";
import type { ProviderUsage } from "@/link/types";
import { usePart } from "./hooks";
import { api } from "./link";

type State = {
  /** The last answer. Undefined until the first one arrives. */
  items?: ProviderUsage[];
  /** When the last answer arrived on this phone. */
  fetchedAt?: number;
  loading: boolean;
  /** One sentence when the last ask failed. `items` are then the last ones that arrived, if any. */
  error?: string;
};
// (Named like a hook: the React Compiler treats a call as one only by its name, and would otherwise skip it on some renders.)
const useUsageStore = create<State>(() => ({ loading: false }));
// Plans and limits are one computer's accounts.
onComputerChange(() => useUsageStore.setState({ loading: false }, true));

/** An answer this fresh is not asked for again by a screen that opens. */
const FRESH_MS = 60_000;
let asking: Promise<void> | null = null;

/** Asks the computer. `refresh` has it read the providers again now, not answer from what it has. */
export function loadProviderUsage(refresh = false): Promise<void> {
  if (asking) return asking;
  useUsageStore.setState({ loading: true });
  asking = api
    .providerUsage(refresh ? { refresh: true } : undefined)
    .then(
      (raw) => useUsageStore.setState({ items: cleanUsage(raw), fetchedAt: Date.now(), loading: false, error: undefined }),
      (error: unknown) => useUsageStore.setState({ loading: false, error: error instanceof Error && error.message ? error.message : "Couldn't load the limits." }),
    )
    .finally(() => {
      asking = null;
    });
  return asking;
}

export type ProviderUsageView = State & {
  /** False on a computer that can't say (an older app). Undefined until the computer has said what it can do. */
  supported: boolean | undefined;
  refresh(): Promise<void>;
  /** A provider's entry, by its id. */
  of(provider: string): ProviderUsage | undefined;
};

/** Each provider's plan and limits, asked for when a screen that shows them opens and the last answer is old. */
export function useProviderUsage(): ProviderUsageView {
  const capabilities = usePart("meta")?.capabilities;
  const supported = capabilities ? capabilities.includes("provider-usage-v1") : undefined;
  const state = useUsageStore();
  useEffect(() => {
    if (!supported) return;
    const { fetchedAt, loading } = useUsageStore.getState();
    if (!loading && (!fetchedAt || Date.now() - fetchedAt > FRESH_MS)) void loadProviderUsage();
  }, [supported]);
  return { ...state, supported, refresh: () => loadProviderUsage(true), of: (provider) => state.items?.find((item) => item.provider === provider) };
}

/** Forgets what was loaded (another computer was paired). */
export const resetProviderUsage = () => useUsageStore.setState({ items: undefined, fetchedAt: undefined, loading: false, error: undefined }, true);
