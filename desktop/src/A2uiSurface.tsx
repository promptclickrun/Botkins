// Native React renderer for A2UI v1.0 Basic Catalog surfaces on Botkins desktop.
// Styled strictly with Botkins theme tokens (a2uiSurface.css); no untrusted HTML, scripts,
// or unconfirmed external navigations.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BellOff,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  CircleHelp,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FastForward,
  Folder,
  Heart,
  HeartOff,
  Home,
  Image as ImageIcon,
  Info,
  Lock,
  LockOpen,
  Mail,
  MapPin,
  Menu,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Rewind,
  Search,
  Send,
  Settings,
  Share2,
  ShoppingCart,
  SkipBack,
  SkipForward,
  Square,
  Star,
  Trash2,
  Upload,
  User,
  UserCircle,
  Volume1,
  Volume2,
  VolumeOff,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  evaluateChecks,
  getDataAtPointer,
  isSafeA2uiUrl,
  resolveActionEvent,
  resolveDynamicBoolean,
  resolveDynamicNumber,
  resolveDynamicString,
  resolveDynamicStringList,
  setDataAtPointer,
  summarizeA2uiSurface,
} from "../desktop/link/a2ui.mjs";
import { errorText } from "./SettingsRows";
import type { A2uiActionPayload, A2uiComponent, A2uiSurface as A2uiSurfaceData } from "./types";
import "./a2uiSurface.css";

const ICON_MAP: Record<string, LucideIcon> = {
  accountCircle: UserCircle,
  add: Plus,
  arrowBack: ArrowLeft,
  arrowForward: ArrowRight,
  attachFile: Paperclip,
  calendarToday: Calendar,
  call: Phone,
  camera: Camera,
  check: Check,
  close: X,
  delete: Trash2,
  download: Download,
  edit: Pencil,
  event: Calendar,
  error: AlertCircle,
  fastForward: FastForward,
  favorite: Heart,
  favoriteOff: HeartOff,
  folder: Folder,
  help: CircleHelp,
  home: Home,
  info: Info,
  locationOn: MapPin,
  lock: Lock,
  lockOpen: LockOpen,
  mail: Mail,
  menu: Menu,
  moreVert: MoreVertical,
  moreHoriz: MoreHorizontal,
  notificationsOff: BellOff,
  notifications: Bell,
  pause: Pause,
  payment: CreditCard,
  person: User,
  phone: Phone,
  photo: ImageIcon,
  play: Play,
  print: Printer,
  refresh: RefreshCw,
  rewind: Rewind,
  search: Search,
  send: Send,
  settings: Settings,
  share: Share2,
  shoppingCart: ShoppingCart,
  skipNext: SkipForward,
  skipPrevious: SkipBack,
  star: Star,
  starHalf: Star,
  starOff: Star,
  stop: Square,
  upload: Upload,
  visibility: Eye,
  visibilityOff: EyeOff,
  volumeDown: Volume1,
  volumeMute: VolumeX,
  volumeOff: VolumeOff,
  volumeUp: Volume2,
  warning: AlertTriangle,
};

const JUSTIFY_MAP: Record<string, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
  stretch: "stretch",
};

const ALIGN_MAP: Record<string, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

const FIT_MAP: Record<string, CSSProperties["objectFit"]> = {
  contain: "contain",
  cover: "cover",
  fill: "fill",
  none: "none",
  scaleDown: "scale-down",
};

type RenderCtx = {
  scopePath: string;
  itemIndex?: number;
};

type Props = {
  chatId: string;
  surface: A2uiSurfaceData;
  rich?: boolean;
  readOnly?: boolean;
  openChat?: (chatId: string) => void;
  onAction?: (chatId: string, payload: A2uiActionPayload) => Promise<unknown>;
  onOpenLink?: (url: string) => void;
};

function boundPathOf(v: unknown, scopePath: string): string | null {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)["@path"] === "string") {
    const raw = (v as Record<string, string>)["@path"];
    if (raw.startsWith("/")) return raw;
    return scopePath ? `${scopePath.replace(/\/$/, "")}/${raw}` : `/${raw}`;
  }
  return null;
}

