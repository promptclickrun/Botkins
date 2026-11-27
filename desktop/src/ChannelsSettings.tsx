import { useEffect, useState } from "react";
import type {
  ChannelAuditEntry,
  ChannelConnection,
  ChannelDmPolicy,
  ChannelGroupMode,
  ChannelKind,
  ChannelPairing,
  ChannelToolProfile,
  State,
} from "./types";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";

const api = window.botkins;

const CHANNEL_GUIDES: Record<
  ChannelKind,
  {
    name: string;
    transportLabel: string;
    summary: string;
    steps: string[];
    secrets: Array<{ key: string; label: string; placeholder: string; required?: boolean }>;
  }
> = {
  slack: {
    name: "Slack",
    transportLabel: "Socket Mode (outbound WebSocket, no public URL)",
    summary: "Connects outbound via Slack Socket Mode using an App-level token and Bot token stored in your vault.",
    steps: [
      "Create an app at api.slack.com/apps (From scratch).",
      "Enable Socket Mode and generate an App-level token with the connections:write scope (xapp-...).",
      "Under OAuth & Permissions, add Bot Token Scopes: app_mentions:read, chat:write, im:history, im:read, im:write, channels:history, groups:history.",
      "Under Event Subscriptions, enable events and subscribe to app_mention, message.im, message.channels, and message.groups.",
      "Install the app to your workspace and copy the Bot User OAuth Token (xoxb-...).",
    ],
    secrets: [
      { key: "appToken", label: "App-level token", placeholder: "xapp-1-...", required: true },
      { key: "botToken", label: "Bot token", placeholder: "xoxb-...", required: true },
    ],
  },
  telegram: {
    name: "Telegram",
    transportLabel: "Long polling (getUpdates, no public URL)",
    summary: "Polls Telegram Bot API directly using a bot token from @BotFather.",
    steps: [
      "Message @BotFather on Telegram and run /newbot.",
      "Choose a display name and username ending in bot.",
      "If you plan to allow group channels later, check /setprivacy in @BotFather.",
      "Paste the bot token below — it is saved directly into your encrypted vault.",
    ],
    secrets: [{ key: "botToken", label: "Bot token", placeholder: "123456:ABC-...", required: true }],
  },
  discord: {
    name: "Discord",
    transportLabel: "Gateway WebSocket (outbound, Message Content intent)",
    summary: "Connects to Discord Gateway v10 over WebSocket with DM, guild message, and Message Content intents.",
    steps: [
      "Open the Discord Developer Portal and create a New Application.",
      "Go to the Bot tab, reset/copy the Bot Token, and turn ON the Message Content Intent under Privileged Gateway Intents.",
      "Under OAuth2 › URL Generator, select the bot scope with View Channels, Send Messages, Send Messages in Threads, and Read Message History.",
      "Invite the bot to your server and paste the Bot Token below.",
    ],
    secrets: [{ key: "botToken", label: "Bot token", placeholder: "Discord bot token", required: true }],
  },
  imessage: {
    name: "iMessage",
    transportLabel: "imsg CLI (local Mac or paired Mac node host)",
    summary: "Watches inbound Messages via `imsg watch` and replies with `imsg send`, locally on macOS or over an encrypted Mac node host link.",
    steps: [
      "On the Mac running Messages, install the imsg CLI (for example: brew install steipete/tap/imsg).",
      "Grant Full Disk Access to Botkins (or your terminal/node host) so imsg can read chat history.",
      "The first time Botkins replies, click Allow on macOS’s “Botkins wants access to control Messages” prompt.",
      "If this computer is Linux or cloud-hosted, pick a paired Mac node host below.",
    ],
    secrets: [],
  },
};

function statusLabel(state?: string): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "auth_error":
      return "Auth error";
    case "waiting_permission":
      return "Waiting for macOS permission";
    case "paused":
      return "Paused";
    case "disabled":
      return "Disabled";
    default:
      return "Disconnected";
  }
}

