// The Screen choice: whether a paired phone may view or control this computer's screen, the macOS
// permissions that choice needs, and who is watching. Settings › Phone and the side pane's Screen
// panel show these same rows, so a bot opening the panel shows the person's own switch and nothing more.
import { useEffect, useState } from "react";
import { Check, MonitorUp, TriangleAlert } from "lucide-react";
import type { PhoneLink, State } from "./types";
import { Group, errorText } from "./SettingsRows";
import { Choices } from "./Preferences";
import "./integrations.css";

const api = window.botkins;

type ScreenMode = PhoneLink["screen"]["mode"];
const SCREEN_MODES: { id: ScreenMode; name: string }[] = [
  { id: "off", name: "Off" },
  { id: "view", name: "View only" },
  { id: "control", name: "View and control" },
];
const SCREEN_HELP: Record<ScreenMode, string> = {
  off: "A paired phone can't see this screen.",
  view: "A paired phone can watch this screen.",
  control: "A paired phone can watch this screen, and click and type.",
};

/** One permission macOS gives: allowed, or a Grant button that asks for it. */
export function Permission({ name, help, granted, busy, grant }: { name: string; help: string; granted: boolean; busy: boolean; grant: () => void }) {
  return (
    <div className="set-row int-item compact phone-permission">
      <div className="set-label">
        <span className="set-name">{name}</span>
        <small>{help}</small>
      </div>
      <div className="set-control">
        {granted ? (
          <span className="phone-allowed" role="status" aria-label={name + " is allowed"}>
            <Check size={14} aria-hidden="true" />
            Allowed
          </span>
        ) : (
          <button type="button" className="set-button" aria-label={"Grant " + name} disabled={busy} onClick={grant}>
            Grant
          </button>
        )}
      </div>
    </div>
  );
}

/** True while a permission the screen choice needs is still missing: it is switched on outside this window. */
export const screenWaiting = (screen: PhoneLink["screen"] | undefined) =>
  !!screen && screen.permissions.system && screen.mode !== "off" && (!screen.permissions.screenRecording || (screen.mode === "control" && !screen.permissions.accessibility));

/** The Screen rows: the choice, the permissions it needs, and the phones watching now. */
export function ScreenRows({ status, busy, run }: { status: PhoneLink; busy: boolean; run: (fn: () => Promise<PhoneLink | void>) => void }) {
  return (
    <>
      <div className="set-row">
        <div className="set-label">
          <span className="set-name">Screen</span>
          <small>{SCREEN_HELP[status.screen.mode]}</small>
          {status.screen.setBy && <small>Set by {status.screen.setBy.name}</small>}
        </div>
        <div className="set-control">
          <Choices label="Screen" value={status.screen.mode} options={SCREEN_MODES} onChange={(mode) => run(() => api.setPhoneScreen(mode))} />
        </div>
      </div>
      {/* What macOS has to allow for the choice to work. Grant asks macOS and opens the page where Botkins is switched on. */}
      {status.screen.permissions.system && status.screen.mode !== "off" && (
        <Permission
          name="Screen Recording"
          help={status.screen.permissions.screenRecording ? "A phone can see this screen." : "Lets a phone see this screen. Switch Botkins on in System Settings; macOS may then ask to reopen Botkins."}
          granted={status.screen.permissions.screenRecording}
          busy={busy}
          grant={() => run(() => api.requestScreenPermission("screenRecording"))}
        />
      )}
      {status.screen.permissions.system && status.screen.mode === "control" && (
        <Permission
          name="Accessibility"
          help={status.screen.permissions.accessibility ? "A phone can click and type." : "Lets a phone click and type. Switch Botkins on in System Settings."}
          granted={status.screen.permissions.accessibility}
          busy={busy}
          grant={() => run(() => api.requestScreenPermission("accessibility"))}
        />
      )}
      {status.screen.viewers.map((viewer) => (
        <div className="set-row int-item compact" key={viewer.deviceId}>
          <span className="int-glyph" aria-hidden="true">
            <MonitorUp size={14} />
          </span>
          <div className="set-label">
            <span className="set-name" role="status">
              {viewer.name} is viewing this screen
            </span>
          </div>
          <div className="set-control">
            <button type="button" className="set-button danger" disabled={busy} onClick={() => run(() => api.setPhoneScreen("off"))}>
              Stop
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * The side pane's Screen panel: the same rows as Settings › Phone. Showing it reads the setting
 * and changes nothing; only the person's own choice here changes it.
 */
export function ScreenPanel({ state }: { state: State }) {
  const [status, setStatus] = useState<PhoneLink>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = state.phones?.revision ?? 0;
  const load = () =>
    api
      .phoneLink()
      .then((s) => {
        setStatus(s);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, [revision]);
  // As in Settings › Phone: while a permission is missing, look again now and then.
  const waiting = screenWaiting(status?.screen);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 2500);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [waiting]);
  async function run(fn: () => Promise<PhoneLink | void>) {
    setError("");
    setBusy(true);
    try {
      const next = await fn();
      if (next) setStatus(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="int-section pane-screen">
      <p className="pane-screen-note">A bot opened this panel. Whether a phone may see or use this screen is your choice.</p>
      {!status ? (
        error ? (
          <p className="set-status error-text" role="alert">
            Couldn't check phone access. {error}{" "}
            <button type="button" className="set-link" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : (
          <p className="set-status" role="status">
            Checking phone access…
          </p>
        )
      ) : status.locked ? (
        <div className="cred-lost" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>Phone access was set up by the installed Botkins app. Choose this there.</span>
        </div>
      ) : status.enabled ? (
        <>
          <Group>
            <ScreenRows status={status} busy={busy} run={(fn) => void run(fn)} />
          </Group>
          {error && (
            <p className="set-status error-text" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <p className="set-status">Phone access is off, so no phone can see this screen. It is turned on in Settings › Phone.</p>
      )}
    </div>
  );
}
