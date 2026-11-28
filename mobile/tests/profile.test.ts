import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";
import {
  CONFIRM_COPY,
  orderTrustedDevices,
  pendingBannerCopy,
  pendingDeviceLabel,
  profileCode,
  profileCodeDisplay,
  profileCodeLabel,
  profileHostIsLocal,
  profileHostsOf,
  profileHostStatus,
  profileHostSubtitle,
  profileIndexSummary,
  profileInitials,
  profilePrompt,
  PROFILE_BROWSER_COPY,
  PROFILE_MIGRATION_COPY,
  PROFILE_OPTIONAL_COPY,
  requestDeleteProfile,
  requestRemovePhoto,
  requestRemoveProfileHost,
  requestRevokeDevice,
  requestSignOutProfile,
  type ConfirmButton,
  type DeletePromptRequest,
} from "../src/features/profile/profileLogic";

const load = createRequire(__filename);

function standIn(id: string, exports: unknown) {
  const full = load.resolve(id);
  const mod = new Module(full);
  mod.filename = full;
  mod.loaded = true;
  mod.exports = exports;
  load.cache[full] = mod;
}

function loadProfileStore(
  storage: Map<string, string>,
  startAttempt: () => Promise<{ id: string; verifier: string; url: string; code: string }>,
  options?: {
    finish?: () => Promise<{ token: string; profileId: string; deviceId: string; name: string; email: string } | null>;
    onKeep?: (key: string, value: string, write: () => void) => Promise<void>;
    onForget?: (key: string, remove: () => void) => Promise<void>;
  },
) {
  standIn("react-native", {
    AppState: { currentState: "background", addEventListener: () => ({ remove() {} }) },
  });
  standIn("expo-network", {
    addNetworkStateListener: () => ({ remove() {} }),
  });
  standIn("../src/state/keep", {
    keep: async (key: string, value: string) => {
      if (options?.onKeep) await options.onKeep(key, value, () => { storage.set(key, value); });
      else storage.set(key, value);
    },
    readKept: async (key: string) => storage.get(key) ?? null,
    forget: async (key: string) => {
      if (options?.onForget) await options.onForget(key, () => { storage.delete(key); });
      else storage.delete(key);
    },
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
      finish: options?.finish ?? (async () => null),
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

test("continuing without a profile rolls back a finish that is already saving its session", async () => {
  const storage = new Map<string, string>();
  const pending = { id: "c".repeat(32), verifier: "verifier-secret", url: "https://profile.botkins.app/#" + "c".repeat(32), code: "246810" };
  const session = { token: "tok-1", profileId: "prof-1", deviceId: "dev-1", name: "Alex", email: "a@example.com" };
  let sessionWriteStarted!: () => void;
  const writingSession = new Promise<void>((resolve) => { sessionWriteStarted = resolve; });
  let releaseSessionWrite!: () => void;
  const pauseSessionWrite = new Promise<void>((resolve) => { releaseSessionWrite = resolve; });

  const store = loadProfileStore(storage, async () => pending, {
    finish: async () => session,
    onKeep: async (key, _value, write) => {
      if (key === "botkins.profile.session.v1") {
        write();
        sessionWriteStarted();
        await pauseSessionWrite;
        return;
      }
      write();
    },
  });

  await store.loadProfile(0);
  await store.beginProfile("Test Phone");
  const finishing = store.finishPending();
  await writingSession;

  const dismissing = store.dismissPrompt();
  releaseSessionWrite();
  const [finished] = await Promise.all([finishing, dismissing]);

  assert.equal(finished, undefined);
  assert.equal(store.useProfile.getState().session, null);
  assert.equal(store.useProfile.getState().attempt, null);
  assert.equal(store.useProfile.getState().prompt, null);
  assert.equal(store.useProfile.getState().busy, false);
  assert.equal(storage.has("botkins.profile.session.v1"), false);
  assert.equal(storage.get("botkins.profile.choice.v1"), "dismissed");
  assert.equal(storage.has("botkins.profile.attempt.v1"), false);
});

test("a dismissed enrollment stays signed out after restart even if rollback delete fails once", async () => {
  const storage = new Map<string, string>();
  const pending = { id: "d".repeat(32), verifier: "verifier-secret", url: "https://profile.botkins.app/#" + "d".repeat(32), code: "135790" };
  const session = { token: "tok-canceled", profileId: "prof-1", deviceId: "dev-canceled", name: "Alex", email: "a@example.com" };
  let sessionWriteStarted!: () => void;
  const writingSession = new Promise<void>((resolve) => { sessionWriteStarted = resolve; });
  let releaseSessionWrite!: () => void;
  const pauseSessionWrite = new Promise<void>((resolve) => { releaseSessionWrite = resolve; });
  let sessionDeletes = 0;

  const store = loadProfileStore(storage, async () => pending, {
    finish: async () => session,
    onKeep: async (key, _value, write) => {
      if (key === "botkins.profile.session.v1") {
        write();
        sessionWriteStarted();
        await pauseSessionWrite;
        return;
      }
      write();
    },
    onForget: async (key, remove) => {
      if (key === "botkins.profile.session.v1") {
        sessionDeletes += 1;
        if (sessionDeletes === 1) throw new Error("Keychain delete failed");
      }
      remove();
    },
  });

  await store.loadProfile(0);
  await store.beginProfile("Test Phone");
  const finishing = store.finishPending();
  await writingSession;

  const dismissing = store.dismissPrompt();
  releaseSessionWrite();
  const [finished] = await Promise.all([finishing, dismissing]);

  assert.equal(finished, undefined);
  assert.equal(store.useProfile.getState().session, null);
  assert.equal(sessionDeletes, 1);
  assert.equal(storage.has("botkins.profile.session.v1"), true);

  // On restart, the saved dismissal for that canceled enrollment must win, retry cleanup, and stay signed out.
  const reloaded = loadProfileStore(storage, async () => pending, {
    onForget: async (key, remove) => {
      if (key === "botkins.profile.session.v1") sessionDeletes += 1;
      remove();
    },
  });
  await reloaded.loadProfile(0);

  assert.equal(reloaded.useProfile.getState().session, null);
  assert.equal(reloaded.useProfile.getState().prompt, null);
  assert.equal(sessionDeletes, 2);
  assert.equal(storage.has("botkins.profile.session.v1"), false);
});

test("an ordinary signed-in person who dismissed the prompt earlier stays signed in on load", async () => {
  const storage = new Map<string, string>();
  const pending = { id: "e".repeat(32), verifier: "verifier-secret", url: "https://profile.botkins.app/#" + "e".repeat(32), code: "112233" };
  const session = { token: "tok-valid", profileId: "prof-1", deviceId: "dev-valid", name: "Alex", email: "a@example.com" };
  storage.set("botkins.profile.session.v1", JSON.stringify(session));
  storage.set("botkins.profile.choice.v1", "dismissed");

  const store = loadProfileStore(storage, async () => pending);
  await store.loadProfile(0);

  assert.deepEqual(store.useProfile.getState().session, session);
  assert.equal(storage.has("botkins.profile.session.v1"), true);
});

test("a storage failure while finishing keeps the attempt, clears busy, and shows a retryable error", async () => {
  const storage = new Map<string, string>();
  const pending = { id: "f".repeat(32), verifier: "verifier-secret", url: "https://profile.botkins.app/#" + "f".repeat(32), code: "987654" };
  const session = { token: "tok-retry", profileId: "prof-1", deviceId: "dev-retry", name: "Alex", email: "a@example.com" };
  let failWrites = 1;

  const store = loadProfileStore(storage, async () => pending, {
    finish: async () => session,
    onKeep: async (key, _value, write) => {
      if (key === "botkins.profile.session.v1" && failWrites > 0) {
        failWrites -= 1;
        throw new Error("Keychain write failed");
      }
      write();
    },
  });

  await store.loadProfile(0);
  await store.beginProfile("Test Phone");
  const first = await store.finishPending();

  assert.equal(first, undefined);
  assert.equal(store.useProfile.getState().busy, false);
  assert.deepEqual(store.useProfile.getState().attempt, pending);
  assert.equal(store.useProfile.getState().session, null);
  assert.equal(store.useProfile.getState().error, "Keychain write failed");

  // Retrying Finish succeeds once storage is writable again.
  const second = await store.finishPending();
  assert.deepEqual(second, session);
  assert.equal(store.useProfile.getState().busy, false);
  assert.equal(store.useProfile.getState().attempt, null);
  assert.deepEqual(store.useProfile.getState().session, session);
  assert.equal(store.useProfile.getState().error, null);
});

test("profileHostStatus picks Ready, Offline, Add, and Removing badges with short subtitles", () => {
  const base = { serverId: "s1", serverKey: "k1", name: "Mac Studio", hosts: ["10.0.0.2:6365"] };

  assert.deepEqual(profileHostStatus(base, { local: true, enrolled: true, pendingRemoval: false }), {
    kind: "ready",
    label: "Ready",
    tone: "success",
    subtitle: "Your computer",
    selectable: true,
  });

  assert.deepEqual(profileHostStatus({ ...base, member: true }, { local: false, enrolled: true, pendingRemoval: false }), {
    kind: "ready",
    label: "Ready",
    tone: "success",
    subtitle: "You're a member",
    selectable: true,
  });

  assert.deepEqual(profileHostStatus({ ...base, hosts: [] }, { local: false, enrolled: false, pendingRemoval: false }), {
    kind: "offline",
    label: "Offline",
    tone: "warning",
    subtitle: "Waiting for computer to come online",
    selectable: false,
  });

  assert.deepEqual(
    profileHostStatus({ ...base, hosts: [], offlineSince: "Nov 3" }, { local: true, enrolled: false, pendingRemoval: false }),
    {
      kind: "offline",
      label: "Offline",
      tone: "warning",
      subtitle: "Offline since Nov 3",
      selectable: true,
    },
  );

  assert.deepEqual(profileHostStatus({ ...base, member: true }, { local: false, enrolled: false, pendingRemoval: false }), {
    kind: "add",
    label: "Add",
    tone: "accent",
    subtitle: "You're a member · tap to enroll",
    selectable: true,
  });

  assert.deepEqual(profileHostStatus(base, { local: true, enrolled: true, pendingRemoval: true }), {
    kind: "removing",
    label: "Removing…",
    tone: "warning",
    subtitle: "Will retry when online",
    selectable: false,
  });
});

test("orderTrustedDevices puts the current device first and preserves others", () => {
  const ordered = orderTrustedDevices([
    { id: "d2", label: "Mac Studio", current: false },
    { id: "d1", label: "Colt's iPhone", current: true },
    { id: "d3", label: "Pixel 9", current: false },
  ]);
  assert.deepEqual(ordered.map((d) => d.id), ["d1", "d2", "d3"]);
});

test("profileIndexSummary computes counts and subtitles for Computers and Trusted devices", () => {
  const hosts = [
    { serverId: "s1", serverKey: "k1", name: "botkins-vps", hosts: ["a"] },
    { serverId: "s2", serverKey: "k2", name: "Mac Studio", hosts: ["b"] },
    { serverId: "s3", serverKey: "k3", name: "Old laptop", hosts: [] },
    { serverId: "s4", serverKey: "k4", name: "Sam's computer", hosts: ["d"], member: true },
  ];
  const devices = [
    { id: "d2", label: "Mac Studio", current: false },
    { id: "d1", label: "iPhone", current: true },
    { id: "d3", label: "Pixel 9", current: false },
  ];
  const summary = profileIndexSummary({
    hosts,
    devices,
    enrolledServerIds: new Set(["s1", "s2", "s3"]),
    currentDeviceLabel: "iPhone",
  });
  assert.equal(summary.computersCount, 4);
  assert.equal(summary.computersReadyCount, 3);
  assert.equal(summary.computersSubtitle, "3 ready on this phone");
  assert.equal(summary.devicesCount, 3);
  assert.equal(summary.devicesSubtitle, "iPhone and 2 more");

  // Single current device only
  const solo = profileIndexSummary({
    hosts: [],
    devices: [{ id: "d1", label: "This iPhone", current: true }],
    enrolledServerIds: new Set(),
  });
  assert.equal(solo.computersCount, 0);
  assert.equal(solo.computersSubtitle, "No computers yet");
  assert.equal(solo.devicesCount, 1);
  assert.equal(solo.devicesSubtitle, "iPhone");

  // A device's own name is used as it is, never as "This Colt's iPhone".
  const named = profileIndexSummary({
    hosts: [],
    devices: [{ id: "d1", label: "Colt's iPhone", current: true }, { id: "d2", label: "Pixel 9" }],
    enrolledServerIds: new Set(),
  });
  assert.equal(named.devicesSubtitle, "Colt's iPhone and 1 more");
});

test("profileCodeDisplay, profileInitials, and pendingBannerCopy format hero and banner text", () => {
  assert.equal(profileCodeDisplay("482913"), "482 913");
  assert.equal(profileCodeDisplay(" 482913 "), "482 913");
  assert.equal(profileInitials("Colt Coan"), "CC");
  assert.equal(profileInitials("Ada"), "A");
  assert.equal(profileInitials(""), "?");
  assert.equal(pendingDeviceLabel("  "), "Another device");
  assert.equal(pendingBannerCopy([]), null);
  assert.deepEqual(pendingBannerCopy([{ id: "p1", label: "iPad", code: "482913" }]), {
    title: "A device wants in",
    subtitle: "iPad · code 482 913",
  });
  assert.deepEqual(
    pendingBannerCopy([
      { id: "p1", label: "iPad", code: "482913" },
      { id: "p2", label: "Mac", code: "111222" },
    ]),
    {
      title: "2 devices want in",
      subtitle: "iPad · code 482 913 (+1 more)",
    },
  );
});

test("HARD RULE: every destructive profile handler calls confirm before any API call", () => {
  const makeAlertRecorder = () => {
    const calls: { title: string; message: string; buttons: ConfirmButton[] }[] = [];
    const alert = (title: string, message: string, buttons: ConfirmButton[]) => {
      calls.push({ title, message, buttons });
    };
    return { calls, alert };
  };

  // 1. Revoke trusted device (never allowed on current device; requires confirm on others)
  {
    const rec = makeAlertRecorder();
    const apiCalls: string[] = [];
    const blocked = requestRevokeDevice({ id: "d1", current: true }, rec.alert, (id) => apiCalls.push(id));
    assert.equal(blocked, false);
    assert.equal(rec.calls.length, 0);
    assert.equal(apiCalls.length, 0);

    const asked = requestRevokeDevice({ id: "d2", current: false }, rec.alert, (id) => apiCalls.push(id));
    assert.equal(asked, true);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.title, CONFIRM_COPY.revokeDevice.title);
    assert.equal(rec.calls[0]!.message, CONFIRM_COPY.revokeDevice.message);
    assert.equal(apiCalls.length, 0, "API must not be called before confirm");

    // Cancel does not call API
    rec.calls[0]!.buttons.find((b) => b.style === "cancel")?.onPress?.();
    assert.equal(apiCalls.length, 0);

    // Confirm invokes API
    rec.calls[0]!.buttons.find((b) => b.text === "Revoke")?.onPress?.();
    assert.deepEqual(apiCalls, ["d2"]);
  }

  // 2. Remove profile host
  {
    const rec = makeAlertRecorder();
    const apiCalls: string[] = [];
    requestRemoveProfileHost("srv-1", rec.alert, (id) => apiCalls.push(id));
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.title, CONFIRM_COPY.removeHost.title);
    assert.equal(rec.calls[0]!.message, CONFIRM_COPY.removeHost.message);
    assert.equal(apiCalls.length, 0, "API must not be called before confirm");

    rec.calls[0]!.buttons.find((b) => b.style === "cancel")?.onPress?.();
    assert.equal(apiCalls.length, 0);

    rec.calls[0]!.buttons.find((b) => b.text === "Remove")?.onPress?.();
    assert.deepEqual(apiCalls, ["srv-1"]);
  }

  // 3. Remove photo
  {
    const rec = makeAlertRecorder();
    let apiCalls = 0;
    requestRemovePhoto(rec.alert, () => { apiCalls += 1; });
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.title, CONFIRM_COPY.removePhoto.title);
    assert.equal(apiCalls, 0, "API must not be called before confirm");

    rec.calls[0]!.buttons.find((b) => b.style === "cancel")?.onPress?.();
    assert.equal(apiCalls, 0);

    rec.calls[0]!.buttons.find((b) => b.text === "Remove")?.onPress?.();
    assert.equal(apiCalls, 1);
  }

  // 4. Sign out of profile
  {
    const rec = makeAlertRecorder();
    let apiCalls = 0;
    requestSignOutProfile(rec.alert, () => { apiCalls += 1; });
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.title, CONFIRM_COPY.signOut.title);
    assert.equal(rec.calls[0]!.message, CONFIRM_COPY.signOut.message);
    assert.equal(apiCalls, 0, "API must not be called before confirm");

    rec.calls[0]!.buttons.find((b) => b.style === "cancel")?.onPress?.();
    assert.equal(apiCalls, 0);

    rec.calls[0]!.buttons.find((b) => b.text === "Sign out")?.onPress?.();
    assert.equal(apiCalls, 1);
  }

  // 5. Delete profile account (two-step: Alert confirm -> typed email prompt -> API)
  {
    const rec = makeAlertRecorder();
    const prompts: DeletePromptRequest[] = [];
    const apiCalls: string[] = [];
    requestDeleteProfile("colt@example.com", rec.alert, (p) => prompts.push(p), (email) => apiCalls.push(email));
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.title, CONFIRM_COPY.deleteProfile.title);
    assert.equal(rec.calls[0]!.message, CONFIRM_COPY.deleteProfile.message);
    assert.equal(prompts.length, 0);
    assert.equal(apiCalls.length, 0, "API must not be called before Alert confirm");

    // Step 1 confirm opens typed-email prompt, still no API call
    rec.calls[0]!.buttons.find((b) => b.text === "Continue")?.onPress?.();
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.title, "Confirm profile deletion");
    assert.match(prompts[0]!.message, /colt@example\.com/);
    assert.equal(apiCalls.length, 0, "API must not be called before typed-email submit");

    // Step 2 submit calls API
    prompts[0]!.onSubmit("colt@example.com");
    assert.deepEqual(apiCalls, ["colt@example.com"]);
  }
});
