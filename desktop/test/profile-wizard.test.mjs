import assert from "node:assert/strict";
import test from "node:test";
import {
  canContinueWithoutProfile,
  nextAutoExpandState,
  nextMigrationPromptHeld,
  reconcileWizardHostState,
  resolveDeviceLabel,
  verificationCodeAriaLabel,
  verificationCodeDisplay,
} from "../src/profileWizard.ts";

function hostProfile(overrides = {}) {
  return {
    signedIn: false,
    profile: null,
    pending: null,
    optedOut: false,
    migration: { needed: false, prompted: false },
    hosts: [],
    devices: [],
    pendingDevices: [],
    ...overrides,
  };
}

test("verification code renders raw digits without spaces so ⌘C pastes cleanly", () => {
  assert.equal(verificationCodeDisplay("123456"), "123456");
  assert.equal(verificationCodeDisplay("  482917  "), "482917");
  assert.equal(verificationCodeDisplay(""), "");
  assert.equal(verificationCodeDisplay(null), "");
  assert.equal(verificationCodeAriaLabel("482917"), "Verification code 4 8 2 9 1 7");
  assert.equal(verificationCodeAriaLabel(""), "Verification code pending");
});

test("migration prompt stays mounted through Done after sign-in, and dismisses immediately on opt-out or sign-out", () => {
  const needed = hostProfile({ migration: { needed: true, prompted: false } });
  assert.equal(nextMigrationPromptHeld(false, needed), true);

  // Signing in clears migration.needed; held prompt stays open so Done can render until Continue dismisses it.
  const signedIn = hostProfile({
    signedIn: true,
    profile: { profileId: "p1", name: "Ada", email: "ada@example.com" },
    migration: { needed: false, prompted: true },
  });
  assert.equal(nextMigrationPromptHeld(true, signedIn), true);
  // Once dismissed (held=false), signing in does not reopen the migration prompt.
  assert.equal(nextMigrationPromptHeld(false, signedIn), false);

  // Opting out dismisses immediately even when held was true.
  const optedOut = hostProfile({ optedOut: true, migration: { needed: false, prompted: true } });
  assert.equal(nextMigrationPromptHeld(true, optedOut), false);

  // Signing out externally while on migration Done also dismisses instead of sticking.
  const signedOut = hostProfile({ signedIn: false, migration: { needed: false, prompted: true } });
  assert.equal(nextMigrationPromptHeld(true, signedOut), false);
});

test("host state reconciliation adopts new attempts, preserves Back navigation, and clears removed attempts", () => {
  const attempt1 = { id: "att-1", code: "123456", url: "https://profile.botkins.app/#att-1", label: "Work Mac" };
  const attempt2 = { id: "att-2", code: "654321", url: "https://profile.botkins.app/#att-2", label: "Studio Mac" };

  // Arrival of a new pending attempt advances to verify and adopts its label.
  const arrived = reconcileWizardHostState(
    { step: "intro", label: "This Mac", attempt: null, completed: null },
    hostProfile(),
    hostProfile({ pending: attempt1 }),
    "This Mac",
  );
  assert.equal(arrived.step, "verify");
  assert.deepEqual(arrived.attempt, attempt1);
  assert.equal(arrived.label, "Work Mac");

  // Unchanged pending attempt id preserves Back navigation to device or intro.
  const stayedBack = reconcileWizardHostState(
    { step: "device", label: "Edited Mac", attempt: attempt1, completed: null },
    hostProfile({ pending: attempt1 }),
    hostProfile({ pending: attempt1 }),
    "This Mac",
  );
  assert.equal(stayedBack.step, "device");
  assert.equal(stayedBack.label, "Edited Mac");
  assert.deepEqual(stayedBack.attempt, attempt1);

  // A brand-new attempt id (e.g. started from CLI) advances back to verify and adopts the new label.
  const replaced = reconcileWizardHostState(
    { step: "intro", label: "Work Mac", attempt: attempt1, completed: null },
    hostProfile({ pending: attempt1 }),
    hostProfile({ pending: attempt2 }),
    "This Mac",
  );
  assert.equal(replaced.step, "verify");
  assert.deepEqual(replaced.attempt, attempt2);
  assert.equal(replaced.label, "Studio Mac");

  // Host clearing pending (e.g. 401 unauthorized in finish) leaves verify, clears attempt, and drops stale retry.
  const invalidated = reconcileWizardHostState(
    { step: "verify", label: "Studio Mac", attempt: attempt2, completed: null },
    hostProfile({ pending: attempt2 }),
    hostProfile({ pending: null }),
    "This Mac",
  );
  assert.equal(invalidated.step, "device");
  assert.equal(invalidated.attempt, null);
  assert.equal(invalidated.clearNotFinished, true);
  assert.equal(invalidated.clearRetry, true);

  // Opt-out clearing pending returns to intro and resets device label.
  const optedOutClear = reconcileWizardHostState(
    { step: "verify", label: "Studio Mac", attempt: attempt2, completed: null },
    hostProfile({ pending: attempt2 }),
    hostProfile({ pending: null, optedOut: true }),
    "This Mac",
  );
  assert.equal(optedOutClear.step, "intro");
  assert.equal(optedOutClear.attempt, null);
  assert.equal(optedOutClear.label, "This Mac");
});

