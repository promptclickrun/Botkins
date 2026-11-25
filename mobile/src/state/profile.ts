// Profile identity is optional. The session, pending verifier and profile-enrolled pairings all
// stay in this phone's native keychain; local/manual pairings are owned by state/link and are never
// removed by profile sign-out.
import { AppState } from "react-native";
import * as Network from "expo-network";
import { create } from "zustand";
import type { Pairing } from "@/link/client";
import { PROFILE_ORIGIN, profileApi, ProfileError, type ProfileAttempt, type ProfileHost, type ProfileHome, type ProfileSession } from "@/link/profile";
import { deviceName, activateProfilePairing, bindProfileHost, connectProfileHost, deactivateProfilePairing, dropProfileBoundPairings, unbindProfileHost } from "@/state/link";
import { forget, keep, readKept } from "@/state/keep";
import { startupProfilePairing } from "@/state/computers";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { profileHostsOf, profilePrompt, type ProfilePrompt } from "@/features/profile/profileLogic";

export const PROFILE_SESSION_KEY = "botkins.profile.session.v1";
export const PROFILE_ATTEMPT_KEY = "botkins.profile.attempt.v1";
export const PROFILE_CHOICE_KEY = "botkins.profile.choice.v1";
export const PROFILE_CANCELED_SESSION_KEY = "botkins.profile.canceled.v1";
/** Legacy pre-index blob. New profile pairings are one key per host. */
export const PROFILE_PAIRINGS_KEY = "botkins.profile.pairings.v1";
export const PROFILE_PAIRINGS_INDEX_KEY = "botkins.profile.pairings.index.v1";
export const PROFILE_CURRENT_KEY = "botkins.profile.current.v1";
export const PROFILE_BOUND_KEY = "botkins.profile.bound.v1";
export const PROFILE_EXCLUDED_KEY = "botkins.profile.excluded.v1";
export const PROFILE_REMOVALS_KEY = "botkins.profile.removals.v1";

type ProfileState = {
  loaded: boolean;
  session: ProfileSession | null;
  attempt: ProfileAttempt | null;
  home: ProfileHome | null;
  pairings: Record<string, Pairing>;
  boundLocal: string[];
  excluded: string[];
  pendingRemovals: string[];
  prompt: ProfilePrompt;
  busy: boolean;
  error: string | null;
};

const empty: ProfileState = { loaded: false, session: null, attempt: null, home: null, pairings: {}, boundLocal: [], excluded: [], pendingRemovals: [], prompt: null, busy: false, error: null };
export const useProfile = create<ProfileState>(() => empty);

/** The profile's hosts, the same empty list while there is no profile (see `profileHostsOf`). */
export function useProfileHosts(): ProfileHost[] {
  return useProfile(profileHostsOf);
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const validSession = (value: unknown): value is ProfileSession => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return text(item.token) && text(item.profileId) && text(item.deviceId) && typeof item.name === "string" && typeof item.email === "string";
};
type CanceledSession = { profileId: string; deviceId: string; token: string };
const validCanceledSession = (value: unknown): value is CanceledSession => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return text(item.profileId) && text(item.deviceId) && text(item.token);
};
const canceledSessionMarker = (session: ProfileSession) =>
  JSON.stringify({ profileId: session.profileId, deviceId: session.deviceId, token: session.token });
const matchesCanceledSession = (session: ProfileSession, value: string | null) => {
  const canceled = parse(value, validCanceledSession);
  return Boolean(
    canceled &&
    canceled.profileId === session.profileId &&
    canceled.deviceId === session.deviceId &&
    canceled.token === session.token,
  );
};
const validAttempt = (value: unknown): value is ProfileAttempt => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return text(item.id) && text(item.verifier) && item.url === PROFILE_ORIGIN + "/#" + item.id && /^\d{6}$/.test(String(item.code));
};
const validPairing = (value: unknown): value is Pairing => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return text(item.serverId) && text(item.serverKey) && text(item.deviceId) && text(item.secretKey) && typeof item.name === "string" && Array.isArray(item.hosts) && item.hosts.every((host) => typeof host === "string");
};

const safeKeyPart = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
/** A profile host key is account-bound, so another signed-in profile cannot read it. */
export const profilePairingKey = (profileId: string, serverId: string) => "botkins.profile." + safeKeyPart(profileId) + ".host." + safeKeyPart(serverId);

