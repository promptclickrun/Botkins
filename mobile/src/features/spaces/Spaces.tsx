// The Spaces tab: every space this person can open, with who can open each. Those on Home first
// (the pinned ones), then the others, and for an owner with Admin mode on what members made; last,
// the single panels pinned to Home. Hold a space, then move, to put it in order, pin it to Home
// (drop it under On Home) or take it off (under More); a still hold opens its menu, which has the
// same moves, as VoiceOver's actions do.
import { useScrollToTop } from "expo-router";
import { MailOpen, Plus } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { changedSpaces } from "@/features/chat/unread";
import type { BoardScroll } from "@/features/home/BotBoard";
import type { SpaceSummary } from "@/link/types";
import { useBots, useCan } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { type PanelPin, usePrefs } from "@/state/prefs";
import { panelHeadline } from "@/state/widgetData";
import { useApp } from "@/state/store";
import { BotAvatar, Dot, EmptyState, HoldMenu, IconButton, IconTile, Label, LinkBanner, Loading, Page, space as gap, T, Tap, type TextPromptOptions, useShape, useTextPrompt, useTheme } from "@/ui";
import { markSeen, openPanel, openShare, openSpace, setPanelPinned, setPinned, useArranging, useSpaceContent, useSpaces, useSpacesOn } from "./data";
import { spaceIcon } from "./icons";
import { panelPinsHere, rowLine, spaceDropPlan, spaceItems, spaceTitle, type SpaceZone, withMove } from "./logic";
import { SortArea, SortCell, SortHandle, useSorter } from "./sortable";

function newSpace(ask: (options: TextPromptOptions) => void) {
  ask({
    title: "New space",
    confirm: "Create",
    onSubmit: (value) => void attempt(api["spaces.create"]({ name: value.slice(0, 40) })).then((id) => id && openSpace(id)),
  });
}

function SpaceRow({ space, spaces }: { space: SpaceSummary; spaces: SpaceSummary[] }) {
  const { colors, control } = useTheme();
  const up = withMove(spaces, space.id, -1);
  const down = withMove(spaces, space.id, 1);
  const title = spaceTitle(space);
  const pinWord = space.pinned ? "Take off Home" : "Pin to Home";
  const actions = [
    ...(space.changed > 0 ? [{ name: "read", label: "Mark as read" }] : []),
    { name: "pin", label: pinWord },
    ...(up ? [{ name: "up", label: "Move up" }] : []),
    ...(down ? [{ name: "down", label: "Move down" }] : []),
  ];
  const run = (name: string) => {
    if (name === "read") markSeen(space.id);
    else if (name === "pin") setPinned(spaces, space.id, !space.pinned);
    else if (name === "up" && up) void attempt(api["link.spaces.arrange"](up));
    else if (name === "down" && down) void attempt(api["link.spaces.arrange"](down));
    else if (name === "share") openShare(space.id);
  };
  return (
    <HoldMenu
      title={title}
      actions={[
        ...(space.changed > 0 ? [{ id: "read", title: "Mark as read", image: "envelope.open" }] : []),
        { id: "pin", title: pinWord, image: space.pinned ? "pin.slash" : "pin" },
        { id: "up", title: "Move up", image: "arrow.up", attributes: { disabled: !up } },
        { id: "down", title: "Move down", image: "arrow.down", attributes: { disabled: !down } },
        ...(space.can === "own" ? [{ id: "share", title: "Share", image: "square.and.arrow.up" }] : []),
      ]}
      onPressAction={({ nativeEvent }) => run(nativeEvent.event)}
    >
      <Tap
        onPress={() => openSpace(space.id)}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityLabel={title + ", " + rowLine(space) + (space.changed > 0 ? ", changed" : "")}
        accessibilityHint="Long press for more"
        accessibilityActions={actions}
        onAccessibilityAction={(event) => run(event.nativeEvent.actionName)}
      >
        <View style={{ minHeight: control.row + 8, paddingHorizontal: gap.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: gap.md }}>
          <IconTile icon={spaceIcon(space)} color={colors.ink2} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="callout" weight="500" numberOfLines={1}>
              {title}
            </T>
            <T variant="footnote" color="muted" numberOfLines={1}>
              {rowLine(space)}
            </T>
          </View>
          {space.changed > 0 && <Dot size={8} />}
        </View>
      </Tap>
    </HoldMenu>
  );
}

