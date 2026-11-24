import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock,
  Compass,
  Copy,
  ExternalLink,
  HardDrive,
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
import { Group, errorText } from "./SettingsRows";
import { WelcomeFrame, WelcomeLogo } from "./Welcome";
import "./profile.css";

const PROFILE_AVATARS = ["", "🌱", "🌊", "🌙", "☀️", "🦊", "🐈", "🌻", "🪐"] as const;

const AVATAR_NAMES: Record<string, string> = {
  "": "No avatar",
  "🌱": "Seedling",
  "🌊": "Wave",
  "🌙": "Crescent moon",
  "☀️": "Sun",
  "🦊": "Fox",
  "🐈": "Cat",
  "🌻": "Sunflower",
  "🪐": "Ringed planet",
};

type WizardStep = "intro" | "device" | "verify" | "done";

const WIZARD_STEPS: ReadonlyArray<{ id: WizardStep; label: string }> = [
  { id: "intro", label: "Overview" },
  { id: "device", label: "Device" },
  { id: "verify", label: "Browser" },
  { id: "done", label: "Done" },
];

type CompletedProfile = {
  name: string;
  email?: string;
  avatar?: string;
};

function defaultDeviceName(pendingLabel?: string): string {
  if (pendingLabel?.trim()) return pendingLabel.trim();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mac/i.test(ua)) return "This Mac";
  if (/Windows/i.test(ua)) return "This PC";
  return "This computer";
}

