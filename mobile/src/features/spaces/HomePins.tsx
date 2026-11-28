// Home's pinned things, under the bots: each pinned space as a card that says what its first panels
// say, then each pinned panel as a card of its own (PanelTile). Nothing runs here: a tap opens the
// space or the panel. What is pinned, and its order, is set from the Spaces tab.
import { ChevronRight } from "lucide-react-native";
import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { myself } from "@/features/chat/people";
import type { SpaceSummary } from "@/link/types";
import { useBots, usePart } from "@/state/hooks";
import { type PanelPin, usePrefs } from "@/state/prefs";
import { panelHeadline } from "@/state/widgetData";
import { Dot, Glass, Label, lift, radius, slopFor, space as gap, T, Tap, tint, useTheme } from "@/ui";
import { markItemSeen, openPanel, openSpace, openSpaces, setPanelPinned, useSeenMarks, useSpaceContent, useSpaces } from "./data";
import { spaceIcon } from "./icons";
import { changedSince, moreLine, panelPinsHere, pinnedLine, spaceTitle } from "./logic";
import { PanelTile } from "./PanelTile";

/** How many of a pinned space's panels (or cards) Home says in its card. */
const LINES = 3;
const LINE = 38;

/** A pinned space: its name and what it holds, then its first panels with what each says. Feed, Ideas and Goals say their newest cards. */
function SpaceCard({ space }: { space: SpaceSummary }) {
  const theme = useTheme();
  const { colors, dark } = theme;
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const { content } = useSpaceContent(space.id);
  const me = myself(usePart("meta"));
  const marked = useSeenMarks((marks) => marks.spaces[space.id] ?? 0);
  const items = useSeenMarks((marks) => marks.items);
  const panels = useMemo(() => (content?.panels ?? []).filter((panel) => !panel.hidden), [content]);
  const cards = useMemo(() => (content?.cards ?? []).filter((card) => card.status === "open").sort((a, b) => b.createdAt - a.createdAt), [content]);
  const changed = useMemo(() => changedSince(panels, Math.max(content?.seenAt ?? 0, marked), me, { ...content?.seenItems, ...items }), [panels, content, marked, me, items]);
  const Icon = spaceIcon(space);
  const title = spaceTitle(space);
  const more = moreLine(panels.length || cards.length, LINES);
  const dividerColor = hasBackdrop ? (dark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.10)") : colors.line;
  const line = { minHeight: LINE, flexDirection: "row", alignItems: "center", gap: gap.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: dividerColor } as const;
  const body = (
    <>
      <Tap onPress={() => openSpace(space.id)} feel="select" sink={0.99} hitSlop={0} accessibilityLabel={title + ", " + pinnedLine(space) + ", open"} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: gap.sm }}>
        <Icon size={18} color={colors.ink} strokeWidth={2.2} />
        <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
          {title}
        </T>
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {pinnedLine(space)}
        </T>
        <ChevronRight size={18} color={colors.faint} strokeWidth={2.2} />
      </Tap>
      {panels.slice(0, LINES).map((panel) => {
        const { value } = panelHeadline(panel);
        const news = changed.has(panel.id);
        return (
          <Tap
            key={panel.id}
            onPress={() => {
              if (news) markItemSeen(space.id, panel.id, panel.updatedAt);
              openPanel(space.id, panel.id);
            }}
            feel="select"
            sink={0.99}
            hitSlop={slopFor(LINE)}
            accessibilityLabel={[panel.title, value, news ? "changed" : ""].filter(Boolean).join(", ")}
            style={line}
          >
            <T variant="subhead" numberOfLines={1} style={{ flexShrink: 1 }}>
              {panel.title}
            </T>
            {news && <Dot size={7} />}
            <View style={{ flex: 1 }} />
            {!!value && (
              <T variant="subhead" weight="600" numberOfLines={1} style={{ maxWidth: "45%" }}>
                {value}
              </T>
            )}
          </Tap>
        );
      })}
      {!panels.length &&
        cards.slice(0, LINES).map((card) => (
          <Tap key={card.id} onPress={() => openSpace(space.id)} feel="select" sink={0.99} hitSlop={slopFor(LINE)} accessibilityLabel={card.title} style={line}>
            <T variant="subhead" numberOfLines={1} style={{ flex: 1 }}>
              {card.title}
            </T>
            {!card.read && <Dot size={7} />}
          </Tap>
        ))}
      {!!more && (
        <Tap onPress={() => openSpace(space.id)} feel="select" sink={0.99} hitSlop={slopFor(LINE - 6)} accessibilityLabel={more + " in " + title} style={[line, { minHeight: LINE - 6 }]}>
          <T variant="footnote" color="muted">
            {more}
          </T>
        </Tap>
      )}
    </>
  );
  if (hasBackdrop) {
    return (
      <View style={lift(theme)}>
        <Glass tintColor={tint(colors.surface, dark ? 0.3 : 0.44)} style={{ paddingHorizontal: gap.lg, paddingVertical: gap.xs, borderRadius: radius.lg, overflow: "hidden" }}>
          {body}
        </Glass>
      </View>
    );
  }
  return (
    <View style={[{ paddingHorizontal: gap.lg, paddingVertical: gap.xs, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }, lift(theme)]}>
      {body}
    </View>
  );
}

/** A pinned panel, read from its space. A panel that is gone takes its pin with it. */
function PinnedPanel({ pin, space }: { pin: PanelPin; space: SpaceSummary }) {
  const { content } = useSpaceContent(pin.spaceId);
  const bots = useBots();
  const panel = content?.panels.find((one) => one.id === pin.panelId);
  const gone = !!content && !panel;
  useEffect(() => {
    if (gone) setPanelPinned(pin, false, true);
  }, [gone, pin]);
  if (!panel) return <View style={{ flex: 1 }} />;
  return <PanelTile panel={panel} spaceId={pin.spaceId} bot={bots.find((bot) => bot.id === panel.botId)} foot={spaceTitle(space)} />;
}

export function HomePins() {
  const spaces = useSpaces();
  const saved = usePrefs((prefs) => prefs.homePanels);
  const pins = useMemo(() => panelPinsHere(saved, spaces), [saved, spaces]);
  const pinned = spaces.filter((space) => space.pinned);
  // Two panels to a row; a last one alone keeps a card's width.
  const rows: PanelPin[][] = [];
  for (let at = 0; at < pins.length; at += 2) rows.push(pins.slice(at, at + 2));
  return (
    <View style={{ gap: gap.md }}>
      <Label style={{ marginBottom: 0 }}>On Home</Label>
      {!pinned.length && !pins.length && (
        <Tap onPress={openSpaces} feel="select" accessibilityLabel="Nothing pinned. Open Spaces" style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: gap.xs }}>
          <T variant="subhead" color="muted">
            Nothing pinned. Pin a space or a panel from Spaces.
          </T>
        </Tap>
      )}
      {pinned.map((space) => (
        <SpaceCard key={space.id} space={space} />
      ))}
      {rows.map((row) => (
        <View key={row.map((pin) => pin.panelId).join("+")} style={{ flexDirection: "row", gap: gap.md }}>
          {row.map((pin) => {
            const space = spaces.find((one) => one.id === pin.spaceId);
            return space ? <PinnedPanel key={pin.panelId} pin={pin} space={space} /> : null;
          })}
          {row.length === 1 && <View style={{ flex: 1 }} />}
        </View>
      ))}
    </View>
  );
}
