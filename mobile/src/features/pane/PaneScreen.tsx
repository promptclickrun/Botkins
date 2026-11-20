// The side pane's screen tab: the computer's screen, live, as large as the tab allows, and under it
// the way to Settings › Screen to use the pointer and keyboard (it keeps its own check). The tab
// itself only shows: it sends no input and doesn't keep the phone awake.
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { fitPicture } from "@/features/remote/gestures";
import { Button, radius, space, useOnShow, useTheme } from "@/ui";
import { GateCover, gateLabel, ScreenPicture, useLiveScreen } from "./LiveScreen";
import { screenLabel, WORDS } from "./screenLive";

export function PaneScreen() {
  const { colors } = useTheme();
  const shown = useOnShow();
  const screen = useLiveScreen("pane", { role: "live", visible: shown });
  const [box, setBox] = useState({ width: 0, height: 0 });
  // The picture's proportions, fitted in the tab and centered.
  const fit = fitPicture(box, { width: screen.ratio * 1000, height: 1000 });
  const open = screen.gate.kind === "open";
  const control = screen.mode === "control" && screen.info?.canControl !== false;

  return (
    <View style={{ flex: 1, paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
      <View style={{ flex: 1 }} onLayout={({ nativeEvent }) => setBox({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}>
        {fit.imageWidth > 0 && (
          <View
            accessible={screen.gate.kind !== "covered"}
            accessibilityLabel={open ? screenLabel("pane", screen.look) : gateLabel(screen.gate)}
            style={{
              position: "absolute",
              left: fit.left,
              top: fit.top,
              width: fit.imageWidth,
              height: fit.imageHeight,
              borderRadius: radius.lg,
              overflow: "hidden",
              backgroundColor: colors.surface,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.line,
            }}
          >
            {open ? <ScreenPicture screen={screen} /> : <GateCover gate={screen.gate} />}
          </View>
        )}
      </View>
      {open && <Button title={control ? WORDS.control : WORDS.watch} wide onPress={() => router.push("/remote")} />}
    </View>
  );
}
