import assert from "node:assert/strict";
import { test } from "node:test";
import { profileCode, profileHostIsLocal, profileHostsOf, profileHostSubtitle, profilePrompt, PROFILE_BROWSER_COPY, PROFILE_MIGRATION_COPY, PROFILE_OPTIONAL_COPY } from "../src/features/profile/profileLogic";

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

test("profile code is shown in two readable groups and host rows distinguish local and enrolled access", () => {
  assert.equal(profileCode("123456"), "123 456");
  assert.equal(profileCode("123"), "123");
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
