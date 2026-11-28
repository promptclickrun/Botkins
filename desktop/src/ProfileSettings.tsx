import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock,
  Compass,
  Copy,
  Ellipsis,
  ExternalLink,
  HardDrive,
  ImageUp,
  Laptop,
  LogOut,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { ProfileState, State } from "./types";
import { AVATAR_TYPES } from "./avatarImage";
import { PersonBadge } from "./PersonBadge";
import { Group, errorText } from "./SettingsRows";
import { YourPicture, useDesktopPicture } from "./YourPicture";
import { WelcomeFrame, WelcomeLogo } from "./Welcome";
import {
  confirmDeleteProfile,
  confirmDisconnectHost,
  confirmSignOut,
  confirmRevokeDevice,
  desktopHostStatus,
  desktopPendingBanner,
  desktopProfileSummary,
  orderDesktopDevices,
} from "./profileLogic";
import {
  canContinueWithoutProfile,
  nextAutoExpandState,
  nextMigrationPromptHeld,
  reconcileWizardHostState,
  resolveDeviceLabel,
  verificationCodeAriaLabel,
  verificationCodeDisplay,
  type CompletedProfile,
  type WizardLocalState,
  type WizardStep,
} from "./profileWizard";
import "./profile.css";

const WIZARD_STEPS: ReadonlyArray<{ id: WizardStep; label: string }> = [
  { id: "intro", label: "Overview" },
  { id: "device", label: "Device" },
  { id: "verify", label: "Browser" },
  { id: "done", label: "Done" },
];

type WizardRetry =
  | { kind: "start"; isRestart: boolean; step: WizardStep }
  | { kind: "open" | "finish" | "optOut" | "copy"; step: WizardStep };

function defaultDeviceName(pendingLabel?: string): string {
  if (pendingLabel?.trim()) return pendingLabel.trim();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mac/i.test(ua)) return "This Mac";
  if (/Windows/i.test(ua)) return "This PC";
  return "This computer";
}

