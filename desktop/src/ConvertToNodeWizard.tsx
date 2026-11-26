// One-step wizard to convert an existing full Botkins host into a Node host.
// Steps: 1) Overview  2) Local inventory  3) Per-bot choices  4) Review & confirm  5) Progress  6) Finish
import { useEffect, useMemo, useState } from "react";
import type {
  NodeConversionAction,
  NodeConversionInspect,
  NodeConversionJob,
  NodeConversionPlan,
  NodeConversionUndoResult,
  NodeHostState,
} from "./types";
import { errorText } from "./SettingsRows";
import "./node-convert.css";

const STEPS = [
  { id: 1, label: "Overview" },
  { id: 2, label: "Inventory" },
  { id: 3, label: "Choose bots" },
  { id: 4, label: "Review" },
  { id: 5, label: "Convert" },
  { id: 6, label: "Done" },
] as const;

type BotChoice = { action: NodeConversionAction; targetHostId?: string };

function stageLabel(stage: string) {
  switch (stage) {
    case "pending":
      return "Waiting";
    case "routines_disabled":
      return "Routines paused on source";
    case "transferring":
      return "Transferring bundle…";
    case "verified":
      return "Verified on destination";
    case "cleaned":
      return "Removed from source";
    case "done":
      return "Moved & verified";
    case "kept":
      return "Kept locally (shared)";
    case "deleted":
      return "Deleted after snapshot";
    case "failed":
      return "Stopped (source untouched)";
    default:
      return stage;
  }
}