function statusClass(state?: string): string {
  if (state === "connected") return "set-badge set-badge-ok";
  if (state === "auth_error" || state === "waiting_permission") return "set-badge set-badge-warn";
  return "set-badge";
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ChannelsSettings({ state }: { state: State }) {
  const bots = state.bots.filter((b) => !b.hidden);
  const remoteHosts = (state.remote?.hosts ?? []).filter((h) => !h.member);
  const [connections, setConnections] = useState<ChannelConnection[]>(state.channels ?? []);
  const [pairings, setPairings] = useState<ChannelPairing[]>([]);
  const [audit, setAudit] = useState<ChannelAuditEntry[]>([]);
  const [auditConn, setAuditConn] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

  // Add-channel form state
  const [kind, setKind] = useState<ChannelKind>("slack");
  const [label, setLabel] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [nodeHostId, setNodeHostId] = useState("");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [showGuide, setShowGuide] = useState(true);

  // Per-connection draft editors (for group channel lists & daily caps)
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (Array.isArray(state.channels)) {
      setConnections(state.channels);
      const nextPairings: ChannelPairing[] = [];
      for (const conn of state.channels) {
        for (const p of conn.pendingPairings ?? []) {
          nextPairings.push({
            ...p,
            connectionId: conn.id,
            label: conn.label,
            kind: conn.kind,
            channel: conn.kind,
          });
        }
      }
      setPairings(nextPairings);
    }
  }, [state.channels]);

  useEffect(() => {
    if (!botId && bots[0]?.id) setBotId(bots[0].id);
  }, [botId, bots]);

  async function refresh() {
    try {
      const [list, pairList, logs] = await Promise.all([
        api.channelsList(),
        api.channelPairList(null),
        api.channelLogs(auditConn || null, { limit: 40 }),
      ]);
      setConnections(Array.isArray(list) ? list : []);
      setPairings(Array.isArray(pairList) ? pairList : []);
      setAudit(Array.isArray(logs) ? logs : []);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [auditConn]);

  const guide = CHANNEL_GUIDES[kind];

  async function handleAdd() {
    setError("");
    setNote("");
    for (const field of guide.secrets) {
      if (field.required && !(secretValues[field.key] ?? "").trim()) {
        setError(`Enter ${field.label} before adding the channel.`);
        return;
      }
    }
    setBusy(true);
    try {
      const secrets: Record<string, string> = {};
      for (const field of guide.secrets) {
        const val = (secretValues[field.key] ?? "").trim();
        if (val) secrets[field.key] = val;
      }
      await api.channelAdd({
        kind,
        label: label.trim() || `${guide.name} channel`,
        botId: botId || bots[0]?.id,
        nodeHostId: kind === "imessage" && nodeHostId ? nodeHostId : undefined,
        secrets: Object.keys(secrets).length ? secrets : undefined,
      });
      setLabel("");
      setSecretValues({});
      setNodeHostId("");
      setNote(`${guide.name} channel saved. Tokens are stored in your vault and never echoed.`);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(fn: () => Promise<unknown>, successNote?: string) {
    setError("");
    setNote("");
    setBusy(true);
    try {
      await fn();
      if (successNote) setNote(successNote);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest(conn: ChannelConnection) {
    setError("");
    setBusy(true);
    try {
      const res = await api.channelTest(conn.id);
      setTestResults((prev) => ({
        ...prev,
        [conn.id]: {
          ok: res.ok,
          detail: res.identity ? `${res.detail} (${res.identity})` : res.detail,
        },
      }));
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="set-stack">
      {error && <p className="set-error" role="alert">{error}</p>}
      {note && <p className="set-note" role="status">{note}</p>}

      <Group
        title="Publish a bot to a channel"
        footer="Secrets go straight into the encrypted vault. New channels start with DM pairing, groups off, and the restricted tool profile."
        actions={
          <button type="button" className="set-button primary" disabled={busy || !bots.length} onClick={() => void handleAdd()}>
            Add {guide.name} channel
          </button>
        }
      >
        <Row label="Channel type" help={guide.transportLabel}>
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className="set-select"
              value={kind}
              disabled={busy}
              onChange={(e) => {
                setKind(e.target.value as ChannelKind);
                setSecretValues({});
                setError("");
              }}
            >
              <option value="slack">Slack (Socket Mode)</option>
              <option value="telegram">Telegram (Long polling)</option>
              <option value="discord">Discord (Gateway)</option>
              <option value="imessage">iMessage (imsg CLI)</option>
            </select>
          )}
        </Row>

        <Row label="Setup guide" help={guide.summary} stacked={showGuide}>
          {(id) => (
            <div>
              <button id={id} type="button" className="set-button" onClick={() => setShowGuide((v) => !v)}>
                {showGuide ? "Hide steps" : "Show steps"}
              </button>
              {showGuide && (
                <ol className="set-list" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {guide.steps.map((step, idx) => (
                    <li key={idx} style={{ marginBottom: 4 }}>
                      {step}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </Row>

        <Row label="Label" help="Friendly name shown in Settings and Workflows">
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="text"
              className="set-input"
              value={label}
              disabled={busy}
              placeholder={`My ${guide.name} bot`}
              onChange={(e) => setLabel(e.target.value)}
            />
          )}
        </Row>

        <Row label="Bound bot" help="The bot that answers messages arriving on this channel">
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className="set-select"
              value={botId}
              disabled={busy}
              onChange={(e) => setBotId(e.target.value)}
            >
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </Row>

        {kind === "imessage" && (
          <Row label="Mac host" help="Run locally on this Mac, or forward through a paired Mac node host.">
            {(id, describedBy) => (
              <select
                id={id}
                aria-describedby={describedBy}
                className="set-select"
                value={nodeHostId}
                disabled={busy}
                onChange={(e) => setNodeHostId(e.target.value)}
              >
                <option value="">This computer (local Mac)</option>
                {remoteHosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({h.state})
                  </option>
                ))}
              </select>
            )}
          </Row>
        )}

        {guide.secrets.map((field) => (
          <Row
            key={field.key}
            label={field.label}
            help="Stored in vault only; never written to workspace.json or logs."
          >
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="off"
                className="set-input"
                value={secretValues[field.key] ?? ""}
                disabled={busy}
                placeholder={field.placeholder}
                onChange={(e) => setSecretValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            )}
          </Row>
        ))}
      </Group>

      <Group
        title={`Pairing approvals (${pairings.length})`}
        footer="Under DM pairing, strangers receive a one-time code and no bot turn until you approve them here, on your phone, or with `botkins channels pair approve <code>`."
      >
        {pairings.length === 0 ? (
          <ValueRow label="No pending pairing codes" value="Quiet" />
        ) : (
          pairings.map((p) => {
            const who = p.display || p.senderDisplay || p.senderId;
            const kindName = p.kind || p.channel || "channel";
            return (
              <Row
                key={`${p.connectionId}-${p.code}`}
                label={`${who} · ${kindName}`}
                help={`Code ${p.code} · Sender ${p.senderId} · Expires ${new Date(p.expiresAt).toLocaleTimeString()}`}
              >
                {() => (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="set-button primary"
                      disabled={busy}
                      onClick={() => void runAction(() => api.channelPairApprove(p.code, p.connectionId), `Approved ${who}.`)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="set-button"
                      disabled={busy}
                      onClick={() => void runAction(() => api.channelPairDeny(p.code, p.connectionId), `Denied ${who}.`)}
                    >
                      Deny
                    </button>
                  </div>
                )}
              </Row>
            );
          })
        )}
      </Group>

      {connections.length === 0 ? (
        <Group title="Connected channels">
          <ValueRow label="No channels configured yet" value="Add one above" />
        </Group>
      ) : (
        connections.map((conn) => {
          const test = testResults[conn.id];
          const groupText = groupDrafts[conn.id] ?? (conn.policy.groups?.channels ?? []).join(", ");
          const capText = capDrafts[conn.id] ?? String(conn.policy.limits?.dailyTurnCap ?? 100);
          return (
            <Group
              key={conn.id}
              title={`${conn.label} (${conn.kind})`}
              footer={
                conn.status?.detail
                  ? `Status: ${statusLabel(conn.status.state)} — ${conn.status.detail}`
                  : `Transport: ${conn.transport}${conn.nodeHostId ? ` · Node: ${conn.nodeHostId}` : ""}`
              }
              actions={
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span className={statusClass(conn.status?.state)}>{statusLabel(conn.status?.state)}</span>
                  <button type="button" className="set-button" disabled={busy} onClick={() => void handleTest(conn)}>
                    Test
                  </button>
                  {conn.paused ? (
                    <button
                      type="button"
                      className="set-button primary"
                      disabled={busy}
                      onClick={() => void runAction(() => api.channelResume(conn.id), `Resumed ${conn.label}.`)}
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="set-button"
                      disabled={busy}
                      onClick={() => void runAction(() => api.channelPause(conn.id), `Paused ${conn.label}.`)}
                    >
                      Pause
                    </button>
                  )}
                  <button
                    type="button"
                    className="set-button danger"
                    disabled={busy}
                    onClick={() => void runAction(() => api.channelRemove(conn.id), `Removed ${conn.label}.`)}
                  >
                    Remove
                  </button>
                </div>
              }
            >
              {test && (
                <ValueRow
                  label="Last connection test"
                  help={test.detail}
                  value={<span className={test.ok ? "set-badge set-badge-ok" : "set-badge set-badge-warn"}>{test.ok ? "OK" : "Failed"}</span>}
                />
              )}

              <Row label="Bound bot" help="Bot that receives inbound messages on this connection">
                {(id, describedBy) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    className="set-select"
                    value={conn.botId}
                    disabled={busy}
                    onChange={(e) => void runAction(() => api.channelBind(conn.id, e.target.value), "Updated bound bot.")}
                  >
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                )}
              </Row>

              <Row label="DM policy" help="Pairing requires owner approval before a stranger triggers a bot turn.">
                {(id, describedBy) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    className="set-select"
                    value={conn.policy.dm}
                    disabled={busy}
                    onChange={(e) =>
                      void runAction(
                        () => api.channelSetPolicy(conn.id, { dm: e.target.value as ChannelDmPolicy }),
                        "Updated DM policy.",
                      )
                    }
                  >
                    <option value="pairing">Pairing (default)</option>
                    <option value="allowlist">Allowlist only</option>
                    <option value="open">Open</option>
                    <option value="off">Off</option>
                  </select>
                )}
              </Row>

              <SwitchRow
                label="Allow group channels"
                help="Off by default. Only listed group/channel IDs are accepted when enabled."
                checked={Boolean(conn.policy.groups?.enabled)}
                disabled={busy}
                onChange={(checked) =>
                  void runAction(() =>
                    api.channelSetPolicy(conn.id, {
                      groups: { ...conn.policy.groups, enabled: checked },
                    }),
                  )
                }
              />

              {conn.policy.groups?.enabled && (
                <>
                  <Row label="Group trigger mode" help="Mention requires an @mention or reply to the bot.">
                    {(id, describedBy) => (
                      <select
                        id={id}
                        aria-describedby={describedBy}
                        className="set-select"
                        value={conn.policy.groups.mode}
                        disabled={busy}
                        onChange={(e) =>
                          void runAction(() =>
                            api.channelSetPolicy(conn.id, {
                              groups: { ...conn.policy.groups, mode: e.target.value as ChannelGroupMode },
                            }),
                          )
                        }
                      >
                        <option value="mention">Mention only (recommended)</option>
                        <option value="all">All messages in listed channels</option>
                      </select>
                    )}
                  </Row>

                  <Row label="Allowed group channel IDs" help="Comma-separated channel/chat IDs.">
                    {(id, describedBy) => (
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          id={id}
                          aria-describedby={describedBy}
                          type="text"
                          className="set-input"
                          value={groupText}
                          placeholder="C12345, C67890"
                          onChange={(e) => setGroupDrafts((prev) => ({ ...prev, [conn.id]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className="set-button"
                          disabled={busy}
                          onClick={() => {
                            const channels = groupText
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean);
                            void runAction(
                              () =>
                                api.channelSetPolicy(conn.id, {
                                  groups: { ...conn.policy.groups, channels },
                                }),
                              "Saved allowed group channels.",
                            );
                          }}
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </Row>
                </>
              )}

              <Row
                label="Tool profile"
                help={
                  conn.policy.toolProfile === "standard"
                    ? "Warning: Standard profile widens tools for external channel turns. Approval-gated tools still prompt only on desktop/phone."
                    : "Restricted (default): shell, file writes, node ops, browser, outbound mail/messages, purchases, vault, and routine/task/plugin edits are disabled."
                }
              >
                {(id, describedBy) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    className="set-select"
                    value={conn.policy.toolProfile}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value as ChannelToolProfile;
                      void runAction(
                        () => api.channelSetPolicy(conn.id, { toolProfile: next }),
                        next === "standard"
                          ? "Warning: widened tool profile to Standard for this channel."
                          : "Switched channel back to Restricted tool profile.",
                      );
                    }}
                  >
                    <option value="restricted">Restricted (read-only knowledge tools)</option>
                    <option value="standard">Standard (widened — use with care)</option>
                  </select>
                )}
              </Row>

              <Row label="Daily turn cap" help="Notifies you and pauses replies once reached for the day.">
                {(id, describedBy) => (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      id={id}
                      aria-describedby={describedBy}
                      type="number"
                      min={1}
                      max={10000}
                      className="set-input"
                      value={capText}
                      onChange={(e) => setCapDrafts((prev) => ({ ...prev, [conn.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="set-button"
                      disabled={busy}
                      onClick={() => {
                        const dailyTurnCap = Math.max(1, Number(capText) || 100);
                        void runAction(
                          () =>
                            api.channelSetPolicy(conn.id, {
                              limits: { ...conn.policy.limits, dailyTurnCap },
                            }),
                          `Daily turn cap set to ${dailyTurnCap}.`,
                        );
                      }}
                    >
                      Save
                    </button>
                  </div>
                )}
              </Row>

              <ValueRow
                label={`Allowlisted senders (${conn.policy.allowlist.length})`}
                value={conn.policy.allowlist.length ? conn.policy.allowlist.join(", ") : "None"}
              />
            </Group>
          );
        })
      )}

      <Group
        title="Audit log (metadata only)"
        footer="Records connection, sender ID, conversation, and decision without storing message bodies."
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            <select className="set-select" value={auditConn} onChange={(e) => setAuditConn(e.target.value)}>
              <option value="">All connections</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <button type="button" className="set-button" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        }
      >
        {audit.length === 0 ? (
          <ValueRow label="No audit events yet" value="—" />
        ) : (
          audit.slice(0, 25).map((entry, idx) => (
            <ValueRow
              key={`${entry.at}-${idx}`}
              label={`${entry.decision}${entry.reason ? ` (${entry.reason})` : ""} · ${entry.channel}`}
              help={`${entry.senderId} · ${entry.conversationId} · ${formatTime(entry.at)}`}
              value={entry.connectionId.slice(0, 12)}
            />
          ))
        )}
      </Group>
    </div>
  );
}