function parse<T>(value: string | null, check: (value: unknown) => value is T): T | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return check(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePairings(value: string | null): Record<string, Pairing> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as { list?: unknown };
    if (!Array.isArray(parsed.list)) return {};
    return Object.fromEntries(parsed.list.filter(validPairing).map((pairing) => [pairing.serverId, pairing]));
  } catch {
    return {};
  }
}

function parseIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { ids?: unknown };
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => text(id)) : [];
  } catch {
    return [];
  }
}

function parseAccountIds(value: string | null, profileId: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { profileId?: unknown; ids?: unknown };
    return parsed.profileId === profileId && Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => text(id)).slice(0, 100) : [];
  } catch {
    return [];
  }
}

const parseBound = parseAccountIds;

async function readProfilePairings(profileId: string, indexText: string | null, legacyText: string | null): Promise<Record<string, Pairing>> {
  let owner: unknown;
  try { owner = indexText ? (JSON.parse(indexText) as { profileId?: unknown }).profileId : undefined; } catch { owner = undefined; }
  const ids = owner === profileId ? parseIds(indexText) : [];
  const records = await Promise.all(ids.map(async (serverId) => [serverId, await readKept(profilePairingKey(profileId, serverId))] as const));
  const pairings = Object.fromEntries(records.map(([serverId, text]) => [serverId, parse(text, validPairing)]).filter((entry): entry is [string, Pairing] => !!entry[1]));
  // Migrate the old single SecureStore value once, without making it the long-term storage shape.
  if (!ids.length && legacyText) {
    const legacy = parsePairings(legacyText);
    if (Object.keys(legacy).length) {
      await savePairings(profileId, legacy, []).catch(() => {});
      await forget(PROFILE_PAIRINGS_KEY).catch(() => {});
    }
    return legacy;
  }
  return pairings;
}

let profileStorageQueue: Promise<void> = Promise.resolve();
function queueProfileStorage(work: () => Promise<void>): Promise<void> {
  const next = profileStorageQueue.then(work, work);
  profileStorageQueue = next.catch(() => {});
  return next;
}

function savePairings(profileId: string, pairings: Record<string, Pairing>, previousIds?: ReadonlyArray<string>) {
  return queueProfileStorage(async () => {
    const ids = Object.keys(pairings);
    const old = new Set(previousIds ?? parseIds(await readKept(PROFILE_PAIRINGS_INDEX_KEY).catch(() => null)));
    await Promise.all([...old].filter((serverId) => !pairings[serverId]).map((serverId) => forget(profilePairingKey(profileId, serverId))));
    await Promise.all(Object.values(pairings).map((pairing) => keep(profilePairingKey(profileId, pairing.serverId), JSON.stringify(pairing))));
    await keep(PROFILE_PAIRINGS_INDEX_KEY, JSON.stringify({ profileId, ids }));
  });
}

function clearProfilePairings(profileId: string, ids?: ReadonlyArray<string>) {
  return queueProfileStorage(async () => {
    const index = parseIds(await readKept(PROFILE_PAIRINGS_INDEX_KEY).catch(() => null));
    const remove = [...new Set(ids ?? index)];
    await Promise.all(remove.map((serverId) => forget(profilePairingKey(profileId, serverId)).catch(() => {})));
    const saved = await readKept(PROFILE_PAIRINGS_INDEX_KEY).catch(() => null);
    let owner: unknown;
    try { owner = saved ? (JSON.parse(saved) as { profileId?: unknown }).profileId : undefined; } catch { owner = undefined; }
    if (!saved || owner === profileId) await forget(PROFILE_PAIRINGS_INDEX_KEY).catch(() => {});
    await forget(PROFILE_PAIRINGS_KEY).catch(() => {});
  });
}

const saveCurrent = (profileId: string, serverId: string) => queueProfileStorage(() => keep(PROFILE_CURRENT_KEY, JSON.stringify({ profileId, serverId })));
const clearCurrent = () => queueProfileStorage(() => forget(PROFILE_CURRENT_KEY));
const saveSession = (session: ProfileSession) => queueProfileStorage(() => keep(PROFILE_SESSION_KEY, JSON.stringify(session)));
const clearSession = () => queueProfileStorage(() => forget(PROFILE_SESSION_KEY));
const clearBound = () => queueProfileStorage(() => forget(PROFILE_BOUND_KEY));
const saveAccountIds = (key: string, profileId: string, ids: ReadonlyArray<string>) => queueProfileStorage(() => keep(key, JSON.stringify({ profileId, ids: [...new Set(ids)] })));
const clearAccountIds = (key: string) => queueProfileStorage(() => forget(key));
const saveExcluded = (profileId: string, ids: ReadonlyArray<string>) => saveAccountIds(PROFILE_EXCLUDED_KEY, profileId, ids);
const clearExcluded = () => clearAccountIds(PROFILE_EXCLUDED_KEY);
const savePendingRemovals = (profileId: string, ids: ReadonlyArray<string>) => saveAccountIds(PROFILE_REMOVALS_KEY, profileId, ids);
const clearPendingRemovals = () => clearAccountIds(PROFILE_REMOVALS_KEY);