const ZONE_TITLES: Record<SpaceZone, string> = { pinned: "On Home", more: "More" };
const INSET = gap.lg + 40 + gap.md;

/**
 * Page's frame for a tab's root, with a scroll view the list can scroll itself: a dragged space
 * near the top or bottom edge scrolls the page (Page has no handle on its scroll view). Keep it
 * like Page's, and like Home's own frame.
 */
function SpacesFrame({ children, scroll, scrollEnabled, actions }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; actions?: ReactNode }) {
  useScrollToTop(scroll.ref);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Beside the side rail on iPhone Duo, and with no room for a tab bar that is in the rail.
  const shape = useShape();
  const { height } = useWindowDimensions();
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  const { edges, offset, max } = scroll;
  useEffect(() => {
    edges.value = { top: insets.top, bottom: height - shape.tabRoom - insets.bottom };
  }, [edges, insets.top, insets.bottom, height, shape.tabRoom]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
    },
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingLeft: gap.xl + shape.left, paddingRight: gap.xl + shape.right, paddingTop: insets.top + gap.md, paddingBottom: shape.tabRoom + insets.bottom + gap.xxl, gap: gap.xl }}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        scrollEnabled={scrollEnabled}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(event) => {
          view.value = event.nativeEvent.layout.height;
          max.value = Math.max(0, content.value - view.value);
        }}
        onContentSizeChange={(_, h) => {
          content.value = h;
          max.value = Math.max(0, content.value - view.value);
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: gap.md, marginBottom: gap.xs }}>
          <View style={{ flex: 1 }}>
            <T variant="display" accessibilityRole="header" numberOfLines={2}>
              Spaces
            </T>
          </View>
          {!!actions && <View style={{ flexDirection: "row", alignItems: "center", gap: gap.sm, paddingBottom: 3 }}>{actions}</View>}
        </View>
        <LinkBanner />
        {children}
      </Animated.ScrollView>
    </View>
  );
}

/** One panel pinned to Home: its title, its space and what it says. A tap opens it; a hold takes it off Home. */
function PinnedPanelRow({ pin, space }: { pin: PanelPin; space: SpaceSummary }) {
  const { control } = useTheme();
  const { content } = useSpaceContent(pin.spaceId);
  const bots = useBots();
  const panel = content?.panels.find((one) => one.id === pin.panelId);
  if (!panel) return null;
  const line = ["Panel in " + spaceTitle(space), panelHeadline(panel).value].filter(Boolean).join(" · ");
  const unpin = () => setPanelPinned(pin, false);
  return (
    <HoldMenu title={panel.title} actions={[{ id: "unpin", title: "Take off Home", image: "pin.slash" }]} onPressAction={unpin}>
      <Tap
        onPress={() => openPanel(pin.spaceId, pin.panelId)}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityLabel={panel.title + ", " + line}
        accessibilityHint="Long press for more"
        accessibilityActions={[{ name: "unpin", label: "Take off Home" }]}
        onAccessibilityAction={unpin}
      >
        <View style={{ minHeight: control.row + 8, paddingHorizontal: gap.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: gap.md }}>
          <View style={{ width: 40, alignItems: "center" }}>
            <BotAvatar bot={bots.find((bot) => bot.id === panel.botId)} size={36} badge={false} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="callout" weight="500" numberOfLines={1}>
              {panel.title}
            </T>
            <T variant="footnote" color="muted" numberOfLines={1}>
              {line}
            </T>
          </View>
        </View>
      </Tap>
    </HoldMenu>
  );
}

