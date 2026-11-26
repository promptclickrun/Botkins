// Settings › Node host: turn this computer on as a node host, convert an existing full host
// safely with the conversion wizard, manage shared project folders, pause or disconnect it,
// inspect the last completed request, revoke saved grants, or undo a conversion from snapshot.
import { useEffect, useState } from "react";
import type { State } from "./types";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";
import ConvertToNodeWizard from "./ConvertToNodeWizard";

const api = window.botkins;

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
          footer="A node host publishes this computer to your profile even without bots, and lets bots on your other computers list files in project folders you choose to share."
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
    ? `${last.sourceBotName} on ${last.sourceHostName} · ${last.resourceName} (${last.status})`
    : "None yet";

  return (
    <>
      <Group
        title="Status"
        footer="Pausing refuses new file-listing requests until you resume. Disconnecting turns off node host mode, clears saved grants, and stops sharing folders."
        actions={
          <>
            <button
              type="button"
              className="set-button"
              disabled={busy}
              onClick={() => void run(() => api.nodePause(!node.paused))}
            >
              {node.paused ? "Resume" : "Pause"}
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
          help={node.paused ? "Not accepting new node requests." : "Ready for requests from your other hosts."}
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
        title="Shared folders"
        footer="Bots on your other hosts can only list files inside project folders you turn on here. Path traversal and symlinks outside the folder are refused."
      >
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
        footer="File-listing grants are separate from cross-host conversation grants. Revoking a grant makes the next request ask for approval again."
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
                  List files · {grant.until ? `Until ${formatTime(grant.until)}` : "Always allow"}
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
    </>
  );
}