test("host state reconciliation clears cached identity and leaves Done when signed out externally", () => {
  const signedIn = hostProfile({
    signedIn: true,
    profile: { profileId: "p1", name: "Ada", email: "ada@example.com", avatar: "🦊" },
  });
  const signedOut = hostProfile({ signedIn: false, profile: null });

  const afterSignOut = reconcileWizardHostState(
    { step: "done", label: "Work Mac", attempt: null, completed: { name: "Ada", email: "ada@example.com", avatar: "🦊" } },
    signedIn,
    signedOut,
    "This Mac",
  );
  assert.equal(afterSignOut.step, "intro");
  assert.equal(afterSignOut.completed, null);
  assert.equal(afterSignOut.attempt, null);
  assert.equal(afterSignOut.label, "This Mac");
  assert.equal(afterSignOut.clearFeedback, true);
});

test("Continue without a profile stays available whenever an attempt is pending, even if already opted out", () => {
  assert.equal(canContinueWithoutProfile({ optedOut: false, migration: false, inline: false, hasPendingAttempt: false }), true);
  assert.equal(canContinueWithoutProfile({ optedOut: true, migration: false, inline: false, hasPendingAttempt: false }), false);
  assert.equal(canContinueWithoutProfile({ optedOut: true, migration: false, inline: false, hasPendingAttempt: true }), true);
  assert.equal(canContinueWithoutProfile({ optedOut: true, migration: true, inline: false, hasPendingAttempt: false }), true);
  assert.equal(canContinueWithoutProfile({ optedOut: true, migration: false, inline: true, hasPendingAttempt: false }), true);
});

test("inline wizard auto-expands only for a newly seen attempt id, not after explicit collapse", () => {
  const firstSeen = nextAutoExpandState(null, "att-1");
  assert.deepEqual(firstSeen, { nextSeenAttemptId: "att-1", shouldExpand: true });

  // Same attempt id after user collapsed does not auto-expand again.
  const sameAfterCollapse = nextAutoExpandState("att-1", "att-1");
  assert.deepEqual(sameAfterCollapse, { nextSeenAttemptId: "att-1", shouldExpand: false });

  // A brand-new attempt id expands again.
  const newer = nextAutoExpandState("att-1", "att-2");
  assert.deepEqual(newer, { nextSeenAttemptId: "att-2", shouldExpand: true });

  // Clearing the attempt resets the seen marker so a future attempt expands.
  const cleared = nextAutoExpandState("att-2", null);
  assert.deepEqual(cleared, { nextSeenAttemptId: null, shouldExpand: false });
});

test("resolveDeviceLabel trims current input and falls back only when blank", () => {
  assert.equal(resolveDeviceLabel("  Studio Mac  "), "Studio Mac");
  assert.equal(resolveDeviceLabel("   "), "This device");
});
