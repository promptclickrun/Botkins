import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BrainCircuit, Check, ChevronDown } from "lucide-react";
import { Button, SearchField } from "glisse";
import { GlassSegmented } from "./GlisseUI";
import type { Bot, Chat, FastMode, ModelChoice, ModelInfo, Preferences, ProviderStatus } from "./types";
import ProviderIcon from "./ProviderIcon";
import { effortLabel, findModel, modelFacts, modelName, plainError, PROVIDER_NAMES, useModelCatalog, useProviders, useProviderUsage } from "./providers";
import { pickerLine, useNow } from "./ProviderLimits";
import { moreAccessibilityLabel, moreLabel, PAGE_SIZE, pageGroups, pageMatches } from "./modelPages";
import "./models.css";

/** A model choice as plain text: "Claude Opus 5.5 · High". Pass the catalog for friendly names. */
export function modelLabel(choice: ModelChoice, models?: ModelInfo[], defaultProvider?: string) {
  return [modelName(choice, models, defaultProvider), choice.reasoningEffort && effortLabel(choice.reasoningEffort)]
    .filter(Boolean)
    .join(" · ");
}

/** Whether a chat is a routine's own chat (desktop/routines.mjs). */
export const isRoutineChat = (chat?: Chat) => !!chat?.schedules?.some((entry) => entry.routine);

/**
 * What a chat runs on when it has no model of its own: for a routine's chat the Default routines
 * model, then its bot's, then the default model. Mirrors effectiveModel in desktop/workspace.mjs.
 */
