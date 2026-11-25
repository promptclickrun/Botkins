import { useEffect, useState, type ReactNode } from "react";
import { BarChart3, Download } from "lucide-react";
import type { UsageReport, UsageTotals } from "./types";
import ProviderIcon from "./ProviderIcon";
import { useModelCatalog, friendlyModel } from "./providers";
import ProviderLimits from "./ProviderLimits";
import "./routines.css";

const api = window.botkins;
const RANGES = [7, 30, 90];
const tokens = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(n);
const money = (n: number) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
/** A cache hit rate as a whole percent, under 1% shown as "<1%". */
const percent = (rate: number) => (rate > 0 && rate < 0.01 ? "<1%" : Math.round(rate * 100) + "%");
const hasRate = (t: UsageTotals): t is UsageTotals & { cacheHitRate: number } => typeof t.cacheHitRate === "number";
const dayLabel = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(date + "T12:00").toLocaleDateString(undefined, opts);

function Breakdown<Row extends UsageTotals & { key: string }>({ title, rows, label }: { title: string; rows: Row[]; label: (r: Row) => ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.input + r.output));
  return (
    <section className="usage-breakdown" aria-label={title}>
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((r) => (
          <div className="usage-line" key={r.key}>
            <span className="usage-name">
              <strong>{label(r)}</strong>
              <small>
                {r.turns} {r.turns === 1 ? "turn" : "turns"} · {tokens(r.input)} in · {tokens(r.output)} out
                {hasRate(r) ? " · " + percent(r.cacheHitRate) + " cached" : ""}
                {r.priced ? " · " + money(r.cost) : ""}
              </small>
            </span>
            <i aria-hidden="true">
              <i style={{ width: ((r.input + r.output) / max) * 100 + "%" }} />
            </i>
          </div>
        ))
      ) : (
        <small>No turns in this range.</small>
      )}
    </section>
  );
}

/**
 * A model in the usage report, with its provider's mark. A turn records its provider; for older
 * turns the mark shows only when the catalog has that model id from one provider alone.
 */
function UsageModel({ id, provider }: { id: string; provider?: string }) {
  const { models } = useModelCatalog();
  const same = models.filter((m) => m.id === id && (!provider || m.provider === provider));
  const one = same.length > 0 && same.every((m) => m.provider === same[0].provider) ? same[0] : undefined;
  const mark = provider ?? one?.provider;
  const name = id === "auto" ? "Auto" : (same[0]?.name ?? friendlyModel(id));
  return (
    <span className="model-badge">
      {mark && <ProviderIcon provider={mark} name={one?.providerName ?? models.find((m) => m.provider === mark)?.providerName} size={13} />}
      <span className="model-badge-name">{name}</span>
    </span>
  );
}

/** Each provider's plan and limits, then turns, tokens and cost over 7, 30 or 90 days, by day, model and bot. */
export default function Usage({ runCount }: { runCount: number }) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    api
      .usage(days)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [days, runCount]);
  const t = report?.totals;
  const peak = Math.max(1, ...(report?.byDay ?? []).map((d) => d.input + d.output));
  const hasTokens = !!t && t.input + t.output > 0;
  return (
    <div className="usage">
      <ProviderLimits />
      <div className="usage-top">
        <div className="filters" role="group" aria-label="Range">
          {RANGES.map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
        <button
          className="secondary"
          disabled={!t?.turns}
          onClick={() =>
            api
              .exportUsage(days)
              .then((saved) => setNote(saved ? "Exported." : ""))
              .catch((e) => setError(String(e)))
          }
        >
          <Download size={14} />
          Export CSV
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {note && <small role="status">{note}</small>}
      {t && (
        <>
          <div className="usage-totals">
            <div className="metric">
              <small>Turns</small>
              <strong>{t.turns.toLocaleString()}</strong>
            </div>
            <div className="metric">
              <small>Input tokens</small>
              <strong>{tokens(t.input)}</strong>
              {(t.cacheRead > 0 || (t.cacheWrite ?? 0) > 0) && (
                <small>
                  {[t.cacheRead > 0 && "+ " + tokens(t.cacheRead) + " from cache", (t.cacheWrite ?? 0) > 0 && tokens(t.cacheWrite!) + " to cache"].filter(Boolean).join(" · ")}
                </small>
              )}
            </div>
            <div className="metric" title="Input read from the prompt cache, as a share of all input: uncached, read from cache and written to it. Turns recorded before this was counted are left out.">
              <small>Cache hit rate</small>
              <strong>{hasRate(t) ? percent(t.cacheHitRate) : "—"}</strong>
              {hasRate(t) && <small>Of all input</small>}
            </div>
            <div className="metric">
              <small>Output tokens</small>
              <strong>{tokens(t.output)}</strong>
            </div>
            <div className="metric">
              <small>Cost</small>
              <strong>{t.priced ? money(t.cost) : "—"}</strong>
              {t.priced > 0 && t.priced < t.turns && <small>From {t.priced} priced turns</small>}
            </div>
          </div>
          <section className="usage-chart" aria-label="Tokens by day">
            <h3>Tokens by day</h3>
            {hasTokens ? (
              <div className={"usage-bars d" + days} role="img" aria-label={"Tokens per day over the last " + days + " days"}>
                {report!.byDay.map((d) => (
                  <span
                    key={d.date}
                    title={dayLabel(d.date, { month: "short", day: "numeric" }) + ": " + d.turns + " turns, " + tokens(d.input) + " in, " + tokens(d.output) + " out"}
                  >
                    <i style={{ height: ((d.input + d.output) / peak) * 100 + "%" }}>
                      <i style={{ height: d.input + d.output ? (d.output / (d.input + d.output)) * 100 + "%" : 0 }} />
                    </i>
                  </span>
                ))}
              </div>
            ) : (
              <div className="empty">
                <BarChart3 />
                <small>{t.turns ? "These turns didn't report token use." : "No turns in this range."}</small>
              </div>
            )}
            {hasTokens && (
              <div className="usage-axis">
                <small>{dayLabel(report!.byDay[0].date, { month: "short", day: "numeric" })}</small>
                <small className="usage-legend">
                  <i className="in" /> Input <i className="out" /> Output
                </small>
                <small>Today</small>
              </div>
            )}
          </section>
          <div className="usage-columns">
            <Breakdown
              title="By model"
              rows={report!.byModel.map((m) => ({ ...m, key: (m.provider ?? "") + "\n" + m.model }))}
              label={(r) => <UsageModel id={r.model} provider={r.provider} />}
            />
            <Breakdown
              title="By bot"
              rows={report!.byBot.map((b) => ({ ...b, key: b.botId }))}
              label={(r) => report!.byBot.find((b) => b.botId === r.key)?.name ?? ""}
            />
          </div>
        </>
      )}
    </div>
  );
}