function parseCurrent(value: string | null, profileId: string): string | null {
  if (!value) return null;
  try {
    const saved = JSON.parse(value) as { profileId?: unknown; serverId?: unknown };
    return saved.profileId === profileId && text(saved.serverId) ? saved.serverId : null;
  } catch {
    return null;
  }
}

export async function onProfilePairingHosts(pairing: Pairing) {
  const current = useProfile.getState().pairings[pairing.serverId];
  if (!current || current.hosts.join("\n") === pairing.hosts.join("\n")) return;
  const next = { ...useProfile.getState().pairings, [pairing.serverId]: pairing };
  const session = useProfile.getState().session;
  if (!session) return;
  const generation = authGeneration;
  const profileId = session.profileId;
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return;
  await savePairings(profileId, next, Object.keys(useProfile.getState().pairings));
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return;
  useProfile.setState({ pairings: next });
  await putDirectoryHost(session, hostOf(pairing), true);
}

async function saveBound(profileId: string, ids: ReadonlyArray<string>) {
  await queueProfileStorage(() => keep(PROFILE_BOUND_KEY, JSON.stringify({ profileId, ids: [...new Set(ids)].slice(0, 100) })));
}

async function setExcluded(session: ProfileSession, ids: ReadonlyArray<string>) {
  const next = [...new Set(ids)];
  await saveExcluded(session.profileId, next);
  if (useProfile.getState().session?.token === session.token) useProfile.setState({ excluded: next });
}

async function allowProfileHost(session: ProfileSession, serverId: string) {
  const excluded = useProfile.getState().excluded;
  if (excluded.includes(serverId)) await setExcluded(session, excluded.filter((id) => id !== serverId));
  const pending = useProfile.getState().pendingRemovals;
  if (pending.includes(serverId)) {
    const next = pending.filter((id) => id !== serverId);
    await savePendingRemovals(session.profileId, next);
    if (useProfile.getState().session?.token === session.token) useProfile.setState({ pendingRemovals: next });
  }
}

function profileInvalid(error: unknown): boolean {
  return error instanceof ProfileError && error.status === 401;
}

const directoryCache = new Map<string, { fingerprint: string; bound: boolean }>();
let authGeneration = 0;
const directoryFingerprint = (host: ProfileHost) => JSON.stringify([host.serverId, host.serverKey, host.name, host.hosts, host.member === true]);

async function putDirectoryHost(session: ProfileSession, host: ProfileHost, bound: boolean) {
  const generation = authGeneration;
  const fingerprint = directoryFingerprint(host);
  const key = session.profileId + ":" + host.serverId;
  const cached = directoryCache.get(key);
  if (cached?.fingerprint === fingerprint && cached.bound === bound) return true;
  try {
    await profileApi.putHost(session.token, host);
    if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return false;
    directoryCache.set(key, { fingerprint, bound });
    return true;
  } catch (error) {
    if (generation !== authGeneration) return false;
    if (profileInvalid(error)) invalidate();
    else useProfile.setState({ error: error instanceof Error ? error.message : "The profile host could not be saved." });
    return false;
  }
}

async function retryPendingHostRemovals(session: ProfileSession) {
  let remaining = useProfile.getState().pendingRemovals.slice();
  if (!remaining.length) return;
  const generation = authGeneration;
  for (const serverId of remaining) {
    if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return;
    try {
      await profileApi.removeHost(session.token, serverId);
      directoryCache.delete(session.profileId + ":" + serverId);
      remaining = remaining.filter((id) => id !== serverId);
    } catch (error) {
      if (profileInvalid(error)) { invalidate(); return; }
      // Keep it pending for the next foreground/reachability retry.
    }
  }
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return;
  if (remaining.length !== useProfile.getState().pendingRemovals.length) {
    await (remaining.length ? savePendingRemovals(session.profileId, remaining) : clearPendingRemovals());
    useProfile.setState({ pendingRemovals: remaining });
  }
}