export function chatDefault(settings: Preferences, chat: Chat | undefined, bot: Bot | undefined) {
  return (isRoutineChat(chat) ? settings.routineModel : undefined) ?? bot?.model ?? settings.model;
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

type Row = { m: ModelInfo; index: number };
type Group = { provider: string; name: string; group?: string; models: Row[] };
/** A provider's groups (one per service, or just one), for paging the provider as a whole. */
type ProviderGroups = { provider: string; name: string; sections: Group[] };
/** The key of a "Show more" row: a provider's, or the search's (MORE alone). */
const MORE = "more:";
const isMore = (key: string) => key.startsWith(MORE);

/** Groups of the same provider, which groupModels keeps side by side, together. */
function byProvider(groups: Group[]): ProviderGroups[] {
  const out: ProviderGroups[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (last?.provider === g.provider) last.sections.push(g);
    else out.push({ provider: g.provider, name: g.name, sections: [g] });
  }
  return out;
}

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

/** What the choice of no model of its own is called, by scope. */
const INHERIT_LABELS = {
  routines: "Use the global default",
  bot: "Use the global default",
  chat: "Use the bot's default",
  routine: "Use the routines default",
} as const;

/**
 * The model and thinking picker for the global default, the Default routines model, a bot, a chat
 * or a routine. Models are grouped under their provider; the thinking levels are the chosen model's
 * own. Saves with setModel, except for "routine": a routine's editor holds the choice (`onChange`)
 * and saves it with the routine, so the picker has no form or Save button of its own there.
 */
export default function ModelPicker({
  scope,
  id,
  value,
  inherited,
  inheritLabel,
  speedSettings,
  done,
  onChange,
  openProviders,
}: {
  scope: "global" | "routines" | "bot" | "chat" | "routine";
  id: string | null;
  value?: ModelChoice;
  inherited?: ModelChoice;
  /** The words for "no model of its own", when the scope's usual ones don't fit (a routine's chat). */
  inheritLabel?: string;
  speedSettings?: { value?: FastMode; inherited?: FastMode };
  done?: () => void;
  /** With scope "routine": each change of the choice (undefined is the routines default). */
  onChange?: (choice: ModelChoice | undefined) => void;
  /** Opens Settings › Model providers. Without it the picker names the providers but offers no link. */
  openProviders?: () => void;
}) {
  const held = scope === "routine";
  const catalog = useModelCatalog();
  const { providers } = useProviders();
  // What is left of each provider's plan, for the line under its name.
  const { usage } = useProviderUsage();
  const now = useNow();
  const models = catalog.models;
  const fallback = providers?.find((p) => p.default)?.id;
  const [draft, setDraft] = useState<ModelChoice | undefined>(value);
  const [dirty, setDirty] = useState(false);
  const [speedEdit, setSpeedEdit] = useState<FastMode | null>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [query, setQuery] = useState("");
  // How many pages of models each provider shows, and a search's matches; both start at one when
  // the picker opens, and a new search starts its matches at one.
  const [pages, setPages] = useState<Record<string, number>>({});
  const [searchPages, setSearchPages] = useState(1);
  // The row the arrow keys are on when it isn't the chosen one: a "Show more" row, or the first
  // model it revealed. Undefined follows the chosen row.
  const [cursor, setCursor] = useState<string>();
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
  const speed = speedEdit === undefined ? speedSettings?.value : speedEdit;
  const effectiveSpeed = speed ?? speedSettings?.inherited ?? "off";
  const speeds = effectiveInfo?.fastModes;
  const speedChoices = ["off", ...(speeds?.fast ? ["fast"] : []), ...(speeds?.ultrafast ? ["ultrafast"] : [])];
  const level = effective?.reasoningEffort ?? "";
  const providerOf = (choice?: ModelChoice) => providers?.find((p) => p.id === (choice?.provider ?? fallback));
  // A saved choice whose provider is still starting isn't unavailable yet; its models are on the way.
  const pending = !!draft && !info && !!providerOf(draft)?.starting;
  const unavailable =
    !!draft && models.length > 0 && !pending && (!info?.available || (!!level && !info.efforts.includes(level)));
  const ready = !catalog.loading && !saving;
  const selected = !draft ? INHERIT : info ? keyFor(info) : SAVED;

  const groups = useMemo(() => groupModels(models, query), [models, query]);
  const providerGroups = useMemo(() => byProvider(groups), [groups]);
  const searching = !!query.trim();
  // Only a page of each provider's models is drawn (a provider can list hundreds); the chosen one
  // is always among them. A search pages its matches across every provider.
  const chosenInfo = draft ? info : undefined;
  const paged = useMemo(() => {
    const isChosen = (row: Row) => !!chosenInfo && row.m === chosenInfo;
    return searching
      ? pageMatches<Row, Group, ProviderGroups>(providerGroups, searchPages, isChosen)
      : { groups: pageGroups<Row, Group, ProviderGroups>(providerGroups, pages, isChosen), rest: 0 };
  }, [providerGroups, searching, searchPages, pages, chosenInfo]);
  const searchable = models.length > 8;
  // The rows in the order arrow keys move through them: the choices, and the "Show more" rows.
  const order = [
    ...(scope !== "global" ? [INHERIT] : []),
    ...(draft && !info ? [SAVED] : []),
    ...paged.groups.flatMap((p) => [
      ...p.sections.flatMap((g) => g.models.filter(({ m }) => m.available).map(({ m }) => keyFor(m))),
      ...(p.rest > 0 ? [MORE + p.group.provider] : []),
    ]),
    ...(paged.rest > 0 ? [MORE] : []),
  ];
  const optionId = (key: string) => {
    if (key === INHERIT) return uid + "-inherit";
    if (key === SAVED) return uid + "-saved";
    if (isMore(key)) return uid + "-more-" + key.slice(MORE.length).replace(/[^\w-]/g, "_");
    return uid + "-m" + models.findIndex((m) => keyFor(m) === key);
  };
  const active = cursor !== undefined && order.includes(cursor) ? cursor : selected;
  const visible = order.includes(active);
  useEffect(() => {
    if (visible) reveal(list.current, document.getElementById(optionId(active)));
  }, [active, visible, groups]);

  /**
   * Draws the next page behind a "Show more" row. From the keyboard, the arrow keys go on from the
   * first model it revealed (or stay on the row when none of them can be chosen).
   */
  function showMore(key: string, fromKeys: boolean) {
    const provider = key.slice(MORE.length);
    const entry = paged.groups.find((p) => p.group.provider === provider);
    const rows = key === MORE ? paged.groups.flatMap((p) => p.group.sections) : (entry?.group.sections ?? []);
    const from = (key === MORE ? searchPages : (pages[provider] ?? 1)) * PAGE_SIZE;
    if (key === MORE) setSearchPages((n) => n + 1);
    else setPages((all) => ({ ...all, [provider]: (all[provider] ?? 1) + 1 }));
    if (!fromKeys) return setCursor(undefined);
    // Under a search, the providers' later matches aren't in paged.groups yet: count them from groups.
    const flat = key === MORE ? groups.flatMap((g) => g.models) : rows.flatMap((g) => g.models);
    const next = flat.slice(from, from + PAGE_SIZE).find(({ m }) => m.available);
    setCursor(next ? keyFor(next.m) : key);
  }

  const change = (choice?: ModelChoice) => {
    setCursor(undefined);
    setDraft(choice);
    setDirty(true);
    setSaved(false);
    setError("");
    onChange?.(choice);
  };
  const inheritText = scope === "global" ? "" : (inheritLabel ?? INHERIT_LABELS[scope]);
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
    const at = order.indexOf(active);
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
      if (e.key === "Enter" && active !== selected && visible) {
        // On a "Show more" row, or a model the arrow keys reached through one.
        e.preventDefault();
        if (isMore(active)) showMore(active, true);
        else pick(active);
      } else if (e.key === "Enter" && !held) {
        e.preventDefault();
        e.currentTarget.closest("form")?.requestSubmit();
      }
      return;
    }
    e.preventDefault();
    const key = order[next];
    if (key === undefined) return;
    if (isMore(key)) setCursor(key);
    else pick(key);
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
  // A routine's picker sits inside the routine's own form, and a form can't hold another.
  const Frame = held ? "div" : "form";
  return (
    <Frame
      className="model-picker"
      onSubmit={async (e) => {
        e.preventDefault();
        if (held || !ready || unavailable || (!!draft && !models.length)) return;
        setSaving(true);
        setError("");
        try {
          if (speedSettings && speedEdit !== undefined) await window.botkins.setModel(scope, id, draft ?? null, speedEdit);
          else await window.botkins.setModel(scope, id, draft ?? null);
          setSpeedEdit(undefined);
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
          <SearchField
            className="mp-search-field lg-search-compact"
            aria-label="Search models"
            aria-controls={uid + "-list"}
            placeholder="Search models"
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              setSearchPages(1);
              setCursor(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                if (!visible && order.length && !isMore(order[0])) pick(order[0]);
                list.current?.focus();
              }
              if (e.key === "Escape" && query) {
                // Clears the search instead of closing the dialog.
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
                setSearchPages(1);
                setCursor(undefined);
              }
            }}
          />
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
          aria-activedescendant={visible ? optionId(active) : undefined}
          aria-busy={catalog.loading || undefined}
          tabIndex={0}
          onKeyDown={keys}
        >
          {scope !== "global" && (
            <div
              role="option"
              id={optionId(INHERIT)}
              aria-selected={selected === INHERIT}
              aria-label={inheritText}
              aria-describedby={uid + "-inherit-desc"}
              className={"mp-option mp-inherit" + (active === INHERIT ? " active" : "")}
              onClick={() => ready && pick(INHERIT)}
            >
              <span className="mp-check" aria-hidden="true">
                {selected === INHERIT && <Check size={14} />}
              </span>
              <span className="mp-text">
                <span className="mp-name">{inheritText}</span>
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
              className={"mp-option unavailable" + (active === SAVED ? " active" : "")}
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
          {paged.groups.flatMap((entry) => entry.sections.map((g, gi) => {
            const first = gi === 0;
            const last = gi === entry.sections.length - 1;
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
                  const current = active === key;
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
                      className={"mp-option" + (m.available ? "" : " unavailable") + (current ? " active" : "")}
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
                {last && entry.rest > 0 && (
                  <MoreRow
                    id={optionId(MORE + g.provider)}
                    rest={entry.rest}
                    providerName={g.name}
                    active={active === MORE + g.provider}
                    onClick={() => showMore(MORE + g.provider, false)}
                  />
                )}
              </div>
            );
          }))}
          {paged.rest > 0 && (
            <MoreRow id={optionId(MORE)} rest={paged.rest} active={active === MORE} onClick={() => showMore(MORE, false)} />
          )}
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
      {!empty && speedSettings && (
        <div className="thinking-control">
          <div className="thinking-head"><span>Fast mode</span>
            {scope !== "global" && <small>{scope === "chat" ? "Bot" : "Global"} default · {effortLabel(speedSettings.inherited ?? "off")}</small>}
          </div>
          <Levels levels={speedChoices} label="Fast mode" firstLabel={scope === "global" ? null : "Use default"}
            value={speed ?? (scope === "global" ? "off" : "")} disabled={!ready}
            change={(next) => { setSpeedEdit((next || null) as FastMode | null); setSaved(false); setError(""); }} />
          {effectiveSpeed !== "off" && <small role="status" className={speeds?.[effectiveSpeed] ? "speed-warning" : undefined}>
            {speeds?.[effectiveSpeed] ? effortLabel(effectiveSpeed) + " uses your plan allowance much faster."
              : effortLabel(effectiveSpeed) + " is unavailable for this model. Turns use standard speed."}
          </small>}
          {effectiveSpeed === "off" && !speeds && <small>Fast mode is unavailable for this model.</small>}
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
      {!empty && !held && (
        <div className="model-save">
          <Button type="submit" variant="filled" className="lg-compact" disabled={!ready || unavailable || (!!draft && !models.length)}>
            {saving ? "Saving…" : "Save model"}
          </Button>
          {saved && <small role="status">Model saved.</small>}
        </div>
      )}
    </Frame>
  );
}

/** The row under a page of models that draws the next page: "Show 25 more", or "Show the last 3". */
function MoreRow({ id, rest, providerName, active, onClick }: { id: string; rest: number; providerName?: string; active: boolean; onClick: () => void }) {
  return (
    <div
      role="option"
      id={id}
      aria-selected={false}
      aria-label={moreAccessibilityLabel(rest, providerName)}
      className={"mp-option mp-more" + (active ? " active" : "")}
      onClick={onClick}
    >
      <span className="mp-check" aria-hidden="true">
        <ChevronDown size={14} />
      </span>
      <span className="mp-text">
        <span className="mp-name">{moreLabel(rest)}</span>
      </span>
    </div>
  );
}

/** "Default" and the model's own levels, as a row of radio buttons; arrow keys move between them. */
function Levels({
  levels,
  value,
  disabled,
  change,
  label = "Thinking level",
  firstLabel = "Default",
}: {
  label?: string;
  firstLabel?: string | null;
  levels: string[];
  value: string;
  disabled: boolean;
  change: (effort: string) => void;
}) {
  const all = firstLabel ? ["", ...levels] : levels;
  const current = all.includes(value) ? value : all[0];
  return (
    <GlassSegmented
      className={"thinking-levels" + (disabled ? " is-disabled" : "")}
      aria-label={label}
      aria-disabled={disabled || undefined}
      value={current}
      items={all.map((l) => ({ value: l, label: l ? effortLabel(l) : (firstLabel ?? "") }))}
      onValueChange={(next) => {
        if (!disabled) change(next);
      }}
    />
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
