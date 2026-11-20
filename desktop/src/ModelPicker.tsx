import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BrainCircuit, Check, Search } from "lucide-react";
import type { ModelChoice, ModelInfo, ProviderStatus } from "./types";
import ProviderIcon from "./ProviderIcon";
import { effortLabel, findModel, modelFacts, modelName, plainError, PROVIDER_NAMES, useModelCatalog, useProviders, useProviderUsage } from "./providers";
import { pickerLine, useNow } from "./ProviderLimits";
import "./models.css";

/** A model choice as plain text: "Claude Opus 5.5 · High". Pass the catalog for friendly names. */
export function modelLabel(choice: ModelChoice, models?: ModelInfo[], defaultProvider?: string) {
  return [modelName(choice, models, defaultProvider), choice.reasoningEffort && effortLabel(choice.reasoningEffort)]
    .filter(Boolean)
    .join(" · ");
}

/** The provider used for choices saved without one. */
export function useDefaultProvider() {
  return useProviders().providers?.find((p) => p.default)?.id;
}

/**
 * A model with its provider's mark and friendly name, and its thinking level. Falls back to the raw
 * id while the catalog loads. Uses the shared catalog unless `models` is given.
 */
export function ModelBadge({
  choice,
  models,
  effort = true,
  size = 14,
  className,
}: {
  choice: ModelChoice;
  models?: ModelInfo[];
  /** Show the thinking level after the name. */
  effort?: boolean;
  size?: number;
  className?: string;
}) {
  const catalog = useModelCatalog();
  const fallback = useDefaultProvider();
  const list = models ?? catalog.models;
  const info = findModel(list, choice, fallback);
  const provider = info?.provider ?? choice.provider ?? fallback;
  const providerName = info?.providerName ?? (provider ? PROVIDER_NAMES[provider] : undefined);
  return (
    <span className={"model-badge" + (className ? " " + className : "")}>
      {provider && <ProviderIcon provider={provider} name={providerName} size={size} />}
      <span className="model-badge-name">{modelName(choice, list, fallback)}</span>
      {effort && choice.reasoningEffort && <span className="model-badge-effort">{effortLabel(choice.reasoningEffort)}</span>}
    </span>
  );
}

const keyFor = (m: ModelInfo) => JSON.stringify([m.id, m.provider ?? ""]);
const INHERIT = "";
const SAVED = "saved";
/** "A", "A and B", "A, B and C". */
export const names = (list: string[]) =>
  list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1];

type Group = { provider: string; name: string; group?: string; models: { m: ModelInfo; index: number }[] };

/** Models under their provider, in the catalog's order; a provider with services (OpenCode) is split by service. */
function groupModels(models: ModelInfo[], query: string): Group[] {
  const q = query.trim().toLowerCase();
  const groups: Group[] = [];
  models.forEach((m, index) => {
    if (q && ![m.name, m.id, m.providerName, m.group].some((s) => s?.toLowerCase().includes(q))) return;
    const provider = m.provider ?? "";
    let g = groups.find((g) => g.provider === provider && g.group === m.group);
    if (!g) {
      g = { provider, name: m.providerName ?? PROVIDER_NAMES[provider] ?? provider, group: m.group, models: [] };
      // A provider's services stay together, after the provider's first one.
      const last = groups.map((x) => x.provider).lastIndexOf(provider);
      groups.splice(last < 0 ? groups.length : last + 1, 0, g);
    }
    g.models.push({ m, index });
  });
  return groups;
}

/** Keeps `el` in view inside the scrolling list, below the sticky provider heading. */
function reveal(list: HTMLElement | null, el: HTMLElement | null) {
  if (!list || !el) return;
  const head = 30;
  if (el.offsetTop - head < list.scrollTop) list.scrollTop = Math.max(0, el.offsetTop - head);
  else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
}

/**
 * The model and thinking picker for the global default, a bot or a chat. Models are grouped under
 * their provider; the thinking levels are the chosen model's own. Saves with setModel.
 */