export default function A2uiSurface({
  chatId,
  surface,
  rich = true,
  readOnly = false,
  openChat,
  onAction,
  onOpenLink,
}: Props) {
  const [dataModel, setDataModel] = useState<Record<string, unknown>>(() => structuredClone(surface.dataModel ?? {}));
  const [tabSelection, setTabSelection] = useState<Record<string, number>>({});
  const [openModalId, setOpenModalId] = useState<string | null>(null);
  const [choiceFilter, setChoiceFilter] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expandedDismissed, setExpandedDismissed] = useState(false);

  // Sync incoming live updates from updateDataModel / server state.
  useEffect(() => {
    setDataModel(structuredClone(surface.dataModel ?? {}));
  }, [surface.updatedAt, surface.surfaceId]);

  const byId = useMemo(() => {
    const m = new Map<string, A2uiComponent>();
    for (const c of surface.components ?? []) m.set(c.id, c);
    return m;
  }, [surface.components]);

  if (surface.deleted) return null;

  const openExternal = (url: string) => {
    if (!isSafeA2uiUrl(url)) return;
    if (onOpenLink) onOpenLink(url);
    else void window.botkins.openLink(url);
  };

  const updatePointer = (pointer: string | null, nextVal: unknown) => {
    if (!pointer) return;
    setDataModel((prev) => {
      try {
        return setDataAtPointer(prev, pointer, nextVal) as Record<string, unknown>;
      } catch {
        return prev;
      }
    });
  };

  const triggerAction = async (comp: A2uiComponent, actionObj: any, ctx: RenderCtx) => {
    if (!actionObj || typeof actionObj !== "object") return;
    if (actionObj.functionCall) {
      const fn = actionObj.functionCall;
      if (fn["@call"] === "openUrl") {
        const url = resolveDynamicString(fn.args?.url, dataModel, ctx);
        openExternal(url);
      }
      return;
    }
    if (!actionObj.event) return;
    if (readOnly || busyId) return;

    // Validate button's own @checks if present.
    const checkErrors = evaluateChecks(comp, dataModel, ctx);
    if (checkErrors.length) {
      setError(checkErrors[0]);
      return;
    }

    const resolved = resolveActionEvent(actionObj, dataModel, ctx);
    if (!resolved) return;
    const actionId = `${surface.surfaceId}:${comp.id}:${resolved.name}:${ctx.itemIndex ?? 0}`;
    const payload: A2uiActionPayload = {
      version: "1.0",
      surfaceId: surface.surfaceId,
      sourceComponentId: comp.id,
      name: resolved.name,
      actionId,
      ...(resolved.userMessage ? { userMessage: resolved.userMessage } : {}),
      timestamp: new Date().toISOString(),
      context: resolved.context,
      ...(surface.sendDataModel ? { dataModel } : {}),
    };

    setBusyId(comp.id);
    setError("");
    try {
      if (onAction) await onAction(chatId, payload);
      else await window.botkins["chat.a2uiAction"](chatId, payload);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  // Rich-cards-off mode: plain text summary + interactive action buttons.
  if (!rich) {
    const summary = summarizeA2uiSurface({ ...surface, dataModel });
    return (
      <section className="a2ui-fallback" aria-label={`Interactive UI ${surface.surfaceId}`}>
        {summary.lines.length > 0 ? (
          summary.lines.map((line, idx) => (
            <p className="a2ui-text" key={idx}>
              {line}
            </p>
          ))
        ) : (
          <p className="a2ui-text caption">Interactive UI ({surface.surfaceId})</p>
        )}
        {summary.actions.length > 0 && (
          <div className="a2ui-fallback-actions" role="group" aria-label="Surface actions">
            {summary.actions.map((act, idx) => {
              const comp = byId.get(act.componentId) ?? { id: act.componentId, component: "Button" };
              const fnCall = act.action?.functionCall as Record<string, unknown> | undefined;
              const isOpenUrl = fnCall?.["@call"] === "openUrl";
              return (
                <button
                  key={`${act.componentId}-${idx}`}
                  type="button"
                  className={"a2ui-btn " + (act.variant || "default")}
                  disabled={(!isOpenUrl && readOnly) || busyId !== null}
                  onClick={() => void triggerAction(comp, act.action, { scopePath: act.scopePath, itemIndex: act.itemIndex })}
                >
                  {busyId === act.componentId ? "Working…" : act.label}
                </button>
              );
            })}
          </div>
        )}
        {error && (
          <p className="a2ui-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (surface.state === "dismissed") {
    const summary = summarizeA2uiSurface({ ...surface, dataModel });
    return (
      <section className="a2ui-surface dismissed" aria-label={`Dismissed UI ${surface.surfaceId}`}>
        <div className="a2ui-status-row" style={{ borderTop: "none", paddingTop: 0 }}>
          <span>Dismissed · {summary.lines[0] || surface.surfaceId}</span>
          <button type="button" className="a2ui-btn borderless" onClick={() => setExpandedDismissed((v) => !v)}>
            {expandedDismissed ? "Hide" : "Show"}
          </button>
        </div>
        {expandedDismissed && renderNode("root", { scopePath: "" }, 0)}
      </section>
    );
  }

  function renderChildren(children: unknown, ctx: RenderCtx, depth: number): ReactNode {
    if (Array.isArray(children)) {
      return children.map((cid, idx) => (
        <span key={`${String(cid)}-${idx}`} style={{ display: "contents" }}>
          {renderNode(String(cid), ctx, depth + 1)}
        </span>
      ));
    }
    if (children && typeof children === "object" && typeof (children as any).componentId === "string" && typeof (children as any).path === "string") {
      const tpl = children as { componentId: string; path: string };
      const arr = getDataAtPointer(dataModel, tpl.path, ctx.scopePath);
      if (!Array.isArray(arr)) return null;
      const base = tpl.path.startsWith("/")
        ? tpl.path.replace(/\/$/, "")
        : `${ctx.scopePath.replace(/\/$/, "")}/${tpl.path}`;
      return arr.slice(0, 50).map((_, idx) => (
        <span key={`${tpl.componentId}-${idx}`} style={{ display: "contents" }}>
          {renderNode(tpl.componentId, { scopePath: `${base}/${idx}`, itemIndex: idx }, depth + 1)}
        </span>
      ));
    }
    return null;
  }

  function renderNode(id: string, ctx: RenderCtx, depth: number): ReactNode {
    if (depth > 24) return null;
    const comp = byId.get(id);
    if (!comp) return null;

    const a11y = comp["@accessibility"];
    const a11yLabel = a11y?.label !== undefined ? resolveDynamicString(a11y.label, dataModel, ctx) : undefined;
    const a11yHidden = a11y?.hidden !== undefined ? resolveDynamicBoolean(a11y.hidden, dataModel, ctx) : undefined;
    const a11yLive = a11y?.live && a11y.live !== "off" ? a11y.live : undefined;
    const weightStyle: CSSProperties = typeof comp.weight === "number" && comp.weight > 0 ? { flex: comp.weight } : {};

    switch (comp.component) {
      case "Text": {
        const text = resolveDynamicString(comp.text, dataModel, ctx);
        const variant = typeof comp.variant === "string" ? comp.variant : "body";
        return (
          <p
            className={`a2ui-text ${variant}`}
            style={weightStyle}
            aria-label={a11yLabel}
            aria-hidden={a11yHidden}
            aria-live={a11yLive}
          >
            {text}
          </p>
        );
      }
      case "Icon": {
        const name = typeof comp.name === "string" ? comp.name : resolveDynamicString(comp.name, dataModel, ctx);
        const IconComp = ICON_MAP[name] ?? Info;
        return <IconComp size={16} aria-label={a11yLabel || name} aria-hidden={a11yHidden ?? !a11yLabel} />;
      }
      case "Image": {
        const url = resolveDynamicString(comp.url, dataModel, ctx);
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : "";
        if (!isSafeA2uiUrl(url, { allowDataImage: true })) {
          return <div className="a2ui-placeholder">{desc || "Image unavailable"}</div>;
        }
        const variant = typeof comp.variant === "string" ? comp.variant : "mediumFeature";
        const fit = typeof comp.fit === "string" ? FIT_MAP[comp.fit] : undefined;
        return (
          <img
            className={`a2ui-image ${variant}`}
            src={url}
            alt={desc || a11yLabel || ""}
            style={{ ...weightStyle, ...(fit ? { objectFit: fit } : {}) }}
            referrerPolicy="no-referrer"
          />
        );
      }
      case "Video":
      case "AudioPlayer": {
        const url = resolveDynamicString(comp.url, dataModel, ctx);
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : `${comp.component} media`;
        return (
          <div className="a2ui-row" style={{ alignItems: "center", justifyContent: "space-between", ...weightStyle }}>
            <span className="a2ui-text caption">{desc}</span>
            {isSafeA2uiUrl(url) && (
              <button type="button" className="a2ui-btn borderless" onClick={() => openExternal(url)}>
                <ExternalLink size={13} aria-hidden="true" /> Open
              </button>
            )}
          </div>
        );
      }
      case "Row": {
        const style: CSSProperties = {
          ...weightStyle,
          ...(typeof comp.justify === "string" && JUSTIFY_MAP[comp.justify] ? { justifyContent: JUSTIFY_MAP[comp.justify] } : {}),
          ...(typeof comp.align === "string" && ALIGN_MAP[comp.align] ? { alignItems: ALIGN_MAP[comp.align] } : {}),
        };
        return (
          <div className="a2ui-row" style={style} aria-label={a11yLabel} aria-live={a11yLive}>
            {renderChildren(comp.children, ctx, depth)}
          </div>
        );
      }
      case "Column": {
        const style: CSSProperties = {
          ...weightStyle,
          ...(typeof comp.justify === "string" && JUSTIFY_MAP[comp.justify] ? { justifyContent: JUSTIFY_MAP[comp.justify] } : {}),
          ...(typeof comp.align === "string" && ALIGN_MAP[comp.align] ? { alignItems: ALIGN_MAP[comp.align] } : {}),
        };
        return (
          <div className="a2ui-column" style={style} aria-label={a11yLabel} aria-live={a11yLive}>
            {renderChildren(comp.children, ctx, depth)}
          </div>
        );
      }
      case "List": {
        const dir = comp.direction === "horizontal" ? "horizontal" : "vertical";
        const style: CSSProperties = {
          ...weightStyle,
          ...(typeof comp.align === "string" && ALIGN_MAP[comp.align] ? { alignItems: ALIGN_MAP[comp.align] } : {}),
        };
        return (
          <div className={`a2ui-list ${dir}`} style={style} role="list" aria-label={a11yLabel}>
            {renderChildren(comp.children, ctx, depth)}
          </div>
        );
      }
      case "Card":
        return (
          <div className="a2ui-card" style={weightStyle} aria-label={a11yLabel}>
            {typeof comp.child === "string" ? renderNode(comp.child, ctx, depth + 1) : null}
          </div>
        );
      case "Divider": {
        const axis = comp.axis === "vertical" ? "vertical" : "horizontal";
        return <hr className={`a2ui-divider ${axis}`} aria-orientation={axis} />;
      }
      case "Button": {
        const variant = typeof comp.variant === "string" ? comp.variant : "default";
        const isOpenUrl = (comp.action as any)?.functionCall?.["@call"] === "openUrl";
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        const disabled = (!isOpenUrl && readOnly) || busyId !== null || checkErrs.length > 0;
        return (
          <button
            type="button"
            className={`a2ui-btn ${variant}`}
            style={weightStyle}
            disabled={disabled}
            aria-label={a11yLabel}
            onClick={() => void triggerAction(comp, comp.action, ctx)}
          >
            {busyId === comp.id ? "Working…" : typeof comp.child === "string" ? renderNode(comp.child, ctx, depth + 1) : "Action"}
          </button>
        );
      }
      case "TextField": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const value = resolveDynamicString(comp.value, dataModel, ctx);
        const placeholder = comp.placeholder !== undefined ? resolveDynamicString(comp.placeholder, dataModel, ctx) : "";
        const variant = typeof comp.variant === "string" ? comp.variant : "shortText";
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <label className="a2ui-field" style={weightStyle}>
            <span className="a2ui-field-label">{label}</span>
            {variant === "longText" ? (
              <textarea
                className="a2ui-textarea"
                value={value}
                placeholder={placeholder}
                disabled={readOnly}
                aria-label={a11yLabel || label}
                onChange={(e) => updatePointer(pointer, e.target.value)}
              />
            ) : (
              <input
                className="a2ui-input"
                type={variant === "number" ? "number" : variant === "obscured" ? "password" : "text"}
                value={value}
                placeholder={placeholder}
                disabled={readOnly}
                aria-label={a11yLabel || label}
                onChange={(e) => updatePointer(pointer, e.target.value)}
              />
            )}
            {checkErrs.length > 0 && <span className="a2ui-check-error">{checkErrs[0]}</span>}
          </label>
        );
      }
      case "CheckBox": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const checked = resolveDynamicBoolean(comp.value, dataModel, ctx);
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <div className="a2ui-field" style={weightStyle}>
            <label className="a2ui-checkbox">
              <input
                type="checkbox"
                checked={checked}
                disabled={readOnly}
                aria-label={a11yLabel || label}
                onChange={(e) => updatePointer(pointer, e.target.checked)}
              />
              <span>{label}</span>
            </label>
            {checkErrs.length > 0 && <span className="a2ui-check-error">{checkErrs[0]}</span>}
          </div>
        );
      }
      case "ChoicePicker": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const selected = resolveDynamicStringList(comp.value, dataModel, ctx);
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const multiple = comp.variant === "multipleSelection";
        const displayStyle = comp.displayStyle === "chips" ? "chips" : "checkbox";
        const options = Array.isArray(comp.options) ? (comp.options as Array<{ label: unknown; value: string }>) : [];
        const filterText = (choiceFilter[comp.id] || "").trim().toLowerCase();
        const filtered = filterText
          ? options.filter((o) => resolveDynamicString(o.label, dataModel, ctx).toLowerCase().includes(filterText))
          : options;
        const toggle = (val: string) => {
          if (readOnly) return;
          const next = multiple
            ? selected.includes(val)
              ? selected.filter((s) => s !== val)
              : [...selected, val]
            : [val];
          updatePointer(pointer, next);
        };
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <fieldset className="a2ui-field" style={{ border: 0, padding: 0, margin: 0, ...weightStyle }}>
            {label && <legend className="a2ui-field-label">{label}</legend>}
            {comp.filterable === true && (
              <input
                type="search"
                className="a2ui-input"
                placeholder="Filter options…"
                value={choiceFilter[comp.id] || ""}
                onChange={(e) => setChoiceFilter((prev) => ({ ...prev, [comp.id]: e.target.value }))}
              />
            )}
            <div className={`a2ui-choices ${displayStyle}`}>
              {filtered.map((opt) => {
                const optLabel = resolveDynamicString(opt.label, dataModel, ctx);
                const isSelected = selected.includes(opt.value);
                if (displayStyle === "chips") {
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={"a2ui-chip" + (isSelected ? " selected" : "")}
                      aria-pressed={isSelected}
                      disabled={readOnly}
                      onClick={() => toggle(opt.value)}
                    >
                      {optLabel}
                    </button>
                  );
                }
                return (
                  <label key={opt.value} className="a2ui-checkbox">
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`${surface.surfaceId}-${comp.id}`}
                      checked={isSelected}
                      disabled={readOnly}
                      onChange={() => toggle(opt.value)}
                    />
                    <span>{optLabel}</span>
                  </label>
                );
              })}
            </div>
            {checkErrs.length > 0 && <span className="a2ui-check-error">{checkErrs[0]}</span>}
          </fieldset>
        );
      }
      case "Slider": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const min = typeof comp.min === "number" ? comp.min : 0;
        const max = typeof comp.max === "number" ? comp.max : 100;
        const val = resolveDynamicNumber(comp.value, dataModel, ctx);
        const step = typeof comp.steps === "number" && comp.steps > 0 ? (max - min) / comp.steps : "any";
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <label className="a2ui-field" style={weightStyle}>
            <div className="a2ui-slider-head">
              <span className="a2ui-field-label">{label}</span>
              <span className="a2ui-text caption">{val}</span>
            </div>
            <input
              type="range"
              className="a2ui-slider"
              min={min}
              max={max}
              step={step}
              value={val}
              disabled={readOnly}
              aria-label={a11yLabel || label}
              onChange={(e) => updatePointer(pointer, Number(e.target.value))}
            />
            {checkErrs.length > 0 && <span className="a2ui-check-error">{checkErrs[0]}</span>}
          </label>
        );
      }
      case "DateTimeInput": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const val = resolveDynamicString(comp.value, dataModel, ctx);
        const enableDate = comp.enableDate === true;
        const enableTime = comp.enableTime === true;
        const inputType = enableDate && enableTime ? "datetime-local" : enableTime ? "time" : "date";
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const min = comp.min !== undefined ? resolveDynamicString(comp.min, dataModel, ctx) : undefined;
        const max = comp.max !== undefined ? resolveDynamicString(comp.max, dataModel, ctx) : undefined;
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <label className="a2ui-field" style={weightStyle}>
            {label && <span className="a2ui-field-label">{label}</span>}
            <input
              type={inputType}
              className="a2ui-input"
              value={val}
              min={min || undefined}
              max={max || undefined}
              disabled={readOnly}
              aria-label={a11yLabel || label || "Date and time"}
              onChange={(e) => updatePointer(pointer, e.target.value)}
            />
            {checkErrs.length > 0 && <span className="a2ui-check-error">{checkErrs[0]}</span>}
          </label>
        );
      }
      case "Tabs": {
        const tabs = Array.isArray(comp.tabs) ? (comp.tabs as Array<{ title: unknown; child: string }>) : [];
        const activeIdx = Math.min(tabSelection[comp.id] ?? 0, Math.max(0, tabs.length - 1));
        const activeTab = tabs[activeIdx];
        return (
          <div className="a2ui-column" style={weightStyle}>
            <div className="a2ui-tabs-bar" role="tablist" aria-label={a11yLabel || "Tabs"}>
              {tabs.map((tab, idx) => (
                <button
                  key={idx}
                  type="button"
                  role="tab"
                  aria-selected={idx === activeIdx}
                  className={"a2ui-tab" + (idx === activeIdx ? " active" : "")}
                  onClick={() => setTabSelection((prev) => ({ ...prev, [comp.id]: idx }))}
                >
                  {resolveDynamicString(tab.title, dataModel, ctx)}
                </button>
              ))}
            </div>
            {activeTab && (
              <div className="a2ui-tab-panel" role="tabpanel">
                {renderNode(activeTab.child, ctx, depth + 1)}
              </div>
            )}
          </div>
        );
      }
      case "Modal": {
        const triggerId = typeof comp.trigger === "string" ? comp.trigger : "";
        const contentId = typeof comp.content === "string" ? comp.content : "";
        const isOpen = openModalId === comp.id;
        return (
          <div style={weightStyle}>
            <div onClick={() => setOpenModalId(comp.id)} style={{ display: "inline-block" }}>
              {renderNode(triggerId, ctx, depth + 1)}
            </div>
            {isOpen && (
              <div
                className="a2ui-modal-backdrop"
                role="dialog"
                aria-modal="true"
                aria-label={a11yLabel || "Dialog"}
                onClick={(e) => {
                  if (e.target === e.currentTarget) setOpenModalId(null);
                }}
              >
                <div className="a2ui-modal-dialog">
                  <button
                    type="button"
                    className="a2ui-btn borderless a2ui-modal-close"
                    aria-label="Close dialog"
                    onClick={() => setOpenModalId(null)}
                  >
                    <X size={16} aria-hidden="true" /> Close
                  </button>
                  {renderNode(contentId, ctx, depth + 1)}
                </div>
              </div>
            )}
          </div>
        );
      }
      default:
        return (
          <div className="a2ui-placeholder" aria-label={a11yLabel}>
            Unsupported component: {comp.component}
          </div>
        );
    }
  }

  return (
    <section className="a2ui-surface" aria-label={`Interactive UI ${surface.surfaceId}`}>
      {renderNode("root", { scopePath: "" }, 0)}
      {surface.state === "dispatched" && (
        <div className="a2ui-status-row">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <CheckCircle2 size={14} aria-hidden="true" />
            Dispatched to {surface.dispatchedBotName || "bot"}
          </span>
          {surface.dispatchedChatId && openChat && (
            <button type="button" className="a2ui-btn" onClick={() => openChat(surface.dispatchedChatId!)}>
              Open chat <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="a2ui-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