/** The panels pinned to Home, under the spaces. */
function PinnedPanels({ spaces }: { spaces: SpaceSummary[] }) {
  const saved = usePrefs((prefs) => prefs.homePanels);
  const pins = useMemo(() => panelPinsHere(saved, spaces), [saved, spaces]);
  if (!pins.length) return null;
  return (
    <View style={{ marginHorizontal: -gap.lg }}>
      <View style={{ paddingHorizontal: gap.lg, paddingBottom: gap.xs }}>
        <Label>Panels on Home</Label>
      </View>
      {pins.map((pin) => {
        const space = spaces.find((one) => one.id === pin.spaceId);
        return space ? <PinnedPanelRow key={pin.spaceId + ":" + pin.panelId} pin={pin} space={space} /> : null;
      })}
    </View>
  );
}

/** The list, with the drag. A drop is shown at once; the computer's own order follows. */
function SpaceList({ spaces, scroll, onDragging }: { spaces: SpaceSummary[]; scroll: BoardScroll; onDragging: (on: boolean) => void }) {
  const { colors } = useTheme();
  const you = useApp((state) => state.parts.meta?.you);
  const viewer = { owner: you?.kind !== "member", admin: you?.kind === "owner" && you.admin === true };
  const hold = useArranging(spaces);
  const shown = hold.shown;
  const { sorter, items } = useSorter({
    build: (dragging) => spaceItems(shown, viewer, dragging),
    scroll,
    onDrop: (key, zone, index) => hold.arrange(spaceDropPlan(shown, viewer, key.slice("space:".length), zone as SpaceZone, index)),
    onDragging,
  });
  const byId = new Map(shown.map((space) => [space.id, space]));
  return (
    <SortArea sorter={sorter}>
      <View style={{ marginHorizontal: -gap.xl }}>
        {items.map((item, at) => {
          const previous = items[at - 1];
          const space = "id" in item && item.id ? byId.get(item.id) : undefined;
          if (!space)
            return (
              <SortCell key={item.key} item={item} style={{ paddingHorizontal: gap.xl, paddingTop: at ? gap.xl : 0, paddingBottom: gap.xs }}>
                <Label>{item.kind === "head" ? ZONE_TITLES[item.zone] : item.kind === "fixed" ? (item.title ?? "") : ""}</Label>
              </SortCell>
            );
          return (
            <SortCell key={item.key} item={item} style={{ paddingHorizontal: gap.xl - gap.lg }}>
              {!!previous && "id" in previous && !!previous.id && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: INSET }} />}
              <SortHandle itemKey={item.key} disabled={item.kind !== "row"}>
                <SpaceRow space={space} spaces={shown} />
              </SortHandle>
            </SortCell>
          );
        })}
      </View>
    </SortArea>
  );
}

export default function Spaces() {
  const on = useSpacesOn();
  const synced = useApp((state) => state.synced);
  const spaces = useSpaces();
  const canCreate = useCan("today", "create");
  const prompt = useTextPrompt();
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  // A page left in the middle of a drag must not keep its scrolling off.
  useEffect(() => () => setDragging(false), []);
  if (!on)
    return (
      <Page tab title="Spaces">
        <EmptyState title="Update the app on your computer" />
      </Page>
    );
  const ask = () => newSpace(prompt.ask);
  const unreadSpaces = changedSpaces(spaces);
  const headerActions = (unreadSpaces.length > 0 || canCreate) ? (
    <>
      {unreadSpaces.length > 0 && (
        <IconButton
          icon={MailOpen}
          label="Mark all as read"
          variant="soft"
          size={44}
          onPress={() => {
            for (const space of unreadSpaces) markSeen(space.id);
          }}
        />
      )}
      {canCreate && <IconButton icon={Plus} label="New space" variant="soft" size={44} onPress={ask} />}
    </>
  ) : undefined;
  return (
    <SpacesFrame scroll={scroll} scrollEnabled={!dragging} actions={headerActions}>
      {prompt.node}
      {!synced ? <Loading /> : !spaces.length ? <EmptyState title="No spaces yet" action={canCreate ? "New space" : undefined} onAction={canCreate ? ask : undefined} /> : <SpaceList spaces={spaces} scroll={scroll} onDragging={setDragging} />}
      {synced && <PinnedPanels spaces={spaces} />}
    </SpacesFrame>
  );
}
