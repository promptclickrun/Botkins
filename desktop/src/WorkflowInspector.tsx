// Right-hand Inspector panel for Workflows:
// - "Step" tab: edit selected trigger / agent / model / condition / approval / output node,
//   with `WorkflowFieldInput` (`{{field}}` chips & picker), webhook secret rotation, and structured outputs.
// - "Runs" tab: run history with per-step statuses, durations, outputs, Approve/Reject controls,
//   and Retry from failed step (using the node's current settings).

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { categories as goalCategories } from "./Board";
import { WorkflowFieldInput } from "./WorkflowFieldInput";
import type {
  Bot,
  Chat,
  ModelInfo,
  Workflow,
  WorkflowConditionRule,
  WorkflowFieldDef,
  WorkflowGithubStatus,
  WorkflowNode,
  WorkflowRun,
  WorkflowTriggerKind,
} from "./types";
import type { NodeFieldAnalysis } from "./workflowAnalysis";
import { TRIGGER_FIELDS } from "./workflowAnalysis";

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

const GITHUB_EVENT_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "pr_opened", label: "PR opened", hint: "New pull request" },
  { value: "pr_updated", label: "PR updated", hint: "PR edited, closed, or merged" },
  { value: "pr_review", label: "PR review", hint: "Review decision changed" },
  { value: "ci_status", label: "CI status", hint: "Checks passing/failing changed" },
  { value: "issue_opened", label: "Issue opened", hint: "New issue" },
  { value: "issue_updated", label: "Issue updated", hint: "Issue edited, labeled, or closed" },
  { value: "issue_comment", label: "Comment added", hint: "New issue or PR comment" },
  { value: "user_mentioned", label: "Mentioned me", hint: "Your GitHub @username mentioned" },
  { value: "bot_mentioned", label: "Bot mentioned", hint: "Custom @bot handle mentioned" },
];

function normalizeEventList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return ["pr_opened", "pr_review", "ci_status"];
}

