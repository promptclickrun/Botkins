// A panel as a card: its title and the one thing it says (the panel widget's own line), and nothing
// of it running. A tap opens the panel; a hold pins it to Home or takes it off. Shown in a space
// set to Cards, and on Home for a pinned panel.
import { Pin } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import type { Bot, PanelView } from "@/link/types";
import { usePrefs } from "@/state/prefs";
import { ago } from "@/state/time";
import { panelHeadline } from "@/state/widgetData";
import { Badge, BotAvatar, Dot, Glass, HoldMenu, lift, radius, space as gap, T, Tap, tint, useTheme } from "@/ui";
import { markItemSeen, openPanel, setPanelPinned, usePanelPinned } from "./data";
import { isApp } from "./logic";

type Props = {
  panel: PanelView;
  spaceId: string;
  bot?: Bot;
  changed?: boolean;
  /** The whole row, with the panel's bot beside its title. Without it the card shares its row with another. */
  wide?: boolean;
  /** A last line of its own (on Home, the panel's space) in place of who updated it and when. */
  foot?: string;
};

export function PanelTile({ panel, spaceId, bot, changed = false, wide = false, foot }: Props) {
  const theme = useTheme();
  const { colors, dark } = theme;
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const pinned = usePanelPinned(spaceId, panel.id);
  const { value, note } = panelHeadline(panel);
  const open = () => {
    if (changed) markItemSeen(spaceId, panel.id, panel.updatedAt);
    openPanel(spaceId, panel.id);
  };
  const pin = () => setPanelPinned({ spaceId, panelId: panel.id }, !pinned);
  const pinWord = pinned ? "Take off Home" : "Pin to Home";
  const last = foot ?? [bot?.name, "Updated " + ago(panel.updatedAt)].filter(Boolean).join(" · ");
  const marks = (
    <>
      {pinned && !foot && <Pin size={14} color={colors.muted} strokeWidth={2.2} />}
      {isApp(panel) && <Badge label="App" />}
      {changed && <Dot size={8} />}
    </>
  );
  const cardBody = (
    <>
      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: gap.sm, marginBottom: gap.xs }}>
          <BotAvatar bot={bot} size={28} badge={false} />
          <T variant="headline" numberOfLines={2} style={{ flex: 1 }}>
            {panel.title}
          </T>
          {marks}
        </View>
      ) : (
        <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: gap.sm }}>
          <T variant="footnote" color="muted" numberOfLines={2} style={{ flex: 1 }}>
            {panel.title}
          </T>
          {marks}
        </View>
      )}
      {!!value && (
        <T variant={wide ? "title2" : "title1"} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {value}
        </T>
      )}
      {!!note && (
        <T variant={value ? "footnote" : "subhead"} color={value ? "muted" : "ink2"} numberOfLines={value ? 1 : 3}>
          {note}
        </T>
      )}
      {(wide || !!foot) && !!last && (
        <T variant="footnote" color="muted" numberOfLines={1}>
          {last}
        </T>
      )}
    </>
  );
  return (
    <HoldMenu
      title={panel.title}
      actions={[
        { id: "pin", title: pinWord, image: pinned ? "pin.slash" : "pin" },
        { id: "open", title: "Open", image: "arrow.up.left.and.arrow.down.right" },
      ]}
      onPressAction={({ nativeEvent }) => (nativeEvent.event === "pin" ? pin() : open())}
      style={{ flex: 1, minWidth: 0 }}
    >
      {hasBackdrop ? (
        <Tap
          onPress={open}
          feel="select"
          sink={0.98}
          hitSlop={0}
          accessibilityLabel={[panel.title, value, note, changed ? "changed" : "", pinned ? "on Home" : ""].filter(Boolean).join(", ")}
          accessibilityHint="Long press for more"
          accessibilityActions={[{ name: "pin", label: pinWord }]}
          onAccessibilityAction={pin}
          style={[{ flex: 1 }, lift(theme)]}
        >
          <Glass
            interactive
            tintColor={tint(colors.surface, dark ? 0.3 : 0.44)}
            style={{ flex: 1, minHeight: wide ? undefined : 124, padding: gap.lg, gap: gap.xs, borderRadius: radius.lg, overflow: "hidden" }}
          >
            {cardBody}
          </Glass>
        </Tap>
      ) : (
        <Tap
          onPress={open}
          feel="select"
          sink={0.98}
          hitSlop={0}
          accessibilityLabel={[panel.title, value, note, changed ? "changed" : "", pinned ? "on Home" : ""].filter(Boolean).join(", ")}
          accessibilityHint="Long press for more"
          accessibilityActions={[{ name: "pin", label: pinWord }]}
          onAccessibilityAction={pin}
          style={[{ flex: 1, minHeight: wide ? undefined : 124, padding: gap.lg, gap: gap.xs, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }, lift(theme)]}
        >
          {cardBody}
        </Tap>
      )}
    </HoldMenu>
  );
}
