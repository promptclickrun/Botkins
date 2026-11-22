// The computer's screen as a card in a chat: where a bot showed the screen, the chat draws this. It
// shows the screen live, at the screen's own proportions and the chat's width, and a tap opens the
// side pane on that tab. For looking only: it sends no pointer or keyboard input.
//
// Only the card of the pane's newest screen tab is live, and only while it can be seen: its screen is
// on show, the app is in front, the card is in the chat's view and the pane doesn't show the screen
// over it. The rules are in screenLive.ts.
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";
import type { PanePanel } from "@/link/types";
import { useApp } from "@/state/store";
import { Dot, radius, space, T, Tap, useTheme } from "@/ui";
import { GateCover, gateLabel, ScreenPicture, useLiveScreen } from "./LiveScreen";
import { cardRole, cardSize, screenLabel, WORDS } from "./screenLive";

export type ScreenCardProps = {
  chatId: string;
  /** The side pane's tab of kind "screen" this card stands for. */
  panel: PanePanel;
  /** Opens the side pane on this tab. */
  onOpen: () => void;
  /** Whether the active chat's list can see this card. */
  inView: boolean;
};

/** The card is never taller than this share of the window. */
const MAX_HEIGHT_SHARE = 0.5;

export function ScreenCard({ chatId, panel, onOpen, inView }: ScreenCardProps) {
  const { colors } = useTheme();
  const loaded = useApp((state) => !!state.chats[chatId]);
  const pane = useApp((state) => state.chats[chatId]?.pane);
  const role = cardRole(loaded, pane, panel.id);

  const screen = useLiveScreen("card", { role, visible: inView });

  const [width, setWidth] = useState(0);
  const { height: windowHeight } = useWindowDimensions();
  const size = cardSize(width, screen.ratio, windowHeight * MAX_HEIGHT_SHARE);

  const open = screen.gate.kind === "open";
  const tappable = open && (role === "live" || role === "older");
  const box: ViewStyle = {
    ...(size.width > 0 ? { width: size.width, height: size.height } : { width: "100%", aspectRatio: screen.ratio }),
    alignSelf: "center",
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  };
  // Before the chat is known (another computer was just chosen), nothing of a picture shows.
  const content = !open ? <GateCover gate={screen.gate} /> : role === "waiting" ? null : <ScreenPicture screen={screen} />;
  const label = open ? screenLabel("card", screen.look) : gateLabel(screen.gate);

  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)} style={{ gap: space.sm }}>
      {tappable ? (
        <Tap onPress={onOpen} feel="select" sink={0.99} accessibilityLabel={label} style={box}>
          {content}
        </Tap>
      ) : (
        // Covered, its "Show screen" is a button of its own; otherwise the card reads as one line.
        <View style={box} accessible={screen.gate.kind !== "covered"} accessibilityLabel={label}>
          {content}
        </View>
      )}
      <View style={styles.caption} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {panel.title || WORDS.title}
        </T>
        {screen.look.live && (
          <View style={styles.live}>
            <Dot tone="success" size={7} />
            <T variant="footnote" color="muted">
              {WORDS.live}
            </T>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs },
  live: { flexDirection: "row", alignItems: "center", gap: space.xs },
});
