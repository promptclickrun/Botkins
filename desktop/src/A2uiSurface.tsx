// Native React renderer for A2UI v1.0 Basic Catalog + Botkins Catalog surfaces on Botkins desktop.
// Supports per-component @catalogId mixing, Botkins UI components (BotAvatar, Badge, StatusBadge,
// Metric, Progress, Chart, Table, TaskCard, ApprovalCard), real inline HTML5 video/audio players
// (single active player, https/Botkins-served URLs only, no autoplay with sound), two-way function
// calls (callRendererFunction <-> rendererFunctionResponse, callAgentFunction <-> agentFunctionResponse),
// and safe plain-text-and-actions fallback for unknown catalogs or rich-cards-off mode.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BellOff,
  Bot,
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
  ShieldAlert,
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
  A2UI_BASIC_CATALOG_ID,
  A2UI_BOTKINS_CATALOG_ID,
  evaluateChecks,
  executeRendererFunctionCall,
  getDataAtPointer,
  hasUnsupportedA2uiComponent,
  isSafeA2uiMediaUrl,
  isSafeA2uiUrl,
  lookupCatalogFunction,
  resolveActionEvent,
  resolveDynamicBoolean,
  resolveDynamicNumber,
  resolveDynamicString,
  resolveDynamicStringList,
  resolveDynamicValue,
  setDataAtPointer,
  summarizeA2uiSurface,
} from "../desktop/link/a2ui.mjs";
import { errorText } from "./SettingsRows";
import type {
  A2uiActionPayload,
  A2uiComponent,
  A2uiFunctionRpcPayload,
  A2uiSurface as A2uiSurfaceData,
} from "./types";
import "./a2uiSurface.css";

// Single active media element coordinator across all A2UI surfaces in the desktop window.
let activeMediaElement: HTMLMediaElement | null = null;
function claimActiveMedia(el: HTMLMediaElement | null) {
  if (!el) return;
  if (activeMediaElement && activeMediaElement !== el) {
    try {
      activeMediaElement.pause();
    } catch {
      // ignore pause errors on detached media elements
    }
  }
  activeMediaElement = el;
}

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
  onFunctionRpc?: (chatId: string, payload: A2uiFunctionRpcPayload) => Promise<unknown>;
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

