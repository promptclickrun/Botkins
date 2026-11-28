import { useCallback, useEffect, useState } from "react";
import type { GithubAgentStatus, State } from "./types";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";

const api = window.botkins;

function formatTime(iso?: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function GithubSettings({ state }: { state: State }) {
  const bots = state.bots.filter((b) => !b.hidden);
  const [status, setStatus] = useState<GithubAgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowDrafts, setAllowDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async (refreshFromRelay = false) => {
    setError(null);
    try {
      const next = refreshFromRelay ? await api.githubAgentRefresh() : await api.githubAgentStatus();
      setStatus(next);
      setAllowDrafts((prev) => {
        const merged = { ...prev };
        for (const r of next.repos ?? []) {
          if (merged[r.fullName] === undefined) merged[r.fullName] = (r.allowlist ?? []).join(", ");
        }
        return merged;
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const handleInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.githubAgentInstallUrl();
      await api.openLink(url);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await load(true);
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async (installationId: number) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.githubAgentUnbind(installationId);
      setStatus(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRepoPatch = async (
    repo: string,
    patch: { answerMentions?: boolean; defaultBotId?: string | null; allowlist?: string[] | string },
  ) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.githubAgentSetRepo(repo, patch);
      setStatus(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const hasInstallations = (status?.installations?.length ?? 0) > 0;
  const appSlug = status?.appSlug || "botkins-agent";

  return (
    <div className="set-stack">
      <Group
        title="Botkins Agent on GitHub"
        footer={`Install @${appSlug} on your repositories so you can mention @${appSlug} (or @${appSlug} <bot name>) on issues and pull requests. Replies post as Botkins Agent with the answering bot's name, and no personal GitHub tokens are sent through the relay.`}
      >
        <ValueRow
          label="Connection"
          value={
            loading && !status
              ? "Checking…"
              : status?.relayConnected
                ? hasInstallations
                  ? "Connected"
                  : "Relay connected · not installed yet"
                : "Relay disconnected"
          }
        />
        <ValueRow label="Events" value={status?.eventsOn ? "On" : "Off"} />
        <ValueRow
          label="Last delivery"
          value={
            status?.lastDelivery
              ? `${status.lastDelivery.event} · ${status.lastDelivery.repository} (${formatTime(status.lastDelivery.receivedAt)})`
              : "None yet"
          }
        />
        <Row
          label={hasInstallations ? "Add or manage on GitHub" : "Install Botkins Agent"}
          help="Opens GitHub with a signed 10-minute link bound to this computer's room key."
        >
          {(id) => (
            <div id={id} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleInstall()}>
                {hasInstallations ? "Add installation" : "Install Botkins Agent"}
              </button>
              {hasInstallations && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void api.openLink(
                      status?.installations?.[0]?.manageUrl ||
                        status?.manageAppUrl ||
                        `https://github.com/apps/${appSlug}`,
                    )
                  }
                >
                  Manage on GitHub
                </button>
              )}
              <button type="button" className="btn" disabled={busy} onClick={() => void handleRefresh()}>
                Refresh
              </button>
            </div>
          )}
        </Row>
      </Group>

      {error && (
        <Group title="Error">
          <div style={{ padding: "10px 14px", color: "var(--danger, #c43)" }}>{error}</div>
        </Group>
      )}

      <Group
        title="Installations"
        footer="Each binding records only the repositories your GitHub account can access (with read/write matching your GitHub permissions) and expires every 7 days. Re-authorize after 7 days or after adding new repositories on GitHub."
      >
        {!hasInstallations ? (
          <ValueRow
            label="No installations bound"
            help={`Click "Install Botkins Agent" above to connect your GitHub account or organization.`}
            value=""
          />
        ) : (
          status!.installations.map((inst) => (
            <Row
              key={inst.installationId}
              label={`${inst.accountLogin || `Installation #${inst.installationId}`} (${inst.accountType})${inst.expired ? " · Re-authorize required" : ""}`}
              help={
                inst.expired
                  ? `Installation #${inst.installationId} · binding expired${inst.installerLogin ? ` (@${inst.installerLogin})` : ""}. Re-authorize to resume events and tokens.`
                  : `Installation #${inst.installationId} · ${inst.repos.length} verified ${inst.repos.length === 1 ? "repository" : "repositories"}${inst.installerLogin ? ` · verified as @${inst.installerLogin}` : ""}${inst.expiresAt ? ` · expires ${formatTime(new Date(inst.expiresAt).toISOString())}` : ""}`
              }
            >
              {(id) => (
                <div id={id} style={{ display: "flex", gap: 8 }}>
                  {inst.expired && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void handleInstall()}
                    >
                      Re-authorize
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void api.openLink(inst.manageUrl || `https://github.com/settings/installations/${inst.installationId}`)
                    }
                  >
                    Manage
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void handleUnbind(inst.installationId)}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </Row>
          ))
        )}
      </Group>

      <Group
        title="Repositories"
        footer={`Turn on "Answer @${appSlug} mentions" for any repository. By default, only the installer and collaborators with write permission can summon a bot; add extra GitHub logins in the per-repo allowlist if needed.`}
      >
        {!(status?.repos?.length) ? (
          <ValueRow
            label="No repositories yet"
            help="Install Botkins Agent and grant access to one or more repositories, then click Refresh."
            value=""
          />
        ) : (
          status!.repos.map((repo) => {
            const draft = allowDrafts[repo.fullName] ?? (repo.allowlist ?? []).join(", ");
            return (
              <div key={repo.fullName} style={{ borderBottom: "1px solid var(--line)", padding: "10px 14px", display: "grid", gap: 8 }}>
                <SwitchRow
                  label={repo.fullName}
                  help={`Answer @${appSlug} mentions in issues and pull requests`}
                  checked={repo.answerMentions}
                  disabled={busy}
                  onChange={(answerMentions) => void handleRepoPatch(repo.fullName, { answerMentions })}
                />
                <Row label="Default bot" help={`Used when a comment says @${appSlug} without naming a bot.`}>
                  {(id, describedBy) => (
                    <select
                      id={id}
                      aria-describedby={describedBy}
                      className="set-select"
                      disabled={busy}
                      value={repo.defaultBotId ?? ""}
                      onChange={(e) => void handleRepoPatch(repo.fullName, { defaultBotId: e.target.value || null })}
                    >
                      <option value="">Primary bot</option>
                      {bots.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Row>
                <Row
                  label="Extra allowlist (optional)"
                  help="Comma-separated GitHub logins allowed in addition to the installer and write collaborators."
                >
                  {(id, describedBy) => (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        id={id}
                        aria-describedby={describedBy}
                        type="text"
                        className="set-input"
                        placeholder="alice, bob"
                        value={draft}
                        disabled={busy}
                        onChange={(e) => setAllowDrafts((prev) => ({ ...prev, [repo.fullName]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void handleRepoPatch(repo.fullName, { allowlist: draft })}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </Row>
              </div>
            );
          })
        )}
      </Group>
    </div>
  );
}
