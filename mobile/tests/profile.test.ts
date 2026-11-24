import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";
import { profileCode, profileCodeLabel, profileHostIsLocal, profileHostsOf, profileHostSubtitle, profilePrompt, PROFILE_BROWSER_COPY, PROFILE_MIGRATION_COPY, PROFILE_OPTIONAL_COPY } from "../src/features/profile/profileLogic";

const load = createRequire(__filename);

function standIn(id: string, exports: unknown) {
  const full = load.resolve(id);
  const mod = new Module(full);
  mod.filename = full;
  mod.loaded = true;
  mod.exports = exports;
  load.cache[full] = mod;
}

function loadProfileStore(storage: Map<string, string>, startAttempt: () => Promise<{ id: string; verifier: string; url: string; code: string }>) {
  standIn("react-native", {
    AppState: { currentState: "background", addEventListener: () => ({ remove() {} }) },
  });
  standIn("expo-network", {
    addNetworkStateListener: () => ({ remove() {} }),
  });
  standIn("../src/state/keep", {
    keep: async (key: string, value: string) => { storage.set(key, value); },
    readKept: async (key: string) => storage.get(key) ?? null,
    forget: async (key: string) => { storage.delete(key); },
  });
  standIn("../src/state/link", {
    deviceName: () => "Test Phone",
    activateProfilePairing: () => {},
    bindProfileHost: async () => false,
    connectProfileHost: async () => null,
    deactivateProfilePairing: () => {},
    dropProfileBoundPairings: async () => {},
    unbindProfileHost: async () => {},
  });
  standIn("../src/state/store", {
    useApp: { getState: () => ({ pairings: [], pairing: null }) },
  });
  standIn("../src/link/profile", {
    PROFILE_ORIGIN: "https://profile.botkins.app",
    ProfileError: class ProfileError extends Error {
      constructor(public readonly status: number, message: string) { super(message); }
    },
    profileApi: {
      start: startAttempt,
      finish: async () => null,
      home: async () => ({ profile: { id: "p", name: "Alex", email: "a@example.com" }, hosts: [], devices: [], pending: [] }),
    },
  });
  const profilePath = load.resolve("../src/state/profile");
  delete load.cache[profilePath];
  return load(profilePath) as typeof import("../src/state/profile");
}

test("profile setup is optional on a fresh phone and offers one migration prompt for old pairings", () => {
  assert.equal(profilePrompt({ pairings: 0, session: null, choice: null, pending: null }), "first");
  assert.equal(profilePrompt({ pairings: 2, session: null, choice: null, pending: null }), "migration");
  assert.equal(profilePrompt({ pairings: 2, session: null, choice: "dismissed", pending: null }), null);
  assert.equal(profilePrompt({ pairings: 0, session: { token: "t", profileId: "p", deviceId: "d", name: "Alex", email: "a@example.com" }, choice: null, pending: null }), null);
  assert.match(PROFILE_OPTIONAL_COPY, /not.*continue across devices/i);
  assert.match(PROFILE_MIGRATION_COPY, /existing computer pairings/i);
  assert.match(PROFILE_BROWSER_COPY, /email code/i);
});

test("a pending browser request resumes even when the app has no profile session", () => {
  assert.equal(profilePrompt({ pairings: 0, session: null, choice: null, pending: { id: "i", verifier: "v", url: "https://profile.botkins.app/#i", code: "123456" } }), "first");
});

test("profile code stays copyable without spaces while the accessibility label reads each digit", () => {
  assert.equal(profileCode("123456"), "123456");
  assert.equal(profileCode(" 123456 "), "123456");
  assert.equal(profileCode("123"), "123");
  assert.equal(profileCodeLabel("123456"), "Profile code 1 2 3 4 5 6");
  assert.equal(profileCodeLabel(""), "Profile code");
  const host = { serverId: "s", serverKey: "k", name: "Mac", hosts: ["127.0.0.1:1"] };
  assert.equal(profileHostIsLocal(host, [{ serverId: "s" }]), true);
  assert.equal(profileHostSubtitle(host, true, false), "This phone's local pairing · waiting for this computer to come online");
  assert.equal(profileHostSubtitle(host, false, false), "Not paired on this phone · tap to enroll");
  assert.equal(profileHostSubtitle(host, true, true), "Available on this phone");
  assert.equal(profileHostSubtitle({ ...host, hosts: [] }, false, false), "Saved in your profile · waiting for this computer to come online");
});

test("with no profile the hosts selector answers the same empty list every time", () => {
  // A new array on each read loops the store selector and stops Home ("Maximum update depth").
  assert.equal(profileHostsOf({ home: null }), profileHostsOf({ home: null }));
  assert.deepEqual(profileHostsOf({ home: null }), []);
  const hosts = [{ serverId: "s", serverKey: "k", name: "Mac", hosts: [] }];
  assert.equal(profileHostsOf({ home: { hosts } }), hosts);
});

test("continuing without a profile clears any pending verification attempt in memory and storage", async () => {
  const storage = new Map<string, string>();
  const pending = { id: "a".repeat(32), verifier: "verifier-secret", url: "https://profile.botkins.app/#" + "a".repeat(32), code: "123456" };
  const store = loadProfileStore(storage, async () => pending);

  await store.loadProfile(0);
  const started = await store.beginProfile("Test Phone");
  assert.deepEqual(started, pending);
  assert.deepEqual(store.useProfile.getState().attempt, pending);
  assert.equal(storage.has("botkins.profile.attempt.v1"), true);

  await store.dismissPrompt();

  assert.equal(store.useProfile.getState().attempt, null);
  assert.equal(store.useProfile.getState().prompt, null);
  assert.equal(storage.get("botkins.profile.choice.v1"), "dismissed");
  assert.equal(storage.has("botkins.profile.attempt.v1"), false);

  // Reloading the store (as when reopening the app/screen) must not resurrect the old attempt.
  const reloaded = loadProfileStore(storage, async () => pending);
  await reloaded.loadProfile(0);
  assert.equal(reloaded.useProfile.getState().attempt, null);
  assert.equal(reloaded.useProfile.getState().prompt, null);
});

test("continuing without a profile cancels an in-flight verification start", async () => {
  const storage = new Map<string, string>();
  const pending = { id: "b".repeat(32), verifier: "verifier-secret", url: "https://profile.botkins.app/#" + "b".repeat(32), code: "654321" };
  let resolveStart!: (value: typeof pending) => void;
  const store = loadProfileStore(storage, () => new Promise((resolve) => { resolveStart = resolve; }));

  await store.loadProfile(0);
  const starting = store.beginProfile("Test Phone");
  await store.dismissPrompt();
  resolveStart(pending);
  assert.equal(await starting, undefined);

  assert.equal(store.useProfile.getState().attempt, null);
  assert.equal(store.useProfile.getState().busy, false);
  assert.equal(storage.get("botkins.profile.choice.v1"), "dismissed");
  assert.equal(storage.has("botkins.profile.attempt.v1"), false);
});
