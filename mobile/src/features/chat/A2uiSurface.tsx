// Native React Native renderer for A2UI v1.0 Basic Catalog + Botkins Catalog surfaces on Botkins mobile.
// Supports per-component @catalogId mixing, Botkins UI kit components (BotAvatar, Badge, StatusBadge,
// Metric, Progress, Chart, Table, TaskCard, ApprovalCard), real inline AudioPlayer (via expo-audio)
// and Video (via react-native-webview HTML5 <video controls playsinline>, zero new native deps,
// single active player coordinator, https/Botkins-served URLs only, no autoplay with sound),
// bidirectional function calls, and safe plain-text-and-actions fallback for unknown catalogs or rich-cards-off.
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
  Folder,
  Heart,
  Home,
  Image as ImageIcon,
  Info,
  Lock,
  LockOpen,
  Mail,
  MapPin,
  Menu,
  Minus,
  Paperclip,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Share2,
  ShieldAlert,
  ShoppingCart,
  Square,
  Star,
  Trash2,
  Upload,
  User,
  UserCircle,
  Volume2,
  X,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Modal as RNModal, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { Svg, Circle, Line, Polyline } from "react-native-svg";
import type { A2uiActionPayload, A2uiComponent, A2uiFunctionRpcPayload, A2uiSurface as A2uiSurfaceData } from "@/link/types";
import { chatA2uiAction, chatA2uiFunction } from "@/state/link";
import { openLink } from "@/ui/LinkHold";
import { Badge, Button, radius, space, T, Tap, useTheme } from "@/ui";
import { audioModule } from "@/features/voice/native";
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
} from "../../../link-host/a2ui.mjs";
import { openChat } from "./navigate";

// Single active media coordinator across all A2UI surfaces on the phone.
let activeMediaStop: (() => void) | null = null;
function claimMobileMedia(stopFn: () => void) {
  if (activeMediaStop && activeMediaStop !== stopFn) {
    try {
      activeMediaStop();
    } catch {
      // ignore stop errors on unmounted players
    }
  }
  activeMediaStop = stopFn;
}

function loadWebView(): any | null {
  try {
    const mod = require("react-native-webview");
    return mod?.WebView ?? mod?.default ?? null;
  } catch {
    return null;
  }
}

const ICON_MAP: Record<string, typeof Info> = {
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
  favorite: Heart,
  folder: Folder,
  help: CircleHelp,
  home: Home,
  info: Info,
  locationOn: MapPin,
  lock: Lock,
  lockOpen: LockOpen,
  mail: Mail,
  menu: Menu,
  notificationsOff: BellOff,
  notifications: Bell,
  pause: Pause,
  payment: CreditCard,
  person: User,
  phone: Phone,
  photo: ImageIcon,
  play: Play,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  share: Share2,
  shoppingCart: ShoppingCart,
  star: Star,
  stop: Square,
  upload: Upload,
  visibility: Eye,
  visibilityOff: EyeOff,
  warning: AlertTriangle,
};

type RenderCtx = {
  scopePath: string;
  itemIndex?: number;
};

type Props = {
  chatId: string;
  surface: A2uiSurfaceData;
  rich: boolean;
  onOpenChat?: (chatId: string) => void;
  onAction?: (chatId: string, payload: A2uiActionPayload) => Promise<unknown>;
  onFunctionRpc?: (chatId: string, payload: A2uiFunctionRpcPayload) => Promise<unknown>;
};

function boundPathOf(v: unknown, scopePath: string): string | null {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)["@path"] === "string") {
    const raw = (v as Record<string, string>)["@path"];
    if (raw.startsWith("/")) return raw;
    return scopePath ? `${scopePath.replace(/\/$/, "")}/${raw}` : `/${raw}`;
  }
  return null;
}

function justifyStyle(v: unknown) {
  switch (v) {
    case "center":
      return "center" as const;
    case "end":
      return "flex-end" as const;
    case "spaceBetween":
      return "space-between" as const;
    case "spaceAround":
      return "space-around" as const;
    case "spaceEvenly":
      return "space-evenly" as const;
    default:
      return "flex-start" as const;
  }
}

function alignStyle(v: unknown) {
  switch (v) {
    case "center":
      return "center" as const;
    case "end":
      return "flex-end" as const;
    case "stretch":
      return "stretch" as const;
    default:
      return "flex-start" as const;
  }
}

