import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Monitor, RefreshCw, ShieldCheck } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { globalAccess, grantOf, grantSummary, openBotPage } from "./access";
import type { ComputerUseStatus, State } from "./types";
import "./records.css";
import "./access.css";

function ComputerUseSection({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.botkins?.computerUseStatus) return;
    setBusy(true);
    try {
      setStatus(await window.botkins.computerUseStatus());
    } catch {
      // ignore on remote/older host
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refresh]);

  const request = async (kind: "accessibility" | "screenRecording") => {
    if (!window.botkins?.requestComputerUsePermission) return;
    setBusy(true);
    try {
      setStatus(await window.botkins.requestComputerUsePermission(kind));
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="access-cua" aria-label="Computer use">
      <label className="switch-row">
        <span>
          <strong>Computer use on this computer</strong>
          <small>
            Let bots in your owner chats inspect and click native apps using the bundled CUA driver (background mode by default; password fields require the vault).
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="Computer use on this computer"
          checked={enabled}
          onChange={(e) => void window.botkins.setPreferences({ computerUse: e.target.checked }).catch(() => {})}
        />
      </label>

      {enabled && status && (
        <div className="access-cua-card">
          <div className="access-cua-head">
            <span className="access-cua-title">
              <Monitor size={14} />
              <strong>System permissions &amp; driver</strong>
            </span>
            <button type="button" className="ghost-btn" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {!status.bundled && (
            <p className="access-cua-warn">
              Bundled CUA driver (v{status.version}) is not present in this build.
            </p>
          )}

          {status.platform === "darwin" && (
            <div className="access-cua-perms">
              <div className="access-cua-perm-row">
                <span>
                  <strong>Accessibility</strong>
                  <small>Required to read app controls and send background clicks or typing.</small>
                </span>
                {status.permissions.accessibility ? (
                  <span className="primary-badge"><ShieldCheck size={12} /> Granted</span>
                ) : (
                  <button type="button" onClick={() => void request("accessibility")} disabled={busy}>
                    Grant Accessibility
                  </button>
                )}
              </div>
              <div className="access-cua-perm-row">
                <span>
                  <strong>Screen Recording</strong>
                  <small>Required for window snapshots and live phone screen preview. macOS may ask you to reopen Botkins after granting.</small>
                </span>
                {status.permissions.screenRecording ? (
                  <span className="primary-badge"><ShieldCheck size={12} /> Granted</span>
                ) : (
                  <button type="button" onClick={() => void request("screenRecording")} disabled={busy}>
                    Grant Screen Recording
                  </button>
                )}
              </div>
            </div>
          )}

          {status.notes?.length > 0 && (
            <div className="access-cua-notes">
              {status.notes.map((line, idx) => (
                <p key={idx} className="access-cua-note">{line}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Settings › Access: whether every bot can use every project, and if not, who can use what. */
export default function AccessSettings({ state }: { state: State }) {
  const everyone = globalAccess(state);
  const projects = state.projects?.length ?? 0;
  return (
    <div className="access-settings">
      <ComputerUseSection enabled={state.settings.computerUse === true} />
      <label className="switch-row">
        <span>
          <strong>All bots can use every project</strong>
          <small>
            {everyone
              ? "Any bot can chat in any project and keep its to-do list."
              : "Each bot uses only the projects granted on its page."}
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="All bots can use every project"
          checked={everyone}
          onChange={(e) => void window.botkins.setPreferences({ access: { allBots: e.target.checked } }).catch(() => {})}
        />
      </label>
      {!everyone && (
        <section className="access-overview" aria-label="Access by bot">
          <div className="access-overview-head">
            <strong>Access by bot</strong>
            <small>
              {projects} {projects === 1 ? "project" : "projects"}
            </small>
          </div>
          <ul className="edit-list">
            {state.bots.map((b) => {
              const g = grantOf(b);
              const none = !g.all && !g.projects.length;
              return (
                <li key={b.id}>
                  <button className="access-bot" onClick={() => openBotPage(b.id)} aria-label={b.name + ": " + grantSummary(state, b) + ". Open bot page"}>
                    <BotAvatar bot={b} size={30} />
                    <span className="grow">
                      <strong>{b.name}</strong>
                      <small className={none ? "no-access" : ""}>{grantSummary(state, b)}</small>
                    </span>
                    {g.all && (
                      <span className="primary-badge">
                        <ShieldCheck size={12} /> All
                      </span>
                    )}
                    <ChevronRight size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
          <small className="access-foot">Choose a bot to change what it can use.</small>
        </section>
      )}
    </div>
  );
}