function ProfileAlert({
  message,
  onRetry,
  retryDisabled = false,
}: {
  message: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  if (!message) return null;
  return (
    <div className="profile-alert" role="alert">
      <span className="profile-alert-body">
        <CircleAlert size={16} aria-hidden="true" />
        <span>{message}</span>
      </span>
      {onRetry && (
        <button type="button" className="set-button" disabled={retryDisabled} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function StepIndicator({ current }: { current: WizardStep }) {
  const activeIdx = WIZARD_STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="profile-steps" aria-label="Profile setup steps">
      {WIZARD_STEPS.map((item, idx) => {
        const done = idx < activeIdx || (current === "done" && idx === activeIdx);
        const active = idx === activeIdx && current !== "done";
        const state = done ? "done" : active ? "active" : "upcoming";
        return (
          <li
            key={item.id}
            className="profile-step"
            data-state={state}
            aria-current={idx === activeIdx ? "step" : undefined}
          >
            <span className="profile-step-dot" aria-hidden="true">
              {done ? <Check size={12} strokeWidth={2.6} /> : idx + 1}
            </span>
            <span className="profile-step-label">{item.label}</span>
            {idx < WIZARD_STEPS.length - 1 && <span className="profile-step-line" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function ProfileWizard({
  state,
  migration = false,
  inline = false,
  autoFocusInitial = false,
  onCollapse,
  onComplete,
}: {
  state: State;
  migration?: boolean;
  inline?: boolean;
  autoFocusInitial?: boolean;
  onCollapse?: () => void;
  onComplete?: () => void;
}) {
  const profile = state.profile;
  const [step, setStep] = useState<WizardStep>(() => {
    if (profile?.signedIn && profile.profile) return "done";
    return profile?.pending ? "verify" : "intro";
  });
  const [label, setLabel] = useState(() => defaultDeviceName(profile?.pending?.label));
  const [attempt, setAttempt] = useState<ProfileState["pending"]>(profile?.pending ?? null);
  const [completed, setCompleted] = useState<CompletedProfile | null>(() =>
    profile?.signedIn && profile.profile
      ? { name: profile.profile.name, email: profile.profile.email, avatar: profile.profile.avatar }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [openingHost, setOpeningHost] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<WizardRetry | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [notFinishedYet, setNotFinishedYet] = useState(false);
  const [copied, setCopied] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const didMountRef = useRef(false);
  const didSyncHostRef = useRef(false);
  const prevHostRef = useRef<ProfileState | null>(profile ?? null);
  const localRef = useRef<WizardLocalState>({ step, label, attempt, completed });
  localRef.current = { step, label, attempt, completed };
  const labelRef = useRef(label);
  labelRef.current = label;
  const copyTimerRef = useRef<number | null>(null);

  // Reconcile both arrival and removal of host profile state (pending attempts, sign-in/sign-out,
  // opt-out) without breaking ordinary Back navigation when the pending attempt has not changed.
  useEffect(() => {
    const nextHost = profile ?? null;
    const prevHost = prevHostRef.current;
    prevHostRef.current = nextHost;
    if (!didSyncHostRef.current) {
      didSyncHostRef.current = true;
      return;
    }
    const reconciled = reconcileWizardHostState(localRef.current, prevHost, nextHost, defaultDeviceName());
    setStep(reconciled.step);
    setLabel(reconciled.label);
    setAttempt(reconciled.attempt);
    setCompleted(reconciled.completed);
    if (reconciled.clearNotFinished) setNotFinishedYet(false);
    if (reconciled.clearFeedback) {
      setError("");
      setRetry(null);
    } else if (reconciled.clearRetry) {
      setRetry(null);
    }
    if (reconciled.statusMessage) setStatusMessage(reconciled.statusMessage);
  }, [
    profile?.signedIn,
    profile?.optedOut,
    profile?.pending?.id,
    profile?.pending?.code,
    profile?.pending?.url,
    profile?.pending?.label,
    profile?.profile?.profileId,
    profile?.profile?.name,
    profile?.profile?.email,
    profile?.profile?.avatar,
  ]);

  // Move focus to each step's heading on step change (and optionally on initial mount).
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      if (!autoFocusInitial) return;
    }
    headingRef.current?.focus();
  }, [step, autoFocusInitial]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const clearFeedback = useCallback(() => {
    setError("");
    setRetry(null);
    setStatusMessage("");
    setNotFinishedYet(false);
  }, []);

  const runAction = useCallback(async (action: () => Promise<void>, nextRetry: WizardRetry) => {
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
      setRetry(nextRetry);
    } finally {
      setBusy(false);
    }
  }, []);

  const startAttempt = useCallback((isRestart = false) => {
    const deviceLabel = resolveDeviceLabel(labelRef.current);
    const originStep: WizardStep = isRestart ? "verify" : "device";
    void runAction(
      async () => {
        const next = await window.botkins.profileStart(deviceLabel);
        setAttempt({ id: next.id, code: next.code, url: next.url, label: next.label });
        setNotFinishedYet(false);
        setCopied(false);
        setStatusMessage(
          isRestart
            ? "Generated a new verification code. Open profile.botkins.app to verify."
            : "Verification code ready. Open profile.botkins.app to verify this device.",
        );
        setStep("verify");
      },
      { kind: "start", isRestart, step: originStep },
    );
  }, [runAction]);

  const openBrowser = useCallback(() => {
    void runAction(
      async () => {
        await window.botkins.profileOpen();
        setStatusMessage("Opened profile.botkins.app in your browser.");
      },
      { kind: "open", step: "verify" },
    );
  }, [runAction]);

  const finishSetup = useCallback(() => {
    void runAction(
      async () => {
        const session = await window.botkins.profileFinish();
        if (session) {
          const next: CompletedProfile = {
            name: session.name,
            email: session.email,
            avatar: session.avatar,
          };
          setCompleted(next);
          setNotFinishedYet(false);
          setStatusMessage("Profile connected.");
          setStep("done");
        } else {
          setNotFinishedYet(true);
          setStatusMessage("Not finished yet. Complete the browser steps, then choose Finish again.");
        }
      },
      { kind: "finish", step: "verify" },
    );
  }, [runAction]);

  const optOut = useCallback(() => {
    const originStep = localRef.current.step;
    void runAction(
      async () => {
        await window.botkins.profileOptOut();
        setAttempt(null);
        setCompleted(null);
        setNotFinishedYet(false);
        setCopied(false);
        setLabel(defaultDeviceName());
        setStep("intro");
        setStatusMessage("Continuing without a profile.");
      },
      { kind: "optOut", step: originStep },
    );
  }, [runAction]);

  const copyCode = useCallback(async () => {
    const rawCode = attempt?.code;
    if (!rawCode) return;
    try {
      await navigator.clipboard.writeText(rawCode);
      setCopied(true);
      setStatusMessage("Verification code copied to clipboard.");
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the verification code.");
      setRetry({ kind: "copy", step: "verify" });
    }
  }, [attempt?.code]);

  const handleRetry = useCallback(() => {
    if (!retry) return;
    if (retry.kind === "start") startAttempt(retry.isRestart);
    else if (retry.kind === "open") openBrowser();
    else if (retry.kind === "finish") finishSetup();
    else if (retry.kind === "optOut") optOut();
    else if (retry.kind === "copy") void copyCode();
  }, [copyCode, finishSetup, openBrowser, optOut, retry, startAttempt]);

  const activeRetry = retry && retry.step === step ? handleRetry : undefined;
  const retryDisabled = busy || (retry?.kind === "start" && step === "device" && !label.trim());
  const showOptOut = canContinueWithoutProfile({
    optedOut: profile?.optedOut,
    migration,
    inline,
    hasPendingAttempt: Boolean(attempt || profile?.pending),
  });
  const displayCode = verificationCodeDisplay(attempt?.code);

  const handleDeviceSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !label.trim()) return;
    startAttempt(false);
  };

  const doneProfile: CompletedProfile = completed ?? {
    name: profile?.profile?.name ?? "Your profile",
    email: profile?.profile?.email,
    avatar: profile?.profile?.avatar,
  };

  return (
    <div className="profile-root">
      <div className={`profile-wizard${inline ? " is-inline" : ""}`}>
        <div className="profile-wizard-top">
          <StepIndicator current={step} />
          {inline && onCollapse && step !== "done" && (
            <button
              type="button"
              className="profile-collapse-btn"
              onClick={onCollapse}
              aria-label="Collapse profile setup"
              title="Collapse"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Screen-reader live region for step and action status updates */}
        <span className="profile-sr-only" role="status" aria-live="polite">
          {statusMessage}
        </span>

        {step === "intro" && (
          <div className="profile-stage" key="intro">
            <div className="profile-stage-head">
              <h2 id={migration ? "profile-wizard-heading" : undefined} ref={headingRef} tabIndex={-1}>
                {migration ? "Link your existing computers" : "Set up a Botkins profile"}
              </h2>
              <p className="profile-stage-sub">
                {migration
                  ? "Keep your existing workspaces connected under one identity across desktop and mobile."
                  : "Optional continuity for your computers and trusted devices."}
              </p>
            </div>

            {migration && (
              <div className="profile-migration-banner">
                <Compass size={17} aria-hidden="true" />
                <span>
                  This installation has existing bots or chats. Set up a profile to link your existing computers, or
                  continue without a profile. Without one, this workspace stays here and you’ll pair each device
                  separately.
                </span>
              </div>
            )}

            <ul className="profile-benefits" aria-label="What a profile gives you">
              <li className="profile-benefit">
                <span className="profile-benefit-icon" aria-hidden="true">
                  <MonitorSmartphone size={17} />
                </span>
                <span className="profile-benefit-text">
                  <strong>Find and reconnect your computers</strong>
                  <small>Keep your desktop hosts listed so you can switch back anytime.</small>
                </span>
              </li>
              <li className="profile-benefit">
                <span className="profile-benefit-icon" aria-hidden="true">
                  <ShieldCheck size={17} />
                </span>
                <span className="profile-benefit-text">
                  <strong>Approve new devices securely</strong>
                  <small>Confirm phones and computers with a short verification code and your passkey.</small>
                </span>
              </li>
              <li className="profile-benefit">
                <span className="profile-benefit-icon" aria-hidden="true">
                  <Compass size={17} />
                </span>
                <span className="profile-benefit-text">
                  <strong>One directory across devices</strong>
                  <small>Share the same profile name, avatar, and computer list on desktop and mobile.</small>
                </span>
              </li>
            </ul>

            <div className="profile-boundary">
              <HardDrive size={16} aria-hidden="true" />
              <span>
                <strong>Your bots and chats stay on this computer.</strong> A profile never moves your bots,
                conversations, or files off this machine.
              </span>
            </div>

            {!migration && !inline && profile?.optedOut && (
              <div className="profile-notice" role="status">
                <Laptop size={16} aria-hidden="true" />
                <span>
                  This computer is currently local-only. You can set up a profile whenever you want to connect across
                  devices.
                </span>
              </div>
            )}

            <ProfileAlert message={error} onRetry={activeRetry} retryDisabled={retryDisabled} />

            <div className="profile-footer">
              <div>
                {showOptOut && (
                  <button type="button" className="profile-btn-quiet" disabled={busy} onClick={optOut}>
                    Continue without a profile
                  </button>
                )}
              </div>
              <button
                type="button"
                className="profile-btn-primary"
                disabled={busy}
                onClick={() => {
                  clearFeedback();
                  setStep("device");
                }}
              >
                <span>Set up a profile</span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {step === "device" && (
          <form className="profile-stage" key="device" onSubmit={handleDeviceSubmit}>
            <div className="profile-stage-head">
              <h2 id={migration ? "profile-wizard-heading" : undefined} ref={headingRef} tabIndex={-1}>
                Name this device
              </h2>
              <p className="profile-stage-sub">
                This label helps you recognize this computer when approving devices or managing your profile.
              </p>
            </div>

            <div className="profile-field">
              <label htmlFor="profile-device-label">Device name</label>
              <input
                id="profile-device-label"
                className="profile-field-input"
                type="text"
                value={label}
                maxLength={120}
                autoComplete="off"
                placeholder="This Mac"
                onChange={(e) => setLabel(e.target.value)}
              />
              <span className="profile-field-hint">For example: Work MacBook, Studio Mac, or Home PC.</span>
            </div>

            <ProfileAlert message={error} onRetry={activeRetry} retryDisabled={retryDisabled} />

            <div className="profile-footer">
              <button
                type="button"
                className="profile-btn-quiet"
                disabled={busy}
                onClick={() => {
                  clearFeedback();
                  setStep("intro");
                }}
              >
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Back</span>
              </button>
              <button type="submit" className="profile-btn-primary" disabled={busy || !label.trim()}>
                <span>{busy ? "Starting…" : "Continue"}</span>
                {!busy && <ArrowRight size={15} aria-hidden="true" />}
              </button>
            </div>
          </form>
        )}

        {step === "verify" && (
          <div className="profile-stage" key="verify">
            <div className="profile-stage-head">
              <h2 id={migration ? "profile-wizard-heading" : undefined} ref={headingRef} tabIndex={-1}>
                Verify in your browser
              </h2>
              <p className="profile-stage-sub">
                Match this code on profile.botkins.app to confirm <strong>{attempt?.label || label.trim() || "this device"}</strong>, then return here.
              </p>
            </div>

            <div className="profile-code-card">
              <div className="profile-code-block">
                <span className="profile-code-eyebrow">Verification code</span>
                <span
                  className="profile-code-value"
                  aria-label={verificationCodeAriaLabel(attempt?.code)}
                >
                  {displayCode || "— — —"}
                </span>
              </div>
              <button
                type="button"
                className="profile-btn-secondary"
                disabled={!displayCode}
                onClick={() => void copyCode()}
              >
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>

            <ol className="profile-checklist" aria-label="Browser verification steps">
              <li className="profile-check-item">
                <span className="profile-check-num" aria-hidden="true">1</span>
                <span className="profile-check-copy">
                  <strong>Sign in with your passkey</strong>
                  <small>Use an existing passkey or create one on profile.botkins.app.</small>
                </span>
              </li>
              <li className="profile-check-item">
                <span className="profile-check-num" aria-hidden="true">2</span>
                <span className="profile-check-copy">
                  <strong>Approve with a trusted device or email</strong>
                  <small>Confirm this device from another signed-in Botkins app or your email code.</small>
                </span>
              </li>
            </ol>

            <div className="profile-verify-actions">
              <button type="button" className="profile-btn-primary" disabled={busy} onClick={openBrowser}>
                <ExternalLink size={15} aria-hidden="true" />
                <span>Open profile.botkins.app</span>
              </button>
              <button type="button" className="profile-btn-secondary" disabled={busy} onClick={finishSetup}>
                <Check size={15} aria-hidden="true" />
                <span>{busy ? "Checking…" : "Finish"}</span>
              </button>
            </div>

            {notFinishedYet && (
              <div className="profile-notice is-warning">
                <Clock size={16} aria-hidden="true" />
                <span>
                  <strong>Not finished yet.</strong> Complete the passkey and approval steps in your browser, then
                  choose Finish again.
                </span>
              </div>
            )}

            <ProfileAlert message={error} onRetry={activeRetry} retryDisabled={retryDisabled} />

            <div className="profile-footer">
              <button
                type="button"
                className="profile-btn-quiet"
                disabled={busy}
                onClick={() => {
                  clearFeedback();
                  setStep("device");
                }}
              >
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Back</span>
              </button>
              {showOptOut && (
                <button type="button" className="profile-btn-quiet" disabled={busy} onClick={optOut}>
                  Continue without a profile
                </button>
              )}
              <button
                type="button"
                className="profile-btn-quiet"
                disabled={busy}
                onClick={() => startAttempt(true)}
              >
                <RotateCcw size={14} aria-hidden="true" />
                <span>Start over</span>
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="profile-stage profile-done" key="done">
            <div className="profile-done-badge" aria-hidden="true">
              <CheckCircle2 size={28} />
            </div>
            <div className="profile-done-copy">
              <h2 id={migration ? "profile-wizard-heading" : undefined} ref={headingRef} tabIndex={-1}>
                Your profile is ready
              </h2>
              <p>This computer is now connected to your Botkins profile.</p>
            </div>
            <div className="profile-done-identity">
              <span className="profile-done-avatar" aria-hidden="true">
                {doneProfile.avatar || <UserRound size={19} />}
              </span>
              <span className="profile-done-meta">
                <strong>{doneProfile.name}</strong>
                {doneProfile.email && <small>{doneProfile.email}</small>}
              </span>
            </div>
            {inline && (state.profile?.hosts?.length ?? 0) > 0 && (
              <div className="profile-done-hosts">
                <div className="profile-done-hosts-head">
                  <strong>Your computers</strong>
                  <small>Open a computer to use its bots here.</small>
                </div>
                <ProfileComputersList state={state} showEmpty={false} onBusyChange={setOpeningHost} />
              </div>
            )}
            {onComplete && (
              <div className="profile-footer end">
                <button type="button" className="profile-btn-primary" disabled={openingHost} onClick={onComplete}>
                  <span>{inline || migration ? "Continue" : "Manage profile"}</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type ProfileSubView = "index" | "computers" | "devices" | "delete";

function SignedInProfile({ state }: { state: State }) {
  const profile = state.profile!;
  const identity = profile.profile!;
  const pic = useDesktopPicture(state);
  const [view, setView] = useState<ProfileSubView>("index");
  const [editingName, setEditingName] = useState(false);
  const [profileName, setProfileName] = useState(identity.name);
  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const photoMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setProfileName(identity.name);
  }, [identity.profileId, identity.name]);

  // Dismiss popovers on outside click or Escape.
  useEffect(() => {
    if (!photoMenuOpen && !moreMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (photoMenuOpen && photoMenuRef.current && target && !photoMenuRef.current.contains(target)) {
        setPhotoMenuOpen(false);
      }
      if (moreMenuOpen && moreMenuRef.current && target && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setPhotoMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [photoMenuOpen, moreMenuOpen]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pairedServerIds = useMemo(
    () => new Set((state.remote?.hosts ?? []).map((h) => h.id)),
    [state.remote?.hosts],
  );
  const localServerId = state.remote?.unifiedHosts?.find((h) => h.local)?.id;

  const summary = useMemo(
    () =>
      desktopProfileSummary({
        hosts: profile.hosts,
        devices: profile.devices,
        pairedServerIds,
        localServerId,
      }),
    [profile.hosts, profile.devices, pairedServerIds, localServerId],
  );

  const orderedDevices = useMemo(() => orderDesktopDevices(profile.devices), [profile.devices]);
  const pendingBanner = useMemo(() => desktopPendingBanner(profile.pendingDevices), [profile.pendingDevices]);

  const handleSaveName = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = profileName.trim();
    if (busy || !trimmed) return;
    void run(async () => {
      await window.botkins.profileUpdate(trimmed, identity.avatar ?? "");
      setEditingName(false);
      setNote("Profile name updated.");
    });
  };

  const handleSignOut = () => {
    confirmSignOut((msg) => window.confirm(msg), () => void run(() => window.botkins.profileSignOut()));
  };

  const handleDisconnectHost = () => {
    confirmDisconnectHost((msg) => window.confirm(msg), () => void run(() => window.botkins.profileDisconnect()));
  };

  const handleRevokeDevice = (device: { id: string; current?: boolean }) => {
    confirmRevokeDevice(device, (msg) => window.confirm(msg), (id) => void run(() => window.botkins.profileRevoke(id)));
  };

  const handleDeleteSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const outcome = confirmDeleteProfile(
      deleteEmail,
      identity.email,
      (msg) => window.confirm(msg),
      (email) => void run(() => window.botkins.profileDeleteAccount(email)),
    );
    if (!outcome.ok && outcome.error) setError(outcome.error);
  };

  const handleOpenHost = (host: ProfileState["hosts"][number]) => {
    void run(async () => {
      const result = pairedServerIds.has(host.serverId)
        ? { id: host.serverId }
        : await window.botkins.profileConnect(host.serverId);
      await window.botkins.useRemoteHost(result.id);
      setNote(`Connected to ${host.name}.`);
    });
  };

  const feedbackBanner = (error || pic.error || note) && (
    <div className="profile-feedback-stack">
      <ProfileAlert message={error || pic.error} />
      {note && (
        <div className="profile-notice is-success" role="status" aria-live="polite">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{note}</span>
        </div>
      )}
    </div>
  );

  // ------------------------------------------------------------------ Sub-view: Computers
  if (view === "computers") {
    return (
      <div className="profile-root profile-page">
        <div className="profile-subhead">
          <button type="button" className="profile-back-btn" onClick={() => { setError(""); setNote(""); setView("index"); }}>
            <ArrowLeft size={15} aria-hidden="true" />
            <span>Profile</span>
          </button>
          <button
            type="button"
            className="set-button"
            disabled={busy}
            onClick={() => void run(async () => { await window.botkins.profileRefresh(); setNote("Computers refreshed."); })}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="profile-sub-title">
          <h2>Computers</h2>
          <p>{profile.hosts.length === 1 ? "1 in your profile" : `${profile.hosts.length} in your profile`}</p>
        </div>

        {feedbackBanner}

        <Group footer="Offline computers remain listed and will retry binding when they are reachable.">
          {profile.hosts.length ? (
            profile.hosts.map((host) => {
              const isLocal = Boolean(localServerId && host.serverId === localServerId);
              const isPaired = isLocal || pairedServerIds.has(host.serverId);
              const status = desktopHostStatus(host, isPaired);
              return (
                <div className="set-row" key={host.serverId}>
                  <div className="profile-row-main">
                    <span
                      className={`profile-row-icon${host.member ? " is-accent" : status.kind === "ready" ? " is-accent" : ""}`}
                      aria-hidden="true"
                    >
                      {host.member ? <Users size={16} /> : <Monitor size={16} />}
                    </span>
                    <div className="set-label">
                      <span className="set-name">{host.name}</span>
                      <small>{status.subtitle}</small>
                    </div>
                  </div>
                  <div className="set-control">
                    <span className={`set-pill ${status.pillClass}`}>{status.label}</span>
                    {!isLocal && host.hosts.length > 0 && (
                      <button
                        type="button"
                        className="set-button"
                        disabled={busy}
                        onClick={() => handleOpenHost(host)}
                      >
                        {isPaired ? "Open" : "Enroll"}
                      </button>
                    )}
                    {isLocal && !profile.localDisconnected && (
                      <button
                        type="button"
                        className="set-button danger"
                        disabled={busy}
                        onClick={handleDisconnectHost}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="profile-empty-row">
              <span className="profile-row-icon" aria-hidden="true">
                <Monitor size={16} />
              </span>
              <span>No computers yet. Sign in on another computer to add it to your directory.</span>
            </div>
          )}
        </Group>

        {profile.localDisconnected && (
          <Group
            title="This computer"
            footer="This computer was removed from your profile directory. Reconnect it so your other devices can find it."
          >
            <div className="set-row">
              <div className="profile-row-main">
                <span className="profile-row-icon is-warning" aria-hidden="true">
                  <Laptop size={16} />
                </span>
                <div className="set-label">
                  <span className="set-name">Disconnected from directory</span>
                  <small>Other devices cannot find this computer through your profile.</small>
                </div>
              </div>
              <div className="set-control">
                <button
                  type="button"
                  className="set-button primary"
                  disabled={busy}
                  onClick={() => void run(() => window.botkins.profileReconnect())}
                >
                  Connect to profile
                </button>
              </div>
            </div>
          </Group>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------------ Sub-view: Devices
  if (view === "devices") {
    return (
      <div className="profile-root profile-page">
        <div className="profile-subhead">
          <button type="button" className="profile-back-btn" onClick={() => { setError(""); setNote(""); setView("index"); }}>
            <ArrowLeft size={15} aria-hidden="true" />
            <span>Profile</span>
          </button>
          <button
            type="button"
            className="set-button"
            disabled={busy}
            onClick={() => void run(async () => { await window.botkins.profileRefresh(); setNote("Devices refreshed."); })}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="profile-sub-title">
          <h2>Devices</h2>
          <p>Can use your profile</p>
        </div>

        {feedbackBanner}

        {profile.pendingDevices.length > 0 && (
          <Group title="Waiting for you" footer="Approve a device only when you recognize its short code.">
            {profile.pendingDevices.map((device) => {
              const deviceCode = approvalCodes[device.id] ?? "";
              return (
                <div className="set-row profile-pending-row" key={device.id}>
                  <div className="profile-row-main">
                    <span className="profile-row-icon is-warning" aria-hidden="true">
                      <Clock size={16} />
                    </span>
                    <div className="set-label">
                      <span className="set-name">{device.label || "Another device"}</span>
                      <small>{device.code ? `Code ${device.code}` : "Waiting for approval"}</small>
                    </div>
                  </div>
                  <form
                    className="profile-approve-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const trimmed = deviceCode.trim();
                      if (busy || !trimmed) return;
                      void run(async () => {
                        await window.botkins.profileApprove(device.id, trimmed);
                        setApprovalCodes((prev) => {
                          const next = { ...prev };
                          delete next[device.id];
                          return next;
                        });
                        setNote(`Approved ${device.label}.`);
                      });
                    }}
                  >
                    <input
                      className="profile-approve-input"
                      aria-label={"Short code for " + device.label}
                      value={deviceCode}
                      onChange={(e) =>
                        setApprovalCodes((prev) => ({
                          ...prev,
                          [device.id]: e.target.value,
                        }))
                      }
                      placeholder="Short code"
                      autoComplete="off"
                    />
                    <button type="submit" className="set-button primary" disabled={busy || !deviceCode.trim()}>
                      Approve
                    </button>
                  </form>
                </div>
              );
            })}
          </Group>
        )}

        <Group
          title="Trusted"
          footer="Revoking a device removes its profile access without unpairing local computers."
        >
          {orderedDevices.length ? (
            orderedDevices.map((device) => (
              <div className="set-row" key={device.id}>
                <div className="profile-row-main">
                  <span className={`profile-row-icon${device.current ? " is-success" : ""}`} aria-hidden="true">
                    <Laptop size={16} />
                  </span>
                  <div className="set-label">
                    <span className="set-name">{device.label || "Device"}</span>
                    <small>{device.current ? "This device" : "Trusted device"}</small>
                  </div>
                </div>
                <div className="set-control">
                  {!device.current && (
                    <button
                      type="button"
                      className="set-button danger"
                      disabled={busy}
                      onClick={() => handleRevokeDevice(device)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="profile-empty-row">
              <span className="profile-row-icon" aria-hidden="true">
                <Laptop size={16} />
              </span>
              <span>No trusted devices listed yet.</span>
            </div>
          )}
        </Group>
      </div>
    );
  }

  // ------------------------------------------------------------------ Sub-view: Delete profile
  if (view === "delete") {
    return (
      <div className="profile-root profile-page">
        <div className="profile-subhead">
          <button type="button" className="profile-back-btn" onClick={() => { setError(""); setDeleteEmail(""); setView("index"); }}>
            <ArrowLeft size={15} aria-hidden="true" />
            <span>Profile</span>
          </button>
        </div>

        {feedbackBanner}

        <section className="profile-danger-section" aria-labelledby="profile-danger-heading">
          <h3 id="profile-danger-heading" className="profile-danger-heading">
            Delete profile
          </h3>
          <div className="profile-danger-card">
            <div className="profile-danger-banner">
              <AlertTriangle size={17} aria-hidden="true" />
              <div className="profile-danger-banner-copy">
                <strong>Delete Botkins profile?</strong>
                <small>
                  This permanently deletes your hosted Botkins profile, its host directory and trusted devices. Local
                  bots, chats, and unrelated manual pairings stay on this computer.
                </small>
              </div>
            </div>
            <form className="profile-danger-body" onSubmit={handleDeleteSubmit}>
              <div className="profile-field">
                <label htmlFor="profile-delete-email">Confirm verified email</label>
                <input
                  id="profile-delete-email"
                  className="profile-field-input"
                  type="email"
                  maxLength={254}
                  value={deleteEmail}
                  placeholder={identity.email || "you@example.com"}
                  onChange={(e) => setDeleteEmail(e.target.value)}
                  autoFocus
                />
                <span className="profile-field-hint">
                  Type <strong>{identity.email || "your signed-in email"}</strong> to permanently delete this profile.
                </span>
              </div>
              <div className="profile-danger-actions">
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => {
                    setDeleteEmail("");
                    setView("index");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="profile-btn-danger"
                  disabled={busy || !deleteEmail.trim()}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span>Delete profile</span>
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    );
  }

  // ------------------------------------------------------------------ Index view
  return (
    <div className="profile-root profile-page">
      {/* Hidden file picker for photo menu */}
      <input
        ref={pic.inputRef}
        type="file"
        accept={AVATAR_TYPES}
        hidden
        aria-label="Choose a picture"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          pic.handleFile(file);
        }}
      />

      {/* Top right ••• menu */}
      <div className="profile-index-bar">
        <div className="profile-menu-anchor" ref={moreMenuRef}>
          <button
            type="button"
            className="profile-icon-btn"
            aria-label="More profile options"
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            disabled={busy}
            onClick={() => setMoreMenuOpen((open) => !open)}
          >
            <Ellipsis size={18} aria-hidden="true" />
          </button>
          {moreMenuOpen && (
            <div className="profile-popover" role="menu" aria-label="Profile options">
              <button
                type="button"
                role="menuitem"
                className="profile-popover-item"
                disabled={busy}
                onClick={() => {
                  setMoreMenuOpen(false);
                  void run(async () => {
                    await window.botkins.profileRefresh();
                    setNote("Profile refreshed.");
                  });
                }}
              >
                <RefreshCw size={15} aria-hidden="true" />
                <span>Refresh</span>
              </button>
              <div className="profile-popover-info" role="menuitem" aria-disabled="true">
                <strong>Email</strong>
                <small>{identity.email || "No email on file"}</small>
              </div>
              <div className="profile-popover-divider" />
              <button
                type="button"
                role="menuitem"
                className="profile-popover-item is-danger"
                disabled={busy}
                onClick={() => {
                  setMoreMenuOpen(false);
                  setError("");
                  setNote("");
                  setView("delete");
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
                <span>Delete profile…</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Identity hero */}
      <div className="profile-hero">
        <div className="profile-menu-anchor" ref={photoMenuRef}>
          <button
            type="button"
            className="profile-hero-avatar-btn"
            aria-label={pic.avatar ? "Change your photo" : "Add a photo"}
            aria-haspopup="menu"
            aria-expanded={photoMenuOpen}
            disabled={busy || pic.busy}
            onClick={() => setPhotoMenuOpen((open) => !open)}
          >
            <PersonBadge
              person={{ id: pic.me, name: identity.name, avatar: pic.avatar, emoji: pic.avatar ? undefined : identity.avatar }}
              size={88}
              className="profile-hero-badge"
            />
            <span className="profile-hero-cam" aria-hidden="true">
              <Camera size={15} />
            </span>
          </button>
          {photoMenuOpen && (
            <div className="profile-popover profile-popover-center" role="menu" aria-label="Your picture">
              <button
                type="button"
                role="menuitem"
                className="profile-popover-item"
                disabled={pic.busy}
                onClick={() => {
                  setPhotoMenuOpen(false);
                  pic.openPicker();
                }}
              >
                <ImageUp size={15} aria-hidden="true" />
                <span>Choose photo…</span>
              </button>
              {pic.avatar && (
                <button
                  type="button"
                  role="menuitem"
                  className="profile-popover-item is-danger"
                  disabled={pic.busy}
                  onClick={() => {
                    setPhotoMenuOpen(false);
                    pic.removeWithConfirm();
                  }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  <span>Remove photo</span>
                </button>
              )}
            </div>
          )}
        </div>

        <h2 className="profile-hero-name">{identity.name}</h2>
        <p className="profile-hero-sub">Signed in with a passkey</p>

        {editingName ? (
          <form className="profile-inline-name-form" onSubmit={handleSaveName}>
            <input
              className="profile-field-input"
              aria-label="Profile name"
              value={profileName}
              maxLength={60}
              onChange={(e) => setProfileName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="set-button primary" disabled={busy || !profileName.trim()}>
              Save
            </button>
            <button
              type="button"
              className="set-button"
              disabled={busy}
              onClick={() => {
                setProfileName(identity.name);
                setEditingName(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="profile-hero-edit"
            disabled={busy}
            onClick={() => setEditingName(true)}
          >
            Edit name
          </button>
        )}
      </div>

      {feedbackBanner}

      {/* Pending approvals banner — only when pendingDevices is non-empty */}
      {pendingBanner && (
        <div className="profile-pending-banner" role="status">
          <div className="profile-pending-banner-copy">
            <strong>{pendingBanner.title}</strong>
            <small>{pendingBanner.subtitle}</small>
          </div>
          <button
            type="button"
            className="profile-pending-review-btn"
            onClick={() => setView("devices")}
          >
            Review
          </button>
        </div>
      )}

      {/* Two-row index */}
      <Group
        title="Your profile"
        footer="Your profile lets your devices find your computers and lets your bots know it's you."
      >
        <button
          type="button"
          className="set-row profile-index-row"
          onClick={() => setView("computers")}
        >
          <div className="profile-row-main">
            <span className="profile-row-icon is-accent" aria-hidden="true">
              <Monitor size={16} />
            </span>
            <div className="set-label">
              <span className="set-name">Computers</span>
              <small>{summary.computersSubtitle}</small>
            </div>
          </div>
          <div className="profile-index-trailing">
            <span className="profile-index-count">{summary.computersCount}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </div>
        </button>

        <button
          type="button"
          className="set-row profile-index-row"
          onClick={() => setView("devices")}
        >
          <div className="profile-row-main">
            <span className="profile-row-icon is-success" aria-hidden="true">
              <ShieldCheck size={16} />
            </span>
            <div className="set-label">
              <span className="set-name">Trusted devices</span>
              <small>{summary.devicesSubtitle}</small>
            </div>
          </div>
          <div className="profile-index-trailing">
            <span className="profile-index-count">{summary.devicesCount}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </div>
        </button>
      </Group>

      {/* Bottom group: Sign out */}
      <Group>
        <button
          type="button"
          className="set-row profile-index-row is-danger"
          disabled={busy}
          onClick={handleSignOut}
        >
          <div className="profile-row-main">
            <span className="profile-row-icon is-danger" aria-hidden="true">
              <LogOut size={16} />
            </span>
            <div className="set-label">
              <span className="set-name">Sign out</span>
              <small>Local bots, chats, and unrelated pairings stay on this computer</small>
            </div>
          </div>
        </button>
      </Group>
    </div>
  );
}

export default function ProfileSettings({ state }: { state: State }) {
  const isSignedIn = Boolean(state.profile?.signedIn && state.profile.profile);
  const [inWizard, setInWizard] = useState(() => !isSignedIn);

  // Return to the wizard if the user signs out or deletes their profile.
  useEffect(() => {
    if (!isSignedIn) setInWizard(true);
  }, [isSignedIn]);

  // "Your picture" is this computer's team's, with or without a hosted profile.
  if (isSignedIn && !inWizard) {
    return <SignedInProfile state={state} />;
  }

  return (
    <>
      <div className="profile-root profile-page your-picture-page">
        <YourPicture state={state} />
      </div>
      <ProfileWizard
        state={state}
        onComplete={() => setInWizard(false)}
      />
    </>
  );
}

export function useMigrationPrompt(profile?: ProfileState): { open: boolean; dismiss: () => void } {
  const [held, setHeld] = useState(() => Boolean(profile?.migration.needed));

  useEffect(() => {
    setHeld((current) => nextMigrationPromptHeld(current, profile));
  }, [profile?.migration.needed, profile?.signedIn, profile?.profile?.profileId]);

  const dismiss = useCallback(() => setHeld(false), []);
  return { open: nextMigrationPromptHeld(held, profile), dismiss };
}

export function ProfileSetupInline({
  state,
  migration = false,
  onComplete,
}: {
  state: State;
  migration?: boolean;
  onComplete?: () => void;
}) {
  const isSignedIn = Boolean(state.profile?.signedIn);
  const pendingId = state.profile?.pending?.id ?? null;
  const [expanded, setExpanded] = useState(() => !isSignedIn && (migration || Boolean(pendingId)));
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [optOutError, setOptOutError] = useState("");
  const seenPendingIdRef = useRef<string | null>(pendingId);
  const setupButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  const handleOptOut = useCallback(async () => {
    setOptOutBusy(true);
    setOptOutError("");
    try {
      await window.botkins.profileOptOut();
    } catch (e) {
      setOptOutError(errorText(e));
    } finally {
      setOptOutBusy(false);
    }
  }, []);

  // Auto-expand only when a newly seen pending attempt id arrives, not after an explicit collapse.
  useEffect(() => {
    const { nextSeenAttemptId, shouldExpand } = nextAutoExpandState(seenPendingIdRef.current, pendingId);
    seenPendingIdRef.current = nextSeenAttemptId;
    if (shouldExpand) setExpanded(true);
  }, [pendingId]);

  useEffect(() => {
    if (!expanded && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      setupButtonRef.current?.focus();
    }
  }, [expanded]);

  if (migration) {
    return (
      <ProfileWizard
        state={state}
        migration
        autoFocusInitial
        onComplete={onComplete}
      />
    );
  }

  // Keep the wizard open through its Done step if sign-in completes while expanded.
  if (isSignedIn && !expanded) {
    return <ProfileComputersInline state={state} />;
  }
  if (state.profile?.optedOut && !isSignedIn) {
    return null;
  }

  if (!expanded) {
    return (
      <div className="profile-root">
        <div className="profile-teaser">
          <div className="profile-teaser-head">
            <span className="profile-teaser-icon" aria-hidden="true">
              <UserRound size={20} />
            </span>
            <div className="profile-teaser-body">
              <span className="profile-teaser-title">
                <strong>Set up a profile</strong>
                <span className="profile-optional-pill">Optional</span>
              </span>
              <small>Find and reconnect your computers across devices. Local bots stay here.</small>
            </div>
          </div>
          {optOutError && (
            <ProfileAlert
              message={optOutError}
              onRetry={() => void handleOptOut()}
              retryDisabled={optOutBusy}
            />
          )}
          <div className="profile-teaser-actions">
            <button
              type="button"
              className="profile-btn-quiet"
              disabled={optOutBusy}
              onClick={() => void handleOptOut()}
            >
              Continue without a profile
            </button>
            <button
              ref={setupButtonRef}
              type="button"
              className="profile-btn-secondary"
              disabled={optOutBusy}
              onClick={() => {
                setOptOutError("");
                setExpanded(true);
              }}
            >
              <span>Set up</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ProfileWizard
      state={state}
      inline
      autoFocusInitial={expanded}
      onCollapse={() => {
        restoreFocusRef.current = true;
        setExpanded(false);
      }}
      onComplete={() => setExpanded(false)}
    />
  );
}

function ProfileComputersList({
  state,
  showEmpty = true,
  onBusyChange,
}: {
  state: State;
  showEmpty?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paired = new Set((state.remote?.hosts ?? []).map((host) => host.id));
  const hosts = state.profile?.hosts ?? [];

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const connect = async (host: ProfileState["hosts"][number]) => {
    setBusy(true);
    setError("");
    try {
      const result = paired.has(host.serverId) ? { id: host.serverId } : await window.botkins.profileConnect(host.serverId);
      await window.botkins.useRemoteHost(result.id);
      await window.botkins.setPreferences({ onboarded: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hosts.length && !showEmpty) return null;

  return (
    <>
      {hosts.length ? (
        hosts.map((host) => (
          <div className="set-row" key={host.serverId}>
            <div className="profile-row-main">
              <span className="profile-row-icon is-accent" aria-hidden="true">
                <Monitor size={16} />
              </span>
              <div className="set-label">
                <span className="set-name">{host.name}</span>
                <small>
                  {paired.has(host.serverId) ? "Paired on this device" : "Listed in profile · may be offline"}
                </small>
              </div>
            </div>
            <div className="set-control">
              <button
                type="button"
                className="set-button primary"
                disabled={busy}
                onClick={() => void connect(host)}
              >
                Open
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="profile-empty-row">
          <span className="profile-row-icon" aria-hidden="true">
            <Monitor size={16} />
          </span>
          <span>No profile computers are listed yet.</span>
        </div>
      )}

      {error && (
        <div style={{ padding: "0 14px 12px" }}>
          <ProfileAlert message={error} />
        </div>
      )}
    </>
  );
}

function ProfileComputersInline({ state }: { state: State }) {
  const identity = state.profile?.profile;

  return (
    <div className="profile-root">
      <div className="profile-inline-card">
        <div className="profile-inline-head">
          <span className="profile-done-avatar" aria-hidden="true">
            {identity?.avatar || <UserRound size={19} />}
          </span>
          <div className="profile-inline-meta">
            <strong>{identity?.name || "Your Botkins profile"}</strong>
            <small>{identity?.email || "Signed in"}</small>
          </div>
          <span className="set-pill ok">Signed in</span>
        </div>

        <ProfileComputersList state={state} />

        <div className="profile-inline-foot">
          Choose a listed computer to open its bots here, or pick a setup option below.
        </div>
      </div>
    </div>
  );
}

export function ProfileMigrationPrompt({ state, onDismiss }: { state: State; onDismiss?: () => void }) {
  return (
    <WelcomeFrame label="profile-wizard-heading">
      <div className="welcome-card profile-migration-card">
        <WelcomeLogo />
        <ProfileSetupInline state={state} migration onComplete={onDismiss} />
      </div>
    </WelcomeFrame>
  );
}
