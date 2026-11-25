// The frames screens are built in: a page (pushed, or the root of a tab) and a sheet.
import { router, useScrollToTop } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { CloudOff, RefreshCw, X } from "lucide-react-native";
import { type ComponentRef, type ReactNode, useContext, useRef } from "react";
import { ActivityIndicator, Platform, RefreshControl, ScrollView, type StyleProp, View, type ViewStyle } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShape } from "./useShape";
import { useRestarting } from "@/state/appUpdate";
import { wake } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { BackdropLayer } from "./Backdrop";
import { Glass } from "./Glass";
import { Tap } from "./Tap";
import { T } from "./Text";
import { radius, slopFor, space, useTheme } from "./theme";

/** Room the floating tab bar needs under the last row of a tab's screen. */
export { TAB_BAR_ROOM } from "./useShape";

/** Says so when the computer can't be reached, with a way to try again. Nothing while in step. */
export function LinkBanner() {
  const { colors } = useTheme();
  const link = useApp((state) => state.link);
  const synced = useApp((state) => state.synced);
  const name = useApp((state) => state.pairing?.name) ?? "your computer";
  // An update this phone started restarts the computer's Botkins: for its first minutes that is said
  // instead of a failure (src/state/appUpdate.ts), and a tap still tries again.
  const restarting = useRestarting();
  if (link === "online" || (link === "connecting" && synced)) return null;
  if (restarting?.stage === "restarting" && link !== "revoked")
    return (
      <Tap
        onPress={() => wake()}
        feel="select"
        sink={0.98}
        accessibilityLabel={"Botkins on " + name + " is restarting to update. Try again"}
        style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, paddingLeft: space.lg, borderRadius: radius.md, backgroundColor: colors.infoSoft }}
      >
        <ActivityIndicator color={colors.info} />
        <T variant="subhead" weight="600" color="info" style={{ flex: 1 }} numberOfLines={2}>
          {"Botkins on " + name + " is restarting to update"}
        </T>
      </Tap>
    );
  const revoked = link === "revoked";
  const connecting = link === "connecting";
  return (
    <Tap
      onPress={() => (revoked ? router.push("/settings/desktop") : wake())}
      feel="select"
      sink={0.98}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, paddingLeft: space.lg, borderRadius: radius.md, backgroundColor: revoked ? colors.dangerSoft : colors.warningSoft }}
    >
      {connecting ? <ActivityIndicator color={colors.warning} /> : <CloudOff size={18} color={revoked ? colors.danger : colors.warning} strokeWidth={2.2} />}
      <T variant="subhead" weight="600" color={revoked ? "danger" : "warning"} style={{ flex: 1 }} numberOfLines={2}>
        {revoked ? "This phone was removed from " + name : connecting ? "Connecting to " + name + "…" : "Can't reach " + name}
      </T>
      {!connecting && (
        <T variant="subhead" weight="600" color={revoked ? "danger" : "warning"}>
          {revoked ? "Fix" : "Retry"}
        </T>
      )}
      {!connecting && !revoked && <RefreshCw size={15} color={colors.warning} strokeWidth={2.4} />}
    </Tap>
  );
}

export type PageProps = {
  /** A large title at the top of the content. */
  title?: string;
  /** A line under the title. */
  caption?: string;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  children: ReactNode;
  /** The root screen of a tab: it has no native header, and the tab bar floats over its end. */
  tab?: boolean;
  scroll?: boolean;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  /** Text fields in the page stay above the keyboard. */
  keyboard?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** Hides the "can't reach your computer" banner (screens that work without the computer). */
  quietLink?: boolean;
  /** Pinned under the scrolling content. */
  footer?: ReactNode;
  /** Called while the page scrolls, a few times a second at most. */
  onScroll?: () => void;
};

