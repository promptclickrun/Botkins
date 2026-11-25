// The side pane's screen tab: the computer's screen, live, as large as the tab allows, and under it
// a shortcut to Control computer to use the pointer and keyboard. The tab
// itself only shows: it sends no input and doesn't keep the phone awake.
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { fitPicture } from "@/features/remote/gestures";
import { useScreenKey } from "@/features/pane/watching";
import { Button, radius, space, useOnShow, useTheme } from "@/ui";
import { GateCover, gateHasAction, gateLabel, ScreenPicture, useLiveScreen } from "./LiveScreen";
import { screenLabel } from "./screenLive";

export function PaneScreen() {
  const host = useScreenKey();
  return <ScreenTab key={host} />;
}

function ScreenTab() {
  const { colors } = useTheme();
  const shown = useOnShow();
  const screen = useLiveScreen("pane", { role: "live", visible: shown });
  const [box, setBox] = useState({ width: 0, height: 0 });
  // The picture's proportions, fitted in the tab and centered.
  const fit = fitPicture(box, { width: screen.ratio * 1000, height: 1000 });
  const open = screen.gate.kind === "open";

  return (
    <View style={{ flex: 1, paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
      <View style={{ flex: 1 }} onLayout={({ nativeEvent }) => setBox({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}>
        {fit.imageWidth > 0 && (
          <View
            accessible={!gateHasAction(screen.gate)}
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
      {!!screen.viewerLabel && <Button title={screen.viewerLabel} wide onPress={screen.openViewer} />}
    </View>
  );
}