export default function ModelPicker({
  scope,
  id,
  value,
  inherited,
  done,
  openProviders,
}: {
  scope: "global" | "bot" | "chat";
  id: string | null;
  value?: ModelChoice;
  inherited?: ModelChoice;
  done?: () => void;
  /** Opens Settings › Model providers. Without it the picker names the providers but offers no link. */
  openProviders?: () => void;
}) {
  const catalog = useModelCatalog();
  const { providers } = useProviders();
  // What is left of each provider's plan, for the line under its name.
  const { usage } = useProviderUsage();
  const now = useNow();
  const models = catalog.models;
  const fallback = providers?.find((p) => p.default)?.id;
  const [draft, setDraft] = useState<ModelChoice | undefined>(value);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [query, setQuery] = useState("");
  const uid = useId();
  const list = useRef<HTMLDivElement>(null);
  // A choice changed elsewhere (the main process moves the default when its provider leaves) shows here
  // unless the person is in the middle of their own change.
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [valueKey]);

  const info = findModel(models, draft, fallback);
  const inheritedInfo = findModel(models, inherited, fallback);
  const effective = draft ?? inherited;
  const effectiveInfo = draft ? info : inheritedInfo;
  const level = effective?.reasoningEffort ?? "";
  const providerOf = (choice?: ModelChoice) => providers?.find((p) => p.id === (choice?.provider ?? fallback));
  // A saved choice whose provider is still starting isn't unavailable yet; its models are on the way.
  const pending = !!draft && !info && !!providerOf(draft)?.starting;
  const unavailable =
    !!draft && models.length > 0 && !pending && (!info?.available || (!!level && !info.efforts.includes(level)));
  const ready = !catalog.loading && !saving;
  const selected = !draft ? INHERIT : info ? keyFor(info) : SAVED;

  const groups = useMemo(() => groupModels(models, query), [models, query]);
  const searchable = models.length > 8;
  // The choices in the order arrow keys move through them.
  const order = [
    ...(scope !== "global" ? [INHERIT] : []),
    ...(draft && !info ? [SAVED] : []),
    ...groups.flatMap((g) => g.models.filter(({ m }) => m.available).map(({ m }) => keyFor(m))),
  ];
  const optionId = (key: string) => {
    if (key === INHERIT) return uid + "-inherit";
    if (key === SAVED) return uid + "-saved";
    return uid + "-m" + models.findIndex((m) => keyFor(m) === key);
  };
  const visible = order.includes(selected);
  useEffect(() => {
    if (visible) reveal(list.current, document.getElementById(optionId(selected)));
  }, [selected, visible, groups]);

  const change = (choice?: ModelChoice) => {
    setDraft(choice);
    setDirty(true);
    setSaved(false);
    setError("");
  };
  /** Picks a model; a thinking level the new model doesn't have is dropped. */
  function pick(key: string) {
    if (key === INHERIT) return change(undefined);
    if (key === SAVED) return;
    const m = models.find((m) => keyFor(m) === key);
    if (!m || !m.available) return;
    const keep = level && m.efforts.includes(level) ? level : undefined;
    change({ model: m.id, provider: m.provider, ...(m.source && { source: m.source }), ...(keep && { reasoningEffort: keep }) });
  }
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (!ready) return;
    const at = order.indexOf(selected);
    const next =
      e.key === "ArrowDown"
        ? Math.min(order.length - 1, at + 1)
        : e.key === "ArrowUp"
          ? Math.max(0, at < 0 ? 0 : at - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? order.length - 1
              : -2;
    if (next === -2) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.closest("form")?.requestSubmit();
      }
      return;
    }
    e.preventDefault();
    if (order[next] !== undefined) pick(order[next]);
  }
  function setLevel(effort: string) {
    const m = effectiveInfo;
    if (!m) return;
    change({
      model: m.id,
      provider: m.provider,
      ...(m.source && { source: m.source }),
      ...(effort && { reasoningEffort: effort }),
    });
  }

  const enabled = providers?.filter((p) => p.enabled) ?? [];
  const waiting = enabled.filter((p) => p.starting);
  const missing = enabled.filter((p) => !p.connected && !p.starting);
  const empty = !catalog.loading && !catalog.error && models.length === 0 && !waiting.length;
  const setup = (label: string) =>
    openProviders ? (
      <button type="button" className="set-link" onClick={openProviders}>
        {label}
      </button>
    ) : null;

  const levels = effectiveInfo?.efforts ?? [];
  return (
    <form
      className="model-picker"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || unavailable || (!!draft && !models.length)) return;
        setSaving(true);
        setError("");
        try {
          await window.botkins.setModel(scope, id, draft ?? null);
          setSaved(true);
          setDirty(false);
          done?.();
        } catch (e) {
          setError(plainError(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="mp-head">
        <span className="mp-label" id={uid + "-label"}>
          Model
        </span>
        {searchable && (
          <span className="mp-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search models"
              aria-controls={uid + "-list"}
              placeholder="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  if (!visible && order.length) pick(order[0]);
                  list.current?.focus();
                }
                if (e.key === "Escape" && query) {
                  // Clears the search instead of closing the dialog.
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </span>
        )}
      </div>
      {empty ? (
        <div className="mp-empty" role="status">
          <strong>No model provider is connected yet.</strong>
          <small>
            Sign in to ChatGPT, Claude or GitHub Copilot, or add another provider, to choose a model.
            {openProviders && (
              <>
                {" "}
                {setup("Set up model providers")}
              </>
            )}
          </small>
        </div>
      ) : (
        <div
          ref={list}
          id={uid + "-list"}
          className="mp-list"
          role="listbox"
          aria-labelledby={uid + "-label"}
          aria-activedescendant={visible ? optionId(selected) : undefined}
          aria-busy={catalog.loading || undefined}
          tabIndex={0}
          onKeyDown={keys}
        >
          {scope !== "global" && (
            <div
              role="option"
              id={optionId(INHERIT)}
              aria-selected={selected === INHERIT}
              aria-label={scope === "bot" ? "Use the global default" : "Use the bot's default"}
              aria-describedby={uid + "-inherit-desc"}
              className="mp-option mp-inherit"
              onClick={() => ready && pick(INHERIT)}
            >
              <span className="mp-check" aria-hidden="true">
                {selected === INHERIT && <Check size={14} />}
              </span>
              <span className="mp-text">
                <span className="mp-name">{scope === "bot" ? "Use the global default" : "Use the bot's default"}</span>
                <small id={uid + "-inherit-desc"}>
                  {inherited ? <ModelBadge choice={inherited} models={models} size={12} /> : "Not set"}
                </small>
              </span>
            </div>
          )}
          {draft && !info && (
            <div
              role="option"
              id={optionId(SAVED)}
              aria-selected={selected === SAVED}
              aria-label={modelName(draft, models, fallback)}
              aria-describedby={uid + "-saved-desc"}
              className="mp-option unavailable"
            >
              <span className="mp-check" aria-hidden="true">
                <Check size={14} />
              </span>
              <span className="mp-text">
                <span className="mp-name">
                  <ModelBadge choice={draft} models={models} size={13} effort={false} />
                </span>
                <small id={uid + "-saved-desc"}>
                  {catalog.loading
                    ? ""
                    : pending
                      ? (providerOf(draft)?.name ?? "Its provider") + " is still starting."
                      : models.length
                        ? "Not available now"
                        : ""}
                </small>
              </span>
            </div>
          )}
          {catalog.loading && !models.length && (
            <div className="mp-note" role="presentation">
              Loading models…
            </div>
          )}
          {groups.map((g, gi) => {
            const first = gi === 0 || groups[gi - 1].provider !== g.provider;
            const left = first ? pickerLine(usage?.find((u) => u.provider === g.provider), now) : undefined;
            return (
              <div
                key={g.provider + "/" + (g.group ?? "")}
                role="group"
                aria-label={g.group ? g.name + ", " + g.group : g.name}
                aria-describedby={left ? uid + "-left-" + g.provider : undefined}
              >
                {first && (
                  <div className="mp-group-head" aria-hidden="true">
                    <ProviderIcon provider={g.provider} name={g.name} size={14} />
                    {g.name}
                    {left && (
                      <span className={"mp-left" + (left.low ? " low" : "")} id={uid + "-left-" + g.provider}>
                        {left.text}
                      </span>
                    )}
                  </div>
                )}
                {g.group && (
                  <div className="mp-subhead" aria-hidden="true">
                    {g.group}
                  </div>
                )}
                {g.models.map(({ m, index }) => {
                  const key = keyFor(m);
                  const on = selected === key;
                  const facts = modelFacts(m);
                  const desc = [
                    m.recommended && uid + "-r" + index,
                    m.description && uid + "-d" + index,
                    facts.length > 0 && uid + "-f" + index,
                    !m.available && uid + "-u" + index,
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div
                      key={key}
                      role="option"
                      id={uid + "-m" + index}
                      aria-selected={on}
                      aria-disabled={!m.available || undefined}
                      aria-label={m.name}
                      aria-describedby={desc || undefined}
                      className={"mp-option" + (m.available ? "" : " unavailable")}
                      onClick={() => ready && pick(key)}
                    >
                      <span className="mp-check" aria-hidden="true">
                        {on && <Check size={14} />}
                      </span>
                      <span className="mp-text">
                        <span className="mp-name">
                          {m.name}
                          {m.recommended && (
                            <span className="mp-tag" id={uid + "-r" + index}>
                              Recommended
                            </span>
                          )}
                        </span>
                        {m.description && <small id={uid + "-d" + index}>{m.description}</small>}
                        {facts.length > 0 && (
                          <small className="mp-facts" id={uid + "-f" + index}>
                            {facts.map((fact) => (
                              <span key={fact.text} title={fact.exact}>
                                {fact.text}
                              </span>
                            ))}
                          </small>
                        )}
                        {!m.available && <small id={uid + "-u" + index}>Not available on this account</small>}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!!query.trim() && !groups.length && (
            <div className="mp-note" role="status">
              No models match “{query.trim()}”.
            </div>
          )}
        </div>
      )}
      {!empty && (waiting.length > 0 || missing.length > 0) && (
        <ProvidersNote waiting={waiting} missing={missing} setup={setup("Set up model providers")} />
      )}

      {!empty && (
        <div className="thinking-control" role="group" aria-labelledby={uid + "-thinking"}>
          <div className="thinking-head">
            <span id={uid + "-thinking"}>
              <BrainCircuit size={16} aria-hidden="true" />
              Thinking
            </span>
          </div>
          {levels.length && effectiveInfo ? (
            <>
              <Levels
                levels={levels}
                value={levels.includes(level) ? level : ""}
                disabled={!ready || !effectiveInfo.available}
                change={setLevel}
              />
              <small>
                {/* The provider's own line about the chosen level, where it gives one. */}
                {level && effectiveInfo.effortNotes?.[level] ? effectiveInfo.effortNotes[level] + ". " : ""}
                {effectiveInfo.defaultEffort
                  ? effortLabel(effectiveInfo.defaultEffort) + " is this model's default."
                  : "Default lets the model decide how much to think."}
              </small>
            </>
          ) : (
            <small>
              {catalog.loading
                ? "Loading models…"
                : effectiveInfo
                  ? "This model manages its own thinking."
                  : "Choose a model to set its thinking."}
            </small>
          )}
        </div>
      )}
      {unavailable && (
        <p role="alert">This saved choice is unavailable. Choose a current model and thinking level.</p>
      )}
      {(error || catalog.error) && (
        <p role="alert">
          {error || catalog.error}{" "}
          <button type="button" className="set-link" onClick={() => void catalog.reload()}>
            Reload models
          </button>
        </p>
      )}
      {!empty && (
        <div className="model-save">
          <button className="primary" disabled={!ready || unavailable || (!!draft && !models.length)}>
            {saving ? "Saving…" : "Save model"}
          </button>
          {saved && <small role="status">Model saved.</small>}
        </div>
      )}
    </form>
  );
}

/** "Default" and the model's own levels, as a row of radio buttons; arrow keys move between them. */
function Levels({
  levels,
  value,
  disabled,
  change,
}: {
  levels: string[];
  value: string;
  disabled: boolean;
  change: (effort: string) => void;
}) {
  const all = ["", ...levels];
  const row = useRef<HTMLDivElement>(null);
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    const at = all.indexOf(value);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (at + 1) % all.length
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (at - 1 + all.length) % all.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? all.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    change(all[next]);
    requestAnimationFrame(() => row.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus());
  }
  return (
    <div ref={row} className="segmented thinking-levels" role="radiogroup" aria-label="Thinking level" onKeyDown={keys}>
      {all.map((l) => (
        <button
          key={l || "default"}
          type="button"
          role="radio"
          aria-checked={value === l}
          tabIndex={value === l ? 0 : -1}
          disabled={disabled}
          onClick={() => change(l)}
        >
          {l ? effortLabel(l) : "Default"}
        </button>
      ))}
    </div>
  );
}

/** One quiet line about providers that are on but have no models here yet. */
function ProvidersNote({
  waiting,
  missing,
  setup,
}: {
  waiting: ProviderStatus[];
  missing: ProviderStatus[];
  setup: ReactNode;
}) {
  const parts = [];
  if (missing.length)
    parts.push(names(missing.map((p) => p.name)) + (missing.length === 1 ? " isn't connected." : " aren't connected."));
  if (waiting.length)
    parts.push(
      names(waiting.map((p) => p.name)) +
        (waiting.length === 1 ? " is still starting; its models appear here when it's ready." : " are still starting; their models appear here when they're ready."),
    );
  return (
    <p className="mp-providers">
      {parts.join(" ")}
      {setup && <> {setup}</>}
    </p>
  );
}
