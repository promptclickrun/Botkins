// Home's row of pinned spaces, where Today sat: one row of chips under the bots. A tap shows that
// space in place, a dot says something changed, and a tap on the chosen one opens its page. "All"
// lists every space. Hold a chip, then move, to put the row in order (sortable.tsx); All spaces has
// the same moves in each space's menu and for VoiceOver.
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import type { BoardScroll } from "@/features/home/BotBoard";
import { Chip, Dot, space as gap, T, Tap } from "@/ui";
import { openSpace, openSpaces, useArranging, useSpaces } from "./data";
import { spaceDropPlan, spaceTitle } from "./logic";
import { SortArea, SortCell, SortHandle, type SortItem, useSorter } from "./sortable";
import { SpaceView } from "./SpaceView";

// The row has one group. Its heading is only where the row starts, so a chip can be dropped first.
const START: SortItem = { key: "head:pinned", kind: "head", zone: "pinned" };
// A drop here only orders the pinned spaces, which does not depend on who is looking.
const ANYONE = { owner: false, admin: false };

// The space last shown stays the one shown while the app is open.
let last: string | undefined;

/** `onDragging`: a chip was lifted or dropped, so Home stops its own scrolling while one is held. */
export function HomeSpaces({ onDragging }: { onDragging?: (on: boolean) => void }) {
  const spaces = useSpaces();
  const hold = useArranging(spaces);
  const pinned = hold.shown.filter((space) => space.pinned);
  const { width } = useWindowDimensions();
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  // The row scrolls sideways: its two ends are the screen's sides.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: width }) };
  const { offset, max } = scroll;
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.x;
    },
  });
  const [lifted, setLifted] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>(last);
  const shown = pinned.find((space) => space.id === chosen) ?? pinned[0];
  const { sorter, items } = useSorter({
    across: true,
    build: () => [START, ...pinned.map((space): SortItem => ({ key: "space:" + space.id, kind: "row", zone: "pinned" }))],
    scroll,
    onDrop: (key, _zone, index) => hold.arrange(spaceDropPlan(hold.shown, ANYONE, key.slice("space:".length), "pinned", index)),
    onDragging: (on) => {
      // The space shown stays the one shown, also when it was only the first of the row.
      if (on && shown) setChosen((last = shown.id));
      setLifted(on);
      onDragging?.(on);
    },
  });
  const pick = (id: string) => {
    if (shown?.id === id) return openSpace(id);
    last = id;
    setChosen(id);
  };
  return (
    <View style={{ gap: gap.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 32 }}>
        <T variant="label" color="muted" style={{ flex: 1, textTransform: "uppercase" }} accessibilityRole="header">
          Spaces
        </T>
        <Tap onPress={openSpaces} feel="select" accessibilityLabel="All spaces" style={{ minHeight: 32, justifyContent: "center", paddingLeft: gap.md }}>
          <T variant="footnote" weight="600" color="muted">
            All
          </T>
        </Tap>
      </View>
      {pinned.length > 0 && (
        <SortArea sorter={sorter}>
          <Animated.ScrollView
            ref={scroll.ref}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!lifted}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onLayout={(event) => {
              view.value = event.nativeEvent.layout.width;
              max.value = Math.max(0, content.value - view.value);
            }}
            onContentSizeChange={(w) => {
              content.value = w;
              max.value = Math.max(0, content.value - view.value);
            }}
            style={{ marginHorizontal: -gap.xl }}
            // Each chip's cell holds the gap after it, so the cells sit edge to edge and one makes room by its own width.
            contentContainerStyle={{ paddingLeft: gap.xl, paddingRight: gap.xl - gap.sm }}
          >
            {items.map((item) => {
              const space = item.kind === "row" ? pinned.find((one) => "space:" + one.id === item.key) : undefined;
              if (!space) return <SortCell key={item.key} item={item} look="chip" />;
              return (
                <SortCell key={item.key} item={item} look="chip" style={{ paddingRight: gap.sm }}>
                  <SortHandle itemKey={item.key} disabled={pinned.length < 2}>
                    <Chip
                      label={spaceTitle(space)}
                      selected={shown?.id === space.id}
                      onPress={() => pick(space.id)}
                      leading={space.changed > 0 && shown?.id !== space.id ? <Dot size={7} /> : undefined}
                      accessibilityLabel={spaceTitle(space) + (space.changed > 0 ? ", changed" : "") + (shown?.id === space.id ? ", shown. Tap to open" : "")}
                    />
                  </SortHandle>
                </SortCell>
              );
            })}
          </Animated.ScrollView>
        </SortArea>
      )}
      {shown ? (
        <SpaceView space={shown} />
      ) : (
        <Tap onPress={openSpaces} feel="select" accessibilityLabel="All spaces" style={{ minHeight: 44, justifyContent: "center" }}>
          <T variant="subhead" color="muted">
            No pinned spaces. Pin one from All.
          </T>
        </Tap>
      )}
    </View>
  );
}
