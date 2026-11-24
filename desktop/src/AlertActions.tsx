// What a person can do with a proactive alert ("proactive-team-v1"), under the alert in a chat and on its Feed
// card. The phone has the same (mobile/src/features/bots/AlertActions.tsx), in the same words
// (desktop/link/proactive-words.mjs). "Take care of it" starts a normal turn in the person's chat with what the
// bot offered: its tools ask for approval as usual. "Not now" holds what it was about back for a day. The ratings
// stay where they were. Only the person the alert was for is sent it.
import { useState } from "react";
import { ALERT } from "../desktop/link/proactive-words.mjs";
import { errorText } from "./SettingsRows";
import type { ProactiveAlert, State } from "./types";
import "./records.css";

/** Whether the computer this window uses has several people for a bot, the setup steps and an alert's actions. */
export const hasProactiveTeam = (state: State) => !state.remote?.using || !!state.remote.using.capabilities?.includes("proactive-team-v1");

export default function AlertActions({ botId, alert, open }: { botId: string; alert?: ProactiveAlert; /** Shows the chat the bot starts its work in. */ open?: (chatId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!alert?.runId) return null;
  if (alert.chosen) return <p className="muted alert-chosen">{alert.chosen === "take" ? ALERT.taken : ALERT.held}</p>;
  const act = async (action: "take" | "later") => {
    setBusy(true);
    setError("");
    try {
      const answer = await window.botkins.proactiveAct(botId, alert.runId, action);
      if (action === "take" && answer?.chatId) open?.(answer.chatId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="alert-actions" role="group" aria-label="This alert">
      {alert.offer && <strong>{alert.offer}</strong>}
      {alert.offer && (
        <button type="button" className="primary" disabled={busy} onClick={() => void act("take")}>
          {ALERT.take}
        </button>
      )}
      <button type="button" className="secondary" disabled={busy} onClick={() => void act("later")}>
        {ALERT.later}
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
