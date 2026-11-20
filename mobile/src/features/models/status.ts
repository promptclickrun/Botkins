import type { ProviderStatus } from "@/link/types";
import type { Tone } from "@/ui";

/** A provider's state in a word or two, for its badge. */
export function providerBadge(provider: ProviderStatus): { label: string; tone: Tone } {
  if (!provider.installed) return { label: "Not installed", tone: "warning" };
  if (!provider.enabled) return { label: "Off", tone: "neutral" };
  if (provider.starting) return { label: "Starting…", tone: "info" };
  if (provider.error) return { label: "Problem", tone: "danger" };
  if (provider.connected) return { label: "Connected", tone: "success" };
  return { label: "Sign in", tone: "accent" };
}

/** The line under a provider's name: who is signed in, else what to do. */
export function providerLine(provider: ProviderStatus) {
  if (provider.connected && (provider.account || provider.plan)) return [provider.account, provider.plan].filter(Boolean).join(" · ");
  return provider.error ?? provider.message ?? provider.description;
}