function stageTone(stage: string): "online" | "warn" | "danger" | "" {
  if (stage === "done" || stage === "kept" || stage === "deleted") return "online";
  if (stage === "failed") return "danger";
  if (stage === "pending") return "";
  return "warn";
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export type ConvertToNodeWizardProps = {
  onClose: () => void;
  fail: (error: unknown) => void;
  /** Optional initial step & preloaded data (useful for resuming or visual previews). */
  initialStep?: 1 | 2 | 3 | 4 | 5 | 6;
  initialInspect?: NodeConversionInspect | null;
  initialPlan?: NodeConversionPlan | null;
  initialJob?: NodeConversionJob | null;
  initialNodeHost?: NodeHostState | null;
};

export default function ConvertToNodeWizard({
  onClose,
  fail,
  initialStep,
  initialInspect,
  initialPlan,
  initialJob,
  initialNodeHost,
}: ConvertToNodeWizardProps) {
  const api = window.botkins;
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(initialStep ?? 1);
  const [loading, setLoading] = useState(!initialInspect);
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState<NodeConversionInspect | null>(initialInspect ?? null);
  const [nodeName, setNodeName] = useState(initialInspect?.suggestedName ?? "");
  const [choices, setChoices] = useState<Record<string, BotChoice>>(() => {
    const map: Record<string, BotChoice> = {};
    const firstOnline = initialInspect?.targets.find((h) => h.online && !h.unavailable)?.serverId;
    for (const bot of initialInspect?.bots ?? []) {
      map[bot.id] = firstOnline ? { action: "move", targetHostId: firstOnline } : { action: "keep" };
    }
    if (initialPlan) {
      for (const bp of initialPlan.botPlans) {
        map[bp.botId] = { action: bp.action, ...(bp.targetHostId ? { targetHostId: bp.targetHostId } : {}) };
      }
    }
    return map;
  });
  const [sharedProjects, setSharedProjects] = useState<string[]>(() =>
    (initialInspect?.shared.projects.items ?? []).filter((p) => p.shared && p.hasFolder).map((p) => p.id),
  );
  const [confirmDelete, setConfirmDelete] = useState("");
  const [plan, setPlan] = useState<NodeConversionPlan | null>(initialPlan ?? null);
  const [job, setJob] = useState<NodeConversionJob | null>(initialJob ?? null);
  const [resultNodeHost, setResultNodeHost] = useState<NodeHostState | null>(initialNodeHost ?? null);
  const [undoResult, setUndoResult] = useState<NodeConversionUndoResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (initialInspect) return;
    let active = true;
    setLoading(true);
    api
      .nodeConvertInspect()
      .then((data) => {
        if (!active) return;
        setInspect(data);
        setNodeName(data.suggestedName || "Node Host");
        const firstOnline = data.targets.find((h) => h.online && !h.unavailable)?.serverId;
        const initChoices: Record<string, BotChoice> = {};
        for (const bot of data.bots) {
          initChoices[bot.id] = firstOnline ? { action: "move", targetHostId: firstOnline } : { action: "keep" };
        }
        setChoices(initChoices);
        setSharedProjects(data.shared.projects.items.filter((p) => p.shared && p.hasFolder).map((p) => p.id));
        if (data.activeJob && (data.activeJob.status === "paused" || data.activeJob.status === "failed")) {
          setJob(data.activeJob);
        }
      })
      .catch((e) => {
        if (active) fail(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, fail, initialInspect]);

  const onlineTargets = useMemo(
    () => (inspect?.targets ?? []).filter((h) => h.online && !h.unavailable),
    [inspect?.targets],
  );
  const allTargets = inspect?.targets ?? [];

  function applySameForAll(action: NodeConversionAction, targetHostId?: string) {
    if (!inspect) return;
    const next: Record<string, BotChoice> = {};
    for (const bot of inspect.bots) {
      next[bot.id] = { action, ...(action === "move" ? { targetHostId: targetHostId ?? onlineTargets[0]?.serverId } : {}) };
    }
    setChoices(next);
  }

  function setBotChoice(botId: string, patch: Partial<BotChoice>) {
    setChoices((prev) => {
      const current = prev[botId] ?? { action: "keep" as NodeConversionAction };
      const next: BotChoice = { ...current, ...patch };
      if (next.action === "move" && !next.targetHostId) {
        next.targetHostId = onlineTargets[0]?.serverId;
      }
      if (next.action !== "move") {
        delete next.targetHostId;
      }
      return { ...prev, [botId]: next };
    });
  }

  function toggleShareProject(projectId: string) {
    setSharedProjects((prev) => (prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]));
  }

  function buildPlanPayload() {
    const botActions = (inspect?.bots ?? []).map((bot) => ({
      botId: bot.id,
      ...(choices[bot.id] ?? { action: "keep" }),
    }));
    return {
      nodeName: nodeName.trim() || inspect?.suggestedName || "Node Host",
      botActions,
      sharedProjects,
      ...(confirmDelete ? { confirmDelete } : {}),
    };
  }

  async function goToReview() {
    setLocalError(null);
    setBusy(true);
    try {
      const built = await api.nodeConvertPlan(buildPlanPayload());
      setPlan(built);
      if (!built.valid && built.errors.length > 0) {
        setLocalError(built.errors[0]);
        return;
      }
      setStep(4);
    } catch (e) {
      setLocalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function startConversion(resume = false) {
    setLocalError(null);
    setStep(5);
    setBusy(true);
    try {
      const payload = resume
        ? { resume: true, ...(job?.id ? { jobId: job.id } : {}) }
        : { ...buildPlanPayload(), confirmDelete: confirmDelete.trim() };
      const result = await api.nodeConvertRun(payload);
      setJob(result.job);
      setResultNodeHost(result.nodeHost);
      if (result.job.status === "completed") {
        setStep(6);
      } else if (result.job.error) {
        setLocalError(result.job.error);
      }
    } catch (e) {
      setLocalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    setLocalError(null);
    setBusy(true);
    try {
      const res = await api.nodeConvertUndo(job?.snapshotId ? { snapshotId: job.snapshotId } : undefined);
      setUndoResult(res);
      setResultNodeHost(res.nodeHost);
    } catch (e) {
      setLocalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="ncw-root">
        <div className="ncw-card">
          <p className="ncw-sub">Inspecting local bots, chats, routines, skills, panels, wiki, and vault…</p>
        </div>
      </div>
    );
  }

  if (!inspect) {
    return (
      <div className="ncw-root">
        <div className="ncw-banner danger">Could not inspect this computer.</div>
        <div className="ncw-actions">
          <button type="button" className="set-button" onClick={onClose}>
            Back to Node host
          </button>
        </div>
      </div>
    );
  }

  const deleteRequired = !!plan?.requiresDeleteConfirmation;
  const deleteReady = !deleteRequired || confirmDelete.trim() === (plan?.deleteConfirmationPhrase || "DELETE");

  return (
    <div className="ncw-root" data-wizard-step={step}>
      <div className="ncw-header">
        <div>
          <h3 className="ncw-title">Convert this computer to a Node host</h3>
          <p className="ncw-sub">
            Safely move, keep, or delete local bots and switch this computer to Node host mode.
          </p>
        </div>
        <button type="button" className="set-button" disabled={busy && step === 5} onClick={onClose}>
          Close
        </button>
      </div>

      <div className="ncw-steps" aria-label="Conversion steps">
        {STEPS.map((s) => (
          <span
            key={s.id}
            className={`ncw-step-pill ${step === s.id ? "active" : step > s.id ? "done" : ""}`}
          >
            <span>{s.id}.</span>
            <span>{s.label}</span>
          </span>
        ))}
      </div>

      {localError && <div className="ncw-banner danger">{localError}</div>}

      {/* STEP 1: OVERVIEW */}
      {step === 1 && (
        <>
          <div className="ncw-card">
            <h4 className="ncw-card-title">What changes when you convert</h4>
            <ul className="ncw-list">
              <li>
                <strong>Node host role turns on:</strong> this computer stays linked to your profile, shares any project folders you allow, and never re-opens first-run setup.
              </li>
              <li>
                <strong>You decide per bot:</strong> move a bot to another online host you own, keep it locally as a shared bot through cross-host Teamwork, or delete it.
              </li>
              <li>
                <strong>Routines never run twice:</strong> moved routines are disabled here first, verified on the destination host, and only enabled there once this host cleans up.
              </li>
              <li>
                <strong>Local backup first + one-click Undo:</strong> Botkins takes a full local snapshot before moving or deleting anything. Your phone pairing stays intact.
              </li>
              <li>
                <strong>Vault secrets stay local:</strong> encrypted credentials in your vault are never sent in plaintext over the network and remain safely on this computer.
              </li>
            </ul>
          </div>

          <div className="ncw-card">
            <div className="ncw-field">
              <label htmlFor="ncw-node-name">Node host name</label>
              <input
                id="ncw-node-name"
                className="ncw-input"
                type="text"
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                placeholder="e.g. Studio Mac or Home Server"
              />
              <span className="ncw-stat-note">Shown on your other Botkins computers and in approval prompts.</span>
            </div>
          </div>

          {job && (job.status === "paused" || job.status === "failed") && (
            <div className="ncw-banner warn">
              <strong>Interrupted conversion found:</strong> a previous conversion stopped cleanly before finishing. You can resume without duplicating already-moved bots.
              <div style={{ marginTop: 8 }}>
                <button type="button" className="set-button primary" onClick={() => void startConversion(true)}>
                  Resume previous conversion
                </button>
              </div>
            </div>
          )}

          <div className="ncw-actions">
            <button type="button" className="set-button" onClick={onClose}>
              Cancel
            </button>
            <div className="ncw-actions-right">
              <button
                type="button"
                className="set-button primary"
                disabled={!nodeName.trim()}
                onClick={() => setStep(2)}
              >
                Inspect local data
              </button>
            </div>
          </div>
        </>
      )}

      {/* STEP 2: INVENTORY */}
      {step === 2 && (
        <>
          <div className="ncw-card">
            <h4 className="ncw-card-title">Local bots ({inspect.bots.length})</h4>
            {inspect.bots.length === 0 ? (
              <p className="ncw-sub">No local bots found on this computer.</p>
            ) : (
              inspect.bots.map((bot) => (
                <div className="ncw-bot-card" key={bot.id}>
                  <div className="ncw-bot-head">
                    <div>
                      <span className="ncw-bot-name">{bot.name}</span>
                      {bot.role && <span className="ncw-bot-role">{bot.role}</span>}
                    </div>
                  </div>
                  <div className="ncw-chips">
                    <span className="ncw-chip">{bot.chatCount} chats ({bot.messageCount} messages)</span>
                    <span className="ncw-chip">
                      {bot.routineCount} routines{bot.routineTimezones.length ? ` (${bot.routineTimezones.join(", ")})` : ""}
                    </span>
                    <span className="ncw-chip">Memory: {formatBytes(bot.memoryBytes)}</span>
                    <span className="ncw-chip">{bot.profileFiles.length} profile files</span>
                    <span className="ncw-chip">{bot.panelCount} Today panels</span>
                    <span className="ncw-chip">{bot.skillCount} skills</span>
                    <span className="ncw-chip">{bot.plugins.length} plugins</span>
                    <span className="ncw-chip">{bot.projectRefs.length} project refs</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="ncw-card">
            <h4 className="ncw-card-title">Shared host items</h4>
            <div className="ncw-grid">
              <div className="ncw-stat">
                <span className="ncw-stat-label">Wiki pages</span>
                <span className="ncw-stat-value">{inspect.shared.wiki.pageCount}</span>
                <span className="ncw-stat-note">Kept locally on node</span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Skills &amp; plugins</span>
                <span className="ncw-stat-value">
                  {inspect.shared.skills.customCount} / {inspect.shared.plugins.count}
                </span>
                <span className="ncw-stat-note">Custom skills / plugins</span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Today panels</span>
                <span className="ncw-stat-value">{inspect.shared.panels.count}</span>
                <span className="ncw-stat-note">{inspect.shared.panels.botOwnedCount} owned by bots</span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Vault entries</span>
                <span className="ncw-stat-value">{inspect.shared.vault.count}</span>
                <span className="ncw-stat-note">Stay encrypted locally</span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Projects</span>
                <span className="ncw-stat-value">{inspect.shared.projects.count}</span>
                <span className="ncw-stat-note">
                  {inspect.shared.projects.items.filter((p) => p.hasFolder).length} with local folder
                </span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Group chats</span>
                <span className="ncw-stat-value">{inspect.shared.groupChats.count}</span>
                <span className="ncw-stat-note">Multi-bot local rooms</span>
              </div>
            </div>
            {inspect.shared.vault.count > 0 && (
              <div className="ncw-banner info">
                <strong>Vault security:</strong> {inspect.shared.vault.note}
              </div>
            )}
          </div>

          <div className="ncw-actions">
            <button type="button" className="set-button" onClick={() => setStep(1)}>
              Back
            </button>
            <div className="ncw-actions-right">
              <button type="button" className="set-button primary" onClick={() => setStep(3)}>
                Choose what happens to each bot
              </button>
            </div>
          </div>
        </>
      )}

      {/* STEP 3: PER-BOT CHOICES */}
      {step === 3 && (
        <>
          <div className="ncw-card">
            <h4 className="ncw-card-title">Choose what happens to each bot</h4>

            {inspect.bots.length > 1 && (
              <div className="ncw-shortcut">
                <span style={{ fontSize: "calc(12.5px * var(--text-scale))", fontWeight: 600 }}>
                  Same for all ({inspect.bots.length} bots):
                </span>
                <div className="ncw-choices">
                  <button
                    type="button"
                    className="set-button"
                    disabled={onlineTargets.length === 0}
                    onClick={() => applySameForAll("move", onlineTargets[0]?.serverId)}
                  >
                    Move all{onlineTargets[0] ? ` to ${onlineTargets[0].name}` : ""}
                  </button>
                  <button type="button" className="set-button" onClick={() => applySameForAll("keep")}>
                    Keep all locally
                  </button>
                  <button type="button" className="set-button danger" onClick={() => applySameForAll("delete")}>
                    Delete all
                  </button>
                </div>
              </div>
            )}

            {onlineTargets.length === 0 && (
              <div className="ncw-banner warn">
                No other same-owner hosts are currently online. Bring another computer online to move bots, or choose <strong>Keep locally</strong> (shared via cross-host Teamwork) or <strong>Delete</strong>.
              </div>
            )}

            {inspect.bots.map((bot) => {
              const choice = choices[bot.id] ?? { action: "keep" as NodeConversionAction };
              return (
                <div className="ncw-bot-card" key={bot.id}>
                  <div className="ncw-bot-head">
                    <div>
                      <span className="ncw-bot-name">{bot.name}</span>
                      {bot.role && <span className="ncw-bot-role">{bot.role}</span>}
                    </div>
                    <span className="ncw-stat-note">
                      {bot.chatCount} chats · {bot.routineCount} routines · {bot.panelCount} panels
                    </span>
                  </div>

                  <div className="ncw-choices">
                    <button
                      type="button"
                      className={`ncw-choice ${choice.action === "move" ? "selected" : ""}`}
                      disabled={onlineTargets.length === 0}
                      onClick={() => setBotChoice(bot.id, { action: "move" })}
                    >
                      Move to another host
                    </button>
                    <button
                      type="button"
                      className={`ncw-choice ${choice.action === "keep" ? "selected" : ""}`}
                      onClick={() => setBotChoice(bot.id, { action: "keep" })}
                    >
                      Keep locally (shared bot)
                    </button>
                    <button
                      type="button"
                      className={`ncw-choice danger ${choice.action === "delete" ? "selected" : ""}`}
                      onClick={() => setBotChoice(bot.id, { action: "delete" })}
                    >
                      Delete
                    </button>

                    {choice.action === "move" && (
                      <select
                        className="ncw-select"
                        aria-label={`Destination host for ${bot.name}`}
                        value={choice.targetHostId ?? ""}
                        onChange={(e) => setBotChoice(bot.id, { action: "move", targetHostId: e.target.value })}
                      >
                        {allTargets.map((host) => (
                          <option key={host.serverId} value={host.serverId} disabled={!host.online || host.unavailable}>
                            {host.name}
                            {!host.online || host.unavailable ? " (Offline)" : ` (Online · ${host.botCount} bots)`}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {inspect.shared.projects.items.some((p) => p.hasFolder) && (
            <div className="ncw-card">
              <h4 className="ncw-card-title">Project folders to share from this node</h4>
              {inspect.shared.projects.items
                .filter((p) => p.hasFolder)
                .map((project) => (
                  <label
                    key={project.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      cursor: "pointer",
                    }}
                  >
                    <span>
                      <strong>{project.name}</strong>
                      <span className="ncw-bot-role ncw-mono">{project.folder}</span>
                    </span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={sharedProjects.includes(project.id)}
                      onChange={() => toggleShareProject(project.id)}
                    />
                  </label>
                ))}
            </div>
          )}

          <div className="ncw-actions">
            <button type="button" className="set-button" onClick={() => setStep(2)}>
              Back
            </button>
            <div className="ncw-actions-right">
              <button type="button" className="set-button primary" disabled={busy} onClick={() => void goToReview()}>
                {busy ? "Building plan…" : "Review conversion plan"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* STEP 4: REVIEW & CONFIRM */}
      {step === 4 && plan && (
        <>
          <div className="ncw-card">
            <h4 className="ncw-card-title">Review conversion summary</h4>
            <div className="ncw-grid">
              <div className="ncw-stat">
                <span className="ncw-stat-label">Moving</span>
                <span className="ncw-stat-value">{plan.counts.moveBots}</span>
                <span className="ncw-stat-note">
                  {plan.counts.chatsMoving} chats · {plan.counts.routinesMoving} routines
                </span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Keeping locally</span>
                <span className="ncw-stat-value">{plan.counts.keepBots}</span>
                <span className="ncw-stat-note">Shared via Teamwork</span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Deleting</span>
                <span className="ncw-stat-value">{plan.counts.deleteBots}</span>
                <span className="ncw-stat-note">After local snapshot</span>
              </div>
              <div className="ncw-stat">
                <span className="ncw-stat-label">Vault secrets</span>
                <span className="ncw-stat-value">{plan.counts.vaultEntriesLeftBehind}</span>
                <span className="ncw-stat-note">Stay encrypted here</span>
              </div>
            </div>

            {plan.botPlans.length > 0 && (
              <table className="ncw-table">
                <thead>
                  <tr>
                    <th>Bot</th>
                    <th>Action</th>
                    <th>Destination</th>
                    <th>Items</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.botPlans.map((bp) => (
                    <tr key={bp.botId}>
                      <td>
                        <strong>{bp.botName}</strong>
                      </td>
                      <td>
                        <span
                          className={`ncw-chip ${
                            bp.action === "delete" ? "danger" : bp.action === "move" ? "online" : ""
                          }`}
                        >
                          {bp.action === "move" ? "Move" : bp.action === "keep" ? "Keep locally" : "Delete"}
                        </span>
                      </td>
                      <td>
                        {bp.action === "move"
                          ? bp.targetHostName || bp.targetHostId
                          : bp.action === "keep"
                            ? `${plan.nodeName} (shared bot)`
                            : "Removed after backup"}
                      </td>
                      <td>
                        {bp.chatCount} chats, {bp.routineCount} routines, {bp.panelCount} panels
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="ncw-banner info">
              <strong>Local backup snapshot folder:</strong>{" "}
              <span className="ncw-mono">{plan.snapshotDir}</span>
              <br />
              A complete backup is saved here before anything moves or is deleted. Phone pairing is preserved.
            </div>

            {plan.warnings.map((warning, i) => (
              <div className="ncw-banner warn" key={i}>
                {warning}
              </div>
            ))}

            {deleteRequired && (
              <div className="ncw-confirm-box">
                <label htmlFor="ncw-delete-confirm" style={{ fontWeight: 700, color: "var(--danger)" }}>
                  Confirm deletion: type {plan.deleteConfirmationPhrase} to remove {plan.counts.deleteBots} bot
                  {plan.counts.deleteBots === 1 ? "" : "s"} after snapshot
                </label>
                <input
                  id="ncw-delete-confirm"
                  className="ncw-input"
                  type="text"
                  value={confirmDelete}
                  onChange={(e) => setConfirmDelete(e.target.value)}
                  placeholder={`Type ${plan.deleteConfirmationPhrase}`}
                />
              </div>
            )}
          </div>

          <div className="ncw-actions">
            <button type="button" className="set-button" onClick={() => setStep(3)}>
              Back
            </button>
            <div className="ncw-actions-right">
              <button
                type="button"
                className="set-button primary"
                disabled={busy || !deleteReady}
                onClick={() => void startConversion(false)}
              >
                Convert to Node host
              </button>
            </div>
          </div>
        </>
      )}

      {/* STEP 5: PROGRESS */}
      {step === 5 && (
        <>
          <div className="ncw-card">
            <h4 className="ncw-card-title">
              {busy
                ? "Converting this computer to a Node host…"
                : job?.status === "paused" || job?.status === "failed"
                  ? "Conversion paused safely"
                  : "Conversion progress"}
            </h4>

            <div className="ncw-progress-row">
              <span>
                <strong>1. Local backup snapshot</strong>
                {job?.snapshotPath && (
                  <div className="ncw-stat-note ncw-mono">{job.snapshotPath}</div>
                )}
              </span>
              <span className={`ncw-chip ${job?.snapshotId ? "online" : "warn"}`}>
                {job?.snapshotId ? "Saved" : "Creating…"}
              </span>
            </div>

            {(job?.items ?? plan?.botPlans ?? []).map((item) => {
              const stage = "stage" in item ? item.stage : "pending";
              const error = "error" in item ? item.error : null;
              return (
                <div className="ncw-progress-row" key={item.botId}>
                  <div>
                    <strong>{item.botName}</strong>
                    <span className="ncw-bot-role">
                      {item.action === "move"
                        ? `Move → ${item.targetHostName || item.targetHostId}`
                        : item.action === "keep"
                          ? "Keep locally (shared)"
                          : "Delete"}
                    </span>
                    {error && <div className="ncw-stat-note" style={{ color: "var(--danger)" }}>{error}</div>}
                  </div>
                  <span className={`ncw-chip ${stageTone(stage)}`}>{stageLabel(stage)}</span>
                </div>
              );
            })}
          </div>

          {!busy && job && (job.status === "paused" || job.status === "failed") && (
            <div className="ncw-banner warn">
              Unmoved bots and data remain untouched on this computer. Once the destination host is online, click <strong>Resume conversion</strong> to continue cleanly without duplicates.
            </div>
          )}

          <div className="ncw-actions">
            {job?.snapshotId && !busy && (
              <button type="button" className="set-button danger" onClick={() => void handleUndo()}>
                Undo conversion
              </button>
            )}
            <div className="ncw-actions-right">
              {!busy && job && (job.status === "paused" || job.status === "failed") && (
                <button type="button" className="set-button primary" onClick={() => void startConversion(true)}>
                  Resume conversion
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* STEP 6: FINISH */}
      {step === 6 && (
        <>
          {undoResult ? (
            <div className="ncw-banner success">
              <strong>Conversion undone.</strong> Restored {undoResult.restoredBots} bot(s) and {undoResult.restoredChats} chat(s) from snapshot{" "}
              <span className="ncw-mono">{undoResult.snapshotId}</span>.
              {undoResult.pausedToPreventDupes.length > 0 && (
                <div>
                  Paused {undoResult.pausedToPreventDupes.length} routine(s) locally because a destination host was unreachable during rollback.
                </div>
              )}
            </div>
          ) : (
            <div className="ncw-card">
              <div className="ncw-bot-head">
                <h4 className="ncw-card-title">{resultNodeHost?.name || job?.nodeName || nodeName}</h4>
                <span className="ncw-chip online">Node host · Online</span>
              </div>
              <p className="ncw-sub">
                This computer is now running in Node host mode. Your phone link and pairings were preserved, and first-run setup will not reappear.
              </p>

              {job && job.items.length > 0 && (
                <table className="ncw-table">
                  <thead>
                    <tr>
                      <th>Bot</th>
                      <th>Now lives on</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.items.map((item) => (
                      <tr key={item.botId}>
                        <td>
                          <strong>{item.botName}</strong>
                        </td>
                        <td>
                          {item.action === "move"
                            ? item.targetHostName || item.targetHostId
                            : item.action === "keep"
                              ? `${job.nodeName} (shared bot via Teamwork)`
                              : "Deleted (in local snapshot)"}
                        </td>
                        <td>
                          <span className="ncw-chip online">{stageLabel(item.stage)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {job?.snapshotPath && (
                <div className="ncw-banner info">
                  <strong>Backup snapshot kept at:</strong>{" "}
                  <span className="ncw-mono">{job.snapshotPath}</span>
                  <br />
                  You can undo this conversion in one click while this snapshot exists.
                </div>
              )}
            </div>
          )}

          <div className="ncw-actions">
            {!undoResult && job?.snapshotId ? (
              <button type="button" className="set-button danger" disabled={busy} onClick={() => void handleUndo()}>
                {busy ? "Undoing…" : "Undo conversion"}
              </button>
            ) : (
              <span />
            )}
            <div className="ncw-actions-right">
              <button type="button" className="set-button primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