function invalidate() {
  authGeneration += 1;
  directoryCache.clear();
  const bound = useProfile.getState().boundLocal;
  const session = useProfile.getState().session;
  deactivateProfilePairing();
  void dropProfileBoundPairings(bound);
  void Promise.all([clearSession(), session ? clearProfilePairings(session.profileId) : Promise.resolve(), clearBound(), clearCurrent(), clearExcluded(), clearPendingRemovals()]).catch(() => {});
  useProfile.setState({ session: null, home: null, pairings: {}, boundLocal: [], excluded: [], pendingRemovals: [], attempt: null, prompt: null, error: "Your Botkins profile session expired. Sign in again." });
}

async function profileCall<T>(work: () => Promise<T>, generation = authGeneration): Promise<T | undefined> {
  try {
    const result = await work();
    return generation === authGeneration ? result : undefined;
  } catch (error) {
    if (generation !== authGeneration) return undefined;
    if (profileInvalid(error)) invalidate();
    else useProfile.setState({ error: error instanceof Error ? error.message : "The profile service is unavailable." });
    return undefined;
  }
}

/** Reads keychain state once. `pairings` is passed by the app after local link boot. */
export async function loadProfile(localPairings = useApp.getState().pairings.length) {
  if (useProfile.getState().loaded) return;
  if (profileLoading) return profileLoading;
  profileLoading = (async () => {
    let values: [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null];
    try {
      values = await Promise.all([
        readKept(PROFILE_SESSION_KEY),
        readKept(PROFILE_ATTEMPT_KEY),
        readKept(PROFILE_CHOICE_KEY),
        readKept(PROFILE_CANCELED_SESSION_KEY),
        readKept(PROFILE_PAIRINGS_INDEX_KEY),
        readKept(PROFILE_PAIRINGS_KEY),
        readKept(PROFILE_BOUND_KEY),
        readKept(PROFILE_CURRENT_KEY),
        readKept(PROFILE_EXCLUDED_KEY),
        readKept(PROFILE_REMOVALS_KEY),
      ]);
    } catch {
      // Protected storage being locked is not a signed-out profile. Leave state untouched and
      // retry when the person brings the app to the foreground after unlocking the phone.
      retryProfileOnActive();
      return;
    }
    const [sessionText, attemptText, choice, canceledText, pairingsIndex, legacyPairings, boundText, currentText, excludedText, removalsText] = values;
    const storedSession = parse(sessionText, validSession);
    const canceled = Boolean(storedSession && matchesCanceledSession(storedSession, canceledText));
    const session = canceled ? null : storedSession;
    if (canceled) {
      await queueProfileStorage(async () => {
        try {
          await forget(PROFILE_SESSION_KEY);
          await forget(PROFILE_CANCELED_SESSION_KEY).catch(() => {});
        } catch {
          // Keep the canceled marker so the next launch stays signed out and retries cleanup.
        }
      });
    } else if (!storedSession && canceledText) {
      void queueProfileStorage(() => forget(PROFILE_CANCELED_SESSION_KEY).catch(() => {}));
    }
    const attempt = parse(attemptText, validAttempt);
    let pairings: Record<string, Pairing>;
    try {
      pairings = session ? await readProfilePairings(session.profileId, pairingsIndex, legacyPairings) : {};
    } catch {
      retryProfileOnActive();
      return;
    }
    const boundLocal = session ? parseBound(boundText, session.profileId) : [];
    const excluded = session ? parseAccountIds(excludedText, session.profileId) : [];
    const pendingRemovals = session ? parseAccountIds(removalsText, session.profileId) : [];
    useProfile.setState({ loaded: true, session, attempt, pairings, boundLocal, excluded, pendingRemovals, prompt: profilePrompt({ pairings: localPairings, session, choice, pending: attempt }), error: null });
    retryProfileSubscription?.remove();
    retryProfileSubscription = null;
    registerLifecycle();
    if (session) {
      const primary = usePrefs.getState().primaryHost;
      const local = useApp.getState().pairings;
      const last = parseCurrent(currentText, session.profileId);
      const initial = startupProfilePairing(primary, last, local, pairings, boundLocal);
      if (initial) activateProfilePairing(initial);
      void refreshProfile();
    }
    if (attempt && AppState.currentState === "active") void finishPending();
  })();
  try {
    await profileLoading;
  } finally {
    profileLoading = null;
  }
}