function activeThemeMode(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" || document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function InlineMediaPlayer({
  kind,
  url,
  posterUrl,
  description,
  style,
  onOpenLink,
}: {
  kind: "Video" | "AudioPlayer";
  url: string;
  posterUrl?: string;
  description?: string;
  style?: CSSProperties;
  onOpenLink: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  useEffect(() => {
    return () => {
      if (mediaRef.current && activeMediaElement === mediaRef.current) {
        activeMediaElement = null;
      }
    };
  }, []);

  const canPlayInline = isSafeA2uiMediaUrl(url) && !failed;
  const safeExternal = isSafeA2uiUrl(url);
  const safePoster = posterUrl && isSafeA2uiUrl(posterUrl, { allowDataImage: true }) ? posterUrl : undefined;

  if (!canPlayInline) {
    return (
      <div className="a2ui-media-fallback" style={style}>
        <span className="a2ui-text caption">{description || (kind === "Video" ? "Video clip" : "Audio track")}</span>
        {safeExternal ? (
          <button type="button" className="a2ui-btn borderless" onClick={() => onOpenLink(url)}>
            <ExternalLink size={13} aria-hidden="true" /> Open link
          </button>
        ) : (
          <span className="a2ui-text caption">Unsupported media URL</span>
        )}
      </div>
    );
  }

  if (kind === "Video") {
    return (
      <figure className="a2ui-media-box" style={style}>
        <video
          ref={(el) => {
            mediaRef.current = el;
          }}
          className="a2ui-video"
          src={url}
          poster={safePoster}
          controls
          playsInline
          preload="metadata"
          autoPlay={false}
          onPlay={(e) => claimActiveMedia(e.currentTarget)}
          onError={() => setFailed(true)}
        />
        {description && <figcaption className="a2ui-text caption">{description}</figcaption>}
      </figure>
    );
  }

  return (
    <div className="a2ui-media-box a2ui-audio-box" style={style}>
      {description && <div className="a2ui-audio-title">{description}</div>}
      <audio
        ref={(el) => {
          mediaRef.current = el;
        }}
        className="a2ui-audio"
        src={url}
        controls
        preload="metadata"
        autoPlay={false}
        onPlay={(e) => claimActiveMedia(e.currentTarget)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export default function A2uiSurface({
  chatId,
  surface,
  rich = true,
  readOnly = false,
  openChat,
  onAction,
  onFunctionRpc,
  onOpenLink,
}: Props) {
  const [dataModel, setDataModel] = useState<Record<string, unknown>>(() => structuredClone(surface.dataModel ?? {}));
  const [tabSelection, setTabSelection] = useState<Record<string, number>>({});
  const [openModalId, setOpenModalId] = useState<string | null>(null);
  const [choiceFilter, setChoiceFilter] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expandedDismissed, setExpandedDismissed] = useState(false);
  const handledCallsRef = useRef<Set<string>>(new Set());

  // Sync incoming live updates from updateDataModel / server state.
  useEffect(() => {
    setDataModel(structuredClone(surface.dataModel ?? {}));
  }, [surface.updatedAt, surface.surfaceId]);

  const byId = useMemo(() => {
    const m = new Map<string, A2uiComponent>();
    for (const c of surface.components ?? []) m.set(c.id, c);
    return m;
  }, [surface.components]);

  const sendFunctionRpc = async (payload: A2uiFunctionRpcPayload) => {
    if (onFunctionRpc) return onFunctionRpc(chatId, payload);
    if (typeof window !== "undefined" && window.botkins?.["chat.a2uiFunction"]) {
      return window.botkins["chat.a2uiFunction"](chatId, payload);
    }
    return null;
  };

  // Automatically process pending non-side-effecting callRendererFunction requests pushed by the host.
  useEffect(() => {
    const pending = surface.pendingRendererCalls ?? [];
    if (!pending.length) return;
    for (const call of pending) {
      if (!call?.functionCallId || handledCallsRef.current.has(call.functionCallId)) continue;
      handledCallsRef.current.add(call.functionCallId);
      void (async () => {
        const envelope = await executeRendererFunctionCall(
          { version: "1.0", callRendererFunction: call },
          {
            dataModel: surface.dataModel ?? {},
            surfaceCatalogId: surface.catalogId || A2UI_BASIC_CATALOG_ID,
            inlineCatalogs: surface.inlineCatalogs || [],
            themeMode: activeThemeMode(),
            userActivated: false,
            handlers: {
              openUrl: (u) => openExternal(u),
              copyToClipboard: async (txt) => {
                if (window.botkins?.copyText) {
                  await window.botkins.copyText(txt);
                  return true;
                }
                return false;
              },
            },
          },
        );
        try {
          await sendFunctionRpc({
            kind: "rendererFunctionResponse",
            surfaceId: surface.surfaceId,
            response: envelope.rendererFunctionResponse as { functionCallId: string; value?: unknown; error?: { code: string; message: string } },
          });
        } catch {
          // ignore if host already timed out or settled this correlation id
        }
      })();
    }
  }, [surface.pendingRendererCalls, surface.surfaceId]);

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
      const fn = actionObj.functionCall as { "@call": string; catalogId?: string; args?: Record<string, unknown> };
      const fnName = fn["@call"];
      const catalogId = fn.catalogId || comp["@catalogId"] || surface.catalogId || A2UI_BASIC_CATALOG_ID;
      if (fnName === "openUrl") {
        const url = resolveDynamicString(fn.args?.url, dataModel, ctx);
        openExternal(url);
        return;
      }
      if (fnName === "copyToClipboard") {
        const text = resolveDynamicString(fn.args?.text, dataModel, ctx);
        if (window.botkins?.copyText) await window.botkins.copyText(text);
        return;
      }
      // Check if function is declared and routable to agent via callAgentFunction
      const found = lookupCatalogFunction(fnName, catalogId, {
        surfaceCatalogId: surface.catalogId || A2UI_BASIC_CATALOG_ID,
        inlineCatalogs: surface.inlineCatalogs || [],
      });
      if (!found || found.def.allowedCallers === "rendererOnly") {
        setError(`Function "${fnName}" is not callable on the agent.`);
        return;
      }
      if (readOnly || busyId) return;
      const resolvedArgs: Record<string, unknown> = {};
      if (fn.args && typeof fn.args === "object") {
        for (const [k, v] of Object.entries(fn.args)) {
          resolvedArgs[k] = resolveDynamicValue(v, dataModel, ctx);
        }
      }
      const callId = `${surface.surfaceId}:${comp.id}:${fnName}:${Date.now()}`;
      setBusyId(comp.id);
      setError("");
      try {
        await sendFunctionRpc({
          kind: "callAgentFunction",
          surfaceId: surface.surfaceId,
          functionCallId: callId,
          callFunction: { "@call": fnName, catalogId, args: resolvedArgs },
          ...(surface.sendDataModel ? { dataModel } : {}),
        });
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusyId(null);
      }
      return;
    }

    if (!actionObj.event) return;
    if (readOnly || busyId) return;

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

  // Rich-cards-off mode OR unknown catalog/component fallback: plain text summary + interactive action buttons.
  const unsupported = hasUnsupportedA2uiComponent(surface);
  if (!rich || unsupported) {
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

  function renderBotkinsComponent(comp: A2uiComponent, ctx: RenderCtx, depth: number, weightStyle: CSSProperties, a11yLabel?: string): ReactNode {
    const tone = typeof comp.tone === "string" ? comp.tone : "neutral";
    switch (comp.component) {
      case "BotAvatar": {
        const name = resolveDynamicString(comp.name, dataModel, ctx);
        const role = comp.role !== undefined ? resolveDynamicString(comp.role, dataModel, ctx) : "";
        const status = typeof comp.status === "string" ? comp.status : "";
        const size = typeof comp.size === "string" ? comp.size : "md";
        const initials = name.trim().slice(0, 2).toUpperCase() || "B";
        return (
          <div className={`a2ui-bot-avatar ${size}`} style={weightStyle} aria-label={a11yLabel || name}>
            <div className="a2ui-bot-avatar-badge" aria-hidden="true">
              <Bot size={size === "sm" ? 13 : size === "lg" ? 18 : 15} />
              <span className="a2ui-bot-avatar-initials">{initials}</span>
            </div>
            <div className="a2ui-bot-avatar-meta">
              <span className="a2ui-bot-avatar-name">{name}</span>
              {role && <span className="a2ui-text caption">{role}</span>}
            </div>
            {status && <span className={`a2ui-badge tone-${status === "error" ? "negative" : status === "working" ? "accent" : status === "online" ? "positive" : "neutral"}`}>{status}</span>}
          </div>
        );
      }
      case "Badge": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const iconName = comp.icon !== undefined ? resolveDynamicString(comp.icon, dataModel, ctx) : "";
        const IconComp = iconName && ICON_MAP[iconName] ? ICON_MAP[iconName] : null;
        return (
          <span className={`a2ui-badge tone-${tone}`} style={weightStyle} aria-label={a11yLabel || label}>
            {IconComp && <IconComp size={12} aria-hidden="true" />}
            {label}
          </span>
        );
      }
      case "StatusBadge": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const pulse = comp.pulse !== undefined ? resolveDynamicBoolean(comp.pulse, dataModel, ctx) : false;
        return (
          <span className={`a2ui-badge a2ui-status-badge tone-${tone}`} style={weightStyle} aria-label={a11yLabel || label}>
            <span className={`a2ui-status-dot${pulse ? " pulse" : ""}`} aria-hidden="true" />
            {label}
          </span>
        );
      }
      case "Metric": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const value = resolveDynamicString(comp.value, dataModel, ctx);
        const note = comp.note !== undefined ? resolveDynamicString(comp.note, dataModel, ctx) : "";
        const delta = comp.delta !== undefined ? resolveDynamicString(comp.delta, dataModel, ctx) : "";
        return (
          <div className={`a2ui-metric tone-${tone}`} style={weightStyle} aria-label={a11yLabel || `${label}: ${value}`}>
            <span className="a2ui-metric-label">{label}</span>
            <div className="a2ui-metric-value-row">
              <span className="a2ui-metric-value">{value}</span>
              {delta && <span className={`a2ui-badge tone-${tone}`}>{delta}</span>}
            </div>
            {note && <span className="a2ui-text caption">{note}</span>}
          </div>
        );
      }
      case "Progress": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const val = resolveDynamicNumber(comp.value, dataModel, ctx);
        const max = Math.max(1e-6, resolveDynamicNumber(comp.max, dataModel, ctx) || 100);
        const pct = Math.max(0, Math.min(100, (val / max) * 100));
        const note = comp.note !== undefined ? resolveDynamicString(comp.note, dataModel, ctx) : `${Math.round(pct)}%`;
        return (
          <div className={`a2ui-progress tone-${tone}`} style={weightStyle} role="progressbar" aria-label={a11yLabel || label} aria-valuenow={val} aria-valuemin={0} aria-valuemax={max}>
            <div className="a2ui-slider-head">
              <span className="a2ui-field-label">{label}</span>
              <span className="a2ui-text caption">{note}</span>
            </div>
            <div className="a2ui-progress-track">
              <div className="a2ui-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      }
      case "Chart": {
        const kind = comp.kind === "line" ? "line" : "bar";
        const title = comp.title !== undefined ? resolveDynamicString(comp.title, dataModel, ctx) : "";
        const unit = comp.unit !== undefined ? resolveDynamicString(comp.unit, dataModel, ctx) : "";
        const rawItems = comp.items !== undefined ? resolveDynamicValue(comp.items, dataModel, ctx) : null;
        const rawLabels = comp.labels !== undefined ? resolveDynamicValue(comp.labels, dataModel, ctx) : null;
        const rawSeries = comp.series !== undefined ? resolveDynamicValue(comp.series, dataModel, ctx) : null;

        if (kind === "bar") {
          const items: Array<{ label: string; value: number }> = Array.isArray(rawItems)
            ? rawItems.map((it: any) => ({ label: String(it?.label ?? ""), value: Number(it?.value ?? 0) || 0 }))
            : Array.isArray(rawSeries) && rawSeries[0]?.values
              ? (rawSeries[0].values as number[]).map((v, idx) => ({
                  label: Array.isArray(rawLabels) && rawLabels[idx] !== undefined ? String(rawLabels[idx]) : `#${idx + 1}`,
                  value: Number(v) || 0,
                }))
              : [];
          const maxVal = Math.max(1, ...items.map((i) => Math.abs(i.value)));
          return (
            <div className="a2ui-chart" style={weightStyle} aria-label={a11yLabel || title || "Bar chart"}>
              {title && <div className="a2ui-chart-title">{title}</div>}
              <div className="a2ui-bars">
                {items.map((item, idx) => (
                  <div className="a2ui-bar-row" key={`${item.label}-${idx}`}>
                    <span className="a2ui-bar-label">{item.label}</span>
                    <div className="a2ui-bar-track">
                      <div className="a2ui-bar-fill" style={{ width: `${Math.max(2, (Math.abs(item.value) / maxVal) * 100)}%` }} />
                    </div>
                    <span className="a2ui-bar-val">
                      {item.value}
                      {unit ? ` ${unit}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }

        // Line chart rendered as responsive inline SVG
        const seriesList: Array<{ name: string; values: number[] }> = Array.isArray(rawSeries)
          ? rawSeries.map((s: any, idx: number) => ({
              name: String(s?.name ?? `Series ${idx + 1}`),
              values: Array.isArray(s?.values) ? s.values.map((v: any) => Number(v) || 0) : [],
            }))
          : Array.isArray(rawItems)
            ? [{ name: title || "Value", values: rawItems.map((it: any) => Number(it?.value ?? 0) || 0) }]
            : [];
        const labels: string[] = Array.isArray(rawLabels)
          ? rawLabels.map(String)
          : Array.isArray(rawItems)
            ? rawItems.map((it: any) => String(it?.label ?? ""))
            : [];
        const allVals = seriesList.flatMap((s) => s.values);
        const minV = allVals.length ? Math.min(...allVals) : 0;
        const maxV = allVals.length ? Math.max(...allVals) : 1;
        const span = Math.max(1e-6, maxV - minV);
        const W = 320;
        const H = 120;
        const PAD = 14;
        const palette = ["var(--accent)", "#10b981", "#f59e0b", "#6366f1"];
        return (
          <div className="a2ui-chart" style={weightStyle} aria-label={a11yLabel || title || "Line chart"}>
            {title && <div className="a2ui-chart-title">{title}</div>}
            <svg viewBox={`0 0 ${W} ${H}`} className="a2ui-line-svg" role="img" aria-label={title || "Line chart"}>
              <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="currentColor" strokeOpacity="0.16" />
              <line x1={PAD} y1={PAD} x2={W - PAD} y2={PAD} stroke="currentColor" strokeOpacity="0.08" />
              {seriesList.map((s, si) => {
                const count = Math.max(1, s.values.length - 1);
                const pts = s.values
                  .map((v, i) => {
                    const x = PAD + (i / count) * (W - PAD * 2);
                    const y = H - PAD - ((v - minV) / span) * (H - PAD * 2);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(" ");
                return (
                  <g key={s.name}>
                    <polyline fill="none" stroke={palette[si % palette.length]} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" points={pts} />
                    {s.values.map((v, i) => {
                      const x = PAD + (i / count) * (W - PAD * 2);
                      const y = H - PAD - ((v - minV) / span) * (H - PAD * 2);
                      return <circle key={i} cx={x} cy={y} r="3" fill={palette[si % palette.length]} />;
                    })}
                  </g>
                );
              })}
            </svg>
            {labels.length > 0 && (
              <div className="a2ui-chart-axis">
                {labels.map((l, i) => (
                  <span key={`${l}-${i}`}>{l}</span>
                ))}
              </div>
            )}
          </div>
        );
      }
      case "Table": {
        const title = comp.title !== undefined ? resolveDynamicString(comp.title, dataModel, ctx) : "";
        const emptyText = comp.emptyText !== undefined ? resolveDynamicString(comp.emptyText, dataModel, ctx) : "No rows";
        const colsRaw = resolveDynamicValue(comp.columns, dataModel, ctx);
        const rowsRaw = resolveDynamicValue(comp.rows, dataModel, ctx);
        const columns: string[] = Array.isArray(colsRaw) ? colsRaw.map(String) : [];
        const rows: string[][] = Array.isArray(rowsRaw)
          ? rowsRaw.map((r) => (Array.isArray(r) ? r.map((cell) => String(cell ?? "")) : [String(r ?? "")]))
          : [];
        return (
          <div className="a2ui-table-wrap" style={weightStyle} aria-label={a11yLabel || title || "Table"}>
            {title && <div className="a2ui-chart-title">{title}</div>}
            {rows.length === 0 ? (
              <p className="a2ui-text caption">{emptyText}</p>
            ) : (
              <table className="a2ui-table">
                <thead>
                  <tr>
                    {columns.map((c, idx) => (
                      <th key={`${c}-${idx}`}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      }
      case "TaskCard": {
        const title = resolveDynamicString(comp.title, dataModel, ctx);
        const summary = comp.summary !== undefined ? resolveDynamicString(comp.summary, dataModel, ctx) : "";
        const status = comp.status !== undefined ? resolveDynamicString(comp.status, dataModel, ctx) : "";
        const priority = typeof comp.priority === "string" ? comp.priority : "";
        const botName = comp.botName !== undefined ? resolveDynamicString(comp.botName, dataModel, ctx) : "";
        const due = comp.due !== undefined ? resolveDynamicString(comp.due, dataModel, ctx) : "";
        const actionLabel = comp.actionLabel !== undefined ? resolveDynamicString(comp.actionLabel, dataModel, ctx) : "Open";
        const prioTone = priority === "urgent" ? "negative" : priority === "high" ? "warning" : "neutral";
        return (
          <div className="a2ui-botkins-card" style={weightStyle} aria-label={a11yLabel || title}>
            <div className="a2ui-botkins-card-head">
              <strong className="a2ui-botkins-card-title">{title}</strong>
              <div className="a2ui-row" style={{ gap: 6 }}>
                {priority && <span className={`a2ui-badge tone-${prioTone}`}>{priority}</span>}
                {status && <span className="a2ui-badge tone-accent">{status}</span>}
              </div>
            </div>
            {summary && <p className="a2ui-text">{summary}</p>}
            {(botName || due) && (
              <div className="a2ui-text caption">
                {[botName ? `Bot: ${botName}` : "", due ? `Due: ${due}` : ""].filter(Boolean).join(" · ")}
              </div>
            )}
            {typeof comp.child === "string" && renderNode(comp.child, ctx, depth + 1)}
            {Boolean(comp.action) && (
              <div className="a2ui-row" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="a2ui-btn primary"
                  disabled={readOnly || busyId !== null}
                  onClick={() => void triggerAction(comp, comp.action, ctx)}
                >
                  {busyId === comp.id ? "Working…" : actionLabel}
                </button>
              </div>
            )}
          </div>
        );
      }
      case "ApprovalCard": {
        const title = resolveDynamicString(comp.title, dataModel, ctx);
        const summary = comp.summary !== undefined ? resolveDynamicString(comp.summary, dataModel, ctx) : "";
        const status = typeof comp.status === "string" ? comp.status : "pending";
        const risk = typeof comp.risk === "string" ? comp.risk : "";
        const approveLabel = comp.approveLabel !== undefined ? resolveDynamicString(comp.approveLabel, dataModel, ctx) : "Approve";
        const rejectLabel = comp.rejectLabel !== undefined ? resolveDynamicString(comp.rejectLabel, dataModel, ctx) : "Reject";
        const riskTone = risk === "high" ? "negative" : risk === "medium" ? "warning" : "positive";
        return (
          <div className={`a2ui-botkins-card a2ui-approval-card status-${status}`} style={weightStyle} aria-label={a11yLabel || title}>
            <div className="a2ui-botkins-card-head">
              <span className="a2ui-botkins-card-title" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <ShieldAlert size={15} aria-hidden="true" />
                {title}
              </span>
              <div className="a2ui-row" style={{ gap: 6 }}>
                {risk && <span className={`a2ui-badge tone-${riskTone}`}>{risk} risk</span>}
                <span className={`a2ui-badge tone-${status === "approved" ? "positive" : status === "rejected" ? "negative" : "warning"}`}>
                  {status}
                </span>
              </div>
            </div>
            {summary && <p className="a2ui-text">{summary}</p>}
            {typeof comp.child === "string" && renderNode(comp.child, ctx, depth + 1)}
            {status === "pending" && (Boolean(comp.approveAction) || Boolean(comp.rejectAction)) && (
              <div className="a2ui-row" style={{ gap: 8 }}>
                {Boolean(comp.approveAction) && (
                  <button
                    type="button"
                    className="a2ui-btn primary"
                    disabled={readOnly || busyId !== null}
                    onClick={() => void triggerAction({ ...comp, id: `${comp.id}:approve` }, comp.approveAction, ctx)}
                  >
                    {busyId === `${comp.id}:approve` ? "Working…" : approveLabel}
                  </button>
                )}
                {Boolean(comp.rejectAction) && (
                  <button
                    type="button"
                    className="a2ui-btn default"
                    disabled={readOnly || busyId !== null}
                    onClick={() => void triggerAction({ ...comp, id: `${comp.id}:reject` }, comp.rejectAction, ctx)}
                  >
                    {busyId === `${comp.id}:reject` ? "Working…" : rejectLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      }
      default:
        return null;
    }
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

    const effectiveCatalog = comp["@catalogId"] || surface.catalogId || A2UI_BASIC_CATALOG_ID;
    if (effectiveCatalog === A2UI_BOTKINS_CATALOG_ID) {
      const botkinsNode = renderBotkinsComponent(comp, ctx, depth, weightStyle, a11yLabel);
      if (botkinsNode) return botkinsNode;
    }

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
        const posterUrl = comp.posterUrl !== undefined ? resolveDynamicString(comp.posterUrl, dataModel, ctx) : undefined;
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : undefined;
        return (
          <InlineMediaPlayer
            kind={comp.component}
            url={url}
            posterUrl={posterUrl}
            description={desc}
            style={weightStyle}
            onOpenLink={openExternal}
          />
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
