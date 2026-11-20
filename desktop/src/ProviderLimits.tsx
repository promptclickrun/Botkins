// Each connected provider's plan and what is left of its limits (docs/PROVIDER_USAGE.md): the
// cards on the Usage page, and the one line under a provider's name in the model picker. Every
// number is the provider's own. A limit without a percent has no bar.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import ProviderIcon from "./ProviderIcon";
import { useProviderUsage } from "./providers";
import type { ProviderLimit, ProviderUsage } from "./types";
import "./limits.css";

const MINUTE = 60_000;
/** Numbers this old are said to be old in the picker, where there is no "Updated" line. */
const OLD = 10 * MINUTE;

export const percentText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)) + "%";

/** How long ago something was read: "just now", "5 min ago", "3 hr ago", "2 days ago". */
export function ago(then: number, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - then) / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " hr ago";
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

/**
 * When a limit starts again. Short, for one line: "2:10 PM" today, "Mon" within a week, else
 * "Dec 1". Long: "today at 2:10 PM", "Mon, Nov 25 at 3:00 AM", "Dec 1".
 */
export function resetText(at: number, now = Date.now(), short = false) {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (when.toDateString() === new Date(now).toDateString()) return short ? time : "today at " + time;
  const date = when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (at - now < 7 * 24 * 60 * MINUTE) {
    const day = when.toLocaleDateString(undefined, { weekday: "short" });
    return short ? day : day + ", " + date + " at " + time;
  }
  return date;
}

const noun = (limit: ProviderLimit) => (limit.window === "week" && !limit.model ? "weekly" : limit.label.charAt(0).toLowerCase() + limit.label.slice(1));

/**
 * The one line under a provider in the model picker: "62% of weekly left · resets Mon". Old
 * numbers, and numbers kept from before a failed read, say their age instead of the reset.
 * Nothing when the provider gave no limit to show.
 */
export function pickerLine(usage: ProviderUsage | undefined, now = Date.now()) {
  if (!usage) return undefined;
  const limit = usage.limits.find((l) => l.primary) ?? usage.limits.find((l) => l.percentRemaining !== undefined && !l.model);
  if (!limit || limit.percentRemaining === undefined) return usage.account === "api-key" ? { text: "API key · billed by use", low: false } : undefined;
  const old = usage.updatedAt !== undefined && (!!usage.error || now - usage.updatedAt > OLD);
  const tail = old ? "updated " + ago(usage.updatedAt!, now) : limit.resetAt ? "resets " + resetText(limit.resetAt, now, true) : "";
  return { text: percentText(limit.percentRemaining) + " of " + noun(limit) + " left" + (tail ? " · " + tail : ""), low: limit.percentRemaining <= 10 };
}

/** The time, told again every half minute, so "Updated 5 min ago" stays true while a screen is open. */
export function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

function Limit({ limit, now }: { limit: ProviderLimit; now: number }) {
  const left = limit.percentRemaining;
  const counts = limit.used !== undefined && limit.limit !== undefined ? limit.used.toLocaleString() + " of " + limit.limit.toLocaleString() + (limit.unit ? " " + limit.unit : "") + " used" : "";
  const reset = limit.resetAt ? "Resets " + resetText(limit.resetAt, now) : "";
  return (
    <div className="limit-row">
      <div className="limit-head">
        <span>{limit.label}</span>
        <strong>{limit.unlimited ? "Unlimited" : left !== undefined ? percentText(left) + " left" : "Not available"}</strong>
      </div>
      {left !== undefined && (
        <div
          className="limit-bar"
          role="meter"
          aria-label={limit.label + ", remaining"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={left}
          aria-valuetext={percentText(left) + " left"}
          data-level={left <= 10 ? "low" : left <= 25 ? "some" : "plenty"}
        >
          <i style={{ width: left + "%" }} />
        </div>
      )}
      {(counts || reset) && <small>{[counts, reset].filter(Boolean).join(" · ")}</small>}
    </div>
  );
}

function Card({ usage, now }: { usage: ProviderUsage; now: number }) {
  const key = usage.account === "api-key";
  // A plan's name says its provider ("Claude Max 20x"), so it is the card's title by itself.
  const named = !!usage.plan && usage.plan.toLowerCase().includes(usage.name.toLowerCase());
  const aside = named ? "" : (usage.plan ?? (key ? "API key" : ""));
  return (
    <article className="limit-card" aria-label={usage.name}>
      <div className="limit-title">
        <ProviderIcon provider={usage.provider} name={usage.name} size={16} />
        <strong>{named ? usage.plan : usage.name}</strong>
        {aside && <span className="limit-plan">{aside}</span>}
      </div>
      {usage.error && (
        <small className="limit-error" role="alert">
          {usage.error}
        </small>
      )}
      {key && <small>Billed by use. An API key has no plan limits.</small>}
      {usage.limits.map((limit) => (
        <Limit key={limit.id} limit={limit} now={now} />
      ))}
      {!usage.limits.length && !key && !usage.error && <small>{usage.note ?? "Limits: not available."}</small>}
      {usage.credits && (
        <div className="limit-head limit-credits">
          <span>{usage.credits.label}</span>
          <strong>{usage.credits.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
        </div>
      )}
      {usage.updatedAt !== undefined && (
        <small className="limit-foot">
          Updated {ago(usage.updatedAt, now)}
          {usage.source ? " · from " + usage.source : ""}
        </small>
      )}
    </article>
  );
}

/** The Usage page's section: one card for each connected provider. */
export default function ProviderLimits() {
  const { usage, loading, refreshing, error, refresh } = useProviderUsage();
  const now = useNow();
  return (
    <section className="limits" aria-label="Plans and limits">
      <div className="limits-top">
        <h3>Plans and limits</h3>
        <button className="secondary" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
          {refreshing && usage ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {loading && <small role="status">Reading your plans from each provider…</small>}
      {error && <p role="alert">{error}</p>}
      {usage && !usage.length && <small>No model provider is connected.</small>}
      {usage && usage.length > 0 && (
        <div className="limits-grid">
          {usage.map((entry) => (
            <Card key={entry.provider} usage={entry} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