let lifecycleRegistered = false;
let profileLoading: Promise<void> | null = null;
let retryProfileSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
function retryProfileOnActive() {
  retryProfileSubscription ??= AppState.addEventListener("change", (next) => {
    if (next === "active" && !useProfile.getState().loaded) void loadProfile();
  });
}
function registerLifecycle() {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;
  AppState.addEventListener("change", (next) => {
    // There is intentionally no timer: returning to the foreground resumes a pending browser
    // acceptance and retries offline host enrollment once the phone is reachable again.
    if (next === "active") {
      if (useProfile.getState().attempt) void finishPending();
      if (useProfile.getState().session) void syncLocalPairings();
    }
  });
  try {
    Network.addNetworkStateListener((state) => {
      if (state.isConnected && AppState.currentState === "active" && useProfile.getState().session) void syncLocalPairings();
    });
  } catch {
    // A build without the network module still retries when the app returns to the foreground.
  }
}

export async function dismissPrompt() {
  authGeneration += 1;
  useProfile.setState({ prompt: null, attempt: null, busy: false, error: null });
  await queueProfileStorage(async () => {
    await Promise.all([
      keep(PROFILE_CHOICE_KEY, "dismissed").catch(() => {}),
      forget(PROFILE_ATTEMPT_KEY).catch(() => {}),
    ]);
  });
}

export async function beginProfile(label = deviceName()): Promise<ProfileAttempt | undefined> {
  if (useProfile.getState().busy) return undefined;
  const generation = authGeneration;
  useProfile.setState({ busy: true, error: null });
  try {
    const attempt = await profileApi.start(label.trim() || deviceName());
    if (generation !== authGeneration) return undefined;
    await queueProfileStorage(async () => {
      if (generation !== authGeneration) return;
      await keep(PROFILE_ATTEMPT_KEY, JSON.stringify(attempt));
    });
    if (generation !== authGeneration) return undefined;
    useProfile.setState({ attempt, busy: false, prompt: null });
    return attempt;
  } catch (error) {
    if (generation !== authGeneration) return undefined;
    useProfile.setState({ busy: false, error: error instanceof Error ? error.message : "The profile sign-in could not start." });
    return undefined;
  }
}

/** Discards an expired browser request so a fresh six-digit request can be started. */
export async function restartProfileAttempt() {
  authGeneration += 1;
  useProfile.setState({ attempt: null, busy: false, error: null });
  await queueProfileStorage(() => forget(PROFILE_ATTEMPT_KEY).catch(() => {}));
}

export async function finishPending(): Promise<ProfileSession | null | undefined> {
  const attempt = useProfile.getState().attempt;
  if (!attempt || useProfile.getState().busy) return undefined;
  let generation = authGeneration;
  useProfile.setState({ busy: true, error: null });
  const session = await profileCall(() => profileApi.finish(attempt), generation);
  if (generation !== authGeneration || useProfile.getState().attempt !== attempt) return undefined;
  if (session === undefined) {
    useProfile.setState({ busy: false });
    return undefined;
  }
  if (!session) {
    useProfile.setState({ busy: false });
    return null;
  }
  const previous = useProfile.getState().session;
  let committed = false;
  try {
    if (previous && previous.profileId !== session.profileId) {
      generation = ++authGeneration;
      await clearProfilePairings(previous.profileId, Object.keys(useProfile.getState().pairings));
      await clearCurrent();
      await dropProfileBoundPairings(useProfile.getState().boundLocal);
      await clearBound();
      await clearExcluded();
      await clearPendingRemovals();
      if (generation !== authGeneration) return undefined;
      useProfile.setState({ pairings: {}, boundLocal: [], excluded: [], pendingRemovals: [] });
    }
    await queueProfileStorage(async () => {
      if (generation !== authGeneration) return;
      let wroteSession = false;
      try {
        await keep(PROFILE_SESSION_KEY, JSON.stringify(session));
        wroteSession = true;
        if (generation !== authGeneration) return;
        await keep(PROFILE_CHOICE_KEY, "enrolled");
        if (generation !== authGeneration) return;
        await forget(PROFILE_CANCELED_SESSION_KEY).catch(() => {});
        await forget(PROFILE_ATTEMPT_KEY).catch(() => {});
        if (generation !== authGeneration) return;
        committed = true;
        useProfile.setState({ session, attempt: null, prompt: null, busy: false, error: null });
      } finally {
        if (wroteSession && !committed) {
          try {
            await forget(PROFILE_SESSION_KEY);
          } catch {
            if (generation !== authGeneration) {
              await keep(PROFILE_CANCELED_SESSION_KEY, canceledSessionMarker(session)).catch(() => {});
            }
          }
        }
      }
    });
  } catch (error) {
    if (generation !== authGeneration || useProfile.getState().attempt !== attempt) return undefined;
    useProfile.setState({
      busy: false,
      error: error instanceof Error && error.message ? error.message : "The profile session could not be saved.",
    });
    return undefined;
  }
  if (!committed || generation !== authGeneration) return undefined;
  await refreshProfile();
  void syncLocalPairings();
  return session;
}