function MobileInlineAudioPlayer({ url, description }: { url: string; description?: string }) {
  const { colors } = useTheme();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const playerRef = useRef<any>(null);

  const stopPlayer = () => {
    try {
      playerRef.current?.pause?.();
    } catch {
      // ignore
    }
    setPlaying(false);
  };

  useEffect(() => {
    return () => {
      try {
        playerRef.current?.pause?.();
        playerRef.current?.remove?.();
      } catch {
        // ignore
      }
      playerRef.current = null;
      if (activeMediaStop === stopPlayer) activeMediaStop = null;
    };
  }, [url]);

  const audio = audioModule();
  const canPlay = isSafeA2uiMediaUrl(url) && !!audio && !failed;
  const safeExternal = isSafeA2uiUrl(url);

  if (!canPlay) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          padding: space.sm,
          borderRadius: radius.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          backgroundColor: colors.sunken,
        }}
      >
        <T variant="footnote" color="muted" style={{ flex: 1 }}>
          {description || "Audio clip"}
        </T>
        {safeExternal && (
          <Button title="Open" icon={ExternalLink} variant="secondary" size="sm" onPress={() => openLink(url)} accessibilityLabel={`Open ${description || "audio"}`} />
        )}
      </View>
    );
  }

  const togglePlay = () => {
    try {
      if (!playerRef.current) {
        playerRef.current = audio.createAudioPlayer({ uri: url });
      }
      if (playing) {
        stopPlayer();
      } else {
        claimMobileMedia(stopPlayer);
        playerRef.current.play();
        setPlaying(true);
      }
    } catch {
      setFailed(true);
    }
  };

  return (
    <View
      accessibilityLabel={`Audio player ${description || ""}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        padding: space.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.sunken,
      }}
    >
      <Button
        title={playing ? "Pause" : "Play"}
        icon={playing ? Pause : Play}
        variant="primary"
        size="sm"
        accessibilityLabel={playing ? "Pause audio" : "Play audio"}
        onPress={togglePlay}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="footnote" weight="600" numberOfLines={1}>
          {description || "Audio track"}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Volume2 size={12} color={colors.muted} />
          <T variant="caption" color="muted">
            {playing ? "Playing via expo-audio" : "Ready"}
          </T>
        </View>
      </View>
    </View>
  );
}

function MobileInlineVideoPlayer({ url, posterUrl, description }: { url: string; posterUrl?: string; description?: string }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const webRef = useRef<any>(null);
  const WebViewComp = useMemo(() => loadWebView(), []);

  const pauseVideo = () => {
    try {
      webRef.current?.injectJavaScript?.("document.querySelector('video')?.pause();true;");
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    return () => {
      if (activeMediaStop === pauseVideo) activeMediaStop = null;
    };
  }, [url]);

  const canPlay = isSafeA2uiMediaUrl(url) && !!WebViewComp && !failed;
  const safeExternal = isSafeA2uiUrl(url);
  const safePoster = posterUrl && isSafeA2uiUrl(posterUrl, { allowDataImage: true }) ? posterUrl : "";

  if (!canPlay) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          padding: space.sm,
          borderRadius: radius.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          backgroundColor: colors.sunken,
        }}
      >
        <T variant="footnote" color="muted" style={{ flex: 1 }}>
          {description || "Video clip"}
        </T>
        {safeExternal && (
          <Button title="Open" icon={ExternalLink} variant="secondary" size="sm" onPress={() => openLink(url)} accessibilityLabel={`Open ${description || "video"}`} />
        )}
      </View>
    );
  }

  const escapedSrc = JSON.stringify(url);
  const escapedPoster = safePoster ? JSON.stringify(safePoster) : "null";
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;padding:0;background:#000;width:100%;height:100%;overflow:hidden}video{width:100%;height:100%;object-fit:contain;display:block}</style></head><body><video id="v" controls playsinline preload="metadata"></video><script>const v=document.getElementById('v');v.src=${escapedSrc};const p=${escapedPoster};if(p)v.poster=p;v.addEventListener('play',()=>window.ReactNativeWebView&&window.ReactNativeWebView.postMessage('play'));v.addEventListener('error',()=>window.ReactNativeWebView&&window.ReactNativeWebView.postMessage('error'));</script></body></html>`;

  return (
    <View
      accessibilityLabel={`Video player ${description || ""}`}
      style={{
        borderRadius: radius.sm,
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.sunken,
      }}
    >
      <View style={{ width: "100%", height: 200, backgroundColor: "#000" }}>
        <WebViewComp
          ref={webRef}
          source={{ html }}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction
          javaScriptEnabled
          onMessage={(ev: any) => {
            const msg = ev?.nativeEvent?.data;
            if (msg === "play") claimMobileMedia(pauseVideo);
            else if (msg === "error") setFailed(true);
          }}
          onError={() => setFailed(true)}
        />
      </View>
      {!!description && (
        <View style={{ padding: space.xs }}>
          <T variant="caption" color="muted">
            {description}
          </T>
        </View>
      )}
    </View>
  );
}

export function A2uiSurface({ chatId, surface, rich, onOpenChat, onAction, onFunctionRpc }: Props) {
  const { colors, dark } = useTheme();
  const [dataModel, setDataModel] = useState<Record<string, unknown>>(() => structuredClone(surface.dataModel ?? {}));
  const [tabSelection, setTabSelection] = useState<Record<string, number>>({});
  const [openModalId, setOpenModalId] = useState<string | null>(null);
  const [choiceFilter, setChoiceFilter] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expandedDismissed, setExpandedDismissed] = useState(false);
  const handledCallsRef = useRef<Set<string>>(new Set());

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
    return chatA2uiFunction(chatId, payload);
  };

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
            themeMode: dark ? "dark" : "light",
            userActivated: false,
            handlers: {
              openUrl: (u) => {
                if (isSafeA2uiUrl(u)) openLink(u);
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
          // ignore if already settled
        }
      })();
    }
  }, [surface.pendingRendererCalls, surface.surfaceId]);

  if (surface.deleted) return null;

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
        if (isSafeA2uiUrl(url)) openLink(url);
        return;
      }
      const found = lookupCatalogFunction(fnName, catalogId, {
        surfaceCatalogId: surface.catalogId || A2UI_BASIC_CATALOG_ID,
        inlineCatalogs: surface.inlineCatalogs || [],
      });
      if (!found || found.def.allowedCallers === "rendererOnly") {
        setError(`Function "${fnName}" is not callable on the agent.`);
        return;
      }
      if (busyId) return;
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
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
      return;
    }
    if (!actionObj.event || busyId) return;

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
      else await chatA2uiAction(chatId, payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Rich-cards-off mode OR unknown catalog/component fallback: plain text summary + interactive action buttons.
  const unsupported = hasUnsupportedA2uiComponent(surface);
  if (!rich || unsupported) {
    const summary = summarizeA2uiSurface({ ...surface, dataModel });
    return (
      <View
        accessible
        accessibilityLabel={`Interactive UI ${surface.surfaceId}`}
        style={{
          backgroundColor: colors.sunken,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          padding: space.md,
          gap: space.sm,
        }}
      >
        {summary.lines.length > 0 ? (
          summary.lines.map((line, idx) => (
            <T key={idx} variant="footnote" color="muted">
              {line}
            </T>
          ))
        ) : (
          <T variant="footnote" color="muted">
            {`Interactive UI (${surface.surfaceId})`}
          </T>
        )}
        {summary.actions.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {summary.actions.map((act, idx) => {
              const comp = byId.get(act.componentId) ?? { id: act.componentId, component: "Button" };
              return (
                <Button
                  key={`${act.componentId}-${idx}`}
                  title={act.label}
                  variant={act.variant === "primary" ? "primary" : "secondary"}
                  size="sm"
                  loading={busyId === act.componentId}
                  disabled={busyId !== null}
                  accessibilityLabel={act.label}
                  onPress={() => void triggerAction(comp, act.action, { scopePath: act.scopePath, itemIndex: act.itemIndex })}
                />
              );
            })}
          </View>
        )}
        {!!error && (
          <T variant="footnote" color="danger">
            {error}
          </T>
        )}
      </View>
    );
  }

  const renderChildren = (children: unknown, ctx: RenderCtx, depth: number): ReactNode => {
    if (Array.isArray(children)) {
      return children.map((cid, idx) => (
        <View key={`${String(cid)}-${idx}`}>{renderNode(String(cid), ctx, depth + 1)}</View>
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
        <View key={`${tpl.componentId}-${idx}`}>{renderNode(tpl.componentId, { scopePath: `${base}/${idx}`, itemIndex: idx }, depth + 1)}</View>
      ));
    }
    return null;
  };

  const labelOfChild = (compId: string, ctx: RenderCtx): string => {
    const child = byId.get(compId);
    if (!child) return "";
    if (child.component === "Text") return resolveDynamicString(child.text, dataModel, ctx);
    if (child.component === "Row" && Array.isArray(child.children)) {
      return child.children.map((id) => labelOfChild(String(id), ctx)).filter(Boolean).join(" ");
    }
    return "";
  };

  const badgeTone = (t: unknown): "neutral" | "accent" | "success" | "warning" | "danger" => {
    if (t === "positive") return "success";
    if (t === "negative") return "danger";
    if (t === "warning") return "warning";
    if (t === "accent") return "accent";
    return "neutral";
  };

  const renderBotkinsComponent = (comp: A2uiComponent, ctx: RenderCtx, depth: number, flexStyle: any, a11yLabel?: string): ReactNode => {
    switch (comp.component) {
      case "BotAvatar": {
        const name = resolveDynamicString(comp.name, dataModel, ctx);
        const role = comp.role !== undefined ? resolveDynamicString(comp.role, dataModel, ctx) : "";
        const status = typeof comp.status === "string" ? comp.status : "";
        return (
          <View accessibilityLabel={a11yLabel || name} style={[{ flexDirection: "row", alignItems: "center", gap: space.sm }, flexStyle]}>
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: colors.sunken,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Bot size={16} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <T variant="footnote" weight="600">
                {name}
              </T>
              {!!role && (
                <T variant="caption" color="muted">
                  {role}
                </T>
              )}
            </View>
            {!!status && <Badge label={status} tone={status === "error" ? "danger" : status === "online" ? "success" : "accent"} />}
          </View>
        );
      }
      case "Badge":
      case "StatusBadge": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        return <Badge label={label} tone={badgeTone(comp.tone)} />;
      }
      case "Metric": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const value = resolveDynamicString(comp.value, dataModel, ctx);
        const note = comp.note !== undefined ? resolveDynamicString(comp.note, dataModel, ctx) : "";
        const delta = comp.delta !== undefined ? resolveDynamicString(comp.delta, dataModel, ctx) : "";
        return (
          <View
            accessibilityLabel={a11yLabel || `${label}: ${value}`}
            style={[
              {
                padding: space.sm,
                borderRadius: radius.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                backgroundColor: colors.sunken,
                gap: 2,
                minWidth: 108,
              },
              flexStyle,
            ]}
          >
            <T variant="caption" color="muted">
              {label}
            </T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <T variant="headline" weight="700">
                {value}
              </T>
              {!!delta && <Badge label={delta} tone={badgeTone(comp.tone)} />}
            </View>
            {!!note && (
              <T variant="caption" color="muted">
                {note}
              </T>
            )}
          </View>
        );
      }
      case "Progress": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const val = resolveDynamicNumber(comp.value, dataModel, ctx);
        const max = Math.max(1e-6, resolveDynamicNumber(comp.max, dataModel, ctx) || 100);
        const pct = Math.max(0, Math.min(100, (val / max) * 100));
        const note = comp.note !== undefined ? resolveDynamicString(comp.note, dataModel, ctx) : `${Math.round(pct)}%`;
        return (
          <View accessibilityLabel={a11yLabel || `${label} ${Math.round(pct)}%`} style={[{ gap: 4 }, flexStyle]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <T variant="footnote" weight="600">
                {label}
              </T>
              <T variant="caption" color="muted">
                {note}
              </T>
            </View>
            <View style={{ height: 7, borderRadius: 99, backgroundColor: colors.sunken, overflow: "hidden" }}>
              <View style={{ height: "100%", width: `${pct}%`, borderRadius: 99, backgroundColor: colors.accent }} />
            </View>
          </View>
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
            <View
              accessibilityLabel={a11yLabel || title || "Bar chart"}
              style={[
                {
                  padding: space.sm,
                  borderRadius: radius.sm,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.line,
                  backgroundColor: colors.sunken,
                  gap: 6,
                },
                flexStyle,
              ]}
            >
              {!!title && (
                <T variant="footnote" weight="600">
                  {title}
                </T>
              )}
              {items.map((item, idx) => (
                <View key={`${item.label}-${idx}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                  <T variant="caption" color="muted" style={{ width: 68 }} numberOfLines={1}>
                    {item.label}
                  </T>
                  <View style={{ flex: 1, height: 8, borderRadius: 99, backgroundColor: colors.line, overflow: "hidden" }}>
                    <View style={{ height: "100%", width: `${Math.max(2, (Math.abs(item.value) / maxVal) * 100)}%`, backgroundColor: colors.accent }} />
                  </View>
                  <T variant="caption" weight="600">
                    {`${item.value}${unit ? ` ${unit}` : ""}`}
                  </T>
                </View>
              ))}
            </View>
          );
        }

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
        const W = 280;
        const H = 110;
        const PAD = 12;
        const palette = [colors.accent, "#10b981", "#f59e0b", "#6366f1"];
        return (
          <View
            accessibilityLabel={a11yLabel || title || "Line chart"}
            style={[
              {
                padding: space.sm,
                borderRadius: radius.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                backgroundColor: colors.sunken,
                gap: 6,
              },
              flexStyle,
            ]}
          >
            {!!title && (
              <T variant="footnote" weight="600">
                {title}
              </T>
            )}
            <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
              <Line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke={colors.line} strokeWidth={1} />
              {seriesList.map((s, si) => {
                const count = Math.max(1, s.values.length - 1);
                const pts = s.values
                  .map((v, i) => {
                    const x = PAD + (i / count) * (W - PAD * 2);
                    const y = H - PAD - ((v - minV) / span) * (H - PAD * 2);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(" ");
                const stroke = palette[si % palette.length];
                return (
                  <View key={s.name}>
                    <Polyline fill="none" stroke={stroke} strokeWidth={2.2} points={pts} />
                    {s.values.map((v, i) => {
                      const x = PAD + (i / count) * (W - PAD * 2);
                      const y = H - PAD - ((v - minV) / span) * (H - PAD * 2);
                      return <Circle key={i} cx={x} cy={y} r={3} fill={stroke} />;
                    })}
                  </View>
                );
              })}
            </Svg>
            {labels.length > 0 && (
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                {labels.map((l, i) => (
                  <T key={`${l}-${i}`} variant="caption" color="muted">
                    {l}
                  </T>
                ))}
              </View>
            )}
          </View>
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
          <View
            accessibilityLabel={a11yLabel || title || "Table"}
            style={[
              {
                borderRadius: radius.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                overflow: "hidden",
              },
              flexStyle,
            ]}
          >
            {!!title && (
              <View style={{ padding: space.xs, backgroundColor: colors.sunken }}>
                <T variant="footnote" weight="600">
                  {title}
                </T>
              </View>
            )}
            {rows.length === 0 ? (
              <View style={{ padding: space.sm }}>
                <T variant="caption" color="muted">
                  {emptyText}
                </T>
              </View>
            ) : (
              <View>
                <View style={{ flexDirection: "row", backgroundColor: colors.sunken, padding: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}>
                  {columns.map((c, idx) => (
                    <T key={`${c}-${idx}`} variant="caption" weight="600" color="muted" style={{ flex: 1 }}>
                      {c}
                    </T>
                  ))}
                </View>
                {rows.map((row, ri) => (
                  <View key={ri} style={{ flexDirection: "row", padding: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}>
                    {row.map((cell, ci) => (
                      <T key={ci} variant="footnote" style={{ flex: 1 }}>
                        {cell}
                      </T>
                    ))}
                  </View>
                ))}
              </View>
            )}
          </View>
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
        return (
          <View
            accessibilityLabel={a11yLabel || title}
            style={[
              {
                padding: space.md,
                borderRadius: radius.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                backgroundColor: colors.sunken,
                gap: space.xs,
              },
              flexStyle,
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs }}>
              <T variant="body" weight="600" style={{ flex: 1 }}>
                {title}
              </T>
              {!!priority && <Badge label={priority} tone={priority === "urgent" ? "danger" : priority === "high" ? "warning" : "neutral"} />}
              {!!status && <Badge label={status} tone="accent" />}
            </View>
            {!!summary && (
              <T variant="footnote" color="muted">
                {summary}
              </T>
            )}
            {(!!botName || !!due) && (
              <T variant="caption" color="muted">
                {[botName ? `Bot: ${botName}` : "", due ? `Due: ${due}` : ""].filter(Boolean).join(" · ")}
              </T>
            )}
            {typeof comp.child === "string" && renderNode(comp.child, ctx, depth + 1)}
            {!!comp.action && (
              <View style={{ alignItems: "flex-end", marginTop: 4 }}>
                <Button
                  title={actionLabel}
                  variant="primary"
                  size="sm"
                  loading={busyId === comp.id}
                  disabled={busyId !== null}
                  onPress={() => void triggerAction(comp, comp.action, ctx)}
                  accessibilityLabel={actionLabel}
                />
              </View>
            )}
          </View>
        );
      }
      case "ApprovalCard": {
        const title = resolveDynamicString(comp.title, dataModel, ctx);
        const summary = comp.summary !== undefined ? resolveDynamicString(comp.summary, dataModel, ctx) : "";
        const status = typeof comp.status === "string" ? comp.status : "pending";
        const risk = typeof comp.risk === "string" ? comp.risk : "";
        const approveLabel = comp.approveLabel !== undefined ? resolveDynamicString(comp.approveLabel, dataModel, ctx) : "Approve";
        const rejectLabel = comp.rejectLabel !== undefined ? resolveDynamicString(comp.rejectLabel, dataModel, ctx) : "Reject";
        return (
          <View
            accessibilityLabel={a11yLabel || title}
            style={[
              {
                padding: space.md,
                borderRadius: radius.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: status === "pending" ? colors.accent : colors.line,
                backgroundColor: colors.sunken,
                gap: space.xs,
              },
              flexStyle,
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                <ShieldAlert size={15} color={colors.accent} />
                <T variant="body" weight="600" style={{ flex: 1 }}>
                  {title}
                </T>
              </View>
              {!!risk && <Badge label={`${risk} risk`} tone={risk === "high" ? "danger" : risk === "medium" ? "warning" : "success"} />}
              <Badge label={status} tone={status === "approved" ? "success" : status === "rejected" ? "danger" : "warning"} />
            </View>
            {!!summary && (
              <T variant="footnote" color="muted">
                {summary}
              </T>
            )}
            {typeof comp.child === "string" && renderNode(comp.child, ctx, depth + 1)}
            {status === "pending" && (!!comp.approveAction || !!comp.rejectAction) && (
              <View style={{ flexDirection: "row", gap: space.sm, marginTop: 4 }}>
                {!!comp.approveAction && (
                  <Button
                    title={approveLabel}
                    variant="primary"
                    size="sm"
                    loading={busyId === `${comp.id}:approve`}
                    disabled={busyId !== null}
                    onPress={() => void triggerAction({ ...comp, id: `${comp.id}:approve` }, comp.approveAction, ctx)}
                    accessibilityLabel={approveLabel}
                  />
                )}
                {!!comp.rejectAction && (
                  <Button
                    title={rejectLabel}
                    variant="secondary"
                    size="sm"
                    loading={busyId === `${comp.id}:reject`}
                    disabled={busyId !== null}
                    onPress={() => void triggerAction({ ...comp, id: `${comp.id}:reject` }, comp.rejectAction, ctx)}
                    accessibilityLabel={rejectLabel}
                  />
                )}
              </View>
            )}
          </View>
        );
      }
      default:
        return null;
    }
  };

  const renderNode = (id: string, ctx: RenderCtx, depth: number): ReactNode => {
    if (depth > 24) return null;
    const comp = byId.get(id);
    if (!comp) return null;

    const a11y = comp["@accessibility"];
    const a11yLabel = a11y?.label !== undefined ? resolveDynamicString(a11y.label, dataModel, ctx) : undefined;
    const flexStyle = typeof comp.weight === "number" && comp.weight > 0 ? { flex: comp.weight } : undefined;

    const effectiveCatalog = comp["@catalogId"] || surface.catalogId || A2UI_BASIC_CATALOG_ID;
    if (effectiveCatalog === A2UI_BOTKINS_CATALOG_ID) {
      const botkinsNode = renderBotkinsComponent(comp, ctx, depth, flexStyle, a11yLabel);
      if (botkinsNode) return botkinsNode;
    }

    switch (comp.component) {
      case "Text": {
        const text = resolveDynamicString(comp.text, dataModel, ctx);
        const variant = typeof comp.variant === "string" ? comp.variant : "body";
        const tVariant = variant === "caption" ? "caption" : variant === "h1" || variant === "h2" ? "headline" : "body";
        return (
          <T
            variant={tVariant}
            weight={variant.startsWith("h") ? "700" : undefined}
            color={variant === "caption" ? "muted" : undefined}
            accessibilityLabel={a11yLabel}
            style={flexStyle}
          >
            {text}
          </T>
        );
      }
      case "Icon": {
        const name = typeof comp.name === "string" ? comp.name : resolveDynamicString(comp.name, dataModel, ctx);
        const IconComp = ICON_MAP[name] ?? Info;
        return <IconComp size={16} color={colors.ink} accessibilityLabel={a11yLabel || name} />;
      }
      case "Image": {
        const url = resolveDynamicString(comp.url, dataModel, ctx);
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : "";
        if (!isSafeA2uiUrl(url, { allowDataImage: true })) {
          return (
            <T variant="caption" color="muted">
              {desc || "Image unavailable"}
            </T>
          );
        }
        const v = typeof comp.variant === "string" ? comp.variant : "mediumFeature";
        const sizeStyle =
          v === "icon"
            ? { width: 24, height: 24, borderRadius: 4 }
            : v === "avatar"
              ? { width: 40, height: 40, borderRadius: 20 }
              : v === "smallFeature"
                ? { width: "100%" as const, height: 110, borderRadius: radius.sm }
                : { width: "100%" as const, height: 180, borderRadius: radius.sm };
        const resizeMode = comp.fit === "contain" || comp.fit === "scaleDown" ? "contain" : comp.fit === "cover" ? "cover" : "stretch";
        return (
          <Image
            source={{ uri: url }}
            accessibilityLabel={desc || a11yLabel || "Image"}
            resizeMode={resizeMode}
            style={[sizeStyle, flexStyle]}
          />
        );
      }
      case "Video": {
        const url = resolveDynamicString(comp.url, dataModel, ctx);
        const posterUrl = comp.posterUrl !== undefined ? resolveDynamicString(comp.posterUrl, dataModel, ctx) : undefined;
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : undefined;
        return <MobileInlineVideoPlayer url={url} posterUrl={posterUrl} description={desc} />;
      }
      case "AudioPlayer": {
        const url = resolveDynamicString(comp.url, dataModel, ctx);
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : undefined;
        return <MobileInlineAudioPlayer url={url} description={desc} />;
      }
      case "Row":
        return (
          <View
            accessibilityLabel={a11yLabel}
            style={[
              {
                flexDirection: "row",
                flexWrap: "wrap",
                gap: space.sm,
                justifyContent: justifyStyle(comp.justify),
                alignItems: alignStyle(comp.align),
              },
              flexStyle,
            ]}
          >
            {renderChildren(comp.children, ctx, depth)}
          </View>
        );
      case "Column":
        return (
          <View
            accessibilityLabel={a11yLabel}
            style={[
              {
                flexDirection: "column",
                gap: space.sm,
                justifyContent: justifyStyle(comp.justify),
                alignItems: alignStyle(comp.align ?? "stretch"),
              },
              flexStyle,
            ]}
          >
            {renderChildren(comp.children, ctx, depth)}
          </View>
        );
      case "List": {
        const horizontal = comp.direction === "horizontal";
        if (horizontal) {
          return (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
              {renderChildren(comp.children, ctx, depth)}
            </ScrollView>
          );
        }
        return (
          <View style={[{ gap: space.sm, alignItems: alignStyle(comp.align ?? "stretch") }, flexStyle]} accessibilityLabel={a11yLabel}>
            {renderChildren(comp.children, ctx, depth)}
          </View>
        );
      }
      case "Card":
        return (
          <View
            accessibilityLabel={a11yLabel}
            style={[
              {
                backgroundColor: colors.sunken,
                borderRadius: radius.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                padding: space.sm,
              },
              flexStyle,
            ]}
          >
            {typeof comp.child === "string" ? renderNode(comp.child, ctx, depth + 1) : null}
          </View>
        );
      case "Divider": {
        const vertical = comp.axis === "vertical";
        return (
          <View
            style={
              vertical
                ? { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: colors.line }
                : { height: StyleSheet.hairlineWidth, width: "100%", backgroundColor: colors.line }
            }
          />
        );
      }
      case "Button": {
        const variant = comp.variant === "primary" ? "primary" : "secondary";
        const label = typeof comp.child === "string" ? labelOfChild(comp.child, ctx) : "";
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        const disabled = busyId !== null || checkErrs.length > 0;
        return (
          <Button
            title={label || (comp.action as any)?.event?.name || (comp.action as any)?.functionCall?.["@call"] || "Action"}
            variant={variant}
            size="sm"
            loading={busyId === comp.id}
            disabled={disabled}
            accessibilityLabel={a11yLabel || label || "Action"}
            onPress={() => void triggerAction(comp, comp.action, ctx)}
          />
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
          <View style={[{ gap: 4 }, flexStyle]}>
            <T variant="footnote" color="muted" weight="600">
              {label}
            </T>
            <TextInput
              value={value}
              placeholder={placeholder}
              placeholderTextColor={colors.muted}
              secureTextEntry={variant === "obscured"}
              multiline={variant === "longText"}
              keyboardType={variant === "number" ? "numeric" : "default"}
              accessibilityLabel={a11yLabel || label}
              onChangeText={(next) => updatePointer(pointer, next)}
              style={{
                borderRadius: radius.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                backgroundColor: colors.sunken,
                color: colors.ink,
                paddingHorizontal: space.sm,
                paddingVertical: space.xs,
                minHeight: variant === "longText" ? 72 : 38,
              }}
            />
            {checkErrs.length > 0 && (
              <T variant="caption" color="danger">
                {checkErrs[0]}
              </T>
            )}
          </View>
        );
      }
      case "CheckBox": {
        const label = resolveDynamicString(comp.label, dataModel, ctx);
        const checked = resolveDynamicBoolean(comp.value, dataModel, ctx);
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <View style={[{ gap: 4 }, flexStyle]}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
              <T variant="body" style={{ flex: 1 }}>
                {label}
              </T>
              <Switch value={checked} accessibilityLabel={a11yLabel || label} onValueChange={(next) => updatePointer(pointer, next)} />
            </View>
            {checkErrs.length > 0 && (
              <T variant="caption" color="danger">
                {checkErrs[0]}
              </T>
            )}
          </View>
        );
      }
      case "ChoicePicker": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const selected = resolveDynamicStringList(comp.value, dataModel, ctx);
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const multiple = comp.variant === "multipleSelection";
        const options = Array.isArray(comp.options) ? (comp.options as Array<{ label: unknown; value: string }>) : [];
        const filterText = (choiceFilter[comp.id] || "").trim().toLowerCase();
        const filtered = filterText
          ? options.filter((o) => resolveDynamicString(o.label, dataModel, ctx).toLowerCase().includes(filterText))
          : options;
        const toggle = (val: string) => {
          const next = multiple
            ? selected.includes(val)
              ? selected.filter((s) => s !== val)
              : [...selected, val]
            : [val];
          updatePointer(pointer, next);
        };
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <View style={[{ gap: space.xs }, flexStyle]}>
            {!!label && (
              <T variant="footnote" color="muted" weight="600">
                {label}
              </T>
            )}
            {comp.filterable === true && (
              <TextInput
                value={choiceFilter[comp.id] || ""}
                placeholder="Filter options…"
                placeholderTextColor={colors.muted}
                onChangeText={(next) => setChoiceFilter((prev) => ({ ...prev, [comp.id]: next }))}
                style={{
                  borderRadius: radius.sm,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.line,
                  backgroundColor: colors.sunken,
                  color: colors.ink,
                  paddingHorizontal: space.sm,
                  paddingVertical: space.xs,
                }}
              />
            )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
              {filtered.map((opt) => {
                const optLabel = resolveDynamicString(opt.label, dataModel, ctx);
                const isSelected = selected.includes(opt.value);
                return (
                  <Tap
                    key={opt.value}
                    onPress={() => toggle(opt.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={optLabel}
                    style={{
                      paddingHorizontal: space.sm,
                      paddingVertical: 6,
                      borderRadius: 999,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: isSelected ? colors.accent : colors.line,
                      backgroundColor: isSelected ? colors.accent : colors.sunken,
                    }}
                  >
                    <T variant="footnote" weight="600" style={{ color: isSelected ? colors.onAccent : colors.ink }}>
                      {optLabel}
                    </T>
                  </Tap>
                );
              })}
            </View>
            {checkErrs.length > 0 && (
              <T variant="caption" color="danger">
                {checkErrs[0]}
              </T>
            )}
          </View>
        );
      }
      case "Slider": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const min = typeof comp.min === "number" ? comp.min : 0;
        const max = typeof comp.max === "number" ? comp.max : 100;
        const val = resolveDynamicNumber(comp.value, dataModel, ctx);
        const step = typeof comp.steps === "number" && comp.steps > 0 ? (max - min) / comp.steps : Math.max(1, Math.round((max - min) / 10));
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n * 100) / 100));
        const pct = max > min ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)) : 0;
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <View style={[{ gap: 6 }, flexStyle]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <T variant="footnote" color="muted" weight="600">
                {label}
              </T>
              <T variant="footnote" weight="600">
                {String(val)}
              </T>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Tap
                onPress={() => updatePointer(pointer, clamp(val - step))}
                accessibilityLabel={`Decrease ${label || "slider"}`}
                style={{ padding: 6, borderRadius: radius.sm, backgroundColor: colors.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
              >
                <Minus size={14} color={colors.ink} />
              </Tap>
              <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.sunken, overflow: "hidden" }}>
                <View style={{ width: `${pct}%`, height: "100%", backgroundColor: colors.accent }} />
              </View>
              <Tap
                onPress={() => updatePointer(pointer, clamp(val + step))}
                accessibilityLabel={`Increase ${label || "slider"}`}
                style={{ padding: 6, borderRadius: radius.sm, backgroundColor: colors.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
              >
                <Plus size={14} color={colors.ink} />
              </Tap>
            </View>
            {checkErrs.length > 0 && (
              <T variant="caption" color="danger">
                {checkErrs[0]}
              </T>
            )}
          </View>
        );
      }
      case "DateTimeInput": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const val = resolveDynamicString(comp.value, dataModel, ctx);
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const placeholder = comp.enableTime && !comp.enableDate ? "HH:MM" : comp.enableTime ? "YYYY-MM-DDTHH:MM" : "YYYY-MM-DD";
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <View style={[{ gap: 4 }, flexStyle]}>
            {!!label && (
              <T variant="footnote" color="muted" weight="600">
                {label}
              </T>
            )}
            <TextInput
              value={val}
              placeholder={placeholder}
              placeholderTextColor={colors.muted}
              accessibilityLabel={a11yLabel || label || "Date and time"}
              onChangeText={(next) => updatePointer(pointer, next)}
              style={{
                borderRadius: radius.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                backgroundColor: colors.sunken,
                color: colors.ink,
                paddingHorizontal: space.sm,
                paddingVertical: space.xs,
              }}
            />
            {checkErrs.length > 0 && (
              <T variant="caption" color="danger">
                {checkErrs[0]}
              </T>
            )}
          </View>
        );
      }
      case "Tabs": {
        const tabs = Array.isArray(comp.tabs) ? (comp.tabs as Array<{ title: unknown; child: string }>) : [];
        const activeIdx = Math.min(tabSelection[comp.id] ?? 0, Math.max(0, tabs.length - 1));
        const activeTab = tabs[activeIdx];
        return (
          <View style={[{ gap: space.sm }, flexStyle]}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: space.xs }}>
              {tabs.map((tab, idx) => {
                const title = resolveDynamicString(tab.title, dataModel, ctx);
                const active = idx === activeIdx;
                return (
                  <Tap
                    key={idx}
                    onPress={() => setTabSelection((prev) => ({ ...prev, [comp.id]: idx }))}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={title}
                    style={{
                      paddingHorizontal: space.sm,
                      paddingVertical: 5,
                      borderRadius: radius.sm,
                      backgroundColor: active ? colors.accent : "transparent",
                    }}
                  >
                    <T variant="footnote" weight="600" style={{ color: active ? colors.onAccent : colors.muted }}>
                      {title}
                    </T>
                  </Tap>
                );
              })}
            </View>
            {activeTab && renderNode(activeTab.child, ctx, depth + 1)}
          </View>
        );
      }
      case "Modal": {
        const triggerId = typeof comp.trigger === "string" ? comp.trigger : "";
        const contentId = typeof comp.content === "string" ? comp.content : "";
        const isOpen = openModalId === comp.id;
        return (
          <View style={flexStyle}>
            <Tap onPress={() => setOpenModalId(comp.id)} accessibilityLabel={a11yLabel || "Open modal"}>
              {renderNode(triggerId, ctx, depth + 1)}
            </Tap>
            {isOpen && (
              <RNModal visible transparent animationType="fade" onRequestClose={() => setOpenModalId(null)}>
                <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: space.lg }}>
                  <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md, gap: space.md }}>
                    <View style={{ alignItems: "flex-end" }}>
                      <Button title="Close" variant="secondary" size="sm" onPress={() => setOpenModalId(null)} accessibilityLabel="Close dialog" />
                    </View>
                    {renderNode(contentId, ctx, depth + 1)}
                  </View>
                </View>
              </RNModal>
            )}
          </View>
        );
      }
      default:
        return (
          <View
            style={{
              padding: space.sm,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.line,
            }}
          >
            <T variant="caption" color="muted">
              {`Unsupported component: ${comp.component}`}
            </T>
          </View>
        );
    }
  };

  if (surface.state === "dismissed") {
    const summary = summarizeA2uiSurface({ ...surface, dataModel });
    return (
      <View
        style={{
          backgroundColor: colors.sunken,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          padding: space.md,
          gap: space.sm,
          opacity: 0.72,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <Badge label="Dismissed" tone="neutral" />
          <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
            {summary.lines[0] || surface.surfaceId}
          </T>
          <Tap onPress={() => setExpandedDismissed((v) => !v)} accessibilityLabel={expandedDismissed ? "Hide surface" : "Show surface"}>
            <T variant="caption" color="muted" weight="600">
              {expandedDismissed ? "Hide" : "Show"}
            </T>
          </Tap>
        </View>
        {expandedDismissed && renderNode("root", { scopePath: "" }, 0)}
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={`Interactive UI ${surface.surfaceId}`}
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        padding: space.md,
        gap: space.sm,
      }}
    >
      {renderNode("root", { scopePath: "" }, 0)}
      {surface.state === "dispatched" && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <CheckCircle2 size={14} color={colors.accent} />
            <T variant="footnote" color="muted">
              {`Dispatched to ${surface.dispatchedBotName || "bot"}`}
            </T>
          </View>
          {!!surface.dispatchedChatId && (
            <Button
              title="Open chat"
              icon={ArrowUpRight}
              variant="secondary"
              size="sm"
              accessibilityLabel={`Open chat with ${surface.dispatchedBotName || "bot"}`}
              onPress={() => {
                if (onOpenChat) onOpenChat(surface.dispatchedChatId!);
                else openChat(surface.dispatchedChatId!);
              }}
            />
          )}
        </View>
      )}
      {!!error && (
        <T variant="footnote" color="danger">
          {error}
        </T>
      )}
    </View>
  );
}
