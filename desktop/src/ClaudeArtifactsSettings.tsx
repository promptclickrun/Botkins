// Settings › General › Claude artifacts: availability (Claude Code + claude.ai subscription),
// model used for headless artifact sub-runs, and per-bot standing grants.
import { useEffect, useState } from "react";
import { Button } from "glisse";
import { Choices } from "./Preferences";
import { Group, ValueRow, errorText } from "./SettingsRows";
import type { Bot, ClaudeArtifactsStatus } from "./types";

const MODEL_OPTIONS: { id: "haiku" | "sonnet" | "opus"; name: string }[] = [
  { id: "haiku", name: "Haiku" },
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
];

export function ClaudeArtifactsSettings({
  bots,
  providerRevision,
  fail,
}: {
  bots: Bot[];
  providerRevision?: number;
  fail: (e: unknown) => void;
}) {
  const [status, setStatus] = useState<ClaudeArtifactsStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (refresh = false) => {
    const fn = window.botkins["claudeArtifacts.status"];
    if (!fn) return;
    setBusy(true);
    void fn(refresh)
      .then((next) => setStatus(next))
      .catch((e) => fail(errorText(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load(false);
  }, [providerRevision]);

  const setModel = (model: "haiku" | "sonnet" | "opus") => {
    const fn = window.botkins["claudeArtifacts.setModel"];
    if (!fn) return;
    setBusy(true);
    void fn(model)
      .then((next) => setStatus(next))
      .catch((e) => fail(errorText(e)))
      .finally(() => setBusy(false));
  };

  const setGrant = (botId: string, allowed: boolean) => {
    const fn = window.botkins["claudeArtifacts.setBotApproval"];
    if (!fn) return;
    setBusy(true);
    void fn(botId, allowed)
      .then((next) => setStatus(next))
      .catch((e) => fail(errorText(e)))
      .finally(() => setBusy(false));
  };

  const availabilityText = !status
    ? "Checking…"
    : status.available
      ? ["Available", status.plan, status.account].filter(Boolean).join(" · ")
      : status.installed
        ? status.signedIn
          ? "Needs claude.ai subscription"
          : "Not signed in"
        : "Claude Code not found";

  const availabilityHelp = !status
    ? "Checking Claude Code and your claude.ai sign-in."
    : status.available
      ? `Claude Code${status.version ? " " + status.version : ""} signed in with a subscription. Offered to every bot regardless of harness.`
      : status.reason || "Install Claude Code and sign in with a claude.ai subscription to enable.";

  const grantedIds = new Set((status?.grants ?? []).map((g) => g.botId));
  const visibleBots = bots.filter((b) => !b.hidden);

  return (
    <Group
      title="Claude artifacts"
      footer="Publishes private HTML pages to your claude.ai account via headless Claude Code. Sharing happens in the claude.ai header. Routines need a standing grant."
      actions={
        <Button variant="glass" className="lg-compact" disabled={busy} onClick={() => load(true)}>
          {busy ? "Checking…" : "Refresh status"}
        </Button>
      }
    >
      <ValueRow label="Availability" value={availabilityText} help={availabilityHelp} />
      <div className="set-row">
        <div className="set-label">
          <span className="set-name">Artifact model</span>
          <small>Model used for headless Artifact tool calls. Haiku is fastest and uses the least of your Claude plan.</small>
        </div>
        <div className="set-control">
          <Choices
            label="Claude artifact model"
            value={status?.model ?? "haiku"}
            options={MODEL_OPTIONS}
            onChange={(id) => setModel(id)}
          />
        </div>
      </div>
      <div className="set-row stacked">
        <div className="set-label">
          <span className="set-name">Standing bot grants</span>
          <small>
            {status?.grants?.length
              ? `${status.grants.length} ${status.grants.length === 1 ? "bot" : "bots"} can publish without asking first (including from routines).`
              : "No standing grants yet. Bots ask on their first publish per chat."}
          </small>
        </div>
        {visibleBots.length > 0 && (
          <div className="set-grant-list">
            {visibleBots.map((bot) => {
              const granted = grantedIds.has(bot.id);
              return (
                <div className="set-grant-item" key={bot.id}>
                  <span className="set-grant-name">
                    <strong>{bot.name}</strong>
                    <small>{granted ? "Always allowed" : "Ask on first publish per chat"}</small>
                  </span>
                  <Button
                    variant="glass"
                    className="lg-compact"
                    disabled={busy}
                    onClick={() => setGrant(bot.id, !granted)}
                  >
                    {granted ? "Revoke" : "Always allow"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Group>
  );
}