export async function refreshProfile(): Promise<ProfileHome | undefined> {
  const session = useProfile.getState().session;
  if (!session) return undefined;
  const generation = authGeneration;
  const home = await profileCall(() => profileApi.home(session.token));
  if (home && generation === authGeneration && useProfile.getState().session?.token === session.token) useProfile.setState({ home });
  return home;
}

export async function updateProfile(name: string, avatar?: string) {
  const session = useProfile.getState().session;
  if (!session || !name.trim()) return false;
  const result = await profileCall(() => profileApi.update(session.token, name.trim(), avatar));
  if (result === undefined) return false;
  const next = { ...session, name: name.trim() };
  await saveSession(next);
  if (useProfile.getState().session?.token === session.token) useProfile.setState({ session: next });
  await refreshProfile();
  return true;
}

function hostOf(pairing: Pairing): ProfileHost {
  return { serverId: pairing.serverId, serverKey: pairing.serverKey, name: pairing.name, hosts: pairing.hosts, ...(pairing.member && { member: true }) };
}

/** Upgrades a legacy authorized device in place. The host marks that calling key profile-bound. */
async function bindLocal(pairing: Pairing, session: ProfileSession): Promise<ProfileHost> {
  const bound = useProfile.getState().boundLocal;
  if (bound.includes(pairing.serverId)) return hostOf(pairing);
  const descriptor = await bindProfileHost(pairing, () => profileApi.proof(session.token, "bind", pairing.serverId, pairing.serverKey));
  if (useProfile.getState().session?.token !== session.token) throw new Error("The profile changed while this computer was being enrolled.");
  const next = [...new Set([...useProfile.getState().boundLocal, pairing.serverId])];
  await saveBound(session.profileId, next);
  useProfile.setState({ boundLocal: next });
  return descriptor;
}

async function enroll(host: ProfileHost, activate = false, purpose: "bind" | "connect" = "bind") {
  const state = useProfile.getState();
  const session = state.session;
  if (!session) return undefined;
  const generation = authGeneration;
  const local = useApp.getState().pairings.find((pairing) => pairing.serverId === host.serverId);
  if (local) {
    await bindLocal(local, session);
    if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) throw new Error("The profile changed while this computer was being enrolled.");
    if (activate) activateProfilePairing(local);
    return local;
  }
  const existing = state.pairings[host.serverId];
  if (existing) {
    if (activate) activateProfilePairing(existing);
    return existing;
  }
  let ticketError: unknown;
  let pairing: Pairing;
  try {
    pairing = await connectProfileHost(host, (publicKey) => profileApi.proof(session.token, purpose, host.serverId, host.serverKey, publicKey).catch((error) => { ticketError = error; throw error; }), session.name);
  } catch (error) {
    if (ticketError && profileInvalid(ticketError)) invalidate();
    throw error;
  }
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) throw new Error("The profile changed while this computer was being enrolled.");
  const next = { ...useProfile.getState().pairings, [pairing.serverId]: pairing };
  await savePairings(session.profileId, next, Object.keys(useProfile.getState().pairings));
  useProfile.setState({ pairings: next });
  if (activate) {
    activateProfilePairing(next[pairing.serverId]);
    await saveCurrent(session.profileId, pairing.serverId);
  }
  return next[pairing.serverId];
}

/** Enrolls a directory host on selection, with a bounded failure left retryable from the page. */
export async function selectProfileHost(host: ProfileHost): Promise<Pairing | undefined> {
  const session = useProfile.getState().session;
  if (!session) return undefined;
  useProfile.setState({ busy: true, error: null });
  try {
    await allowProfileHost(session, host.serverId);
    const local = useApp.getState().pairings.some((pairing) => pairing.serverId === host.serverId);
    const pairing = await enroll(host, true, local ? "bind" : "connect");
    const currentSession = useProfile.getState().session;
    if (pairing && currentSession?.profileId) await saveCurrent(currentSession.profileId, pairing.serverId);
    useProfile.setState({ busy: false });
    return pairing;
  } catch (error) {
    if (profileInvalid(error)) invalidate();
    useProfile.setState({ busy: false, error: error instanceof Error ? error.message : "That computer could not be enrolled right now." });
    return undefined;
  }
}

