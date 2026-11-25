// Settings › Node host: turn this computer on as a node host, manage shared project folders,
// pause or disconnect it, inspect the last completed request, and revoke saved grants.
import { useEffect, useState } from "react";
import type { State } from "./types";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";

const api = window.botkins;

function formatTime(ms: number) {
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

  if (!node?.enabled) {
    return (
      <Group
        title="Node host"
        footer="A node host publishes this computer to your profile even without bots, and lets bots on your other computers list files in project folders you choose to share."
        actions={
          <button
            type="button"
            className="set-button primary"
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
    );
  }

  const last = node.lastCompleted;
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
          help={last ? `${formatTime(last.at)}${last.summary ? " · " + last.summary : ""}` : undefined}
        />
      </Group>

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
              help={project.path}
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
