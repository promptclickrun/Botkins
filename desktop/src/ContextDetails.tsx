import { findModel, friendlyModel, useModelCatalog } from "./providers";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { Chat, Run } from "./types";

const n = (v?: number) => (v ?? 0).toLocaleString();
const ago = (t?: number) => {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

/** The context window's makeup and this chat's token use, opened from the header meter. */
export default function ContextDetails({
  chat,
  runs,
  busy,
  close,
  compact,
}: {
  chat: Chat;
  runs: Run[];
  busy: boolean;
  close: () => void;
  compact: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(".context-open")) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [close]);
  const c = chat.context!;
  const percent = Math.min(100, Math.round((c.current / c.limit) * 100));
  const parts = [
    { label: "Instructions and system", value: c.system, tone: "system" },
    { label: "Tool definitions", value: c.tools, tone: "tools" },
    { label: "Conversation", value: c.conversation, tone: "conversation" },
  ].filter((p) => p.value !== undefined);
  const known = parts.reduce((s, p) => s + (p.value ?? 0), 0);
  const used = runs.filter((r) => r.usage);
  const last = [...used].sort((a, b) => b.time - a.time)[0];
  // What the model's own provider states about it, for the model the chat last ran on.
  const catalog = useModelCatalog();
  const ran = [...runs].sort((a, b) => b.time - a.time).find((r) => r.model)?.model;
  const model = findModel(catalog.models, ran);
  const facts = model
    ? [
        { label: "Context window", value: model.contextWindow && n(model.contextWindow) + " tokens" },
        { label: "Most in one request", value: model.maxPrompt && model.maxPrompt !== model.contextWindow ? n(model.maxPrompt) + " tokens" : undefined },
        { label: "Longest reply", value: model.maxOutput && n(model.maxOutput) + " tokens" },
        { label: "Pictures", value: model.vision === undefined ? undefined : model.vision ? "Yes" : "No" },
        { label: "Knowledge to", value: model.knowledge },
      ].filter((fact) => fact.value)
    : [];
  const total = used.reduce(
    (t, r) => ({
      input: t.input + (r.usage!.input || 0),
      output: t.output + (r.usage!.output || 0),
      cacheRead: t.cacheRead + (r.usage!.cacheRead || 0),
      cost: t.cost + (r.usage!.cost || 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cost: 0 },
  );
  return (
    <div className="context-details" role="dialog" aria-label="Context window details" tabIndex={-1} ref={box}>
      <div className="cd-head">
        <strong>Context window</strong>
        <button aria-label="Close context details" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <div className="cd-total">
        <b>{percent}%</b>
        <span>
          {n(c.current)} of {n(c.limit)} tokens
          {c.updatedAt ? <small> · updated {ago(c.updatedAt)}</small> : null}
        </span>
      </div>
      <div className="cd-bar" aria-hidden="true">
        {parts.length ? (
          parts.map((p) => <i key={p.tone} className={"cd-" + p.tone} style={{ width: ((p.value ?? 0) / c.limit) * 100 + "%" }} />)
        ) : (
          <i className="cd-conversation" style={{ width: percent + "%" }} />
        )}
        {parts.length > 0 && c.current > known && <i className="cd-other" style={{ width: ((c.current - known) / c.limit) * 100 + "%" }} />}
      </div>
      {parts.length > 0 && (
        <dl className="cd-parts">
          {parts.map((p) => (
            <div key={p.tone}>
              <dt>
                <i className={"cd-" + p.tone} />
                {p.label}
              </dt>
              <dd>{n(p.value)}</dd>
            </div>
          ))}
          {c.current > known && (
            <div>
              <dt>
                <i className="cd-other" />
                Other
              </dt>
              <dd>{n(c.current - known)}</dd>
            </div>
          )}
          <div>
            <dt>Free</dt>
            <dd>{n(Math.max(0, c.limit - c.current))}</dd>
          </div>
          {c.messages !== undefined && (
            <div>
              <dt>Messages in context</dt>
              <dd>{n(c.messages)}</dd>
            </div>
          )}
        </dl>
      )}
      {model && facts.length > 0 && (
        <dl className="cd-parts">
          <div className="cd-section">
            {model.name}
            {model.providerName ? " · as " + model.providerName + " states it" : ""}
          </div>
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {last && (
        <dl className="cd-parts">
          <div className="cd-section">Latest reply{last.usage?.model ? " · " + friendlyModel(last.usage.model) : ""}</div>
          <div>
            <dt>Input</dt>
            <dd>{n(last.usage!.input)}</dd>
          </div>
          <div>
            <dt>Cached input</dt>
            <dd>{n(last.usage!.cacheRead)}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{n(last.usage!.output)}</dd>
          </div>
          <div className="cd-section">This chat · {used.length} {used.length === 1 ? "reply" : "replies"}</div>
          <div>
            <dt>Input</dt>
            <dd>{n(total.input)}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{n(total.output)}</dd>
          </div>
          {total.cost > 0 && (
            <div>
              <dt>Premium requests</dt>
              <dd>{total.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="cd-actions">
        <small>Compact summarizes earlier turns to free space. The chat itself stays.</small>
        <button className="secondary" disabled={busy} onClick={compact}>
          Compact
        </button>
      </div>
    </div>
  );
}