/** Registers and enrolls every local pairing without changing which computer the app is using. */
async function syncLocalPairingsNow() {
  const session = useProfile.getState().session;
  if (!session || AppState.currentState !== "active") return;
  await retryPendingHostRemovals(session);
  if (useProfile.getState().session?.token !== session.token) return;
  const excluded = new Set(useProfile.getState().excluded);
  const local = useApp.getState().pairings.filter((pairing) => !excluded.has(pairing.serverId));
  for (const pairing of local) {
    if (AppState.currentState !== "active" || useProfile.getState().session?.token !== session.token) return;
    let host: ProfileHost;
    try {
      host = await bindLocal(pairing, session);
    } catch (error) {
      // Offline or an older host is retried on the next foreground event; never publish an
      // unverified descriptor. An existing directory entry remains visible as awaiting transfer.
      if (profileInvalid(error)) { invalidate(); return; }
      continue;
    }
    await putDirectoryHost(session, host, true);
  }
  await refreshProfile();
}

let syncing: Promise<void> | null = null;
export function syncLocalPairings(): Promise<void> {
  syncing ??= syncLocalPairingsNow().finally(() => { syncing = null; });
  return syncing;
}

/** Called by pairing/join flows after a new local authorization is saved. */
export async function onLocalPairing(pairing: Pairing) {
  const session = useProfile.getState().session;
  if (!session || AppState.currentState !== "active") return;
  await allowProfileHost(session, pairing.serverId);
  let host: ProfileHost;
  try { host = await bindLocal(pairing, session); } catch (error) {
    if (profileInvalid(error)) invalidate();
    else useProfile.setState({ error: "Profile transfer is waiting for this computer to come online." });
    return;
  }
  await putDirectoryHost(session, host, true);
  await refreshProfile();
}

export async function approveDevice(id: string, code: string) {
  const session = useProfile.getState().session;
  if (!session) return false;
  const result = await profileCall(() => profileApi.approve(session.token, id, code.replace(/\s/g, "")));
  if (result === undefined) return false;
  await refreshProfile();
  return true;
}

export async function revokeDevice(deviceId: string) {
  const session = useProfile.getState().session;
  if (!session) return false;
  const result = await profileCall(() => profileApi.revoke(session.token, deviceId));
  if (result === undefined) return false;
  await refreshProfile();
  return true;
}

export async function removeProfileHost(serverId: string) {
  const session = useProfile.getState().session;
  if (!session) return false;
  const generation = authGeneration;
  const state = useProfile.getState();
  const local = useApp.getState().pairings.find((pairing) => pairing.serverId === serverId);
  const cached = state.pairings[serverId];
  const directoryHost = state.home?.hosts.find((host) => host.serverId === serverId);
  let access = local && state.boundLocal.includes(serverId) ? local : cached;
  if (!access && directoryHost?.hosts.length) {
    try {
      const enrolled = await enroll(directoryHost, false, "connect");
      if (enrolled) access = enrolled;
    } catch (error) {
      useProfile.setState({ error: error instanceof Error ? error.message : "This computer could not be reached to revoke profile access." });
      return false;
    }
  }
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return false;
  if (!access && directoryHost && directoryHost.hosts.length === 0) {
    useProfile.setState({ error: "This computer is offline, so its profile access could not be revoked." });
    return false;
  }
  // Keep an explicit unlink from being undone by the next automatic local-pairing sync.
  await setExcluded(session, [...useProfile.getState().excluded, serverId]);
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return false;
  if (access) {
    try {
      await unbindProfileHost(access, session.profileId);
    } catch (error) {
      useProfile.setState({ error: error instanceof Error ? error.message : "This computer could not be unlinked while it is offline." });
      return false;
    }
    if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return false;
  }
  directoryCache.delete(session.profileId + ":" + serverId);
  const bound = useProfile.getState().boundLocal.filter((id) => id !== serverId);
  if (bound.length !== useProfile.getState().boundLocal.length) {
    await saveBound(session.profileId, bound);
    useProfile.setState({ boundLocal: bound });
    await dropProfileBoundPairings([serverId]);
  }
  if (generation !== authGeneration || useProfile.getState().session?.token !== session.token) return false;
  const next = { ...useProfile.getState().pairings };
  delete next[serverId];
  await savePairings(session.profileId, next, Object.keys(useProfile.getState().pairings));
  useProfile.setState({ pairings: next });
  const remembered = parseCurrent(await readKept(PROFILE_CURRENT_KEY).catch(() => null), session.profileId);
  const selected = remembered === serverId || useApp.getState().pairing?.serverId === serverId;
  if (selected) await clearCurrent().catch(() => {});
  if (useApp.getState().pairing?.serverId === serverId) {
    deactivateProfilePairing();
  }
  const result = await profileCall(() => profileApi.removeHost(session.token, serverId), generation);
  if (result === undefined) {
    if (generation === authGeneration && useProfile.getState().session?.token === session.token) {
      const pending = [...new Set([...useProfile.getState().pendingRemovals, serverId])];
      await savePendingRemovals(session.profileId, pending);
      useProfile.setState({ pendingRemovals: pending, error: "Host access was revoked on this phone; removing it from your profile will retry when you are online." });
    }
    return false;
  }
  const pending = useProfile.getState().pendingRemovals.filter((id) => id !== serverId);
  if (pending.length !== useProfile.getState().pendingRemovals.length) {
    await (pending.length ? savePendingRemovals(session.profileId, pending) : clearPendingRemovals());
    useProfile.setState({ pendingRemovals: pending });
  }
  await refreshProfile();
  return true;
}

