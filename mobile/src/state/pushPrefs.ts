// Plain helpers for per-agent push notification preferences across single-host and unified mode.
// No React Native imports so unit tests can run this directly.
import type { BotNotificationFilter, Parts, PushPrefs } from "@/link/types";
import { hostOfId, unscopeId } from "./unified";

export type HostPushRecord = {
  serverId: string;
  deviceId: string;
  online?: boolean;
  push: PushPrefs | null;
};

export const PUSH_DEFAULTS: PushPrefs = {
  replies: true,
  requests: true,
  routines: true,
  previews: true,
  activities: true,
  updates: true,
  spaces: true,
  bots: { mode: "all", ids: [] },
  mutedBots: [],
};

/**
 * Combines push prefs across one or more paired hosts into a single UI-facing `PushPrefs` view.
 * In unified mode, bot IDs in `bots.ids` and `mutedBots` are already host-scoped in merged `parts.phones`.
 * Returns `null` when no host has push registered.
 */
export function mergePushPrefs(records: HostPushRecord[]): PushPrefs | null {
  const registered = records.filter((r) => r.push != null);
  if (!registered.length) return null;
  const first = registered[0]!.push!;
  if (registered.length === 1) {
    return {
      ...PUSH_DEFAULTS,
      ...first,
      bots: first.bots ? { mode: first.bots.mode, ids: [...(first.bots.ids ?? [])] } : { mode: "all", ids: [] },
      mutedBots: [...(first.mutedBots ?? [])],
    };
  }
  const anyOnly = registered.some((r) => r.push!.bots?.mode === "only");
  const botIds = new Set<string>();
  const muted = new Set<string>();
  for (const r of registered) {
    const p = r.push!;
    if (p.bots?.mode === "only") {
      for (const id of p.bots.ids ?? []) botIds.add(id);
    }
    for (const id of p.mutedBots ?? []) muted.add(id);
  }
  return {
    ...PUSH_DEFAULTS,
    ...first,
    bots: { mode: anyOnly ? "only" : "all", ids: [...botIds] },
    mutedBots: [...muted],
  };
}

/**
 * Extracts `HostPushRecord[]` from the app's synced `parts.phones` and pairings list.
 * In single-host mode, reads only the active pairing; in unified mode, reads every included host.
 */
export function hostPushRecords(
  phones: Parts["phones"] | undefined,
  pairings: { serverId: string; deviceId: string }[],
): HostPushRecord[] {
  return pairings.map((p) => ({
    serverId: p.serverId,
    deviceId: p.deviceId,
    push: phones?.[p.deviceId]?.push ?? null,
  }));
}

/**
 * Plans per-host `link.push.prefs` payloads from a UI patch (whose `bots.ids` and `mutedBots`
 * carry host-scoped bot IDs in unified mode). Each host receives only its own unscoped bot IDs.
 */
export function planPushPrefsUpdate(
  patch: Partial<PushPrefs>,
  hosts: { serverId: string }[],
  primaryId: string | null,
): { serverId: string; prefs: Partial<PushPrefs> }[] {
  const { bots, mutedBots, ...shared } = patch;
  return hosts.map(({ serverId }) => {
    const prefs: Partial<PushPrefs> = { ...shared };
    if (bots !== undefined) {
      const ids = (bots.ids ?? [])
        .filter((id) => hostOfId(id, primaryId) === serverId)
        .map((id) => unscopeId(id));
      prefs.bots = { mode: bots.mode, ids };
    }
    if (mutedBots !== undefined) {
      prefs.mutedBots = mutedBots
        .filter((id) => hostOfId(id, primaryId) === serverId)
        .map((id) => unscopeId(id));
    }
    return { serverId, prefs };
  });
}

/**
 * Plans the single-host `link.push.prefs` update to mute or unmute one bot on its owning host,
 * sending unscoped bot IDs to that host's push record.
 */
export function planBotMuteUpdate(
  botId: string,
  muted: boolean,
  currentMutedScoped: string[],
  primaryId: string | null,
): { serverId: string; mutedBots: string[] } | null {
  const serverId = hostOfId(botId, primaryId);
  if (!serverId) return null;
  const rawId = unscopeId(botId);
  const hostMuted = new Set(
    currentMutedScoped
      .filter((id) => hostOfId(id, primaryId) === serverId)
      .map((id) => unscopeId(id)),
  );
  if (muted) hostMuted.add(rawId);
  else hostMuted.delete(rawId);
  return { serverId, mutedBots: [...hostMuted] };
}

/** Whether a bot is muted in the given push prefs (comparing host-scoped IDs). */
export function isBotMuted(prefs: Pick<PushPrefs, "mutedBots"> | null | undefined, botId: string): boolean {
  return Boolean(prefs?.mutedBots?.includes(botId));
}

/** Toggles a bot in the `only` allowlist while keeping mode `"only"`. */
export function toggleAllowedBot(filter: BotNotificationFilter | undefined, botId: string, on: boolean): BotNotificationFilter {
  const current = new Set(filter?.ids ?? []);
  if (on) current.add(botId);
  else current.delete(botId);
  return { mode: "only", ids: [...current] };
}
