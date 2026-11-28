// Shared swipe-to-reveal destructive row for Profile subpages (Computers & Devices).
// HARD RULE: Swiping only reveals the destructive button. Tapping that button invokes onAction,
// which MUST open a confirmation Alert before any API call runs.
import { type ReactNode, useEffect } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { usePrefs } from "@/state/prefs";
import { HoldMenu, T, Tap, useTheme } from "@/ui";

const ACTION_WIDTH = 86;

export function SwipeActionRow({
  children,
  actionLabel,
  actionId,
  menuTitle,
  disabled,
  revealed,
  onRevealChange,
  onAction,
}: {
  children: ReactNode;
  actionLabel: string;
  actionId: string;
  menuTitle: string;
  disabled?: boolean;
  revealed: boolean;
  onRevealChange: (next: boolean) => void;
  onAction: () => void;
}) {
  const { colors } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const translateX = useSharedValue(revealed ? -ACTION_WIDTH : 0);

  useEffect(() => {
    translateX.value = withSpring(revealed ? -ACTION_WIDTH : 0, { damping: 22, stiffness: 280 });
  }, [revealed, translateX]);

  const pan = usePanGesture({
    runOnJS: true,
    enabled: !disabled,
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    onUpdate: (e) => {
      const base = revealed ? -ACTION_WIDTH : 0;
      translateX.value = Math.max(-ACTION_WIDTH, Math.min(0, base + e.translationX));
    },
    onDeactivate: (e) => {
      const base = revealed ? -ACTION_WIDTH : 0;
      const next = base + e.translationX < -ACTION_WIDTH / 2;
      onRevealChange(next);
      translateX.value = withSpring(next ? -ACTION_WIDTH : 0, { damping: 22, stiffness: 280 });
    },
    onFinalize: () => {
      translateX.value = withSpring(revealed ? -ACTION_WIDTH : 0, { damping: 22, stiffness: 280 });
    },
  });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const actionRevealStyle = useAnimatedStyle(() => ({
    opacity: translateX.value < -2 ? 1 : 0,
  }));

  return (
    <View style={{ overflow: "hidden" }}>
      <Animated.View
        pointerEvents={revealed ? "auto" : "none"}
        style={[
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: ACTION_WIDTH,
            backgroundColor: colors.danger,
          },
          actionRevealStyle,
        ]}
      >
        <Tap
          disabled={disabled}
          onPress={() => {
            onRevealChange(false);
            onAction();
          }}
          accessibilityLabel={actionLabel + " " + menuTitle}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <T variant="subhead" weight="600" color={colors.onAccent} numberOfLines={1}>
            {actionLabel}
          </T>
        </Tap>
      </Animated.View>
      <HoldMenu
        title={menuTitle}
        actions={disabled ? [] : [{ id: actionId, title: actionLabel, attributes: { destructive: true } }]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === actionId) {
            onRevealChange(false);
            onAction();
          }
        }}
      >
        <GestureDetector gesture={pan}>
          <Animated.View style={[{ backgroundColor: hasBackdrop ? "transparent" : colors.surface }, animatedStyle]}>
            {children}
          </Animated.View>
        </GestureDetector>
      </HoldMenu>
    </View>
  );
}
