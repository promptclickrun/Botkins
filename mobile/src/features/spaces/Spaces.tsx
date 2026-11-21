// All spaces: every space this person can open, with who can open each. Pinned first (they are the
// row on Home), then the others, and for an owner with Admin mode on what members made. Hold a
// space, then move, to put it in order, pin it (drop it under Pinned) or unpin it (under More); a
// still hold opens its menu, which has the same moves, as VoiceOver's actions do.
import { Lightbulb, LayoutGrid, type LucideIcon, Plus, Rss, Sun, Target } from "lucide-react-native";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BoardScroll } from "@/features/home/BotBoard";
import type { SpaceSummary } from "@/link/types";
import { useCan } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Dot, EmptyState, HoldMenu, IconButton, IconTile, Label, LinkBanner, Loading, Page, space as gap, T, Tap, useTheme } from "@/ui";
import { openShare, openSpace, setPinned, useArranging, useSpaces, useSpacesOn } from "./data";
import { rowLine, spaceDropPlan, spaceItems, spaceTitle, type SpaceZone, withMove } from "./logic";
import { SortArea, SortCell, SortHandle, useSorter } from "./sortable";

const ICONS: Record<NonNullable<SpaceSummary["builtin"]>, LucideIcon> = { today: Sun, feed: Rss, ideas: Lightbulb, goals: Target };

function newSpace() {
  Alert.prompt(
    "New space",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Create",
        onPress: (value?: string) => {
          const name = value?.trim().slice(0, 40);
          if (name) void attempt(api["spaces.create"]({ name })).then((id) => id && openSpace(id));
        },
      },
    ],
    "plain-text",
    "",
  );
}

function SpaceRow({ space, spaces }: { space: SpaceSummary; spaces: SpaceSummary[] }) {
  const { colors, control } = useTheme();
  const up = withMove(spaces, space.id, -1);
  const down = withMove(spaces, space.id, 1);
  const title = spaceTitle(space);
  const actions = [
    { name: "pin", label: space.pinned ? "Unpin" : "Pin" },
    ...(up ? [{ name: "up", label: "Move up" }] : []),
    ...(down ? [{ name: "down", label: "Move down" }] : []),
  ];
  const run = (name: string) => {
    if (name === "pin") setPinned(spaces, space.id, !space.pinned);
    else if (name === "up" && up) void attempt(api["link.spaces.arrange"](up));
    else if (name === "down" && down) void attempt(api["link.spaces.arrange"](down));
    else if (name === "share") openShare(space.id);
  };
  return (
    <HoldMenu
      title={title}
      actions={[
        { id: "pin", title: space.pinned ? "Unpin" : "Pin", image: space.pinned ? "pin.slash" : "pin" },
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
          <IconTile icon={space.builtin ? ICONS[space.builtin] : LayoutGrid} color={colors.ink2} />
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

const ZONE_TITLES: Record<SpaceZone, string> = { pinned: "Pinned", more: "More" };
const INSET = gap.lg + 40 + gap.md;

/**
 * Page's frame for a pushed page, with a scroll view the list can scroll itself: a dragged space
 * near the top or bottom edge scrolls the page (Page has no handle on its scroll view). Keep it
 * like Page's, and like the Chats screen's own frame.
 */
function SpacesFrame({ children, scroll, scrollEnabled, actions }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; actions?: ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const frame = useRef<ComponentRef<typeof View>>(null);
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  const { edges, offset, max } = scroll;
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
    },
  });
  return (
    <View
      ref={frame}
      style={{ flex: 1, backgroundColor: colors.canvas }}
      // The page starts under the bar: where that is on the screen is where a finger can reach from.
      onLayout={() => frame.current?.measureInWindow((_x, y) => (edges.value = { top: y, bottom: height - insets.bottom }))}
    >
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: gap.xl, paddingTop: gap.sm, paddingBottom: insets.bottom + gap.xxl, gap: gap.xl }}
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
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  // A page left in the middle of a drag must not keep its scrolling off.
  useEffect(() => () => setDragging(false), []);
  if (!on)
    return (
      <Page title="Spaces">
        <EmptyState title="Update the app on your computer" />
      </Page>
    );
  return (
    <SpacesFrame scroll={scroll} scrollEnabled={!dragging} actions={canCreate ? <IconButton icon={Plus} label="New space" variant="soft" size={44} onPress={newSpace} /> : undefined}>
      {!synced ? <Loading /> : !spaces.length ? <EmptyState title="No spaces yet" action={canCreate ? "New space" : undefined} onAction={canCreate ? newSpace : undefined} /> : <SpaceList spaces={spaces} scroll={scroll} onDragging={setDragging} />}
    </SpacesFrame>
  );
}