function GithubTriggerSettings({
  nodeId,
  config,
  setConfig,
}: {
  nodeId: string;
  config: Record<string, any>;
  setConfig: (patch: Record<string, any>) => void;
}) {
  const [status, setStatus] = useState<WorkflowGithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const loadStatus = async (includeRepos = true) => {
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
  };

  useEffect(() => {
    setLoading(true);
    void loadStatus(true);
  }, [nodeId]);

  const waiting = status?.signIn?.status === "waiting" || status?.signIn?.status === "starting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void loadStatus(true);
    }, 2500);
    return () => clearInterval(timer);
  }, [waiting]);

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

  const selectedEvents = normalizeEventList(config.events);
  const toggleEvent = (ev: string) => {
    const next = selectedEvents.includes(ev)
      ? selectedEvents.filter((item) => item !== ev)
      : [...selectedEvents, ev];
    const patch: Record<string, any> = { events: next };
    if (ev === "bot_mentioned" && !selectedEvents.includes(ev) && !config.mentionHandle) {
      patch.mentionHandle = "@botkins-bot";
    }
    setConfig(patch);
  };

  const repoListId = `wf-gh-repos-${nodeId}`;
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
              Install the GitHub CLI (<code>gh</code>) on this computer to connect GitHub and poll events locally.
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
            <p className="wf-hint">Sign in once with your GitHub account so Botkins can poll this repository locally.</p>
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

      <div className="wf-field-group">
        <label className="wf-label">Repository (owner/repo)</label>
        <input
          type="text"
          list={status?.repos?.length ? repoListId : undefined}
          value={config.repo || ""}
          placeholder="promptclickrun/Botkins"
          onChange={(e) => setConfig({ repo: e.target.value.trim() })}
        />
        {!!status?.repos?.length && (
          <datalist id={repoListId}>
            {status.repos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        )}
      </div>

      <div className="wf-field-group">
        <label className="wf-label">Events</label>
        <div className="wf-gh-events">
          {GITHUB_EVENT_OPTIONS.map((opt) => {
            const active = selectedEvents.includes(opt.value);
            const label =
              opt.value === "user_mentioned" && status?.login
                ? `Mentioned @${status.login}`
                : opt.label;
            return (
              <button
                key={opt.value}
                type="button"
                className={`wf-gh-event-pill ${active ? "active" : ""}`}
                title={opt.hint}
                onClick={() => toggleEvent(opt.value)}
              >
                {active && <Check size={11} />}
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedEvents.includes("bot_mentioned") && (
        <div className="wf-field-group">
          <label className="wf-label">Bot mention handle(s)</label>
          <input
            type="text"
            value={config.mentionHandle ?? "@botkins-bot"}
            placeholder="@botkins-bot"
            onChange={(e) => setConfig({ mentionHandle: e.target.value })}
          />
          <p className="wf-hint">Triggers when an issue, PR, or comment mentions this handle (comma-separated for multiple).</p>
        </div>
      )}

      <div className="wf-two-col">
        <div className="wf-field-group">
          <label className="wf-label">Branch filter (PRs)</label>
          <input
            type="text"
            value={config.branch || ""}
            placeholder="Optional, e.g. main"
            onChange={(e) => setConfig({ branch: e.target.value.trim() || undefined })}
          />
        </div>
        <div className="wf-field-group">
          <label className="wf-label">Author filter</label>
          <input
            type="text"
            value={config.author || ""}
            placeholder="Optional username"
            onChange={(e) => setConfig({ author: e.target.value.trim().replace(/^@/, "") || undefined })}
          />
        </div>
      </div>

      <div className="wf-field-group">
        <label className="wf-label">Poll interval (min)</label>
        <input
          type="number"
          min={1}
          max={120}
          value={config.pollMinutes ?? 5}
          onChange={(e) => setConfig({ pollMinutes: Math.max(1, Number(e.target.value) || 5) })}
        />
        <p className="wf-hint">Polls via local <code>gh</code> CLI (no inbound tunnel or relay required).</p>
      </div>
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
  tab: "step" | "runs";
  onTab: (t: "step" | "runs") => void;
  onSelectRun: (runId: string | null) => void;
  onChangeNode: (nodeId: string, updater: (prev: WorkflowNode) => WorkflowNode) => void;
  onRetryRun: (runId: string, nodeId?: string) => Promise<void>;
  onRespondApproval: (runId: string, nodeId: string, decision: "approved" | "rejected", note: string) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
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
  tab,
  onTab,
  onSelectRun,
  onChangeNode,
  onRetryRun,
  onRespondApproval,
  onCancelRun,
  webhookPort,
}: Props) {
  const [freshSecret, setFreshSecret] = useState<{ nodeId: string; secret: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null;

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
                          config: tk === "github" ? { events: ["pr_opened", "pr_review", "ci_status"], pollMinutes: 5 } : {},
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
                    <GithubTriggerSettings nodeId={node.id} config={node.config} setConfig={setConfig} />
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
                            checked={Boolean(node.config.directOnly)}
                            onChange={(e) => setConfig({ directOnly: e.target.checked })}
                          />
                          <span>Direct messages only</span>
                        </label>
                        <label className="wf-checkbox-row">
                          <input
                            type="checkbox"
                            checked={Boolean(node.config.mentionOnly)}
                            onChange={(e) => setConfig({ mentionOnly: e.target.checked })}
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
                    <select value={node.config.destination || "chat"} onChange={(e) => setConfig({ destination: e.target.value })}>
                      <option value="chat">Post to chat</option>
                      <option value="feed">Today · Feed</option>
                      <option value="idea">Today · Ideas</option>
                      <option value="goal">Today · Goals</option>
                      <option value="notification">Notification</option>
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
                    </>
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
                  {node.config.destination && node.config.destination !== "chat" && (
                    <WorkflowFieldInput
                      label="Title (optional)"
                      multiline={false}
                      value={node.config.title || ""}
                      onChange={(title) => setConfig({ title })}
                      analysis={analysis}
                      placeholder="{{title}}"
                    />
                  )}
                  <WorkflowFieldInput
                    label="Message template"
                    value={node.config.template || ""}
                    onChange={(template) => setConfig({ template })}
                    analysis={analysis}
                    placeholder="Task {{title}} is ready for review:\n{{agent_reply}}"
                  />
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
                {runs.slice(0, 20).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={"wf-run-row" + (selectedRun?.id === r.id ? " active" : "")}
                    onClick={() => onSelectRun(r.id)}
                  >
                    <span className={`wf-run-dot wf-status-${r.status}`} />
                    <span className="wf-run-row-main">
                      <strong>{r.status === "waiting_approval" ? "Waiting approval" : r.status}</strong>
                      <span>
                        {r.manual ? "Manual" : r.triggerKind || "Event"} · {relTime(r.startedAt)}
                      </span>
                    </span>
                    <span className="wf-run-dur">{durText(r.startedAt, r.finishedAt)}</span>
                  </button>
                ))}
              </div>

              {selectedRun && (
                <div className="wf-run-detail">
                  <div className="wf-run-detail-head">
                    <div>
                      <strong className="wf-run-detail-title">Run · {selectedRun.status}</strong>
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

                  {selectedRun.error && (
                    <div className="wf-error-box">
                      <AlertTriangle size={13} /> <span>{selectedRun.error}</span>
                    </div>
                  )}

                  <div className="wf-step-list">
                    {Object.values(selectedRun.steps).map((st) => (
                      <div key={st.nodeId} className={`wf-step-card wf-status-${st.status}`}>
                        <div className="wf-step-card-head">
                          <span className="wf-step-card-name">
                            {st.status === "completed" && <CheckCircle2 size={13} />}
                            {st.status === "failed" && <XCircle size={13} />}
                            {st.status === "running" && <LoaderCircle size={13} className="wf-spin" />}
                            {st.status === "waiting_approval" && <ShieldCheck size={13} />}
                            {st.status === "pending" && <Clock size={13} />}
                            <span>{st.label}</span>
                          </span>
                          <span className="wf-step-card-meta">
                            {st.status}
                            {st.startedAt ? ` · ${durText(st.startedAt, st.finishedAt)}` : ""}
                          </span>
                        </div>
                        {st.summary && <div className="wf-step-summary">{st.summary}</div>}
                        {st.error && <div className="wf-step-err">{st.error}</div>}
                        {st.status === "failed" && (
                          <button
                            type="button"
                            className="wf-mini-btn"
                            onClick={() => onRetryRun(selectedRun.id, st.nodeId)}
                          >
                            <RotateCcw size={11} /> Retry from here (with current settings)
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
