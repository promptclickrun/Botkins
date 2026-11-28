// Settings › Node host: turn this computer on as a node host, convert an existing full host
// safely with the conversion wizard, manage exec policy, allowlist, whole-computer scope,
// shared project folders, pause/kill switch, saved grants, audit log, or undo a conversion.
import { useEffect, useState } from "react";
import type { NodeHostExecPolicy, State } from "./types";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";
import ConvertToNodeWizard from "./ConvertToNodeWizard";

const api = window.botkins;

const EXEC_MODES: Array<{ value: NodeHostExecPolicy["mode"]; label: string; help: string }> = [
  { value: "deny", label: "Deny", help: "Refuse all remote shell execution requests." },
  { value: "allowlist", label: "Allowlist", help: "Run matching allowlist commands automatically; refuse everything else." },
  { value: "ask", label: "Ask (default)", help: "Ask for approval before running any command unless allowlisted or granted." },
  { value: "full", label: "Full", help: "Run remote shell commands without asking, including shell strings and interpreters." },
];

function formatTime(ms?: number) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export default function NodeHostSettings({ state, fail }: { state: State; fail: (e: unknown) => void }) {
  const node = state.nodeHost;
  const [name, setName] = useState(node?.name ?? "");
  const [pattern, setPattern] = useState("");
  const [botScope, setBotScope] = useState("*");
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const hasLocalData = node?.hasLocalData ?? (state.bots.length > 0 || state.chats.length > 0);
  const activeSnapshot = node?.conversion?.snapshot ?? null;
  const interruptedJob =
    node?.conversion?.activeJob &&
    (node.conversion.activeJob.status === "paused" || node.conversion.activeJob.status === "failed")
      ? node.conversion.activeJob
      : null;

  useEffect(() => {
    setName(node?.name ?? "");
  }, [node?.name]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (wizardOpen) {
    return <ConvertToNodeWizard onClose={() => setWizardOpen(false)} fail={fail} />;
  }

  if (!node?.enabled) {
    return (
      <>
        {hasLocalData && (
          <Group
            title="Convert this computer to a Node host"
            footer="Takes a local backup snapshot first, lets you move, keep as shared, or delete each local bot, keeps routines from running twice, and preserves phone pairing."
            actions={
              <button
                type="button"
                className="set-button primary"
                disabled={busy}
                onClick={() => setWizardOpen(true)}
              >
                {interruptedJob ? "Resume conversion" : "Convert this computer to a Node host"}
              </button>
            }
          >
            <ValueRow
              label="Local workspace"
              value={`${state.bots.length} bot${state.bots.length === 1 ? "" : "s"} · ${state.chats.length} chat${state.chats.length === 1 ? "" : "s"}`}
              help="Walk through moving or keeping your local bots before turning on Node host mode."
            />
            {interruptedJob && (
              <ValueRow
                label="Interrupted conversion"
                value={interruptedJob.status === "paused" ? "Paused safely" : "Stopped"}
                help={interruptedJob.error ?? "Resume to continue without duplicating moved bots."}
              />
            )}
          </Group>
        )}

        <Group
          title="Node host"
          footer="A node host publishes this computer to your profile and lets bots on your other computers run scoped file, shell, screen and notification operations under your approval policy."
          actions={
            <button
              type="button"
              className={hasLocalData ? "set-button" : "set-button primary"}
              disabled={busy}
              onClick={() => void run(() => api.nodeSetup({ name: name.trim() || undefined }))}
            >
              {busy ? "Setting up…" : "Set Up as Node Host"}
            </button>
          }
        >
          <ValueRow label="Status" value="Off" />
          <Row label="Node name" help="How this computer appears to your other Botkins hosts.">
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Build Mac or Home Server"
                disabled={busy}
              />
            )}
          </Row>
        </Group>
      </>
    );
  }

  const last = node.lastCompleted;
  const lastAt = last?.finishedAt ?? last?.at;
  const lastText = last
    ? `${last.sourceBotName} on ${last.sourceHostName} · ${last.operation} (${last.resourceName}) · ${last.status}`
    : "None yet";
  const execMode = node.execPolicy?.mode ?? "ask";
  const allowlist = node.execPolicy?.allowlist ?? [];
  const auditLog = node.auditLog ?? [];
  const execHelp = EXEC_MODES.find((m) => m.value === execMode)?.help;

  return (
    <>
      <Group
        title="Status"
        footer="Pausing immediately refuses new requests and terminates any running node processes. Disconnecting turns off node host mode, clears saved grants, and stops sharing folders."
        actions={
          <>
            <button
              type="button"
              className="set-button"
              disabled={busy}
              onClick={() => void run(() => api.nodePause(!node.paused))}
            >
              {node.paused ? "Resume" : "Pause (Kill Switch)"}
            </button>
            {confirmDisconnect ? (
              <>
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => setConfirmDisconnect(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="set-button danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.nodeDisconnect();
                      setConfirmDisconnect(false);
                    })
                  }
                >
                  Confirm disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                className="set-button danger"
                disabled={busy}
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </button>
            )}
          </>
        }
      >
        <ValueRow
          label="Status"
          value={node.paused ? "Paused" : "Online"}
          help={node.paused ? "Kill switch active: rejecting requests and stopping running jobs." : "Ready for requests from your other hosts."}
        />
        <Row label="Node name" help="Shown to your other Botkins hosts and in approval cards.">
          {(id, describedBy) => (
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input
                id={id}
                aria-describedby={describedBy}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className="set-button"
                disabled={busy || !name.trim() || name.trim() === node.name}
                onClick={() => void run(() => api.nodeRename(name.trim()))}
              >
                Save
              </button>
            </span>
          )}
        </Row>
        <ValueRow
          label="Last completed request"
          value={lastText}
          help={last ? `${formatTime(lastAt)}${last.summary ? " · " + last.summary : ""}` : undefined}
        />
      </Group>

      {activeSnapshot && (
        <Group
          title="Conversion backup snapshot"
          footer="Restoring brings back your pre-conversion bots, chats, routines, memory, and panels while keeping your phone pairing and encrypted vault intact."
          actions={
            confirmUndo ? (
              <>
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => setConfirmUndo(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="set-button danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.nodeConvertUndo({ snapshotId: activeSnapshot.id });
                      setConfirmUndo(false);
                    })
                  }
                >
                  Confirm undo conversion
                </button>
              </>
            ) : (
              <button
                type="button"
                className="set-button danger"
                disabled={busy}
                onClick={() => setConfirmUndo(true)}
              >
                Undo conversion
              </button>
            )
          }
        >
          <ValueRow
            label="Backup location"
            value={activeSnapshot.path}
            help={`Taken ${formatTime(activeSnapshot.createdAt)} · ${activeSnapshot.botCount} bot(s), ${activeSnapshot.chatCount} chat(s)`}
          />
        </Group>
      )}

      <Group
        title="Shell execution policy"
        footer="Stored and enforced on this node. Approvals bind exact argv, cwd, env and resolved executable path; unpinned interpreter scripts are refused unless mode is Full."
      >
        <Row label="Policy mode" help={execHelp}>
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              value={execMode}
              disabled={busy}
              onChange={(e) =>
                void run(() => api.nodeSetExecMode(e.target.value as NodeHostExecPolicy["mode"]))
              }
            >
              {EXEC_MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Add allowlist rule" help="Executable name or resolved path glob (e.g. uname, git, /usr/bin/git). Scope to * or a source bot ID.">
          {(id, describedBy) => (
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                id={id}
                aria-describedby={describedBy}
                type="text"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="Pattern (e.g. git)"
                disabled={busy}
                style={{ width: 150 }}
              />
              <input
                type="text"
                value={botScope}
                onChange={(e) => setBotScope(e.target.value)}
                placeholder="Bot ID or *"
                disabled={busy}
                style={{ width: 110 }}
              />
              <button
                type="button"
                className="set-button"
                disabled={busy || !pattern.trim()}
                onClick={() =>
                  void run(async () => {
                    await api.nodeAddAllowlistRule({
                      pattern: pattern.trim(),
                      botId: botScope.trim() || "*",
                    });
                    setPattern("");
                    setBotScope("*");
                  })
                }
              >
                Add
              </button>
            </span>
          )}
        </Row>
        {allowlist.length === 0 ? (
          <ValueRow label="Allowlist rules" value="None" help="No commands are allowlisted on this node yet." />
        ) : (
          allowlist.map((rule) => (
            <div className="set-row" key={rule.id}>
              <div className="set-label">
                <span>{rule.pattern}</span>
                <small>Source bot: {rule.botId || "*"}</small>
              </div>
              <div className="set-control">
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => void run(() => api.nodeRemoveAllowlistRule(rule.id))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </Group>

      <Group
        title="File access & shared folders"
        footer="Shared folders block path traversal and symlink escapes. Turning on Whole computer allows absolute paths outside shared folders (still gated by per-operation grants)."
      >
        <SwitchRow
          label="Whole computer file access"
          help="Opt-in: allow approved bots to read, write, move, search or delete files outside shared folders."
          checked={!!node.wholeComputer}
          disabled={busy}
          onChange={(checked) => void run(() => api.nodeSetWholeComputer(checked))}
        />
        {node.availableProjects.length === 0 ? (
          <ValueRow
            label="No project folders yet"
            value="None"
            help="Create a project with a folder under Work › Projects, then turn on sharing here."
          />
        ) : (
          node.availableProjects.map((project) => (
            <SwitchRow
              key={project.id}
              label={project.name}
              help={project.folder ?? project.path}
              checked={!!project.shared}
              disabled={busy}
              onChange={(checked) => void run(() => api.nodeShareProject(project.id, checked))}
            />
          ))
        )}
      </Group>

      <Group
        title="Saved grants"
        footer="Grants are scoped per source host, bot, operation and resource. Destructive operations and shell commands require their own grants."
        actions={
          node.grants.length > 1 ? (
            <button
              type="button"
              className="set-button danger"
              disabled={busy}
              onClick={() => void run(() => api.nodeRevokeGrant(null))}
            >
              Revoke all
            </button>
          ) : undefined
        }
      >
        {node.grants.length === 0 ? (
          <ValueRow label="No saved grants" value="None" help="When you choose Allow for today or Always allow, it appears here." />
        ) : (
          node.grants.map((grant) => (
            <div className="set-row" key={grant.id}>
              <div className="set-label">
                <span>
                  {grant.sourceBotName} on {grant.sourceHostName} → {grant.resourceName}
                </span>
                <small>
                  {grant.operation} · {grant.until ? `Until ${formatTime(grant.until)}` : "Always allow"}
                </small>
              </div>
              <div className="set-control">
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => void run(() => api.nodeRevokeGrant(grant.id))}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </Group>

      <Group
        title="Audit log"
        footer="Every remote node operation, caller, arguments summary, status and exit code is recorded locally on this node."
      >
        {auditLog.length === 0 ? (
          <ValueRow label="No operations recorded" value="Empty" />
        ) : (
          auditLog.slice(0, 25).map((entry) => (
            <div className="set-row" key={entry.id}>
              <div className="set-label">
                <span>
                  {entry.operation} · {entry.status}
                  {entry.exitCode !== undefined && entry.exitCode !== null ? ` (exit ${entry.exitCode})` : ""}
                </span>
                <small>
                  {entry.sourceBotName} on {entry.sourceHostName} · {entry.argsSummary || entry.resourceName} · {formatTime(entry.time)}
                  {entry.error ? ` · ${entry.error}` : ""}
                </small>
              </div>
            </div>
          ))
        )}
      </Group>
    </>
  );
}
