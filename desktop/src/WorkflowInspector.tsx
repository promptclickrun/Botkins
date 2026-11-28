// Right-hand Inspector panel for Workflows:
// - "Step" tab: edit selected trigger / agent / model / condition / approval / output node,
//   with `WorkflowFieldInput` (`{{field}}` chips & picker), webhook secret rotation, and structured outputs.
// - "Runs" tab: run history with per-step statuses, durations, outputs, Approve/Reject controls,
//   and Retry from failed step (using the node's current settings).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Filter,
  GitBranch,
  KeyRound,
  Link2,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import { categories as goalCategories } from "./Board";
import { useAsk } from "./Pages";
import { WorkflowFieldInput } from "./WorkflowFieldInput";
import type {
  Bot,
  Chat,
  ModelInfo,
  Workflow,
  WorkflowConditionRule,
  WorkflowFieldDef,
  WorkflowGithubCatalog,
  WorkflowGithubDelivery,
  WorkflowGithubStatus,
  WorkflowNode,
  WorkflowRun,
  WorkflowTriggerKind,
} from "./types";
import type { NodeFieldAnalysis } from "./workflowAnalysis";
import { TRIGGER_FIELDS } from "./workflowAnalysis";
import {
  canShowUncertainRetry,
  deriveGithubAccessAlerts,
  extractCanonicalEvents,
  extractConfiguredRepos,
  filterLabelOptions,
  findGithubUncertainStep,
  groupDeliveriesByOutcome,
  groupReposByOwner,
  hasGithubUncertainFailure,
  isGithubUncertainStep,
  isIssueOnlyGithubTrigger,
  latestReplayableDelivery,
  normalizeLabelColor,
  PR_ONLY_ACTIONS,
  resolveGithubUncertainDetails,
  resolveOutputTargetRepos,
  shouldClearLabelsOnRepoChange,
  SKIP_REASON_META,
  WORKFLOW_GITHUB_ACTION_OPTIONS,
  WORKFLOW_GITHUB_EVENT_GROUPS,
  WORKFLOW_GITHUB_EVENT_LABELS,
  workflowRunStatusLabel,
  workflowStepStatusLabel,
  type GithubAccessAlert,
  type GithubUncertainDetails,
  type WorkflowGithubAction,
} from "./workflowGithub";

const api = window.botkins;

const CONDITION_OPS: Array<{ value: WorkflowConditionRule["op"]; label: string }> = [
  { value: "equals", label: "equals (=)" },
  { value: "not_equals", label: "does not equal (!=)" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "in", label: "is one of (comma-separated)" },
  { value: "matches", label: "matches regex" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "exists", label: "is present" },
  { value: "empty", label: "is empty" },
];

function useGithubStatus(triggerKey: string) {
  const [status, setStatus] = useState<WorkflowGithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const loadStatus = useCallback(async (includeRepos = true) => {
    try {
      const next = await api.workflowGithubStatus({ includeRepos });
      setStatus(next);
      setError(null);
      return next;
    } catch (err: any) {
      setError(err?.message || "Could not check GitHub CLI status.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadStatus(true);
  }, [triggerKey, loadStatus]);

  // Poll ONLY while an interactive device-code sign-in is actively pending.
  const waiting = status?.signIn?.status === "waiting" || status?.signIn?.status === "starting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void loadStatus(true);
    }, 2500);
    return () => clearInterval(timer);
  }, [waiting, loadStatus]);

  const handleStartSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const signIn = await api.workflowGithubSignInStart();
      setStatus((prev) =>
        prev
          ? { ...prev, signIn }
          : { installed: true, authenticated: false, login: null, scopes: [], repos: [], installUrl: "https://cli.github.com/", signIn },
      );
      if (signIn.status === "done") {
        await loadStatus(true);
      }
    } catch (err: any) {
      setError(err?.message || "Could not start GitHub sign-in.");
    } finally {
      setBusy(false);
    }
  };

  const handleCancelSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.workflowGithubSignInCancel();
      setStatus(next);
    } catch (err: any) {
      setError(err?.message || "Could not cancel GitHub sign-in.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyAndOpen = () => {
    const code = status?.signIn?.code;
    const url = status?.signIn?.url || "https://github.com/login/device";
    if (code) {
      api.copyText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1800);
    }
    void api.openLink(url);
  };

  return { status, loading, busy, error, copiedCode, loadStatus, handleStartSignIn, handleCancelSignIn, handleCopyAndOpen };
}