export function Page({ title, caption, actions, children, tab, scroll = true, onRefresh, refreshing = false, keyboard, contentStyle, quietLink, footer, onScroll }: PageProps) {
  const { colors } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  useScrollToTop(scrollRef);
  // A tab's root lays itself out beside the side rail (a pushed page gets that room from its stack).
  const shape = useShape();
  const head = (title || actions) && (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.md, marginBottom: space.xs }}>
      <View style={{ flex: 1, gap: 2 }}>
        {!!title && (
          <T variant="display" accessibilityRole="header" numberOfLines={2}>
            {title}
          </T>
        )}
        {!!caption && (
          <T variant="subhead" color="muted" numberOfLines={2}>
            {caption}
          </T>
        )}
      </View>
      {!!actions && <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: 3 }}>{actions}</View>}
    </View>
  );
  // Non-scrolling pushed pages do not get ScrollView's contentInsetAdjustmentBehavior, so pad below the transparent iOS bar.
  const nonScrollTop = !tab && !scroll && hasBackdrop && Platform.OS === "ios" ? headerHeight + space.sm : space.sm;
  const padding = {
    paddingLeft: space.xl + (tab ? shape.left : 0),
    paddingRight: space.xl + (tab ? shape.right : 0),
    paddingTop: tab ? insets.top + space.md : nonScrollTop,
    paddingBottom: (tab ? shape.tabRoom : 0) + insets.bottom + space.xxl,
    gap: space.xl,
  };
  const body = (
    <>
      {head}
      {!quietLink && <LinkBanner />}
      {children}
    </>
  );
  if (!scroll)
    return (
      <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
        {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
        <View style={[{ flex: 1 }, padding, contentStyle]}>{body}</View>
        {footer}
      </View>
    );
  const Scroller = keyboard ? KeyboardAwareScrollView : ScrollView;
  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <Scroller
        ref={tab ? (view) => { scrollRef.current = view; } : undefined}
        style={{ flex: 1, backgroundColor: "transparent" }}
        contentContainerStyle={[padding, contentStyle]}
        contentInsetAdjustmentBehavior={tab ? "never" : "automatic"}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        {...(onScroll && { onScroll, scrollEventThrottle: 200, onMomentumScrollEnd: onScroll })}
        {...(keyboard && { bottomOffset: 24 })}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.muted} /> : undefined}
      >
        {body}
      </Scroller>
      {footer}
    </View>
  );
}

export type SheetProps = {
  title: string;
  children: ReactNode;
  /** The action at the right of the header: "Save", "Create", "Done". */
  action?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionLoading?: boolean;
  /** Called instead of going back when the sheet is closed with the X. */
  onClose?: () => void;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  footer?: ReactNode;
};

/** A screen shown as a sheet: a title, a way out, and one action. */
export function Sheet({ title, children, action, onAction, actionDisabled, actionLoading, onClose, scroll = true, contentStyle, footer }: SheetProps) {
  const { colors, control } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const button = control.sheetButton;
  const insets = useSafeAreaInsets();
  const close = onClose ?? (() => router.back());
  // The native sheet lays out its direct children itself, so these views must not be flattened away.
  const closeIcon = <X size={18} color={colors.ink2} strokeWidth={2.4} />;
  const header = (
    <View collapsable={false} style={{ minHeight: 60, flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, gap: space.sm }}>
      {hasBackdrop ? (
        <Tap onPress={close} accessibilityLabel="Close" sink={0.9} hitSlop={slopFor(button)}>
          <Glass interactive style={{ width: button, height: button, borderRadius: button / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            {closeIcon}
          </Glass>
        </Tap>
      ) : (
        <Tap onPress={close} accessibilityLabel="Close" sink={0.9} hitSlop={slopFor(button)} style={{ width: button, height: button, borderRadius: button / 2, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }}>
          {closeIcon}
        </Tap>
      )}
      <T variant="headline" center numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
        {title}
      </T>
      <View style={{ minWidth: button, alignItems: "flex-end" }}>
        {!!action &&
          (actionLoading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Tap onPress={onAction} disabled={actionDisabled} accessibilityLabel={action} hitSlop={slopFor(button)} style={{ minHeight: button, paddingHorizontal: 14, borderRadius: button / 2, backgroundColor: actionDisabled ? colors.sunken : colors.primary, alignItems: "center", justifyContent: "center" }}>
              <T variant="subhead" weight="700" color={actionDisabled ? "muted" : "onPrimary"}>
                {action}
              </T>
            </Tap>
          ))}
      </View>
    </View>
  );
  const padding = { paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.xxl, gap: space.xl };
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      {header}
      {scroll ? (
        <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: "transparent" }} contentContainerStyle={[padding, contentStyle]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} bottomOffset={24}>
          {children}
        </KeyboardAwareScrollView>
      ) : (
        <View style={[{ flex: 1 }, padding, contentStyle]}>{children}</View>
      )}
      {footer}
    </View>
  );
}

/** A centered spinner for a screen that is still loading its first data. */
export function Loading({ label }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: 56, alignItems: "center", gap: space.md }}>
      <ActivityIndicator color={colors.muted} />
      {!!label && (
        <T variant="footnote" color="muted">
          {label}
        </T>
      )}
    </View>
  );
}
