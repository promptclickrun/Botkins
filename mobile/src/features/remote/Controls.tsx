// The floating bar at the bottom of the Screen and the status line at the top.
import { MenuView } from "@react-native-menu/menu";
import { Ellipsis, Keyboard, type LucideIcon, Pointer, Touchpad, X } from "lucide-react-native";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { ScreenDisplay } from "@/link/types";
import { space, T, Tap } from "@/ui";
import { chrome, QUALITY, type QualityId } from "./chrome";
import type { PointerMode } from "./gestures";

/** Fades a view in or out; hidden, it doesn't take touches. */
function useFade(visible: boolean) {
  const shown = useSharedValue(visible ? 1 : 0);
  useEffect(() => {
    shown.value = withTiming(visible ? 1 : 0, { duration: visible ? 160 : 320 });
  }, [shown, visible]);
  return useAnimatedStyle(() => ({ opacity: shown.value }));
}

export function ControlBar({
  visible,
  bottom,
  control,
  mode,
  displays,
  display,
  quality,
  onClose,
  onKeyboard,
  onMode,
  onDisplay,
  onQuality,
  onFit,
  onMenu,
}: {
  visible: boolean;
  bottom: number;
  control: boolean;
  mode: PointerMode;
  displays: ScreenDisplay[];
  display: string | undefined;
  quality: QualityId;
  onClose: () => void;
  onKeyboard: () => void;
  onMode: () => void;
  onDisplay: (id: string) => void;
  onQuality: (id: QualityId) => void;
  onFit: () => void;
  /** The menu opened (true) or closed (false). */
  onMenu: (open: boolean) => void;
}) {
  const fade = useFade(visible);
  const hint = useFade(!visible);
  const actions = [
    ...(displays.length > 1
      ? [{ id: "display", title: "Display", image: "display", subactions: displays.map((item) => ({ id: "display:" + item.id, title: item.label, state: item.id === display ? ("on" as const) : ("off" as const) })) }]
      : []),
    {
      id: "quality",
      title: "Quality",
      subtitle: QUALITY[quality].title,
      image: "slider.horizontal.3",
      subactions: (Object.keys(QUALITY) as QualityId[]).map((id) => ({ id: "quality:" + id, title: QUALITY[id].title, state: id === quality ? ("on" as const) : ("off" as const) })),
    },
    { id: "fit", title: "Fit to screen", image: "arrow.down.right.and.arrow.up.left" },
  ];

  return (
    <>
      {/* While the bar is away, a small handle marks where a tap brings it back. */}
      <Animated.View style={[styles.barWrap, { bottom: Math.max(bottom - space.sm, 6) }, hint]} pointerEvents="none">
        <View style={styles.handle} />
      </Animated.View>
      <Animated.View style={[styles.barWrap, { bottom }, fade]} pointerEvents={visible ? "box-none" : "none"}>
        <View style={styles.bar}>
          <BarButton icon={X} label="Close" onPress={onClose} />
          {control && <BarButton icon={Keyboard} label="Keyboard" onPress={onKeyboard} />}
          {control && <BarButton icon={mode === "trackpad" ? Touchpad : Pointer} label={mode === "trackpad" ? "Pointer: trackpad" : "Pointer: touch"} hint="Switches between trackpad and touch" onPress={onMode} />}
          <MenuView
            actions={actions}
            themeVariant="dark"
            onOpenMenu={() => onMenu(true)}
            onCloseMenu={() => onMenu(false)}
            onPressAction={({ nativeEvent }) => {
              const action = nativeEvent.event;
              if (action === "fit") onFit();
              else if (action.startsWith("display:")) onDisplay(action.slice("display:".length));
              else if (action.startsWith("quality:")) onQuality(action.slice("quality:".length) as QualityId);
            }}
          >
            <View accessible accessibilityRole="button" accessibilityLabel="More" style={styles.button}>
              <Ellipsis size={22} color={chrome.ink} strokeWidth={2.2} />
            </View>
          </MenuView>
        </View>
      </Animated.View>
    </>
  );
}

function BarButton({ icon: Icon, label, hint, onPress }: { icon: LucideIcon; label: string; hint?: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label} accessibilityHint={hint} sink={0.9} style={styles.button}>
      <Icon size={22} color={chrome.ink} strokeWidth={2.2} />
    </Tap>
  );
}

/** The computer's name, "View only", a spinner until the first picture, "Reconnecting…" while retrying. */
export function StatusLine({ visible, top, name, viewOnly, waiting, reconnecting, note }: { visible: boolean; top: number; name: string | undefined; viewOnly: boolean; waiting: boolean; reconnecting: boolean; note?: string | null }) {
  const fade = useFade(visible || waiting || reconnecting || !!note);
  const words = reconnecting ? "Reconnecting…" : (note ?? [name ?? "Your computer", viewOnly ? "View only" : ""].filter(Boolean).join(" · "));
  return (
    <Animated.View style={[styles.statusWrap, { top }, fade]} pointerEvents="none">
      <View style={styles.status} accessibilityLiveRegion="polite">
        {(waiting || reconnecting) && <ActivityIndicator size="small" color={chrome.ink} />}
        <T variant="footnote" weight="600" color={chrome.ink} numberOfLines={1}>
          {words}
        </T>
      </View>
    </Animated.View>
  );
}

/** A line from the computer about what it can't do ("Allow screen recording…"). */
export function ProblemLine({ text }: { text: string }) {
  return (
    <View style={styles.problem} accessibilityRole="alert">
      <T variant="footnote" weight="600" color={chrome.inkOn} center>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  barWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  bar: { flexDirection: "row", alignItems: "center", gap: space.xs, padding: 6, borderRadius: 999, backgroundColor: chrome.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: chrome.glassLine },
  button: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  handle: { width: 44, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.38)" },
  statusWrap: { position: "absolute", left: space.lg, right: space.lg, alignItems: "center" },
  status: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: chrome.glass, maxWidth: 420 },
  problem: { marginHorizontal: space.lg, marginTop: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 12, backgroundColor: chrome.warn },
});
