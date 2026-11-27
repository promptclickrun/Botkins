// Native React Native renderer for A2UI v1.0 Basic Catalog surfaces on Botkins mobile.
// Uses Botkins theme tokens (light/dark), accessibility labels, safe openLink confirmation,
// and a plain-text + action-buttons fallback when rich cards are off.
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
  ShoppingCart,
  Square,
  Star,
  Trash2,
  Upload,
  User,
  UserCircle,
  X,
} from "lucide-react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Modal as RNModal, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import type { A2uiActionPayload, A2uiComponent, A2uiSurface as A2uiSurfaceData } from "@/link/types";
import { chatA2uiAction } from "@/state/link";
import { openLink } from "@/ui/LinkHold";
import { Badge, Button, radius, space, T, Tap, useTheme } from "@/ui";
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
} from "../../../link-host/a2ui.mjs";
import { openChat } from "./navigate";

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

export function A2uiSurface({ chatId, surface, rich, onOpenChat }: Props) {
  const { colors } = useTheme();
  const [dataModel, setDataModel] = useState<Record<string, unknown>>(() => structuredClone(surface.dataModel ?? {}));
  const [tabSelection, setTabSelection] = useState<Record<string, number>>({});
  const [openModalId, setOpenModalId] = useState<string | null>(null);
  const [choiceFilter, setChoiceFilter] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expandedDismissed, setExpandedDismissed] = useState(false);

  useEffect(() => {
    setDataModel(structuredClone(surface.dataModel ?? {}));
  }, [surface.updatedAt, surface.surfaceId]);

  const byId = useMemo(() => {
    const m = new Map<string, A2uiComponent>();
    for (const c of surface.components ?? []) m.set(c.id, c);
    return m;
  }, [surface.components]);

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
      const fn = actionObj.functionCall;
      if (fn["@call"] === "openUrl") {
        const url = resolveDynamicString(fn.args?.url, dataModel, ctx);
        if (isSafeA2uiUrl(url)) openLink(url);
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
      await chatA2uiAction(chatId, payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Rich-cards-off mode: plain text summary + interactive action buttons.
  if (!rich) {
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
                  title={busyId === act.componentId ? "Working…" : act.label}
                  variant={act.variant === "primary" ? "primary" : "secondary"}
                  size="sm"
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
        <View key={`${tpl.componentId}-${idx}`}>
          {renderNode(tpl.componentId, { scopePath: `${base}/${idx}`, itemIndex: idx }, depth + 1)}
        </View>
      ));
    }
    return null;
  };

  const labelOfChild = (compId: string, ctx: RenderCtx): string => {
    const child = byId.get(compId);
    if (!child) return "";
    if (child.component === "Text") return resolveDynamicString(child.text, dataModel, ctx).trim();
    if (child.component === "Row" && Array.isArray(child.children)) {
      return child.children.map((id) => labelOfChild(String(id), ctx)).filter(Boolean).join(" ");
    }
    return "";
  };

  const renderNode = (id: string, ctx: RenderCtx, depth: number): ReactNode => {
    if (depth > 24) return null;
    const comp = byId.get(id);
    if (!comp) return null;

    const a11y = comp["@accessibility"];
    const a11yLabel = a11y?.label !== undefined ? resolveDynamicString(a11y.label, dataModel, ctx) : undefined;
    const flexStyle = typeof comp.weight === "number" && comp.weight > 0 ? { flex: comp.weight } : undefined;

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
      case "Video":
      case "AudioPlayer": {
        const url = resolveDynamicString(comp.url, dataModel, ctx);
        const desc = comp.description !== undefined ? resolveDynamicString(comp.description, dataModel, ctx) : `${comp.component} media`;
        return (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
            <T variant="footnote" color="muted" style={{ flex: 1 }}>
              {desc}
            </T>
            {isSafeA2uiUrl(url) && (
              <Button title="Open" icon={ExternalLink} variant="secondary" size="sm" onPress={() => openLink(url)} accessibilityLabel={`Open ${desc}`} />
            )}
          </View>
        );
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
                padding: space.md,
              },
              flexStyle,
            ]}
          >
            {typeof comp.child === "string" ? renderNode(comp.child, ctx, depth + 1) : null}
          </View>
        );
      case "Divider":
        return (
          <View
            style={
              comp.axis === "vertical"
                ? { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: colors.line, marginHorizontal: 4 }
                : { height: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: colors.line, marginVertical: 4 }
            }
          />
        );
      case "Button": {
        const variant = comp.variant === "primary" ? "primary" : "secondary";
        const label = (typeof comp.child === "string" ? labelOfChild(comp.child, ctx) : "") || (comp.action as any)?.event?.name || "Action";
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <Button
            title={busyId === comp.id ? "Working…" : label}
            variant={variant}
            size="sm"
            disabled={busyId !== null || checkErrs.length > 0}
            accessibilityLabel={a11yLabel || label}
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
            <T variant="caption" color="muted" weight="600">
              {label}
            </T>
            <TextInput
              value={value}
              placeholder={placeholder}
              placeholderTextColor={colors.muted}
              multiline={variant === "longText"}
              secureTextEntry={variant === "obscured"}
              keyboardType={variant === "number" ? "numeric" : "default"}
              accessibilityLabel={a11yLabel || label}
              onChangeText={(txt) => updatePointer(pointer, txt)}
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                borderRadius: radius.sm,
                paddingHorizontal: space.sm,
                paddingVertical: 8,
                color: colors.ink,
                backgroundColor: colors.sunken,
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
              <T variant="footnote" style={{ flex: 1 }}>
                {label}
              </T>
              <Switch
                value={checked}
                accessibilityLabel={a11yLabel || label}
                onValueChange={(next) => updatePointer(pointer, next)}
              />
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
              <T variant="caption" color="muted" weight="600">
                {label}
              </T>
            )}
            {comp.filterable === true && (
              <TextInput
                value={choiceFilter[comp.id] || ""}
                placeholder="Filter options…"
                placeholderTextColor={colors.muted}
                onChangeText={(txt) => setChoiceFilter((prev) => ({ ...prev, [comp.id]: txt }))}
                style={{
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.line,
                  borderRadius: radius.sm,
                  paddingHorizontal: space.sm,
                  paddingVertical: 6,
                  color: colors.ink,
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
                    accessibilityLabel={optLabel}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => toggle(opt.value)}
                    style={{
                      paddingHorizontal: space.sm,
                      paddingVertical: 6,
                      borderRadius: 999,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: isSelected ? colors.accent : colors.line,
                      backgroundColor: isSelected ? colors.accent : colors.sunken,
                    }}
                  >
                    <T variant="caption" weight="600" style={{ color: isSelected ? "#ffffff" : colors.ink }}>
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
        const stepSize = typeof comp.steps === "number" && comp.steps > 0 ? (max - min) / comp.steps : Math.max(1, (max - min) / 10);
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n * 100) / 100));
        return (
          <View style={[{ gap: space.xs }, flexStyle]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <T variant="caption" color="muted" weight="600">
                {label}
              </T>
              <T variant="caption" color="muted">
                {String(val)}
              </T>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Tap
                accessibilityLabel={`Decrease ${label || "value"}`}
                onPress={() => updatePointer(pointer, clamp(val - stepSize))}
                style={{ padding: 6, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
              >
                <Minus size={14} color={colors.ink} />
              </Tap>
              <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.sunken, overflow: "hidden" }}>
                <View
                  style={{
                    height: 6,
                    width: `${Math.max(0, Math.min(100, ((val - min) / Math.max(1, max - min)) * 100))}%`,
                    backgroundColor: colors.accent,
                  }}
                />
              </View>
              <Tap
                accessibilityLabel={`Increase ${label || "value"}`}
                onPress={() => updatePointer(pointer, clamp(val + stepSize))}
                style={{ padding: 6, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
              >
                <Plus size={14} color={colors.ink} />
              </Tap>
            </View>
          </View>
        );
      }
      case "DateTimeInput": {
        const label = comp.label !== undefined ? resolveDynamicString(comp.label, dataModel, ctx) : "";
        const val = resolveDynamicString(comp.value, dataModel, ctx);
        const placeholder =
          comp.enableDate && comp.enableTime
            ? "YYYY-MM-DDTHH:MM"
            : comp.enableTime
              ? "HH:MM"
              : "YYYY-MM-DD";
        const pointer = boundPathOf(comp.value, ctx.scopePath);
        const checkErrs = evaluateChecks(comp, dataModel, ctx);
        return (
          <View style={[{ gap: 4 }, flexStyle]}>
            {!!label && (
              <T variant="caption" color="muted" weight="600">
                {label}
              </T>
            )}
            <TextInput
              value={val}
              placeholder={placeholder}
              placeholderTextColor={colors.muted}
              accessibilityLabel={a11yLabel || label || "Date and time"}
              onChangeText={(txt) => updatePointer(pointer, txt)}
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.line,
                borderRadius: radius.sm,
                paddingHorizontal: space.sm,
                paddingVertical: 8,
                color: colors.ink,
                backgroundColor: colors.sunken,
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
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
              {tabs.map((tab, idx) => {
                const title = resolveDynamicString(tab.title, dataModel, ctx);
                const selected = idx === activeIdx;
                return (
                  <Tap
                    key={idx}
                    accessibilityLabel={title}
                    accessibilityState={{ selected }}
                    onPress={() => setTabSelection((prev) => ({ ...prev, [comp.id]: idx }))}
                    style={{
                      paddingHorizontal: space.sm,
                      paddingVertical: 6,
                      borderRadius: radius.sm,
                      backgroundColor: selected ? colors.sunken : "transparent",
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: selected ? colors.line : "transparent",
                    }}
                  >
                    <T variant="caption" weight="600" color={selected ? undefined : "muted"}>
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