function formatShortCode(code: string): string {
  const clean = code.trim();
  return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
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
  onSignedIn,
  onComplete,
}: {
  state: State;
  migration?: boolean;
  inline?: boolean;
  autoFocusInitial?: boolean;
  onCollapse?: () => void;
  onSignedIn?: (completed: CompletedProfile) => void;
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
  const [error, setError] = useState("");
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [notFinishedYet, setNotFinishedYet] = useState(false);
  const [copied, setCopied] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const didMountRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);

  // Sync pending attempt if the host updates it while we are on the verify step.
  useEffect(() => {
    if (profile?.pending && (!attempt || profile.pending.id !== attempt.id)) {
      setAttempt(profile.pending);
    }
  }, [profile?.pending?.id, profile?.pending?.code, profile?.pending?.url, profile?.pending?.label]);

  // Auto-advance to Done if state.profile becomes signed-in while the wizard is open.
  useEffect(() => {
    if (step !== "done" && profile?.signedIn && profile.profile) {
      const next: CompletedProfile = {
        name: profile.profile.name,
        email: profile.profile.email,
        avatar: profile.profile.avatar,
      };
      setCompleted(next);
      setNotFinishedYet(false);
      setError("");
      setRetryAction(null);
      setStatusMessage("Profile connected.");
      onSignedIn?.(next);
      setStep("done");
    }
  }, [step, profile?.signedIn, profile?.profile?.profileId, profile?.profile?.name, profile?.profile?.email, profile?.profile?.avatar, onSignedIn]);

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
    setRetryAction(null);
    setStatusMessage("");
    setNotFinishedYet(false);
  }, []);

  const runAction = useCallback(async (action: () => Promise<void>, retry: () => void) => {
    setBusy(true);
    setError("");
    setRetryAction(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
      setRetryAction(() => retry);
    } finally {
      setBusy(false);
    }
  }, []);

  const startAttempt = useCallback((isRestart = false) => {
    const deviceLabel = label.trim() || "This device";
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
      () => startAttempt(isRestart),
    );
  }, [label, runAction]);

  const openBrowser = useCallback(() => {
    void runAction(
      async () => {
        await window.botkins.profileOpen();
        setStatusMessage("Opened profile.botkins.app in your browser.");
      },
      () => openBrowser(),
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
          onSignedIn?.(next);
          setStep("done");
        } else {
          setNotFinishedYet(true);
          setStatusMessage("Not finished yet. Complete the browser steps, then choose Finish again.");
        }
      },
      () => finishSetup(),
    );
  }, [onSignedIn, runAction]);

  const optOut = useCallback(() => {
    void runAction(
      async () => {
        await window.botkins.profileOptOut();
        setStatusMessage("Continuing without a profile.");
      },
      () => optOut(),
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
      setRetryAction(() => () => void copyCode());
    }
  }, [attempt?.code]);

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

            {error && (
              <div className="profile-alert" role="alert">
                <span className="profile-alert-body">
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{error}</span>
                </span>
                {retryAction && (
                  <button type="button" className="set-button" disabled={busy} onClick={retryAction}>
                    Retry
                  </button>
                )}
              </div>
            )}

            <div className="profile-footer">
              <div>
                {(!profile?.optedOut || migration || inline) && (
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

            {error && (
              <div className="profile-alert" role="alert">
                <span className="profile-alert-body">
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{error}</span>
                </span>
                {retryAction && (
                  <button type="button" className="set-button" disabled={busy} onClick={retryAction}>
                    Retry
                  </button>
                )}
              </div>
            )}

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
                  aria-label={attempt?.code ? `Verification code ${attempt.code.split("").join(" ")}` : "Verification code pending"}
                >
                  {attempt?.code ? formatShortCode(attempt.code) : "— — —"}
                </span>
              </div>
              <button
                type="button"
                className="profile-btn-secondary"
                disabled={!attempt?.code}
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
              <div className="profile-notice is-warning" role="status" aria-live="polite">
                <Clock size={16} aria-hidden="true" />
                <span>
                  <strong>Not finished yet.</strong> Complete the passkey and approval steps in your browser, then
                  choose Finish again.
                </span>
              </div>
            )}

            {error && (
              <div className="profile-alert" role="alert">
                <span className="profile-alert-body">
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{error}</span>
                </span>
                {retryAction && (
                  <button type="button" className="set-button" disabled={busy} onClick={retryAction}>
                    Retry
                  </button>
                )}
              </div>
            )}

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
            {onComplete && (
              <div className="profile-footer end">
                <button type="button" className="profile-btn-primary" onClick={onComplete}>
                  <span>{inline ? "Continue" : "Manage profile"}</span>
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

function SignedInProfile({ state }: { state: State }) {
  const profile = state.profile!;
  const identity = profile.profile!;
  const [profileName, setProfileName] = useState(identity.name);
  const [profileAvatar, setProfileAvatar] = useState(identity.avatar ?? "");
  const [deleteEmail, setDeleteEmail] = useState("");
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const avatarRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setProfileName(identity.name);
    setProfileAvatar(identity.avatar ?? "");
  }, [identity.profileId, identity.name, identity.avatar]);

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

  const hasIdentityChanges =
    profileName.trim() !== identity.name || profileAvatar !== (identity.avatar ?? "");

  const handleAvatarKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const count = PROFILE_AVATARS.length;
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIdx = (idx + 1) % count;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIdx = (idx - 1 + count) % count;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = count - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    setProfileAvatar(PROFILE_AVATARS[nextIdx]);
    avatarRefs.current[nextIdx]?.focus();
  };

  return (
    <div className="profile-root profile-page">
      {(error || note) && (
        <div className="profile-feedback-stack">
          {error && (
            <div className="profile-alert" role="alert">
              <span className="profile-alert-body">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{error}</span>
              </span>
            </div>
          )}
          {note && (
            <div className="profile-notice is-success" role="status" aria-live="polite">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{note}</span>
            </div>
          )}
        </div>
      )}

      <Group
        title="Your profile"
        footer="Your profile account is separate from each computer's local bots and chats."
      >
        <div className="profile-hero">
          <span className="profile-avatar-badge" aria-hidden="true">
            {identity.avatar || <UserRound size={24} />}
          </span>
          <div className="profile-hero-info">
            <div className="profile-hero-name-row">
              <h3 className="profile-hero-name">{identity.name}</h3>
              <span className="set-pill ok">Signed in</span>
            </div>
            <span className="profile-hero-email">{identity.email || "Signed in with passkey"}</span>
          </div>
          <div className="set-control">
            <button
              type="button"
              className="set-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.botkins.profileRefresh();
                  setNote("Profile refreshed.");
                })
              }
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <form
          className="profile-edit-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !profileName.trim()) return;
            void run(async () => {
              await window.botkins.profileUpdate(profileName.trim(), profileAvatar.trim());
              setNote("Profile identity updated.");
            });
          }}
        >
          <div className="profile-field">
            <label htmlFor="profile-name">Profile name</label>
            <input
              id="profile-name"
              className="profile-field-input"
              value={profileName}
              maxLength={60}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <span className="profile-field-hint">Shown to people approving or pairing this device.</span>
          </div>

          <div className="profile-field">
            <label id="profile-avatar-label">Avatar</label>
            <div className="profile-avatar-grid" role="radiogroup" aria-labelledby="profile-avatar-label">
              {PROFILE_AVATARS.map((avatar, idx) => {
                const selected = profileAvatar === avatar;
                const label = AVATAR_NAMES[avatar] || avatar;
                return (
                  <button
                    key={avatar || "none"}
                    ref={(el) => {
                      avatarRefs.current[idx] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    title={label}
                    tabIndex={selected ? 0 : -1}
                    className="profile-avatar-tile"
                    onClick={() => setProfileAvatar(avatar)}
                    onKeyDown={(e) => handleAvatarKeyDown(e, idx)}
                  >
                    {avatar ? avatar : <UserRound size={18} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
            <span className="profile-field-hint">Optional emoji shared with your profile devices.</span>
          </div>

          <div className="profile-footer end">
            <button
              type="submit"
              className="profile-btn-primary"
              disabled={busy || !profileName.trim() || !hasIdentityChanges}
            >
              Save profile
            </button>
          </div>
        </form>
      </Group>

      <Group
        title="Computers"
        footer="Offline computers remain listed and will retry binding when they are reachable."
      >
        {profile.hosts.length ? (
          profile.hosts.map((host) => (
            <div className="set-row" key={host.serverId}>
              <div className="profile-row-main">
                <span className={`profile-row-icon${host.hosts.length ? " is-accent" : ""}`} aria-hidden="true">
                  {host.member ? <Users size={16} /> : <Monitor size={16} />}
                </span>
                <div className="set-label">
                  <span className="set-name">{host.name}</span>
                  <small>
                    {host.hosts.length ? host.hosts.join(" · ") : "Offline or unavailable"}
                  </small>
                </div>
              </div>
              <div className="set-control">
                {host.member && <span className="set-pill">Team member</span>}
                <span className={`set-pill${host.hosts.length ? " ok" : ""}`}>
                  {host.hosts.length ? "Reachable" : "Offline"}
                </span>
              </div>
            </div>
          ))
        ) : (
          <div className="profile-empty-row">
            <span className="profile-row-icon" aria-hidden="true">
              <Monitor size={16} />
            </span>
            <span>No computers yet. Sign in on another computer to add it to your directory.</span>
          </div>
        )}
      </Group>

      <Group
        title="Trusted devices"
        footer="Approve a device only when you recognize its short code. Revoking removes its profile access without unpairing local computers."
      >
        {profile.devices.map((device) => (
          <div className="set-row" key={device.id}>
            <div className="profile-row-main">
              <span className={`profile-row-icon${device.current ? " is-success" : ""}`} aria-hidden="true">
                <Laptop size={16} />
              </span>
              <div className="set-label">
                <span className="set-name">{device.label}</span>
                <small>{device.current ? "This device" : device.id}</small>
              </div>
            </div>
            <div className="set-control">
              {device.current ? (
                <span className="set-pill ok">Current</span>
              ) : (
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => void run(() => window.botkins.profileRevoke(device.id))}
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}

        {profile.pendingDevices.map((device) => {
          const deviceCode = approvalCodes[device.id] ?? "";
          return (
            <div className="set-row profile-pending-row" key={device.id}>
              <div className="profile-row-main">
                <span className="profile-row-icon is-warning" aria-hidden="true">
                  <Clock size={16} />
                </span>
                <div className="set-label">
                  <span className="set-name">{device.label}</span>
                  <small>Waiting for approval</small>
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

        {!profile.devices.length && !profile.pendingDevices.length && (
          <div className="profile-empty-row">
            <span className="profile-row-icon" aria-hidden="true">
              <Laptop size={16} />
            </span>
            <span>No trusted devices listed yet.</span>
          </div>
        )}
      </Group>

      <Group
        title="This computer"
        footer="Disconnecting removes only this computer from the hosted directory. It does not sign out the account or delete local bots and chats."
      >
        <div className="set-row">
          <div className="profile-row-main">
            <span
              className={`profile-row-icon ${profile.localDisconnected ? "is-warning" : "is-success"}`}
              aria-hidden="true"
            >
              <Laptop size={16} />
            </span>
            <div className="set-label">
              <span className="set-name">
                {profile.localDisconnected ? "Disconnected from directory" : "Connected to directory"}
              </span>
              <small>
                {profile.localDisconnected
                  ? "Other devices cannot find this computer through your profile."
                  : "Other signed-in devices can find and reconnect to this computer."}
              </small>
            </div>
          </div>
          <div className="set-control">
            {profile.localDisconnected ? (
              <button
                type="button"
                className="set-button primary"
                disabled={busy}
                onClick={() => void run(() => window.botkins.profileReconnect())}
              >
                Connect this host to profile
              </button>
            ) : (
              <button
                type="button"
                className="set-button"
                disabled={busy}
                onClick={() => void run(() => window.botkins.profileDisconnect())}
              >
                Disconnect this host from profile
              </button>
            )}
          </div>
        </div>

        <div className="set-row profile-signout-row">
          <div className="profile-row-main">
            <span className="profile-row-icon" aria-hidden="true">
              <LogOut size={16} />
            </span>
            <div className="set-label">
              <span className="set-name">Sign out on this computer</span>
              <small>Local bots, chats, and unrelated manual pairings stay on this computer.</small>
            </div>
          </div>
          <div className="set-control">
            <button
              type="button"
              className="set-button"
              disabled={busy}
              onClick={() => void run(() => window.botkins.profileSignOut())}
            >
              Sign out of profile
            </button>
          </div>
        </div>
      </Group>

      <section className="profile-danger-section" aria-labelledby="profile-danger-heading">
        <h3 id="profile-danger-heading" className="profile-danger-heading">
          Danger zone
        </h3>
        <div className="profile-danger-card">
          <div className="profile-danger-banner">
            <AlertTriangle size={17} aria-hidden="true" />
            <div className="profile-danger-banner-copy">
              <strong>Delete profile</strong>
              <small>
                This permanently deletes your hosted Botkins profile and computer directory. Local bots, chats, and
                unrelated manual pairings stay on this computer.
              </small>
            </div>
          </div>
          <div className="profile-danger-body">
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
              />
              <span className="profile-field-hint">
                Type <strong>{identity.email || "your signed-in email"}</strong> to permanently delete this profile.
              </span>
            </div>
            <div className="profile-danger-actions">
              <button
                type="button"
                className="profile-btn-danger"
                disabled={busy || !deleteEmail.trim()}
                onClick={() => {
                  if (window.confirm("Delete this hosted Botkins profile permanently?")) {
                    void run(() => window.botkins.profileDeleteAccount(deleteEmail.trim()));
                  }
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>Delete profile</span>
              </button>
            </div>
          </div>
        </div>
      </section>
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

  if (isSignedIn && !inWizard) {
    return <SignedInProfile state={state} />;
  }

  return (
    <ProfileWizard
      state={state}
      onComplete={() => setInWizard(false)}
    />
  );
}

export function ProfileSetupInline({ state, migration = false }: { state: State; migration?: boolean }) {
  const isSignedIn = Boolean(state.profile?.signedIn);
  const [expanded, setExpanded] = useState(() => !isSignedIn && (migration || Boolean(state.profile?.pending)));

  // If a pending attempt appears while collapsed, expand so the user can see their code.
  useEffect(() => {
    if (state.profile?.pending && !expanded) setExpanded(true);
  }, [state.profile?.pending?.id, expanded]);

  // Keep the wizard open through its Done step if sign-in completes while expanded.
  if (isSignedIn && !expanded) {
    return <ProfileComputersInline state={state} />;
  }
  if (state.profile?.optedOut && !isSignedIn) {
    return null;
  }

  if (!expanded && !migration) {
    return (
      <div className="profile-root">
        <div className="profile-teaser">
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
          <div className="profile-teaser-actions">
            <button
              type="button"
              className="profile-btn-secondary"
              onClick={() => setExpanded(true)}
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
      migration={migration}
      inline={!migration}
      autoFocusInitial={expanded}
      onCollapse={migration ? undefined : () => setExpanded(false)}
      onComplete={() => setExpanded(false)}
    />
  );
}

function ProfileComputersInline({ state }: { state: State }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paired = new Set((state.remote?.hosts ?? []).map((host) => host.id));
  const hosts = state.profile?.hosts ?? [];
  const identity = state.profile?.profile;

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
            <div className="profile-alert" role="alert">
              <span className="profile-alert-body">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{error}</span>
              </span>
            </div>
          </div>
        )}

        <div className="profile-inline-foot">
          Choose a listed computer to open its bots here, or pick a setup option below.
        </div>
      </div>
    </div>
  );
}

export function ProfileMigrationPrompt({ state }: { state: State }) {
  return (
    <WelcomeFrame label="profile-wizard-heading">
      <div className="welcome-card profile-migration-card">
        <WelcomeLogo />
        <ProfileSetupInline state={state} migration />
      </div>
    </WelcomeFrame>
  );
}