function GithubAccessAlertsBar({
  alerts,
  onConnect,
  onOpenGithub,
}: {
  alerts: GithubAccessAlert[];
  onConnect: () => void;
  onOpenGithub: () => void;
}) {
  if (!alerts.length) return null;
  return (
    <div className="wf-gh-alerts" role="status" aria-live="polite">
      {alerts.map((alert) => (
        <div key={alert.kind} className={`wf-gh-alert wf-gh-alert-${alert.kind}`}>
          <AlertTriangle size={14} className="wf-gh-alert-icon" aria-hidden="true" />
          <div className="wf-gh-alert-body">
            <strong>{alert.title}</strong>
            <span>{alert.detail}</span>
          </div>
          {alert.action === "github" ? (
            <button type="button" className="wf-mini-btn" onClick={onOpenGithub}>
              <ExternalLink size={11} /> GitHub
            </button>
          ) : (
            <button type="button" className="wf-mini-btn wf-mini-btn-primary" onClick={onConnect}>
              <KeyRound size={11} /> {alert.action === "reconnect" ? "Reconnect" : "Connect"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function GithubMultiRepoPicker({
  selected,
  available,
  onChange,
}: {
  selected: string[];
  available: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [customRepo, setCustomRepo] = useState("");

  const allRepos = useMemo(() => [...new Set([...selected, ...available])], [selected, available]);
  const groups = useMemo(() => groupReposByOwner(allRepos, query), [allRepos, query]);
  const selectedLower = useMemo(() => new Set(selected.map((r) => r.toLowerCase())), [selected]);

  const toggle = (repo: string) => {
    const low = repo.toLowerCase();
    const next = selectedLower.has(low)
      ? selected.filter((r) => r.toLowerCase() !== low)
      : [...selected, repo];
    onChange(next);
  };

  const addCustom = () => {
    const cleaned = customRepo.trim().replace(/^\/+|\/+$/g, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(cleaned)) return;
    if (!selectedLower.has(cleaned.toLowerCase())) {
      onChange([...selected, cleaned]);
    }
    setCustomRepo("");
  };

  return (
    <div className="wf-subbox wf-gh-picker">
      <div className="wf-subbox-head">
        <span className="wf-label">Repositories ({selected.length})</span>
        {selected.length > 0 && (
          <button type="button" className="wf-mini-btn" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="wf-gh-chip-wrap">
          {selected.map((repo) => (
            <span key={repo} className="wf-gh-selected-chip">
              <span>{repo}</span>
              <button
                type="button"
                aria-label={`Remove ${repo}`}
                onClick={() => toggle(repo)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="wf-gh-search-row">
        <Search size={12} className="wf-gh-search-icon" aria-hidden="true" />
        <input
          type="text"
          value={query}
          placeholder="Filter repositories by owner or name…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {groups.length > 0 ? (
        <div className="wf-gh-grouped-list" role="listbox" aria-multiselectable="true" aria-label="Repositories">
          {groups.map((grp) => (
            <div key={grp.owner} className="wf-gh-owner-group">
              <div className="wf-gh-owner-head">{grp.owner}</div>
              {grp.repos.map((repo) => {
                const checked = selectedLower.has(repo.toLowerCase());
                const shortName = repo.slice(repo.indexOf("/") + 1);
                return (
                  <button
                    key={repo}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    className={`wf-gh-pick-row ${checked ? "active" : ""}`}
                    onClick={() => toggle(repo)}
                  >
                    <span className="wf-gh-check-box">{checked && <Check size={11} />}</span>
                    <span className="wf-gh-pick-name">{shortName}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <p className="wf-hint">{query.trim() ? "No matching repositories." : "Add a repository below or connect GitHub to browse."}</p>
      )}

      <div className="wf-gh-custom-row">
        <input
          type="text"
          value={customRepo}
          placeholder="Add owner/repo manually…"
          onChange={(e) => setCustomRepo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button type="button" className="wf-mini-btn" onClick={addCustom} disabled={!/^[\w.-]+\/[\w.-]+$/.test(customRepo.trim())}>
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

function GithubColorLabelPicker({
  label,
  selected,
  catalog,
  loading,
  onChange,
}: {
  label: string;
  selected: string[];
  catalog: WorkflowGithubCatalog["labels"];
  loading: boolean;
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  const options = useMemo(() => filterLabelOptions(catalog, selected, query), [catalog, selected, query]);
  const selectedLower = useMemo(() => new Set(selected.map((s) => s.toLowerCase())), [selected]);

  const toggle = (name: string) => {
    const low = name.toLowerCase();
    onChange(selectedLower.has(low) ? selected.filter((s) => s.toLowerCase() !== low) : [...selected, name]);
  };

  const addCustom = () => {
    const cleaned = custom.trim();
    if (!cleaned) return;
    if (!selectedLower.has(cleaned.toLowerCase())) onChange([...selected, cleaned]);
    setCustom("");
  };

  return (
    <div className="wf-subbox wf-gh-picker">
      <div className="wf-subbox-head">
        <span className="wf-label">
          {label} {selected.length > 0 ? `(${selected.length})` : ""}
        </span>
        {loading && <LoaderCircle size={12} className="wf-spin" />}
      </div>

      {selected.length > 0 && (
        <div className="wf-gh-chip-wrap">
          {selected.map((name) => {
            const match = options.find((o) => o.name.toLowerCase() === name.toLowerCase());
            const dotColor = normalizeLabelColor(match?.color);
            return (
              <span key={name} className="wf-gh-selected-chip">
                <span className="wf-gh-color-dot" style={{ backgroundColor: dotColor }} />
                <span>{name}</span>
                <button type="button" aria-label={`Remove label ${name}`} onClick={() => toggle(name)}>
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {options.length > 5 && (
        <div className="wf-gh-search-row">
          <Search size={12} className="wf-gh-search-icon" aria-hidden="true" />
          <input
            type="text"
            value={query}
            placeholder="Filter labels…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {options.length > 0 ? (
        <div className="wf-gh-label-list" role="listbox" aria-multiselectable="true" aria-label={label}>
          {options.slice(0, 60).map((opt) => {
            const active = selectedLower.has(opt.name.toLowerCase());
            return (
              <button
                key={opt.name}
                type="button"
                role="option"
                aria-selected={active}
                className={`wf-gh-label-pill ${active ? "active" : ""}`}
                title={opt.description || opt.name}
                onClick={() => toggle(opt.name)}
              >
                <span className="wf-gh-color-dot" style={{ backgroundColor: normalizeLabelColor(opt.color) }} />
                <span>{opt.name}</span>
                {active && <Check size={11} />}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="wf-hint">{loading ? "Loading repository labels…" : "No labels loaded yet. Type a label below or select a repo."}</p>
      )}

      <div className="wf-gh-custom-row">
        <input
          type="text"
          value={custom}
          placeholder="Add custom label…"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button type="button" className="wf-mini-btn" onClick={addCustom} disabled={!custom.trim()}>
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

function skipReasonIcon(reason: WorkflowGithubDelivery["reason"]) {
  switch (reason) {
    case "self":
      return <Repeat size={11} aria-hidden="true" />;
    case "chain":
      return <Link2 size={11} aria-hidden="true" />;
    case "offline":
      return <WifiOff size={11} aria-hidden="true" />;
    case "refused":
      return <ShieldAlert size={11} aria-hidden="true" />;
    default:
      return <Filter size={11} aria-hidden="true" />;
  }
}

function GithubDeliveryLog({
  workflowId,
  nodeId,
  onSelectRun,
  onTabRuns,
  onReplayLast,
}: {
  workflowId: string;
  nodeId: string;
  onSelectRun: (runId: string) => void;
  onTabRuns: () => void;
  onReplayLast?: (nodeId: string) => Promise<void>;
}) {
  const [deliveries, setDeliveries] = useState<WorkflowGithubDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const loadDeliveries = useCallback(async () => {
    if (!api.workflowGithubDeliveries) return;
    setLoading(true);
    try {
      const list = await api.workflowGithubDeliveries(workflowId, nodeId);
      setDeliveries(Array.isArray(list) ? list : []);
    } catch {
      setDeliveries([]);
    } finally {
      setLoading(false);
    }
  }, [workflowId, nodeId]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  const groups = useMemo(() => groupDeliveriesByOutcome(deliveries), [deliveries]);
  const replayable = useMemo(() => latestReplayableDelivery(deliveries), [deliveries]);

  const handleReplay = async () => {
    if (!onReplayLast || !replayable) return;
    setReplaying(true);
    try {
      await onReplayLast(nodeId);
      await loadDeliveries();
    } finally {
      setReplaying(false);
    }
  };

  return (
    <div className="wf-subbox wf-gh-deliveries">
      <div className="wf-subbox-head">
        <span className="wf-label">Recent deliveries {deliveries.length > 0 ? `(${deliveries.length})` : ""}</span>
        <div className="wf-gh-delivery-actions">
          <button
            type="button"
            className="wf-mini-btn"
            disabled={loading}
            onClick={() => void loadDeliveries()}
            title="Refresh delivery log"
          >
            <RefreshCw size={11} className={loading ? "wf-spin" : ""} />
          </button>
          <button
            type="button"
            className="wf-mini-btn wf-mini-btn-primary"
            disabled={!replayable || replaying || !onReplayLast}
            onClick={() => void handleReplay()}
            title={replayable ? `Replay ${replayable.event} on ${replayable.repository ?? "repo"}` : "No recorded event to replay yet"}
          >
            {replaying ? <LoaderCircle size={11} className="wf-spin" /> : <Play size={11} />}
            Run last event
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="wf-hint">No GitHub deliveries recorded for this trigger yet.</p>
      ) : (
        <div className="wf-gh-delivery-groups">
          {groups.map((grp) => (
            <div key={grp.outcome} className="wf-gh-delivery-group">
              <div className={`wf-gh-delivery-group-head wf-gh-outcome-${grp.outcome}`}>
                <span>{grp.label}</span>
                <span className="wf-gh-delivery-count">{grp.items.length}</span>
              </div>
              {grp.items.map((item) => {
                const reasonMeta = item.reason ? SKIP_REASON_META[item.reason] : null;
                const targetRunId = item.runId || item.waitsForRunId;
                return (
                  <div key={item.deliveryId} className="wf-gh-delivery-row">
                    <div className="wf-gh-delivery-main">
                      <span className="wf-gh-delivery-title">
                        <strong>{WORKFLOW_GITHUB_EVENT_LABELS[item.event] || item.event}</strong>
                        {item.repository && (
                          <span className="wf-gh-delivery-repo">
                            {item.repository}
                            {item.number ? `#${item.number}` : ""}
                          </span>
                        )}
                      </span>
                      {item.title && <span className="wf-gh-delivery-sub">{item.title}</span>}
                      <span className="wf-gh-delivery-meta">
                        {relTime(Date.parse(item.receivedAt) || Date.now())}
                        {reasonMeta && (
                          <span className="wf-gh-skip-pill" title={item.reasonDetail || reasonMeta.description}>
                            {skipReasonIcon(item.reason)} {reasonMeta.label}
                            {item.reasonDetail ? ` (${item.reasonDetail})` : ""}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="wf-gh-delivery-cta">
                      {targetRunId && (
                        <button
                          type="button"
                          className="wf-mini-btn"
                          onClick={() => {
                            onSelectRun(targetRunId);
                            onTabRuns();
                          }}
                        >
                          {item.outcome === "waiting" ? "Blocking run" : "View run"}
                        </button>
                      )}
                      {!targetRunId && item.url && (
                        <button type="button" className="wf-mini-btn" onClick={() => void api.openLink(item.url!)}>
                          <ExternalLink size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GithubTriggerSettings({
  workflowId,
  nodeId,
  config,
  setConfig,
  onSelectRun,
  onTabRuns,
  onReplayLast,
}: {
  workflowId: string;
  nodeId: string;
  config: Record<string, any>;
  setConfig: (patch: Record<string, any>) => void;
  onSelectRun: (runId: string) => void;
  onTabRuns: () => void;
  onReplayLast?: (nodeId: string) => Promise<void>;
}) {
  const { status, loading, busy, error, copiedCode, loadStatus, handleStartSignIn, handleCancelSignIn, handleCopyAndOpen } =
    useGithubStatus(nodeId);
  const [catalog, setCatalog] = useState<WorkflowGithubCatalog>({ repos: [], labels: [], assignees: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);

  const selectedRepos = useMemo(() => extractConfiguredRepos(config), [config]);
  const selectedEvents = useMemo(() => extractCanonicalEvents(config.events), [config.events]);
  const selectedLabels: string[] = useMemo(
    () => (Array.isArray(config.labels) ? config.labels.map((s: unknown) => String(s)).filter(Boolean) : []),
    [config.labels],
  );
  const repoKey = selectedRepos.join("|");

  useEffect(() => {
    if (!status?.authenticated || !selectedRepos.length || !api.workflowGithubCatalog) {
      setCatalog({ repos: [], labels: [], assignees: [] });
      return;
    }
    let live = true;
    setCatalogLoading(true);
    void api
      .workflowGithubCatalog({ repos: selectedRepos, includeLabels: true, includeAssignees: false })
      .then((res) => {
        if (live && res) setCatalog(res);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setCatalogLoading(false);
      });
    return () => {
      live = false;
    };
  }, [status?.authenticated, repoKey]);

  const accessAlerts = useMemo(
    () => deriveGithubAccessAlerts({ role: "trigger", selectedRepos, status }),
    [selectedRepos, status],
  );

  const handleReposChange = (nextRepos: string[]) => {
    const patch: Record<string, any> = {
      repos: nextRepos,
      repo: nextRepos[0] || "",
    };
    if (shouldClearLabelsOnRepoChange(selectedRepos, nextRepos)) {
      patch.labels = [];
    }
    setConfig(patch);
  };

  const toggleEvent = (ev: string) => {
    const next = selectedEvents.includes(ev)
      ? selectedEvents.filter((item) => item !== ev)
      : [...selectedEvents, ev];
    const patch: Record<string, any> = { events: next.length ? next : ["issue.opened"] };
    if (ev === "mention" && !selectedEvents.includes(ev) && !config.mentionHandle && !config.mentionHandles?.length) {
      patch.mentionHandle = "@botkins-bot";
    }
    setConfig(patch);
  };

  const hasPrEvent = selectedEvents.some((e) => e.startsWith("pr."));
  const signIn = status?.signIn;

  return (
    <>
      <div className="wf-subbox wf-gh-auth">
        <div className="wf-subbox-head">
          <span className="wf-label">GitHub connection</span>
          <button
            type="button"
            className="wf-mini-btn"
            disabled={loading || busy}
            onClick={() => void loadStatus(true)}
            title="Refresh GitHub status"
          >
            <RefreshCw size={12} className={loading ? "wf-spin" : ""} /> Refresh
          </button>
        </div>

        {loading && !status ? (
          <p className="wf-hint">
            <LoaderCircle size={12} className="wf-spin" /> Checking local GitHub CLI…
          </p>
        ) : !status?.installed ? (
          <div className="wf-gh-auth-body">
            <p className="wf-hint">
              Install the GitHub CLI (<code>gh</code>) on this computer to connect GitHub and watch events.
            </p>
            <button
              type="button"
              className="wf-mini-btn"
              onClick={() => void api.openLink(status?.installUrl || "https://cli.github.com/")}
            >
              <ExternalLink size={12} /> Install GitHub CLI
            </button>
          </div>
        ) : signIn?.status === "waiting" && signIn.code ? (
          <div className="wf-gh-auth-body">
            <p className="wf-hint">Enter this one-time code on GitHub to finish connecting:</p>
            <div className="wf-gh-code-row">
              <code className="wf-gh-code">{signIn.code}</code>
              <button type="button" className="wf-mini-btn wf-mini-btn-primary" onClick={handleCopyAndOpen}>
                {copiedCode ? <Check size={12} /> : <Copy size={12} />}
                {copiedCode ? "Copied · Opening…" : "Copy code & open GitHub"}
              </button>
            </div>
            <div className="wf-gh-waiting-row">
              <span className="wf-hint">
                <LoaderCircle size={12} className="wf-spin" /> Waiting for GitHub sign-in…
              </span>
              <button type="button" className="wf-mini-btn" disabled={busy} onClick={() => void handleCancelSignIn()}>
                Cancel
              </button>
            </div>
          </div>
        ) : status.authenticated ? (
          <div className="wf-gh-connected-row">
            <span className="wf-gh-status-ok">
              <CheckCircle2 size={13} /> Connected{status.login ? ` as @${status.login}` : ""}
            </span>
            <button type="button" className="wf-mini-btn" disabled={busy} onClick={() => void handleStartSignIn()}>
              Reconnect
            </button>
          </div>
        ) : (
          <div className="wf-gh-auth-body">
            <p className="wf-hint">Sign in once with your GitHub account so Botkins can watch repositories.</p>
            <button
              type="button"
              className="wf-mini-btn wf-mini-btn-primary"
              disabled={busy}
              onClick={() => void handleStartSignIn()}
            >
              {busy ? <LoaderCircle size={12} className="wf-spin" /> : <KeyRound size={12} />}
              {busy ? "Starting GitHub sign-in…" : "Connect GitHub"}
            </button>
          </div>
        )}

        {(error || signIn?.status === "failed") && (
          <p className="wf-gh-error">{error || signIn?.error}</p>
        )}
      </div>

      <GithubAccessAlertsBar
        alerts={accessAlerts}
        onConnect={() => void handleStartSignIn()}
        onOpenGithub={() => void api.openLink("https://github.com/settings/installations")}
      />

      <GithubMultiRepoPicker
        selected={selectedRepos}
        available={status?.repos ?? []}
        onChange={handleReposChange}
      />

      <div className="wf-field-group">
        <label className="wf-label">Events</label>
        <div className="wf-gh-event-groups">
          {WORKFLOW_GITHUB_EVENT_GROUPS.map((grp) => (
            <div key={grp.group} className="wf-gh-event-group">
              <span className="wf-gh-event-group-label">{grp.group}</span>
              <div className="wf-gh-events">
                {grp.events.map((opt) => {
                  const active = selectedEvents.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`wf-gh-event-pill ${active ? "active" : ""}`}
                      title={opt.hint}
                      onClick={() => toggleEvent(opt.value)}
                    >
                      {active && <Check size={11} />}
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <GithubColorLabelPicker
        label="Label filter (optional)"
        selected={selectedLabels}
        catalog={catalog.labels}
        loading={catalogLoading}
        onChange={(labels) => setConfig({ labels })}
      />

      {selectedEvents.includes("mention") && (
        <div className="wf-field-group">
          <label className="wf-label">Mention handle(s)</label>
          <input
            type="text"
            value={
              Array.isArray(config.mentionHandles) && config.mentionHandles.length
                ? config.mentionHandles.map((h: string) => `@${h.replace(/^@/, "")}`).join(", ")
                : config.mentionHandle ?? "@botkins-bot"
            }
            placeholder="@botkins-bot"
            onChange={(e) => setConfig({ mentionHandle: e.target.value, mentionHandles: undefined })}
          />
          <p className="wf-hint">Triggers when an issue, PR, or comment mentions any listed handle (comma-separated).</p>
        </div>
      )}

      <div className="wf-subbox">
        <span className="wf-label">Filters</span>
        <label className="wf-check">
          <input
            type="checkbox"
            checked={config.notBot !== false}
            onChange={(e) => setConfig({ notBot: e.target.checked })}
          />
          <span>Ignore bot accounts (recommended)</span>
        </label>
        <label className="wf-check">
          <input
            type="checkbox"
            checked={config.firstTime === true}
            onChange={(e) => setConfig({ firstTime: e.target.checked ? true : undefined })}
          />
          <span>First-time contributors only</span>
        </label>
        <div className="wf-field-group">
          <label className="wf-label">Title contains (optional)</label>
          <input
            type="text"
            value={config.titleContains || ""}
            placeholder="e.g. [RFC] or hotfix"
            onChange={(e) => setConfig({ titleContains: e.target.value.trim() || undefined })}
          />
        </div>
        {hasPrEvent && (
          <div className="wf-field-group">
            <label className="wf-label">
              <GitBranch size={11} /> Base branch (exact PR target)
            </label>
            <input
              type="text"
              value={config.baseBranch || ""}
              placeholder="e.g. main"
              onChange={(e) => setConfig({ baseBranch: e.target.value.trim() || undefined })}
            />
          </div>
        )}
      </div>

      <div className="wf-field-group">
        <label className="wf-label">Fallback poll interval (min)</label>
        <input
          type="number"
          min={1}
          max={120}
          value={config.pollMinutes ?? 5}
          onChange={(e) => setConfig({ pollMinutes: Math.max(1, Math.min(120, Number(e.target.value) || 5)) })}
        />
        <p className="wf-hint">Used when local <code>gh</code> polling or offline catch-up is active.</p>
      </div>

      <GithubDeliveryLog
        workflowId={workflowId}
        nodeId={nodeId}
        onSelectRun={onSelectRun}
        onTabRuns={onTabRuns}
        onReplayLast={onReplayLast}
      />
    </>
  );
}

function GithubOutputSettings({
  nodeId,
  workflow,
  config,
  analysis,
  setConfig,
}: {
  nodeId: string;
  workflow: Workflow;
  config: Record<string, any>;
  analysis?: NodeFieldAnalysis;
  setConfig: (patch: Record<string, any>) => void;
}) {
  const { status, handleStartSignIn } = useGithubStatus(`out:${nodeId}`);
  const [catalog, setCatalog] = useState<WorkflowGithubCatalog>({ repos: [], labels: [], assignees: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [personQuery, setPersonQuery] = useState("");
  const [customPerson, setCustomPerson] = useState("");

  const triggers = useMemo(() => workflow.nodes.filter((n) => n.kind === "trigger"), [workflow.nodes]);
  const issueOnly = useMemo(() => isIssueOnlyGithubTrigger(triggers), [triggers]);
  const targetRepos = useMemo(() => resolveOutputTargetRepos(config, triggers), [config, triggers]);
  const targetKey = targetRepos.join("|");

  const action = (config.action || "comment") as WorkflowGithubAction;
  const actionMeta = WORKFLOW_GITHUB_ACTION_OPTIONS.find((a) => a.value === action) ?? WORKFLOW_GITHUB_ACTION_OPTIONS[0];
  const sameRepo = config.sameRepository !== false && (!config.repository || config.repository === "trigger");
  const sameItem = config.sameItem !== false && (!config.item || config.item === "event");

  const accessAlerts = useMemo(
    () => deriveGithubAccessAlerts({ role: "output", selectedRepos: targetRepos, status }),
    [targetRepos, status],
  );

  useEffect(() => {
    if (!status?.authenticated || !targetRepos.length || !api.workflowGithubCatalog) {
      setCatalog({ repos: [], labels: [], assignees: [] });
      return;
    }
    let live = true;
    setCatalogLoading(true);
    void api
      .workflowGithubCatalog({ repos: targetRepos.slice(0, 3), includeLabels: true, includeAssignees: true })
      .then((res) => {
        if (live && res) setCatalog(res);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setCatalogLoading(false);
      });
    return () => {
      live = false;
    };
  }, [status?.authenticated, targetKey]);

  const labelsFromAgent = config.labelsFrom === "agent";
  const selectedLabels: string[] = useMemo(
    () => (Array.isArray(config.labels) ? config.labels.map((l: unknown) => String(l)).filter(Boolean) : []),
    [config.labels],
  );

  const isReviewRequest = action === "review.request";
  const peopleField = isReviewRequest ? "reviewers" : "assignees";
  const peopleFromAgent = config.person === "agent" || (isReviewRequest ? config.reviewersFrom === "agent" : config.assigneesFrom === "agent");
  const selectedPeople: string[] = useMemo(() => {
    const raw = isReviewRequest ? config.reviewers : config.assignees;
    return Array.isArray(raw) ? raw.map((p: unknown) => String(p).replace(/^@/, "")).filter(Boolean) : [];
  }, [config.reviewers, config.assignees, isReviewRequest]);
  const selectedPeopleLower = useMemo(() => new Set(selectedPeople.map((p) => p.toLowerCase())), [selectedPeople]);

  const filteredAssignees = useMemo(() => {
    const needle = personQuery.trim().toLowerCase();
    const seen = new Set<string>();
    const merged: Array<{ login: string }> = [];
    for (const a of catalog.assignees) {
      const k = a.login.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        merged.push({ login: a.login });
      }
    }
    for (const p of selectedPeople) {
      const k = p.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        merged.push({ login: p });
      }
    }
    return merged.filter((u) => !needle || u.login.toLowerCase().includes(needle));
  }, [catalog.assignees, selectedPeople, personQuery]);

  const togglePerson = (login: string) => {
    const clean = login.trim().replace(/^@/, "");
    if (!clean) return;
    const low = clean.toLowerCase();
    const next = selectedPeopleLower.has(low)
      ? selectedPeople.filter((p) => p.toLowerCase() !== low)
      : [...selectedPeople, clean];
    setConfig({ [peopleField]: next, person: undefined });
  };

  const addCustomPerson = () => {
    const clean = customPerson.trim().replace(/^@/, "");
    if (!clean) return;
    if (!selectedPeopleLower.has(clean.toLowerCase())) {
      setConfig({ [peopleField]: [...selectedPeople, clean], person: undefined });
    }
    setCustomPerson("");
  };

  const repoListId = `wf-gh-out-repos-${nodeId}`;

  return (
    <>
      <GithubAccessAlertsBar
        alerts={accessAlerts}
        onConnect={() => void handleStartSignIn()}
        onOpenGithub={() => void api.openLink("https://github.com/settings/installations")}
      />

      <div className="wf-field-group">
        <label className="wf-label">GitHub action</label>
        <select
          value={action}
          onChange={(e) => setConfig({ action: e.target.value as WorkflowGithubAction })}
        >
          {WORKFLOW_GITHUB_ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={issueOnly && opt.prOnly}>
              {opt.label}{opt.prOnly ? " (PR only)" : ""} — {opt.hint}
            </option>
          ))}
        </select>
        {issueOnly && PR_ONLY_ACTIONS.has(action) && (
          <p className="wf-gh-error">This action only works on pull requests, but the trigger only watches issues.</p>
        )}
      </div>

      <div className="wf-subbox">
        <span className="wf-label">Target</span>
        <label className="wf-check">
          <input
            type="checkbox"
            checked={sameRepo}
            onChange={(e) =>
              setConfig(
                e.target.checked
                  ? { sameRepository: true, repository: "trigger" }
                  : { sameRepository: false, repository: targetRepos[0] || "" },
              )
            }
          />
          <span>Same repository as trigger</span>
        </label>
        {!sameRepo && (
          <div className="wf-field-group">
            <label className="wf-label">Target repository (owner/repo)</label>
            <input
              type="text"
              list={status?.repos?.length ? repoListId : undefined}
              value={config.repository && config.repository !== "trigger" ? config.repository : ""}
              placeholder="owner/repo or {{repository}}"
              onChange={(e) => setConfig({ sameRepository: false, repository: e.target.value.trim() })}
            />
            {!!status?.repos?.length && (
              <datalist id={repoListId}>
                {status.repos.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            )}
          </div>
        )}

        {action !== "issue.create" && (
          <>
            <label className="wf-check">
              <input
                type="checkbox"
                checked={sameItem}
                onChange={(e) =>
                  setConfig(
                    e.target.checked
                      ? { sameItem: true, item: "event" }
                      : { sameItem: false, item: "" },
                  )
                }
              />
              <span>Same issue or PR as trigger event</span>
            </label>
            {!sameItem && (
              <WorkflowFieldInput
                label="Target issue/PR number or URL"
                multiline={false}
                value={config.item && config.item !== "event" ? config.item : ""}
                onChange={(item) => setConfig({ sameItem: false, item })}
                analysis={analysis}
                placeholder="#123, URL, or {{number}}"
              />
            )}
          </>
        )}
      </div>

      {actionMeta.needsTitle && (
        <WorkflowFieldInput
          label="Issue title"
          multiline={false}
          value={config.title || ""}
          onChange={(title) => setConfig({ title })}
          analysis={analysis}
          placeholder="Summary title for new issue"
        />
      )}

      {(actionMeta.needsBody || actionMeta.optionalBody) && (
        <WorkflowFieldInput
          label={actionMeta.needsBody ? "Body" : "Body (optional)"}
          value={config.body ?? config.template ?? ""}
          onChange={(body) => setConfig({ body, template: body })}
          analysis={analysis}
          placeholder="Write comment or review text using {{agent_reply}}…"
        />
      )}

      {actionMeta.usesCloseReason && (
        <div className="wf-field-group">
          <label className="wf-label">Close reason (issues)</label>
          <select value={config.stateReason || "completed"} onChange={(e) => setConfig({ stateReason: e.target.value })}>
            <option value="completed">Completed</option>
            <option value="not_planned">Not planned</option>
          </select>
        </div>
      )}

      {actionMeta.usesLabels && (
        <div className="wf-field-group">
          <label className="wf-check">
            <input
              type="checkbox"
              checked={labelsFromAgent}
              onChange={(e) => setConfig({ labelsFrom: e.target.checked ? "agent" : undefined })}
            />
            <span>Let agent pick from repository label catalog</span>
          </label>
          {!labelsFromAgent ? (
            <GithubColorLabelPicker
              label="Catalog labels"
              selected={selectedLabels}
              catalog={catalog.labels}
              loading={catalogLoading}
              onChange={(labels) => setConfig({ labels })}
            />
          ) : (
            <p className="wf-hint">At run time, the model chooses only from real labels on the target repository.</p>
          )}
        </div>
      )}

      {(actionMeta.usesAssignees || actionMeta.usesReviewers) && (
        <div className="wf-subbox wf-gh-picker">
          <div className="wf-subbox-head">
            <span className="wf-label">{isReviewRequest ? "Reviewers" : "Assignees"}</span>
            {catalogLoading && <LoaderCircle size={12} className="wf-spin" />}
          </div>
          <label className="wf-check">
            <input
              type="checkbox"
              checked={peopleFromAgent}
              onChange={(e) => setConfig({ person: e.target.checked ? "agent" : undefined })}
            />
            <span>Let agent pick from repository collaborators</span>
          </label>
          {!peopleFromAgent ? (
            <>
              {selectedPeople.length > 0 && (
                <div className="wf-gh-chip-wrap">
                  {selectedPeople.map((login) => (
                    <span key={login} className="wf-gh-selected-chip">
                      <span>@{login}</span>
                      <button type="button" aria-label={`Remove ${login}`} onClick={() => togglePerson(login)}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {filteredAssignees.length > 5 && (
                <div className="wf-gh-search-row">
                  <Search size={12} className="wf-gh-search-icon" aria-hidden="true" />
                  <input
                    type="text"
                    value={personQuery}
                    placeholder={`Filter ${isReviewRequest ? "reviewers" : "assignees"}…`}
                    onChange={(e) => setPersonQuery(e.target.value)}
                  />
                </div>
              )}
              {filteredAssignees.length > 0 && (
                <div className="wf-gh-label-list" role="listbox" aria-multiselectable="true">
                  {filteredAssignees.slice(0, 40).map((u) => {
                    const active = selectedPeopleLower.has(u.login.toLowerCase());
                    return (
                      <button
                        key={u.login}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`wf-gh-label-pill ${active ? "active" : ""}`}
                        onClick={() => togglePerson(u.login)}
                      >
                        <span>@{u.login}</span>
                        {active && <Check size={11} />}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="wf-gh-custom-row">
                <input
                  type="text"
                  value={customPerson}
                  placeholder="Add GitHub @username…"
                  onChange={(e) => setCustomPerson(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomPerson();
                    }
                  }}
                />
                <button type="button" className="wf-mini-btn" onClick={addCustomPerson} disabled={!customPerson.trim()}>
                  <Plus size={12} /> Add
                </button>
              </div>
            </>
          ) : (
            <p className="wf-hint">At run time, the model chooses only from real repository collaborators.</p>
          )}
        </div>
      )}
    </>
  );
}

interface Props {
  workflow: Workflow;
  node: WorkflowNode | null;
  analysis?: NodeFieldAnalysis;
  bots: Bot[];
  chats: Chat[];
  models: ModelInfo[];
  runs: WorkflowRun[];
  selectedRunId: string | null;
  isOwner?: boolean;
  tab: "step" | "runs";
  onTab: (t: "step" | "runs") => void;
  onSelectRun: (runId: string | null) => void;
  onChangeNode: (nodeId: string, updater: (prev: WorkflowNode) => WorkflowNode) => void;
  onRetryRun: (runId: string, nodeId?: string | null, options?: { allowUncertainRetry?: boolean }) => Promise<void>;
  onRespondApproval: (runId: string, nodeId: string, decision: "approved" | "rejected", note: string) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
  onReplayLastGithubEvent?: (nodeId: string) => Promise<void>;
  webhookPort?: number | null;
}

function relTime(ms: number) {
  const diff = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function durText(start?: number | null, end?: number | null) {
  if (!start) return "";
  const ms = Math.max(0, (end ?? Date.now()) - start);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function OutputFieldsEditor({
  fields,
  onChange,
  heading = "Structured output fields",
}: {
  fields: WorkflowFieldDef[];
  onChange: (next: WorkflowFieldDef[]) => void;
  heading?: string;
}) {
  return (
    <div className="wf-subbox">
      <div className="wf-subbox-head">
        <span className="wf-label">{heading}</span>
        <button
          type="button"
          className="wf-mini-btn"
          onClick={() => onChange([...fields, { name: `field_${fields.length + 1}`, type: "string", description: "" }])}
        >
          <Plus size={12} /> Add field
        </button>
      </div>
      {fields.length === 0 ? (
        <p className="wf-hint">Optional — define named fields so downstream steps can reference them as {"{{field}}"}.</p>
      ) : (
        <div className="wf-field-rows">
          {fields.map((f, idx) => (
            <div key={idx} className="wf-field-row">
              <input
                type="text"
                value={f.name}
                placeholder="field_name"
                onChange={(e) => {
                  const next = [...fields];
                  next[idx] = { ...f, name: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "") };
                  onChange(next);
                }}
              />
              <select
                value={f.type || "string"}
                onChange={(e) => {
                  const next = [...fields];
                  next[idx] = { ...f, type: e.target.value as WorkflowFieldDef["type"] };
                  onChange(next);
                }}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
              </select>
              <input
                type="text"
                value={(f.choices ?? []).join(", ")}
                placeholder="choices (optional)"
                onChange={(e) => {
                  const next = [...fields];
                  const list = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  next[idx] = { ...f, choices: list.length ? list : undefined };
                  onChange(next);
                }}
              />
              <button
                type="button"
                className="wf-icon-btn"
                title="Remove field"
                onClick={() => onChange(fields.filter((_, i) => i !== idx))}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowInspector({
  workflow,
  node,
  analysis,
  bots,
  chats,
  models,
  runs,
  selectedRunId,
  isOwner = true,
  tab,
  onTab,
  onSelectRun,
  onChangeNode,
  onRetryRun,
  onRespondApproval,
  onCancelRun,
  onReplayLastGithubEvent,
  webhookPort,
}: Props) {
  const dialogs = useAsk();
  const [freshSecret, setFreshSecret] = useState<{ nodeId: string; secret: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null;
  const selectedRunUncertain = useMemo(
    () => resolveGithubUncertainDetails(selectedRun, workflow.nodes),
    [selectedRun, workflow.nodes],
  );

  const confirmAndRetryUncertain = async (
    runId: string,
    details: GithubUncertainDetails,
    nodeId?: string | null,
    busyKey = "retry-uncertain",
  ) => {
    const ok = await dialogs.ask({
      title: details.confirmTitle,
      body: details.confirmMessage,
      confirm: "Retry anyway",
      danger: true,
    });
    if (ok === null) return;
    setBusyAction(busyKey);
    try {
      await onRetryRun(runId, nodeId ?? details.nodeId ?? null, { allowUncertainRetry: true });
    } finally {
      setBusyAction(null);
    }
  };

  const setConfig = (patch: Record<string, any>) => {
    if (!node) return;
    onChangeNode(node.id, (prev) => ({ ...prev, config: { ...prev.config, ...patch } }));
  };

  const copy = async (label: string, text: string) => {
    try {
      await api.copyText?.(text);
    } catch {
      navigator.clipboard?.writeText(text).catch(() => {});
    }
    setCopied(label);
    setTimeout(() => setCopied((cur) => (cur === label ? null : cur)), 1500);
  };

  const handleRotateSecret = async () => {
    if (!node) return;
    setBusyAction("secret");
    try {
      const res = await api.workflowRotateWebhookSecret(workflow.id, node.id);
      setFreshSecret({ nodeId: node.id, secret: res.secret });
    } finally {
      setBusyAction(null);
    }
  };

  const routineChats = chats.filter((c) => c.schedules?.some((s) => s.routine));
  const ordinaryChats = chats.filter((c) => !c.panelId && !c.archived && !c.schedules?.some((s) => s.routine));

  const pendingApprovalsCount = runs.filter((r) => r.status === "waiting_approval").length;

  return (
    <aside className="wf-inspector" aria-label="Workflow inspector">
      <div className="wf-inspector-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "step"}
          className={tab === "step" ? "active" : ""}
          onClick={() => onTab("step")}
        >
          Step
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "runs"}
          className={tab === "runs" ? "active" : ""}
          onClick={() => onTab("runs")}
        >
          Runs {runs.length > 0 && <span className="wf-tab-count">{runs.length}</span>}
          {pendingApprovalsCount > 0 && <span className="wf-tab-badge">{pendingApprovalsCount}</span>}
        </button>
      </div>

      {tab === "step" ? (
        <div className="wf-inspector-body">
          {!node ? (
            <div className="wf-inspector-empty">
              <p>Select a step on the canvas to edit its settings, or click any step type in the toolbar to add one.</p>
            </div>
          ) : (
            <div className="wf-form">
              <div className="wf-field-group">
                <label className="wf-label" htmlFor="wf-node-label">
                  Step label
                </label>
                <input
                  id="wf-node-label"
                  type="text"
                  value={node.label}
                  onChange={(e) => onChangeNode(node.id, (prev) => ({ ...prev, label: e.target.value }))}
                />
              </div>

              {/* TRIGGER CONFIG */}
              {node.kind === "trigger" && (
                <>
                  <div className="wf-field-group">
                    <label className="wf-label" htmlFor="wf-trigger-kind">
                      Trigger source
                    </label>
                    <select
                      id="wf-trigger-kind"
                      value={node.triggerKind || "manual"}
                      onChange={(e) => {
                        const tk = e.target.value as WorkflowTriggerKind;
                        onChangeNode(node.id, (prev) => ({
                          ...prev,
                          triggerKind: tk,
                          config: tk === "github" ? { repos: [], events: ["issue.opened"], notBot: true, pollMinutes: 5 } : {},
                        }));
                      }}
                    >
                      <option value="task">Task Board (created / status changed)</option>
                      <option value="schedule">Schedule (cron + time zone)</option>
                      <option value="manual">Manual run</option>
                      <option value="routine">Routine finished</option>
                      <option value="chat">Chat message / @mention</option>
                      <option value="webhook">Local webhook (secret protected)</option>
                      <option value="github">GitHub issues, PRs, reviews &amp; @mentions</option>
                      <option value="channel">External channel (Slack, Telegram, Discord, iMessage)</option>
                    </select>
                  </div>

                  {node.triggerKind === "task" && (
                    <>
                      <div className="wf-field-group">
                        <label className="wf-label">Event</label>
                        <select value={node.config.event || "status_changed"} onChange={(e) => setConfig({ event: e.target.value })}>
                          <option value="status_changed">Status changed</option>
                          <option value="created">Task created</option>
                          <option value="any">Either</option>
                        </select>
                      </div>
                      <div className="wf-two-col">
                        <div className="wf-field-group">
                          <label className="wf-label">From status (optional)</label>
                          <select value={node.config.fromStatus || ""} onChange={(e) => setConfig({ fromStatus: e.target.value || undefined })}>
                            <option value="">Any</option>
                            <option value="later">Later</option>
                            <option value="ready">Ready</option>
                            <option value="working">Working</option>
                            <option value="review">Review</option>
                            <option value="blocked">Blocked</option>
                            <option value="done">Done</option>
                          </select>
                        </div>
                        <div className="wf-field-group">
                          <label className="wf-label">To status</label>
                          <select value={node.config.toStatus || ""} onChange={(e) => setConfig({ toStatus: e.target.value || undefined })}>
                            <option value="">Any</option>
                            <option value="later">Later</option>
                            <option value="ready">Ready</option>
                            <option value="working">Working</option>
                            <option value="review">Review</option>
                            <option value="blocked">Blocked</option>
                            <option value="done">Done</option>
                            <option value="archived">Archived</option>
                          </select>
                        </div>
                      </div>
                      <div className="wf-field-group">
                        <label className="wf-label">Filter by bot (optional)</label>
                        <select value={node.config.botId || ""} onChange={(e) => setConfig({ botId: e.target.value || undefined })}>
                          <option value="">Any bot</option>
                          {bots.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="wf-field-group">
                        <label className="wf-label">Title contains (optional)</label>
                        <input
                          type="text"
                          value={node.config.titleContains || ""}
                          placeholder="e.g. Deploy or PR"
                          onChange={(e) => setConfig({ titleContains: e.target.value || undefined })}
                        />
                      </div>
                    </>
                  )}

                  {node.triggerKind === "schedule" && (
                    <>
                      <div className="wf-two-col">
                        <div className="wf-field-group">
                          <label className="wf-label">Cadence</label>
                          <select value={node.config.cadence || "daily"} onChange={(e) => setConfig({ cadence: e.target.value })}>
                            <option value="daily">Daily</option>
                            <option value="weekdays">Weekdays</option>
                            <option value="weekly">Weekly</option>
                            <option value="custom">Custom cron</option>
                          </select>
                        </div>
                        {node.config.cadence !== "custom" && (
                          <div className="wf-field-group">
                            <label className="wf-label">Time</label>
                            <input
                              type="time"
                              value={node.config.time || "09:00"}
                              onChange={(e) => setConfig({ time: e.target.value })}
                            />
                          </div>
                        )}
                      </div>
                      {node.config.cadence === "custom" && (
                        <div className="wf-field-group">
                          <label className="wf-label">Cron expression (5 fields)</label>
                          <input
                            type="text"
                            value={node.config.cron || "0 9 * * *"}
                            placeholder="0 9 * * 1-5"
                            onChange={(e) => setConfig({ cron: e.target.value })}
                          />
                        </div>
                      )}
                      <div className="wf-field-group">
                        <label className="wf-label">Time zone</label>
                        <input
                          type="text"
                          value={node.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
                          onChange={(e) => setConfig({ timezone: e.target.value })}
                        />
                      </div>
                    </>
                  )}

                  {node.triggerKind === "manual" && (
                    <OutputFieldsEditor
                      heading="Optional manual inputs"
                      fields={Array.isArray(node.config.inputs) ? node.config.inputs : []}
                      onChange={(inputs) => setConfig({ inputs })}
                    />
                  )}

                  {node.triggerKind === "routine" && (
                    <>
                      <div className="wf-field-group">
                        <label className="wf-label">Routine (optional)</label>
                        <select value={node.config.routineChatId || ""} onChange={(e) => setConfig({ routineChatId: e.target.value || undefined })}>
                          <option value="">Any routine</option>
                          {routineChats.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="wf-field-group">
                        <label className="wf-label">Only on status</label>
                        <select value={node.config.onlyOnStatus || "any"} onChange={(e) => setConfig({ onlyOnStatus: e.target.value })}>
                          <option value="any">Any</option>
                          <option value="done">Completed</option>
                          <option value="failed">Failed</option>
                        </select>
                      </div>
                    </>
                  )}

                  {node.triggerKind === "chat" && (
                    <>
                      <div className="wf-field-group">
                        <label className="wf-label">Bot (optional)</label>
                        <select value={node.config.botId || ""} onChange={(e) => setConfig({ botId: e.target.value || undefined })}>
                          <option value="">Any bot</option>
                          {bots.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <label className="wf-check">
                        <input
                          type="checkbox"
                          checked={!!node.config.mentionOnly}
                          onChange={(e) => setConfig({ mentionOnly: e.target.checked })}
                        />
                        <span>Only when @mentioned</span>
                      </label>
                      <div className="wf-field-group">
                        <label className="wf-label">Text contains (optional)</label>
                        <input
                          type="text"
                          value={node.config.textContains || ""}
                          placeholder="e.g. deploy"
                          onChange={(e) => setConfig({ textContains: e.target.value || undefined })}
                        />
                      </div>
                    </>
                  )}

                  {node.triggerKind === "webhook" && (
                    <div className="wf-subbox">
                      <div className="wf-field-group">
                        <label className="wf-label">Local webhook endpoint</label>
                        <div className="wf-copy-row">
                          <code className="wf-code-line">
                            {`http://127.0.0.1:${webhookPort || "<port>"}/botkins/v1/webhooks/${node.config.routeId || "pending"}`}
                          </code>
                          <button
                            type="button"
                            className="wf-mini-btn"
                            onClick={() =>
                              copy(
                                "url",
                                `http://127.0.0.1:${webhookPort || "<port>"}/botkins/v1/webhooks/${node.config.routeId || ""}`,
                              )
                            }
                          >
                            {copied === "url" ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        </div>
                      </div>
                      <div className="wf-field-group">
                        <div className="wf-subbox-head">
                          <span className="wf-label">Secret (stored in vault)</span>
                          <button type="button" className="wf-mini-btn" disabled={busyAction === "secret"} onClick={handleRotateSecret}>
                            <KeyRound size={12} /> {node.config.hasSecret ? "Rotate secret" : "Generate secret"}
                          </button>
                        </div>
                        {freshSecret && freshSecret.nodeId === node.id ? (
                          <div className="wf-copy-row">
                            <code className="wf-code-line">{freshSecret.secret}</code>
                            <button type="button" className="wf-mini-btn" onClick={() => copy("secret", freshSecret.secret)}>
                              {copied === "secret" ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        ) : (
                          <p className="wf-hint">
                            Send via <code>Authorization: Bearer &lt;secret&gt;</code>, <code>X-Botkins-Secret</code>, or HMAC{" "}
                            <code>X-Hub-Signature-256</code>. Max body 64 KB.
                          </p>
                        )}
                      </div>
                      <OutputFieldsEditor
                        heading="Extract JSON fields (exact case)"
                        fields={Array.isArray(node.config.fields) ? node.config.fields : []}
                        onChange={(fields) => setConfig({ fields })}
                      />
                    </div>
                  )}

                  {node.triggerKind === "github" && (
                    <GithubTriggerSettings
                      workflowId={workflow.id}
                      nodeId={node.id}
                      config={node.config}
                      setConfig={setConfig}
                      onSelectRun={(runId) => onSelectRun(runId)}
                      onTabRuns={() => onTab("runs")}
                      onReplayLast={onReplayLastGithubEvent}
                    />
                  )}

                  {node.triggerKind === "channel" && (
                    <>
                      <div className="wf-two-col">
                        <div className="wf-field-group">
                          <label className="wf-label">Channel kind</label>
                          <select
                            value={node.config.channel || ""}
                            onChange={(e) => setConfig({ channel: e.target.value })}
                          >
                            <option value="">Any channel</option>
                            <option value="slack">Slack</option>
                            <option value="telegram">Telegram</option>
                            <option value="discord">Discord</option>
                            <option value="imessage">iMessage</option>
                          </select>
                        </div>
                        <div className="wf-field-group">
                          <label className="wf-label">Connection (optional)</label>
                          <input
                            type="text"
                            value={node.config.connection || ""}
                            placeholder="Connection ID or label"
                            onChange={(e) => setConfig({ connection: e.target.value.trim() })}
                          />
                        </div>
                      </div>
                      <div className="wf-field-group">
                        <label className="wf-label">Text contains (optional)</label>
                        <input
                          type="text"
                          value={node.config.textContains || ""}
                          placeholder="Filter by substring"
                          onChange={(e) => setConfig({ textContains: e.target.value })}
                        />
                      </div>
                      <div className="wf-two-col">
                        <label className="wf-checkbox-row">
                          <input
                            type="checkbox"
                            checked={node.config.isDirect === true}
                            onChange={(e) => setConfig({ isDirect: e.target.checked ? true : undefined, directOnly: undefined })}
                          />
                          <span>Direct messages only</span>
                        </label>
                        <label className="wf-checkbox-row">
                          <input
                            type="checkbox"
                            checked={node.config.mentionsBot === true}
                            onChange={(e) => setConfig({ mentionsBot: e.target.checked ? true : undefined, mentionOnly: undefined })}
                          />
                          <span>Mentions only</span>
                        </label>
                      </div>
                    </>
                  )}

                  {/* Fixed fields reference */}
                  <div className="wf-subbox">
                    <span className="wf-label">Fields emitted by this trigger</span>
                    <div className="wf-chip-list">
                      {(TRIGGER_FIELDS[node.triggerKind || "manual"] ?? []).map((f) => (
                        <span key={f.name} className="wf-chip wf-chip-mini" title={f.description}>
                          {f.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* AGENT STEP */}
              {node.kind === "agent" && (
                <>
                  <div className="wf-field-group">
                    <label className="wf-label">Bot</label>
                    <select value={node.config.botId || ""} onChange={(e) => setConfig({ botId: e.target.value || undefined })}>
                      <option value="">Primary bot</option>
                      {bots.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <WorkflowFieldInput
                    label="Prompt"
                    value={node.config.prompt || ""}
                    onChange={(prompt) => setConfig({ prompt })}
                    analysis={analysis}
                    placeholder="What should the bot do? Type {{ to insert trigger or upstream fields…"
                  />
                  <div className="wf-field-group">
                    <label className="wf-label">Reply field name</label>
                    <input
                      type="text"
                      value={node.config.outputKey || "agent_reply"}
                      onChange={(e) => setConfig({ outputKey: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "") })}
                    />
                  </div>
                  <OutputFieldsEditor
                    fields={Array.isArray(node.config.outputFields) ? node.config.outputFields : []}
                    onChange={(outputFields) => setConfig({ outputFields })}
                  />
                </>
              )}

              {/* MODEL STEP */}
              {node.kind === "model" && (
                <>
                  <div className="wf-field-group">
                    <label className="wf-label">Model (one-shot, no tools)</label>
                    <select value={node.config.model || ""} onChange={(e) => setConfig({ model: e.target.value || undefined })}>
                      <option value="">Default workspace model</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <WorkflowFieldInput
                    label="Prompt"
                    value={node.config.prompt || ""}
                    onChange={(prompt) => setConfig({ prompt })}
                    analysis={analysis}
                    placeholder="Summarize or classify {{result}}…"
                  />
                  <OutputFieldsEditor
                    fields={Array.isArray(node.config.outputFields) ? node.config.outputFields : []}
                    onChange={(outputFields) => setConfig({ outputFields })}
                  />
                </>
              )}

              {/* CONDITION STEP (NO MODEL) */}
              {node.kind === "condition" && (
                <>
                  <div className="wf-subbox">
                    <div className="wf-subbox-head">
                      <span className="wf-label">Rules (deterministic, no model)</span>
                      <select
                        className="wf-inline-select"
                        value={node.config.match || "all"}
                        onChange={(e) => setConfig({ match: e.target.value })}
                      >
                        <option value="all">Match all (AND)</option>
                        <option value="any">Match any (OR)</option>
                      </select>
                    </div>
                    {((Array.isArray(node.config.rules) ? node.config.rules : []) as WorkflowConditionRule[]).map((rule, idx) => (
                      <div key={idx} className="wf-rule-row">
                        <input
                          type="text"
                          list="wf-available-fields"
                          value={rule.field}
                          placeholder="field (e.g. to)"
                          onChange={(e) => {
                            const next = [...(node.config.rules ?? [])];
                            next[idx] = { ...rule, field: e.target.value };
                            setConfig({ rules: next });
                          }}
                        />
                        <select
                          value={rule.op || "equals"}
                          onChange={(e) => {
                            const next = [...(node.config.rules ?? [])];
                            next[idx] = { ...rule, op: e.target.value };
                            setConfig({ rules: next });
                          }}
                        >
                          {CONDITION_OPS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>
                        {rule.op !== "exists" && rule.op !== "empty" && (
                          <input
                            type="text"
                            value={rule.value ?? ""}
                            placeholder="value (e.g. review)"
                            onChange={(e) => {
                              const next = [...(node.config.rules ?? [])];
                              next[idx] = { ...rule, value: e.target.value };
                              setConfig({ rules: next });
                            }}
                          />
                        )}
                        <button
                          type="button"
                          className="wf-icon-btn"
                          title="Remove rule"
                          onClick={() => setConfig({ rules: (node.config.rules ?? []).filter((_: any, i: number) => i !== idx) })}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <datalist id="wf-available-fields">
                      {(analysis?.available ?? []).map((f) => (
                        <option key={f.name} value={f.name} />
                      ))}
                    </datalist>
                    <button
                      type="button"
                      className="wf-mini-btn"
                      onClick={() =>
                        setConfig({
                          rules: [
                            ...(Array.isArray(node.config.rules) ? node.config.rules : []),
                            { field: analysis?.available[0]?.name || "to", op: "equals", value: "" },
                          ],
                        })
                      }
                    >
                      <Plus size={12} /> Add rule
                    </button>
                  </div>
                </>
              )}

              {/* APPROVAL STEP */}
              {node.kind === "approval" && (
                <>
                  <WorkflowFieldInput
                    label="Approval question"
                    value={node.config.message || ""}
                    onChange={(message) => setConfig({ message })}
                    analysis={analysis}
                    placeholder="Ask the person whether to proceed with {{title}}…"
                  />
                  <div className="wf-field-group">
                    <label className="wf-label">Optional note field name</label>
                    <input
                      type="text"
                      value={node.config.noteField || ""}
                      placeholder="approval_note"
                      onChange={(e) => setConfig({ noteField: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "") })}
                    />
                  </div>
                </>
              )}

              {/* OUTPUT STEP */}
              {node.kind === "output" && (
                <>
                  <div className="wf-field-group">
                    <label className="wf-label">Destination</label>
                    <select
                      value={node.config.destination || "chat"}
                      onChange={(e) => {
                        const destination = e.target.value;
                        if (destination === "github") {
                          setConfig({
                            destination: "github",
                            action: node.config.action || "comment",
                            sameRepository: node.config.sameRepository ?? true,
                            sameItem: node.config.sameItem ?? true,
                            card: undefined,
                            a2ui: undefined,
                          });
                        } else {
                          setConfig(destination === "chat" ? { destination } : { destination, card: undefined, a2ui: undefined });
                        }
                      }}
                    >
                      <option value="chat">Post to chat</option>
                      <option value="feed">Today · Feed</option>
                      <option value="idea">Today · Ideas</option>
                      <option value="goal">Today · Goals</option>
                      <option value="notification">Notification</option>
                      <option value="github">GitHub (comment, label, assign, review, close, issue)</option>
                    </select>
                  </div>
                  {(node.config.destination || "chat") === "chat" && (
                    <>
                      <div className="wf-field-group">
                        <label className="wf-label">Target chat (optional — defaults to bot’s main chat)</label>
                        <select value={node.config.chatId || ""} onChange={(e) => setConfig({ chatId: e.target.value || undefined })}>
                          <option value="">Bot’s main chat</option>
                          {ordinaryChats.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="wf-field-group">
                        <label className="wf-label">Posting bot</label>
                        <select value={node.config.botId || ""} onChange={(e) => setConfig({ botId: e.target.value || undefined })}>
                          <option value="">Primary bot</option>
                          {bots.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <label className="wf-check">
                        <input
                          type="checkbox"
                          checked={!!node.config.card}
                          onChange={(e) =>
                            setConfig({
                              card: e.target.checked
                                ? {
                                    title: node.config.title || "{{title}}",
                                    needsYou: "",
                                    body: node.config.template || "",
                                  }
                                : undefined,
                            })
                          }
                        />
                        <span>Post as action card (Dispatch / Dismiss + Needs-you badge)</span>
                      </label>
                      {node.config.card && (() => {
                        const card = node.config.card;
                        const setCard = (patch: Record<string, any>) => setConfig({ card: { ...card, ...patch } });
                        const fields: Array<{ label: string; value: string; tone?: string }> = Array.isArray(card.fields) ? card.fields : [];
                        const dispatch = card.dispatch && typeof card.dispatch === "object" ? card.dispatch : null;
                        const setDispatch = (patch: Record<string, any>) => {
                          const next = { ...(dispatch || {}), ...patch };
                          setCard({ dispatch: next });
                        };
                        return (
                          <div className="wf-card-editor">
                            <WorkflowFieldInput
                              label="Card title"
                              multiline={false}
                              value={card.title || ""}
                              onChange={(title) => setCard({ title })}
                              analysis={analysis}
                              placeholder="{{repo}} #{{number}}: {{title}}"
                            />
                            <WorkflowFieldInput
                              label="Subtitle / link line (optional)"
                              multiline={false}
                              value={card.subtitle || ""}
                              onChange={(subtitle) => setCard({ subtitle: subtitle || undefined })}
                              analysis={analysis}
                              placeholder="[{{repo}}#{{number}}]({{url}})"
                            />
                            <WorkflowFieldInput
                              label="Needs your direction flag (optional — yes/true or no/false)"
                              multiline={false}
                              value={typeof card.needsYou === "boolean" ? (card.needsYou ? "true" : "false") : card.needsYou || ""}
                              onChange={(needsYou) => setCard({ needsYou: needsYou || undefined })}
                              analysis={analysis}
                              placeholder="{{needs_colt}}"
                            />
                            <WorkflowFieldInput
                              label="Summary body (optional — falls back to message template)"
                              value={card.body || ""}
                              onChange={(body) => setCard({ body: body || undefined })}
                              analysis={analysis}
                              placeholder="{{summary}}"
                            />
                            <div className="wf-field-group">
                              <div className="wf-inline-head">
                                <label className="wf-label">Metadata badges (optional)</label>
                                <button
                                  type="button"
                                  className="wf-small-btn"
                                  onClick={() => setCard({ fields: [...fields, { label: "", value: "", tone: "neutral" }] })}
                                >
                                  + Add badge
                                </button>
                              </div>
                              {fields.map((f, idx) => (
                                <div key={idx} className="wf-rule-row">
                                  <input
                                    type="text"
                                    placeholder="Label (e.g. Priority)"
                                    value={f.label || ""}
                                    onChange={(e) => {
                                      const next = fields.slice();
                                      next[idx] = { ...f, label: e.target.value };
                                      setCard({ fields: next });
                                    }}
                                  />
                                  <input
                                    type="text"
                                    placeholder="Value (e.g. {{priority}})"
                                    value={f.value || ""}
                                    onChange={(e) => {
                                      const next = fields.slice();
                                      next[idx] = { ...f, value: e.target.value };
                                      setCard({ fields: next });
                                    }}
                                  />
                                  <select
                                    value={f.tone || "neutral"}
                                    onChange={(e) => {
                                      const next = fields.slice();
                                      next[idx] = { ...f, tone: e.target.value };
                                      setCard({ fields: next });
                                    }}
                                  >
                                    <option value="neutral">Neutral</option>
                                    <option value="accent">Accent</option>
                                    <option value="positive">Positive</option>
                                    <option value="warning">Warning</option>
                                    <option value="negative">Negative</option>
                                  </select>
                                  <button
                                    type="button"
                                    className="wf-icon-btn"
                                    aria-label="Remove badge"
                                    onClick={() => setCard({ fields: fields.filter((_, j) => j !== idx) })}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                            <WorkflowFieldInput
                              label="Reference link URL (optional, e.g. GitHub comment)"
                              multiline={false}
                              value={card.link?.url || ""}
                              onChange={(url) =>
                                setCard({
                                  link: url.trim()
                                    ? { label: card.link?.label || "View comment", url }
                                    : undefined,
                                })
                              }
                              analysis={analysis}
                              placeholder="{{comment_url}}"
                            />
                            {card.link?.url && (
                              <WorkflowFieldInput
                                label="Reference link label"
                                multiline={false}
                                value={card.link?.label || ""}
                                onChange={(label) => setCard({ link: { ...card.link, label } })}
                                analysis={analysis}
                                placeholder="View GitHub comment"
                              />
                            )}
                            <label className="wf-check">
                              <input
                                type="checkbox"
                                checked={!!dispatch}
                                onChange={(e) =>
                                  setCard({
                                    dispatch: e.target.checked
                                      ? { botId: node.config.botId || undefined, prompt: "" }
                                      : undefined,
                                  })
                                }
                              />
                              <span>Enable Dispatch button (starts a new chat with a bot)</span>
                            </label>
                            {dispatch && (
                              <>
                                <div className="wf-field-group">
                                  <label className="wf-label">Dispatch bot</label>
                                  <select
                                    value={dispatch.botId || ""}
                                    onChange={(e) => setDispatch({ botId: e.target.value || undefined, botName: undefined })}
                                  >
                                    <option value="">Same as posting bot</option>
                                    {bots.map((b) => (
                                      <option key={b.id} value={b.id}>
                                        {b.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <WorkflowFieldInput
                                  label="New chat title (optional — defaults to card title)"
                                  multiline={false}
                                  value={dispatch.chatTitle || ""}
                                  onChange={(chatTitle) => setDispatch({ chatTitle: chatTitle || undefined })}
                                  analysis={analysis}
                                  placeholder="{{repo}} #{{number}}: {{title}}"
                                />
                                <WorkflowFieldInput
                                  label="Dispatch prompt (first message sent to the bot)"
                                  value={dispatch.prompt || ""}
                                  onChange={(prompt) => setDispatch({ prompt })}
                                  analysis={analysis}
                                  placeholder="Work on {{repo}} #{{number}} ({{url}}):\n{{summary}}"
                                />
                              </>
                            )}
                          </div>
                        );
                      })()}
                      <label className="wf-check">
                        <input
                          type="checkbox"
                          checked={!!node.config.a2ui}
                          onChange={(e) => {
                            if (e.target.checked) {
                              const starter = [
                                {
                                  version: "1.0",
                                  createSurface: {
                                    surfaceId: "wf-surface",
                                    sendDataModel: true,
                                    components: [
                                      { id: "root", component: "Column", children: ["heading", "body", "actions"] },
                                      { id: "heading", component: "Text", text: "{{title?}}" },
                                      { id: "body", component: "Text", text: "{{agent_reply?}}", variant: "caption" },
                                      { id: "actions", component: "Row", children: ["ok_btn"] },
                                      { id: "ok_btn", component: "Button", child: "ok_label", variant: "primary", action: { event: { name: "acknowledge" } } },
                                      { id: "ok_label", component: "Text", text: "Acknowledge" },
                                    ],
                                    dataModel: {},
                                  },
                                },
                              ];
                              setConfig({ a2ui: { messages: JSON.stringify(starter, null, 2), onAction: "bot" } });
                            } else {
                              setConfig({ a2ui: undefined });
                            }
                          }}
                        />
                        <span>Post as A2UI v1.0 interactive surface</span>
                      </label>
                      {node.config.a2ui && (() => {
                        const rawA2ui = node.config.a2ui;
                        const isObj = typeof rawA2ui === "object" && rawA2ui !== null && !Array.isArray(rawA2ui);
                        const onAction: string = isObj && typeof rawA2ui.onAction === "string" ? rawA2ui.onAction : "bot";
                        const payloadText: string =
                          typeof rawA2ui === "string"
                            ? rawA2ui
                            : isObj && typeof rawA2ui.messages === "string"
                              ? rawA2ui.messages
                              : JSON.stringify(isObj && Array.isArray(rawA2ui.messages) ? rawA2ui.messages : rawA2ui, null, 2);
                        const updateA2ui = (nextText: string, nextOnAction: string) => {
                          let parsed: unknown = nextText;
                          try {
                            const obj = JSON.parse(nextText);
                            if (Array.isArray(obj)) parsed = obj;
                          } catch {
                            // Keep raw string while editing JSON with {{field}} tokens
                          }
                          setConfig({
                            a2ui: {
                              ...(isObj ? rawA2ui : {}),
                              messages: parsed,
                              onAction: nextOnAction,
                            },
                          });
                        };
                        return (
                          <div className="wf-card-editor">
                            <div className="wf-field-group">
                              <label className="wf-label">When the person clicks a surface action</label>
                              <select
                                value={onAction}
                                onChange={(e) => updateA2ui(payloadText, e.target.value)}
                              >
                                <option value="bot">Send action to owning bot in chat</option>
                                <option value="resume">Resume waiting workflow approval (or trigger)</option>
                                <option value="trigger">Trigger this workflow with action as input</option>
                              </select>
                            </div>
                            <WorkflowFieldInput
                              label="A2UI v1.0 messages JSON (supports {{field}} templates)"
                              value={payloadText}
                              onChange={(val) => updateA2ui(val, onAction)}
                              analysis={analysis}
                              placeholder='[{"version":"1.0","createSurface":{"surfaceId":"s1","components":[{"id":"root","component":"Text","text":"{{title}}"}]}}]'
                            />
                          </div>
                        );
                      })()}
                    </>
                  )}
                  {node.config.destination === "github" && (
                    <GithubOutputSettings
                      nodeId={node.id}
                      workflow={workflow}
                      config={node.config}
                      analysis={analysis}
                      setConfig={setConfig}
                    />
                  )}
                  {node.config.destination === "goal" && (
                    <div className="wf-field-group">
                      <label className="wf-label">Goal category</label>
                      <select value={node.config.category || "productivity"} onChange={(e) => setConfig({ category: e.target.value })}>
                        {goalCategories.map((c) => (
                          <option key={c} value={c}>
                            {c[0].toUpperCase() + c.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {node.config.destination && node.config.destination !== "chat" && node.config.destination !== "github" && (
                    <WorkflowFieldInput
                      label="Title (optional)"
                      multiline={false}
                      value={node.config.title || ""}
                      onChange={(title) => setConfig({ title })}
                      analysis={analysis}
                      placeholder="{{title}}"
                    />
                  )}
                  {node.config.destination !== "github" && (
                    <WorkflowFieldInput
                      label={node.config.card || node.config.a2ui ? "Fallback text template (optional — for notifications & older clients)" : "Message template"}
                      value={node.config.template || ""}
                      onChange={(template) => setConfig({ template })}
                      analysis={analysis}
                      placeholder="Task {{title}} is ready for review:\n{{agent_reply}}"
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        /* RUNS TAB */
        <div className="wf-inspector-body">
          {runs.length === 0 ? (
            <div className="wf-inspector-empty">
              <p>No runs yet. Trigger this workflow manually or wait for its trigger event.</p>
            </div>
          ) : (
            <div className="wf-runs-pane">
              <div className="wf-run-list">
                {runs.slice(0, 20).map((r) => {
                  const runUncertain = hasGithubUncertainFailure(r);
                  const runDetails = runUncertain ? resolveGithubUncertainDetails(r, workflow.nodes) : null;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={"wf-run-row" + (selectedRun?.id === r.id ? " active" : "")}
                      onClick={() => onSelectRun(r.id)}
                    >
                      <span className={`wf-run-dot wf-status-${runUncertain ? "github_uncertain" : r.status}`} />
                      <span className="wf-run-row-main">
                        <strong className={runUncertain ? "wf-run-status-uncertain" : undefined}>
                          {workflowRunStatusLabel(r)}
                        </strong>
                        <span>
                          {[
                            runDetails?.summary,
                            r.replay ? "Replay" : r.manual ? "Manual" : r.triggerKind || "Event",
                            relTime(r.startedAt),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="wf-run-dur">{durText(r.startedAt, r.finishedAt)}</span>
                    </button>
                  );
                })}
              </div>

              {selectedRun && (
                <div className="wf-run-detail">
                  <div className="wf-run-detail-head">
                    <div>
                      <strong
                        className={
                          "wf-run-detail-title" + (selectedRunUncertain ? " wf-run-status-uncertain" : "")
                        }
                      >
                        Run · {workflowRunStatusLabel(selectedRun)}
                      </strong>
                      <div className="wf-hint">
                        Started {new Date(selectedRun.startedAt).toLocaleTimeString()} ({durText(selectedRun.startedAt, selectedRun.finishedAt)})
                      </div>
                    </div>
                    <div className="wf-run-actions">
                      {selectedRun.status === "failed" && (
                        <button
                          type="button"
                          className="btn primary small"
                          disabled={busyAction === "retry"}
                          onClick={async () => {
                            setBusyAction("retry");
                            try {
                              await onRetryRun(selectedRun.id);
                            } finally {
                              setBusyAction(null);
                            }
                          }}
                        >
                          <RotateCcw size={12} aria-hidden="true" /> Retry failed step
                        </button>
                      )}
                      {selectedRunUncertain && canShowUncertainRetry({ run: selectedRun, isOwner }) && (
                        <button
                          type="button"
                          className="btn soft small wf-uncertain-btn"
                          disabled={busyAction === "retry-uncertain"}
                          onClick={() => void confirmAndRetryUncertain(selectedRun.id, selectedRunUncertain)}
                        >
                          <RotateCcw size={12} aria-hidden="true" /> Retry anyway
                        </button>
                      )}
                      {(selectedRun.status === "running" || selectedRun.status === "waiting_approval") && (
                        <button
                          type="button"
                          className="btn soft small"
                          onClick={() => onCancelRun(selectedRun.id)}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Pending approval box */}
                  {selectedRun.status === "waiting_approval" && selectedRun.pendingApproval && (
                    <div className="wf-approval-card">
                      <div className="wf-approval-title">
                        <ShieldCheck size={15} /> {selectedRun.pendingApproval.label}
                      </div>
                      <p className="wf-approval-msg">{selectedRun.pendingApproval.message}</p>
                      <input
                        type="text"
                        placeholder="Optional note…"
                        value={approvalNote}
                        onChange={(e) => setApprovalNote(e.target.value)}
                      />
                      <div className="wf-approval-btns">
                        <button
                          type="button"
                          className="btn primary small"
                          disabled={busyAction === "approve"}
                          onClick={async () => {
                            setBusyAction("approve");
                            try {
                              await onRespondApproval(selectedRun.id, selectedRun.pendingApproval!.nodeId, "approved", approvalNote);
                              setApprovalNote("");
                            } finally {
                              setBusyAction(null);
                            }
                          }}
                        >
                          <Check size={13} aria-hidden="true" /> Approve
                        </button>
                        <button
                          type="button"
                          className="btn soft small"
                          disabled={busyAction === "reject"}
                          onClick={async () => {
                            setBusyAction("reject");
                            try {
                              await onRespondApproval(selectedRun.id, selectedRun.pendingApproval!.nodeId, "rejected", approvalNote);
                              setApprovalNote("");
                            } finally {
                              setBusyAction(null);
                            }
                          }}
                        >
                          <X size={13} aria-hidden="true" /> Reject
                        </button>
                      </div>
                    </div>
                  )}

                  {selectedRunUncertain && (
                    <div className="wf-uncertain-box" role="alert">
                      <div className="wf-uncertain-head">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <span>{selectedRunUncertain.statusLabel}</span>
                      </div>
                      <div className="wf-uncertain-detail">
                        <strong>{selectedRunUncertain.actionLabel}</strong>
                        {selectedRunUncertain.target ? (
                          <>
                            {" on "}
                            {selectedRunUncertain.url ? (
                              <button
                                type="button"
                                className="wf-uncertain-link"
                                onClick={() => void api.openLink(selectedRunUncertain.url!)}
                              >
                                {selectedRunUncertain.target} <ExternalLink size={11} aria-hidden="true" />
                              </button>
                            ) : (
                              <code>{selectedRunUncertain.target}</code>
                            )}
                          </>
                        ) : null}
                        {" — check GitHub before retrying so it does not post twice."}
                      </div>
                      <div className="wf-uncertain-actions">
                        {selectedRunUncertain.url && (
                          <button
                            type="button"
                            className="wf-mini-btn"
                            onClick={() => void api.openLink(selectedRunUncertain.url!)}
                          >
                            <ExternalLink size={11} aria-hidden="true" /> Open on GitHub
                          </button>
                        )}
                        {canShowUncertainRetry({ run: selectedRun, isOwner }) && (
                          <button
                            type="button"
                            className="wf-mini-btn wf-uncertain-btn"
                            disabled={busyAction === "retry-uncertain"}
                            onClick={() => void confirmAndRetryUncertain(selectedRun.id, selectedRunUncertain)}
                          >
                            <RotateCcw size={11} aria-hidden="true" /> Retry anyway
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {selectedRun.error && !selectedRunUncertain && (
                    <div className="wf-error-box">
                      <AlertTriangle size={13} /> <span>{selectedRun.error}</span>
                    </div>
                  )}

                  <div className="wf-step-list">
                    {(() => {
                      const uncertainStep = findGithubUncertainStep(selectedRun);
                      return Object.values(selectedRun.steps).map((st) => {
                        const isUncertain = isGithubUncertainStep(st) || uncertainStep?.nodeId === st.nodeId;
                        const stepUncertain = isUncertain
                          ? resolveGithubUncertainDetails(selectedRun, workflow.nodes, st)
                          : null;
                        return (
                          <div
                            key={st.nodeId}
                            className={`wf-step-card wf-status-${isUncertain ? "github_uncertain" : st.status}`}
                          >
                            <div className="wf-step-card-head">
                              <span className="wf-step-card-name">
                                {st.status === "completed" && <CheckCircle2 size={13} />}
                                {isUncertain && <AlertTriangle size={13} />}
                                {st.status === "failed" && !isUncertain && <XCircle size={13} />}
                                {st.status === "running" && <LoaderCircle size={13} className="wf-spin" />}
                                {st.status === "waiting_approval" && <ShieldCheck size={13} />}
                                {st.status === "pending" && <Clock size={13} />}
                                <span>{st.label}</span>
                              </span>
                              <span
                                className={
                                  "wf-step-card-meta" + (isUncertain ? " wf-run-status-uncertain" : "")
                                }
                              >
                                {workflowStepStatusLabel(st, selectedRun)}
                                {st.startedAt ? ` · ${durText(st.startedAt, st.finishedAt)}` : ""}
                              </span>
                            </div>
                            {st.summary && <div className="wf-step-summary">{st.summary}</div>}
                            {stepUncertain && (
                              <div className="wf-step-uncertain-note">
                                <span>
                                  {stepUncertain.actionLabel}
                                  {stepUncertain.target ? ` on ${stepUncertain.target}` : ""}
                                </span>
                                {stepUncertain.url && (
                                  <button
                                    type="button"
                                    className="wf-uncertain-link"
                                    onClick={() => void api.openLink(stepUncertain.url!)}
                                  >
                                    Check on GitHub <ExternalLink size={11} aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            )}
                            {st.error && <div className="wf-step-err">{st.error}</div>}
                            {st.status === "failed" && (
                              <div className="wf-step-actions">
                                <button
                                  type="button"
                                  className="wf-mini-btn"
                                  onClick={() => onRetryRun(selectedRun.id, st.nodeId)}
                                >
                                  <RotateCcw size={11} /> Retry from here (with current settings)
                                </button>
                                {stepUncertain && canShowUncertainRetry({ run: selectedRun, isOwner, step: st }) && (
                                  <button
                                    type="button"
                                    className="wf-mini-btn wf-uncertain-btn"
                                    disabled={busyAction === `retry-uncertain:${st.nodeId}`}
                                    onClick={() =>
                                      void confirmAndRetryUncertain(
                                        selectedRun.id,
                                        stepUncertain,
                                        st.nodeId,
                                        `retry-uncertain:${st.nodeId}`,
                                      )
                                    }
                                  >
                                    <RotateCcw size={11} aria-hidden="true" /> Retry anyway
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {dialogs.node}
    </aside>
  );
}
