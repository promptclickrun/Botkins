// The newest screen card takes one still while visible. Tapping opens the live pane.
// Older cards keep their own still. Cards never send input or keep the phone awake.
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";
import type { PanePanel } from "@/link/types";
import { useApp } from "@/state/store";
import { useScreenKey } from "@/features/pane/watching";
import { api, attempt } from "@/state/link";
import { HoldMenu, radius, space, T, Tap, useTheme } from "@/ui";
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

export function ScreenCard(props: ScreenCardProps) {
  const host = useScreenKey();
  return <Card key={JSON.stringify([host, props.panel.id])} {...props} />;
}

function Card({ chatId, panel, onOpen, inView }: ScreenCardProps) {
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
  const label = open && role !== "waiting" ? screenLabel("card", screen.look) : gateLabel(screen.gate);

  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)} style={{ gap: space.sm }}>
      <HoldMenu actions={[{ id: "close", title: "Close screen", image: "xmark" }]}
        onPressAction={() => void attempt(api.sidePane(chatId, "remove", panel.id))}>
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
      </HoldMenu>
      <View style={styles.caption} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {panel.title || WORDS.title}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs },
});
