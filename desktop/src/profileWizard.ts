// Pure helpers for the desktop Profile setup wizard (`ProfileSettings.tsx`), kept free of
// window/DOM imports so `node --test` can import it directly.
import type { ProfileState } from "./types";

export type WizardStep = "intro" | "device" | "verify" | "done";

export type CompletedProfile = {
  name: string;
  email?: string;
  avatar?: string;
};

export type WizardLocalState = {
  step: WizardStep;
  label: string;
  attempt: ProfileState["pending"];
  completed: CompletedProfile | null;
};

export type WizardReconcileResult = WizardLocalState & {
  clearNotFinished: boolean;
  clearFeedback: boolean;
  clearRetry: boolean;
  statusMessage: string | null;
};

/** Renders the verification code without inserted spaces so manual selection + ⌘C pastes into the 6-digit browser input. */
export function verificationCodeDisplay(code?: string | null): string {
  return (code ?? "").trim();
}

/** Screen-reader label spelling out each digit individually. */
export function verificationCodeAriaLabel(code?: string | null): string {
  const clean = verificationCodeDisplay(code);
  return clean ? `Verification code ${clean.split("").join(" ")}` : "Verification code pending";
}

/** Trims a device name field and falls back only when blank. */
export function resolveDeviceLabel(input: string, fallback = "This device"): string {
  return input.trim() || fallback;
}

/**
 * Keeps an active migration prompt mounted through the signed-in Done step until Continue dismisses it,
 * while opting out or signing out dismisses it immediately.
 */
export function nextMigrationPromptHeld(held: boolean, profile: ProfileState | undefined): boolean {
  if (!profile) return false;
  if (profile.migration.needed) return true;
  return held && Boolean(profile.signedIn && profile.profile);
}

/** Whether the "Continue without a profile" action should be shown in the wizard. */
export function canContinueWithoutProfile(options: {
  optedOut?: boolean;
  migration?: boolean;
  inline?: boolean;
  hasPendingAttempt?: boolean;
}): boolean {
  return !options.optedOut || Boolean(options.migration) || Boolean(options.inline) || Boolean(options.hasPendingAttempt);
}

/** Auto-expands the first-run inline wizard only when a newly seen pending attempt id arrives. */
export function nextAutoExpandState(
  seenAttemptId: string | null,
  nextAttemptId: string | null,
): { nextSeenAttemptId: string | null; shouldExpand: boolean } {
  if (!nextAttemptId) return { nextSeenAttemptId: null, shouldExpand: false };
  if (nextAttemptId === seenAttemptId) return { nextSeenAttemptId: seenAttemptId, shouldExpand: false };
  return { nextSeenAttemptId: nextAttemptId, shouldExpand: true };
}

/**
 * Reconciles wizard state with both arrival and removal of host profile state (pending attempt,
 * signed-in identity, and opt-out), while preserving ordinary Back navigation when the pending
 * attempt id has not changed.
 */
export function reconcileWizardHostState(
  local: WizardLocalState,
  prevHost: ProfileState | null,
  nextHost: ProfileState | null,
  fallbackLabel: string,
): WizardReconcileResult {
  const base: WizardReconcileResult = {
    ...local,
    clearNotFinished: false,
    clearFeedback: false,
    clearRetry: false,
    statusMessage: null,
  };
  if (!nextHost) return base;

  const wasSignedIn = Boolean(prevHost?.signedIn && prevHost.profile);
  const isSignedIn = Boolean(nextHost.signedIn && nextHost.profile);
  const prevPending = prevHost?.pending ?? null;
  const nextPending = nextHost.pending ?? null;

  if (isSignedIn && nextHost.profile) {
    const nextCompleted: CompletedProfile = {
      name: nextHost.profile.name,
      email: nextHost.profile.email,
      avatar: nextHost.profile.avatar,
    };
    const enteringDone = local.step !== "done";
    return {
      ...base,
      step: "done",
      attempt: null,
      completed: nextCompleted,
      clearNotFinished: true,
      clearFeedback: !wasSignedIn || enteringDone,
      clearRetry: true,
      statusMessage: enteringDone ? "Profile connected." : null,
    };
  }

  if (wasSignedIn && !isSignedIn) {
    return {
      ...base,
      step: nextPending ? "verify" : "intro",
      attempt: nextPending,
      completed: null,
      label: nextPending?.label?.trim() || fallbackLabel,
      clearNotFinished: true,
      clearFeedback: true,
      clearRetry: true,
    };
  }

  if (nextPending) {
    const isNewAttempt = prevPending?.id !== nextPending.id;
    const labelChanged = prevPending?.label !== nextPending.label;
    return {
      ...base,
      step: isNewAttempt ? "verify" : local.step,
      attempt: nextPending,
      completed: isNewAttempt ? null : local.completed,
      label: isNewAttempt || labelChanged ? nextPending.label?.trim() || local.label || fallbackLabel : local.label,
      clearNotFinished: isNewAttempt,
    };
  }

  if (prevPending && !nextPending) {
    if (nextHost.optedOut) {
      return {
        ...base,
        step: "intro",
        attempt: null,
        completed: null,
        label: fallbackLabel,
        clearNotFinished: true,
        clearRetry: true,
      };
    }
    return {
      ...base,
      step: local.step === "verify" ? "device" : local.step,
      attempt: null,
      clearNotFinished: true,
      clearRetry: true,
    };
  }

  if (!prevHost?.optedOut && nextHost.optedOut) {
    return {
      ...base,
      step: "intro",
      attempt: null,
      completed: null,
      label: fallbackLabel,
      clearNotFinished: true,
      clearRetry: true,
    };
  }

  return base;
}