/** Signs out of the profile only. Legacy/manual pairings remain in state/link untouched. */
export async function signOutProfile(): Promise<{ revoked: boolean; offline: boolean }> {
  const generation = ++authGeneration;
  const session = useProfile.getState().session;
  const boundLocal = useProfile.getState().boundLocal;
  let revoked = false;
  let offline = false;
  if (session) {
    try {
      await profileApi.revoke(session.token, session.deviceId);
      revoked = true;
    } catch (error) {
      offline = true;
      if (profileInvalid(error)) invalidate();
    }
  }
  // A late finish/home request from the signed-out account must not put its session back.
  if (generation !== authGeneration) return { revoked, offline };
  deactivateProfilePairing();
  await dropProfileBoundPairings(boundLocal);
  await Promise.all([clearSession(), forget(PROFILE_ATTEMPT_KEY), session ? clearProfilePairings(session.profileId, Object.keys(useProfile.getState().pairings)) : Promise.resolve(), clearBound(), clearCurrent(), clearExcluded(), clearPendingRemovals()]).catch(() => {});
  directoryCache.clear();
  useProfile.setState({ session: null, attempt: null, home: null, pairings: {}, boundLocal: [], excluded: [], pendingRemovals: [], prompt: null, busy: false, error: null });
  await keep(PROFILE_CHOICE_KEY, "signed-out").catch(() => {});
  return { revoked, offline };
}

/** Permanently deletes the signed-in profile after the person re-enters its verified email. */
export async function deleteProfileAccount(confirmationEmail: string): Promise<boolean> {
  const session = useProfile.getState().session;
  if (useProfile.getState().busy) return false;
  if (!session || confirmationEmail.trim().toLowerCase() !== session.email.trim().toLowerCase()) {
    useProfile.setState({ error: "Enter the verified profile email exactly." });
    return false;
  }
  useProfile.setState({ busy: true, error: null });
  const generation = ++authGeneration;
  const result = await profileCall(() => profileApi.deleteAccount(session.token, confirmationEmail.trim()), generation);
  if (result === undefined || generation !== authGeneration) {
    useProfile.setState({ busy: false });
    return false;
  }
  const boundLocal = useProfile.getState().boundLocal;
  const local = useApp.getState().pairings.filter((pairing) => boundLocal.includes(pairing.serverId));
  await Promise.all(local.map((pairing) => unbindProfileHost(pairing, session.profileId).catch(() => {})));
  deactivateProfilePairing();
  await dropProfileBoundPairings(boundLocal);
  await Promise.all([clearSession(), forget(PROFILE_ATTEMPT_KEY), clearProfilePairings(session.profileId, Object.keys(useProfile.getState().pairings)), clearBound(), clearCurrent(), clearExcluded(), clearPendingRemovals()]).catch(() => {});
  directoryCache.clear();
  useProfile.setState({ session: null, attempt: null, home: null, pairings: {}, boundLocal: [], excluded: [], pendingRemovals: [], prompt: null, busy: false, error: null });
  await keep(PROFILE_CHOICE_KEY, "deleted").catch(() => {});
  return true;
}

export const profileDeviceLabel = () => deviceName();
