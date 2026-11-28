import { useState } from "react";
import { AlertCircle, ArrowUpRight, CheckCircle2, ExternalLink, Send, X } from "lucide-react";
import { RichText } from "./RichText";
import { Block } from "./Today";
import { errorText } from "./SettingsRows";
import type { WorkflowActionCard as ActionCardData } from "./types";
import "./workflowActionCard.css";

export default function WorkflowActionCard({
  chatId,
  card,
  readOnly = false,
  openChat,
}: {
  chatId: string;
  card: ActionCardData;
  readOnly?: boolean;
  openChat?: (chatId: string) => void;
}) {
  const [busy, setBusy] = useState<"dispatch" | "dismiss" | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  const act = async (action: "dispatch" | "dismiss") => {
    setBusy(action);
    setError("");
    try {
      await window.botkins["chat.cardAction"](chatId, card.id, action);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const dispatchLabel =
    card.dispatch?.label?.trim() ||
    (card.dispatch?.botName ? `Dispatch to ${card.dispatch.botName}` : "Dispatch");

  const badge = (
    <span className={"wf-action-badge " + (card.needsYou ? "warning" : "calm")}>
      {card.needsYou ? <AlertCircle size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
      {card.needsYou ? "Needs your direction" : "No input needed"}
    </span>
  );

  if (card.state === "dismissed") {
    return (
      <section className="wf-action-card dismissed" aria-label={card.title}>
        <div className="wf-action-card-dismissed-row">
          <div className="wf-action-card-dismissed-main">
            <span className="wf-action-badge muted">Dismissed</span>
            <h3 className="wf-action-card-title">{card.title}</h3>
          </div>
          <button
            type="button"
            className="wf-action-card-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide" : "Show"}
          </button>
        </div>
        {expanded && (
          <>
            <div className="wf-action-card-head">{badge}</div>
            {card.subtitle && (
              <div className="wf-action-card-subtitle">
                <RichText text={card.subtitle} />
              </div>
            )}
            {card.blocks.length > 0 && (
              <div className="wf-action-card-blocks">
                {card.blocks.map((block, i) => (
                  <Block key={block.type === "html" ? block.frame : i} block={block} title={card.title} />
                ))}
              </div>
            )}
            {card.link && (
              <button
                type="button"
                className="wf-action-card-link"
                onClick={() => void window.botkins.openLink(card.link!.url)}
              >
                <ExternalLink size={13} aria-hidden="true" />
                {card.link.label}
              </button>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <section
      className={"wf-action-card" + (card.needsYou ? " needs-you" : "")}
      aria-label={card.title}
    >
      <div className="wf-action-card-head">{badge}</div>
      <h3 className="wf-action-card-title">{card.title}</h3>
      {card.subtitle && (
        <div className="wf-action-card-subtitle">
          <RichText text={card.subtitle} />
        </div>
      )}
      {card.blocks.length > 0 && (
        <div className="wf-action-card-blocks">
          {card.blocks.map((block, i) => (
            <Block key={block.type === "html" ? block.frame : i} block={block} title={card.title} />
          ))}
        </div>
      )}
      {card.link && (
        <button
          type="button"
          className="wf-action-card-link"
          onClick={() => void window.botkins.openLink(card.link!.url)}
        >
          <ExternalLink size={13} aria-hidden="true" />
          {card.link.label}
        </button>
      )}
      <div className="wf-action-card-footer">
        {card.state === "dispatched" ? (
          <>
            <span className="wf-action-card-status dispatched">
              <CheckCircle2 size={14} aria-hidden="true" />
              Dispatched to {card.dispatchedBotName || "bot"}
            </span>
            {card.dispatchedChatId && openChat && (
              <button
                type="button"
                className="secondary"
                onClick={() => openChat(card.dispatchedChatId!)}
              >
                Open chat <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <div className="wf-action-card-buttons" role="group" aria-label="Card actions">
            {card.dispatch?.prompt && (
              <button
                type="button"
                className="primary"
                disabled={readOnly || busy !== null}
                onClick={() => void act("dispatch")}
              >
                <Send size={14} aria-hidden="true" />
                {busy === "dispatch" ? "Dispatching…" : dispatchLabel}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={readOnly || busy !== null}
              onClick={() => void act("dismiss")}
            >
              <X size={14} aria-hidden="true" />
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="wf-action-card-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
